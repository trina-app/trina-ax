// What the reader model is given for one file, made by the server's own converters (docs/AGENTS/plan/
// 20261111-0630-file-list.md "Scope" 3): text from files/extract.ts (Office, PDF text layers, HWP/HWPX, plain text) or
// the search's fresh text cache, images through the vision normalizer (photos, screenshots, and PDF pages without
// text: page 1, plus up to 2 more of a multi-page scan), the names inside an archive. Video, audio, camera photos and
// files nothing can read get their line without a model ("meta"). The type comes from the bytes (sniff.ts).
//
// The bytes are read once, from an fd opened without following a link, of a regular single-link file whose parent
// folders are checked to be the real ones (realpathCheck) before the open and again after the read, with the fd's
// device and inode equal to the path's (a parent folder swapped for a link meanwhile, which a dev environment can do,
// is caught); a quarantined file or its bytes are never read. The size, mtime, sha256 and inode kept with the line are
// those of exactly these bytes, so a file that changed after it was read no longer matches and its line is not shown
// (view.ts).
import fs from 'node:fs'
import { constants as C } from 'node:fs'
import path from 'node:path'
import { decodeText, extractText, type Tools } from '../files/extract'
import type { OfficeCache } from '../files/search'
import { modelImage, pdfLayer, pdfPageImage, type VisionTools } from '../files/vision'
import { realpathCheck } from '../policy/resolve'
import { inBackground } from '../tools/isolate'
import { unknownFields, type Fields } from './format'
import { CAMERA_PHOTOS_META } from './policy'
import { extOf, KIND_LABEL, sniff, wrongExtension, zipEntries, zipRead, type Kind } from './sniff'

/** characters of a file's text the model sees */
export const TEXT_MAX = 3000
/** a PDF whose first two pages have fewer non-space characters is read as a scan (images) */
export const SCAN_CHARS = 50
/** a camera photo whose OCR text has at least this many characters is a photo of a document: the model reads it */
export const PHOTO_TEXT_CHARS = 30
/** bytes kept of a file whose whole content is needed (Office, PDF, images, archives); larger ones are not read */
export const READ_MAX = 64 * 1024 * 1024
const HEAD = 64 * 1024
/** names of an archive the model sees */
const ZIP_NAMES = 60

export type Group = 'text' | 'image' | 'meta'
export interface Item {
  /** team path (actual names on disk) */
  rel: string
  kind: Kind
  /** the real format when the extension says another */
  real: string | null
  group: Group
  /** a note for the model (what kind of file, how many pages) */
  hint?: string
  text?: string
  images?: { media: 'image/jpeg'; data: Buffer }[]
  /** group meta: the fields, no model */
  meta?: Fields
  /** the file as it was read: what its line describes (sha null: larger than READ_MAX, not hashed) */
  read: { size: number; mtimeMs: number; sha: string | null; ino: string }
}

export interface PrepareEnv {
  root: string
  extract: Tools
  vision: VisionTools
  /** the search's text cache of Office files and PDFs (files/search.ts): its text when fresh, instead of converting */
  office?: OfficeCache
  /** the server's OCR (macOS): tells a photo of a document from other camera photos */
  ocr?: string | null
  /** the team sends images to the AI (Team settings) and the reader can take them */
  images: boolean
  /** the safe operations quarantine (files the server made in a confidential workflow): never read */
  quarantine?: { hasFile(abs: string): boolean; hasHash(hash: string): boolean }
  signal?: AbortSignal
}

/**
 * Read a team file safely: parents checked before the open and after the read, no link followed, a regular single-link
 * file whose fd is the path's own file. The bytes (all of them up to `max`, else the first HEAD), its stat, its
 * "dev:ino" and the sha256 of the whole file (null when it is larger than `max`: not read to its end). null when it is
 * not such a file, or it changed while it was read.
 */
export async function readSafe(root: string, rel: string, max = READ_MAX): Promise<{ bytes: Buffer; whole: boolean; st: fs.Stats; sha: string | null; ino: string } | null> {
  const segs = rel.split('/')
  const abs = path.join(root, ...segs)
  try { realpathCheck(root, segs.slice(0, -1)) } catch { return null }
  let fh: fs.promises.FileHandle
  try { fh = await fs.promises.open(abs, C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)) } catch { return null }
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.nlink > 1) return null
    const whole = st.size <= max
    const h = whole ? new Bun.CryptoHasher('sha256') : null
    const keep: Buffer[] = []
    let kept = 0
    const buf = Buffer.alloc(1 << 20)
    for (;;) {
      const room = (whole ? max : HEAD) - kept
      if (!whole && room <= 0) break
      const { bytesRead } = await fh.read(buf, 0, buf.length)
      if (!bytesRead) break
      const chunk = buf.subarray(0, bytesRead)
      h?.update(chunk)
      if (room > 0) { const c = Buffer.from(chunk.subarray(0, room)); keep.push(c); kept += c.length }
    }
    const after = await fh.stat()
    // changed while it was read: not described now (the next run reads it again)
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) return null
    // the path still leads to this very file through real folders (no parent swapped for a link meanwhile)
    let now: fs.Stats
    try { now = fs.lstatSync(abs) } catch { return null }
    if (now.dev !== st.dev || now.ino !== st.ino) return null
    try { realpathCheck(root, segs.slice(0, -1)) } catch { return null }
    return { bytes: Buffer.concat(keep), whole, st, sha: h ? h.digest('hex') : null, ino: `${st.dev}:${st.ino}` }
  } catch { return null } finally { await fh.close() }
}

// ---------------------------------------------------------------- EXIF (camera photos)
/** Camera make and model and the capture date (YYYY-MM-DD) from a JPEG's EXIF, or null when it has none. */
export function jpegCamera(b: Uint8Array): { make: string; model: string; date: string } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let p = 2
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1]!, len = (b[p + 2]! << 8) | b[p + 3]!
    if (marker === 0xda || len < 2) break
    if (marker === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) return tiff(b.subarray(p + 10, p + 2 + len))
    p += 2 + len
  }
  return null
}
function tiff(t: Uint8Array): { make: string; model: string; date: string } | null {
  if (t.length < 8) return null
  const le = t[0] === 0x49 && t[1] === 0x49
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength)
  const u16 = (o: number) => (o + 2 <= t.length ? v.getUint16(o, le) : 0)
  const u32 = (o: number) => (o + 4 <= t.length ? v.getUint32(o, le) : 0)
  const ascii = (count: number, at: number) => {
    const off = count <= 4 ? at : u32(at)
    if (off + count > t.length) return ''
    return new TextDecoder('latin1').decode(t.subarray(off, off + count)).replace(/\0.*$/s, '').trim()
  }
  const ifd = (off: number) => {
    const out = new Map<number, string | number>()
    const n = u16(off)
    for (let i = 0; i < Math.min(n, 200); i++) {
      const e = off + 2 + i * 12
      if (e + 12 > t.length) break
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4)
      if (type === 2) out.set(tag, ascii(count, e + 8))
      else if (type === 4) out.set(tag, u32(e + 8))
    }
    return out
  }
  const ifd0 = ifd(u32(4))
  const make = String(ifd0.get(0x010f) ?? ''), model = String(ifd0.get(0x0110) ?? '')
  if (!make && !model) return null
  const exif = typeof ifd0.get(0x8769) === 'number' ? ifd(ifd0.get(0x8769) as number) : new Map()
  const raw = String(exif.get(0x9003) ?? ifd0.get(0x0132) ?? '')
  const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(raw)
  return { make, model, date: m ? `${m[1]}-${m[2]}-${m[3]}` : '' }
}

const month = (ms: number) => new Date(ms).toISOString().slice(0, 7)
const lower = <T>(f: () => Promise<T>) => inBackground(() => true, f)

/** The name a converter is given: the real format's extension, so a docx named .pdf is read as a docx. */
const NAME_OF: Partial<Record<Kind, string>> = { docx: 'x.docx', xlsx: 'x.xlsx', pptx: 'x.pptx', hwpx: 'x.hwpx', odt: 'x.odt', ods: 'x.ods', hwp: 'x.hwp', xls: 'x.xls',
  jpeg: 'x.jpg', png: 'x.png', gif: 'x.gif', webp: 'x.webp', heic: 'x.heic', tiff: 'x.tiff', bmp: 'x.bmp', pdf: 'x.pdf' }
export const IMAGE_KINDS: ReadonlySet<Kind> = new Set(['jpeg', 'png', 'gif', 'webp', 'heic', 'tiff', 'bmp'])
const OFFICE_KINDS: ReadonlySet<Kind> = new Set(['docx', 'xlsx', 'pptx', 'hwpx', 'odt', 'ods', 'hwp', 'xls'])

/** Pages of a scan the model sees: page 1, and for a multi-page scan up to 2 more spread over it (a bundle of several
 * documents in one PDF). */
export function scanPages(n: number): number[] {
  if (n <= 1) return [1]
  if (n === 2) return [1, 2]
  return [...new Set([1, Math.ceil((n + 1) / 2), n])]
}

/** The search's cached text of this file when it is current (same name, not misnamed), else null. */
function cachedText(env: PrepareEnv, rel: string, st: fs.Stats, real: string | null): string | null {
  if (!env.office || real) return null
  try { return env.office.fresh(rel, st) ? fs.readFileSync(env.office.cachePath(rel), 'utf8') : null } catch { return null }
}

const tidy = (t: string) => t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()

/** One file -> what the model sees (or its line without a model). null: the file could not be read safely now. */
export async function prepare(env: PrepareEnv, rel: string): Promise<Item | null> {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  const ext = extOf(name)
  if (env.quarantine?.hasFile(path.join(env.root, ...rel.split('/')))) return null
  const f = await readSafe(env.root, rel)
  if (!f || (f.sha && env.quarantine?.hasHash(f.sha))) return null
  const read = { size: f.st.size, mtimeMs: f.st.mtimeMs, sha: f.sha, ino: f.ino }
  const bytes = f.bytes
  const kind = sniff(bytes.subarray(0, HEAD), ext, f.whole ? bytes : null)
  const real = wrongExtension(name, kind)
  const label = KIND_LABEL[kind] ?? 'unknown'
  const meta = (fields: Fields): Item => ({ rel, kind, real, group: 'meta', meta: fields, read })
  try {
    if (kind === 'empty') return meta(unknownFields('empty file'))
    if (kind === 'binary') return meta(unknownFields('unknown format'))
    if (kind === 'video' || kind === 'audio') {
      return meta({ type: kind === 'video' ? 'video' : 'audio recording', names: [], date: '', what: `${kind} file, content not read (modified ${month(f.st.mtimeMs)})`, lang: 'none' })
    }
    if (kind === 'text') {
      const t = decodeText(bytes.subarray(0, TEXT_MAX * 4))
      return t.trim() ? { rel, kind, real, group: 'text', text: t.slice(0, TEXT_MAX), hint: ext ? `${ext} text` : 'plain text', read } : meta(unknownFields('no content'))
    }
    if (kind === 'doc' || kind === 'ppt' || kind === 'ole' || kind === 'odp') return meta(unknownFields(`${label === 'unknown' ? 'old Office' : label} document, text not read`))
    if (!f.whole) return meta(unknownFields(`large ${label} file, not read`))
    if (kind === 'zip') {
      const names = (zipEntries(bytes) ?? []).map((e) => e.name).filter((n) => !n.endsWith('/'))
      if (!names.length) return meta(unknownFields('archive that cannot be opened'))
      const listing = names.slice(0, ZIP_NAMES).join('\n') + (names.length > ZIP_NAMES ? `\n… ${names.length - ZIP_NAMES} more` : '')
      return { rel, kind, real, group: 'text', text: listing, hint: `zip archive with ${names.length} files; only the names inside are shown`, read }
    }
    if (kind === 'iwork') {
      const entries = zipEntries(bytes) ?? []
      const pv = ['preview.jpg', 'preview-web.jpg', 'QuickLook/Thumbnail.jpg'].map((n) => entries.find((e) => e.name === n)).find(Boolean)
      const img = pv ? zipRead(bytes, pv, 8 * 1024 * 1024) : null
      if (!img || !env.images) return meta(unknownFields(img ? 'Apple iWork document, preview not sent (images are not sent to the AI)' : 'Apple iWork document without a preview'))
      const jpeg = await lower(() => modelImage('x.jpg', img, env.vision, env.signal))
      return { rel, kind, real, group: 'image', images: [{ media: 'image/jpeg', data: jpeg }], hint: `Apple ${ext || 'iWork'} document; first-page preview image`, read }
    }
    if (IMAGE_KINDS.has(kind)) {
      // a camera photo: its metadata only, unless the server's OCR finds the text of a document in it
      const cam = kind === 'heic' ? { make: '', model: '', date: '' } : kind === 'jpeg' ? jpegCamera(bytes) : null
      if (cam && CAMERA_PHOTOS_META) {
        let words = ''
        if (env.ocr) { try { words = await lower(() => extractText(NAME_OF[kind]!, bytes, { pandoc: null, pdftotext: null, ocr: env.ocr }, env.signal)) } catch { words = '' } }
        if (words.replace(/\s/g, '').length < PHOTO_TEXT_CHARS) {
          const camera = [cam.make, cam.model].filter(Boolean).join(' ').trim()
          return meta({ type: 'photo', names: [], date: cam.date, what: `camera photo${camera ? ` (${camera})` : ''}, not read`, lang: 'none' })
        }
      }
      if (!env.images) return meta(unknownFields('image, not read (images are not sent to the AI)'))
      const jpeg = await lower(() => modelImage(NAME_OF[kind]!, bytes, env.vision, env.signal))
      return { rel, kind, real, group: 'image', images: [{ media: 'image/jpeg', data: jpeg }], read }
    }
    if (kind === 'pdf') {
      const cached = cachedText(env, rel, f.st, real)
      const pages = cached !== null ? cached.split('\f').filter((p, i, a) => i < a.length - 1 || p.trim()) : await lower(() => pdfLayer(bytes, env.vision, env.signal))
      const first = pages.slice(0, 2).join('\n')
      if (first.replace(/\s/g, '').length >= SCAN_CHARS) {
        return { rel, kind, real, group: 'text', text: tidy(first).slice(0, TEXT_MAX), hint: `PDF, ${pages.length} page${pages.length === 1 ? '' : 's'}, text of the first pages`, read }
      }
      if (!env.images) return meta(unknownFields('scanned PDF, not read (images are not sent to the AI)'))
      const want = scanPages(Math.max(1, pages.length))
      const images: NonNullable<Item['images']> = []
      for (const p of want) {
        try { images.push({ media: 'image/jpeg', data: await lower(() => pdfPageImage(bytes, p, env.vision, env.signal)) }) } catch (e) { if (p === 1) throw e }
      }
      const shown = want.slice(0, images.length)
      return { rel, kind, real, group: 'image', images, hint: `PDF without a text layer (scan), ${pages.length} page${pages.length === 1 ? '' : 's'}; page${shown.length > 1 ? 's' : ''} ${shown.join(', ')} shown`, read }
    }
    if (OFFICE_KINDS.has(kind)) {
      const text = cachedText(env, rel, f.st, real) ?? await lower(() => extractText(NAME_OF[kind]!, bytes, env.extract, env.signal))
      const t = tidy(text)
      return t ? { rel, kind, real, group: 'text', text: t.slice(0, TEXT_MAX), hint: `${label} document`, read } : meta(unknownFields('no content'))
    }
    return meta(unknownFields('unknown format'))
  } catch {
    env.signal?.throwIfAborted()
    return meta(unknownFields(IMAGE_KINDS.has(kind) ? 'unreadable image' : `${label} file that cannot be read`))
  }
}
