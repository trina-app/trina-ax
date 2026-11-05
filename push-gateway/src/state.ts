// Gateway state: trust on first use per team key, rate limits and dedupe. The logic lives in the *On functions over a
// small async key-value storage (one "shard" per team key and one per device token), so the Worker's Durable Object
// (worker.ts), the Bun entry's SQLite file (bun.ts) and the in-memory store (tests) run exactly the same code.
//
// Shard "k:<key id>": seen = { firstSeenMs } (TOFU, kept), b:min = the key's minute window, d:<token id>:<notification
//                     id> = dedupe until. Shard "t:<token id>": b:min and b:day for the device token. Token id = sha256
//                     hex of the token: raw tokens are never stored. Every record but `seen` has `until` and is swept
//                     after it.
// Each *On function must run without another call on the same shard in between: the Durable Object's input gates give
// that, ShardedState below serialises calls per shard.
import { PUSH_GATEWAY_DEDUPE_MS } from '../../shared/src/cloud-protocol/push-gateway.ts'

export const LIMITS = {
  /** a key first seen less than this long ago is young */
  youngKeyMs: 24 * 3600_000,
  keyPerMinuteYoung: 120,
  keyPerMinuteEstablished: 1200,
  tokenPerMinute: 20,
  tokenPerDay: 200,
  dedupeMs: PUSH_GATEWAY_DEDUPE_MS,
}
export type Limits = typeof LIMITS

const MINUTE = 60_000
const DAY = 86_400_000

export type KeyAdmission =
  | { kind: 'ok'; firstSeenMs: number }
  | { kind: 'duplicate' }
  | { kind: 'limited'; retryAfterSec: number }
export type TokenAdmission = { kind: 'ok' } | { kind: 'limited'; retryAfterSec: number }

export interface GatewayState {
  /** the operator blocked this key */
  isBlocked(keyId: string): Promise<boolean>
  /** record the key on first use, refuse a (token, notification) sent within the dedupe window, count the key's
   * minute limit (young or established) and reserve the dedupe entry */
  admitKey(keyId: string, dedupeId: string, now: number): Promise<KeyAdmission>
  /** count the device token's minute and day limits */
  admitToken(tokenId: string, now: number): Promise<TokenAdmission>
  /** drop a dedupe reservation: nothing was delivered, a retry must send */
  release(keyId: string, dedupeId: string): Promise<void>
}

/** The subset of Durable Object storage the logic needs. */
export interface ShardStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}

interface Seen { firstSeenMs: number }
interface Window { w: number; n: number; until: number }
interface Dedupe { until: number }

const retryAfter = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 1000))

async function windowCount(st: ShardStorage, key: string, size: number, now: number): Promise<{ w: number; n: number; until: number }> {
  const w = Math.floor(now / size)
  const rec = await st.get<Window>(key)
  return { w, n: rec && rec.w === w ? rec.n : 0, until: (w + 1) * size }
}

export async function admitKeyOn(st: ShardStorage, dedupeId: string, now: number, limits: Limits = LIMITS): Promise<KeyAdmission> {
  let seen = await st.get<Seen>('seen')
  if (!seen) {
    seen = { firstSeenMs: now }
    await st.put('seen', seen)
  }
  const d = await st.get<Dedupe>(`d:${dedupeId}`)
  if (d && d.until > now) return { kind: 'duplicate' }
  const limit = now - seen.firstSeenMs < limits.youngKeyMs ? limits.keyPerMinuteYoung : limits.keyPerMinuteEstablished
  const min = await windowCount(st, 'b:min', MINUTE, now)
  if (min.n >= limit) return { kind: 'limited', retryAfterSec: retryAfter(min.until, now) }
  await st.put('b:min', { w: min.w, n: min.n + 1, until: min.until } satisfies Window)
  await st.put(`d:${dedupeId}`, { until: now + limits.dedupeMs } satisfies Dedupe)
  return { kind: 'ok', firstSeenMs: seen.firstSeenMs }
}

export async function admitTokenOn(st: ShardStorage, now: number, limits: Limits = LIMITS): Promise<TokenAdmission> {
  const min = await windowCount(st, 'b:min', MINUTE, now)
  const day = await windowCount(st, 'b:day', DAY, now)
  if (day.n >= limits.tokenPerDay) return { kind: 'limited', retryAfterSec: retryAfter(day.until, now) }
  if (min.n >= limits.tokenPerMinute) return { kind: 'limited', retryAfterSec: retryAfter(min.until, now) }
  await st.put('b:min', { w: min.w, n: min.n + 1, until: min.until } satisfies Window)
  await st.put('b:day', { w: day.w, n: day.n + 1, until: day.until } satisfies Window)
  return { kind: 'ok' }
}

export async function releaseOn(st: ShardStorage, dedupeId: string): Promise<void> {
  await st.delete(`d:${dedupeId}`)
}

/** true when a stored record has run out (everything but the TOFU record `seen` has `until`) */
export function expired(value: unknown, now: number): boolean {
  const until = (value as { until?: unknown } | null)?.until
  return typeof until === 'number' && until <= now
}

/**
 * GatewayState over per-shard storages in one process (memory for tests, SQLite for the Bun entry). Calls on one shard
 * run one after another, so the *On functions see no other call in between.
 */
export class ShardedState implements GatewayState {
  private chains = new Map<string, Promise<unknown>>()
  constructor(
    private readonly open: (shard: string) => ShardStorage,
    private readonly blocked: (keyId: string) => Promise<boolean>,
    private readonly limits: Limits = LIMITS,
  ) {}

  private run<T>(shard: string, fn: (st: ShardStorage) => Promise<T>): Promise<T> {
    const prev = this.chains.get(shard) ?? Promise.resolve()
    const next = prev.then(() => fn(this.open(shard)))
    const settled = next.catch(() => undefined)
    this.chains.set(shard, settled)
    void settled.then(() => { if (this.chains.get(shard) === settled) this.chains.delete(shard) })
    return next
  }

  isBlocked(keyId: string) { return this.blocked(keyId) }
  admitKey(keyId: string, dedupeId: string, now: number) { return this.run(`k:${keyId}`, (st) => admitKeyOn(st, dedupeId, now, this.limits)) }
  admitToken(tokenId: string, now: number) { return this.run(`t:${tokenId}`, (st) => admitTokenOn(st, now, this.limits)) }
  release(keyId: string, dedupeId: string) { return this.run(`k:${keyId}`, (st) => releaseOn(st, dedupeId)) }
}

/** In-memory shards (tests; nothing survives a restart). `sweep(now)` drops expired records. */
export class MemoryShards {
  readonly shards = new Map<string, Map<string, unknown>>()
  open = (shard: string): ShardStorage => {
    let m = this.shards.get(shard)
    if (!m) this.shards.set(shard, (m = new Map()))
    const map = m
    return {
      get: async <T>(k: string) => structuredClone(map.get(k)) as T | undefined,
      put: async (k: string, v: unknown) => { map.set(k, structuredClone(v)) },
      delete: async (k: string) => map.delete(k),
    }
  }
  sweep(now: number) {
    for (const [name, m] of this.shards) {
      for (const [k, v] of m) if (expired(v, now)) m.delete(k)
      if (m.size === 0) this.shards.delete(name)
    }
  }
}

/** A complete in-memory GatewayState (tests). */
export function memoryState(opts: { blocked?: Set<string>; limits?: Limits } = {}) {
  const shards = new MemoryShards()
  const blocked = opts.blocked ?? new Set<string>()
  const state = new ShardedState(shards.open, async (id) => blocked.has(id), opts.limits)
  return { state, shards, blocked }
}
