// The attachments of an email file, for the AI's unzip_file (tools/unzip.ts; QA TC-4920,
// docs/decisions/20261118-make-zip-and-mail-attachments.md). Before it the AI could read an .eml but said "I can only
// save text files" for its attachment and sent the person to their mail app.
// - .eml (RFC 5322 / MIME): multipart parts walked to MAIL_DEPTH_MAX levels and MAIL_PARTS_MAX parts; a part is an
//   attachment when it says so (Content-Disposition: attachment) or carries a file name; a picture placed inside the
//   body (inline with a Content-ID: a signature logo) is counted, not saved; an attached email (message/rfc822) is saved
//   as its own .eml. Bodies decoded from base64 or quoted-printable. Names from RFC 2231 (filename*=UTF-8''…, also in
//   pieces) or RFC 2047 encoded words (=?UTF-8?B?…?=, =?ks_c_5601-1987?B?…?=), raw 8-bit names as UTF-8 else CP949.
// - .msg (Outlook): the compound file read by files/cfb.ts (bounded, version 3); each __attach_version1.0_#… storage's
//   data stream (PR_ATTACH_DATA_BIN) under its long name, else its short or display name. An email inside the email
//   (an embedded message) is named, not saved.
// - Names cleaned for the team folder (no slashes or characters Windows refuses; policy/names.ts badSegment), else
//   attachment-<n>; the caller saves each through the normal checks and never over an existing file.
import { readCfb, CfbError } from './cfb'
import { badSegment } from '../policy/names'

export const MAIL_PARTS_MAX = 2000
export const MAIL_DEPTH_MAX = 20

export interface MailAttachment { name: string; data: Buffer; mime: string }
export interface MailParts { attachments: MailAttachment[]; skipped: { name: string; why: string }[]; inline: number }

export class MailProblem extends Error {}

export const isMailFile = (name: string) => /\.(eml|msg)$/i.test(name)

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const CP949 = new TextDecoder('euc-kr')
/** WHATWG names for the charsets mail programs write (ks_c_5601-1987 is Windows' Korean code page) */
const CHARSET: Record<string, string> = { 'ks_c_5601-1987': 'euc-kr', 'ks_c_5601': 'euc-kr', cp949: 'euc-kr', 'x-windows-949': 'euc-kr', 'unicode-1-1-utf-7': 'utf-8' }
function decodeBytes(b: Uint8Array, charset?: string): string {
  const cs = (charset ?? '').trim().toLowerCase()
  if (cs) { try { return new TextDecoder(CHARSET[cs] ?? cs).decode(b) } catch { /* unknown charset: guessed below */ } }
  try { return UTF8.decode(b) } catch { return CP949.decode(b) }
}
/** a header value held as Latin-1 (one char per byte): its bytes as UTF-8, else CP949 */
const rawHeader = (s: string) => /[\x80-\xff]/.test(s) ? decodeBytes(Buffer.from(s, 'latin1')) : s

/** RFC 2047 encoded words in a header value */
function encodedWords(s: string): string {
  return s.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
    const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1')
    return decodeBytes(bytes, cs.split('*')[0])
  })
}

interface Header { value: string; params: Map<string, string> }
/** A structured header (Content-Type, Content-Disposition): its value and its parameters, RFC 2231 pieces joined. */
function parseHeader(raw: string): Header {
  const parts: string[] = []
  let cur = '', q = false
  for (const ch of raw) {
    if (ch === '"') q = !q
    if (ch === ';' && !q) { parts.push(cur); cur = '' } else cur += ch
  }
  parts.push(cur)
  const params = new Map<string, string>()
  const pieces = new Map<string, { n: number; v: string; enc: boolean }[]>()
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq < 0) continue
    const key = p.slice(0, eq).trim().toLowerCase()
    let v = p.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1')
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key)
    if (!m) continue
    if (m[2] === undefined && !m[3]) { params.set(m[1]!, v); continue }
    const list = pieces.get(m[1]!) ?? []
    list.push({ n: Number(m[2] ?? 0), v, enc: !!m[3] })
    pieces.set(m[1]!, list)
  }
  for (const [k, list] of pieces) {
    list.sort((a, b) => a.n - b.n)
    let charset = ''
    const bytes: number[] = []
    for (const [i, p] of list.entries()) {
      let v = p.v
      if (p.enc && i === 0) { const m = /^([^']*)'[^']*'(.*)$/.exec(v); if (m) { charset = m[1]!; v = m[2]! } }
      if (p.enc) { for (let j = 0; j < v.length; j++) { if (v[j] === '%' && /^[0-9A-Fa-f]{2}$/.test(v.slice(j + 1, j + 3))) { bytes.push(parseInt(v.slice(j + 1, j + 3), 16)); j += 2 } else bytes.push(v.charCodeAt(j) & 0xff) } }
      else for (const ch of Buffer.from(v, 'latin1')) bytes.push(ch)
    }
    params.set(k, decodeBytes(Uint8Array.from(bytes), charset))
  }
  return { value: parts[0]!.trim().toLowerCase(), params }
}

/** headers and body of an entity held as Latin-1 */
function splitEntity(s: string): { headers: Map<string, string>; body: string } {
  const m = /\r?\n\r?\n/.exec(s)
  const head = m ? s.slice(0, m.index) : s
  const body = m ? s.slice(m.index + m[0].length) : ''
  const headers = new Map<string, string>()
  let last = ''
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) { headers.set(last, headers.get(last)! + ' ' + line.trim()); continue }
    const i = line.indexOf(':')
    if (i <= 0) continue
    last = line.slice(0, i).trim().toLowerCase()
    // the first of a header given twice (a crafted second Content-Type does not replace the real one)
    if (!headers.has(last)) headers.set(last, line.slice(i + 1).trim())
    else last = ''
  }
  return { headers, body }
}

function decodeBody(body: string, cte: string): Buffer {
  const e = cte.trim().toLowerCase()
  if (e === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (e === 'quoted-printable') {
    return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1')
  }
  return Buffer.from(body, 'latin1')
}

const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv',
  'application/zip': 'zip', 'message/rfc822': 'eml', 'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'application/x-hwp': 'hwp', 'application/hwp+zip': 'hwpx',
}

/** A file name the team folder takes (an attachment's name is the sender's choice), or '' */
export function cleanAttachmentName(s: string): string {
  const n = s.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, 150)
  return n && !badSegment(n) ? n : ''
}
const named = (raw: string, mime: string, n: number) => cleanAttachmentName(raw) || `attachment-${n}.${MIME_EXT[mime] ?? 'bin'}`

function emlParts(bytes: Uint8Array): MailParts {
  const out: MailParts = { attachments: [], skipped: [], inline: 0 }
  let parts = 0
  const walk = (entity: string, depth: number) => {
    if (++parts > MAIL_PARTS_MAX) throw new MailProblem(`more than ${MAIL_PARTS_MAX} parts`)
    const { headers, body } = splitEntity(entity)
    const ct = parseHeader(rawHeader(headers.get('content-type') ?? 'text/plain'))
    const cd = parseHeader(rawHeader(headers.get('content-disposition') ?? ''))
    if (ct.value.startsWith('multipart/')) {
      const boundary = ct.params.get('boundary')
      if (!boundary || depth >= MAIL_DEPTH_MAX) return
      const marker = '--' + boundary
      const chunks = body.split(new RegExp(`\\r?\\n?${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      // before the first marker: the preamble; after "--marker--": the epilogue
      for (const c of chunks.slice(1)) {
        if (c.startsWith('--')) break
        walk(c.replace(/^[ \t]*\r?\n/, ''), depth + 1)
      }
      return
    }
    const rawName = cd.params.get('filename') ?? ct.params.get('name') ?? ''
    const name = encodedWords(rawName)
    const disposition = cd.value
    const isAttachment = disposition === 'attachment' || (!!name && disposition !== 'inline') || ct.value === 'message/rfc822'
    if (!isAttachment) {
      // a picture inside the body (a logo, a screenshot pasted in): not an attachment
      if (name || headers.has('content-id')) out.inline++
      return
    }
    const data = ct.value === 'message/rfc822' ? Buffer.from(body, 'latin1') : decodeBody(body, headers.get('content-transfer-encoding') ?? '')
    const n = out.attachments.length + 1
    let file = named(name || (ct.value === 'message/rfc822' ? (encodedWords(rawHeader(splitEntity(body).headers.get('subject') ?? '')) || 'message') + '.eml' : ''), ct.value, n)
    if (ct.value === 'message/rfc822' && !/\.eml$/i.test(file)) file += '.eml'
    out.attachments.push({ name: file, data, mime: ct.value })
  }
  walk(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'), 0)
  return out
}

function msgParts(bytes: Uint8Array): MailParts {
  let cfb
  try { cfb = readCfb(bytes) } catch (e) { if (e instanceof CfbError) throw new MailProblem(`not an Outlook file this server can read (${e.message})`); throw e }
  const out: MailParts = { attachments: [], skipped: [], inline: 0 }
  const storages = new Set<string>()
  for (const p of cfb.streams.keys()) { const top = p.split('/')[0]!; if (/^__attach_version1\.0_#[0-9A-Fa-f]{8}$/.test(top)) storages.add(top) }
  const text = (at: string, id: string): string => {
    const u = cfb.streams.get(`${at}/__substg1.0_${id}001F`)?.data
    if (u) return Buffer.from(u).toString('utf16le').replace(/\u0000+$/, '')
    const a = cfb.streams.get(`${at}/__substg1.0_${id}001E`)?.data
    return a ? decodeBytes(a).replace(/\u0000+$/, '') : ''
  }
  for (const at of [...storages].sort()) {
    const raw = text(at, '3707') || text(at, '3704') || text(at, '3001')
    const mime = text(at, '370E').toLowerCase()
    const data = cfb.streams.get(`${at}/__substg1.0_37010102`)?.data
    if (!data) {
      out.skipped.push({ name: raw || 'an attached item', why: 'an email or item inside the email, which cannot be taken out as a file here' })
      continue
    }
    out.attachments.push({ name: named(raw, mime, out.attachments.length + 1), data: Buffer.from(data), mime })
  }
  return out
}

/** The attachments of an .eml or .msg (by its name); MailProblem when it cannot be read. */
export function mailParts(name: string, bytes: Uint8Array): MailParts {
  return /\.msg$/i.test(name) ? msgParts(bytes) : emlParts(bytes)
}
