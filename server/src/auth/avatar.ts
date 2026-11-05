// The check of a profile photo upload and the cutting-out of its metadata (docs/DECISIONS.md "프로필과 사람 목록").
// Pure functions, no image library: the photo is stored as sent except that every metadata block (camera EXIF with the
// place a picture was taken, XMP, comments, colour profiles, text chunks) is cut out of the container. The web app
// already scales and crops the photo in a canvas; the server repeats the rules because it cannot trust the client.
import { AVATAR_MAX_BYTES, AVATAR_MAX_PX, AVATAR_MIN_PX, imageInfo, isTeamIconType, type TeamIconType } from '@mycel/shared'

export type AvatarProblem = 'type' | 'mismatch' | 'too_big' | 'not_square' | 'too_small' | 'too_large' | 'broken' | 'animated'

const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const le32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0
const tag = (b: Uint8Array, i: number) => String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!)
const join = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))

/** PNG: keep only the chunks that draw the picture (and its transparency and gamma); drop text, EXIF, time, animation. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT'])
function cleanPng(b: Uint8Array): Uint8Array | null {
  const out: Uint8Array[] = [b.subarray(0, 8)]
  let i = 8
  let seenEnd = false
  while (i + 12 <= b.length) {
    const len = be32(b, i)
    const end = i + 12 + len
    if (end > b.length) return null
    const name = tag(b, i + 4)
    if (PNG_KEEP.has(name)) out.push(b.subarray(i, end))
    i = end
    if (name === 'IEND') { seenEnd = true; break }
  }
  return seenEnd ? join(out) : null
}

/** JPEG: keep the markers that draw the picture; drop APP1 (EXIF, XMP), the other APPn (except JFIF and Adobe) and comments.
 * Nothing after the end-of-image marker is kept (bytes appended to a JPEG are not part of the picture). */
function cleanJpeg(b: Uint8Array): Uint8Array | null {
  const out: Uint8Array[] = [b.subarray(0, 2)]
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]!
    if (m === 0xff) { i++; continue } // fill byte
    if (m === 0xd9) { out.push(b.subarray(i, i + 2)); return join(out) }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(b.subarray(i, i + 2)); i += 2; continue }
    const len = (b[i + 2]! << 8) | b[i + 3]!
    if (len < 2 || i + 2 + len > b.length) return null
    const seg = b.subarray(i, i + 2 + len)
    const metadata = (m >= 0xe1 && m <= 0xef && m !== 0xee) || m === 0xfe
    if (!metadata) out.push(seg)
    i += 2 + len
    if (m === 0xda) {
      // the picture data runs to the next marker: a 0xff that is not a stuffed 0xff00, a restart marker or a fill byte.
      // That marker is the end of the image (kept, and the rest dropped) or the next table or scan of a progressive file
      let j = i
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && b[j + 1] !== 0xff && !(b[j + 1]! >= 0xd0 && b[j + 1]! <= 0xd7))) j++
      if (j + 1 >= b.length) return null // no end-of-image marker
      out.push(b.subarray(i, j))
      i = j
    }
  }
  return null
}

/** WebP: drop the EXIF, XMP and colour profile chunks and their flags; refuse animation. */
function cleanWebp(b: Uint8Array): Uint8Array | 'animated' | null {
  if (b.length < 20 || le32(b, 4) + 8 > b.length) return null
  const body = b.subarray(12, 8 + le32(b, 4))
  const chunks: Uint8Array[] = []
  let i = 0
  while (i + 8 <= body.length) {
    const len = le32(body, i + 4)
    if (i + 8 + len > body.length) return null
    const name = tag(body, i)
    const chunk = new Uint8Array(body.subarray(i, i + 8 + len)) // a copy: VP8X flags are changed below
    if (name === 'ANIM' || name === 'ANMF') return 'animated'
    if (name === 'VP8X') {
      if (len < 10) return null
      if (chunk[8]! & 0x02) return 'animated'
      chunk[8] = chunk[8]! & ~(0x20 | 0x08 | 0x04) // no ICC profile, EXIF or XMP
    }
    if (name !== 'EXIF' && name !== 'XMP ' && name !== 'ICCP') chunks.push(chunk, new Uint8Array(len & 1))
    i += 8 + len + (len & 1)
  }
  const payload = join(chunks)
  const head = new Uint8Array(12)
  head.set([0x52, 0x49, 0x46, 0x46]); head.set([0x57, 0x45, 0x42, 0x50], 8)
  new DataView(head.buffer).setUint32(4, 4 + payload.length, true)
  return join([head, payload])
}

export type AvatarResult = { ok: true; bytes: Uint8Array<ArrayBuffer>; type: TeamIconType; width: number } | { ok: false; problem: AvatarProblem }

/**
 * Check an upload and return the bytes to store. `declared` is the type the uploader names. Refused: a type other than
 * PNG / JPEG / WebP (SVG included), first bytes that are not that type, more than 256 KiB, a picture that is not a
 * square of 64–512 pixels, an animation, a file that does not parse.
 */
export function prepareAvatar(input: Uint8Array, declared: string): AvatarResult {
  const type = declared.split(';')[0]!.trim().toLowerCase()
  if (!isTeamIconType(type)) return { ok: false, problem: 'type' }
  if (input.byteLength > AVATAR_MAX_BYTES) return { ok: false, problem: 'too_big' }
  const info = imageInfo(input)
  if (!info || info.type !== type) return { ok: false, problem: 'mismatch' }
  if (info.width !== info.height) return { ok: false, problem: 'not_square' }
  if (info.width < AVATAR_MIN_PX) return { ok: false, problem: 'too_small' }
  if (info.width > AVATAR_MAX_PX) return { ok: false, problem: 'too_large' }
  const cleaned = type === 'image/png' ? cleanPng(input) : type === 'image/jpeg' ? cleanJpeg(input) : cleanWebp(input)
  if (cleaned === 'animated') return { ok: false, problem: 'animated' }
  if (!cleaned) return { ok: false, problem: 'broken' }
  // the cleaned file must still read as the same picture
  const again = imageInfo(cleaned)
  if (!again || again.type !== type || again.width !== info.width || again.height !== info.height) return { ok: false, problem: 'broken' }
  return { ok: true, bytes: new Uint8Array(cleaned), type, width: info.width }
}
