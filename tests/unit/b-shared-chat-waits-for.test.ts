// Everyone else in a shared chat sees whose confirmation the AI is stopped on (Chat.waitsFor), for every kind of card and
// until it ends, with the fake engine through the real launcher and gate (docs/AGENTS/plan/*-shared-chat-waiting.md).
// That no card content reaches them: tests/security/shared-chat-waits-for.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, attentionCount, markerOf, type Chat, type ServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { saveQuestion } from '../../server/src/chat/open-questions'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const WIN = '22222222-2222-4222-8222-222222222222'
const pandoc = Bun.which('pandoc')
const NAME = 'Alice Kim'

let h: Harness
let alice: TestSocket, bob: TestSocket
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-waits-for', askUserTimeoutMs: 1500, stallTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: WIN }); await alice.next('hello')
  bob = await h.ws('bob'); await bob.next('hello')
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { alice?.close(); bob?.close(); await h?.close() })

const newChat = () => h.api('alice').call(API.createChat, { body: { projectId } })
const send = (user: string, id: string, content: string) => h.api(user).call(API.sendMessage, { params: { id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
const view = (user: string, id: string): Promise<Chat> => h.api(user).call(API.getChat, { params: { id } })
/** the newest chat.updated of this chat that reached bob since `from` */
const liveFor = (from: number, id: string) => bob.frames.slice(from).flatMap((f: ServerFrame) => (f.type === 'chat.updated' && f.data.chatId === id && f.data.chat ? [f.data.chat] : [])).at(-1)
const liveWaits = (from: number, id: string, name: string | undefined) => waitFor(() => { const c = liveFor(from, id); return !!c && c.waitsFor === name }, { timeoutMs: 2000 })
const idle = (id: string) => waitFor(() => !h.rt().activeTurn(id), { timeoutMs: 20_000 })
const ASK = { tool: 'ask_user', args: { question: 'Which color?', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }] } }
const execOf = (turnId: string) => h.rt().execFor(turnId) as unknown as { showCard(r: unknown, o: { window?: string | null; timeoutMs: number }): Promise<unknown> }
const serverCard = (requestId: string) => ({ kind: 'ask_user', requestId, question: 'Allow?', origin: 'server', options: [{ label: 'Yes', value: 'yes' }] })

describe('the others see who the AI waits for', () => {
  test('a question kept after the answer ended: told live, kept on reload, gone once answered', async () => {
    const chat = await newChat()
    const from = bob.frames.length
    const r = await send('alice', chat.id, fake(ASK))
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
    await idle(chat.id)
    expect(await liveWaits(from, chat.id, NAME)).toBe(true)
    const seen = await view('bob', chat.id)
    expect([seen.runState, seen.waitsFor, seen.waiting, seen.shared?.answering]).toEqual(['idle', NAME, undefined, null])
    // the asker has the card and no line about themselves
    const own = await view('alice', chat.id)
    expect([own.waiting, own.waitsFor]).toEqual([true, undefined])
    const after = bob.frames.length
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'red' } })
    expect(await liveWaits(after, chat.id, undefined)).toBe(true)
    await idle(chat.id)
    expect((await view('bob', chat.id)).waitsFor).toBeUndefined()
  })

  test('a card inside a running answer: named while it waits, the running line after it times out', async () => {
    const chat = await newChat()
    const r = await send('alice', chat.id, fake({ sleep: 3500 }, { say: 'done' }))
    await waitFor(() => !!h.rt().execFor(r.turnId), { timeoutMs: 5000 })
    expect((await view('bob', chat.id)).shared?.answering).toEqual({ name: NAME })
    const from = bob.frames.length
    void execOf(r.turnId).showCard(serverCard('in-call-1'), { timeoutMs: 700 })
    expect(await liveWaits(from, chat.id, NAME)).toBe(true)
    expect((await view('bob', chat.id)).shared?.answering).toEqual({ name: NAME, waiting: true })
    const after = bob.frames.length
    expect(await waitFor(() => { const c = liveFor(after, chat.id); return !!c && !c.waitsFor }, { timeoutMs: 2000 })).toBe(true)
    expect((await view('bob', chat.id)).shared?.answering).toEqual({ name: NAME })
    await idle(chat.id)
  })

  test("a card for one desktop window: the others are told both ways, the person's own lists do not change", async () => {
    const chat = await newChat()
    const r = await send('alice', chat.id, fake({ sleep: 3500 }, { say: 'done' }))
    await waitFor(() => !!h.rt().execFor(r.turnId), { timeoutMs: 5000 })
    const from = bob.frames.length
    void execOf(r.turnId).showCard(serverCard('window-1'), { window: WIN, timeoutMs: 700 })
    expect(await liveWaits(from, chat.id, NAME)).toBe(true)
    expect((await view('alice', chat.id)).waiting).toBeUndefined()
    const after = bob.frames.length
    expect(await waitFor(() => { const c = liveFor(after, chat.id); return !!c && !c.waitsFor }, { timeoutMs: 2000 })).toBe(true)
    await idle(chat.id)
  })

  test('a stopped answer closes the wait', async () => {
    const chat = await newChat()
    const r = await send('alice', chat.id, fake({ sleep: 8000 }, { say: 'never' }))
    await waitFor(() => !!h.rt().execFor(r.turnId), { timeoutMs: 5000 })
    void execOf(r.turnId).showCard(serverCard('stop-1'), { timeoutMs: 30_000 })
    await waitFor(async () => (await view('bob', chat.id)).waitsFor === NAME, { timeoutMs: 2000 })
    const from = bob.frames.length
    await h.api('alice').call(API.stop, { params: { id: chat.id } })
    await idle(chat.id)
    expect(await waitFor(() => { const c = liveFor(from, chat.id); return !!c && !c.waitsFor }, { timeoutMs: 3000 })).toBe(true)
  })

  test("another person's answer running past a kept card names nobody wrongly", async () => {
    const chat = await newChat()
    const first = await send('alice', chat.id, fake({ say: 'one' }))
    await idle(chat.id)
    saveQuestion(h.ctx.db, { request: serverCard('kept-1') as never, chatId: chat.id, messageId: first.assistantMessage.id, turnId: first.turnId, userId: 'alice', call: { tool: 'remember', args: {}, window: null } })
    expect((await view('bob', chat.id)).waitsFor).toBe(NAME)
    const second = await send('bob', chat.id, fake({ sleep: 1500 }, { say: 'two' }))
    await waitFor(() => !!h.rt().execFor(second.turnId), { timeoutMs: 5000 })
    const forAlice = await view('alice', chat.id)
    expect(forAlice.shared?.answering).toEqual({ name: 'Bob Lee' })
    expect(forAlice.waitsFor).toBeUndefined()
    expect((await view('bob', chat.id)).waitsFor).toBeUndefined()
    await idle(chat.id)
    // the chat went on without it: the card stays for alice, and nobody reads that the chat waits for her
    expect((await view('bob', chat.id)).waitsFor).toBeUndefined()
    expect((await view('alice', chat.id)).waiting).toBe(true)
    h.ctx.db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chat.id)
  })

  test("the asker's own new turn with no open card: the running line, not a stale wait", async () => {
    const chat = await newChat()
    const first = await send('alice', chat.id, fake({ say: 'one' }))
    await idle(chat.id)
    saveQuestion(h.ctx.db, { request: serverCard('kept-2') as never, chatId: chat.id, messageId: first.assistantMessage.id, turnId: first.turnId, userId: 'alice', call: { tool: 'remember', args: {}, window: null } })
    const second = await send('alice', chat.id, fake({ sleep: 1500 }, { say: 'two' }))
    await waitFor(() => !!h.rt().execFor(second.turnId), { timeoutMs: 5000 })
    const seen = await view('bob', chat.id)
    expect([seen.waitsFor, seen.shared?.answering]).toEqual([undefined, { name: NAME }])
    await idle(chat.id)
    h.ctx.db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chat.id)
  })

  test('a kept card for one desktop window holds the chat only while that window is connected, told live both ways', async () => {
    const chat = await newChat()
    const win = crypto.randomUUID()
    let sock = await h.ws('alice', { windowId: win }); await sock.next('hello')
    const first = await send('alice', chat.id, fake({ say: 'one' }))
    await idle(chat.id)
    saveQuestion(h.ctx.db, { request: serverCard('win-kept') as never, chatId: chat.id, messageId: first.assistantMessage.id, turnId: first.turnId, userId: 'alice', call: { tool: 'navigate', args: {}, window: win } })
    expect((await view('bob', chat.id)).waitsFor).toBe(NAME)
    let from = bob.frames.length
    sock.close()
    expect(await waitFor(() => { const c = liveFor(from, chat.id); return !!c && !c.waitsFor }, { timeoutMs: 3000 })).toBe(true)
    from = bob.frames.length
    sock = await h.ws('alice', { windowId: win }); await sock.next('hello')
    expect(await liveWaits(from, chat.id, NAME)).toBe(true)
    sock.close()
    h.ctx.db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chat.id)
  })

  test('a person who no longer sees the chat holds nobody up', async () => {
    const chat = await newChat()
    const first = await send('alice', chat.id, fake({ say: 'one' }))
    await idle(chat.id)
    saveQuestion(h.ctx.db, { request: serverCard('gone-1') as never, chatId: chat.id, messageId: first.assistantMessage.id, turnId: first.turnId, userId: 'erin' })
    expect((await view('bob', chat.id)).waitsFor).toBeUndefined()
    h.ctx.db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chat.id)
  })

  test('the list marks it for the others without counting it as needing them', async () => {
    const chat = await newChat()
    // bob wrote in it, so it is in his own list
    await send('bob', chat.id, fake({ say: 'hello' }))
    await idle(chat.id)
    const r = await send('alice', chat.id, fake(ASK))
    await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
    await idle(chat.id)
    const seen = await view('bob', chat.id)
    const clean = { ...seen, unseen: undefined, unreadCount: undefined }
    expect(markerOf(clean)).toEqual({ kind: 'running', reason: 'someone' })
    expect(attentionCount([clean], []).n).toBe(0)
    const groups = await h.api('bob').call(API.listChatGroups, {})
    const marks = groups.projects.flatMap((p) => p.marked)
    expect(marks.find((m) => m.id === chat.id)?.waitsFor).toBe(NAME)
    h.ctx.db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chat.id)
  })
})

/** Sends, answers every other card with its first button, and stops at the first card `is` picks: what bob reads then. */
async function atRealCard(chatId: string, content: string, is: (q: string) => boolean) {
  const r = await send('alice', chatId, content)
  const seen = new Set<string>()
  for (const end = Date.now() + 40_000; Date.now() < end; await Bun.sleep(25)) {
    const open = (await h.api('alice').call(API.listTurnRequests, { params: { id: chatId } })).items
    for (const x of open) {
      if (seen.has(x.request.requestId)) continue
      seen.add(x.request.requestId)
      const q = x.request as unknown as { kind: string; requestId: string; question?: string; options?: { value: string }[] }
      if (q.kind === 'ask_user' && is(q.question ?? '')) return { turn: r, card: q }
      if (q.kind === 'ask_user') await h.api('alice').call(API.answerTurn, { params: { id: x.turnId }, body: { kind: 'ask_user', requestId: q.requestId, answer: q.options?.[0]?.value ?? null } })
    }
  }
  throw new Error('the card never came')
}
const bobGot = async (chatId: string, from: number) => JSON.stringify([await view('bob', chatId), bob.frames.slice(from).filter((f: ServerFrame) => f.type === 'chat.updated' || f.type === 'turn.request')])

describe('real cards, raised by their tools', () => {
  test('the widening card', async () => {
    const chat = await newChat()
    const from = bob.frames.length
    const { card } = await atRealCard(chat.id, `Save it in Company-wide\n${fake({ tool: 'read', args: { file_path: 'groups/marketing/campaign-brief.md' } }, { tool: 'write', args: { file_path: 'shared/widen-secret-name.md', content: '# n' }, sayResult: true })}`, (q) => q.includes('widen-secret-name'))
    expect(await waitFor(async () => (await view('bob', chat.id)).waitsFor === NAME, { timeoutMs: 3000 })).toBe(true)
    expect(await bobGot(chat.id, from)).not.toContain(card.question!.split('\n')[0]!)
    h.ctx.db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chat.id)
    await idle(chat.id)
  })

  ;(pandoc ? test : test.skip)('the picture card', async () => {
    const put = (rel: string, b: Uint8Array) => { const p = path.join(h.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b) }
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
    put('projects/falcon/seal-secret.png', png)
    put('projects/falcon/form.docx', new Uint8Array(Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from('# Form\n\nSigner (seal)\n') }).stdout))
    const chat = await newChat()
    const from = bob.frames.length
    const doc = 'projects/falcon/form.docx'
    const { card } = await atRealCard(chat.id, fake({ tool: 'read', args: { file_path: doc } }, { tool: 'edit_office', args: { file_path: doc, changes: [{ insert_picture: { image: 'projects/falcon/seal-secret.png', over: '(seal)' } }] }, sayResult: true }), (q) => /did not upload this picture/.test(q))
    expect(card.question).toContain('seal-secret')
    expect(await waitFor(async () => (await view('bob', chat.id)).waitsFor === NAME, { timeoutMs: 3000 })).toBe(true)
    expect(await bobGot(chat.id, from)).not.toContain('did not upload this picture')
    h.ctx.db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chat.id)
    await h.api('alice').call(API.stop, { params: { id: chat.id } }).catch(() => {})
    await idle(chat.id)
  })
})

describe('a person with an open card goes', () => {
  const twoPeople = async (who: string) => {
    const p = await h.api('dana').call(API.createProject, { body: { name: `Leave ${crypto.randomUUID().slice(0, 6)}`, participants: [{ subjectType: 'user', subjectId: who }, { subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
    const chat = await h.api(who).call(API.createChat, { body: { projectId: p.id } })
    const r = await send(who, chat.id, fake(ASK))
    await waitFor(async () => (await h.api(who).call(API.listTurnRequests, { params: { id: chat.id } })).items.some((x) => x.turnId === r.turnId), { timeoutMs: 15_000 })
    await idle(chat.id)
    return { p, chat }
  }
  const cleared = async (from: number, id: string) => waitFor(() => { const c = liveFor(from, id); return !!c && !c.waitsFor }, { timeoutMs: 3000 })

  test('leaving the project tells the others at once', async () => {
    const { p, chat } = await twoPeople('carol')
    expect((await view('bob', chat.id)).waitsFor).toBe('Carol Park')
    const from = bob.frames.length
    await h.api('carol').call(API.leaveProject, { params: { id: p.id } })
    expect(await cleared(from, chat.id)).toBe(true)
  })

  test('a deleted account tells the others at once', async () => {
    const { chat } = await twoPeople('erin')
    expect((await view('bob', chat.id)).waitsFor).toBe('Erin Yoo')
    const from = bob.frames.length
    await h.api('dana').call(API.deleteUser, { params: { id: 'erin' }, query: { personalFolder: 'delete' }, body: {} })
    expect(await cleared(from, chat.id)).toBe(true)
  })
})
