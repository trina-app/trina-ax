// Scheduled tasks and videos in shared chats (docs/decisions/20261118-shared-schedules-any-frequency.md). The owner:
// "in a shared chat everything is shared". A task made in a shared chat runs as its maker, in that chat, with every gate
// of that chat: a read some of its people cannot open needs the maker's card, and a run has nobody to answer it, so it
// is skipped. The maker's other tasks stay theirs (list and delete there see only the chat's own). Uses the shared
// project chat fixture of b-shared-chats: projects/falcon, alice writes it, bob (finance) reads it; the marketing brief
// is alice's to read, not bob's.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { CONFIRMED } from '../lib/schedule-card'
import { namedPaths, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { peopleShareRefusal } from '../../server/src/chat/people-share'
import { sharedSection } from '../../server/src/chat/prompt'
import { scheduledRunBlock } from '../../server/src/chat/schedules'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const BRIEF = 'groups/marketing/campaign-brief.md'
const CANARY = 'Autumn Upgrade'

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-schedules', askUserTimeoutMs: 5000, stallTimeoutMs: 60_000, timeZone: 'Asia/Seoul' })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const newShared = async (user = 'alice') => h.api(user).call(API.createChat, { body: { projectId } })
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
async function ask(user: string, chatId: string, content: string) {
  const started = await send(user, chatId, content)
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return { started, done: done.data.message }
}
/** send, answer the turn's first card with `value`, wait for the end */
async function askWithCard(user: string, chatId: string, content: string, value: string) {
  const started = await send(user, chatId, content)
  const card = await ws[user]!.next('turn.request', (f) => f.data.turnId === started.turnId, 15_000)
  await h.api(user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: value } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  const req = card.data.request
  if (req.kind !== 'ask_user') throw new Error(`expected a question card, got ${req.kind}`)
  return { started, card: req, done: done.data.message }
}
const schedulesOf = (user: string) => db().query('SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at').all(user) as { id: string; title: string; chat_id: string | null; project_id: string | null; last_chat_id: string | null }[]
/** run a task now through the runner, as at its time; the chat its run is in once the answer is done */
async function runIt(id: string): Promise<string> {
  db().query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id)
  expect(h.rt().schedules.runDue(new Date())).toEqual([id])
  const turn = db().query('SELECT id, chat_id FROM turns WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1').get(id) as { id: string; chat_id: string }
  await waitFor(() => (db().query("SELECT status FROM turns WHERE id = ?").get(turn.id) as { status: string }).status !== 'queued' &&
    (db().query("SELECT status FROM messages WHERE turn_id = ? AND role = 'assistant'").get(turn.id) as { status: string } | null)?.status !== 'streaming', { timeoutMs: 30_000 })
  return turn.chat_id
}
const answerOf = (chatId: string) => (db().query("SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(chatId) as { content: string }).content

describe('offered in a shared chat', () => {
  test('the allowlist has schedules and videos; a shared turn offers them; a guest\'s tools stay as they are', async () => {
    for (const t of ['schedule_create', 'schedule_list', 'schedule_delete', 'generate_video', 'promo_video', 'save_promo_video']) expect(SHARED_TOOLS.has(t)).toBe(true)
    const chat = await newShared()
    const offered = (await ask('alice', chat.id, fake({ echo: 'tools' }))).done.content.split(',').map((t) => t.replace(/^mcp__team__/, ''))
    for (const t of ['schedule_create', 'schedule_list', 'schedule_delete', 'promo_video']) expect(offered).toContain(t)
    // the instructions no longer send the person elsewhere for them
    const words = sharedSection({ project: 'Falcon', audience: 2, asker: 'Alice Kim' }, 'en')
    expect(words).not.toContain('scheduled tasks;')
    expect(words).not.toContain('video generation')
    expect(words).toContain('A scheduled task made here runs as Alice Kim')
  })

  test('promo_video\'s logo and pictures are weighed by the shared read card like its sources', () => {
    const paths = namedPaths('promo_video', { sources: ['shared/intro.md'], logo: 'groups/marketing/logo.png', promise: { headline: 'x', picture: 'groups/marketing/hero.jpg' }, work: { headline: 'y', picture: 'users/alice/secret.png' }, proof: { picture: 'groups/finance/chart.png' } })
    expect(paths.map((p) => p.value).sort()).toEqual(['groups/finance/chart.png', 'groups/marketing/hero.jpg', 'groups/marketing/logo.png', 'shared/intro.md', 'users/alice/secret.png'])
  })
})

describe('a task made in a shared chat', () => {
  let chatId = ''
  let taskId = ''
  test('the card says the runs post here and how many see it; the task remembers the chat', async () => {
    chatId = (await newShared()).id
    const prompt = fake({ tool: 'read', args: { file_path: BRIEF }, sayResult: true })
    const r = await askWithCard('alice', chatId, fake({ tool: 'schedule_create', args: { title: 'Brief check', prompt, repeat: 'weekly', weekdays: [1, 4], time: '09:00' }, sayResult: true }), 'create')
    expect(r.card.question).toContain('Each run posts its result in this shared chat, which 2 people can see now.')
    expect(r.card.question).toContain('every Monday and Thursday at 09:00')
    expect(r.done.content).toContain('Its runs post their results in this shared chat')
    const s = schedulesOf('alice').find((x) => x.title === 'Brief check')!
    expect(s).toMatchObject({ chat_id: chatId, project_id: projectId })
    taskId = s.id
    // the Scheduled page says where it posts
    const listed = (await h.api('alice').call(API.listSchedules)).items.find((x) => x.id === taskId)!
    expect(listed).toMatchObject({ repeat: 'weekly', weekdays: [1, 4], postsIn: { chatId } })
  })

  test('its run is a turn in that chat, as its maker, for everyone there; a place bob cannot open is not read (no card in a run)', async () => {
    const before = db().query('SELECT count(*) n FROM chats WHERE user_id = ?').get('alice') as { n: number }
    const ran = await runIt(taskId)
    expect(ran).toBe(chatId)
    // no new chat
    expect(db().query('SELECT count(*) n FROM chats WHERE user_id = ?').get('alice')).toEqual(before)
    const turn = db().query("SELECT user_id, client_kind, status FROM turns WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1").get(taskId)
    expect(turn).toEqual({ user_id: 'alice', client_kind: 'schedule', status: 'done' })
    // the brief is the marketing group's: bob sees this chat, so the read needs alice's yes, and nobody answers in a run
    const answer = answerOf(chatId)
    expect(answer).not.toContain(CANARY)
    expect(answer).toContain('Not read (read)')
    const ev = db().query("SELECT ok, summary FROM tool_events WHERE tool = 'read' ORDER BY rowid DESC LIMIT 1").get() as { ok: number; summary: string }
    expect(ev.ok).toBe(0)
    expect(ev.summary).toContain('(shared chat)')
    // the answer is bob's to see: it is in the chat he sees, under the earlier answer
    const msgs = (await h.api('bob').call(API.listMessages, { params: { id: chatId }, query: {} })).items
    const auto = msgs.filter((m) => m.role === 'user').at(-1)!
    expect(auto.content).toContain('"tool":"read"')
    expect(msgs.at(-1)!.role).toBe('assistant')
    expect(auto.parentId).toBe(msgs.filter((m) => m.role === 'assistant').at(-2)!.id)
    // the run history links it for its maker
    const runs = await h.api('alice').call(API.listScheduleRuns, { params: { id: taskId }, query: {} })
    expect(runs.items[0]).toMatchObject({ chatId })
  })

  test('a run there is told it is in a shared chat', () => {
    expect(scheduledRunBlock('T', 'every day at 09:00', null, true)).toContain('This run is in the shared chat the task was made in')
    expect(scheduledRunBlock('T', 'every day at 09:00', null, false)).not.toContain('shared chat')
  })

  test('the maker\'s other tasks are theirs: list and delete in the shared chat see only this chat\'s', async () => {
    const own = h.rt().schedules.create('alice', { title: 'Private plans', prompt: 'look at my folder', repeat: 'daily', time: '08:00' }, undefined, CONFIRMED)
    const listed = (await ask('alice', chatId, fake({ tool: 'schedule_list', args: {}, sayResult: true }))).done.content
    expect(listed).toContain('Brief check')
    expect(listed).not.toContain('Private plans')
    const del = (await ask('alice', chatId, fake({ tool: 'schedule_delete', args: { id: own.id }, sayResult: true }))).done.content
    expect(del).toContain(`no scheduled task ${own.id}`)
    expect(h.rt().schedules.get('alice', own.id)).not.toBeNull()
    // in her own chat she sees and deletes it
    const mine = await h.api('alice').call(API.createChat, { body: {} })
    expect((await ask('alice', mine.id, fake({ tool: 'schedule_list', args: {}, sayResult: true }))).done.content).toContain('Private plans')
    h.rt().schedules.delete('alice', own.id)
  })

  test('while its maker cannot continue the chat (deleted here), a run is a new chat of theirs, as any task', async () => {
    db().query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), chatId)
    try {
      const ran = await runIt(taskId)
      expect(ran).not.toBe(chatId)
      expect(db().query('SELECT user_id, project_id, title_source FROM chats WHERE id = ?').get(ran)).toEqual({ user_id: 'alice', project_id: projectId, title_source: 'schedule' })
      expect((await h.api('alice').call(API.listSchedules)).items.find((x) => x.id === taskId)!.postsIn).toBeNull()
    } finally { db().query('UPDATE chats SET deleted_at = NULL WHERE id = ?').run(chatId) }
  })

  test('bob\'s turn is bob\'s: his schedule_create there makes his task, not alice\'s', async () => {
    const r = await askWithCard('bob', chatId, fake({ tool: 'schedule_create', args: { title: 'Bob hourly', prompt: 'summarize this chat', repeat: 'interval', every_minutes: 60, time: '09:00' }, sayResult: true }), 'create')
    expect(r.card.question).toContain('1시간마다') // bob reads Korean
    expect(schedulesOf('bob').find((x) => x.title === 'Bob hourly')).toMatchObject({ chat_id: chatId })
    expect(schedulesOf('alice').some((x) => x.title === 'Bob hourly')).toBe(false)
  })
})

describe('sharing a chat that a run posted in', () => {
  test('a chat shared with people stays changeable after a run there; a private chat a run made is still never shared', () => {
    const now = new Date().toISOString()
    const mk = (people: boolean) => {
      const id = crypto.randomUUID()
      db().query("INSERT INTO chats (id, user_id, title, title_source, engine, created_at, updated_at, people_shared_at) VALUES (?, 'alice', 't', 'auto', 'claude-code', ?, ?, ?)").run(id, now, now, people ? now : null)
      db().query("INSERT INTO turns (id, chat_id, user_id, engine, status, started_at, schedule_id, scheduled_for, people_checked, shared_checked) VALUES (?, ?, 'alice', 'claude-code', 'done', ?, ?, ?, 1, 1)").run(crypto.randomUUID(), id, now, 'task-' + id, now)
      return h.rt().store.chatRow(id)!
    }
    expect(peopleShareRefusal(h.ctx, mk(true))).toBeNull()
    expect(peopleShareRefusal(h.ctx, mk(false))).toMatchObject({ status: 'conflict', reason: 'scheduled_run' })
  })
})
