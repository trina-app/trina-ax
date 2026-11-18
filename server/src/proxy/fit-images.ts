// The pictures of one model request, fitted before the request goes on (limits audit #4, QA TC-4907,
// docs/decisions/20261118-limits-images.md). The engine sends every picture of the conversation again with each request:
// a long answer about 60 photos would pass what one request may carry (the providers take 100 images and 32 MB per
// request, and each full picture costs about 2,500 tokens of the context). Claude Code keeps every picture until the
// context is compacted; here the request is fitted instead of the person being asked to continue in a new message:
//
// - the newest pictures go as they are (at least FIT_FULL_NEWEST);
// - older ones go smaller (FIT_SMALL_SIDE px, at most FIT_SMALL_BYTES, the same converter and isolation as reads,
//   cached by the picture's sha256, so each is converted once);
// - past FIT_REQUEST_BYTES, more pictures go smaller, a block of FIT_STEP at a time, oldest first;
// - past FIT_REQUEST_IMAGES pictures or still past FIT_REQUEST_BYTES, the oldest give way to a one-line note that names
//   the picture's file when the read said it (droppedNote).
//
// The lines between "as sent", "smaller" and "left out" move in steps of FIT_STEP pictures, so the request's start (the
// part the provider caches) changes once every FIT_STEP new pictures, not with each one.
//
// Conversions run at most FIT_PARALLEL at once, outside the request: a request waits for the smaller copies of its
// older pictures at most FIT_WAIT_MS and sends the ones still being made as they are (the next request uses the copy).
// Only what a request needs to fit at all (the byte limit) is waited for. Nothing here may break a request: a picture
// that cannot be made smaller stays as it is, and any failure forwards the request unchanged.

/** the newest pictures of a request that go as they are (the AI is looking at them now) */
export const FIT_FULL_NEWEST = 12
/** the lines between full, smaller and left out move in steps of this many pictures (the cached prompt prefix) */
export const FIT_STEP = 12
/** pictures one request may hold (Anthropic: 100 per request) */
export const FIT_REQUEST_IMAGES = 96
/** base64 characters of all pictures of one request (the providers take 32 MB a request, text and tools included) */
export const FIT_REQUEST_BYTES = 20 * 1024 ** 2
/** an older picture again: longest side and most bytes (about 600 tokens instead of 2,500) */
export const FIT_SMALL_SIDE = 768
export const FIT_SMALL_BYTES = 150_000
/** conversions of the proxy at the same time (the reads' converter slots are shared, files/vision.ts VISION_PARALLEL) */
export const FIT_PARALLEL = 2
/** how long a request waits for the smaller copies of its older pictures before it goes on without them */
export const FIT_WAIT_MS = 1500
/** the cache of smaller pictures (base64 characters together), and of pictures that cannot be made smaller (a count) */
let cacheMax = 64 * 1024 ** 2
const NULL_MAX = 2048
/** a picture whose conversion a limit stopped this many times (time, memory: not a busy server) counts as "cannot be
 * made smaller": the same picture would stop the converter on every request */
export const FIT_TRIES = 2
/** conversions waiting at most; past it a picture goes on as it is (made smaller by a later request) */
export const FIT_QUEUE_MAX = 64

/** what an image left out of the request becomes; `file` when the read said which file it showed */
export const droppedNote = (file: string | null) => file
  ? `[The picture of ${file} was left out here to keep the request within the model's limits. Read that file again to look at it.]`
  : '[An earlier picture was left out here to keep the request within the model\'s limits. Read its file again to look at it.]'
export const FIT_DROPPED_NOTE = droppedNote(null)

/** A smaller copy of one picture (JPEG bytes); null when it cannot be made smaller (the same answer every time: it is
 * kept); a throw when the conversion did not finish (busy, a limit, a stop: tried again on a later request). */
export type Shrink = (bytes: Buffer) => Promise<Buffer | null>

export interface FitReport { images: number; shrunk: number; dropped: number; pending: number }

interface Slot { list: unknown[]; i: number; block: ImageBlock; len: number; file: string | null; key?: string; small?: boolean }
interface ImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: unknown }

const isImage = (b: unknown): b is ImageBlock => {
  const s = (b as { type?: unknown; source?: { type?: unknown; data?: unknown } } | null)
  return !!s && s.type === 'image' && s.source?.type === 'base64' && typeof s.source.data === 'string'
}
/** the file a read named right before its picture ("Image <path> (shown below).", files/service.ts readImage) */
const fileOf = (prev: unknown): string | null => {
  const t = (prev as { type?: unknown; text?: unknown } | null)
  if (t?.type !== 'text' || typeof t.text !== 'string') return null
  const m = /^Image (.{1,400}?) \(shown below\)\./.exec(t.text)
  return m ? m[1]! : null
}

/** every base64 picture of the request, oldest first: in a message's content and inside its tool results */
function slots(body: unknown): Slot[] {
  const out: Slot[] = []
  const messages = (body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return out
  const walk = (list: unknown[]) => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]
      if (isImage(b)) out.push({ list, i, block: b, len: b.source.data.length, file: i > 0 ? fileOf(list[i - 1]) : null })
      else if ((b as { type?: unknown } | null)?.type === 'tool_result' && Array.isArray((b as { content?: unknown }).content)) walk((b as { content: unknown[] }).content)
    }
  }
  for (const m of messages) if (Array.isArray((m as { content?: unknown } | null)?.content)) walk((m as { content: unknown[] }).content)
  return out
}

// ---------------- the cache and the conversions ----------------
/** smaller copies made: sha256 of the picture -> its smaller copy (base64), or null (it cannot be made smaller) */
const cache = new Map<string, string>()
const cannot = new Map<string, true>()
let cached = 0
const remember = (k: string, v: string | null) => {
  if (v === null) {
    cannot.set(k, true)
    if (cannot.size > NULL_MAX) cannot.delete(cannot.keys().next().value!)
    return
  }
  cache.set(k, v)
  cached += v.length
  for (const [old, val] of cache) {
    if (cached <= cacheMax) break
    cache.delete(old)
    cached -= val.length
  }
}
/** limit stops so far, by picture (at most NULL_MAX pictures) */
const stops = new Map<string, number>()
const stoppedOnce = (k: string) => {
  const n = (stops.get(k) ?? 0) + 1
  stops.delete(k)
  if (n >= FIT_TRIES) { remember(k, null); return }
  stops.set(k, n)
  if (stops.size > NULL_MAX) stops.delete(stops.keys().next().value!)
}
/** the copy (or "cannot"), refreshed as the most recently used (the caches let the least recently used go first) */
const lookup = (k: string): string | null | undefined => {
  const v = cache.get(k)
  if (v !== undefined) { cache.delete(k); cache.set(k, v); return v }
  if (cannot.has(k)) { cannot.delete(k); cannot.set(k, true); return null }
  return undefined
}
/** conversions running or waiting, by picture */
const pending = new Map<string, Promise<void>>()
let active = 0
const queue: (() => void)[] = []
async function limited(f: () => Promise<void>) {
  if (active >= FIT_PARALLEL) await new Promise<void>((go) => queue.push(go))
  else active++
  try { await f() } finally {
    const next = queue.shift()
    if (next) next()
    else active--
  }
}
/** the cache, emptied (tests); conversions still running finish into the new cache */
/** the cache's size (tests) */
export const fitCacheLimit = (bytes: number) => { cacheMax = bytes }
export const fitCacheClear = () => { cache.clear(); cannot.clear(); stops.clear(); cached = 0 }
/** conversions running and waiting (tests) */
export const fitQueue = () => ({ running: active, waiting: queue.length })

/** the picture's cache key, hashed off the event loop (WebCrypto) */
async function keyOf(b: ImageBlock): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', Buffer.from(b.source.media_type + '\0' + b.source.data, 'latin1'))
  return Buffer.from(d).toString('hex')
}

/** starts (or joins) the conversion of one picture; resolves when it is in the cache, or failed for now. null: the
 * queue is full (FIT_QUEUE_MAX), the picture goes on as it is */
function convert(key: string, data: string, shrink: Shrink): Promise<void> | null {
  let p = pending.get(key)
  if (p) return p
  if (active >= FIT_PARALLEL && queue.length >= FIT_QUEUE_MAX) return null
  p = limited(async () => {
    if (cache.has(key) || cannot.has(key)) return
    let out: Buffer | null
    try { out = await shrink(Buffer.from(data, 'base64')) } catch (e) {
      // not finished: tried again later; a limit (not a busy server) that stops the same picture again ends the tries
      if ((e as { code?: unknown } | null)?.code !== 'vision_busy') stoppedOnce(key)
      return
    }
    stops.delete(key)
    remember(key, out && out.length && Math.ceil(out.length / 3) * 4 < data.length ? out.toString('base64') : null)
  }).finally(() => pending.delete(key))
  pending.set(key, p)
  return p
}

const stopped = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal?.aborted) reject(signal.reason)
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
})
/** waits for `ps` (at most `ms` when given); a stop of the request is passed on */
async function wait(ps: Promise<void>[], signal?: AbortSignal, ms?: number) {
  if (!ps.length) return
  const all = Promise.all(ps).then(() => {})
  const race: Promise<unknown>[] = [all]
  if (signal) { const st = stopped(signal); st.catch(() => {}); race.push(st) }
  let t: ReturnType<typeof setTimeout> | undefined
  if (ms !== undefined) race.push(new Promise<void>((done) => { t = setTimeout(done, ms) }))
  try { await Promise.race(race) } finally { if (t) clearTimeout(t) }
}

/** the smaller copy in place of the picture, when there is one */
function apply(s: Slot): boolean {
  const small = s.key && !s.small ? lookup(s.key) : undefined
  if (!small) return false
  s.block.source = { type: 'base64', media_type: 'image/jpeg', data: small }
  s.len = small.length
  s.small = true
  return true
}

/**
 * Fits the pictures of one Messages API request body (changed in place). Returns what was done, or null when the
 * request has no pictures.
 */
export async function fitRequestImages(body: unknown, shrink: Shrink, signal?: AbortSignal): Promise<FitReport | null> {
  const all = slots(body)
  const n = all.length
  if (!n) return null
  signal?.throwIfAborted()
  const report: FitReport = { images: n, shrunk: 0, dropped: 0, pending: 0 }
  // 1. too many for one request: the oldest go, in steps
  let drop = n > FIT_REQUEST_IMAGES ? Math.min(n - 1, Math.ceil((n - FIT_REQUEST_IMAGES) / FIT_STEP) * FIT_STEP) : 0
  // 2. older pictures smaller: everything before the newest FIT_FULL_NEWEST, the line moving in steps
  const older = n > FIT_FULL_NEWEST ? Math.floor((n - FIT_FULL_NEWEST) / FIT_STEP) * FIT_STEP : 0
  const start = async (from: number, to: number) => {
    const ps: Promise<void>[] = []
    for (let k = from; k < to; k++) {
      const s = all[k]!
      s.key ??= await keyOf(s.block)
      if (lookup(s.key) !== undefined) continue
      const p = convert(s.key, s.block.source.data, shrink)
      if (p) ps.push(p)
    }
    return ps
  }
  const settle = (from: number, to: number) => { for (let k = from; k < to; k++) if (apply(all[k]!)) report.shrunk++ }
  await wait(await start(drop, older), signal, FIT_WAIT_MS)
  settle(drop, older)
  // 3. still too many bytes: the next pictures smaller too, a block of FIT_STEP at a time, oldest first (waited for:
  //    the request does not fit without them)
  const total = () => all.slice(drop).reduce((t, s) => t + s.len, 0)
  for (let line = Math.max(drop, older); line < n && total() > FIT_REQUEST_BYTES; line += FIT_STEP) {
    const to = Math.min(n, line + FIT_STEP)
    await wait([...await start(line, to), ...all.slice(drop, line).map((s) => (s.key && pending.get(s.key)) || Promise.resolve())], signal)
    settle(drop, to)
  }
  // 4. and then the oldest go, in steps, until it fits (never the newest picture)
  while (drop < n - 1 && total() > FIT_REQUEST_BYTES) drop = Math.min(n - 1, drop + FIT_STEP)
  for (let k = 0; k < drop; k++) {
    const s = all[k]!
    s.list[s.i] = { type: 'text', text: droppedNote(s.file), ...(s.block.cache_control !== undefined ? { cache_control: s.block.cache_control } : {}) }
  }
  report.dropped = drop
  report.pending = all.slice(drop).filter((s) => s.key && pending.has(s.key)).length
  return report
}
