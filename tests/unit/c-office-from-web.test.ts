// Office files, CSV tables and ZIP archives from the web (QA TC-4922, docs/decisions/20261118-office-zip-from-the-web.md):
// save_url saves them, judged by their bytes (a zip by the names in its directory, a compound file by its streams), and
// refuses program packages, installers and damaged zips; web_fetch reads their text through the extract hook (the
// normal extractors) and lists a zip's files. Local test servers stand in for public sites (testAllow); the address
// rules are save_url's and web_fetch's own (their own tests).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { TurnFiles, type ToolCtx } from '../../server/src/files/service'
import { ToolError } from '../../server/src/policy/errors'
import { saveUrl, type SaveUrlOptions } from '../../server/src/tools/save-url'
import { settleKind, sniffDownload, KINDS, RefusedKind } from '../../server/src/tools/sniff'
import { rememberUrls, type TurnPerson } from '../../server/src/tools/url-gate'
import { noteEgressIp } from '../../server/src/tools/egress'
import { webFetch, type FetchOptions } from '../../server/src/tools/web-fetch'
import { writeZip } from '../../server/src/files/zip-write'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(30_000)

const z = (names: Record<string, string>) => Buffer.from(writeZip(Object.entries(names).map(([name, data]) => ({ name, data: Buffer.from(data), utf8: true }))))
const DOCX = z({ '[Content_Types].xml': '<Types/>', '_rels/.rels': '<Relationships/>', 'word/document.xml': '<w:document/>' })
const DOCM = z({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>', 'word/vbaProject.bin': 'macros' })
const XLSX_FILE = z({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>', 'xl/worksheets/sheet1.xml': '<worksheet/>' })
const PPTX = z({ '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': '<p:presentation/>' })
const HWPX = z({ mimetype: 'application/hwp+zip', 'Contents/section0.xml': '<hs:sec/>' })
const PLAIN_ZIP = z({ '보고서/1월.txt': 'one', '보고서/2월.txt': 'two' })
const APK = z({ 'AndroidManifest.xml': 'x', 'classes.dex': 'dex' })
const DAMAGED_ZIP = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200, 1)])
const CFB = (XLSX as unknown as { CFB: any }).CFB
const cfb = (streams: Record<string, string>) => { const c = CFB.utils.cfb_new(); for (const [n, d] of Object.entries(streams)) CFB.utils.cfb_add(c, '/' + n, Buffer.from(d)); return Buffer.from(CFB.write(c, { type: 'buffer', fileType: 'cfb' })) }
const XLS = (() => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'sales'], ['Kim', 3]]), 'S'); return Buffer.from(XLSX.write(wb, { bookType: 'xls', type: 'buffer' })) })()
const DOC = cfb({ WordDocument: 'word 97 body', '1Table': 'table' })
const MSI = cfb({ '䡀㼿䕷': 'installer table' })
const CSV = Buffer.from('name,city,amount\nKim,Seoul,1200\nLee,Busan,800\n')

let A: CApp
let site: ReturnType<typeof Bun.serve>
const HOST = 'files.example'
const at = (p: string) => `http://${HOST}:${(site as { port: number }).port}${p}`
const OCTET = { 'content-type': 'application/octet-stream' }

beforeAll(async () => {
  A = await makeCApp('c-office-from-web')
  noteEgressIp(A.ctx, '198.51.100.20')
  site = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname
      const routes: Record<string, [Buffer, Record<string, string>]> = {
        '/download?id=1': [DOCX, OCTET], '/report.docx': [DOCX, OCTET], '/macro.docx': [DOCM, OCTET], '/sheet.bin': [XLSX_FILE, OCTET], '/deck': [PPTX, OCTET],
        '/form.hwpx': [HWPX, OCTET], '/reports.zip': [PLAIN_ZIP, { 'content-type': 'application/zip' }], '/app.zip': [APK, OCTET], '/app.apk': [PLAIN_ZIP, OCTET],
        '/broken.zip': [DAMAGED_ZIP, OCTET], '/old.xls': [XLS, { 'content-type': 'application/vnd.ms-excel' }], '/old-sheet': [XLS, OCTET], '/letter.doc': [DOC, OCTET],
        '/setup.bin': [MSI, OCTET], '/sales.csv': [CSV, { 'content-type': 'application/vnd.ms-excel' }], '/export': [CSV, { 'content-type': 'text/csv; charset=utf-8' }],
        '/table.csv': [Buffer.from('<!doctype html><html><body>sign in</body></html>'), { 'content-type': 'text/csv' }],
        '/big.docx': [Buffer.concat([DOCX, Buffer.alloc(6 * 1024 * 1024)]), OCTET],
      }
      const key = p + new URL(req.url).search
      const r = routes[key] ?? routes[p]
      return r ? new Response(new Uint8Array(r[0]), { headers: r[1] }) : new Response('no', { status: 404 })
    },
  })
})
afterAll(async () => { site?.stop(true); await A?.close() })

const LOOKUP = async (h: string) => { if (h === HOST) return [{ address: '127.0.0.1', family: 4 }]; throw new Error('ENOTFOUND') }
const disk = () => ({ bsize: 4096, blocks: (500 * 1024 ** 3) / 4096, bfree: (200 * 1024 ** 3) / 4096, bavail: (200 * 1024 ** 3) / 4096 })
const OPTS: SaveUrlOptions = { lookup: LOOKUP, testAllow: (ip) => ip === '127.0.0.1', connectTimeoutMs: 3000, idleTimeoutMs: 3000, statfs: disk, normalize: async () => {} }
function setup() {
  const chat = A.chat('alice')
  const turnId = A.turn('alice', chat)
  const person: TurnPerson = { locale: 'en', async confirm() { return true }, *turnUrls() {} }
  const t: ToolCtx = { user: A.ctx.files.principal('alice'), turnId, files: new TurnFiles(), person, signal: new AbortController().signal, confirmWidening: async () => null }
  const run = (p: string, save_as?: string) => { rememberUrls(A.ctx.db, chat, [at(p)], 'allowed'); return saveUrl(A.ctx, { url: at(p), ...(save_as ? { save_as } : {}) }, t, OPTS) }
  return { run }
}
/** the message a call fails with (Bun 1.3.12 on macOS crashes on `rejects` after another await in the same test) */
const failure = async (p: Promise<unknown>): Promise<string> => { const e = await p.then(() => null, (x: unknown) => x); expect(e).toBeInstanceOf(Error); return (e as Error).message }
const bytes = (rel: string) => fs.readFileSync(path.join(A.team, ...rel.split('/')))

describe('save_url: Office, CSV and ZIP files (QA TC-4922)', () => {
  test('Word, Excel, PowerPoint and Hangul files are saved, named and typed by their bytes', async () => {
    const s = setup()
    const docx = await s.run('/download?id=1', 'groups/marketing/web/brief')
    expect(docx.structured).toMatchObject({ path: 'groups/marketing/web/brief.docx', type: KINDS.docx.mime })
    expect(bytes('groups/marketing/web/brief.docx').equals(DOCX)).toBe(true)
    expect(docx.text).toContain('Read it with read')
    expect((await s.run('/report.docx', 'groups/marketing/web/')).structured.path).toBe('groups/marketing/web/report.docx')
    // a VBA project inside: the macro-enabled extension, or Word refuses to open it
    expect((await s.run('/macro.docx', 'groups/marketing/web/')).structured.path).toBe('groups/marketing/web/macro.docm')
    expect((await s.run('/sheet.bin', 'groups/marketing/web/')).structured).toMatchObject({ path: 'groups/marketing/web/sheet.xlsx', type: KINDS.xlsx.mime })
    expect((await s.run('/deck', 'groups/marketing/web/')).structured.path).toBe('groups/marketing/web/deck.pptx')
    expect((await s.run('/form.hwpx', 'groups/marketing/web/')).structured.path).toBe('groups/marketing/web/form.hwpx')
  })
  test('old Excel and Word files (compound files) by their streams; an installer is refused', async () => {
    const s = setup()
    expect((await s.run('/old.xls', 'groups/marketing/old/')).structured).toMatchObject({ path: 'groups/marketing/old/old.xls', type: 'application/vnd.ms-excel' })
    expect((await s.run('/old-sheet', 'groups/marketing/old/')).structured.path).toBe('groups/marketing/old/old-sheet.xls')
    expect((await s.run('/letter.doc', 'groups/marketing/old/')).structured.path).toBe('groups/marketing/old/letter.doc')
    const msi = await s.run('/setup.bin', 'groups/marketing/old/').catch((e) => e)
    expect(msi).toBeInstanceOf(ToolError)
    expect(msi.message).toContain('not a Word, Excel, PowerPoint, Hangul or Outlook file')
    expect(fs.existsSync(path.join(A.team, 'groups/marketing/old/setup.bin'))).toBe(false)
  })
  test('a CSV table by its name or its type (Excel sends application/vnd.ms-excel); a page that calls itself CSV is refused', async () => {
    const s = setup()
    const a = await s.run('/sales.csv', 'groups/marketing/data/')
    expect(a.structured).toMatchObject({ path: 'groups/marketing/data/sales.csv', type: 'text/csv' })
    expect(bytes('groups/marketing/data/sales.csv').equals(CSV)).toBe(true)
    expect((await s.run('/export', 'groups/marketing/data/')).structured.path).toBe('groups/marketing/data/export.csv')
    expect(await failure(s.run('/table.csv', 'groups/marketing/data/'))).toMatch(/an HTML page/)
  })
  test('a ZIP is saved as it is (not unzipped); app packages and damaged zips are refused', async () => {
    const s = setup()
    const r = await s.run('/reports.zip', 'groups/marketing/zips/')
    expect(r.structured).toMatchObject({ path: 'groups/marketing/zips/reports.zip', type: 'application/zip' })
    expect(r.text).toContain('unzip_file opens it')
    expect(bytes('groups/marketing/zips/reports.zip').equals(PLAIN_ZIP)).toBe(true)
    expect(await failure(s.run('/app.zip', 'groups/marketing/zips/'))).toMatch(/a program package/)
    expect(await failure(s.run('/app.apk', 'groups/marketing/zips/'))).toMatch(/a program package/)
    expect(await failure(s.run('/broken.zip', 'groups/marketing/zips/'))).toMatch(/a damaged ZIP/)
    expect(fs.readdirSync(path.join(A.team, 'groups/marketing/zips'))).toEqual(['reports.zip'])
  })
  test('the sniffer: a container waits for the whole file; a table needs its name or type', () => {
    expect(sniffDownload(DOCX.subarray(0, 64), '', 'x')?.name).toBe('zip')
    expect(sniffDownload(XLS.subarray(0, 64), '', 'x')?.name).toBe('ole')
    expect(sniffDownload(CSV.subarray(0, 64), '', 'data')).toBeNull()
    expect(sniffDownload(CSV.subarray(0, 64), 'text/csv', 'data')?.name).toBe('csv')
    expect(sniffDownload(CSV.subarray(0, 64), '', 'data.tsv')?.name).toBe('tsv')
    expect(settleKind(KINDS.zip, PPTX, '', 'x').name).toBe('pptx')
    expect(() => settleKind(KINDS.ole, MSI, '', 'x.doc')).toThrow(RefusedKind)
    // too large to read whole: what the name says, among the zip formats
    expect(settleKind(KINDS.zip, null, '', 'big.xlsx').name).toBe('xlsx')
    expect(settleKind(KINDS.zip, null, '', 'big.dat').name).toBe('zip')
    expect(() => settleKind(KINDS.zip, null, '', 'big.jar')).toThrow(RefusedKind)
  })
})

describe('web_fetch: the text of Office files and tables, the list of a zip (QA TC-4922)', () => {
  const extracted: string[] = []
  const T: FetchOptions = { testAllow: (ip) => ip === '127.0.0.1', lookup: LOOKUP, timeoutMs: 5000, extract: async (name, b) => { extracted.push(name); return name.endsWith('.csv') ? Buffer.from(b).toString('utf8') : `text of ${name} (${b.length} bytes)` } }
  test('a Word file and an old Excel file go through the extractor under their kind; a CSV is read as text', async () => {
    extracted.length = 0
    const d = await webFetch(at('/download?id=1'), T)
    expect(d.text).toContain('(Word file)')
    expect(d.text).toContain(`text of download.docx (${DOCX.length} bytes)`)
    const m = await webFetch(at('/macro.docx'), T)
    expect(m.text).toContain('text of download.docx')
    expect((await webFetch(at('/old.xls'), T)).text).toContain('text of download.xls')
    expect((await webFetch(at('/sales.csv'), T)).text).toContain('Kim,Seoul,1200')
    expect(extracted).toEqual(['download.docx', 'download.docx', 'download.xls', 'download.csv'])
  })
  test('a zip: the list of its files, never their contents; a file over 5 MB points to save_url; programs and old Word files are not read', async () => {
    const r = await webFetch(at('/reports.zip'), T)
    expect(r.text).toContain('A ZIP archive with 2 files')
    expect(r.text).toContain('- 보고서/1월.txt (3 B)')
    expect(r.text).not.toContain('one')
    expect(r.text).toContain('unzip_file')
    expect(await failure(webFetch(at('/big.docx'), T))).toMatch(/larger than 5 MB.*save_url/)
    expect(await failure(webFetch(at('/app.zip'), T))).toMatch(/a program package/)
    expect(await failure(webFetch(at('/letter.doc'), T))).toMatch(/cannot be read as text here/)
    // without an extractor (a caller that never reads documents): refused as before
    expect(await failure(webFetch(at('/report.docx'), { ...T, extract: undefined }))).toMatch(/unsupported content type application\/octet-stream/)
  })
})
