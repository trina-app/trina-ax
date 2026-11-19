// A zip written as a stream, front to back (no seeking), for the team export (system/team-export-zip.ts): its bytes go
// through age to presigned upload URLs, so nothing can be patched afterwards.
//
// What every common unzip opens (macOS Archive Utility, Windows Explorer, 7-Zip, unzip):
// - a file under 2 GiB: deflate, its CRC and sizes in a data descriptor after the data (bit 3), the usual streamed
//   zip. Already-compressed types (JPEG, MP4, zip …) at level 1, so they cost little time.
// - a larger file: stored, its CRC read in a first pass so the local header holds the real CRC and sizes. Archive
//   Utility does not open a stored entry with a data descriptor. A file that changes between the two passes fails
//   the zip (a corrupt entry would be worse). 4 GiB or more: zip64 sizes in the local and central headers.
// - offsets past 4 GiB or more than 65,534 entries: zip64 in the central directory and a zip64 end record.
// Names are UTF-8 with the UTF-8 flag (bit 11), so Korean and Japanese names come out right on Windows and macOS.
import zlib from 'node:zlib'
import { dosTime } from '../files/zip-stream'
import { deflateRaw, type Bytes } from './streams'

const MAX_32 = 0xffffffff
const MAX_16 = 0xffff
/** a file this big or bigger is stored, never deflated (deflate output must stay under 4 GiB); tests lower it */
export const ZIP_OUT_LIMITS = { storeFrom: 2 * 1024 ** 3 }

const crc32 = (b: Uint8Array, prev = 0): number => (zlib as unknown as { crc32: (d: Uint8Array, v?: number) => number }).crc32(b, prev) >>> 0

export class ZipSourceChanged extends Error { name = 'ZipSourceChanged' }

export interface ZipOutEntry {
  /** path inside the zip with "/" between folders; a folder without its trailing "/" */
  name: string
  mtime: Date
  /** a folder entry (no data) */
  dir?: boolean
  /** the file's bytes; called twice for a big stored file (once for its CRC), so each call must start over */
  data?: () => Bytes
  /** the byte count when known (a file on disk): decides deflate or store */
  size?: number
  /** bytes that are already compressed: deflate at level 1 */
  compressed?: boolean
}

interface Central { name: Buffer; method: number; at: { time: number; date: number }; crc: number; csize: number; usize: number; offset: number; dir: boolean; bit3: boolean }

function localHeader(name: Buffer, method: number, at: { time: number; date: number }, o: { bit3: boolean; crc: number; csize: number; usize: number; zip64: boolean }): Buffer {
  const extra = o.zip64 ? Buffer.alloc(20) : Buffer.alloc(0)
  if (o.zip64) {
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(16, 2)
    extra.writeBigUInt64LE(BigInt(o.usize), 4)
    extra.writeBigUInt64LE(BigInt(o.csize), 12)
  }
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)
  h.writeUInt16LE(o.zip64 ? 45 : 20, 4)
  h.writeUInt16LE(0x0800 | (o.bit3 ? 0x0008 : 0), 6)
  h.writeUInt16LE(method, 8)
  h.writeUInt16LE(at.time, 10)
  h.writeUInt16LE(at.date, 12)
  h.writeUInt32LE(o.bit3 ? 0 : o.crc, 14)
  h.writeUInt32LE(o.bit3 ? 0 : o.zip64 ? MAX_32 : o.csize, 18)
  h.writeUInt32LE(o.bit3 ? 0 : o.zip64 ? MAX_32 : o.usize, 22)
  h.writeUInt16LE(name.length, 26)
  h.writeUInt16LE(extra.length, 28)
  return Buffer.concat([h, name, extra])
}

function centralHeader(c: Central): Buffer {
  const big: bigint[] = []
  if (c.usize >= MAX_32) big.push(BigInt(c.usize))
  if (c.csize >= MAX_32) big.push(BigInt(c.csize))
  if (c.offset >= MAX_32) big.push(BigInt(c.offset))
  const extra = big.length ? Buffer.alloc(4 + 8 * big.length) : Buffer.alloc(0)
  if (big.length) {
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(8 * big.length, 2)
    big.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + 8 * i))
  }
  const h = Buffer.alloc(46)
  h.writeUInt32LE(0x02014b50, 0)
  h.writeUInt16LE((3 << 8) | (big.length ? 45 : 20), 4) // made by Unix (its mode in the external attributes)
  h.writeUInt16LE(big.length ? 45 : 20, 6)
  h.writeUInt16LE(0x0800 | (c.bit3 ? 0x0008 : 0), 8)
  h.writeUInt16LE(c.method, 10)
  h.writeUInt16LE(c.at.time, 12)
  h.writeUInt16LE(c.at.date, 14)
  h.writeUInt32LE(c.crc, 16)
  h.writeUInt32LE(Math.min(c.csize, MAX_32), 20)
  h.writeUInt32LE(Math.min(c.usize, MAX_32), 24)
  h.writeUInt16LE(c.name.length, 28)
  h.writeUInt16LE(extra.length, 30)
  // a folder: the DOS directory bit and drwxr-xr-x; a file: -rw-r--r--
  h.writeUInt32LE((((c.dir ? 0o040755 : 0o100644) << 16) | (c.dir ? 0x10 : 0)) >>> 0, 38)
  h.writeUInt32LE(Math.min(c.offset, MAX_32), 42)
  return Buffer.concat([h, c.name, extra])
}

function endRecords(count: number, cdStart: number, cdSize: number): Buffer {
  const zip64 = count >= MAX_16 || cdStart >= MAX_32 || cdSize >= MAX_32
  const out: Buffer[] = []
  if (zip64) {
    const r = Buffer.alloc(56)
    r.writeUInt32LE(0x06064b50, 0)
    r.writeBigUInt64LE(44n, 4)
    r.writeUInt16LE((3 << 8) | 45, 12)
    r.writeUInt16LE(45, 14)
    r.writeBigUInt64LE(BigInt(count), 24)
    r.writeBigUInt64LE(BigInt(count), 32)
    r.writeBigUInt64LE(BigInt(cdSize), 40)
    r.writeBigUInt64LE(BigInt(cdStart), 48)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeBigUInt64LE(BigInt(cdStart + cdSize), 8)
    loc.writeUInt32LE(1, 16)
    out.push(r, loc)
  }
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0)
  e.writeUInt16LE(zip64 ? MAX_16 : count, 8)
  e.writeUInt16LE(zip64 ? MAX_16 : count, 10)
  e.writeUInt32LE(zip64 ? MAX_32 : cdSize, 12)
  e.writeUInt32LE(zip64 ? MAX_32 : cdStart, 16)
  out.push(e)
  return Buffer.concat(out)
}

/** The zip of `entries`, in order, as a byte stream. */
export async function* zipOut(entries: AsyncIterable<ZipOutEntry> | Iterable<ZipOutEntry>): AsyncGenerator<Uint8Array> {
  let offset = 0
  const central: Central[] = []
  const out = (b: Uint8Array) => { offset += b.length; return b }
  for await (const e of entries as AsyncIterable<ZipOutEntry>) {
    const at = dosTime(e.mtime)
    if (e.dir || !e.data) {
      const name = Buffer.from(e.name.replace(/\/+$/, '') + '/', 'utf8')
      if (name.length > MAX_16) throw new Error('zip entry name too long')
      const c: Central = { name, method: 0, at, crc: 0, csize: 0, usize: 0, offset, dir: true, bit3: false }
      yield out(localHeader(name, 0, at, { bit3: false, crc: 0, csize: 0, usize: 0, zip64: false }))
      central.push(c)
      continue
    }
    const name = Buffer.from(e.name, 'utf8')
    if (name.length > MAX_16) throw new Error('zip entry name too long')
    const local = offset
    if ((e.size ?? 0) >= ZIP_OUT_LIMITS.storeFrom) {
      // stored: the CRC first, then the bytes (checked against the first pass)
      let crc = 0
      let size = 0
      for await (const c of e.data()) { crc = crc32(c, crc); size += c.length }
      const zip64 = size >= MAX_32
      yield out(localHeader(name, 0, at, { bit3: false, crc, csize: size, usize: size, zip64 }))
      let crc2 = 0
      let size2 = 0
      for await (const c of e.data()) {
        crc2 = crc32(c, crc2)
        size2 += c.length
        if (size2 > size) throw new ZipSourceChanged(`${e.name} changed during the export`)
        yield out(c)
      }
      if (size2 !== size || crc2 !== crc) throw new ZipSourceChanged(`${e.name} changed during the export`)
      central.push({ name, method: 0, at, crc, csize: size, usize: size, offset: local, dir: false, bit3: false })
      continue
    }
    yield out(localHeader(name, 8, at, { bit3: true, crc: 0, csize: 0, usize: 0, zip64: false }))
    let crc = 0
    let usize = 0
    const src = e.data()
    const tapped = (async function* () {
      for await (const c of src) {
        crc = crc32(c, crc)
        usize += c.length
        if (usize >= MAX_32) throw new ZipSourceChanged(`${e.name} grew past 4 GB during the export`)
        yield c
      }
    })()
    const start = offset
    for await (const c of deflateRaw(tapped, e.compressed ? 1 : 6)) yield out(c)
    const csize = offset - start
    if (csize >= MAX_32) throw new ZipSourceChanged(`${e.name} grew past 4 GB during the export`)
    const d = Buffer.alloc(16)
    d.writeUInt32LE(0x08074b50, 0)
    d.writeUInt32LE(crc, 4)
    d.writeUInt32LE(csize, 8)
    d.writeUInt32LE(usize, 12)
    yield out(d)
    central.push({ name, method: 8, at, crc, csize, usize, offset: local, dir: false, bit3: true })
  }
  const cdStart = offset
  for (const c of central) yield out(centralHeader(c))
  yield out(endRecords(central.length, cdStart, offset - cdStart))
}
