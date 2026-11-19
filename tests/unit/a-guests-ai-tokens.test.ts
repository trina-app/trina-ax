// A guest's Team AI limit in tokens (docs/DECISIONS.md "Guest Team AI: a token limit"): stored as the guest's own
// 'block' budget with limit_tokens (no money limit), enforced on tokens whatever the connection costs, shown with what
// is used and when it starts over; a guest given Team AI before tokens keeps their US dollar limit, read and enforced as
// it is, until an admin changes it; a team's tokens per answer for "about N answers".
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import path from 'node:path'
import { DEFAULT_TOKENS_PER_ANSWER, MIN_ANSWERS_FOR_AVERAGE, answersFor } from '@mycel/shared'
import { setEnginesEnabled, teamTimeZone } from '../../server/src/admin/settings'
import { answerTokens, budgetBlock, periodEnd } from '../../server/src/admin/budgets'
import { guestHasBlockBudget } from '../../server/src/credentials/guest-ai'
import { addCred, testCredCtx } from '../lib/credentials'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })
const key = (s: string) => `sk-ant-api03-${s}${'k'.repeat(30)}`

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(owner, [mia.id, nora.id])
  const t = testCredCtx(h.ctx.db, path.join(h.ctx.config.dataDir, 'test-secrets'))
  setEnginesEnabled(h.ctx.db, { 'claude-code': true, codex: true })
  const team = addCred(t.cc, 'anthropic-api-key', key('tokensteam'), { label: 'team' })
  return { owner, mia, room, team }
}
let n = 0
/** One answer of `userId` now: `tokens` in and out, at no cost (a subscription connection prices nothing). */
const answer = (userId: string, input: number, output: number, costUsd = 0, at = new Date()) =>
  h.ctx.db.query('INSERT INTO turns (id, chat_id, user_id, engine, status, started_at, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`t-${++n}`, 'c', userId, 'claude-code', 'done', at.toISOString(), input, output, costUsd)

test('Team AI stores a token limit, counts every token toward it and blocks at it, even at no cost', async () => {
  const { owner, room, team } = await setup('a-guests-tokens-enforce')
  const g = await addGuest(h, owner, { username: 'tia', place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitTokens: 10_000 } })
  expect(h.ctx.db.query("SELECT period, limit_usd, limit_tokens, action FROM budgets WHERE subject_type = 'user' AND subject_id = ?").all(g.id))
    .toEqual([{ period: 'month', limit_usd: 0, limit_tokens: 10_000, action: 'block' }])
  const me = await g.client.call('GET', '/api/me')
  expect(me.guest.ai).toEqual({ mode: 'team', credentialId: team, limitTokens: 10_000 })
  const resetsAt = periodEnd('month', new Date(), teamTimeZone(h.ctx.db)).toISOString()
  expect(me.guest.aiUse).toEqual({ usedTokens: 0, usedUsd: 0, resetsAt })
  // under the limit: answers go on, and Admin's row has what is used
  answer(g.id, 6_000, 3_000)
  expect(budgetBlock(h.ctx.db, g.id, 'en')).toBeNull()
  const row = async () => ((await owner.call('GET', '/api/admin/users')).items as { id: string; guest?: { aiUse?: { usedTokens: number }; aiUsedUp?: true } }[]).find((u) => u.id === g.id)!.guest!
  expect((await row()).aiUse?.usedTokens).toBe(9_000)
  expect((await row()).aiUsedUp).toBeUndefined()
  // at the limit: input and output both count, the cost does not (0 here), and the send is refused with the reset date
  answer(g.id, 500, 500)
  const b = budgetBlock(h.ctx.db, g.id, 'en')!
  expect(b.resetsAt).toBe(resetsAt)
  // the words every place shows as they are (the composer, a room's AI side chat) name the amount (QA TC-3310)
  expect(b.message).toStartWith("You have used up this month's AI limit (10K tokens). You can use it again from ")
  expect(budgetBlock(h.ctx.db, g.id, 'ko')!.message).toStartWith('이번 달 AI 한도(1만 토큰)를 다 썼어요. ')
  expect((await row()).aiUsedUp).toBe(true)
  const r = await g.client.try('POST', '/api/chats', { message: 'hello' })
  expect(r.body.error.code).toBe('budget_exceeded')
  expect(r.body.error.params).toEqual({ resetsAt, period: 'month', own: true })
  // last month's tokens do not count
  h.ctx.db.query("DELETE FROM turns WHERE user_id = ?").run(g.id)
  answer(g.id, 50_000, 0, 0, new Date(Date.now() - 40 * 86_400_000))
  expect(budgetBlock(h.ctx.db, g.id, 'en')).toBeNull()
})

test('Change AI sets a token limit and replaces an older guest\'s US dollar one; a body in dollars is refused', async () => {
  const { owner, room, team } = await setup('a-guests-tokens-change')
  const g = await addGuest(h, owner, { username: 'tia', place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitTokens: 10_000 } })
  // a guest given Team AI before tokens: their budget in US dollars, read and shown as it is
  h.ctx.db.query("UPDATE budgets SET limit_usd = 20, limit_tokens = NULL WHERE subject_type = 'user' AND subject_id = ?").run(g.id)
  expect((await g.client.call('GET', '/api/me')).guest.ai).toEqual({ mode: 'team', credentialId: team, limitUsd: 20 })
  // still enforced in dollars: tokens alone never stop it, $20 of spend does
  answer(g.id, 5_000_000, 0, 0)
  expect(budgetBlock(h.ctx.db, g.id, 'en')).toBeNull()
  answer(g.id, 10, 10, 20)
  // a dollar guest reads the words without an amount
  expect(budgetBlock(h.ctx.db, g.id, 'en')!.message).toStartWith("You have used up this month's AI usage limit.")
  // the API takes tokens only: dollars, a fraction, 0 or over the cap are refused and nothing changes
  const url = `/api/admin/users/${g.id}/guest-ai`
  for (const body of [{ limitUsd: 20 }, { limitTokens: 5_000_000, limitUsd: 20 }, { limitTokens: 1.5 }, { limitTokens: 0 }, { limitTokens: 2_000_000_000 }, {}])
    expect((await owner.try('PATCH', url, { mode: 'team', credentialId: team, ...body })).status).toBe(400)
  expect((await owner.try('POST', '/api/guest-invites', { place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitUsd: 5 } })).status).toBe(400)
  expect(h.ctx.db.query("SELECT limit_usd, limit_tokens FROM budgets WHERE subject_type = 'user' AND subject_id = ?").all(g.id)).toEqual([{ limit_usd: 20, limit_tokens: null }])
  // an admin picks tokens: the dollar limit goes, the token one counts from the same month's turns
  const u = await owner.call('PATCH', url, { mode: 'team', credentialId: team, limitTokens: 9_000_000 })
  expect(u.guest.ai).toEqual({ mode: 'team', credentialId: team, limitTokens: 9_000_000 })
  expect(h.ctx.db.query("SELECT limit_usd, limit_tokens FROM budgets WHERE subject_type = 'user' AND subject_id = ?").all(g.id)).toEqual([{ limit_usd: 0, limit_tokens: 9_000_000 }])
  expect(budgetBlock(h.ctx.db, g.id, 'en')).toBeNull()
  answer(g.id, 4_000_000, 0, 0)
  expect(budgetBlock(h.ctx.db, g.id, 'en')).not.toBeNull()
})

test('a limit cleared in Admin › AI limits is no limit: Team AI is off for the guest, not unlimited', async () => {
  const { owner, room, team } = await setup('a-guests-tokens-cleared')
  const g = await addGuest(h, owner, { username: 'tia', place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitTokens: 10_000 } })
  expect(guestHasBlockBudget(h.ctx.db, g.id)).toBe(true)
  h.ctx.db.query("UPDATE budgets SET limit_tokens = NULL, limit_usd = 0 WHERE subject_type = 'user' AND subject_id = ?").run(g.id)
  expect(guestHasBlockBudget(h.ctx.db, g.id)).toBe(false)
  expect((await g.client.call('GET', '/api/me')).guest.ai).toEqual({ mode: 'none' })
})

test('a team limit that stops a guest is not said as their own amount (params.own only for their own)', async () => {
  const { owner, room, team } = await setup('a-guests-tokens-team-limit')
  const g = await addGuest(h, owner, { username: 'tia', place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitTokens: 10_000_000 } })
  h.ctx.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES ('team-day', 'team', NULL, 'day', 0, 1000, 'block')").run()
  answer(g.id, 800, 300)
  const b = budgetBlock(h.ctx.db, g.id, 'en')!
  expect(b.budget.subjectType).toBe('team')
  expect(b.params.own).toBeUndefined()
  expect(b.message).not.toContain('tokens)')
})

test('a guest link made before tokens, used now, gives its US dollar limit as it was', async () => {
  const { owner, room, team } = await setup('a-guests-tokens-old-link')
  const inv = await owner.call('POST', '/api/guest-invites', { place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitTokens: 10_000 } })
  const token = String(inv.url).split('/invite/')[1]!
  // the link as an older server stored it
  h.ctx.db.query('UPDATE invites SET guest_ai = ? WHERE id = ?').run(JSON.stringify({ mode: 'team', credentialId: team, limitUsd: 15 }), inv.invite.id)
  const c = h.client({ ip: '10.0.0.7' })
  const r = await c.call('POST', `/api/invites/${token}/accept`, { username: 'olda', name: 'OLDA', password: 'guest river lamp 77' })
  expect(r.me.guest.ai).toEqual({ mode: 'team', credentialId: team, limitUsd: 15 })
  expect(h.ctx.db.query("SELECT limit_usd, limit_tokens FROM budgets WHERE subject_type = 'user' AND subject_id = ?").all(r.me.user.id)).toEqual([{ limit_usd: 15, limit_tokens: null }])
})

test("the team's tokens per answer: the default until enough answers, then their mean; for the owner and admins only", async () => {
  const { owner, mia } = await setup('a-guests-tokens-average')
  expect(answerTokens(h.ctx.db)).toEqual({ tokens: DEFAULT_TOKENS_PER_ANSWER, from: 'default' })
  for (let i = 0; i < MIN_ANSWERS_FOR_AVERAGE - 1; i++) answer(mia.id, 30_000, 10_000)
  // answers without tokens (failed before the AI ran) and answers older than 90 days do not count
  answer(mia.id, 0, 0)
  answer(mia.id, 900_000, 0, 0, new Date(Date.now() - 100 * 86_400_000))
  expect(answerTokens(h.ctx.db).from).toBe('default')
  answer(mia.id, 50_000, 10_000)
  // (19 × 40,000 + 60,000) / 20 = 41,000
  expect(answerTokens(h.ctx.db)).toEqual({ tokens: 41_000, from: 'team' })
  expect((await owner.call('GET', '/api/guest-invites/limit')).answerTokens).toEqual({ tokens: 41_000, from: 'team' })
  expect((await mia.client.call('GET', '/api/guest-invites/limit')).answerTokens).toBeUndefined()
})

test('"about N answers" rounds to friendly numbers', () => {
  // rounded down, never more than fits
  expect(answersFor(1_000_000, 80_000)).toBe(12) // 12.5
  expect(answersFor(5_000_000, 80_000)).toBe(62) // 62.5
  expect(answersFor(10_000_000, 80_000)).toBe(120) // 125
  expect(answersFor(1_000_000, 41_000)).toBe(24) // 24.4
  expect(answersFor(5_000_000, 41_000)).toBe(120) // 121.9
  expect(answersFor(5_000_000, 52_000)).toBe(96) // 96.2
  expect(answersFor(100_000, 80_000)).toBe(1)
  expect(answersFor(50_000, 80_000)).toBe(0) // less than one answer
  expect(answersFor(10_000_000, 7_000)).toBe(1_400) // 1,428.6
  expect(answersFor(1_000_000_000, 3_000)).toBe(330_000) // 333,333
  expect(answersFor(0, 80_000)).toBe(0)
  expect(answersFor(1_000_000, 0)).toBe(0)
})
