// The late personal card for new owners and admins (docs/decisions/20261128-owner-personal-onboarding.md;
// server/src/onboarding/member-welcome.ts ensureOwnCard): who gets one (an account at most 30 days old that never had a
// connection of its own, in any state), what it is (the owner card, or a member card for an admin), when its days
// start (the first read, on any device) and restart (the team setup's end), `setupOpen` (the owner only), a handover,
// and who never gets one (a guest, a demo, a team that lets nobody connect their own).
import { afterEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'
import { ensureOwnCard, LATE_CARD_DAYS } from '../../server/src/onboarding/member-welcome'
import { audit } from '../../server/src/admin/audit'
import type { DemoFile } from '../../shared/src/api'

let h: Harness
afterEach(async () => { await h?.close() })

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const ownerId = () => (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as { id: string }).id
type WRow = { setup: number; joined_at: string; hidden_at: string | null; apps_seen_at: string | null; invited_by: string | null; done_at: string | null }
const row = (id: string) => h.ctx.db.query('SELECT setup, joined_at, hidden_at, apps_seen_at, invited_by, done_at FROM member_welcome WHERE user_id = ?').get(id) as WRow | null
const rows = (id: string) => (h.ctx.db.query('SELECT COUNT(*) n FROM member_welcome WHERE user_id = ?').get(id) as { n: number }).n
const welcome = async (c: Client) => (await c.call('GET', '/api/me/welcome')).welcome
const made = (id: string, at: string) => h.ctx.db.query('UPDATE users SET created_at = ? WHERE id = ?').run(at, id)
const connectDrive = (userId: string) => {
  const at = new Date().toISOString()
  h.ctx.db.query(`INSERT INTO drive_connections (id, user_id, config_key, account, scopes, secret_enc, key_version, status, expires_at, created_at, updated_at)
    VALUES (?, ?, 'k', '{}', '[]', 'x', 1, 'connected', ?, ?, ?)`).run(crypto.randomUUID(), userId, at, at, at)
}
/** an admin added directly, their member row gone: an admin "made later" (no join card) */
const adminWithoutRow = async (owner: Client, username: string) => {
  const a = await addMember(h, owner, { username, role: 'admin' })
  h.ctx.db.query('DELETE FROM member_welcome WHERE user_id = ?').run(a.id)
  return a
}

test('a young owner with no connection: the owner card on the first read, the setup open, its days from that read, no held notices', async () => {
  h = await harness('b-owner-late-1')
  const owner = await withOwner(h)
  const id = ownerId()
  expect(row(id)).toBeNull()
  const w = await welcome(owner)
  expect(w).toMatchObject({ kind: 'owner', inviter: null, setupOpen: true, allSet: false, steps: { tools: false, asked: false } })
  const r = row(id)!
  expect(r).toMatchObject({ setup: 1, hidden_at: null, invited_by: null })
  expect(Date.now() - Date.parse(r.joined_at)).toBeLessThan(60_000)
  // a late card holds no connection template notices
  expect(r.apps_seen_at).toBe(r.joined_at)
})

test('an account older than 30 days gets none; nor one that connected a tool and ended it since, nor one with a broken connection', async () => {
  h = await harness('b-owner-late-2')
  const owner = await withOwner(h)
  const id = ownerId()
  made(id, ago(LATE_CARD_DAYS + 1))
  expect(await welcome(owner)).toBeNull()
  expect(row(id)).toBeNull()
  // 29 days: in the window
  made(id, ago(LATE_CARD_DAYS - 1))
  const admin = await adminWithoutRow(owner, 'ada')
  // connected Google Drive and ended it: the row is gone, the audit keeps it (a disconnect deletes the row)
  audit(h.ctx.db, { actor: admin.id, action: 'drive.connected', target: crypto.randomUUID() })
  expect(await welcome(admin.client)).toBeNull()
  expect(row(admin.id)).toBeNull()
  // a personal connection made and deleted since (integration.create, scope personal)
  const b = await adminWithoutRow(owner, 'bea')
  audit(h.ctx.db, { actor: b.id, action: 'integration.create', target: crypto.randomUUID(), detail: { scope: 'personal', kind: 'mcp', auth: 'oauth' } })
  expect(await welcome(b.client)).toBeNull()
  // a team connection this admin made is not one of their own: the card
  const c = await adminWithoutRow(owner, 'cy')
  audit(h.ctx.db, { actor: c.id, action: 'integration.create', target: crypto.randomUUID(), detail: { scope: 'team', kind: 'mcp', auth: 'oauth' } })
  expect(await welcome(c.client)).toMatchObject({ kind: 'member' })
  // a connection of theirs that is there but not working (needs a reconnect): none
  const d = await adminWithoutRow(owner, 'dee')
  connectDrive(d.id)
  h.ctx.db.query("UPDATE drive_connections SET status = 'needs_reconnect' WHERE user_id = ?").run(d.id)
  expect(await welcome(d.client)).toBeNull()
  // the owner, young again and with nothing of their own: the card
  expect(await welcome(owner)).toMatchObject({ kind: 'owner' })
})

test('an admin made later: a member card (tools, hi, asked; no inviter); a live member card stays as it is', async () => {
  h = await harness('b-owner-late-3')
  const owner = await withOwner(h)
  const a = await adminWithoutRow(owner, 'amir')
  const w = await welcome(a.client)
  expect(w).toMatchObject({ kind: 'member', inviter: null, allSet: false, steps: { hi: false, asked: false, tools: false } })
  expect(w.setupOpen).toBeUndefined()
  expect(row(a.id)).toMatchObject({ setup: 0 })
  expect(row(a.id)!.apps_seen_at).not.toBeNull()
  // invited as an admin: the join's card (with its held notices), untouched
  const b = await addMember(h, owner, { username: 'bo', role: 'admin' })
  const before = row(b.id)!
  expect(before.apps_seen_at).toBeNull()
  expect(await welcome(b.client)).toMatchObject({ kind: 'member' })
  expect(row(b.id)).toEqual(before)
})

test('several devices at the first read make one row; a hidden, finished or outlived card is never made again', async () => {
  h = await harness('b-owner-late-4')
  const owner = await withOwner(h, 'olga')
  const id = ownerId()
  const phone = h.client({ ip: '10.8.0.2' })
  await phone.login('olga', OWNER_PW)
  const [a, b] = await Promise.all([welcome(owner), welcome(phone)])
  expect(a).toMatchObject({ kind: 'owner' })
  expect(b).toMatchObject({ kind: 'owner' })
  expect(rows(id)).toBe(1)
  const first = row(id)!.joined_at
  await welcome(phone)
  expect(row(id)!.joined_at).toBe(first)
  // hidden: stays hidden on every device, and the next read makes nothing
  await phone.call('PATCH', '/api/me/welcome', { hide: true })
  expect(await welcome(owner)).toBeNull()
  expect(row(id)!.hidden_at).not.toBeNull()
  // outlived (its 14 days over): never again
  const old = ago(20)
  h.ctx.db.query('UPDATE member_welcome SET hidden_at = NULL, joined_at = ? WHERE user_id = ?').run(old, id)
  expect(await welcome(owner)).toBeNull()
  expect(row(id)!.joined_at).toBe(old)
})

test('a setup that ends late restarts the open card\'s days; a done or hidden card is not restarted', async () => {
  h = await harness('b-owner-late-5')
  const owner = await withOwner(h)
  const id = ownerId()
  await owner.call('PATCH', '/api/onboarding/welcome', {})
  expect(await welcome(owner)).toMatchObject({ setupOpen: true })
  // the late card 20 days ago (its 14 over): the setup ends now, and the card is back for 14 days from the end
  h.ctx.db.query('UPDATE member_welcome SET joined_at = ? WHERE user_id = ?').run(ago(20), id)
  expect(await welcome(owner)).toBeNull()
  await owner.call('PATCH', '/api/me/welcome', { asked: true })
  await owner.call('PATCH', '/api/onboarding/welcome', { finish: true })
  expect(Date.now() - Date.parse(row(id)!.joined_at)).toBeLessThan(60_000)
  // its rows kept (asked), not a fresh card
  expect(await welcome(owner)).toMatchObject({ kind: 'owner', steps: { asked: true } })
  // a hidden card: the end leaves it hidden, its days as they were
  await h.close()
  h = await harness('b-owner-late-6')
  const o2 = await withOwner(h)
  const id2 = ownerId()
  await welcome(o2)
  await o2.call('PATCH', '/api/me/welcome', { hide: true })
  h.ctx.db.query('UPDATE member_welcome SET joined_at = ? WHERE user_id = ?').run(ago(3), id2)
  const hidden = row(id2)!
  await o2.call('PATCH', '/api/onboarding/welcome', { finish: true })
  expect(row(id2)).toEqual(hidden)
  expect(await welcome(o2)).toBeNull()
  // a done card: the end leaves it done
  h.ctx.db.query("UPDATE member_welcome SET hidden_at = NULL, done_at = ? WHERE user_id = ?").run(ago(1), id2)
  const done = row(id2)!
  ensureOwnCard(h.ctx, id2)
  const { startMySetup } = await import('../../server/src/onboarding/my-setup')
  startMySetup(h.ctx, id2)
  expect(row(id2)).toEqual(done)
})

test('setupOpen is the owner\'s only: an ex-owner, now an admin, finishes their owner card while the new owner\'s setup is open', async () => {
  h = await harness('b-owner-late-7')
  const owner = await withOwner(h)
  const oldId = ownerId()
  await owner.call('PATCH', '/api/onboarding/welcome', {})
  expect(await welcome(owner)).toMatchObject({ kind: 'owner', setupOpen: true })
  await owner.call('PATCH', '/api/me/welcome', { asked: true })
  connectDrive(oldId)
  expect(await welcome(owner)).toMatchObject({ setupOpen: true, allSet: false })
  const next = await addMember(h, owner, { username: 'nia' })
  await owner.call('POST', '/api/admin/transfer-ownership', { userId: next.id, password: OWNER_PW })
  // the ex-owner keeps the owner card, no longer held by the team setup they cannot open
  const w = await welcome(owner)
  expect(w).toMatchObject({ kind: 'owner', allSet: true })
  expect(w.setupOpen).toBeUndefined()
  // the new owner: young, no connection, their member row hidden at the handover became a fresh owner card
  expect(row(next.id)).toMatchObject({ setup: 1, hidden_at: null, invited_by: null })
  expect(await welcome(next.client)).toMatchObject({ kind: 'owner', setupOpen: true })
})

test('a handover to someone not new, or who had a connection of their own: their card stays hidden', async () => {
  h = await harness('b-owner-late-8')
  const owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'abe' })
  const b = await addMember(h, owner, { username: 'bel', ip: '10.0.0.8' })
  made(a.id, ago(LATE_CARD_DAYS + 5))
  await owner.call('POST', '/api/admin/transfer-ownership', { userId: a.id, password: OWNER_PW })
  expect(row(a.id)).toMatchObject({ setup: 0 })
  expect(row(a.id)!.hidden_at).not.toBeNull()
  expect(await welcome(a.client)).toBeNull()
  // young, but connected Google Drive once and ended it since
  audit(h.ctx.db, { actor: b.id, action: 'drive.connected', target: crypto.randomUUID() })
  await a.client.call('POST', '/api/admin/transfer-ownership', { userId: b.id, password: a.password })
  expect(row(b.id)).toMatchObject({ setup: 0 })
  expect(row(b.id)!.hidden_at).not.toBeNull()
  expect(await welcome(b.client)).toBeNull()
})

test('never: a guest, a demo server, a team that lets nobody connect their own', async () => {
  h = await harness('b-owner-late-9')
  const owner = await withOwner(h)
  const id = ownerId()
  // a team that lets nobody connect their own: nothing personal to set up
  await owner.call('PATCH', '/api/admin/settings', { personalIntegrations: false })
  expect(await welcome(owner)).toBeNull()
  expect(row(id)).toBeNull()
  await owner.call('PATCH', '/api/admin/settings', { personalIntegrations: true })
  // a demo server (the demo company's people, a free-roam instance): the demo's own screen keeps Home
  const config = h.ctx.config as { demo?: DemoFile }
  config.demo = { company: 'Steepling', password: 'demo pass 2026', personas: [] } as unknown as DemoFile
  try { ensureOwnCard(h.ctx, id) } finally { delete config.demo }
  expect(row(id)).toBeNull()
  // a guest (even one marked admin by hand): none
  const g = await addMember(h, owner, { username: 'gus', role: 'admin' })
  h.ctx.db.query('DELETE FROM member_welcome WHERE user_id = ?').run(g.id)
  h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(g.id)
  ensureOwnCard(h.ctx, g.id)
  expect(row(g.id)).toBeNull()
  // a member made by "Add directly" without a row: members get theirs at the join only
  const m = await addMember(h, owner, { username: 'max' })
  h.ctx.db.query('DELETE FROM member_welcome WHERE user_id = ?').run(m.id)
  expect(await welcome(m.client)).toBeNull()
  expect(row(m.id)).toBeNull()
})
