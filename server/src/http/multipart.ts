// A multipart/form-data upload read as a stream: the file part goes straight to a private temp file (hashed on the
// way), the text fields stay small, and the limit is counted while the bytes arrive. Nothing of the file is kept in
// memory beyond one network read and the few bytes a part delimiter can span.
//
// Why not Request.formData(): it reads the whole body into memory before anything can be checked, and Bun 1.3.12 does
// not apply Bun.serve's maxRequestBodySize to a body without Content-Length (Transfer-Encoding: chunked, which a proxy
// in front may choose). Such a request of any size was held in memory whole, and that memory was not given back: a few
// 100 MB uploads to POST /api/rooms/:id/files took a 3.8 GB team server down (out of memory, 0.5.9).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fail } from './errors'

/** The file part of a multipart upload, on disk. `path` is removed after the handler unless it moved the file away. */
export interface SpooledFile {
  /** a private temp file (0600) holding the part's bytes */
  path: string
  size: number
  /** the part's filename as sent ('' when none) */
  name: string
  /** sha256 of the bytes, hex */
  sha256: string
}

export interface SpoolOptions {
  /** the most bytes the file part may have (413 beyond, while it streams) */
  maxBytes: number
  /** where the temp file is made (created 0700 when missing) */
  dir: string
  /** the name of the file field (default 'file'); a second one, or any other part with a filename, is refused */
  field?: string
}

/** everything that is not the file: part headers, delimiters and the text fields together */
export const MULTIPART_OVERHEAD_MAX = 64 * 1024
const HEADERS_MAX = 16 * 1024
const FIELDS_MAX = 100

const boundaryOf = (contentType: string): string | null => {
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType)
  return m ? (m[1] ?? m[2])! : null
}

/** name and filename of a part's Content-Disposition (browsers send the name bytes as UTF-8, `"` as %22) */
function disposition(headers: string): { name: string; filename: string | null } | null {
  const line = headers.split('\r\n').find((l) => /^content-disposition:/i.test(l))
  if (!line || !/^content-disposition:\s*form-data\b/i.test(line)) return null
  const param = (k: string) => {
    const m = new RegExp(`;\\s*${k}="((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(line) ?? new RegExp(`;\\s*${k}=([^;\\s"]+)`, 'i').exec(line)
    return m ? m[1]! : null
  }
  const name = param('name')
  return name === null ? null : { name, filename: param('filename') }
}

/**
 * Read a multipart/form-data request: the text fields, and the one file part written to a temp file in `o.dir`.
 * 413 payload_too_large as soon as the declared length or the bytes that arrived pass the limit (the rest of the body is
 * not read); 400 bad_request for a body that is not well-formed multipart. On any failure, a dropped connection too, the
 * temp file is removed.
 */
export async function spoolMultipart(req: Request, o: SpoolOptions): Promise<{ fields: Record<string, string>; file: SpooledFile | null }> {
  const total = o.maxBytes + MULTIPART_OVERHEAD_MAX
  const declared = req.headers.get('content-length')
  if (declared !== null && Number(declared) > total) fail('payload_too_large')
  const ct = req.headers.get('content-type') ?? ''
  const boundary = /^multipart\/form-data\b/i.test(ct) ? boundaryOf(ct) : null
  if (!boundary || !req.body) fail('bad_request')
  const first = Buffer.from(`--${boundary}`, 'latin1')
  const delim = Buffer.from(`\r\n--${boundary}`, 'latin1')
  const fieldName = o.field ?? 'file'

  const reader = req.body!.getReader()
  let buf: Buffer = Buffer.alloc(0)
  let read = 0
  let ended = false
  /** more bytes into buf; false at the end of the body */
  const more = async (): Promise<boolean> => {
    if (ended) return false
    const { value, done } = await reader.read()
    if (done) { ended = true; return false }
    read += value.byteLength
    if (read > total) fail('payload_too_large')
    buf = buf.length ? Buffer.concat([buf, value]) : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    return true
  }
  /** buf holds at least n bytes (400 when the body ends first) */
  const need = async (n: number) => { while (buf.length < n) if (!(await more())) fail('bad_request') }

  const fields: Record<string, string> = {}
  let fieldCount = 0
  let overhead = 0
  let file: SpooledFile | null = null
  let preamble = 0
  let skipped = false
  let fd: number | null = null
  let tmp: string | null = null
  try {
    // the first delimiter (a preamble before it is allowed and ignored)
    for (;;) {
      const at = buf.indexOf(first)
      // at the very start of the body, or at the start of a line
      if ((at === 0 && !skipped) || (at > 1 && buf[at - 2] === 13 && buf[at - 1] === 10)) { buf = buf.subarray(at + first.length); break }
      if (at >= 0) { skipped = true; buf = buf.subarray(at + first.length - 1); continue }
      // no delimiter yet: only the bytes that could be its start are kept (a preamble is searched once, not again with
      // every read)
      preamble += Math.max(0, buf.length - (first.length + 1))
      if (preamble > MULTIPART_OVERHEAD_MAX) fail('bad_request')
      if (buf.length > first.length + 1) { skipped = true; buf = Buffer.from(buf.subarray(buf.length - (first.length + 1))) }
      if (!(await more())) fail('bad_request')
    }
    for (;;) {
      // after a delimiter: "--" ends the body, CRLF starts a part
      await need(2)
      if (buf[0] === 45 && buf[1] === 45) break
      if (buf[0] !== 13 || buf[1] !== 10) fail('bad_request')
      buf = buf.subarray(2)
      let end: number
      while ((end = buf.indexOf('\r\n\r\n')) < 0) {
        if (buf.length > HEADERS_MAX) fail('bad_request')
        if (!(await more())) fail('bad_request')
      }
      if (end > HEADERS_MAX) fail('bad_request')
      const d = disposition(buf.subarray(0, end).toString('utf8'))
      if (!d) fail('bad_request')
      buf = buf.subarray(end + 4)
      overhead += end + 4 + delim.length
      const isFile = d!.filename !== null
      if (isFile && (d!.name !== fieldName || file || fd !== null)) fail('bad_request')
      if (!isFile && ++fieldCount > FIELDS_MAX) fail('bad_request')

      let size = 0
      const hash = isFile ? crypto.createHash('sha256') : null
      const text: Buffer[] = []
      if (isFile) {
        fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 })
        tmp = path.join(o.dir, 'up-' + crypto.randomBytes(12).toString('hex'))
        fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      }
      const take = async (bytes: Buffer) => {
        if (!bytes.length) return
        size += bytes.length
        if (isFile) {
          if (size > o.maxBytes) fail('payload_too_large')
          hash!.update(bytes)
          let off = 0
          while (off < bytes.length) off += await new Promise<number>((res, rej) => fs.write(fd!, bytes, off, bytes.length - off, null, (err, n) => (err ? rej(err) : res(n))))
        } else {
          overhead += bytes.length
          if (overhead > MULTIPART_OVERHEAD_MAX) fail('payload_too_large')
          text.push(Buffer.from(bytes))
        }
      }
      // the part's bytes run to the next delimiter; while none is in sight, all but what could be its start is taken
      for (;;) {
        const at = buf.indexOf(delim)
        if (at >= 0) { await take(buf.subarray(0, at)); buf = buf.subarray(at + delim.length); break }
        const keep = Math.min(buf.length, delim.length - 1)
        await take(buf.subarray(0, buf.length - keep))
        buf = Buffer.from(buf.subarray(buf.length - keep))
        if (!(await more())) fail('bad_request')
      }
      if (isFile) {
        fs.closeSync(fd!)
        fd = null
        file = { path: tmp!, size, name: d!.filename!, sha256: hash!.digest('hex') }
      } else if (!(d!.name in {})) fields[d!.name] = Buffer.concat(text).toString('utf8') // the last of a repeated field counts, as with FormData
    }
    return { fields, file }
  } catch (e) {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* closed */ }
    if (tmp) fs.rmSync(tmp, { force: true })
    // the rest of the body is not wanted: stop reading it
    void reader.cancel().catch(() => {})
    throw e
  } finally {
    try { reader.releaseLock() } catch { /* cancelled */ }
  }
}
