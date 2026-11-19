// A stand-in for one demo instance (the gate's pool.command in tests), run by Node like the gate:
//   node demo-gate/test/fake-instance.ts --config <server.json>
// It listens where the gate's server.json says and answers what the gate needs (health, the persona sign-in), plus
// /echo (what reached it: path, headers, its config and environment) and a WebSocket echo on /ws.
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
      const okOrigin = req.headers.origin === process.env.MYCEL_PUBLIC_ORIGINS && req.headers['x-mycel-csrf'] === '1'
      let key = ''
      try { key = (JSON.parse(body) as { key?: string }).key ?? '' } catch {}
      if (!okOrigin || key !== 'newHire' || fs.existsSync('persona-fails')) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":{"code":"csrf"}}') }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': [`mycel-dev-sid=${crypto.randomBytes(24).toString('base64url')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`] })
      res.end('{"ok":true}')
    })
    return
  }
  if (url.pathname === '/echo' || url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['seen=1; Path=/; Domain=example.com'] })
    return res.end(JSON.stringify({ path: req.url, method: req.method, headers: req.headers, dir: process.cwd(), config, env: process.env }))
  }
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
process.on('SIGTERM', () => process.exit(0))
