// The one check for files the AI puts into a team or chat folder (docs/decisions/20261124-doc-skills.md "Exit check"):
// every place an AI write lands (placeProduced, chat files and their versions, moves and renames that change an
// extension, and a run's direct writes in devenv/track.ts) calls assertSafeTeamFile. It decides by CONTENT, not by name:
//   - Office Open XML (any extension): scanned in the office worker (office-links-check.ts scanOffice), every risky item
//     by its exact identity; an item the replaced file already held, in the bytes this answer read, may stay.
//   - Formats this server cannot read inside (legacy OLE2 Office, RTF, MHT, ODF, a binary .xlsb workbook): only the
//     replaced file's own bytes, unchanged, may pass.
//   - Windows shortcut and search files (.url, .library-ms, .searchConnector-ms, .scf, or their content): refused.
// A plain file (text, an image, a PDF, a zip that is not Office) passes: their own tools check them.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { OFFICE_WRITE_MAX, officeWorkerWrite } from './extract'
import { OFFICE_EXIT_MODE } from './office-links-check'
import { ToolError } from '../policy/errors'

/** earlier bytes given to the check, at most */
export const OFFICE_EXIT_EARLIER_MAX = 64 * 1024 * 1024
const SHORTCUT_EXT = /\.(url|library-ms|searchconnector-ms|scf|website|lnk|appref-ms)$/i

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x)
/** bytes read from the start of a file for its signature */
export const HEAD_BYTES = 8192
/** a zip directory larger than this is not listed: such a file is refused as unreadable */
const ZIP_DIR_MAX = 256 * 1024 * 1024
/** kept for callers that read a file's end themselves */
export const TAIL_BYTES = 65_557

/** Read `len` bytes at `pos` of a file or a buffer. */
export type ReadAt = (pos: number, len: number) => Uint8Array
export const bytesReader = (b: Uint8Array): ReadAt => (pos, len) => b.subarray(Math.max(0, pos), Math.max(0, pos) + Math.max(0, len))
export function fdReader(fd: number): ReadAt {
  return (pos, len) => { const out = Buffer.alloc(Math.max(0, len)); const n = fs.readSync(fd, out, 0, out.length, Math.max(0, pos)); return out.subarray(0, n) }
}

/**
 * Every entry name of a zip, read from its directory as unzip does: the end record found from the end of the file,
 * zip64 records, any bytes put before the zip. null: not a zip. 'unreadable': a zip whose directory cannot be listed in
 * full (the caller refuses it: fail closed).
 */
export function zipNames(size: number, readAt: ReadAt): string[] | 'unreadable' | null {
  const tailLen = Math.min(size, 65_557)
  const tail = readAt(size - tailLen, tailLen)
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let at = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { at = i; break }
  if (at < 0) return startsWith(readAt(0, 4), [0x50, 0x4b, 0x03, 0x04]) ? 'unreadable' : null
  const eocd = size - tailLen + at
  let entries = tv.getUint16(at + 10, true), cdSize = tv.getUint32(at + 12, true), cdOff = tv.getUint32(at + 16, true), end = eocd
  if (entries === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    // zip64: the locator right before the end record names the zip64 end record
    if (eocd < 20) return 'unreadable'
    const loc = readAt(eocd - 20, 20), lv = new DataView(loc.buffer, loc.byteOffset, loc.byteLength)
    if (loc.length < 20 || lv.getUint32(0, true) !== 0x07064b50) return 'unreadable'
    const recAt = Number(lv.getBigUint64(8, true))
    // with bytes before the zip the record is further on by the same amount: found next to the locator
    const z64 = eocd - 20 - 56
    if (z64 < 0) return 'unreadable'
    const rec = readAt(z64, 56), rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength)
    if (rec.length < 56 || rv.getUint32(0, true) !== 0x06064b50 || recAt > z64) return 'unreadable'
    entries = Number(rv.getBigUint64(32, true)); cdSize = Number(rv.getBigUint64(40, true)); cdOff = Number(rv.getBigUint64(48, true)); end = z64
  }
  const prefix = end - cdSize - cdOff
  if (prefix < 0 || cdSize > ZIP_DIR_MAX || !Number.isSafeInteger(entries)) return 'unreadable'
  const cd = readAt(cdOff + prefix, cdSize)
  if (cd.length !== cdSize) return 'unreadable'
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
  const names: string[] = []
  let p = 0
  for (let n = 0; n < entries; n++) {
    if (p + 46 > cd.length || cv.getUint32(p, true) !== 0x02014b50) return 'unreadable'
    const nlen = cv.getUint16(p + 28, true), xlen = cv.getUint16(p + 30, true), clen = cv.getUint16(p + 32, true)
    if (p + 46 + nlen > cd.length) return 'unreadable'
    names.push(Buffer.from(cd.subarray(p + 46, p + 46 + nlen)).toString('utf8'))
    p += 46 + nlen + xlen + clen
  }
  return names
}

/** the streams and storages that make a compound file an Office document or give it macros */
const OLE_OFFICE_STREAMS = new Set(['worddocument', 'workbook', 'book', 'powerpoint document', '_vba_project_cur', 'vba', 'macros', '_vba_project', 'objectpool'])

/** Every stream and storage name of an OLE2 compound file (MS-CFB), read through its FAT; 'unreadable' when its header,
 * FAT or directory chain cannot be followed. */
export function oleStreamNames(size: number, readAt: ReadAt): string[] | 'unreadable' {
  try {
    const h = readAt(0, 512)
    if (h.length < 512) return 'unreadable'
    const hv = new DataView(h.buffer, h.byteOffset, 512)
    const shift = hv.getUint16(0x1e, true)
    if (shift !== 9 && shift !== 12) return 'unreadable'
    const sec = 1 << shift
    const at = (n: number) => (n + 1) * sec
    const fatSectors: number[] = []
    for (let i = 0; i < 109; i++) { const n = hv.getUint32(0x4c + i * 4, true); if (n < 0xfffffffa) fatSectors.push(n) }
    // more FAT sectors through the DIFAT chain
    let difat = hv.getUint32(0x44, true), guard = 0
    while (difat < 0xfffffffa) {
      if (++guard > 100_000 || at(difat) + sec > size) return 'unreadable'
      const d = readAt(at(difat), sec), dv = new DataView(d.buffer, d.byteOffset, d.length)
      for (let i = 0; i < sec / 4 - 1; i++) { const n = dv.getUint32(i * 4, true); if (n < 0xfffffffa) fatSectors.push(n) }
      difat = dv.getUint32(sec - 4, true)
    }
    if (fatSectors.length > 1_000_000) return 'unreadable'
    const fatCache = new Map<number, DataView>()
    const next = (n: number) => {
      const per = sec / 4, fs_ = fatSectors[Math.floor(n / per)]
      if (fs_ === undefined || at(fs_) + sec > size) throw new Error('fat')
      let v = fatCache.get(fs_)
      if (!v) { const b = readAt(at(fs_), sec); v = new DataView(b.buffer, b.byteOffset, b.length); fatCache.set(fs_, v) }
      return v.getUint32((n % per) * 4, true)
    }
    const names: string[] = []
    let dir = hv.getUint32(0x30, true), steps = 0
    while (dir < 0xfffffffa) {
      if (++steps > 200_000 || at(dir) + sec > size) return 'unreadable'
      const b = readAt(at(dir), sec)
      for (let o = 0; o + 128 <= b.length; o += 128) {
        const e = new DataView(b.buffer, b.byteOffset + o, 128)
        const type = e.getUint8(0x42), len = e.getUint16(0x40, true)
        if (type === 0 || len < 2 || len > 64) continue
        names.push(Buffer.from(b.subarray(o, o + len - 2)).toString('utf16le'))
      }
      dir = next(dir)
    }
    return names
  } catch { return 'unreadable' }
}

export type ContentKind = { office: 'docx' | 'pptx' | 'xlsx'; names: string[] } | { opaque: string } | { shortcut: string } | null

/** What a file is by its bytes (the name only for shortcuts, which are plain text). Fail closed: a zip whose directory
 * cannot be listed is opaque (refused unless it is the replaced file's own bytes). */
export function contentKind(name: string, size: number, readAt: ReadAt): ContentKind {
  if (SHORTCUT_EXT.test(name)) return { shortcut: name.slice(name.lastIndexOf('.')) }
  const head = readAt(0, HEAD_BYTES)
  const text = Buffer.from(head).toString('latin1').replace(/^\uFEFF/, '').trimStart()
  if (/^\[(InternetShortcut|\.ShellClassInfo|Shell)\]/i.test(text) || /<(libraryDescription|searchConnectorDescription)\b/.test(text)) return { shortcut: 'a Windows shortcut' }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // OLE2 holds many formats (an Outlook .msg, an installer, thumbs.db): only an Office document or a macro storage is
    // Office here, by its streams; a directory that cannot be read is refused (fail closed)
    const streams = oleStreamNames(size, readAt)
    if (streams === 'unreadable') return { opaque: 'a compound file whose contents could not be listed' }
    if (streams.some((n) => OLE_OFFICE_STREAMS.has(n.toLowerCase()))) return { opaque: 'a legacy Office file (.doc, .xls, .ppt)' }
    return null
  }
  if (/^\{\\rtf/i.test(text)) return { opaque: 'an RTF document' }
  if (/^MIME-Version:/im.test(text.slice(0, 2048)) && /multipart\/related/i.test(text)) return { opaque: 'a web archive (MHT)' }
  const names = zipNames(size, readAt)
  if (names === null) return null
  if (names === 'unreadable') return { opaque: 'a zip file whose contents could not be listed' }
  const lower = names.map((n) => n.toLowerCase())
  // OpenDocument by its own mimetype (stored first, uncompressed); a Hangul .hwpx has a mimetype and a manifest too
  if (lower.includes('mimetype') && Buffer.from(head).toString('latin1').includes('application/vnd.oasis.opendocument')) return { opaque: 'an OpenDocument file' }
  if (!lower.includes('[content_types].xml')) return null
  if (lower.some((n) => /(^|\/)workbook\.bin$/.test(n))) return { opaque: 'a binary Excel workbook (.xlsb)' }
  // the kind only words the refusal: every scan runs on every Office package (office-links-check.ts)
  const office = lower.some((n) => n.startsWith('word/')) ? 'docx' : lower.some((n) => n.startsWith('xl/')) ? 'xlsx' : 'pptx'
  return { office, names }
}

/**
 * The file `name` with `bytes` may go where the AI puts it: the bytes to save (an attached template taken out), or a
 * ToolError naming what is not allowed. `replaced`: the bytes of the file it replaces, as this answer read them (null:
 * a new file, or one not read). Only that file vouches for items it already held.
 */
export async function assertSafeTeamFile(name: string, bytes: Uint8Array, replaced: Uint8Array | null, signal?: AbortSignal, read: Uint8Array[] = []): Promise<Uint8Array> {
  const k = contentKind(name, bytes.length, bytesReader(bytes))
  if (!k) return bytes
  if ('shortcut' in k) throw new ToolError(`'${name}' is ${k.shortcut.startsWith('.') ? `a ${k.shortcut} file` : k.shortcut}, which can open places outside the team folder; it is not saved`, 'office_unsafe')
  if ('opaque' in k) {
    if ([replaced, ...read].some((v) => v && Buffer.compare(Buffer.from(v), Buffer.from(bytes)) === 0)) return bytes
    throw new ToolError(`'${name}' is ${k.opaque}, which cannot be checked for links that leave the file; save it as .docx, .pptx or .xlsx instead`, 'office_unsafe')
  }
  if (bytes.length > OFFICE_WRITE_MAX) throw new ToolError(`'${name}' is too large to be checked for links that leave the file`, 'office_unsafe')
  // what vouches: the replaced file and the files this answer read, each as read (exact items only, office-links-check.ts)
  let room = OFFICE_EXIT_EARLIER_MAX
  const earlier = [replaced, ...read].filter((v): v is Uint8Array => !!v && v.length <= room && (room -= v.length) >= 0)
  const head = new TextEncoder().encode(JSON.stringify({ kind: k.office, sizes: [bytes.length, ...earlier.map((e) => e.length)] }))
  const req = new Uint8Array(4 + head.length + bytes.length + earlier.reduce((n, e) => n + e.length, 0))
  new DataView(req.buffer).setUint32(0, head.length)
  req.set(head, 4)
  let at = 4 + head.length
  for (const part of [bytes, ...earlier]) { req.set(part, at); at += part.length }
  return new Uint8Array(await officeWorkerWrite(OFFICE_EXIT_MODE, req, signal))
}

/** The kind of an Office file by its name (callers that have no bytes yet, e.g. to pick earlier versions). */
export function officeKind(name: string): 'docx' | 'pptx' | 'xlsx' | null {
  const m = /\.(do[ct][xm]|pp[st][xm]|pot[xm]|xl[st][xm])$/i.exec(name)
  if (!m) return null
  const e = m[1]!.toLowerCase()
  return e.startsWith('d') ? 'docx' : e.startsWith('x') ? 'xlsx' : 'pptx'
}

/** A file on disk as the AI is about to place it (`abs`): checked like assertSafeTeamFile, reading only its head and
 * tail unless it is an Office file; a cleaned Office file (its attached template taken out) is written back to `abs`.
 * Returns whether the bytes changed. */
export async function assertSafeTeamPath(name: string, abs: string, replaced: Uint8Array | null | (() => Uint8Array | null), signal?: AbortSignal, o: { writeBack?: boolean; read?: Uint8Array[] | (() => Uint8Array[]) } = {}): Promise<boolean> {
  const fd = fs.openSync(abs, 'r')
  let size: number, k: ContentKind
  try { size = fs.fstatSync(fd).size; k = contentKind(name, size, fdReader(fd)) } finally { fs.closeSync(fd) }
  if (!k) return false
  // a shortcut, or a large file of a format that cannot be read inside: refused without reading it all
  if ('shortcut' in k) throw new ToolError(`'${name}' is ${k.shortcut.startsWith('.') ? `a ${k.shortcut} file` : k.shortcut}, which can open places outside the team folder; it is not saved`, 'office_unsafe')
  if ('opaque' in k && size > OFFICE_EXIT_EARLIER_MAX) throw new ToolError(`'${name}' is ${k.opaque}, which cannot be checked for links that leave the file`, 'office_unsafe')
  if (size > OFFICE_WRITE_MAX) throw new ToolError(`'${name}' is too large to be checked for links that leave the file`, 'office_unsafe')
  const bytes = new Uint8Array(fs.readFileSync(abs))
  // what vouches is read only now, for an Office-like file (a plain file never costs a read of anything else)
  const out = await assertSafeTeamFile(name, bytes, typeof replaced === 'function' ? replaced() : replaced, signal, typeof o.read === 'function' ? o.read() : o.read ?? [])
  if (Buffer.compare(Buffer.from(out), Buffer.from(bytes)) === 0 || o.writeBack === false) return false
  fs.writeFileSync(abs, out)
  return true
}

/** A rename by the AI that changes how a file opens: a shortcut name, or Office / unreadable content under a name of
 * another family (a .txt or .bin renamed .docx), is refused (the content was never checked under that name). Null: fine. */
export function renameProblem(oldName: string, newName: string, abs: string): string | null {
  if (SHORTCUT_EXT.test(newName)) return `a ${newName.slice(newName.lastIndexOf('.'))} file can open places outside the team folder`
  const ext = (n: string) => (n.includes('.') ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : '')
  if (ext(oldName) === ext(newName)) return null
  let k: ContentKind
  try { const fd = fs.openSync(abs, 'r'); try { k = contentKind(newName, fs.fstatSync(fd).size, fdReader(fd)) } finally { fs.closeSync(fd) } } catch { return null }
  if (!k) return null
  if ('office' in k && officeKind(oldName) === k.office) return null
  return 'its content is an Office or similar document that was not checked under this name; save it again with make_file or from the work folder instead'
}

/** The bytes of the team file at `abs` when they are exactly what this answer read (`readHash`); else null. Only the
 * file being replaced vouches, and only in the version the AI saw. */
export function replacedAsRead(abs: string, readHash: string | undefined): Uint8Array | null {
  if (!readHash) return null
  try {
    const st = fs.lstatSync(abs)
    if (!st.isFile() || st.size > OFFICE_EXIT_EARLIER_MAX) return null
    const b = fs.readFileSync(abs)
    return crypto.createHash('sha256').update(b).digest('hex') === readHash ? new Uint8Array(b) : null
  } catch { return null }
}

/** The team files this answer read (`readHashes`: team path -> the hash it read), in exactly the bytes it read: a file
 * changed on disk since is left out (it no longer has the bytes that were read). Only Office and similar documents, at
 * most READ_VOUCH_FILES of them and OFFICE_EXIT_EARLIER_MAX bytes in all. An exact copy of an item they hold adds no
 * exposure (those bytes are in the team's files already); anything new or changed is still refused. */
export const READ_VOUCH_FILES = 20
export function readVouchers(root: string, readHashes: Iterable<[string, string]>): Uint8Array[] {
  const out: Uint8Array[] = []
  let room = OFFICE_EXIT_EARLIER_MAX
  for (const [rel, hash] of readHashes) {
    if (out.length >= READ_VOUCH_FILES) break
    if (!rel || rel.includes(':') || rel.split('/').some((x) => x === '..' || x === '')) continue
    try {
      const abs = path.join(root, ...rel.split('/'))
      const st = fs.lstatSync(abs)
      if (!st.isFile() || st.size > room) continue
      const b = fs.readFileSync(abs)
      if (!contentKind(rel, b.length, bytesReader(b))) continue
      if (crypto.createHash('sha256').update(b).digest('hex') !== hash) continue
      out.push(new Uint8Array(b)); room -= b.length
    } catch { /* gone or unreadable: vouches for nothing */ }
  }
  return out
}
