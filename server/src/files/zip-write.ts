// A small zip writer for the documents the server makes itself (files/hwpx-write.ts): entries in the order given, each
// stored or deflated, no data descriptors, no zip64, no extra fields, dated 1980-01-01 as Hangul dates its own entries.
// An OCF package (.hwpx, like .epub) needs its `mimetype` entry first and stored, and some readers look for it at byte
// 30 of the file; a general zip library does not promise that, so the bytes are laid out here.
// The reader (readZip) is for a document changed in place (files/hwpx-edit.ts, office worker only): each entry with
// its compressed bytes as they are in the file, so a part that is not changed is copied without being compressed again.
import zlib from 'node:zlib'

export interface ZipEntry {
  /** the entry's path inside the zip (ASCII unless `utf8`) */
  name: string
  data: Uint8Array
  /** keep the bytes as they are (method 0), e.g. an OCF `mimetype`; otherwise deflated (method 8) */
  store?: boolean
  /** the name is UTF-8 (general purpose flag bit 11), as in the file it came from */
  utf8?: boolean
  /** DOS time and date of the entry (default 00:00 on 1980-01-01) */
  time?: number
  date?: number
  /** the entry's compressed bytes as another zip held them, copied as they are: `data` must be what they expand to */
  raw?: { method: 0 | 8; crc: number; body: Uint8Array }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS date of 1980-01-01 (day 1, month 1, year 0), time 00:00:00 */
const DOS_DATE = (0 << 9) | (1 << 5) | 1
const MAX_32 = 0xffffffff

/** The zip file of `entries`. Throws when it would need zip64 (an entry or the whole file of 4 GiB or more). */
export function writeZip(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    // eslint-disable-next-line no-control-regex
    if (!(e.utf8 ? /^[^\x00-\x1f\x7f]+$/u : /^[\x21-\x7e][\x20-\x7e]*$/).test(e.name)) throw new Error(`zip entry name not allowed: ${e.name.slice(0, 80)}`)
    const name = Buffer.from(e.name, e.utf8 ? 'utf8' : 'ascii')
    if (name.length > 0xffff) throw new Error(`zip entry name not allowed: ${e.name.slice(0, 80)}`)
    const method = e.raw ? e.raw.method : e.store ? 0 : 8
    const body = e.raw ? Buffer.from(e.raw.body.buffer, e.raw.body.byteOffset, e.raw.body.byteLength) : e.store ? Buffer.from(e.data) : zlib.deflateRawSync(e.data, { level: 6 })
    const crc = e.raw ? e.raw.crc : crc32(e.data)
    if (e.data.length >= MAX_32 || body.length >= MAX_32 || offset >= MAX_32) throw new Error('zip too large')
    const version = method === 0 ? 10 : 20
    const flags = e.utf8 ? 0x0800 : 0 // sizes are in this header; bit 11: the name is UTF-8
    const time = e.time ?? 0, date = e.date ?? DOS_DATE
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(version, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // no extra field
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(version, 4) // made by: MS-DOS / FAT attributes
    central.writeUInt16LE(version, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  if (entries.length >= 0xffff || offset + cd.length >= MAX_32) throw new Error('zip too large')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return new Uint8Array(Buffer.concat([...locals, cd, end]))
}

/** One entry of a zip's central directory: what zipDirectory reads (nothing is expanded). */
export interface ZipDirEntry { name: string; method: number; crc: number; csize: number; usize: number }

/**
 * The central directory of a zip: names, methods, CRCs and sizes, nothing expanded and no local header read. For the
 * server process (tools/edit-hwpx.ts), which compares two files part by part without parsing either; every offset is
 * bounds-checked and the entry count capped. Throws on anything it cannot read.
 */
export function zipDirectory(bytes: Uint8Array, maxEntries = 10_000): ZipDirEntry[] {
  const bad = (why: string): never => { throw new Error(why) }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) bad('no end of central directory')
  const count = v.getUint16(eocd + 10, true)
  if (count > maxEntries) bad('too many entries')
  let p = v.getUint32(eocd + 16, true)
  const out: ZipDirEntry[] = []
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) bad('bad central directory entry')
    const nlen = v.getUint16(p + 28, true)
    if (p + 46 + nlen > eocd) bad('bad central directory entry')
    out.push({
      name: Buffer.from(bytes.subarray(p + 46, p + 46 + nlen)).toString('latin1'),
      method: v.getUint16(p + 10, true), crc: v.getUint32(p + 16, true), csize: v.getUint32(p + 20, true), usize: v.getUint32(p + 24, true),
    })
    p += 46 + nlen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
  }
  return out
}

/** One entry of a zip as readZip found it: the expanded bytes and the compressed ones, as in the file. */
export interface ZipRead extends ZipEntry { raw: { method: 0 | 8; crc: number; body: Uint8Array } }

/**
 * The entries of a zip in the order of its central directory, each expanded and its CRC checked. Call only after
 * zip-guard's checkZip (sizes and expansion bounded). Refused: an entry whose local header names another file, a name
 * twice (in any case: readers would differ on which one counts), flag bits other than the deflate options, the data
 * descriptor and the UTF-8 name, a name with control characters, a backslash, a leading "/" or a ".." part, and an
 * entry that does not match its checksum. The data descriptor is not needed: the sizes come from the central directory.
 */
export function readZip(bytes: Uint8Array): ZipRead[] {
  const bad = (why: string): never => { throw new Error(why) }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) bad('no end of central directory')
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const out: ZipRead[] = []
  const seen = new Set<string>()
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) bad('bad central directory entry')
    const flags = v.getUint16(p + 8, true)
    const method = v.getUint16(p + 10, true)
    const time = v.getUint16(p + 12, true), date = v.getUint16(p + 14, true)
    const crc = v.getUint32(p + 16, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true)
    const nlen = v.getUint16(p + 28, true)
    const local = v.getUint32(p + 42, true)
    const nameBytes = bytes.subarray(p + 46, p + 46 + nlen)
    p += 46 + nlen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
    if (flags & ~(0x0002 | 0x0004 | 0x0008 | 0x0800)) bad(`entry flags ${flags.toString(16)}`)
    if (method !== 0 && method !== 8) bad(`compression method ${method}`)
    const utf8 = (flags & 0x0800) !== 0
    let name: string
    try { name = new TextDecoder(utf8 ? 'utf-8' : 'latin1', { fatal: true }).decode(nameBytes) } catch { return bad('an entry name is not UTF-8') }
    // eslint-disable-next-line no-control-regex
    if (!name || /[\x00-\x1f\x7f\\]/.test(name) || name.startsWith('/') || name.split('/').includes('..')) bad(`entry name ${JSON.stringify(name.slice(0, 80))}`)
    if (!utf8 && !/^[\x20-\x7e]+$/.test(name)) bad(`entry name ${JSON.stringify(name.slice(0, 80))} is neither ASCII nor marked UTF-8`)
    const key = name.toLowerCase()
    if (seen.has(key)) bad(`the entry ${name.slice(0, 80)} is there twice`)
    seen.add(key)
    if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) bad('bad local header')
    const lnlen = v.getUint16(local + 26, true)
    if (!Buffer.from(bytes.subarray(local + 30, local + 30 + lnlen)).equals(Buffer.from(nameBytes))) bad(`the local header of ${name.slice(0, 80)} names another file`)
    const start = local + 30 + lnlen + v.getUint16(local + 28, true)
    if (start + csize > bytes.length) bad('entry out of range')
    const body = bytes.subarray(start, start + csize)
    let data: Uint8Array
    if (method === 0) data = body
    else {
      let r: { buffer: Buffer; engine: { bytesWritten: number } }
      try { r = zlib.inflateRawSync(body, { maxOutputLength: Math.max(usize, 1), info: true }) as unknown as typeof r } catch { return bad('bad compressed data') }
      // bytes after the end of the compressed stream would be copied along unseen by any reader
      if (r.engine.bytesWritten !== body.length) bad(`${name.slice(0, 80)} has bytes after its compressed data`)
      data = new Uint8Array(r.buffer)
    }
    if (data.length !== usize || crc32(data) !== crc) bad(`${name.slice(0, 80)} does not match its checksum`)
    out.push({ name, data, utf8, time, date, store: method === 0, raw: { method: method as 0 | 8, crc, body } })
  }
  return out
}
