// The pure parts of the model upstream (./upstream.ts): which headers go back, the answers the gate writes itself,
// the stream rewrite and the weighted token count. Kept apart so the tests read them without a server.

/** The one text a visitor's instance ever gets for an upstream failure (the plan: visitors never learn which account). */
export const BUSY_TEXT = 'The demo is busy, try again in a bit.'

/**
 * The neutral failure: 503 + api_error + x-should-retry: false, never with a request-id or a retry-after.
 * Why this shape (server code the instance runs):
 *   - 401 would make the instance's model proxy mark its AI connection refused (broker.onUnauthorized);
 *   - 400 / 402 / 403 with a request-id from a loopback upstream is read as Anthropic's own account refusal
 *     (proxy/anthropic-refusal.ts accountRefusal: refused, plan ended, no credit). Without a request-id it returns null;
 *   - 429 with a long retry-after marks the connection limited (onLongLimit); 529 and the type overloaded_error make
 *     Claude Code retry for minutes;
 *   - 503 passes the instance's proxy unchanged, and the engine's error text holds no sign-in, limit or context words
 *     (engine/claude-parse.ts classifyError), so it is a "crash": the turn tries once more, then says to try again.
 */
export const NEUTRAL_STATUS = 503
export const neutralError = () => ({ type: 'error', error: { type: 'api_error', message: BUSY_TEXT } })
/** the daily cap and PAUSE: the product proxy's own budget stop (proxy/model-proxy.ts overBudget) */
export const BUDGET_STATUS = 403
export const budgetError = () => ({ type: 'error', error: { type: 'permission_error', message: 'budget_exceeded' } })
export const NEUTRAL_HEADERS: Record<string, string> = { 'content-type': 'application/json', 'x-should-retry': 'false', 'cache-control': 'no-store' }

/** Response headers that go back to an instance; everything else stays here (request-id, organization id, the
 * anthropic-ratelimit-unified-* headers, cf-*, set-cookie, server, via …). */
export const RESPONSE_HEADER_ALLOW = new Set(['content-type', 'cache-control'])
export function allowedResponseHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase()
    if (!RESPONSE_HEADER_ALLOW.has(key) || v === undefined) continue
    out[key] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

/** Request headers the gate passes on (the product proxy's FORWARD_HEADERS); the instance's dummy credential never. */
export const FORWARD_REQUEST_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type', 'accept', 'user-agent', 'x-app']
export const OAUTH_BETA = 'oauth-2025-04-20'
const BETA_RE = /^[a-z0-9][a-z0-9-]{0,80}-\d{4}-\d{2}-\d{2}$/
/** The anthropic-beta list for the mode: the subscription needs the oauth beta, an API key must not send it. */
export function betaFor(mode: 'claude-subscription' | 'anthropic-api-key', inbound: string | undefined): string | null {
  const s = new Set((inbound ?? '').split(',').map((x) => x.trim()).filter((x) => BETA_RE.test(x)))
  if (mode === 'claude-subscription') s.add(OAUTH_BETA)
  else s.delete(OAUTH_BETA)
  return s.size ? [...s].join(',') : null
}

/** Anthropic's "the conversation does not fit" 400 (the engine compacts or starts fresh on it): passed through. */
export function isPromptTooLong(status: number, body: string): boolean {
  if (status !== 400) return false
  try {
    const j = JSON.parse(body) as { type?: unknown; error?: { type?: unknown; message?: unknown } }
    return j?.type === 'error' && j.error?.type === 'invalid_request_error' && typeof j.error.message === 'string' && /prompt is too long/i.test(j.error.message)
  } catch { return false }
}

export interface Usage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
/** uncached input + cache writes + output + 0.1 × cache reads (the plan's weight) */
export function weighted(u: Usage): number {
  return Math.round(n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens) + 0.1 * n(u.cache_read_input_tokens))
}
/** usage fields of message_start (input, cache) and message_delta (running output total): later values win */
export function mergeUsage(into: Usage, u: unknown): void {
  if (!u || typeof u !== 'object') return
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
    const v = (u as Record<string, unknown>)[k]
    if (typeof v === 'number' && Number.isFinite(v)) into[k] = v
  }
}

/**
 * Reads a Messages API event stream event by event: usage from message_start / message_delta, and every `error`
 * event replaced by the neutral error (an overloaded_error inside a 200 stream would start Claude Code's long retries,
 * and its text names the provider's state). Events are passed on whole, in order.
 */
export class SseRewriter {
  usage: Usage = {}
  sawError = false
  private buf = ''
  /** text in, the text to send out */
  feed(chunk: string): string {
    this.buf += chunk
    let out = ''
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf)
      if (!m) break
      const ev = this.buf.slice(0, m.index)
      this.buf = this.buf.slice(m.index + m[0].length)
      out += this.event(ev) + '\n\n'
    }
    // no real event is this long; a broken stream must not grow memory without end
    if (this.buf.length > 4 << 20) { this.buf = ''; this.sawError = true; out += this.neutralEvent() + '\n\n' }
    return out
  }
  /** what is left at the end (a last event without its blank line) */
  end(): string {
    const rest = this.buf
    this.buf = ''
    return rest.trim() ? this.event(rest) + '\n\n' : ''
  }
  neutralEvent(): string { return `event: error\ndata: ${JSON.stringify(neutralError())}` }
  private event(ev: string): string {
    let name = ''
    const data: string[] = []
    for (const line of ev.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    let j: { type?: unknown; message?: { usage?: unknown }; usage?: unknown } | null = null
    try { if (data.length) j = JSON.parse(data.join('\n')) } catch {}
    if (name === 'error' || j?.type === 'error') { this.sawError = true; return this.neutralEvent() }
    if (j?.type === 'message_start') mergeUsage(this.usage, j.message?.usage)
    else if (j?.type === 'message_delta') mergeUsage(this.usage, j.usage)
    return ev
  }
}

/** Is `model` one of `allowed`: the id itself, or the id with a date (claude-haiku-4-5-20251001)? */
export function modelAllowed(model: unknown, allowed: readonly string[]): boolean {
  return typeof model === 'string' && allowed.some((a) => model === a || (model.startsWith(a + '-') && /^\d{8}$/.test(model.slice(a.length + 1))))
}

/**
 * The model pin: a request body that names a model outside the allow-list gets `fallback` instead (the default Sonnet).
 * We rewrite rather than refuse: the instance's turn then still answers (a refusal would read as "busy" on every try
 * when a turn asks for Opus, which a subscription turn does when nobody chose a model), and the cost stays Sonnet's.
 * Returns the body to send, and the model the request named when it was changed (for the log). A body that is not a
 * JSON object is passed on as it came (the instance's proxy checked it; Anthropic refuses it).
 */
export function pinModel(body: Buffer, allowed: readonly string[], fallback: string): { body: Buffer; was: string | null } {
  let j: unknown
  try { j = JSON.parse(body.toString('utf8')) } catch { return { body, was: null } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { body, was: null }
  const m = (j as { model?: unknown }).model
  if (modelAllowed(m, allowed)) return { body, was: null }
  ;(j as { model: string }).model = fallback
  return { body: Buffer.from(JSON.stringify(j)), was: typeof m === 'string' ? m.slice(0, 60) : typeof m }
}
