// Gateway state: trust on first use per team key, rate limits and dedupe. The logic lives in the *On functions over a
// small async key-value storage, one "shard" per name, so the SQLite file (bun.ts) and the in-memory store (tests) run
// exactly the same code.
//
// Shard "k:<key id>":      seen = { firstSeenMs, until? } (TOFU; `until` = forgotten 24 h after first use unless a
//                          send was delivered, then kept), b:min = the key's minute window, d:<token id>:<notification
//                          id> = dedupe until.
// Shard "t:<pair id>":     b:min and b:day for one (key, token) pair, pair id = sha256 hex of "<key id>:<token id>",
//                          so one team server cannot use up a phone's budget for other teams.
// Shard "c:<client>":      the client address's minute window. In memory only (never written to disk): it is
//                          counted before the signature is checked.
// Token id = sha256 hex of the token: raw tokens are never stored. Every record but a confirmed `seen` has `until`
// and is swept after it.
// Each *On function must run without another call on the same shard in between: ShardedState serialises calls per
// shard.
import { PUSH_GATEWAY_DEDUPE_MS } from '../../shared/src/cloud-protocol/push-gateway.ts'

export const LIMITS = {
  /** a key first seen less than this long ago is young; an unconfirmed key is forgotten after this long */
  youngKeyMs: 24 * 3600_000,
  keyPerMinuteYoung: 120,
  keyPerMinuteEstablished: 1200,
  /** per (key, token) pair */
  tokenPerMinute: 20,
  tokenPerDay: 200,
  /** per client address (an IPv6 address counts by its /64), before the signature is checked */
  clientPerMinute: 600,
  dedupeMs: PUSH_GATEWAY_DEDUPE_MS,
}
export type Limits = typeof LIMITS

const MINUTE = 60_000
const DAY = 86_400_000

export type Admission = { kind: 'ok' } | { kind: 'limited'; retryAfterSec: number }
export type KeyAdmission =
  | { kind: 'ok'; firstSeenMs: number; confirmed: boolean }
  | { kind: 'duplicate' }
  | { kind: 'limited'; retryAfterSec: number }

export interface GatewayState {
  /** the client address's minute limit, counted for every send request */
  admitClient(client: string, now: number): Promise<Admission>
  /** the operator blocked this key */
  isBlocked(keyId: string): Promise<boolean>
  /** record the key on first use, refuse a (token, notification) sent within the dedupe window, count the key's
   * minute limit (young or established) and reserve the dedupe entry */
  admitKey(keyId: string, dedupeId: string, now: number): Promise<KeyAdmission>
  /** a send was delivered for this key: keep its first-seen record */
  confirmKey(keyId: string): Promise<void>
  /** the (key, token) pair's minute and day limits */
  admitPair(pairId: string, now: number): Promise<Admission>
  /** drop a dedupe reservation: nothing was delivered, a retry must send */
  release(keyId: string, dedupeId: string): Promise<void>
}

export interface ShardStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}

interface Seen { firstSeenMs: number; until?: number }
interface Window { w: number; n: number; until: number }
interface Dedupe { until: number }

/** true when a stored record has run out (everything but a confirmed `seen` has `until`) */
export function expired(value: unknown, now: number): boolean {
  const until = (value as { until?: unknown } | null)?.until
  return typeof until === 'number' && until <= now
}

const retryAfter = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 1000))

async function windowCount(st: ShardStorage, key: string, size: number, now: number): Promise<Window> {
  const w = Math.floor(now / size)
  const rec = await st.get<Window>(key)
  return { w, n: rec && rec.w === w ? rec.n : 0, until: (w + 1) * size }
}
const bump = (st: ShardStorage, key: string, win: Window) => st.put(key, { w: win.w, n: win.n + 1, until: win.until } satisfies Window)

export async function admitKeyOn(st: ShardStorage, dedupeId: string, now: number, limits: Limits = LIMITS): Promise<KeyAdmission> {
  let seen = await st.get<Seen>('seen')
  if (!seen || expired(seen, now)) {
    seen = { firstSeenMs: now, until: now + limits.youngKeyMs }
    await st.put('seen', seen)
  }
  const d = await st.get<Dedupe>(`d:${dedupeId}`)
  if (d && d.until > now) return { kind: 'duplicate' }
  const limit = now - seen.firstSeenMs < limits.youngKeyMs ? limits.keyPerMinuteYoung : limits.keyPerMinuteEstablished
  const min = await windowCount(st, 'b:min', MINUTE, now)
  if (min.n >= limit) return { kind: 'limited', retryAfterSec: retryAfter(min.until, now) }
  await bump(st, 'b:min', min)
  await st.put(`d:${dedupeId}`, { until: now + limits.dedupeMs } satisfies Dedupe)
  return { kind: 'ok', firstSeenMs: seen.firstSeenMs, confirmed: seen.until === undefined }
}

export async function confirmKeyOn(st: ShardStorage): Promise<void> {
  const seen = await st.get<Seen>('seen')
  if (seen && seen.until !== undefined) await st.put('seen', { firstSeenMs: seen.firstSeenMs } satisfies Seen)
}

export async function admitPairOn(st: ShardStorage, now: number, limits: Limits = LIMITS): Promise<Admission> {
  const min = await windowCount(st, 'b:min', MINUTE, now)
  const day = await windowCount(st, 'b:day', DAY, now)
  if (day.n >= limits.tokenPerDay) return { kind: 'limited', retryAfterSec: retryAfter(day.until, now) }
  if (min.n >= limits.tokenPerMinute) return { kind: 'limited', retryAfterSec: retryAfter(min.until, now) }
  await bump(st, 'b:min', min)
  await bump(st, 'b:day', day)
  return { kind: 'ok' }
}

export async function admitClientOn(st: ShardStorage, now: number, limits: Limits = LIMITS): Promise<Admission> {
  const min = await windowCount(st, 'b:min', MINUTE, now)
  if (min.n >= limits.clientPerMinute) return { kind: 'limited', retryAfterSec: retryAfter(min.until, now) }
  await bump(st, 'b:min', min)
  return { kind: 'ok' }
}

export async function releaseOn(st: ShardStorage, dedupeId: string): Promise<void> {
  await st.delete(`d:${dedupeId}`)
}

/** In-memory shards. `sweep(now)` drops expired records and empty shards. */
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

/**
 * GatewayState over per-shard storages in one process. Key and pair shards go to `open` (SQLite in bun.ts), client
 * shards to `clients` (memory). Calls on one shard run one after another.
 */
export class ShardedState implements GatewayState {
  private chains = new Map<string, Promise<unknown>>()
  readonly clients = new MemoryShards()
  constructor(
    private readonly open: (shard: string) => ShardStorage,
    private readonly blocked: (keyId: string) => Promise<boolean>,
    private readonly limits: Limits = LIMITS,
  ) {}

  private run<T>(shard: string, st: ShardStorage, fn: (st: ShardStorage) => Promise<T>): Promise<T> {
    const next = (this.chains.get(shard) ?? Promise.resolve()).then(() => fn(st))
    const settled = next.catch(() => undefined)
    this.chains.set(shard, settled)
    void settled.then(() => { if (this.chains.get(shard) === settled) this.chains.delete(shard) })
    return next
  }
  private on<T>(shard: string, fn: (st: ShardStorage) => Promise<T>) { return this.run(shard, this.open(shard), fn) }

  admitClient(client: string, now: number) { return this.run(`c:${client}`, this.clients.open(`c:${client}`), (st) => admitClientOn(st, now, this.limits)) }
  isBlocked(keyId: string) { return this.blocked(keyId) }
  admitKey(keyId: string, dedupeId: string, now: number) { return this.on(`k:${keyId}`, (st) => admitKeyOn(st, dedupeId, now, this.limits)) }
  confirmKey(keyId: string) { return this.on(`k:${keyId}`, (st) => confirmKeyOn(st)) }
  admitPair(pairId: string, now: number) { return this.on(`t:${pairId}`, (st) => admitPairOn(st, now, this.limits)) }
  release(keyId: string, dedupeId: string) { return this.on(`k:${keyId}`, (st) => releaseOn(st, dedupeId)) }
  /** drop expired client windows (the persistent storage sweeps itself, see bun.ts) */
  sweep(now: number) { this.clients.sweep(now) }
}

/** A complete in-memory GatewayState (tests). */
export function memoryState(opts: { blocked?: Set<string>; limits?: Limits } = {}) {
  const shards = new MemoryShards()
  const blocked = opts.blocked ?? new Set<string>()
  const state = new ShardedState(shards.open, async (id) => blocked.has(id), opts.limits)
  return { state, shards, blocked }
}
