import { confidentialTurn, externalSearch } from "../safe-ops/confidential"
// The model proxy's Codex path (docs/DECISIONS.md "AI 연결" D9/D21). A managed Codex turn never holds a real
// credential: its CODEX_HOME/auth.json carries this turn's proxy token as the access token (or API key) and fixed
// placeholders, its model provider "teamax" points at http://127.0.0.1:<port>/codex/<chatgpt|openai>, and the
// background ChatGPT calls (chatgpt_base_url) and the token refresh address point here too. This handler:
//   POST /codex/chatgpt/responses   ChatGPT sign-in  -> <chatgpt>/responses (Authorization + ChatGPT-Account-ID)
//   POST /codex/openai/responses    OpenAI API key   -> <openai>/responses (Authorization)
//   POST /codex/<mode>/alpha/search Codex's own web search (the `web.run` tool, which Codex runs itself) -> the same
//                                    upstream's /alpha/search, held to the cached index (checkSearchRequest); a page
//                                    named by an address is answered here, never sent (searchOpensAddress); a 401 / 429
//                                    of a search fails that search only and leaves the connection's state alone
//   GET  /codex/backend/wham/config/bundle -> {} (a remote config bundle could change the lockdown: never passed)
//   other /codex/backend/*, /codex/*/models  -> 404 (never sent upstream; the two that Codex 0.163 sends on every
//                                    ChatGPT turn, BACKGROUND_404 below, are expected and not logged as failures)
//   POST /codex/oauth/token         -> 400 invalid_grant, audited (the engine must never refresh by itself)
// Requests are filtered like the Claude path: Responses only, function / web_search tools only (web_search held to
// the cached index: external_web_access false, web_search_preview refused), inline images and
// files only, no background / stored-prompt / conversation state, models from the locked catalog only, store forced
// to false, the checked body written again. 401 of a ChatGPT sign-in: one refresh (single-flight) and one retry; the
// engine then gets 403 (never 401, which would make Codex try to refresh). Long 429s mark this connection only.
import type { Database } from 'bun:sqlite'
import type { CredentialBroker } from '../credentials/broker'
import { overBudget, retryAfterSeconds, apiError, expectedAnswer, unreachable, toolPolicyOf, type ProxyTurnEvent, type TokenRow } from './model-proxy'

export interface CodexPathDeps {
  db: Database
  broker: CredentialBroker | null
  codexModels: () => string[]
  onTurnEvent?: (turnId: string, ev: ProxyTurnEvent) => void
  refused: (row: TokenRow | null, reason: string, extra?: Record<string, unknown>) => void
  admit: (req: Request) => Promise<TokenRow | Response>
  log?: { warn(msg: string, f?: Record<string, unknown>): void }
  /** the engine hung up while the answer streamed (model-proxy.ts: logged when its turn was stopped) */
  onStreamCancel?: () => void
}

/** request headers that reach the upstream (Codex 0.163's own headers, C8); everything else is dropped, the engine's
 * Authorization / ChatGPT-Account-ID / OpenAI-* / cookies included */
const FORWARD = ['content-type', 'accept', 'user-agent', 'originator', 'version', 'session-id', 'thread-id', 'x-client-request-id', 'x-openai-subagent',
  'x-codex-beta-features', 'x-codex-turn-state', 'x-codex-window-id', 'x-codex-turn-metadata', 'x-codex-parent-thread-id']
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'proxy-authenticate', 'upgrade'])
// web_search_preview ignores external_web_access (always live): refused. web_search is held to the cached index.
const TOOL_OK = new Set(['function', 'web_search'])
const FORBIDDEN_KEYS = ['background', 'previous_response_id', 'conversation', 'prompt']
const MAX_BODY = 32 * 1024 * 1024
/** a 429 whose retry-after is this short is retried once by the proxy (Codex does not retry 429 itself, C14) */
const RETRY_429_MAX_S = 10
const CREDIT_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'organization_usage_limit_exceeded'])
/** GETs Codex 0.163 sends to chatgpt_base_url on every turn with a ChatGPT sign-in (codex-rs backend-client; the path
 * style follows the base URL, ours has no "/backend-api"). Both are answered 404 on purpose, as before, and Codex goes
 * on without them; only the warning goes (QA 2026-10-30: three per answer buried the real ones):
 *   accounts/check  workspace routing discovery (app-server workspace_routing.rs): an answer could send the model
 *                   requests to the backend origin it names, around this proxy
 *   settings/user   the commit-attribution setting (ext/git-attribution): without it Codex leaves attribution off */
const BACKGROUND_404 = new Set(['/codex/backend/api/codex/accounts/check', '/codex/backend/api/codex/settings/user',
  '/codex/backend/wham/accounts/check', '/codex/backend/wham/settings/user'])
const TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed'])

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
    if (Array.isArray((t as { tools?: unknown })?.tools)) { const r = checkTools((t as { tools?: unknown }).tools, depth + 1); if (r) return r }
    // a namespace only groups tools; any other entry is checked itself too, whatever it holds
    if (type === 'namespace') continue
    if (typeof type !== 'string' || !TOOL_OK.has(type)) return `tool type ${String(type).slice(0, 40)} is not allowed`
    // cached results only: a live search could open any address, outside the team server's address rules (web_fetch,
    // docs/DECISIONS.md "Outbound web channels"). Written into the forwarded body whatever the engine sent.
    if (type === 'web_search') (t as Record<string, unknown>).external_web_access = false
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

/** what Codex 0.163's `web.run` tool may ask for (its commands are the tool's parameters; Codex drops other keys) */
const SEARCH_COMMANDS = new Set(['search_query', 'image_query', 'open', 'click', 'find', 'screenshot', 'finance', 'weather', 'sports', 'time', 'response_length'])
const SEARCH_KEYS = new Set(['id', 'model', 'input', 'commands', 'settings', 'max_output_tokens'])
const SEARCH_SETTINGS = new Set(['allowed_callers', 'external_web_access'])
/** a command takes at most this many entries (Codex sends the model's list as it is) */
const SEARCH_ENTRIES_MAX = 20

/**
 * The shape of each command as Codex 0.163–0.165 sends it (typed: a list of flat objects whose fields are text,
 * numbers or lists of text; `response_length` is a word). Codex itself drops keys the model adds; the proxy holds the
 * same shape, so no nested setting or second command list rides along in a field.
 */
function checkSearchCommands(c: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(c)) {
    if (v === null) continue
    if (k === 'response_length') { if (typeof v !== 'string') return 'search command response_length must be text'; continue }
    if (!Array.isArray(v)) return `search command ${k} must be a list`
    if (v.length > SEARCH_ENTRIES_MAX) return `search command ${k} has more than ${SEARCH_ENTRIES_MAX} entries`
    for (const e of v) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return `search command ${k} takes objects`
      for (const [f, x] of Object.entries(e)) {
        const flat = x === null || typeof x !== 'object' || (Array.isArray(x) && x.every((y) => typeof y === 'string'))
        if (!flat) return `search command ${k}.${f.slice(0, 40)} is not allowed`
      }
    }
  }
  return null
}

/** a reference to one of the search's own results (turn0search0, turn0fetch3, turn1view0): never an address or a host */
const SEARCH_REF = /^[A-Za-z0-9_-]{1,100}$/

/**
 * open / click / find / screenshot name a page by `ref_id`, which Codex lets be "a reference id or URL". An address
 * there is not passed on (docs/DECISIONS.md "Codex web search"): the address would leave the team server inside the
 * search request, and what OpenAI's side does with an address it has not indexed cannot be seen from here. Addresses
 * are opened with web_fetch, under the address rules (the card), as with Claude, whose WebSearch opens no page. null =
 * every page named is a result reference; else the refusal's reason.
 */
export function searchOpensAddress(body: unknown): string | null {
  const c = (body as { commands?: unknown } | null)?.commands
  if (!c || typeof c !== 'object') return null
  for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue
    for (const e of v) {
      const ref = (e as { ref_id?: unknown } | null)?.ref_id
      if (ref !== undefined && ref !== null && (typeof ref !== 'string' || !SEARCH_REF.test(ref))) return `search command ${k} names an address, not a search result`
    }
  }
  return null
}
/** what the model gets for such a call (Codex hands the `output` to it as the tool's result) */
export const SEARCH_ADDRESS_NOTE = 'The team server did not run this: open, click, find and screenshot here take only a reference to a result of this search (such as turn0search0), not a web address. To read a page at an address, use the web_fetch tool.'

/**
 * Codex's standalone web search (POST <base_url>/alpha/search: the conversation, the tool's commands and settings).
 * Cached results only: `settings.external_web_access` goes out false whatever the engine sent, as for the web_search
 * tool, so OpenAI answers from its index and no page is loaded live for it (docs/DECISIONS.md "Codex web search").
 * Keys, commands and settings this version does not send are refused rather than passed on. null = forward (the body
 * is changed in place); else why the request is refused.
 */
export function checkSearchRequest(body: unknown, models: string[]): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object'
  const b = body as Record<string, unknown>
  if (typeof b.model !== 'string' || !models.includes(b.model)) return 'model is not in the locked catalog'
  for (const k of Object.keys(b)) if (!SEARCH_KEYS.has(k)) return `search field ${k.slice(0, 40)} is not allowed`
  const c = b.commands
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'search commands must be an object'
  for (const k of Object.keys(c)) if (!SEARCH_COMMANDS.has(k)) return `search command ${k.slice(0, 40)} is not allowed`
  const cr = checkSearchCommands(c as Record<string, unknown>)
  if (cr) return cr
  const st = b.settings ?? {}
  if (typeof st !== 'object' || Array.isArray(st) || st === null) return 'search settings must be an object'
  for (const k of Object.keys(st)) if (!SEARCH_SETTINGS.has(k)) return `search setting ${k.slice(0, 40)} is not allowed`
  b.settings = { ...st, external_web_access: false }
  if (b.input !== undefined) { const r = checkContent(b.input, 0); if (r) return r }
  return null
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function handleCodex(req: Request, url: URL, d: CodexPathDeps): Promise<Response> {
  const p = url.pathname
  // background calls of the engine (chatgpt_base_url): answered here, never upstream
  if (p.startsWith('/codex/backend/')) {
    if (req.method === 'GET' && p === '/codex/backend/wham/config/bundle') return json(200, {})
    const r = apiError(404, 'not_found_error', 'not found')
    return req.method === 'GET' && BACKGROUND_404.has(p) ? expectedAnswer(r) : r
  }
  if (p === '/codex/oauth/token') {
    d.refused(null, 'engine refresh attempt')
    return json(400, { error: 'invalid_grant', error_description: 'the team server refreshes this sign-in' })
  }
  const m = /^\/codex\/(chatgpt|openai)\/(responses|alpha\/search)$/.exec(p)
  if (!m || req.method !== 'POST') return apiError(404, 'not_found_error', 'not found')
  const mode = m[1] as 'chatgpt' | 'openai'
  const endpoint = m[2] as 'responses' | 'alpha/search'
  const search = endpoint === 'alpha/search'
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
  // web search (the search call itself, or a request that offers or replays the web tool): never in a confidential
  // conversation, and only for a turn started with it (approved templates and confidential chats start without;
  // toolPolicyOf: a token from before has it). The body is scanned only when one of the two applies.
  const noSearch = confidentialTurn(d.db, row.turn_id) ? 'search is disabled for this confidential conversation'
    : !toolPolicyOf(row).webSearch ? 'web search is off for this answer' : null
  const refused = (noSearch && (search || externalSearch(parsed)) ? noSearch : null)
    ?? (search ? checkSearchRequest(parsed, d.codexModels()) : checkResponsesRequest(parsed, d.codexModels()))
  if (refused) {
    d.refused(row, refused)
    return apiError(403, 'permission_error', `refused by the team server: ${refused}`)
  }
  // a page named by its address: nothing goes upstream, and the model is told what to use instead (a 403 would give
  // it only "aborted", and it would try again)
  const address = search ? searchOpensAddress(parsed) : null
  if (address) {
    d.refused(row, address)
    return json(200, { output: SEARCH_ADDRESS_NOTE })
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
      return await fetch(`${c.upstream.replace(/\/$/, '')}/${endpoint}`, { method: 'POST', headers, body: outBody, signal: abort.signal, redirect: 'manual' })
    } catch { return null }
  }

  let up = await send(cred)
  if (!up) return unreachable(req)
  if (up.status >= 300 && up.status < 400) {
    await up.body?.cancel().catch(() => {})
    return apiError(502, 'api_error', 'the model service answered with a redirect; it is not followed')
  }
  // a refused or limited search says nothing certain about the connection (an endpoint or a scope it lacks, a limit of
  // search alone): it fails by itself, Codex gives the model "aborted" and goes on, and the model requests keep
  // deciding the connection's state (refresh, invalid, limited). Never a refresh per search either.
  if (search && (up.status === 401 || up.status === 429)) {
    const status = up.status
    await up.body?.cancel().catch(() => {})
    d.log?.warn('model proxy: web search refused by the model service', { turn: row.turn_id, status })
    return apiError(status === 401 ? 403 : 429, status === 401 ? 'permission_error' : 'rate_limit_error', `the model service answered ${status} to this web search`)
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
      if (!up) return unreachable(req)
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
      if (!r2) return unreachable(req)
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
  // usage from the answer's terminal event (response.completed / .incomplete / .failed), web searches from its output
  // items; counted once, as soon as that event passed: Codex 0.163 stops reading there and hangs up
  // (codex-api/src/sse/responses.rs), so the end of the stream is never read
  let usage: Record<string, unknown> | null = null
  let recorded = false
  const done = () => {
    if (recorded || !usage) return
    recorded = true
    // the answer goes on either way (an error in the stream would make the engine ask again, and pay twice)
    try { broker.record(credId, row.turn_id, model, usage) } catch (e) { d.log?.warn('model proxy: usage not recorded', { err: String((e as Error)?.message ?? e).slice(0, 200) }) }
  }
  let buf = ''
  const dec = new TextDecoder()
  const scan = (chunk: Uint8Array | string) => {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!l.startsWith('data:')) continue
      try {
        const ev = JSON.parse(l.slice(5))
        if (TERMINAL.has(ev?.type) && ev.response) {
          const r = ev.response as { usage?: Record<string, unknown>; model?: string; output?: { type?: string }[] }
          if (typeof r.model === 'string') model = r.model
          if (r.usage) { usage = { ...r.usage, web_search_calls: (r.output ?? []).filter((o) => o?.type === 'web_search_call').length }; done() }
        }
      } catch {}
    }
    if (buf.length > 4 << 20) buf = ''
  }
  // chatgpt.com/backend-api/codex/responses streams its events with no content-type at all (QA 2026-10-30: every
  // ChatGPT answer took the buffered branch below and none was counted). An untyped answer to a streamed request is
  // the stream it was asked for.
  const ct = (up.headers.get('content-type') ?? '').toLowerCase()
  const sse = ct.includes('text/event-stream') || (!ct && (parsed as { stream?: unknown }).stream === true)
  if (up.status < 300 && up.body && sse) {
    // pass the stream through as it arrives
    const reader = up.body.getReader()
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        try {
          const { value, done: end } = await reader.read()
          if (end) { done(); ctl.close(); return }
          ctl.enqueue(value)
          scan(value)
        } catch (e) { done(); ctl.error(e) }
      },
      cancel() { done(); abort.abort(); reader.cancel().catch(() => {}); d.onStreamCancel?.() },
    }, { highWaterMark: 0 })
    return new Response(stream, { status: up.status, headers: outHeaders })
  }
  const text = await up.text()
  if (up.status < 300) try {
    let j: { usage?: Record<string, unknown>; model?: unknown; output?: unknown } | null = null
    try { j = JSON.parse(text) } catch { scan(text + '\n') } // events under another content-type: still counted
    // a search answer is one web search call (with the tokens of its own model, when it says them)
    if (search && j) broker.record(credId, row.turn_id, typeof j.model === 'string' ? j.model : model, { ...(j.usage ?? {}), web_search_calls: 1 })
    else if (j?.usage) broker.record(credId, row.turn_id, typeof j.model === 'string' ? j.model : model, { ...j.usage, web_search_calls: Array.isArray(j.output) ? j.output.filter((o: { type?: string }) => o?.type === 'web_search_call').length : 0 })
  } catch {}
  return new Response(text, { status: up.status, headers: outHeaders })
}
