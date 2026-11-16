// Requests through the office / server public address (cloudflared -> 127.0.0.1:<app port>) keep Bun's own request
// object: directFetch must not wrap it in `new Request(url, req)`. Under Bun 1.3.12 a wrapped body became a JS stream in
// which every socket read was its own buffer that garbage collection did not count; cloudflared forwards chunked
// bodies in small pieces, so a 3 MB upload kept about 550 MB and three 100 MB uploads took a 4 GB server down
// (docs/decisions/20261116-tunnel-request-body-memory.md). Also: a request refused before its body ended
// (endConnectionAfter) ends its connection instead of being read to its end.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { directFetch, endConnectionAfter } from '../../server/src/http/tunnel'
import { peerIp } from '../../server/src/main'

const HOST = 'app.tunnel-memory.example'
const REPO = path.join(import.meta.dir, '../..')

describe('directFetch keeps the request Bun handed over', () => {
  const cfg = { tunnel: { host: HOST, allowFrom: [], countries: [] }, listen: { host: '127.0.0.1', port: 47831 } }
  const srv = (o: { timeout?: (r: Request, s: number) => void } = {}) => ({ requestIP: () => ({ address: '127.0.0.1' }), port: 47831, ...o })

  test('through the public address: the same object, its url https://<host>/..., body untouched', async () => {
    const orig = new Request(`http://${HOST}/api/files/upload?x=1`, { method: 'POST', headers: { host: HOST, 'cf-connecting-ip': '203.0.113.9' }, body: 'abc' })
    let seen = null as Request | null
    let env: Record<string, unknown> = {}
    await directFetch(cfg, (req, e) => { seen = req; env = e as never; return new Response('ok') }, peerIp)(orig, srv())
    expect(seen === orig).toBe(true)
    expect(seen!.url).toBe(`https://${HOST}/api/files/upload?x=1`)
    expect(new URL(seen!.url).origin).toBe(`https://${HOST}`)
    expect(env).toMatchObject({ tunnel: true, ip: '203.0.113.9', via: 'direct' })
    expect(env.upgradeReq).toBeUndefined()
    expect(await seen!.text()).toBe('abc')
    // fixed once set
    expect(() => Object.defineProperty(seen!, 'url', { value: 'http://evil.example/' })).toThrow()
  })

  test('anything else is passed as it is', async () => {
    const orig = new Request('http://localhost:47831/api/health', { headers: { host: 'localhost:47831' } })
    let seen = null as Request | null
    await directFetch(cfg, (req) => { seen = req; return new Response('ok') }, peerIp)(orig, srv())
    expect(seen === orig).toBe(true)
    expect(seen!.url).toBe('http://localhost:47831/api/health')
    expect(Object.getOwnPropertyDescriptor(orig, 'url')).toBeUndefined()
  })

  test('a request marked by endConnectionAfter gets server.timeout(req, 1); other answers do not', async () => {
    const calls: number[] = []
    const s = srv({ timeout: (_r, sec) => { calls.push(sec) } })
    const post = (host = 'localhost:47831') => new Request(`http://${host}/x`, { method: 'POST', headers: { host }, body: 'x' })
    await directFetch(cfg, (req) => { endConnectionAfter(req); return new Response('no', { status: 413 }) }, peerIp)(post(), s)
    expect(calls).toEqual([1])
    await directFetch(cfg, (req) => { endConnectionAfter(req); return new Response('no', { status: 413 }) }, peerIp)(post(HOST), s)
    expect(calls).toEqual([1, 1])
    // Connection: close alone (a streamed answer could carry it) does not cut the connection
    await directFetch(cfg, () => new Response('ok', { headers: { connection: 'close' } }), peerIp)(post(), s)
    expect(calls).toEqual([1, 1])
  })

  test('no source file wraps an incoming request in a new Request or clones it', () => {
    // a wrapped or cloned request loses Bun's own body (memory) or the public URL (http/tunnel.ts withPublicUrl)
    const t = fs.readFileSync(path.join(REPO, 'server/src/http/tunnel.ts'), 'utf8')
    const code = t.split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l))
    expect(code.filter((l) => l.includes('new Request(')).length).toBe(1) // withPublicUrl's fallback only
    const files = [...new Bun.Glob('server/src/**/*.ts').scanSync(REPO)]
    const clones = files.filter((f) => /\b(?:req|request|raw)\.clone\(\)/.test(fs.readFileSync(path.join(REPO, f), 'utf8')))
    expect(clones).toEqual([])
  })
})

describe('over a real socket, body sent in small pieces like cloudflared (child server)', () => {
  let child: ReturnType<typeof Bun.spawn>
  let port = 0
  beforeAll(async () => {
    child = Bun.spawn([process.execPath, path.join(REPO, 'tests/fixtures/tunnel-body-memory/server.ts'), HOST], { cwd: REPO, stdout: 'pipe', stderr: 'inherit' })
    const rd = (child.stdout as ReadableStream<Uint8Array>).getReader()
    let out = ''
    while (!/port \d+/.test(out)) {
      const { value, done } = await rd.read()
      if (done) throw new Error('the test server ended: ' + out)
      out += new TextDecoder().decode(value)
    }
    rd.releaseLock()
    port = Number(/port (\d+)/.exec(out)![1])
  })
  afterAll(() => { child?.kill() })

  const rss = async () => Number(await (await fetch(`http://127.0.0.1:${port}/rss`)).text())

  /** POST `bytes` chunked in 1415-byte writes, each after a timer turn (cloudflared's typical piece) */
  const send = (p: string, bytes: number, o: { untilClosed?: boolean } = {}) => new Promise<{ first: string; body: string; closedMs: number | null; sent: number }>((resolve) => {
    let out = '', sent = 0, closedMs: number | null = null, answeredAt = 0
    const sock = net.connect(port, '127.0.0.1', async () => {
      sock.write(`POST ${p} HTTP/1.1\r\nHost: ${HOST}\r\nTransfer-Encoding: chunked\r\n\r\n`)
      const piece = Buffer.alloc(1415, 97)
      while (sent < bytes && !sock.destroyed && (o.untilClosed || !out)) {
        const ok = sock.write('587\r\n') && sock.write(piece) && sock.write('\r\n')
        sent += piece.byteLength
        await new Promise((r) => ok ? setTimeout(r, 0) : sock.once('drain', r))
      }
      if (!sock.destroyed && !out) sock.write('0\r\n\r\n')
    })
    sock.on('data', (d) => {
      if (!out) { answeredAt = Date.now(); if (!o.untilClosed) setTimeout(() => sock.destroy(), 100) }
      out += d
    })
    sock.on('end', () => { closedMs = Date.now() - answeredAt })
    sock.on('close', () => resolve({ first: out.split('\r\n')[0] ?? '', body: out.split('\r\n\r\n')[1] ?? '', closedMs, sent }))
    sock.on('error', () => {})
  })

  test('3 MB bodies through the public address leave no large leftover memory', async () => {
    const warm = await send('/up', 256 * 1024)
    expect(warm.first).toBe('HTTP/1.1 200 OK')
    const before = await rss()
    for (let i = 0; i < 2; i++) {
      const r = await send('/up', 3 * 1024 * 1024)
      expect(r.first).toBe('HTTP/1.1 200 OK')
      expect(r.body).toContain('https:') // the app saw the public https URL
    }
    // wrapped (before the fix) this kept 500+ MB on Bun 1.3.12; unwrapped it is a few MB
    expect((await rss()) - before).toBeLessThan(150 * 1024 * 1024)
  }, 90_000)

  test('a body refused early ends the connection instead of being read to its end', async () => {
    const r = await send('/limited', 400 * 1024 * 1024, { untilClosed: true })
    expect(r.first).toBe('HTTP/1.1 413 Payload Too Large')
    expect(r.closedMs).not.toBeNull()
    expect(r.closedMs!).toBeLessThan(15_000)
    expect(r.sent).toBeLessThan(400 * 1024 * 1024)
  }, 60_000)
})
