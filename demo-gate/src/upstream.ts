// The instances' model upstream, on its own loopback port. Each instance's model proxy sends its requests to
// http://127.0.0.1:<port>/i/<id>.<secret>/v1/messages (engine.modelUpstreams.anthropic), with a DUMMY credential.
// Here the path secret is checked, the dummy is dropped and the ONE real credential (a 0600 file) is put on instead.
// Only POST /v1/messages and /v1/messages/count_tokens pass. Answers come back with an allowlist of headers; every
// failure is the neutral answer of ./model.ts, except "prompt is too long" (passed through) and the daily cap / PAUSE
// (403 budget_exceeded).
import fs from 'node:fs'
import http from 'node:http'
import type { GateConfig } from './config.ts'
import { readSecretFile } from './config.ts'
import type { GateLog } from './log.ts'
import {
  BUDGET_STATUS, FORWARD_REQUEST_HEADERS, NEUTRAL_HEADERS, NEUTRAL_STATUS, SseRewriter, allowedResponseHeaders, betaFor,
  budgetError, isPromptTooLong, mergeUsage, neutralError, weighted, type Usage,
} from './model.ts'
import type { Instance } from './pool.ts'
import type { GateState } from './state.ts'

const PATH_RE = /^\/i\/([0-9a-f]{8})\.([A-Za-z0-9_-]{43})(\/v1\/messages(?:\/count_tokens)?)$/
const MAX_BODY = 64 * 1024 * 1024
const MAX_COOLDOWN_S = 3600

/** A counting semaphore with a wait limit. */
export class Semaphore {
  active = 0
  private queue: Array<(ok: boolean) => void> = []
  private max: number
  constructor(max: number) { this.max = max }
  get waiting() { return this.queue.length }
  acquire(waitMs: number): Promise<boolean> {
    if (this.active < this.max) { this.active++; return Promise.resolve(true) }
    return new Promise((resolve) => {
      const done = (ok: boolean) => { clearTimeout(t); resolve(ok) }
      const t = setTimeout(() => { const i = this.queue.indexOf(done); if (i >= 0) this.queue.splice(i, 1); resolve(false) }, waitMs)
      this.queue.push(done)
    })
  }
  release(): void {
    const next = this.queue.shift()
    if (next) next(true) // the slot passes straight on
    else this.active = Math.max(0, this.active - 1)
  }
}

export interface UpstreamDeps {
  cfg: GateConfig
  log: GateLog
  state: GateState
  paused: () => boolean
  instance: (id: string, secret: string) => Instance | null
}

export interface UpstreamStatus { streams: number; waiting: number; cooldownUntil: string | null; lastStatus: number | null; credentialRefusedAt: string | null }

export function createUpstream(d: UpstreamDeps) {
  const sem = new Semaphore(d.cfg.limits.maxStreams)
  let cooldownUntil = 0
  let lastStatus: number | null = null
  let credentialRefusedAt: number | null = null
  let cred: { mtime: number; value: string } | null = null
  const credential = (): string => {
    const st = fs.statSync(d.cfg.ai.credentialFile)
    if (!cred || cred.mtime !== st.mtimeMs) cred = { mtime: st.mtimeMs, value: readSecretFile(d.cfg.ai.credentialFile) }
    return cred.value
  }

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = NEUTRAL_HEADERS) => {
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(status, headers)
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  const neutral = (res: http.ServerResponse) => send(res, NEUTRAL_STATUS, neutralError())
  const overCap = () => d.paused() || d.state.dailyTokens() >= d.cfg.limits.dailyWeightedTokens

  /** read the account's limit headers here (never passed on): a rejected window or a 429 pauses calls for a while */
  const noteLimits = (h: Headers, status: number) => {
    const now = Date.now()
    let until = 0
    if (h.get('anthropic-ratelimit-unified-status') === 'rejected') {
      const reset = Number(h.get('anthropic-ratelimit-unified-reset'))
      until = Number.isFinite(reset) && reset > 0 ? Math.min(reset * 1000, now + MAX_COOLDOWN_S * 1000) : now + 60_000
    }
    if (status === 429) {
      const ra = Number(h.get('retry-after'))
      until = Math.max(until, now + Math.min(Number.isFinite(ra) && ra > 0 ? ra : 30, MAX_COOLDOWN_S) * 1000)
    }
    if (until > cooldownUntil) { cooldownUntil = until; d.log.warn('upstream limited: calls wait', { untilMs: until - now }) }
  }

  const count = (inst: Instance, u: Usage) => {
    const w = weighted(u)
    if (w <= 0) return
    inst.tokens += w
    d.state.addTokens(w)
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x')
    const m = PATH_RE.exec(url.pathname)
    if (!m || req.method !== 'POST') return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } })
    for (const [k, v] of url.searchParams) if (k !== 'beta' || v !== 'true') return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } })
    const inst = d.instance(m[1]!, m[2]!)
    if (!inst) {
      d.log.warn('model request with a wrong path secret', { instance: m[1] })
      return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } })
    }
    const apiPath = m[3]!
    const messages = apiPath === '/v1/messages'
    if (overCap()) {
      d.log.info('model request stopped: daily cap or pause', { instance: inst.id })
      return send(res, BUDGET_STATUS, budgetError())
    }
    if (Date.now() < cooldownUntil) return neutral(res)

    // the request body (the instance's proxy checked it; it is passed on as it came)
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new Error('too large'); chunks.push(c as Buffer) }
    } catch { return neutral(res) }

    if (!(await sem.acquire(d.cfg.limits.streamWaitMs))) { d.log.warn('model request: no free stream', { instance: inst.id }); return neutral(res) }
    let released = false
    const release = () => { if (!released) { released = true; sem.release() } }
    res.on('close', release)
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })

    const headers: Record<string, string> = {}
    for (const k of FORWARD_REQUEST_HEADERS) { const v = req.headers[k]; if (typeof v === 'string' && v) headers[k] = v }
    let secret: string
    try { secret = credential() } catch (e) { d.log.error('credential file unreadable', { error: String((e as Error).message).slice(0, 120) }); release(); return neutral(res) }
    if (d.cfg.ai.mode === 'claude-subscription') headers.authorization = `Bearer ${secret}`
    else headers['x-api-key'] = secret
    const beta = betaFor(d.cfg.ai.mode, headers['anthropic-beta'])
    if (beta) headers['anthropic-beta'] = beta
    else delete headers['anthropic-beta']

    let up: Response
    try {
      up = await fetch(d.cfg.ai.upstream + apiPath + url.search, { method: 'POST', headers, body: Buffer.concat(chunks), redirect: 'manual', signal: abort.signal })
    } catch {
      if (!abort.signal.aborted) d.log.warn('upstream unreachable', { instance: inst.id })
      release()
      return neutral(res)
    }
    lastStatus = up.status
    noteLimits(up.headers, up.status)
    const raw: Record<string, string> = {}
    up.headers.forEach((v, k) => { raw[k] = v })
    const outHeaders = allowedResponseHeaders(raw)

    if (up.status < 200 || up.status >= 300) {
      let text = ''
      try { text = await up.text() } catch {}
      release()
      if (isPromptTooLong(up.status, text)) return send(res, 400, text, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      let type = ''
      try { type = String((JSON.parse(text) as { error?: { type?: unknown } }).error?.type ?? '').slice(0, 40) } catch {}
      if (up.status === 401 || up.status === 403) credentialRefusedAt = Date.now()
      d.log.warn('upstream error answered neutrally', { instance: inst.id, status: up.status, type, path: apiPath })
      return neutral(res)
    }

    const sse = (up.headers.get('content-type') ?? '').includes('text/event-stream')
    if (!sse || !up.body) {
      let text = ''
      try { text = await up.text() } catch { release(); return neutral(res) }
      release()
      if (messages) {
        try {
          const j = JSON.parse(text) as { type?: unknown; usage?: unknown }
          if (j?.type === 'error') return neutral(res)
          const u: Usage = {}
          mergeUsage(u, j?.usage)
          count(inst, u)
        } catch {}
      }
      return send(res, up.status, text, { ...outHeaders, 'content-type': outHeaders['content-type'] ?? 'application/json' })
    }

    res.writeHead(up.status, outHeaders)
    const rw = new SseRewriter()
    const dec = new TextDecoder()
    let counted = false
    const finish = () => { if (!counted) { counted = true; if (messages) count(inst, rw.usage) } }
    try {
      for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
        const out = rw.feed(dec.decode(chunk, { stream: true }))
        if (out && !res.write(out)) await new Promise<void>((ok) => { res.once('drain', ok); res.once('close', ok) })
        if (res.destroyed) break
      }
      const tail = rw.feed(dec.decode()) + rw.end()
      if (tail && !res.destroyed) res.write(tail)
    } catch {
      // the stream broke off upstream: the instance gets the neutral error event, what was used still counts
      if (!res.destroyed && !abort.signal.aborted) res.write(rw.neutralEvent() + '\n\n')
    }
    finish()
    if (rw.sawError) d.log.warn('upstream stream error answered neutrally', { instance: inst.id })
    release()
    if (!res.destroyed) res.end()
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      d.log.error('upstream handler failed', { error: String((e as Error)?.message ?? e).slice(0, 200) })
      try { neutral(res) } catch {}
    })
  })
  server.on('upgrade', (_req, sock) => sock.destroy())
  // a long answer can stream for many minutes
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 5_000

  return {
    server,
    status(): UpstreamStatus {
      return { streams: sem.active, waiting: sem.waiting, cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null, lastStatus, credentialRefusedAt: credentialRefusedAt ? new Date(credentialRefusedAt).toISOString() : null }
    },
  }
}
