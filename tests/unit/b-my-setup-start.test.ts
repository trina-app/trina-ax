// When the owner's own My setup card starts (docs/decisions/20261120-my-setup-card.md; server/src/onboarding/my-setup.ts):
// every way the team setup ends (the end screen through the shared-skills path, ✕ on the steps once it held), a lead
// who was handed the team, owners whose setup ended before the card existed (a late card on their next Home read while
// the account is young: docs/decisions/20261128-owner-personal-onboarding.md), and the tools row with nothing left to
// connect.
import { afterEach, expect, test } from 'bun:test'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'
import { DISMISS_HOLD_MS, endHeldDismissal, recordShared, updateWelcome, WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { getSetting, setSetting } from '../../server/src/admin/settings'

let h: Harness
afterEach(async () => { await h?.close() })

const DAY = 86_400_000
const ownerId = () => (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as { id: string }).id
const row = (id: string) => h.ctx.db.query('SELECT setup, joined_at, hidden_at FROM member_welcome WHERE user_id = ?').get(id) as { setup: number; joined_at: string; hidden_at: string | null } | null
const welcome = async (c: Client) => (await c.call('GET', '/api/me/welcome')).welcome
/** the stored steps' row, changed by hand (an end that happened before this release) */
const setRow = (patch: Record<string, unknown>) => setSetting(h.ctx.db, WELCOME_SETTING, { ...(getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING) ?? {}), ...patch })

test('the end screen through shared skills (recordShared) starts the card', async () => {
  h = await harness('b-my-setup-start-1')
  const owner = await withOwner(h)
  const id = ownerId()
  // every other step answered; the shared skills are the last one
  updateWelcome(h.ctx, id, { step: { id: 'profile', state: 'done' } })
  for (const s of ['files', 'tools', 'invite'] as const) updateWelcome(h.ctx, id, { step: { id: s, state: 'skipped' } })
  expect(row(id)).toBeNull()
  expect(recordShared(h.ctx, id, [{ path: 'skills/weekly/SKILL.md', title: 'Weekly', recommended: true }])).toBe(true)
  expect(row(id)).toMatchObject({ setup: 1, hidden_at: null })
  expect(await welcome(owner)).toMatchObject({ kind: 'owner' })
})

test('✕ on the steps, once it held (endHeldDismissal), starts the card, its days from the ✕; an undone ✕ does not', async () => {
  h = await harness('b-my-setup-start-2')
  const owner = await withOwner(h)
  const id = ownerId()
  updateWelcome(h.ctx, id, {})
  updateWelcome(h.ctx, id, { dismissed: true })
  const at = (getSetting<{ dismissedAt: string }>(h.ctx.db, WELCOME_SETTING))!.dismissedAt
  // inside the hold (the undo toast): nothing
  expect(endHeldDismissal(h.ctx, id, Date.parse(at) + 1000)).toBe(false)
  expect(row(id)).toBeNull()
  expect(endHeldDismissal(h.ctx, id, Date.parse(at) + DISMISS_HOLD_MS + 1)).toBe(true)
  expect(row(id)).toMatchObject({ setup: 1, joined_at: at })
  expect(await welcome(owner)).toMatchObject({ kind: 'owner' })
})

test('a lead here longer than 30 days who was handed the team and then ends the setup: their hidden member row becomes the owner\'s card at the end', async () => {
  h = await harness('b-my-setup-start-3')
  const owner = await withOwner(h)
  const inv = await owner.call('POST', '/api/admin/invites', {})
  const c = h.client({ ip: '10.9.0.1' })
  const leah = (await c.call('POST', `/api/invites/${inv.token}/accept`, { username: 'leah', name: 'Leah Lead', password: 'tulip meadow 2026' })).me.user.id
  await c.call('GET', '/api/me')
  // not new here: no late card at the handover (ensureOwnCard), the member row stays hidden
  h.ctx.db.query("UPDATE users SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(leah)
  await owner.call('POST', '/api/admin/transfer-ownership', { userId: leah, password: OWNER_PW })
  expect(row(leah)).toMatchObject({ setup: 0 })
  expect(row(leah)!.hidden_at).not.toBeNull()
  expect(await welcome(c)).toBeNull()
  // the new owner ends the steps (the steps' row is the team's: the old owner never finished it)
  await c.call('PATCH', '/api/onboarding/welcome', { finish: true })
  expect(row(leah)).toMatchObject({ setup: 1, hidden_at: null })
  expect(await welcome(c)).toMatchObject({ kind: 'owner', inviter: null })
})

test('an owner whose setup ended before the card existed: a young account gets the late card on the next read, its days from that read; an old one none', async () => {
  h = await harness('b-my-setup-start-4')
  const owner = await withOwner(h)
  const id = ownerId()
  updateWelcome(h.ctx, id, {})
  // ended 20 days ago, before this release, on an account made 40 days ago: none (backfillOwner's 14 days are gone; the
  // 30-day window of the late card holds)
  setRow({ finishedAt: new Date(Date.now() - 20 * DAY).toISOString() })
  h.ctx.db.query('UPDATE users SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 40 * DAY).toISOString(), id)
  expect(await welcome(owner)).toBeNull()
  expect(row(id)).toBeNull()
  // the same end on an account made 25 days ago: the card, fresh from this read
  h.ctx.db.query('UPDATE users SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 25 * DAY).toISOString(), id)
  const w = await welcome(owner)
  expect(w).toMatchObject({ kind: 'owner' })
  expect(w.setupOpen).toBeUndefined()
  expect(Date.now() - Date.parse(row(id)!.joined_at)).toBeLessThan(60_000)
  // hidden: stays hidden (nothing is made again)
  await owner.call('PATCH', '/api/me/welcome', { hide: true })
  expect(await welcome(owner)).toBeNull()
  expect(row(id)!.hidden_at).not.toBeNull()
  // closed with ✕ 5 days ago (no end screen, and its hold timer lost to a restart), on another team: the late card
  await h.close()
  h = await harness('b-my-setup-start-5')
  const o2 = await withOwner(h)
  const id2 = ownerId()
  updateWelcome(h.ctx, id2, {})
  setRow({ dismissedAt: new Date(Date.now() - 5 * DAY).toISOString() })
  expect(await welcome(o2)).toMatchObject({ kind: 'owner' })
  expect(row(id2)).toMatchObject({ setup: 1 })
  // a member never gets an owner's card that way (their own, added directly, stays a member's)
  const m = await addMember(h, o2, { username: 'mo' })
  expect((await welcome(m.client)).kind).toBe('member')
})

test('the tools row: every tool it offers is the team\'s for everyone, nothing left to connect: done', async () => {
  h = await harness('b-my-setup-start-6')
  const owner = await withOwner(h)
  await owner.call('PATCH', '/api/onboarding/welcome', { finish: true })
  expect(await welcome(owner)).toMatchObject({ steps: { tools: false }, allSet: false })
  // tools done; the owner's "ask" counts too
  expect((await owner.call('PATCH', '/api/me/welcome', { tools: true })).welcome).toMatchObject({ steps: { tools: true }, allSet: false })
  expect((await owner.call('PATCH', '/api/me/welcome', { asked: true })).welcome).toMatchObject({ steps: { tools: true, asked: true }, allSet: true })
})
