// Streaming downloads with Range (tab 4 "다운로드").
// - Whole file: the body is Bun.file(path). Bun.serve sends it with sendfile (measured: 600 MB to a slow client at
//   ~30 MB RSS, while a pull ReadableStream reached 1.6 GB because Bun.serve has no backpressure), and the relay
//   client reads it lazily in 256 KB pieces.
// - Range: Bun 1.3.12 mishandles Bun.file().slice() bodies once anything reads response.body (the stream runs past
//   the slice end; slice().stream() never ends) — both happen on the relay path. So a range is served from our own
//   pull stream over [start, end], and one response carries at most RANGE_MAX bytes (Content-Range says what was
//   sent; media players and PDF viewers ask for the next part). Memory per request stays <= RANGE_MAX even
//   without backpressure.
// The file was authorize()d and opened with O_NOFOLLOW / checked (regular, nlink 1) just before; only the server
// writes inside the team folder, so it cannot be swapped for a link in between.
import fs from 'node:fs'
import { HttpError } from '../http/errors'
import { openChecked } from './place'
import { mimeOf } from './service'

export const RANGE_MAX = 8 * 1024 * 1024
const READ = 256 * 1024

/** Exactly bytes [start, end] of a file, read on demand. */
export function rangeStream(abs: string, start: number, end: number): ReadableStream<Uint8Array> {
  let fd: number | null = null
  let pos = start
  const close = () => { if (fd !== null) { try { fs.closeSync(fd) } catch {} fd = null } }
  return new ReadableStream<Uint8Array>({
    start() { fd = openChecked(abs).fd },
    pull(ctl) {
      const want = Math.min(READ, end + 1 - pos)
      if (want <= 0 || fd === null) { close(); ctl.close(); return }
      const buf = new Uint8Array(want)
      return new Promise<void>((res, rej) => fs.read(fd!, buf, 0, want, pos, (err, n) => {
        if (err) { close(); rej(err); return }
        if (n === 0) { close(); ctl.close(); res(); return }
        pos += n
        ctl.enqueue(buf.subarray(0, n))
        if (pos > end) { close(); ctl.close() }
        res()
      }))
    },
    cancel() { close() },
  })
}

/** Types a browser would run (scripts, active documents): served as text/plain when shown inline. */
const ACTIVE = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/x-javascript|text\/x-javascript)/i

export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'file'
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`
}

/** Parse a single "bytes=a-b" range. null = no / unusable Range header (send everything); 'bad' = 416. */
export function parseRange(h: string | null | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!h) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim())
  if (!m) return null // multiple ranges / other units: ignore Range, send the whole file (allowed by RFC 9110)
  const [a, b] = [m[1]!, m[2]!]
  if (a === '' && b === '') return 'bad'
  let start: number, end: number
  if (a === '') { const n = Number(b); if (n === 0) return 'bad'; start = Math.max(0, size - n); end = size - 1 }
  else { start = Number(a); end = b === '' ? size - 1 : Math.min(Number(b), size - 1) }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'bad'
  return { start, end }
}

export function streamFile(o: { abs: string; name: string; req: Request; disposition: 'inline' | 'attachment'; etag?: string }): Response {
  const { fd, st } = openChecked(o.abs)
  fs.closeSync(fd)
  const size = st.size
  const etag = o.etag ? `"${o.etag}"` : `"${st.ino.toString(36)}-${size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
  let type = mimeOf(o.name) ?? 'application/octet-stream'
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'ETag': etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  if (o.disposition === 'inline' && ACTIVE.test(type)) type = 'text/plain; charset=utf-8'
  // nothing a team member uploaded may run with this origin's rights; PDFs keep the browser viewer working
  if (!/^application\/pdf/i.test(type)) headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
  headers.set('Content-Type', type)
  headers.set('Content-Disposition', contentDisposition(o.disposition, o.name))
  const inm = o.req.headers.get('if-none-match')
  if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) return new Response(null, { status: 304, headers })
  const ifRange = o.req.headers.get('if-range')
  const range = ifRange && ifRange !== etag ? null : parseRange(o.req.headers.get('range'), size)
  if (range === 'bad') {
    headers.set('Content-Range', `bytes */${size}`)
    throw new HttpError('range_not_satisfiable', undefined, { status: 416 })
  }
  const file = Bun.file(o.abs)
  if (!range) {
    headers.set('Content-Length', String(size))
    return new Response(o.req.method === 'HEAD' || size === 0 ? null : file, { status: 200, headers })
  }
  const end = Math.min(range.end, range.start + RANGE_MAX - 1)
  headers.set('Content-Range', `bytes ${range.start}-${end}/${size}`)
  headers.set('Content-Length', String(end - range.start + 1))
  return new Response(o.req.method === 'HEAD' ? null : rangeStream(o.abs, range.start, end), { status: 206, headers })
}
