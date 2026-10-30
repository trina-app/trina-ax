// The AI sees images and PDF pages like Claude Code's Read (server/src/files/vision.ts, files/service.ts readImage /
// readPdf; docs/DECISIONS.md "AI sees images and PDF pages"). Real converters where the machine has them: the Go
// normalizer (mycel-safeops vision) in the converter isolation, pdftotext / pdftoppm (Linux) or PDFKit (macOS).
// Runs on macOS (sandbox-exec) and in the Linux T1 container (bwrap + converter cgroup, tests/linux/driver.ts).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { makeCApp, type CApp } from '../lib/c-app'
import { makePng } from '../lib/images'
import { CCITT_SCAN, makePagesPdf, makePdf } from '../lib/pdf'
import { makeHandler } from '../../server/src/mcp/protocol'
import { send, flush } from '../../server/src/mcp/socket'
import { nativeBinDir, ocrBin, which } from '../../server/src/config'
import { isolation } from '../../server/src/tools/isolate'
import { heicTools } from '../../server/src/files/heic-preview'
import { imageTokens, PDF_PAGES_PER_READ, READ_OUTPUT_TOKENS, textTokens, VISION_SIDE_MAX, VISION_TURN_BYTES, VISION_TURN_IMAGES, parsePages, visionTools } from '../../server/src/files/vision'
import { confidentialChat } from '../../server/src/safe-ops/confidential'
import { TurnFiles } from '../../server/src/files/service'

setDefaultTimeout(60_000)
// making the fixture team (pandoc, an app) can take long on a busy CI machine: a hook that times out keeps running into
// the next test file
const HOOK_MS = 120_000
const FIX = path.resolve(import.meta.dir, '..', 'fixtures', 'ocr')
let A: CApp
const ALICE = 'users/alice'
const put = (rel: string, b: Uint8Array | string) => { fs.mkdirSync(path.dirname(path.join(A.team, rel)), { recursive: true }); fs.writeFileSync(path.join(A.team, rel), b) }
const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

// the converters this machine has (the same lookup as the server's): tests that need one are skipped, with the reason
const TOOLS = visionTools({ nativeBin: nativeBinDir(), pdftotext: which('pdftotext'), ocr: ocrBin(), which })
const realConverter = !!TOOLS.normalizer && isolation() !== 'none'
const pageRenderer = realConverter && !!(TOOLS.pdfkit || TOOLS.pdftoppm) && !!(TOOLS.pdftotext || TOOLS.pdfkit)
beforeAll(async () => {
  A = await makeCApp('vision-read')
  // the notes to the AI follow the person's language: English here, Korean checked below
  A.ctx.db.query("UPDATE users SET locale = 'en'").run()
  put(`${ALICE}/photo.png`, makePng(64, 48))
  put(`${ALICE}/text.pdf`, makePdf(['Quarterly report 2026', 'Revenue grew by 12 percent in the third quarter.']))
  put(`${ALICE}/scan.pdf`, makePagesPdf([{ image: CCITT_SCAN }]))
  put(`${ALICE}/mixed.pdf`, makePagesPdf([{ lines: ['Page one has a real text layer with enough words.'] }, { image: CCITT_SCAN }, { lines: ['Page three is text again, also with enough words.'] }]))
  put(`${ALICE}/eleven.pdf`, makePagesPdf(Array.from({ length: 11 }, (_, i) => ({ lines: [`This is page number ${i + 1} of the eleven page report.`] }))))
  put(`${ALICE}/long.pdf`, makePagesPdf(Array.from({ length: 25 }, (_, i) => ({ lines: [`Chapter ${i + 1}: a page of the twenty-five page manual.`] }))))
}, HOOK_MS)
afterAll(async () => { await A?.close() }, HOOK_MS)

const handler = (who: string, turn: string | null = null, ctx = A.toolCtx(who as any, turn)) => ({ ctx, call: (name: string, args: unknown) => makeHandler(A.ctx.files, A.ctx.db, ctx)({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
const images = (r: any) => (r.result.content as any[]).filter((c) => c.type === 'image')
const texts = (r: any) => (r.result.content as any[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
const jpegSize = (b64: string) => {
  const b = Buffer.from(b64, 'base64')
  for (let p = 2; p + 9 < b.length;) {
    const m = b[p + 1]!
    if (m >= 0xc0 && m <= 0xc3) return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) }
    p += 2 + b.readUInt16BE(p + 2)
  }
  return null
}
const setVision = (on: boolean) => A.ctx.db.query("INSERT INTO settings (key, value) VALUES ('aiVision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(on))

describe('images go to the model as image blocks (default on, no 1A flag)', () => {
  test('an image read returns one JPEG image block; the read scope is recorded; no structuredContent', async () => {
    const chat = A.chat('alice'), h = handler('alice', A.turn('alice', chat))
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(fakeJpeg)
    try {
      const r = await h.call('read', { file_path: `${ALICE}/photo.png` })
      expect(r.result.isError).toBeUndefined()
      expect(images(r)).toEqual([{ type: 'image', mimeType: 'image/jpeg', data: fakeJpeg.toString('base64') }])
      expect(r.result.structuredContent).toBeUndefined()
      expect(h.ctx.files.readPaths.has(`${ALICE}/photo.png`)).toBe(true)
      expect(h.ctx.files.readHashes.get(`${ALICE}/photo.png`)).toHaveLength(64)
      expect(h.ctx.files.imageCount).toBe(1)
      // the beforeDelivery guard stays off the wire
      expect(JSON.parse(JSON.stringify(r)).beforeDelivery).toBeUndefined()
      // no confidential lock, no 1A workflow
      expect(process.env.MYCEL_SAFE_OPS_1A).toBeUndefined()
      expect(confidentialChat(A.ctx.db, chat)).toBe(false)
      expect((A.ctx.db.query('SELECT count(*) AS n FROM safe_ops_workflows').get() as { n: number }).n).toBe(0)
      expect((A.ctx.db.query('SELECT count(*) AS n FROM safe_ops_artifacts').get() as { n: number }).n).toBe(0)
    } finally { codec.mockRestore() }
  })

  test.skipIf(!realConverter)('real normalizer: PNG, a sideways phone JPEG and a transparent PNG', async () => {
    put(`${ALICE}/rot6.jpg`, fs.readFileSync(path.join(FIX, 'rot6.jpg')))
    put(`${ALICE}/trans.png`, fs.readFileSync(path.join(FIX, 'trans.png')))
    put(`${ALICE}/wide.png`, makePng(3000, 600))
    const h = handler('alice', A.turn('alice', A.chat('alice')))
    for (const [file, w, hh] of [['photo.png', 64, 48], ['rot6.jpg', 1417, 284], ['trans.png', 1417, 284], ['wide.png', VISION_SIDE_MAX, 313]] as const) {
      const r = await h.call('read', { file_path: `${ALICE}/${file}` })
      expect(r.result.isError, `${file}: ${texts(r)}`).toBeUndefined()
      const [img] = images(r)
      expect(img.mimeType).toBe('image/jpeg')
      expect(Buffer.from(img.data, 'base64').length).toBeLessThanOrEqual(1024 ** 2)
      expect(jpegSize(img.data), file).toEqual({ width: w, height: hh })
    }
  })

  test.skipIf(!realConverter)('metadata (EXIF GPS, XMP, ICC, comments) never reaches the model', async () => {
    const src = fs.readFileSync(path.join(FIX, 'rot6.jpg'))
    const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload])
    const gps = Buffer.concat([Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0\0'), Buffer.from('GPSLatitude 37.5665 CANARY-GPS-4471')])
    const tagged = Buffer.concat([src.subarray(0, 2), seg(0xe1, gps), seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>CANARY-XMP-1180</x:xmpmeta>')),
      seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01CANARY-ICC')), seg(0xfe, Buffer.from('CANARY-COMMENT-5531')), src.subarray(2)])
    expect(tagged.includes('CANARY-GPS-4471')).toBe(true)
    put(`${ALICE}/gps.jpg`, tagged)
    const r = await handler('alice', A.turn('alice', A.chat('alice'))).call('read', { file_path: `${ALICE}/gps.jpg` })
    const [img] = images(r)
    const out = Buffer.from(img.data, 'base64')
    for (const leak of ['CANARY', 'Exif', 'GPS', 'xmpmeta', 'ICC_PROFILE']) expect(out.includes(leak), leak).toBe(false)
  })

  test.skipIf(!realConverter)('decompression bombs and corrupt images stay bounded and isolated: a note, no image', async () => {
    // header-only bomb: 100000 x 100000 declared, a few bytes of data
    const png = Buffer.from(makePng(8, 8))
    const bomb = Buffer.from(png)
    bomb.writeUInt32BE(100000, 16); bomb.writeUInt32BE(100000, 20)
    bomb.writeUInt32BE(zlib.crc32(bomb.subarray(12, 29)), 29)
    put(`${ALICE}/bomb.png`, bomb)
    // a real bomb inside the pixel limit: 49 megapixels of zeros, about 50 KB on disk
    put(`${ALICE}/zeros.png`, grayPng(7000, 7000))
    put(`${ALICE}/corrupt.png`, png.subarray(0, png.length - 20))
    put(`${ALICE}/random.webp`, Buffer.from('RIFF\x10\0\0\0WEBPVP8 garbage that is not an image'))
    put(`${ALICE}/notes.bmp`, fs.readFileSync(path.join(FIX, 'notes.txt')))
    const h = handler('alice', A.turn('alice', A.chat('alice')))
    const t0 = Date.now()
    const big = await h.call('read', { file_path: `${ALICE}/bomb.png` })
    expect(big.result.isError).toBe(true)
    expect(images(big)).toEqual([])
    expect(texts(big)).toContain('too large')
    expect(Date.now() - t0).toBeLessThan(10_000)
    const zeros = await h.call('read', { file_path: `${ALICE}/zeros.png` })
    expect(jpegSize(images(zeros)[0].data)).toEqual({ width: VISION_SIDE_MAX, height: VISION_SIDE_MAX })
    for (const f of ['corrupt.png', 'random.webp', 'notes.bmp']) {
      const r = await h.call('read', { file_path: `${ALICE}/${f}` })
      expect(r.result.isError, f).toBe(true)
      expect(images(r), f).toEqual([])
      expect(texts(r), f).toMatch(/damaged|cannot be shown/)
    }
  })

  test.skipIf(!realConverter || (!heicTools().heifDec && !heicTools().imageIo))('HEIC: decoded by heif-dec / ImageIO, then normalized', async () => {
    put(`${ALICE}/IMG_0001.HEIC`, fs.readFileSync(path.join(FIX, 'photo.heic')))
    const r = await handler('alice', A.turn('alice', A.chat('alice'))).call('read', { file_path: `${ALICE}/IMG_0001.HEIC` })
    expect(r.result.isError, texts(r)).toBeUndefined()
    const size = jpegSize(images(r)[0].data)!
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(VISION_SIDE_MAX)
    expect(size.width).toBeGreaterThan(size.height)
  })
})

describe('PDF pages (Claude Code Read contract)', () => {
  test('parsePages: single pages, ranges, lists; 1-based, bounded, at most 20', () => {
    expect(parsePages('3', 10)).toEqual([3])
    expect(parsePages('1-3, 7', 10)).toEqual([1, 2, 3, 7])
    expect(parsePages('8-12', 10)).toEqual([8, 9, 10])
    expect(parsePages(`1-${PDF_PAGES_PER_READ}`, 30)).toHaveLength(PDF_PAGES_PER_READ)
    expect(() => parsePages(`1-${PDF_PAGES_PER_READ + 1}`, 30)).toThrow(/at most 20 pages/)
    expect(() => parsePages('0', 10)).toThrow(/start at 1/)
    expect(() => parsePages('11', 10)).toThrow(/past the end: this PDF has 10 pages/)
    expect(() => parsePages('a-b', 10)).toThrow(/must look like/)
    expect(() => parsePages('5-2', 10)).toThrow(/not a range/)
  })

  test.skipIf(!pageRenderer)('text pages come back as text, without images', async () => {
    const r = await handler('alice', A.turn('alice', A.chat('alice'))).call('read', { file_path: `${ALICE}/text.pdf` })
    expect(r.result.isError).toBeUndefined()
    expect(texts(r)).toContain('--- Page 1 ---')
    expect(texts(r)).toContain('Revenue grew by 12 percent')
    expect(images(r)).toEqual([])
  })

  test.skipIf(!pageRenderer)('scanned pages come back as page images; text pages stay text; as_images shows text pages too', async () => {
    const h = handler('alice', A.turn('alice', A.chat('alice')))
    const r = await h.call('read', { file_path: `${ALICE}/mixed.pdf` })
    expect(r.result.isError, texts(r)).toBeUndefined()
    const c = r.result.content as any[]
    // order: header + page 1 text, page 2 heading, the image, page 3 text
    expect(c.map((x) => x.type)).toEqual(['text', 'image', 'text'])
    expect(c[0].text).toContain('Page one has a real text layer')
    expect(c[0].text).toContain('--- Page 2 (no text layer: shown as an image) ---')
    expect(c[2].text).toContain('Page three is text again')
    const size = jpegSize(c[1].data)!
    expect(Math.max(size.width, size.height)).toBe(VISION_SIDE_MAX)
    expect(size.height).toBeGreaterThan(size.width) // A4 portrait
    const all = await h.call('read', { file_path: `${ALICE}/mixed.pdf`, pages: '1', as_images: true })
    expect(images(all)).toHaveLength(1)
    expect(texts(all)).toContain('Page one has a real text layer')
    expect(texts(all)).toContain('--- Page 1 as an image ---')
    const only = await h.call('read', { file_path: `${ALICE}/scan.pdf` })
    expect(images(only)).toHaveLength(1)
    expect(h.ctx.files.imageCount).toBe(3)
  })

  test.skipIf(!pageRenderer)("a page's /Rotate is applied", async () => {
    put(`${ALICE}/turned.pdf`, makePagesPdf([{ image: CCITT_SCAN }], { rotate: 90 }))
    const r = await handler('alice', A.turn('alice', A.chat('alice'))).call('read', { file_path: `${ALICE}/turned.pdf` })
    const size = jpegSize(images(r)[0].data)!
    expect(size.width).toBe(VISION_SIDE_MAX)
    expect(size.width).toBeGreaterThan(size.height) // A4 turned: landscape
  })

  test.skipIf(!pageRenderer)('over 10 pages, pages is required (a clear error); at most 20 pages per call; offset/limit read the text lines', async () => {
    const h = handler('alice', A.turn('alice', A.chat('alice')))
    const no = await h.call('read', { file_path: `${ALICE}/eleven.pdf` })
    expect(no.result.isError).toBe(true)
    expect(texts(no)).toContain('has 11 pages: read it in parts with pages')
    const some = await h.call('read', { file_path: `${ALICE}/eleven.pdf`, pages: '10-11' })
    expect(texts(some)).toContain('This is page number 11')
    expect(texts(some)).not.toContain('This is page number 9 ')
    const many = await h.call('read', { file_path: `${ALICE}/long.pdf`, pages: '1-21' })
    expect(many.result.isError).toBe(true)
    expect(texts(many)).toContain('at most 20 pages per read')
    const twenty = await h.call('read', { file_path: `${ALICE}/long.pdf`, pages: '1-20' })
    expect(twenty.result.isError).toBeUndefined()
    expect(texts(twenty)).toContain('Chapter 20:')
    const lines = await h.call('read', { file_path: `${ALICE}/long.pdf`, offset: 1, limit: 400 })
    expect(lines.result.isError).toBeUndefined()
    expect(texts(lines)).toMatch(/^\s+1\t/)
    expect(texts(lines)).toContain('Chapter 25:')
    const past = await h.call('read', { file_path: `${ALICE}/long.pdf`, pages: '26' })
    expect(texts(past)).toContain('past the end: this PDF has 25 pages')
    const notPdf = await h.call('read', { file_path: 'shared/glossary.md', pages: '1' })
    expect(texts(notPdf)).toContain('only for PDF files')
  })

  // grep searches the text cache (files/search.ts): on a Mac that is Apple Vision text for scanned pages and PDFKit text
  // without poppler, which number lines differently from the text layer alone (review of feat/vision-read)
  test.skipIf(!pageRenderer)('grep -> read: offset/limit give the line grep reports (also on a Mac without poppler)', async () => {
    const office = A.ctx.files.office as unknown as { tools: { pdftotext: string | null } }
    const saved = A.ctx.files.cfg.pdftotext
    const h = handler('alice', A.turn('alice', A.chat('alice')))
    try {
      for (const poppler of A.ctx.files.cfg.ocr && saved ? [true, false] : [true]) {
        if (!poppler) A.ctx.files.cfg.pdftotext = office.tools.pdftotext = null
        for (const [file, word] of [['mixed.pdf', 'Page three'], ['eleven.pdf', 'page number 9 ']] as const) {
          const rel = `${ALICE}/${file}`
          fs.rmSync(A.ctx.files.office.cachePath(rel), { force: true })
          await A.ctx.files.office.update(rel)
          const hit = new RegExp(`${file}:(\\d+):.*${word}`).exec(texts(await h.call('grep', { pattern: word, path: ALICE, output_mode: 'content', '-n': true })))
          expect(hit).not.toBeNull()
          const line = await h.call('read', { file_path: rel, offset: Number(hit![1]), limit: 1 })
          expect(line.result.isError).toBeUndefined()
          expect(texts(line)).toContain(word)
        }
      }
    } finally {
      A.ctx.files.cfg.pdftotext = office.tools.pdftotext = saved
      for (const f of ['mixed.pdf', 'eleven.pdf']) fs.rmSync(A.ctx.files.office.cachePath(`${ALICE}/${f}`), { force: true })
    }
  })

  // Claude Code cuts an MCP result over 25,000 tokens (MAX_MCP_OUTPUT_TOKENS): 20 page images (about 2,300 tokens each
  // for an A4 page) would lose some and tell the AI the output was truncated (review of feat/vision-read)
  test.skipIf(!pageRenderer)('page images that would pass the tool output limit wait for the next call, which reads them', async () => {
    put(`${ALICE}/twenty-scans.pdf`, makePagesPdf(Array.from({ length: 20 }, () => ({ image: CCITT_SCAN }))))
    // an A4 page drawn at 1568 px: 1109 x 1568 (2,319 tokens)
    const a4 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x20, 0x04, 0x55]), Buffer.alloc(14), Buffer.from([0xff, 0xd9])])
    expect(imageTokens(a4)).toBe(2319)
    const page = spyOn(A.ctx.files, 'pdfPageImage').mockResolvedValue(a4)
    try {
      const h = handler('alice', A.turn('alice', A.chat('alice')))
      const first = await h.call('read', { file_path: `${ALICE}/twenty-scans.pdf`, pages: '1-20' })
      expect(first.result.isError).toBeUndefined()
      expect(images(first)).toHaveLength(10)
      expect(page.mock.calls.length).toBe(11) // the 11th did not fit; no conversion after it
      expect(texts(first)).toContain('Not shown in this read: the images of pages 11-20')
      expect(texts(first)).toContain('pages: "11-20"')
      const measured = (first.result.content as any[]).reduce((n, c) => n + (c.type === 'image' ? imageTokens(Buffer.from(c.data, 'base64')) : textTokens(c.text)), 0)
      expect(measured).toBeLessThanOrEqual(READ_OUTPUT_TOKENS)
      expect(h.ctx.files.imageCount).toBe(10)
      const rest = await h.call('read', { file_path: `${ALICE}/twenty-scans.pdf`, pages: '11-20' })
      expect(images(rest)).toHaveLength(10)
      expect(texts(rest)).not.toContain('Not shown in this read')
    } finally { page.mockRestore() }
  })

  test.skipIf(!pageRenderer)('line reads name the scanned pages to read as images', async () => {
    const r = await handler('alice', A.turn('alice', A.chat('alice'))).call('read', { file_path: `${ALICE}/mixed.pdf`, offset: 1 })
    expect(texts(r)).toContain('Pages without a text layer (scans or pictures): 2.')
    expect(texts(r)).toContain('pages: "2"')
    expect(images(r)).toEqual([])
  })
})

describe('per-turn image budget', () => {
  test(`at most ${VISION_TURN_IMAGES} images or ${VISION_TURN_BYTES / 1024 / 1024} MB per turn; then a note, no image`, async () => {
    const h = handler('alice', A.turn('alice', A.chat('alice')))
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(fakeJpeg)
    try {
      h.ctx.files.imageCount = VISION_TURN_IMAGES - 1
      expect(images(await h.call('read', { file_path: `${ALICE}/photo.png` }))).toHaveLength(1)
      const full = await h.call('read', { file_path: `${ALICE}/photo.png` })
      expect(images(full)).toEqual([])
      expect(texts(full)).toContain('image limit')
      expect(codec.mock.calls.length).toBe(1) // nothing converted once the budget is used up
      const h2 = handler('alice', A.turn('alice', A.chat('alice')))
      h2.ctx.files.imageBytes = VISION_TURN_BYTES - 2
      const over = await h2.call('read', { file_path: `${ALICE}/photo.png` })
      expect(images(over)).toEqual([])
      expect(texts(over)).toContain('image limit')
    } finally { codec.mockRestore() }
  })

  test.skipIf(!pageRenderer)('a PDF read stops adding page images at the budget and says so for the rest', async () => {
    put(`${ALICE}/scans.pdf`, makePagesPdf(Array.from({ length: 4 }, () => ({ image: CCITT_SCAN }))))
    const h = handler('alice', A.turn('alice', A.chat('alice')))
    const page = spyOn(A.ctx.files, 'pdfPageImage').mockResolvedValue(fakeJpeg)
    try {
      h.ctx.files.imageCount = VISION_TURN_IMAGES - 2
      const r = await h.call('read', { file_path: `${ALICE}/scans.pdf` })
      expect(images(r)).toHaveLength(2)
      expect(texts(r).match(/image limit/g)).toHaveLength(2)
      expect(page.mock.calls.length).toBe(2)
    } finally { page.mockRestore() }
  })
})

describe('access: denied files, revocation and replacement before delivery', () => {
  test('a file the person cannot read: denied, nothing converted', async () => {
    put('groups/finance/receipt.png', makePng(16, 16))
    put('groups/finance/statement.pdf', makePagesPdf([{ image: CCITT_SCAN }]))
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(fakeJpeg)
    const page = spyOn(A.ctx.files, 'pdfPageImage').mockResolvedValue(fakeJpeg)
    try {
      for (const [file, args] of [['groups/finance/receipt.png', {}], ['groups/finance/statement.pdf', { pages: '1' }], ['users/bob/../bob/x.png', {}]] as const) {
        const r = await handler('alice', A.turn('alice', A.chat('alice'))).call('read', { file_path: file, ...args })
        expect(r.result.isError, file).toBe(true)
        expect(texts(r)).toContain('Access denied')
        expect(images(r)).toEqual([])
      }
      expect(codec).not.toHaveBeenCalled()
      expect(page).not.toHaveBeenCalled()
    } finally { codec.mockRestore(); page.mockRestore() }
  })

  test('membership removed while the image converts: not delivered', async () => {
    const h = handler('bob', A.turn('bob', A.chat('bob')))
    const codec = spyOn(A.ctx.files, 'modelImage').mockImplementation(async () => {
      A.ctx.db.query("DELETE FROM group_members WHERE user_id='bob' AND group_id='finance'").run()
      return fakeJpeg
    })
    try {
      const r = await h.call('read', { file_path: 'groups/finance/receipt.png' })
      expect(r.result.isError).toBe(true)
      expect(images(r)).toEqual([])
      expect(h.ctx.files.readPaths.has('groups/finance/receipt.png')).toBe(false)
    } finally {
      codec.mockRestore()
      A.ctx.db.query("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES ('finance', 'bob')").run()
    }
  })

  test('account disabled or file replaced while converting: not delivered (images and PDF pages)', async () => {
    const h = handler('alice', A.turn('alice', A.chat('alice')))
    let codec = spyOn(A.ctx.files, 'modelImage').mockImplementation(async () => {
      A.ctx.db.query("UPDATE users SET status='disabled' WHERE id='alice'").run()
      return fakeJpeg
    })
    try {
      const r = await h.call('read', { file_path: `${ALICE}/photo.png` })
      expect(r.result.isError).toBe(true)
      expect(images(r)).toEqual([])
    } finally { codec.mockRestore(); A.ctx.db.query("UPDATE users SET status='active' WHERE id='alice'").run() }
    codec = spyOn(A.ctx.files, 'modelImage').mockImplementation(async () => { put(`${ALICE}/photo.png`, makePng(32, 32)); return fakeJpeg })
    try {
      const r = await h.call('read', { file_path: `${ALICE}/photo.png` })
      expect(r.result.isError).toBe(true)
      expect(images(r)).toEqual([])
    } finally { codec.mockRestore() }
    if (!pageRenderer) return
    const page = spyOn(A.ctx.files, 'pdfPageImage').mockImplementation(async () => { put(`${ALICE}/scan.pdf`, makePagesPdf([{ image: CCITT_SCAN }, { image: CCITT_SCAN }])); return fakeJpeg })
    try {
      const r = await h.call('read', { file_path: `${ALICE}/scan.pdf` })
      expect(r.result.isError).toBe(true)
      expect(images(r)).toEqual([])
    } finally { page.mockRestore() }
  })

  test('revocation while the answer waits in the socket buffer: the queued image is dropped', async () => {
    const ctx = A.toolCtx('bob', A.turn('bob', A.chat('bob')))
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(fakeJpeg)
    let out: any
    try { out = await A.ctx.files.read(ctx, { file_path: 'groups/finance/receipt.png' }) } finally { codec.mockRestore() }
    expect(out.content.some((c: any) => c.type === 'image')).toBe(true)
    let writes = 0, closed = false
    const socket = { data: { out: [], stage: 'mcp' }, write() { writes++; return 0 }, end() { closed = true } }
    send(socket, JSON.stringify(out.content), out.beforeDelivery)
    expect(socket.data.out.length).toBe(1)
    A.ctx.db.query("DELETE FROM group_members WHERE user_id='bob' AND group_id='finance'").run()
    try {
      flush(socket)
      expect(writes).toBe(1)
      expect(closed).toBe(true)
      expect(socket.data.out).toEqual([])
    } finally { A.ctx.db.query("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES ('finance', 'bob')").run() }
  })

  test('quarantined (download-only) bytes are refused before any conversion', async () => {
    const bytes = Buffer.from(makePng(20, 20, [1, 2, 3]))
    put(`${ALICE}/generated.png`, bytes)
    A.ctx.files.quarantine.add(bytes, 'image')
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(fakeJpeg)
    try {
      const r = await handler('alice', A.turn('alice', A.chat('alice'))).call('read', { file_path: `${ALICE}/generated.png` })
      expect(r.result.isError).toBe(true)
      expect(codec).not.toHaveBeenCalled()
    } finally { codec.mockRestore(); A.ctx.db.query('DELETE FROM safe_ops_artifacts').run() }
  })
})

describe('no pixels: team switch off, the API engine, a connection without a turn', () => {
  test('switch off: no image block; Mac reads the text with Apple Vision, Linux gives a note', async () => {
    setVision(false)
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(fakeJpeg)
    const page = spyOn(A.ctx.files, 'pdfPageImage').mockResolvedValue(fakeJpeg)
    const ocr = A.ctx.files.cfg.ocr
    try {
      A.ctx.files.cfg.ocr = null
      const h = handler('alice', A.turn('alice', A.chat('alice')))
      const r = await h.call('read', { file_path: `${ALICE}/photo.png` })
      expect(images(r)).toEqual([])
      expect(texts(r)).toContain('does not send images to the AI')
      expect(h.ctx.files.readPaths.has(`${ALICE}/photo.png`)).toBe(false)
      if (pageRenderer) {
        const pdf = await h.call('read', { file_path: `${ALICE}/mixed.pdf` })
        expect(images(pdf)).toEqual([])
        expect(texts(pdf)).toContain('Page one has a real text layer')
        expect(texts(pdf)).toContain('Pages without a text layer (scans or pictures): 2.')
        expect(texts(pdf)).toContain('does not send images to the AI')
      }
      expect(codec).not.toHaveBeenCalled()
      expect(page).not.toHaveBeenCalled()
    } finally { A.ctx.files.cfg.ocr = ocr; codec.mockRestore(); page.mockRestore(); setVision(true) }
  })

  test('the API engine (text only) and a connection without a chat turn get a short note (Linux; a Mac reads the text with Apple Vision)', async () => {
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(fakeJpeg)
    const ocr = A.ctx.files.cfg.ocr
    try {
      A.ctx.files.cfg.ocr = null
      const turn = A.turn('alice', A.chat('alice'))
      A.ctx.db.query("UPDATE turns SET engine='api' WHERE id=?").run(turn)
      const api = await handler('alice', turn).call('read', { file_path: `${ALICE}/photo.png` })
      expect(images(api)).toEqual([])
      expect(texts(api)).toContain('reads text only')
      A.ctx.db.query("UPDATE users SET locale = 'ko' WHERE id = 'alice'").run()
      const ko = await handler('alice', turn).call('read', { file_path: `${ALICE}/photo.png` })
      expect(texts(ko)).toContain('API 엔진')
      A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run()
      const remote = await A.ctx.files.call('read', { file_path: `${ALICE}/photo.png` }, A.toolCtx('alice', null))
      expect(remote.content).toBeUndefined()
      expect(remote.text).toContain('carries text only')
      expect(codec).not.toHaveBeenCalled()
    } finally { A.ctx.files.cfg.ocr = ocr; codec.mockRestore() }
  })

  test('the setting is ON by default and an admin can turn it off through the API', async () => {
    A.ctx.db.query("DELETE FROM settings WHERE key='aiVision'").run()
    const got = await A.json('/api/admin/settings', { as: 'carol' })
    expect(got.status).toBe(200)
    expect(got.body.aiVision).toBe(true)
    const off = await A.json('/api/admin/settings', { as: 'carol', method: 'PATCH', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: JSON.stringify({ aiVision: false }) })
    expect(off.status).toBe(200)
    expect(off.body.aiVision).toBe(false)
    const member = await A.json('/api/admin/settings', { as: 'alice', method: 'PATCH', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: JSON.stringify({ aiVision: true }) })
    expect(member.status).toBe(403)
    setVision(true)
  })
})

describe('the turn files keep image accounting per turn', () => {
  test('a new turn starts with an empty budget', () => {
    const f = new TurnFiles()
    expect([f.imageCount, f.imageBytes]).toEqual([0, 0])
  })
})

/** A w x h 8-bit grayscale PNG of zeros (zlib keeps it tiny: a decompression bomb inside the pixel limit). */
function grayPng(w: number, h: number): Buffer {
  const row = Buffer.alloc(w + 1)
  const raw = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)), { level: 9 })
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', raw), chunk('IEND', Buffer.alloc(0))])
}
