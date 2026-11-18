// query_data (QA TC-4913): totals, pivots, top-N and splits over team data files without the dev environment, through the
// tool path (the MCP handler, as an engine calls it) and the isolated office worker. Before it, the AI refused a pivot of a
// 50,000-row CSV on a team without the dev environment ("the heavier data-processing option isn't available").
// Covers: the parsers and the SQL guard; a 50k-row CSV (monthly totals per store, the top 5, split by region into three
// files); xlsx in (sheets, dates) and out; JSON; CP949 and ";" CSVs; the read record; the folder rules (no access,
// read-only, a wider place without a card, skills); refusals that change nothing; the limits; the tool lists and prompt.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { QueryDataInput, stepLabel } from '@mycel/shared'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { TurnFiles, type ToolCtx } from '../../server/src/files/service'
import { checkedSql, columnNames, csvField, CsvParser, numberKind, runDataQuery, sniffDelimiter, sniffEncodingOf, splitName } from '../../server/src/files/data-query'
import { DATA_LIMITS, dataSlot, runDataWorker, splitTarget } from '../../server/src/tools/query-data'
import { isolation, makeWorkDir } from '../../server/src/tools/isolate'
import { ROOM_FILE_TOOLS, SHARED_TOOLS, WRITE_TARGET_ARGS, OWN_WORDS_TOOLS, namedPaths } from '../../server/src/rooms/ai-tools'
import { GUEST_TURN_TOOLS } from '../../server/src/chat/guest-tools'
import { QUERY_DATA_RULE } from '../../server/src/chat/prompt'
import { DEV_ENV_WORDS } from '../../server/src/chat/app-map'

setDefaultTimeout(120_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-query-data') })
afterAll(async () => { await A.close() })

const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array | string) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
let rpcId = 0
function turn(user: Person, o: { files?: TurnFiles; confirmWidening?: ToolCtx['confirmWidening'] } = {}) {
  const turnId = A.turn(user, A.chat(user))
  const h = makeHandler(A.ctx.files, A.ctx.db, { ...A.toolCtx(user, turnId), ...(o.files ? { files: o.files } : {}), ...(o.confirmWidening ? { confirmWidening: o.confirmWidening } : {}) })
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content.map((c: { text?: string }) => c.text ?? '').join('\n') as string, isError: !!r.result.isError }
  }
  return Object.assign(call, { turnId })
}

const D = 'groups/marketing/data'
const STORES = ['Gangnam', 'Hongdae', 'Jamsil', 'Busan', 'Daegu', 'Incheon']
const REGION: Record<string, string> = { Gangnam: 'Seoul', Hongdae: 'Seoul', Jamsil: 'Seoul', Busan: 'South', Daegu: 'South', Incheon: 'Capital area' }
interface Sale { id: number; date: string; store: string; region: string; product: string; amount: number }
const SALES: Sale[] = []
{
  let seed = 11
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const products = ['Latte', 'Cake, chocolate', 'Tea "green"', '샌드위치']
  for (let i = 0; i < 50_000; i++) {
    const store = STORES[Math.floor(rnd() * STORES.length)]!
    const m = 1 + Math.floor(rnd() * 12), d = 1 + Math.floor(rnd() * 28)
    SALES.push({ id: 100000 + i, date: `2025-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, store, region: REGION[store]!, product: products[Math.floor(rnd() * products.length)]!, amount: 1000 + Math.floor(rnd() * 90000) })
  }
}
const q = (s: string) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s)
const SALES_CSV = ['order_id,date,store,region,product,amount', ...SALES.map((s) => [s.id, s.date, s.store, s.region, q(s.product), s.amount].join(','))].join('\r\n') + '\r\n'

/** a parsed tab-separated result table from the tool's text: the lines after "Result:" up to the first empty line */
function resultRows(text: string): string[][] {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.startsWith('Result:'))
  const out: string[][] = []
  for (const l of lines.slice(i + 1)) { if (!l.trim()) break; out.push(l.split('\t')) }
  return out
}
const csvLines = (rel: string) => fs.readFileSync(file(rel), 'utf8').replace(/^﻿/, '').trim().split('\r\n')

describe('the input', () => {
  test('paths needed; save_as needs sql; split_by needs save_as; nothing else', () => {
    const ok = (v: unknown) => QueryDataInput.safeParse(v).success
    expect(ok({ paths: ['a.csv'] })).toBe(true)
    expect(ok({ paths: ['a.csv'], sql: 'select 1', save_as: 'b.csv', split_by: 'x' })).toBe(true)
    expect(ok({ paths: [] })).toBe(false)
    expect(ok({ paths: ['a.csv'], save_as: 'b.csv' })).toBe(false)
    expect(ok({ paths: ['a.csv'], sql: 'select 1', split_by: 'x' })).toBe(false)
    expect(ok({ paths: ['a.csv'], python: 'x' })).toBe(false)
  })
})

describe('the parts', () => {
  test('numbers: integers, decimals, thousands; codes with a leading zero and long ids stay text', () => {
    expect(numberKind('42')).toBe('integer')
    expect(numberKind('-3.5')).toBe('real')
    expect(numberKind('1,234,567')).toBe('integer')
    expect(numberKind('0')).toBe('integer')
    expect(numberKind('0.25')).toBe('real')
    expect(numberKind('007')).toBeNull()
    expect(numberKind('1234567890123456')).toBeNull()
    expect(numberKind('12%')).toBeNull()
    expect(numberKind('2025-01-02')).toBeNull()
  })
  test('CSV records: quotes, doubled quotes, line breaks in a field, CRLF, a lone CR, and any piece boundary', () => {
    const text = 'a,b,c\r\n1,"x, ""y""",3\n2,"multi\nline",\r4,,"end"'
    const want = [['a', 'b', 'c'], ['1', 'x, "y"', '3'], ['2', 'multi\nline', ''], ['4', '', 'end']]
    for (let cut = 1; cut < text.length; cut++) {
      const rows: string[][] = []
      const p = new CsvParser(',', (r) => { rows.push(r) })
      p.feed(text.slice(0, cut)); p.feed(text.slice(cut)); p.end()
      expect(rows).toEqual(want)
    }
  })
  test('the delimiter of the first line; names for empty and repeated headers', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(sniffDelimiter('a\tb\tc')).toBe('\t')
    expect(sniffDelimiter('"x;y",b,c')).toBe(',')
    expect(columnNames(['name', '', 'Name', null], 5)).toEqual(['name', 'c2', 'Name 2', 'c4', 'c5'])
  })
  test('the SQL guard: one reading statement; a ";" in a string or a comment is fine', () => {
    expect(checkedSql('SELECT 1;')).toBe('SELECT 1')
    expect(checkedSql("-- totals\nselect ';' as x; -- done")).toContain("select ';' as x")
    expect(checkedSql('WITH a AS (SELECT 1) SELECT * FROM a')).toContain('WITH')
    expect(() => checkedSql('SELECT 1; DROP TABLE data')).toThrow('one SQL statement')
    expect(() => checkedSql('DROP TABLE data')).toThrow('only a query that reads')
    expect(() => checkedSql("ATTACH 'x.db' AS x")).toThrow('only a query that reads')
    expect(() => checkedSql('PRAGMA query_only = OFF')).toThrow('only a query that reads')
    expect(() => checkedSql("SELECT 'open")).toThrow('unclosed quote')
  })
  test('split file names: "<name> - <value>", {value} in place, unsafe characters replaced', () => {
    expect(splitTarget('a/sales.csv', 'Seoul', 1)).toBe('a/sales - Seoul.csv')
    expect(splitTarget('a/{value} sales.xlsx', 'South', 1)).toBe('a/South sales.xlsx')
    expect(splitTarget('a/sales.csv', null, 0)).toBe('a/sales.csv')
    expect(splitName('A/B: C?')).toBe('A-B- C-')
    expect(splitName('a\u202eb\u200bc')).toBe('a-b-c')
    expect(splitName('x. ')).toBe('x')
    expect(splitName('...')).toBe('')
    expect(splitName(null)).toBe('blank')
    // a name the team folder does not take, or nothing left: "<name> - value <index>"; names given twice get a number
    expect(splitTarget('a/{value}.csv', 'CON', 4)).toBe('a/result - value 4.csv')
    expect(splitTarget('a/sales.csv', '', 2)).toBe('a/sales - value 2.csv')
    expect(splitTarget('a/{value}.csv', '', 3)).toBe('a/result - value 3.csv')
    const used = new Set<string>()
    expect(splitTarget('a/s.csv', 'Seoul', 1, used)).toBe('a/s - Seoul.csv')
    expect(splitTarget('a/s.csv', 'seoul', 2, used)).toBe('a/s - seoul 2.csv')
  })
  test('CSV output: text that looks like a formula gets a quote mark; numbers do not', () => {
    for (const t of ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\tx', '\rx']) expect(csvField(t, ',').replace(/^"|"$/g, '').startsWith("'")).toBe(true)
    expect(csvField(-5, ',')).toBe('-5')
    expect(csvField('plain', ',')).toBe('plain')
    expect(csvField('=HYPERLINK("x")', ',')).toBe('"\'=HYPERLINK(""x"")"')
  })
  test('the encoding from a sample: UTF-8, CP949, UTF-16 with and without a BOM', () => {
    expect(sniffEncodingOf(Buffer.from('a,b\n한글,1\n'))).toBe('utf-8')
    expect(sniffEncodingOf(Uint8Array.from([0x61, 0x2c, 0x62, 0x0a, 0xb0, 0xad, 0xb3, 0xb2, 0x2c, 0x31]))).toBe('euc-kr')
    expect(sniffEncodingOf(Buffer.from('store,amount\nGangnam,3\n', 'utf16le'))).toBe('utf-16le')
    expect(sniffEncodingOf(Buffer.from('store,amount\nGangnam,3\n', 'utf16le').swap16())).toBe('utf-16be')
    expect(sniffEncodingOf(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a', 'utf16le')]))).toBe('utf-16le')
    // a UTF-8 sample cut inside a character is still UTF-8
    expect(sniffEncodingOf(Buffer.from('가나다라마바사'.repeat(50)).subarray(0, 100))).toBe('utf-8')
  })
  test('the query runs read-only over the loaded copies only', () => {
    const dir = fs.mkdtempSync(path.join(A.ctx.config.dataDir, 'dq-'))
    fs.writeFileSync(path.join(dir, 'in-1.csv'), 'x\n1\n2\n')
    // a write inside a reading query (a CTE cannot write; a function that could is not there, or SQLite's authorizer
    // refuses it first, as on Linux CI)
    expect(() => runDataQuery({ inputs: [{ file: 'in-1.csv', name: 'x.csv', ext: 'csv', table: 'data' }], sql: "SELECT load_extension('x')", show: 5 }, dir)).toThrow(/no such function|not authorized/)
    fs.writeFileSync(path.join(dir, 'in-1.csv'), 'x\n1\n2\n')
    fs.rmSync(path.join(dir, 'data.db'), { force: true })
    const r = runDataQuery({ inputs: [{ file: 'in-1.csv', name: 'x.csv', ext: 'csv', table: 'data' }], sql: 'SELECT sum(x) s, 0.1 + 0.2 f, x AS a, x AS a FROM data', show: 5 }, dir)
    // repeated result names stay apart; float noise is gone
    expect(r.result!.columns).toEqual(['s', 'f', 'a', 'a:1'])
    expect(r.result!.rows[0]).toEqual([3, 0.3, 1, 1])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('a 50,000-row CSV (the TC-4913 tasks)', () => {
  beforeAll(() => { put(`${D}/sales-2025.csv`, SALES_CSV) })

  test('without sql: the table, its columns and types, and the first rows; the file joins the read record', async () => {
    const files = new TurnFiles()
    const r = await turn('alice', { files })('query_data', { paths: [`${D}/sales-2025.csv`] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`data = '${D}/sales-2025.csv': 50,000 rows; columns: order_id integer, date text, store text, region text, product text, amount integer`)
    expect(r.text).toContain('100000\t')
    expect(files.readPaths.has(`${D}/sales-2025.csv`)).toBe(true)
    expect(files.readHashes.get(`${D}/sales-2025.csv`)).toBe(new Bun.CryptoHasher('sha256').update(SALES_CSV).digest('hex'))
  })

  test('monthly totals per store: every row counted, the same as adding them up here', async () => {
    const r = await turn('alice')('query_data', { paths: [`${D}/sales-2025.csv`], sql: 'SELECT substr(date, 1, 7) AS month, store, SUM(amount) AS total FROM data GROUP BY month, store ORDER BY month, store', show_rows: 500 })
    expect(r.isError, r.text).toBe(false)
    const want = new Map<string, number>()
    for (const s of SALES) { const k = `${s.date.slice(0, 7)}|${s.store}`; want.set(k, (want.get(k) ?? 0) + s.amount) }
    const rows = resultRows(r.text)
    expect(rows[0]).toEqual(['month', 'store', 'total'])
    expect(rows.length - 1).toBe(want.size)
    for (const [m, st, t] of rows.slice(1)) expect(Number(t)).toBe(want.get(`${m}|${st}`)!)
    expect(r.text).toContain(`Result: ${want.size} rows, 3 columns:`)
  })

  test('the top 5 stores', async () => {
    const r = await turn('alice')('query_data', { paths: [`${D}/sales-2025.csv`], sql: 'SELECT store, SUM(amount) AS total FROM data GROUP BY store ORDER BY total DESC LIMIT 5' })
    expect(r.isError, r.text).toBe(false)
    const sums = new Map<string, number>()
    for (const s of SALES) sums.set(s.store, (sums.get(s.store) ?? 0) + s.amount)
    const want = [...sums].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, t]) => [s, String(t)])
    expect(resultRows(r.text).slice(1)).toEqual(want)
  })

  test('split by region into three files next to each other, every row in one of them, the original unchanged', async () => {
    const call = turn('alice')
    const r = await call('query_data', { paths: [`${D}/sales-2025.csv`], sql: 'SELECT * FROM data ORDER BY order_id', save_as: `${D}/by-region/sales.csv`, split_by: 'region' })
    expect(r.isError, r.text).toBe(false)
    expect(fs.readdirSync(file(`${D}/by-region`)).sort()).toEqual(['sales - Capital area.csv', 'sales - Seoul.csv', 'sales - South.csv'])
    let n = 0
    for (const region of ['Seoul', 'South', 'Capital area']) {
      const lines = csvLines(`${D}/by-region/sales - ${region}.csv`)
      expect(lines[0]).toBe('order_id,date,store,region,product,amount')
      expect(lines.length - 1).toBe(SALES.filter((s) => s.region === region).length)
      n += lines.length - 1
    }
    expect(n).toBe(50_000)
    // a quoted field survives the round trip, and Excel gets a BOM to show Korean
    expect(fs.readFileSync(file(`${D}/by-region/sales - Seoul.csv`), 'utf8').startsWith('﻿')).toBe(true)
    expect(fs.readFileSync(file(`${D}/by-region/sales - Seoul.csv`), 'utf8')).toContain('"Tea ""green"""')
    expect(r.text).toContain('Saved 3 files:')
    expect(r.text).toContain('/files/view?path=')
    expect(fs.readFileSync(file(`${D}/sales-2025.csv`), 'utf8')).toBe(SALES_CSV)
    // every saved file is in the turn's file history, made from the CSV
    const ev = A.ctx.db.query("SELECT path, detail FROM file_events WHERE turn_id = ? AND action = 'create'").all(call.turnId) as { path: string; detail: string }[]
    const made = ev.filter((e) => e.detail && JSON.parse(e.detail).tool === 'query_data')
    expect(made.map((e) => e.path).sort()).toEqual(['Capital area', 'Seoul', 'South'].map((x) => `${D}/by-region/sales - ${x}.csv`))
    expect(JSON.parse(made[0]!.detail).from).toBe(`${D}/sales-2025.csv`)
  })

  test('saved as .xlsx: a real workbook with numbers as numbers', async () => {
    const r = await turn('alice')('query_data', { paths: [`${D}/sales-2025.csv`], sql: 'SELECT region, COUNT(*) AS orders, SUM(amount) AS total FROM data GROUP BY region ORDER BY region', save_as: `${D}/regions.xlsx` })
    expect(r.isError, r.text).toBe(false)
    const wb = XLSX.read(fs.readFileSync(file(`${D}/regions.xlsx`)))
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1 })
    expect(rows[0]).toEqual(['region', 'orders', 'total'])
    expect(rows.length).toBe(4)
    expect(typeof rows[1]![1]).toBe('number')
    expect((rows as unknown[][]).slice(1).reduce((n, r) => n + (r[1] as number), 0)).toBe(50_000)
  })

  test('a wrong column name: the error names the tables and columns, so the next try can be right', async () => {
    const r = await turn('alice')('query_data', { paths: [`${D}/sales-2025.csv`], sql: 'SELECT shop FROM data' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('no such column: shop')
    expect(r.text).toContain('Tables: data (order_id integer, date text, store text')
  })
})

describe('other files', () => {
  test('a workbook: every sheet a table, dates as YYYY-MM-DD, a title row skipped with header_row; joined with a CSV', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Store targets 2025'], [], ['store', 'target', 'since'], ['Gangnam', 100, new Date(Date.UTC(2024, 2, 1))], ['Busan', 80, new Date(Date.UTC(2023, 11, 15))]], { cellDates: true }), 'Targets')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['store', 'manager'], ['Gangnam', '김민지'], ['Busan', 'Lee']]), '담당자')
    put(`${D}/targets.xlsx`, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    put(`${D}/small.csv`, 'store,amount\nGangnam,10\nGangnam,5\nBusan,7\n')
    const look = await turn('alice')('query_data', { paths: [`${D}/targets.xlsx`], header_row: 3 })
    expect(look.isError, look.text).toBe(false)
    expect(look.text).toContain("data = 'groups/marketing/data/targets.xlsx' sheet 'Targets': 2 rows; columns: store text, target integer, since text")
    expect(look.text).toContain('2024-03-01')
    const r = await turn('alice')('query_data', {
      paths: [`${D}/small.csv`, `${D}/targets.xlsx`], header_row: 1, sheet: '담당자',
      sql: 'SELECT s.store, SUM(s.amount) AS total, m.manager FROM t1 s JOIN t2 m ON m.store = s.store GROUP BY s.store ORDER BY s.store',
    })
    expect(r.isError, r.text).toBe(false)
    expect(resultRows(r.text).slice(1)).toEqual([['Busan', '7', 'Lee'], ['Gangnam', '15', '김민지']])
    expect(r.text).toContain("'groups/marketing/data/targets.xlsx' also has the sheets 'Targets'")
  })

  test('JSON records and JSONL; nested values as JSON text', async () => {
    put(`${D}/orders.json`, JSON.stringify({ orders: [{ id: 1, total: 9.5, tags: ['a'] }, { id: 2, total: 0.5, extra: 'x' }] }))
    put(`${D}/events.jsonl`, '{"kind":"a"}\n{"kind":"b"}\n\n{"kind":"a"}\n')
    const r = await turn('alice')('query_data', { paths: [`${D}/orders.json`, `${D}/events.jsonl`], sql: "SELECT (SELECT SUM(total) FROM t1) AS total, (SELECT COUNT(*) FROM t2 WHERE kind = 'a') AS a, (SELECT json_extract(tags, '$[0]') FROM t1 WHERE id = 1) AS tag" })
    expect(r.isError, r.text).toBe(false)
    expect(resultRows(r.text)[1]).toEqual(['10', '2', 'a'])
  })

  test('a CP949 CSV from Korean Excel with ";" between fields', async () => {
    put(`${D}/kr.csv`, Buffer.from([...Buffer.from('store;amount\n'), 0xb0, 0xad, 0xb3, 0xb2, ...Buffer.from(';3\n'), 0xb0, 0xad, 0xb3, 0xb2, ...Buffer.from(';4\n')]))
    const r = await turn('alice')('query_data', { paths: [`${D}/kr.csv`], sql: 'SELECT store, SUM(amount) t FROM data GROUP BY store' })
    expect(r.isError, r.text).toBe(false)
    expect(resultRows(r.text)[1]).toEqual(['강남', '7'])
    expect(r.text).toContain('CP949')
  })

  test('not a data file, a folder, a file given twice: refused before any work', async () => {
    const pdf = await turn('alice')('query_data', { paths: ['groups/marketing/brand-guidelines.docx'] })
    expect(pdf.isError).toBe(true)
    expect(pdf.text).toContain('not a data file')
    const dir = await turn('alice')('query_data', { paths: [D] })
    expect(dir.text).toContain('is a folder')
    const twice = await turn('alice')('query_data', { paths: [`${D}/small.csv`, `${D}/small.csv`] })
    expect(twice.text).toContain('given twice')
  })
})

describe('the folder rules', () => {
  test('a file the person cannot open is not found, and nothing goes into the read record', async () => {
    put('groups/finance/ledger.csv', 'item,amount\nCANARY-FIN-7731,1\n')
    const files = new TurnFiles()
    const r = await turn('alice', { files })('query_data', { paths: ['groups/finance/ledger.csv'], sql: 'SELECT * FROM data' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('not found or no access')
    expect(r.text).not.toContain('CANARY')
    expect(files.readPaths.size).toBe(0)
  })
  test('saving into a read-only place, a skills folder, or a wider place without a card: refused, nothing saved', async () => {
    put('projects/falcon/visits.csv', 'day,n\n1,2\n')
    const ro = await turn('bob')('query_data', { paths: ['projects/falcon/visits.csv'], sql: 'SELECT * FROM data', save_as: 'projects/falcon/out.csv' })
    expect(ro.isError).toBe(true)
    expect(ro.text).toContain('read-only')
    expect(fs.existsSync(file('projects/falcon/out.csv'))).toBe(false)
    const sk = await turn('carol')('query_data', { paths: [`${D}/small.csv`], sql: 'SELECT * FROM data', save_as: 'skills/x/out.csv' })
    expect(sk.isError).toBe(true)
    expect(sk.text).toContain('skills folder')
    const wide = await turn('alice')('query_data', { paths: [`${D}/small.csv`], sql: 'SELECT * FROM data', save_as: 'shared/out.csv' })
    expect(wide.isError).toBe(true)
    expect(wide.text).toContain('more people can read')
    expect(fs.existsSync(file('shared/out.csv'))).toBe(false)
  })
  test('a chat card is asked once for the result folder, before the query runs; a "no" saves nothing', async () => {
    const asked: string[] = []
    const no = await turn('alice', { confirmWidening: async (t, s) => { asked.push(`${t}<${s.join(',')}`); return 'The person said no.' } })('query_data', { paths: [`${D}/small.csv`], sql: 'SELECT * FROM data', save_as: 'shared/split/s.csv', split_by: 'store' })
    expect(no.isError).toBe(true)
    expect(asked).toEqual([`shared/split/s - x.csv<${D}/small.csv`])
    expect(fs.existsSync(file('shared/split'))).toBe(false)
    const yes = await turn('alice', { confirmWidening: async () => null })('query_data', { paths: [`${D}/small.csv`], sql: 'SELECT * FROM data', save_as: 'shared/split/s.csv', split_by: 'store' })
    expect(yes.isError, yes.text).toBe(false)
    expect(fs.readdirSync(file('shared/split')).sort()).toEqual(['s - Busan.csv', 's - Gangnam.csv'])
  })
  test('an existing file not read in this turn is never saved over: a conflict copy next to it', async () => {
    put(`${D}/keep.csv`, 'old\n')
    const r = await turn('alice')('query_data', { paths: [`${D}/small.csv`], sql: 'SELECT * FROM data', save_as: `${D}/keep.csv` })
    expect(r.isError, r.text).toBe(false)
    expect(fs.readFileSync(file(`${D}/keep.csv`), 'utf8')).toBe('old\n')
    expect(r.text).toContain('was already there')
  })
})

describe('limits', () => {
  test('too many values to split into files: refused, nothing saved', async () => {
    const r = await turn('alice')('query_data', { paths: [`${D}/sales-2025.csv`], sql: 'SELECT * FROM data', save_as: `${D}/per-order/o.csv`, split_by: 'order_id' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(`more than ${DATA_LIMITS.splitFiles} different values`)
    expect(fs.existsSync(file(`${D}/per-order`))).toBe(false)
  })
  test('the time limit stops the worker and says so plainly', async () => {
    const was = DATA_LIMITS.timeoutMs
    DATA_LIMITS.timeoutMs = 50
    try {
      const r = await turn('alice')('query_data', { paths: [`${D}/sales-2025.csv`], sql: 'SELECT COUNT(*) FROM data a, data b' })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('took longer than')
    } finally { DATA_LIMITS.timeoutMs = was }
  })
  test('a busy server waits, then says to try again', async () => {
    const was = { ...DATA_LIMITS }
    DATA_LIMITS.parallel = 1; DATA_LIMITS.waitMs = 100
    const held = await dataSlot('someone-else')
    try {
      const r = await turn('alice')('query_data', { paths: [`${D}/small.csv`] })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('try again in a moment')
    } finally { held(); Object.assign(DATA_LIMITS, was) }
  })
})

describe('the review cases', () => {
  test('one query at a time per person: a second one of the same person waits, another person goes ahead', async () => {
    const was = { ...DATA_LIMITS }
    DATA_LIMITS.parallel = 2; DATA_LIMITS.waitMs = 150
    const alice = A.ctx.files.principal('alice').id
    const held = await dataSlot(alice)
    try {
      const mine = await turn('alice')('query_data', { paths: [`${D}/small.csv`] })
      expect(mine.isError).toBe(true)
      expect(mine.text).toContain('another data calculation of this person is still running')
      put('groups/finance/q.csv', 'a\n1\n')
      const other = await turn('bob')('query_data', { paths: ['groups/finance/q.csv'] })
      expect(other.isError, other.text).toBe(false)
    } finally { held(); Object.assign(DATA_LIMITS, was) }
  })
  test('save_as one of the inputs is refused; a split file named like an input is not saved over it', async () => {
    const before = fs.readFileSync(file(`${D}/small.csv`), 'utf8')
    const r = await turn('alice')('query_data', { paths: [`${D}/small.csv`], sql: 'SELECT store FROM data', save_as: `${D}/SMALL.csv` })
    expect(r.isError).toBe(true)
    // the same refusal on a case-insensitive Mac and on case-sensitive Linux (checked before authorize)
    expect(r.text).toContain('never changed')
    expect(fs.readFileSync(file(`${D}/small.csv`), 'utf8')).toBe(before)
    put(`${D}/sp/x - Busan.csv`, 'keep\n')
    const s2 = await turn('alice')('query_data', { paths: [`${D}/small.csv`, `${D}/sp/x - Busan.csv`], sql: 'SELECT * FROM t1', save_as: `${D}/sp/x.csv`, split_by: 'store' })
    expect(s2.isError, s2.text).toBe(false)
    expect(s2.text).toContain('NOT saved (1)')
    expect(fs.readFileSync(file(`${D}/sp/x - Busan.csv`), 'utf8')).toBe('keep\n')
    expect(fs.readFileSync(file(`${D}/small.csv`), 'utf8')).toBe(before)
  })
  test('split values: an empty cell and the text "blank" stay apart, letter-case twins get a number, a formula-looking cell is quoted', async () => {
    put(`${D}/odd.csv`, 'k,v\n,1\nblank,2\nSeoul,3\nseoul,4\n=cmd,5\n')
    const r = await turn('alice')('query_data', { paths: [`${D}/odd.csv`], sql: 'SELECT * FROM data', save_as: `${D}/odd/o.csv`, split_by: 'k' })
    expect(r.isError, r.text).toBe(false)
    expect(fs.readdirSync(file(`${D}/odd`)).sort()).toEqual(['o - =cmd.csv', 'o - Seoul.csv', 'o - blank 2.csv', 'o - blank.csv', 'o - seoul 2.csv'])
    expect(csvLines(`${D}/odd/o - =cmd.csv`)[1]).toBe("'=cmd,5")
  })
  test('WITH ... INSERT / DELETE / UPDATE never change anything', async () => {
    const before = fs.readFileSync(file(`${D}/small.csv`), 'utf8')
    for (const sql of ['WITH a AS (SELECT 1) INSERT INTO data VALUES (\'x\', 1)', 'WITH a AS (SELECT 1) DELETE FROM data', 'WITH a AS (SELECT 1) UPDATE data SET amount = 0', 'SELECT 1; DELETE FROM data']) {
      const r = await turn('alice')('query_data', { paths: [`${D}/small.csv`], sql })
      expect(r.isError, sql).toBe(true)
    }
    const after = await turn('alice')('query_data', { paths: [`${D}/small.csv`], sql: 'SELECT COUNT(*) n FROM data' })
    expect(resultRows(after.text)[1]).toEqual(['3'])
    expect(fs.readFileSync(file(`${D}/small.csv`), 'utf8')).toBe(before)
  })
  test.skipIf(isolation() === 'none')('the worker cannot read outside its work folder through the real sandbox (a link to a team file)', async () => {
    put('groups/finance/secret.csv', 'x\nCANARY-FIN-7731\n')
    const work = makeWorkDir(path.join(A.ctx.config.dataDir, 'work'))
    try {
      fs.symlinkSync(file('groups/finance/secret.csv'), path.join(work, 'in-1.csv'))
      const p = runDataWorker(work, { inputs: [{ file: 'in-1.csv', name: 'x.csv', ext: 'csv', table: 'data' }], sql: 'SELECT * FROM data', show: 5 }, 100)
      let text = ''
      try { text = JSON.stringify(await p) } catch (e) { text = String((e as Error).message) }
      expect(text).not.toContain('CANARY-FIN-7731')
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  })
  test('a cross join sorted by random() is stopped by the memory cap, without filling the disk', async () => {
    const work = makeWorkDir(path.join(A.ctx.config.dataDir, 'work'))
    const was = { ...DATA_LIMITS }
    DATA_LIMITS.rssMiB = 400
    const free = () => { const f = fs.statfsSync(work); return f.bavail * f.bsize }
    const start = free()
    let low = start
    const watch = setInterval(() => { try { low = Math.min(low, free()) } catch {} }, 50)
    try {
      fs.writeFileSync(path.join(work, 'in-1.csv'), 'a\n' + Array.from({ length: 20_000 }, (_, i) => i).join('\n') + '\n')
      const t0 = Date.now()
      const err = await runDataWorker(work, { inputs: [{ file: 'in-1.csv', name: 'n.csv', ext: 'csv', table: 'data' }], sql: 'SELECT x.a, y.a FROM data x, data y ORDER BY random()', show: 5 }, 120_000).then(() => null, (e) => e as Error)
      expect(err?.message ?? '').toMatch(/memory/)
      expect(Date.now() - t0).toBeLessThan(DATA_LIMITS.timeoutMs)
      // nothing near the 2.3 GB the old temp files took; the work folder holds only the database
      expect(start - low).toBeLessThan(200 * 1024 * 1024)
    } finally { clearInterval(watch); Object.assign(DATA_LIMITS, was); fs.rmSync(work, { recursive: true, force: true }) }
  })
})

describe('the lists and the prompt', () => {
  test('shared chats, rooms and guests may use it; where it writes; the files it names; its step line', () => {
    expect(SHARED_TOOLS.has('query_data')).toBe(true)
    expect(ROOM_FILE_TOOLS.has('query_data')).toBe(true)
    expect(OWN_WORDS_TOOLS.has('query_data')).toBe(true)
    expect(GUEST_TURN_TOOLS.has('query_data')).toBe(true)
    expect(WRITE_TARGET_ARGS.query_data).toEqual(['save_as'])
    expect(namedPaths('query_data', { paths: ['a.csv', 'b.xlsx'], save_as: 'c.csv' }).map((x) => x.value)).toEqual(['a.csv', 'b.xlsx', 'c.csv'])
    expect(stepLabel('query_data', { paths: ['groups/a.csv', 'b.csv'] }, 'en', new Set())).toBe('Calculate data · groups/a.csv +1')
    expect(stepLabel('query_data', { paths: ['groups/a.csv'] }, 'ko', new Set())).toBe('데이터 계산 · groups/a.csv')
  })
  test('the AI is told to use it instead of refusing, and the dev environment no longer claims big data files', () => {
    expect(QUERY_DATA_RULE).toContain('use query_data')
    expect(QUERY_DATA_RULE).toContain('Never say such work cannot be done here')
    expect(DEV_ENV_WORDS).not.toMatch(/heavier work itself, e\.g\. big data files/)
    expect(DEV_ENV_WORDS).toContain('does not need it')
  })
})
