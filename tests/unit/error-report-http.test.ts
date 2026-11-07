// POST /api/client-errors and server.errorReports in GET /api/me, through the real routes and session.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { ErrorReporter, parseDsn, setErrorReports } from '../../server/src/system/error-report'
import { Client, harness, withOwner, type Harness } from './a-lib'

const report = { type: 'TypeError', message: "cannot read '/team/board/plan.md'", stack: 'TypeError: x\n    at f (https://acme.trina.app/assets/index-abc.js:1:2)', page: '/files' }
const NONE = { server: null, web: null, refused: false, invalid: [] }

describe('browser error reports over HTTP', () => {
  let h: Harness
  let owner: Client
  const bodies: string[] = []
  const on = () => setErrorReports({
    ...NONE,
    web: new ErrorReporter(parseDsn('https://k@sentry.example.com/1')!, {
      release: 'mycel@1', environment: 'dev', logger: 'web',
      fetch: (async (_u: string, r: RequestInit) => { bodies.push(r.body as string); return new Response('{}') }) as unknown as typeof fetch,
    }),
  })

  beforeAll(async () => {
    h = await harness('error-report-http')
    owner = await withOwner(h)
  })
  afterEach(() => { setErrorReports(NONE); bodies.length = 0 })
  afterAll(() => h.close())

  test('off: not found, and the web app is not told to send', async () => {
    expect((await owner.raw('POST', '/api/client-errors', report)).status).toBe(404)
    expect((await owner.call('GET', '/api/me')).server.errorReports).toBeUndefined()
  })

  test('on: taken, scrubbed and forwarded, and the web app is told to send', async () => {
    on()
    expect((await owner.call('GET', '/api/me')).server.errorReports).toBe(true)
    expect((await owner.raw('POST', '/api/client-errors', report)).status).toBe(204)
    await Bun.sleep(10)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('assets/index-abc.js')
    expect(bodies[0]).toContain('"page":"/files"')
    expect(bodies[0]).not.toContain('plan.md')
    expect(bodies[0]).not.toContain('acme.trina.app')
  })

  test('nobody signed in may send', async () => {
    on()
    expect((await new Client(h).raw('POST', '/api/client-errors', report)).status).toBe(401)
    expect(bodies).toHaveLength(0)
  })

  test('a request from another site is refused', async () => {
    on()
    expect((await owner.raw('POST', '/api/client-errors', report, { 'x-mycel-csrf': '' })).status).toBeGreaterThanOrEqual(400)
  })

  test('a body over the limit is refused', async () => {
    on()
    expect((await owner.raw('POST', '/api/client-errors', { ...report, stack: 'x'.repeat(20_000) })).status).toBe(413)
    expect(bodies).toHaveLength(0)
  })

  test('a field over its limit, or a field left out, is refused', async () => {
    on()
    expect((await owner.raw('POST', '/api/client-errors', { ...report, type: 'x'.repeat(81) })).status).toBe(400)
    expect((await owner.raw('POST', '/api/client-errors', { type: 'Error' })).status).toBe(400)
    expect(bodies).toHaveLength(0)
  })

  test('a field the contract does not name does not reach Sentry', async () => {
    on()
    expect((await owner.raw('POST', '/api/client-errors', { ...report, logLine: 'SECRET_PROMPT_TEXT', route: '/secret' })).status).toBe(204)
    await Bun.sleep(10)
    expect(bodies[0]).not.toContain('SECRET_PROMPT_TEXT')
    expect(bodies[0]).not.toContain('/secret')
  })
})
