// The server's safety cards wait as long as it takes (docs/decisions/20261119-safety-cards-wait.md): a delete, share
// or website card raised inside its tool call ends the answer with the card open (the call does nothing), and the
// person's answer, however late, starts the next turn, which runs that same call again exactly once, every check made
// again at that moment, the card taking the saved answer. With the fake engine through the real launcher and gate.
// (The browser site card: b-browser.test.ts. Each card's own logic, waiting inside its call as a Slack question's card
// does: ai-delete-files, b-share-with-person, web-allow-all and the others, run with safetyCardsWait off.)
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import dnsP from 'node:dns/promises'
import { API, type Message, type TurnRequest } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { CARD_LATER_NOTE } from '../../server/src/chat/tools'
import { sameCard } from '../../server/src/chat/open-questions'
import { TurnExec } from '../../server/src/chat/turn'
import { redactorOf } from '../../server/src/integrations/connections/redact'

setDefaultTimeout(60_000)

// every DNS lookup is a stub: nothing resolves a real name; a lookup means the fetch ran
const lookups: string[] = []
;(dnsP as unknown as { lookup: unknown }).lookup = async (host: string) => {
  lookups.push(host.toLowerCase())
  throw Object.assign(new Error('stub: not resolved'), { code: 'ENOTFOUND' })
}
const looked = (host: string) => lookups.filter((x) => x === host).length

// the call written so its address or path is not typed in the message as the person's own words
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d).replace(/\//g, '\\u002f')).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-safety-cards-wait', askUserTimeoutMs: 1500, stallTimeoutMs: 60_000, safetyCardsWait: true })
  alice = await h.ws('alice', { windowId: 'win-scw-main' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

const abs = (rel: string) => path.join(h.team, ...rel.split('/'))
const put = (rel: string, body = 'x\n') => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body) }
const newChat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id
const doneOf = async (messageId: string) => (await alice.next('message.done', (f) => f.data.messageId === messageId, 30_000)).data.message as Message
const post = (who: string, turnId: string, body: unknown) => h.req(who, `/api/turns/${turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const openRows = (chatId: string) => (h.ctx.db.query('SELECT COUNT(*) n FROM open_questions WHERE chat_id = ?').get(chatId) as { n: number }).n
const trashed = (rel: string) => h.ctx.db.query('SELECT turn_id FROM trash_items WHERE original_path = ? AND restored_at IS NULL').all(rel) as { turn_id: string }[]

/** Ask in a new chat: the card opens, the answer ends with it open (the call did nothing), the turn holds nothing */
async function askAndWait(content: string) {
  const chatId = await newChat()
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const card = (await alice.next('turn.request', (f) => f.data.turnId === r.turnId, 20_000)).data.request as TurnRequest
  const done = await doneOf(r.assistantMessage.id)
  expect(await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })).toBe(true)
  return { chatId, turnId: r.turnId as string, answerId: r.assistantMessage.id as string, card, done }
}
/** the turn the answer started: its user message and finished answer */
async function nextTurn(chatId: string, askingId: string) {
  const u = await alice.next('message.created', (f) => f.data.chatId === chatId && f.data.message.parentId === askingId, 20_000)
  const a = await alice.next('message.created', (f) => f.data.chatId === chatId && f.data.message.parentId === u.data.message.id, 20_000)
  return { user: u.data.message as Message, done: await doneOf(a.data.message.id), turnId: a.data.message.turnId as string }
}

describe('a delete card', () => {
  test('waits after the answer (nothing deleted, no time limit, after a restart); the answer runs the call once, a second answer runs nothing', async () => {
    put('users/alice/QA-del/old.txt')
    const w = await askAndWait(`clean up\n${fake({ tool: 'delete_files', args: { paths: ['users/alice/QA-del/old.txt'] }, sayResult: true })}`)
    expect(w.card).toMatchObject({ kind: 'ask_user', origin: 'server' })
    expect(w.card).not.toHaveProperty('expiresAt')
    expect(JSON.parse(w.done.content)).toEqual({ waiting_for_user: true, note: CARD_LATER_NOTE })
    expect(w.done.steps.find((s) => s.tool === 'delete_files')).toMatchObject({ status: 'ok', detail: 'Waiting for your answer on the card' })
    expect(fs.existsSync(abs('users/alice/QA-del/old.txt'))).toBe(true)
    expect(trashed('users/alice/QA-del/old.txt')).toEqual([])
    // past the old wait (1.5 s here), and after the server's start-up recovery: still open, from the database
    await Bun.sleep(2000)
    await h.rt().recover()
    const open = await h.api('alice').call(API.listTurnRequests, { params: { id: w.chatId } })
    expect(open.items.map((x) => x.request.requestId)).toEqual([w.card.requestId])
    expect((await h.api('alice').call(API.getChat, { params: { id: w.chatId } })).waiting).toBe(true)
    // its buttons only (a typed answer is no yes), and only alice's
    expect((await post('alice', w.turnId, { kind: 'ask_user', requestId: w.card.requestId, answer: 'yes please' })).status).toBe(400)
    expect((await post('bob', w.turnId, { kind: 'ask_user', requestId: w.card.requestId, answer: 'trash' })).status).toBe(404)
    // two answers at once: one runs, the other is refused
    const [a, b] = await Promise.all([
      post('alice', w.turnId, { kind: 'ask_user', requestId: w.card.requestId, answer: 'trash' }),
      post('alice', w.turnId, { kind: 'ask_user', requestId: w.card.requestId, answer: 'trash' }),
    ])
    expect([a.status, b.status].sort()).toEqual([204, 409])
    const next = await nextTurn(w.chatId, w.answerId)
    expect(next.user.content).toBe('Move to trash')
    expect(next.done.status).toBe('done')
    // the call ran again in the new turn, once, and did it
    expect(fs.existsSync(abs('users/alice/QA-del/old.txt'))).toBe(false)
    expect(trashed('users/alice/QA-del/old.txt')).toEqual([{ turn_id: next.turnId }])
    expect(next.done.steps.filter((s) => s.tool === 'delete_files')).toMatchObject([{ status: 'ok' }])
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM tool_events WHERE turn_id = ? AND tool = 'delete_files'").get(next.turnId)).toEqual({ n: 1 })
    expect(openRows(w.chatId)).toBe(0)
    // answered: no card, no turn again
    expect((await post('alice', w.turnId, { kind: 'ask_user', requestId: w.card.requestId, answer: 'trash' })).status).toBe(409)
  })

  test('access lost before the answer: the call runs again as the person is now, and nothing is deleted', async () => {
    put('shared/QA-revoke/notes.md')
    const w = await askAndWait(`clean up\n${fake({ tool: 'delete_files', args: { paths: ['shared/QA-revoke/notes.md'] }, sayResult: true })}`)
    // meanwhile the folder becomes carol's alone
    h.ctx.db.query("INSERT INTO folders (id, path, limited) VALUES ('f_scw_revoke', 'shared/QA-revoke', 1)").run()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_scw_revoke', 'f_scw_revoke', 'user', 'carol', 'write')").run()
    await post('alice', w.turnId, { kind: 'ask_user', requestId: w.card.requestId, answer: 'trash' })
    const next = await nextTurn(w.chatId, w.answerId)
    expect(next.done.status).toBe('done')
    expect(fs.existsSync(abs('shared/QA-revoke/notes.md'))).toBe(true)
    expect(trashed('shared/QA-revoke/notes.md')).toEqual([])
    // refused before any card: no new card opened
    expect(alice.frames.some((f) => f.type === 'turn.request' && f.data.turnId === next.turnId)).toBe(false)
  })

  test('"No": the call does not run again, nothing is deleted, and the AI is told it was the card\'s no', async () => {
    put('users/alice/QA-del/keep.txt')
    const w = await askAndWait(`clean up\n${fake({ tool: 'delete_files', args: { paths: ['users/alice/QA-del/keep.txt'] }, sayResult: true })}`)
    await post('alice', w.turnId, { kind: 'ask_user', requestId: w.card.requestId, answer: 'skip' })
    const next = await nextTurn(w.chatId, w.answerId)
    expect(next.user.content).not.toBe('Move to trash')
    expect(fs.existsSync(abs('users/alice/QA-del/keep.txt'))).toBe(true)
    // (a no never runs the call again: docs/decisions/20261122-late-card-answer-resumes.md)
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM tool_events WHERE turn_id = ? AND tool = 'delete_files'").get(next.turnId)).toEqual({ n: 0 })
  })
})

describe('a saved yes runs once', () => {
  test('a regenerate of the answer\'s message never runs the saved call again (no card, nothing deleted)', async () => {
    put('users/alice/QA-del/again.txt')
    const w = await askAndWait(`clean up\n${fake({ tool: 'delete_files', args: { paths: ['users/alice/QA-del/again.txt'] }, sayResult: true })}`)
    // the call was left undone and audited so (not as a card nobody answered)
    expect((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'files.ai_trash' AND json_extract(detail, '$.turnId') = ?").all(w.turnId) as { detail: string }[]).map((r) => JSON.parse(r.detail).outcome)).toEqual(['deferred'])
    await post('alice', w.turnId, { kind: 'ask_user', requestId: w.card.requestId, answer: 'trash' })
    const next = await nextTurn(w.chatId, w.answerId)
    expect(trashed('users/alice/QA-del/again.txt')).toEqual([{ turn_id: next.turnId }])
    // the same path again, then the answer of that message asked again (and a retry is the same): nothing runs
    put('users/alice/QA-del/again.txt')
    const re = await h.api('alice').call(API.regenerate, { params: { id: w.chatId, messageId: next.done.id }, body: {} })
    const d = await doneOf(re.assistantMessage.id)
    expect(d.status).toBe('done')
    expect(fs.existsSync(abs('users/alice/QA-del/again.txt'))).toBe(true)
    expect(trashed('users/alice/QA-del/again.txt')).toHaveLength(1)
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM tool_events WHERE turn_id = ? AND tool = 'delete_files'").get(re.turnId)).toEqual({ n: 0 })
    expect(alice.frames.some((f) => f.type === 'turn.request' && f.data.turnId === re.turnId)).toBe(false)
  })
})

describe('what is never kept', () => {
  test('a call that holds a stored connection secret is not saved: its card waits inside the call, as before', async () => {
    const SECRET = 'sk-QA-SECRET-4f9a8b7c6d5e'
    const proto = TurnExec.prototype as unknown as { redactor(): unknown }
    const real = proto.redactor
    proto.redactor = () => redactorOf([SECRET])
    try {
      const chatId = await newChat()
      const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: fake({ tool: 'web_fetch', args: { url: `https://card-secret.example/doc?k=${SECRET}` }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
      const card = (await alice.next('turn.request', (f) => f.data.turnId === r.turnId, 20_000)).data.request as TurnRequest & { expiresAt?: string }
      // the old wait: a time limit, and nothing in the database
      expect(card.expiresAt).toBeDefined()
      expect(openRows(chatId)).toBe(0)
      expect(JSON.stringify(h.ctx.db.query('SELECT call_args FROM open_questions').all())).not.toContain(SECRET)
      await doneOf(r.assistantMessage.id)
    } finally { proto.redactor = real }
  })
})

describe('a share card', () => {
  test('waits after the answer (nothing shared); the answer shares once', async () => {
    put('users/alice/QA-share/plan.md')
    const w = await askAndWait(`share plan.md (to the person I said before)\n${fake({ tool: 'share_with_person', args: { paths: ['users/alice/QA-share/plan.md'], people: ['Bob Lee'] }, sayResult: true })}`)
    expect(w.card).toMatchObject({ kind: 'ask_user', origin: 'server' })
    expect(JSON.parse(w.done.content)).toMatchObject({ waiting_for_user: true })
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM file_shares WHERE path = 'users/alice/QA-share/plan.md'").get()).toEqual({ n: 0 })
    await post('alice', w.turnId, { kind: 'ask_user', requestId: w.card.requestId, answer: 'share' })
    const next = await nextTurn(w.chatId, w.answerId)
    expect(next.done.status).toBe('done')
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM file_shares WHERE path = 'users/alice/QA-share/plan.md'").get()).toEqual({ n: 1 })
  })
})

describe('a website card', () => {
  test('waits after the answer (nothing fetched); "Don\'t open" fetches nothing, "Open" fetches once', async () => {
    const no = await askAndWait(fake({ tool: 'web_fetch', args: { url: 'https://card-wait-no.example/doc' }, sayResult: true }))
    expect(no.card).toMatchObject({ kind: 'ask_user', origin: 'server' })
    await post('alice', no.turnId, { kind: 'ask_user', requestId: no.card.requestId, answer: 'deny' })
    await nextTurn(no.chatId, no.answerId)
    expect(looked('card-wait-no.example')).toBe(0)

    const yes = await askAndWait(fake({ tool: 'web_fetch', args: { url: 'https://card-wait-yes.example/doc' }, sayResult: true }))
    expect(looked('card-wait-yes.example')).toBe(0)
    await post('alice', yes.turnId, { kind: 'ask_user', requestId: yes.card.requestId, answer: 'allow' })
    const next = await nextTurn(yes.chatId, yes.answerId)
    expect(next.done.status).toBe('done')
    expect(looked('card-wait-yes.example')).toBe(1)
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM tool_events WHERE turn_id = ? AND tool = 'web_fetch'").get(next.turnId)).toEqual({ n: 1 })
  })
})

describe('the answer is the cards\' choices, not the person\'s words', () => {
  test('two website cards answered "Open": the user message is marked as the cards\' choices, also on reload', async () => {
    const chatId = await newChat()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: fake({ tool: 'web_fetch', args: { url: 'https://card-two-a.example/doc' } }, { tool: 'web_fetch', args: { url: 'https://card-two-b.example/doc' } }), clientMessageId: cm(), attachmentIds: [] } })
    const c1 = (await alice.next('turn.request', (f) => f.data.turnId === r.turnId, 20_000)).data.request as TurnRequest
    const c2 = (await alice.next('turn.request', (f) => f.data.turnId === r.turnId && f.data.request.requestId !== c1.requestId, 20_000)).data.request as TurnRequest
    await doneOf(r.assistantMessage.id)
    expect(await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })).toBe(true)
    expect((await post('alice', r.turnId, { kind: 'ask_user', requestId: c1.requestId, answer: 'allow' })).status).toBeLessThan(300)
    await post('alice', r.turnId, { kind: 'ask_user', requestId: c2.requestId, answer: 'allow' })
    const next = await nextTurn(chatId, r.assistantMessage.id)
    const open = (c1 as Extract<TurnRequest, { kind: 'ask_user' }>).options!.find((o) => o.value === 'allow')!.label
    // the text keeps the cards' questions (what the AI reads of it in later turns); the apps draw the line instead
    expect(next.user.content).toContain(`\n${open}\n\n`)
    expect(next.user.cardAnswer).toEqual({ choices: [open, open] })
    // a reload: the history says the same
    const page = await h.api('alice').call(API.listMessages, { params: { id: chatId }, query: {} })
    const u = page.items.find((m: Message) => m.id === next.user.id)!
    expect(u.cardAnswer).toEqual({ choices: [open, open] })
    expect(looked('card-two-a.example') + looked('card-two-b.example')).toBe(2)
  })

  test('an older chat\'s safety-card answer (saved before the marks) reads as the cards\' choices too, by their buttons', async () => {
    const { chatId, turnId, answerId, card } = await askAndWait(fake({ tool: 'web_fetch', args: { url: 'https://card-old.example/doc' } }))
    await post('alice', turnId, { kind: 'ask_user', requestId: card.requestId, answer: 'deny' })
    const next = await nextTurn(chatId, answerId)
    const q = (card as Extract<TurnRequest, { kind: 'ask_user' }>)
    const deny = q.options!.find((o) => o.value === 'deny')!.label
    // as an older build saved it: no words with the answer, the question's text before them
    const row = h.ctx.db.query('SELECT questions FROM answered_questions WHERE message_id = ?').get(next.user.id) as { questions: string }
    const old = (JSON.parse(row.questions) as { shown?: unknown }[]).map(({ shown: _s, ...a }) => a)
    expect(old[0]).not.toHaveProperty('typed')
    h.ctx.db.query('UPDATE answered_questions SET questions = ? WHERE message_id = ?').run(JSON.stringify([...old, { ...old[0], question: 'Second card?' }]), next.user.id)
    const page = await h.api('alice').call(API.listMessages, { params: { id: chatId }, query: {} })
    expect(page.items.find((m: Message) => m.id === next.user.id)!.cardAnswer).toEqual({ choices: [deny, deny] })
  })
})

describe('the same card or another one', () => {
  test('only the card the person answered takes the answer: the Always allow choice and the time limit do not count, what it says does', () => {
    const base: TurnRequest = { kind: 'ask_user', origin: 'server', requestId: 'a', question: 'Move 1 file to the trash?', options: [{ label: 'Move', value: 'trash' }, { label: 'No', value: 'skip' }], details: [{ label: 'File', text: 'old.txt' }] }
    expect(sameCard(base, { ...base, requestId: 'b', expiresAt: '2099-01-01T00:00:00Z', options: [...base.options!, { label: 'Always allow', value: '__always' }], note: 'x' } as TurnRequest)).toBe(true)
    expect(sameCard(base, { ...base, requestId: 'b', question: 'Move 2 files to the trash?' })).toBe(false)
    expect(sameCard(base, { ...base, requestId: 'b', details: [{ label: 'File', text: 'other.txt' }] })).toBe(false)
    expect(sameCard(base, { kind: 'browser_site', requestId: 'b', url: 'http://10.0.0.1/', host: '10.0.0.1' })).toBe(false)
  })
})
