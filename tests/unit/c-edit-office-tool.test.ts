// edit_office through a chat turn (tools/edit-office.ts; QA TC-4906): read first, a new version of the same file with
// the old one in its history, a new file with `output`, the wider-audience check for what the chat read and for a new
// picture, never skills/, Excel values read as make_file reads them; and the server's own check of the zip parts.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import * as XLSX from '../../server/node_modules/xlsx'
import ExcelJS from '../../server/node_modules/exceljs'
import { API } from '@mycel/shared/api'
import { which } from '../../server/src/config'
import { outsideContentTool } from '../../server/src/chat/team-content-tools'
import { EDIT_OFFICE_DESCRIPTION, editOfficeOutput, officePartsMismatch } from '../../server/src/tools/edit-office'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(90_000)
const pandoc = which('pandoc')
const withPandoc = pandoc ? test : test.skip

function docx(md: string): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from(md) })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return new Uint8Array(r.stdout)
}
async function workbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Budget')
  ws.addRow(['Item', 'Amount'])
  ws.addRow(['Rent', 1200])
  ws.getCell('B2').numFmt = '#,##0'
  return new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
}

describe('edit_office: the tool', () => {
  test('told to the AI; a team-content tool; outputs keep the format', () => {
    expect(EDIT_OFFICE_DESCRIPTION).toContain('stays exactly as it was')
    expect(EDIT_OFFICE_DESCRIPTION).toContain('use make_file only for a new file')
    expect(outsideContentTool('edit_office')).toBe(false)
    expect(editOfficeOutput('out/new', 'a/b.xlsx')).toBe('out/new.xlsx')
    expect(editOfficeOutput('out/new.pptx', 'a/b.pptx')).toBe('out/new.pptx')
  })

  withPandoc('the server\'s part check: a part outside the edit that changed, or one the report hides, is caught', () => {
    const a = docx('# T\n\nhello\n')
    const touch = (b: Uint8Array, name: string) => writeZip(readZip(b).map((e) => (e.name === name ? { name: e.name, data: new TextEncoder().encode(new TextDecoder().decode(e.data) + ' ') } : e)))
    const doc = touch(a, 'word/document.xml')
    expect(officePartsMismatch('docx', a, doc, { changed: ['word/document.xml'], added: [], removed: [] })).toBeNull()
    expect(officePartsMismatch('docx', a, doc, { changed: [], added: [], removed: [] })).toContain('word/document.xml changed')
    const styles = touch(a, '[Content_Types].xml')
    expect(officePartsMismatch('docx', a, styles, { changed: ['[Content_Types].xml'], added: [], removed: [] })).toContain('not changed here')
    const extra = writeZip([...readZip(a), { name: 'word/evil.bin', data: new Uint8Array([1]) }])
    expect(officePartsMismatch('docx', a, extra, { changed: [], added: [], removed: [] })).toContain('a new part word/evil.bin')
  })
})

let h: Harness
let bob: TestSocket
const put = (rel: string, data: string | Uint8Array) => { const p = path.join(h.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const read = (rel: string) => new Uint8Array(fs.readFileSync(path.join(h.team, ...rel.split('/'))))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

describe('edit_office: saved like edit_hwp and comment_docx', () => {
  beforeAll(async () => {
    h = await startHarness({ name: 'c-edit-office', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
    bob = await h.ws('bob', { windowId: 'win-edit-office-bob' })
    await bob.next('hello')
    if (pandoc) put('shared/contracts/supply.docx', docx('# Supply Contract\n\nPayment is due on the 25th.\n'))
    put('shared/finance/budget.xlsx', await workbook())
  })
  afterAll(async () => { bob?.close(); await h?.close() })

  async function turn(content: string) {
    const chat = await h.api('bob').call(API.createChat, { body: {} })
    const r = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const done = await bob.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 75_000)
    return { turnId: r.turnId as string, content: done.data.message.content as string }
  }
  const call = { tool: 'edit_office', args: { file_path: 'shared/contracts/supply.docx', changes: [{ find: '25th', replace: 'last day of the month' }] }, sayResult: true }

  withPandoc('not read in this turn: refused, the file unchanged', async () => {
    const before = read('shared/contracts/supply.docx')
    const r = await turn(fake(call))
    expect(r.content).toContain('first (with read) before changing it')
    expect(Buffer.from(read('shared/contracts/supply.docx')).equals(Buffer.from(before))).toBe(true)
  })

  withPandoc('read, then changed: a new version of the same file, the change in it, the old one in its history', async () => {
    const r = await turn(fake({ tool: 'read', args: { file_path: 'shared/contracts/supply.docx' } }, call))
    expect(r.content).toContain('Saved a new version of shared/contracts/supply.docx')
    expect(r.content).toContain('"Payment is due on the 25th." -> "Payment is due on the last day of the month."')
    const doc = new TextDecoder().decode(readZip(read('shared/contracts/supply.docx')).find((e) => e.name === 'word/document.xml')!.data)
    expect(doc).toContain('last day of the month')
    const versions = h.ctx.db.query('SELECT count(*) AS n FROM file_versions WHERE path = ?').get('shared/contracts/supply.docx') as { n: number }
    expect(versions.n).toBeGreaterThan(0)
  })

  test('Excel: "1,500" is a number in the cell\'s style, a formula is checked, an outside formula refused', async () => {
    const r = await turn(fake({ tool: 'read', args: { file_path: 'shared/finance/budget.xlsx' } }, { tool: 'edit_office', args: { file_path: 'shared/finance/budget.xlsx', changes: [{ cell: { ref: 'B2', value: '1,500' } }, { cell: { ref: 'B3', value: '=sum(B2)' } }] }, sayResult: true }))
    expect(r.content).toContain('Saved a new version of shared/finance/budget.xlsx')
    expect(r.content).toContain('Formulas are calculated again')
    const ws = XLSX.read(read('shared/finance/budget.xlsx'), { type: 'array', cellFormula: true, cellNF: true, sheetStubs: true }).Sheets.Budget!
    expect(ws.B2!.v).toBe(1500)
    expect(ws.B2!.z).toBe('#,##0')
    expect(ws.B3!.f).toBe('SUM(B2)')
    const bad = await turn(fake({ tool: 'read', args: { file_path: 'shared/finance/budget.xlsx' } }, { tool: 'edit_office', args: { file_path: 'shared/finance/budget.xlsx', changes: [{ cell: { ref: 'C2', value: '=WEBSERVICE("http://x")' } }] }, sayResult: true }))
    expect(bad.content).toContain('WEBSERVICE is not allowed')
  })

  withPandoc('a change for another format is refused with words; a skills folder as output is refused', async () => {
    const r = await turn(fake({ tool: 'read', args: { file_path: 'shared/contracts/supply.docx' } }, { tool: 'edit_office', args: { file_path: 'shared/contracts/supply.docx', changes: [{ cell: { ref: 'A1', value: 1 } }] }, sayResult: true }))
    expect(r.content).toContain('cell and append_rows are for Excel workbooks')
    const s = await turn(fake({ tool: 'read', args: { file_path: 'shared/contracts/supply.docx' } }, { ...call, args: { ...call.args, output: 'skills/x/supply.docx' } }))
    expect(s.content).toContain('cannot be saved in a skills folder')
  })

  withPandoc('what the chat read may not go where more people see it unasked: a private file read first, then a change asks (no answer: nothing saved)', async () => {
    put('users/bob/private.md', 'Private note: unit price 25,000')
    const before = read('shared/contracts/supply.docx')
    const r = await turn(fake({ tool: 'read', args: { file_path: 'users/bob/private.md' } }, { tool: 'read', args: { file_path: 'shared/contracts/supply.docx' } }, { ...call, args: { ...call.args, changes: [{ find: 'Payment', replace: 'Unit price 25,000. Payment' }] } }))
    expect(r.content).toContain('more people can see that folder')
    expect(Buffer.from(read('shared/contracts/supply.docx')).equals(Buffer.from(before))).toBe(true)
  })
})
