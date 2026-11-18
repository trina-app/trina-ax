// What is inside a zip, as the AI's unzip_file (tools/unzip.ts) will save it: every entry's name decoded, its path
// checked and cut into folder names, junk left out, and the limits applied, before anything is written. Nothing here
// touches the disk; the tool inflates one entry at a time (inflateEntry) and places each file through the normal
// checks.
// - Names: UTF-8 when the zip says so (flag bit 11) or carries an Info-ZIP Unicode path whose CRC matches the name;
//   otherwise UTF-8 when the bytes are valid UTF-8, else CP949 (zips made on Korean Windows without the UTF-8 flag;
//   WHATWG "euc-kr" is Windows' code page 949). Then NFC (macOS zips write decomposed Hangul) and "\" read as "/".
// - Refused for the whole zip (nothing is saved): an absolute path ("/x", "C:\x") or a ".." segment, the sign of a zip
//   made to write outside its folder; zip64, encryption, a damaged directory, too many entries or bytes (zip-guard.ts).
// - Skipped and named: links and device files (only plain files and folders come out of a zip here), names the team
//   folder does not take (policy/names.ts badSegment), a path that appears twice or is both a file and a folder.
// - Left out silently: macOS and Windows junk (__MACOSX/, ._*, .DS_Store, Thumbs.db, desktop.ini).
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { badSegment, foldKey } from '../policy/names'
import { crc32 as crc32Js } from './zip-write'
import { entryData, readCentral, ZIP_RATIO_FROM, ZIP_RATIO_MAX, ZIP_TOTAL_MAX, ZipProblem, type ZipEntry } from './zip-guard'

/** the zip file itself (it is read into memory) and all of its files together, uncompressed */
export const UNZIP_ZIP_MAX = ZIP_TOTAL_MAX
export const UNZIP_TOTAL_MAX = ZIP_TOTAL_MAX
/** entries of the central directory (folders and junk count too) */
export const UNZIP_ENTRIES_MAX = 5000
/** folder levels inside the zip */
export const UNZIP_DEPTH_MAX = 30

export interface PlannedFile { segs: string[]; entry: ZipEntry; size: number }
export interface ZipPlan {
  files: PlannedFile[]
  /** folders the zip names (also empty ones), each as its segments; parents of files are implied */
  folders: string[][]
  /** entries not saved, with a plain reason */
  skipped: { name: string; why: string }[]
  /** junk entries left out (__MACOSX and the like) */
  junk: number
  /** all the zip's entries sat in one folder of this name; it was taken off the paths (the tool names its folder after
   * it) */
  top: string | null
  total: number
}

/** A zip made to write outside its folder (an absolute path or ".."): the whole zip is refused. */
export class UnsafeZip extends Error {
  constructor(readonly entry: string) { super(`unsafe path in the zip: ${entry}`); this.name = 'UnsafeZip' }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const UTF8_LOOSE = new TextDecoder('utf-8')
const CP949 = new TextDecoder('euc-kr')

const crc32 = (b: Uint8Array): number => {
  const z = zlib as unknown as { crc32?: (d: Uint8Array) => number }
  return z.crc32 ? z.crc32(b) >>> 0 : crc32Js(b)
}

/** The Info-ZIP Unicode path extra field (0x7075): its UTF-8 name when its CRC is that of the raw name. */
function unicodePath(e: ZipEntry): string | null {
  const x = e.extra
  const v = new DataView(x.buffer, x.byteOffset, x.byteLength)
  for (let p = 0; p + 4 <= x.length;) {
    const id = v.getUint16(p, true)
    const len = v.getUint16(p + 2, true)
    if (p + 4 + len > x.length) return null
    if (id === 0x7075 && len >= 5 && x[p + 4] === 1 && v.getUint32(p + 5, true) === crc32(e.nameBytes)) {
      try { return UTF8.decode(x.subarray(p + 9, p + 4 + len)) } catch { return null }
    }
    p += 4 + len
  }
  return null
}

/** An entry's name as people wrote it (see the head of this file). */
export function decodeName(e: Pick<ZipEntry, 'nameBytes' | 'flags' | 'extra'>): string {
  const b = e.nameBytes
  let s: string
  if (e.flags & 0x800) s = UTF8_LOOSE.decode(b)
  else {
    const u = unicodePath(e as ZipEntry)
    if (u !== null) s = u
    else { try { s = UTF8.decode(b) } catch { s = CP949.decode(b) } }
  }
  return s.normalize('NFC')
}

const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
const isJunk = (segs: string[]) => segs[0] === '__MACOSX' || segs.some((s) => JUNK_NAMES.has(s.toLowerCase())) || segs.at(-1)!.startsWith('._')

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

/**
 * The plan of a zip: what it holds, where each file goes under the target folder, and what is left out. Throws a
 * ZipProblem (zip-guard.ts) or UnsafeZip; nothing has been written then.
 */
export function planZip(bytes: Uint8Array, o: { unwrap?: boolean } = {}): ZipPlan {
  const entries = readCentral(bytes, { total: UNZIP_TOTAL_MAX, entries: UNZIP_ENTRIES_MAX })
  const items: { segs: string[]; dir: boolean; entry: ZipEntry; name: string }[] = []
  const skipped: ZipPlan['skipped'] = []
  let junk = 0
  for (const e of entries) {
    const name = decodeName(e)
    const raw = name.replace(/\\/g, '/')
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new UnsafeZip(name)
    const parts = raw.split('/')
    if (parts.includes('..')) throw new UnsafeZip(name)
    const segs = parts.filter((s) => s !== '' && s !== '.')
    if (!segs.length) continue
    if (isJunk(segs)) { junk++; continue }
    // a Unix mode in the upper half of the external attributes (made by Unix, 3): links and devices stay out
    const mode = e.madeBy === 3 ? (e.external >>> 16) & S_IFMT : 0
    if (mode === S_IFLNK) { skipped.push({ name, why: 'a link (shortcut) to another file, which is not saved' }); continue }
    if (mode && mode !== S_IFREG && mode !== S_IFDIR) { skipped.push({ name, why: 'not a regular file' }); continue }
    const dir = raw.endsWith('/') || mode === S_IFDIR || (e.external & 0x10) !== 0
    if (segs.length > UNZIP_DEPTH_MAX) { skipped.push({ name, why: `more than ${UNZIP_DEPTH_MAX} folders deep` }); continue }
    const bad = segs.map((s) => badSegment(s)).find(Boolean)
    if (bad) { skipped.push({ name, why: `the name is not allowed in the team folder (${bad})` }); continue }
    items.push({ segs, dir, entry: e, name })
  }
  // one folder around everything ("report/…"): taken off, the tool's folder is named after it
  const firsts = new Set(items.map((i) => i.segs[0]!))
  let top: string | null = null
  if (o.unwrap !== false && firsts.size === 1 && items.some((i) => i.segs.length > 1) && items.every((i) => i.segs.length > 1 || i.dir)) {
    top = [...firsts][0]!
    for (const i of items) i.segs = i.segs.slice(1)
  }
  // duplicates (also by case and width, as the team folder compares names), a path that is a file and a folder
  const files: PlannedFile[] = []
  const folders: string[][] = []
  const fileKeys = new Set<string>()
  const dirKeys = new Set<string>()
  const keyOf = (segs: string[]) => segs.map(foldKey).join('/')
  let total = 0
  for (const i of items) {
    if (!i.segs.length) continue
    const k = keyOf(i.segs)
    const parents = i.segs.slice(0, -1).map((_, n) => keyOf(i.segs.slice(0, n + 1)))
    if (parents.some((p) => fileKeys.has(p))) { skipped.push({ name: i.name, why: 'it is inside a name that is also a file in the zip' }); continue }
    if (i.dir) {
      if (fileKeys.has(k)) { skipped.push({ name: i.name, why: 'a file of the same name is in the zip' }); continue }
      if (!dirKeys.has(k)) { dirKeys.add(k); folders.push(i.segs) }
      for (const p of parents) dirKeys.add(p)
      continue
    }
    if (fileKeys.has(k) || dirKeys.has(k)) { skipped.push({ name: i.name, why: 'the zip has this name twice' }); continue }
    fileKeys.add(k)
    for (const p of parents) dirKeys.add(p)
    total += i.entry.usize
    files.push({ segs: i.segs, entry: i.entry, size: i.entry.usize })
  }
  return { files, folders, skipped, junk, top, total }
}

const inflateRaw = promisify(zlib.inflateRaw) as (b: Uint8Array, o: zlib.ZlibOptions) => Promise<Buffer>

/** One entry's bytes, inflated on the zlib thread pool with a hard output cap; its real size and CRC must match the
 * directory. Throws a ZipProblem. */
export async function inflateEntry(bytes: Uint8Array, e: ZipEntry): Promise<Buffer> {
  const data = entryData(bytes, e)
  let out: Buffer
  if (e.method === 0) {
    if (e.csize !== e.usize) throw new ZipProblem('damaged', 'stored entry with two sizes')
    out = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  } else {
    if (e.usize > ZIP_RATIO_FROM && e.usize > e.csize * ZIP_RATIO_MAX) throw new ZipProblem('complex', `a part expands more than ${ZIP_RATIO_MAX} times`)
    try { out = await inflateRaw(data, { maxOutputLength: Math.max(e.usize, 1) }) } catch (err) {
      if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipProblem('complex', 'a part is larger than its header says')
      throw new ZipProblem('damaged', 'bad compressed data')
    }
  }
  if (out.length !== e.usize) throw new ZipProblem('damaged', 'a part is not the size its header says')
  if (crc32(out) !== e.crc) throw new ZipProblem('damaged', 'a part does not match its checksum')
  return out
}
