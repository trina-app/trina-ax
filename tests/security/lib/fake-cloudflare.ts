// A small in-memory Cloudflare API (zones, DNS records, tunnels with their ingress, secret and connector token) for
// the public-address.ts regressions. The connector token is derived from the tunnel id and its secret, as at
// Cloudflare, so a rotated secret gives a different token and the old one stops matching.
import type { Api } from '../../../scripts/office/public-address'

export interface FakeTunnel { id: string; name: string; config_src: string; deleted_at: string | null; config: any; secret: string; connections: number }
export interface FakeCf { api: Api; calls: string[]; dns: { id: string; type: string; name: string; content: string; proxied: boolean }[]; tunnels: FakeTunnel[] }

export const ZONE = 'office-test.example'
export const cred = { zoneId: 'z1', accountId: 'acc1' }
export const tokenOf = (t: Pick<FakeTunnel, 'id' | 'secret'>) => Buffer.from(JSON.stringify({ a: 'acc1', t: t.id, s: t.secret })).toString('base64')
/** a connector token still lets its holder connect: the tunnel exists and has this secret */
export const tokenConnects = (f: FakeCf, token: string) => {
  const j = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as { t: string; s: string }
  return f.tunnels.some((t) => t.id === j.t && !t.deleted_at && t.secret === j.s)
}

export function fakeCloudflare(): FakeCf {
  const f: FakeCf = { calls: [], dns: [{ id: 'r-apex', type: 'A', name: ZONE, content: '192.0.2.1', proxied: true }], tunnels: [], api: null as unknown as Api }
  let n = 0
  f.api = async (method, p, body: any) => {
    f.calls.push(`${method} ${p}`)
    const u = new URL('https://x' + p)
    let m: RegExpExecArray | null
    if (method === 'GET' && /^\/zones\/z1$/.test(u.pathname)) return { id: 'z1', name: ZONE, account: { id: 'acc1' } }
    if ((m = /^\/zones\/z1\/dns_records(?:\/([\w-]+))?$/.exec(u.pathname))) {
      if (method === 'GET') return f.dns.filter((r) => r.name === u.searchParams.get('name'))
      if (method === 'POST') { const r = { id: `r${++n}`, ...body }; f.dns.push(r); return r }
      const i = f.dns.findIndex((r) => r.id === m![1])
      if (i < 0) throw new Error('no such record')
      if (method === 'PATCH') { Object.assign(f.dns[i]!, body); return f.dns[i] }
      if (method === 'DELETE') { f.dns.splice(i, 1); return { id: m[1] } }
    }
    if ((m = /^\/accounts\/acc1\/cfd_tunnel(?:\/([\w-]+))?(?:\/(configurations|token|connections))?$/.exec(u.pathname))) {
      const t = m[1] ? f.tunnels.find((x) => x.id === m![1] && !x.deleted_at) : undefined
      if (!m[1] && method === 'GET') return f.tunnels.filter((x) => !x.deleted_at && (!u.searchParams.has('name') || x.name === u.searchParams.get('name')))
      if (!m[1] && method === 'POST') {
        const x: FakeTunnel = { id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(++n).padStart(12, '0')}`, name: body.name, config_src: body.config_src, deleted_at: null, config: null, secret: `secret-${n}`, connections: 0 }
        f.tunnels.push(x)
        return x
      }
      if (!t) throw new Error('tunnel not found')
      if (m[2] === 'configurations' && method === 'GET') return { config: t.config }
      if (m[2] === 'configurations' && method === 'PUT') { t.config = body.config; return { config: t.config } }
      if (m[2] === 'token' && method === 'GET') return tokenOf(t)
      if (m[2] === 'connections' && method === 'DELETE') { t.connections = 0; return null }
      if (!m[2] && method === 'GET') return t
      if (!m[2] && method === 'PATCH') {
        if (typeof body.tunnel_secret !== 'string' || Buffer.from(body.tunnel_secret, 'base64').length < 32) throw new Error('bad secret')
        t.secret = body.tunnel_secret
        return t
      }
      if (!m[2] && method === 'DELETE') { t.deleted_at = 'now'; return t }
    }
    throw new Error(`unexpected ${method} ${p}`)
  }
  return f
}

export const writes = (f: FakeCf) => f.calls.filter((c) => !c.startsWith('GET'))
