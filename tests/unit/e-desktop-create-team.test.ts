// The desktop app's create flow (desktop/src/main/create-team.ts) with a stub console sign-in: S2's two ways (Google in
// the browser, or an e-mail code in the app), the code step and its errors, and the screens that follow. The console
// calls themselves are e2e (desktop/e2e/create-team.spec.ts); the error words are the pure create-team.ts.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateTeam } from '../../desktop/src/main/create-team'
import { emailSignInError, type CreateView } from '../../desktop/src/common/create-team'
import { isAppEmail } from '@mycel/shared/cloud-protocol/owner-claim'
import type { ConsoleSignIn, EmailResult } from '../../desktop/src/main/console-signin'

const me = { accountId: 'a', email: 'owner@example.com', team: null, freeLeft: true, waitlist: false, store: false, freePlan: { maxActiveMembers: 3, maxConcurrency: 1, diskGB: 5, termsUrl: 'https://t.example.test/t', privacyUrl: 'https://t.example.test/p', termsVersion: 'v1' } }

function setup(o: { store?: boolean; verify?: EmailResult[]; start?: EmailResult[] } = {}) {
  let token = false
  const calls: string[] = []
  const signin = {
    token: () => (token ? { token: 'x'.repeat(43), expiresAt: new Date(Date.now() + 3600_000).toISOString(), store: false } : null),
    cancel: () => calls.push('cancel'),
    signIn: async () => { calls.push('browser'); return { ok: false, error: 'closed' } },
    emailStart: async (email: string, store: boolean) => { calls.push(`start ${email} ${store}`); return o.start?.shift() ?? { ok: true } },
    emailVerify: async (code: string) => {
      calls.push(`verify ${code}`)
      const r = o.verify?.shift() ?? { ok: true }
      if (r.ok) token = true
      return r
    },
    api: async (method: string, path: string) => { calls.push(`${method} ${path}`); return path.endsWith('/me') ? { status: 200, body: { ...me, store: o.store === true } } : { status: 404, body: null } },
  }
  const views: CreateView[] = []
  const flow = new CreateTeam({
    signin: signin as unknown as ConsoleSignIn, store: o.store === true, userData: mkdtempSync(join(tmpdir(), 'create-team-')), locale: () => 'en', timeZone: () => 'UTC',
    changed: () => views.push(flow.view()), openTeam: async () => {}, pollMs: 10,
  })
  return { flow, calls, views }
}
const settle = () => new Promise((r) => setTimeout(r, 5))

describe('S2: the two ways to sign in', () => {
  test('no token: the two ways first, nothing opened in the browser until Continue with Google', async () => {
    const { flow, calls } = setup()
    flow.start()
    expect(flow.view()).toMatchObject({ screen: 'signin', step: 'choose', error: null })
    expect(calls).toEqual([])
    flow.google()
    await settle()
    expect(calls).toEqual(['browser'])
  })
  test('the e-mail way: a full address, a 6-digit code, its errors, send again, another e-mail, then the name screen', async () => {
    const { flow, calls } = setup({ verify: [{ ok: false, error: 'codeInvalid' }, { ok: false, error: 'codeExpired' }, { ok: false, error: 'tooMany' }] })
    flow.start()
    await flow.sendCode('owner@example')
    expect(flow.view()).toMatchObject({ step: 'choose', error: 'emailInvalid' })
    expect(calls).toEqual([])
    await flow.sendCode(' owner@example.com ')
    expect(flow.view()).toMatchObject({ step: 'code', email: 'owner@example.com', error: null })
    // a code that is not 6 digits never leaves the app
    await flow.verifyCode('12345')
    expect(flow.view()).toMatchObject({ step: 'code', error: 'codeInvalid' })
    for (const error of ['codeInvalid', 'codeExpired', 'tooMany']) {
      await flow.verifyCode('123 456')
      expect(flow.view()).toMatchObject({ step: 'code', error, busy: false })
    }
    await flow.sendCode('owner@example.com')
    expect(flow.view()).toMatchObject({ step: 'code', error: null })
    flow.otherEmail()
    expect(flow.view()).toMatchObject({ step: 'choose', email: 'owner@example.com' })
    await flow.sendCode('owner@example.com')
    await flow.verifyCode('654321')
    await settle()
    expect(flow.view()).toMatchObject({ screen: 'name', email: 'owner@example.com' })
    expect(calls.filter((c) => c.startsWith('start'))).toEqual(['start owner@example.com false', 'start owner@example.com false', 'start owner@example.com false'])
    expect(calls.filter((c) => c.startsWith('verify'))).toEqual(['verify 123456', 'verify 123456', 'verify 123456', 'verify 654321'])
    expect(calls).not.toContain('browser')
  })
  test('sending fails: offline or too many on the two ways, the address kept', async () => {
    const { flow } = setup({ start: [{ ok: false, error: 'offline' }, { ok: false, error: 'tooMany' }] })
    flow.start()
    await flow.sendCode('owner@example.com')
    expect(flow.view()).toMatchObject({ step: 'choose', error: 'offline', email: 'owner@example.com' })
    await flow.sendCode('owner@example.com')
    expect(flow.view()).toMatchObject({ step: 'choose', error: 'tooMany' })
  })
  test('the store build sends store on the code request, and still only reads and opens', async () => {
    const { flow, calls } = setup({ store: true })
    flow.signInAgain()
    expect(flow.view()).toMatchObject({ screen: 'signin', step: 'choose' })
    await flow.sendCode('owner@example.com')
    await flow.verifyCode('111111')
    await settle()
    expect(calls[0]).toBe('start owner@example.com true')
    expect(flow.view()).toMatchObject({ screen: 'notice', notice: 'noTeam', action: null })
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false)
  })
  test('the console error codes become the screen lines', () => {
    expect(emailSignInError(400, { error: { code: 'code_invalid', message: '' } })).toBe('codeInvalid')
    expect(emailSignInError(400, { error: { code: 'code_expired', message: '' } })).toBe('codeExpired')
    expect(emailSignInError(429, { error: { code: 'code_exhausted', message: '' } })).toBe('tooMany')
    expect(emailSignInError(429, { error: { code: 'rate_limited', message: '' } })).toBe('tooMany')
    expect(emailSignInError(400, { error: { code: 'invalid_request', message: '' } })).toBe('emailInvalid')
    expect(emailSignInError(500, null)).toBe('failed')
    for (const ok of ['owner@example.com', 'a.b+c@sub.example.co']) expect(isAppEmail(ok)).toBe(true)
    for (const bad of ['owner@example', 'owner example.com', '@example.com', 'a@b@c.com', `${'a'.repeat(65)}@example.com`, '']) expect(isAppEmail(bad)).toBe(false)
  })
})
