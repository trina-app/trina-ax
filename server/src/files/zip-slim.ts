// The text parts of an Office zip (.docx, .pptx, .xlsx, .hwpx) without its pictures, sound, video, fonts and embedded
// files. What makes a big deck or report big is almost always those, and none of them is text, so the readers
// (pandoc, the office worker) get a small zip of the same document instead (docs/decisions/20261118-limits-office-read.md).
// Nothing is inflated here: the central directory is read (zip-guard.ts readCentral, linear and bounded by the entry
// count) and the kept parts are copied as they are, still compressed. A dropped part stays in the zip as an empty
// entry under its own name, so a relationship that points at it still finds a part (an empty picture). The readers
// check the slim zip again before they expand anything (checkZip). Pure and cheap, so it may run in the server process.
import { entryData, readCentral, ZIP_ENTRIES_MAX, ZipProblem, type ZipEntry } from './zip-guard'

/** parts that hold text: XML (OOXML, OWPML, ODF), relationships, and the small text files of a container */
const TEXT_PART = /\.(xml|rels|hpf|vml)$|^mimetype$|^META-INF\/[^/]+$/i

/** Is this part kept (text) or emptied (everything else)? */
export const isTextPart = (name: string) => TEXT_PART.test(name)

/** a declared total this large is fine here: only the kept parts are ever inflated, by readers with their own caps */
const SLIM_TOTAL_MAX = Number.MAX_SAFE_INTEGER

export interface Slim {
  bytes: Uint8Array
  /** parts emptied, and their bytes in the original (compressed) */
  dropped: number
  droppedBytes: number
}

const decodeName = (b: Uint8Array) => new TextDecoder('utf-8').decode(b)

/**
 * The zip with every part that is not text emptied, or null when there is nothing to drop (the original is used as it
 * is) or the zip cannot be read here: damaged, zip64, encrypted, or parts that share or overlap their bytes (the reader
 * then gives its own error on the original). `keep`: also keep a part
 * that is not text (the caller's own rule), by its name. `minDropped`: null as well when the emptied parts come to no
 * more than this many bytes.
 */
export function slimZip(bytes: Uint8Array, keep: (name: string) => boolean = () => false, o: { minDropped?: number } = {}): Slim | null {
  let entries: ZipEntry[]
  try { entries = readCentral(bytes, { total: SLIM_TOTAL_MAX, entries: ZIP_ENTRIES_MAX }) } catch (e) {
    if (e instanceof ZipProblem) return null
    throw e
  }
  const kept: { e: ZipEntry; data: Uint8Array | null }[] = []
  let dropped = 0, droppedBytes = 0, keptBytes = 0
  // every part's place in the file, [local header, end of its data): parts that share or overlap a place (central
  // entries that point at one local header, an overlap bomb) would make the copy many times the file
  const spans: [number, number][] = []
  try {
    for (const e of entries) {
      const name = decodeName(e.nameBytes)
      const data = entryData(bytes, e)
      spans.push([e.local, data.byteOffset - bytes.byteOffset + data.length])
      if (isTextPart(name) || keep(name) || e.csize === 0) { kept.push({ e, data }); keptBytes += data.length }
      else { kept.push({ e, data: null }); dropped++; droppedBytes += e.csize }
    }
  } catch (e) {
    if (e instanceof ZipProblem) return null
    throw e
  }
  spans.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < spans.length; i++) if (spans[i]![0] < spans[i - 1]![1]) return null
  if (keptBytes > bytes.length) return null
  // `minDropped`: not worth a copy unless the emptied parts are more than this (checked before the copy is made)
  if (!dropped || droppedBytes <= (o.minDropped ?? 0)) return null
  // local headers and data, then the central directory, then its end
  let size = 22
  for (const { e, data } of kept) size += 30 + e.nameBytes.length + (data?.length ?? 0) + 46 + e.nameBytes.length
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  const offsets: number[] = []
  let p = 0
  for (const { e, data } of kept) {
    offsets.push(p)
    const method = data ? e.method : 0
    v.setUint32(p, 0x04034b50, true)
    v.setUint16(p + 4, 20, true)
    // only the UTF-8 name flag stays: sizes are in the header now (no data descriptor), nothing is encrypted
    v.setUint16(p + 6, e.flags & 0x0800, true)
    v.setUint16(p + 8, method, true)
    v.setUint32(p + 14, data ? e.crc : 0, true)
    v.setUint32(p + 18, data ? e.csize : 0, true)
    v.setUint32(p + 22, data ? e.usize : 0, true)
    v.setUint16(p + 26, e.nameBytes.length, true)
    out.set(e.nameBytes, p + 30)
    p += 30 + e.nameBytes.length
    if (data) { out.set(data, p); p += data.length }
  }
  const cd = p
  kept.forEach(({ e, data }, i) => {
    v.setUint32(p, 0x02014b50, true)
    v.setUint16(p + 4, 20, true)
    v.setUint16(p + 6, 20, true)
    v.setUint16(p + 8, e.flags & 0x0800, true)
    v.setUint16(p + 10, data ? e.method : 0, true)
    v.setUint32(p + 16, data ? e.crc : 0, true)
    v.setUint32(p + 20, data ? e.csize : 0, true)
    v.setUint32(p + 24, data ? e.usize : 0, true)
    v.setUint16(p + 28, e.nameBytes.length, true)
    v.setUint32(p + 42, offsets[i]!, true)
    out.set(e.nameBytes, p + 46)
    p += 46 + e.nameBytes.length
  })
  v.setUint32(p, 0x06054b50, true)
  v.setUint16(p + 8, kept.length, true)
  v.setUint16(p + 10, kept.length, true)
  v.setUint32(p + 12, p - cd, true)
  v.setUint32(p + 16, cd, true)
  return { bytes: out, dropped, droppedBytes }
}
