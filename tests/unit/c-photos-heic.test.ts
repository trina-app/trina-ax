// iPhone photos (HEIC / HEIF), the iPhone's default format (the owner, 2026-11-17: "아이폰 HEIC는 지원안해?"):
// - resize_images makes JPEG copies of them (or PNG when asked), upright, keeping the photo's details by default;
// - the AI sees them on read: Claude takes only JPEG, PNG, GIF and WebP, so the server decodes the HEIC first
//   (heif-dec on Linux, macOS ImageIO through mycel-ocr) in the converter isolation;
// - the size a HEIC declares is checked before any decoder runs (a decompression bomb is refused undecoded);
// - a server without a HEIC decoder says one plain sentence.
// Fixture tests/fixtures/exif/photo-gps.heic: made on a Mac with `sips -s format heic` from photo-gps.jpg (320x200
// stored, rotation to 200x320, Apple / iPhone 15 Pro, a location in Seoul). The conversion tests skip without the
// built helpers (bun run build:native; mycel-ocr needs swiftc) and without heif-dec.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { RESIZE_WORD } from '../../server/src/tools/resize-images'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { imageSize } from '../../server/src/uploads/image'
import { heicRefusal, heicSize, heicTools } from '../../server/src/files/heic-preview'
import { VISION_TEXT } from '../../server/src/files/vision-text'
import type { VisionTools } from '../../server/src/files/vision'

setDefaultTimeout(60_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-photos-heic') })
afterAll(async () => { await A.close() })

const ROOT = path.join(import.meta.dir, '..', '..')
const HEIC = fs.readFileSync(path.join(ROOT, 'tests/fixtures/exif/photo-gps.heic'))
const TILED = fs.readFileSync(path.join(ROOT, 'tests/fixtures/ocr/photo.heic')) // 2126x426 in 512 px tiles
const bin = path.join(ROOT, 'native/bin', `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`)
const helper = fs.existsSync(path.join(bin, 'mycel-safeops'))
const decoder = (() => { const t = heicTools(); return !!(t.heifDec || t.imageIo) })()
const conv = test.skipIf(!helper || !decoder)
if (!helper || !decoder) console.warn('c-photos-heic: no built mycel-safeops or no HEIC decoder (heif-dec, or mycel-ocr on macOS): the conversion tests are skipped')

const D = 'groups/marketing/iphone'
const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
const word = () => RESIZE_WORD[teamDefaultLocale(A.ctx.db)]
let rpcId = 0
type Block = { type: string; text?: string; data?: string; mimeType?: string }
function turn(user: Person) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, A.turn(user, A.chat(user))))
  return async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    const content = r.result.content as Block[]
    return { text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), content, isError: !!r.result.isError }
  }
}
/** the tags of IFD0 of a JPEG's EXIF */
function ifd0(jpg: Buffer): Map<number, number> {
  const out = new Map<number, number>()
  const at = jpg.indexOf('Exif\0\0', 0, 'latin1')
  if (at < 0) return out
  const t = jpg.subarray(at + 6)
  const le = t.toString('latin1', 0, 2) === 'II'
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o))
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o))
  const off = u32(4)
  for (let i = 0; i < u16(off); i++) out.set(u16(off + 2 + 12 * i), u16(off + 2 + 12 * i + 8))
  return out
}
/** the server's converters with no HEIC decoder (a Linux server without libheif-examples, or Windows) */
function withoutDecoder<T>(f: () => Promise<T>): Promise<T> {
  const files = A.ctx.files as unknown as { visionTools: () => VisionTools }
  const orig = files.visionTools.bind(files)
  files.visionTools = () => ({ ...orig(), heic: { heifDec: null, imageIo: null } })
  return f().finally(() => { files.visionTools = orig })
}
/** a copy of a HEIC whose every `ispe` declares w x h (the box layout unchanged) */
function declaring(b: Buffer, w: number, h: number): Buffer {
  const out = Buffer.from(b)
  for (let p = out.indexOf('ispe'); p >= 0; p = out.indexOf('ispe', p + 4)) { out.writeUInt32BE(w, p + 8); out.writeUInt32BE(h, p + 12) }
  return out
}

describe('the size a HEIC declares, read before decoding', () => {
  test('the primary image of a plain and a tiled phone photo', () => {
    expect(heicSize(HEIC)).toMatchObject({ width: 320, height: 200 })
    // a grid of 512 px tiles: the grid's own size, not a tile's
    expect(heicSize(TILED)).toMatchObject({ width: 2126, height: 426 })
    expect(heicRefusal(HEIC)).toBeNull()
  })
  test('over 50 megapixels or 65,535 px a side: refused; no primary size or not a HEIF: damaged', () => {
    expect(heicRefusal(declaring(HEIC, 10_000, 6_000))).toBe('too_large')
    expect(heicRefusal(declaring(HEIC, 70_000, 10))).toBe('too_large')
    expect(heicRefusal(Buffer.from('not a photo at all, just text'))).toBe('damaged')
    expect(heicRefusal(HEIC.subarray(0, 200))).toBe('damaged')
    // cut anywhere: never a throw
    for (let n = 0; n < HEIC.length; n += 97) heicRefusal(HEIC.subarray(0, n))
  })
})

describe('resize_images with iPhone photos', () => {
  conv('a JPEG copy, upright, with the details kept; the answer says it is a JPEG', async () => {
    put(`${D}/IMG_0001.HEIC`, HEIC)
    const r = await turn('alice')('resize_images', { paths: [`${D}/IMG_0001.HEIC`], longest_side: 160 })
    expect(r.isError, r.text).toBe(false)
    const rel = `${D}/IMG_0001-${word()}.jpg`
    const out = fs.readFileSync(file(rel))
    expect([...out.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect(imageSize(out)).toEqual({ width: 100, height: 160 })
    expect(ifd0(out).get(0x0112)).toBe(1)
    expect(out.includes('iPhone 15 Pro')).toBe(true)
    expect(ifd0(out).has(0x8825)).toBe(true)
    expect(r.text).toContain(`Saved ${rel}`)
    expect(r.text).toMatch(/iPhone photo \(HEIC\); its copy is JPEG/)
    expect(r.text).toContain('keep the photo details')
    expect(fs.readFileSync(file(`${D}/IMG_0001.HEIC`)).equals(HEIC)).toBe(true)
  })

  conv('the location removed on request; PNG when asked; never replaces the HEIC', async () => {
    put(`${D}/IMG_0002.heic`, HEIC)
    const call = turn('alice')
    const r = await call('resize_images', { paths: [`${D}/IMG_0002.heic`], preset: 'smaller', remove_details: 'location' })
    expect(r.isError, r.text).toBe(false)
    const out = fs.readFileSync(file(`${D}/IMG_0002-${word()}.jpg`))
    expect(imageSize(out)).toEqual({ width: 100, height: 160 })
    expect(ifd0(out).has(0x8825)).toBe(false)
    expect(out.includes('iPhone 15 Pro')).toBe(true)
    expect(r.text).toMatch(/location was removed/)
    const png = await call('resize_images', { paths: [`${D}/IMG_0002.heic`], longest_side: 100, format: 'png' })
    expect(png.isError, png.text).toBe(false)
    expect(fs.readFileSync(file(`${D}/IMG_0002-${word()}.png`)).readUInt32BE(0)).toBe(0x89504e47)
    await call('read', { file_path: `${D}/IMG_0002.heic` })
    const rep = await call('resize_images', { paths: [`${D}/IMG_0002.heic`], longest_side: 100, replace: true })
    expect(rep.isError).toBe(true)
    expect(rep.text).toMatch(/iPhone photo \(HEIC\).*cannot replace/)
  })

  test('a HEIC declaring 60 megapixels is refused before any decoder runs', async () => {
    put(`${D}/huge.heic`, declaring(HEIC, 10_000, 6_000))
    const r = await turn('alice')('resize_images', { paths: [`${D}/huge.heic`], longest_side: 800 })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/huge\.heic.*too large/)
  })

  test('no HEIC decoder on this server: one plain sentence, no jargon; JPEGs in the same call still made', async () => {
    put(`${D}/IMG_0003.heic`, HEIC)
    const r = await withoutDecoder(() => turn('alice')('resize_images', { paths: [`${D}/IMG_0003.heic`], longest_side: 800 }))
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/IMG_0003\.heic.*this server cannot open iPhone photos/)
    expect(r.text).toMatch(/save the photo as JPEG/)
    expect(r.text).not.toMatch(/heif|libheif|decoder|mycel/i)
  })
})

describe('the AI sees iPhone photos', () => {
  conv('read gives one JPEG image block, upright', async () => {
    put(`${D}/look.heic`, HEIC)
    const r = await turn('alice')('read', { file_path: `${D}/look.heic` })
    expect(r.isError, r.text).toBe(false)
    const img = r.content.find((c) => c.type === 'image')
    expect(img?.mimeType).toBe('image/jpeg')
    const jpg = Buffer.from(img!.data!, 'base64')
    expect(imageSize(jpg)).toEqual({ width: 200, height: 320 })
    // the model's copy carries no details (the normalizer rebuilds it from pixels)
    expect(jpg.includes('iPhone 15 Pro')).toBe(false)
  })

  conv('a tiled phone photo is shown whole, not its first tile', async () => {
    put(`${D}/tiled.heic`, TILED)
    const r = await turn('alice')('read', { file_path: `${D}/tiled.heic` })
    const img = r.content.find((c) => c.type === 'image')
    const s = imageSize(Buffer.from(img!.data!, 'base64'))!
    expect(s.width / s.height).toBeCloseTo(2126 / 426, 1)
  })

  test('a HEIC declaring too many pixels: the too-large note, no decoder run', async () => {
    put(`${D}/bomb.heic`, declaring(HEIC, 60_000, 60_000))
    const r = await turn('alice')('read', { file_path: `${D}/bomb.heic` })
    expect(r.content.some((c) => c.type === 'image')).toBe(false)
    expect(r.text).toContain(VISION_TEXT.tooLarge.ko)
  })

  test('no HEIC decoder: the plain sentence in the person\'s language', async () => {
    put(`${D}/nodec.heic`, HEIC)
    const r = await withoutDecoder(() => turn('alice')('read', { file_path: `${D}/nodec.heic` }))
    expect(r.content.some((c) => c.type === 'image')).toBe(false)
    expect(r.text).toContain(VISION_TEXT.noHeic.ko)
    expect(VISION_TEXT.noHeic.ko).toBe('이 서버에서는 아이폰 사진(HEIC)을 열 수 없어요. JPEG로 저장해서 다시 올려 주세요.')
  })
})

describe('thumbnails of iPhone photos (chat attachments, room and chat files)', () => {
  conv('made through the HEIC decoder, upright, with no photo details; a room file stored without its name too', async () => {
    const { makeThumbnail } = await import('../../server/src/uploads/image')
    const dir = fs.mkdtempSync(path.join(A.data, 'thumbs-'))
    // stored like a room file: no extension
    const src = path.join(dir, 'f-0001')
    fs.writeFileSync(src, HEIC)
    const made = await makeThumbnail(src, path.join(dir, 't'), 160, dir, null)
    expect(made).toBe('jpg')
    const jpg = fs.readFileSync(path.join(dir, 't.jpg'))
    expect(imageSize(jpg)).toEqual({ width: 100, height: 160 })
    expect(jpg.includes('iPhone 15 Pro')).toBe(false)
    expect(jpg.includes('Exif')).toBe(false)
    // a bomb is not decoded
    fs.writeFileSync(src, declaring(HEIC, 60_000, 60_000))
    expect(await makeThumbnail(src, path.join(dir, 'b'), 160, dir, null)).toBeNull()
  })
})
