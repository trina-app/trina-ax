// What the reader model is given for one file, made by the server's own converters (docs/AGENTS/plan/
// 20261111-0630-file-list.md "Scope" 4): text from files/extract.ts (Office, PDF text layers, HWP/HWPX, plain text),
// images through the vision normalizer (photos, screenshots, and PDF pages without text: page 1, plus up to 2 more of
// a multi-page scan), the names inside an archive. Video, audio and files nothing can read get their line without a
// model ("meta"). The type comes from the bytes (sniff.ts), never from the extension. Bytes are read from an fd opened
// without following links; converters run isolated and below people's work (tools/isolate.ts inBackground).
import fs from 'node:fs'
import { constants as C } from 'node:fs'
import { decodeText, extractText, type Tools } from '../files/extract'
import { modelImage, pdfLayer, pdfPageImage, type VisionTools } from '../files/vision'
import { inBackground } from '../tools/isolate'
import { unknownFields, type Fields } from './format'
import { extOf, KIND_LABEL, sniff, wrongExtension, zipEntries, zipRead, type Kind } from './sniff'

/** characters of a file's text the model sees */
export const TEXT_MAX = 3000
/** a PDF whose first two pages have fewer non-space characters is read as a scan (images) */
export const SCAN_CHARS = 50
/** bytes read of a file whose whole content is needed (Office, PDF, images, archives); larger ones are not read */
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
}

export interface PrepareEnv {
  extract: Tools
  vision: VisionTools
  /** the team sends images to the AI (Team settings; files/vision.ts visionOn) and the reader can take them */
  images: boolean
  signal?: AbortSignal
}

/** Read up to `max` bytes of a regular single-link file without following a link; null when it is not one. */
function readFile(abs: string, max: number): { bytes: Buffer; size: number; mtimeMs: number } | null {
  let fd: number
  try { fd = fs.openSync(abs, C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)) } catch { return null }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.nlink > 1) return null
    const n = Math.min(st.size, max)
    const b = Buffer.alloc(n)
    let off = 0
    while (off < n) { const r = fs.readSync(fd, b, off, n - off, off); if (r <= 0) break; off += r }
    return { bytes: b.subarray(0, off), size: st.size, mtimeMs: st.mtimeMs }
  } catch { return null } finally { fs.closeSync(fd) }
}

const month = (ms: number) => new Date(ms).toISOString().slice(0, 7)
const meta = (rel: string, kind: Kind, real: string | null, fields: Fields): Item => ({ rel, kind, real, group: 'meta', meta: fields })
const lower = (on: () => Promise<unknown>) => inBackground(() => true, on as () => Promise<never>)

/** The name a converter is given: the real format's extension, so a docx named .pdf is read as a docx. */
const NAME_OF: Partial<Record<Kind, string>> = { docx: 'x.docx', xlsx: 'x.xlsx', pptx: 'x.pptx', hwpx: 'x.hwpx', odt: 'x.odt', ods: 'x.ods', hwp: 'x.hwp', xls: 'x.xls',
  jpeg: 'x.jpg', png: 'x.png', gif: 'x.gif', webp: 'x.webp', heic: 'x.heic', tiff: 'x.tiff', bmp: 'x.bmp', pdf: 'x.pdf' }
const IMAGE_KINDS: ReadonlySet<Kind> = new Set(['jpeg', 'png', 'gif', 'webp', 'heic', 'tiff', 'bmp'])
const OFFICE_KINDS: ReadonlySet<Kind> = new Set(['docx', 'xlsx', 'pptx', 'hwpx', 'odt', 'ods', 'hwp', 'xls'])

/** Pages of a scan the model sees: page 1, and for a multi-page scan up to 2 more spread over it (a bundle of several
 * documents in one PDF). */
export function scanPages(n: number): number[] {
  if (n <= 1) return [1]
  if (n === 2) return [1, 2]
  return [...new Set([1, Math.ceil((n + 1) / 2), n])]
}

/** One file -> what the model sees (or its line without a model). Never throws: a broken file gets an honest line. */
export async function prepare(env: PrepareEnv, abs: string, rel: string): Promise<Item> {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  const ext = extOf(name)
  const head = readFile(abs, HEAD)
  if (!head) return meta(rel, 'binary', null, unknownFields('cannot be opened'))
  let whole: Buffer | null = head.size <= HEAD ? head.bytes : null
  // a zip container is known only from its whole directory (docx, hwpx, iWork …)
  if (!whole && head.bytes[0] === 0x50 && head.bytes[1] === 0x4b && head.size <= READ_MAX) whole = readFile(abs, READ_MAX)?.bytes ?? null
  const kind = sniff(head.bytes, ext, whole)
  const real = wrongExtension(name, kind)
  const label = KIND_LABEL[kind] ?? 'unknown'
  try {
    if (kind === 'empty') return meta(rel, kind, real, unknownFields('empty file'))
    if (kind === 'binary') return meta(rel, kind, real, unknownFields('unknown format'))
    if (kind === 'video' || kind === 'audio') {
      return meta(rel, kind, real, { type: kind === 'video' ? 'video' : 'audio recording', names: [], date: '', what: `${kind} file, content not read (modified ${month(head.mtimeMs)})`, lang: 'none' })
    }
    if (kind === 'text') {
      const t = decodeText(head.bytes)
      return t.trim() ? { rel, kind, real, group: 'text', text: t.slice(0, TEXT_MAX), hint: ext ? `${ext} text` : 'plain text' } : meta(rel, kind, real, unknownFields('no content'))
    }
    if (kind === 'doc' || kind === 'ppt' || kind === 'ole' || kind === 'odp') {
      return meta(rel, kind, real, unknownFields(`${label === 'unknown' ? 'old Office' : label} document, text not read`))
    }
    if (head.size > READ_MAX) return meta(rel, kind, real, unknownFields(`large ${label} file, not read`))
    const bytes = whole ?? readFile(abs, READ_MAX)?.bytes
    if (!bytes) return meta(rel, kind, real, unknownFields('cannot be opened'))
    if (kind === 'zip') {
      const names = (zipEntries(bytes) ?? []).map((e) => e.name).filter((n) => !n.endsWith('/'))
      if (!names.length) return meta(rel, kind, real, unknownFields('archive that cannot be opened'))
      const listing = names.slice(0, ZIP_NAMES).join('\n') + (names.length > ZIP_NAMES ? `\n… ${names.length - ZIP_NAMES} more` : '')
      return { rel, kind, real, group: 'text', text: listing, hint: `zip archive with ${names.length} files; only the names inside are shown` }
    }
    if (kind === 'iwork') {
      const entries = zipEntries(bytes) ?? []
      const pv = ['preview.jpg', 'preview-web.jpg', 'QuickLook/Thumbnail.jpg'].map((n) => entries.find((e) => e.name === n)).find(Boolean)
      const img = pv ? zipRead(bytes, pv, 8 * 1024 * 1024) : null
      if (!img || !env.images) return meta(rel, kind, real, unknownFields(img ? 'Apple iWork document, preview not sent (images to the AI are off)' : 'Apple iWork document without a preview'))
      const jpeg = await lower(() => modelImage('x.jpg', img, env.vision, env.signal)) as Buffer
      return { rel, kind, real, group: 'image', images: [{ media: 'image/jpeg', data: jpeg }], hint: `Apple ${ext || 'iWork'} document; first-page preview image` }
    }
    if (IMAGE_KINDS.has(kind)) {
      if (!env.images) return meta(rel, kind, real, unknownFields('image, not read (images to the AI are off)'))
      const jpeg = await lower(() => modelImage(NAME_OF[kind]!, bytes, env.vision, env.signal)) as Buffer
      return { rel, kind, real, group: 'image', images: [{ media: 'image/jpeg', data: jpeg }] }
    }
    if (kind === 'pdf') {
      const pages = await lower(() => pdfLayer(bytes, env.vision, env.signal)) as string[]
      const first = pages.slice(0, 2).join('\n')
      if (first.replace(/\s/g, '').length >= SCAN_CHARS) {
        return { rel, kind, real, group: 'text', text: first.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, TEXT_MAX), hint: `PDF, ${pages.length} page${pages.length === 1 ? '' : 's'}, text of the first pages` }
      }
      if (!env.images) return meta(rel, kind, real, unknownFields('scanned PDF, not read (images to the AI are off)'))
      const want = scanPages(Math.max(1, pages.length))
      const images: Item['images'] = []
      for (const p of want) {
        // a page of a mixed PDF that has text is still drawn: the model sees the page as it is
        try { images.push({ media: 'image/jpeg', data: await lower(() => pdfPageImage(bytes, p, env.vision, env.signal)) as Buffer }) } catch (e) { if (p === 1) throw e }
      }
      const shown = want.slice(0, images.length)
      return { rel, kind, real, group: 'image', images, hint: `PDF without a text layer (scan), ${pages.length} page${pages.length === 1 ? '' : 's'}; page${shown.length > 1 ? 's' : ''} ${shown.join(', ')} shown` }
    }
    if (OFFICE_KINDS.has(kind)) {
      const text = await lower(() => extractText(NAME_OF[kind]!, bytes, env.extract, env.signal)) as string
      const t = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
      return t ? { rel, kind, real, group: 'text', text: t.slice(0, TEXT_MAX), hint: `${label} document` } : meta(rel, kind, real, unknownFields('no content'))
    }
    return meta(rel, kind, real, unknownFields('unknown format'))
  } catch (e) {
    env.signal?.throwIfAborted()
    return meta(rel, kind, real, unknownFields(IMAGE_KINDS.has(kind) ? 'unreadable image' : `${label} file that cannot be read`))
  }
}
