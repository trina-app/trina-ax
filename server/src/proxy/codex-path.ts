import { confidentialTurn, externalSearch } from "../safe-ops/confidential"
// The model proxy's Codex path (docs/DECISIONS.md "AI 연결" D9/D21). A managed Codex turn never holds a real
// credential: its CODEX_HOME/auth.json carries this turn's proxy token as the access token (or API key) and fixed
// placeholders, its model provider "teamax" points at http://127.0.0.1:<port>/codex/<chatgpt|openai>, and the
// background ChatGPT calls (chatgpt_base_url) and the token refresh address point here too. This handler:
//   POST /codex/chatgpt/responses   ChatGPT sign-in  -> <chatgpt>/responses (Authorization + ChatGPT-Account-ID)
//   POST /codex/openai/responses    OpenAI API key   -> <openai>/responses (Authorization)
//   GET  /codex/backend/wham/config/bundle -> {} (a remote config bundle could change the lockdown: never passed)
//   other /codex/backend/*, /codex/*/models  -> 404 (never sent upstream)
//   POST /codex/oauth/token         -> 400 invalid_grant, audited (the engine must never refresh by itself)
// Requests are filtered like the Claude path: Responses only, function / web_search tools only, inline images and
// files only, no background / stored-prompt / conversation state, models from the locked catalog only, store forced
// to false, the checked body written again. 401 of a ChatGPT sign-in: one refresh (single-flight) and one retry; the
// engine then gets 403 (never 401, which would make Codex try to refresh). Long 429s mark this connection only.
import type { Database } from 'bun:sqlite'
import type { CredentialBroker } from '../credentials/broker'
import { overBudget, retryAfterSeconds, apiError, type ProxyTurnEvent, type TokenRow } from './model-proxy'

export interface CodexPathDeps {
  db: Database
  broker: CredentialBroker | null
  codexModels: () => string[]
  onTurnEvent?: (turnId: string, ev: ProxyTurnEvent) => void
  refused: (row: TokenRow | null, reason: string, extra?: Record<string, unknown>) => void
  admit: (req: Request) => Promise<TokenRow | Response>
}

/** request headers that reach the upstream (Codex 0.163's own headers, C8); everything else is dropped, the engine's
 * Authorization / ChatGPT-Account-ID / OpenAI-* / cookies included */
const FORWARD = ['content-type', 'accept', 'user-agent', 'originator', 'version', 'session-id', 'thread-id', 'x-client-request-id', 'x-openai-subagent',
  'x-codex-beta-features', 'x-codex-turn-state', 'x-codex-window-id', 'x-codex-turn-metadata', 'x-codex-parent-thread-id']
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'proxy-authenticate', 'upgrade'])
const TOOL_OK = new Set(['function', 'web_search', 'web_search_preview'])
const FORBIDDEN_KEYS = ['background', 'previous_response_id', 'conversation', 'prompt']
const MAX_BODY = 32 * 1024 * 1024
/** a 429 whose retry-after is this short is retried once by the proxy (Codex does not retry 429 itself, C14) */
const RETRY_429_MAX_S = 10
const CREDIT_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'organization_usage_limit_exceeded'])

/** `lists`: how many content lists deep (input -> a message's content -> a function output's content ...: at most 8);
 * `depth`: JSON levels overall (a guard against absurd nesting) */
function checkContent(v: unknown, lists: number, depth = 0): string | null {
  if (lists > 8 || depth > 64) return 'input nested too deep'
  if (Array.isArray(v)) { for (const x of v) { const r = checkContent(x, lists + 1, depth + 1); if (r) return r } return null }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.type === 'input_image') {
    if (o.file_id !== undefined) return 'input_image by file id is not allowed'
    if (typeof o.image_url === 'string' && !o.image_url.startsWith('data:')) return 'input_image must carry its data inline'
  }
  if (o.type === 'input_file') {
    if (o.file_id !== undefined || o.file_url !== undefined) return 'input_file must carry its data inline'
  }
  // Codex 0.163 with a "responses lite" model sends its tool list as an input item ({type: "additional_tools", role:
  // "developer", tools: [...]}) instead of the top-level `tools` (core/src/client.rs): the same tool rule applies
  if (o.tools !== undefined) { const r = checkTools(o.tools); if (r) return r }
  for (const [k, x] of Object.entries(o)) if (k !== 'type' && typeof x === 'object' && x !== null) { const r = checkContent(x, lists, depth + 1); if (r) return r }
  return null
}

function checkTools(tools: unknown, depth = 0): string | null {
  if (tools === undefined) return null
  if (!Array.isArray(tools)) return 'tools must be a list'
  if (depth > 4) return 'tools nested too deep'
  for (const t of tools as Record<string, unknown>[]) {
    const type = t && typeof t === 'object' ? t.type : undefined
    if (type === 'namespace' || Array.isArray((t as { tools?: unknown })?.tools)) { const r = checkTools((t as { tools?: unknown }).tools, depth + 1); if (r) return r; continue }
    if (typeof type !== 'string' || !TOOL_OK.has(type)) return `tool type ${String(type).slice(0, 40)} is not allowed`
  }
  return null
}

/** null = forward (the body is changed in place: store false); else why the request is refused */
export function checkResponsesRequest(body: unknown, models: string[]): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object'
  const b = body as Record<string, unknown>
  if (typeof b.model !== 'string' || !models.includes(b.model)) return 'model is not in the locked catalog'
  for (const k of FORBIDDEN_KEYS) if (b[k] !== undefined && b[k] !== null && b[k] !== false) return `${k} is not allowed`
  if (b.service_tier !== undefined && b.service_tier !== null && b.service_tier !== 'auto' && b.service_tier !== 'default') return 'service_tier is not allowed'
  const t = checkTools(b.tools)
  if (t) return t
  if (b.input !== undefined) { const r = checkContent(b.input, 0); if (r) return r }
  if (b.instructions !== undefined && typeof b.instructions !== 'string') return 'instructions must be text'
  b.store = false
  return null
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function handleCodex(req: Request, url: URL, d: CodexPathDeps): Promise<Response> {
  const p = url.pathname
  // background calls of the engine (chatgpt_base_url): answered here, never upstream
  if (p.startsWith('/codex/backend/')) {
    if (req.method === 'GET' && p === '/codex/backend/wham/config/bundle') return json(200, {})
    return apiError(404, 'not_found_error', 'not found')
  }
  if (p === '/codex/oauth/token') {
    d.refused(null, 'engine refresh attempt')
    return json(400, { error: 'invalid_grant', error_description: 'the team server refreshes this sign-in' })
  }
  const m = /^\/codex\/(chatgpt|openai)\/responses$/.exec(p)
  if (!m || req.method !== 'POST') return apiError(404, 'not_found_error', 'not found')
  const mode = m[1] as 'chatgpt' | 'openai'
  const admitted = await d.admit(req)
  if (admitted instanceof Response) return admitted
  const row = admitted
  if (!d.broker) return apiError(503, 'api_error', 'no AI connection path on this team server')
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > MAX_BODY) return apiError(413, 'invalid_request_error', 'body too large')
  const raw = await req.arrayBuffer()
  if (raw.byteLength > MAX_BODY) return apiError(413, 'invalid_request_error', 'body too large')
  let parsed: unknown = null
  try { parsed = JSON.parse(new TextDecoder().decode(raw)) } catch {}
  const refused = (confidentialTurn(d.db,row.turn_id) && externalSearch(parsed) ? 'search is disabled for this confidential conversation' : null) ?? checkResponsesRequest(parsed, d.codexModels())
  if (refused) {
    d.refused(row, refused)
    return apiError(403, 'permission_error', `refused by the team server: ${refused}`)
  }
  if (overBudget(d.db, row.user_id, row.turn_id, row.budget_usd)) {
    d.onTurnEvent?.(row.turn_id, { type: 'budget' })
    return apiError(403, 'permission_error', 'budget_exceeded')
  }
  const binding = { credentialId: row.credential_id, family: row.family, turnId: row.turn_id, userId: row.user_id }
  let cred = await d.broker.forRequest(binding, 'openai')
  if (!cred.ok) {
    if (cred.event) d.onTurnEvent?.(row.turn_id, cred.event)
    return apiError(cred.status, cred.type, cred.message, cred.retryAfter ? { 'retry-after': String(cred.retryAfter) } : {})
  }
  if ((mode === 'chatgpt') !== (cred.kind === 'chatgpt')) {
    d.refused(row, 'connection kind does not match the path')
    return apiError(403, 'permission_error', 'this AI connection is not for this path')
  }
  const outBody = JSON.stringify(parsed)
  let model = String((parsed as { model: string }).model)
  const abort = new AbortController()
  req.signal.addEventListener('abort', () => abort.abort(), { once: true })

  const send = async (c: Extract<typeof cred, { ok: true }>): Promise<Response | null> => {
    const headers = new Headers()
    for (const k of FORWARD) { const v = req.headers.get(k); if (v) headers.set(k, v) }
    headers.set('content-type', 'application/json')
    if (c.inject.type === 'chatgpt') {
      headers.set('authorization', 'Bearer ' + c.inject.accessToken)
      headers.set('chatgpt-account-id', c.inject.accountId)
      if (c.inject.fedramp) headers.set('x-openai-fedramp', 'true')
    } else if (c.inject.type === 'openai-bearer') headers.set('authorization', 'Bearer ' + c.inject.key)
    else return null
    try {
      return await fetch(`${c.upstream.replace(/\/$/, '')}/responses`, { method: 'POST', headers, body: outBody, signal: abort.signal, redirect: 'manual' })
    } catch { return null }
  }

  let up = await send(cred)
  if (!up) return apiError(502, 'api_error', 'the model service could not be reached')
  if (up.status >= 300 && up.status < 400) {
    await up.body?.cancel().catch(() => {})
    return apiError(502, 'api_error', 'the model service answered with a redirect; it is not followed')
  }
  if (up.status === 401) {
    await up.body?.cancel().catch(() => {})
    if (cred.kind === 'chatgpt') {
      // one refresh (or the one another request just did), then one more try with the new access token
      const r = await d.broker.onUnauthorized(cred.credentialId, cred.inject.type === 'chatgpt' ? cred.inject.accessToken : '')
      if (r === 'temporary') return apiError(502, 'api_error', 'the sign-in could not be refreshed right now')
      if (r === 'refused') {
        d.onTurnEvent?.(row.turn_id, { type: 'credential', credentialId: cred.credentialId, reason: 'needs_reconnect' })
        return apiError(403, 'permission_error', 'credential_needs_reconnect')
      }
      const c2 = await d.broker.forRequest(binding, 'openai')
      if (!c2.ok) {
        if (c2.event) d.onTurnEvent?.(row.turn_id, c2.event)
        return apiError(c2.status, c2.type, c2.message)
      }
      cred = c2
      up = await send(c2)
      if (!up) return apiError(502, 'api_error', 'the model service could not be reached')
    }
    if (up.status === 401) {
      await up.body?.cancel().catch(() => {})
      d.broker.markInvalid(cred.credentialId, 'upstream_401', 401)
      d.onTurnEvent?.(row.turn_id, { type: 'credential', credentialId: cred.credentialId, reason: 'invalid' })
      // 403, not 401: Codex answers a 401 by refreshing its own (placeholder) login
      return apiError(403, 'permission_error', 'credential_invalid')
    }
  }
  if (up.status === 429) {
    const text = await up.text()
    let err: Record<string, unknown> = {}
    try { const j = JSON.parse(text); err = (j?.error && typeof j.error === 'object' ? j.error : {}) as Record<string, unknown> } catch {}
    const type = String(err.type ?? err.code ?? '')
    const ra = retryAfterSeconds(up.headers.get('retry-after'))
    const now = Date.now()
    let until: Date | null = null
    if (type === 'usage_limit_reached') {
      const resets = typeof err.resets_at === 'number' ? err.resets_at * 1000 : null
      until = new Date(resets && resets > now ? resets : ra !== null ? now + ra * 1000 : now + 3600_000)
    } else if (CREDIT_CODES.has(type) || /_spend_limit_exceeded$/.test(type)) {
      until = new Date(now + 3600_000)
    } else if (type === 'usage_not_included') {
      d.broker.markInvalid(cred.credentialId, 'usage_not_included', 429)
      d.onTurnEvent?.(row.turn_id, { type: 'credential', credentialId: cred.credentialId, reason: 'invalid' })
      return new Response(text, { status: 429, headers: { 'content-type': up.headers.get('content-type') ?? 'application/json' } })
    } else if (ra !== null && ra <= RETRY_429_MAX_S) {
      await Bun.sleep(ra * 1000)
      const r2 = await send(cred)
      if (!r2) return apiError(502, 'api_error', 'the model service could not be reached')
      up = r2
    } else {
      until = new Date(now + (ra ?? 3600) * 1000)
    }
    if (until) {
      d.broker.onLongLimit(cred.credentialId, until, type || 'rate_limited')
      d.onTurnEvent?.(row.turn_id, { type: 'rate_limit', retryAt: until.toISOString(), credentialId: cred.credentialId })
      return new Response(text, { status: 429, headers: { 'content-type': up.headers.get('content-type') ?? 'application/json' } })
    }
  }
  const outHeaders = new Headers()
  for (const [k, v] of up.headers) if (!DROP_RESPONSE.has(k.toLowerCase())) outHeaders.set(k, v)
  if (up.status >= 200 && up.status < 300) d.broker.succeeded(cred.credentialId)
  if (up.status >= 500) {
    // the connection's state stays; the engine retries (request_max_retries)
    await up.body?.cancel().catch(() => {})
    return apiError(502, 'api_error', `the model service answered ${up.status}`)
  }
  const credId = cred.credentialId
  const broker = d.broker
  if (up.status < 300 && up.body && (up.headers.get('content-type') ?? '').includes('text/event-stream')) {
    // pass the stream through as it arrives; usage from response.completed / response.incomplete, web searches from
    // its output items
    let usage: Record<string, unknown> | null = null
    let buf = ''
    let recorded = false
    const done = () => { if (!recorded && usage) { recorded = true; broker.record(credId, row.turn_id, model, usage) } }
    const dec = new TextDecoder()
    const reader = up.body.getReader()
    const scan = (chunk: Uint8Array) => {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!l.startsWith('data:')) continue
        try {
          const ev = JSON.parse(l.slice(5))
          if ((ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed') && ev.response) {
            const r = ev.response as { usage?: Record<string, unknown>; model?: string; output?: { type?: string }[] }
            if (typeof r.model === 'string') model = r.model
            if (r.usage) usage = { ...r.usage, web_search_calls: (r.output ?? []).filter((o) => o?.type === 'web_search_call').length }
          }
        } catch {}
      }
      if (buf.length > 4 << 20) buf = ''
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        try {
          const { value, done: end } = await reader.read()
          if (end) { done(); ctl.close(); return }
          ctl.enqueue(value)
          scan(value)
        } catch (e) { done(); ctl.error(e) }
      },
      cancel() { done(); abort.abort(); reader.cancel().catch(() => {}) },
    }, { highWaterMark: 0 })
    return new Response(stream, { status: up.status, headers: outHeaders })
  }
  const text = await up.text()
  if (up.status < 300) try {
    const j = JSON.parse(text)
    if (j?.usage) broker.record(credId, row.turn_id, typeof j.model === 'string' ? j.model : model, { ...j.usage, web_search_calls: Array.isArray(j.output) ? j.output.filter((o: { type?: string }) => o?.type === 'web_search_call').length : 0 })
  } catch {}
  return new Response(text, { status: up.status, headers: outHeaders })
}
