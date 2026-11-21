// The AI sees a PowerPoint deck's slides as pictures (docs/decisions/20261121-ai-sees-slides.md): read, chat_file and
// room_file with `pages` (slide numbers) or `as_images` on a .pptx draw the deck as a PDF with every slide, hidden ones
// too (files/deck-pdf.ts: the office worker and the isolated headless browser), kept in memory by the deck's hash, then
// give each slide's text and picture as a PDF page with as_images. A plain read of a deck stays text. The 20-pages rule,
// pages required over 10 slides, a plain refusal where no browser runs, .ppt refused plainly, a damaged or too large deck
// refused without a crash. Draws are skipped where no browser or no page renderer runs. Synthetic content only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import { makeCApp, jsonBody, type CApp, type Person } from '../lib/c-app'
import { makeHandler } from '../../server/src/mcp/protocol'
import { nativeBinDir, ocrBin, which } from '../../server/src/config'
import { isolation } from '../../server/src/tools/isolate'
import { visionTools } from '../../server/src/files/vision'
import { TurnFiles } from '../../server/src/files/service'
import { deckPdf, deckPdfStats, forgetDeckPdfs, pagesOnlyText, slidesNotes } from '../../server/src/files/deck-pdf'
import { htmlPdfUnavailable } from '../../server/src/files/html-pdf'
import { pptxSlidesHtml } from '../../server/src/files/pptx-html'
import { roomFilesOf } from '../../server/src/rooms/files'
import { readRoomFileFor, type RoomFileReader } from '../../server/src/chat/room-tools'

setDefaultTimeout(120_000)
const HOOK_MS = 120_000
const pandoc = which('pandoc')
const TOOLS = visionTools({ nativeBin: nativeBinDir(), pdftotext: which('pdftotext'), ocr: ocrBin(), which })
/** a deck can be drawn and its pages shown here: the browser, the isolation, a page renderer and the normalizer */
const DRAWS = !!pandoc && htmlPdfUnavailable() === null && isolation() !== 'none' && !!TOOLS.normalizer && !!(TOOLS.pdfkit || TOOLS.pdftoppm) && !!(TOOLS.pdftotext || TOOLS.pdfkit)
const draws = DRAWS ? test : test.skip
const withPandoc = pandoc ? test : test.skip
const ALICE = 'users/alice'
let A: CApp

function deck(md: string): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'pptx', '-o', '-'], { stdin: Buffer.from(md) })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return new Uint8Array(r.stdout)
}
function withParts(bytes: Uint8Array, edit: Record<string, (old: string) => string>): Uint8Array {
  const c = XLSX.CFB.read(Buffer.from(bytes), { type: 'buffer' })
  for (const [name, f] of Object.entries(edit)) {
    const i = c.FullPaths.indexOf('Root Entry/' + name)
    if (i < 0) throw new Error(`no part ${name}`)
    c.FileIndex[i]!.content = Buffer.from(f(Buffer.from(c.FileIndex[i]!.content as Uint8Array).toString('utf8')), 'utf8')
  }
  return new Uint8Array(XLSX.CFB.write(c, { fileType: 'zip', type: 'buffer' }) as Buffer)
}
const slidesMd = (n: number) => Array.from({ length: n }, (_, i) => `## Slide title ${i + 1}\n\n- point ${i + 1} of the plan\n`).join('\n')
const put = (rel: string, b: Uint8Array | string) => { fs.mkdirSync(path.dirname(path.join(A.team, rel)), { recursive: true }); fs.writeFileSync(path.join(A.team, rel), b) }
const handler = (who: string) => { const ctx = A.toolCtx(who as any, A.turn(who as any, A.chat(who as any))); return { ctx, call: (name: string, args: unknown) => makeHandler(A.ctx.files, A.ctx.db, ctx)({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) } }
const images = (r: any) => (r.result.content as any[]).filter((c) => c.type === 'image')
const texts = (r: any) => (r.result.content as any[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

let three: Uint8Array
beforeAll(async () => {
  A = await makeCApp('read-pptx-slides')
  A.ctx.db.query("UPDATE users SET locale = 'en'").run()
  if (!pandoc) return
  // slide 2 hidden in the deck
  three = withParts(deck(slidesMd(3)), { 'ppt/slides/slide2.xml': (x) => x.replace('<p:sld ', '<p:sld show="0" ') })
  put(`${ALICE}/three.pptx`, three)
  put(`${ALICE}/twelve.pptx`, deck(slidesMd(12)))
  put(`${ALICE}/many.pptx`, deck(slidesMd(22)))
  put(`${ALICE}/old.ppt`, 'not really an old deck')
  put(`${ALICE}/broken.pptx`, 'PK\x03\x04 this is not a zip')
}, HOOK_MS)
afterAll(async () => { await A?.close() }, HOOK_MS)

describe('the drawing (pptx-html.ts withHidden)', () => {
  withPandoc('withHidden draws every slide and names the hidden ones; without it they are left out, as before', () => {
    const all = pptxSlidesHtml(three, { withHidden: true })
    expect(all.slides).toBe(3)
    expect(all.hidden).toBe(1)
    expect(all.hiddenSlides).toEqual([2])
    expect(all.html).toContain('Slide title 2')
    const shown = pptxSlidesHtml(three)
    expect(shown.slides).toBe(2)
    expect(shown.hiddenSlides).toBeUndefined()
    expect(shown.html).not.toContain('Slide title 2')
  })

  withPandoc('a deck over 200 slides is refused by the worker\'s drawing, not drawn', () => {
    expect(() => pptxSlidesHtml(deck(slidesMd(201)), { withHidden: true })).toThrow(/more than 200 slides/)
  })

  test('the notes say what the pictures leave out, so a grey box is never called a fault of the deck', () => {
    const notes = slidesNotes({ pdf: new Uint8Array(), pages: 3, hidden: 1, hiddenSlides: [2], notDrawn: { charts: 1, diagrams: 0, objects: 0, pictures: 0 } }, [1, 2], (p) => p.join(', '))
    expect(notes[0]).toContain('Slide 2 is hidden in the deck')
    expect(notes[1]).toContain('1 chart is drawn as a light grey box')
    expect(notes[1]).toContain('Do not report these as faults of the deck')
    expect(slidesNotes({ pdf: new Uint8Array(), pages: 3, hidden: 0, hiddenSlides: [], notDrawn: { charts: 2, diagrams: 1, objects: 0, pictures: 0 } }, [3], String)[0]).toContain('are drawn as light grey boxes')
  })
})

describe('read with pages / as_images on a .pptx', () => {
  draws('slides come as pictures with their text; page N is slide N, a hidden slide is drawn and named', async () => {
    forgetDeckPdfs()
    const h = handler('alice')
    const r = await h.call('read', { file_path: `${ALICE}/three.pptx`, pages: '1-3' })
    expect(r.result.isError, texts(r)).toBeUndefined()
    expect(images(r)).toHaveLength(3)
    for (const i of images(r)) expect(i.mimeType).toBe('image/jpeg')
    const t = texts(r)
    expect(t).toContain(`PowerPoint ${ALICE}/three.pptx: 3 slides; all slides below`)
    expect(t).toContain('Slide title 2')
    expect(t).toContain('Slide 2 is hidden in the deck')
    expect(t).toContain('Do not report these as faults of the deck')
    expect(h.ctx.files.readPaths.has(`${ALICE}/three.pptx`)).toBe(true)
    expect(h.ctx.files.imageCount).toBe(3)
  })

  draws('as_images alone on a short deck shows every slide; a second read draws nothing again (cache by hash)', async () => {
    forgetDeckPdfs()
    const before = deckPdfStats.draws
    const r1 = await handler('alice').call('read', { file_path: `${ALICE}/three.pptx`, as_images: true })
    expect(images(r1)).toHaveLength(3)
    expect(deckPdfStats.draws).toBe(before + 1)
    const r2 = await handler('alice').call('read', { file_path: `${ALICE}/three.pptx`, pages: '3' })
    expect(images(r2)).toHaveLength(1)
    expect(texts(r2)).toContain('Slide title 3')
    expect(deckPdfStats.draws).toBe(before + 1)
  })

  draws('two reads of one deck at the same time share one drawing', async () => {
    forgetDeckPdfs()
    const before = deckPdfStats.draws
    const bytes = new Uint8Array(fs.readFileSync(path.join(A.team, `${ALICE}/twelve.pptx`)))
    const [a, b] = await Promise.all([
      deckPdf(bytes, { user: 'u1', workBase: A.ctx.config.dataDir, withHidden: true }),
      deckPdf(bytes, { user: 'u2', workBase: A.ctx.config.dataDir, withHidden: true }),
    ])
    expect(a).toBe(b)
    expect(a.pages).toBe(12)
    expect(deckPdfStats.draws).toBe(before + 1)
  })

  draws('over 10 slides pages is required; at most 20 per call', async () => {
    const h = handler('alice')
    const all = await h.call('read', { file_path: `${ALICE}/twelve.pptx`, as_images: true })
    expect(all.result.isError).toBe(true)
    expect(texts(all)).toContain('has 12 slides: give pages')
    const part = await h.call('read', { file_path: `${ALICE}/twelve.pptx`, pages: '11-12' })
    expect(images(part)).toHaveLength(2)
    expect(texts(part)).toContain('slides 11-12 below')
    const many = await h.call('read', { file_path: `${ALICE}/many.pptx`, pages: '1-21' })
    expect(many.result.isError).toBe(true)
    expect(texts(many)).toContain('20')
  })

  withPandoc('a plain read of a deck stays its text, with no picture and no drawing', async () => {
    const before = deckPdfStats.draws
    const r = await handler('alice').call('read', { file_path: `${ALICE}/three.pptx` })
    expect(r.result.isError).toBeUndefined()
    expect(images(r)).toHaveLength(0)
    expect(texts(r)).toContain('Slide title 1')
    expect(deckPdfStats.draws).toBe(before)
  })

  withPandoc('a .ppt with pages is refused plainly, naming .pptx; another file still names PDF', async () => {
    const r = await handler('alice').call('read', { file_path: `${ALICE}/old.ppt`, pages: '1' })
    expect(r.result.isError).toBe(true)
    expect(texts(r)).toContain('slides of a .ppt file cannot be shown as images here')
    expect(pagesOnlyText('md')).toBe('pages and as_images are only for PDF files and PowerPoint (.pptx) decks')
  })

  draws('a damaged deck is refused with a plain message, nothing crashes', async () => {
    const r = await handler('alice').call('read', { file_path: `${ALICE}/broken.pptx`, pages: '1' })
    expect(r.result.isError).toBe(true)
    expect(texts(r)).toContain('could not be drawn as images')
    expect(texts(r)).toContain('Its text can still be read')
  })

  withPandoc('where no headless browser runs: a plain refusal that points to the text read', async () => {
    const was = process.env.MYCEL_HTML_PDF_BROWSER
    process.env.MYCEL_HTML_PDF_BROWSER = 'none'
    try {
      const r = await handler('alice').call('read', { file_path: `${ALICE}/three.pptx`, pages: '1' })
      expect(r.result.isError).toBe(true)
      expect(texts(r)).toContain('cannot be shown as images on this server')
      expect(texts(r)).toContain('never guess how a slide looks')
    } finally { if (was === undefined) delete process.env.MYCEL_HTML_PDF_BROWSER; else process.env.MYCEL_HTML_PDF_BROWSER = was }
  })
})

describe('room_file with pages on a deck sent in a room', () => {
  async function sendDeck(user: Person, name: string, bytes: Uint8Array) {
    const r = await A.json('/api/rooms', { as: 'alice', ...jsonBody({ kind: 'group', userIds: ['bob', 'carol'], name: 'deck check' }) })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const src = path.join(A.data, `upload-${crypto.randomUUID()}`)
    fs.writeFileSync(src, bytes)
    const f = await roomFilesOf(A.ctx).create(user, r.body.id, name, src, createHash('sha256').update(bytes).digest('hex'))
    const m = await A.json(`/api/rooms/${r.body.id}/messages`, { as: user, ...jsonBody({ body: name, clientMessageId: 'cm-' + crypto.randomUUID(), mentions: [], fileIds: [f.id] }) })
    expect(m.status, JSON.stringify(m.body)).toBe(201)
    return { room: r.body.id as string, file: f.id as string }
  }
  const reader = (user: Person, files = new TurnFiles()): RoomFileReader => {
    const turnId = A.turn(user, A.chat(user))
    return { ctx: A.ctx, userId: user, timeZone: 'UTC', signal: new AbortController().signal, toolCtx: () => ({ user: A.ctx.files.principal(user), turnId, files }), seen: () => {}, canSave: true, pdfPages: true }
  }

  draws('the slides come as pictures inside the room file framing', async () => {
    const { room, file } = await sendDeck('bob', 'plan.pptx', three)
    const out = await readRoomFileFor(reader('alice'), { room, file, pages: '1-2' }, () => {})
    expect(out.isError).toBeUndefined()
    expect(out.content.filter((c) => c.type === 'image')).toHaveLength(2)
    const t = out.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('\n')
    expect(t).toContain('<room_file name="plan.pptx" pages="1-2">')
    expect(t).toContain('PowerPoint "plan.pptx": 3 slides; slides 1-2 below')
    expect(t).toContain('Slide 2 is hidden in the deck')
    expect(out.summary).toBe('room_file -> slides 1-2 of 3, 2 images')
  })

  withPandoc('without pages a deck sent in a room stays text', async () => {
    const { room, file } = await sendDeck('bob', 'plan2.pptx', three)
    const out = await readRoomFileFor(reader('alice'), { room, file }, () => {})
    expect(out.content.filter((c) => c.type === 'image')).toHaveLength(0)
  })
})
