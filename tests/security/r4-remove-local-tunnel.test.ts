// Security regression, round 4 (tunnel 5): public-address.ts remove deleted locally managed tunnels it cannot see.
// A tunnel with config_src "local" keeps its ingress in someone's config.yml, so the API shows no names for it;
// remove took it for unused, closed its live connections and deleted it, when reached through --tunnel, the default
// name teamax-<name-with-dashes>, or a CNAME pointing at it. set refuses such tunnels and DECISIONS.md says they are
// never touched. It also deleted an empty remotely managed tunnel reached only through --tunnel or the default name.
//
// Port of scratchpad tunnel/repro/remove-deletes-local-tunnel.ts against the in-memory Cloudflare API.
import { describe, expect, test } from 'bun:test'
import { defaultTunnelName, removeAddress } from '../../scripts/office/public-address'
import { cred, fakeCloudflare, writes, type FakeCf } from './lib/fake-cloudflare'

const HOST = 'teamax-r4-4d3d462b.clinic-test.example'
const local = (f: FakeCf, name: string, id = 'bbbbbbbb-1111-4222-8333-000000000001') => {
  f.tunnels.push({ id, name, config_src: 'local', deleted_at: null, config: null, secret: 's', connections: 2 })
  return f.tunnels.at(-1)!
}
const touched = (f: FakeCf, id: string) => f.calls.filter((c) => c.includes(id) && !c.startsWith('GET'))

describe('remove never deletes a tunnel that is not this name\'s', () => {
  test('a locally managed tunnel under the default name (the name has no DNS record) is not touched', async () => {
    const f = fakeCloudflare()
    const t = local(f, defaultTunnelName(HOST))
    const r = await removeAddress(f.api, cred, { host: HOST })
    expect(t.deleted_at).toBeNull() // was 'now'
    expect(t.connections).toBe(2)
    expect(touched(f, t.id)).toEqual([])
    expect(r.actions.join('\n')).toMatch(/managed by a local config file: not touched/)
  })

  test('a locally managed tunnel named with --tunnel, or the one the name\'s CNAME points to, is not touched', async () => {
    const f = fakeCloudflare()
    const t = local(f, 'someone-elses-service')
    await removeAddress(f.api, cred, { host: HOST, tunnel: 'someone-elses-service' })
    expect(t.deleted_at).toBeNull()
    expect(touched(f, t.id)).toEqual([])
    const g = fakeCloudflare()
    const u = local(g, 'office-nas')
    g.dns.push({ id: 'r1', type: 'CNAME', name: HOST, content: `${u.id}.cfargotunnel.com`, proxied: true })
    // a CNAME at a locally managed tunnel was not made by this script (set refuses those): refused, nothing changed
    await expect(removeAddress(g.api, cred, { host: HOST })).rejects.toThrow(/managed by a local config file: refused, nothing changed/)
    expect(u.deleted_at).toBeNull() // was 'now'
    expect(touched(g, u.id)).toEqual([])
    expect(writes(g)).toEqual([])
    expect(g.dns.find((d) => d.name === HOST)).toBeDefined()
  })

  test('an empty --tunnel means the default name, not "no tunnel"', async () => {
    const f = fakeCloudflare()
    const t = local(f, defaultTunnelName(HOST))
    await removeAddress(f.api, cred, { host: HOST, tunnel: '' })
    expect(t.deleted_at).toBeNull()
    expect(f.calls.some((c) => c.includes(`name=${defaultTunnelName(HOST)}`))).toBe(true)
  })

  test('an empty remotely managed tunnel reached only through --tunnel (no rule for the name) is kept', async () => {
    const f = fakeCloudflare()
    f.tunnels.push({ id: 'cccccccc-1111-4222-8333-000000000002', name: 'spare', config_src: 'cloudflare', deleted_at: null, config: { ingress: [{ service: 'http_status:404' }] }, secret: 's', connections: 1 })
    const r = await removeAddress(f.api, cred, { host: HOST, tunnel: 'spare' })
    expect(f.tunnels[0]!.deleted_at).toBeNull()
    expect(f.tunnels[0]!.connections).toBe(1)
    expect(touched(f, f.tunnels[0]!.id)).toEqual([])
    expect(r.actions.join('\n')).toMatch(/tunnel spare kept, it has no rule for/)
  })
})
