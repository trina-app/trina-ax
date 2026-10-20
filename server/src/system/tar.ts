// Streaming tar (POSIX ustar + PAX headers) for backups and exports. Only what we need: regular files and folders,
// UTF-8 names of any length, millisecond mtimes. The writer reads files in 1 MB pieces with async I/O, so a backup of a
// large team folder neither blocks the event loop nor holds a file in memory; the reader writes entries as they
// arrive. Archives open with the system tar (bsdtar / GNU tar) too.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const BLOCK = 512
const CHUNK = 1 << 20
/** largest size the 12-byte octal ustar field can hold */
export const USTAR_MAX_SIZE = 8 ** 11 - 1
/** PAX extended / global headers are small key=value lists; anything bigger is refused (never buffered) */
const PAX_MAX = 1 << 20

export interface TarEntryInput {
  /** archive path, forward slashes, no leading slash */
  name: string
  type: 'file' | 'dir'
  /** absolute source path for files */
  source?: string
  /** in-memory content for small generated files (exports, metadata) */
  data?: Uint8Array
  mode?: number
  mtimeMs?: number
}

/** What actually went into the archive for one file (size/mtime around the read, for the backup manifest). */
export interface TarWritten { name: string; size: number; mtimeMs: number; changedWhileReading: boolean }

function octal(n: number, len: number): string {
  const s = Math.floor(n).toString(8)
  return s.length >= len ? '7'.repeat(len - 1) : s.padStart(len - 1, '0')
}

/** Header block(s) for one entry (exported for the format tests). */
export function tarHeaders(name: string, size: number, mode: number, mtimeMs: number, type: 'file' | 'dir'): Uint8Array[] {
  return entryHeaders(name, size, mode, mtimeMs, type)
}

function writeStr(buf: Uint8Array, off: number, len: number, s: string) {
  const b = Buffer.from(s, 'utf8')
  buf.set(b.subarray(0, len), off)
}

function header(name: string, size: number, mode: number, mtimeSec: number, typeflag: string): Uint8Array {
  const h = new Uint8Array(BLOCK)
  writeStr(h, 0, 100, name)
  writeStr(h, 100, 8, octal(mode & 0o7777, 8))
  writeStr(h, 108, 8, octal(0, 8))
  writeStr(h, 116, 8, octal(0, 8))
  writeStr(h, 124, 12, octal(size, 12))
  writeStr(h, 136, 12, octal(mtimeSec, 12))
  h.fill(0x20, 148, 156) // checksum placeholder = spaces
  writeStr(h, 156, 1, typeflag)
  writeStr(h, 257, 6, 'ustar\0')
  writeStr(h, 263, 2, '00')
  let sum = 0
  for (const b of h) sum += b
  writeStr(h, 148, 8, octal(sum, 7) + '\0')
  return h
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body) + 1
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body)
  return `${len}${body}`
}

const pad = (n: number) => new Uint8Array((BLOCK - (n % BLOCK)) % BLOCK)

/** Header block(s) for one entry: a PAX 'x' header carries the exact path and the mtime with milliseconds. */
function entryHeaders(name: string, size: number, mode: number, mtimeMs: number, type: 'file' | 'dir'): Uint8Array[] {
  const out: Uint8Array[] = []
  const fullName = type === 'dir' && !name.endsWith('/') ? name + '/' : name
  const ascii = /^[\x20-\x7e]*$/.test(fullName) && Buffer.byteLength(fullName) <= 99
  // the ustar size field holds at most 8^11 - 1 bytes (8 GiB); bigger files carry their exact size in the PAX header
  const pax = paxRecord('mtime', (Math.floor(mtimeMs) / 1000).toFixed(3)) + (ascii ? '' : paxRecord('path', fullName))
    + (type === 'file' && size > USTAR_MAX_SIZE ? paxRecord('size', String(size)) : '')
  const paxBytes = Buffer.from(pax, 'utf8')
  out.push(header('PaxHeader/' + (ascii ? fullName : 'entry').slice(0, 80), paxBytes.length, 0o644, mtimeMs / 1000, 'x'), paxBytes, pad(paxBytes.length))
  const shortName = ascii ? fullName : Buffer.from(fullName, 'utf8').subarray(0, 99).toString('utf8').replace(/�+$/, '')
  out.push(header(shortName, type === 'dir' ? 0 : size, mode, mtimeMs / 1000, type === 'dir' ? '5' : '0'))
  return out
}

export function checkArchiveName(name: string): string {
  const n = name.replace(/\\/g, '/')
  if (!n || n.startsWith('/') || n.split('/').some((p) => p === '..' || p === '.' ) || n.includes('\0')) throw new Error(`unsafe archive path: ${JSON.stringify(name)}`)
  return n.replace(/\/+$/, '')
}

/**
 * Tar stream of the given entries. Files are read with async I/O in 1 MB pieces; the size is the size at open time.
 * If a file shrinks while being read the rest is zero-filled and `changedWhileReading` is set (the next backup picks
 * it up again); growth beyond the opening size is ignored for the same reason. Files that vanished are skipped.
 */
export async function* tarStream(entries: AsyncIterable<TarEntryInput> | Iterable<TarEntryInput>, onWritten?: (w: TarWritten) => void): AsyncGenerator<Uint8Array> {
  for await (const e of entries) {
    const name = checkArchiveName(e.name)
    if (e.type === 'dir') {
      for (const b of entryHeaders(name, 0, e.mode ?? 0o755, e.mtimeMs ?? Date.now(), 'dir')) yield b
      continue
    }
    if (e.data) {
      for (const b of entryHeaders(name, e.data.byteLength, e.mode ?? 0o644, e.mtimeMs ?? Date.now(), 'file')) yield b
      yield e.data
      yield pad(e.data.byteLength)
      onWritten?.({ name, size: e.data.byteLength, mtimeMs: e.mtimeMs ?? Date.now(), changedWhileReading: false })
      continue
    }
    let fh: fsp.FileHandle
    try { fh = await fsp.open(e.source!, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    try {
      const st = await fh.stat()
      if (!st.isFile()) continue
      const size = st.size
      for (const b of entryHeaders(name, size, e.mode ?? (st.mode & 0o777), st.mtimeMs, 'file')) yield b
      let done = 0
      let short = false
      while (done < size) {
        const want = Math.min(CHUNK, size - done)
        const buf = new Uint8Array(want)
        const { bytesRead } = await fh.read(buf, 0, want, done)
        if (bytesRead === 0) {
          // the file shrank (a log truncated during the backup): fill up to the size in the header, in pieces, so
          // a file that lost gigabytes does not become one allocation of that size
          short = true
          while (done < size) { const n = Math.min(CHUNK, size - done); yield new Uint8Array(n); done += n }
          break
        }
        yield bytesRead === want ? buf : buf.subarray(0, bytesRead)
        done += bytesRead
      }
      yield pad(size)
      const after = await fh.stat()
      onWritten?.({ name, size, mtimeMs: st.mtimeMs, changedWhileReading: short || after.size !== size || after.mtimeMs !== st.mtimeMs })
    } finally {
      await fh.close()
    }
  }
  yield new Uint8Array(BLOCK * 2)
}

export interface TarEntryOut { name: string; type: 'file' | 'dir'; size: number; mode: number; mtimeMs: number }

function parseOctal(b: Uint8Array, off: number, len: number): number {
  const s = Buffer.from(b.subarray(off, off + len)).toString('latin1').replace(/[\0 ]+$/g, '').trim()
  return s ? parseInt(s, 8) : 0
}
function cstr(b: Uint8Array, off: number, len: number): string {
  const sub = b.subarray(off, off + len)
  const z = sub.indexOf(0)
  return Buffer.from(z >= 0 ? sub.subarray(0, z) : sub).toString('utf8')
}

/** Byte-exact reader over an async chunk source. */
class ByteReader {
  private buf = new Uint8Array(0)
  private it: AsyncIterator<Uint8Array>
  private ended = false
  constructor(src: AsyncIterable<Uint8Array>) { this.it = src[Symbol.asyncIterator]() }
  private async fill(n: number): Promise<boolean> {
    while (this.buf.byteLength < n && !this.ended) {
      const r = await this.it.next()
      if (r.done) { this.ended = true; break }
      const c = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value as ArrayBuffer)
      const nb = new Uint8Array(this.buf.byteLength + c.byteLength)
      nb.set(this.buf); nb.set(c, this.buf.byteLength)
      this.buf = nb
    }
    return this.buf.byteLength >= n
  }
  async read(n: number): Promise<Uint8Array> {
    if (!(await this.fill(n))) throw new Error('archive is truncated')
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }
  /** stream n bytes in pieces of at most CHUNK */
  async *take(n: number): AsyncGenerator<Uint8Array> {
    let left = n
    while (left > 0) {
      if (this.buf.byteLength === 0 && !(await this.fill(1))) throw new Error('archive is truncated')
      const k = Math.min(left, this.buf.byteLength, CHUNK)
      const out = this.buf.slice(0, k)
      this.buf = this.buf.subarray(k)
      left -= k
      yield out
    }
  }
}

/**
 * Read a tar stream; for every entry call `onEntry` with a body iterator (files) that must be consumed (or ignored:
 * the reader skips what is left). Only regular files and folders are accepted; anything else, or an unsafe path
 * ("..", absolute), fails the whole archive.
 */
export async function readTar(src: AsyncIterable<Uint8Array>, onEntry: (e: TarEntryOut, body: AsyncIterable<Uint8Array>) => Promise<void>): Promise<number> {
  const r = new ByteReader(src)
  let pax: Record<string, string> = {}
  let count = 0
  for (;;) {
    const h = await r.read(BLOCK)
    if (h.every((b) => b === 0)) return count
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!
    if (sum !== parseOctal(h, 148, 8)) throw new Error('archive header checksum mismatch')
    const type = String.fromCharCode(h[156] || 0x30)
    const size = parseOctal(h, 124, 12)
    const padLen = (BLOCK - (size % BLOCK)) % BLOCK
    if (type === 'x') {
      if (size > PAX_MAX) throw new Error('PAX header too large')
      const body = Buffer.from(await r.read(size))
      await r.read(padLen)
      pax = {}
      let i = 0
      while (i < body.length) {
        const sp = body.indexOf(0x20, i)
        const len = sp > i ? parseInt(body.subarray(i, sp).toString('latin1'), 10) : NaN
        if (!(len > 0) || i + len > body.length) throw new Error('bad PAX header')
        const rec = body.subarray(sp + 1, i + len - 1).toString('utf8') // "key=value" without the newline
        const eq = rec.indexOf('=')
        if (eq > 0) pax[rec.slice(0, eq)] = rec.slice(eq + 1)
        i += len
      }
      continue
    }
    if (type === 'g') {
      // global header: ignored, but skipped as a stream (a crafted size must not make us buffer it)
      if (size > PAX_MAX) throw new Error('PAX global header too large')
      for await (const _ of r.take(size + padLen)) { /* skip */ }
      continue
    }
    const prefix = cstr(h, 345, 155)
    const rawName = pax.path ?? (prefix ? prefix + '/' + cstr(h, 0, 100) : cstr(h, 0, 100))
    const mtimeMs = pax.mtime ? Math.round(parseFloat(pax.mtime) * 1000) : parseOctal(h, 136, 12) * 1000
    let fileSize = size
    if (pax.size !== undefined) {
      if (!/^[0-9]{1,16}$/.test(pax.size)) throw new Error('bad PAX size')
      fileSize = Number(pax.size)
    }
    pax = {}
    if (type !== '0' && type !== '\0' && type !== '5') throw new Error(`unsupported archive entry type ${JSON.stringify(type)} for ${rawName}`)
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new Error(`bad entry size for ${rawName}`)
    if (type === '5' && fileSize !== 0) throw new Error(`folder entry with a body: ${rawName}`)
    const entry: TarEntryOut = { name: checkArchiveName(rawName), type: type === '5' ? 'dir' : 'file', size: type === '5' ? 0 : fileSize, mode: parseOctal(h, 100, 8), mtimeMs }
    const bodyPad = (BLOCK - (entry.size % BLOCK)) % BLOCK
    let consumed = 0
    const body = (async function* () { for await (const c of r.take(entry.size)) { consumed += c.byteLength; yield c } })()
    await onEntry(entry, body)
    if (consumed < entry.size) for await (const _ of r.take(entry.size - consumed)) { /* skip */ }
    if (entry.type === 'file') await r.read(bodyPad)
    count++
  }
}

/**
 * Extract a tar stream into `dest` (which must exist): regular files 0600/0644 as recorded, folders 0700/0755.
 * `replace`: a file entry may replace a folder of the same name that is already in `dest` (layering incremental
 * backups: a folder that became a file).
 */
export async function extractTar(src: AsyncIterable<Uint8Array>, dest: string, o: { filter?: (name: string) => boolean; replace?: boolean } = {}): Promise<number> {
  const root = path.resolve(dest)
  return readTar(src, async (e, body) => {
    if (o.filter && !o.filter(e.name)) return
    const target = path.join(root, e.name)
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe archive path: ${e.name}`)
    if (o.replace) {
      // a path component that is a file where the archive needs a folder, or a folder where it needs a file
      const segs = e.name.split('/')
      for (let i = 1; i <= segs.length; i++) {
        const p = path.join(root, ...segs.slice(0, i))
        const st = await fsp.lstat(p).catch(() => null)
        if (!st) break
        const wantDir = i < segs.length || e.type === 'dir'
        if (wantDir && !st.isDirectory()) { await fsp.rm(p, { force: true }); break }
        if (!wantDir && st.isDirectory()) await fsp.rm(p, { recursive: true, force: true })
      }
    }
    if (e.type === 'dir') {
      await fsp.mkdir(target, { recursive: true, mode: 0o700 })
      await fsp.chmod(target, (e.mode & 0o755) || 0o700) // never group/world-writable
      return
    }
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    const fh = await fsp.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, (e.mode & 0o755) || 0o600)
    try {
      for await (const c of body) await fh.write(c)
    } finally {
      await fh.close()
    }
    const t = new Date(e.mtimeMs)
    await fsp.utimes(target, t, t)
  })
}
