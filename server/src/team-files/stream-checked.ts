// A download whose bytes come from the very descriptor that was checked (docs/decisions/20261116-folder-share-server.md;
// the design's "Opening a child" step 11).
//
// streamFile (download.ts) checks the file, closes its descriptor and lets the body open the path again. That is safe
// only while nothing but the server writes inside the team folder. A file inside a shared folder is served to someone
// who is not its owner, and the folder may hold links an earlier dev-environment run left there, so here nothing is
// opened twice:
//   1. ONE open, O_RDONLY | O_NOFOLLOW (a symbolic link put at the name after the caller's check is refused by the open);
//   2. fstat of that descriptor: a regular file with one link, whose inode and device are the ones the caller's lstat
//      saw (`expect`): a different file swapped in between the check and the open is refused;
//   3. size, ETag and times from that fstat, and every byte of the body read from that descriptor (fs.read at an
//      offset). Never Bun.file(path), never a second open by path, on the relay path too.
// The descriptor is closed when the body ends, the client leaves, or no body is sent (HEAD, 304, 416, an error).
//
// Bodies: a range is our pull stream over [start, end], at most RANGE_MAX a response, as in download.ts. A whole file
// up to WHOLE_MAX is read whole (it keeps its Content-Length; counted against HELD_CAP with the other bodies read
// whole), a bigger one, or one above the cap, goes as the pull stream. No sendfile here on any platform: sendfile takes
// a path or would need the descriptor to outlive the response, and Bun.serve does not say when a response has gone out.
// The cost is download.ts's macOS cost on Linux too, for these downloads only: what a slow client has not taken yet
// stays in memory, bounded by HELD_CAP for all bodies read whole together.
//
// streamOpen() takes an already checked descriptor, so the owner's own path download (download.ts streamFile) can move
// onto it and the two become one.
import fs from 'node:fs'
import { HttpError } from '../http/errors'
import { Denied, ToolError } from '../policy/errors'
import { contentDisposition, HELD_CAP, heldBytes, holdBody, inlineType, parseRange, RANGE_MAX, WHOLE_MAX } from './download'
import { mimeOf } from './service'

const C = fs.constants
const READ = 256 * 1024
const WHOLE_READ = 1024 * 1024

/** The file a caller checked with lstat: the descriptor opened next must be this one. */
export interface CheckedFile { ino: number; dev: number }

/** Open `abs` once and prove the descriptor is the regular, singly linked file `expect` names. The caller closes it. */
export function openSame(abs: string, expect: CheckedFile): { fd: number; st: fs.Stats } {
  let fd: number
  try { fd = fs.openSync(abs, C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)) } catch (e: any) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new Denied('symbolic links are not followed')
    if (e.code === 'ENOENT') throw new ToolError('not found', 'not_found')
    throw new ToolError(`cannot open file (${e.code})`)
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1) throw new Denied('not a regular file')
    if (st.ino !== expect.ino || st.dev !== expect.dev) throw new Denied('the file changed while it was being opened')
    return { fd, st }
  } catch (e) {
    try { fs.closeSync(fd) } catch {}
    throw e
  }
}

/** Bytes [start, end] of an open descriptor, read on demand; the descriptor is closed at the end or when cancelled. */
export function fdRangeStream(fd: number, start: number, end: number, piece = READ, onClose?: () => void): ReadableStream<Uint8Array> {
  let open = true
  let pos = start
  const close = () => { if (open) { open = false; try { fs.closeSync(fd) } catch {} onClose?.() } }
  return new ReadableStream<Uint8Array>({
    pull(ctl) {
      const want = Math.min(piece, end + 1 - pos)
      if (want <= 0 || !open) { close(); ctl.close(); return }
      const buf = new Uint8Array(want)
      return new Promise<void>((res, rej) => fs.read(fd, buf, 0, want, pos, (err, n) => {
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

/** The whole of an open descriptor's first `size` bytes in memory (read on Bun's thread pool). Closes it. */
async function readWhole(fd: number, size: number): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const buf = new Uint8Array(size)
    let got = 0
    while (got < size) {
      const k = await new Promise<number>((res, rej) => fs.read(fd, buf, got, Math.min(WHOLE_READ * 8, size - got), got, (err, r) => (err ? rej(err) : res(r))))
      if (k === 0) break
      got += k
    }
    return got === size ? buf : buf.subarray(0, got)
  } finally {
    try { fs.closeSync(fd) } catch {}
  }
}

export interface StreamOpts { name: string; req: Request; disposition: 'inline' | 'attachment'; etag?: string; cache?: `private, ${string}`; wholeMax?: number; heldCap?: number }

/** The response for an already checked, open descriptor (`fd`, with its fstat `st`): headers as streamFile sends them,
 * the body from the descriptor alone. Always ends with the descriptor closed (or handed to the body, which closes it). */
export async function streamOpen(fd: number, st: fs.Stats, o: StreamOpts): Promise<Response> {
  let mine = true
  const done = () => { if (mine) { mine = false; try { fs.closeSync(fd) } catch {} } }
  try {
    const size = st.size
    const etag = o.etag ? `"${o.etag}"` : `"${st.ino.toString(36)}-${size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
    const type = inlineType(mimeOf(o.name) ?? 'application/octet-stream', o.disposition)
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'ETag': etag,
      'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': o.cache ?? 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    // nothing a team member uploaded may run with this origin's rights; PDFs keep the browser viewer working
    if (!/^application\/pdf/i.test(type)) headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
    headers.set('Content-Type', type)
    headers.set('Content-Disposition', contentDisposition(o.disposition, o.name))
    const inm = o.req.headers.get('if-none-match')
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) { done(); return new Response(null, { status: 304, headers }) }
    const ifRange = o.req.headers.get('if-range')
    const range = ifRange && ifRange !== etag ? null : parseRange(o.req.headers.get('range'), size)
    if (range === 'bad') throw new HttpError('range_not_satisfiable', undefined, { status: 416 })
    const head = o.req.method === 'HEAD'
    if (!range) {
      headers.set('Content-Length', String(size))
      if (head || size === 0) { done(); return new Response(null, { status: 200, headers }) }
      mine = false
      if (size > (o.wholeMax ?? WHOLE_MAX) || heldBytes() + size > (o.heldCap ?? HELD_CAP)) return new Response(fdRangeStream(fd, 0, size - 1, WHOLE_READ), { status: 200, headers })
      const release = holdBody(size, o.req.signal)
      try { return new Response(await readWhole(fd, size), { status: 200, headers }) } catch (e) { release(); throw e }
    }
    const end = Math.min(range.end, range.start + RANGE_MAX - 1)
    headers.set('Content-Range', `bytes ${range.start}-${end}/${size}`)
    headers.set('Content-Length', String(end - range.start + 1))
    if (head) { done(); return new Response(null, { status: 206, headers }) }
    mine = false
    return new Response(fdRangeStream(fd, range.start, end), { status: 206, headers })
  } catch (e) {
    done()
    throw e
  }
}

/** A download of `abs`, which the caller just checked (`expect`: the inode and device its lstat saw): one open, the
 * descriptor proven to be that file, the body read from it. */
export function streamChecked(o: StreamOpts & { abs: string; expect: CheckedFile }): Promise<Response> {
  const { fd, st } = openSame(o.abs, o.expect)
  return streamOpen(fd, st, o)
}
