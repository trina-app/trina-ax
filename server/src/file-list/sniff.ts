// What a file really is, from its bytes (extensions lie: 184 of the 2,238 test files had a wrong one). Only the first
// bytes and, for a zip container, the names in its central directory are looked at; nothing is expanded here except
// one small entry (an Apple iWork preview) with a hard output cap.
import zlib from 'node:zlib'
import { cp949Text } from '@mycel/shared/text-encoding'

export type Kind =
  | 'pdf' | 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | 'tiff' | 'bmp'
  | 'docx' | 'xlsx' | 'pptx' | 'hwpx' | 'odt' | 'ods' | 'odp' | 'iwork' | 'zip'
  | 'hwp' | 'doc' | 'xls' | 'ppt' | 'ole'
  | 'video' | 'audio' | 'text' | 'empty' | 'binary'

export const KIND_LABEL: Partial<Record<Kind, string>> = {
  pdf: 'PDF', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WEBP', heic: 'HEIC', tiff: 'TIFF', bmp: 'BMP', docx: 'DOCX',
  xlsx: 'XLSX', pptx: 'PPTX', hwpx: 'HWPX', odt: 'ODT', ods: 'ODS', odp: 'ODP', iwork: 'Apple iWork', zip: 'ZIP',
  hwp: 'HWP', doc: 'DOC', xls: 'XLS', ppt: 'PPT', video: 'video', audio: 'audio', text: 'plain text',
}

/** Extensions and the kinds their bytes may be (a name with another extension is not judged). */
const EXT_KINDS: Record<string, readonly Kind[]> = {
  pdf: ['pdf'], jpg: ['jpeg'], jpeg: ['jpeg'], png: ['png'], gif: ['gif'], webp: ['webp'], heic: ['heic'], heif: ['heic'],
  tif: ['tiff'], tiff: ['tiff'], bmp: ['bmp'], docx: ['docx'], xlsx: ['xlsx'], pptx: ['pptx'], hwpx: ['hwpx'], odt: ['odt'],
  ods: ['ods'], odp: ['odp'], pages: ['iwork'], key: ['iwork'], numbers: ['iwork'], zip: ['zip', 'docx', 'xlsx', 'pptx', 'hwpx', 'odt', 'ods', 'odp', 'iwork'],
  hwp: ['hwp', 'ole'], doc: ['doc', 'ole'], xls: ['xls', 'ole'], ppt: ['ppt', 'ole'],
  md: ['text'], txt: ['text'], csv: ['text'], tsv: ['text'], json: ['text'], html: ['text'], htm: ['text'], xml: ['text'],
  mp4: ['video'], mov: ['video'], m4v: ['video'], webm: ['video'], avi: ['video'], mkv: ['video'],
  mp3: ['audio'], wav: ['audio'], m4a: ['audio'], aac: ['audio'], flac: ['audio'], ogg: ['audio', 'video'],
}

export const extOf = (name: string) => (/\.([^./]+)$/.exec(name)?.[1] ?? '').toLowerCase()

/** The real format when the name's extension says another known one (a PNG named .docx), else null. */
export function wrongExtension(name: string, kind: Kind): string | null {
  const allowed = EXT_KINDS[extOf(name)]
  if (!allowed || allowed.includes(kind)) return null
  return KIND_LABEL[kind] ?? null
}

// ---------------------------------------------------------------- zip central directory
export interface ZipEntry { name: string; method: number; csize: number; usize: number; local: number }

/** The entries of a zip from its central directory (no data read); null when it is not a readable zip. */
export function zipEntries(b: Uint8Array, max = 20_000): ZipEntry[] | null {
  if (b.length < 22) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let eocd = -1
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 0xffff; i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) return null
  const count = v.getUint16(eocd + 10, true), cdOff = v.getUint32(eocd + 16, true)
  if (count === 0xffff || cdOff === 0xffffffff || cdOff >= eocd) return null
  const out: ZipEntry[] = []
  let p = cdOff
  for (let n = 0; n < Math.min(count, max); n++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) return out.length ? out : null
    const flags = v.getUint16(p + 8, true)
    const nameLen = v.getUint16(p + 28, true)
    const raw = b.subarray(p + 46, p + 46 + nameLen)
    // names without the UTF-8 flag: legacy Korean (CP949) when it decodes cleanly, else Latin-1
    let name = new TextDecoder('utf-8').decode(raw)
    if (!(flags & 0x800)) { try { name = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { name = cp949Text(raw) ?? new TextDecoder('latin1').decode(raw) } }
    out.push({ name: name.normalize('NFC'), method: v.getUint16(p + 10, true), csize: v.getUint32(p + 20, true), usize: v.getUint32(p + 24, true), local: v.getUint32(p + 42, true) })
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
  }
  return out
}

/** One entry's bytes (stored or deflated), at most `max` bytes uncompressed; null when it cannot be read. */
export function zipRead(b: Uint8Array, e: ZipEntry, max: number): Buffer | null {
  if (e.usize > max || e.local + 30 > b.length) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (v.getUint32(e.local, true) !== 0x04034b50) return null
  const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true)
  if (start + e.csize > b.length) return null
  const data = b.subarray(start, start + e.csize)
  if (e.method === 0) return Buffer.from(data)
  if (e.method !== 8) return null
  try { return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, max) }) } catch { return null }
}

// ---------------------------------------------------------------- the kind
const at = (b: Uint8Array, off: number, s: string) => s.split('').every((c, i) => b[off + i] === c.charCodeAt(0))

/** The kind of a file from its first bytes (`head`, at least 4 KB when the file has them) and, for a zip, all of it
 * (`whole`, when it was read; without it a zip stays 'zip'). */
export function sniff(head: Uint8Array, ext: string, whole?: Uint8Array | null): Kind {
  if (!head.length) return 'empty'
  if (at(head, 0, '%PDF')) return 'pdf'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head[0] === 0x89 && at(head, 1, 'PNG')) return 'png'
  if (at(head, 0, 'GIF8')) return 'gif'
  if (at(head, 0, 'RIFF') && at(head, 8, 'WEBP')) return 'webp'
  if (at(head, 0, 'RIFF') && at(head, 8, 'WAVE')) return 'audio'
  if (at(head, 0, 'RIFF') && at(head, 8, 'AVI')) return 'video'
  if (at(head, 0, 'BM') && head.length > 14) return 'bmp'
  if (at(head, 4, 'ftyp')) {
    const brand = String.fromCharCode(...head.subarray(8, 12))
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc', 'heim', 'heis'].includes(brand)) return 'heic'
    if (['M4A ', 'M4B '].includes(brand)) return 'audio'
    return 'video'
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video'
  if (at(head, 0, 'ID3') || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) || at(head, 0, 'fLaC') || at(head, 0, 'OggS')) return 'audio'
  if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a)) return 'tiff'
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5)) {
    const entries = whole ? zipEntries(whole) : null
    if (!entries) return 'zip'
    const names = new Set(entries.map((e) => e.name))
    const mime = entries.find((e) => e.name === 'mimetype')
    if (names.has('[Content_Types].xml')) {
      if (entries.some((e) => e.name.startsWith('word/'))) return 'docx'
      if (entries.some((e) => e.name.startsWith('xl/'))) return 'xlsx'
      if (entries.some((e) => e.name.startsWith('ppt/'))) return 'pptx'
    }
    if (names.has('Contents/section0.xml') || names.has('Preview/PrvText.txt') || names.has('Contents/content.hpf')) return 'hwpx'
    if (mime && whole) {
      const m = zipRead(whole, mime, 200)?.toString('latin1') ?? ''
      if (m.includes('opendocument.text')) return 'odt'
      if (m.includes('opendocument.spreadsheet')) return 'ods'
      if (m.includes('opendocument.presentation')) return 'odp'
    }
    if (entries.some((e) => e.name.startsWith('Index/') && e.name.endsWith('.iwa')) || names.has('preview.jpg')) return 'iwork'
    return 'zip'
  }
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    return ext === 'hwp' || ext === 'doc' || ext === 'xls' || ext === 'ppt' ? ext : 'ole'
  }
  // text: no NUL in the first bytes (UTF-16 with a BOM counts too)
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return 'text'
  return head.subarray(0, 8192).includes(0) ? 'binary' : 'text'
}
