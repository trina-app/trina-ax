// The same token or key twice (Admin > AI connections, Settings > AI connections): the 409 says where the copy is to the
// owner and admins (they hold the secret they pasted) and to the person whose own connection it is, and only "already
// connected on this team" to other members. "Move it to the team": the owner's new team connection takes over a
// member's personal copy (no password, one transaction, the member told, Activity log). No part of a secret in any
// answer. Fake providers on 127.0.0.1 only.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { SealingKey } from '@mycel/shared/api'
import { sealSecret } from '../../web/src/lib/seal'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let answer = 200
const fake = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ ok: answer < 300 }, { status: answer }) })
const up = `http://127.0.0.1:${fake.port}`

// the test's own name last, so each secret's last 4 differ too
const CLAUDE = (s: string) => 'sk-ant-oat01-' + 'q'.repeat(30) + s
const AKEY = (s: string) => 'sk-ant-api03-' + 'w'.repeat(30) + s
const CANARIES: string[] = []

let h: Harness
let owner: Client
let admin: { client: Client; id: string }
let mia: { client: Client; id: string }
let nina: { client: Client; id: string }
let key: SealingKey
beforeAll(async () => {
  h = await harness('cred-dup', { engine: { authMode: 'managed', modelUpstreams: { anthropic: up, openai: up + '/v1' } } })
  // "No AI" leaves out an engine whose program is missing on the server: any existing file stands in for Claude Code
  // here, so the answer does not depend on the test machine (no turn runs in this file)
  h.ctx.engineConfig.claudeBin = process.execPath
  owner = await withOwner(h)
  admin = await addMember(h, owner, { username: 'adam', role: 'admin' })
  mia = await addMember(h, owner, { username: 'mia' })
  nina = await addMember(h, owner, { username: 'nina' })
  key = await owner.call('GET', '/api/credentials/sealing-key')
})
afterAll(async () => { await h?.close(); fake.stop(true) })
beforeEach(() => { answer = 200; h.ctx.db.query('DELETE FROM engine_credentials').run() })

const sealed = (secret: string) => { CANARIES.push(secret); return sealSecret(key, secret, 'credential.create') }
const team = async (secret: string, extra: Record<string, unknown> = {}) => owner.try('POST', '/api/admin/credentials', {
  kind: secret.startsWith('sk-ant-oat') ? 'anthropic-oauth' : 'anthropic-api-key', label: 'Team Max', sealed: await sealed(secret),
  ...(secret.startsWith('sk-ant-oat') ? { acknowledgedPlanNotice: true } : {}), ...extra,
})
const own = async (c: Client, secret: string, label = 'My Max') => c.try('POST', '/api/me/credentials', {
  kind: secret.startsWith('sk-ant-oat') ? 'anthropic-oauth' : 'anthropic-api-key', label, sealed: await sealed(secret), ...(secret.startsWith('sk-ant-oat') ? { acknowledgedPlanNotice: true } : {}),
})
const rows = () => h.ctx.db.query('SELECT id, owner_user_id, label FROM engine_credentials ORDER BY created_at').all() as { id: string; owner_user_id: string | null; label: string }[]
/** no secret in it; a 409 not even the last 4 that the list shows of an API key (o.hint) */
const noSecretIn = (x: unknown, o: { hint?: boolean } = {}) => {
  const s = JSON.stringify(x)
  for (const c of CANARIES) { expect(s).not.toContain(c); expect(s).not.toContain(c.slice(13, 40)); if (o.hint) expect(s).not.toContain(c.slice(-4)) }
}

describe('the 409 says where the copy is', () => {
  test("owner adding a team connection over a member's personal one: whose, which, and that it can be moved", async () => {
    const p = await own(mia.client, CLAUDE('mia1'), "Mia's Max")
    expect(p.status).toBe(201)
    const r = await team(CLAUDE('mia1'))
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('conflict')
    expect(r.body.error.params).toEqual({ reason: 'duplicate_credential', where: 'personal', credentialId: p.body.id, label: "Mia's Max", ownerId: mia.id, ownerName: 'MIA', movable: true })
    expect(r.body.error.message).toContain('MIA')
    expect(r.body.error.message).toContain("Mia's Max")
    noSecretIn(r.body, { hint: true })
  })
  test('an admin adding their own: they hold the secret, so they hear whose it is (not movable from there)', async () => {
    const p = await own(mia.client, AKEY('mia2'), 'Mia key')
    const r = await own(admin.client, AKEY('mia2'))
    expect(r.status).toBe(409)
    expect(r.body.error.params).toEqual({ reason: 'duplicate_credential', where: 'personal', credentialId: p.body.id, label: 'Mia key', ownerId: mia.id, ownerName: 'MIA' })
    noSecretIn(r.body, { hint: true })
  })
  test("a member adding someone else's: only \"already connected on this team\", never whose", async () => {
    await own(mia.client, AKEY('mia3'), 'Mia key')
    const r = await own(nina.client, AKEY('mia3'))
    expect(r.status).toBe(409)
    expect(r.body.error.params).toEqual({ reason: 'duplicate_credential', where: 'elsewhere' })
    expect(r.body.error.message).toBe('이 팀에 이미 연결된 토큰·키예요.')
    expect(JSON.stringify(r.body)).not.toContain('MIA')
    expect(JSON.stringify(r.body)).not.toContain('Mia key')
    // the same for a team connection: a member does not learn its name either
    await team(AKEY('team3'))
    const t = await own(nina.client, AKEY('team3'))
    expect(t.body.error.params).toEqual({ reason: 'duplicate_credential', where: 'elsewhere' })
    expect(JSON.stringify(t.body)).not.toContain('Team Max')
    noSecretIn([r.body, t.body], { hint: true })
  })
  test('a member adding their own again: which of their connections', async () => {
    const p = await own(mia.client, AKEY('mia4'), 'Mia key')
    const r = await own(mia.client, AKEY('mia4'))
    expect(r.body.error.params).toEqual({ reason: 'duplicate_credential', where: 'own', credentialId: p.body.id, label: 'Mia key' })
  })
  test('owner adding a team connection twice, or a new key that is already another team connection: its label, not movable', async () => {
    const first = await team(AKEY('team5'))
    const r = await team(AKEY('team5'))
    expect(r.body.error.params).toEqual({ reason: 'duplicate_credential', where: 'team', credentialId: first.body.id, label: 'Team Max' })
    expect(r.body.error.message).toContain("'Team Max'")
    const other = await team(AKEY('team5b'))
    const rep = await owner.try('POST', `/api/admin/credentials/${other.body.id}/secret`, { sealed: await sealSecret(key, AKEY('team5'), 'credential.replace') })
    expect(rep.status).toBe(409)
    expect(rep.body.error.params).toMatchObject({ where: 'team', credentialId: first.body.id })
    noSecretIn([r.body, rep.body], { hint: true })
  })
})

describe('Move it to the team', () => {
  test('needs no password (the re-sealed secret is the proof); a token the caller does not hold is still a 409; a member cannot move it; nothing changes', async () => {
    const p = await own(mia.client, CLAUDE('mv1'))
    // a move naming another personal connection than the one holding this token: 409 (the secret is what proves
    // possession, the id alone proves nothing), nothing changes
    const q = await own(mia.client, CLAUDE('mv1b'), 'Second')
    expect((await team(CLAUDE('mv1'), { moveFrom: q.body.id })).status).toBe(409)
    expect(rows().map((r) => r.id).sort()).toEqual([p.body.id, q.body.id].sort())
    // the same token without moveFrom stays a 409 that offers the move
    expect((await team(CLAUDE('mv1'))).status).toBe(409)
    // a member is refused by role, with or without moveFrom
    expect((await mia.client.try('POST', '/api/admin/credentials', { kind: 'anthropic-oauth', label: 'x', sealed: await sealed(CLAUDE('mv1')), acknowledgedPlanNotice: true, moveFrom: p.body.id })).status).toBe(403)
    expect(rows().map((r) => r.id).sort()).toEqual([p.body.id, q.body.id].sort())
    // an admin may move it, like the owner (their sealed copy of the token is the proof; no password)
    const moved = await admin.client.try('POST', '/api/admin/credentials', { kind: 'anthropic-oauth', label: 'Moved', sealed: await sealed(CLAUDE('mv1')), acknowledgedPlanNotice: true, moveFrom: p.body.id })
    expect(moved.status).toBe(201)
    expect(rows().map((r) => r.id)).not.toContain(p.body.id)
  })
  test('removes the personal copy and makes the team connection; the member is told; Activity log says so; no secret', async () => {
    const p = await own(mia.client, CLAUDE('mv2'), "Mia's Max")
    h.hub.events.length = 0
    const r = await team(CLAUDE('mv2'), { moveFrom: p.body.id, label: 'Team Max' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ scope: 'team', label: 'Team Max', owner: null })
    // exactly one copy, the team's
    expect(rows()).toEqual([{ id: r.body.id, owner_user_id: null, label: 'Team Max' }])
    expect((await mia.client.call('GET', '/api/me/credentials')).items).toEqual([])
    const notice = h.hub.events.find((e) => e.target === mia.id && (e.data as any)?.data?.code === 'credential_moved_to_team')
    expect(notice).toBeTruthy()
    expect((notice!.data as any).data.message).toContain("Mia's Max")
    expect((notice!.data as any).data.link).toBe('/settings/credentials')
    const entry = h.ctx.db.query("SELECT actor_id AS actor, target, detail FROM audit_log WHERE action = 'credential.move_to_team' ORDER BY rowid DESC LIMIT 1").get() as { actor: string; target: string; detail: string }
    expect(entry.target).toBe(r.body.id)
    expect(entry.actor).toBeTruthy()
    expect(JSON.parse(entry.detail)).toMatchObject({ scope: 'team', label: 'Team Max', from: { id: p.body.id, label: "Mia's Max", owner: mia.id } })
    const log = await owner.call('GET', '/api/admin/audit?limit=50')
    noSecretIn([r.body, notice, entry, log, await owner.call('GET', '/api/admin/credentials')])
  })
  test('moveFrom naming anything but the personal copy of this token stays a 409 and removes nothing', async () => {
    const p = await own(mia.client, AKEY('mv3'))
    const other = await own(nina.client, AKEY('mv3other'))
    const r = await team(AKEY('mv3'), { moveFrom: other.body.id })
    expect(r.status).toBe(409)
    expect(r.body.error.params).toMatchObject({ where: 'personal', credentialId: p.body.id, movable: true })
    const t = await team(AKEY('mv3team'))
    expect((await team(AKEY('mv3team'), { moveFrom: t.body.id })).body.error.params).toMatchObject({ where: 'team' })
    expect(rows().map((x) => x.id).sort()).toEqual([p.body.id, other.body.id, t.body.id].sort())
    // a member's own path has no moveFrom
    const m = await mia.client.try('POST', '/api/me/credentials', { kind: 'anthropic-api-key', label: 'x', sealed: await sealed(AKEY('mv3')), moveFrom: p.body.id })
    expect(m.status).toBe(409)
    expect(m.body.error.params.where).toBe('own')
  })
  test('the provider refuses the token: nothing moves (the personal copy stays, no team copy)', async () => {
    const p = await own(mia.client, CLAUDE('mv4'))
    answer = 401
    const r = await team(CLAUDE('mv4'), { moveFrom: p.body.id })
    expect(r.status).toBe(400)
    expect(rows().map((x) => x.id)).toEqual([p.body.id])
  })
})

describe('No AI in the members list', () => {
  test('GET /api/admin/users?noAi=1 names the active people with no AI connection they can use', async () => {
    const before = await admin.client.call('GET', '/api/admin/users?noAi=1')
    expect(new Set(before.noAi)).toEqual(new Set(before.items.map((u: any) => u.id)))
    // only when asked for (the other screens that list members do not pay for it)
    expect((await admin.client.call('GET', '/api/admin/users')).noAi).toBeUndefined()
    await own(mia.client, AKEY('noai'))
    expect((await owner.call('GET', '/api/admin/users?noAi=1')).noAi).not.toContain(mia.id)
    await team(AKEY('noai-team'))
    expect((await owner.call('GET', '/api/admin/users?noAi=1')).noAi).toEqual([])
    expect((await mia.client.try('GET', '/api/admin/users?noAi=1')).status).toBe(403)
  })
  test('noAiUntil: the people whom only a provider limit keeps from AI, with its end; empty when no wait helps', async () => {
    const plain = await admin.client.call('GET', '/api/admin/users?noAi=1')
    expect(plain.noAiUntil).toEqual({})
    expect((await admin.client.call('GET', '/api/admin/users')).noAiUntil).toBeUndefined()
    await team(AKEY('until-team'))
    const end = new Date(Date.now() + 2 * 86400_000).toISOString()
    h.ctx.db.query("UPDATE engine_credentials SET limited_until = ?, status_code = 'rate_limited'").run(end)
    const r = await admin.client.call('GET', '/api/admin/users?noAi=1')
    expect(new Set(r.noAi)).toEqual(new Set(r.items.map((u: any) => u.id)))
    expect(r.noAiUntil[mia.id]).toBe(end)
    expect(Object.keys(r.noAiUntil).sort()).toEqual([...r.noAi].sort())
  })
})
