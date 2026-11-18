// Seven small limits of the second limits audit (docs/decisions/20261118-audit2-small.md):
// TC-4914 make_file builds a big workbook from a CSV source (plus summary sheets), TC-4917 a Word title is read,
// TC-4918 spreadsheet formulas are read next to their values, TC-4921 grep names the files it skipped for size and
// grep / list stop at a budget with the next offset, TC-4923 office time limits by file size, TC-4924 box_shell only
// while the dev environment works, TC-4926 the sub-agent sentence follows PARENT_ONLY_TOOLS.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import ExcelJS from '../../server/node_modules/exceljs'
import { API, DEV_ENV_DEFAULT_LIMITS } from '@mycel/shared/api'
import { MakeFileInput } from '@mycel/shared'
import { makeHandler } from '../../server/src/mcp/protocol'
import { which } from '../../server/src/config'
import { converterReadTimeoutMs, extractText, officeWorkersMax, officeWorkerTimeoutMs, setOfficeWorkersMaxForTests } from '../../server/src/files/extract'
import { sheetText } from '../../server/src/files/office-parse'
import { listPage } from '../../server/src/files/service'
import { TOOL_TEXT_BUDGET } from '../../server/src/files/search'
import { textTokens } from '../../server/src/files/vision'
import { setPlanForTests } from '../../server/src/system/limits'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { BROWSER_TOOL_NAMES } from '../../server/src/realtime/browser-tools'
import { devEnvDownRule, PARENT_ONLY_WORDS, subagentLacks, subagentRule } from '../../server/src/chat/prompt'
import { setSrtSystem } from '../../server/src/devenv/srt/runner'
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

describe('TC-4923 office time limits follow the file size', () => {
  test('read and write limits grow with the input; the converters too', () => {
    expect(officeWorkerTimeoutMs(0)).toBe(180_000)
    expect(officeWorkerTimeoutMs(32 * 1024 * 1024)).toBe(244_000)
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
  test('an owner or admin is told where the reason is', () => {
    expect(devEnvDownRule('staff', 'en')).toContain('Dev environment')
    expect(devEnvDownRule('staff', 'en')).toContain('Never say to try again in a few minutes')
  })
})
