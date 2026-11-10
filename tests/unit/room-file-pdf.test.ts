// A PDF sent in a room, read by room_file the way a team-folder read gives a PDF (chat/room-tools.ts readRoomFileFor
// and roomPdf, files/service.ts pdfPagesForModel; docs/DECISIONS.md "room_file reads a scanned PDF's pages"): the text
// layer per page, pages without one as page images, `pages` and `as_images`, the tool output limit, the turn's image
// budget shared with team reads, the team switch and the engine. The room checks stay as they were (a member now, the
// message visible and not deleted, not a hidden answer, not on the safety check's list, the account as it is now) and
// are run again before the result goes out and at the socket's drain. Real text layers (pdftotext, or PDFKit on a Mac
// without poppler); page images from the real converters in one test, a stand-in JPEG elsewhere. Synthetic people only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { makeCApp, jsonBody, type CApp, type Person } from '../lib/c-app'
import { makePng } from '../lib/images'
import { CCITT_SCAN, makePagesPdf, makePdf } from '../lib/pdf'
import { makeHandler } from '../../server/src/mcp/protocol'
import { send, flush } from '../../server/src/mcp/socket'
import { nativeBinDir, ocrBin, which } from '../../server/src/config'
import { isolation } from '../../server/src/tools/isolate'
import { imageTokens, READ_OUTPUT_TOKENS, textTokens, VISION_SIDE_MAX, VISION_TURN_IMAGES, visionTools } from '../../server/src/files/vision'
import { TurnFiles } from '../../server/src/files/service'
import { roomFilesOf } from '../../server/src/rooms/files'
import { readRoomFileFor, ROOM_SESSION_TOOL_DESCRIPTIONS, ROOM_TOOL_DESCRIPTIONS, type RoomFileArgs, type RoomFileReader } from '../../server/src/chat/room-tools'
import { RoomFileHereInput, RoomFileInput } from '@mycel/shared'
import type { McpContent, TurnToolSet } from '../../server/src/turns'

setDefaultTimeout(60_000)
const HOOK_MS = 120_000
let A: CApp
const TOOLS = visionTools({ nativeBin: nativeBinDir(), pdftotext: which('pdftotext'), ocr: ocrBin(), which })
/** a text layer can be read here (pdftotext, or PDFKit on a Mac without poppler), in the converter isolation */
const layers = isolation() !== 'none' && !!(TOOLS.pdftotext || TOOLS.pdfkit)
/** and pages can be drawn and normalized for real */
const pageRenderer = layers && !!TOOLS.normalizer && !!(TOOLS.pdfkit || TOOLS.pdftoppm)
const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
/** an A4 page drawn at 1568 px as the frame header says: 1109 x 1568 (2,319 tokens) */
const a4 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x20, 0x04, 0x55]), Buffer.alloc(14), Buffer.from([0xff, 0xd9])])
const cm = () => 'cm-' + crypto.randomUUID()

const TEXT = makePdf(['Quarterly report 2026', 'Revenue grew by 12 percent in the third quarter.'])
const SCAN = makePagesPdf([{ image: CCITT_SCAN }])
const MIXED = makePagesPdf([{ lines: ['Page one has a real text layer with enough words.'] }, { image: CCITT_SCAN }, { lines: ['Page three is text again, also with enough words.'] }])
let roomId = ''
const file: Record<string, string> = {}

/** a file `user` sends in the room with a message; its id */
async function sendFile(user: Person, room: string, name: string, bytes: Uint8Array | string): Promise<{ id: string; message: string }> {
  const src = path.join(A.data, `upload-${crypto.randomUUID()}`)
  fs.writeFileSync(src, bytes)
  const f = await roomFilesOf(A.ctx).create(user, room, name, src, createHash('sha256').update(bytes).digest('hex'))
  const m = await A.json(`/api/rooms/${room}/messages`, { as: user, ...jsonBody({ body: name, clientMessageId: cm(), mentions: [], fileIds: [f.id] }) })
  expect(m.status, JSON.stringify(m.body)).toBe(201)
  return { id: f.id, message: m.body.id }
}

beforeAll(async () => {
  A = await makeCApp('room-file-pdf')
  A.ctx.db.query("UPDATE users SET locale = 'en'").run()
  const r = await A.json('/api/rooms', { as: 'alice', ...jsonBody({ kind: 'group', userIds: ['bob', 'carol'], name: 'pdf check' }) })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  roomId = r.body.id
  for (const [name, bytes] of [['text.pdf', TEXT], ['scan.pdf', SCAN], ['mixed.pdf', MIXED], ['notes.md', '# Notes\nship on Monday\n']] as const) file[name] = (await sendFile('bob', roomId, name, bytes)).id
  fs.mkdirSync(path.join(A.team, 'users/alice'), { recursive: true })
  fs.writeFileSync(path.join(A.team, 'users/alice/photo.png'), makePng(64, 48))
}, HOOK_MS)
afterAll(async () => { await A?.close() }, HOOK_MS)

/** the reader a chat turn builds (chat/room-tools.ts readRoomFile): the person as they are now, the turn's files */
function reader(user: Person, files = new TurnFiles(), turnId: string | null = A.turn(user, A.chat(user))): RoomFileReader {
  return {
    ctx: A.ctx, userId: user, timeZone: 'UTC', signal: new AbortController().signal,
    toolCtx: () => ({ user: A.ctx.files.principal(user), turnId, files }),
    seen: () => {}, canSave: true, pdfPages: true,
  }
}
const read = (r: RoomFileReader, a: Omit<RoomFileArgs, 'room'> & { room?: string }) => readRoomFileFor(r, { room: roomId, ...a }, () => {})
const images = (out: { content: McpContent[] }) => out.content.filter((c) => c.type === 'image')
const texts = (out: { content: McpContent[] }) => out.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
const setVision = (on: boolean) => A.ctx.db.query("INSERT INTO settings (key, value) VALUES ('aiVision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(on))
/** the page renderer replaced by a stand-in JPEG (or `f`), restored after */
async function withPages<T>(jpeg: Buffer | (() => Promise<Buffer>), f: (calls: () => number) => Promise<T>): Promise<T> {
  const page = typeof jpeg === 'function' ? spyOn(A.ctx.files, 'pdfPageImage').mockImplementation(jpeg) : spyOn(A.ctx.files, 'pdfPageImage').mockResolvedValue(jpeg)
  try { return await f(() => page.mock.calls.length) } finally { page.mockRestore() }
}

describe('the tool contract', () => {
  test('room_file takes pages and as_images in both chats; the descriptions say scanned pages come as images', () => {
    for (const s of [RoomFileInput, RoomFileHereInput]) {
      expect(s.safeParse({ room: roomId, file: 'x', pages: '1-3', as_images: true }).success || s.safeParse({ file: 'x', pages: '1-3', as_images: true }).success).toBe(true)
    }
    for (const d of [ROOM_TOOL_DESCRIPTIONS.room_file, ROOM_SESSION_TOOL_DESCRIPTIONS.room_file]) {
      expect(d).toContain('pages without a text layer (scans) as images')
      expect(d).not.toContain('scanned pages have none')
    }
  })
})

describe.skipIf(!layers)('a PDF sent in a room, as a read gives it', () => {
  test('a scanned PDF gives its page as an image; a text PDF text only; a mixed PDF both, in page order', async () => {
    const files = new TurnFiles()
    const r = reader('alice', files)
    await withPages(fakeJpeg, async (calls) => {
      const text = await read(r, { file: file['text.pdf']! })
      expect(text.isError).toBeUndefined()
      expect(texts(text)).toContain('--- Page 1 ---')
      expect(texts(text)).toContain('Revenue grew by 12 percent')
      expect(images(text)).toEqual([])
      expect(calls()).toBe(0)
      expect(text.summary).toBe('room_file -> PDF pages 1 of 1, 0 images')

      const scan = await read(r, { file: file['scan.pdf']! })
      expect(scan.isError).toBeUndefined()
      expect(images(scan)).toEqual([{ type: 'image', mimeType: 'image/jpeg', data: fakeJpeg.toString('base64') }])
      expect(texts(scan)).toContain('--- Page 1 (no text layer: shown as an image) ---')
      // the file's framing holds the pages: the head first, </room_file> after the last page
      expect(scan.content[0]!.type === 'text' && scan.content[0]!.text).toContain('sent by Bob')
      expect(scan.content[0]!.type === 'text' && scan.content[0]!.text).toContain('<room_file name="scan.pdf" pages="1">')
      expect(scan.content.at(-1)).toEqual({ type: 'text', text: '</room_file>' })
      // the audit line names no file
      expect(scan.summary).toBe('room_file -> PDF pages 1 of 1, 1 image')

      const mixed = await read(r, { file: file['mixed.pdf']! })
      expect(mixed.content.map((c) => c.type)).toEqual(['text', 'image', 'text'])
      expect(texts(mixed)).toContain('Page one has a real text layer')
      expect(texts(mixed)).toContain('--- Page 2 (no text layer: shown as an image) ---')
      expect(mixed.content[2]!.type === 'text' && mixed.content[2]!.text).toContain('Page three is text again')
      expect(calls()).toBe(2)
    })
    expect(files.imageCount).toBe(2)
  })

  test.skipIf(!pageRenderer)('the real converters draw the scanned page (A4 portrait, 1568 px)', async () => {
    const out = await read(reader('alice'), { file: file['mixed.pdf']! })
    const img = images(out)[0] as { data: string } | undefined
    expect(img, texts(out)).toBeDefined()
    const b = Buffer.from(img!.data, 'base64')
    let size: { w: number; h: number } | null = null
    for (let p = 2; p + 9 < b.length;) {
      const m = b[p + 1]!
      if (m >= 0xc0 && m <= 0xc3) { size = { h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) }; break }
      p += 2 + b.readUInt16BE(p + 2)
    }
    expect(Math.max(size!.w, size!.h)).toBe(VISION_SIDE_MAX)
    expect(size!.h).toBeGreaterThan(size!.w)
  })

  test('pages and as_images as for read; offset gives the text and names the scanned pages; a long PDF needs pages', async () => {
    const r = reader('alice')
    await withPages(fakeJpeg, async (calls) => {
      const one = await read(r, { file: file['mixed.pdf']!, pages: '1', as_images: true })
      expect(images(one)).toHaveLength(1)
      expect(texts(one)).toContain('--- Page 1 as an image ---')
      expect(texts(one)).toContain('pages 1 below')
      expect(texts(one)).not.toContain('Page three')
      const past = await read(r, { file: file['mixed.pdf']!, pages: '4' })
      expect(past.isError).toBe(true)
      expect(texts(past)).toContain('past the end: this PDF has 3 pages')
      const bad = await read(r, { file: file['mixed.pdf']!, pages: 'two' })
      expect(texts(bad)).toContain('pages must look like')
      // not a PDF: refused before the file is read
      const md = await read(r, { file: file['notes.md']!, pages: '1' })
      expect(md.isError).toBe(true)
      expect(texts(md)).toContain('pages and as_images are only for PDF files')
      // offset: the text as before (characters), the scanned page named with the pages to read it by
      const lines = await read(r, { file: file['mixed.pdf']!, offset: 0 })
      expect(images(lines)).toEqual([])
      expect(texts(lines)).toContain('Page three is text again')
      expect(texts(lines)).toContain('Pages without a text layer (scans or pictures): 2.')
      expect(texts(lines)).toContain('pages: "2"')
      expect(lines.summary).toBe(`room_file -> PDF text ${texts(lines).match(/<room_file[^>]*>\n([\s\S]*)\n<\/room_file>/)![1]!.length} characters, 1 page without text`)
      expect(calls()).toBe(1)
    })
    const long = (await sendFile('carol', roomId, 'long.pdf', makePagesPdf(Array.from({ length: 12 }, (_, i) => (i === 7 ? { image: CCITT_SCAN } : { lines: [`Chapter ${i + 1}: a page of the twelve page manual.`] }))))).id
    await withPages(fakeJpeg, async (calls) => {
      // without pages: the text, naming the page without a text layer
      const whole = await read(r, { file: long })
      expect(images(whole)).toEqual([])
      expect(texts(whole)).toContain('Chapter 12:')
      expect(texts(whole)).toContain('Pages without a text layer (scans or pictures): 8.')
      expect(texts(whole)).toContain('pages: "8"')
      // as_images on all of it: pages first, as read asks for them
      const all = await read(r, { file: long, as_images: true })
      expect(all.isError).toBe(true)
      expect(texts(all)).toContain('This PDF has 12 pages: read it in parts with pages')
      const eight = await read(r, { file: long, pages: '7-8' })
      expect(eight.content.map((c) => c.type)).toEqual(['text', 'image', 'text'])
      expect(texts(eight)).toContain('Chapter 7:')
      expect(calls()).toBe(1)
    })
  })

  test('page images that would pass the tool output limit wait for the next call, which reads them', async () => {
    expect(imageTokens(a4)).toBe(2319)
    const twenty = (await sendFile('bob', roomId, 'twenty-scans.pdf', makePagesPdf(Array.from({ length: 20 }, () => ({ image: CCITT_SCAN }))))).id
    const r = reader('alice')
    await withPages(a4, async (calls) => {
      const first = await read(r, { file: twenty, pages: '1-20' })
      expect(first.isError).toBeUndefined()
      const shown = images(first).length
      expect(shown).toBeGreaterThanOrEqual(9)
      expect(shown).toBeLessThan(20)
      expect(calls()).toBe(shown + 1) // the one that did not fit; nothing converted after it
      expect(texts(first)).toContain(`Not shown in this read: the images of pages ${shown + 1}-20`)
      expect(texts(first)).toContain(`pages: "${shown + 1}-20"`)
      // the whole result, the room's head and framing too, as the engine counts it
      const measured = first.content.reduce((n, c) => n + (c.type === 'image' ? imageTokens(Buffer.from((c as { data: string }).data, 'base64')) : textTokens((c as { text: string }).text)), 0)
      expect(measured).toBeLessThanOrEqual(READ_OUTPUT_TOKENS)
      // the notes come after the file's framing
      expect(texts(first).indexOf('</room_file>')).toBeLessThan(texts(first).indexOf('Not shown in this read'))
      const rest = await read(r, { file: twenty, pages: `${shown + 1}-20` })
      expect(images(rest)).toHaveLength(20 - shown)
    })
  })
})

describe.skipIf(!layers)('no pixels where a read sends none', () => {
  test('image viewing off: no page image, the same note as a read (Linux), or Apple Vision text (a Mac)', async () => {
    setVision(false)
    try {
      await withPages(fakeJpeg, async (calls) => {
        const ocr = A.ctx.files.cfg.ocr
        try {
          A.ctx.files.cfg.ocr = null
          const out = await read(reader('alice'), { file: file['mixed.pdf']! })
          expect(images(out)).toEqual([])
          expect(texts(out)).toContain('Page one has a real text layer')
          expect(texts(out)).toContain('Pages without a text layer (scans or pictures): 2.')
          expect(texts(out)).toContain('does not send images to the AI')
          const text = await read(reader('alice'), { file: file['mixed.pdf']!, offset: 0 })
          expect(texts(text)).toContain('Pages without a text layer (scans or pictures): 2. This team does not send images to the AI')
        } finally { A.ctx.files.cfg.ocr = ocr }
        if (ocr) {
          // a Mac reads the scanned page with Apple Vision, as a team read does: text, never pixels
          const mac = await read(reader('alice'), { file: file['scan.pdf']! })
          expect(images(mac)).toEqual([])
          expect(texts(mac)).toContain('Page 1 (scanned; recognized text):')
        }
        expect(calls()).toBe(0)
      })
    } finally { setVision(true) }
  })

  test('the API engine and a connection without a chat turn get the note', async () => {
    const ocr = A.ctx.files.cfg.ocr
    A.ctx.files.cfg.ocr = null
    try {
      await withPages(fakeJpeg, async (calls) => {
        const turn = A.turn('alice', A.chat('alice'))
        A.ctx.db.query("UPDATE turns SET engine = 'api' WHERE id = ?").run(turn)
        const api = await read(reader('alice', new TurnFiles(), turn), { file: file['scan.pdf']! })
        expect(images(api)).toEqual([])
        expect(texts(api)).toContain('reads text only')
        const none = await read(reader('alice', new TurnFiles(), null), { file: file['scan.pdf']! })
        expect(images(none)).toEqual([])
        expect(texts(none)).toContain('carries text only')
        expect(calls()).toBe(0)
      })
    } finally { A.ctx.files.cfg.ocr = ocr }
  })
})

describe.skipIf(!layers)('the room checks, as before, and again before delivery', () => {
  test('not a member, a deleted file, a hidden answer and a held file: the same refusals, nothing converted', async () => {
    await withPages(fakeJpeg, async (calls) => {
      // dana is not in the room: no such file for her (the same words as an unknown one)
      const outsider = await read(reader('dana'), { file: file['scan.pdf']! })
      expect(images(outsider)).toEqual([])
      expect(texts(outsider)).toContain('No room')
      // a deleted message takes its files
      const gone = await sendFile('bob', roomId, 'gone.pdf', SCAN)
      expect((await A.req(`/api/rooms/${roomId}/messages/${gone.message}`, { as: 'bob', method: 'DELETE' })).status).toBe(204)
      const deleted = await read(reader('alice'), { file: gone.id })
      expect(texts(deleted)).toContain(`No file "${gone.id}" in that room that the user can see`)
      // an old answer hidden from alice (rooms/history.ts) is withheld, its files with it
      const hidden = await sendFile('bob', roomId, 'hidden.pdf', SCAN)
      const seq = (A.ctx.db.query('SELECT seq FROM room_messages WHERE id = ?').get(hidden.message) as { seq: number }).seq
      A.ctx.db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, ?)').run(roomId, 'alice', hidden.message, seq)
      const withheld = await read(reader('alice'), { file: hidden.id })
      expect(texts(withheld)).toContain(`No file "${hidden.id}" in that room that the user can see`)
      // bob, who sent it, still reads it
      expect(images(await read(reader('bob'), { file: hidden.id }))).toHaveLength(1)
      // the safety check's list
      const bytes = makePagesPdf([{ image: CCITT_SCAN }, { lines: ['held by the safety check, with enough words'] }])
      const held = await sendFile('bob', roomId, 'held.pdf', bytes)
      A.ctx.files.quarantine.add(bytes, 'image')
      try {
        const out = await read(reader('alice'), { file: held.id, pages: '1' })
        expect(out.isError).toBe(true)
        expect(texts(out)).toContain("This file is held by the team's safety check, so it cannot be read here.")
        expect(texts(out)).not.toContain('held by the safety check, with enough words')
        expect(images(out)).toEqual([])
      } finally { A.ctx.db.query('DELETE FROM safe_ops_artifacts').run() }
      expect(calls()).toBe(1) // bob's own read only
    })
  })

  test('taken out of the room, the message deleted, the file held or the account disabled while the pages convert: nothing goes', async () => {
    const changes: [string, () => void | Promise<void>, () => void][] = [
      ['left the room', () => { A.ctx.db.query("DELETE FROM room_members WHERE room_id = ? AND user_id = 'carol'").run(roomId) }, () => { A.ctx.db.query("INSERT INTO room_members (room_id, user_id, joined_at, last_read_seq, visible_from_seq) VALUES (?, 'carol', '2026-01-01T00:00:00.000Z', 0, 0)").run(roomId) }],
      ['account disabled', () => { A.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'carol'").run() }, () => { A.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'carol'").run() }],
      ['held', () => { A.ctx.files.quarantine.add(SCAN, 'image') }, () => { A.ctx.db.query('DELETE FROM safe_ops_artifacts').run() }],
    ]
    for (const [why, change, undo] of changes) {
      const f = await sendFile('bob', roomId, `during-${why.replace(/ /g, '-')}.pdf`, SCAN)
      try {
        await withPages(async () => { await change(); return fakeJpeg }, async (calls) => {
          const out = await read(reader('carol'), { file: f.id })
          expect(calls(), why).toBe(1)
          expect(out.isError, why).toBe(true)
          expect(texts(out), why).toBe('Access changed during the call. Please retry.')
          expect(images(out), why).toEqual([])
          expect(out.beforeDelivery).toBeUndefined()
        })
      } finally { undo() }
    }
    // the message deleted by its sender while it converts
    const f = await sendFile('bob', roomId, 'deleted-during.pdf', SCAN)
    await withPages(async () => { await A.req(`/api/rooms/${roomId}/messages/${f.message}`, { as: 'bob', method: 'DELETE' }); return fakeJpeg }, async () => {
      const out = await read(reader('carol'), { file: f.id })
      expect(texts(out)).toBe('Access changed during the call. Please retry.')
      expect(images(out)).toEqual([])
    })
  })

  test('a result waiting in the socket buffer is dropped when the person leaves the room meanwhile', async () => {
    const f = await sendFile('bob', roomId, 'queued.pdf', SCAN)
    const out = await withPages(fakeJpeg, () => read(reader('carol'), { file: f.id }))
    expect(images(out)).toHaveLength(1)
    expect(out.beforeDelivery).toBeDefined()
    let writes = 0, closed = false
    const socket = { data: { out: [], stage: 'mcp' }, write() { writes++; return 0 }, end() { closed = true } }
    send(socket as any, JSON.stringify(out.content), out.beforeDelivery)
    A.ctx.db.query("DELETE FROM room_members WHERE room_id = ? AND user_id = 'carol'").run(roomId)
    try {
      flush(socket as any)
      expect(writes).toBe(1)
      expect(closed).toBe(true)
      expect(socket.data.out).toEqual([])
    } finally { A.ctx.db.query("INSERT INTO room_members (room_id, user_id, joined_at, last_read_seq, visible_from_seq) VALUES (?, 'carol', '2026-01-01T00:00:00.000Z', 0, 0)").run(roomId) }
  })

  test("a chat tool's beforeDelivery runs before the result leaves the handler and goes with it to the socket", async () => {
    let ok = true
    const tools: TurnToolSet = {
      list: () => [{ name: 'room_file', description: '', inputSchema: {} }],
      has: (n) => n === 'room_file',
      async call() { return { content: [{ type: 'image', mimeType: 'image/jpeg', data: 'AAAA' }], summary: 'room_file -> PDF pages 1 of 1, 1 image', beforeDelivery: () => { if (!ok) throw new Error('changed') } } },
    }
    const call = () => makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', A.turn('alice', A.chat('alice'))), tools)({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'room_file', arguments: {} } })
    const sent = await call()
    expect(sent.result.content[0].type).toBe('image')
    expect(typeof sent.beforeDelivery).toBe('function')
    expect(JSON.parse(JSON.stringify(sent)).beforeDelivery).toBeUndefined()
    ok = false
    expect(() => sent.beforeDelivery()).toThrow()
    const refused = await call()
    expect(refused.result.isError).toBe(true)
    expect(refused.result.content.some((c: any) => c.type === 'image')).toBe(false)
  })
})

describe.skipIf(!layers)("the turn's image budget, room and team reads together", () => {
  test(`at most ${VISION_TURN_IMAGES} images a turn, whichever tool sent them`, async () => {
    const turn = A.turn('alice', A.chat('alice'))
    const ctx = A.toolCtx('alice', turn)
    const team = makeHandler(A.ctx.files, A.ctx.db, ctx)
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(fakeJpeg)
    const twoScans = (await sendFile('bob', roomId, 'two-scans.pdf', makePagesPdf([{ image: CCITT_SCAN }, { image: CCITT_SCAN }]))).id
    try {
      await withPages(fakeJpeg, async (calls) => {
        ctx.files.imageCount = VISION_TURN_IMAGES - 2
        const photo = await team({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { file_path: 'users/alice/photo.png' } } })
        expect(photo.result.content.filter((c: any) => c.type === 'image')).toHaveLength(1)
        // the room read uses the same turn's files: one page fits, the second gets the budget note
        const room = await read(reader('alice', ctx.files, turn), { file: twoScans })
        expect(images(room)).toHaveLength(1)
        expect(texts(room)).toContain('image limit')
        expect(ctx.files.imageCount).toBe(VISION_TURN_IMAGES)
        const after = await team({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { file_path: 'users/alice/photo.png' } } })
        expect(after.result.content.filter((c: any) => c.type === 'image')).toEqual([])
        expect(JSON.stringify(after.result.content)).toContain('image limit')
        // and a room read after a full turn converts nothing
        const full = await read(reader('alice', ctx.files, turn), { file: file['scan.pdf']! })
        expect(images(full)).toEqual([])
        expect(texts(full)).toContain('image limit')
        expect(calls()).toBe(1)
      })
    } finally { codec.mockRestore() }
  })
})
