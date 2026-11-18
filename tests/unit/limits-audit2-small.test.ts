// Seven small limits of the second limits audit (docs/decisions/20261118-audit2-small.md):
// TC-4914 make_file builds a big workbook from a CSV source (plus summary sheets), TC-4917 a Word title is read,
// TC-4918 spreadsheet formulas are read next to their values, TC-4921 grep names the files it skipped for size and
// grep / list stop at a budget with the next offset, TC-4923 office time limits by file size, TC-4924 box_shell only
// while the dev environment works, TC-4926 the sub-agent sentence follows PARENT_ONLY_TOOLS.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import { setSystemTime } from 'bun:test'
import path from 'node:path'
import * as XLSX from 'xlsx'
import ExcelJS from '../../server/node_modules/exceljs'
import { API, DEV_ENV_DEFAULT_LIMITS } from '@mycel/shared/api'
import { MakeFileInput } from '@mycel/shared'
import { makeHandler } from '../../server/src/mcp/protocol'
import { which } from '../../server/src/config'
import { converterReadTimeoutMs, extractText, officeWorkersMax, officeWorkerTimeoutMs, setOfficeWorkersMaxForTests } from '../../server/src/files/extract'
import { formulasWithValues, sheetText } from '../../server/src/files/office-parse'
import { OfficeCache } from '../../server/src/files/search'
import { listPage, TOOL_TEXT_BUDGET } from '../../server/src/files/tool-budget'
import { textTokens } from '../../server/src/files/vision'
import { setPlanForTests } from '../../server/src/system/limits'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { BROWSER_TOOL_NAMES } from '../../server/src/realtime/browser-tools'
import { devEnvDownRule, PARENT_ONLY_WORDS, subagentLacks, subagentRule } from '../../server/src/chat/prompt'
import { devEnvDownReason, setSrtSystem } from '../../server/src/devenv/srt/runner'
import type { SrtSystem } from '../../server/src/devenv/srt/system'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(60_000)
const pandoc = which('pandoc')

let A: CApp
beforeAll(async () => { A = await makeCApp('audit2-small') })
afterAll(async () => { await A.close() })
let rpcId = 0
async function call(user: Person, name: string, args: unknown) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, null))
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  if (r.error) return { text: String(r.error.message), isError: true }
  return { text: r.result.content[0].text as string, isError: !!r.result.isError }
}
const put = (rel: string, data: string | Uint8Array) => { const f = path.join(A.team, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data) }

describe('TC-4914 make_file: a big workbook from a CSV source', () => {
  test('a 5,000-row CSV source plus a summary sheet in content: every row, the formulas, a chart', async () => {
    const regions = ['North', 'South', 'East', 'West']
    const rows = ['date,region,units,price,revenue']
    for (let i = 0; i < 5000; i++) rows.push(`2026-0${(i % 9) + 1}-01,${regions[i % 4]},${i % 7 + 1},10,${(i % 7 + 1) * 10}`)
    put('users/alice/LIM/sales.csv', rows.join('\n') + '\n')
    const summary = '## Summary\n\n| Region | Revenue |\n|---|---|\n' + regions.map((r, i) => `| ${r} | =SUMIFS(sales!E:E,sales!B:B,A${i + 2}) |`).join('\n') + '\n'
    const r = await call('alice', 'make_file', { source: 'users/alice/LIM/sales.csv', content: summary, format: 'xlsx', output: 'users/alice/LIM/out/dashboard.xlsx', charts: [{ type: 'bar', range: 'A1:B5', sheet: 'Summary' }] })
    expect(r.isError, r.text).toBe(false)
    const wb = XLSX.read(fs.readFileSync(path.join(A.team, 'users/alice/LIM/out/dashboard.xlsx')), { cellFormula: true, sheetStubs: true })
    expect(wb.SheetNames).toEqual(['sales', 'Summary'])
    expect(XLSX.utils.decode_range(wb.Sheets.sales!['!ref']!).e.r + 1).toBe(5001)
    expect(wb.Sheets.Summary!.B2!.f).toBe('SUMIFS(sales!E:E,sales!B:B,A2)')
  })
  test('content with a source only for an xlsx from a CSV, and only as Markdown tables', async () => {
    put('users/alice/LIM/notes.md', '# Notes\n')
    expect(MakeFileInput.safeParse({ source: 'users/alice/LIM/notes.md', content: '# x', format: 'docx', output: 'users/alice/LIM/x.docx' }).success).toBe(false)
    expect(MakeFileInput.safeParse({ source: 'users/alice/LIM/sales.csv', content: '| a |\n|---|\n| 1 |', format: 'xlsx', output: 'users/alice/LIM/x.xlsx' }).success).toBe(true)
    const r = await call('alice', 'make_file', { source: 'users/alice/LIM/sales.csv', content: 'just words', format: 'xlsx', output: 'users/alice/LIM/out/bad.xlsx' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Markdown | pipe | tables')
    expect(fs.existsSync(path.join(A.team, 'users/alice/LIM/out/bad.xlsx'))).toBe(false)
  })
  test('the description says a big workbook comes from the CSV as source, never retyped', async () => {
    const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
    const l = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} })
    const d = String(l.result.tools.find((t: { name: string }) => t.name.endsWith('make_file')).description)
    expect(d).toContain('give the .csv/.tsv file as `source`')
    expect(d).toContain('never retype or sample its rows')
  })
})

describe.skipIf(!pandoc)('TC-4917 a Word title is read', () => {
  test('title, subtitle and author come first, before the first heading', async () => {
    const md = '---\ntitle: Annual Report QA-TITLE-7713\nsubtitle: Draft for review\nauthor: Kim\n---\n\n# Intro\n\nBody text.\n'
    const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from(md) })
    const text = await extractText('report.docx', new Uint8Array(r.stdout), { pandoc, pdftotext: null })
    const lines = text.split('\n').filter((l) => l.trim())
    expect(lines.slice(0, 4)).toEqual(['Annual Report QA-TITLE-7713', 'Draft for review', 'Kim', '# Intro'])
  })
  test('a document without a title gets none', async () => {
    const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from('# Intro\n\nBody.\n') })
    const text = await extractText('plain.docx', new Uint8Array(r.stdout), { pandoc, pdftotext: null })
    expect(text.trim().split('\n')[0]).toBe('# Intro')
  })
})

describe('TC-4918 formulas are read next to their values', () => {
  test('SheetJS cells: a stored value, an error, a long formula', () => {
    const ws = XLSX.utils.aoa_to_sheet([['item', 'amount'], ['a', 100], ['b', 200]])
    ws.B4 = { t: 'n', v: 300, f: 'SUM(B2:B3)' }
    ws.C2 = { t: 'e', v: 7, w: '#DIV/0!', f: 'B2/0' }
    ws.C3 = { t: 'n', v: 1, f: 'IF(' + 'A1="x",'.repeat(60) + '1)' }
    ws['!ref'] = 'A1:C4'
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S')
    const text = sheetText(new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })))
    expect(text).toContain('\t=SUM(B2:B3) → 300')
    expect(text).toContain('=B2/0 → #DIV/0!')
    expect(text).toMatch(/…" ?→ ?1|… → 1/)
    // plain values stay as they were
    expect(text).toContain('a\t100\t')
  })
  test('too much formula text: that sheet shows its values, with one labelled line saying so', () => {
    const rows: (string | number)[][] = [['a', 'b', 'total']]
    for (let i = 2; i <= 400; i++) rows.push([i, 2, 0])
    const ws = XLSX.utils.aoa_to_sheet(rows)
    for (let i = 2; i <= 400; i++) ws[`C${i}`] = { t: 'n', v: i * 2, f: `A${i}*B${i}` }
    const small = XLSX.utils.aoa_to_sheet([['x', 'y'], [1, 0]])
    small.B2 = { t: 'n', v: 2, f: 'A2*2' }
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Big'); XLSX.utils.book_append_sheet(wb, small, 'Small')
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    const text = sheetText(bytes, 1_000)
    expect(text).toContain('400\t2\t800\n') // values only on the big sheet
    expect(text).not.toContain('=A400*B400')
    expect(text).toContain('=A2*2 → 2') // the small one still fits
    expect(text.trim().split('\n').at(-1)).toBe("=== Sheet 'Big' shows values only: its 399 formula cells are too many to show next to them ===")
    expect(sheetText(bytes)).toContain('=A400*B400 → 800')
    const one = { '!data': [[{ t: 'n', v: 1 }, { t: 'n', v: 2, f: 'A1*2' }]], '!ref': 'A1:B1' } as unknown as XLSX.WorkSheet
    expect(formulasWithValues(one, 3)).toMatchObject({ shown: false, cells: 1 })
  })
  test('an Excel file with a shared formula: each cell shows its own formula', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Q3')
    ws.addRow(['units', 'price', 'total'])
    ws.addRow([2, 10, { formula: 'A2*B2', result: 20, shareType: 'shared', ref: 'C2:C3' }])
    ws.addRow([3, 10, { sharedFormula: 'C2', result: 30 }])
    ws.addRow(['', '', { formula: 'SUM(C2:C3)', result: 50 }])
    const text = sheetText(new Uint8Array(await wb.xlsx.writeBuffer()))
    expect(text).toContain('2\t10\t=A2*B2 → 20')
    expect(text).toContain('3\t10\t=A3*B3 → 30')
    expect(text).toContain('=SUM(C2:C3) → 50')
  })
})

describe('TC-4921 grep and list say what they left out', () => {
  test('grep names a file over 50 MB that it did not search, and says read opens it', async () => {
    put('users/alice/BIG/small.csv', 'id,needle\n1,needle\n')
    const big = path.join(A.team, 'users/alice/BIG/export.csv')
    fs.writeFileSync(big, 'id,needle\n')
    fs.truncateSync(big, 51 * 1024 * 1024)
    const r = await call('alice', 'grep', { pattern: 'needle', path: 'users/alice/BIG' })
    expect(r.text).toContain('users/alice/BIG/small.csv')
    expect(r.text).toContain('1 file was not searched because it is over 50 MB: users/alice/BIG/export.csv')
    expect(r.text).toContain('with read')
    // nobody else hears of it: bob cannot see alice's folder
    const b = await call('bob', 'grep', { pattern: 'needle' })
    expect(b.text).not.toContain('export.csv')
    fs.rmSync(big)
  })
  test('grep stops at the budget and the offset reads on, line for line', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `row ${String(i).padStart(5, '0')} needle ${'x'.repeat(80)}`)
    put('users/alice/LONG/log.txt', lines.join('\n') + '\n')
    const first = await call('alice', 'grep', { pattern: 'needle', path: 'users/alice/LONG/log.txt', output_mode: 'content', head_limit: 5000 })
    expect(first.text.length).toBeLessThan(30_000)
    expect(textTokens(first.text)).toBeLessThan(25_000)
    const m = /offset=(\d+)/.exec(first.text)
    expect(m, first.text.slice(-300)).not.toBeNull()
    const n = Number(m![1])
    expect(first.text).toContain(`row ${String(n - 1).padStart(5, '0')}`)
    expect(first.text).not.toContain(`row ${String(n).padStart(5, '0')}`)
    const next = await call('alice', 'grep', { pattern: 'needle', path: 'users/alice/LONG/log.txt', output_mode: 'content', head_limit: 5000, offset: n })
    expect(next.text.split('\n')[0]).toContain(`row ${String(n).padStart(5, '0')}`)
  })
  test('list stops at the budget and the offset reads on', async () => {
    for (let i = 0; i < 700; i++) put(`users/alice/MANY/${'a-rather-long-file-name-for-the-budget-'.repeat(1)}${String(i).padStart(4, '0')}.txt`, 'x')
    const first = await call('alice', 'list', { path: 'users/alice/MANY' })
    expect(first.text.length).toBeLessThan(30_000)
    const m = /offset=(\d+)/.exec(first.text)
    expect(m).not.toBeNull()
    const next = await call('alice', 'list', { path: 'users/alice/MANY', offset: Number(m![1]) })
    expect(next.text.split('\n')[0]).toContain(String(Number(m![1])).padStart(4, '0'))
    expect(next.text).not.toContain('more of')
    expect(listPage(['a', 'b'], 0)).toBe('a\nb')
    expect(listPage(['a', 'b'], 5)).toContain('no entries from 5')
    const wide = Array.from({ length: 4000 }, (_, i) => `한글이름-${i}`)
    expect(textTokens(listPage(wide, 0))).toBeLessThanOrEqual(TOOL_TEXT_BUDGET.tokens + 100)
  })
})

describe('TC-4921 paging and place labels', () => {
  test('grep pages through 1,500 files: every file exactly once, in the same order each call', async () => {
    for (let i = 0; i < 1500; i++) put(`users/alice/PAGE/d${i % 30}/note-${String(i).padStart(4, '0')}.txt`, 'needle\n')
    const seen: string[] = []
    let offset: number | undefined
    for (let page = 0; page < 20; page++) {
      const r = await call('alice', 'grep', { pattern: 'needle', path: 'users/alice/PAGE', head_limit: 5000, ...(offset !== undefined ? { offset } : {}) })
      expect(r.text.length).toBeLessThan(30_000)
      seen.push(...r.text.split('\n').filter((l) => l.startsWith('users/alice/PAGE/')))
      const m = /offset=(\d+)/.exec(r.text)
      if (!m) break
      offset = Number(m[1])
    }
    expect(seen.length).toBe(1500)
    expect(new Set(seen).size).toBe(1500)
  })
  test('a first line longer than the whole budget: its start is shown and its file is recorded as read', async () => {
    put('users/alice/WIDE/one.txt', 'needle ' + 'y'.repeat(40_000) + '\n')
    const t = A.toolCtx('alice', null)
    const h = makeHandler(A.ctx.files, A.ctx.db, t)
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'grep', arguments: { pattern: 'needle', path: 'users/alice/WIDE', output_mode: 'content' } } })
    const text = r.result.content[0].text as string
    expect(text).toContain('line cut')
    expect(text.length).toBeLessThan(30_000)
    expect(t.files.readPaths.has('users/alice/WIDE/one.txt')).toBe(true)
  })
  test('Korean sheet rows with their place labels stay under the budget', async () => {
    const rows: string[][] = [['항목', '설명', '금액']]
    for (let i = 0; i < 3000; i++) rows.push([`매출 항목 ${i}`, '지역별 월간 매출 합계와 비고', String(i * 1000)])
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '지역별 매출 보고서')
    put('users/alice/KO/report.xlsx', new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })))
    const r = await call('alice', 'grep', { pattern: '매출 항목', path: 'users/alice/KO', output_mode: 'content', head_limit: 5000 })
    expect(r.text).toContain("[시트 '지역별 매출 보고서'") // alice reads Korean
    expect(textTokens(r.text)).toBeLessThan(25_000)
    expect(r.text).toMatch(/offset=\d+/)
  })
  test('the format-7 rebuild makes Word and spreadsheet text again, not PDFs', () => {
    const dir = fs.mkdtempSync(path.join(A.data, 'cache7-'))
    const cache = new OfficeCache(dir, { root: A.team, caseInsensitive: false } as never, { pandoc: null, pdftotext: null })
    for (const rel of ['a/scan.pdf', 'a/deck.pptx', 'a/memo.docx', 'a/book.xlsx']) {
      fs.mkdirSync(path.dirname(cache.cachePath(rel)), { recursive: true })
      fs.writeFileSync(cache.cachePath(rel), 'text')
      fs.writeFileSync(cache.cachePath(rel) + '.source.json', JSON.stringify({ source: 'x', text: 'y', format: '6' }))
    }
    expect(cache.current('a/scan.pdf')).toBe(true)
    expect(cache.current('a/deck.pptx')).toBe(true)
    expect(cache.current('a/memo.docx')).toBe(false)
    expect(cache.current('a/book.xlsx')).toBe(false)
  })
})

describe('TC-4923 office time limits follow the file size', () => {
  test('read and write limits grow with the input; the converters too', () => {
    expect(officeWorkerTimeoutMs(0)).toBe(60_000)
    expect(officeWorkerTimeoutMs(32 * 1024 * 1024)).toBe(188_000)
    expect(officeWorkerTimeoutMs(1024 * 1024 * 1024)).toBe(600_000)
    expect(converterReadTimeoutMs(1024)).toBe(62_000)
    expect(converterReadTimeoutMs(500 * 1024 * 1024)).toBe(300_000)
  })
  test('workers at once: from the CPU budget, 2 to 6, and no more than a plan\'s converter memory holds', () => {
    setOfficeWorkersMaxForTests(null)
    expect(officeWorkersMax()).toBeGreaterThanOrEqual(2)
    expect(officeWorkersMax()).toBeLessThanOrEqual(6)
    setPlanForTests({ format: 1, cpuCores: 16, memoryMiB: 4096, reserveMiB: 1024, maxConcurrency: 3, convMemoryMaxMiB: 1024 } as never)
    try { expect(officeWorkersMax()).toBe(2) } finally { setPlanForTests(undefined) }
    // no plan: also no more than a quarter of the machine's memory holds at 2 GB each (6 x 2 GB on a 16 GB Mac before)
    setPlanForTests(null)
    try { expect(officeWorkersMax()).toBeLessThanOrEqual(Math.max(2, Math.floor(os.totalmem() / 1024 / 1024 * 0.25 / 2048))) } finally { setPlanForTests(undefined) }
  })
})

describe('TC-4926 the sub-agent sentence follows the tool list', () => {
  test('every tool only the main AI has has plain words', () => {
    for (const t of PARENT_ONLY_TOOLS) if (!BROWSER_TOOL_NAMES.has(t)) expect(PARENT_ONLY_WORDS[t], t).toBeTruthy()
  })
  test('the sentence names what this turn has and helpers lack, and nothing else', () => {
    const rule = subagentRule(['read', 'write', 'delete_files', 'room_read', 'rooms', 'box_shell', 'make_file'])
    expect(rule).toContain('only you have: putting files in the trash, team chat rooms, running commands in the dev environment.')
    expect(rule).not.toContain('schedules')
    expect(rule).not.toContain('the browser')
    expect(subagentLacks(['read', 'make_file'])).toEqual([])
    expect(subagentRule(['read'])).toContain('the same user\'s access. It cannot ask')
  })
})

describe('TC-4924 box_shell only while the dev environment works', () => {
  let h: Harness, ws: TestSocket, chat = ''
  let problem = 'bwrap is missing'
  const fake: SrtSystem = {
    spawn() { throw new Error('no runs in this test') },
    async stop() {}, async unit() { return { state: '', result: '', memoryBytes: null } }, async units() { return [] }, async forget() {},
    oomKills() { return 0 }, cpuUsec() { return 0 }, procs() { return [] }, async selfTest() { return problem },
  }
  beforeAll(async () => {
    process.env.MYCEL_DEV_ENV = '1'
    h = await startHarness({ name: 'audit2-devenv' })
    ws = await h.ws('alice'); await ws.next('hello')
    setSrtSystem(fake, { base: fs.mkdtempSync(path.join(A.data, 'srt-')), id: 'mycel', plan: { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' } })
    saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
    chat = (await h.api('alice').call(API.createChat, { body: {} })).id
  })
  afterAll(async () => { setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h?.close() })
  const fakeMsg = (d: unknown) => '@fake ' + JSON.stringify(d)
  test('broken: no box_shell, and the instructions say once what cannot be done', async () => {
    const tools = await ask(h, ws, 'alice', chat, fakeMsg({ echo: 'tools' }))
    expect(tools.done.content).not.toContain('box_shell')
    const sys = await ask(h, ws, 'alice', chat, fakeMsg({ echo: 'system' }))
    expect(sys.done.content).toContain('is turned on for this team but is not working right now')
    expect(sys.done.content).toContain('do not give the user technical details')
    expect(sys.done.content).not.toContain('bwrap')
  })
  test('working again: box_shell is offered', async () => {
    problem = ''
    setSrtSystem(fake, { base: fs.mkdtempSync(path.join(A.data, 'srt-')), id: 'mycel', plan: { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' } })
    const c2 = (await h.api('alice').call(API.createChat, { body: {} })).id
    const tools = await ask(h, ws, 'alice', c2, fakeMsg({ echo: 'tools' }))
    expect(tools.done.content).toContain('box_shell')
  })
  test('the health check: one self-test at a time, the last result while it runs again, a late check changes nothing', async () => {
    let calls = 0
    let release: (v: string) => void = () => {}
    const slow: SrtSystem = { ...fake, selfTest: () => { calls++; return new Promise<string>((r) => { release = r }) } }
    const cfg = { base: fs.mkdtempSync(path.join(A.data, 'srt-')), id: 'mycel', plan: { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' } } as const
    setSrtSystem(slow, cfg as never)
    // the first check is late: not known yet, so nothing is taken away (as before the check)
    expect(await Promise.all([devEnvDownReason(undefined, 30), devEnvDownReason(undefined, 30)])).toEqual(['', ''])
    expect(calls).toBe(1)
    release('bwrap is missing'); await Bun.sleep(5)
    expect(await devEnvDownReason(undefined, 30)).toBe('bwrap is missing')
    expect(calls).toBe(1)
    // a minute later the failed check runs again; while it runs the last answer stands
    const t0 = Date.now()
    setSystemTime(new Date(t0 + 61_000))
    try {
      expect(await devEnvDownReason(undefined, 30)).toBe('bwrap is missing')
      expect(await devEnvDownReason(undefined, 30)).toBe('bwrap is missing')
      expect(calls).toBe(2)
      release(''); await Bun.sleep(5)
      expect(await devEnvDownReason(undefined, 30)).toBe('')
    } finally { setSystemTime() }
    setSrtSystem(fake, cfg as never)
  })
  test('an owner or admin is told where the reason is', () => {
    expect(devEnvDownRule('staff', 'en')).toContain('Dev environment')
    expect(devEnvDownRule('staff', 'en')).toContain('Never say to try again in a few minutes')
  })
})
