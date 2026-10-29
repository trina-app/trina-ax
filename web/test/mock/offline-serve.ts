// Stoppable production-web fixture. Keep mock sessions in memory while the HTTP listener is truly stopped.
import path from 'node:path'
import { MockServer } from './server'

const port = Number(process.env.MOCK_PORT ?? 19842)
const dist = path.resolve(import.meta.dirname, '../../dist')
const mock = new MockServer()
const handle = mock.handle.bind(mock)
let mode = 'online'
mock.handle = async (req, root) => {
  const url = new URL(req.url)
  if (mode === 'api-down' && url.pathname.startsWith('/api/')) return new Response('Unavailable', { status: 503 })
  if (mode === '503' && req.headers.get('sec-fetch-mode') === 'navigate') {
    return new Response('<!doctype html><html><body><h1>Scheduled maintenance</h1></body></html>', {
      status: 503, headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
    })
  }
  return handle(req, root)
}
let server: ReturnType<typeof mock.serve> | null = mock.serve(port, dist)
Bun.serve({
  hostname: '127.0.0.1', port: port + 1,
  async fetch(req) {
    if (req.method !== 'POST') return new Response(`offline-fixture:${process.pid}`)
    mode = await req.text()
    if (mode === 'stop') {
      await server?.stop(true)
      server = null
    } else if (!server) server = mock.serve(port, dist)
    return new Response('ok')
  },
})
