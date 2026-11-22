// Ask less (QA TC-f1x S-005/S-012, docs/decisions/20261122-ask-less.md): in a chat shared with people, a search or a
// listing (glob, grep, list) in a folder everyone in the chat can open leaves out the places below it that some of them
// cannot open, with no read card, and its result says how many, never which (chat/turn.ts sharedSearchLeftOut). Before,
// the AI's broad glob while looking for the folder asked about restricted sub-folders nobody named. A path that is itself
// such a place, and a read of a file there, still ask on the card. alice and bob both open shared/; under
// shared/qa-left/ the folder QA-Restricted is alice's alone, bob-PRIVATE bob's alone (alice cannot open it, so it is
// not counted to her either).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { searchLeftOutNote } from '../../server/src/chat/search-path'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const BASE = 'shared/qa-left'
const MINE = `${BASE}/QA-Restricted`
const BOBS = `${BASE}/bob-PRIVATE`

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-search-left-out', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const db = h.ctx.db
  const limit = (id: string, p: string, who: string) => {
    db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run(id, p)
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'everyone', NULL, 'none')").run(crypto.randomUUID(), id)
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', ?, 'write')").run(crypto.randomUUID(), id, who)
  }
  limit('f_left_mine', MINE, 'alice')
  limit('f_left_bobs', BOBS, 'bob')
  for (const d of [MINE, BOBS, `${BASE}/meetings`]) fs.mkdirSync(path.join(h.team, d), { recursive: true })
  fs.writeFileSync(path.join(h.team, MINE, 'salary-CUTS.md'), 'CANARY-LEFT budget minutes')
  fs.writeFileSync(path.join(h.team, BOBS, 'bob-notes.md'), 'CANARY-BOB budget minutes')
  fs.writeFileSync(path.join(h.team, BASE, 'meetings', 'minutes-open.md'), 'Open budget minutes')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const cards = (chatId: string) => (h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'chat.shared_read' AND target = ?").get(chatId) as { n: number }).n
const send = (chatId: string, content: string) =>
  h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
async function sharedChat() {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  const s = await send(c.id, `hello\n${fake({ say: 'hi' })}`)
  await ws.alice!.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 30_000)
  const subjects = [{ subjectType: 'user' as const, subjectId: 'bob' }]
  let r = await h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects } })
  if (r.status === 'confirm') r = await h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects, confirmKey: r.confirmKey } })
  if (r.status !== 'saved') throw new Error('not shared')
  return c.id
}
/** alice's turn; no card may come (a card would time out: the run is checked below) */
async function ask(chatId: string, content: string) {
  const started = await send(chatId, content)
  const done = await ws.alice!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  const asked = ws.alice!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === started.turnId)
  return { content: done.data.message.content as string, asked }
}
const leaks = (s: string) => /QA-Restricted|salary-CUTS|CANARY-LEFT|bob-PRIVATE|bob-notes|CANARY-BOB/i.test(s)

describe('a broad search or listing in a shared chat', () => {
  test('glob over a folder everyone opens: no card, the open files, a count without names', async () => {
    const chat = await sharedChat()
    const r = await ask(chat, fake({ tool: 'glob', args: { pattern: '**/*.md', path: BASE }, sayResult: true }))
    expect(r.asked).toBe(false)
    expect(cards(chat)).toBe(0)
    expect(r.content).toContain('minutes-open.md')
    expect(leaks(r.content)).toBe(false)
    // QA-Restricted counts (alice could open it); bob-PRIVATE does not (she cannot: not even its number reaches her)
    expect(r.content).toContain(searchLeftOutNote(1))
  })

  test('grep over a higher folder (shared/): no card, nothing from the left-out places', async () => {
    const chat = await sharedChat()
    const r = await ask(chat, fake({ tool: 'grep', args: { pattern: 'budget minutes', path: 'shared', output_mode: 'content' }, sayResult: true }))
    expect(r.asked).toBe(false)
    expect(cards(chat)).toBe(0)
    expect(r.content).toContain('Open budget minutes')
    expect(leaks(r.content)).toBe(false)
    expect(r.content).toContain(searchLeftOutNote(1))
  })

  test('list: the folder that holds them leaves them out with the count; one level up nothing is left out', async () => {
    const chat = await sharedChat()
    const r = await ask(chat, fake({ tool: 'list', args: { path: BASE }, sayResult: true }))
    expect(r.asked).toBe(false)
    expect(cards(chat)).toBe(0)
    expect(r.content).toContain('meetings')
    expect(leaks(r.content)).toBe(false)
    expect(r.content).toContain(searchLeftOutNote(1))
    const up = await ask(chat, fake({ tool: 'list', args: { path: 'shared' }, sayResult: true }))
    expect(up.asked).toBe(false)
    expect(up.content).toContain('qa-left')
    expect(up.content).not.toContain('left out because')
  })

  test('bob sees no step or text that names them', async () => {
    const chat = await sharedChat()
    await ask(chat, fake({ tool: 'glob', args: { pattern: '**/*', path: BASE } }, { tool: 'list', args: { path: BASE } }, { say: 'done' }))
    const forBob = (await h.api('bob').call(API.listMessages, { params: { id: chat }, query: {} })).items as Message[]
    expect(leaks(JSON.stringify(forBob))).toBe(false)
  })
})

describe('a path that is itself a place some people here cannot open', () => {
  const cardOf = (turnId: string) => ws.alice!.next('turn.request', (f) => f.data.turnId === turnId, 15_000)
  const answer = (turnId: string, requestId: string, value: 'share' | 'skip') =>
    h.api('alice').call(API.answerTurn, { params: { id: turnId }, body: { kind: 'ask_user', requestId, answer: value } })

  for (const call of [
    { tool: 'list', args: { path: MINE } },
    { tool: 'glob', args: { pattern: '*', path: MINE } },
    { tool: 'read', args: { file_path: `${MINE}/salary-CUTS.md` } },
  ]) {
    test(`${call.tool} there asks on the card as before; a no reads nothing`, async () => {
      const chat = await sharedChat()
      const started = await send(chat, fake({ ...call, sayResult: true }))
      const card = await cardOf(started.turnId)
      await answer(started.turnId, card.data.request.requestId, 'skip')
      const done = (await ws.alice!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)).data.message
      expect(done.content).not.toContain('CANARY-LEFT')
      expect(done.content).not.toContain('left out because')
    })
  }
})
