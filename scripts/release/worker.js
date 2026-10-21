// https://updates.treesoop.com — the office release feed (docs/OFFICE.md "자동 업데이트"), a Cloudflare Worker in
// front of the private R2 bucket teamax-updates (binding BUCKET). Deployed by scripts/release/hosting.ts.
//
// Read-only: GET / HEAD of office/<channel>.json (the signed manifest, never cached) and office/<version>/<file>
// (immutable once published), with Range for resumed downloads. Nothing is listed; every other path is 404. The
// signature and the hashes in the manifest are what the offices trust, not this server.
const KEY = /^office\/(?:(?:stable|beta)\.json|\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+){0,3})?\/[A-Za-z0-9][A-Za-z0-9._+-]{0,150})$/
const MANIFEST = /^office\/(?:stable|beta)\.json$/

const text = (status, body, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } })

export default {
  async fetch(req, env) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method not allowed\n', { allow: 'GET, HEAD' })
    const url = new URL(req.url)
    let key
    try { key = decodeURIComponent(url.pathname).replace(/^\/+/, '') } catch { return text(404, 'Not found\n') }
    if (key === '') return text(200, 'Team AX updates\n')
    if (!KEY.test(key)) return text(404, 'Not found\n')
    const obj = await env.BUCKET.get(key, { range: req.headers, onlyIf: req.headers })
    if (obj === null) return text(404, 'Not found\n')
    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    headers.set('etag', obj.httpEtag)
    headers.set('accept-ranges', 'bytes')
    headers.set('x-content-type-options', 'nosniff')
    headers.set('cache-control', MANIFEST.test(key) ? 'no-cache, no-store' : 'public, max-age=31536000, immutable')
    if (!('body' in obj)) return new Response(null, { status: 304, headers }) // If-None-Match matched
    let status = 200
    if (obj.range && req.headers.has('range')) {
      const size = obj.size
      const start = 'suffix' in obj.range ? size - obj.range.suffix : obj.range.offset ?? 0
      const len = 'suffix' in obj.range ? obj.range.suffix : obj.range.length ?? size - start
      headers.set('content-range', `bytes ${start}-${start + len - 1}/${size}`)
      headers.set('content-length', String(len))
      status = 206
    } else {
      headers.set('content-length', String(obj.size))
    }
    return new Response(req.method === 'HEAD' ? null : obj.body, { status, headers })
  },
}
