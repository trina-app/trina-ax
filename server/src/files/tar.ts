// Tar archives for the AI's unzip_file (tools/unzip.ts: .tar, .tar.gz / .tgz, and a lone .gz file) and make_zip
// (tools/make-zip.ts: TarStream writes .tar and .tar.gz). QA TC-5057, docs/decisions/20261118-tar-archives.md.
// - Reading: a small ustar / pax / GNU reader with strict bounds over bytes already in memory (the archive, or what
//   gunzipBounded unpacked). Every header's checksum is checked, every size must fit in what is left of the archive,
//   pax records must parse exactly, and nothing is read past the end. The entries then go through files/unzip.ts
//   planEntries, the zip's own rules: an absolute path or ".." (also from a pax "path" or a GNU long name) refuses the
//   whole archive; links, hard links, device files, FIFOs and sparse files are skipped and named; the entry count, the
//   unpacked total (UNZIP_TOTAL_MAX) and the zip's expansion rule (ZIP_RATIO_MAX above ZIP_RATIO_FROM) for gzip.
// - Not read: bzip2 / xz tars (no decoder in the server), 7z, rar; multi-volume and old GNU sparse tars are refused.
// - Writing: the backups' headers (system/tar.ts tarHeaders: a pax record with the exact path, so Korean names and long
//   paths come out right in GNU tar, bsdtar on macOS and Windows' tar.exe, and 7-Zip), the bytes streamed in through
//   make_zip's own permission-checked reads. system/tar.ts readTar is not used for reading: it fails a whole archive on a
//   link (a backup must be exact), reads names as UTF-8 only and has no GNU long names; people's tars need the zip's
//   skip-and-name rules and Windows' CP949 names.
import fs from 'node:fs'
import zlib from 'node:zlib'
import { ZIP_RATIO_FROM, ZIP_RATIO_MAX, ZipProblem } from './zip-guard'
import { tarHeaders } from '../system/tar'
import { decodeLegacy, MAIL_ENTRY, planEntries, UNZIP_ENTRIES_MAX, UNZIP_TOTAL_MAX, type RawEntry, type ZipPlan } from './unzip'

const BLOCK = 512
const MIB = 1024 * 1024
/** what a gzip may unpack to (the files' limit plus room for the tar's own headers and padding); tests lower it */
export const TAR_LIMITS = { expanded: UNZIP_TOTAL_MAX + 32 * MIB }
/** a pax header's or a GNU long name's own data */
const META_MAX = 1 * MIB
const UTF8 = new TextDecoder('utf-8', { fatal: true })

export const isGzip = (b: Uint8Array) => b.length >= 18 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8

/** Unsigned (and the old signed) sum of a header with its checksum field read as spaces. */
function checksumOk(h: Uint8Array): boolean {
  let u = 0
  let s = 0
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i]!
    u += b
    s += b > 127 ? b - 256 : b
  }
  let want: number
  try { want = num(h, 148, 8) } catch { return false }
  return want === u || want === s
}

/** A numeric header field: octal digits (spaces or NULs around them), or GNU base-256 when its first byte has the high
 * bit. Anything else is a damaged header. */
function num(h: Uint8Array, off: number, len: number): number {
  const f = h.subarray(off, off + len)
  if (f[0]! & 0x80) {
    if (f[0] === 0xff) throw new ZipProblem('damaged', 'a negative size in a tar header')
    let n = f[0]! & 0x7f
    for (let i = 1; i < len; i++) {
      n = n * 256 + f[i]!
      if (n > Number.MAX_SAFE_INTEGER) throw new ZipProblem('complex', 'a size too large in a tar header')
    }
    return n
  }
  let i = 0
  while (i < len && (f[i] === 0x20 || f[i] === 0)) i++
  let n = 0
  let digits = 0
  for (; i < len && f[i]! >= 0x30 && f[i]! <= 0x37; i++, digits++) n = n * 8 + (f[i]! - 0x30)
  for (; i < len; i++) if (f[i] !== 0x20 && f[i] !== 0) throw new ZipProblem('damaged', 'a bad number in a tar header')
  if (!digits && f.some((b) => b !== 0 && b !== 0x20)) throw new ZipProblem('damaged', 'a bad number in a tar header')
  return n
}

/** A NUL-ended text field */
const field = (h: Uint8Array, off: number, len: number) => { const f = h.subarray(off, off + len); const z = f.indexOf(0); return z < 0 ? f : f.subarray(0, z) }
const allZero = (h: Uint8Array) => { for (let i = 0; i < h.length; i++) if (h[i] !== 0) return false; return true }

/** A tar starts with a header whose checksum is right (a ustar magic or not: old tars have none). */
export function isTar(b: Uint8Array): boolean {
  if (b.length < BLOCK) return false
  const h = b.subarray(0, BLOCK)
  if (allZero(h) || h[0] === 0) return false
  return checksumOk(h)
}

/** pax extended-header records ("<len> <key>=<value>\n"), each exactly its stated length. Only the keys read here
 * (path, size, GNU.sparse.*) keep their value as text: others, such as extended attributes, may be binary. A path that
 * is not UTF-8 (hdrcharset=BINARY) is read like a ustar name. */
function paxRecords(d: Uint8Array): Map<string, string> {
  const out = new Map<string, string>()
  let p = 0
  while (p < d.length) {
    if (d[p] === 0) break // padding some writers leave
    let q = p
    let len = 0
    while (q < d.length && d[q]! >= 0x30 && d[q]! <= 0x39 && q - p < 8) len = len * 10 + (d[q++]! - 0x30)
    if (q === p || d[q] !== 0x20 || len <= q - p + 1 || p + len > d.length || d[p + len - 1] !== 0x0a) throw new ZipProblem('damaged', 'a bad pax header in the tar')
    const rec = d.subarray(q + 1, p + len - 1)
    const eq = rec.indexOf(0x3d)
    if (eq <= 0) throw new ZipProblem('damaged', 'a bad pax header in the tar')
    let key: string
    try { key = UTF8.decode(rec.subarray(0, eq)) } catch { throw new ZipProblem('damaged', 'a pax header that is not UTF-8') }
    const v = rec.subarray(eq + 1)
    if (key === 'path') out.set(key, decodeLegacy(v))
    else if (key === 'size' || key.startsWith('GNU.sparse.')) out.set(key, String.fromCharCode(...v.subarray(0, 64)))
    else out.set(key, '')
    p += len
  }
  return out
}

/**
 * The entries of a tar (in memory), each checked against the archive's bounds: a header's checksum, a size that fits
 * in what is left, pax and GNU long-name data under META_MAX. The entry count and the files' total are the zip's
 * limits. Throws a ZipProblem; nothing is written.
 */
export function readTar(tar: Uint8Array): RawEntry[] {
  const out: RawEntry[] = []
  let off = 0
  let pax: Map<string, string> | null = null
  let longName: string | null = null
  let meta = 0
  let total = 0
  for (;;) {
    if (off + BLOCK > tar.length) {
      // the end blocks are missing (some writers stop after the last file): fine when nothing is left over
      if (off === tar.length || allZero(tar.subarray(off))) break
      throw new ZipProblem('damaged', 'the tar is cut short')
    }
    const h = tar.subarray(off, off + BLOCK)
    if (allZero(h)) break
    if (!checksumOk(h)) throw new ZipProblem('damaged', 'a tar header does not match its checksum')
    const type = String.fromCharCode(h[156]!)
    const headerSize = num(h, 124, 12)
    // a pax "size" sets the size of the entry it comes before (only that one; numbers only)
    let size = headerSize
    const meta1 = type === 'x' || type === 'g' || type === 'L' || type === 'K'
    if (!meta1 && pax?.has('size')) {
      const v = pax.get('size')!
      if (!/^\d{1,16}$/.test(v)) throw new ZipProblem('damaged', 'a bad size in a pax header')
      size = Number(v)
    }
    const dataOff = off + BLOCK
    if (size > tar.length - dataOff) throw new ZipProblem('damaged', 'the tar is cut short')
    const next = dataOff + Math.ceil(size / BLOCK) * BLOCK
    const data = tar.subarray(dataOff, dataOff + size)
    if (meta1) {
      if (++meta > UNZIP_ENTRIES_MAX * 4) throw new ZipProblem('complex', `more than ${UNZIP_ENTRIES_MAX} parts in the file`)
      if (size > META_MAX) throw new ZipProblem('complex', 'a tar header larger than 1 MB')
      if (type === 'x') { const r = paxRecords(data); pax = new Map([...(pax ?? []), ...r]) }
      else if (type === 'L') longName = decodeLegacy(field(data, 0, data.length))
      // 'g' (global pax defaults) and 'K' (a long link target): links are never saved, and a global default never
      // names an entry here; each entry's own name decides
      off = next
      continue
    }
    if (type === 'S' || type === 'M') throw new ZipProblem('complex', 'a sparse or multi-volume tar')
    if (type === 'V') { pax = null; longName = null; off = next; continue } // a volume label, not a file
    if (out.length >= UNZIP_ENTRIES_MAX) throw new ZipProblem('complex', `more than ${UNZIP_ENTRIES_MAX} parts in the file`)
    const ustar = h[257] === 0x75 && h[258] === 0x73 && h[259] === 0x74 && h[260] === 0x61 && h[261] === 0x72
    const prefix = ustar ? field(h, 345, 155) : new Uint8Array(0)
    const own = field(h, 0, 100)
    const name = pax?.get('path')?.normalize('NFC') ?? longName ?? (prefix.length ? `${decodeLegacy(prefix)}/${decodeLegacy(own)}` : decodeLegacy(own))
    const sparse = !!pax && [...pax.keys()].some((k) => k.startsWith('GNU.sparse.'))
    let kind: RawEntry['kind']
    if (sparse) kind = 'sparse'
    else if (type === '0' || type === '\0' || type === '7') kind = name.endsWith('/') ? 'dir' : 'file'
    else if (type === '5') kind = 'dir'
    else if (type === '1') kind = 'hardlink'
    else if (type === '2') kind = 'link'
    else kind = 'other' // devices, FIFOs, vendor types: only plain files and folders come out
    if (kind === 'file') {
      total += size
      if (total > UNZIP_TOTAL_MAX) throw new ZipProblem('complex', `it expands to more than ${Math.round(UNZIP_TOTAL_MAX / MIB)} MB`)
    }
    out.push({ name, kind, size: kind === 'file' ? size : 0, entry: MAIL_ENTRY, ...(kind === 'file' ? { data: { off: dataOff, len: size } } : {}) })
    pax = null
    longName = null
    off = next
  }
  return out
}

/** The plan of a tar, as planZip's (files/unzip.ts planEntries: the same rules). */
export function planTar(tar: Uint8Array, o: { unwrap?: boolean } = {}): ZipPlan {
  return planEntries(readTar(tar), o)
}

/** A lone .gz (not a tar inside): one file, named after the .gz without its ending (as gunzip does; the name stored in
 * the gzip header is not used). */
export function planGz(gzName: string, unpacked: number): ZipPlan {
  let name = gzName.replace(/\.gz$/i, '').replace(/\.tgz$/i, '.tar')
  if (!name) name = 'file'
  return planEntries([{ name, kind: 'file', size: unpacked, entry: MAIL_ENTRY, data: { off: 0, len: unpacked } }], { unwrap: false })
}

/**
 * A gzip unpacked in memory on the zlib thread pool, with the same bounds as a zip's parts: at most TAR_LIMITS.expanded
 * bytes, and above ZIP_RATIO_FROM at most ZIP_RATIO_MAX times its packed size. Stops as soon as a bound is passed (a
 * gzip bomb never fills memory). Throws a ZipProblem.
 */
export function gunzipBounded(gz: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const g = zlib.createGunzip({ chunkSize: 64 * 1024 })
    const chunks: Buffer[] = []
    let n = 0
    let done = false
    const onAbort = () => fail(new ZipProblem('damaged', 'stopped'))
    const fail = (e: Error) => { if (done) return; done = true; signal?.removeEventListener('abort', onAbort); g.destroy(); chunks.length = 0; reject(e) }
    signal?.addEventListener('abort', onAbort, { once: true })
    g.on('data', (c: Buffer) => {
      if (done) return
      n += c.length
      if (n > TAR_LIMITS.expanded) { fail(new ZipProblem('complex', `it expands to more than ${Math.round(UNZIP_TOTAL_MAX / MIB)} MB`)); return }
      if (n > ZIP_RATIO_FROM && n > gz.length * ZIP_RATIO_MAX) { fail(new ZipProblem('complex', `it expands more than ${ZIP_RATIO_MAX} times`)); return }
      chunks.push(c)
    })
    g.on('error', () => fail(new ZipProblem('damaged', 'bad compressed data')))
    g.on('end', () => { if (done) return; done = true; signal?.removeEventListener('abort', onAbort); resolve(Buffer.concat(chunks, n)) })
    g.end(gz)
  })
}

// ---------------- writing ----------------

export class TarChanged extends Error {}

/** A .tar or .tar.gz written to a new file one entry at a time (make_zip): the file's bytes streamed in, never all
 * in memory. A file's size is given up front (its header comes first); a file that turns out longer or shorter throws
 * TarChanged. */
export class TarStream {
  private fd: number
  private gz: zlib.Gzip | null
  private failed: Error | null = null
  private closed = false
  private written = 0
  constructor(readonly at: string, gzip: boolean) {
    this.fd = fs.openSync(at, 'wx', 0o600)
    this.gz = gzip ? zlib.createGzip({ level: 6 }) : null
    this.gz?.on('data', (c: Buffer) => { try { this.raw(c) } catch (e) { this.failed = e as Error; this.gz!.destroy() } })
    this.gz?.on('error', (e) => { this.failed ??= e })
  }

  /** bytes in the file so far */
  get size() { return this.written }

  private raw(b: Uint8Array) {
    for (let off = 0; off < b.length;) off += fs.writeSync(this.fd, b, off, b.length - off)
    this.written += b.length
  }

  private async put(b: Uint8Array) {
    if (this.failed) throw this.failed
    if (!this.gz) { this.raw(b); return }
    if (!this.gz.write(b)) await new Promise<void>((resolve) => { this.gz!.once('drain', resolve); this.gz!.once('close', resolve) })
    if (this.failed) throw this.failed
  }

  /** the backups' header blocks (system/tar.ts): a pax header with the exact path and mtime, then the ustar header */
  private async head(name: string, type: 'file' | 'dir', size: number, mtime: Date, mode: number) {
    for (const b of tarHeaders(name, size, mode, mtime.getTime(), type)) await this.put(b)
  }

  private async pad(n: number) { const r = n % BLOCK; if (r) await this.put(Buffer.alloc(BLOCK - r)) }

  /** An (empty) folder entry: `name` without the trailing "/". */
  async folder(name: string, mtime: Date) { await this.head(name.replace(/\/+$/, '') + '/', 'dir', 0, mtime, 0o755) }

  /** One file of `size` bytes: `feed` calls `push` with each piece in order (and may wait). */
  async file(name: string, mtime: Date, size: number, feed: (push: (piece: Buffer) => Promise<void>) => Promise<void>): Promise<{ usize: number }> {
    await this.head(name, 'file', size, mtime, 0o644)
    let n = 0
    await feed(async (piece) => {
      n += piece.length
      if (n > size) throw new TarChanged('a file grew while it was read')
      await this.put(piece)
    })
    if (n !== size) throw new TarChanged('a file shrank while it was read')
    await this.pad(size)
    return { usize: n }
  }

  /** The two end blocks; the gzip is finished and the file closed. */
  async finish() {
    await this.put(Buffer.alloc(BLOCK * 2))
    if (this.gz) {
      const gz = this.gz
      await new Promise<void>((resolve, reject) => { gz.once('end', resolve); gz.once('error', reject); gz.end() })
      if (this.failed) throw this.failed
    }
    this.close()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.gz?.destroy()
    fs.closeSync(this.fd)
  }
}
