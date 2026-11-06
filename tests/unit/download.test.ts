// The hardened download (server/src/tools/download.ts) that generate_video and save_url share: every redirect hop is
// checked again (private, LAN and metadata addresses refused), the connection is pinned to the checked address, the
// body streams to a new file (Content-Length, chunked, up to the close), and a failure leaves no partial file. Local
// test servers stand in for public sites (testAllow lets 127.0.0.1 count as public); no real network.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import nodeNet from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { downloadToFile, type DownloadOptions } from '../../server/src/tools/download'
import { downloadVideo } from '../../server/src/tools/higgsfield'

setDefaultTimeout(20_000)

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-dl-'))
afterAll(() => fs.rmSync(W, { recursive: true, force: true }))
let n = 0
const dst = () => path.join(W, `f${++n}`)

/** 127.0.0.1 stands in for a public site; every other address keeps the real rules */
const LOCAL: DownloadOptions = { testAllow: (ip) => ip === '127.0.0.1', lookup: async () => [{ address: '127.0.0.1', family: 4 }], connectTimeoutMs: 3000, idleTimeoutMs: 1500 }
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(5000)])

let web: ReturnType<typeof Bun.serve>
let secure: ReturnType<typeof Bun.serve>
let raw: nodeNet.Server
let rawPort = 0
/** raw answers by path, for framing that Bun.serve would tidy up */
const RAW: Record<string, (s: nodeNet.Socket) => void> = {
  '/chunked': (s) => s.end('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: image/png\r\n\r\n' + '4\r\nabcd\r\n' + '3;ext=1\r\nefg\r\n' + '0\r\n\r\n'),
  '/cut': (s) => { s.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nonly-a-part'); setTimeout(() => s.destroy(), 50) },
  '/close': (s) => s.end('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\nbody-until-close'),
  '/stall': (s) => s.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nstart'),
  '/continue': (s) => s.end('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'),
  '/gzip': (s) => s.end('HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\nzz'),
  '/nohead': (s) => s.end('not http at all'),
  // a slow drip: one byte at a time, each inside the idle time-out, never ending (a never-closing download)
  '/drip': (s) => {
    s.write('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n')
    const t = setInterval(() => { if (s.destroyed) { clearInterval(t); return } s.write('x') }, 80)
    s.on('close', () => clearInterval(t))
  },
}

beforeAll(async () => {
  web = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const u = new URL(req.url)
      const port = (web as { port: number }).port
      switch (u.pathname) {
        case '/png': return new Response(PNG, { headers: { 'content-type': 'text/html' } })
        case '/to-png': return Response.redirect(`http://127.0.0.1:${port}/png`, 302)
        case '/to-metadata': return Response.redirect('http://169.254.169.254/latest/meta-data/', 302)
        case '/to-lan': return Response.redirect('http://10.0.0.7/x.png', 301)
        case '/to-v6-local': return Response.redirect('http://[::ffff:192.168.1.1]/x', 307)
        case '/to-localhost': return Response.redirect('http://localhost/x', 302)
        case '/to-ftp': return Response.redirect('ftp://example.com/x', 302)
        case '/loop': return Response.redirect(`http://127.0.0.1:${port}/loop`, 302)
        case '/missing': return new Response('no', { status: 404 })
        case '/big': return new Response(Buffer.alloc(300_000, 1))
        default: return new Response('?', { status: 400 })
      }
    },
  })
  const key = path.join(W, 'key.pem'), cert = path.join(W, 'cert.pem')
  Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=video.test', '-addext', 'subjectAltName=DNS:video.test'])
  secure = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) }, fetch: (req) => new Response(`host=${req.headers.get('host')}`) })
  raw = nodeNet.createServer((s) => {
    let buf = ''
    s.on('data', (d) => {
      buf += d.toString('latin1')
      if (!buf.includes('\r\n\r\n')) return
      const p = /^GET (\S+)/.exec(buf)?.[1] ?? ''
      ;(RAW[p] ?? ((x: nodeNet.Socket) => x.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')))(s)
    })
    s.on('error', () => {})
  })
  await new Promise<void>((r) => raw.listen(0, '127.0.0.1', () => r()))
  rawPort = (raw.address() as nodeNet.AddressInfo).port
})
afterAll(() => { web?.stop(true); secure?.stop(true); raw?.close() })

const at = (p: string) => `http://127.0.0.1:${(web as { port: number }).port}${p}`
const rawAt = (p: string) => `http://127.0.0.1:${rawPort}${p}`

describe('downloadToFile', () => {
  test('streams the body to a new 0600 file, with its sha256; the declared type is only reported', async () => {
    const f = dst()
    const r = await downloadToFile(at('/png'), f, LOCAL)
    expect(r.size).toBe(PNG.length)
    expect(r.sha256).toBe(crypto.createHash('sha256').update(PNG).digest('hex'))
    expect(r.contentType).toBe('text/html')
    expect(r.first.subarray(0, 4).toString('latin1')).toBe('\x89PNG')
    expect(fs.readFileSync(f).equals(PNG)).toBe(true)
    expect(fs.statSync(f).mode & 0o777).toBe(0o600)
  })
  test('never writes into an existing file', async () => {
    const f = dst()
    fs.writeFileSync(f, 'keep')
    await expect(downloadToFile(at('/png'), f, LOCAL)).rejects.toThrow()
    expect(fs.readFileSync(f, 'utf8')).toBe('keep')
  })
  test('a redirect to a public address is followed; the final address is reported', async () => {
    const r = await downloadToFile(at('/to-png'), dst(), LOCAL)
    expect(r.url).toBe(at('/png'))
    expect(r.size).toBe(PNG.length)
  })
  test.each([
    ['/to-metadata', /private, local or reserved/], ['/to-lan', /private, local or reserved/], ['/to-v6-local', /private, local or reserved/],
    ['/to-localhost', /local network names/], ['/to-ftp', /only http and https/],
  ])('a redirect from %s is refused on its own hop', async (p, why) => {
    const f = dst()
    await expect(downloadToFile(at(p), f, LOCAL)).rejects.toThrow(why)
    expect(fs.existsSync(f)).toBe(false)
  })
  test('a DNS answer with a private address is refused before any connection', async () => {
    await expect(downloadToFile('http://cdn.example/x.png', dst(), { lookup: async () => [{ address: '192.168.0.10', family: 4 }] })).rejects.toThrow(/private/)
    await expect(downloadToFile('http://169.254.169.254/latest/meta-data/', dst())).rejects.toThrow(/private/)
  })
  test('this server\'s own exit address is refused (hairpin into the office)', async () => {
    await expect(downloadToFile(at('/png'), dst(), { ...LOCAL, blockedIps: () => ['127.0.0.1'] })).rejects.toThrow(/own public address/)
  })
  test('at most 5 redirects', async () => {
    await expect(downloadToFile(at('/loop'), dst(), LOCAL)).rejects.toThrow(/too many redirects/)
  })
  test('https only: the first address and every redirect', async () => {
    await expect(downloadToFile(at('/png'), dst(), { ...LOCAL, httpsOnly: true })).rejects.toThrow(/not https/)
  })
  test('HTTP errors, compressed bodies and non-HTTP answers are errors and leave nothing', async () => {
    for (const [u, why] of [[at('/missing'), /HTTP 404/], [rawAt('/gzip'), /compressed/], [rawAt('/nohead'), /no valid HTTP/]] as const) {
      const f = dst()
      await expect(downloadToFile(u, f, LOCAL)).rejects.toThrow(why)
      expect(fs.existsSync(f)).toBe(false)
    }
  })
  test('chunked and close-delimited bodies; a 100 Continue head is skipped', async () => {
    let f = dst()
    expect((await downloadToFile(rawAt('/chunked'), f, LOCAL)).size).toBe(7)
    expect(fs.readFileSync(f, 'utf8')).toBe('abcdefg')
    f = dst()
    await downloadToFile(rawAt('/close'), f, LOCAL)
    expect(fs.readFileSync(f, 'utf8')).toBe('body-until-close')
    f = dst()
    await downloadToFile(rawAt('/continue'), f, LOCAL)
    expect(fs.readFileSync(f, 'utf8')).toBe('ok')
  })
  test('openEnded is set only when the length is unknown and the body is not chunked (ends at the close)', async () => {
    expect((await downloadToFile(at('/png'), dst(), LOCAL)).openEnded).toBe(false) // Content-Length
    expect((await downloadToFile(rawAt('/chunked'), dst(), LOCAL)).openEnded).toBe(false) // chunked framing
    expect((await downloadToFile(rawAt('/close'), dst(), LOCAL)).openEnded).toBe(true) // close-delimited
  })
  test('a slow drip is stopped by the total time limit (the idle time-out alone never trips); the partial file is deleted', async () => {
    const f = dst()
    await expect(downloadToFile(rawAt('/drip'), f, { ...LOCAL, idleTimeoutMs: 10_000, totalTimeoutMs: 500 })).rejects.toThrow(/time limit/)
    expect(fs.existsSync(f)).toBe(false)
  })
  test('a body cut off before its Content-Length, or a site that stops sending, fails and the partial file is deleted', async () => {
    let f = dst()
    await expect(downloadToFile(rawAt('/cut'), f, LOCAL)).rejects.toThrow(/cut off/)
    expect(fs.existsSync(f)).toBe(false)
    f = dst()
    await expect(downloadToFile(rawAt('/stall'), f, LOCAL)).rejects.toThrow(/stopped sending/)
    expect(fs.existsSync(f)).toBe(false)
  })
  test('maxBytes: refused from Content-Length up front, and counted while streaming', async () => {
    const f = dst()
    await expect(downloadToFile(at('/big'), f, { ...LOCAL, maxBytes: 1000 })).rejects.toThrow(/larger than the limit/)
    expect(fs.existsSync(f)).toBe(false)
    await expect(downloadToFile(rawAt('/close'), dst(), { ...LOCAL, maxBytes: 4 })).rejects.toThrow(/larger than the limit/)
  })
  test('sniff sees the first bytes before anything is written and can stop it', async () => {
    const f = dst()
    let seen = ''
    await expect(downloadToFile(at('/png'), f, { ...LOCAL, sniff: (b) => { seen = b.subarray(1, 4).toString('latin1'); throw new Error('not this type') } })).rejects.toThrow(/not this type/)
    expect(seen).toBe('PNG')
    expect(fs.existsSync(f)).toBe(false)
  })
  test('stop (the turn ended) ends the download', async () => {
    const ac = new AbortController()
    const p = downloadToFile(rawAt('/stall'), dst(), { ...LOCAL, idleTimeoutMs: 10_000, signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    await expect(p).rejects.toThrow(/stopped/)
  })
})

describe('generate_video download (downloadVideo)', () => {
  test('https only, before any connection', async () => {
    await expect(downloadVideo('http://cdn.example/v.mp4', dst())).rejects.toThrow(/not https/)
  })
  test('the result address and each redirect are checked (no plain fetch any more)', async () => {
    // a redirect to the metadata address: refused on that hop (the old download followed it with fetch)
    await expect(downloadVideo(at('/to-metadata'), dst(), { ...LOCAL, httpsOnly: false })).rejects.toThrow(/private, local or reserved/)
    await expect(downloadVideo('https://video.example/v.mp4', dst(), { lookup: async () => [{ address: '10.1.2.3', family: 4 }] })).rejects.toThrow(/private/)
  })
  test('https: the connection goes to the checked address with the name as Host and SNI; a bad certificate fails', async () => {
    const u = `https://video.test:${(secure as { port: number }).port}/v.mp4`
    const f = dst()
    expect(await downloadVideo(u, f, { ...LOCAL, insecureTlsForTests: true })).toBeGreaterThan(0)
    expect(fs.readFileSync(f, 'utf8')).toBe(`host=video.test:${(secure as { port: number }).port}`)
    await expect(downloadVideo(u, dst(), LOCAL)).rejects.toThrow(/certificate|TLS|connect/i)
  })
  test('bytes saved', async () => {
    const f = dst()
    expect(await downloadVideo(at('/png'), f, { ...LOCAL, httpsOnly: false })).toBe(PNG.length)
    expect(fs.readFileSync(f).equals(PNG)).toBe(true)
  })
})
