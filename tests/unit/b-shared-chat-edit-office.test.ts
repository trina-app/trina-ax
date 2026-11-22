// A team Word, Excel or PowerPoint file changed from a shared chat (scenario QA S-028, TC-r2c-F1;
// docs/decisions/20261122-shared-chat-team-office-edit.md): edit_office works there as edit_hwp and comment_docx do,
// with the asker's own access. The document counts as read by the chat (a file some of its people cannot open asks with
// the read card first, which only the asker sees), a read-only folder refuses, and nothing changes without a yes.
// Alice shares a chat with bob and the marketing group (erin); a project chat on projects/falcon (alice writes it).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from '../../server/node_modules/xlsx'
import ExcelJS from '../../server/node_modules/exceljs'
import { API, type PutChatAudienceResult, type TurnRequest } from '@mycel/shared/api'
import { namedPaths, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { sharedSection } from '../../server/src/chat/prompt'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-edit-office', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u, { windowId: `win-seo-${u}` }); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: 'Falcon project notes.' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const abs = (rel: string) => path.join(h.team, rel)
const put = (rel: string, b: Uint8Array) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), b) }
async function workbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('Sales')
  sheet.addRow(['Client', 'Oct', 'Nov'])
  sheet.addRow(['Hansol', 100, null])
  sheet.addRow(['Daon', 200, null])
  return new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
}
const cell = (rel: string, ref: string) => XLSX.read(new Uint8Array(fs.readFileSync(abs(rel))), { type: 'array' }).Sheets['Sales']![ref]?.v

type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const putAudience = (chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
  h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
async function patient<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f() } catch (e) { if ((e as { status?: number }).status !== 429 || i > 20) throw e; await Bun.sleep(1100) }
  }
}
type Ask = TurnRequest & { requestId: string; question?: string; options?: { label: string; value: string }[] }
/** one answer by `user` in the chat, each card answered with the next of `answers` (the last one repeats) */
async function turn(user: string, chatId: string, content: string, answers: string[] = ['skip']) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Ask[] = []
  const seen = new Set<string>()
  for (let waited = 0; ; waited += 50) {
    if (waited > 80_000) throw new Error('the answer did not end')
    for (const f of ws[user]!.frames) {
      if (f.type !== 'turn.request' || f.data.turnId !== r.turnId || seen.has(f.data.request.requestId)) continue
      seen.add(f.data.request.requestId)
      cards.push(f.data.request as Ask)
      const answer = answers[Math.min(cards.length - 1, answers.length - 1)]!
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: f.data.request.requestId, answer } })
    }
    const done = ws[user]!.frames.find((f) => f.type === 'message.done' && f.data.messageId === r.assistantMessage.id)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, content: done.data.message.content as string }
    await Bun.sleep(50)
  }
}
let n = 0
/** a chat alice shares with bob and the marketing group (erin) */
async function peopleChat() {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await turn('alice', c.id, `hello ${++n}\n${fake({ say: 'hi' })}`)
  const subjects: Sub[] = [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'group', subjectId: 'marketing' }]
  let r = await patient(() => putAudience(c.id, subjects))
  if (r.status === 'confirm') { const key = r.confirmKey; r = await patient(() => putAudience(c.id, subjects, key)) }
  if (r.status !== 'saved') throw new Error('not shared')
  return c.id as string
}
const setCell = (p: string, ref: string, value: unknown) => fake(
  { tool: 'read', args: { file_path: p } },
  { tool: 'edit_office', args: { file_path: p, changes: [{ cell: { ref, value } }] }, sayResult: true },
)

describe('edit_office on a team file in a chat shared with people (S-028)', () => {
  test('two people each change the team workbook they can both edit: a new version each, no card (before: refused)', async () => {
    expect(SHARED_TOOLS.has('edit_office')).toBe(true)
    put('shared/r2c/sales.xlsx', await workbook())
    const chat = await peopleChat()
    const b = await turn('bob', chat, setCell('shared/r2c/sales.xlsx', 'C2', 150))
    expect(b.cards).toEqual([])
    expect(b.content).toContain('Saved a new version of shared/r2c/sales.xlsx')
    expect(cell('shared/r2c/sales.xlsx', 'C2')).toBe(150)
    const e = await turn('erin', chat, setCell('shared/r2c/sales.xlsx', 'C3', 250))
    expect(e.cards).toEqual([])
    expect(e.content).toContain('Saved a new version of shared/r2c/sales.xlsx')
    expect(cell('shared/r2c/sales.xlsx', 'C2')).toBe(150)
    expect(cell('shared/r2c/sales.xlsx', 'C3')).toBe(250)
    expect(cell('shared/r2c/sales.xlsx', 'B2')).toBe(100)
    // the earlier bytes are kept: the file's history has bob's and erin's saves
    const hist = await h.api('alice').call(API.history, { query: { path: 'shared/r2c/sales.xlsx' } })
    expect(hist.items.length).toBeGreaterThanOrEqual(2)
    // bob's card would have been his alone: erin and alice got none of bob's turn
    expect(ws.alice!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === b.turnId)).toBe(false)
  })

  test('a workbook some people here cannot open: the asker\'s read card first; "no" changes nothing', async () => {
    // groups/finance: bob writes it, erin (marketing) cannot open it
    put('groups/finance/r2c-forecast.xlsx', await workbook())
    const before = fs.readFileSync(abs('groups/finance/r2c-forecast.xlsx'))
    const chat = await peopleChat()
    const no = await turn('bob', chat, setCell('groups/finance/r2c-forecast.xlsx', 'C2', 999), ['skip'])
    expect(no.cards.length).toBeGreaterThanOrEqual(1)
    expect(no.cards[0]!.options?.map((o) => o.value)).toContain('share')
    expect(fs.readFileSync(abs('groups/finance/r2c-forecast.xlsx')).equals(before)).toBe(true)
    expect(ws.erin!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === no.turnId)).toBe(false)
  })

  test('a folder that is read-only for the asker: refused, nothing changed', async () => {
    // projects/falcon: alice writes, finance (bob) reads
    put('projects/falcon/r2c-plan.xlsx', await workbook())
    const before = fs.readFileSync(abs('projects/falcon/r2c-plan.xlsx'))
    const chat = await peopleChat()
    const r = await turn('bob', chat, setCell('projects/falcon/r2c-plan.xlsx', 'C2', 1), ['share'])
    expect(r.content).not.toContain('Saved a new version')
    expect(fs.readFileSync(abs('projects/falcon/r2c-plan.xlsx')).equals(before)).toBe(true)
  })

  test('a replacement picture counts as a read of the chat, like the document (the read card weighs it)', () => {
    const named = namedPaths('edit_office', { file_path: 'shared/deck.pptx', changes: [{ slide: 1, replace_picture: { image: 'users/bob/photo.png' } }] })
    expect(named).toContainEqual({ key: 'file_path', value: 'shared/deck.pptx' })
    expect(named).toContainEqual({ key: 'replace_picture.image', value: 'users/bob/photo.png' })
  })

  test('a team skill\'s workbook: refused before any card, nothing changed', async () => {
    const chat = await peopleChat()
    const r = await turn('bob', chat, fake({ tool: 'edit_office', args: { file_path: 'skills/r2c/sheet.xlsx', changes: [{ cell: { ref: 'A1', value: 1 } }] }, sayResult: true }))
    expect(r.cards).toEqual([])
    expect(r.content).not.toContain('Saved a new version')
  })

  test('the shared chat instructions say a team file is changed here with the asker\'s access', () => {
    const t = sharedSection({ project: null, audience: 3, asker: 'Bob' } as never, 'en', false)
    expect(t).toContain('Changing a team file works here')
    expect(t).toContain('edit_office without output')
  })
})

describe('edit_office in a shared project chat', () => {
  test('offered, and the project\'s own workbook gets a new version', async () => {
    put('projects/falcon/r2c-budget.xlsx', await workbook())
    const chat = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
    const tools = await turn('alice', chat, fake({ echo: 'tools' }))
    expect(tools.content.split(',')).toContain('edit_office')
    const r = await turn('alice', chat, setCell('projects/falcon/r2c-budget.xlsx', 'C2', 42))
    expect(r.cards).toEqual([])
    expect(r.content).toContain('Saved a new version of projects/falcon/r2c-budget.xlsx')
    expect(cell('projects/falcon/r2c-budget.xlsx', 'C2')).toBe(42)
  })
})
