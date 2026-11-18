// Second limits audit (QA TC-4972..TC-4978, docs/decisions/20261118-audit2-file-caps.md): caps set when each tool was
// first written, raised to what memory and disk really hold. Through the tool path (the MCP handler):
// - PDF tools: a 70 MB scan is edited (40 MB per call before; the new file came back under a 64 MB answer cap);
// - resize_images: a 40 MB photo reaches the image helper (32 MB before), so a bad one is "damaged", not "too large";
// - read with versions: changes up to 40,000 characters at once (8,000 before) and an offset to read on;
// - artifact: 10 MB (2 MB before);
// - make_file: 50 charts per workbook (10 before).
// A room file over 50 MB saved by the AI: tests/unit/b-chat-rooms-save.test.ts. Team files on a mail (18 MB, 20 files):
// tests/unit/c-integrations-attach.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { concatTransformationMatrix, drawObject, PDFDocument, PDFName, PDFRawStream, popGraphicsState, pushGraphicsState } from 'pdf-lib'
import { MakeFileInput, MAKE_FILE_CHARTS_MAX } from '@mycel/shared'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, jsonBody, sha256hex, type CApp, type Person } from '../lib/c-app'
import { PDF_OUTPUT_MAX, PDF_PAGES_INPUT_MAX } from '../../server/src/files/pdf-pages'
import { STAMP_PDF_MAX } from '../../server/src/files/pdf-stamp'
import { OFFICE_WRITE_MAX } from '../../server/src/files/extract'
import { RESIZE_INPUT_MAX, RESIZE_TIMEOUT_MS } from '../../server/src/tools/resize-images'
import { VERSION_DIFF_MAX_CHARS, versionDiffPart } from '../../server/src/files/service'
import { MAX_ARTIFACT_BYTES } from '../../server/src/tools/artifact'
import { CHARTS_MAX, placeCharts } from '../../server/src/tools/xlsx-chart'

setDefaultTimeout(120_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-audit2-file-caps') })
afterAll(async () => { await A.close() })

const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array | string) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
let rpcId = 0
async function call(user: Person, name: string, args: Record<string, unknown>) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, A.turn(user, A.chat(user))))
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  const text = (r.result.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  return { text, isError: !!r.result.isError }
}
const ROOT = path.join(import.meta.dir, '..', '..')
const helper = fs.existsSync(path.join(ROOT, 'native/bin', `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`, 'mycel-safeops'))

/** a scan-like PDF of about `mb` MB: each page draws one 2 MB picture (random bytes, so nothing compresses) */
async function scanPdf(mb: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const per = 2 * 1024 * 1024
  for (let i = 0; i < Math.ceil((mb * 1024 * 1024) / per); i++) {
    const page = doc.addPage([595, 842])
    const dict = doc.context.obj({ Type: 'XObject', Subtype: 'Image', Width: 1000, Height: 1000, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', Length: per })
    page.node.setXObject(PDFName.of('Im0'), doc.context.register(PDFRawStream.of(dict, crypto.randomBytes(per))))
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(500, 0, 0, 500, 40, 40), drawObject('Im0'), popGraphicsState())
  }
  return doc.save({ useObjectStreams: false })
}

describe('PDF tools (TC-4972)', () => {
  test('the limits: 100 MB per call, the answer cap above it (64 MB for the other office tools)', () => {
    expect(PDF_PAGES_INPUT_MAX).toBe(100 * 1024 * 1024)
    expect(STAMP_PDF_MAX).toBe(PDF_PAGES_INPUT_MAX)
    expect(PDF_OUTPUT_MAX).toBeGreaterThan(PDF_PAGES_INPUT_MAX)
    expect(OFFICE_WRITE_MAX).toBe(64 * 1024 * 1024)
  })

  test('a 70 MB scan gets page numbers: the new file comes back whole', async () => {
    // the per-answer write cap (config.ts maxWriteBytesPerTurn, 50 MB on dev until PR #1284 raises it to 1 GB) is its
    // own limit, not this one
    const cfg = A.ctx.engineConfig as { maxWriteBytesPerTurn: number }
    const was = cfg.maxWriteBytesPerTurn
    cfg.maxWriteBytesPerTurn = Math.max(was, 1024 * 1024 * 1024)
    const big = await scanPdf(70)
    put('groups/marketing/pdfs/scan.pdf', big)
    const r = await call('alice', 'edit_pdf', { file_path: 'groups/marketing/pdfs/scan.pdf', operations: [{ page_numbers: {} }], output: 'groups/marketing/pdfs/scan-numbered.pdf' })
    expect(r.text).not.toContain('larger than')
    expect(r).toMatchObject({ isError: false })
    const out = fs.statSync(file('groups/marketing/pdfs/scan-numbered.pdf')).size
    expect(out).toBeGreaterThan(64 * 1024 * 1024)
    expect((await PDFDocument.load(fs.readFileSync(file('groups/marketing/pdfs/scan-numbered.pdf')))).getPageCount()).toBe(35)
    for (const f of ['scan.pdf', 'scan-numbered.pdf']) fs.rmSync(file(`groups/marketing/pdfs/${f}`), { force: true })
    cfg.maxWriteBytesPerTurn = was
  })

  test('over the limit: said plainly, nothing read', async () => {
    const p = file('groups/marketing/pdfs/huge.pdf')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '%PDF-1.7\n')
    fs.truncateSync(p, PDF_PAGES_INPUT_MAX + 1)
    const r = await call('alice', 'split_pdf', { file_path: 'groups/marketing/pdfs/huge.pdf', every: 1 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('larger than 100 MB')
    fs.rmSync(p, { force: true })
  })
})

describe('resize_images (TC-4973)', () => {
  test('150 MB per photo, 120 s per photo', () => {
    expect(RESIZE_INPUT_MAX).toBe(150 * 1024 * 1024)
    expect(RESIZE_TIMEOUT_MS).toBe(120_000)
  })

  test.skipIf(!helper)('a 40 MB photo reaches the image helper (32 MB before): a broken one is damaged, not too large', async () => {
    const p = file('groups/marketing/photos/raw-export.jpg')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    fs.truncateSync(p, 40 * 1024 * 1024)
    const r = await call('alice', 'resize_images', { paths: ['groups/marketing/photos/raw-export.jpg'], preset: 'email' })
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain('larger than')
    expect(r.text).toContain('damaged')
    fs.rmSync(p, { force: true })
  })
})

describe('read with versions: longer changes and read on (TC-4975)', () => {
  const save = async (as: Person, p: string, content: string, base: string | null) => {
    const r = await A.json('/api/files/content', { ...jsonBody({ path: p, content, baseSha256: base === null ? null : sha256hex(base) }, 'PUT'), as })
    expect(r.status).toBe(200)
  }
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `row ${i + 1}: ${tag} ${'x'.repeat(40)}`).join('\n') + '\n'

  test('versionDiffPart: whole lines up to the limit, where to read on, a single long line cut', () => {
    expect(VERSION_DIFF_MAX_CHARS).toBe(40_000)
    const t = ['a', 'bb', 'ccc', 'dddd'].join('\n')
    expect(versionDiffPart(t, 1, 5)).toEqual({ text: 'a\nbb', next: 3, lines: 4 })
    expect(versionDiffPart(t, 3, 5)).toEqual({ text: 'ccc', next: 4, lines: 4 })
    expect(versionDiffPart(t, 4, 5)).toEqual({ text: 'dddd', next: null, lines: 4 })
    expect(versionDiffPart('x'.repeat(10), 1, 4)).toEqual({ text: 'xxxx…', next: null, lines: 1 })
  })

  test('a change of 20,000 characters is shown whole (8,000 before); a longer one in parts, with the offset to read on', async () => {
    const p = 'shared/qa/price-list.md'
    const v1 = lines(400, 'old')
    const v2 = lines(400, 'new')
    await save('alice', p, v1, null)
    await save('alice', p, v2, v1)
    const first = await call('alice', 'read', { file_path: p, versions: true })
    expect(first.isError).toBe(false)
    // 800 changed lines of about 55 characters: about 44,000 characters of changes, over one part
    expect(first.text).toContain('400 removed, 400 added')
    const m = /cut at line (\d+) of (\d+): for the rest, the same read with offset: (\d+)/.exec(first.text)
    expect(m).not.toBeNull()
    const next = Number(m![3])
    expect(first.text).toContain('-row 1: old')
    // much more than the 8,000 characters of before
    expect(first.text.length).toBeGreaterThan(30_000)
    const rest = await call('alice', 'read', { file_path: p, versions: true, offset: next })
    expect(rest.text).toContain(`lines ${next}-${m![2]} of ${m![2]} lines of changes`)
    expect(rest.text).toContain('+row 400: new')
    expect(rest.text).not.toContain('cut at line')
    const past = await call('alice', 'read', { file_path: p, versions: true, offset: 100_000 })
    expect(past.text).toContain('offset 100000 is past the end')
    // a change of about 20,000 characters: whole, no read-on
    const q = 'shared/qa/short-list.md'
    const w1 = lines(180, 'old')
    const w2 = lines(180, 'new')
    await save('alice', q, w1, null)
    await save('alice', q, w2, w1)
    const whole = await call('alice', 'read', { file_path: q, versions: true })
    expect(whole.text).toContain('+row 180: new')
    expect(whole.text).not.toContain('cut at line')
  })
})

describe('artifact (TC-4977)', () => {
  test('up to 10 MB; over it, refused with what to do instead', async () => {
    expect(MAX_ARTIFACT_BYTES).toBe(10 * 1024 * 1024)
    const page = `<html><body>${'<p>row</p>'.repeat(500_000)}</body></html>`
    const ok = await call('alice', 'artifact', { action: 'create', key: 'big-report', type: 'html', content: page })
    expect(ok.isError).toBe(false)
    const over = await call('alice', 'artifact', { action: 'create', key: 'too-big', type: 'html', content: 'x'.repeat(MAX_ARTIFACT_BYTES + 1) })
    expect(over.isError).toBe(true)
    expect(over.text).toContain('max 10 MB')
    expect(over.text).toContain('several artifacts')
  })
})

describe('make_file charts (TC-4978)', () => {
  test('50 charts in one workbook (10 before), the 51st refused', () => {
    expect(CHARTS_MAX).toBe(50)
    expect(MAKE_FILE_CHARTS_MAX).toBe(CHARTS_MAX)
    const chart = (i: number) => ({ type: 'column' as const, range: 'A1:B4', anchor: `D${1 + i * 20}` })
    const fifty = Array.from({ length: 50 }, (_, i) => chart(i))
    expect(MakeFileInput.safeParse({ output: 'shared/x.xlsx', format: 'xlsx', content: '| a | b |\n|---|---|\n| x | 1 |', charts: fifty }).success).toBe(true)
    expect(MakeFileInput.safeParse({ output: 'shared/x.xlsx', format: 'xlsx', content: '| a | b |\n|---|---|\n| x | 1 |', charts: [...fifty, chart(50)] }).success).toBe(false)
    const sheets = [{ name: 'Sheet1', rows: [['a', 'b'], ['x', 1], ['y', 2], ['z', 3]] }]
    expect(placeCharts(fifty, sheets)).toHaveLength(50)
    expect(() => placeCharts([...fifty, chart(50)], sheets)).toThrow('at most 50 charts per file')
  })
})
