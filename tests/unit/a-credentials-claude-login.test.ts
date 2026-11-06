// Connecting a Claude subscription from the browser (docs/DECISIONS.md "Claude 구독 연결: 브라우저에서"): the server asks
// the real launcher to run `claude setup-token` (a stand-in with the 2.1.305 screen that refuses to run without a
// terminal, tests/lib/fake-claude-login.ts) on a pseudo-terminal in a one-off folder through the model proxy; the
// authorize address goes only to the person who started it; the code they paste back travels sealed (its own purpose)
// to the launcher, which types it in; the token comes back only on the launcher's socket and is checked and stored
// like a pasted one (count_tokens: 200 ok, 401 not saved, else saved "checked on the first question"). The folder is
// gone in every case, the token never appears in a log line, an audit entry, an event or a response; one sign-in at a
// time (either kind); a wrong code, a timeout and a cancel end it; the team's policies and the starter-only rule hold.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { API, type CredentialLogin, type SealingKey } from '@mycel/shared/api'
import { startHarness, testSessions, type Harness, type TestSocket } from '../lib/b-harness'
import { FAKE_CLAUDE_GOOD_CODE, FAKE_CLAUDE_TOKEN, FAKE_CLAUDE_URL } from '../lib/fake-claude-login'
import { credentialLogins, type LoginDeps } from '../../server/src/credentials/login'
import { credentialsOf, getRow, listRows, secretOf } from '../../server/src/credentials/store'
import { MEMBER_OWN_KEY } from '../../server/src/credentials/resolve'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { setSetting } from '../../server/src/admin/settings'
import { createLogger } from '../../server/src/log'
import type { SocketLauncher } from '../../server/src/native'
import { sealSecret } from '../../web/src/lib/seal'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
// where the model proxy's tunnels go: an echo server (nothing leaves this machine), and what was asked for
const echo = net.createServer((c) => c.on('data', (d) => c.write(d)).on('error', () => {}))
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
const dialed: string[] = []
const dial = (host: string, port: number) => { dialed.push(`${host}:${port}`); return net.connect((echo.address() as net.AddressInfo).port, '127.0.0.1') }
// the Anthropic the token is checked against (count_tokens), with its answer per test
let answer = 200
let answerDelayMs = 0
const checks: string[] = []
const anthropic = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  checks.push(`${new URL(req.url).pathname} ${req.headers.get('authorization') === `Bearer ${tokenNow}` ? 'token' : 'other'}`)
  if (answerDelayMs) await Bun.sleep(answerDelayMs)
  return Response.json({ input_tokens: 1 }, { status: answer })
} })
let tokenNow = FAKE_CLAUDE_TOKEN

// the "claude" the launcher runs: a wrapper that reads this test's settings, then the stand-in
const R = fs.mkdtempSync('/tmp/mycel-cl-')
const claudeBin = path.join(R, 'claude')
const envFile = path.join(R, 'login.env')
const setFake = (vars: Record<string, string>) => {
  tokenNow = vars.FAKE_CLAUDE_TOKEN ?? FAKE_CLAUDE_TOKEN
  fs.writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `export ${k}='${v}'`).join('\n') + '\n')
}
setFake({})
fs.writeFileSync(claudeBin, `#!/bin/sh\n. "${envFile}"\nexec "${process.execPath}" "${path.resolve(import.meta.dir, '../lib/fake-claude-login.ts')}" "$@"\n`, { mode: 0o755 })

const logLines: string[] = []
let h: Harness
let dana: TestSocket
let alice: TestSocket
let bob: TestSocket
let key: SealingKey
let launcherOff = false
const deps: LoginDeps = {
  async launcher() {
    if (launcherOff) return null
    const core = await h.ctx.core()
    return { sock: (core.launcher as SocketLauncher).path, bin: claudeBin, proxyPort: core.proxy!.port }
  },
}
const logins = () => credentialLogins(credentialsOf(h.ctx), deps)
const realVerify = testSessions.verifyPassword
const PW = (user: string) => `pw-${user}`
beforeAll(async () => {
  // the harness's sessions check no password; here each person's own is `pw-<id>` (the team's AI steps ask for it again)
  testSessions.verifyPassword = async (userId: string, pw: string) => pw === PW(userId)
  h = await startHarness({ name: 'a-cred-claude-login', allowCmds: [claudeBin], proxyDial: dial, credentials: [], upstreams: { anthropic: `http://127.0.0.1:${anthropic.port}` },
    log: createLogger({ level: 'debug', name: 'test', sink: (l) => logLines.push(l) }) })
  logins() // the sign-ins of this server use the stand-in above
  setSetting(h.ctx.db, MEMBER_OWN_KEY, true)
  setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, true)
  dana = await h.ws('dana', { windowId: 'win-dana-cl' }); await dana.next('hello')
  alice = await h.ws('alice', { windowId: 'win-alice-cl' }); await alice.next('hello')
  bob = await h.ws('bob', { windowId: 'win-bob-cl' }); await bob.next('hello')
  key = await h.api('dana').call(API.sealingKey)
})
afterAll(async () => { testSessions.verifyPassword = realVerify; dana?.close(); alice?.close(); bob?.close(); await h?.close(); echo.close(); anthropic.stop(true); fs.rmSync(R, { recursive: true, force: true }) })

const loginDir = () => path.join(h.ctx.engineConfig.agentRoot, '.claude-login')
const leftovers = () => (fs.existsSync(loginDir()) ? fs.readdirSync(loginDir()) : [])
const finished = ['done', 'failed', 'expired', 'cancelled']
const final = async (s: TestSocket, loginId: string) => (await s.next('credential.login', (f) => f.data.loginId === loginId && finished.includes(f.data.state), 30_000)).data as CredentialLogin
const waiting = async (s: TestSocket, loginId: string) => (await s.next('credential.login', (f) => f.data.loginId === loginId && f.data.state === 'code', 20_000)).data as CredentialLogin
const team = (label: string, extra: Record<string, unknown> = {}) => logins().start({ userId: 'dana', locale: 'en', personal: false, kind: 'anthropic-oauth', label, assignments: [], priority: 100, ...extra })
const sealedCode = (code: string, purpose: 'credential.login-code' | 'credential.create' = 'credential.login-code') => sealSecret(key, code, purpose)
const postCode = async (user: string, scope: 'admin' | 'me', loginId: string, code: string, purpose?: 'credential.login-code' | 'credential.create') =>
  h.req(user, `/api/${scope}/credential-logins/${loginId}/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sealed: await sealedCode(code, purpose) }) })
const everything = () => JSON.stringify({
  logs: logLines, audit: h.ctx.db.query('SELECT * FROM audit_log').all(), frames: [dana, alice, bob].map((s) => s.frames),
  rows: h.ctx.db.query('SELECT * FROM engine_credentials').all(),
})

describe('Claude sign-in for the team', () => {
  let id = ''
  test('the address reaches its starter only; the pasted code gives a verified connection; nothing stays behind', async () => {
    dialed.length = 0; checks.length = 0
    const start = await team('Team Claude')
    expect(start).toMatchObject({ kind: 'anthropic-oauth', state: 'starting', url: null, code: null })
    const w = await waiting(dana, start.loginId)
    expect(w).toMatchObject({ kind: 'anthropic-oauth', url: FAKE_CLAUDE_URL, code: null })
    expect(leftovers().length).toBe(1) // its folder exists while it runs
    // only the launcher's events: the program's own output never reaches the server
    const r = await postCode('dana', 'admin', start.loginId, `  ${FAKE_CLAUDE_GOOD_CODE}\n`)
    expect(r.status).toBe(200)
    expect(((await r.json()) as CredentialLogin).state).toBe('checking')
    const done = await final(dana, start.loginId)
    expect(done.state).toBe('done')
    expect(done.credential).toMatchObject({ kind: 'anthropic-oauth', label: 'Team Claude', scope: 'team', state: 'ok' })
    id = done.credential!.id
    const row = getRow(h.ctx.db, id)!
    expect(secretOf(credentialsOf(h.ctx), row as never)).toEqual({ token: FAKE_CLAUDE_TOKEN })
    expect(row.expires_at).not.toBeNull()
    // checked exactly like a pasted token: count_tokens with that token
    expect(checks).toEqual(['/v1/messages/count_tokens token'])
    // the exchange went through the proxy to platform.claude.com only; the profile lookup was refused without an
    // Activity log line; the one-time proxy token is dead now
    expect(dialed).toEqual(['platform.claude.com:443'])
    const refused = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'proxy.connect_refused'").all() as { detail: string }[]
    expect(refused.filter((x) => x.detail.includes('api.anthropic.com'))).toEqual([])
    const tok = h.ctx.db.query("SELECT revoked_at FROM proxy_tokens WHERE turn_id LIKE 'claude-login:%'").all() as { revoked_at: string | null }[]
    expect(tok.length).toBeGreaterThan(0); expect(tok.every((t) => t.revoked_at !== null)).toBe(true)
    expect(leftovers()).toEqual([])
    // nobody else saw it
    expect(alice.frames.some((f) => f.type === 'credential.login')).toBe(false)
    expect(bob.frames.some((f) => f.type === 'credential.login')).toBe(false)
    // audited (start, end, the new connection) without the token or the code; the token in no log line, event or row
    const audit = JSON.stringify(h.ctx.db.query("SELECT action, detail FROM audit_log WHERE action LIKE 'credential.%'").all())
    expect(audit).toContain('credential.login'); expect(audit).toContain('credential.create'); expect(audit).toContain('anthropic-oauth')
    const all = everything()
    for (const secret of [FAKE_CLAUDE_TOKEN, FAKE_CLAUDE_GOOD_CODE, 'good-code']) expect(all).not.toContain(secret)
  })

  test('a wrong code: failed, nothing stored, the folder gone', async () => {
    const before = listRows(h.ctx.db).length
    const s = await team('Wrong code')
    await waiting(dana, s.loginId)
    expect((await postCode('dana', 'admin', s.loginId, 'wrong-code#good-state')).status).toBe(200)
    expect(await final(dana, s.loginId)).toMatchObject({ state: 'failed', reason: 'bad_code' })
    expect(listRows(h.ctx.db).length).toBe(before)
    expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
  })

  test('the code: the right shape, sealed for this purpose, only once, only from its starter', async () => {
    const s = await team('Code rules')
    await waiting(dana, s.loginId)
    // not a code (no #, a space, a control key, anything token-shaped): 400, and the sign-in still waits
    for (const bad of ['no-hash-here', 'a b#c', 'abc#d\u001b[A', 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA#x']) {
      const r = await postCode('dana', 'admin', s.loginId, bad)
      expect(r.status).toBe(400)
    }
    // sealed for adding a connection, not for this: 400
    expect((await postCode('dana', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE, 'credential.create')).status).toBe(400)
    // another admin, or the members' path: they cannot reach this person's sign-in (only its starter can)
    expect((await postCode('carol', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(404)
    expect((await h.req('carol', `/api/admin/credential-logins/${s.loginId}`)).status).toBe(404)
    expect((await postCode('alice', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(403)
    expect((await postCode('alice', 'me', s.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(404)
    expect((await h.req('alice', `/api/me/credential-logins/${s.loginId}`)).status).toBe(404)
    expect(logins().get(s.loginId, 'dana').state).toBe('code')
    expect((await postCode('dana', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(200)
    // a second code while the first is checked: 409
    expect((await postCode('dana', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(409)
    // the same token as the first test: a new connection is refused as a duplicate, nothing stored twice
    expect(await final(dana, s.loginId)).toMatchObject({ state: 'failed', reason: 'duplicate' })
    expect(listRows(h.ctx.db).filter((r) => r.kind === 'anthropic-oauth').length).toBe(1)
  })

  test('Anthropic refuses the token (401): not saved; another answer: saved and checked on the first question', async () => {
    setFake({ FAKE_CLAUDE_TOKEN: 'sk-ant-oat01-' + 'refusedToken'.repeat(8) })
    answer = 401
    const s1 = await team('Refused')
    await waiting(dana, s1.loginId)
    await postCode('dana', 'admin', s1.loginId, FAKE_CLAUDE_GOOD_CODE)
    expect(await final(dana, s1.loginId)).toMatchObject({ state: 'failed', reason: 'refused' })
    expect(listRows(h.ctx.db).some((r) => r.label === 'Refused')).toBe(false)
    answer = 503
    const s2 = await team('Unverified')
    await waiting(dana, s2.loginId)
    await postCode('dana', 'admin', s2.loginId, FAKE_CLAUDE_GOOD_CODE)
    const d = await final(dana, s2.loginId)
    expect(d).toMatchObject({ state: 'done', credential: { label: 'Unverified', state: 'unverified' } })
    answer = 200
    setFake({})
  })

  test('reconnect: the same connection gets the new token; a connection of another kind is not reconnected here', async () => {
    const newer = 'sk-ant-oat01-' + 'reconnectedToken'.repeat(6)
    setFake({ FAKE_CLAUDE_TOKEN: newer })
    h.ctx.db.query("UPDATE engine_credentials SET status = 'invalid', status_code = 'upstream_401' WHERE id = ?").run(id)
    const s = await team('ignored', { reconnectId: id })
    await waiting(dana, s.loginId)
    await postCode('dana', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)
    const d = await final(dana, s.loginId)
    expect(d).toMatchObject({ state: 'done', credential: { id, label: 'Team Claude', state: 'ok' } })
    expect(getRow(h.ctx.db, id)).toMatchObject({ status: 'ok', status_code: null })
    expect(secretOf(credentialsOf(h.ctx), getRow(h.ctx.db, id) as never)).toEqual({ token: newer })
    expect(leftovers()).toEqual([])
    setFake({})
    const key2 = listRows(h.ctx.db).find((r) => r.kind !== 'anthropic-oauth')
    if (key2) {
      let e: unknown = null
      try { await team('x', { reconnectId: key2.id }) } catch (x) { e = x }
      expect((e as { code?: string }).code).toBe('not_found')
    }
  })

  test('one sign-in at a time (either kind); cancelling stops it and removes its folder', async () => {
    const s = await team('slow')
    await waiting(dana, s.loginId)
    expect(leftovers().length).toBe(1)
    for (const kind of ['anthropic-oauth', 'chatgpt'] as const) {
      let busy: unknown = null
      try { await logins().start({ userId: 'dana', locale: 'en', personal: false, kind, label: 'second', assignments: [], priority: 100 }) } catch (e) { busy = e }
      expect((busy as { code?: string }).code).toBe('busy')
    }
    expect((await h.req('dana', `/api/admin/credential-logins/${s.loginId}`, { method: 'DELETE' })).status).toBe(204)
    expect(await final(dana, s.loginId)).toMatchObject({ state: 'cancelled' })
    expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
    // a code after the cancel: 409
    expect((await postCode('dana', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(409)
    expect(listRows(h.ctx.db).some((r) => r.label === 'slow')).toBe(false)
  })

  test('nobody approves in time: expired, the folder gone', async () => {
    deps.timeoutMs = 2500
    try {
      const s = await team('late')
      expect(Date.parse(s.expiresAt) - Date.now()).toBeLessThan(3000)
      await waiting(dana, s.loginId)
      expect(await final(dana, s.loginId)).toMatchObject({ state: 'expired', reason: 'timeout' })
      expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
    } finally { delete deps.timeoutMs }
  })

  test('no token and no known error after the code: exchange_failed after the wait, not "checking" for 16 minutes', async () => {
    setFake({ FAKE_CLAUDE_HANG: '1' })
    deps.exchangeTimeoutMs = 1500
    try {
      const s = await team('hangs')
      await waiting(dana, s.loginId)
      const t0 = Date.now()
      expect((await postCode('dana', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(200)
      expect(await final(dana, s.loginId)).toMatchObject({ state: 'failed', reason: 'exchange_failed' })
      expect(Date.now() - t0).toBeLessThan(10_000)
      expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
    } finally { delete deps.exchangeTimeoutMs; setFake({}) }
  })

  test('a success screen the launcher does not know: its own reason, the screen in the log masked, the token nowhere', async () => {
    const odd = 'sk-ant-oat01-' + 'unreadableToken'.repeat(6)
    setFake({ FAKE_CLAUDE_ODD: '1', FAKE_CLAUDE_TOKEN: odd })
    try {
      const before = listRows(h.ctx.db).length
      const s = await team('Odd screen')
      await waiting(dana, s.loginId)
      await postCode('dana', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)
      expect(await final(dana, s.loginId)).toMatchObject({ state: 'failed', reason: 'token_unreadable' })
      expect(listRows(h.ctx.db).length).toBe(before)
      const line = logLines.find((l) => l.includes('token_unreadable'))
      expect(line).toBeDefined()
      expect(line).toContain('Token: sk-ant-[masked')
      expect(everything()).not.toContain(odd)
      expect(everything()).not.toContain('unreadableTokenunreadable')
      expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
    } finally { setFake({}) }
  })

  test('a code the launcher does not type ends the sign-in (code_refused), never "checking"', async () => {
    const s = await team('refused code')
    await waiting(dana, s.loginId)
    logins().all.get(s.loginId)!.sendCode('not a code') // past the server's own check: the launcher refuses it
    expect(await final(dana, s.loginId)).toMatchObject({ state: 'failed', reason: 'code_refused' })
    expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
  })

  test('a cancel while the token is being checked and saved: 409, and the connection is made', async () => {
    setFake({ FAKE_CLAUDE_TOKEN: 'sk-ant-oat01-' + 'storingToken'.repeat(8) })
    answerDelayMs = 2500
    try {
      const s = await team('Stored anyway')
      await waiting(dana, s.loginId)
      await postCode('dana', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)
      expect(await waitFor(() => logins().all.get(s.loginId)?.storing === true, { timeoutMs: 15_000 })).toBe(true)
      const r = await h.req('dana', `/api/admin/credential-logins/${s.loginId}`, { method: 'DELETE' })
      expect(r.status).toBe(409)
      expect(((await r.json()) as { error: { message: string } }).error.message).toContain('저장하는 중') // dana reads Korean
      expect(await final(dana, s.loginId)).toMatchObject({ state: 'done', credential: { label: 'Stored anyway' } })
    } finally { answerDelayMs = 0; setFake({}) }
  })

  test('another site\'s address is never shown: the sign-in fails', async () => {
    setFake({ FAKE_CLAUDE_URL: FAKE_CLAUDE_URL.replace('https://claude.com/', 'https://claude.com.evil.example/') })
    const s = await team('evil')
    const f = await final(dana, s.loginId)
    expect(f).toMatchObject({ state: 'failed', reason: 'unexpected_url', url: null })
    expect(dana.frames.some((x) => x.type === 'credential.login' && JSON.stringify(x.data).includes('evil.example'))).toBe(false)
    setFake({})
  })
})

describe('the policies of a sign-in', () => {
  test('sharing off (team) / personal connections off (a member): 403; the kind off on this server: 400; no launcher: 503', async () => {
    const tryStart = async (o: Record<string, unknown>) => { try { await logins().start({ userId: 'dana', locale: 'en', personal: false, kind: 'anthropic-oauth', label: 'p', assignments: [], priority: 100, ...o }); return null } catch (e) { return (e as { code?: string }).code } }
    setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, false)
    try { expect(await tryStart({})).toBe('forbidden') } finally { setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, true) }
    setSetting(h.ctx.db, MEMBER_OWN_KEY, false)
    try {
      expect(await tryStart({ userId: 'alice', personal: true })).toBe('forbidden')
      const r = await h.req('alice', '/api/me/credential-logins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'anthropic-oauth', label: 'x', acknowledgedPlanNotice: true }) })
      expect(r.status).toBe(403)
    } finally { setSetting(h.ctx.db, MEMBER_OWN_KEY, true) }
    const kinds = credentialsOf(h.ctx).allowedKinds
    kinds.delete('anthropic-oauth')
    try { expect(await tryStart({})).toBe('validation') } finally { kinds.add('anthropic-oauth') }
    launcherOff = true
    try { expect(await tryStart({})).toBe('engine_unavailable') } finally { launcherOff = false }
    // the plan notice is required for this kind too
    expect((await h.req('alice', '/api/me/credential-logins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'anthropic-oauth', label: 'x' }) })).status).toBe(400)
    expect(leftovers()).toEqual([])
  })
})

describe('a member\'s own Claude sign-in over HTTP', () => {
  test('202 with the state; only its starter can read, send a code or cancel; the connection is personal', async () => {
    setFake({ FAKE_CLAUDE_TOKEN: 'sk-ant-oat01-' + 'aliceOwnToken'.repeat(7) })
    const r = await h.api('alice').call(API.startMyCredentialLogin, { body: { kind: 'anthropic-oauth', label: 'Alice Claude', acknowledgedPlanNotice: true } })
    expect(r).toMatchObject({ kind: 'anthropic-oauth', state: 'starting' })
    await waiting(alice, r.loginId)
    expect((await h.req('bob', `/api/me/credential-logins/${r.loginId}`)).status).toBe(404)
    expect((await postCode('bob', 'me', r.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(404)
    expect((await h.req('bob', `/api/me/credential-logins/${r.loginId}`, { method: 'DELETE' })).status).toBe(404)
    expect((await postCode('alice', 'me', r.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(200)
    const d = await final(alice, r.loginId)
    expect(d.state).toBe('done')
    expect(d.credential).toMatchObject({ kind: 'anthropic-oauth', scope: 'personal', owner: { id: 'alice' } })
    expect((await h.api('alice').call(API.getMyCredentialLogin, { params: { id: r.loginId } })).state).toBe('done')
    expect(bob.frames.some((f) => f.type === 'credential.login')).toBe(false)
    expect(everything()).not.toContain(tokenNow)
    setFake({})
  })
  test('the team turns personal connections off during a member\'s reconnect: nothing stored', async () => {
    const own = listRows(h.ctx.db).find((r) => r.owner_user_id === 'alice' && r.kind === 'anthropic-oauth')!
    const before = secretOf(credentialsOf(h.ctx), own as never)
    setFake({ FAKE_CLAUDE_TOKEN: 'sk-ant-oat01-' + 'aliceNewerToken'.repeat(6) })
    const r = await h.api('alice').call(API.startMyCredentialLogin, { body: { kind: 'anthropic-oauth', label: 'x', reconnectId: own.id, acknowledgedPlanNotice: true } })
    await waiting(alice, r.loginId)
    setSetting(h.ctx.db, MEMBER_OWN_KEY, false)
    try {
      expect((await postCode('alice', 'me', r.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(200)
      expect(await final(alice, r.loginId)).toMatchObject({ state: 'failed', reason: 'policy_changed' })
      expect(secretOf(credentialsOf(h.ctx), getRow(h.ctx.db, own.id) as never)).toEqual(before)
    } finally { setSetting(h.ctx.db, MEMBER_OWN_KEY, true); setFake({}) }
  })
})

describe('Claude sign-in started by an admin', () => {
  let carol: TestSocket
  beforeAll(async () => { carol = await h.ws('carol', { windowId: 'win-carol-cl' }); await carol.next('hello') })
  afterAll(() => carol?.close())
  const adminToken = 'sk-ant-oat01-' + 'carolAdminToken'.repeat(6)
  const json = { 'content-type': 'application/json' }
  const startOver = (user: string, password: string, label = 'Carol Claude') => h.req(user, '/api/admin/credential-logins', { method: 'POST', headers: json, body: JSON.stringify({ kind: 'anthropic-oauth', label, assignments: [], priority: 100, acknowledgedPlanNotice: true, password }) })
  const setRole = (id: string, role: string) => h.ctx.db.query('UPDATE users SET role = ? WHERE id = ?').run(role, id)

  test('end to end over HTTP with the admin\'s own password: the address and the state go to the admin who started it, not to the owner; the owner is told', async () => {
    setFake({ FAKE_CLAUDE_TOKEN: adminToken })
    try {
      const ownerFramesBefore = dana.frames.length
      // the password again is the admin's own: none, a wrong one and the owner's typed by her are refused; a member is refused anyway
      expect((await startOver('carol', 'not-her-password')).status).toBe(403)
      expect((await startOver('carol', PW('dana'))).status).toBe(403)
      expect((await startOver('alice', PW('alice'))).status).toBe(403)
      const none = await h.req('carol', '/api/admin/credential-logins', { method: 'POST', headers: json, body: JSON.stringify({ kind: 'anthropic-oauth', label: 'x', assignments: [], priority: 100, acknowledgedPlanNotice: true }) })
      expect(none.status).toBe(400)
      expect(leftovers()).toEqual([])
      const started = await startOver('carol', PW('carol'))
      expect(started.status).toBe(202)
      const s = (await started.json()) as CredentialLogin
      const w = await waiting(carol, s.loginId)
      expect(w).toMatchObject({ kind: 'anthropic-oauth', url: FAKE_CLAUDE_URL })
      // the owner cannot read or answer an admin's sign-in, and does not see its frames
      expect((await h.req('dana', `/api/admin/credential-logins/${s.loginId}`)).status).toBe(404)
      expect((await postCode('dana', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(404)
      // a team sign-in is not reachable through the members' door, not even by its starter
      expect((await h.req('carol', `/api/me/credential-logins/${s.loginId}`)).status).toBe(404)
      expect((await postCode('carol', 'me', s.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(404)
      // the admin reads it (GET), pastes the code (sealed), and the connection is stored for the team
      expect((await h.req('carol', `/api/admin/credential-logins/${s.loginId}`)).status).toBe(200)
      const r = await postCode('carol', 'admin', s.loginId, FAKE_CLAUDE_GOOD_CODE)
      expect(r.status).toBe(200)
      const done = await final(carol, s.loginId)
      expect(done.state).toBe('done')
      expect(done.credential).toMatchObject({ kind: 'anthropic-oauth', label: 'Carol Claude', scope: 'team', state: 'ok' })
      expect(getRow(h.ctx.db, done.credential!.id)!.created_by).toBe('carol')
      expect(dana.frames.slice(ownerFramesBefore).some((f) => f.type === 'credential.login')).toBe(false)
      // the owner got a short notice, live and in the inbox: who and what, never the token
      const notice = await dana.next('notice', (f) => f.data.code === 'credential_admin_change', 10_000)
      expect(notice.data.message).toContain('Carol Park')
      expect(notice.data.message).toContain('Carol Claude')
      const inbox = ((await (await h.req('dana', '/api/notifications')).json()) as { items: { eventType: string; credentialChange?: { who: string; action: string; subject: string } }[] }).items
      expect(inbox.find((i) => i.eventType === 'credential.change')?.credentialChange).toEqual({ who: 'Carol Park', action: 'added', subject: 'Carol Claude' })
      expect(JSON.stringify(dana.frames)).not.toContain(adminToken)
      expect(JSON.stringify(inbox)).not.toContain(adminToken)
      expect(everything()).not.toContain(adminToken)
      expect(leftovers()).toEqual([])
    } finally { setFake({}) }
  })

  test('a start while one runs: the owner or an admin is told whose it is (and can stop it); a member is not; the owner or an admin stops any, a member\'s own too (and the member is told)', async () => {
    const s = await team('Forgotten', { userId: 'carol' })
    await waiting(carol, s.loginId)
    // one at a time: the owner starting hears whose it is, its kind and how to stop it; a member hears only that it is busy
    const busy = await startOver('dana', PW('dana'), 'Owner wants it')
    expect(busy.status).toBe(409)
    expect(((await busy.json()) as { error: { code: string; params?: unknown } }).error).toMatchObject({ code: 'busy', params: { reason: 'login_busy', loginId: s.loginId, personal: false, starter: 'Carol Park' } })
    const own409 = await h.req('alice', '/api/me/credential-logins', { method: 'POST', headers: json, body: JSON.stringify({ kind: 'anthropic-oauth', label: 'mine', acknowledgedPlanNotice: true }) })
    expect(own409.status).toBe(409)
    expect(((await own409.json()) as { error: { params?: unknown } }).error.params).toBeUndefined()
    expect((await h.req('alice', `/api/admin/credential-logins/${s.loginId}`, { method: 'DELETE' })).status).toBe(403)
    expect((await h.req('dana', `/api/admin/credential-logins/${s.loginId}`, { method: 'DELETE' })).status).toBe(204)
    expect((await final(carol, s.loginId)).state).toBe('cancelled')
    const a = h.ctx.db.query("SELECT actor_id FROM audit_log WHERE action = 'credential.login_cancel' AND target = ?").get(s.loginId) as { actor_id: string }
    expect(a.actor_id).toBe('dana')
    expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
    // a member's own sign-in that is in the way: an admin hears it is a personal one and whose, and may stop it; the member is told
    const own = await h.api('alice').call(API.startMyCredentialLogin, { body: { kind: 'anthropic-oauth', label: 'mine', acknowledgedPlanNotice: true } })
    await waiting(alice, own.loginId)
    const busy2 = await startOver('carol', PW('carol'), 'Carol wants it')
    expect(((await busy2.json()) as { error: { params?: unknown } }).error.params).toMatchObject({ reason: 'login_busy', loginId: own.loginId, personal: true, starter: 'Alice Kim' })
    expect((await h.req('bob', `/api/me/credential-logins/${own.loginId}`, { method: 'DELETE' })).status).toBe(404)
    expect((await h.req('carol', `/api/admin/credential-logins/${own.loginId}`, { method: 'DELETE' })).status).toBe(204)
    expect((await final(alice, own.loginId)).state).toBe('cancelled')
    const told = await alice.next('notice', (f) => f.data.code === 'credential_admin_change', 10_000)
    expect(told.data.message).toContain('Carol Park')
    const mine = ((await (await h.req('alice', '/api/notifications')).json()) as { items: { eventType: string; credentialChange?: { action: string; who: string; subject: string } }[] }).items
    expect(mine.find((i) => i.eventType === 'credential.change')?.credentialChange).toEqual({ who: 'Carol Park', action: 'personal_login_stopped', subject: 'mine' })
    expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
  })

  test('who may stop whose personal sign-in: the owner anyone\'s, an admin a member\'s, nobody the owner\'s or an admin\'s but the owner; a stop that does not happen (saving its token) is not recorded or told', async () => {
    const setRole = (id: string, role: string) => h.ctx.db.query('UPDATE users SET role = ? WHERE id = ?').run(role, id)
    const stop = (user: string, id: string) => h.req(user, `/api/admin/credential-logins/${id}`, { method: 'DELETE' })
    const stopped = (id: string) => (h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'credential.login_cancel' AND target = ?").get(id) as { n: number }).n
    const notices = () => (h.ctx.db.query("SELECT COUNT(*) AS n FROM credential_change_notices WHERE action = 'personal_login_stopped'").get() as { n: number }).n
    try {
      // an admin\'s own sign-in (alice is made an admin for this): another admin may not stop it, the owner may
      setRole('alice', 'admin')
      const adminsOwn = await logins().start({ userId: 'alice', locale: 'en', personal: true, kind: 'anthropic-oauth', label: 'admins own', assignments: [], priority: 100 })
      await waiting(alice, adminsOwn.loginId)
      expect((await stop('carol', adminsOwn.loginId)).status).toBe(403)
      expect(stopped(adminsOwn.loginId)).toBe(0)
      // while it is saving its token, even the owner\'s stop does not happen: 409, nothing recorded, nothing told
      const l = logins().all.get(adminsOwn.loginId)!
      l.storing = true
      const before = notices()
      expect((await stop('dana', adminsOwn.loginId)).status).toBe(409)
      expect(stopped(adminsOwn.loginId)).toBe(0)
      expect(notices()).toBe(before)
      l.storing = false
      expect((await stop('dana', adminsOwn.loginId)).status).toBe(204)
      expect(stopped(adminsOwn.loginId)).toBe(1)
      await final(alice, adminsOwn.loginId)
      expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
      setRole('alice', 'member')
      // the owner\'s own: an admin may not stop it
      const ownersOwn = await logins().start({ userId: 'dana', locale: 'en', personal: true, kind: 'anthropic-oauth', label: 'owners own', assignments: [], priority: 100 })
      await waiting(dana, ownersOwn.loginId)
      expect((await stop('carol', ownersOwn.loginId)).status).toBe(403)
      expect(stopped(ownersOwn.loginId)).toBe(0)
      expect((await h.req('dana', `/api/me/credential-logins/${ownersOwn.loginId}`, { method: 'DELETE' })).status).toBe(204)
      await final(dana, ownersOwn.loginId)
      expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
    } finally { setRole('alice', 'member') }
  })

  test('an admin made a member (or disabled) while signing in: the sign-in is stopped, and one already past the code stores nothing', async () => {
    try {
      // demoted by the owner (the real route) while it waits for the code: stopped now
      const s = await team('Demoted', { userId: 'carol' })
      await waiting(carol, s.loginId)
      expect((await h.req('dana', '/api/admin/users/carol', { method: 'PATCH', headers: json, body: JSON.stringify({ role: 'member' }) })).status).toBe(200)
      expect(logins().all.get(s.loginId)!.state).toBe('cancelled')
      expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
      setRole('carol', 'admin')
      // the code was already sent when the role went: the store step looks again and keeps nothing
      setFake({ FAKE_CLAUDE_TOKEN: 'sk-ant-oat01-' + 'demotedLate'.repeat(8) })
      const before = listRows(h.ctx.db).length
      const late = await team('Demoted late', { userId: 'carol' })
      await waiting(carol, late.loginId)
      expect((await postCode('carol', 'admin', late.loginId, FAKE_CLAUDE_GOOD_CODE)).status).toBe(200)
      setRole('carol', 'member')
      expect(await final(carol, late.loginId)).toMatchObject({ state: 'failed', reason: 'policy_changed' })
      expect(listRows(h.ctx.db).length).toBe(before)
      setRole('carol', 'admin')
      // disabled: every running sign-in of theirs ends, their own personal one too
      const again = await team('Disabled', { userId: 'carol' })
      await waiting(carol, again.loginId)
      expect((await h.req('dana', '/api/admin/users/carol', { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'disabled' }) })).status).toBe(200)
      expect(logins().all.get(again.loginId)!.state).toBe('cancelled')
      expect((await h.req('dana', '/api/admin/users/carol', { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'active' }) })).status).toBe(200)
    } finally { setRole('carol', 'admin'); setFake({}) }
  })

  test('a member deleted while signing in: the sign-in ends with the account', async () => {
    const made = await h.req('dana', '/api/admin/users', { method: 'POST', headers: json, body: JSON.stringify({ username: 'zed', name: 'Zed', role: 'member', groupIds: [] }) })
    expect(made.status).toBe(201)
    const zed = ((await made.json()) as { user: { id: string } }).user.id
    const l = await logins().start({ userId: zed, locale: 'en', personal: true, kind: 'anthropic-oauth', label: 'zed own', assignments: [], priority: 100 })
    expect(await waitFor(() => logins().all.get(l.loginId)?.state === 'code', { timeoutMs: 20_000 })).toBe(true)
    expect(logins().all.get(l.loginId)!.endedAt).toBeNull()
    expect((await h.req('dana', `/api/admin/users/${zed}?personalFolder=delete`, { method: 'DELETE' })).status).toBe(204)
    expect(logins().all.get(l.loginId)!.state).toBe('cancelled')
    expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
  })

  test('a ChatGPT team sign-in also looks at its starter\'s role when it stores (a member, a disabled admin: refused)', () => {
    const store = (userId: string) => (logins() as unknown as { storeChatgpt(l: unknown, json: string): { ok: boolean; reason?: string } }).storeChatgpt({ userId, personal: false, label: 'x', assignments: [], priority: 100, reconnectId: null }, '{}')
    expect(store('alice')).toEqual({ ok: false, reason: 'policy_changed' })
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'carol'").run()
    try { expect(store('carol')).toEqual({ ok: false, reason: 'policy_changed' }) } finally { h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'carol'").run() }
    // a personal sign-in of a disabled or deleted account stores nothing either
    const mine = (userId: string) => (logins() as unknown as { storeChatgpt(l: unknown, json: string): { ok: boolean; reason?: string } }).storeChatgpt({ userId, personal: true, label: 'x', assignments: [], priority: 100, reconnectId: null }, '{}')
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'alice'").run()
    try { expect(mine('alice')).toEqual({ ok: false, reason: 'policy_changed' }) } finally { h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'alice'").run() }
    expect(mine('alice')).toEqual({ ok: false, reason: 'incomplete' })
    // an active admin gets past the role check (this empty file is then refused for what it is)
    expect(store('carol')).toEqual({ ok: false, reason: 'incomplete' })
  })
})

test('the stand-in refuses to run without a terminal (so the launcher\'s own terminal is what the tests above use)', () => {
  const p = Bun.spawnSync([claudeBin, 'setup-token'], { env: { BROWSER: 'true', PATH: '/usr/bin:/bin' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  expect(p.exitCode).toBe(3)
  expect(p.stderr.toString()).toContain('needs a terminal')
})
