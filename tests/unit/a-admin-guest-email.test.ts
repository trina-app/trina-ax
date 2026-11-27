// An owner or admin setting a guest's e-mail in Admin › Members (PATCH /api/admin/users/:id) follows the rule of
// Settings › Profile (docs/decisions/20261116-admin-guest-email-unique.md): not an address another account here gives,
// compared as the Slack e-mail proof compares (NFC, trimmed, lower case); one plain line, nothing saved. Members may
// still share an address, as before. A real guest (invite and accept).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { msg } from '../../server/src/auth/messages'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
let owner: Client
let ada: { client: Client; id: string }
let mia: { client: Client; id: string }
let nora: { client: Client; id: string }
let gus: { client: Client; id: string }
const row = (id: string) => h.ctx.db.query('SELECT name, email FROM users WHERE id = ?').get(id) as { name: string; email: string | null }

beforeAll(async () => {
  h = await harness('a-admin-guest-email')
  owner = await withOwner(h)
  ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  mia = await addMember(h, owner, { username: 'mia' })
  nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(owner, [mia.id, nora.id])
  gus = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  await mia.client.call('PATCH', '/api/me', { email: 'mia@acme.example' })
})
afterAll(async () => { await h?.close() })

test('an admin who sets a guest\'s e-mail to a member\'s is refused with the Profile line; nothing in the change is saved', async () => {
  for (const by of [owner, ada.client]) {
    const r = await by.try('PATCH', `/api/admin/users/${gus.id}`, { name: 'Gus Renamed', email: 'mia@acme.example' })
    expect(r.status).toBe(409)
    expect(r.body.error.params.reason).toBe('email_in_use')
    // the caller's language (the team's here): the same line Settings › Profile gives, naming nobody
    expect((['ko', 'en', 'id', 'ja', 'es', 'zh'] as const).map((l) => msg('emailInUse', l))).toContain(r.body.error.message)
    expect(JSON.stringify(r.body)).not.toContain('mia')
    expect(row(gus.id)).toEqual({ name: 'GUS', email: null })
  }
})

test('a duplicate in another case is refused too', async () => {
  for (const email of ['MIA@Acme.Example', 'Mia@ACME.example']) {
    const r = await owner.try('PATCH', `/api/admin/users/${gus.id}`, { email })
    expect(r.status).toBe(409)
    expect(r.body.error.params.reason).toBe('email_in_use')
    expect(row(gus.id).email).toBeNull()
  }
})

test('an admin may set a guest\'s e-mail to an address nobody here gives, change its case, and clear it', async () => {
  expect((await ada.client.try('PATCH', `/api/admin/users/${gus.id}`, { email: 'gus@client.example' })).status).toBe(200)
  expect(row(gus.id).email).toBe('gus@client.example')
  // their own address in another case is not "another account's"
  expect((await owner.try('PATCH', `/api/admin/users/${gus.id}`, { email: 'GUS@client.example' })).status).toBe(200)
  expect((await owner.try('PATCH', `/api/admin/users/${gus.id}`, { email: null })).status).toBe(200)
  expect(row(gus.id).email).toBeNull()
  // an admin's changes are not counted against the guest's own 10 an hour
  for (let i = 0; i < 12; i++) expect((await owner.try('PATCH', `/api/admin/users/${gus.id}`, { email: `try${i}@client.example` })).status).toBe(200)
  expect((await gus.client.try('PATCH', '/api/me', { email: 'gus@client.example' })).status).toBe(200)
})

// since 2026-11-27 (sign in by e-mail, tests/unit/a-login-email.test.ts) members may not share one either: one e-mail
// signs in one account; the account keeps its own address
test('members may no longer be given an address another account has; their own stays', async () => {
  const r = await owner.try('PATCH', `/api/admin/users/${nora.id}`, { email: 'MIA@acme.example' })
  expect(r.status).toBe(409)
  expect(r.body.error.params?.reason).toBe('email_in_use')
  expect(row(nora.id).email).not.toBe('MIA@acme.example')
  expect((await ada.client.try('PATCH', `/api/admin/users/${mia.id}`, { email: 'mia@acme.example' })).status).toBe(200)
})

test('a guest made a member is a member: the one-account-per-e-mail rule is the same for them', async () => {
  // there is no way to make a member a guest (role takes no "guest"); the only conversion is guest -> member
  expect((await owner.try('PATCH', `/api/admin/users/${mia.id}`, { role: 'guest' })).status).toBe(400)
  expect((await owner.try('POST', `/api/admin/users/${gus.id}/convert-guest`)).status).toBe(200)
  expect((await owner.try('PATCH', `/api/admin/users/${gus.id}`, { email: 'mia@acme.example' })).status).toBe(409)
  expect(row(gus.id).email).not.toBe('mia@acme.example')
})
