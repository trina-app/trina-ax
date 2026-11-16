// A child server for tests/unit/tunnel-body-memory.test.ts: Bun.serve + directFetch exactly as server/src/main.ts wires
// them, with a public address configured, and a tiny app that reads the body as a stream (like http/multipart.ts).
// Its own process, so its RSS is only its own. Prints "port <n>" when ready.
//   POST /up       reads the whole body, answers its protocol and size ("https:3145728")
//   POST /limited  refuses past 1 MiB with 413 and ends the connection (endConnectionAfter, like http/route.ts)
//   GET  /rss      RSS in bytes after forced collections
import { directFetch, endConnectionAfter } from '../../../server/src/http/tunnel'
import { peerIp } from '../../../server/src/main'

const HOST = process.argv[2] ?? 'app.tunnel-memory.example'
const app = async (req: Request): Promise<Response> => {
  const p = new URL(req.url).pathname
  if (p === '/rss') {
    for (let i = 0; i < 4; i++) { Bun.gc(true); await Bun.sleep(50) }
    return new Response(String(process.memoryUsage().rss))
  }
  if (!req.body) return new Response('none')
  const rd = req.body.getReader()
  let n = 0
  for (;;) {
    const { done, value } = await rd.read()
    if (done) break
    n += value.byteLength
    if (p === '/limited' && n > 1024 * 1024) {
      rd.releaseLock()
      endConnectionAfter(req)
      return new Response('too large', { status: 413, headers: { connection: 'close' } })
    }
  }
  return new Response(`${new URL(req.url).protocol}${n}`)
}
let fetch: ReturnType<typeof directFetch> | null = null
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 120, maxRequestBodySize: 60 * 1024 * 1024, fetch: (req, s) => fetch!(req, s) })
fetch = directFetch({ tunnel: { host: HOST, allowFrom: [], countries: [] }, listen: { host: '127.0.0.1', port: server.port! } }, app, peerIp)
console.log(`port ${server.port}`)
