// A zip written to a file one entry at a time, for the AI's make_zip (tools/make-zip.ts): each file streamed through
// zlib's deflate (or stored, for files that are already compressed), its local header written first and its CRC and
// sizes written into it afterwards (no data descriptors), names in UTF-8 with the UTF-8 flag (bit 11) so Windows,
// macOS and Korean names come out right, folders as their own entries. No zip64: the whole file stays under 4 GiB and
// 65,535 entries (make_zip's limits are far below). files/zip-write.ts is the in-memory writer for the documents the
// server makes; files/unzip.ts reads zips.
import fs from 'node:fs'
import zlib from 'node:zlib'

const crc32 = (b: Uint8Array, prev = 0): number => (zlib as unknown as { crc32: (d: Uint8Array, v?: number) => number }).crc32(b, prev) >>> 0
const MAX_32 = 0xffffffff

/** DOS time and date of a moment, in the server's local time (as zip tools show them); 1980-01-01 for anything earlier */
export function dosTime(d: Date): { time: number; date: number } {
  if (!(d.getFullYear() >= 1980)) return { time: 0, date: (1 << 5) | 1 }
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.min(d.getFullYear(), 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export class ZipTooLarge extends Error {}

export class ZipStream {
  private fd: number
  private offset = 0
  private central: Buffer[] = []
  private closed = false
  constructor(readonly at: string) { this.fd = fs.openSync(at, 'wx', 0o600) }

  get size() { return this.offset }
  get entries() { return this.central.length }

  private put(b: Uint8Array) {
    if (this.offset + b.length >= MAX_32) throw new ZipTooLarge('the zip would be 4 GB or larger')
    for (let off = 0; off < b.length;) off += fs.writeSync(this.fd, b, off, b.length - off, this.offset + off)
    this.offset += b.length
  }

  private header(name: Buffer, method: number, at: { time: number; date: number }): Buffer {
    const h = Buffer.alloc(30 + name.length)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(method === 0 ? 10 : 20, 4)
    h.writeUInt16LE(0x0800, 6) // the name is UTF-8; sizes are in this header (written after the data)
    h.writeUInt16LE(method, 8)
    h.writeUInt16LE(at.time, 10)
    h.writeUInt16LE(at.date, 12)
    // crc, compressed and uncompressed size: filled in after the data (offsets 14, 18, 22)
    h.writeUInt16LE(name.length, 26)
    h.writeUInt16LE(0, 28)
    name.copy(h, 30)
    return h
  }

  private centralEntry(name: Buffer, method: number, at: { time: number; date: number }, crc: number, csize: number, usize: number, local: number, dir: boolean) {
    const c = Buffer.alloc(46 + name.length)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE((3 << 8) | 20, 4) // made by Unix (its mode in the external attributes), version 2.0
    c.writeUInt16LE(method === 0 ? 10 : 20, 6)
    c.writeUInt16LE(0x0800, 8)
    c.writeUInt16LE(method, 10)
    c.writeUInt16LE(at.time, 12)
    c.writeUInt16LE(at.date, 14)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(csize, 20)
    c.writeUInt32LE(usize, 24)
    c.writeUInt16LE(name.length, 28)
    // a folder: the DOS directory bit and drwxr-xr-x; a file: -rw-r--r--
    c.writeUInt32LE((((dir ? 0o040755 : 0o100644) << 16) | (dir ? 0x10 : 0)) >>> 0, 38)
    c.writeUInt32LE(local, 42)
    name.copy(c, 46)
    this.central.push(c)
  }

  /** An (empty) folder entry: `name` without the trailing "/". */
  folder(name: string, mtime: Date) {
    const n = Buffer.from(name.replace(/\/+$/, '') + '/', 'utf8')
    const at = dosTime(mtime)
    const local = this.offset
    this.put(this.header(n, 0, at))
    this.centralEntry(n, 0, at, 0, 0, 0, local, true)
  }

  /**
   * One file: `feed` calls `push` with each piece of its bytes in order (and may wait). `store`: keep the bytes as they
   * are (a JPEG, an MP4, a zip: deflate would only cost time). Returns the bytes it took and wrote.
   */
  async file(name: string, mtime: Date, store: boolean, feed: (push: (piece: Buffer) => Promise<void>) => Promise<void>): Promise<{ usize: number; csize: number }> {
    const n = Buffer.from(name, 'utf8')
    if (n.length > 0xffff) throw new Error('zip entry name too long')
    const at = dosTime(mtime)
    const method = store ? 0 : 8
    const local = this.offset
    this.put(this.header(n, method, at))
    let crc = 0
    let usize = 0
    const start = this.offset
    if (store) {
      await feed(async (piece) => { crc = crc32(piece, crc); usize += piece.length; this.put(piece) })
    } else {
      const d = zlib.createDeflateRaw({ level: 6 })
      let failed: Error | null = null
      d.on('data', (c: Buffer) => { try { this.put(c) } catch (e) { failed = e as Error; d.destroy() } })
      const ended = new Promise<void>((resolve, reject) => { d.once('end', resolve); d.once('error', reject); d.once('close', () => (failed ? reject(failed) : resolve())) })
      try {
        await feed(async (piece) => {
          if (failed) throw failed
          crc = crc32(piece, crc)
          usize += piece.length
          if (usize >= MAX_32) throw new ZipTooLarge('a file is 4 GB or larger')
          if (!d.write(piece)) await new Promise<void>((resolve) => { d.once('drain', resolve); d.once('close', resolve) })
        })
        d.end()
        await ended
        if (failed) throw failed
      } catch (e) { d.destroy(); throw e }
    }
    const csize = this.offset - start
    const fix = Buffer.alloc(12)
    fix.writeUInt32LE(crc, 0)
    fix.writeUInt32LE(csize, 4)
    fix.writeUInt32LE(usize, 8)
    fs.writeSync(this.fd, fix, 0, 12, local + 14)
    this.centralEntry(n, method, at, crc, csize, usize, local, false)
    return { usize, csize }
  }

  /** The central directory and its end record; the file is closed. */
  finish() {
    const cdStart = this.offset
    for (const c of this.central) this.put(c)
    const cdSize = this.offset - cdStart
    if (this.central.length > 0xfffe) throw new ZipTooLarge('too many entries')
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.central.length, 8)
    end.writeUInt16LE(this.central.length, 10)
    end.writeUInt32LE(cdSize, 12)
    end.writeUInt32LE(cdStart, 16)
    this.put(end)
    this.close()
  }

  close() { if (!this.closed) { this.closed = true; fs.closeSync(this.fd) } }
}
