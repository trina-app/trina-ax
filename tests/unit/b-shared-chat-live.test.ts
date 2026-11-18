// A running answer of a shared chat streams to everyone who sees the chat (docs/decisions/
// 20261118-shared-chat-live-answers.md, QA TC-4961), with the fake engine through the real launcher and gate. The project
// is on projects/falcon: alice writes it, the finance group (bob) reads it, so both see its shared chats; gina (finance,
// added here) joins later. Covered: bob gets alice's text as it is written, over the socket and over REST while it runs,
// and the finished message as he sees it (no usage); he never gets her cards, queue positions, busy notices, step
// details or a step line naming a place he cannot see; nothing of her own connection before her yes on the card; a
// person who joins after the answer used her own connection gets nothing more of it, and someone who stops seeing the
// chat gets nothing more at once.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Message, type ServerFrame } from '@mycel/shared/api'
import { addTestPerson, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { stopTurnsIn } from '../../server/src/chat/runtime'
import { LIVE_VIEWERS_MS } from '../../server/src/chat/live-answer'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const MINE_TOOL = 'my_alicemail__search_tasks'
const BRIEF = 'groups/marketing/campaign-brief.md'

let h: Harness, svc: FakeServices
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-live', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  h.ctx.db.query("INSERT INTO users (id, username, name, role) VALUES ('gina', 'gina', 'Gina Han', 'member')").run()
  addTestPerson('gina', { id: 'gina', name: 'Gina Han', role: 'member', locale: 'en' })
  for (const u of ['alice', 'bob', 'gina', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  svc = new FakeServices()
  integrationsOf(h.ctx, { net: svc.net() })
  const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Alice Mail', url: `${svc.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY, writePolicy: 'ask' } as never })
  expect(mine.status).toBe('connected')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); svc?.stop(); await h?.close() })

const db = () => h.ctx.db
const newShared = async (user = 'alice') => h.api(user).call(API.createChat, { body: { projectId } })
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
const doneFor = async (user: string, messageId: string) => (await ws[user]!.next('message.done', (f) => f.data.messageId === messageId, 30_000)).data.message as Message
const idle = (chatId: string) => waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
const ofMessage = (user: string, messageId: string, from = 0) => ws[user]!.frames.slice(from).filter((f) => (f as { data?: { messageId?: string } }).data?.messageId === messageId)
const ofTurn = (user: string, turnId: string, from = 0) => ws[user]!.frames.slice(from).filter((f) => (f as { data?: { turnId?: string } }).data?.turnId === turnId)
/** the text the live deltas of a message give, applied as the web app applies them (store/thread.ts applyDelta) */
const liveText = (frames: ServerFrame[]) => {
  let s = ''
  for (const f of frames) {
    if (f.type !== 'message.delta') continue
    const d = f.data
    if (d.reset) { s = s.slice(0, d.offset) + d.text; continue }
    if (d.offset > s.length) throw new Error(`gap at ${d.offset} (have ${s.length})`)
    s = s.slice(0, d.offset) + d.text + s.slice(d.offset + d.text.length)
  }
  return s
}
const messagesOf = async (user: string, chatId: string): Promise<Message[]> => (await h.api(user).call(API.listMessages, { params: { id: chatId }, query: {} })).items
const ginaJoins = () => db().query("INSERT OR IGNORE INTO group_members VALUES ('finance', 'gina')").run()
const ginaLeaves = () => db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'gina'").run()

describe('the others see the answer as it is written (TC-4961)', () => {
  test("bob gets alice's text live, over the socket and over REST, and the finished message as he sees it", async () => {
    const chat = await newShared()
    const from = { bob: ws.bob!.frames.length, erin: ws.erin!.frames.length }
    const r = await send('alice', chat.id, 'q\n' + fake({ say: 'First part. ' }, { sleep: 2500 }, { say: 'Second part.' }))
    // while it runs: the first part reached bob, the second not yet
    await waitFor(() => liveText(ofMessage('bob', r.assistantMessage.id, from.bob)) === 'First part. ', { timeoutMs: 15_000 })
    // a reload while it runs: the text so far (it showed nothing before)
    const running = (await messagesOf('bob', chat.id)).find((m) => m.id === r.assistantMessage.id)!
    expect([running.status, running.content, running.usage]).toEqual(['streaming', 'First part. ', null])
    const forAlice = await doneFor('alice', r.assistantMessage.id)
    const forBob = await doneFor('bob', r.assistantMessage.id)
    expect(liveText(ofMessage('bob', r.assistantMessage.id, from.bob))).toBe('First part. Second part.')
    expect([forBob.status, forBob.content, forBob.usage]).toEqual(['done', 'First part. Second part.', null])
    expect(forAlice.usage).not.toBeNull()
    // the person's own things stay theirs: no busy notice, queue position or card of her turn for bob
    expect(ofTurn('bob', r.turnId, from.bob).map((f) => f.type)).toEqual([])
    // erin is not in the project: nothing of it
    expect(ofMessage('erin', r.assistantMessage.id, from.erin)).toEqual([])
    await idle(chat.id)
  })

  test("a step naming a place bob cannot see: its words alone, never its detail; the read card stays alice's", async () => {
    const chat = await newShared()
    const from = ws.bob!.frames.length
    const r = await send('alice', chat.id, fake({ tool: 'read', args: { file_path: BRIEF } }, { say: 'read it' }))
    const card = await ws.alice!.next('turn.request', (f) => f.data.turnId === r.turnId, 15_000)
    // the card is open: bob has the running step at most, no card, no text
    expect(ofTurn('bob', r.turnId, from)).toEqual([])
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'share' } })
    await doneFor('bob', r.assistantMessage.id)
    const steps = ofMessage('bob', r.assistantMessage.id, from).filter((f) => f.type === 'message.step').map((f) => (f as Extract<ServerFrame, { type: 'message.step' }>).data.step)
    expect(steps.length).toBeGreaterThan(0)
    for (const s of steps) {
      expect(JSON.stringify(s)).not.toContain('campaign-brief')
      expect(s.detail).toBeUndefined()
      expect((s as { sv?: unknown }).sv).toBeUndefined()
    }
    // alice saw the path in her own line
    const hers = ofMessage('alice', r.assistantMessage.id).filter((f) => f.type === 'message.step').map((f) => (f as Extract<ServerFrame, { type: 'message.step' }>).data.step.label)
    expect(hers.some((l) => l.includes('campaign-brief'))).toBe(true)
    await idle(chat.id)
  })
})

describe('security: what only the asker may see never reaches the others while it streams', () => {
  test("alice's own connection: nothing of it reaches bob before her yes, and never its card, its key or a step detail", async () => {
    const chat = await newShared()
    const from = ws.bob!.frames.length
    const calls = svc.calls.length
    const r = await send('alice', chat.id, 'q\n' + fake({ say: 'Looking. ' }, { tool: MINE_TOOL, args: { q: 'invoices' }, sayResult: true }, { say: ' Done.' }))
    const card = await ws.alice!.next('turn.request', (f) => f.data.turnId === r.turnId, 15_000)
    // the card waits on alice: nothing fetched, bob has the text before the call and nothing of the card
    await Bun.sleep(300)
    expect(svc.calls.length).toBe(calls)
    expect(ofTurn('bob', r.turnId, from)).toEqual([])
    expect(liveText(ofMessage('bob', r.assistantMessage.id, from))).toBe('Looking. ')
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'cancel' } })
    const forBob = await doneFor('bob', r.assistantMessage.id)
    expect(svc.calls.length).toBe(calls)
    const all = JSON.stringify(ofMessage('bob', r.assistantMessage.id, from)) + JSON.stringify(forBob)
    expect(all).not.toContain(MCP_KEY)
    expect(ofTurn('bob', r.turnId, from)).toEqual([])
    for (const f of ofMessage('bob', r.assistantMessage.id, from)) if (f.type === 'message.step') expect(f.data.step.detail).toBeUndefined()
    await idle(chat.id)
  })

  test("someone who joins after the answer used alice's own connection gets nothing more of it, live or over REST", async () => {
    const chat = await newShared()
    const from = { bob: ws.bob!.frames.length, gina: ws.gina!.frames.length }
    const r = await send('alice', chat.id, 'q\n' + fake({ tool: MINE_TOOL, args: { q: 'invoices' }, sayResult: true }, { sleep: 3000 }, { say: ' Tail.' }))
    const card = await ws.alice!.next('turn.request', (f) => f.data.turnId === r.turnId, 15_000)
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'once' } })
    // the result came back and went to bob too (the card said everyone in the chat would see it)
    await waitFor(() => liveText(ofMessage('bob', r.assistantMessage.id, from.bob)).includes('search_tasks'), { timeoutMs: 15_000 })
    ginaJoins()
    try {
      // she sees the chat now, but the answer is built on a connection that is not hers
      await Bun.sleep(LIVE_VIEWERS_MS + 200)
      const hers = (await messagesOf('gina', chat.id)).find((m) => m.id === r.assistantMessage.id)!
      expect([hers.status, hers.content, hers.steps]).toEqual(['streaming', '', []])
      const forGina = await doneFor('gina', r.assistantMessage.id)
      expect(forGina.withheld).toBe(true)
      expect(forGina.content).toBe('')
      expect(ofMessage('gina', r.assistantMessage.id, from.gina).filter((f) => f.type === 'message.delta' || f.type === 'message.step')).toEqual([])
      expect((await doneFor('bob', r.assistantMessage.id)).content).toContain('Tail.')
    } finally { ginaLeaves() }
    await idle(chat.id)
  })

  test('someone who stops seeing the chat gets nothing more of the answer at once; the answer goes on for the asker', async () => {
    const chat = await newShared()
    const from = ws.bob!.frames.length
    const r = await send('alice', chat.id, 'q\n' + fake({ say: 'Before. ' }, { sleep: 700 }, { say: 'After.' }))
    await waitFor(() => liveText(ofMessage('bob', r.assistantMessage.id, from)) === 'Before. ', { timeoutMs: 15_000 })
    db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'bob'").run()
    try {
      // what every access change does for the people who lost the chat (admin/folders.ts afterAccessChange), well within
      // LIVE_VIEWERS_MS of the last piece: not left to the list's own refresh
      stopTurnsIn(h.ctx, 'bob', [chat.id])
      expect((await doneFor('alice', r.assistantMessage.id)).content).toBe('Before. After.')
      await Bun.sleep(200)
      expect(liveText(ofMessage('bob', r.assistantMessage.id, from))).toBe('Before. ')
      expect(ofMessage('bob', r.assistantMessage.id, from).some((f) => f.type === 'message.done')).toBe(false)
    } finally { db().query("INSERT OR IGNORE INTO group_members VALUES ('finance', 'bob')").run() }
    await idle(chat.id)
  })
})
