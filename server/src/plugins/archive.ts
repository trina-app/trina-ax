// The .trinaplugin container: a POSIX ustar archive, optionally gzip-compressed, read fully in memory under hard
// limits before anything touches the disk. Only regular files are accepted (directories are implied by paths and
// skipped): links, devices, FIFOs, PAX/GNU extension headers, absolute or parent paths, hidden segments, duplicate or
// case-folded duplicate names, setuid/setgid/sticky bits and oversized or decompression-bomb archives are refused.
// The writer (build scripts and tests) is deterministic: sorted paths, zero times and owners, fixed modes.
import zlib from 'node:zlib'
import { SMALL_UPLOAD_MAX } from '@mycel/shared/api'
import { ZIP_ENTRIES_MAX, ZIP_RATIO_FROM, ZIP_RATIO_MAX, ZIP_TOTAL_MAX } from '../files/zip-guard'

/** The same bounds as every other container the server opens (files/zip-guard.ts), plus the upload size. */
export const ARCHIVE_LIMITS = {
  /** the uploaded / stored archive (gzip or plain) */
  archiveBytes: SMALL_UPLOAD_MAX,
  /** all file contents together after decompression */
  expandedBytes: ZIP_TOTAL_MAX,
  entries: Math.min(2000, ZIP_ENTRIES_MAX),
  /** gzip: above ratioFrom, the archive may expand at most ratioMax times */
  ratioFrom: ZIP_RATIO_FROM,
  ratioMax: ZIP_RATIO_MAX,
}

export class ArchiveError extends Error { name = 'ArchiveError' }

const BLOCK = 512
const PATH_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\/){0,7}[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/

export const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b

function octal(b: Buffer, off: number, len: number): number {
  const s = b.toString('latin1', off, off + len).replace(/\0.*$/s, '').trim()
  if (s === '') return 0
  if (!/^[0-7]+$/.test(s)) throw new ArchiveError('bad number field')
  const n = parseInt(s, 8)
  if (!Number.isSafeInteger(n)) throw new ArchiveError('number field out of range')
  return n
}

/** Safe relative path: plain segments, no dot or hidden segments, no trailing dots. */
export function safeArchivePath(p: string): boolean {
  return PATH_RE.test(p) && !p.split('/').some((s) => s.endsWith('.'))
}

/** Read every regular file of a (gzip-)tar archive. */
export function readArchive(bytes: Uint8Array, limits = ARCHIVE_LIMITS): Map<string, Buffer> {
  if (bytes.length > limits.archiveBytes) throw new ArchiveError('archive too large')
  let tar: Buffer
  if (isGzip(bytes)) {
    try { tar = zlib.gunzipSync(bytes, { maxOutputLength: limits.expandedBytes + 4 * 1024 * 1024 }) } catch { throw new ArchiveError('archive expands too far or is damaged') }
    if (tar.length > limits.ratioFrom && tar.length > bytes.length * limits.ratioMax) throw new ArchiveError(`archive expands more than ${limits.ratioMax} times`)
  } else tar = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const files = new Map<string, Buffer>()
  const folded = new Set<string>()
  let off = 0, total = 0, entries = 0
  for (;;) {
    if (off + BLOCK > tar.length) throw new ArchiveError('archive ends early')
    const h = tar.subarray(off, off + BLOCK)
    if (h.every((x) => x === 0)) break
    if (++entries > limits.entries) throw new ArchiveError('too many entries')
    // checksum: sum of the header with the checksum field read as spaces
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!
    if (octal(h, 148, 8) !== sum) throw new ArchiveError('header checksum mismatch')
    if (h.toString('latin1', 257, 262) !== 'ustar') throw new ArchiveError('not a ustar archive')
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '')
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/s, '')
    const full = prefix ? `${prefix}/${name}` : name
    const type = String.fromCharCode(h[156]!)
    const mode = octal(h, 100, 8)
    const size = octal(h, 124, 12)
    if (mode & 0o7000) throw new ArchiveError('setuid, setgid or sticky bit')
    const dataStart = off + BLOCK
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK
    if (next > tar.length) throw new ArchiveError('entry runs past the end')
    off = next
    if (type === '5') {
      if (size !== 0) throw new ArchiveError('directory with data')
      const dir = full.replace(/\/$/, '')
      if (!safeArchivePath(dir)) throw new ArchiveError('unsafe path')
      continue
    }
    if (type !== '0' && type !== '\0') throw new ArchiveError('only regular files are allowed (no links, devices or extension headers)')
    if (!safeArchivePath(full)) throw new ArchiveError('unsafe path')
    const key = full.normalize('NFC').toLowerCase()
    if (files.has(full) || folded.has(key)) throw new ArchiveError('a path appears twice')
    total += size
    if (total > limits.expandedBytes) throw new ArchiveError('archive expands too far')
    folded.add(key)
    files.set(full, Buffer.from(tar.subarray(dataStart, dataStart + size)))
  }
  // a path that is both a file and a folder
  for (const p of files.keys()) for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) if (files.has(p.slice(0, i))) throw new ArchiveError('a path is both a file and a folder')
  return files
}

function header(path: string, size: number, executable: boolean): Buffer {
  const h = Buffer.alloc(BLOCK)
  let name = path, prefix = ''
  if (Buffer.byteLength(name) > 100) {
    const cut = path.lastIndexOf('/', path.length - 1)
    prefix = path.slice(0, cut); name = path.slice(cut + 1)
    if (cut < 0 || Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new ArchiveError('path too long for ustar')
  }
  h.write(name, 0, 'utf8')
  h.write((executable ? '0000755' : '0000644') + '\0', 100, 'latin1')
  h.write('0000000\0', 108, 'latin1')
  h.write('0000000\0', 116, 'latin1')
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1')
  h.write('00000000000\0', 136, 'latin1')
  h.write('        ', 148, 'latin1')
  h.write('0', 156, 'latin1')
  h.write('ustar\0' + '00', 257, 'latin1')
  h.write(prefix, 345, 'utf8')
  let sum = 0
  for (const x of h) sum += x
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
  return h
}

/** A deterministic archive of the given files (sorted by path). */
export function writeArchive(files: Map<string, Uint8Array> | Record<string, Uint8Array>, o: { gzip?: boolean; executables?: Set<string> } = {}): Buffer {
  const entries = (files instanceof Map ? [...files.entries()] : Object.entries(files)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const parts: Buffer[] = []
  for (const [p, data] of entries) {
    if (!safeArchivePath(p)) throw new ArchiveError(`unsafe path ${p}`)
    parts.push(header(p, data.length, o.executables?.has(p) ?? false), Buffer.from(data))
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  const tar = Buffer.concat(parts)
  if (!o.gzip) return tar
  const gz = zlib.gzipSync(tar, { level: 9 })
  // zlib writes the build machine's OS into the gzip header (19 on macOS, 3 on Linux), so the same files would give
  // different package bytes on a Mac and on the Linux CI. The official list pins the archive's SHA-256: fix it to 3
  // (Unix). The header carries no CRC of its own (FLG 0), and the deflate stream is the same on both.
  if (gz[3] !== 0) throw new ArchiveError('unexpected gzip header flags')
  gz[9] = 3
  return gz
}
