// The desktop app's return address from the hosting console (desktop/src/common/console-return.ts): its own listener on
// 127.0.0.1, only GET /console-callback with the state it waits for (compared in constant time) and a code or an
// error, read here and never forwarded; anything else 404 without using it up; closed after one good answer, after
// the timeout and by close, and never by or with the connector sign-in's listener (common/sign-in-return.ts). PKCE S256.
// Real sockets on this computer, nothing outside it.
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { APP_CALLBACK_PATH, APP_CONNECT_TTL_MS, appCallbackUrl, appConnectUrl, parseAppConnectParams } from '@mycel/shared/cloud-protocol/owner-claim'
import { callbackQuery, ConsoleReturn, newState, pkceChallenge, pkcePair, sameState } from '../../desktop/src/common/console-return'
import { SignInReturn, TEAM_CALLBACK_PATH } from '../../desktop/src/common/sign-in-return'

const CODE = 'Q29kZUNvZGVDb2RlQ29kZUNvZGVDb2RlQ29kZUNvZGU'
let r: ConsoleReturn | undefined
let s: SignInReturn | undefined
afterEach(() => { r?.close(); s?.close() })

function get(port: number, path: string, o: { host?: string; method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders } | { error: string }> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { host: o.host ?? `127.0.0.1:${port}`, ...o.headers }, agent: false }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }))
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}
const callback = (port: number, q: Record<string, string>) => new URL(appCallbackUrl(port, 'code' in q ? { code: q.code!, state: q.state! } : { error: q.error as 'cancelled', state: q.state! })).pathname + new URL(appCallbackUrl(port, 'code' in q ? { code: q.code!, state: q.state! } : { error: q.error as 'cancelled', state: q.state! })).search
const closed = async (port: number) => 'error' in (await get(port, `${APP_CALLBACK_PATH}?state=x&code=y`))

describe('PKCE and state', () => {
  test('the challenge is S256 of the verifier (RFC 7636), both 43 base64url; states are random', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    // RFC 7636 appendix B
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    expect(pkcePair().verifier).not.toBe(verifier)
    expect(newState()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newState()).not.toBe(newState())
    // the connect address the console reads back
    const state = newState()
    const p = parseAppConnectParams(new URL(appConnectUrl('https://account.trina.app', { state, challenge, port: 49152, locale: 'en', store: false })).searchParams)
    expect(p).toEqual({ state, challenge, port: 49152, locale: 'en', store: false })
    expect(sameState(state, state)).toBe(true)
    expect(sameState(state, state.slice(0, 42) + (state[42] === 'A' ? 'B' : 'A'))).toBe(false)
    expect(sameState(state, state.slice(1))).toBe(false)
  })
  test('the callback query: exactly state and a code or a named error, once each', () => {
    const state = newState()
    expect(callbackQuery(`${APP_CALLBACK_PATH}?code=${CODE}&state=${state}`)).toEqual({ state, code: CODE })
    expect(callbackQuery(`${APP_CALLBACK_PATH}?error=cancelled&state=${state}`)).toEqual({ state, error: 'cancelled' })
    for (const bad of [
      `${APP_CALLBACK_PATH}?state=${state}`, `${APP_CALLBACK_PATH}?code=${CODE}`, `${APP_CALLBACK_PATH}?code=${CODE}&state=${state}&x=1`,
      `${APP_CALLBACK_PATH}?code=${CODE}&code=${CODE}&state=${state}`, `${APP_CALLBACK_PATH}?code=short&state=${state}`, `${APP_CALLBACK_PATH}?error=other&state=${state}`,
      `${APP_CALLBACK_PATH}?code=${CODE}&error=cancelled&state=${state}`, `/callback?code=${CODE}&state=${state}`, `${APP_CALLBACK_PATH}/?code=${CODE}&state=${state}`, undefined,
    ]) expect(callbackQuery(bad)).toBeNull()
  })
})

describe('the console return listener', () => {
  test('one good return: a small "close this tab" page, the code to the app, then it is gone', async () => {
    r = new ConsoleReturn({ page: () => 'You can close this tab.' })
    const state = newState()
    const o = (await r.open(state))!
    expect(o.port).toBeGreaterThan(1023)
    const res = await get(o.port, callback(o.port, { code: CODE, state }))
    expect(res).toMatchObject({ status: 200 })
    if ('body' in res) {
      expect(res.body).toContain('You can close this tab.')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['content-security-policy']).toContain("default-src 'none'")
      expect(res.headers.location).toBeUndefined()
    }
    expect(await o.answer).toEqual({ code: CODE })
    expect(r.port).toBeNull()
    expect(await closed(o.port)).toBe(true)
  })
  test('a state mismatch is refused and does not use it up; neither does any other path, method, Host or kind of load', async () => {
    r = new ConsoleReturn({ page: () => 'done' })
    const state = newState()
    const o = (await r.open(state))!
    const other = newState()
    for (const [path, opt] of [
      [callback(o.port, { code: CODE, state: other }), {}],
      [callback(o.port, { error: 'cancelled', state: other }), {}],
      ['/', {}], ['/callback?code=x&state=y', {}], [`${APP_CALLBACK_PATH}?state=${state}`, {}], [`${APP_CALLBACK_PATH}x?code=${CODE}&state=${state}`, {}],
      [callback(o.port, { code: CODE, state }), { method: 'POST' }],
      [callback(o.port, { code: CODE, state }), { host: `localhost:${o.port}` }],
      [callback(o.port, { code: CODE, state }), { headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } }],
      [callback(o.port, { code: CODE, state }), { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } }],
    ] as const) {
      const res = await get(o.port, path, opt)
      expect('status' in res && res.status, path).toBe(404)
    }
    expect(r.port).toBe(o.port)
    expect(await get(o.port, callback(o.port, { code: CODE, state }))).toMatchObject({ status: 200 })
    expect(await o.answer).toEqual({ code: CODE })
  })
  test('the console says the person cancelled: the app hears it, the listener closes', async () => {
    r = new ConsoleReturn({ page: () => 'done' })
    const state = newState()
    const o = (await r.open(state))!
    expect(await get(o.port, callback(o.port, { error: 'cancelled', state }))).toMatchObject({ status: 200 })
    expect(await o.answer).toEqual({ error: 'cancelled' })
    expect(await closed(o.port)).toBe(true)
  })
  test('it closes after the time limit (10 minutes by default) and on close; a new open closes the older one', async () => {
    expect(APP_CONNECT_TTL_MS).toBe(10 * 60_000)
    r = new ConsoleReturn({ page: () => 'done', timeoutMs: 80 })
    const o = (await r.open(newState()))!
    expect(await o.answer).toEqual({ error: 'timeout' })
    expect(await closed(o.port)).toBe(true)
    r = new ConsoleReturn({ page: () => 'done' })
    const a = (await r.open(newState()))!
    const b = (await r.open(newState()))!
    expect(await a.answer).toEqual({ error: 'closed' })
    expect(await closed(a.port)).toBe(true)
    expect(r.port).toBe(b.port)
    r.close()
    expect(await b.answer).toEqual({ error: 'closed' })
  })
  test('it lives next to a connector sign-in listener: both answer, closing one leaves the other', async () => {
    const team = 'https://acme.trina.app'
    s = new SignInReturn({ current: () => team })
    r = new ConsoleReturn({ page: () => 'done' })
    const connector = (await s.open(team))!
    const state = newState()
    const o = (await r.open(state))!
    expect(o.port).not.toBe(connector)
    // closing the console's leaves the connector's
    r.close()
    expect(await o.answer).toEqual({ error: 'closed' })
    expect(s.port).toBe(connector)
    // a new console open does not close the connector's either
    const state2 = newState()
    const o2 = (await r.open(state2))!
    expect(s.port).toBe(connector)
    // the connector's return still goes to its team; then it closes, and the console's is still there
    const q = `code=abc&state=${'S'.repeat(43)}`
    const res = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: connector, path: `/callback?${q}`, agent: false }, (x) => { x.resume(); resolve(x.statusCode ?? 0); expect(x.headers.location).toBe(`${team}${TEAM_CALLBACK_PATH}?${q}`) })
    })
    expect(res).toBe(302)
    await Bun.sleep(20)
    expect(s.port).toBeNull()
    expect(r.port).toBe(o2.port)
    expect(await get(o2.port, callback(o2.port, { code: CODE, state: state2 }))).toMatchObject({ status: 200 })
    expect(await o2.answer).toEqual({ code: CODE })
  })
  test('a connector sign-in opened after it does not close it, and the shared checks are one module', async () => {
    r = new ConsoleReturn({ page: () => 'done' })
    const state = newState()
    const o = (await r.open(state))!
    const team = 'https://acme.trina.app'
    s = new SignInReturn({ current: () => team })
    await s.open(team)
    await s.open(team) // a new connector sign-in closes the older connector one only
    s.close()
    expect(r.port).toBe(o.port)
    expect(await get(o.port, callback(o.port, { code: CODE, state }))).toMatchObject({ status: 200 })
    const fs = await import('node:fs')
    for (const f of ['sign-in-return.ts', 'console-return.ts']) expect(fs.readFileSync(new URL(`../../desktop/src/common/${f}`, import.meta.url), 'utf8')).toContain("from './loopback'")
  })
})
