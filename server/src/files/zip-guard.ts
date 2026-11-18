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

/** Why a zip cannot be opened: too large or complex (zip64, limits), damaged, or encrypted. checkZip turns it into its
 * refusal text; the AI's unzip_file (tools/unzip.ts) into its own. */
export class ZipProblem extends Error {
  constructor(readonly kind: 'complex' | 'damaged' | 'encrypted' | 'busy', readonly why: string) { super(why); this.name = 'ZipProblem' }
}

/** One entry of the central directory, its sizes checked against the limits (not yet inflated). */
export interface ZipEntry {
  /** the name's raw bytes and its general-purpose flags (bit 11: the name is UTF-8) */
  nameBytes: Uint8Array
  flags: number
  /** extra field of the central entry (an Info-ZIP Unicode path, 0x7075, may be in it) */
  extra: Uint8Array
  /** the upper byte of "version made by" (3 = Unix) and the external attributes (a Unix mode in the upper 16 bits) */
  madeBy: number
  external: number
  method: number
  crc: number
  csize: number
  usize: number
  local: number
}

/**
 * The central directory of a zip with every entry's declared sizes checked against the limits: throws a ZipProblem
 * when it is damaged, uses zip64 or encryption, or declares more than the limits (count, total, an entry that expands
 * more than ZIP_RATIO_MAX times above ZIP_RATIO_FROM, a compression method other than stored or deflate). The data is
 * not inflated here (checkZip and unzip_file do that, each with a hard output cap).
 */
export function readCentral(bytes: Uint8Array, limits = { total: ZIP_TOTAL_MAX, entries: ZIP_ENTRIES_MAX }): ZipEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // end of central directory: 22 bytes plus a comment of at most 65535 bytes
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new ZipProblem('damaged', 'no end of central directory')
  const count = v.getUint16(eocd + 10, true)
  const cdSize = v.getUint32(eocd + 12, true)
  const cdOff = v.getUint32(eocd + 16, true)
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new ZipProblem('complex', 'zip64 container')
  if (count > limits.entries) throw new ZipProblem('complex', `more than ${limits.entries} parts in the file`)
  if (cdOff + cdSize > eocd) throw new ZipProblem('damaged', 'central directory out of range')
  const parts: ZipEntry[] = []
  let total = 0
  let p = cdOff
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) throw new ZipProblem('damaged', 'bad central directory entry')
    const madeBy = v.getUint8(p + 5)
    const flags = v.getUint16(p + 8, true)
    const method = v.getUint16(p + 10, true)
    const crc = v.getUint32(p + 16, true)
    const csize = v.getUint32(p + 20, true)
    const usize = v.getUint32(p + 24, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const external = v.getUint32(p + 38, true)
    const local = v.getUint32(p + 42, true)
    if (p + 46 + nameLen + extraLen > eocd) throw new ZipProblem('damaged', 'bad central directory entry')
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen)
    const extra = bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
    p += 46 + nameLen + extraLen + v.getUint16(p + 32, true)
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new ZipProblem('complex', 'zip64 container')
    if (flags & 1) throw new ZipProblem('encrypted', 'it is encrypted')
    total += usize
    if (total > limits.total) throw new ZipProblem('complex', `it expands to more than ${Math.round(limits.total / MIB)} MB`)
    if (usize > ZIP_RATIO_FROM && usize > csize * ZIP_RATIO_MAX) throw new ZipProblem('complex', `a part expands more than ${ZIP_RATIO_MAX} times`)
    if (method !== 0 && method !== 8) throw new ZipProblem('damaged', `compression method ${method}`)
    parts.push({ nameBytes, flags, extra, madeBy, external, method, crc, csize, usize, local })
  }
  return parts
}

/** Where an entry's data starts, after its local header (whose name / extra lengths can differ from the central ones). */
export function entryData(bytes: Uint8Array, e: Pick<ZipEntry, 'local' | 'csize'>): Uint8Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (e.local + 30 > bytes.length || v.getUint32(e.local, true) !== 0x04034b50) throw new ZipProblem('damaged', 'bad local header')
  const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true)
  if (start + e.csize > bytes.length) throw new ZipProblem('damaged', 'entry out of range')
  return bytes.subarray(start, start + e.csize)
}

/** Throws a ToolError when the zip is damaged, uses zip64 or encryption, or expands past the limits. */
export function checkZip(bytes: Uint8Array, limits = { total: ZIP_TOTAL_MAX, entries: ZIP_ENTRIES_MAX }): void {
  try {
    // first the declared sizes of every entry (cheap), then each entry's real size (bounded by the declared total)
    for (const { method, csize, usize, local } of readCentral(bytes, limits)) {
      const data = entryData(bytes, { local, csize })
      if (method === 0) {
        if (csize !== usize) throw new ZipProblem('damaged', 'stored entry with two sizes')
        continue
      }
      let real: number
      try { real = zlib.inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) }).byteLength } catch (e) {
        if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipProblem('complex', 'a part is larger than its header says')
        throw new ZipProblem('damaged', 'bad compressed data')
      }
      if (real !== usize) throw new ZipProblem('damaged', 'a part is not the size its header says')
    }
  } catch (e) {
    if (!(e instanceof ZipProblem)) throw e
    if (e.kind === 'encrypted') throw new ToolError('could not read this file (it is encrypted)')
    throw e.kind === 'complex' ? tooComplex(e.why) : damaged(e.why)
  }
}
