// OCR for scanned PDFs and images (native/ocr/main.swift → mycel-ocr, server/src/files/extract.ts). The fixtures are
// made here with macOS tools (cupsfilter: text → PDF, sips: PDF → PNG → image-only PDF); the real-OCR tests run only
// where mycel-ocr is built (`bash native/build.sh` on a Mac).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ocrBin, which } from '../../server/src/config'
import { extractText, looksScanned } from '../../server/src/files/extract'

describe('looksScanned (pdftotext output, pages end with a form feed)', () => {
  test('a page with next to no text means a scanned page', () => {
    expect(looksScanned('\f')).toBe(true)
    const page = '진료 예약 안내: 평일 오전 9시부터 오후 6시까지 받습니다'
    expect(looksScanned(`${page}\f\f`)).toBe(true)
    expect(looksScanned(`${page}\f`)).toBe(false)
    expect(looksScanned(`${page}\f${page}\f`)).toBe(false)
  })
})

const bin = ocrBin()
const pdftotext = which('pdftotext')
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-ocr-'))
afterAll(() => fs.rmSync(W, { recursive: true, force: true }))

// macOS only: the fixtures are made with cupsfilter and sips, and the recognizer is Apple Vision (Linux's mycel-ocr,
// tesseract + poppler: tests/unit/g-ocr-linux.test.ts and native/cmd/mycel-ocr). bun still runs a skipped describe's
// body to collect its tests, so the fixtures are made in beforeAll, which runs only when the tests do.
describe.skipIf(process.platform !== 'darwin' || !bin || !fs.existsSync('/usr/sbin/cupsfilter'))('mycel-ocr (Apple Vision, in the converter sandbox)', () => {
  const run = (cmd: string, args: string[]) => { const p = Bun.spawnSync([cmd, ...args], { cwd: W }); if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr}`); return p.stdout }
  beforeAll(() => {
    fs.writeFileSync(path.join(W, 'note.txt'), '진료 예약 안내\n오전 9시부터 오후 6시까지\nInvoice 2026-10-21 total 15000\n')
    fs.writeFileSync(path.join(W, 'text.pdf'), run('/usr/sbin/cupsfilter', ['-m', 'application/pdf', 'note.txt']))
    run('/usr/bin/sips', ['-s', 'format', 'png', 'text.pdf', '--out', 'page.png'])
    run('/usr/bin/sips', ['-s', 'format', 'pdf', 'page.png', '--out', 'scan.pdf'])
  })
  const bytes = (f: string) => new Uint8Array(fs.readFileSync(path.join(W, f)))
  const tools = { pandoc: null, pdftotext, ocr: bin }
  const squash = (s: string) => s.replace(/\s+/g, '')
  // real Apple Vision runs (each may take up to extract.ts's 20 s); bun's default 5 s timed out on a busy Mac
  const OCR_MS = 30_000

  test('a scanned PDF (no text layer) is recognized, with or without pdftotext', async () => {
    for (const t of [tools, { ...tools, pdftotext: null }]) {
      const text = await extractText('scan.pdf', bytes('scan.pdf'), t)
      expect(squash(text)).toContain('오전9시부터오후6시까지')
      expect(text).toContain('Invoice 2026-10-21')
    }
  }, OCR_MS)
  test('an image with a transparent background', async () => {
    expect(squash(await extractText('사진.PNG', bytes('page.png'), tools))).toContain('진료예약안내')
  }, OCR_MS)
  test('a PDF with a text layer keeps pdftotext (no OCR)', async () => {
    if (!pdftotext) return
    expect(await extractText('text.pdf', bytes('text.pdf'), tools)).toBe((await extractText('text.pdf', bytes('text.pdf'), { ...tools, ocr: null })))
  })
  test('without the tool, an image is still a binary file', async () => {
    await expect(extractText('page.png', bytes('page.png'), { ...tools, ocr: null })).rejects.toThrow(/binary file/)
  })
})
