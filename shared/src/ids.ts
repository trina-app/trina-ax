// Identifiers. Every row id is a UUIDv7 (time-ordered, so ids sort by creation and index well), except
// users.id, which is a short stable slug because it is also the personal folder name users/<id>/.
import { z } from 'zod'

const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** UUIDv7 string (lower-case, RFC 9562). */
export const Uuid7 = z.string().regex(UUID7_RE, 'expected a UUIDv7')
export type Uuid7 = z.infer<typeof Uuid7>
export const isUuid7 = (s: unknown): s is string => typeof s === 'string' && UUID7_RE.test(s)

/** users.id: lower-case slug, also the personal folder name (users/<id>/). Never changes; `name` is the display name. */
export const UserId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'lower-case letters, digits, "-" or "_", at most 32')
export type UserId = z.infer<typeof UserId>

let lastMs = 0
let seq = 0
/**
 * Generate a UUIDv7. Works in Bun, Node and browsers (crypto.getRandomValues). Ids generated in the same
 * millisecond by this process stay monotonic (12-bit counter in rand_a, RFC 9562 method 1).
 */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  let ms = now
  if (ms <= lastMs) {
    ms = lastMs
    seq = (seq + 1) & 0xfff
    if (seq === 0) ms = ++lastMs // counter wrapped: borrow the next millisecond
  } else {
    lastMs = ms
    seq = (b[6]! & 0x07) << 8 | b[7]! // random start, leaves room to count up
  }
  // 48-bit big-endian unix ms
  b[0] = Math.floor(ms / 2 ** 40) & 0xff
  b[1] = Math.floor(ms / 2 ** 32) & 0xff
  b[2] = (ms >>> 24) & 0xff
  b[3] = (ms >>> 16) & 0xff
  b[4] = (ms >>> 8) & 0xff
  b[5] = ms & 0xff
  b[6] = 0x70 | ((seq >>> 8) & 0x0f)
  b[7] = seq & 0xff
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Milliseconds since the epoch encoded in a UUIDv7. */
export function uuidv7Time(id: string): number {
  const h = id.replace(/-/g, '').slice(0, 12)
  return parseInt(h, 16)
}
