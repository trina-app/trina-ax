// Security regression, round 4 (tunnel 6): the internet could still tell whether the office server is set up, and
// read the clinic's team name. GET /api/setup forced needed:false on the tunnel but sent teamName (null before setup,
// the name after), and POST /api/setup checked "already set up" (409) before the tunnel refusal (403).
//
// Port of scratchpad tunnel/repro/setup-state-oracle.sh: the same two requests through the office public address
// before and after the owner is created on the Mac must get the same answers.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { directFetch } from '../../server/src/http/tunnel'
import { peerIp } from '../../server/src/main'
import { harness, OWNER_PW, SETUP_TOKEN, type Harness } from '../unit/a-lib'

const HOST = 'exampleteam.clinic-test.example'
const PUB = `https://${HOST}`

describe('the internet address does not tell whether the team is set up', () => {
  let h: Harness
  let serve: ReturnType<typeof directFetch>
  const probe = async () => {
    const send = async (method: string, body?: unknown) => {
      const headers: Record<string, string> = { host: HOST, 'cf-connecting-ip': '203.0.113.9' }
      if (method !== 'GET') Object.assign(headers, { origin: PUB, 'x-mycel-csrf': '1', 'content-type': 'application/json' })
      const res = await serve(new Request(`http://${HOST}/api/setup`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { requestIP: () => ({ address: '127.0.0.1' }), port: 47830 }) as Response
      // every error carries its own requestId: not part of what the answer says
      return { status: res.status, body: (await res.text()).replace(/"requestId":"[^"]*"/, '"requestId":"-"') }
    }
    return {
      get: await send('GET'),
      post: await send('POST', { setupToken: 'A'.repeat(24), teamName: 'x', locale: 'en', owner: { username: 'probe', name: 'Probe', password: 'Probe-Password-123456' } }),
    }
  }

  beforeAll(async () => {
    h = await harness('r4-setup-oracle', {
      office: true, listen: { host: '127.0.0.1', port: 47830 },
      tunnel: { host: HOST, allowFrom: [], countries: [] },
      allowedHosts: ['localhost:47830', '127.0.0.1:47830'], allowedPeers: ['192.168.1.0/24'],
      publicOrigins: [PUB, 'http://localhost:47830', 'http://127.0.0.1:47830'],
    })
    serve = directFetch(h.ctx.config, (req, env) => h.app.fetch(req, env), peerIp)
  })
  afterAll(async () => { await h.close() })

  test('GET and POST /api/setup answer the same before and after the owner exists', async () => {
    const before = await probe()
    expect(before.get.status).toBe(200)
    expect(JSON.parse(before.get.body)).toMatchObject({ needed: false, teamName: null })
    expect(before.post.status).toBe(403)

    const mac = h.client({ base: 'http://localhost:47830', via: 'direct', ip: '127.0.0.1', port: 47830 })
    await mac.call('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Exampleteam Dental', locale: 'en', owner: { username: 'director', name: 'Director', password: OWNER_PW } }, { origin: 'http://localhost:47830' })

    const after = await probe()
    expect(after.get).toEqual(before.get) // was teamName "Exampleteam Dental"
    expect(after.post).toEqual(before.post) // was 409 "already set up"
    expect(after.get.body + after.post.body).not.toContain('Exampleteam Dental')
  })
})
