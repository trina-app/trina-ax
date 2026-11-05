// Cloudflare Worker entry (wrangler.toml). State:
//   BLOCKED  KV namespace, the operator's blocklist: key = team key id (sha256 hex of the SPKI DER), any value = blocked.
//            The Worker only reads it (cached 60 s at the edge), so an unknown key costs no KV write.
//   LIMITER  Durable Object, one instance per shard ("k:<key id>", "t:<token id>"): the TOFU first-seen record, the
//            rate-limit windows and the dedupe entries (state.ts). A Durable Object is strongly consistent and runs one
//            call at a time (input gates), which a daily per-token limit and a replay guard need; the Workers Rate
//            Limiting binding only counts per 10 or 60 s and per location, so it cannot hold 200/day or dedupe.
// Bindings are typed here with the few members used, so no Workers type package is needed.
import { createGateway, type GatewayDeps, type GatewayEnv, type LogLine } from './gateway.ts'
import { admitKeyOn, admitTokenOn, expired, releaseOn, LIMITS, type GatewayState, type KeyAdmission, type ShardStorage, type TokenAdmission } from './state.ts'

export interface KVNamespaceLike { get(key: string, options?: { cacheTtl?: number }): Promise<string | null> }
export interface DurableObjectStubLike { fetch(input: string, init?: RequestInit): Promise<Response> }
export interface DurableObjectNamespaceLike<Id = unknown> { idFromName(name: string): Id; get(id: Id): DurableObjectStubLike }
export interface DurableObjectStorageLike extends ShardStorage {
  list(): Promise<Map<string, unknown>>
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number): Promise<void>
}
export interface DurableObjectStateLike { storage: DurableObjectStorageLike }

export interface WorkerEnv extends GatewayEnv {
  BLOCKED: KVNamespaceLike
  LIMITER: DurableObjectNamespaceLike
}

const DO_ORIGIN = 'https://limiter.internal'

/** GatewayState over the BLOCKED KV namespace and the LIMITER Durable Object. */
export class DurableState implements GatewayState {
  constructor(private readonly env: WorkerEnv) {}
  private async call<T>(shard: string, op: string, args: Record<string, unknown>): Promise<T> {
    const stub = this.env.LIMITER.get(this.env.LIMITER.idFromName(shard))
    const res = await stub.fetch(`${DO_ORIGIN}/${op}`, { method: 'POST', body: JSON.stringify(args) })
    if (res.status !== 200) throw new Error(`limiter ${op}: ${res.status}`)
    return (await res.json()) as T
  }
  async isBlocked(keyId: string) { return (await this.env.BLOCKED.get(keyId, { cacheTtl: 60 })) !== null }
  admitKey(keyId: string, dedupeId: string, now: number) { return this.call<KeyAdmission>(`k:${keyId}`, 'admit-key', { dedupeId, now }) }
  admitToken(tokenId: string, now: number) { return this.call<TokenAdmission>(`t:${tokenId}`, 'admit-token', { now }) }
  async release(keyId: string, dedupeId: string) { await this.call(`k:${keyId}`, 'release', { dedupeId }) }
}

/** The Durable Object: runs state.ts on its own storage, sweeps expired records with an alarm. */
export class PushLimiter {
  private alarmKnown = false
  constructor(private readonly ctx: DurableObjectStateLike, _env?: unknown) {}

  async fetch(req: Request): Promise<Response> {
    const op = new URL(req.url).pathname.slice(1)
    const args = (await req.json()) as { dedupeId?: unknown; now?: unknown }
    const st = this.ctx.storage
    const now = typeof args.now === 'number' ? args.now : Date.now()
    const dedupeId = typeof args.dedupeId === 'string' ? args.dedupeId : ''
    let out: unknown
    if (op === 'admit-key' && dedupeId) out = await admitKeyOn(st, dedupeId, now)
    else if (op === 'admit-token') out = await admitTokenOn(st, now)
    else if (op === 'release' && dedupeId) {
      await releaseOn(st, dedupeId)
      out = { ok: true }
    }
    else return new Response('not found', { status: 404 })
    if (!this.alarmKnown) {
      if ((await st.getAlarm()) === null) await st.setAlarm(Date.now() + LIMITS.dedupeMs)
      this.alarmKnown = true
    }
    return Response.json(out)
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    let next = Infinity
    for (const [k, v] of await this.ctx.storage.list()) {
      if (expired(v, now)) await this.ctx.storage.delete(k)
      else {
        const until = (v as { until?: unknown }).until
        if (typeof until === 'number') next = Math.min(next, until)
      }
    }
    this.alarmKnown = false
    if (next !== Infinity) {
      await this.ctx.storage.setAlarm(next)
      this.alarmKnown = true
    }
  }
}

const log = (line: LogLine) => console.log(JSON.stringify(line))

/** The Worker; tests pass fake providers and clocks through `deps`. */
export function createWorker(deps: Partial<Omit<GatewayDeps, 'state'>> = {}) {
  let gateway: ReturnType<typeof createGateway> | null = null
  return {
    fetch(req: Request, env: WorkerEnv): Promise<Response> {
      // env is the same for the life of an isolate (a secret change is a new deployment), so caches live here
      gateway ??= createGateway(env, {
        fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
        now: deps.now ?? (() => Date.now()),
        log: deps.log ?? log,
        state: new DurableState(env),
        endpoints: deps.endpoints,
      })
      return gateway.handle(req)
    },
  }
}

export default createWorker()
