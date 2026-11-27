// A guest can't take an e-mail another account here gives (docs/DECISIONS.md "A guest can't take an e-mail used in the
// team", the owner 2026-11-16): Settings › Profile (PATCH /api/me) refuses it with one plain line, compared as the
// Slack e-mail proof compares (NFC, trimmed, lower case), so a copied address can no longer block that member's Slack
// link. Members may still share an address, as before. A real guest (invite and accept).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { msg } from '../../server/src/auth/messages'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
let owner: Client
let mia: { client: Client; id: string }
let nora: { client: Client; id: string }
let gus: { client: Client; id: string }
const emailOf = (id: string) => (h.ctx.db.query('SELECT email FROM users WHERE id = ?').get(id) as { email: string | null }).email

beforeAll(async () => {
  h = await harness('a-guests-email')
  owner = await withOwner(h)
  mia = await addMember(h, owner, { username: 'mia' })
  nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(owner, [mia.id, nora.id])
  gus = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  await mia.client.call('PATCH', '/api/me', { email: 'mia@acme.example' })
})
afterAll(async () => { await h?.close() })

test('a guest who gives a member\'s e-mail (in another case) is refused with one plain line; nothing is saved', async () => {
  expect(msg('emailInUse', 'en')).toBe('This e-mail is already used in this team.')
  for (const email of ['mia@acme.example', 'MIA@Acme.Example']) {
    const r = await gus.client.try('PATCH', '/api/me', { email }, { 'accept-language': 'en' })
    expect(r.status).toBe(409)
    expect(r.body.error.params.reason).toBe('email_in_use')
    expect((['ko', 'en', 'id', 'ja', 'es', 'zh'] as const).map((l) => msg('emailInUse', l))).toContain(r.body.error.message)
    expect(emailOf(gus.id)).toBeNull()
  }
  // the message names nobody
  const r = await gus.client.try('PATCH', '/api/me', { email: 'mia@acme.example' })
  expect(JSON.stringify(r.body)).not.toContain('mia')
})

test('the owner\'s e-mail and a switched-off account\'s are taken too', async () => {
  await owner.call('PATCH', '/api/me', { email: 'olga@acme.example' })
  expect((await gus.client.try('PATCH', '/api/me', { email: 'olga@acme.example' })).status).toBe(409)
  h.ctx.db.query("UPDATE users SET email = 'gone@acme.example', status = 'disabled' WHERE id = ?").run(nora.id)
  expect((await gus.client.try('PATCH', '/api/me', { email: 'gone@acme.example' })).status).toBe(409)
})

test('a guest may set an address nobody here gives, clear it, and save their own again', async () => {
  expect((await gus.client.try('PATCH', '/api/me', { email: 'gus@client.example' })).status).toBe(200)
  expect(emailOf(gus.id)).toBe('gus@client.example')
  expect((await gus.client.try('PATCH', '/api/me', { email: 'GUS@client.example' })).status).toBe(200)
  expect((await gus.client.try('PATCH', '/api/me', { email: null })).status).toBe(200)
  expect(emailOf(gus.id)).toBeNull()
})

test('at most 10 addresses an hour from a guest, whatever the answer; clearing is never held back', async () => {
  let last = 0
  for (let i = 0; i < 12 && last !== 429; i++) last = (await gus.client.try('PATCH', '/api/me', { email: `try${i}@client.example` })).status
  expect(last).toBe(429)
  const r = await gus.client.try('PATCH', '/api/me', { email: 'mia@acme.example' })
  expect(r.status).toBe(429)
  expect(r.body.error.params.reason).toBe('email_tries')
  expect((await gus.client.try('PATCH', '/api/me', { email: null })).status).toBe(200)
  // a member is never counted
  for (let i = 0; i < 12; i++) expect((await mia.client.try('PATCH', '/api/me', { email: 'mia@acme.example' })).status).toBe(200)
})

// since 2026-11-27 (sign in by e-mail, tests/unit/a-login-email.test.ts) members may not share one either
test('members may no longer take an address another account has', async () => {
  const r = await owner.try('PATCH', '/api/me', { email: 'mia@acme.example' })
  expect(r.status).toBe(409)
  expect(r.body.error.params?.reason).toBe('email_in_use')
  expect(emailOf(mia.id)).toBe('mia@acme.example')
})
