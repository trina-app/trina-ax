// The one suggestion under a result (docs/DECISIONS.md "X — Lean onboarding"; server/src/onboarding/suggestions.ts):
// the same person running the same team skill for the 2nd time gets "매주 이 시간에 자동으로 받을까요?", a long
// report-like answer gets [PPT로 만들기], never both, and a suggestion the person closed never comes back for them.
import { afterEach, expect, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { PPT_SUGGEST_CHARS } from '@mycel/shared/api'

let h: Harness
afterEach(async () => { await h?.close() })

const AD = 'skills/marketing/ad-copy/SKILL.md'
const REPORT = 'skills/marketing/weekly-report/SKILL.md'

async function setup() {
  h = await harness('b-result-suggestions')
  const owner = await withOwner(h)
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  const mia = await addMember(h, owner, { username: 'mia' })
  return { owner, ownerId, mia }
}

/** One answer of a person in a new chat of theirs: the turn, its answer and the skill it ran (if any). */
function answer(userId: string, o: { skill?: { path: string; name: string; source?: 'command' | 'tool' }; status?: string; scheduleId?: string; content?: string } = {}) {
  const chatId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const turnId = crypto.randomUUID()
  const db = h.ctx.db
  db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chatId, userId)
  db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'assistant', ?, 'done')").run(messageId, chatId, o.content ?? 'Three options.')
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id, schedule_id) VALUES (?, ?, ?, 'claude', ?, ?, ?)").run(turnId, chatId, userId, o.status ?? 'done', messageId, o.scheduleId ?? null)
  if (o.skill) db.query('INSERT INTO turn_skill_runs (turn_id, skill_path, skill_name, source) VALUES (?, ?, ?, ?)').run(turnId, o.skill.path, o.skill.name, o.skill.source ?? 'command')
  return { chatId, messageId }
}
const ask = async (c: { call: (m: string, p: string, b?: unknown) => Promise<any> }, a: { chatId: string; messageId: string }) =>
  (await c.call('GET', `/api/onboarding/suggestion?chatId=${a.chatId}&messageId=${a.messageId}`)).suggestion

test('the same skill a 2nd time: schedule it; not after a failed or a scheduled run, not once a task runs it, never again once closed', async () => {
  const { owner, ownerId, mia } = await setup()
  const ad = { path: AD, name: 'ad-copy' }
  // the first run: nothing
  expect(await ask(owner, answer(ownerId, { skill: ad }))).toBeNull()
  // a failed run and a scheduled run do not count as the 2nd
  expect(await ask(owner, answer(ownerId, { skill: ad, status: 'error' }))).toBeNull()
  answer(ownerId, { skill: ad, scheduleId: 'sched-1' })
  // ...but a scheduled run means a task runs it already: take that row out to see the count alone
  h.ctx.db.query('DELETE FROM turns WHERE schedule_id = ?').run('sched-1')
  const second = answer(ownerId, { skill: ad })
  expect(await ask(owner, second)).toEqual({ kind: 'schedule', key: `schedule:${AD}`, skill: { path: AD, name: 'ad-copy' } })
  // the skill tool counts as a run too
  expect((await ask(owner, answer(ownerId, { skill: { ...ad, source: 'tool' } })))?.kind).toBe('schedule')
  // someone else's 1st run is theirs alone
  expect(await ask(mia.client, answer(mia.id, { skill: ad }))).toBeNull()

  // a task of theirs that runs "/ad-copy" already: nothing to suggest
  const sid = crypto.randomUUID()
  h.ctx.db.query("INSERT INTO schedules (id, user_id, title, prompt, repeat, time, weekday) VALUES (?, ?, '광고 문구', ?, 'weekly', '09:00', 1)").run(sid, ownerId, '/ad-copy\n알릴 제품·서비스: 데스크 매트')
  expect(await ask(owner, second)).toBeNull()
  // "/ad-copy-old" is another skill's command
  h.ctx.db.query('UPDATE schedules SET prompt = ? WHERE id = ?').run('/ad-copy-old', sid)
  expect((await ask(owner, second))?.kind).toBe('schedule')

  // closed: never again for this person, on any chat; another person still gets it
  expect((await owner.try('POST', '/api/onboarding/suggestion/dismiss', { key: `schedule:${AD}` })).status).toBe(204)
  expect((await owner.try('POST', '/api/onboarding/suggestion/dismiss', { key: `schedule:${AD}` })).status).toBe(204)
  expect(await ask(owner, second)).toBeNull()
  expect(await ask(owner, answer(ownerId, { skill: ad }))).toBeNull()
  answer(mia.id, { skill: ad })
  expect((await ask(mia.client, answer(mia.id, { skill: ad })))?.kind).toBe('schedule')
})

test('a long report-like answer: PPT; code is not prose; the weekly report always; schedule first, never both', async () => {
  const { owner, ownerId } = await setup()
  const long = '## 이번 주\n' + '가'.repeat(PPT_SUGGEST_CHARS)
  expect(await ask(owner, answer(ownerId, { content: long }))).toEqual({ kind: 'ppt', key: 'ppt' })
  expect(await ask(owner, answer(ownerId, { content: 'short' }))).toBeNull()
  expect(await ask(owner, answer(ownerId, { content: '```ts\n' + 'x'.repeat(PPT_SUGGEST_CHARS * 2) + '\n```\nDone.' }))).toBeNull()
  const report = { path: REPORT, name: 'weekly-report' }
  expect(await ask(owner, answer(ownerId, { skill: report, content: 'A short weekly report.' }))).toEqual({ kind: 'ppt', key: 'ppt' })
  // the 2nd weekly report: the schedule wins, one suggestion only
  expect((await ask(owner, answer(ownerId, { skill: report, content: long })))?.kind).toBe('schedule')
  // an answer still running or a scheduled run's answer: nothing
  expect(await ask(owner, answer(ownerId, { content: long, status: 'running' }))).toBeNull()
  expect(await ask(owner, answer(ownerId, { content: long, scheduleId: 'sched-2' }))).toBeNull()
  // closing PPT closes it for every later answer of this person
  await owner.call('POST', '/api/onboarding/suggestion/dismiss', { key: 'ppt' })
  expect(await ask(owner, answer(ownerId, { content: long }))).toBeNull()
})

test('own chats only; keys are checked', async () => {
  const { owner, ownerId, mia } = await setup()
  const a = answer(ownerId, { content: 'x' })
  expect((await mia.client.try('GET', `/api/onboarding/suggestion?chatId=${a.chatId}&messageId=${a.messageId}`)).status).toBe(404)
  expect((await owner.try('GET', `/api/onboarding/suggestion?chatId=${a.chatId}&messageId=nope`)).status).toBe(200)
  expect((await owner.try('GET', '/api/onboarding/suggestion?chatId=nope&messageId=nope')).status).toBe(404)
  for (const key of ['', 'schedule:', 'schedule:shared/x.md', 'other', 'ppt\nmore']) expect((await owner.try('POST', '/api/onboarding/suggestion/dismiss', { key })).status, key).toBe(400)
  expect((await owner.try('POST', '/api/onboarding/suggestion/dismiss', { key: 'ppt', extra: 1 })).status).toBe(400)
})
