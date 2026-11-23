// The asks left after batch 5's count (docs/AGENTS/plan/20261123-0745-b5-asks-left.md):
// F10 in my own project chat a save into my own folder asks nothing (as its read since #426); after someone else wrote
//     in the chat, and in a chat shared with people, the save card stays.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type TurnRequest, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { missingService } from '../../server/src/integrations/connections/tools'
import { ANSWER_END_RULE } from '../../server/src/chat/prompt'

setDefaultTimeout(120_000)
const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives as JSON escapes: the person's own words are only what the test writes around them
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
type Ask = Extract<TurnRequest, { kind: 'ask_user' }>

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId = ''
beforeAll(async () => {
  h = await startHarness({ name: 'b5-asks-left', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  db.query("UPDATE users SET prefs = json_set(COALESCE(prefs, '{}'), '$.autoMemory', 'off')").run()
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u, { windowId: `win-b5l-${u}` }); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h?.close() })

const at = (rel: string) => path.join(h.team, rel)
const put = (rel: string, body = 'x\n') => { fs.mkdirSync(path.dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), body) }
const read = (rel: string) => fs.readFileSync(at(rel), 'utf8')
const versions = (rel: string) => (h.ctx.db.query('SELECT COUNT(*) n FROM file_versions WHERE path = ?').get(rel) as { n: number }).n
const roomRead = (room: string) => ({ tool: 'room_read', args: { room } })
const write = (file_path: string, content: string) => ({ tool: 'write', args: { file_path, content } })
/** a write over a file that is there reads it first in the same answer (the write tool's own rule) */
const readW = (file_path: string) => ({ tool: 'read', args: { file_path } })

/** one answer; each card it raises is answered by `answer` ("skip" by default); its cards and answer */
async function run(user: string, chatId: string, content: string, answer: (c: Ask) => string = () => 'skip') {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Ask[] = []
  const end = Date.now() + 60_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === x.data.request.requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as Ask
      cards.push(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: answer(c) } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, done: done.data.message }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}

describe('F10: a save into my own folder in my own project chat', () => {
  test('no card; after another person wrote in the chat the save card is back', async () => {
    const tag = uuidv7().slice(-6)
    const file = `users/alice/quote-${tag}.html`
    put(file, '<p>old</p>\n')
    const chat = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
    const r = await run('alice', chat, `견적서 다시 만들어줘\n${fake(readW(file), write(file, '<p>1,100,000</p>\n'), { say: 'done' })}`)
    expect(r.cards).toHaveLength(0)
    expect(read(file)).toBe('<p>1,100,000</p>\n')
    // bob writes in the chat: his words could pick the name now
    await run('bob', chat, `hi\n${fake({ say: 'hi bob' })}`)
    const again = await run('alice', chat, `다시 저장해줘\n${fake(readW(file), write(file, '<p>again</p>\n'), { say: 'done' })}`)
    expect(again.cards).toHaveLength(1)
    expect(again.cards[0]!.question).toContain('save')
  })

  test('a chat shared with people (not a project chat) keeps the save card', async () => {
    const tag = uuidv7().slice(-6)
    const file = `users/alice/people-${tag}.html`
    put(file, '<p>old</p>\n')
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    await run('alice', c, `hello\n${fake({ say: 'hi' })}`)
    const subjects = [{ subjectType: 'user' as const, subjectId: 'bob' }]
    let s: PutChatAudienceResult = await h.api('alice').call(API.putChatAudience, { params: { id: c }, body: { subjects } })
    if (s.status === 'confirm') s = await h.api('alice').call(API.putChatAudience, { params: { id: c }, body: { subjects, confirmKey: s.confirmKey } })
    const r = await run('alice', c, `견적서 다시 만들어줘\n${fake(write(file, '<p>new</p>\n'), { say: 'done' })}`)
    expect(r.cards).toHaveLength(1)
    expect(read(file)).toBe('<p>old</p>\n')
  })
})

describe('the words the AI gets', () => {
  test('a service that is not connected: one sentence where no connect card can be offered; the card rule elsewhere', () => {
    expect(missingService(true, true)).toBe('')
    expect(missingService(true, false)).toContain('/settings/connectors')
    expect(missingService(false, false)).toContain('owner or admin')
    expect(missingService(false, false)).not.toContain('/settings/connectors')
  })
  test('an answer ends when the task is done', () => {
    expect(ANSWER_END_RULE).toContain('do not end with an offer or a question')
  })
})
