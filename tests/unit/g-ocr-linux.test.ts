// Linux OCR through the server's read path (server/src/files/extract.ts -> tools/isolate.ts runIsolated -> the Go
// mycel-ocr with poppler + tesseract kor+eng; linux-runtime spec 3.7.1, task L13). Fixtures and the Debian 13 image:
// tests/fixtures/ocr/make.sh. Runs only on Linux with mycel-ocr built and the tools installed:
//   bash tests/fixtures/ocr/make.sh test --docker
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ocrBin, which } from '../../server/src/config'
import { extractText } from '../../server/src/files/extract'
import { isolation } from '../../server/src/tools/isolate'

const bin = process.platform === 'linux' ? ocrBin() : null
const FIX = path.resolve(import.meta.dir, '..', 'fixtures', 'ocr')
const bytes = (f: string) => new Uint8Array(fs.readFileSync(path.join(FIX, f)))
const squash = (s: string) => s.replace(/\s+/g, '')
// tesseract runs one thread per page; a busy CI machine needs more than bun's 5 s
const OCR_MS = 60_000

describe.skipIf(!bin)('mycel-ocr on Linux (tesseract, in the converter sandbox)', () => {
  const pdftotext = which('pdftotext')
  const tools = { pandoc: null, pdftotext, ocr: bin }
  const page = (s: string) => {
    const q = squash(s)
    for (const w of ['진료예약안내', '오전9시부터오후6시까지', 'Invoice2026-10-21']) expect(q).toContain(w)
  }

  test('the converter sandbox is bwrap here', () => {
    expect(isolation()).toBe('bwrap')
  })
  test('a scanned PDF (no text layer) is recognized, with or without pdftotext', async () => {
    for (const t of [tools, { ...tools, pdftotext: null }]) page(await extractText('scan.pdf', bytes('scan.pdf'), t))
  }, OCR_MS)
  test('a PDF with a scanned page keeps the text layer of the other page', async () => {
    const text = await extractText('mixed.pdf', bytes('mixed.pdf'), tools)
    expect(text.split('\n\n')[0]).toContain('평일 오전 9시부터 오후 6시까지 받습니다')
    page(text.split('\n\n').slice(1).join('\n'))
  }, OCR_MS)
  test('images: PNG, text only in the alpha channel, a sideways phone JPEG (EXIF 6), a tiled HEIC', async () => {
    page(await extractText('사진.PNG', bytes('page.png'), tools))
    page(await extractText('t.png', bytes('trans.png'), tools))
    page(await extractText('photo.jpg', bytes('rot6.jpg'), tools))
    page(await extractText('IMG_0001.HEIC', bytes('photo.heic'), tools))
  }, OCR_MS)
  test('a PDF with a text layer keeps pdftotext (no OCR)', async () => {
    expect(await extractText('text.pdf', bytes('text.pdf'), tools)).toBe(await extractText('text.pdf', bytes('text.pdf'), { ...tools, ocr: null }))
  }, OCR_MS)
  test('a password-protected PDF and a non-image say why', async () => {
    await expect(extractText('enc.pdf', bytes('enc.pdf'), { ...tools, pdftotext: null })).rejects.toThrow(/password-protected/)
    await expect(extractText('notes.png', bytes('notes.txt'), tools)).rejects.toThrow(/not a PDF or an image/)
  }, OCR_MS)
})
