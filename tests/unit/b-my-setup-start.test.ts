// When the owner's own My setup card starts (docs/decisions/20261120-my-setup-card.md; server/src/onboarding/my-setup.ts):
// every way the team setup ends (the end screen through the shared-skills path, ✕ on the steps once it held), a lead
// who was handed the team, owners whose setup ended before the card existed (on their next Home read, within 14 days of
// that end), and the tools row with nothing left to connect.
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

test('a lead who was handed the team and then ends the setup: their hidden member row becomes the owner\'s card', async () => {
  h = await harness('b-my-setup-start-3')
  const owner = await withOwner(h)
  const inv = await owner.call('POST', '/api/admin/invites', {})
  const c = h.client({ ip: '10.9.0.1' })
  const leah = (await c.call('POST', `/api/invites/${inv.token}/accept`, { username: 'leah', name: 'Leah Lead', password: 'tulip meadow 2026' })).me.user.id
  await c.call('GET', '/api/me')
  await owner.call('POST', '/api/admin/transfer-ownership', { userId: leah, password: OWNER_PW })
  expect(row(leah)).toMatchObject({ setup: 0 })
  expect(row(leah)!.hidden_at).not.toBeNull()
  expect(await welcome(c)).toBeNull()
  // the new owner ends the steps (the steps' row is the team's: the old owner never finished it)
  await c.call('PATCH', '/api/onboarding/welcome', { finish: true })
  expect(row(leah)).toMatchObject({ setup: 1, hidden_at: null })
  expect(await welcome(c)).toMatchObject({ kind: 'owner', inviter: null })
})

test('backfill: an owner whose setup ended (or was closed) within 14 days and has no card gets one on the next Home read, its days from that end; older ones none', async () => {
  h = await harness('b-my-setup-start-4')
  const owner = await withOwner(h)
  const id = ownerId()
  updateWelcome(h.ctx, id, {})
  // ended 20 days ago, before this release: none
  setRow({ finishedAt: new Date(Date.now() - 20 * DAY).toISOString() })
  expect(await welcome(owner)).toBeNull()
  expect(row(id)).toBeNull()
  // ended 3 days ago: the card, 3 days into its 14
  const ended = new Date(Date.now() - 3 * DAY).toISOString()
  setRow({ finishedAt: ended })
  expect(await welcome(owner)).toMatchObject({ kind: 'owner' })
  expect(row(id)).toMatchObject({ setup: 1, joined_at: ended })
  // hidden: stays hidden (nothing is made again)
  await owner.call('PATCH', '/api/me/welcome', { hide: true })
  expect(await welcome(owner)).toBeNull()
  // closed with ✕ 5 days ago (no end screen), on another team: the card from the ✕
  await h.close()
  h = await harness('b-my-setup-start-5')
  const o2 = await withOwner(h)
  const id2 = ownerId()
  updateWelcome(h.ctx, id2, {})
  const closed = new Date(Date.now() - 5 * DAY).toISOString()
  setRow({ dismissedAt: closed })
  expect(await welcome(o2)).toMatchObject({ kind: 'owner' })
  expect(row(id2)).toMatchObject({ joined_at: closed })
  // a member never gets an owner's card that way (their own, added directly, stays a member's)
  const m = await addMember(h, o2, { username: 'mo' })
  expect((await welcome(m.client)).kind).toBe('member')
})

test('the tools row: every tool it offers is the team\'s for everyone, nothing left to connect: done', async () => {
  h = await harness('b-my-setup-start-6')
  const owner = await withOwner(h)
  await owner.call('PATCH', '/api/onboarding/welcome', { finish: true })
  expect(await welcome(owner)).toMatchObject({ steps: { tools: false }, allSet: false })
  expect((await owner.call('PATCH', '/api/me/welcome', { tools: true })).welcome).toMatchObject({ steps: { tools: true }, allSet: true })
})
