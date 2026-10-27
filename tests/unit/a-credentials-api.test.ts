// Admin > AI connections over HTTP (docs/DECISIONS.md "AI 연결" 3.8/3.9): adding a Claude subscription token or an
// API key sealed in the browser (web/src/lib/seal.ts) and checked without spending tokens against fake providers
// (200 = verified, 401 = refused and not saved, anything else = saved "checked on the first question"), the plan
// notice (D23), the same token twice (409), the password again, owner-only changes, members' own connections, the
// server's allowed kinds (D22). S-8 (no secret in any response, audit entry or log line), S-10 (sealing: no plain
// secret field, purpose, replay, key id), S-13 (redirects of the provider check are not followed).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { SealingKey } from '@mycel/shared/api'
import { createLogger } from '../../server/src/log'
import { sealSecret } from '../../web/src/lib/seal'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'

// ---------------- fake providers ----------------
const hits: { path: string; headers: Record<string, string> }[] = []
let answer: Record<string, number> = {}
const stolen: string[] = []
const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { stolen.push(new URL(req.url).pathname); return new Response('ok') } })
const fake = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const u = new URL(req.url)
    hits.push({ path: u.pathname, headers: Object.fromEntries(req.headers) })
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
let member: { client: Client; id: string }
let key: SealingKey
beforeAll(async () => {
  h = await harness('cred-api', { engine: { authMode: 'managed', modelUpstreams: { anthropic: up, openai: up + '/v1' } } },
    { log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) })
  owner = await withOwner(h)
  admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  member = await addMember(h, owner, { username: 'mia', role: 'member' })
  key = await owner.call('GET', '/api/credentials/sealing-key')
})
afterAll(async () => { await h?.close(); fake.stop(true); other.stop(true) })

const sealed = async (secret: string, purpose: 'credential.create' | 'credential.replace' = 'credential.create') => { CANARIES.push(secret); return sealSecret(key, secret, purpose) }
const create = async (c: Client, kind: string, secret: string, extra: Record<string, unknown> = {}) =>
  c.try('POST', '/api/admin/credentials', { kind, label: 'L-' + kind, sealed: await sealed(secret), password: OWNER_PW, ...(kind === 'anthropic-oauth' ? { acknowledgedPlanNotice: true } : {}), ...extra })

describe('sealing key and sealed secrets (S-10)', () => {
  test('the public key only (no private part), a 16-hex key id', async () => {
    expect(key.alg).toBe('ECDH-ES+P256+HKDF-SHA256+A256GCM')
    expect(key.kid).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(key)).not.toContain('"d"')
    expect(await member.client.call('GET', '/api/credentials/sealing-key')).toEqual(key)
  })
  test('a plain secret field is not part of the contract (400), even with a sealed one missing', async () => {
    const r = await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'x', secret: AKEY('plain'), password: OWNER_PW })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).not.toContain(AKEY('plain'))
  })
  test('sealed for another purpose, used twice, or with another key id: refused, never saved', async () => {
    const before = (await owner.call('GET', '/api/admin/credentials')).items.length
    const replace = await sealed(AKEY('purpose'), 'credential.replace')
    expect((await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'x', sealed: replace, password: OWNER_PW })).status).toBe(400)
    const once = await sealed(AKEY('once'))
    expect((await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'once', sealed: once, password: OWNER_PW })).status).toBe(201)
    const again = await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'once2', sealed: once, password: OWNER_PW })
    expect(again.status).toBe(400); expect(again.body.error.fields['body.sealed']).toBe('already used')
    const wrongKid = { ...(await sealed(AKEY('kid'))), kid: '0000000000000000' }
    expect((await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'x', sealed: wrongKid, password: OWNER_PW })).status).toBe(400)
    const broken = { ...(await sealed(AKEY('broken'))), ct: 'A'.repeat(40) }
    expect((await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'x', sealed: broken, password: OWNER_PW })).status).toBe(400)
    expect((await owner.call('GET', '/api/admin/credentials')).items.length).toBe(before + 1)
  })
})

describe('adding connections (checked without spending tokens)', () => {
  test('shared subscriptions need an explicit owner choice and acknowledged risk', async () => {
    const initial = await owner.call('GET', '/api/admin/credentials')
    expect(initial).toMatchObject({ memberOwn: true, sharedSubscriptions: false })
    hits.length = 0
    expect((await create(owner, 'anthropic-oauth', CLAUDE('sharing-off'))).status).toBe(403)
    expect(hits).toEqual([])
    expect((await admin.try('PATCH', '/api/admin/credential-settings', { sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true })).status).toBe(403)
    expect((await member.client.try('PATCH', '/api/admin/credential-settings', { sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true })).status).toBe(403)
    expect((await owner.try('PATCH', '/api/admin/credential-settings', { memberOwn: false, sharedSubscriptions: true })).status).toBe(400)
    expect(await owner.call('GET', '/api/admin/credentials')).toMatchObject({ memberOwn: true, sharedSubscriptions: false })
    expect(await owner.call('PATCH', '/api/admin/credential-settings', { sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true })).toEqual({ memberOwn: true, sharedSubscriptions: true })
  })
  test('a Claude subscription token: count_tokens with the OAuth headers, 200 = verified; one year; the plan notice is required', async () => {
    hits.length = 0; answer = {}
    const noAck = await owner.try('POST', '/api/admin/credentials', { kind: 'anthropic-oauth', label: 'Max', sealed: await sealed(CLAUDE('noack')), password: OWNER_PW })
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
  test('only the owner, with the password: admins and members 403, a wrong password 403', async () => {
    expect((await create(admin, 'anthropic-api-key', AKEY('byadmin'))).status).toBe(403)
    expect((await create(member.client, 'anthropic-api-key', AKEY('bymember'))).status).toBe(403)
    expect((await create(owner, 'anthropic-api-key', AKEY('wrongpw'), { password: 'nope' })).status).toBe(403)
  })
})

describe('changing, checking, removing', () => {
  let id = ''
  beforeAll(async () => { id = (await create(owner, 'anthropic-oauth', CLAUDE('change'))).body.id })
  test('rename, order, switch off, assign, monthly limit: owner only', async () => {
    const groups = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [member.id] })
    const r = await owner.call('PATCH', `/api/admin/credentials/${id}`, { label: 'Design Max', priority: 5, assignments: [{ subjectType: 'group', subjectId: groups.id }], spendLimit: { usd: null, tokens: 1000000, action: 'warn' } })
    expect(r).toMatchObject({ label: 'Design Max', priority: 5, assignments: [{ subjectType: 'group', subjectId: groups.id, name: 'design' }], spendLimit: { usd: null, tokens: 1000000, action: 'warn' } })
    expect((await owner.call('PATCH', `/api/admin/credentials/${id}`, { disabled: true })).state).toBe('disabled')
    expect((await admin.try('PATCH', `/api/admin/credentials/${id}`, { label: 'x' })).status).toBe(403)
    expect((await owner.try('PATCH', `/api/admin/credentials/${id}`, { assignments: [{ subjectType: 'group', subjectId: 'nope' }] })).status).toBe(400)
    await owner.call('PATCH', `/api/admin/credentials/${id}`, { disabled: false, assignments: [] })
  })
  test('a new token on the same connection (password again): state back to ok', async () => {
    h.ctx.db.query("UPDATE engine_credentials SET status = 'invalid', limited_until = ? WHERE id = ?").run(new Date(Date.now() + 3600_000).toISOString(), id)
    const r = await owner.call('POST', `/api/admin/credentials/${id}/secret`, { sealed: await sealed(CLAUDE('changed2'), 'credential.replace'), password: OWNER_PW })
    expect(r).toMatchObject({ state: 'ok', limitedUntil: null })
    // sealed for "create" is not accepted here
    expect((await owner.try('POST', `/api/admin/credentials/${id}/secret`, { sealed: await sealed(CLAUDE('changed3')), password: OWNER_PW })).status).toBe(400)
  })
  test('check again: admins too (no tokens spent); a 401 marks it refused', async () => {
    answer = { '/v1/messages/count_tokens': 401 }
    expect((await admin.call('POST', `/api/admin/credentials/${id}/check`)).state).toBe('invalid')
    answer = {}
    expect((await admin.call('POST', `/api/admin/credentials/${id}/check`)).state).toBe('ok')
    expect((await member.client.try('POST', `/api/admin/credentials/${id}/check`)).status).toBe(403)
  })
  test('remove: owner only; gone afterwards', async () => {
    expect((await admin.try('DELETE', `/api/admin/credentials/${id}`)).status).toBe(403)
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

describe('members\' own connections', () => {
  const mine = async (secret: string) => member.client.try('POST', '/api/me/credentials', { kind: 'anthropic-api-key', label: 'mine', sealed: await sealed(secret) })
  test('on by default; an explicit owner opt-out is preserved and enforced', async () => {
    expect((await member.client.call('GET', '/api/me/credentials')).allowed).toBe(true)
    expect(await owner.call('PATCH', '/api/admin/credential-settings', { memberOwn: false })).toEqual({ memberOwn: false, sharedSubscriptions: true })
    expect((await member.client.call('GET', '/api/me/credentials')).allowed).toBe(false)
    expect((await mine(AKEY('mine0'))).status).toBe(403)
    expect((await admin.try('PATCH', '/api/admin/credential-settings', { memberOwn: true })).status).toBe(403)
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
    expect(actions).toEqual(['credential.check', 'credential.create', 'credential.delete', 'credential.secret_replaced', 'credential.settings', 'credential.update'])
  })
})

describe('kinds this server allows (engine.credentialKinds, D22)', () => {
  test('API keys only: subscriptions cannot be added and existing ones show as "off on this server"', async () => {
    const h2 = await harness('cred-api-kinds', { engine: { authMode: 'managed', credentialKinds: ['anthropic-api-key', 'openai-api-key'], modelUpstreams: { anthropic: up, openai: up + '/v1' } } })
    try {
      const o2 = await withOwner(h2)
      const k2: SealingKey = await o2.call('GET', '/api/credentials/sealing-key')
      const r = await o2.try('POST', '/api/admin/credentials', { kind: 'anthropic-oauth', label: 'x', sealed: await sealSecret(k2, CLAUDE('off'), 'credential.create'), acknowledgedPlanNotice: true, password: OWNER_PW })
      expect(r.status).toBe(400)
      expect((await o2.call('GET', '/api/admin/credentials')).allowedKinds).toEqual(['anthropic-api-key', 'openai-api-key'])
      expect((await o2.try('POST', '/api/admin/credential-logins', { label: 'g', acknowledgedPlanNotice: true, password: OWNER_PW })).status).toBe(400)
    } finally { await h2.close() }
  })
})
