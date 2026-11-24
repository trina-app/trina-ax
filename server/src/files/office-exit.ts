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
/** bytes read from the start of a file, and from its end (a zip's central directory names every part) */
export const HEAD_BYTES = 8192, TAIL_BYTES = 4 * 1024 * 1024

export type ContentKind = { office: 'docx' | 'pptx' | 'xlsx' } | { opaque: string } | { shortcut: string } | null

/** What a file is by its bytes: `head` its first bytes, `tail` its last (the whole file when small). The name only for
 * shortcuts, which are plain text. */
export function contentKind(name: string, head: Uint8Array, tail: Uint8Array = head): ContentKind {
  if (SHORTCUT_EXT.test(name)) return { shortcut: name.slice(name.lastIndexOf('.')) }
  const text = Buffer.from(head).toString('latin1').replace(/^\uFEFF/, '').trimStart()
  if (/^\[(InternetShortcut|\.ShellClassInfo|Shell)\]/i.test(text) || /<(libraryDescription|searchConnectorDescription)\b/.test(text)) return { shortcut: 'a Windows shortcut' }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { opaque: 'a legacy Office file (.doc, .xls, .ppt)' }
  if (/^\{\\rtf/i.test(text)) return { opaque: 'an RTF document' }
  if (/^MIME-Version:/im.test(text.slice(0, 2048)) && /multipart\/related/i.test(text)) return { opaque: 'a web archive (MHT)' }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    const names = Buffer.from(tail).toString('latin1')
    if (Buffer.from(head.subarray(0, 200)).toString('latin1').includes('mimetypeapplication/vnd.oasis.opendocument')) return { opaque: 'an OpenDocument file' }
    if (!names.includes('[Content_Types].xml')) return null
    if (names.includes('xl/workbook.bin')) return { opaque: 'a binary Excel workbook (.xlsb)' }
    if (names.includes('word/')) return { office: 'docx' }
    if (names.includes('xl/')) return { office: 'xlsx' }
    return { office: 'pptx' }
  }
  return null
}

/**
 * The file `name` with `bytes` may go where the AI puts it: the bytes to save (an attached template taken out), or a
 * ToolError naming what is not allowed. `replaced`: the bytes of the file it replaces, as this answer read them (null:
 * a new file, or one not read). Only that file vouches for items it already held.
 */
export async function assertSafeTeamFile(name: string, bytes: Uint8Array, replaced: Uint8Array | null, signal?: AbortSignal, read: Uint8Array[] = []): Promise<Uint8Array> {
  const k = contentKind(name, bytes.subarray(0, HEAD_BYTES), bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)))
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
export async function assertSafeTeamPath(name: string, abs: string, replaced: Uint8Array | null, signal?: AbortSignal, o: { writeBack?: boolean; read?: Uint8Array[] } = {}): Promise<boolean> {
  const fd = fs.openSync(abs, 'r')
  let head: Uint8Array, tail: Uint8Array, size: number
  try {
    size = fs.fstatSync(fd).size
    head = Buffer.alloc(Math.min(HEAD_BYTES, size)); fs.readSync(fd, head, 0, head.length, 0)
    const n = Math.min(TAIL_BYTES, size); tail = Buffer.alloc(n); fs.readSync(fd, tail, 0, n, size - n)
  } finally { fs.closeSync(fd) }
  if (!contentKind(name, head, tail)) return false
  if (size > OFFICE_WRITE_MAX) throw new ToolError(`'${name}' is too large to be checked for links that leave the file`, 'office_unsafe')
  const bytes = new Uint8Array(fs.readFileSync(abs))
  const out = await assertSafeTeamFile(name, bytes, replaced, signal, o.read ?? [])
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
  let head: Uint8Array, tail: Uint8Array
  try {
    const fd = fs.openSync(abs, 'r')
    try {
      const size = fs.fstatSync(fd).size
      head = Buffer.alloc(Math.min(HEAD_BYTES, size)); fs.readSync(fd, head, 0, head.length, 0)
      const n = Math.min(TAIL_BYTES, size); tail = Buffer.alloc(n); fs.readSync(fd, tail, 0, n, size - n)
    } finally { fs.closeSync(fd) }
  } catch { return null }
  const k = contentKind(newName, head, tail)
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
      if (!contentKind(rel, b.subarray(0, HEAD_BYTES), b.subarray(Math.max(0, b.length - TAIL_BYTES)))) continue
      if (crypto.createHash('sha256').update(b).digest('hex') !== hash) continue
      out.push(new Uint8Array(b)); room -= b.length
    } catch { /* gone or unreadable: vouches for nothing */ }
  }
  return out
}
