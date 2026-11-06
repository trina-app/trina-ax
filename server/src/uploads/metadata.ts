// Cutting metadata out of pictures, without an image library: the picture data is kept byte for byte, the blocks that
// describe it (camera EXIF with the place a picture was taken, XMP, comments, text chunks, other cameras' extras) go.
// Two users (docs/DECISIONS.md): a profile photo (auth/avatar.ts, the strictest: colour profiles go too, animation is
// refused) and a photo sent in a team chat room (rooms/files.ts: like a messenger, its colour profile and animation
// stay, and its EXIF orientation is written back as the only tag so a phone's portrait photo still stands upright).
// Every format is read with keep-lists (what draws the picture stays, anything else goes, a kind added later included),
// and a file this cannot read exactly is refused (null), never passed on with its metadata. HEIC is cleaned in place
// (its items and boxes are blanked, the layout stays). Every parser is linear in the file's size, and HEIC's item tables
// have a step budget: a crafted 50 MB upload costs about 100 ms at most (tests/unit/room-photo-metadata.test.ts).

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const le32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0
const tag = (b: Uint8Array, i: number) => String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!)
const join = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))
const startsWith = (b: Uint8Array, at: number, s: string) => s.length <= b.length - at && [...s].every((c, k) => b[at + k] === c.charCodeAt(0))

export interface CleanOptions {
  /** keep the colour profile (JPEG APP2 ICC_PROFILE, PNG iCCP, WebP ICCP): a photo's colours, not who took it */
  colour: boolean
  /** keep an animation (PNG acTL/fcTL/fdAT, WebP ANIM/ANMF); false: refuse it ('animated') */
  animation: boolean
  /** write the picture's EXIF orientation back as the only tag (when it is not 1, "as stored") */
  orientation: boolean
}
/** a profile photo: everything but the picture goes, no animation */
export const STRICT: CleanOptions = { colour: false, animation: false, orientation: false }
/** a photo sent in a room: the picture, its colours, its animation and which way up it is */
export const PHOTO: CleanOptions = { colour: true, animation: true, orientation: true }

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'heic'
/** The container by its first bytes (null: none of these). */
export function imageFormat(b: Uint8Array): ImageFormat | null {
  if (b.length >= 8 && b[0] === 0x89 && startsWith(b, 1, 'PNG')) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 12 && startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) return 'webp'
  if (b.length >= 12 && startsWith(b, 4, 'ftyp') && /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(tag(b, 8))) return 'heic'
  return null
}

// ---------------- EXIF orientation ----------------
/** The Orientation tag (1–8) of a TIFF block (EXIF), or null. */
function tiffOrientation(t: Uint8Array): number | null {
  if (t.length < 8) return null
  const le = t[0] === 0x49 && t[1] === 0x49
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null
  const u16 = (i: number) => (le ? t[i]! | (t[i + 1]! << 8) : be16(t, i))
  const u32 = (i: number) => (le ? le32(t, i) : be32(t, i))
  if (u16(2) !== 42) return null
  const ifd = u32(4)
  if (ifd + 2 > t.length) return null
  const n = u16(ifd)
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12
    if (e + 12 > t.length) return null
    if (u16(e) === 0x0112 && u16(e + 2) === 3) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : null }
  }
  return null
}
/** "Exif\0\0" in front of a TIFF block (JPEG always, WebP sometimes): skipped */
const tiffOf = (b: Uint8Array) => (startsWith(b, 0, 'Exif\0\0') ? b.subarray(6) : b)

/** A JPEG's / PNG's / WebP's EXIF orientation: 1 (as stored) when it has none. 5–8 turn the picture a quarter. */
export function exifOrientation(b: Uint8Array): number {
  const f = imageFormat(b)
  try {
    if (f === 'jpeg') {
      let i = 2
      while (i + 4 <= b.length && b[i] === 0xff) {
        const m = b[i + 1]!
        if (m === 0xda || m === 0xd9) break
        const len = be16(b, i + 2)
        if (m === 0xe1 && startsWith(b, i + 4, 'Exif\0\0')) return tiffOrientation(b.subarray(i + 10, i + 2 + len)) ?? 1
        i += 2 + len
      }
    } else if (f === 'png') {
      for (let i = 8; i + 12 <= b.length;) {
        const len = be32(b, i), name = tag(b, i + 4)
        if (name === 'eXIf') return tiffOrientation(tiffOf(b.subarray(i + 8, i + 8 + len))) ?? 1
        if (name === 'IDAT' || name === 'IEND') break
        i += 12 + len
      }
    } else if (f === 'webp') {
      for (let i = 12; i + 8 <= b.length;) {
        const len = le32(b, i + 4)
        if (tag(b, i) === 'EXIF') return tiffOrientation(tiffOf(b.subarray(i + 8, i + 8 + len))) ?? 1
        i += 8 + len + (len & 1)
      }
    }
  } catch { /* unreadable: as stored */ }
  return 1
}

/** A TIFF block with the Orientation tag only (big-endian, one IFD entry). */
function orientationTiff(o: number): Uint8Array {
  const t = new Uint8Array(26)
  t.set(ascii('MM')); t.set([0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0], 2)
  return t
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(name: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer)
  v.setUint32(0, data.length); out.set(ascii(name), 4); out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

// ---------------- the containers ----------------
/** PNG: keep only the chunks that draw the picture (its transparency, gamma and colour; with `colour` its colour
 * profile; with `animation` its frames); drop text, EXIF, time and anything else. */
const PNG_PICTURE = ['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT']
function cleanPng(b: Uint8Array, o: CleanOptions): Uint8Array | 'animated' | null {
  const keep = new Set([...PNG_PICTURE, ...(o.colour ? ['iCCP', 'cICP', 'mDCV', 'cLLI'] : []), ...(o.animation ? ['acTL', 'fcTL', 'fdAT'] : [])])
  const turn = o.orientation ? exifOrientation(b) : 1
  const out: Uint8Array[] = [b.subarray(0, 8)]
  let i = 8
  let seenEnd = false
  while (i + 12 <= b.length) {
    const len = be32(b, i)
    const end = i + 12 + len
    if (end > b.length) return null
    const name = tag(b, i + 4)
    if (name === 'acTL' && !o.animation) return 'animated'
    if (keep.has(name)) out.push(b.subarray(i, end))
    if (name === 'IHDR' && turn !== 1) out.push(pngChunk('eXIf', orientationTiff(turn)))
    i = end
    if (name === 'IEND') { seenEnd = true; break }
  }
  return seenEnd ? join(out) : null
}

/** Where a JPEG scan (entropy-coded data) that starts at `from` ends: the first 0xff that is not a stuffed 0xff00, a
 * restart marker or a fill byte; -1 when there is none. Linear: the native search skips the stretches without 0xff,
 * and a scan dense with stuffed bytes (a real one has about one in 256; a crafted one every other byte) goes on with a
 * plain loop, which reads each byte once (about 3 ms per MB). */
function scanEnd(b: Uint8Array, from: number): number {
  let j = from, hits = 0
  const end = (n: number) => n !== 0x00 && n !== 0xff && !(n >= 0xd0 && n <= 0xd7)
  while (hits < 4096) {
    j = b.indexOf(0xff, j)
    if (j < 0 || j + 1 >= b.length) return -1
    if (end(b[j + 1]!)) return j
    j++
    hits++
  }
  for (; j + 1 < b.length; j++) if (b[j] === 0xff && end(b[j + 1]!)) return j
  return -1
}

/** The JPEG segments that draw the picture (a keep-list: anything else, a later or unknown kind included, goes): the
 * frame, Huffman, arithmetic-coding, quantisation and restart tables, the scans, DNL, DHP and EXP; APP0 only as JFIF
 * (not JFXX, which holds a thumbnail), APP14 only as Adobe (its colour transform), APP2 only as an ICC profile and only
 * with `colour`. Every other APPn (EXIF and XMP in APP1, Photoshop's IPTC in APP13, a camera's own), the JPGn
 * extensions (0xF0–0xFD) and comments go. */
function jpegPicture(b: Uint8Array, i: number, m: number, o: CleanOptions): boolean {
  if (m >= 0xc0 && m <= 0xcf) return m !== 0xc8 // SOFn, DHT, DAC; not the reserved JPG
  if (m === 0xdb || m === 0xdd || m === 0xda || m === 0xdc || m === 0xde || m === 0xdf) return true
  if (m === 0xe0) return startsWith(b, i + 4, 'JFIF\0')
  if (m === 0xee) return startsWith(b, i + 4, 'Adobe')
  if (m === 0xe2) return o.colour && startsWith(b, i + 4, 'ICC_PROFILE\0')
  return false
}

/** Does a kept table segment (the marker at `i`, its length `len`) hold exactly what its kind holds? A frame header,
 * a scan header, Huffman and quantisation tables have fixed layouts; anything else under their markers (a segment
 * whose marker was changed, metadata dressed as a table) does not fit, and the file is not read. */
function jpegTableFits(b: Uint8Array, i: number, m: number, len: number): boolean {
  const end = i + 2 + len
  if ((m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) || m === 0xde) return len >= 8 && len === 8 + 3 * b[i + 9]! // SOFn, DHP
  if (m === 0xda) return len >= 6 && len === 6 + 2 * b[i + 4]! // SOS
  if (m === 0xdd || m === 0xdc) return len === 4 // DRI, DNL
  if (m === 0xdf) return len === 3 // EXP
  if (m === 0xcc) return len % 2 === 0 // DAC: two bytes per table
  if (m === 0xdb) { // DQT: tables of 1 + 64 or 1 + 128 bytes
    let k = i + 4
    while (k < end) k += 1 + (b[k]! >> 4 ? 128 : 64)
    return k === end
  }
  if (m === 0xc4) { // DHT: class and id, 16 counts, then that many symbols
    let k = i + 4
    while (k < end) {
      if (k + 17 > end) return false
      let n = 0
      for (let c = 1; c <= 16; c++) n += b[k + c]!
      k += 17 + n
    }
    return k === end
  }
  return true
}

/** JPEG: keep the segments that draw the picture (jpegPicture); with `orientation` a one-tag EXIF goes back in front.
 * Nothing after the end-of-image marker is kept (bytes appended to a JPEG, like a second picture with its own EXIF,
 * are not this one). */
function cleanJpeg(b: Uint8Array, o: CleanOptions): Uint8Array | null {
  const turn = o.orientation ? exifOrientation(b) : 1
  const out: Uint8Array[] = [b.subarray(0, 2)]
  if (turn !== 1) {
    const tiff = orientationTiff(turn), app1 = new Uint8Array(4 + 6 + tiff.length)
    app1.set([0xff, 0xe1, (app1.length - 2) >> 8, (app1.length - 2) & 0xff]); app1.set(ascii('Exif\0\0'), 4); app1.set(tiff, 10)
    out.push(app1)
  }
  let i = 2
  // a marker is two bytes (the end-of-image marker can be the file's last two bytes); a segment adds a 2-byte length
  while (i + 2 <= b.length) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]!
    if (m === 0xff) { i++; continue } // fill byte
    if (m === 0xd9) { out.push(b.subarray(i, i + 2)); return join(out) }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(b.subarray(i, i + 2)); i += 2; continue }
    if (i + 4 > b.length) return null
    const len = (b[i + 2]! << 8) | b[i + 3]!
    if (len < 2 || i + 2 + len > b.length) return null
    if (jpegPicture(b, i, m, o)) {
      if (!jpegTableFits(b, i, m, len)) return null
      out.push(b.subarray(i, i + 2 + len))
    }
    i += 2 + len
    if (m === 0xda) {
      // the picture data runs to the next marker: a 0xff that is not a stuffed 0xff00, a restart marker or a fill byte.
      // That marker is the end of the image (kept, and the rest dropped) or the next table or scan of a progressive file
      const j = scanEnd(b, i)
      if (j < 0) return null // no end-of-image marker
      out.push(b.subarray(i, j))
      i = j
    }
  }
  return null
}

/** An animated WebP's frame (ANMF chunk) with only its picture chunks (ALPH, VP8, VP8L); null when it does not parse. */
function webpFrame(c: Uint8Array): Uint8Array | null {
  const len = le32(c, 4)
  if (len < 16 || 8 + len > c.length) return null
  const parts: Uint8Array[] = [c.subarray(8, 24)]
  for (let i = 24; i < 8 + len;) {
    if (i + 8 > 8 + len) return null
    const n = le32(c, i + 4)
    if (i + 8 + n > 8 + len) return null
    const name = tag(c, i)
    if (name === 'ALPH' || name === 'VP8 ' || name === 'VP8L') parts.push(c.subarray(i, i + 8 + n), new Uint8Array(n & 1))
    i += 8 + n + (n & 1)
  }
  const body = join(parts)
  const out = new Uint8Array(8 + body.length)
  out.set(ascii('ANMF')); new DataView(out.buffer).setUint32(4, body.length, true); out.set(body, 8)
  return out
}

/** WebP: keep the picture chunks (with `colour` the colour profile, with `animation` the frames); drop EXIF, XMP and
 * anything else, and their flags; with `orientation` a one-tag EXIF chunk goes back at the end. */
function cleanWebp(b: Uint8Array, o: CleanOptions): Uint8Array | 'animated' | null {
  if (b.length < 20 || le32(b, 4) + 8 > b.length) return null
  const turn = o.orientation ? exifOrientation(b) : 1
  const body = b.subarray(12, 8 + le32(b, 4))
  const keep = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', ...(o.colour ? ['ICCP'] : []), ...(o.animation ? ['ANIM', 'ANMF'] : [])])
  const chunks: Uint8Array[] = []
  let extended = false
  let i = 0
  while (i + 8 <= body.length) {
    const len = le32(body, i + 4)
    if (i + 8 + len > body.length) return null
    const name = tag(body, i)
    const chunk = new Uint8Array(body.subarray(i, i + 8 + len)) // a copy: VP8X flags are changed below
    if ((name === 'ANIM' || name === 'ANMF') && !o.animation) return 'animated'
    if (name === 'VP8X') {
      if (len < 10) return null
      if (chunk[8]! & 0x02 && !o.animation) return 'animated'
      // no XMP (0x04); EXIF (0x08) only for the orientation written back; the colour profile (0x20) as kept
      chunk[8] = (chunk[8]! & ~(0x04 | 0x08 | (o.colour ? 0 : 0x20))) | (turn !== 1 ? 0x08 : 0)
      extended = true
    }
    if (name === 'ANMF' && keep.has(name)) {
      // a frame: its 16-byte header, then its own chunks; only the picture ones stay (EXIF or XMP inside a frame go)
      const frame = webpFrame(chunk)
      if (!frame) return null
      chunks.push(frame, new Uint8Array(frame.length & 1))
    } else if (keep.has(name)) chunks.push(chunk, new Uint8Array(len & 1))
    i += 8 + len + (len & 1)
  }
  // an EXIF chunk needs the extended header (one that had an orientation had it)
  if (turn !== 1 && extended) {
    const tiff = orientationTiff(turn), c = new Uint8Array(8 + tiff.length)
    c.set(ascii('EXIF')); new DataView(c.buffer).setUint32(4, tiff.length, true); c.set(tiff, 8)
    chunks.push(c)
  }
  const payload = join(chunks)
  const head = new Uint8Array(12)
  head.set(ascii('RIFF')); head.set(ascii('WEBP'), 8)
  new DataView(head.buffer).setUint32(4, 4 + payload.length, true)
  return join([head, payload])
}

/** HEIC parsing limits: more items or extents than a camera writes are refused, and so is a file whose item tables
 * take more steps than this to read (each item and each extent is one step). A refused photo is not sent. */
export const HEIC_MAX_ITEMS = 10_000
export const HEIC_MAX_EXTENTS = 1_000
export const HEIC_MAX_STEPS = 20_000
/** HEIF item types that draw the picture (coded images, tiles, grids, overlays, derived and tone-mapped images, masks) */
const HEIC_PICTURE_ITEMS = new Set(['hvc1', 'hvt1', 'av01', 'avc1', 'jpeg', 'j2k1', 'vvc1', 'unci', 'grid', 'iden', 'iovl', 'tmap', 'mski'])

/** HEIC / HEIF (ISO base media), with keep-lists like the other formats, in place (every offset in the file stays
 * right): the items that draw the picture stay; the bytes of the EXIF item become an empty EXIF block and those of
 * every other item (XMP, any other) spaces; bytes of 'mdat' that no picture item uses become zeros, and so do the
 * payloads of boxes that are not part of the picture (at the top: anything but ftyp, meta and mdat; in meta: anything
 * but its item tables and properties, an XML metadata box included). Its orientation is not EXIF but the picture's own
 * 'irot' / 'imir' property, which stays. Anything this does not read exactly (a box that does not fit, an item table
 * it cannot follow, an item it cannot place) is null: refused, never sent with its metadata. Each step reads bytes or
 * counts against HEIC_MAX_STEPS, so a crafted file costs no more than a few milliseconds. */
function cleanHeic(src: Uint8Array): Uint8Array | null {
  const b = new Uint8Array(src)
  let steps = 0
  const step = () => ++steps <= HEIC_MAX_STEPS
  const boxes = (from: number, to: number) => {
    const out: { type: string; start: number; body: number; end: number }[] = []
    for (let i = from; i < to;) {
      if (i + 8 > to || !step()) return null
      let size = be32(b, i), head = 8
      if (size === 1) { if (i + 16 > to) return null; size = be32(b, i + 8) * 2 ** 32 + be32(b, i + 12); head = 16 } else if (size === 0) size = to - i
      if (size < head || i + size > to) return null
      out.push({ type: tag(b, i + 4), start: i, body: i + head, end: i + size })
      i += size
    }
    return out
  }
  const top = boxes(0, b.length)
  const metas = top?.filter((x) => x.type === 'meta') ?? []
  if (!top || metas.length !== 1) return null
  const meta = metas[0]!
  if (meta.body + 4 > meta.end) return null
  const inner = boxes(meta.body + 4, meta.end) // meta is a full box: version and flags first
  if (!inner) return null
  const one = (type: string) => { const l = inner.filter((x) => x.type === type); return l.length > 1 ? undefined : l[0] ?? null }
  const iinf = one('iinf'), iloc = one('iloc'), idat = one('idat')
  if (!iinf || !iloc || idat === undefined) return null
  // which items draw the picture; the others are blanked
  const blank = new Map<number, 'exif' | 'other'>()
  if (iinf.body + 4 > iinf.end) return null
  const iv = b[iinf.body]!
  const entries = boxes(iinf.body + 4 + (iv === 0 ? 2 : 4), iinf.end)
  if (!entries || entries.length > HEIC_MAX_ITEMS) return null
  for (const e of entries) {
    if (e.type !== 'infe') return null
    if (e.body + 4 > e.end) return null
    const v = b[e.body]!
    if (v < 2) return null // an item without its type: it may be EXIF
    let q = e.body + 4
    const id = v === 2 ? be16(b, q) : be32(b, q)
    q += (v === 2 ? 2 : 4) + 2
    if (q + 4 > e.end) return null
    const type = tag(b, q)
    if (type === 'Exif') blank.set(id, 'exif')
    else if (!HEIC_PICTURE_ITEMS.has(type)) blank.set(id, 'other')
  }
  // where every item is: sizes 0, 4 or 8 only (ISO/IEC 14496-12), every read inside the box
  const lv = b[iloc.body]!
  if (lv > 2) return null
  let p = iloc.body + 4
  if (p + 2 > iloc.end) return null
  const offSize = b[p]! >> 4, lenSize = b[p]! & 15, baseSize = b[p + 1]! >> 4, idxSize = lv === 1 || lv === 2 ? b[p + 1]! & 15 : 0
  if (![offSize, lenSize, baseSize, idxSize].every((n) => n === 0 || n === 4 || n === 8)) return null
  p += 2
  const num = (n: number) => {
    if (p + n > iloc.end) throw new RangeError('iloc')
    let v = 0
    for (let k = 0; k < n; k++) v = v * 256 + b[p + k]!
    p += n
    return v
  }
  const found = new Set<number>()
  const picture: [number, number][] = [] // file ranges the picture items use
  const cut: { at: number; len: number; what: 'exif' | 'other'; first: boolean }[] = []
  try {
    const count = lv < 2 ? num(2) : num(4)
    if (count > HEIC_MAX_ITEMS) return null
    for (let k = 0; k < count; k++) {
      if (!step()) return null
      const id = lv < 2 ? num(2) : num(4)
      const method = lv === 1 || lv === 2 ? num(2) & 15 : 0
      num(2) // data_reference_index
      const base = num(baseSize)
      const extents = num(2)
      if (extents > HEIC_MAX_EXTENTS) return null
      const what = blank.get(id)
      if (what) found.add(id)
      if (method > 1 || (method === 1 && !idat)) return null
      for (let x = 0; x < extents; x++) {
        if (!step()) return null
        if (idxSize) num(idxSize)
        const off = num(offSize), len = num(lenSize)
        const at = method === 0 ? base + off : idat!.body + base + off
        // a length of 0 means "to the end": not read here
        if (!len || at + len > (method === 0 ? b.length : idat!.end)) return null
        if (what) cut.push({ at, len, what, first: x === 0 })
        else if (method === 0) picture.push([at, at + len])
      }
    }
  } catch { return null }
  if (![...blank.keys()].every((id) => found.has(id))) return null
  // boxes that are not part of the picture lose their payload; mdat keeps only what the picture items use
  const KEEP_META = new Set(['hdlr', 'pitm', 'iloc', 'iinf', 'iref', 'iprp', 'idat', 'dinf', 'grpl'])
  for (const x of inner) if (!KEEP_META.has(x.type)) b.fill(0, x.body, x.end)
  picture.sort((a, c) => a[0] - c[0])
  for (const x of top) {
    if (x.type === 'ftyp' || x.type === 'meta') continue
    if (x.type !== 'mdat') { b.fill(0, x.body, x.end); continue }
    let at = x.body
    for (const [from, to] of picture) {
      if (to <= at || from >= x.end) continue
      if (from > at) b.fill(0, at, from)
      at = Math.max(at, to)
    }
    if (at < x.end) b.fill(0, at, x.end)
  }
  // EXIF: an empty TIFF block (its 4-byte header offset, then "MM", 42, an IFD with no entries); any other item: spaces
  // (an XMP packet reads as an empty one)
  for (const c of cut) {
    b.fill(c.what === 'other' ? 0x20 : 0, c.at, c.at + c.len)
    if (c.what === 'exif' && c.first && c.len >= 18) b.set([0, 0, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0], c.at)
  }
  return b
}

/** The picture without its metadata (see the top of this file), 'animated' when `o` refuses an animation, null when
 * the container cannot be read (or is not one of these). */
export function cleanImage(b: Uint8Array, o: CleanOptions): Uint8Array | 'animated' | null {
  try {
    switch (imageFormat(b)) {
      case 'png': return cleanPng(b, o)
      case 'jpeg': return cleanJpeg(b, o)
      case 'webp': return cleanWebp(b, o)
      case 'heic': return cleanHeic(b)
      default: return null
    }
  } catch { return null }
}
