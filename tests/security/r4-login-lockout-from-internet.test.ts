// Security regression, round 4 (tunnel 3): anyone on the internet could lock any known account out of sign-in
// everywhere (the Mac, the office LAN and the internet address) for 15 minutes. The per-account failure counter was
// one counter for every path, and while it is tripped even the correct password gets 429. Ten POSTs per account
// every 15 minutes from any IP kept the owner and the whole front desk out, also inside the clinic.
//
// Port of scratchpad tunnel/repro/lockout-from-internet.sh on the office tunnel path (directFetch, CF-Connecting-IP):
// ten wrong passwords for desk1 through the public address, then desk1's correct password from the Mac, from the
// office LAN and from the clinic's own internet address (a network desk1 signed in from before). Brute-force
// protection must stay: a stranger's network still gets 429 with the right password, and the office and per-network
// counters still lock after ten failures of their own.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { directFetch } from '../../server/src/http/tunnel'
import { peerIp } from '../../server/src/main'
import { harness, OWNER_PW, SETUP_TOKEN, type Harness } from '../unit/a-lib'

const HOST = 'exampleteam.clinic-test.example'
const PUB = `https://${HOST}`
const LAN = 'https://192.168.1.18:8443'
const CLINIC_IP = '198.51.100.10' // the clinic's public address, as Cloudflare reports it for the desks
const DESK_PW = 'front desk tulip 42'

describe('failed sign-ins from the internet do not lock people out at the clinic', () => {
  let h: Harness
  let serve: ReturnType<typeof directFetch>
  type Where = { via: 'internet'; ip: string } | { via: 'mac' } | { via: 'lan'; peer: string }
  const login = async (where: Where, username: string, password: string): Promise<number> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-mycel-csrf': '1' }
    let url: string, peer = '127.0.0.1', port = 47830
    if (where.via === 'internet') { headers.host = HOST; headers.origin = PUB; headers['cf-connecting-ip'] = where.ip; url = `http://${HOST}` }
    else if (where.via === 'mac') { headers.host = 'localhost:47830'; headers.origin = 'http://localhost:47830'; url = 'http://localhost:47830' }
    else { headers.host = '192.168.1.18:8443'; headers.origin = LAN; url = LAN; peer = where.peer; port = 8443 }
    const req = new Request(`${url}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username, password }) })
    const res = await serve(req, { requestIP: () => ({ address: peer }), port }) as Response
    await res.arrayBuffer()
    return res.status
  }
  const flood = async (username: string, from = '203.0.113.') => {
    for (let i = 0; i < DEFAULT_LIMITS.perAccount; i++) expect(await login({ via: 'internet', ip: `${from}${i + 1}` }, username, `wrong guess ${i} xx`)).toBe(401)
    expect(await login({ via: 'internet', ip: `${from}99` }, username, 'one more guess xx')).toBe(429)
  }

  beforeAll(async () => {
    h = await harness('r4-lockout', {
      office: true, listen: { host: '127.0.0.1', port: 47830 },
      tunnel: { host: HOST, allowFrom: [], countries: [] },
      allowedHosts: ['192.168.1.18:8443', 'localhost:47830', '127.0.0.1:47830'], allowedPeers: ['192.168.1.0/24'],
      publicOrigins: [PUB, LAN, 'http://localhost:47830', 'http://127.0.0.1:47830'],
    })
    serve = directFetch(h.ctx.config, (req, env) => h.app.fetch(req, env), peerIp)
    // the owner sets the team up on the Mac and adds desk1, who signs in at the clinic (the internet address)
    const owner = h.client({ base: 'http://localhost:47830', via: 'direct', ip: '127.0.0.1', port: 47830 })
    await owner.call('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Exampleteam', locale: 'ko', owner: { username: 'director', name: 'Director', password: OWNER_PW } }, { origin: 'http://localhost:47830' })
    const r = await owner.call('POST', '/api/admin/users', { username: 'desk1', name: 'Desk 1', role: 'member', groupIds: [] }, { origin: 'http://localhost:47830' })
    const admin = h.ctx.db
    // a known password instead of the temporary one (the change-password step is not what this test is about)
    const { hashPassword } = await import('../../server/src/auth/passwords')
    admin.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword(DESK_PW), r.user.id)
    expect(await login({ via: 'internet', ip: CLINIC_IP }, 'desk1', DESK_PW)).toBe(200)
  })
  afterAll(async () => { await h.close() })

  test('after ten wrong passwords from the internet, desk1 still signs in at the Mac, on the LAN and from the clinic', async () => {
    await flood('desk1')
    expect(await login({ via: 'mac' }, 'desk1', DESK_PW)).toBe(200) // was 429
    expect(await login({ via: 'lan', peer: '192.168.1.50' }, 'desk1', DESK_PW)).toBe(200) // was 429
    expect(await login({ via: 'internet', ip: CLINIC_IP }, 'desk1', DESK_PW)).toBe(200) // was 429
    // brute-force protection is still there for everyone else: a stranger's network gets 429 with the right password
    expect(await login({ via: 'internet', ip: '192.0.2.77' }, 'desk1', DESK_PW)).toBe(429)
    // and the clinic's success did not hand the guessers ten new tries
    expect(await login({ via: 'internet', ip: '203.0.113.50' }, 'desk1', 'yet another guess')).toBe(429)
  })

  test('the owner, flooded from the internet, signs in at the Mac', async () => {
    await flood('director', '203.0.114.')
    expect(await login({ via: 'mac' }, 'director', OWNER_PW)).toBe(200)
  })

  test('the office LAN and a known network keep a limit of their own', async () => {
    h.advance(DEFAULT_LIMITS.windowMs + 1000)
    // ten failures on the LAN lock the LAN counter (an infected desk cannot guess without limit) ...
    for (let i = 0; i < DEFAULT_LIMITS.perAccount; i++) expect(await login({ via: 'lan', peer: `192.168.1.${60 + i}` }, 'desk1', `lan guess ${i} xx`)).toBe(401)
    expect(await login({ via: 'lan', peer: '192.168.1.80' }, 'desk1', DESK_PW)).toBe(429)
    // ... but not the clinic's internet address or the Mac
    expect(await login({ via: 'internet', ip: CLINIC_IP }, 'desk1', DESK_PW)).toBe(200)
    expect(await login({ via: 'mac' }, 'desk1', DESK_PW)).toBe(200)
    // the clinic's network has its own counter too
    for (let i = 0; i < DEFAULT_LIMITS.perAccount; i++) expect(await login({ via: 'internet', ip: CLINIC_IP }, 'desk1', `clinic typo ${i} x`)).toBe(401)
    expect(await login({ via: 'internet', ip: CLINIC_IP }, 'desk1', DESK_PW)).toBe(429)
  })
})
