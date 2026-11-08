// Admin > AI connections over HTTP (docs/DECISIONS.md "AI 연결" 3.8/3.9): adding a Claude subscription token or an
// API key sealed in the browser (web/src/lib/seal.ts) and checked without spending tokens against fake providers
// (200 = verified, 401 = refused and not saved, anything else = saved "checked on the first question"), the plan
// notice (D23), the same token twice (409), the password again, the owner's and the admins' changes (an admin's is told
// to the owner, the owner's is not), members' own connections, the
// server's allowed kinds (D22). S-8 (no secret in any response, audit entry or log line), S-10 (sealing: no plain
// secret field, purpose, replay, key id), S-13 (redirects of the provider check are not followed).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { API, CREDENTIAL_KINDS, CUSTOM_ADDRESS_KINDS, type SealingKey } from '@mycel/shared/api'
import { PRODUCT } from '../../shared/src/product'
import { createLogger } from '../../server/src/log'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import { readApiEngine, writeApiEngine, apiEngineKeyPath } from '../../server/src/engine/api-agent'
import { apiEngineFetch } from '../../server/src/system/egress'
import { createCredential, replaceSecret } from '../../server/src/credentials/service'
import { credentialsOf, markInvalid, markNeedsReconnect, noticeOwners } from '../../server/src/credentials/store'
import { sealSecret } from '../../web/src/lib/seal'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'

// ---------------- fake providers ----------------
const hits: { path: string; headers: Record<string, string> }[] = []
let answer: Record<string, number> = {}
let delayMs = 0
const stolen: string[] = []
const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { stolen.push(new URL(req.url).pathname); return new Response('ok') } })
const fake = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const u = new URL(req.url)
    hits.push({ path: u.pathname, headers: Object.fromEntries(req.headers) })
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const status = answer[u.pathname] ?? 200
    if (status === 307) return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/steal` } })
    return Response.json({ ok: status < 300 }, { status })
  },
})
const up = `http://127.0.0.1:${fake.port}`

const CLAUDE = (s: string) => 'sk-ant-oat01-' + s.padEnd(40, 'z')
const AKEY = (s: string) => 'sk-ant-api03-' + s.padEnd(40, 'k')
const OKEY = (s: string) => 'sk-proj-' + s.padEnd(40, 'o')
const CANARIES: string[] = []
const lines: string[] = []

let h: Harness
let owner: Client
let admin: Client
let adminId = ''
let adminPw = ''
let member: { client: Client; id: string }
let key: SealingKey
beforeAll(async () => {
  h = await harness('cred-api', { engine: { authMode: 'managed', modelUpstreams: { anthropic: up, openai: up + '/v1' } } },
    { log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) })
  owner = await withOwner(h)
  const adam = await addMember(h, owner, { username: 'adam', role: 'admin' })
  admin = adam.client; adminId = adam.id; adminPw = adam.password
  member = await addMember(h, owner, { username: 'mia', role: 'member' })
  key = await owner.call('GET', '/api/credentials/sealing-key')
})
afterAll(async () => { await h?.close(); fake.stop(true); other.stop(true) })

const sealed = async (secret: string, purpose: 'credential.create' | 'credential.replace' = 'credential.create') => { CANARIES.push(secret); return sealSecret(key, secret, purpose) }
const create = async (c: Client, kind: string, secret: string, extra: Record<string, unknown> = {}) =>
  c.try('POST', '/api/admin/credentials', { kind, label: 'L-' + kind, sealed: await sealed(secret), ...(kind === 'anthropic-oauth' ? { acknowledgedPlanNotice: true } : {}), ...extra })

describe('sealing key and sealed secrets (S-10)', () => {
  test('the public key only (no private part), a 16-hex key id', async () => {
    expect(key.alg).toBe('ECDH-ES+P256+HKDF-SHA256+A256GCM')
    expect(key.kid).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(key)).not.toContain('"d"')
    expect(await member.client.call('GET', '/api/credentials/sealing-key')).toEqual(key)
  })
  test('a plain secret field is not part of the contract (400), even with a sealed one missing', async () => {
    const r = await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'x', secret: AKEY('plain') })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).not.toContain(AKEY('plain'))
  })
  test('sealed for another purpose, used twice, or with another key id: refused, never saved', async () => {
    const before = (await owner.call('GET', '/api/admin/credentials')).items.length
    const replace = await sealed(AKEY('purpose'), 'credential.replace')
    expect((await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'x', sealed: replace })).status).toBe(400)
    const once = await sealed(AKEY('once'))
    expect((await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'once', sealed: once })).status).toBe(201)
    const again = await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'once2', sealed: once })
    expect(again.status).toBe(400); expect(again.body.error.fields['body.sealed']).toBe('already used')
    const wrongKid = { ...(await sealed(AKEY('kid'))), kid: '0000000000000000' }
    expect((await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'x', sealed: wrongKid })).status).toBe(400)
    const broken = { ...(await sealed(AKEY('broken'))), ct: 'A'.repeat(40) }
    expect((await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'x', sealed: broken })).status).toBe(400)
    expect((await owner.call('GET', '/api/admin/credentials')).items.length).toBe(before + 1)
  })
})

describe('adding connections (checked without spending tokens)', () => {
  test('shared subscriptions need an explicit owner choice and acknowledged risk', async () => {
    const initial = await owner.call('GET', '/api/admin/credentials')
    expect(initial).toMatchObject({ memberOwn: true, sharedSubscriptions: PRODUCT.sharedSubscriptionsDefault })
    // an owner who switched sharing off: from here the explicit choice rules, whatever the edition default
    expect(await owner.call('PATCH', '/api/admin/credential-settings', { sharedSubscriptions: false })).toEqual({ memberOwn: true, sharedSubscriptions: false })
    hits.length = 0
    expect((await create(owner, 'anthropic-oauth', CLAUDE('sharing-off'))).status).toBe(403)
    expect(hits).toEqual([])
    // an admin has the owner's say here, and the same rule: the risk must be acknowledged
    expect((await admin.try('PATCH', '/api/admin/credential-settings', { sharedSubscriptions: true })).status).toBe(400)
    expect((await member.client.try('PATCH', '/api/admin/credential-settings', { sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true })).status).toBe(403)
    expect((await owner.try('PATCH', '/api/admin/credential-settings', { memberOwn: false, sharedSubscriptions: true })).status).toBe(400)
    expect(await owner.call('GET', '/api/admin/credentials')).toMatchObject({ memberOwn: true, sharedSubscriptions: false })
    expect(await owner.call('PATCH', '/api/admin/credential-settings', { sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true })).toEqual({ memberOwn: true, sharedSubscriptions: true })
  })
  test('a Claude subscription token: count_tokens with the OAuth headers, 200 = verified; one year; the plan notice is required', async () => {
    hits.length = 0; answer = {}
    const noAck = await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-oauth', label: 'Max', sealed: await sealed(CLAUDE('noack')) })
    expect(noAck.status).toBe(400); expect(noAck.body.error.fields['body.acknowledgedPlanNotice']).toBeDefined()
    expect(hits).toEqual([]) // refused before asking the provider
    const r = await create(owner, 'anthropic-oauth', CLAUDE('max1'))
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ kind: 'anthropic-oauth', scope: 'team', state: 'ok', hint: null, disabled: false })
    expect(Date.parse(r.body.expiresAt) - Date.now()).toBeGreaterThan(364 * 86400_000)
    expect(hits.map((x) => x.path)).toEqual(['/v1/messages/count_tokens'])
    expect(hits[0]!.headers.authorization).toBe('Bearer ' + CLAUDE('max1'))
    expect(hits[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20')
  })
  test('not a token of that kind: 400 without asking the provider; the value never comes back', async () => {
    hits.length = 0
    for (const [kind, secret] of [['anthropic-oauth', 'hello'], ['anthropic-api-key', CLAUDE('wrongkind')], ['openai-api-key', AKEY('wrongkind')]] as const) {
      const r = await create(owner, kind, secret)
      expect(r.status).toBe(400)
      expect(JSON.stringify(r.body)).not.toContain(secret)
    }
    expect(hits).toEqual([])
  })
  test('refused by the provider (401): not saved; another answer (500, a redirect): saved as unverified, the redirect not followed (S-13)', async () => {
    const n = (await owner.call('GET', '/api/admin/credentials')).items.length
    answer = { '/v1/messages/count_tokens': 401 }
    expect((await create(owner, 'anthropic-oauth', CLAUDE('revoked'))).status).toBe(400)
    answer = { '/v1/messages/count_tokens': 500 }
    const u = await create(owner, 'anthropic-oauth', CLAUDE('flaky'))
    expect(u.status).toBe(201); expect(u.body.state).toBe('unverified'); expect(u.body.detail).toBeTruthy()
    stolen.length = 0
    answer = { '/v1/messages/count_tokens': 307 }
    const red = await create(owner, 'anthropic-oauth', CLAUDE('redirected'))
    expect(red.status).toBe(201); expect(red.body.state).toBe('unverified')
    expect(stolen).toEqual([])
    answer = {}
    expect((await owner.call('GET', '/api/admin/credentials')).items.length).toBe(n + 2)
  })
  test('API keys: GET /models (x-api-key / Bearer), 401 or 403 refused; the hint is the last 4 characters', async () => {
    hits.length = 0
    const a = await create(owner, 'anthropic-api-key', AKEY('team') + 'WXYZ')
    expect(a.status).toBe(201); expect(a.body.hint).toBe('WXYZ')
    expect(hits.at(-1)).toMatchObject({ path: '/v1/models' }); expect(hits.at(-1)!.headers['x-api-key']).toBe(AKEY('team') + 'WXYZ')
    const o = await create(owner, 'openai-api-key', OKEY('team'))
    expect(o.status).toBe(201)
    expect(hits.at(-1)).toMatchObject({ path: '/v1/models' }); expect(hits.at(-1)!.headers.authorization).toBe('Bearer ' + OKEY('team'))
    answer = { '/v1/models': 403 }
    expect((await create(owner, 'openai-api-key', OKEY('forbidden'))).status).toBe(400)
    answer = {}
  })
  test('the same token or key again: 409', async () => {
    expect((await create(owner, 'anthropic-api-key', AKEY('dup'))).status).toBe(201)
    expect((await create(owner, 'anthropic-api-key', AKEY('dup'))).status).toBe(409)
  })
  test('the owner and admins add with no password at all; a member is refused by role', async () => {
    expect((await create(member.client, 'anthropic-api-key', AKEY('bymember'))).status).toBe(403)
    expect((await create(owner, 'anthropic-api-key', AKEY('nopw'), { password: undefined })).status).toBe(201)
    expect((await create(admin, 'anthropic-api-key', AKEY('adminnopw'))).status).toBe(201)
    // a password in the body is not part of the contract any more: ignored, never checked
    expect((await create(admin, 'anthropic-api-key', AKEY('adminanypw'), { password: 'anything at all' })).status).toBe(201)
  })
  test('every kind goes to its provider\'s fixed address, so none asks for a password; a kind with an address the caller sets must be listed and gets one', () => {
    expect([...CREDENTIAL_KINDS].sort()).toEqual(['anthropic-api-key', 'anthropic-oauth', 'chatgpt', 'openai-api-key'])
    expect(CUSTOM_ADDRESS_KINDS).toEqual([])
    // the only place a caller sets where the team's conversations go still asks for the password
    expect(API.putApiEngine.auth).toBe('admin-reauth')
    for (const e of [API.createCredential, API.replaceCredentialSecret, API.startCredentialLogin]) expect(e.auth).toBe('admin')
  })
})

describe('changing, checking, removing', () => {
  let id = ''
  beforeAll(async () => { id = (await create(owner, 'anthropic-oauth', CLAUDE('change'))).body.id })
  test('rename, order, switch off, assign, monthly limit: owner and admins, not members', async () => {
    const groups = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [member.id] })
    const r = await owner.call('PATCH', `/api/admin/credentials/${id}`, { label: 'Design Max', priority: 5, assignments: [{ subjectType: 'group', subjectId: groups.id }], spendLimit: { usd: null, tokens: 1000000, action: 'warn' } })
    expect(r).toMatchObject({ label: 'Design Max', priority: 5, assignments: [{ subjectType: 'group', subjectId: groups.id, name: 'design' }], spendLimit: { usd: null, tokens: 1000000, action: 'warn' } })
    expect((await owner.call('PATCH', `/api/admin/credentials/${id}`, { disabled: true })).state).toBe('disabled')
    expect((await member.client.try('PATCH', `/api/admin/credentials/${id}`, { label: 'x' })).status).toBe(403)
    // a group that does not exist (deleted since the dialog opened, or never there) does not block the save: it is
    // dropped, and with nothing left the connection stays off for nobody, never the whole team's (credentials/assignees.ts)
    expect(await owner.call('PATCH', `/api/admin/credentials/${id}`, { assignments: [{ subjectType: 'group', subjectId: 'nope' }] })).toMatchObject({ disabled: true, assignments: [] })
    expect((await owner.try('PATCH', `/api/admin/credentials/${id}`, { disabled: false })).status).toBe(409)
    await owner.call('PATCH', `/api/admin/credentials/${id}`, { disabled: false, assignments: [] })
  })
  test('a new token on the same connection (password again): state back to ok', async () => {
    h.ctx.db.query("UPDATE engine_credentials SET status = 'invalid', limited_until = ? WHERE id = ?").run(new Date(Date.now() + 3600_000).toISOString(), id)
    const r = await owner.call('POST', `/api/admin/credentials/${id}/secret`, { sealed: await sealed(CLAUDE('changed2'), 'credential.replace') })
    expect(r).toMatchObject({ state: 'ok', limitedUntil: null })
    // sealed for "create" is not accepted here
    expect((await owner.try('POST', `/api/admin/credentials/${id}/secret`, { sealed: await sealed(CLAUDE('changed3')) })).status).toBe(400)
  })
  test('check again: admins too (no tokens spent); a 401 marks it refused', async () => {
    answer = { '/v1/messages/count_tokens': 401 }
    expect((await admin.call('POST', `/api/admin/credentials/${id}/check`)).state).toBe('invalid')
    answer = {}
    expect((await admin.call('POST', `/api/admin/credentials/${id}/check`)).state).toBe('ok')
    expect((await member.client.try('POST', `/api/admin/credentials/${id}/check`)).status).toBe(403)
  })
  test('remove: not a member; gone afterwards', async () => {
    expect((await member.client.try('DELETE', `/api/admin/credentials/${id}`)).status).toBe(403)
    expect((await owner.try('DELETE', `/api/admin/credentials/${id}`)).status).toBe(204)
    expect((await owner.try('DELETE', `/api/admin/credentials/${id}`)).status).toBe(404)
  })
  test('the list: admins see it (with this month\'s use), members do not', async () => {
    const l = await admin.call('GET', '/api/admin/credentials')
    expect(l.allowedKinds).toEqual(['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'])
    expect(l.pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(l.items[0].month).toEqual({ usd: 0, tokens: 0, requests: 0 })
    expect((await member.client.try('GET', '/api/admin/credentials')).status).toBe(403)
  })
})

describe('admins change the team\'s AI like the owner; the owner is told, but not of their own changes', () => {
  const told: { to: string[] | undefined; code: string; message: Record<string, string> }[] = []
  let ownerId = ''
  beforeAll(async () => {
    const cc = credentialsOf(h.ctx)
    const real = cc.notify
    cc.notify = (n, to) => { told.push({ to, code: n.code, message: n.message as Record<string, string> }); real(n, to) }
    ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
  })
  const mine = () => told.filter((t) => t.code === 'credential_admin_change')
  const adminCreate = async (kind: string, secret: string, extra: Record<string, unknown> = {}) =>
    admin.try('POST', '/api/admin/credentials', { kind, label: 'Adam ' + kind, sealed: await sealed(secret), ...(kind === 'anthropic-oauth' ? { acknowledgedPlanNotice: true } : {}), ...extra })
  let id = ''

  test('an admin adds a connection with no password: the owner gets one notice (who and what, no key)', async () => {
    told.length = 0
    const secret = AKEY('byadmin2')
    const r = await adminCreate('anthropic-api-key', secret)
    expect(r.status).toBe(201)
    id = r.body.id
    expect(r.body).toMatchObject({ scope: 'team', label: 'Adam anthropic-api-key' })
    expect(mine()).toHaveLength(1)
    expect(mine()[0]!.to).toEqual([ownerId])
    expect(mine()[0]!.message.en).toBe("ADAM added the team AI connection 'Adam anthropic-api-key'.")
    expect(JSON.stringify(told)).not.toContain(secret)
    // the actor in the Activity log is the admin
    expect(h.ctx.db.query("SELECT actor_id AS actor FROM audit_log WHERE action = 'credential.create' AND target = ?").get(id)).toEqual({ actor: adminId })
  })
  test('an admin renames, assigns and switches off (the owner is told only of the switch-off), replaces and removes one the owner added', async () => {
    const ownersId = (await create(owner, 'anthropic-api-key', AKEY('byowner2'))).body.id
    told.length = 0
    expect((await admin.call('PATCH', `/api/admin/credentials/${ownersId}`, { label: 'Renamed by admin', priority: 7 })).label).toBe('Renamed by admin')
    expect(mine()).toHaveLength(0)
    expect((await admin.call('PATCH', `/api/admin/credentials/${ownersId}`, { disabled: true })).state).toBe('disabled')
    expect(mine()).toHaveLength(1)
    expect(mine()[0]!.message.en).toBe("ADAM turned off the team AI connection 'Renamed by admin'.")
    // the new key needs no password
    const rep = await admin.try('POST', `/api/admin/credentials/${ownersId}/secret`, { sealed: await sealed(AKEY('adminswap'), 'credential.replace') })
    expect(rep.status).toBe(200)
    expect(mine()).toHaveLength(2)
    expect(mine()[1]!.message.en).toContain('replaced the token or key')
    expect((await admin.try('DELETE', `/api/admin/credentials/${ownersId}`)).status).toBe(204)
    expect(mine()).toHaveLength(3)
    expect(mine()[2]!.message.en).toBe("ADAM removed the team AI connection 'Renamed by admin'.")
    expect(mine().every((m) => m.to!.length === 1 && m.to![0] === ownerId)).toBe(true)
  })
  test('the owner changes and removes one an admin added; their own changes tell nobody', async () => {
    told.length = 0
    expect((await owner.call('PATCH', `/api/admin/credentials/${id}`, { label: 'Owner renamed', disabled: true })).state).toBe('disabled')
    const rep = await owner.try('POST', `/api/admin/credentials/${id}/secret`, { sealed: await sealed(AKEY('ownerswap'), 'credential.replace') })
    expect(rep.status).toBe(200)
    const made = await create(owner, 'anthropic-api-key', AKEY('ownermade'))
    expect(made.status).toBe(201)
    expect((await owner.try('DELETE', `/api/admin/credentials/${made.body.id}`)).status).toBe(204)
    expect((await owner.try('DELETE', `/api/admin/credentials/${id}`)).status).toBe(204)
    expect(mine()).toHaveLength(0)
  })
  test('a member is refused on every one of these; the admin stays the actor in the Activity log', async () => {
    const aid = (await adminCreate('anthropic-api-key', AKEY('byadmin3'))).body.id
    expect(h.ctx.db.query("SELECT actor_id AS actor FROM audit_log WHERE action = 'credential.create' AND target = ?").get(aid)).toEqual({ actor: adminId })
    const m = member.client
    expect((await m.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'x', sealed: await sealed(AKEY('m1')) })).status).toBe(403)
    expect((await m.try('PATCH', `/api/admin/credentials/${aid}`, { disabled: true })).status).toBe(403)
    expect((await m.try('POST', `/api/admin/credentials/${aid}/secret`, { sealed: await sealed(AKEY('m2'), 'credential.replace') })).status).toBe(403)
    expect((await m.try('DELETE', `/api/admin/credentials/${aid}`)).status).toBe(403)
    expect((await m.try('POST', '/api/admin/credential-logins', { kind: 'anthropic-oauth', label: 'x', assignments: [], priority: 1, acknowledgedPlanNotice: true })).status).toBe(403)
    expect((await m.try('GET', '/api/admin/credential-logins/nope')).status).toBe(403)
    expect((await m.try('DELETE', '/api/admin/credential-logins/nope')).status).toBe(403)
    expect((await m.try('POST', '/api/admin/credential-logins/nope/code', { sealed: await sealed(AKEY('m3')) })).status).toBe(403)
    expect((await m.try('PATCH', '/api/admin/credential-settings', { memberOwn: true })).status).toBe(403)
    expect((await m.try('GET', '/api/admin/engines/api-config')).status).toBe(403)
    expect((await m.try('PUT', '/api/admin/engines/api-config', { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', label: 'x' })).status).toBe(403)
    expect((await admin.try('DELETE', `/api/admin/credentials/${aid}`)).status).toBe(204)
  })
  test('a refused or disconnected team connection is told to the owner and every admin (not to members)', async () => {
    const cid = (await create(owner, 'anthropic-api-key', AKEY('refusedlater'))).body.id
    told.length = 0
    markInvalid(credentialsOf(h.ctx), cid, 'upstream_401', 401)
    markNeedsReconnect(credentialsOf(h.ctx), cid, 'refresh_failed')
    const codes = told.map((t) => t.code)
    expect(codes).toContain('credential_rejected')
    expect(codes).toContain('credential_needs_reconnect')
    for (const t of told.filter((x) => x.code !== 'credential_admin_change')) {
      expect(t.to).toContain(ownerId)
      expect(t.to).toContain(adminId)
      expect(t.to).not.toContain(member.id)
    }
    await owner.try('DELETE', `/api/admin/credentials/${cid}`)
  })
  const inbox = async (c: Client) => ((await c.call('GET', '/api/notifications')).items as any[]).filter((i) => i.eventType === 'credential.change')
  test('the notice is also in the owner\'s inbox for when they are away: who, what, the name, never a key; the owner\'s own changes add none', async () => {
    const before = (await inbox(owner)).length
    const secret = AKEY('inboxkey')
    const r = await adminCreate('anthropic-api-key', secret, { label: 'Inbox key' })
    expect(r.status).toBe(201)
    const items = await inbox(owner)
    expect(items.length).toBe(before + 1)
    expect(items[0]).toMatchObject({ code: 'credential.change', link: 'admin_credentials', readAt: null, credentialChange: { who: 'ADAM', action: 'added', subject: 'Inbox key' } })
    expect(JSON.stringify(items)).not.toContain(secret)
    // an admin sees nothing of it, and the owner's own changes add nothing
    expect(await inbox(admin)).toEqual([])
    await owner.call('PATCH', `/api/admin/credentials/${r.body.id}`, { label: 'Owner renamed it', disabled: true })
    expect((await owner.try('DELETE', `/api/admin/credentials/${r.body.id}`)).status).toBe(204)
    expect((await inbox(owner)).length).toBe(before + 1)
  })
  test('also told: giving a connection to other people, a zero limit, and turning shared subscriptions on', async () => {
    const cid = (await adminCreate('anthropic-api-key', AKEY('also1'), { label: 'Also' })).body.id
    const g = await owner.call('POST', '/api/admin/groups', { name: 'nobody-here', memberIds: [] })
    told.length = 0
    await admin.call('PATCH', `/api/admin/credentials/${cid}`, { assignments: [{ subjectType: 'group', subjectId: g.id }] })
    expect(mine().map((m) => m.message.en)).toEqual(["ADAM changed who may use the team AI connection 'Also'."])
    await admin.call('PATCH', `/api/admin/credentials/${cid}`, { spendLimit: { usd: 0, tokens: null, action: 'block' } })
    expect(mine()[1]!.message.en).toBe("ADAM set the monthly limit of the team AI connection 'Also' to zero.")
    // a normal limit, a rename and an order tell nobody
    await admin.call('PATCH', `/api/admin/credentials/${cid}`, { spendLimit: { usd: 5, tokens: null, action: 'warn' }, label: 'Also 2', priority: 9 })
    expect(mine()).toHaveLength(2)
    // shared subscriptions: only turning them on (it answers for the provider terms), not off, not again
    await owner.call('PATCH', '/api/admin/credential-settings', { sharedSubscriptions: false })
    await admin.call('PATCH', '/api/admin/credential-settings', { memberOwn: false })
    expect(mine()).toHaveLength(2)
    await admin.call('PATCH', '/api/admin/credential-settings', { sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true })
    expect(mine()).toHaveLength(3)
    expect(mine()[2]!.message.en).toContain('turned on shared subscriptions')
    await admin.call('PATCH', '/api/admin/credential-settings', { sharedSubscriptions: true, memberOwn: true })
    expect(mine()).toHaveLength(3)
    expect((await inbox(owner)).slice(0, 3).map((i) => i.credentialChange.action).sort()).toEqual(['reassigned', 'shared_on', 'zero_limit']) // same-millisecond rows come in any order
    await owner.try('DELETE', `/api/admin/credentials/${cid}`)
  })
  test('a person who is no longer an admin (demoted a moment ago) is still reported to the owner', async () => {
    told.length = 0
    h.ctx.db.query("UPDATE users SET role = 'member' WHERE id = ?").run(adminId)
    try { noticeOwners(credentialsOf(h.ctx), adminId, 'added', 'Late one') } finally { h.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(adminId) }
    expect(mine()).toHaveLength(1)
    noticeOwners(credentialsOf(h.ctx), ownerId, 'added', 'Owner one')
    expect(mine()).toHaveLength(1)
  })
  test('a rename with the edit dialog\'s whole body (the same assignments and limit) tells nobody and is not audited as more than the rename', async () => {
    const g = await owner.call('POST', '/api/admin/groups', { name: 'dialog-team', memberIds: [] })
    const cid = (await adminCreate('anthropic-api-key', AKEY('dialog1'), { label: 'Dialog', assignments: [{ subjectType: 'group', subjectId: g.id }] })).body.id
    await admin.call('PATCH', `/api/admin/credentials/${cid}`, { spendLimit: { usd: 5, tokens: null, action: 'warn' } })
    told.length = 0
    const same = { label: 'Dialog renamed', assignments: [{ subjectType: 'group', subjectId: g.id }], spendLimit: { usd: 5, tokens: null, action: 'warn' } }
    const r = await admin.call('PATCH', `/api/admin/credentials/${cid}`, same)
    expect(r.label).toBe('Dialog renamed')
    expect(mine()).toHaveLength(0)
    const last = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'credential.update' AND target = ? ORDER BY id DESC").get(cid) as { detail: string }
    expect(JSON.parse(last.detail).changed).toEqual(['label'])
    // the same people in another order, a repeated entry: still the same set
    await admin.call('PATCH', `/api/admin/credentials/${cid}`, { assignments: [{ subjectType: 'group', subjectId: g.id }, { subjectType: 'group', subjectId: g.id }] })
    expect(mine()).toHaveLength(0)
    // a real change still tells (and a limit that is not zero does not)
    await admin.call('PATCH', `/api/admin/credentials/${cid}`, { ...same, assignments: [] })
    expect(mine().map((m) => m.message.en)).toEqual(["ADAM changed who may use the team AI connection 'Dialog renamed'."])
    await owner.try('DELETE', `/api/admin/credentials/${cid}`)
  })
  test('the write itself looks again at who may make it (a sign-in\'s starter who lost the right during the provider check)', async () => {
    const cc = credentialsOf(h.ctx)
    const stop = () => { throw Object.assign(new Error('lost the right'), { stopped: true }) }
    const before = (h.ctx.db.query('SELECT COUNT(*) AS n FROM engine_credentials').get() as { n: number }).n
    await expect(createCredential(cc, { kind: 'anthropic-api-key', label: 'late', secret: AKEY('lateone'), assignments: [], priority: 100, ownerUserId: null, actor: adminId, ensure: stop }, 'en')).rejects.toMatchObject({ stopped: true })
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM engine_credentials').get() as { n: number }).n).toBe(before)
    const cid = (await create(owner, 'anthropic-api-key', AKEY('replaceme'))).body.id
    const hint = (h.ctx.db.query('SELECT hint FROM engine_credentials WHERE id = ?').get(cid) as { hint: string }).hint
    await expect(replaceSecret(cc, cid, AKEY('replaced2'), adminId, 'en', stop)).rejects.toMatchObject({ stopped: true })
    expect((h.ctx.db.query('SELECT hint FROM engine_credentials WHERE id = ?').get(cid) as { hint: string }).hint).toBe(hint)
    await owner.try('DELETE', `/api/admin/credentials/${cid}`)
  })
  describe('connections members made for themselves', () => {
    let ann: { client: Client; id: string; password: string }
    let ownerMine = '', memberMine = '', adamMine = '', annMine = ''
    const own = async (c: Client, secret: string) => (await c.call('POST', '/api/me/credentials', { kind: 'anthropic-api-key', label: 'own-' + secret.slice(13, 18), sealed: await sealed(secret) })).id as string
    beforeAll(async () => {
      ann = await addMember(h, owner, { username: 'ann', role: 'admin' })
      await owner.call('PATCH', '/api/admin/credential-settings', { memberOwn: true })
      memberMine = await own(member.client, AKEY('pmember'))
      ownerMine = await own(owner, AKEY('powner'))
      adamMine = await own(admin, AKEY('padam'))
      annMine = await own(ann.client, AKEY('pann'))
    })
    test('an admin may only switch off or remove a member\'s, and the member is told; never the key, the name, the order or the limit', async () => {
      told.length = 0
      expect((await admin.try('PATCH', `/api/admin/credentials/${memberMine}`, { label: 'x' })).status).toBe(403)
      expect((await admin.try('PATCH', `/api/admin/credentials/${memberMine}`, { priority: 1 })).status).toBe(403)
      expect((await admin.try('PATCH', `/api/admin/credentials/${memberMine}`, { spendLimit: { usd: 1, tokens: null, action: 'block' } })).status).toBe(403)
      expect((await admin.try('PATCH', `/api/admin/credentials/${memberMine}`, { disabled: true, label: 'x' })).status).toBe(403)
      expect((await admin.try('POST', `/api/admin/credentials/${memberMine}/secret`, { sealed: await sealed(AKEY('swap'), 'credential.replace') })).status).toBe(403)
      expect(told).toEqual([])
      expect((await admin.call('PATCH', `/api/admin/credentials/${memberMine}`, { disabled: true })).state).toBe('disabled')
      expect(told.map((t) => [t.to, t.message.en])).toEqual([[[member.id], "ADAM turned off your AI connection 'own-pmemb'."]])
      const mi = ((await member.client.call('GET', '/api/notifications')).items as any[]).filter((i) => i.eventType === 'credential.change')
      expect(mi[0]).toMatchObject({ link: null, credentialChange: { who: 'ADAM', action: 'personal_disabled', subject: 'own-pmemb' } })
      // switching it back on is the member\'s
      expect((await admin.try('PATCH', `/api/admin/credentials/${memberMine}`, { disabled: false })).status).toBe(403)
      expect((await admin.try('DELETE', `/api/admin/credentials/${memberMine}`)).status).toBe(204)
      expect(told.at(-1)!.message.en).toBe("ADAM removed your AI connection 'own-pmemb'.")
      expect((await member.client.try('DELETE', `/api/me/credentials/${memberMine}`)).status).toBe(404)
    })
    test('an admin may not touch the owner\'s or another admin\'s own connection, in any way', async () => {
      told.length = 0
      for (const id of [ownerMine, annMine]) {
        expect((await admin.try('PATCH', `/api/admin/credentials/${id}`, { disabled: true })).status).toBe(403)
        expect((await admin.try('DELETE', `/api/admin/credentials/${id}`)).status).toBe(403)
        expect((await admin.try('POST', `/api/admin/credentials/${id}/secret`, { sealed: await sealed(AKEY('swap2'), 'credential.replace') })).status).toBe(403)
      }
      expect((await ann.client.try('DELETE', `/api/admin/credentials/${adamMine}`)).status).toBe(403)
      expect(told).toEqual([])
      expect((await owner.call('GET', '/api/admin/credentials')).items.filter((x: any) => x.scope === 'personal').map((x: any) => x.id).sort()).toEqual([adamMine, annMine, ownerMine].sort())
    })
    test('the owner keeps what the owner had: switch off, remove (and the member is told); the holder removes their own without a notice', async () => {
      told.length = 0
      expect((await owner.call('PATCH', `/api/admin/credentials/${annMine}`, { disabled: true })).state).toBe('disabled')
      expect(told.map((t) => t.to)).toEqual([[ann.id]])
      expect((await owner.try('DELETE', `/api/admin/credentials/${annMine}`)).status).toBe(204)
      told.length = 0
      expect((await admin.try('DELETE', `/api/me/credentials/${adamMine}`)).status).toBe(204)
      expect((await owner.try('DELETE', `/api/me/credentials/${ownerMine}`)).status).toBe(204)
      expect(told).toEqual([])
    })
  })
  test('an admin changes the settings of the team\'s connections (members\' own)', async () => {
    expect(await admin.call('PATCH', '/api/admin/credential-settings', { memberOwn: true })).toMatchObject({ memberOwn: true })
  })
  const PUBLIC = 'https://93.184.216.34/v1' // a literal public address: no DNS lookup in the test
  test('an admin edits the API engine settings with their own password; the owner is told (host and model, never the key); the owner\'s own edit tells nobody', async () => {
    told.length = 0
    const keyText = 'engine-key-' + 'q'.repeat(24)
    const body = { baseUrl: PUBLIC, model: 'team-model', label: 'Team API', key: keyText }
    // the password again: none = 400, the owner's typed by the admin = 403
    expect((await admin.try('PUT', '/api/admin/engines/api-config', body)).status).toBe(400)
    expect((await admin.try('PUT', '/api/admin/engines/api-config', { ...body, password: OWNER_PW })).status).toBe(403)
    expect(mine()).toHaveLength(0)
    const r = await admin.call('PUT', '/api/admin/engines/api-config', { ...body, password: adminPw })
    expect(r).toEqual({ baseUrl: body.baseUrl, model: 'team-model', label: 'Team API', hasKey: true })
    expect(await admin.call('GET', '/api/admin/engines/api-config')).toEqual(r)
    expect(mine()).toHaveLength(1)
    expect(mine()[0]!.to).toEqual([ownerId])
    expect(mine()[0]!.message.en).toBe('ADAM changed the team API engine settings (93.184.216.34, team-model).')
    expect(JSON.stringify(told)).not.toContain(keyText)
    expect(h.ctx.db.query("SELECT actor_id AS actor FROM audit_log WHERE action = 'engines.api' ORDER BY rowid DESC").get()).toEqual({ actor: adminId })
    expect(JSON.stringify(h.ctx.db.query('SELECT detail FROM audit_log WHERE action = ?').all('engines.api'))).not.toContain(keyText)
    told.length = 0
    expect(await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: body.baseUrl, model: 'owner-model', label: 'Team API', password: OWNER_PW })).toMatchObject({ model: 'owner-model', hasKey: true })
    expect(mine()).toHaveLength(0)
    // and the other way round: the admin may change what the owner set (same address: the key stays)
    expect(await admin.call('PUT', '/api/admin/engines/api-config', { baseUrl: body.baseUrl, model: 'again', label: 'Team API', password: adminPw })).toMatchObject({ model: 'again', hasKey: true })
    expect(await admin.call('PUT', '/api/admin/engines/api-config', { baseUrl: body.baseUrl, model: 'back', label: 'Team API', key: null, password: adminPw })).toMatchObject({ model: 'back', hasKey: false })
    expect(mine()).toHaveLength(2)
  })
  test('a save that waits for the admin\'s DNS cannot pair the owner\'s new key with the admin\'s address (regression: review round 2)', async () => {
    const OWNER_A = 'https://93.184.216.34/v1'
    const realLookup = dns.lookup
    let slow = 0
    ;(dns as any).lookup = async (host: string, o: unknown) => {
      if (host === 'evil.example') { if (slow) await new Promise((r) => setTimeout(r, slow)); return [{ address: '93.184.216.35', family: 4 }] }
      return realLookup(host, o as never)
    }
    try {
      const dir = h.ctx.config.dataDir
      // 1. the owner's engine, with the owner's key
      await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: OWNER_A, model: 'm', label: 'x', key: 'owner-key-1-' + 'a'.repeat(20), password: OWNER_PW })
      // 2. the admin moves it to their own name, key removed (allowed: a changed address with key null)
      await admin.call('PUT', '/api/admin/engines/api-config', { baseUrl: 'https://evil.example/v1', model: 'm', label: 'x', key: null, password: adminPw })
      expect(readApiEngine(dir)).toMatchObject({ baseUrl: 'https://evil.example/v1', key: null })
      // 3. the admin starts another save at that origin, key absent ("kept"), whose DNS answer is slow
      slow = 400
      const pending = admin.try('PUT', '/api/admin/engines/api-config', { baseUrl: 'https://evil.example/v2', model: 'm', label: 'x', password: adminPw })
      await new Promise((r) => setTimeout(r, 150))
      // 4. meanwhile the owner fixes the engine: their own address and a new key
      await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: OWNER_A, model: 'm', label: 'x', key: 'owner-key-2-' + 'b'.repeat(20), password: OWNER_PW })
      const r = await pending
      slow = 0
      // the late save sees the owner's key now: a new address without a key for it is refused, nothing is written
      expect(r.status).toBe(400)
      expect(readApiEngine(dir)).toMatchObject({ baseUrl: OWNER_A, key: 'owner-key-2-' + 'b'.repeat(20) })
      // and if it had been written anyway, the key belongs to the address it was stored for and is never read for another
      writeApiEngine(dir, { baseUrl: 'https://evil.example/v2', model: 'm', label: 'x' })
      expect(readApiEngine(dir)).toMatchObject({ baseUrl: 'https://evil.example/v2', key: null })
      writeApiEngine(dir, { baseUrl: OWNER_A, model: 'm', label: 'x' })
      expect(readApiEngine(dir)?.key).toBe('owner-key-2-' + 'b'.repeat(20))
      // a key file from before this fix (the bare key) is bound to the address that was set, the first time it is rewritten
      fs.writeFileSync(apiEngineKeyPath(dir), 'bare-old-key-' + 'c'.repeat(20))
      expect(readApiEngine(dir)?.key).toBe('bare-old-key-' + 'c'.repeat(20))
      writeApiEngine(dir, { baseUrl: 'https://evil.example/v3', model: 'm', label: 'x' })
      expect(readApiEngine(dir)?.key).toBeNull()
      writeApiEngine(dir, { baseUrl: OWNER_A, model: 'm', label: 'x', key: null })
    } finally { slow = 0; ;(dns as any).lookup = realLookup }
  })
  test('the engine\'s calls never follow a redirect, and an address an admin set is checked to be public at every call', async () => {
    const seen: string[] = []
    const stub = (async (url: string, init: RequestInit) => { seen.push(`${url} ${init.redirect}`); return new Response('{}') }) as unknown as typeof fetch
    await apiEngineFetch(stub)('http://127.0.0.1:9/v1/models')
    expect(seen).toEqual(['http://127.0.0.1:9/v1/models error'])
    // an admin's address: a private one and an http one are refused before anything is sent, a public https one goes
    seen.length = 0
    await expect(apiEngineFetch(stub, { publicCheck: true })('http://127.0.0.1:9/v1/models')).rejects.toThrow(/https/)
    await expect(apiEngineFetch(stub, { publicCheck: true })('https://10.0.0.5/v1/models')).rejects.toThrow(/private|local|reserved/)
    await expect(apiEngineFetch(stub, { publicCheck: true })('https://169.254.169.254/latest')).rejects.toThrow(/private|local|reserved/)
    expect(seen).toEqual([])
    await expect(apiEngineFetch(stub, { publicCheck: true })('http://93.184.216.34/v1/models')).rejects.toThrow(/https/)
    expect(seen).toEqual([])
    await apiEngineFetch(stub, { publicCheck: true })('https://93.184.216.34/v1/models')
    expect(seen).toEqual(['https://93.184.216.34/v1/models error'])
    // who set it is kept: an admin's address stays checked, the owner's is not
    const dir = h.ctx.config.dataDir
    await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: 'http://127.0.0.1:9/v1', model: 'm', label: 'x', key: null, password: OWNER_PW })
    expect(readApiEngine(dir)?.setBy).toBeUndefined()
    await admin.call('PUT', '/api/admin/engines/api-config', { baseUrl: 'http://127.0.0.1:9/v1', model: 'm2', label: 'x', password: adminPw }) // a model change keeps the owner's address as the owner's
    expect(readApiEngine(dir)?.setBy).toBeUndefined()
    await admin.call('PUT', '/api/admin/engines/api-config', { baseUrl: 'https://93.184.216.34/v1', model: 'm2', label: 'x', key: null, password: adminPw })
    expect(readApiEngine(dir)?.setBy).toBe('admin')
    // an owner who changes only the model leaves an admin\'s address the admin\'s (still checked at every call); a NEW address is theirs
    await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: 'https://93.184.216.34/v1/', model: 'm3', label: 'x', password: OWNER_PW })
    expect(readApiEngine(dir)).toMatchObject({ model: 'm3', setBy: 'admin' })
    await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: 'https://93.184.216.34/v2', model: 'm3', label: 'x', key: null, password: OWNER_PW })
    expect(readApiEngine(dir)?.setBy).toBeUndefined()
  })
  test('the key belongs to the whole address, path included: another tenant\'s path on the same gateway never gets it (regression: review round 3)', async () => {
    const dir = h.ctx.config.dataDir
    const OWNER_URL = 'https://93.184.216.34/v1/OWNERACCT/gw/openai'
    const K = 'owner-key-' + 'a'.repeat(24)
    await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: OWNER_URL, model: 'm', label: 'x', key: K, password: OWNER_PW })
    // the same host and port, another tenant\'s path, no key: refused for the admin, and for the owner too; nothing written
    for (const [c, pw] of [[admin, adminPw], [owner, OWNER_PW]] as const) {
      const r = await c.try('PUT', '/api/admin/engines/api-config', { baseUrl: 'https://93.184.216.34/v1/ATTACKER/gw/custom-x', model: 'm', label: 'x', password: pw })
      expect(r.status).toBe(400)
      expect(r.body.error.fields['body.key']).toBeDefined()
    }
    expect(readApiEngine(dir)).toMatchObject({ baseUrl: OWNER_URL, key: K })
    // a trailing slash, nothing else: the same address
    expect((await admin.try('PUT', '/api/admin/engines/api-config', { baseUrl: OWNER_URL + '/', model: 'm2', label: 'x', password: adminPw })).status).toBe(200)
    expect(readApiEngine(dir)).toMatchObject({ model: 'm2', key: K })
    // if another path were written anyway, the key is not read for it, and not for the old path from a third address either
    writeApiEngine(dir, { baseUrl: 'https://93.184.216.34/v1/ATTACKER/gw/custom-x', model: 'm', label: 'x' })
    expect(readApiEngine(dir)).toMatchObject({ key: null })
    writeApiEngine(dir, { baseUrl: OWNER_URL, model: 'm', label: 'x' })
    expect(readApiEngine(dir)?.key).toBe(K)
    // keys from earlier builds of this change: bound to the address that is set, the first time they are rewritten
    fs.writeFileSync(apiEngineKeyPath(dir), JSON.stringify({ key: 'origin-bound-' + 'd'.repeat(20), origin: 'https://93.184.216.34' }))
    expect(readApiEngine(dir)?.key).toBe('origin-bound-' + 'd'.repeat(20))
    writeApiEngine(dir, { baseUrl: 'https://93.184.216.34/v1/OTHER', model: 'm', label: 'x' })
    expect(readApiEngine(dir)?.key).toBeNull() // bound to the address that was set (OWNER_URL), not to the new path
    expect(JSON.parse(fs.readFileSync(apiEngineKeyPath(dir), 'utf8'))).toMatchObject({ url: OWNER_URL })
    writeApiEngine(dir, { baseUrl: OWNER_URL, model: 'm', label: 'x', key: null })
  })
  test('an admin cannot set an http address (https keeps a re-pointed name from reaching an internal host), nor keep one through the per-call check', async () => {
    const r = await admin.try('PUT', '/api/admin/engines/api-config', { baseUrl: 'http://93.184.216.34/v1', model: 'm', label: 'x', key: null, password: adminPw })
    expect(r.status).toBe(403)
    expect(r.body.error.fields['body.baseUrl']).toBe('https_required')
    expect(r.body.error.message).toContain('https')
    // the owner may (a local Ollama, a plain LAN address)
    expect((await owner.try('PUT', '/api/admin/engines/api-config', { baseUrl: 'http://93.184.216.34/v1', model: 'm', label: 'x', key: null, password: OWNER_PW })).status).toBe(200)
  })
  test('an admin\'s save that changes nothing tells the owner nothing', async () => {
    await admin.call('PUT', '/api/admin/engines/api-config', { baseUrl: PUBLIC, model: 'same', label: 'Same', key: null, password: adminPw })
    told.length = 0
    await admin.call('PUT', '/api/admin/engines/api-config', { baseUrl: PUBLIC, model: 'same', label: 'Same', password: adminPw })
    await admin.call('PUT', '/api/admin/engines/api-config', { baseUrl: PUBLIC + '/', model: 'same', password: adminPw })
    expect(mine()).toHaveLength(0)
    await admin.call('PUT', '/api/admin/engines/api-config', { baseUrl: PUBLIC, model: 'other', label: 'Same', password: adminPw })
    expect(mine()).toHaveLength(1)
  })
  test('the role is read again after every wait: an admin disabled or demoted during the DNS lookup or the provider check writes nothing', async () => {
    const dir = h.ctx.config.dataDir
    const realLookup = dns.lookup
    ;(dns as any).lookup = async (host: string, o: unknown) => {
      if (host === 'slow.example') { await new Promise((r) => setTimeout(r, 300)); return [{ address: '93.184.216.36', family: 4 }] }
      return realLookup(host, o as never)
    }
    const setRole = (role: string) => h.ctx.db.query('UPDATE users SET role = ? WHERE id = ?').run(role, adminId)
    try {
      await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: PUBLIC, model: 'before', label: 'x', key: null, password: OWNER_PW })
      const pending = admin.try('PUT', '/api/admin/engines/api-config', { baseUrl: 'https://slow.example/v1', model: 'late', label: 'x', key: null, password: adminPw })
      await new Promise((r) => setTimeout(r, 100))
      setRole('member')
      const r = await pending
      expect(r.status).toBe(403)
      expect(readApiEngine(dir)).toMatchObject({ baseUrl: PUBLIC, model: 'before' })
      setRole('admin')
      // the provider check of a create takes a moment; the person is a member by the time it ends
      delayMs = 300
      const before = (h.ctx.db.query('SELECT COUNT(*) AS n FROM engine_credentials').get() as { n: number }).n
      const create2 = adminCreate('anthropic-api-key', AKEY('latewrite'), { label: 'Late write' })
      await new Promise((r) => setTimeout(r, 100))
      setRole('member')
      expect((await create2).status).toBe(403)
      expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM engine_credentials').get() as { n: number }).n).toBe(before)
      setRole('admin')
      const cid = (await create(owner, 'anthropic-api-key', AKEY('latereplace'))).body.id
      const rep = admin.try('POST', `/api/admin/credentials/${cid}/secret`, { sealed: await sealed(AKEY('latereplace2'), 'credential.replace') })
      await new Promise((r) => setTimeout(r, 100))
      setRole('member')
      expect((await rep).status).toBe(403)
      setRole('admin')
      delayMs = 0
      await owner.try('DELETE', `/api/admin/credentials/${cid}`)
    } finally { delayMs = 0; setRole('admin'); ;(dns as any).lookup = realLookup }
  })
  test('the stored key never goes to a new address: a changed address needs a key of its own (or null), the check sends nothing old', async () => {
    const seen: { auth: string | null; path: string }[] = []
    const sink = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { seen.push({ auth: req.headers.get('authorization'), path: new URL(req.url).pathname }); return Response.json({ data: [{ id: 'm' }] }) } })
    try {
      const A = `http://127.0.0.1:${fake.port}/v1`
      const B = `http://127.0.0.1:${sink.port}/v1`
      const OLD = 'owners-engine-key-' + 'z'.repeat(20)
      // the owner sets a local address with a key (a private address is the owner's to set)
      await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: A, model: 'm', label: 'x', key: OLD, password: OWNER_PW })
      // an admin cannot point it at a private address, with or without a key, and the owner's key stays where it was
      for (const key of [undefined, 'attacker-' + 'k'.repeat(20), null]) {
        const r = await admin.try('PUT', '/api/admin/engines/api-config', { baseUrl: B, model: 'm', label: 'x', password: adminPw, ...(key !== undefined ? { key } : {}) })
        expect(r.status).toBe(403)
        expect(r.body.error.fields['body.baseUrl']).toBe('https_required') // http, and a private address besides
      }
      const priv = await admin.try('PUT', '/api/admin/engines/api-config', { baseUrl: 'https://10.0.0.5/v1', model: 'm', label: 'x', key: null, password: adminPw })
      expect(priv.status).toBe(403)
      expect(priv.body.error.fields['body.baseUrl']).toBe('owner_only_address')
      expect(await owner.call('GET', '/api/admin/engines/api-config')).toMatchObject({ baseUrl: A, hasKey: true })
      // an admin may still change the model at the address that is set (a private address already there is left alone)
      expect(await admin.call('PUT', '/api/admin/engines/api-config', { baseUrl: A, model: 'm2', label: 'x', password: adminPw })).toMatchObject({ baseUrl: A, model: 'm2', hasKey: true })
      // a changed address without a key: refused for everybody, nothing written
      for (const c of [owner, admin]) {
        const r = await c.try('PUT', '/api/admin/engines/api-config', { baseUrl: B, model: 'm', label: 'x', password: c === owner ? OWNER_PW : adminPw })
        expect(r.status).toBe(c === owner ? 400 : 403) // the admin is stopped by the address rule first
      }
      const refused = await owner.try('PUT', '/api/admin/engines/api-config', { baseUrl: B, model: 'm', label: 'x', password: OWNER_PW })
      expect(refused.status).toBe(400)
      expect(refused.body.error.fields['body.key']).toBeDefined()
      expect(await owner.call('GET', '/api/admin/engines/api-config')).toMatchObject({ baseUrl: A, hasKey: true })
      // the same host on another port is another address too; the path alone is not
      expect((await owner.try('PUT', '/api/admin/engines/api-config', { baseUrl: B, model: 'm', label: 'x', password: OWNER_PW })).status).toBe(400)
      expect(await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: A + '/', model: 'm', label: 'x', password: OWNER_PW })).toMatchObject({ hasKey: true })
      // the owner moves it with a key for the new address; the check sends that key, never the old one
      await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: B, model: 'm', label: 'x', key: 'new-key-' + 'n'.repeat(20), password: OWNER_PW })
      await admin.call('POST', '/api/admin/engines/api/check')
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((x) => x.auth === 'Bearer new-key-' + 'n'.repeat(20))).toBe(true)
      expect(JSON.stringify(seen)).not.toContain(OLD)
      // or with the key removed: nothing is sent
      seen.length = 0
      await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: A, model: 'm', label: 'x', key: null, password: OWNER_PW })
      await owner.call('PUT', '/api/admin/engines/api-config', { baseUrl: B, model: 'm', label: 'x', password: OWNER_PW }) // no key stored: nothing to protect
      await admin.call('POST', '/api/admin/engines/api/check')
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((x) => x.auth === null)).toBe(true)
    } finally { sink.stop(true) }
  })
})

describe('members\' own connections', () => {
  const mine = async (secret: string) => member.client.try('POST', '/api/me/credentials', { kind: 'anthropic-api-key', label: 'mine', sealed: await sealed(secret) })
  test('on by default; an explicit owner opt-out is preserved and enforced', async () => {
    expect((await member.client.call('GET', '/api/me/credentials')).allowed).toBe(true)
    expect(await owner.call('PATCH', '/api/admin/credential-settings', { memberOwn: false })).toEqual({ memberOwn: false, sharedSubscriptions: true })
    expect((await member.client.call('GET', '/api/me/credentials')).allowed).toBe(false)
    expect((await mine(AKEY('mine0'))).status).toBe(403)
    expect((await member.client.try('PATCH', '/api/admin/credential-settings', { memberOwn: true })).status).toBe(403)
    expect(await owner.call('PATCH', '/api/admin/credential-settings', { memberOwn: true })).toEqual({ memberOwn: true, sharedSubscriptions: true })
  })
  test('a member adds, sees and removes their own; nobody else\'s', async () => {
    const r = await mine(AKEY('mine1'))
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ scope: 'personal', owner: { id: member.id } })
    expect((await member.client.call('GET', '/api/me/credentials')).items.map((x: any) => x.id)).toEqual([r.body.id])
    expect((await owner.call('GET', '/api/me/credentials')).items).toEqual([])
    // the owner sees that it exists (and may switch it off), but not through the member's own path
    expect((await owner.call('GET', '/api/admin/credentials')).items.some((x: any) => x.id === r.body.id && x.scope === 'personal')).toBe(true)
    expect((await owner.try('DELETE', `/api/me/credentials/${r.body.id}`)).status).toBe(404)
    expect((await member.client.try('DELETE', `/api/me/credentials/${r.body.id}`)).status).toBe(204)
  })
})

describe('S-8: secrets never come back (responses, audit, logs)', () => {
  test('no canary secret in any list, audit entry or log line', async () => {
    const dump = JSON.stringify(await owner.call('GET', '/api/admin/credentials')) + JSON.stringify(await member.client.call('GET', '/api/me/credentials'))
      + JSON.stringify(h.ctx.db.query('SELECT action, target, detail FROM audit_log').all()) + JSON.stringify(await owner.call('GET', '/api/admin/audit?limit=200'))
      + lines.join('\n')
    expect(CANARIES.length).toBeGreaterThan(10)
    for (const c of CANARIES) expect(dump).not.toContain(c)
    // the database file holds only ciphertext (S-9 is in a-credentials-store.test.ts)
    const rows = h.ctx.db.query('SELECT secret_enc FROM engine_credentials').all() as { secret_enc: string }[]
    for (const c of CANARIES) for (const r of rows) expect(r.secret_enc).not.toContain(c)
    const actions = (h.ctx.db.query("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'credential.%'").all() as { action: string }[]).map((a) => a.action).sort()
    expect(actions).toEqual(['credential.check', 'credential.create', 'credential.delete', 'credential.rejected', 'credential.secret_replaced', 'credential.settings', 'credential.update'])
  })
})

describe('kinds this server allows (engine.credentialKinds, D22)', () => {
  test('API keys only: subscriptions cannot be added and existing ones show as "off on this server"', async () => {
    const h2 = await harness('cred-api-kinds', { engine: { authMode: 'managed', credentialKinds: ['anthropic-api-key', 'openai-api-key'], modelUpstreams: { anthropic: up, openai: up + '/v1' } } })
    try {
      const o2 = await withOwner(h2)
      const k2: SealingKey = await o2.call('GET', '/api/credentials/sealing-key')
      const r = await o2.try('POST', '/api/admin/credentials', { kind: 'anthropic-oauth', label: 'x', sealed: await sealSecret(k2, CLAUDE('off'), 'credential.create'), acknowledgedPlanNotice: true })
      expect(r.status).toBe(400)
      expect((await o2.call('GET', '/api/admin/credentials')).allowedKinds).toEqual(['anthropic-api-key', 'openai-api-key'])
      expect((await o2.try('POST', '/api/admin/credential-logins', { label: 'g', acknowledgedPlanNotice: true })).status).toBe(400)
    } finally { await h2.close() }
  })
})
