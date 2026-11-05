// Photos sent in a team chat room (uploads/metadata.ts PHOTO, rooms/files.ts): the place they were taken and the other
// camera metadata are cut out, the orientation stays (written back as the only EXIF tag), and the size the room shows
// them at is the upright one (uploads/image.ts displaySize). Fixtures in tests/fixtures/exif were made with Pillow:
// 64x48 pictures stored landscape with a red top-left quarter, EXIF orientation 1 / 3 / 6 / 8, a camera make and
// model, GPS (Seoul), an XMP packet with GPS and a JPEG comment; a PNG with text chunks and eXIf; a WebP with EXIF and
// XMP.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { cleanImage, exifOrientation, imageFormat, PHOTO, STRICT } from '../../server/src/uploads/metadata'
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
