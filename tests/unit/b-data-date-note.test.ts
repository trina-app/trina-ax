// QA TC-b3s-7 / S-102 (2026-11-22): the AI's answer said the top 3 had 77.6% while the page it made computed 66.9% from
// its own data, and the page showed "출처: …xlsx" with no date. The instructions now say a number in the answer comes from
// the same computation as the file, and a page made from a data file shows the data's date (FIGURES_RULE). A read of a
// spreadsheet or CSV team file says when the file last changed, in the turn's time zone, once a turn per file.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { API } from '@mycel/shared/api'
import { spokenText, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { dataDateNotes } from '../../server/src/chat/file-notes'
import { FIGURES_RULE } from '../../server/src/chat/prompt'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const LINE = 'was last changed'

let h: Harness
let ws: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-data-date-note', stallTimeoutMs: 60_000 })
  ws = await h.ws('alice'); await ws.next('hello')
  fs.mkdirSync(path.join(h.team, 'shared', 'sales'), { recursive: true })
  fs.writeFileSync(path.join(h.team, 'shared', 'sales', 'oct.csv'), 'client,amount\nA,25.5\nB,12.6\n')
  // 2026-11-22 05:03 UTC = 14:03 in Seoul
  const t = new Date('2026-11-22T05:03:00Z')
  fs.utimesSync(path.join(h.team, 'shared', 'sales', 'oct.csv'), t, t)
  fs.writeFileSync(path.join(h.team, 'shared', 'sales', 'notes.md'), '# notes\n')
})
afterAll(async () => { ws?.close(); await h?.close() })

async function ask(content: string) {
  const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chat }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  const done = await ws.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 40_000)
  return spokenText(h, r.assistantMessage.id)
}

describe('the data date of a spreadsheet or CSV read', () => {
  test('for each spreadsheet or CSV a read or query_data took, in the turn\'s time zone; not for other files, chat places or a failed call', () => {
    const changed = () => '2026-11-22 14:03 (Asia/Seoul)'
    const one = (name: string, args: unknown, isError = false) => dataDateNotes({ name, isError, args, changed })
    const [n] = one('read', { file_path: 'shared/sales/oct.xlsx' })
    expect(n?.text).toContain('oct.xlsx was last changed 2026-11-22 14:03 (Asia/Seoul)')
    expect(n?.text).toContain('as of 2026-11-22')
    for (const p of ['shared/sales/oct.csv', 'shared/a.XLSX', 'groups/x/b.ods', 'shared/c.tsv']) expect(one('read', { file_path: p })).toHaveLength(1)
    // query_data: each data file of its paths (S-102 rerun: the dashboard's numbers came from query_data)
    expect(one('query_data', { paths: ['shared/sales/oct.xlsx', 'shared/sales/notes.md', 'shared/sales/sep.csv'], sql: 'select 1' }).map((x) => x.path)).toEqual(['shared/sales/oct.xlsx', 'shared/sales/sep.csv'])
    expect(one('read', { file_path: 'shared/notes.md' })).toEqual([])
    expect(one('read', { file_path: 'chat:files/oct.xlsx' })).toEqual([])
    expect(one('read', { file_path: 'shared/sales/oct.xlsx' }, true)).toEqual([])
    expect(one('grep', { file_path: 'shared/sales/oct.xlsx' })).toEqual([])
    expect(dataDateNotes({ name: 'read', isError: false, args: { file_path: 'shared/sales/oct.xlsx' }, changed: () => null })).toEqual([])
  })

  test('through a real turn: the read result carries the date once; a Markdown file gets none', async () => {
    const out = await ask(`make a dashboard\n${fake(
      { tool: 'read', args: { file_path: 'shared/sales/oct.csv' }, sayResult: true },
      { tool: 'read', args: { file_path: 'shared/sales/oct.csv' }, sayResult: true },
      { tool: 'read', args: { file_path: 'shared/sales/notes.md' }, sayResult: true },
    )}`)
    expect(out.split(LINE).length - 1).toBe(1)
    // the harness user's zone is the team's (Asia/Seoul in the harness) or UTC: the minute is the file's either way
    expect(out).toMatch(/oct\.csv was last changed 2026-11-22 (?:14|05):03 \(/)
  })

  test('the instructions: one computed number for the answer and the file, and the data date on a page', () => {
    expect(FIGURES_RULE).toContain('compute it once')
    expect(FIGURES_RULE).toContain("shows its data's date by the source, as a tool result gives it (none given: no date)")
  })
})
