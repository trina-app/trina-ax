// A small client for Slack's Web API (https://docs.slack.dev/apis/web-api/): form-encoded POSTs to
// https://slack.com/api/<method> with the token in the Authorization header (never in the body or the address), no
// redirects, a time limit and a size limit on the answer. A 429 waits for Retry-After (at most twice, at most 30 s
// each); a 5xx is tried once more. Errors carry Slack's error code only (a short word), never a token or a body.

export interface SlackDeps {
  /** tests only: the fake Slack's address instead of https://slack.com. It also allows that address's ws:// socket and
   * response URLs. Never set from HTTP, a file or the environment. */
  base?: string
  /** how often answers are looked for (default 1 s) */
  pollMs?: number
  /** the first wait before a new connection after a failed one (default 1 s; doubles up to a minute) */
  retryMs?: number
  /** tests: a shorter time limit per request than 15 s */
  timeoutMs?: number
  now?: () => number
}

export class SlackApiError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryAfter?: number) { super(`slack_${code}`) }
}

const CODE = /^[a-z0-9_]{1,64}$/
const MAX_BYTES = 1024 * 1024
const TIMEOUT_MS = 15_000
const MAX_WAIT_S = 30

export interface CallResult { [k: string]: unknown; ok: true }

function form(body: Record<string, unknown>): URLSearchParams {
  const f = new URLSearchParams()
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue
    f.set(k, typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v))
  }
  return f
}

async function readCapped(r: Response): Promise<string> {
  if (!r.body) return ''
  const reader = r.body.getReader(), parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > MAX_BYTES) { try { await reader.cancel() } catch {} throw new SlackApiError('response_too_large', r.status) }
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}

export class SlackApi {
  constructor(private readonly deps: SlackDeps = {}) {}
  get base(): string { return this.deps.base ?? 'https://slack.com' }
  get testing(): boolean { return this.deps.base !== undefined }

  /** One Web API method. `scopes`: the token's scopes as Slack lists them in X-OAuth-Scopes (when it does). */
  /** `noAuth`: no Authorization header (openid.connect.token takes the app's client id and secret in the body) */
  async call(method: string, token: string, body: Record<string, unknown> = {}, o: { noAuth?: boolean } = {}): Promise<CallResult & { scopes: string[] | null }> {
    if (!/^[a-z]+(\.[a-zA-Z]+)+$/.test(method)) throw new SlackApiError('invalid_method')
    let retries = 0
    for (;;) {
      let r: Response
      try {
        r = await fetch(`${this.base}/api/${method}`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.deps.timeoutMs ?? TIMEOUT_MS),
          headers: { ...(o.noAuth ? {} : { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body: form(body),
        })
      } catch { throw new SlackApiError('unreachable') }
      if (r.status === 429) {
        const wait = Number(r.headers.get('retry-after') ?? '1')
        try { await r.body?.cancel() } catch {}
        if (retries < 2 && Number.isFinite(wait) && wait <= MAX_WAIT_S) { retries++; await Bun.sleep(Math.max(0, wait) * 1000); continue }
        throw new SlackApiError('ratelimited', 429, Number.isFinite(wait) ? wait : undefined)
      }
      if (r.status >= 500 && retries < 1) { retries++; try { await r.body?.cancel() } catch {}; await Bun.sleep(1000); continue }
      if (r.status !== 200) { try { await r.body?.cancel() } catch {}; throw new SlackApiError(r.status >= 300 && r.status < 400 ? 'redirected' : 'http_error', r.status) }
      let j: Record<string, unknown>
      try { j = JSON.parse(await readCapped(r)) } catch (e) { if (e instanceof SlackApiError) throw e; throw new SlackApiError('invalid_response', r.status) }
      if (!j || typeof j !== 'object') throw new SlackApiError('invalid_response', r.status)
      if (j.ok !== true) throw new SlackApiError(typeof j.error === 'string' && CODE.test(j.error) ? j.error : 'unknown', r.status)
      const sc = r.headers.get('x-oauth-scopes')
      return { ...(j as CallResult), scopes: sc === null ? null : sc.split(',').map((s) => s.trim()).filter(Boolean) }
    }
  }

  /** May this address get an interaction's answer? Slack's own response URLs only (the fake Slack's in tests). */
  responseUrlOk(raw: unknown): raw is string {
    if (typeof raw !== 'string' || raw.length > 2048) return false
    let u: URL
    try { u = new URL(raw) } catch { return false }
    if (u.username || u.password || u.hash) return false
    if (this.testing) return u.origin === new URL(this.base).origin
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com' && (u.port === '' || u.port === '443')
  }

  /** Answer through an interaction's response_url (replace or delete the ephemeral message it came from). */
  async respond(url: string, body: Record<string, unknown>): Promise<boolean> {
    if (!this.responseUrlOk(url)) return false
    try {
      const r = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.deps.timeoutMs ?? TIMEOUT_MS), headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) })
      try { await r.body?.cancel() } catch {}
      return r.status === 200
    } catch { return false }
  }

  /** The Socket Mode address apps.connections.open gave: Slack's wss:// only (the fake Slack's ws:// in tests). */
  socketUrlOk(raw: unknown): raw is string {
    if (typeof raw !== 'string' || raw.length > 4096) return false
    let u: URL
    try { u = new URL(raw) } catch { return false }
    if (u.username || u.password || u.hash) return false
    if (this.testing) { const b = new URL(this.base); return u.protocol === 'ws:' && u.host === b.host }
    return u.protocol === 'wss:' && (u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com')) && (u.port === '' || u.port === '443')
  }
}
