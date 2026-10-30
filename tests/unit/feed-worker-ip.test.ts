// The release feed Worker's /ip (scripts/release/worker.js): a team server learns its public exit address from it
// (server/src/tools/egress.ts, docs/DECISIONS.md "Exit address on every install"). It answers the caller's own address
// as Cloudflare saw it and nothing else; every path that was served before is served as before (a fake R2 bucket).
import path from 'node:path'
import { describe, expect, test } from 'bun:test'

// plain JavaScript, deployed as it is (scripts/release/hosting.ts): loaded by path, with the one method used here
const worker = (await import(path.join(import.meta.dir, '../../scripts/release/worker.js')) as { default: { fetch(r: Request, e: unknown): Promise<Response> } }).default
const asked: string[] = []
const env = { BUCKET: { async get(key: string) { asked.push(key); return null } } }
const get = (p: string, headers: Record<string, string> = {}, method = 'GET') => worker.fetch(new Request(`https://updates.trina.app${p}`, { method, headers }), env)

describe('feed Worker /ip', () => {
  test('the address Cloudflare saw, as plain text, never cached; the real IPv6 one when pseudo-IPv4 rewrote it', async () => {
    const r = await get('/ip', { 'cf-connecting-ip': '93.184.216.77' })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('93.184.216.77\n')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await (await get('/ip', { 'cf-connecting-ip': '2606:4700::1' })).text()).toBe('2606:4700::1\n')
    expect(await (await get('/ip', { 'cf-connecting-ip': '240.16.0.1', 'cf-connecting-ipv6': '2001:4860::8888' })).text()).toBe('2001:4860::8888\n')
    // without pseudo-IPv4 the address Cloudflare saw wins over an IPv6 header the caller may have sent itself
    expect(await (await get('/ip', { 'cf-connecting-ip': '93.184.216.77', 'cf-connecting-ipv6': '2001:db8::1' })).text()).toBe('93.184.216.77\n')
    expect(await (await get('/ip', { 'cf-connecting-ip': '255.1.2.3', 'cf-connecting-ipv6': '2001:4860::8888' })).text()).toBe('2001:4860::8888\n')
    expect(asked).toEqual([])
  })

  test('no address, or one that is not an address: 404; other methods: 405', async () => {
    expect((await get('/ip')).status).toBe(404)
    expect((await get('/ip', { 'cf-connecting-ip': '<script>' })).status).toBe(404)
    expect((await get('/ip', { 'cf-connecting-ip': '1.2.3.4' }, 'POST')).status).toBe(405)
    expect(asked).toEqual([])
  })

  test('everything served before is unchanged (the root line publish-server.ts checks, manifests, unknown paths)', async () => {
    const root = await get('/')
    expect(await root.text()).toBe('Updates: office/, server/, plugins/\n')
    expect((await get('/server/stable.json')).status).toBe(404) // the fake bucket has nothing
    expect(asked).toEqual(['server/stable.json'])
    expect((await get('/ip/extra', { 'cf-connecting-ip': '1.2.3.4' })).status).toBe(404)
    expect((await get('/whatever')).status).toBe(404)
    expect(asked).toEqual(['server/stable.json'])
  })
})
