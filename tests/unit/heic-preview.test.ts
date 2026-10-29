// HEIC / HEIF preview (QA R2-FMT-10): the server converts a phone photo to JPEG for the file panel
// (server/src/files/heic-preview.ts, GET /api/files/preview), and the AI reads the same photo through OCR.
// The fixture tests/fixtures/ocr/photo.heic is tiled (512x512 grid, like a phone photo) and 2126x426 px: a converter
// that returns only the first tile gives 512x512, so the size check catches it.
// Real conversion: heif-dec when it is installed, else (macOS) mycel-ocr built here with swiftc. Without either the
// real-conversion tests are skipped; the fallback tests always run.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { which } from '../../server/src/config'
import { extractText } from '../../server/src/files/extract'
import { HeicPreviews, heicToJpeg, heicTools, PREVIEW_INPUT_MAX, type HeicTools } from '../../server/src/files/heic-preview'
import { imageSize } from '../../server/src/uploads/image'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(180_000)

const FIXTURE = path.join(import.meta.dir, '..', 'fixtures', 'ocr', 'photo.heic')
const NONE: HeicTools = { heifDec: null, imageIo: null }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-preview-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** mycel-ocr with the --jpeg mode, built from native/ocr/main.swift (macOS with swiftc only). */
function buildImageIo(): string | null {
  if (process.platform !== 'darwin' || !which('swiftc')) return null
  const out = path.join(tmp, 'bin', 'mycel-ocr')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const r = Bun.spawnSync([which('swiftc')!, '-O', '-o', out, path.join(import.meta.dir, '..', '..', 'native', 'ocr', 'main.swift')])
  return r.exitCode === 0 && fs.existsSync(out) ? out : null
}

const heifDec = which('heif-dec') ?? which('heif-convert')
const imageIo = buildImageIo()
const real: HeicTools | null = heifDec || imageIo ? { heifDec, imageIo } : null
if (!real) console.warn('heic-preview.test: no heif-dec / heif-convert and no swiftc (macOS): the real-conversion tests are skipped')

describe.skipIf(!real)('HEIC to JPEG with a real converter', () => {
  test('every tile, full size, a JPEG', async () => {
    const out = await heicToJpeg(fs.readFileSync(FIXTURE), real!)
    expect(out).not.toBeNull()
    expect([...out!.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect(imageSize(out!)).toEqual({ width: 2126, height: 426 })
  })
  test.skipIf(!heifDec)('heif-dec alone', async () => {
    expect(imageSize((await heicToJpeg(fs.readFileSync(FIXTURE), { heifDec, imageIo: null }))!)).toEqual({ width: 2126, height: 426 })
  })
  test.skipIf(!imageIo)('mycel-ocr --jpeg alone (macOS ImageIO in the sandbox)', async () => {
    expect(imageSize((await heicToJpeg(fs.readFileSync(FIXTURE), { heifDec: null, imageIo }))!)).toEqual({ width: 2126, height: 426 })
  })
  test('cached by content: a second preview needs no converter', async () => {
    const dir = path.join(tmp, 'cache-real')
    const file = path.join(tmp, 'IMG_0001.HEIC')
    fs.copyFileSync(FIXTURE, file)
    const first = await new HeicPreviews(dir, real!).jpeg(file)
    expect(first).not.toBeNull()
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.jpg')).length).toBe(1)
    const again = await new HeicPreviews(dir, NONE).jpeg(file)
    expect(again?.etag).toBe(first!.etag)
    expect(again!.bytes.equals(first!.bytes)).toBe(true)
  })
  test('a damaged HEIC: an error, not a broken image', async () => {
    const bad = new Uint8Array(Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic broken', 'latin1'))
    await expect(heicToJpeg(bad, real!)).rejects.toThrow('could not make a preview')
  })
})

/** Apple Vision in the converter sandbox fails on some machines for every image (not only HEIC): probe with a PNG. */
async function visionWorks(): Promise<boolean> {
  if (process.platform !== 'darwin' || !imageIo) return false
  try {
    return (await extractText('page.png', fs.readFileSync(path.join(path.dirname(FIXTURE), 'page.png')), { pandoc: null, pdftotext: null, ocr: imageIo })).includes('Invoice')
  } catch { return false }
}
const vision = await visionWorks()
if (process.platform === 'darwin' && imageIo && !vision) console.warn('heic-preview.test: Apple Vision fails in the sandbox on this machine (a PNG too): the HEIC OCR test is skipped')

describe.skipIf(!vision)('the AI reads a HEIC photo (OCR)', () => {
  test('mycel-ocr reads the tiled photo', async () => {
    const text = await extractText('IMG_0001.HEIC', fs.readFileSync(FIXTURE), { pandoc: null, pdftotext: null, ocr: imageIo })
    expect(text).toContain('Invoice')
  })
})

describe('fallback', () => {
  test('no converter: null (the web shows the "cannot preview" panel)', async () => {
    expect(await heicToJpeg(fs.readFileSync(FIXTURE), NONE)).toBeNull()
    const file = path.join(tmp, 'none.heic')
    fs.copyFileSync(FIXTURE, file)
    expect(await new HeicPreviews(path.join(tmp, 'cache-none'), NONE).jpeg(file)).toBeNull()
  })
  test('a converter that writes no JPEG (an old mycel-ocr without --jpeg): an error, never its text as an image', async () => {
    await expect(heicToJpeg(fs.readFileSync(FIXTURE), { heifDec: null, imageIo: '/bin/echo' })).rejects.toThrow('no JPEG mode')
  })
  test('a file over the input limit is refused before a converter runs', async () => {
    const big = path.join(tmp, 'big.heic')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, PREVIEW_INPUT_MAX + 1)
    await expect(new HeicPreviews(path.join(tmp, 'cache-big'), { heifDec: '/bin/false', imageIo: null }).jpeg(big)).rejects.toThrow('too large')
  })
  test('the cache keeps at most its byte limit (least recently used go first)', () => {
    const dir = path.join(tmp, 'cache-prune')
    fs.mkdirSync(dir)
    for (let i = 0; i < 4; i++) {
      const p = path.join(dir, `${i}.jpg`)
      fs.writeFileSync(p, Buffer.alloc(100))
      fs.utimesSync(p, new Date(1000 * (i + 1)), new Date(1000 * (i + 1)))
    }
    new HeicPreviews(dir, NONE, 250).prune()
    expect(fs.readdirSync(dir).sort()).toEqual(['2.jpg', '3.jpg'])
  })
})

describe('GET /api/files/preview', () => {
  let A: CApp
  beforeAll(async () => { A = await makeCApp('heic-preview') })
  afterAll(async () => { await A.close() })
  const q = (p: string) => '/api/files/preview?' + new URLSearchParams({ path: p }).toString()

  test('a HEIC photo: the JPEG when this machine has a converter, else 503 no_preview', async () => {
    fs.mkdirSync(path.join(A.team, 'shared', 'photos'), { recursive: true })
    fs.copyFileSync(FIXTURE, path.join(A.team, 'shared', 'photos', 'IMG_0001.HEIC'))
    const res = await A.req(q('shared/photos/IMG_0001.HEIC'), { as: 'alice' })
    const t = heicTools()
    if (t.heifDec || t.imageIo) {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/jpeg')
      expect(res.headers.get('content-security-policy')).toContain('sandbox')
      expect(imageSize(new Uint8Array(await res.arrayBuffer()))).toEqual({ width: 2126, height: 426 })
    } else {
      expect(res.status).toBe(503)
      expect((await res.json()).error.params).toEqual({ reason: 'no_preview' })
    }
  })
  test('other formats: 503 no_preview; hidden or missing files: 404; a session is needed', async () => {
    const md = await A.req(q('shared/glossary.md'), { as: 'alice' })
    expect(md.status).toBe(503)
    expect((await md.json()).error.params).toEqual({ reason: 'no_preview' })
    expect((await A.req(q('shared/photos/missing.heic'), { as: 'alice' })).status).toBe(404)
    expect((await A.req(q('groups/finance/x.heic'), { as: 'alice' })).status).toBe(404)
    expect((await A.req(q('shared/photos/IMG_0001.HEIC'))).status).toBe(401)
  })
})
