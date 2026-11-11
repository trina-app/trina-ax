// The only way a Google app connection's calls leave this server's code (docs/GOOGLE-APPS.md "Security"): to the Google
// Workspace MCP server this server started on 127.0.0.1, at exactly the address it was started on (library.ts
// endpoint()), with the person's access token. Nothing anyone types reaches it: a connection's address is a placeholder
// (catalog.ts placeholderUrl) and the generic connection requests (connections/net.ts serviceRequest) keep refusing
// http and this machine as before. node:http, not fetch: no proxy from the environment can ever see the token.
import http from 'node:http'
import type { NetRequest, NetResponse } from '../connections/net'

/** what the AI is told when the library cannot be reached (the app's name first) */
export const downMessage = (name: string) => `${name} is not reachable right now, try again in a minute`
export const TIMEOUT_MS = 30_000
const MAX_BODY = 1024 * 1024

/** The library's address as library.ts gives it, when it is one this transport may use: http, 127.0.0.1, a port, /mcp,
 * nothing else. null otherwise (it is not used). */
export function loopbackEndpoint(endpoint: string | null): URL | null {
  if (!endpoint) return null
  let u: URL
  try { u = new URL(endpoint) } catch { return null }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.pathname !== '/mcp' || u.search || u.hash || u.username || u.password) return null
  return u
}

export class LibraryDown extends Error { name = 'LibraryDown' }

/**
 * One request to the library. `endpoint`: the address the library listens on now; `url` must be exactly it (the MCP
 * client's address). The answer is read up to `maxBytes` (cut, not failed, like net.ts) and until `until` says the
 * reply is in (an event stream may stay open). Throws LibraryDown when it cannot be reached.
 */
export function libraryRequest(endpoint: string | null, url: string, r: NetRequest): Promise<NetResponse> {
  const target = loopbackEndpoint(endpoint)
  if (!target || url !== target.href) return Promise.reject(new LibraryDown('not the library'))
  const max = r.maxBytes ?? MAX_BODY
  return new Promise<NetResponse>((resolve, reject) => {
    let settled = false
    const done = (f: () => void) => { if (!settled) { settled = true; clearTimeout(timer); r.signal?.removeEventListener('abort', onAbort); f() } }
    const headers: Record<string, string> = {}
    for (const [k, v] of r.headers) headers[k] = v
    if (r.body) headers['Content-Length'] = String(r.body.length)
    const req = http.request({ host: '127.0.0.1', port: Number(target.port), path: target.pathname, method: r.method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      let size = 0, truncated = false
      const head = { status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])) }
      const finish = () => done(() => resolve({ ...head, body: Buffer.concat(chunks), truncated }))
      res.on('data', (c: Buffer) => {
        if (settled) return
        const room = max - size
        if (c.length > room) { chunks.push(c.subarray(0, Math.max(0, room))); size = max; truncated = true; res.destroy(); finish(); return }
        chunks.push(c); size += c.length
        if (r.until && r.until(Buffer.concat(chunks), head)) { res.destroy(); finish() }
      })
      res.on('end', finish)
      res.on('error', () => (size ? finish() : done(() => reject(new LibraryDown('read failed')))))
    })
    const onAbort = () => { req.destroy(); done(() => reject(new LibraryDown('stopped'))) }
    const timer = setTimeout(() => { req.destroy(); done(() => reject(new LibraryDown('timeout'))) }, Math.max(1, Math.min(TIMEOUT_MS, (r.long?.deadline ?? Infinity) - Date.now())))
    if (r.signal?.aborted) return onAbort()
    r.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', () => done(() => reject(new LibraryDown('unreachable'))))
    req.end(r.body ?? undefined)
  })
}
