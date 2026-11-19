// A second relay under the same team domain (the US relay, relay-us.trina.app): RELAY_SELF_NAMES names the host labels
// that are the relay's own address (API, /connect). Default 'relay', so an existing relay does not change.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import http from 'node:http'
import { loadRelayConfig } from '../../relay/src/config.ts'
import { registerTeam, startRelay, type InProcessRelay } from '../lib/f-relay'

function get(port: number, host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('relay self names', () => {
  test('default: relay; set: validated, lowercased, and reserved as team names', () => {
    expect(loadRelayConfig(['--dev'], {}).selfNames).toEqual(['relay'])
    const c = loadRelayConfig(['--dev'], { RELAY_SELF_NAMES: 'Relay-US, relay', RELAY_RESERVED: 'acme' })
    expect(c.selfNames).toEqual(['relay-us', 'relay'])
    expect(c.reserved).toEqual(['acme', 'relay-us', 'relay'])
    expect(() => loadRelayConfig(['--dev'], { RELAY_SELF_NAMES: 'relay.us' })).toThrow()
    expect(() => loadRelayConfig(['--dev'], { RELAY_SELF_NAMES: ' , ' })).toThrow()
  })

  describe('in a running relay', () => {
    let r: InProcessRelay
    const port = 19400 + Math.floor(Math.random() * 400)
    beforeAll(async () => { r = await startRelay(port, { RELAY_SELF_NAMES: 'relay-us' }) })
    afterAll(async () => { await r.stop() })

    test('relay-us.<domain> is the relay itself, relay.<domain> is then a team address', async () => {
      const self = await get(port, `relay-us.localhost:${port}`, '/healthz')
      expect(self.status).toBe(200)
      expect(JSON.parse(self.body).ok).toBe(true)
      const other = await get(port, `relay.localhost:${port}`, '/healthz')
      expect(other.status).toBe(404)
      expect(other.body).toContain('team_unknown')
    })

    test('a self name cannot be registered as a team', async () => {
      await expect(registerTeam(r.base, 'relay-us')).rejects.toThrow(/register relay-us: 4\d\d/)
      expect((await registerTeam(r.base, 'acme-self')).name).toBe('acme-self')
    })
  })
})
