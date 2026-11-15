// The desktop app's one-time return address of a connector sign-in (desktop/src/common/sign-in-return.ts): bound to
// 127.0.0.1 only, one GET /callback with a state from its own Host, sent on only to the team's https origin with the
// same query, then closed; anything else 404 without using it up; closed after the timeout, by a newer one, by close,
// and when the window shows another team. Real sockets on this computer, nothing outside it.
import { afterEach, describe, expect, test } from 'bun:test'
import http from 'node:http'
import { returnOrigin, returnQuery, SIGN_IN_RETURN_MS, SignInReturn, TEAM_CALLBACK_PATH } from '../../desktop/src/common/sign-in-return'

const TEAM = 'https://acme.trina.app'
let team: string | null = TEAM
let r: SignInReturn
afterEach(() => { r?.close(); team = TEAM })

/** one request as a browser sends it: never follows a redirect */
function get(port: number, path: string, o: { host?: string; method?: string; address?: string } = {}): Promise<{ status: number; location?: string; headers: http.IncomingHttpHeaders } | { error: string }> {
  return new Promise((resolve) => {
    const req = http.request({ host: o.address ?? '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { host: o.host ?? `127.0.0.1:${port}` }, agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, headers: res.headers }))
    })
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }))
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}
const closed = async (port: number) => 'error' in (await get(port, '/callback?state=x'))
const Q = 'code=abc123&state=' + 'S'.repeat(43) + '&iss=https%3A%2F%2Fmcp.canva.com'

describe('the return address', () => {
  test('one GET /callback with a state: 302 to the team\'s own return page with the same query, then it is gone', async () => {
    r = new SignInReturn({ current: () => team })
    const port = await r.open(TEAM)
    expect(port).toBeGreaterThan(1023)
    expect(r.port).toBe(port)
    const res = await get(port!, `/callback?${Q}`)
    expect(res).toMatchObject({ status: 302, location: `${TEAM}${TEAM_CALLBACK_PATH}?${Q}` })
    if ('headers' in res) {
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['referrer-policy']).toBe('no-referrer')
    }
    await Bun.sleep(20)
    expect(r.port).toBeNull()
    expect(await closed(port!)).toBe(true)
  })

  test('bound to 127.0.0.1 only: not on ::1, not on this computer\'s other addresses', async () => {
    r = new SignInReturn({ current: () => team })
    const port = (await r.open(TEAM))!
    expect('error' in (await get(port, '/callback?state=x', { address: '::1', host: `[::1]:${port}` }))).toBe(true)
    const os = await import('node:os')
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)
    if (lan) expect('error' in (await get(port, '/callback?state=x', { address: lan.address, host: `${lan.address}:${port}` }))).toBe(true)
    // still open for the real one
    expect(await get(port, `/callback?${Q}`)).toMatchObject({ status: 302 })
  })

  test('anything but the return gets 404 and does not use it up: another path, method or Host, no state, a bad query', async () => {
    r = new SignInReturn({ current: () => team })
    const port = (await r.open(TEAM))!
    for (const [path, o] of [
      ['/', {}], ['/callback/', {}], ['/callbackx?state=x', {}], ['/CALLBACK?state=x', {}], ['/api/integrations/oauth/callback?state=x', {}],
      ['/callback', {}], ['/callback?code=1', {}], ['/callback?state=', {}], [`/callback?state=x&a=${'b'.repeat(9000)}`, {}],
      [`/callback?${Q}`, { method: 'POST' }], [`/callback?${Q}`, { method: 'HEAD' }],
      [`/callback?${Q}`, { host: 'evil.example' }], [`/callback?${Q}`, { host: `localhost:${port}` }], [`/callback?${Q}`, { host: '127.0.0.1' }],
    ] as const) {
      const res = await get(port, path, o)
      expect('status' in res && res.status, `${o && 'method' in o ? o.method : 'GET'} ${path.slice(0, 40)} ${'host' in o ? o.host : ''}`).toBe(404)
    }
    expect(await get(port, `/callback?${Q}`)).toMatchObject({ status: 302 })
  })

  test('it goes only to the team\'s https origin, and only while the window shows that team', async () => {
    r = new SignInReturn({ current: () => team })
    // not https, not an origin, or not the team the window shows: nothing opens
    for (const o of ['http://acme.trina.app', 'https://acme.trina.app/path', 'https://user:pw@acme.trina.app', 'javascript:alert(1)', '', null, 'https://other.trina.app']) expect(await r.open(o)).toBeNull()
    expect(returnOrigin('https://acme.trina.app/')).toBe(TEAM)
    expect(returnOrigin('https://acme.trina.app:8443')).toBe('https://acme.trina.app:8443')
    // the window moved to another team meanwhile: refused, and closed
    const port = (await r.open(TEAM))!
    team = 'https://other.trina.app'
    expect(await get(port, `/callback?${Q}`)).toMatchObject({ status: 404 })
    expect(r.port).toBeNull()
    expect(await closed(port)).toBe(true)
  })

  test('it closes after its time unused, when a newer one opens, and when the page closes it', async () => {
    r = new SignInReturn({ current: () => team, timeoutMs: 150 })
    const a = (await r.open(TEAM))!
    await Bun.sleep(300)
    expect(r.port).toBeNull()
    expect(await closed(a)).toBe(true)
    // one at a time
    const b = (await r.open(TEAM))!
    const c = (await r.open(TEAM))!
    expect(await closed(b)).toBe(true)
    expect(r.port).toBe(c)
    // close names the port: an older port closes nothing
    r.close(b)
    expect(r.port).toBe(c)
    r.close(c)
    expect(await closed(c)).toBe(true)
    // the real lifetime is the server's sign-in lifetime
    expect(SIGN_IN_RETURN_MS).toBe(10 * 60_000)
  })

  test('a flood of wrong requests closes it', async () => {
    r = new SignInReturn({ current: () => team })
    const port = (await r.open(TEAM))!
    for (let i = 0; i < 20; i++) await get(port, '/favicon.ico')
    expect(r.port).toBeNull()
    expect(await closed(port)).toBe(true)
  })

  test('returnQuery: the exact path, a state, printable ASCII, not too long', () => {
    expect(returnQuery(`/callback?${Q}`)).toBe(Q)
    for (const u of [undefined, '', '/callback', '/callback?', '/callback?code=1', '/x?state=1', '/callback?state=a b', `/callback?state=${'a'.repeat(8200)}`, '/callback?state=\r\nX: y', '/callback?state=a&x=é']) expect(returnQuery(u), String(u).slice(0, 30)).toBeNull()
    expect(returnQuery('/callback?error=access_denied&state=abc')).toBe('error=access_denied&state=abc')
  })
})
