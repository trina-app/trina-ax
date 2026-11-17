// A custom connector whose MCP server needs no sign-in (DeepWiki, QA TC-4771), added with the form's default way in
// (sign-in): Sign in finds no sign-in to offer, but the server let us start a session and listed its tools without a
// key, so the connection becomes one with no sign-in and is connected (service.ts authorize). A server that refuses its
// tool list without a key keeps the old reason and stays waiting for a sign-in, and so do servers whose sign-in
// metadata answered but cannot be used, or could not be read (down), and a connection signed in while the probe ran.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { harness, withOwner, type Client, type Harness } from './a-lib'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { getRow } from '../../server/src/integrations/connections/store'
import { TEXT } from '../../server/src/integrations/connections/text'

setDefaultTimeout(30_000)

let h: Harness, olga: Client, fake: FakeServices
let seq = 0
beforeAll(() => { fake = new FakeServices() })
afterAll(() => fake?.stop())
beforeEach(async () => {
  h = await harness('int-no-signin-' + ++seq)
  olga = await withOwner(h)
  fake.now = Date.now()
  integrationsOf(h.ctx, { net: fake.net(), now: () => fake.now })
})
afterEach(async () => { await h?.close() })

const add = (path: string) => olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'DeepWiki', url: `${fake.base}${path}`, auth: 'oauth' })
const flows = (id: string) => (h.ctx.db.query('SELECT count(*) AS n FROM integration_oauth_flows WHERE integration_id = ?').get(id) as { n: number }).n

describe('a server that needs no sign-in, added with sign-in', () => {
  test('Sign in connects it with no sign-in: no page to open, no flow, its tools saved', async () => {
    const c = await add('/mcp-open')
    expect(c).toMatchObject({ auth: 'oauth', status: 'needs_auth' })
    const r = await olga.try('POST', `/api/integrations/${c.id}/authorize`, {})
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ connected: true })
    expect(getRow(h.ctx.db, c.id)).toMatchObject({ auth: 'none', status: 'connected', last_error: null, secret_enc: null })
    expect(flows(c.id)).toBe(0)
    const listed = (await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)
    expect(listed).toMatchObject({ auth: 'none', status: 'connected' })
    expect(listed.tools.length).toBeGreaterThan(0)
    // no registration or sign-in was tried at the service
    expect(fake.seen.some((s) => /\/register|\/authorize\?/.test(s.path))).toBe(false)
  })

  test('a server that lists its tools only after a sign-in it does not offer: the old reason, still waiting', async () => {
    const c = await add('/mcp-half')
    const r = await olga.try('POST', `/api/integrations/${c.id}/authorize`, {})
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe(TEXT.oauth_unsupported.ko)
    expect(getRow(h.ctx.db, c.id)).toMatchObject({ auth: 'oauth', status: 'needs_auth', last_error: 'oauth_unsupported' })
  })

  test('a server that asks for sign-in still signs in as before', async () => {
    const c = await add('/mcp-oauth')
    const r = await olga.try('POST', `/api/integrations/${c.id}/authorize`, {})
    expect(r.status).toBe(200)
    expect(typeof r.body.authorizationUrl).toBe('string')
    expect(getRow(h.ctx.db, c.id)).toMatchObject({ auth: 'oauth', status: 'needs_auth' })
  })

  test('sign-in metadata that answered but cannot be used (another issuer), tools listed without a key: not switched', async () => {
    const c = await add('/mcp-badmeta')
    const r = await olga.try('POST', `/api/integrations/${c.id}/authorize`, {})
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe(TEXT.oauth_unsupported.ko)
    expect(getRow(h.ctx.db, c.id)).toMatchObject({ auth: 'oauth', status: 'needs_auth' })
  })

  test('the metadata address answers 503, tools listed without a key: down is not "no sign-in", not switched', async () => {
    const c = await add('/mcp-down')
    const r = await olga.try('POST', `/api/integrations/${c.id}/authorize`, {})
    expect(r.status).toBe(400)
    expect(getRow(h.ctx.db, c.id)).toMatchObject({ auth: 'oauth', status: 'needs_auth' })
  })

  test('a sign-in that finishes while the probe runs: its tokens stay, nothing is switched', async () => {
    const c = await add('/mcp-open')
    let release!: () => void
    const last = '/.well-known/oauth-authorization-server'
    fake.hold = { path: last, until: new Promise<void>((res) => { release = res }) }
    try {
      const from = fake.seen.length
      const reached = () => fake.seen.slice(from).some((s) => s.path === last)
      const pending = olga.try('POST', `/api/integrations/${c.id}/authorize`, {})
      for (let i = 0; i < 500 && !reached(); i++) await Bun.sleep(10)
      expect(reached()).toBe(true)
      // what the sign-in's callback writes (service.ts callback): the sealed tokens, and the version moves on
      h.ctx.db.query("UPDATE integrations SET secret_enc='sealed-tokens', version=version+1 WHERE id=?").run(c.id)
      fake.hold = null
      release()
      const r = await pending
      expect(r.status).toBe(400)
    } finally { fake.hold = null; release() }
    expect(getRow(h.ctx.db, c.id)).toMatchObject({ auth: 'oauth', secret_enc: 'sealed-tokens' })
    const audits = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.update' AND target = ?").all(c.id)
    expect(audits).toEqual([])
  })

  test('the switch is logged as made by the server itself', async () => {
    const c = await add('/mcp-open')
    expect((await olga.try('POST', `/api/integrations/${c.id}/authorize`, {})).body).toEqual({ connected: true })
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.update' AND target = ?").get(c.id) as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ via: 'no_signin_probe', changed: ['auth'] })
  })
})
