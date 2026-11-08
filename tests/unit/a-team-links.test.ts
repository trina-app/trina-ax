// Onboarding stream E: the team invite link (server/src/auth/team-links.ts, shared/src/api/team-links.ts). Create,
// re-show, replace and revoke; members only; uses, seats and expiry; the per-link rate limit; the token only in the
// #fragment and only sealed at rest; the skill deep link checked against the new member's access; the owners' inbox.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Plan, setPlanForTests } from '../../server/src/system/limits'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { joinNext } from '../../web/src/lib/team-link'
import { profilePrefill } from '@mycel/shared/api'

const PW = 'tulip meadow 2026'
const plan = (maxActiveMembers: number) => Plan.parse({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50, maxActiveMembers })
const tokenOf = (url: string) => new URL(url).hash.replace(/^#t=/, '')
const audits = (h: Harness, action: string) => h.ctx.db.query('SELECT actor_id, target, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { actor_id: string | null; target: string; detail: string }[]

function writeSkill(h: Harness, rel: string, name: string, title?: string) {
  const abs = path.join(h.ctx.config.teamRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `---\nname: ${name}\ndescription: Writes ad copy.\n${title ? `metadata:\n  title: ${title}\n` : ''}---\nWrite three lines of ad copy.\n`)
}

let h: Harness
let owner: Client
let admin: Client
let adminId: string
let n = 0
const fresh = () => `joiner${++n}`
const join = (token: string, o: Record<string, unknown> = {}, c = h.client({ ip: `10.9.0.${(n % 200) + 1}` })) =>
  c.try('POST', '/api/team-link/join', { token, username: fresh(), name: 'New Person', password: PW, ...o })
const info = (token: string) => h.client().try('POST', '/api/team-link/info', { token })

beforeAll(async () => {
  h = await harness('team-links')
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'adam', role: 'admin' })
  admin = a.client
  adminId = a.id
})
afterAll(async () => { await h.close() })
afterEach(() => { setPlanForTests(undefined); h.auth.limiter.limits = DEFAULT_LIMITS })

describe('make, show again, replace, revoke', () => {
  test('a new link: 14 days, members only, the token only after #, shown again with the same address', async () => {
    expect((await admin.call('GET', '/api/admin/team-link')).link).toBeNull()
    const r = await admin.call('POST', '/api/admin/team-link', {})
    const link = r.link
    const u = new URL(link.url)
    expect(u.origin).toBe('http://team.localhost')
    expect(u.pathname).toBe('/join')
    expect(u.search).toBe('')
    expect(u.hash).toMatch(/^#t=[A-Za-z0-9_-]{40,}$/)
    expect(Date.parse(link.expiresAt) - Date.parse(link.createdAt)).toBe(14 * 86_400_000)
    expect(link).toMatchObject({ state: 'active', uses: 0, maxUses: 20, groupIds: [], skill: null, createdBy: { id: adminId } })
    expect(r.seats).toEqual({ used: 2, limit: null })
    // shown again: the same address (sealed at rest, not a hash shown once)
    expect((await admin.call('GET', '/api/admin/team-link')).link.url).toBe(link.url)
    expect((await owner.call('GET', '/api/admin/team-link')).link.url).toBe(link.url)
    expect(await info(tokenOf(link.url))).toMatchObject({ status: 200, body: { teamName: 'Acme', valid: true, problem: null, skillName: null } })
    expect(audits(h, 'team_link.create').at(-1)).toMatchObject({ actor_id: adminId, target: link.id })
  })

  test('at rest: the token is sealed and hashed, never stored plain; a sealed copy on another row does not open', async () => {
    const { link } = await admin.call('POST', '/api/admin/team-link', { expiresInDays: 7 })
    const token = tokenOf(link.url)
    const row = h.ctx.db.query('SELECT token_hash, token_enc FROM team_links WHERE id = ?').get(link.id) as { token_hash: string; token_enc: string }
    expect(row.token_hash).toBe(crypto.createHash('sha256').update(token).digest('hex'))
    expect(row.token_enc).not.toContain(token)
    expect(Buffer.from(row.token_enc, 'base64').toString('latin1')).not.toContain(token)
    // the key lives with the secrets, outside the database
    const keyDir = path.join(path.dirname(h.ctx.config.dataDir), 'secrets', 'team-links')
    expect(fs.existsSync(path.join(keyDir, 'credentials.key'))).toBe(true)
    // the old link's sealed token copied onto the new link's row: it does not open there (AAD = the row), so the
    // admin is told to make a new link instead of being shown another link's address
    const next = (await admin.call('POST', '/api/admin/team-link', {})).link
    h.ctx.db.query('UPDATE team_links SET token_enc = ? WHERE id = ?').run(row.token_enc, next.id)
    expect((await admin.call('GET', '/api/admin/team-link')).link).toMatchObject({ id: next.id, url: null, state: 'active' })
  })

  test('a new link replaces the open one (one at a time); revoke ends it for good', async () => {
    const first = (await admin.call('POST', '/api/admin/team-link', {})).link
    const second = (await owner.call('POST', '/api/admin/team-link', { expiresInDays: 30 })).link
    expect(second.url).not.toBe(first.url)
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM team_links WHERE revoked_at IS NULL').get()).toEqual({ n: 1 })
    expect(Date.parse(second.expiresAt) - Date.parse(second.createdAt)).toBe(30 * 86_400_000)
    expect((await info(tokenOf(first.url))).body).toMatchObject({ valid: false, problem: 'revoked' })
    const late = await join(tokenOf(first.url))
    expect(late.status).toBe(410)
    expect(late.body.error.message).toContain('새 링크')
    expect(audits(h, 'team_link.create').at(-1)!.detail).toContain('"replaced":1')
    // revoke
    await owner.call('DELETE', '/api/admin/team-link')
    expect((await owner.call('GET', '/api/admin/team-link')).link).toBeNull()
    expect((await info(tokenOf(second.url))).body).toMatchObject({ valid: false, problem: 'revoked' })
    expect((await join(tokenOf(second.url))).status).toBe(410)
    // the revoked row keeps no sealed token
    expect(h.ctx.db.query('SELECT token_enc FROM team_links WHERE id = ?').get(second.id)).toEqual({ token_enc: null })
    expect(audits(h, 'team_link.revoke').at(-1)).toMatchObject({ target: second.id })
    expect((await owner.try('DELETE', '/api/admin/team-link')).status).toBe(404)
    // a new link after a revoke has a new token
    const third = (await admin.call('POST', '/api/admin/team-link', {})).link
    expect(third.url).not.toBe(second.url)
  })

  test('only owners and admins manage it; unknown groups are refused', async () => {
    const m = await addMember(h, owner, { username: 'mia' })
    expect((await m.client.try('GET', '/api/admin/team-link')).status).toBe(403)
    expect((await m.client.try('POST', '/api/admin/team-link', {})).status).toBe(403)
    expect((await admin.try('POST', '/api/admin/team-link', { groupIds: ['01890a5d-ac96-7000-8000-000000000000'] })).status).toBe(400)
    expect((await admin.try('POST', '/api/admin/team-link', { expiresInDays: 10 })).status).toBe(400)
  })
})

describe('joining', () => {
  test('always a member, in the link\'s groups, signed in; the form needs no password confirmation', async () => {
    const g = await owner.call('POST', '/api/admin/groups', { name: 'Marketing' })
    // a role in the request is ignored: the contract has no role, the table has no role column
    const { link } = await owner.call('POST', '/api/admin/team-link', { groupIds: [g.id], role: 'admin' })
    const c = h.client({ ip: '10.9.1.1' })
    const r = await c.try('POST', '/api/team-link/join', { token: tokenOf(link.url), username: 'nina', name: 'Nina', password: PW, role: 'admin' })
    expect(r.status).toBe(201)
    expect(r.body.me.user).toMatchObject({ username: 'nina', role: 'member' })
    expect(r.body.me.groups.map((x: any) => x.id)).toEqual([g.id])
    expect(r.body.next).toBeNull()
    expect(fs.existsSync(path.join(h.ctx.config.teamRoot, 'users', r.body.me.user.id))).toBe(true)
    expect((await c.call('GET', '/api/me')).user.role).toBe('member')
    const row = audits(h, 'team_link.join').at(-1)!
    expect(row).toMatchObject({ actor_id: r.body.me.user.id, target: link.id })
    expect(JSON.parse(row.detail)).toMatchObject({ role: 'member', groupIds: [g.id], uses: 1 })
    expect((await owner.call('GET', '/api/admin/team-link')).link.uses).toBe(1)
  })

  test('the usual checks: taken username, weak password, unknown token', async () => {
    const { link } = await owner.call('POST', '/api/admin/team-link', {})
    const t = tokenOf(link.url)
    expect((await join(t, { username: 'NINA' })).status).toBe(409)
    const weak = await join(t, { password: 'qwerty123' })
    expect(weak.status).toBe(400)
    expect(weak.body.error.fields).toHaveProperty(['body.password'])
    expect((await join('x'.repeat(43))).status).toBe(404)
    expect((await info('x'.repeat(43))).status).toBe(404)
    expect((await owner.call('GET', '/api/admin/team-link')).link.uses).toBe(0)
  })

  test('max uses: the last use is the last join, also with more joins at once than uses; then "used up"', async () => {
    const { link } = await owner.call('POST', '/api/admin/team-link', { maxUses: 2 })
    const t = tokenOf(link.url)
    // three at once for two uses: exactly two get in
    const all = await Promise.all([join(t), join(t), join(t)])
    expect(all.map((x) => x.status).sort()).toEqual([201, 201, 410])
    expect(all.find((x) => x.status === 410)!.body.error.params.reason).toBe('used_up')
    const third = await join(t)
    expect(third.status).toBe(410)
    expect(third.body.error.params.reason).toBe('used_up')
    expect((await info(t)).body).toMatchObject({ valid: false, problem: 'used_up' })
    expect((await owner.call('GET', '/api/admin/team-link')).link).toMatchObject({ uses: 2, maxUses: 2, state: 'used_up' })
  })

  test('expiry: after its days the link says so and lets nobody in', async () => {
    const { link } = await owner.call('POST', '/api/admin/team-link', { expiresInDays: 7 })
    h.advance(7 * 86_400_000 + 1000)
    try {
      expect((await info(tokenOf(link.url))).body).toMatchObject({ valid: false, problem: 'expired' })
      const r = await join(tokenOf(link.url))
      expect(r.status).toBe(410)
      expect(r.body.error.params.reason).toBe('expired')
      expect((await owner.call('GET', '/api/admin/team-link')).link.state).toBe('expired')
    } finally { h.advance(-(7 * 86_400_000 + 1000)) }
  })

  test('per-link rate limit: attempts from anywhere, right or wrong, count; the next one waits', async () => {
    h.auth.limiter.limits = { ...DEFAULT_LIMITS, perLink: 3 }
    const { link } = await owner.call('POST', '/api/admin/team-link', {})
    const t = tokenOf(link.url)
    // three different addresses: the per-IP limit is not what stops them
    for (let i = 0; i < 3; i++) expect((await join(t, { password: 'qwerty123' }, h.client({ ip: `10.7.0.${i + 1}` }))).status).toBe(400)
    const r = await join(t, {}, h.client({ ip: '10.7.0.9' }))
    expect(r.status).toBe(429)
    expect(Number(r.headers.get('retry-after') ?? r.body.error.retryAfter)).toBeGreaterThan(0)
    expect(audits(h, 'team_link.rate_limited').at(-1)).toMatchObject({ target: link.id })
    // the card says so: the link looks active but lets nobody in until then
    const shown = (await owner.call('GET', '/api/admin/team-link')).link
    expect(shown.state).toBe('active')
    expect(Date.parse(shown.limitedUntil) - Date.now()).toBeGreaterThan(60_000)
    // another link has its own counter
    const other = (await owner.call('POST', '/api/admin/team-link', {})).link
    expect(other.limitedUntil).toBeNull()
    expect((await join(tokenOf(other.url), {}, h.client({ ip: '10.7.0.10' }))).status).toBe(201)
  })

  test('per-link rate limit: joins that work do not count, so a big team joining at once is not turned away', async () => {
    h.auth.limiter.limits = { ...DEFAULT_LIMITS, perLink: 3 }
    const { link } = await owner.call('POST', '/api/admin/team-link', {})
    const t = tokenOf(link.url)
    for (let i = 0; i < 6; i++) expect((await join(t, {}, h.client({ ip: `10.6.0.${i + 1}` }))).status).toBe(201)
    expect((await owner.call('GET', '/api/admin/team-link')).link.uses).toBe(6)
  })

  test('the link ends for good when its maker can no longer invite; enabling them again does not bring it back', async () => {
    const ex = await addMember(h, owner, { username: 'ezra', role: 'admin' })
    const { link } = await ex.client.call('POST', '/api/admin/team-link', {})
    await owner.call('PATCH', `/api/admin/users/${ex.id}`, { status: 'disabled' })
    expect((await info(tokenOf(link.url))).body).toMatchObject({ valid: false, problem: 'revoked' })
    expect((await owner.call('GET', '/api/admin/team-link')).link).toBeNull()
    await owner.call('PATCH', `/api/admin/users/${ex.id}`, { status: 'active' })
    expect((await info(tokenOf(link.url))).body).toMatchObject({ valid: false, problem: 'revoked' })
    expect((await join(tokenOf(link.url))).status).toBe(410)
    // demoted to member: the same
    const ivy = await addMember(h, owner, { username: 'ivo', role: 'admin' })
    const second = (await ivy.client.call('POST', '/api/admin/team-link', {})).link
    await owner.call('PATCH', `/api/admin/users/${ivy.id}`, { role: 'member' })
    expect((await info(tokenOf(second.url))).body.problem).toBe('revoked')
  })

  test('the check at every use: a maker who lost the right by another way stops the link ("stopped")', async () => {
    const ex = await addMember(h, owner, { username: 'enzo', role: 'admin' })
    const { link } = await ex.client.call('POST', '/api/admin/team-link', {})
    // a change the admin screens never make (a damaged or edited database): the use-time check still holds
    h.ctx.db.query("UPDATE users SET role = 'member' WHERE id = ?").run(ex.id)
    expect((await info(tokenOf(link.url))).body).toMatchObject({ valid: false, problem: 'stopped' })
    expect((await join(tokenOf(link.url))).status).toBe(410)
    expect((await owner.call('GET', '/api/admin/team-link')).link.state).toBe('stopped')
    // it can still be turned off for good from the card
    await owner.call('DELETE', '/api/admin/team-link')
    expect((await info(tokenOf(link.url))).body.problem).toBe('revoked')
  })

  test('a restored database copy brings no open link back: it is revoked like unused invites', async () => {
    const { endSessions } = await import('../../server/src/system/backup')
    const { Database } = await import('bun:sqlite')
    const { link } = await owner.call('POST', '/api/admin/team-link', {})
    const copy = path.join(path.dirname(h.ctx.config.dataDir), 'restore-copy.db')
    fs.rmSync(copy, { force: true })
    h.ctx.db.run(`VACUUM INTO '${copy}'`)
    endSessions(copy)
    const db = new Database(copy)
    try {
      expect(db.query('SELECT COUNT(*) AS n FROM team_links WHERE revoked_at IS NULL OR token_enc IS NOT NULL').get()).toEqual({ n: 0 })
      expect(db.query('SELECT revoked_at IS NOT NULL AS r FROM team_links WHERE id = ?').get(link.id)).toEqual({ r: 1 })
    } finally { db.close(); fs.rmSync(copy, { force: true }) }
  })

  test('the owners and the link\'s maker hear about every join (metadata only, the name while the account is there)', async () => {
    const { link } = await admin.call('POST', '/api/admin/team-link', {})
    const r = await join(tokenOf(link.url), { name: 'Joy Joiner' })
    expect(r.status).toBe(201)
    for (const c of [owner, admin]) {
      const inbox = await c.call('GET', '/api/notifications')
      const item = inbox.items.find((x: any) => x.code === 'team.joined' && x.sourceId === r.body.me.user.id)
      expect(item).toMatchObject({ eventType: 'team.joined', link: null, joined: { name: 'Joy Joiner' } })
    }
    // the person who joined gets nothing about it
    const self = h.client({ ip: '10.9.3.3' })
    await self.login(r.body.me.user.username, PW)
    expect((await self.call('GET', '/api/notifications')).items.filter((x: any) => x.code === 'team.joined')).toEqual([])
  })
})

describe('seats', () => {
  test('default uses = seats left; never above the plan\'s limit; every join still takes a seat', async () => {
    await owner.call('DELETE', '/api/admin/team-link').catch(() => {})
    const used = (await owner.call('GET', '/api/admin/team-link')).seats.used
    setPlanForTests(plan(used + 2))
    const r = await owner.call('POST', '/api/admin/team-link', {})
    expect(r.seats).toEqual({ used, limit: used + 2 })
    expect(r.link.maxUses).toBe(2)
    const over = await owner.try('POST', '/api/admin/team-link', { maxUses: used + 3 })
    expect(over.status).toBe(409)
    expect(over.body.error.params.reason).toBe('max_uses_over_plan')
    // up to the plan's limit is allowed (disabled accounts free seats later)
    const wide = (await owner.call('POST', '/api/admin/team-link', { maxUses: used + 2 })).link
    const t = tokenOf(wide.url)
    expect((await join(t)).status).toBe(201)
    expect((await join(t)).status).toBe(201)
    // the seats are full: the link says so, a join is refused and uses nothing
    expect((await info(t)).body).toMatchObject({ valid: false, problem: 'full' })
    const full = await join(t)
    expect(full.status).toBe(409)
    expect(full.body.error.params.reason).toBe('seat_limit')
    expect((await owner.call('GET', '/api/admin/team-link')).link.uses).toBe(2)
    // no new link while every seat is taken
    expect((await owner.try('POST', '/api/admin/team-link', {})).body.error.params.reason).toBe('seat_limit')
  })
})

describe('skill deep link', () => {
  test('a readable team skill: the new member lands on its form; a skill new members cannot read is refused', async () => {
    setPlanForTests(null)
    writeSkill(h, 'skills/marketing/ad-copy/SKILL.md', 'ad-copy')
    const { link } = await owner.call('POST', '/api/admin/team-link', { skillPath: 'skills/marketing/ad-copy/SKILL.md' })
    // without a title, people read its name
    expect(link.skill).toEqual({ path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', title: 'ad-copy' })
    expect((await info(tokenOf(link.url))).body).toMatchObject({ skillName: 'ad-copy', skillTitle: 'ad-copy' })
    const r = await join(tokenOf(link.url))
    expect(r.status).toBe(201)
    expect(r.body.next).toBe(`/skills?run=${encodeURIComponent('skills/marketing/ad-copy/SKILL.md')}`)
    // not a skill, someone's personal skill, a missing file: refused
    for (const p of ['shared/x.md', `users/${adminId}/skills/mine/SKILL.md`, 'skills/nope/SKILL.md', '../etc/passwd']) {
      expect((await owner.try('POST', '/api/admin/team-link', { skillPath: p })).status).toBe(400)
    }
  })

  test('a skill with a title: the card and the join page name it by its title, the deep link still by its path', async () => {
    setPlanForTests(null)
    writeSkill(h, 'skills/marketing/ad-copy/SKILL.md', 'ad-copy', '광고 문구')
    const { link } = await owner.call('POST', '/api/admin/team-link', { skillPath: 'skills/marketing/ad-copy/SKILL.md' })
    expect(link.skill).toEqual({ path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', title: '광고 문구' })
    expect((await info(tokenOf(link.url))).body).toMatchObject({ skillName: 'ad-copy', skillTitle: '광고 문구' })
    expect((await join(tokenOf(link.url))).body.next).toBe(`/skills?run=${encodeURIComponent('skills/marketing/ad-copy/SKILL.md')}`)
  })

  test('the folder rules decide: a group-only skill needs that group on the link, and a lost right drops the deep link', async () => {
    const g = await owner.call('POST', '/api/admin/groups', { name: 'Sales' })
    const folder = await owner.call('POST', '/api/admin/folders', { path: 'skills/sales', rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'group', subjectId: g.id, access: 'read' }] })
    writeSkill(h, 'skills/sales/pitch/SKILL.md', 'pitch')
    const bad = await owner.try('POST', '/api/admin/team-link', { skillPath: 'skills/sales/pitch/SKILL.md' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.fields).toHaveProperty(['body.skillPath'])
    const { link } = await owner.call('POST', '/api/admin/team-link', { skillPath: 'skills/sales/pitch/SKILL.md', groupIds: [g.id] })
    expect((await info(tokenOf(link.url))).body.skillName).toBe('pitch')
    // the group loses the folder after the link was made: joining still works, but lands on Home
    await owner.call('PUT', `/api/admin/folders/${folder.id}/rules`, { rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }] })
    expect((await info(tokenOf(link.url))).body).toMatchObject({ skillName: null, skillTitle: null })
    const r = await join(tokenOf(link.url))
    expect(r.status).toBe(201)
    expect(r.body.next).toBeNull()
    expect((await owner.call('GET', '/api/admin/team-link')).link.skill).toEqual({ path: 'skills/sales/pitch/SKILL.md', name: 'pitch', title: 'pitch' })
  })

  test('a skill of a recommended pack (onboarding C): the new member lands on its form, and their own list carries it with its fields', async () => {
    setPlanForTests(null)
    expect((await owner.try('POST', '/api/onboarding/packs/work/install')).status).toBe(200)
    expect((await owner.try('PUT', '/api/onboarding/profile', { website: 'https://www.acme.example/', oneLine: '', products: 'Paper planners', audience: 'Small offices', tone: ['friendly'], avoid: '', sources: [] })).status).toBe(200)
    const skillPath = 'skills/work/humanizer/SKILL.md'
    const { link } = await owner.call('POST', '/api/admin/team-link', { skillPath })
    const c = h.client({ ip: '10.9.1.1' })
    const r = await join(tokenOf(link.url), { tokenMode: 'cookie' }, c)
    expect(r.status).toBe(201)
    // the address the join page goes to (web/src/lib/team-link.ts joinNext keeps exactly this one)
    const next = joinNext(r.body.next)
    expect(next).toBe(`/skills?run=${encodeURIComponent(skillPath)}`)
    const run = new URL(next, 'http://x').searchParams.get('run')
    // what the Skills page's form reads as that member: the skill by that path, with its fields, the only one of its
    // name (so "/humanizer" runs it), and the company profile for the fields that ask for it
    const items = (await c.call('GET', '/api/skills')).items as { path: string; name: string; inputs?: { name: string; prefill?: string }[] }[]
    const skill = items.find((s) => s.path === run)
    expect(skill?.name).toBe('humanizer')
    expect(skill!.inputs!.length).toBeGreaterThan(0)
    expect(items.filter((s) => s.name === skill!.name)).toHaveLength(1)
    const prefill = profilePrefill((await c.call('GET', '/api/onboarding/profile')).profile)
    for (const i of skill!.inputs!) if (i.prefill) expect(prefill[i.prefill], i.name).toBeTruthy()
  })
})

describe('the token never travels in a path or query', () => {
  test('no team-link endpoint takes it in a path or a query', async () => {
    const { listEndpoints } = await import('@mycel/shared/api')
    const eps = listEndpoints().filter((x) => /team-link/.test(x.ep.path))
    // make, show, change (PATCH), revoke, info, join
    expect(eps.length).toBe(6)
    for (const { name, ep } of eps) expect({ name, param: ep.path.includes(':'), query: !!ep.query }).toEqual({ name, param: false, query: false })
  })

  test('nothing the server logs while the link is made, read, shown and used holds the token', async () => {
    const { createLogger } = await import('../../server/src/log')
    const lines: string[] = []
    const lh = await harness('team-links-log', {}, { log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) })
    try {
      const o = await withOwner(lh)
      const { link } = await o.call('POST', '/api/admin/team-link', {})
      const t = tokenOf(link.url)
      await o.call('GET', '/api/admin/team-link')
      await lh.client().call('POST', '/api/team-link/info', { token: t })
      expect((await lh.client().try('POST', '/api/team-link/join', { token: t, username: 'lena', name: 'Lena', password: PW })).status).toBe(201)
      expect(lines.some((l) => l.includes('/api/team-link/join'))).toBe(true)
      expect(lines.filter((l) => l.includes(t))).toEqual([])
      const db = lh.ctx.db.query("SELECT detail FROM audit_log WHERE action LIKE 'team_link.%'").all() as { detail: string }[]
      expect(db.filter((r) => r.detail?.includes(t))).toEqual([])
    } finally { await lh.close() }
  })
})
