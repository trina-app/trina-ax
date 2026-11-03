// A small zip writer for the documents the server makes itself (files/hwpx-write.ts): entries in the order given, each
// stored or deflated, no data descriptors, no zip64, no extra fields, dated 1980-01-01 as Hangul dates its own entries.
// An OCF package (.hwpx, like .epub) needs its `mimetype` entry first and stored, and some readers look for it at byte
// 30 of the file; a general zip library does not promise that, so the bytes are laid out here.
import zlib from 'node:zlib'

export interface ZipEntry {
  /** the entry's path inside the zip (ASCII: no flag for UTF-8 names is written) */
  name: string
  data: Uint8Array
  /** keep the bytes as they are (method 0), e.g. an OCF `mimetype`; otherwise deflated (method 8) */
  store?: boolean
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
    if (!/^[\x21-\x7e][\x20-\x7e]*$/.test(e.name) || e.name.length > 0xffff) throw new Error(`zip entry name not allowed: ${e.name.slice(0, 80)}`)
    const name = Buffer.from(e.name, 'ascii')
    const method = e.store ? 0 : 8
    const body = e.store ? Buffer.from(e.data) : zlib.deflateRawSync(e.data, { level: 6 })
    const crc = crc32(e.data)
    if (e.data.length >= MAX_32 || body.length >= MAX_32 || offset >= MAX_32) throw new Error('zip too large')
    const version = method === 0 ? 10 : 20
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(version, 4)
    local.writeUInt16LE(0, 6) // flags: sizes are in this header, names are ASCII
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // time 00:00
    local.writeUInt16LE(DOS_DATE, 12)
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
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(DOS_DATE, 14)
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
