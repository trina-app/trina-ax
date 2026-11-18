// The pictures of one model request, fitted before the request goes on (limits audit #4, QA TC-4907,
// docs/decisions/20261118-limits-images.md). The engine sends every picture of the conversation again with each request:
// a long answer about 60 photos would pass what one request may carry (the providers take 100 images and 32 MB per
// request, and each full picture costs about 2,500 tokens of the context). Claude Code keeps every picture until the
// context is compacted; here the request is fitted instead of the person being asked to continue in a new message:
//
// - the newest pictures go as they are (at least FIT_FULL_NEWEST, fewer only when their bytes pass FIT_REQUEST_BYTES);
// - older ones go again smaller (FIT_SMALL_SIDE px, at most FIT_SMALL_BYTES, the same converter and isolation as reads,
//   cached by the picture's sha256, so each is converted once);
// - past FIT_REQUEST_IMAGES pictures or FIT_REQUEST_BYTES, the oldest give way to a one-line note (FIT_DROPPED_NOTE).
//
// The line between "as sent" and "smaller" moves in steps of FIT_STEP pictures, so the request's start (the part the
// provider caches) changes once every FIT_STEP new pictures, not with each one. Nothing here may break a request: a
// picture that cannot be made smaller stays as it is, and any failure forwards the request unchanged.
import { createHash } from 'node:crypto'

/** the newest pictures of a request that go as they are (the AI is looking at them now) */
export const FIT_FULL_NEWEST = 12
/** the line between full and smaller pictures moves in steps of this many pictures (the cached prompt prefix) */
export const FIT_STEP = 12
/** pictures one request may hold (Anthropic: 100 per request) */
export const FIT_REQUEST_IMAGES = 96
/** base64 characters of all pictures of one request (the providers take 32 MB a request, text and tools included) */
export const FIT_REQUEST_BYTES = 20 * 1024 ** 2
/** an older picture again: longest side and most bytes (about 600 tokens instead of 2,500) */
export const FIT_SMALL_SIDE = 768
export const FIT_SMALL_BYTES = 150_000
/** the cache of smaller pictures (base64 characters together) */
const CACHE_MAX = 64 * 1024 ** 2

export const FIT_DROPPED_NOTE = '[An earlier picture was left out here to keep the request within the model\'s limits. Read its file again to look at it.]'

/** a smaller copy of one picture (JPEG bytes), or null when it cannot be made smaller */
export type Shrink = (bytes: Buffer, signal?: AbortSignal) => Promise<Buffer | null>

export interface FitReport { images: number; shrunk: number; dropped: number }

interface Slot { list: unknown[]; i: number; block: ImageBlock; len: number; small: boolean }
interface ImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: unknown }

const isImage = (b: unknown): b is ImageBlock => {
  const s = (b as { type?: unknown; source?: { type?: unknown; data?: unknown } } | null)
  return !!s && s.type === 'image' && s.source?.type === 'base64' && typeof s.source.data === 'string'
}

/** every base64 picture of the request, oldest first: in a message's content and inside its tool results */
function slots(body: unknown): Slot[] {
  const out: Slot[] = []
  const messages = (body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return out
  const walk = (list: unknown[]) => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]
      if (isImage(b)) out.push({ list, i, block: b, len: b.source.data.length, small: false })
      else if ((b as { type?: unknown } | null)?.type === 'tool_result' && Array.isArray((b as { content?: unknown }).content)) walk((b as { content: unknown[] }).content)
    }
  }
  for (const m of messages) if (Array.isArray((m as { content?: unknown } | null)?.content)) walk((m as { content: unknown[] }).content)
  return out
}

/** smaller copies already made: sha256 of the picture -> its smaller copy (base64), or null (could not be made smaller) */
const cache = new Map<string, string | null>()
let cached = 0
const remember = (k: string, v: string | null) => {
  cache.set(k, v)
  cached += v?.length ?? 0
  for (const [old, val] of cache) {
    if (cached <= CACHE_MAX) break
    cache.delete(old)
    cached -= val?.length ?? 0
  }
}
/** the cache, emptied (tests) */
export const fitCacheClear = () => { cache.clear(); cached = 0 }

async function smaller(s: Slot, shrink: Shrink, signal?: AbortSignal): Promise<boolean> {
  const data = s.block.source.data
  const key = createHash('sha256').update(s.block.source.media_type).update('\0').update(data).digest('hex')
  let small = cache.get(key)
  if (small === undefined) {
    let out: Buffer | null = null
    try { out = await shrink(Buffer.from(data, 'base64'), signal) } catch { signal?.throwIfAborted() }
    small = out && out.length && Math.ceil(out.length / 3) * 4 < data.length ? out.toString('base64') : null
    remember(key, small)
  }
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
  const report: FitReport = { images: n, shrunk: 0, dropped: 0 }
  // 1. too many for one request: the oldest go, in steps (each gives way to a note)
  let drop = n > FIT_REQUEST_IMAGES ? Math.min(n, Math.ceil((n - FIT_REQUEST_IMAGES) / FIT_STEP) * FIT_STEP) : 0
  // 2. older pictures again smaller: everything before the newest FIT_FULL_NEWEST, the line moving in steps
  const older = n > FIT_FULL_NEWEST ? Math.floor((n - FIT_FULL_NEWEST) / FIT_STEP) * FIT_STEP : 0
  for (let k = drop; k < older; k++) if (await smaller(all[k]!, shrink, signal)) report.shrunk++
  // 3. still too many bytes: the next full pictures smaller too, oldest first (the newest last)
  const total = () => all.slice(drop).reduce((t, s) => t + s.len, 0)
  for (let k = Math.max(drop, older); k < n && total() > FIT_REQUEST_BYTES; k++) if (await smaller(all[k]!, shrink, signal)) report.shrunk++
  // 4. and then the oldest go, in steps, until it fits (never the newest picture)
  while (drop < n - 1 && total() > FIT_REQUEST_BYTES) drop = Math.min(n - 1, drop + FIT_STEP)
  for (let k = 0; k < drop; k++) {
    const s = all[k]!
    s.list[s.i] = { type: 'text', text: FIT_DROPPED_NOTE, ...(s.block.cache_control !== undefined ? { cache_control: s.block.cache_control } : {}) }
  }
  report.dropped = drop
  return report
}
