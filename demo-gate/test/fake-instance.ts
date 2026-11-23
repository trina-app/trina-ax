// A stand-in for one demo instance (the gate's pool.command in tests), run by Node like the gate:
//   node demo-gate/test/fake-instance.ts --config <server.json>
// It listens where the gate's server.json says and answers what the gate needs (health, the persona sign-in), plus
// /echo (what reached it: path, headers, its config and environment) and a WebSocket echo on /ws.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'

const i = process.argv.indexOf('--config')
const file = i >= 0 ? process.argv[i + 1]! : process.env.MYCEL_CONFIG!
const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { listen: { port: number } }

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/api/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}') }
  if (url.pathname === '/api/demo/persona' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      // the real server's check (server/src/routes/demo.ts gateKeyOk)
      let want = ''
      try { want = (JSON.parse(fs.readFileSync(process.env.MYCEL_DEMO!, 'utf8')) as { gateKeySha256?: string }).gateKeySha256 ?? '' } catch {}
      const shown = req.headers['x-mycel-demo-gate']
      if (want && (typeof shown !== 'string' || crypto.createHash('sha256').update(shown).digest('hex') !== want) && !fs.existsSync('no-gate-key-check')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"code":"unauthorized"}}') }
      const okOrigin = req.headers.origin === process.env.MYCEL_PUBLIC_ORIGINS && req.headers['x-mycel-csrf'] === '1'
      let key = ''
      try { key = (JSON.parse(body) as { key?: string }).key ?? '' } catch {}
      if (!okOrigin || key !== 'newHire' || fs.existsSync('persona-fails')) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":{"code":"csrf"}}') }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': [`__Host-sid=${crypto.randomBytes(24).toString('base64url')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`] })
      res.end('{"ok":true}')
    })
    return
  }
  // what the real server's GET /api/demo says, from the demo file (the gate checks it before the instance is warm)
  if (url.pathname === '/api/demo') {
    let d: { kind?: string; builder?: boolean; limitTokens?: number } = {}
    try { d = JSON.parse(fs.readFileSync(process.env.MYCEL_DEMO!, 'utf8')) } catch {}
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ company: 'Steepling', kind: d.kind ?? 'freeRoam', ...(d.builder ? { builder: true } : {}), used: 0, cap: d.limitTokens ?? 300_000 }))
  }
  if (url.pathname === '/echo' || url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['seen=1; Path=/; Domain=example.com'] })
    return res.end(JSON.stringify({ path: req.url, method: req.method, headers: req.headers, dir: process.cwd(), config, env: process.env }))
  }
  // HTML with its own Cache-Control (the gate adds no-transform to it, keeping the rest)
  if (url.pathname === '/cached') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, max-age=60' }); return res.end('<p>cached</p>') }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<p>instance ${process.cwd()}</p>`)
})
server.on('upgrade', (req, sock) => {
  if (!req.url?.startsWith('/ws')) { sock.end('HTTP/1.1 404 Not Found\r\n\r\n'); return }
  const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Seen-Cookie: ${req.headers.cookie ?? ''}\r\n\r\n`)
  // raw bytes back as they came (the gate only pipes; the test reads its own bytes)
  sock.on('data', (d) => sock.write(d))
  sock.on('error', () => {})
})
server.listen(config.listen.port, '127.0.0.1')
// a helper in the same process group, as the real server's launcher and engines are (the sweeper must end it too);
// its command line names the instance folder, like theirs
if (fs.existsSync('spawn-child')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.cwd()], { stdio: 'ignore' })
  fs.writeFileSync('child-pid', String(child.pid))
  fs.writeFileSync('leader-pid', String(process.pid))
}
process.on('SIGTERM', () => process.exit(0))
