// What the mailbox keeps (shared/src/cloud-protocol/mail-in.ts "Who holds what"): per team its seal key, the address
// hashes it takes mail for and the sealed items not taken yet; an index hash → team; counters for the limits; the
// nonces of recent requests. Nothing in clear: no address, no mail.
//
// One implementation over a small key-value interface (KvLike): a Map in memory (tests, the dev server) or a Durable
// Object's storage (worker.ts). A sealed item larger than one value may hold is split into chunks.
import type { MailInItem } from '../../shared/src/cloud-protocol/mail-in.ts'

/** The part of a Durable Object's storage this uses (and what MemoryKv does). */
export interface KvLike {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list<T = unknown>(o: { prefix: string }): Promise<Map<string, T>>
}

export class MemoryKv implements KvLike {
  readonly m = new Map<string, unknown>()
  async get<T>(key: string) { return structuredClone(this.m.get(key)) as T | undefined }
  async put(key: string, value: unknown) { this.m.set(key, structuredClone(value)) }
  async delete(key: string) { return this.m.delete(key) }
  async list<T>(o: { prefix: string }) {
    const out = new Map<string, T>()
    for (const k of [...this.m.keys()].sort()) if (k.startsWith(o.prefix)) out.set(k, structuredClone(this.m.get(k)) as T)
    return out
  }
}

/** One queued item: the item without its `ct` (kept in chunks), its lease and size. */
interface ItemHead { item: Omit<MailInItem, 'sealed'> & { sealed: Omit<MailInItem['sealed'], 'ct'> }; chunks: number; bytes: number; leaseUntil: number; at: number }
interface TeamDoc { sealKey: string | null; hashes: string[] }
/** Kept apart from TeamDoc: the gateway writes these per mail, and a mailbox whose gateway and API run in separate
 * processes (mailbox-ses) must not write back an old seal key or address set with them. */
interface StatsDoc { expired: number; items: number; bytes: number }

/** A Durable Object value is at most 2 MB (SQLite storage): chunks well under it. */
const CHUNK = 1_000_000

export interface MailStoreOptions {
  /** the largest `ct` part in one value (characters); DynamoDB items are at most 400 KB, so mailbox-ses uses less */
  chunk?: number
}

export class MailStore {
  private readonly chunk: number
  constructor(readonly kv: KvLike, o: MailStoreOptions = {}) {
    this.chunk = o.chunk ?? CHUNK
    if (!Number.isInteger(this.chunk) || this.chunk < 1024) throw new Error('chunk: an integer of at least 1024')
  }

  // ---------- teams ----------
  async team(teamId: string): Promise<TeamDoc> {
    const d = await this.kv.get<TeamDoc>(`t:${teamId}`)
    return d ? { sealKey: d.sealKey ?? null, hashes: d.hashes ?? [] } : { sealKey: null, hashes: [] }
  }
  private async saveTeam(teamId: string, d: TeamDoc) { await this.kv.put(`t:${teamId}`, d) }
  private async stats(teamId: string): Promise<StatsDoc> {
    const d = await this.kv.get<Partial<StatsDoc>>(`s:${teamId}`)
    return { expired: d?.expired ?? 0, items: d?.items ?? 0, bytes: d?.bytes ?? 0 }
  }
  private async saveStats(teamId: string, d: StatsDoc) { await this.kv.put(`s:${teamId}`, d) }
  async setSealKey(teamId: string, sealKey: string) { const d = await this.team(teamId); d.sealKey = sealKey; await this.saveTeam(teamId, d) }
  /** The team's whole set of address hashes, replaced at once. A hash another team holds is not taken. Answers the set. */
  async syncHashes(teamId: string, hashes: string[]): Promise<string[]> {
    const d = await this.team(teamId)
    const next: string[] = []
    for (const h of hashes) {
      const owner = await this.kv.get<string>(`h:${h}`)
      if (owner === undefined || owner === teamId) next.push(h)
    }
    const keep = new Set(next)
    for (const h of d.hashes) if (!keep.has(h)) await this.kv.delete(`h:${h}`)
    for (const h of next) await this.kv.put(`h:${h}`, teamId)
    d.hashes = next
    await this.saveTeam(teamId, d)
    return next
  }
  /** The team an address hash belongs to now, or null. */
  async teamOfHash(hash: string): Promise<string | null> { return (await this.kv.get<string>(`h:${hash}`)) ?? null }
  /** Items dropped unread since the last poll: read and reset. */
  async takeExpired(teamId: string): Promise<number> {
    const d = await this.stats(teamId)
    const n = d.expired
    if (n) { d.expired = 0; await this.saveStats(teamId, d) }
    return n
  }

  // ---------- counters ----------
  /** A counter in a time window (`window` names it, e.g. an hour's number); `by` 0 only reads. */
  async bump(key: string, by: number): Promise<number> {
    const k = `c:${key}`
    const n = ((await this.kv.get<number>(k)) ?? 0) + by
    if (by) await this.kv.put(k, n)
    return n
  }
  /** Counters of windows before `keepFrom` (by the window number in the key's last part) go. */
  async pruneCounters(isOld: (key: string) => boolean) {
    for (const k of (await this.kv.list({ prefix: 'c:' })).keys()) if (isOld(k.slice(2))) await this.kv.delete(k)
  }

  // ---------- nonces ----------
  /** true the first time (key, nonce) is seen within `ttlMs`. */
  async freshNonce(key: string, nonce: string, now: number, ttlMs: number): Promise<boolean> {
    const k = `n:${key}:${nonce}`
    const until = await this.kv.get<number>(k)
    if (until !== undefined && until > now) return false
    await this.kv.put(k, now + ttlMs)
    return true
  }
  async pruneNonces(now: number) {
    for (const [k, until] of await this.kv.list<number>({ prefix: 'n:' })) if (until <= now) await this.kv.delete(k)
  }

  // ---------- items ----------
  private async heads(teamId: string): Promise<Map<string, ItemHead>> { return this.kv.list<ItemHead>({ prefix: `q:${teamId}:` }) }
  async queueStats(teamId: string): Promise<{ items: number; bytes: number }> {
    // kept in the team's stats (put and drop move them): no list of the queue per mail
    const d = await this.stats(teamId)
    return { items: d.items, bytes: d.bytes }
  }
  async putItem(teamId: string, item: MailInItem, at: number) {
    const ct = item.sealed.ct
    const chunks = Math.max(1, Math.ceil(ct.length / this.chunk))
    for (let i = 0; i < chunks; i++) await this.kv.put(`b:${teamId}:${item.id}:${i}`, ct.slice(i * this.chunk, (i + 1) * this.chunk))
    const { ct: _drop, ...sealed } = item.sealed
    // the key sorts by arrival time, so a poll hands out the oldest first
    await this.kv.put(`q:${teamId}:${String(at).padStart(15, '0')}:${item.id}`, { item: { ...item, sealed }, chunks, bytes: ct.length, leaseUntil: 0, at } satisfies ItemHead)
    await this.moveStats(teamId, 1, ct.length)
  }
  private async moveStats(teamId: string, items: number, bytes: number) {
    const d = await this.stats(teamId)
    d.items = Math.max(0, d.items + items); d.bytes = Math.max(0, d.bytes + bytes)
    await this.saveStats(teamId, d)
  }
  private async full(teamId: string, key: string, h: ItemHead): Promise<MailInItem> {
    let ct = ''
    for (let i = 0; i < h.chunks; i++) ct += (await this.kv.get<string>(`b:${teamId}:${h.item.id}:${i}`)) ?? ''
    return { ...h.item, sealed: { ...h.item.sealed, ct } }
  }
  private async drop(teamId: string, key: string, h: ItemHead) {
    for (let i = 0; i < h.chunks; i++) await this.kv.delete(`b:${teamId}:${h.item.id}:${i}`)
    await this.kv.delete(key)
    await this.moveStats(teamId, -1, -h.bytes)
  }
  /** Items taken by the team (deleted at once). Ids of other teams or unknown ids do nothing. */
  async ack(teamId: string, ids: string[]) {
    if (!ids.length) return
    const want = new Set(ids)
    for (const [k, h] of await this.heads(teamId)) if (want.has(h.item.id)) await this.drop(teamId, k, h)
  }
  /** Items older than `ttlMs` go unread and are counted for the team's next poll. */
  async expire(teamId: string, now: number, ttlMs: number): Promise<number> {
    let n = 0
    // the keys sort by arrival: the first one still young ends the walk
    for (const [k, h] of await this.heads(teamId)) { if (h.at > now - ttlMs) break; await this.drop(teamId, k, h); n++ }
    if (n) { const d = await this.stats(teamId); d.expired += n; await this.saveStats(teamId, d) }
    return n
  }
  /** Hand out waiting items (not leased now), oldest first, within the limits (one item always goes when one waits);
   * each is leased until `now + leaseMs`. */
  async take(teamId: string, now: number, leaseMs: number, maxItems: number, maxBytes: number): Promise<MailInItem[]> {
    const out: MailInItem[] = []
    let bytes = 0
    for (const [k, h] of await this.heads(teamId)) {
      if (h.leaseUntil > now) continue
      if (out.length >= maxItems || (out.length > 0 && bytes + h.bytes > maxBytes)) break
      out.push(await this.full(teamId, k, h))
      bytes += h.bytes
      await this.kv.put(k, { ...h, leaseUntil: now + leaseMs })
    }
    return out
  }
  /** An item waits that is not leased now (a poll would hand it out). */
  async ready(teamId: string, now: number): Promise<boolean> {
    for (const h of (await this.heads(teamId)).values()) if (h.leaseUntil <= now) return true
    return false
  }
  /** The earliest time a leased item comes free (for a held poll), or null. */
  async nextLeaseEnd(teamId: string, now: number): Promise<number | null> {
    let at: number | null = null
    for (const h of (await this.heads(teamId)).values()) if (h.leaseUntil > now && (at === null || h.leaseUntil < at)) at = h.leaseUntil
    return at
  }
}
