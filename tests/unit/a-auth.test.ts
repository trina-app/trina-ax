// Component A: first-run setup, sign-in (cookie / bearer), CSRF, sessions, password change, rate limits.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { passwordProblem, temporaryPassword } from '../../server/src/auth/passwords'
import { weakPasswordMessage } from '../../server/src/auth/messages'
import { OWNER_PW, SETUP_TOKEN, addMember, harness, withOwner, type Client, type Harness } from './a-lib'

describe('first-run setup', () => {
  let h: Harness
  beforeAll(async () => {
    h = await harness('setup')
    fs.mkdirSync(h.ctx.config.dataDir, { recursive: true })
    fs.writeFileSync(path.join(h.ctx.config.dataDir, 'setup-token'), SETUP_TOKEN + '\n')
  })
  afterAll(() => h.close())

  test('status says setup is needed while no user exists', async () => {
    expect(await h.client().call('GET', '/api/setup')).toEqual({ needed: true, teamName: null, defaultLocale: 'en' })
  })
  test('wrong token and weak passwords are refused', async () => {
    const c = h.client()
    const owner = { username: 'olga', name: 'Olga', password: OWNER_PW }
    const bad = await c.try('POST', '/api/setup', { setupToken: 'x'.repeat(32), teamName: 'Acme', owner })
    expect(bad.status).toBe(403)
    // before setup there is no team default yet: English (a Korean page sends its language and gets Korean)
    expect(bad.body.error.message).toContain('setup token')
    const badKo = await c.try('POST', '/api/setup', { setupToken: 'x'.repeat(32), teamName: 'Acme', owner }, { 'x-mycel-locale': 'ko' })
    expect(badKo.body.error.message).toContain('설정 토큰')
    const weak = await c.try('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', owner: { ...owner, password: 'password123' } })
    expect(weak.status).toBe(400)
    expect(weak.body.error.fields['body.owner.password']).toContain('common')
    const noCsrf = await c.try('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', owner }, { 'x-mycel-csrf': '' })
    expect(noCsrf.status).toBe(403)
  })
  test('creates the owner, team settings, default folders and rules, and signs in with an HttpOnly cookie', async () => {
    const c = h.client()
    const res = await c.raw('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'en', owner: { username: 'Olga', name: 'Olga Owner', password: OWNER_PW } })
    expect(res.status).toBe(201)
    const cookie = res.headers.getSetCookie()[0]!
    expect(cookie).toMatch(/^mycel-dev-sid=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/)
    const body = (await res.json()) as any
    expect(body.token).toBeUndefined()
    expect(body.me.user).toMatchObject({ id: 'olga', username: 'Olga', role: 'owner', mustChangePassword: false })
    expect(body.me.team).toEqual({ name: 'Acme', defaultLocale: 'en' })
    const me = await c.call('GET', '/api/me')
    expect(me.user.id).toBe('olga')
    for (const d of ['shared', 'skills', 'groups', 'projects', 'users/olga']) expect(fs.statSync(path.join(h.ctx.files.fx.root, d)).isDirectory()).toBe(true)
    const folders = await c.call('GET', '/api/admin/folders')
    const rules = Object.fromEntries(folders.items.map((f: any) => [f.path, f.rules.map((r: any) => `${r.subjectType}:${r.subjectId}:${r.access}`).sort()]))
    expect(rules).toEqual({ shared: ['everyone:null:write'], skills: ['everyone:null:read', 'role:admin:write'] })
    expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'setup-token'))).toBe(false)
    expect(h.ctx.config.setupToken).toBeNull()
  })
  test('cannot run twice; status now shows the team', async () => {
    const r = await h.client().try('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Evil', owner: { username: 'mallory', name: 'M', password: OWNER_PW } })
    expect(r.status).toBe(409)
    expect(await h.client().call('GET', '/api/setup')).toEqual({ needed: false, teamName: null, defaultLocale: 'en' }) // round 4: no team name to anonymous visitors
  })
})

describe('sign-in and sessions', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('login'); owner = await withOwner(h) })
  afterAll(() => h.close())

  test('cookie sign-in: username is case-insensitive; wrong password gives one message for both cases', async () => {
    const c = h.client()
    const me = await c.login('OLGA', OWNER_PW)
    expect(me.me.user.id).toBe('olga')
    const wrong = await h.client().try('POST', '/api/auth/login', { username: 'olga', password: 'nope nope nope' })
    const unknown = await h.client().try('POST', '/api/auth/login', { username: 'nobody', password: 'nope nope nope' })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body.error.message).toBe(unknown.body.error.message)
  })
  test('https uses the __Host- cookie with Secure', async () => {
    const res = await h.fetch('/api/auth/login', { method: 'POST', base: 'https://acme.treesoop.com', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: JSON.stringify({ username: 'olga', password: OWNER_PW }) })
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-sid=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/)
    const sid = res.headers.getSetCookie()[0]!.split(';')[0]!
    const me = await h.fetch('/api/me', { base: 'https://acme.treesoop.com', headers: { cookie: sid } })
    expect(me.status).toBe(200)
  })
  test('bearer sign-in returns the token once, works without CSRF header; cookie requests need it', async () => {
    const app = h.client()
    const r = await app.call('POST', '/api/auth/login', { username: 'olga', password: OWNER_PW, tokenMode: 'bearer', client: 'mobile' })
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(app.lastHeaders!.getSetCookie()).toEqual([])
    expect((await app.call('GET', '/api/me')).session.client).toBe('mobile')
    expect((await app.try('PATCH', '/api/me', { name: 'Olga O' }, { 'x-mycel-csrf': '' })).status).toBe(200)
    const web = h.client()
    await web.login('olga', OWNER_PW)
    expect((await web.try('PATCH', '/api/me', { name: 'Olga O' }, { 'x-mycel-csrf': '' })).status).toBe(403)
    // tokens are stored hashed only
    const rows = h.ctx.db.query('SELECT token_hash FROM sessions').all() as { token_hash: string }[]
    expect(rows.some((x) => x.token_hash === r.token)).toBe(false)
    expect(rows.every((x) => /^[0-9a-f]{64}$/.test(x.token_hash))).toBe(true)
  })
  test('WebSocket bearer subprotocol resolves the session (mobile shells)', async () => {
    const app = h.client()
    const { token } = await app.call('POST', '/api/auth/login', { username: 'olga', password: OWNER_PW, tokenMode: 'bearer' })
    const auth = await h.auth.resolve(new Request('http://team.localhost/api/ws', { headers: { 'sec-websocket-protocol': `mycel.v1, mycel.bearer.${token}` } }), { ip: null, via: 'test' })
    expect(auth?.user.id).toBe('olga')
    expect(auth?.via).toBe('bearer')
  })
  test('logout ends only this session and clears the cookie', async () => {
    const a = h.client(), b = h.client()
    await a.login('olga', OWNER_PW)
    await b.login('olga', OWNER_PW)
    const sid = (await a.call('GET', '/api/me')).session.id
    const res = await a.raw('POST', '/api/auth/logout')
    expect(res.status).toBe(204)
    expect(res.headers.getSetCookie()[0]).toContain('Max-Age=0')
    expect(h.hub.events.some((e) => e.kind === 'disconnectSession' && e.target === sid)).toBe(true)
    expect((await a.try('GET', '/api/me')).status).toBe(401)
    expect((await b.try('GET', '/api/me')).status).toBe(200)
  })
  test('my sessions: list with current flag, revoke own device, never someone else\'s', async () => {
    const a = h.client(), b = h.client()
    await a.login('olga', OWNER_PW)
    await b.login('olga', OWNER_PW)
    const list = await a.call('GET', '/api/me/sessions')
    const mine = list.items.find((s: any) => s.current)
    const other = list.items.find((s: any) => !s.current)
    expect(mine && other).toBeTruthy()
    const bid = (await b.call('GET', '/api/me')).session.id
    await a.call('DELETE', `/api/me/sessions/${bid}`)
    expect((await b.try('GET', '/api/me')).status).toBe(401)
    const m = await addMember(h, owner, { username: 'mike' })
    const mikeSid = (await m.client.call('GET', '/api/me')).session.id
    expect((await a.try('DELETE', `/api/me/sessions/${mikeSid}`)).status).toBe(404)
    expect((await m.client.try('GET', '/api/me')).status).toBe(200)
  })
  test('expired sessions are refused and removed', async () => {
    const c = h.client()
    await c.login('olga', OWNER_PW)
    const sid = (await c.call('GET', '/api/me')).session.id
    h.ctx.db.query('UPDATE sessions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), sid)
    expect((await c.try('GET', '/api/me')).status).toBe(401)
    expect(h.ctx.db.query('SELECT 1 FROM sessions WHERE id = ?').get(sid)).toBeNull()
  })
  test('PATCH /api/me merges preferences', async () => {
    const c = h.client()
    await c.login('olga', OWNER_PW)
    await c.call('PATCH', '/api/me', { prefs: { theme: 'dark', engine: 'codex' } })
    const me = await c.call('PATCH', '/api/me', { prefs: { theme: 'light' }, locale: 'id' })
    expect(me.user.prefs).toEqual({ theme: 'light', engine: 'codex' })
    expect(me.user.locale).toBe('id')
  })
})

describe('password change and forced change', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('password'); owner = await withOwner(h) })
  afterAll(() => h.close())

  test('a new member must change the temporary password before anything else', async () => {
    const r = await owner.call('POST', '/api/admin/users', { username: 'nina', name: 'Nina', role: 'member' })
    expect(r.temporaryPassword).toMatch(/^[a-z]{4,7}[0-9]{4}$/)
    expect(r.user.mustChangePassword).toBe(true)
    const c = h.client()
    const login = await c.login('nina', r.temporaryPassword)
    expect(login.me.user.mustChangePassword).toBe(true)
    const blocked = await c.try('PATCH', '/api/me', { name: 'N' })
    expect(blocked.status).toBe(403)
    expect(blocked.body.error.code).toBe('password_change_required')
    expect((await c.try('GET', '/api/me')).status).toBe(200)
    const same = await c.try('POST', '/api/auth/password', { newPassword: r.temporaryPassword })
    expect(same.status).toBe(400)
    expect(same.body.error.fields['body.newPassword']).toBe('same as current')
    // right after signing in with the temporary password only the new one is needed
    await c.call('POST', '/api/auth/password', { newPassword: 'north star picks 9' })
    expect((await c.call('PATCH', '/api/me', { name: 'Nina K' })).user.name).toBe('Nina K')
  })
  test('changing the password ends every other session, keeps this one; the old password stops working', async () => {
    const m = await addMember(h, owner, { username: 'paul' })
    const other = h.client()
    await other.login('paul', m.password)
    const otherSid = (await other.call('GET', '/api/me')).session.id
    const wrong = await m.client.try('POST', '/api/auth/password', { currentPassword: 'not it at all', newPassword: 'purple new garden 99' })
    expect(wrong.status).toBe(403)
    const weak = await m.client.try('POST', '/api/auth/password', { currentPassword: m.password, newPassword: 'paul' })
    expect(weak.status).toBe(400)
    expect(weak.body.error.fields['body.newPassword']).toContain('8')
    // a normal session (not right after a temporary sign-in) must give the current password
    const noCurrent = await m.client.try('POST', '/api/auth/password', { newPassword: 'purple new garden 99' })
    expect(noCurrent.status).toBe(400)
    expect(noCurrent.body.error.fields['body.currentPassword']).toBe('required')
    h.hub.events = []
    await m.client.call('POST', '/api/auth/password', { currentPassword: m.password, newPassword: 'purple new garden 99' })
    expect((await m.client.try('GET', '/api/me')).status).toBe(200)
    expect((await other.try('GET', '/api/me')).status).toBe(401)
    expect(h.hub.events).toEqual([{ kind: 'disconnectSession', target: otherSid, data: 'password_changed' }])
    expect((await h.client().try('POST', '/api/auth/login', { username: 'paul', password: m.password })).status).toBe(401)
    await h.client().login('paul', 'purple new garden 99')
  })
  test('disabling an account ends its sessions now; sign-in then fails like a wrong password', async () => {
    const m = await addMember(h, owner, { username: 'dora' })
    h.hub.events = []
    await owner.call('PATCH', `/api/admin/users/${m.id}`, { status: 'disabled' })
    expect(h.hub.events).toContainEqual({ kind: 'disconnectUser', target: m.id, data: 'disabled' })
    expect((await m.client.try('GET', '/api/me')).status).toBe(401)
    const r = await h.client().try('POST', '/api/auth/login', { username: 'dora', password: m.password })
    expect(r.status).toBe(401)
    expect(r.body.error.message).toContain('아이디 또는 비밀번호')
  })
  test('password rule: 8-128 characters, not the username, not a common one; nothing else', () => {
    expect(passwordProblem('short12')).toBe('at least 8 characters')
    expect(passwordProblem('비밀번호하나둘')).toBe('at least 8 characters')
    expect(passwordProblem('x'.repeat(129))).toBe('at most 128 characters')
    expect(passwordProblem('x'.repeat(127) + 'y')).toBeNull()
    for (const pw of ['12345678', '123456789', '1234567890', '87654321', '23456789', '11111111', '00000000', 'aaaaaaaa', 'password', 'Password1', 'qwerty123', 'QWERTYUIOP', '1q2w3e4r', 'iloveyou', 'qwer1234'])
      expect(passwordProblem(pw), pw).toBe('this password is too common')
    expect(passwordProblem('kim2026k', { username: 'KIM2026K' })).toBe('must not be the username')
    // easy is fine now: no character classes, no "different characters" or repeat rules
    for (const pw of ['tiger427', 'exampleteam2026', 'abcabcab', 'kim20260', 'sunflower', '한국어비밀번호입니다']) expect(passwordProblem(pw, { username: 'kim' }), pw).toBeNull()
    expect(new Set(Array.from({ length: 50 }, temporaryPassword)).size).toBeGreaterThanOrEqual(49)
    for (let i = 0; i < 200; i++) {
      const t = temporaryPassword()
      expect(t).toMatch(/^[a-z]{4,7}[0-9]{4}$/)
      expect(passwordProblem(t)).toBeNull()
    }
  })
  test('weak password messages say why, in the person\'s language', () => {
    expect(weakPasswordMessage('must not be the username', 'ko')).toBe('더 안전한 비밀번호를 정해 주세요. 아이디와 같은 비밀번호는 쓸 수 없습니다.')
    expect(weakPasswordMessage('at least 8 characters', 'en')).toBe('Please choose a stronger password. Use at least 8 characters.')
    expect(weakPasswordMessage('at least 8 characters', 'ko')).toBe('더 안전한 비밀번호를 정해 주세요. 8자 이상이어야 합니다.')
    expect(weakPasswordMessage('something new', 'id')).toBe('Pilih kata sandi yang lebih kuat.')
    for (const pw of ['short', 'qwertyuiop', 'x'.repeat(200)]) expect(weakPasswordMessage(passwordProblem(pw)!, 'ko')).not.toBe('더 안전한 비밀번호를 정해 주세요.')
  })
})

describe('rate limits (per account and per real client IP)', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => {
    h = await harness('ratelimit')
    owner = await withOwner(h)
    await addMember(h, owner, { username: 'amy', password: 'apple orange tree 11' })
    await addMember(h, owner, { username: 'ben', password: 'blue ocean wave 22' })
  })
  afterAll(() => h.close())
  const attempt = (username: string, password: string, ip: string | null, via: 'direct' | 'relay' = 'direct', headers: Record<string, string> = {}) =>
    h.fetch('/api/auth/login', { method: 'POST', ip, via, headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1', ...headers }, body: JSON.stringify({ username, password }) })

  test('the account locks after 10 failures from any IPs, even for the right password; the window reopens it', async () => {
    for (let i = 0; i < DEFAULT_LIMITS.perAccount; i++) expect((await attempt('amy', 'wrong password!', `198.51.100.${i}`)).status).toBe(401)
    const locked = await attempt('amy', 'apple orange tree 11', '198.51.100.200')
    expect(locked.status).toBe(429)
    const body = (await locked.json()) as any
    expect(body.error.code).toBe('rate_limited')
    expect(body.error.retryAfter).toBeGreaterThan(0)
    expect(Number(locked.headers.get('retry-after'))).toBe(body.error.retryAfter)
    // other accounts are not affected
    expect((await attempt('ben', 'blue ocean wave 22', '198.51.100.200')).status).toBe(200)
    h.advance(DEFAULT_LIMITS.windowMs + 1000)
    expect((await attempt('amy', 'apple orange tree 11', '198.51.100.200')).status).toBe(200)
    // success cleared the account's failures
    expect((await attempt('amy', 'wrong password!', '198.51.100.9')).status).toBe(401)
    expect((await attempt('amy', 'apple orange tree 11', '198.51.100.9')).status).toBe(200)
  })
  test('one IP is limited across accounts; X-Forwarded-For / CF-Connecting-IP are ignored; other IPs still work', async () => {
    h.advance(DEFAULT_LIMITS.windowMs + 1000)
    for (let i = 0; i < DEFAULT_LIMITS.perIp; i++) {
      const r = await attempt(`ghost${i % 25}`, 'whatever pw 123', '203.0.113.5', 'direct', { 'x-forwarded-for': `192.0.2.${i}`, 'cf-connecting-ip': `192.0.2.${i}` })
      expect(r.status).toBe(401)
    }
    expect((await attempt('ben', 'blue ocean wave 22', '203.0.113.5', 'direct', { 'x-forwarded-for': '192.0.2.250' })).status).toBe(429)
    expect((await attempt('ben', 'blue ocean wave 22', '203.0.113.6')).status).toBe(200)
  })
  test('through the relay the IP comes from the OPEN metadata (ctx.appFetch env), not from headers', async () => {
    h.advance(DEFAULT_LIMITS.windowMs + 1000)
    const viaRelay = (ip: string, password: string) => h.ctx.appFetch(new Request('https://acme.treesoop.com/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ username: `relay-${Math.random()}`, password }),
    }), { ip, via: 'relay' })
    for (let i = 0; i < DEFAULT_LIMITS.perIp; i++) expect((await viaRelay('2001:db8::1', 'bad pw bad pw')).status).toBe(401)
    expect((await viaRelay('2001:db8::1', 'bad pw bad pw')).status).toBe(429)
    // an IPv6 client counts by its /64 (it can take any address in it): another address there is still limited,
    // another /64 is not
    expect((await viaRelay('2001:db8::2', 'bad pw bad pw')).status).toBe(429)
    expect((await viaRelay('2001:db8:0:1::2', 'bad pw bad pw')).status).toBe(401)
    const rows = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(rows.detail)).toEqual({ ip: '2001:db8:0:1::2', via: 'relay' })
  })
  test('unknown client IP: only the account limit applies', async () => {
    h.advance(DEFAULT_LIMITS.windowMs + 1000)
    for (let i = 0; i < DEFAULT_LIMITS.perIp + 5; i++) expect((await attempt(`nobody${i}`, 'whatever pw 123', null)).status).toBe(401)
    expect((await attempt('ben', 'blue ocean wave 22', null)).status).toBe(200)
    expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM login_attempts WHERE key LIKE 'ip:%' AND at > ?").get(h.auth.now() - 1000)).toEqual({ n: 0 })
  })
  test('password re-entry (owner-reauth) and current-password checks are limited per person', async () => {
    h.advance(DEFAULT_LIMITS.windowMs + 1000)
    const m = await addMember(h, owner, { username: 'cara', password: 'cloud forest path 33' })
    for (let i = 0; i < DEFAULT_LIMITS.perReauth; i++) {
      expect((await m.client.try('POST', '/api/auth/password', { currentPassword: 'wrong wrong', newPassword: 'cloud desert road 44' })).status).toBe(403)
    }
    const r = await m.client.try('POST', '/api/auth/password', { currentPassword: 'cloud forest path 33', newPassword: 'cloud desert road 44' })
    expect(r.status).toBe(429)
    expect(await h.auth.verifyPassword('olga', OWNER_PW, { ip: null, via: 'test' })).toBe(true)
  })
  test('failed sign-ins are audited with the real IP, never with the tried password', async () => {
    const rows = h.ctx.db.query("SELECT detail FROM audit_log WHERE action IN ('auth.login_failed','auth.rate_limited')").all() as { detail: string }[]
    expect(rows.length).toBeGreaterThan(10)
    for (const r of rows) expect(r.detail).not.toContain('password')
  })
  test('old attempts are swept', () => {
    h.advance(DEFAULT_LIMITS.windowMs + 1000)
    h.auth.limiter.sweep()
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM login_attempts').get()).toEqual({ n: 0 })
  })
})
