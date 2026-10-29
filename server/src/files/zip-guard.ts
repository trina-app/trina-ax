// A check of a zip container (xlsx, ods, hwpx) before a parser expands it. The central directory gives each entry's
// sizes, but a crafted file can lie about them, so every entry is also inflated once here with a hard output cap
// and its real size must match the declared one. Work and memory stay bounded by ZIP_TOTAL_MAX, one entry at a
// time. Runs in the office worker (files/office-worker.ts), never in the server process.
import zlib from 'node:zlib'
import { ToolError } from '../policy/errors'

const MIB = 1024 * 1024
/** all entries together, uncompressed */
export const ZIP_TOTAL_MAX = 200 * MIB
/** an entry above this size must not expand more than ZIP_RATIO_MAX times */
export const ZIP_RATIO_FROM = 10 * MIB
export const ZIP_RATIO_MAX = 100
export const ZIP_ENTRIES_MAX = 10_000

/** The refusal text for a file that is too large or too complex to read safely (also used by the office worker). */
export const tooComplex = (why: string) => new ToolError(`too large or too complex to read safely as text (${why}); download it to look at it`)
const damaged = (why: string) => new ToolError(`could not read this file (damaged zip container: ${why})`)

export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

/** Throws a ToolError when the zip is damaged, uses zip64 or encryption, or expands past the limits. */
export function checkZip(bytes: Uint8Array): void {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // end of central directory: 22 bytes plus a comment of at most 65535 bytes
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw damaged('no end of central directory')
  const count = v.getUint16(eocd + 10, true)
  const cdSize = v.getUint32(eocd + 12, true)
  const cdOff = v.getUint32(eocd + 16, true)
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw tooComplex('zip64 container')
  if (count > ZIP_ENTRIES_MAX) throw tooComplex(`more than ${ZIP_ENTRIES_MAX} parts in the file`)
  if (cdOff + cdSize > eocd) throw damaged('central directory out of range')
  // first the declared sizes of every entry (cheap), then each entry's real size (bounded by the declared total)
  const parts: { method: number; csize: number; usize: number; local: number }[] = []
  let total = 0
  let p = cdOff
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) throw damaged('bad central directory entry')
    const flags = v.getUint16(p + 8, true)
    const method = v.getUint16(p + 10, true)
    const csize = v.getUint32(p + 20, true)
    const usize = v.getUint32(p + 24, true)
    const local = v.getUint32(p + 42, true)
    p += 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw tooComplex('zip64 container')
    if (flags & 1) throw new ToolError('could not read this file (it is encrypted)')
    total += usize
    if (total > ZIP_TOTAL_MAX) throw tooComplex(`it expands to more than ${ZIP_TOTAL_MAX / MIB} MB`)
    if (usize > ZIP_RATIO_FROM && usize > csize * ZIP_RATIO_MAX) throw tooComplex(`a part expands more than ${ZIP_RATIO_MAX} times`)
    if (method !== 0 && method !== 8) throw damaged(`compression method ${method}`)
    parts.push({ method, csize, usize, local })
  }
  for (const { method, csize, usize, local } of parts) {
    // the data itself: after the local header, whose name / extra lengths can differ from the central ones
    if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw damaged('bad local header')
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    if (start + csize > bytes.length) throw damaged('entry out of range')
    if (method === 0) {
      if (csize !== usize) throw damaged('stored entry with two sizes')
      continue
    }
    let real: number
    try { real = zlib.inflateRawSync(bytes.subarray(start, start + csize), { maxOutputLength: Math.max(usize, 1) }).byteLength } catch (e) {
      if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooComplex('a part is larger than its header says')
      throw damaged('bad compressed data')
    }
    if (real !== usize) throw damaged('a part is not the size its header says')
  }
}
