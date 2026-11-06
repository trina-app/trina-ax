// Photos sent in a team chat room (uploads/metadata.ts PHOTO, rooms/files.ts): the place they were taken and the other
// camera metadata are cut out, the orientation stays (written back as the only EXIF tag), and the size the room shows
// them at is the upright one (uploads/image.ts displaySize). Fixtures in tests/fixtures/exif were made with Pillow:
// 64x48 pictures stored landscape with a red top-left quarter, EXIF orientation 1 / 3 / 6 / 8, a camera make and
// model, GPS (Seoul), an XMP packet with GPS and a JPEG comment; a PNG with text chunks and eXIf; a WebP with EXIF and
// XMP.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { cleanImage, exifOrientation, imageFormat, JPEG_STRAY_MAX, PHOTO, STRICT } from '../../server/src/uploads/metadata'
import { displaySize, imageSize } from '../../server/src/uploads/image'

const dir = path.join(import.meta.dir, '../fixtures/exif')
const read = (n: string) => new Uint8Array(fs.readFileSync(path.join(dir, n)))
const text = (b: Uint8Array) => Buffer.from(b).toString('latin1')
/** what identifies the photo or where it was taken, as the fixtures hold it */
const LEAKS = ['FixtureCam', 'Fixture Phone', 'FixtureSoft', 'FIXTURE-COMMENT', 'FIXTURE-PNG-TEXT', 'xmpmeta', 'GPSLatitude']
const leaks = (b: Uint8Array) => LEAKS.filter((s) => text(b).includes(s))
/** the GPS IFD pointer tag (0x8825) in either byte order */
const gpsTag = (b: Uint8Array) => text(b).includes('\x88\x25') || text(b).includes('\x25\x88')

describe('the size a room shows a photo at', () => {
  test('orientations 5–8 swap width and height; 1 and 3 do not', () => {
    for (const [o, size] of [[1, { width: 64, height: 48 }], [3, { width: 64, height: 48 }], [6, { width: 48, height: 64 }], [8, { width: 48, height: 64 }]] as const) {
      const b = read(`portrait-o${o}.jpg`)
      expect({ o, stored: imageSize(b), orientation: exifOrientation(b), shown: displaySize(b) }).toEqual({ o, stored: { width: 64, height: 48 }, orientation: o, shown: size })
    }
    expect(displaySize(read('photo-text.png'))).toEqual({ width: 48, height: 64 })
    expect(displaySize(read('photo-meta.webp'))).toEqual({ width: 48, height: 64 })
  })
})

describe('a room photo without its metadata', () => {
  test('JPEG: GPS, camera, XMP and comment go; the orientation stays as the only tag; the picture is the same', () => {
    for (const o of [1, 3, 6, 8]) {
      const b = read(`portrait-o${o}.jpg`)
      expect(leaks(b).length).toBeGreaterThan(0)
      expect(gpsTag(b)).toBe(true)
      const c = cleanImage(b, PHOTO) as Uint8Array
      expect(c).toBeInstanceOf(Uint8Array)
      expect({ o, leaks: leaks(c), gps: gpsTag(c) }).toEqual({ o, leaks: [], gps: false })
      expect({ o, orientation: exifOrientation(c), size: imageSize(c), shown: displaySize(c) }).toEqual({ o, orientation: o, size: imageSize(b), shown: displaySize(b) })
      // one EXIF block at most (the orientation), none for "as stored"
      expect(text(c).split('Exif\0\0').length - 1).toBe(o === 1 ? 0 : 1)
      // the scan is kept byte for byte: from the first start-of-scan to the end
      const scan = (x: Uint8Array) => text(x).slice(text(x).indexOf('\xff\xda'))
      expect(scan(c)).toBe(scan(b))
    }
  })

  test('PNG: text chunks and EXIF go, the orientation stays; WebP: EXIF and XMP go, the orientation stays', () => {
    for (const n of ['photo-text.png', 'photo-meta.webp']) {
      const b = read(n)
      expect(leaks(b).length).toBeGreaterThan(0)
      const c = cleanImage(b, PHOTO) as Uint8Array
      expect({ n, leaks: leaks(c), gps: gpsTag(c), orientation: exifOrientation(c), size: imageSize(c) }).toEqual({ n, leaks: [], gps: false, orientation: 6, size: { width: 64, height: 48 } })
      expect(imageFormat(c)).toBe(imageFormat(b))
    }
    const png = text(cleanImage(read('photo-text.png'), PHOTO) as Uint8Array)
    for (const chunk of ['tEXt', 'iTXt', 'zTXt']) expect(png).not.toContain(chunk)
  })

  test('a profile photo (STRICT) keeps no orientation tag and no colour profile, as before', () => {
    const c = cleanImage(read('portrait-o6.jpg'), STRICT) as Uint8Array
    expect(leaks(c)).toEqual([])
    expect(exifOrientation(c)).toBe(1)
  })

  test('HEIC: the EXIF and XMP items are blanked in place; the layout and the picture stay', () => {
    const b = heic()
    expect(imageFormat(b)).toBe('heic')
    expect(leaks(b)).toEqual(['FixtureCam', 'xmpmeta', 'GPSLatitude'])
    const c = cleanImage(b, PHOTO) as Uint8Array
    expect(c.length).toBe(b.length)
    expect(leaks(c)).toEqual([])
    expect(text(c)).toContain('PICTURE-BYTES')
  })

  test('a file that only says it is a JPEG is not one: it cannot be cleaned', () => {
    expect(cleanImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1]), PHOTO)).toBeNull()
  })
})

// ---------------- the review of bf51a728: crafted files ----------------
const u8 = (...x: number[]) => Buffer.from(x)
const be16b = (n: number) => u8(n >> 8, n & 255)
const be32b = (n: number) => u8(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255)
const lat = (s: string) => Buffer.from(s, 'latin1')
const isoBox = (type: string, ...body: Buffer[]) => { const b = Buffer.concat(body); return Buffer.concat([be32b(8 + b.length), lat(type), b]) }
const GPS_TEXT = 'GPSLatitude=37.5665;GPSLongitude=126.978'
const hasGps = (b: Uint8Array | null | string) => b instanceof Uint8Array && text(b).includes('GPSLatitude')

describe('crafted HEIC files', () => {
  /** an iloc whose items list many extents of zero-byte fields (the reviewer's probe): only the box size bounded it */
  const ilocBomb = (items: number, extents: number, sizes = 0x00) => {
    const infe = isoBox('infe', u8(2, 0, 0, 0), be16b(1), be16b(0), lat('Exif'), u8(0))
    const iinf = isoBox('iinf', u8(0, 0, 0, 0), be16b(1), infe)
    const loc: Buffer[] = [u8(0, 0, 0, 0, sizes, 0x00), be16b(items)]
    for (let k = 0; k < items; k++) loc.push(be16b(2), be16b(0), be16b(extents))
    return new Uint8Array(Buffer.concat([isoBox('ftyp', lat('heic'), be32b(0)), isoBox('meta', u8(0, 0, 0, 0), iinf, isoBox('iloc', ...loc))]))
  }

  test('an item table built to take forever is refused at once (a 400 KB one well under 100 ms)', () => {
    for (const [items, extents, sizes] of [[66_000, 65_535, 0x00], [10_000, 1_000, 0x00], [9_999, 5, 0x00], [2_000, 65_535, 0x00], [100, 10, 0x33]] as const) {
      const f = ilocBomb(items, extents, sizes)
      const t = performance.now()
      const r = cleanImage(f, PHOTO)
      const ms = performance.now() - t
      expect({ items, extents, kb: Math.round(f.length / 1024) > 0, refused: r === null, fast: ms < 100 }).toEqual({ items, extents, kb: true, refused: true, fast: true })
    }
    expect(ilocBomb(66_000, 65_535).length).toBeGreaterThan(390_000)
  })

  test('a box this cannot read anywhere (in iinf, in meta, at the top) refuses the file instead of keeping its EXIF', () => {
    const exif = Buffer.concat([be32b(0), lat('MM\0*'), lat(GPS_TEXT)])
    const build = (where: 'none' | 'iinf' | 'meta' | 'top' | 'v1') => {
      const infe = where === 'v1' ? isoBox('infe', u8(1, 0, 0, 0), be16b(1), be16b(0), lat('exif\0'), lat('\0')) : isoBox('infe', u8(2, 0, 0, 0), be16b(1), be16b(0), lat('Exif'), u8(0))
      const junk = Buffer.concat([be32b(0xffff), lat('free')])
      const iinf = isoBox('iinf', u8(0, 0, 0, 0), be16b(1), infe, where === 'iinf' ? junk : Buffer.alloc(0))
      const ftyp = isoBox('ftyp', lat('heic'), be32b(0))
      const meta = (off: number) => isoBox('meta', u8(0, 0, 0, 0), iinf, isoBox('iloc', u8(0, 0, 0, 0, 0x44, 0x00), be16b(1), be16b(1), be16b(0), be16b(1), be32b(off), be32b(exif.length)), where === 'meta' ? junk : Buffer.alloc(0))
      const off = ftyp.length + meta(0).length + 8
      return new Uint8Array(Buffer.concat([ftyp, meta(off), isoBox('mdat', exif), where === 'top' ? junk : Buffer.alloc(0)]))
    }
    const ok = cleanImage(build('none'), PHOTO)
    expect(ok instanceof Uint8Array && !hasGps(ok)).toBe(true)
    for (const where of ['iinf', 'meta', 'top', 'v1'] as const) {
      const f = build(where)
      expect(hasGps(f)).toBe(true)
      expect({ where, result: cleanImage(f, PHOTO) }).toEqual({ where, result: null })
    }
  })
})

describe('crafted JPEG segments', () => {
  const jpg = read('portrait-o6.jpg')
  const seg = (m: number, id: string) => { const body = lat(id + GPS_TEXT); return Buffer.concat([u8(0xff, m), be16b(body.length + 2), body]) }
  const withSeg = (s: Buffer) => new Uint8Array(Buffer.concat([jpg.subarray(0, 2), s, jpg.subarray(2)]))

  test('GPS in an APP0 that is not JFIF, a JFXX, an APP14 that is not Adobe, JPGn, APP13 or a comment: dropped', () => {
    for (const [name, m, id] of [
      ['APP0 other', 0xe0, 'Exif\0\0'], ['APP0 JFXX', 0xe0, 'JFXX\0'], ['APP14 other', 0xee, 'Exif\0\0'], ['JPG0', 0xf0, 'Exif\0\0'],
      ['JPG13', 0xfd, 'Exif\0\0'], ['APP13', 0xed, 'Photoshop 3.0\0'], ['COM', 0xfe, ''], ['APP1', 0xe1, 'Exif\0\0'], ['APP2 not ICC', 0xe2, 'MPF\0'],
    ] as const) {
      const f = withSeg(seg(m, id))
      expect(hasGps(f)).toBe(true)
      const c = cleanImage(f, PHOTO)
      expect({ name, cleaned: c instanceof Uint8Array, gps: hasGps(c) }).toEqual({ name, cleaned: true, gps: false })
    }
  })

  test('stray bytes between two segments are skipped, as libjpeg does, and never kept; too many are refused', () => {
    // after the first segment behind SOI: a few junk bytes, then the rest of the file
    const firstEnd = 4 + ((jpg[4]! << 8) | jpg[5]!)
    const junk = lat('\x00\x12JUNK\x34')
    const f = new Uint8Array(Buffer.concat([jpg.subarray(0, firstEnd), junk, jpg.subarray(firstEnd)]))
    const c = cleanImage(f, PHOTO) as Uint8Array
    expect(c).toBeInstanceOf(Uint8Array)
    expect({ gps: hasGps(c), leaks: leaks(c), junk: text(c).includes('JUNK'), orientation: exifOrientation(c), size: imageSize(c) })
      .toEqual({ gps: false, leaks: [], junk: false, orientation: 6, size: { width: 64, height: 48 } })
    // the same as the file without them
    expect(Buffer.from(c).equals(Buffer.from(cleanImage(jpg, PHOTO) as Uint8Array))).toBe(true)
    // more than JPEG_STRAY_MAX bytes before the next marker: not a JPEG this reads
    const long = new Uint8Array(Buffer.concat([jpg.subarray(0, firstEnd), Buffer.alloc(JPEG_STRAY_MAX + 1, 0x20), jpg.subarray(firstEnd)]))
    expect(cleanImage(long, PHOTO)).toBeNull()
  })

  test('JFIF in APP0 and Adobe in APP14 stay (they draw the picture)', () => {
    for (const [m, id] of [[0xe0, 'JFIF\0'], [0xee, 'Adobe']] as const) {
      const s = seg(m, id)
      const c = cleanImage(withSeg(s), PHOTO) as Uint8Array
      expect(Buffer.from(c).includes(s)).toBe(true)
    }
  })
})

test('an animated WebP keeps its frames and loses EXIF or XMP put inside one', () => {
  const still = read('photo-meta.webp')
  // the fixture's picture chunk
  let at = 12, vp8: Buffer | null = null
  while (at + 8 <= still.length) { const len = Buffer.from(still).readUInt32LE(at + 4); if (text(still.subarray(at, at + 4)) === 'VP8 ') vp8 = Buffer.from(still.subarray(at, at + 8 + len + (len & 1))); at += 8 + len + (len & 1) }
  const le = (n: number, k: number) => { const b = Buffer.alloc(k); for (let i = 0; i < k; i++) b[i] = (n >> (8 * i)) & 255; return b }
  const chunk = (name: string, body: Buffer) => Buffer.concat([lat(name), le(body.length, 4), body, Buffer.alloc(body.length & 1)])
  const frame = chunk('ANMF', Buffer.concat([le(0, 3), le(0, 3), le(63, 3), le(47, 3), le(100, 3), u8(0), vp8!, chunk('EXIF', lat(`MM\0*${GPS_TEXT}`)), chunk('XMP ', lat(`<x:xmpmeta ${GPS_TEXT}/>`))]))
  const body = Buffer.concat([lat('WEBP'), chunk('VP8X', Buffer.concat([u8(0x02, 0, 0, 0), le(63, 3), le(47, 3)])), chunk('ANIM', Buffer.concat([le(0, 4), le(0, 2)])), frame, frame])
  const anim = new Uint8Array(Buffer.concat([lat('RIFF'), le(body.length, 4), body]))
  expect(hasGps(anim)).toBe(true)
  const c = cleanImage(anim, PHOTO) as Uint8Array
  expect(c).toBeInstanceOf(Uint8Array)
  expect(hasGps(c)).toBe(false)
  expect(text(c).split('ANMF').length - 1).toBe(2)
  expect(Buffer.from(c).includes(vp8!)).toBe(true)
  expect(cleanImage(anim, STRICT)).toBe('animated')
})

test('mutated files never throw and never take long (a quick fuzz; the review ran 18,000)', () => {
  let seed = 11
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const files = [...fs.readdirSync(dir).map((n) => read(n)), heic()]
  let worst = 0
  for (const f of files) {
    for (let k = 0; k < 300; k++) {
      const g = new Uint8Array(f)
      for (let x = 1 + Math.floor(rnd() * 6); x > 0; x--) g[Math.floor(rnd() * g.length)] = Math.floor(rnd() * 256)
      const cut = rnd() < 0.2 ? g.subarray(0, Math.floor(rnd() * g.length)) : g
      const t = performance.now()
      expect(() => { cleanImage(cut, PHOTO); cleanImage(cut, STRICT); exifOrientation(cut); displaySize(cut) }).not.toThrow()
      worst = Math.max(worst, performance.now() - t)
    }
  }
  expect(worst).toBeLessThan(50)
})

/** A small HEIF in the ISO base media layout: ftyp, a meta box (hdlr, iinf with an 'hvc1' picture, an 'Exif' item and an
 * XMP 'mime' item, iloc version 1 with their places in mdat) and mdat holding the three. */
function heic(): Uint8Array {
  const u8 = (...x: number[]) => Buffer.from(x)
  const u16 = (n: number) => u8(n >> 8, n & 255)
  const u32 = (n: number) => u8(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255)
  const str = (s: string) => Buffer.from(s, 'latin1')
  const box = (type: string, ...body: Buffer[]) => { const b = Buffer.concat(body); return Buffer.concat([u32(8 + b.length), str(type), b]) }
  const full = (type: string, version: number, ...body: Buffer[]) => box(type, u8(version, 0, 0, 0), ...body)
  const picture = str('PICTURE-BYTES')
  const exif = Buffer.concat([u32(0), str('MM\0\x2a\0\0\0\x08'), str('FixtureCam GPS 37.56N 126.97E')])
  const xmp = str('<x:xmpmeta GPSLatitude="37,33.99N"/>')
  const infe = (id: number, type: string, extra = '') => full('infe', 2, u16(id), u16(0), str(type), str('\0'), str(extra))
  const ftyp = box('ftyp', str('heic'), u32(0), str('mif1heic'))
  const build = (mdatStart: number) => {
    const at = [mdatStart + 8, mdatStart + 8 + picture.length, mdatStart + 8 + picture.length + exif.length]
    const loc = (id: number, off: number, len: number) => Buffer.concat([u16(id), u16(0), u16(0), u16(1), u32(off), u32(len)])
    const iloc = full('iloc', 1, u8(0x44, 0x00), u16(3), loc(1, at[0]!, picture.length), loc(2, at[1]!, exif.length), loc(3, at[2]!, xmp.length))
    const iinf = full('iinf', 0, u16(3), infe(1, 'hvc1'), infe(2, 'Exif'), infe(3, 'mime', 'application/rdf+xml\0'))
    return full('meta', 0, full('hdlr', 0, u32(0), str('pict'), u32(0), u32(0), u32(0), str('\0')), iinf, iloc)
  }
  const metaLen = build(0).length
  const meta = build(ftyp.length + metaLen)
  return new Uint8Array(Buffer.concat([ftyp, meta, box('mdat', picture, exif, xmp)]))
}
