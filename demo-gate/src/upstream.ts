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
  budgetError, isPromptTooLong, mergeUsage, neutralError, pinModel, weighted, type Usage,
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

export interface UpstreamStatus { streams: number; waiting: number; cooldownUntil: string | null; lastStatus: number | null; credentialRefusedAt: string | null; limits: UnifiedLimits }

/** The account's unified rate-limit windows as last seen: only numbers and status words, never another header. */
export interface UnifiedLimits {
  /** 5-hour / 7-day window use as a fraction (0.42 = 42 %) */
  utilization5h: number | null
  utilization7d: number | null
  status: string | null
  resetAt: string | null
  /** every unified window the response named (e.g. "5h", "7d", "7d_opus"): utilization, status, reset */
  windows: Record<string, { utilization?: number; status?: string; resetAt?: string }>
  seenAt: string | null
}

const UNIFIED = 'anthropic-ratelimit-unified-'
const WINDOW_RE = /^anthropic-ratelimit-unified-([a-z0-9_]{1,24}(?:-[a-z0-9_]{1,24})?)-(utilization|status|reset)$/
const WORD_RE = /^[a-z_]{1,32}$/
const MAX_WINDOWS = 8

export const emptyLimits = (): UnifiedLimits => ({ utilization5h: null, utilization7d: null, status: null, resetAt: null, windows: {}, seenAt: null })

const fraction = (v: string | null | undefined): number | undefined => {
  if (v == null || !/^\s*[0-9]+(?:\.[0-9]+)?\s*$/.test(v)) return undefined
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined
}
const word = (v: string | null | undefined): string | undefined => {
  const w = v?.trim().toLowerCase()
  return w && WORD_RE.test(w) ? w : undefined
}
/** a reset time: unix seconds (what Anthropic sends) or an ISO date; anything else is dropped */
const resetIso = (v: string | null | undefined): string | undefined => {
  const t = v?.trim()
  if (!t) return undefined
  const ms = /^[0-9]{9,11}$/.test(t) ? Number(t) * 1000 : /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(t) ? Date.parse(t) : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** Read the unified rate-limit headers of one response; null when it carried none. Other headers are never read. */
export function parseUnifiedLimits(h: Headers | Record<string, string | string[] | undefined>, now = Date.now()): UnifiedLimits | null {
  const get = (k: string): string | undefined => {
    if (h instanceof Headers) return h.get(k) ?? undefined
    const v = h[k]
    return Array.isArray(v) ? v[0] : v
  }
  const names: string[] = []
  if (h instanceof Headers) h.forEach((_v, k) => { if (k.startsWith(UNIFIED)) names.push(k) })
  else for (const k of Object.keys(h)) if (k.toLowerCase().startsWith(UNIFIED)) names.push(k.toLowerCase())
  if (!names.length) return null
  const out = emptyLimits()
  out.status = word(get(UNIFIED + 'status')) ?? null
  out.resetAt = resetIso(get(UNIFIED + 'reset')) ?? null
  for (const k of names.sort()) {
    const m = WINDOW_RE.exec(k)
    if (!m) continue
    const [, name, kind] = m as unknown as [string, string, 'utilization' | 'status' | 'reset']
    if (!out.windows[name] && Object.keys(out.windows).length >= MAX_WINDOWS) continue
    const v = get(k)
    const val = kind === 'utilization' ? fraction(v) : kind === 'status' ? word(v) : resetIso(v)
    if (val === undefined) continue
    const w = (out.windows[name] ??= {}) as Record<string, number | string>
    w[kind === 'reset' ? 'resetAt' : kind] = val
  }
  for (const [name, w] of Object.entries(out.windows)) if (!Object.keys(w).length) delete out.windows[name]
  out.utilization5h = out.windows['5h']?.utilization ?? null
  out.utilization7d = out.windows['7d']?.utilization ?? null
  if (out.status === null && out.utilization5h === null && out.utilization7d === null && !Object.keys(out.windows).length) return null
  out.seenAt = new Date(now).toISOString()
  return out
}

export function createUpstream(d: UpstreamDeps) {
  const sem = new Semaphore(d.cfg.limits.maxStreams)
  /** each instance's own stream limit, inside the global one: one visitor never takes every stream */
  const perInstance = new Map<string, Semaphore>()
  const instanceSem = (id: string) => {
    let s = perInstance.get(id)
    if (!s) { s = new Semaphore(d.cfg.limits.streamsPerInstance); perInstance.set(id, s) }
    return s
  }
  const dropIdle = (id: string, s: Semaphore) => { if (s.active === 0 && s.waiting === 0 && perInstance.get(id) === s) perInstance.delete(id) }
  let cooldownUntil = 0
  let lastStatus: number | null = null
  let credentialRefusedAt: number | null = null
  let limits = emptyLimits()
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
    const seen = parseUnifiedLimits(h, now)
    if (seen) limits = seen
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
    if (w > 0) { inst.tokens += w; d.state.addTokens(w) }
    // one line per completed request, to work out later how much of the account's window one visitor uses
    d.log.info('upstream usage', { instance: inst.id, tokens: Math.max(0, w), u5h: limits.utilization5h, u7d: limits.utilization7d })
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
    // the gate's own per-visitor cap (the instance's demo limit with a margin): the instance stops itself first; this
    // holds even if its own count went wrong
    if (inst.cap > 0 && inst.tokens >= inst.cap) {
      d.log.info('model request stopped: instance cap', { instance: inst.id, tokens: inst.tokens, cap: inst.cap })
      return send(res, BUDGET_STATUS, budgetError())
    }
    if (Date.now() < cooldownUntil) return neutral(res)

    // the request body (the instance's proxy checked it; it is passed on as it came)
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new Error('too large'); chunks.push(c as Buffer) }
    } catch { return neutral(res) }
    // the model pin: a model outside the allow-list becomes the default Sonnet (model.ts pinModel says why)
    const pinned = pinModel(Buffer.concat(chunks), d.cfg.ai.models, d.cfg.ai.defaultModel)
    if (pinned.was !== null) d.log.info('model request: model pinned', { instance: inst.id, asked: pinned.was, sent: d.cfg.ai.defaultModel })

    // a stream of this instance's own, then one of the gate's; both within the same wait
    const waitUntil = Date.now() + d.cfg.limits.streamWaitMs
    const own = instanceSem(inst.id)
    if (!(await own.acquire(d.cfg.limits.streamWaitMs))) { dropIdle(inst.id, own); d.log.warn('model request: instance stream limit', { instance: inst.id }); return neutral(res) }
    if (!(await sem.acquire(Math.max(0, waitUntil - Date.now())))) {
      own.release(); dropIdle(inst.id, own)
      d.log.warn('model request: no free stream', { instance: inst.id })
      return neutral(res)
    }
    let released = false
    const release = () => { if (!released) { released = true; sem.release(); own.release(); dropIdle(inst.id, own) } }
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
      up = await fetch(d.cfg.ai.upstream + apiPath + url.search, { method: 'POST', headers, body: new Uint8Array(pinned.body), redirect: 'manual', signal: abort.signal })
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
      return { streams: sem.active, waiting: sem.waiting, cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null, lastStatus, credentialRefusedAt: credentialRefusedAt ? new Date(credentialRefusedAt).toISOString() : null, limits: structuredClone(limits) }
    },
  }
}
