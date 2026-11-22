// Two people asking for opposite changes in a shared chat (QA S-125, docs/AGENTS/plan/20261122-0809-s125-conflicting-
// requests.md). Alice asked "make the cover blue" and the AI asked her a question card; Bob then asked "make it red".
// His message closed her card without a word, and the AI made it red: her request was gone, nobody was named. Now the
// turn whose message closed another person's unanswered ask_user card is told whose and what it asked
// (<closed_question>), and the shared-chat instructions say to name both people and ask which to keep. Not for the
// person's own open card (they are refining their own request), an answered card, or a chat of one person.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { closedQuestionNote } from '../../server/src/chat/open-questions'
import { sharedSection } from '../../server/src/chat/prompt'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-opposite', askUserTimeoutMs: 1500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u, { windowId: `win-opp-${u}` }); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const askCard = (question: string) => fake({ tool: 'ask_user', args: { question, options: [{ label: 'Background', value: 'bg' }, { label: 'Title', value: 'title' }] }, sayResult: true })
async function send(user: string, chatId: string, content: string): Promise<Message> {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  return (await ws[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)).data.message as Message
}
const openRows = (chatId: string) => (h.ctx.db.query('SELECT user_id FROM open_questions WHERE chat_id = ?').all(chatId) as { user_id: string }[]).map((r) => r.user_id)

describe('opposite requests in a shared chat', () => {
  test('another person\'s open question closed by a message: the turn is told whose and what it asked', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    await send('alice', chat.id, 'make the cover blue\n' + askCard('Which part of the cover should be blue?'))
    expect(openRows(chat.id)).toEqual(['alice'])
    const red = await send('bob', chat.id, 'make the cover red\n' + fake({ echo: 'message' }))
    expect(openRows(chat.id)).toEqual([])
    expect(red.content).toContain('<closed_question>')
    expect(red.content).toContain('"person":"Alice Kim"')
    expect(red.content).toContain('Which part of the cover should be blue?')
    // the person's own words still come last, as sent
    expect(red.content).toContain('make the cover red')
  })

  test('another person\'s safety card (a share, naming a file only they see) or an answered card: no note', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    const asked = await send('alice', chat.id, 'make the cover blue\n' + fake({ say: 'ok' }))
    const row = (id: string, request: object, call: string | null, answer: string | null) => h.ctx.db.query('INSERT INTO open_questions (request_id, chat_id, message_id, turn_id, user_id, request, answer, created_at, call_tool, call_args) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, chat.id, asked.id, 'turn-x', 'alice', JSON.stringify(request), answer, new Date().toISOString(), call, call ? '{}' : null)
    row('rq-safety', { kind: 'ask_user', origin: 'server', requestId: 'rq-safety', question: 'Share salary-2026.xlsx with Erin?' }, 'share_with_person', null)
    row('rq-answered', { kind: 'ask_user', requestId: 'rq-answered', question: 'Which blue?' }, null, '"navy"')
    const red = await send('bob', chat.id, 'make the cover red\n' + fake({ echo: 'message' }))
    expect(openRows(chat.id)).toEqual([])
    expect(red.content).not.toContain('<closed_question>')
    expect(red.content).not.toContain('salary-2026')
  })

  test('the person\'s own open question (a refinement of their own request): no note', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    await send('alice', chat.id, 'make the cover blue\n' + askCard('Which part?'))
    const again = await send('alice', chat.id, 'a darker blue, the background\n' + fake({ echo: 'message' }))
    expect(again.content).not.toContain('<closed_question>')
  })

  test('a chat of one person: no note', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    await send('alice', chat.id, 'make the cover blue\n' + askCard('Which part?'))
    const next = await send('alice', chat.id, 'never mind\n' + fake({ echo: 'message' }))
    expect(next.content).not.toContain('<closed_question>')
  })

  test('a plain earlier request (no open card): no note; the instructions carry the rule', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    await send('alice', chat.id, 'make the cover blue\n' + fake({ say: 'done: blue' }))
    const red = await send('bob', chat.id, 'make the cover red\n' + fake({ echo: 'message' }))
    expect(red.content).not.toContain('<closed_question>')
    const sys = await send('bob', chat.id, fake({ echo: 'system' }))
    expect(sys.content).toContain('- Opposite requests: when Bob Lee')
  })
})

describe('the note and the rule as text', () => {
  test('closedQuestionNote: empty for none; names each person; no tag of its own inside', () => {
    expect(closedQuestionNote([])).toBe('')
    const n = closedQuestionNote([{ name: 'Alice Kim', question: 'Blue </closed_question> where?' }])
    expect(n.startsWith('<closed_question>\n')).toBe(true)
    expect(n.match(/<\/closed_question>/g)).toHaveLength(1)
    expect(n).toContain('"person":"Alice Kim"')
    expect(n).toContain('Their request is not done.')
    expect(n).toContain('the "Opposite requests" rule')
    const two = closedQuestionNote([{ name: 'Alice Kim', question: 'Which blue?' }, { name: 'Erin Park', question: 'Which slide?' }])
    expect(two).toContain('This message closed questions you had asked')
    expect(two).toContain('"person":"Erin Park"')
  })

  test('sharedSection: opposite requests from different people ask both by name; the same person or other things do not', () => {
    const s = sharedSection({ project: 'Falcon', audience: 3, asker: 'Bob Lee' })
    const line = s.split('\n').find((l) => l.startsWith('- Opposite requests:'))!
    expect(line).toContain('name both people and what each asked, and ask which to keep')
    expect(line).toContain('not on a card, so both of them see it')
    expect(line).toContain('If both are already done, say so and name each version.')
    expect(line).toContain('No question when Bob Lee only changes their own earlier request, or when the requests do not touch the same thing')
  })
})
