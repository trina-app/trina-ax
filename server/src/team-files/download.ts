// Streaming downloads with Range (tab 4 "다운로드").
// - Whole file (and a resumed download to the end, routes/downloads.ts): fileBody(). On Linux the body is
//   Bun.file(path), which Bun.serve sends with sendfile (measured: 600 MB to a slow client at ~30 MB RSS, while a pull
//   ReadableStream reached 1.6 GB because Bun.serve has no backpressure), and the relay client reads it lazily in
//   256 KB pieces. Elsewhere (macOS: the office Mac, dev) never sendfile: XNU's sendfile allocates its buffers (M_WAIT)
//   and reads the file into them before it looks at the socket's non-blocking flag, so a slow client of a file that is
//   not in memory parked the server's only JS thread in the kernel (QA TC-222: /api/health unanswered for 352 s,
//   `sample` in sendfile, state U). Bun 1.4 stopped using it on macOS for this reason (oven-sh/bun#33728). There a file
//   up to WHOLE_MAX is read whole on Bun's thread pool (an in-memory body keeps its Content-Length: Bun 1.3.12 drops
//   the header of a stream body and sends it chunked; it is what Bun itself does for a Bun.file body over TLS, the
//   office Mac's LAN listener), a bigger one goes as our pull stream. The cost on Bun 1.3.12, which has no backpressure
//   for either: what a slow client has not taken yet stays in memory (at most the file, freed when the download ends
//   or the client leaves). Bun 1.4 applies backpressure to stream bodies.
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
/** pieces of a whole-file stream and of a whole read: fewer reads for hundreds of MB */
const WHOLE_READ = 1024 * 1024
/** without sendfile (macOS), a body up to this size is read whole, so it keeps its Content-Length (see the top) */
export const WHOLE_MAX = 256 * 1024 * 1024

/** Bun.file bodies (sendfile) only where sendfile cannot block the JS thread: Linux (see the top of this file). */
export const SENDFILE = process.platform === 'linux'

/** Exactly bytes [start, end] of a file, read on demand (on Bun's thread pool: the JS thread never waits on the disk). */
export function rangeStream(abs: string, start: number, end: number, piece = READ): ReadableStream<Uint8Array> {
  let fd: number | null = null
  let pos = start
  const close = () => { if (fd !== null) { try { fs.closeSync(fd) } catch {} fd = null } }
  return new ReadableStream<Uint8Array>({
    start() { fd = openChecked(abs).fd },
    pull(ctl) {
      const want = Math.min(piece, end + 1 - pos)
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

/**
 * The body for bytes [start, size - 1] of a file: the whole file (start 0) or a download resumed to its end. Linux:
 * Bun.file (sendfile, constant memory). Elsewhere (see the top): read whole up to WHOLE_MAX, else our stream, so a slow
 * client cannot stop the server. `size` is the size the caller put in Content-Length; the body never runs past it.
 */
export async function fileBody(abs: string, start: number, size: number, o: { sendfile?: boolean; wholeMax?: number } = {}): Promise<Blob | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>> {
  if (o.sendfile ?? SENDFILE) return start === 0 ? Bun.file(abs) : Bun.file(abs).slice(start)
  if (size - start > (o.wholeMax ?? WHOLE_MAX)) return rangeStream(abs, start, size - 1, WHOLE_READ)
  const { fd } = openChecked(abs)
  try {
    const buf = new Uint8Array(size - start)
    let got = 0
    while (got < buf.length) {
      const n = await new Promise<number>((res, rej) => fs.read(fd, buf, got, Math.min(WHOLE_READ * 8, buf.length - got), start + got, (err, k) => err ? rej(err) : res(k)))
      if (n === 0) break
      got += n
    }
    return got === buf.length ? buf : buf.subarray(0, got)
  } finally {
    fs.closeSync(fd)
  }
}

/** Types a browser would run (scripts of every name: JavaScript, ECMAScript, JScript, LiveScript; active documents: HTML,
 * every XML document, which can carry XHTML scripts, such as RSS, Atom, XSLT, MathML, SMIL and XUL): served as
 * text/plain when shown inline. */
const ACTIVE = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/xsl|text\/mathml|text\/vnd\.wap\.wml)|^[^;]*\+xml\b|^(text|application)\/(x-)?(java|ecma|j|live)script\b/i

/** The download's file name. NFC: a name stored decomposed (typed on a Mac before names were composed) would show as
 * split letters on Windows (QA TC-225). */
export function contentDisposition(kind: 'inline' | 'attachment', stored: string): string {
  const name = stored.normalize('NFC')
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

export async function streamFile(o: { abs: string; name: string; req: Request; disposition: 'inline' | 'attachment'; etag?: string }): Promise<Response> {
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
  if (!range) {
    headers.set('Content-Length', String(size))
    return new Response(o.req.method === 'HEAD' || size === 0 ? null : await fileBody(o.abs, 0, size), { status: 200, headers })
  }
  const end = Math.min(range.end, range.start + RANGE_MAX - 1)
  headers.set('Content-Range', `bytes ${range.start}-${end}/${size}`)
  headers.set('Content-Length', String(end - range.start + 1))
  return new Response(o.req.method === 'HEAD' ? null : rangeStream(o.abs, range.start, end), { status: 206, headers })
}
