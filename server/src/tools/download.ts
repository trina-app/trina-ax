// Downloading a file from the web straight to disk: generate_video's result (tools/higgsfield.ts) and save_url
// (tools/save-url.ts). It runs in the server account, outside the engine firewall, so the web_fetch rules apply on
// every hop (tools/web-fetch.ts resolveTarget): http(s) on ports 80 / 443 only, no user:password@, no local names, the
// name looked up once and every address public (not private, LAN, link-local / metadata, this machine or its networks,
// nor this server's own exit address), then the connection pinned to that address (our own HTTP/1.1 GET over
// node:net / node:tls, no proxy from the environment, no second lookup). Redirects are followed by hand, at most 5, each
// new address checked again from the start. No cookies or credentials are sent; `Accept-Encoding: identity`.
//
// The body goes to the file as it arrives (never whole in memory): read in socket-sized pieces, with backpressure (a
// full queue pauses the socket). Limits are the caller's: a hard maximum (generate_video), a size above which the
// caller is asked first (save_url's card over 1 GB: known from Content-Length before anything is written, or reached
// while streaming, when nothing past it is written until the answer), and a disk check up front and while streaming.
// A failure deletes the partial file.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import { PRODUCT, SOURCE_CODE } from '@mycel/shared'
import { ToolError } from '../policy/errors'
import { resolveTarget, type ResolveOptions, type Target } from './web-fetch'

export const DOWNLOAD_MAX_REDIRECTS = 5
/** per hop: the name lookup, the connection and the answer's head */
export const DOWNLOAD_CONNECT_TIMEOUT_MS = 15_000
/** no bytes for this long while the body arrives (not while the person is asked) */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
/** the bytes the type is judged by before anything is written */
export const SNIFF_BYTES = 64
/** the disk is looked at again after every this many bytes */
export const ROOM_STEP = 64 * 1024 * 1024
const HEAD_MAX = 64 * 1024
/** queued, unread socket data before the socket is paused */
const QUEUE_HIGH = 1024 * 1024
const UA = `Mozilla/5.0 (compatible; ${PRODUCT.artifactBase}-fetch/1.0; +${SOURCE_CODE.repository})`

export interface DownloadOptions extends Pick<ResolveOptions, 'lookup' | 'testAllow' | 'blockedIps'> {
  /** tests only: accept the test server's self-signed certificate */
  insecureTlsForTests?: boolean
  /** every hop must be https (generate_video) */
  httpsOnly?: boolean
  /** a hard limit: a larger body is an error */
  maxBytes?: number
  /** a body larger than this calls `onLarge` first; it throws to stop (nothing past `askAbove` is written before) */
  askAbove?: number
  onLarge?: (o: { size: number | null; received: number }) => Promise<void>
  /** "about to write `more` bytes": throws to stop. Called with the announced size (0 when unknown) before the body,
   * then after every ROOM_STEP bytes with what is still announced (or the next ROOM_STEP when the size is unknown) */
  room?: (more: number) => void
  /** the first SNIFF_BYTES bytes (all of a shorter body), before anything is written: throws to stop */
  sniff?: (first: Buffer, contentType: string) => void
  signal?: AbortSignal
  connectTimeoutMs?: number
  idleTimeoutMs?: number
}

export interface Downloaded {
  /** the address the file finally came from (after redirects) */
  url: string
  size: number
  sha256: string
  /** what the site said it is (not trusted: the caller judges by the bytes) */
  contentType: string
  /** the first SNIFF_BYTES bytes */
  first: Buffer
}

const stopped = () => new ToolError('stopped')

/** A socket read in pieces, with backpressure; `idle` ms without data (while armed) ends it with a time-out. */
class Conn {
  private queue: Buffer[] = []
  private queued = 0
  private ended = false
  private error: Error | null = null
  private wake: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private paused = false
  /** the time-out is off (the person is being asked): data that still arrives does not arm it again */
  private held = false
  constructor(private sock: net.Socket, private idleMs: number, signal?: AbortSignal) {
    sock.on('data', (d: Buffer) => {
      this.queue.push(d)
      this.queued += d.length
      if (!this.held) this.arm()
      if (this.queued > QUEUE_HIGH && !this.paused) { this.paused = true; sock.pause() }
      this.poke()
    })
    sock.on('end', () => { this.ended = true; this.poke() })
    sock.on('close', () => { this.ended = true; this.poke() })
    sock.on('error', (e: NodeJS.ErrnoException) => {
      this.error ??= new ToolError(/CERT|SSL|TLS|self.signed|altname/i.test(String(e.code) + e.message) ? `TLS certificate problem: ${e.message}` : `could not connect (${e.code ?? e.message})`)
      this.poke()
    })
    const abort = () => { this.error = stopped(); this.close(); this.poke() }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    sock.once('close', () => signal?.removeEventListener('abort', abort))
  }
  private poke() { const w = this.wake; this.wake = null; w?.() }
  /** time-out armed again (after each piece of data, and when reading resumes) */
  arm(ms = this.idleMs) {
    this.held = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.error ??= new ToolError('the site stopped sending (time-out)'); this.close(); this.poke() }, ms)
  }
  /** no time-out (the person is being asked; the socket stays paused meanwhile) */
  disarm() { this.held = true; if (this.timer) clearTimeout(this.timer); this.timer = null }
  /** why the connection ended, if it failed */
  failure(): Error | null { return this.error }
  /** the next piece; null at the end of the stream */
  async read(): Promise<Buffer | null> {
    for (;;) {
      if (this.error && !this.queue.length) throw this.error
      if (this.queue.length) {
        const d = this.queue.shift()!
        this.queued -= d.length
        if (this.paused && this.queued < QUEUE_HIGH / 4) { this.paused = false; this.sock.resume() }
        return d
      }
      if (this.ended) return null
      if (this.paused) { this.paused = false; this.sock.resume() }
      await new Promise<void>((r) => { this.wake = r })
    }
  }
  /** a piece not used yet goes back to the front */
  unread(d: Buffer) { if (d.length) { this.queue.unshift(d); this.queued += d.length } }
  close() {
    this.disarm()
    // not destroyed inside a socket callback: that crashed Bun 1.3.12 after a failed TLS handshake (web-fetch.ts)
    setImmediate(() => this.sock.destroy())
  }
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const BREAKS = /[\r\n\0]/

/** Connect to the pinned address and send one GET; resolves once connected. */
function connect(t: Target, o: { deadline: number; insecureTlsForTests?: boolean; signal?: AbortSignal; idleMs: number }): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const path = (t.url.pathname || '/') + t.url.search
    if (BREAKS.test(path) || /\s/.test(path)) return reject(new ToolError('invalid request'))
    const hostHeader = t.url.port ? `${t.url.hostname}:${t.url.port}` : t.url.hostname
    const headers: [string, string][] = [['User-Agent', UA], ['Accept', '*/*'], ['Accept-Encoding', 'identity'], ['Accept-Language', 'ko,en;q=0.8']]
    let head = `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\n`
    for (const [k, v] of headers) {
      if (!TOKEN.test(k) || BREAKS.test(v)) return reject(new ToolError('invalid request header'))
      head += `${k}: ${v}\r\n`
    }
    head += 'Connection: close\r\n\r\n'
    if (o.signal?.aborted) return reject(stopped())
    const secure = t.url.protocol === 'https:'
    const sock: net.Socket = secure
      ? tls.connect({ host: t.ip, port: t.port, servername: net.isIP(t.host) ? undefined : t.host, ALPNProtocols: ['http/1.1'], rejectUnauthorized: !o.insecureTlsForTests })
      : net.connect({ host: t.ip, port: t.port })
    const conn = new Conn(sock, o.idleMs, o.signal)
    conn.arm(Math.max(1, o.deadline - Date.now()))
    let settled = false
    sock.once(secure ? 'secureConnect' : 'connect', () => { if (settled) return; settled = true; sock.write(head); resolve(conn) })
    // a failure, the time-out or a stop before the connection is up (Conn noted why; later ones reach read())
    const fail = () => { if (settled) return; settled = true; conn.close(); reject(conn.failure() ?? new ToolError('could not connect')) }
    sock.once('error', fail)
    sock.once('close', fail)
  })
}

interface Head { status: number; headers: Record<string, string> }

/** The answer's head (1xx heads skipped); the bytes after it go back into the connection. */
async function readHead(conn: Conn): Promise<Head> {
  let buf: Buffer = Buffer.alloc(0)
  for (;;) {
    const end = buf.indexOf('\r\n\r\n')
    if (end >= 0) {
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n')
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')
      if (!m) throw new ToolError('the site sent no valid HTTP response')
      const rest = buf.subarray(end + 4)
      if (m[1]!.startsWith('1')) { buf = rest; continue }
      const headers: Record<string, string> = {}
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':')
        if (i > 0) { const k = l.slice(0, i).trim().toLowerCase(); const v = l.slice(i + 1).trim(); headers[k] = headers[k] ? `${headers[k]}, ${v}` : v }
      }
      conn.unread(rest)
      return { status: Number(m[1]), headers }
    }
    if (buf.length > HEAD_MAX) throw new ToolError('the site sent no valid HTTP response')
    const d = await conn.read()
    if (!d) throw new ToolError('the site sent no valid HTTP response')
    buf = buf.length ? Buffer.concat([buf, d]) : d
  }
}

/** The body as it arrives: by Content-Length, chunked, or up to the close. */
async function* bodyOf(conn: Conn, h: Head): AsyncGenerator<Buffer> {
  if (/chunked/i.test(h.headers['transfer-encoding'] ?? '')) {
    let pending: Buffer = Buffer.alloc(0)
    const more = async () => {
      const d = await conn.read()
      if (!d) throw new ToolError('the download was cut off')
      pending = pending.length ? Buffer.concat([pending, d]) : d
    }
    for (;;) {
      let nl = pending.indexOf('\r\n')
      while (nl < 0) { if (pending.length > 4096) throw new ToolError('the site sent a damaged chunked response'); await more(); nl = pending.indexOf('\r\n') }
      const n = parseInt(pending.subarray(0, nl).toString('latin1').split(';')[0]!.trim(), 16)
      if (!Number.isFinite(n) || n < 0) throw new ToolError('the site sent a damaged chunked response')
      pending = pending.subarray(nl + 2)
      if (n === 0) return // trailers are not read
      let left = n
      while (left > 0) {
        if (!pending.length) await more()
        const take = pending.subarray(0, left)
        pending = pending.subarray(take.length)
        left -= take.length
        yield take
      }
      while (pending.length < 2) await more()
      pending = pending.subarray(2)
    }
  }
  const cl = h.headers['content-length']
  const length = cl !== undefined && /^\d+$/.test(cl) ? Number(cl) : null
  let got = 0
  for (;;) {
    if (length !== null && got >= length) return
    const d = await conn.read()
    if (!d) {
      if (length !== null && got < length) throw new ToolError('the download was cut off')
      return
    }
    const piece = length !== null ? d.subarray(0, length - got) : d
    got += piece.length
    if (piece.length) yield piece
  }
}

/** The size the answer announces (Content-Length without chunked framing), or null. */
export function announcedSize(headers: Record<string, string>): number | null {
  if (/chunked/i.test(headers['transfer-encoding'] ?? '')) return null
  const cl = headers['content-length']
  return cl !== undefined && /^\d+$/.test(cl) ? Number(cl) : null
}

/** GET `rawUrl` into the new file `dst` (created, 0600; never an existing file). Throws ToolError; `dst` is then gone. */
export async function downloadToFile(rawUrl: string, dst: string, o: DownloadOptions = {}): Promise<Downloaded> {
  const connectMs = o.connectTimeoutMs ?? DOWNLOAD_CONNECT_TIMEOUT_MS
  const idleMs = o.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS
  let current = rawUrl
  for (let hop = 0; ; hop++) {
    if (o.httpsOnly && !/^https:\/\//i.test(current)) throw new ToolError(hop ? 'the download redirected to an address that is not https' : 'the address is not https')
    const deadline = Date.now() + connectMs
    const t = await resolveTarget(current, { lookup: o.lookup, testAllow: o.testAllow, blockedIps: o.blockedIps, deadline })
    if (o.signal?.aborted) throw stopped()
    const conn = await connect(t, { deadline, insecureTlsForTests: o.insecureTlsForTests, signal: o.signal, idleMs })
    try {
      const h = await readHead(conn)
      if ([301, 302, 303, 307, 308].includes(h.status) && h.headers.location) {
        if (hop >= DOWNLOAD_MAX_REDIRECTS) throw new ToolError(`too many redirects (more than ${DOWNLOAD_MAX_REDIRECTS})`)
        try { current = new URL(h.headers.location, t.url).href } catch { throw new ToolError('the site redirected to an invalid URL') }
        continue
      }
      if (h.status >= 400) throw new ToolError(`the site answered HTTP ${h.status}`)
      if (h.status < 200 || h.status >= 300) throw new ToolError(`unexpected HTTP status ${h.status}`)
      const enc = (h.headers['content-encoding'] ?? '').trim().toLowerCase()
      if (enc && enc !== 'identity') throw new ToolError(`the site sent the file compressed (Content-Encoding ${enc.slice(0, 40)}), which downloads do not take`)
      return await save(conn, h, t.url.href, dst, o, idleMs)
    } finally { conn.close() }
  }
}

async function save(conn: Conn, h: Head, url: string, dst: string, o: DownloadOptions, idleMs: number): Promise<Downloaded> {
  const announced = announcedSize(h.headers)
  if (o.maxBytes !== undefined && announced !== null && announced > o.maxBytes) throw new ToolError(`the file is larger than the limit (${announced} bytes, at most ${o.maxBytes})`)
  o.room?.(announced ?? 0)
  let asked = false
  if (o.askAbove !== undefined && announced !== null && announced > o.askAbove) {
    conn.disarm()
    await o.onLarge?.({ size: announced, received: 0 })
    asked = true
    conn.arm(idleMs)
  }
  const fh = await fs.promises.open(dst, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
  const hash = crypto.createHash('sha256')
  const contentType = h.headers['content-type'] ?? ''
  let size = 0
  let first: Buffer | null = null
  let sniffed: Buffer = Buffer.alloc(0)
  let nextRoom = ROOM_STEP
  const write = async (b: Buffer) => {
    let off = 0
    while (off < b.length) { const { bytesWritten } = await fh.write(b, off, b.length - off); off += bytesWritten }
    hash.update(b)
    size += b.length
    if (o.room && size >= nextRoom) {
      nextRoom = size + ROOM_STEP
      o.room(announced !== null ? Math.max(0, announced - size) : ROOM_STEP)
    }
  }
  const emit = async (b: Buffer) => {
    if (o.maxBytes !== undefined && size + b.length > o.maxBytes) throw new ToolError(`the file is larger than the limit (at most ${o.maxBytes} bytes)`)
    if (!asked && o.askAbove !== undefined && size + b.length > o.askAbove) {
      // up to the line, then nothing more until the person answered (the socket stays paused meanwhile)
      const fits = o.askAbove - size
      await write(b.subarray(0, fits))
      b = b.subarray(fits)
      conn.disarm()
      await o.onLarge?.({ size: null, received: size })
      asked = true
      conn.arm(idleMs)
    }
    if (b.length) await write(b)
  }
  try {
    for await (const piece of bodyOf(conn, h)) {
      if (o.signal?.aborted) throw stopped()
      if (first === null) {
        sniffed = sniffed.length ? Buffer.concat([sniffed, piece]) : piece
        if (sniffed.length < SNIFF_BYTES) continue
        first = Buffer.from(sniffed.subarray(0, SNIFF_BYTES))
        o.sniff?.(first, contentType)
        await emit(sniffed)
        continue
      }
      await emit(piece)
    }
    if (first === null) {
      first = Buffer.from(sniffed)
      o.sniff?.(first, contentType)
      if (sniffed.length) await emit(sniffed)
    }
    await fh.sync().catch(() => {})
    await fh.close()
  } catch (e) {
    await fh.close().catch(() => {})
    fs.rmSync(dst, { force: true })
    throw e
  }
  return { url, size, sha256: hash.digest('hex'), contentType, first }
}
