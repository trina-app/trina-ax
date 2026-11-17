// What an image read tells the AI besides the picture (AI scenario VIEW-05, 2026-11-17;
// docs/decisions/20261117-ai-facts-and-gaps.md): the picture the model gets is drawn on white (mycel-safeops vision) and
// a size read off it is a guess, so asked "is the seal's background transparent, and how big is it?" the AI answered
// "about 600 x 600" and stamped a test PDF nobody asked for. The result now names the format, the size in pixels and
// whether the file has see-through parts, read from the file itself. The ffmpeg look is skipped where there is none.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { which } from '../../server/src/config'
import { imageFactsLine, imageFormat, seeThrough } from '../../server/src/uploads/image'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp } from '../lib/c-app'
import { makeJpeg, makePng, makeWebp, pngRgbaOf } from '../lib/images'

setDefaultTimeout(60_000)
const ffmpeg = which('ffmpeg')
const PHOTO = fs.readFileSync(path.join(import.meta.dir, '../fixtures/exif/portrait-o6.jpg'))
const RED = [210, 30, 30, 255] as const
const CLEAR = [0, 0, 0, 0] as const
/** a red ring on nothing: the corners and the middle see-through */
const seal = (n = 120) => pngRgbaOf(n, n, (x, y) => { const d = Math.hypot(x - n / 2, y - n / 2); return d < n * 0.45 && d > n * 0.3 ? RED : CLEAR })
/** an opaque square with a see-through hole in the middle: see-through, but not the background */
const holed = (n = 120) => pngRgbaOf(n, n, (x, y) => (Math.hypot(x - n / 2, y - n / 2) < n * 0.2 ? CLEAR : RED))
/** an alpha channel with every pixel opaque */
const opaqueRgba = (n = 40) => pngRgbaOf(n, n, () => RED)

describe('the facts, from the file itself', () => {
  test('format by the first bytes, never the name', () => {
    expect(imageFormat(makePng(4, 4))).toBe('PNG')
    expect(imageFormat(makeJpeg(4, 4))).toBe('JPEG')
    expect(imageFormat(makeWebp(4, 4))).toBe('WebP')
    expect(imageFormat(Buffer.from('GIF89a......'))).toBe('GIF')
    expect(imageFormat(Buffer.from('not a picture'))).toBeNull()
  })
  test('one line: format, size in pixels, see-through parts; only what is known', () => {
    expect(imageFactsLine(makePng(600, 600), 'background')).toBe('Read from the file itself: PNG, 600 × 600 pixels, see-through background (shown white in your picture of it). Say these as facts when asked.')
    expect(imageFactsLine(makePng(64, 48), 'some')).toContain('PNG, 64 × 48 pixels, some see-through parts, not the background')
    // the size as shown: a phone photo stored 64 x 48 with EXIF orientation 6 is 48 x 64 upright
    expect(imageFactsLine(PHOTO, 'none')).toContain('JPEG, 48 × 64 pixels, no see-through parts.')
    // not looked at: the size alone, never a guess about transparency
    expect(imageFactsLine(makePng(10, 10), null)).toBe('Read from the file itself: PNG, 10 × 10 pixels. Say these as facts when asked.')
    expect(imageFactsLine(Buffer.from('nothing'), null)).toBe('')
  })
  test('pictures that cannot have see-through pixels need no look: JPEG, a PNG without alpha', async () => {
    expect(await seeThrough(makeJpeg(8, 8), { ffmpeg: null })).toBe('none')
    expect(await seeThrough(makePng(8, 8), { ffmpeg: null })).toBe('none')
    // one that can, with no ffmpeg here: unknown, not "none"
    expect(await seeThrough(seal(), { ffmpeg: null })).toBeNull()
    expect(await seeThrough(Buffer.from('nothing'), { ffmpeg: null })).toBeNull()
  })
  test.skipIf(!ffmpeg)('the pixels decide: a seal on nothing, a hole in the middle, an alpha channel all opaque', async () => {
    expect(await seeThrough(seal())).toBe('background')
    expect(await seeThrough(holed())).toBe('some')
    // an alpha channel the look finds all opaque: "the background is not see-through", never "none" (one see-through
    // pixel in a big picture averages away)
    expect(await seeThrough(opaqueRgba())).toBe('opaque')
    expect(imageFactsLine(opaqueRgba(), 'opaque')).toContain('the background is not see-through')
    // half see-through everywhere: the background is see-through too
    expect(await seeThrough(pngRgbaOf(40, 40, () => [210, 30, 30, 128]))).toBe('background')
  })
  test('a picture too large to look at is not looked at (ffmpeg decodes it whole)', async () => {
    // an RGBA header that says 10000 x 10000: refused before any run (the ffmpeg given does not exist)
    const big = Buffer.from(pngRgbaOf(4, 4, () => CLEAR)); big.writeUInt32BE(10000, 16); big.writeUInt32BE(10000, 20)
    expect(await seeThrough(big, { ffmpeg: '/nonexistent/ffmpeg' })).toBeNull()
  })
})

describe('an image read carries the facts', () => {
  let A: CApp
  const put = (rel: string, b: Uint8Array) => { fs.mkdirSync(path.dirname(path.join(A.team, rel)), { recursive: true }); fs.writeFileSync(path.join(A.team, rel), b) }
  beforeAll(async () => {
    A = await makeCApp('image-read-facts')
    put('users/alice/seal.png', seal(600))
  }, 120_000)
  afterAll(async () => { await A?.close() }, 120_000)

  test('format, size and see-through parts after "shown below"; the picture still goes', async () => {
    const chat = A.chat('alice'), ctx = A.toolCtx('alice' as any, A.turn('alice', chat))
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(jpeg)
    const look = spyOn(A.ctx.files, 'seeThrough').mockResolvedValue('background')
    try {
      const r: any = await makeHandler(A.ctx.files, A.ctx.db, ctx)({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { file_path: 'users/alice/seal.png' } } })
      const text = (r.result.content as any[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      expect(text).toContain('(shown below). Read from the file itself: PNG, 600 × 600 pixels, see-through background')
      expect((r.result.content as any[]).filter((c) => c.type === 'image')).toHaveLength(1)
      expect(look).toHaveBeenCalledTimes(1)
    } finally { codec.mockRestore(); look.mockRestore() }
  })
  test('the look failing costs only that part', async () => {
    const chat = A.chat('alice'), ctx = A.toolCtx('alice' as any, A.turn('alice', chat))
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const look = spyOn(A.ctx.files, 'seeThrough').mockRejectedValue(new Error('ffmpeg broke'))
    try {
      const r: any = await makeHandler(A.ctx.files, A.ctx.db, ctx)({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { file_path: 'users/alice/seal.png' } } })
      const text = (r.result.content as any[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      expect(r.result.isError).toBeUndefined()
      expect(text).toContain('Read from the file itself: PNG, 600 × 600 pixels. Say these')
      expect(text).not.toContain('see-through')
    } finally { codec.mockRestore(); look.mockRestore() }
  })
})
