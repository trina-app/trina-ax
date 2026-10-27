// Connecting a ChatGPT plan from the browser (docs/DECISIONS.md "AI 연결" D8, S-11): the server asks the real launcher
// to run `codex login --device-auth` (a fake with the 0.163 output shape) in a one-off folder through the model proxy;
// the address and code go only to the person who started it; the resulting login is checked, encrypted and stored;
// the folder is gone in every case; one sign-in at a time; reconnecting must be the same ChatGPT account.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { API, type CredentialLogin } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { credentialLogins } from '../../server/src/credentials/login'
import { credentialsOf, getRow, listRows, metaOf, secretOf } from '../../server/src/credentials/store'
import { MEMBER_OWN_KEY } from '../../server/src/credentials/resolve'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { setSetting } from '../../server/src/admin/settings'
import type { SocketLauncher } from '../../server/src/native'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
const echo = net.createServer((c) => c.on('data', (d) => c.write(d)).on('error', () => {}))
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
const dialed: string[] = []
const dial = (host: string, port: number) => { dialed.push(`${host}:${port}`); return net.connect((echo.address() as net.AddressInfo).port, '127.0.0.1') }

// the "codex" the launcher runs: a wrapper that reads this test's settings, then the fake login
const R = fs.mkdtempSync('/tmp/mycel-lg-')
const codexBin = path.join(R, 'codex')
const envFile = path.join(R, 'login.env')
const setLogin = (vars: Record<string, string>) => fs.writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `export ${k}=${v}`).join('\n') + '\n')
setLogin({})
fs.writeFileSync(codexBin, `#!/bin/sh\n. "${envFile}"\nexec "${process.execPath}" "${path.resolve(import.meta.dir, '../lib/fake-codex-login.ts')}" "$@"\n`, { mode: 0o755 })

let h: Harness
let dana: TestSocket
let alice: TestSocket
let bob: TestSocket
const logins = () => credentialLogins(credentialsOf(h.ctx), {
  async launcher() {
    const core = await h.ctx.core()
    return { sock: (core.launcher as SocketLauncher).path, codexBin, proxyPort: core.proxy!.port }
  },
})
beforeAll(async () => {
  h = await startHarness({ name: 'a-cred-login', allowCmds: [codexBin], proxyDial: dial, credentials: [] })
  logins() // the sign-ins of this server use the fake codex above
  setSetting(h.ctx.db, MEMBER_OWN_KEY, true)
  setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, true)
  dana = await h.ws('dana', { windowId: 'win-dana-lg' }); await dana.next('hello')
  alice = await h.ws('alice', { windowId: 'win-alice-lg' }); await alice.next('hello')
  bob = await h.ws('bob', { windowId: 'win-bob-lg' }); await bob.next('hello')
})
afterAll(async () => { dana?.close(); alice?.close(); bob?.close(); await h?.close(); echo.close(); fs.rmSync(R, { recursive: true, force: true }) })

const loginDir = () => path.join(h.ctx.engineConfig.agentRoot, '.codex-login')
const leftovers = () => (fs.existsSync(loginDir()) ? fs.readdirSync(loginDir()) : [])
const final = async (s: TestSocket, loginId: string) => (await s.next('credential.login', (f) => f.data.loginId === loginId && ['done', 'failed', 'expired', 'cancelled'].includes(f.data.state), 30_000)).data as CredentialLogin

describe('ChatGPT sign-in for the team', () => {
  let id = ''
  test('the address and code reach the person who started it (only), the login is stored encrypted, nothing stays behind', async () => {
    const start = await logins().start({ userId: 'dana', locale: 'en', personal: false, label: 'Team ChatGPT', assignments: [], priority: 100 })
    expect(start.state).toBe('starting')
    const code = await dana.next('credential.login', (f) => f.data.loginId === start.loginId && f.data.state === 'code', 20_000)
    expect(code.data).toMatchObject({ url: 'https://auth.openai.com/codex/device', code: 'WXYZ-12AB3' })
    const done = await final(dana, start.loginId)
    expect(done.state).toBe('done')
    expect(done.credential).toMatchObject({ kind: 'chatgpt', label: 'Team ChatGPT', scope: 'team', planType: 'plus', state: 'ok' })
    id = done.credential!.id
    const row = getRow(h.ctx.db, id)!
    expect(metaOf(row)).toMatchObject({ planType: 'plus', emailMasked: 'o***@e***.com' })
    expect(JSON.stringify(row)).not.toContain('at-login-acc-login')
    expect(secretOf(credentialsOf(h.ctx), row as never)).toMatchObject({ accessToken: 'at-login-acc-login', refreshToken: 'r-login', accountId: 'acc-login' })
    // the sign-in went through the proxy to auth.openai.com only, with a one-time token that is dead now
    expect(dialed).toContain('auth.openai.com:443')
    const tok = h.ctx.db.query("SELECT revoked_at FROM proxy_tokens WHERE turn_id LIKE 'codex-login:%'").all() as { revoked_at: string | null }[]
    expect(tok.length).toBeGreaterThan(0); expect(tok.every((t) => t.revoked_at !== null)).toBe(true)
    expect(leftovers()).toEqual([])
    // nobody else saw it
    expect(alice.frames.some((f) => f.type === 'credential.login')).toBe(false)
    expect(bob.frames.some((f) => f.type === 'credential.login')).toBe(false)
    // audited without tokens, e-mail or account id
    const audit = JSON.stringify(h.ctx.db.query("SELECT action, detail FROM audit_log WHERE action LIKE 'credential.%'").all())
    expect(audit).toContain('credential.login'); expect(audit).toContain('credential.create')
    for (const x of ['at-login', 'r-login', 'acc-login', 'owner@example.com']) expect(audit).not.toContain(x)
  })
  test('the same ChatGPT account again (not a reconnect): refused', async () => {
    const s = await logins().start({ userId: 'dana', locale: 'en', personal: false, label: 'Again', assignments: [], priority: 100 })
    expect(await final(dana, s.loginId)).toMatchObject({ state: 'failed', reason: 'same_account' })
    expect(listRows(h.ctx.db).filter((r) => r.kind === 'chatgpt').length).toBe(1)
  })
  test('reconnect: another account is refused; the same account replaces the sign-in', async () => {
    setLogin({ FAKE_LOGIN_ACCOUNT: 'acc-other' })
    const s1 = await logins().start({ userId: 'dana', locale: 'en', personal: false, label: 'x', assignments: [], priority: 100, reconnectId: id })
    expect(await final(dana, s1.loginId)).toMatchObject({ state: 'failed', reason: 'other_account' })
    h.ctx.db.query("UPDATE engine_credentials SET status = 'needs_reconnect', status_code = 'invalid_grant' WHERE id = ?").run(id)
    setLogin({ FAKE_LOGIN_PLAN: 'pro' })
    const s2 = await logins().start({ userId: 'dana', locale: 'en', personal: false, label: 'x', assignments: [], priority: 100, reconnectId: id })
    const d = await final(dana, s2.loginId)
    expect(d).toMatchObject({ state: 'done' })
    expect(getRow(h.ctx.db, id)).toMatchObject({ status: 'ok', status_code: null })
    expect(metaOf(getRow(h.ctx.db, id)!).planType).toBe('pro')
    expect(leftovers()).toEqual([])
    setLogin({})
  })
  test('an id_token of another account than the login says: refused (nothing stored)', async () => {
    setLogin({ FAKE_LOGIN_ACCOUNT: 'acc-third', FAKE_LOGIN_MISMATCH: '1' })
    const s = await logins().start({ userId: 'dana', locale: 'en', personal: false, label: 'x', assignments: [], priority: 100 })
    expect(await final(dana, s.loginId)).toMatchObject({ state: 'failed', reason: 'account_mismatch' })
    setLogin({})
  })
  test('one sign-in at a time; cancelling stops it and removes its folder', async () => {
    setLogin({ FAKE_LOGIN_ACCOUNT: 'acc-slow', FAKE_LOGIN_WAIT_MS: '20000' })
    const s = await logins().start({ userId: 'dana', locale: 'en', personal: false, label: 'slow', assignments: [], priority: 100 })
    await dana.next('credential.login', (f) => f.data.loginId === s.loginId && f.data.state === 'code', 20_000)
    expect(leftovers().length).toBe(1) // its folder exists while it runs
    let busy: unknown = null
    try { await logins().start({ userId: 'dana', locale: 'en', personal: false, label: 'second', assignments: [], priority: 100 }) } catch (e) { busy = e }
    expect((busy as { code?: string }).code).toBe('busy')
    logins().cancel(s.loginId, 'dana')
    expect(await final(dana, s.loginId)).toMatchObject({ state: 'cancelled' })
    expect(await waitFor(() => leftovers().length === 0, { timeoutMs: 10_000 })).toBe(true)
    expect(listRows(h.ctx.db).some((r) => r.label === 'slow')).toBe(false)
    setLogin({})
  })
})

describe('a member\'s own ChatGPT sign-in over HTTP', () => {
  test('202 with the state; only its starter can read or cancel it; the connection is personal', async () => {
    setLogin({ FAKE_LOGIN_ACCOUNT: 'acc-alice' })
    const r = await h.api('alice').call(API.startMyCredentialLogin, { body: { label: 'Alice ChatGPT', acknowledgedPlanNotice: true } })
    expect(r.state).toBe('starting')
    expect((await h.req('bob', `/api/me/credential-logins/${r.loginId}`)).status).toBe(404)
    expect((await h.req('bob', `/api/me/credential-logins/${r.loginId}`, { method: 'DELETE' })).status).toBe(404)
    const d = await final(alice, r.loginId)
    expect(d.state).toBe('done')
    expect(d.credential).toMatchObject({ scope: 'personal', owner: { id: 'alice' } })
    expect((await h.api('alice').call(API.getMyCredentialLogin, { params: { id: r.loginId } })).state).toBe('done')
    setLogin({})
  })
  test('without the plan notice confirmed: 400; with personal connections off: 403', async () => {
    expect((await h.req('alice', '/api/me/credential-logins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x' }) })).status).toBe(400)
    setSetting(h.ctx.db, MEMBER_OWN_KEY, false)
    try {
      expect((await h.req('alice', '/api/me/credential-logins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x', acknowledgedPlanNotice: true }) })).status).toBe(403)
    } finally { setSetting(h.ctx.db, MEMBER_OWN_KEY, true) }
  })
})
