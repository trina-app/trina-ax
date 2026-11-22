// QA TC-b3s-7 / S-102 (2026-11-22): the AI's answer said the top 3 had 77.6% while the page it made computed 66.9% from
// its own data, and the page showed "출처: …xlsx" with no date. The instructions now say a number in the answer comes from
// the same computation as the file, and a page made from a data file shows the data's date (FIGURES_RULE). A read of a
// spreadsheet or CSV team file says when the file last changed, in the turn's time zone, once a turn per file.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { dataDateNote } from '../../server/src/chat/file-notes'
import { FIGURES_RULE } from '../../server/src/chat/prompt'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const LINE = 'This file was last changed'

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
  return done.data.message.content as string
}

describe('the data date of a spreadsheet or CSV read', () => {
  test('said once a turn per file, in the turn\'s time zone; not for other files, chat places or a failed read', () => {
    const changed = () => '2026-11-22 14:03 (Asia/Seoul)'
    const n = dataDateNote({ name: 'read', isError: false, args: { file_path: 'shared/sales/oct.xlsx' }, changed })
    expect(n?.text).toContain(`${LINE} 2026-11-22 14:03 (Asia/Seoul)`)
    expect(n?.text).toContain('as of 2026-11-22')
    for (const p of ['shared/sales/oct.csv', 'shared/a.XLSX', 'groups/x/b.ods', 'shared/c.tsv']) expect(dataDateNote({ name: 'read', isError: false, args: { file_path: p }, changed })).not.toBeNull()
    expect(dataDateNote({ name: 'read', isError: false, args: { file_path: 'shared/notes.md' }, changed })).toBeNull()
    expect(dataDateNote({ name: 'read', isError: false, args: { file_path: 'chat:files/oct.xlsx' }, changed })).toBeNull()
    expect(dataDateNote({ name: 'read', isError: true, args: { file_path: 'shared/sales/oct.xlsx' }, changed })).toBeNull()
    expect(dataDateNote({ name: 'grep', isError: false, args: { file_path: 'shared/sales/oct.xlsx' }, changed })).toBeNull()
    expect(dataDateNote({ name: 'read', isError: false, args: { file_path: 'shared/sales/oct.xlsx' }, changed: () => null })).toBeNull()
  })

  test('through a real turn: the read result carries the date once; a Markdown file gets none', async () => {
    const out = await ask(`make a dashboard\n${fake(
      { tool: 'read', args: { file_path: 'shared/sales/oct.csv' }, sayResult: true },
      { tool: 'read', args: { file_path: 'shared/sales/oct.csv' }, sayResult: true },
      { tool: 'read', args: { file_path: 'shared/sales/notes.md' }, sayResult: true },
    )}`)
    expect(out.split(LINE).length - 1).toBe(1)
    // the harness user's zone is the team's (Asia/Seoul in the harness) or UTC: the minute is the file's either way
    expect(out).toMatch(/This file was last changed 2026-11-22 (?:14|05):03/)
  })

  test('the instructions: one computed number for the answer and the file, and the data date on a page', () => {
    expect(FIGURES_RULE).toContain('compute it once')
    expect(FIGURES_RULE).toContain("shows its data's date by the source")
  })
})
