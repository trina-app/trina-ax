// A fork of a shared chat (docs/decisions/20261126-chat-fork.md, server/src/chat/fork.ts): "Continue in a chat only you
// see" makes a new chat of mine with the conversation as I see it, in the same project, and its AI goes on from my own
// session. The project is projects/falcon: alice writes it, the finance group (bob) reads it; carol (admin) is not a
// member, erin sees only public/. Covered: the copy as seen (names kept, a hidden answer one line, turn rows of the
// original runners, left_out mapped, my own unrecorded answer still mine), other people's step notes only as the shared
// chat gives them, marks, scope and records copied, nobody else sees the fork and the original is not changed, the
// session copied and resumed once with the since-block and the fork line, checks for me alone (a newcomer to the
// original does not drop it), the skill list recorded, a fresh start without my session, the reset after access loss,
// chat files by reference (open while I see them there, gone after), the refusals and the guest gate.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError, type Attachment, type Chat, type Message, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { resetEngineSessions } from '../../server/src/chat/runtime'
import { hiddenAnswersCutover, setAnswerReads, setHiddenAnswersCutover, setLeftOut } from '../../server/src/chat/shared-answers'
import { WITHHELD_ANSWER } from '../../server/src/chat/shared'
import { GUEST_ENDPOINTS } from '../../server/src/auth/guest-endpoints'
import { roomsOf } from '../../server/src/rooms/service'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-fork', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'carol', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: 'Falcon project notes.' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 10_000)
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
const newShared = async (user = 'alice') => h.api(user).call(API.createChat, { body: { projectId } })
async function ask(user: string, chatId: string, content: string, attachmentIds: string[] = []) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return { started, done: done.data.message }
}
const messages = async (user: string, chatId: string): Promise<Message[]> => (await h.api(user).call(API.listMessages, { params: { id: chatId }, query: {} })).items
const fork = (user: string, chatId: string, leafId?: string): Promise<Chat> => h.api(user).call(API.forkChat, { params: { id: chatId }, body: leafId ? { leafId } : {} })
const row = (id: string) => db().query('SELECT * FROM chats WHERE id = ?').get(id) as Record<string, unknown>
const msgRows = (chatId: string) => db().query('SELECT id, parent_id, role, author_id, content, steps, step_notes, attachments, turn_id, withheld_copy, fork_copy FROM messages WHERE chat_id = ? ORDER BY rowid').all(chatId) as
  { id: string; parent_id: string | null; role: string; author_id: string | null; content: string; steps: string; step_notes: string | null; attachments: string; turn_id: string | null; withheld_copy: number; fork_copy: number }[]
const runnerOf = (turnId: string | null) => (turnId ? (db().query('SELECT user_id FROM turns WHERE id = ?').get(turnId) as { user_id: string } | null)?.user_id : null) ?? null

describe('what a fork copies', () => {
  test('the conversation as I see it, others\' names kept, in the same project; the original unchanged; nobody else sees it', async () => {
    const chat = await newShared('alice')
    await ask('alice', chat.id, `Plan the launch\n${fake({ say: 'ALICE-ANSWER' })}`)
    await ask('bob', chat.id, `Add a budget\n${fake({ say: 'BOB-ANSWER' })}`)
    const before = msgRows(chat.id)
    const f = await fork('bob', chat.id)
    expect(f.projectId).toBe(projectId)
    expect(f.shared).toBeUndefined()
    expect(f.title).toBe((await h.api('bob').call(API.getChat, { params: { id: chat.id } })).title)
    expect(f.forkedFrom).toEqual({ title: f.title, chatId: chat.id })
    const got = await messages('bob', f.id)
    expect(got.map((m) => [m.role, m.author?.id ?? null, m.content.split('\n')[0]])).toEqual([
      ['user', 'alice', 'Plan the launch'], ['assistant', null, 'ALICE-ANSWER'], ['user', 'bob', 'Add a budget'], ['assistant', null, 'BOB-ANSWER'],
    ])
    // each copied answer keeps its runner's turn row (no usage: it was paid for once)
    const rows = msgRows(f.id)
    expect(rows.filter((m) => m.role === 'assistant').map((m) => runnerOf(m.turn_id))).toEqual(['alice', 'bob'])
    expect(rows.every((m) => m.fork_copy === 1)).toBe(true)
    expect((db().query('SELECT SUM(input_tokens + output_tokens) AS n, SUM(cost_usd) AS c FROM turns WHERE chat_id = ?').get(f.id) as { n: number; c: number })).toEqual({ n: 0, c: 0 })
    // new ids, the same chain
    expect(rows.map((m) => m.id).some((id) => before.some((b) => b.id === id))).toBe(false)
    expect(rows.slice(1).every((m, i) => m.parent_id === rows[i]!.id)).toBe(true)
    expect(row(f.id)).toMatchObject({ user_id: 'bob', shared_at: null, people_shared_at: null, fork_of: chat.id, fork_pending: 1, active_leaf_id: rows.at(-1)!.id })
    // the original: the same messages, nobody new
    expect(msgRows(chat.id)).toEqual(before)
    expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).shared?.audience).toBe(2)
    // only bob sees it
    expect((await errOf(h.api('alice').call(API.getChat, { params: { id: f.id } }))).status).toBe(404)
    expect((await h.api('alice').call(API.listChats, { query: {} })).items.map((c) => c.id)).not.toContain(f.id)
    expect((await h.api('bob').call(API.listChats, { query: {} })).items.map((c) => c.id)).toContain(f.id)
    expect(ws.alice!.frames.some((x) => x.type === 'chat.updated' && x.data.chatId === f.id)).toBe(false)
    const a = db().query("SELECT actor_id AS actor, detail FROM audit_log WHERE action = 'chat.fork' AND target = ?").all(f.id) as { actor: string; detail: string }[]
    expect(a.map((x) => [x.actor, JSON.parse(x.detail).from])).toEqual([['bob', chat.id]])
    // later words in the original do not follow
    db().query("UPDATE messages SET content = 'EDITED' WHERE id = ?").run(before[1]!.id)
    expect((await messages('bob', f.id))[1]!.content).toBe('ALICE-ANSWER')
  })

  test('an answer hidden from me is one line with nothing of it, also after the original would show it; left_out is mapped; my own unrecorded answer stays mine', async () => {
    const chat = await newShared('alice')
    await ask('alice', chat.id, `Secret numbers\n${fake({ say: 'HIDDEN-FROM-BOB' })}`)
    await ask('bob', chat.id, `My part\n${fake({ say: 'BOB-OWN' })}`)
    await ask('bob', chat.id, `Again\n${fake({ say: 'BOB-UNRECORDED' })}`)
    const src = msgRows(chat.id)
    const [, a1, , b1, , b2] = src
    // alice's answer from before the cutover without a record: hidden from everyone but her (fails closed)
    // (its text set here: the question's own words name what the fake engine says)
    db().query("UPDATE messages SET created_at = '2020-01-01T00:00:00.000Z', content = 'SECRET-NUMBERS-TEXT' WHERE id = ?").run(a1!.id)
    db().query('DELETE FROM shared_answer_reads WHERE message_id IN (?, ?)').run(a1!.id, b2!.id)
    // (once bob is in its record, the original shows it to him: below)
    setLeftOut(db(), chat.id, b1!.id, [a1!.id])
    const was = hiddenAnswersCutover(db())
    setHiddenAnswersCutover(db(), '2021-01-01T00:00:00.000Z')
    let f: Chat
    try {
      expect((await messages('bob', chat.id))[1]!.withheld).toBe(true)
      f = await fork('bob', chat.id)
    } finally { setHiddenAnswersCutover(db(), was) }
    // the original's record now has bob in it, so it shows it to him; the copy never does
    setAnswerReads(db(), chat.id, a1!.id, [{ c: ['alice', 'bob'], s: [] }])
    expect((await messages('bob', chat.id))[1]!.withheld).toBeUndefined()
    const rows = msgRows(f.id)
    expect(rows[1]).toMatchObject({ withheld_copy: 1, content: '', steps: '[]', attachments: '[]', step_notes: null })
    expect(JSON.stringify(rows)).not.toContain('SECRET-NUMBERS-TEXT')
    const got = await messages('bob', f.id)
    expect(got[1]!.withheld).toBe(true)
    expect(got[3]).toMatchObject({ content: 'BOB-OWN' })
    expect(got[3]!.withheld).toBeUndefined()
    // left_out names the copies
    const left = (db().query('SELECT left_out FROM shared_answer_reads WHERE message_id = ?').get(rows[3]!.id) as { left_out: string }).left_out
    expect(JSON.parse(left)).toEqual([rows[1]!.id])
    // bob's own answer without a record: still his (its turn row says so), and none is made up
    expect(got[5]).toMatchObject({ content: 'BOB-UNRECORDED' })
    expect(got[5]!.withheld).toBeUndefined()
    expect(db().query('SELECT 1 FROM shared_answer_reads WHERE message_id = ?').get(rows[5]!.id)).toBeNull()
    // the fork's fresh session gets the line in its place, never the text
    const sys = await ask('bob', f.id, fake({ echo: 'system' }))
    expect(sys.done.content).not.toContain('SECRET-NUMBERS-TEXT')
    expect(sys.done.content).toContain(WITHHELD_ANSWER)
  })

  test('records with left_out mapped, the read scope and the marks are copied as they are', async () => {
    const chat = await newShared('alice')
    await ask('alice', chat.id, `One\n${fake({ say: 'A' })}`)
    await ask('bob', chat.id, `Two\n${fake({ say: 'B' })}`)
    const src = msgRows(chat.id)
    setAnswerReads(db(), chat.id, src[3]!.id, [{ c: ['alice', 'bob'], s: [{ type: 'root' }], y: 1 }])
    setLeftOut(db(), chat.id, src[3]!.id, [src[1]!.id])
    const scope = JSON.stringify({ sources: [{ type: 'root' }], v: 2, unlisted: [] })
    db().query('UPDATE chats SET session_tainted = 1, room_outside = 1, session_read_scope = ? WHERE id = ?').run(scope, chat.id)
    const f = await fork('bob', chat.id)
    const rows = msgRows(f.id)
    const rec = db().query('SELECT reads, left_out FROM shared_answer_reads WHERE message_id = ?').get(rows[3]!.id) as { reads: string; left_out: string }
    expect(JSON.parse(rec.reads)).toEqual([{ c: ['alice', 'bob'], s: [{ type: 'root' }], y: 1 }])
    expect(JSON.parse(rec.left_out)).toEqual([rows[1]!.id])
    // others' words are in it: the mark that keeps sends to what the person's own message names
    expect(row(f.id)).toMatchObject({ session_tainted: 1, room_outside: 1, others_words: 1, session_read_scope: scope })
  })

  test('another person\'s step notes only as the shared chat gives them to me; their step details stay theirs', async () => {
    const chat = await newShared('alice')
    await ask('alice', chat.id, `Read the brief\n${fake({ say: 'Done' })}`)
    const a1 = msgRows(chat.id)[1]!
    const steps = [
      { id: 's1', kind: 'tool', tool: 'read', label: 'Read a file', status: 'ok', sv: { label: 'Read projects/falcon/brief.md', paths: ['projects/falcon/brief.md'] } },
      { id: 's2', kind: 'tool', tool: 'mcp__mail__search', label: 'Search mail', status: 'ok', detail: 'MAIL-DETAIL' },
      { id: 's3', kind: 'tool', tool: 'read', label: 'Read a file', status: 'ok', sv: { label: 'Read users/alice/private.md', paths: ['users/alice/private.md'] } },
    ]
    const notes = { s1: { i: 'path "projects/falcon/brief.md"', o: 'BRIEF-START' }, s2: { i: 'query "q"', o: 'MAIL-RESULT' }, s3: { i: 'path "users/alice/private.md"', o: 'PRIVATE-START' } }
    db().query('UPDATE messages SET steps = ?, step_notes = ? WHERE id = ?').run(JSON.stringify(steps), JSON.stringify(notes), a1.id)
    const f = await fork('bob', chat.id)
    const copy = msgRows(f.id)[1]!
    expect(Object.keys(JSON.parse(copy.step_notes ?? '{}'))).toEqual(['s1'])
    expect(copy.steps).not.toContain('MAIL-DETAIL')
    expect(copy.steps).not.toContain('users/alice/private.md')
    // the fork's fresh session gets the file step's note, as the shared chat would give it to bob
    const sys = await ask('bob', f.id, fake({ echo: 'system' }))
    expect(sys.done.content).toContain('BRIEF-START')
    expect(sys.done.content).not.toContain('MAIL-RESULT')
    expect(sys.done.content).not.toContain('PRIVATE-START')
  })
})

describe('nothing of another person\'s that I do not see', () => {
  test('their computer upload, their failure reason and their usage stay out of my copy', async () => {
    const chat = await newShared('alice')
    await ask('alice', chat.id, `See the file\n${fake({ say: 'Seen' })}`)
    const [q, a] = msgRows(chat.id)
    const upload = { id: crypto.randomUUID(), name: 'ALICE-PRIVATE.pdf', path: `users/alice/.attachments/${chat.id}/ALICE-PRIVATE.pdf`, size: 10, mime: 'application/pdf', kind: 'pdf' }
    db().query('UPDATE messages SET attachments = ? WHERE id = ?').run(JSON.stringify([upload]), q!.id)
    db().query("UPDATE messages SET status = 'error', error = ? WHERE id = ?").run(JSON.stringify({ code: 'internal', message: 'ALICE-ERROR-DETAIL' }), a!.id)
    db().query('UPDATE turns SET input_tokens = 1234, output_tokens = 99, cost_usd = 0.5 WHERE id = ?').run(a!.turn_id)
    const f = await fork('bob', chat.id)
    const rows = msgRows(f.id)
    expect(JSON.stringify(rows)).not.toContain('ALICE-PRIVATE')
    expect(JSON.stringify(rows)).not.toContain('ALICE-ERROR-DETAIL')
    const t = db().query('SELECT input_tokens, output_tokens, cost_usd FROM turns WHERE id = ?').get(rows[1]!.turn_id) as Record<string, number>
    expect(t).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0 })
    const got = await messages('bob', f.id)
    expect(got[0]!.attachments).toEqual([])
    expect(got[1]!.usage).toBeNull()
  })
})

describe('the engine session', () => {
  test('my own session goes on once with what others wrote since and the fork line; a newcomer to the original does not drop it; the skill list is recorded', async () => {
    const chat = await newShared('alice')
    await ask('alice', chat.id, `Start\n${fake({ say: 'ok' })}`)
    await ask('bob', chat.id, `Bob asks\n${fake({ say: 'bob ok' })}`)
    await ask('alice', chat.id, `ALICE-AFTER-BOB\n${fake({ say: 'ALICE-LATER-ANSWER' })}`)
    const sid = (db().query("SELECT engine_session_blob AS f FROM turns WHERE chat_id = ? AND user_id = 'bob' AND engine_session_blob IS NOT NULL").get(chat.id) as { f: string }).f
    expect(fs.existsSync(sid)).toBe(true)
    // carol joins the original before the fork's first answer: not someone who sees the fork
    const folder = (db().query("SELECT id FROM folders WHERE path = 'projects/falcon'").get() as { id: string }).id
    const rule = crypto.randomUUID()
    db().query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'carol', 'read')").run(rule, folder)
    try {
      const f = await fork('bob', chat.id)
      const r = row(f.id)
      expect(r.engine_session_id).toBe(path.basename(sid, '.jsonl'))
      const copy = path.join(h.ctx.config.dataDir, 'sessions', f.id, `${r.engine_session_id}.jsonl`)
      expect(fs.readFileSync(copy)).toEqual(fs.readFileSync(sid))
      expect(r.engine_session_leaf_id).toBe(msgRows(f.id)[3]!.id)
      const first = await ask('bob', f.id, fake({ echo: 'resume' }))
      expect(first.done.content).toBe('resumed=true')
      expect(row(f.id).fork_pending).toBe(0)
      const listed = db().query('SELECT user_id, session_id FROM chat_skill_lists WHERE chat_id = ?').get(f.id) as { user_id: string; session_id: string | null }
      expect(listed).toEqual({ user_id: 'bob', session_id: r.engine_session_id as string })
      // the next answer goes on like any chat's
      expect((await ask('bob', f.id, fake({ echo: 'resume' }))).done.content).toBe('resumed=true')
      // the fork's first message carries what alice wrote after bob's last answer and the fork line
      const f2 = await fork('bob', chat.id)
      const msg = await ask('bob', f2.id, fake({ echo: 'message' }))
      expect(msg.done.content).toContain('<since_your_last_answer>')
      expect(msg.done.content).toContain('ALICE-AFTER-BOB')
      expect(msg.done.content).toContain('ALICE-LATER-ANSWER')
      expect(msg.done.content).toContain('<chat_copy>')
      expect(msg.done.content).toContain('only Bob')
      // the original's own session of bob is untouched
      expect(fs.existsSync(sid)).toBe(true)
    } finally { db().query('DELETE FROM folder_rules WHERE id = ?').run(rule) }
  })

  test('no session of mine on the branch: a fresh start from the copied words; losing access resets the fork\'s session', async () => {
    const chat = await newShared('alice')
    await ask('alice', chat.id, `Only alice\n${fake({ say: 'ALICE-ONLY' })}`)
    const f = await fork('bob', chat.id)
    expect(row(f.id).engine_session_id).toBeNull()
    expect((await ask('bob', f.id, fake({ echo: 'resume' }))).done.content).toBe('resumed=false')
    expect(row(f.id).fork_pending).toBe(0)
    // a session the fork made of its own: the access-change reset covers it like any chat of bob's
    expect(row(f.id).engine_session_id).not.toBeNull()
    resetEngineSessions(h.ctx, 'bob')
    expect(row(f.id).engine_session_id).toBeNull()
    expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'sessions', f.id))).toBe(false)
  })

  test('a copied session that holds what I can no longer open is not resumed (a fresh start)', async () => {
    const chat = await newShared('alice')
    await ask('bob', chat.id, `Bob first\n${fake({ say: 'bob ok' })}`)
    const b1 = msgRows(chat.id)[1]!
    // the answer read a place bob may not read now
    setAnswerReads(db(), chat.id, b1.id, [{ c: ['alice', 'bob'], s: [{ type: 'user', id: 'alice' }] }])
    const f = await fork('bob', chat.id)
    const copied = row(f.id).engine_session_id as string
    expect(copied).not.toBeNull()
    const copy = path.join(h.ctx.config.dataDir, 'sessions', f.id, `${copied}.jsonl`)
    expect(fs.existsSync(copy)).toBe(true)
    // the fresh first answer fails before it keeps a session of its own
    const first = await ask('bob', f.id, fake({ startFail: true }))
    expect(first.done.status).toBe('error')
    expect(row(f.id).fork_pending).toBe(0)
    // the copied session went with that decision: an edit of the first question (its parent is the copy's leaf) does
    // not resume it without the checks
    expect(fs.existsSync(copy)).toBe(false)
    expect(row(f.id).engine_session_id).toBeNull()
    const e = await h.api('bob').call(API.editMessage, { params: { id: f.id, messageId: first.started.userMessage!.id }, body: { content: fake({ echo: 'resume' }), clientMessageId: cm(), attachmentIds: [] } })
    const done = await ws.bob!.next('message.done', (x) => x.data.messageId === e.assistantMessage.id, 30_000)
    expect(done.data.message.content).toBe('resumed=false')
  })
})

describe('tools in a fork', () => {
  test('a fork holding only copies of words I saw is my own chat for my tools: looking_at and my folders are offered', async () => {
    const chat = await newShared('alice')
    await ask('alice', chat.id, `Hello\n${fake({ say: 'hi' })}`)
    await ask('bob', chat.id, `Me too\n${fake({ say: 'hi bob' })}`)
    const inShared = await ask('bob', chat.id, fake({ echo: 'tools' }))
    expect(inShared.done.content).not.toContain('looking_at')
    const f = await fork('bob', chat.id)
    const tools = await ask('bob', f.id, fake({ echo: 'tools' }))
    expect(tools.done.content).toContain('looking_at')
  })
})

describe('chat files by reference', () => {
  type Sub = { subjectType: 'user' | 'group'; subjectId: string }
  const put = (user: string, chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
    h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
  async function share(user: string, chatId: string, subjects: Sub[]) {
    let r = await put(user, chatId, subjects)
    if (r.status === 'confirm') r = await put(user, chatId, subjects, r.confirmKey)
    if (r.status !== 'saved') throw new Error('not saved')
  }
  async function upload(user: string, chatId: string, name: string, content: string) {
    const form = new FormData()
    form.set('chatId', chatId)
    form.set('file', new File([content], name))
    const res = await h.req(user, '/api/uploads', { method: 'POST', body: form })
    return { status: res.status, body: (await res.json()) as Attachment }
  }

  test('a chat shared with people: the fork is outside projects; its file opens while I see it there, and not after', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    await ask('alice', c.id, `hello\n${fake({ say: 'hi' })}`)
    await share('alice', c.id, [{ subjectType: 'user', subjectId: 'bob' }])
    const up = await upload('alice', c.id, 'notes.txt', 'FILE-BODY-IN-SOURCE')
    expect(up.status).toBe(201)
    await ask('alice', c.id, `here it is\n${fake({ say: 'ok' })}`, [up.body.id])
    const f = await fork('bob', c.id)
    expect(f.projectId).toBeNull()
    const att = (await messages('bob', f.id))[2]!.attachments[0]!
    expect(att).toMatchObject({ id: up.body.id, source: 'chat', fromChat: c.id, name: 'notes.txt' })
    const res = await h.req('bob', `/api/chats/${f.id}/files/${up.body.id}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('FILE-BODY-IN-SOURCE')
    // the AI of the fork reads it by its chat place
    const read = await ask('bob', f.id, fake({ tool: 'chat_file', args: { file: up.body.id }, sayResult: true }))
    expect(read.done.content).toContain('FILE-BODY-IN-SOURCE')
    // a new version is never written into the shared chat's file from here
    const save = await h.req('bob', `/api/chats/${f.id}/files/${up.body.id}/content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'CHANGED' }) })
    expect(save.status).toBe(409)
    // taken out of the shared chat: the copy's file goes with it
    await share('alice', c.id, [])
    expect((await h.req('bob', `/api/chats/${f.id}/files/${up.body.id}`)).status).toBe(404)
    expect((await messages('bob', f.id))[2]!.attachments).toEqual([])
    // the copied words stay
    expect((await messages('bob', f.id))[2]!.content.split('\n')[0]).toBe('here it is')
  })
})

describe('refusals', () => {
  test('a chat of one person, nothing finished yet, someone who does not see it, a guest outside their place', async () => {
    const mine = await h.api('alice').call(API.createChat, { body: { projectId, private: true } })
    await ask('alice', mine.id, `Private\n${fake({ say: 'p' })}`)
    const one = await errOf(fork('alice', mine.id))
    expect([one.status, one.body.params?.reason]).toEqual([409, 'fork_not_shared'])
    const empty = await newShared('alice')
    const none = await errOf(fork('alice', empty.id))
    expect([none.status, none.body.params?.reason]).toEqual([409, 'fork_nothing'])
    const chat = await newShared('alice')
    await ask('alice', chat.id, `Hi\n${fake({ say: 'hi' })}`)
    expect((await errOf(fork('erin', chat.id))).status).toBe(404)
    // a guest may call it (their own chat in their one project), but nowhere else
    expect(GUEST_ENDPOINTS.has(API.forkChat)).toBe(true)
    const bobs = await newShared('bob')
    await ask('bob', bobs.id, `Bob\n${fake({ say: 'b' })}`)
    // bob stands for a guest invited to the project (their guests row names it, and a person rule on its folder)
    const folder = (db().query("SELECT id FROM folders WHERE path = 'projects/falcon'").get() as { id: string }).id
    db().query("UPDATE users SET guest = 1 WHERE id = 'bob'").run()
    db().query("INSERT INTO guests (user_id, place_kind, place_id, project_id, ai, created_at) VALUES ('bob', 'project', ?, ?, 'none', ?)").run(projectId, projectId, new Date().toISOString())
    db().query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('fork-guest', ?, 'user', 'bob', 'read')").run(folder)
    try {
      // without AI: refused (the web keeps the old way)
      const g = await errOf(fork('bob', bobs.id))
      expect([g.status, g.body.params?.reason]).toEqual([403, 'fork_guest'])
      // with AI, in their own project: allowed
      db().query("UPDATE guests SET ai = 'team' WHERE user_id = 'bob'").run()
      expect((await fork('bob', bobs.id)).projectId).toBe(projectId)
    } finally {
      db().query("UPDATE users SET guest = 0 WHERE id = 'bob'").run()
      db().query("DELETE FROM folder_rules WHERE id = 'fork-guest'").run()
      db().query("DELETE FROM guests WHERE user_id = 'bob'").run()
    }
  })
})
