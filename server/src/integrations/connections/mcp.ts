// A small MCP client over Streamable HTTP (no SDK): JSON-RPC POSTs that accept JSON or an event stream, the server's
// Mcp-Session-Id kept for the session, MCP-Protocol-Version on every request after initialize.
// initialize -> notifications/initialized -> tools/list (cursor pages) -> tools/call. The server's words that are cut
// here (an error message, tool descriptions) have the connection's secrets hidden first (hide.ts).
import crypto from 'node:crypto'
import { INTEGRATION_TOOLS_MAX } from '@mycel/shared/api'
import { hideDeep } from './hide'
import { NetError, serviceRequest, type NetOptions, type NetRequest, type NetResponse } from './net'
import { refusalOf, type Refusal } from './refusal'

export const MCP_PROTOCOL = '2025-06-18'
/** the most a tools/call answer may be: an image or audio block comes inline as base64 (a generated image of a few MB
 * is common). initialize keeps the 1 MiB of net.ts, tools/list has its own cap below; the AI still gets at most
 * MAX_RESULT_CHARS of text (tools.ts), the bytes go to the chat's media store. */
export const MCP_CALL_MAX_BYTES = 25 * 1024 * 1024
/** the most one tools/list page may be. A big service sends its whole catalog in one page (Higgsfield: 186 tools,
 * about 1.07 MB in 2026-11), over net.ts's 1 MiB; what is kept is capped below (MAX_TOOLS, MAX_SCHEMAS_CHARS). */
export const MCP_LIST_MAX_BYTES = 8 * 1024 * 1024
/** the most one check reads of tools/list, all pages together, and how many pages it asks for: a server that pages
 * on forever (or sends pages of tools that cannot be kept) costs at most this, not 100 pages of 8 MiB. Reading stops
 * sooner once the list kept is full (MAX_TOOLS, MAX_SCHEMAS_CHARS). */
export const MCP_LIST_TOTAL_BYTES = 16 * 1024 * 1024
export const MCP_LIST_MAX_PAGES = 20
/** a check reads tools/list for as long as it keeps coming: a page fails when no bytes arrive for MCP_LIST_IDLE_MS,
 * and the check when its pages are not all in MCP_LIST_TIMEOUT_MS after it began, instead of the 30 s each of other
 * requests (net.ts). A big list can come slowly: Higgsfield sent its 1.07 MB at 17-38 KB/s in 2026-11, 30-65 s, and
 * the 30 s cut it every time. 90 s stays under what the person's "Check again" request may wait (the relay's 100 s for
 * an answer to start, the server's 120 s idle limit, main.ts). A turn never reads the list (it uses the saved one,
 * store.ts savedTools). */
export const MCP_LIST_IDLE_MS = 30_000
export const MCP_LIST_TIMEOUT_MS = 90_000
/** a tools/call waits for its answer for as long as the service keeps working on it: it fails when nothing at all comes
 * for MCP_CALL_IDLE_MS (the bytes of an event stream count: the progress notifications we ask for with a progressToken,
 * pings, log messages), and in any case MCP_CALL_TIMEOUT_MS after it began. It used to have the 30 s of other requests,
 * which cut every web scrape (Bright Data's LinkedIn scrapers answer in 1-2 minutes, silently, in 2026-11). 5 minutes:
 * a scrape or a render that sends nothing until it is done finishes; a service that has hung is told apart within
 * that. 15 minutes in all: under the 30 minutes the engines wait for one of our tool calls (engine/claude.ts
 * MCP_TOOL_TIMEOUT_MS, engine/codex.ts CODEX_TOOL_TIMEOUT_SEC), so the AI gets our plain reason, not the engine's
 * timeout, and a service that keeps trickling bytes cannot hold a turn for ever (the turn's stall guard waits while
 * our tool runs, chat/turn.ts ownCallStarted). Stop ends the call at once (the turn's signal) and tells the service
 * (notifications/cancelled). */
export const MCP_CALL_IDLE_MS = 5 * 60_000
export const MCP_CALL_TIMEOUT_MS = 15 * 60_000
const KNOWN_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])
/** tools kept per connection: every tool a service lists, up to this hard ceiling (docs/DECISIONS.md "Connection
 * tools: deferred, found and called"). A turn offers what fits its budget as tools and the rest through find_tools /
 * call_tool (tools.ts), so a big catalog no longer goes to the engine whole with every turn. */
export const MAX_TOOLS = INTEGRATION_TOOLS_MAX
/** one tool's input schema, as kept. A larger one is shortened (its longest descriptions cut, shrinkSchema), and only
 * left out when its structure alone is larger. 32,000 characters is about 8,000 tokens: a turn offers connection tools
 * directly up to MAX_TURN_TOOL_CHARS (50,000, tools.ts) in all, so a larger tool would take most of a turn's budget. */
export const MAX_SCHEMA_CHARS = 32_000
/** all kept input schemas and descriptions of one connection together (what tools_json holds; Higgsfield's is about
 * 1.07 million characters) */
export const MAX_SCHEMAS_CHARS = 4_000_000
const MAX_DESCRIPTION = 1000
/** the end of a description we cut (a tool's own, or one inside its schema): the AI is told the words go on */
export const SHORTENED = '… (shortened)'

export class McpError extends Error {
  name = 'McpError'
  /** unauthorized: 401 (wwwAuthenticate: its header); forbidden: 403; session_gone: 404 for our session; rpc: a
   * JSON-RPC error (message: the server's, cut); not_mcp: an answer that is not MCP. `refusal`: a 401's or 403's OAuth
   * error code and the service's words, sanitized (refusal.ts) */
  constructor(readonly code: 'unauthorized' | 'forbidden' | 'session_gone' | 'rpc' | 'not_mcp' | 'http', readonly status = 0, readonly detail = '', readonly refusal: Refusal = { error: '', said: '' }) { super(code) }
}

export interface RemoteTool { name: string; title: string | null; description: string; readOnly: boolean; inputSchema: Record<string, unknown>
  /** the service says the tool changes something but destroys nothing (destructiveHint false, not read-only): with a
   * create name, the create tier that runs without a card (tools.ts createTool; docs/decisions/20261123-do-then-undo.md).
   * Absent when the service does not say so (MCP's default for a change is destructive) */
  nonDestructive?: true }

/** Server-sent events in a body: the data of each complete event (blank-line terminated). */
export function sseEvents(text: string, complete = false): string[] {
  const out: string[] = []
  const blocks = text.replace(/\r\n?/g, '\n').split('\n\n')
  if (!complete) blocks.pop() // the last block may still be arriving
  for (const b of blocks) {
    const data = b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''))
    if (data.length) out.push(data.join('\n'))
  }
  return out
}

/** a tool over MAX_SCHEMA_CHARS: its name, its schema's size as listed (characters of JSON), and whether it was kept
 * shortened (true) or left out */
export type SizeNote = (name: string, chars: number, kept: boolean) => void
/** listTools' answer. `shortened`, `dropped`: the tools whose input schema was over MAX_SCHEMA_CHARS, kept with their
 * longest descriptions cut, or left out because even cut they did not fit (chars: the size as listed) */
export interface ListedTools {
  tools: RemoteTool[]; more: boolean; total: number; unread: boolean
  shortened: { name: string; chars: number }[]; dropped: { name: string; chars: number }[]
}

/** The JSON-RPC response with this id among the messages of a body (one object, a batch, or events). */
function findReply(messages: unknown[], id: string): Record<string, any> | null {
  for (const m of messages) {
    if (Array.isArray(m)) { const r = findReply(m, id); if (r) return r; continue }
    if (m && typeof m === 'object' && (m as any).id === id && ('result' in (m as object) || 'error' in (m as object))) return m as Record<string, any>
  }
  return null
}
const parse = (s: string): unknown => { try { return JSON.parse(s) } catch { return null } }
type Hide = (text: string) => string
const keep: Hide = (s) => s
interface Req { signal?: AbortSignal; maxBytes?: number; read?: { bytes: number }; long?: NetRequest['long'] }

export class McpClient {
  sessionId: string | null = null
  version: string | null = null
  private ready: Promise<void> | null = null
  usedAt = Date.now()

  /** `hider` makes the function that hides the connection's secrets, when an answer is in (a refresh may have rotated
   * them); `auth` is told when a check's request must end (a token still valid is then not refreshed ahead of time) */
  /** `send`: another way to the server than net.ts (a Google app connection's calls go only to the library on this
   * machine, google-apps/transport.ts); left out, serviceRequest with its address rules */
  constructor(readonly url: string, private auth: (deadline?: number) => Promise<[string, string][]>, private net: NetOptions, private hider: () => Hide = () => keep,
    private send?: (url: string, r: NetRequest) => Promise<NetResponse>) {}

  /** `read`: the answer's bytes are added to it (also when it is cut); `long`: net.ts NetRequest.long */
  private async post(message: Record<string, unknown>, o: Req = {}): Promise<Record<string, any> | null> {
    const { signal, maxBytes, read, long } = o
    // past a check's deadline nothing starts, not even a token refresh
    if (long && Date.now() >= long.deadline) throw new NetError(long.reason)
    const id = typeof message.id === 'string' ? message.id : null
    const headers: [string, string][] = [['Content-Type', 'application/json'], ['Accept', 'application/json, text/event-stream'], ...(await this.auth(long?.deadline))]
    if (this.version) headers.push(['MCP-Protocol-Version', this.version])
    if (this.sessionId) headers.push(['Mcp-Session-Id', this.sessionId])
    const req: NetRequest = {
      method: 'POST', headers, body: Buffer.from(JSON.stringify(message)), signal, ...(maxBytes ? { maxBytes } : {}), ...(long ? { long } : {}),
      // an event stream may stay open after our reply: stop reading once it is in
      until: id ? (body, head) => /text\/event-stream/i.test(head.headers['content-type'] ?? '') && !!findReply(sseEvents(body.toString('utf8')).map(parse), id) : undefined,
    }
    // a long call keeps the session in use while it runs (service.ts CLIENT_IDLE_MS)
    this.usedAt = Date.now()
    const res = this.send ? await this.send(this.url, req) : await serviceRequest(this.url, req, this.net)
    this.usedAt = Date.now()
    if (read) read.bytes += res.body.length
    if (res.status === 401) throw new McpError('unauthorized', 401, res.headers['www-authenticate'] ?? '', refusalOf(res, this.hider()))
    if (res.status === 403) throw new McpError('forbidden', 403, res.headers['www-authenticate'] ?? '', refusalOf(res, this.hider()))
    if (res.status === 404 && this.sessionId) throw new McpError('session_gone', 404)
    if (res.status >= 300 && res.status < 400) throw new NetError('redirect', res.status)
    if (res.status < 200 || res.status >= 300) throw new McpError('http', res.status)
    if (!id) return null // a notification: 202 (or any 2xx) and nothing to read
    if (res.truncated) throw new NetError('too_large')
    const type = (res.headers['content-type'] ?? '').toLowerCase()
    const text = res.body.toString('utf8')
    const messages = type.includes('text/event-stream') ? sseEvents(text, true).map(parse) : [parse(text)]
    const reply = findReply(messages, id)
    if (!reply) throw new McpError('not_mcp', res.status)
    if (message.method === 'initialize') {
      const sid = res.headers['mcp-session-id']
      if (sid && /^[\x21-\x7e]{1,1024}$/.test(sid)) this.sessionId = sid
    }
    if (reply.error) throw new McpError('rpc', 0, this.hider()(String(reply.error?.message ?? 'error')).replace(/[\u0000-\u001f]/g, ' ').slice(0, 300))
    return reply.result && typeof reply.result === 'object' ? reply.result : {}
  }

  private request(method: string, params: Record<string, unknown>, o: Req = {}) {
    return this.post({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }, o)
  }

  /** initialize + notifications/initialized, once per session (shared by a check and the calls: its own 30 s each,
   * never a check's deadline; listTools stops waiting for it at its deadline) */
  start(signal?: AbortSignal): Promise<void> {
    this.ready ??= (async () => {
      const r = await this.request('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'team-integrations', version: '1.0' } }, { signal })
      const v = typeof r?.protocolVersion === 'string' ? r.protocolVersion : ''
      if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new McpError('not_mcp')
      this.version = KNOWN_VERSIONS.has(v) ? v : MCP_PROTOCOL
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { signal })
    })().catch((e) => { this.ready = null; this.sessionId = null; this.version = null; throw e })
    return this.ready
  }

  /** the pages of tools/list; tools without a usable input schema are left out; at most MAX_TOOLS (and
   * MAX_SCHEMAS_CHARS) kept. Reading stops once the list kept is full, after MCP_LIST_MAX_PAGES pages, or at
   * MCP_LIST_TOTAL_BYTES (a later page that does not fit in what is left is not read whole, and the pages before it are
   * kept). `total`: how many usable tools the pages read listed (counted on past the ceiling within a page, so people
   * and the AI can be told "1,000 of 1,200"); `more`: some were not kept, or pages were left unread; `unread`: pages
   * were left unread, so the service offers more than `total` ("1,000 of more than 1,000"). `deadline` (epoch ms): when
   * the check must be done (MCP_LIST_TIMEOUT_MS; one for a whole check, service.ts check), also while it waits for the
   * session to start. */
  async listTools(signal?: AbortSignal, deadline = Date.now() + (this.net.listTimeoutMs ?? MCP_LIST_TIMEOUT_MS)): Promise<ListedTools> {
    await byDeadline(this.start(signal), deadline)
    const long = { deadline, idleMs: this.net.listIdleMs ?? MCP_LIST_IDLE_MS, reason: 'list_timeout' as const }
    const tools: RemoteTool[] = []
    const seen = new Set<string>()
    const read = { bytes: 0 }
    let cursor: string | undefined
    let full = false
    let size = 0
    // tools whose schema was over MAX_SCHEMA_CHARS: kept shortened, or left out (by name, once each)
    const oversized = { shortened: new Map<string, number>(), dropped: new Map<string, number>() }
    // a shortened one counts once it is kept (not a duplicate, not past a full list)
    let cut: { name: string; chars: number } | null = null
    const note: SizeNote = (name, chars, kept) => { if (kept) cut = { name, chars }; else oversized.dropped.set(name, chars) }
    for (let page = 0; page < MCP_LIST_MAX_PAGES; page++) {
      const room = MCP_LIST_TOTAL_BYTES - read.bytes
      if (room <= 0) break
      const cap = Math.min(MCP_LIST_MAX_BYTES, room)
      let r: Record<string, any> | null
      try { r = await this.request('tools/list', cursor ? { cursor } : {}, { signal, maxBytes: cap, read, long }) } catch (e) {
        // cut by what is left of the check's bytes, not by the page limit: the pages read are kept
        if (page > 0 && cap < MCP_LIST_MAX_BYTES && e instanceof NetError && e.reason === 'too_large') break
        throw e
      }
      const list = Array.isArray(r?.tools) ? r!.tools : null
      if (!list) throw new McpError('not_mcp')
      const hide = this.hider()
      for (const t of list) {
        cut = null
        const tool = toolOf(t, hide, note)
        if (!tool || seen.has(tool.name)) continue
        seen.add(tool.name)
        if (full) continue
        const cost = JSON.stringify(tool.inputSchema).length + tool.description.length
        if (tools.length >= MAX_TOOLS || size + cost > MAX_SCHEMAS_CHARS) { full = true; continue }
        size += cost
        tools.push(tool)
        const c = cut as { name: string; chars: number } | null
        if (c && c.name === tool.name) oversized.shortened.set(c.name, c.chars)
      }
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined
      // the list kept is full: the pages after this one would only be counted
      if (!cursor || full || tools.length >= MAX_TOOLS) break
    }
    // a name left out on one page and kept on another (a duplicate) was not lost
    for (const n of seen) oversized.dropped.delete(n)
    const list = (m: Map<string, number>) => [...m].map(([name, chars]) => ({ name, chars }))
    return { tools, more: full || !!cursor, total: seen.size, unread: !!cursor, shortened: list(oversized.shortened), dropped: list(oversized.dropped) }
  }

  /** One tools/call: MCP_CALL_IDLE_MS without a byte, MCP_CALL_TIMEOUT_MS in all (the session's start keeps its 30 s).
   * Its own id is the progressToken, so a service that reports progress keeps the call alive. Stopped by `signal` (Stop,
   * the turn's end) or by those limits: the request is closed and the service told, as MCP asks (notifications/cancelled),
   * so it can stop its work too. */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<Record<string, any>> {
    await this.start(signal)
    const id = crypto.randomUUID()
    const deadline = Date.now() + (this.net.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS)
    const long = { deadline, idleMs: this.net.callIdleMs ?? MCP_CALL_IDLE_MS, reason: 'call_timeout' as const, idleReason: 'call_idle' as const }
    const params = { name, arguments: args && typeof args === 'object' ? args : {}, _meta: { progressToken: id } }
    try {
      return (await this.post({ jsonrpc: '2.0', id, method: 'tools/call', params }, { signal, maxBytes: MCP_CALL_MAX_BYTES, long })) ?? {}
    } catch (e) {
      // stopped here: the service may stop its work too (best effort, never waited for)
      if (signal?.aborted || (e instanceof NetError && (e.reason === 'call_idle' || e.reason === 'call_timeout'))) this.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: signal?.aborted ? 'stopped' : 'timed out' } }).catch(() => {})
      throw e
    }
  }
}

/** `p`, or list_timeout at `deadline` (a check stops waiting for a session another request started) */
function byDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NetError('list_timeout')), Math.max(0, deadline - Date.now())) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

const clean = (s: unknown, max: number, hide: Hide) => (typeof s === 'string' ? hide(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')

/** `s` cut to `max` characters, ending in SHORTENED when cut (never splitting a surrogate pair) */
export function cutWords(s: string, max: number): string {
  if (s.length <= max) return s
  let end = Math.max(0, max - SHORTENED.length)
  if (end > 0 && /[\ud800-\udbff]/.test(s[end - 1]!)) end--
  return s.slice(0, end).trimEnd() + SHORTENED
}

/** the keys whose value is data, not schema: their strings are never cut (a default or an allowed value must stay as
 * the service sent it) */
const VALUE_KEYS = new Set(['default', 'const', 'enum', 'examples', 'example'])
/** the keys whose value maps names to schemas: each name there is a property's (or definition's) own, never a keyword,
 * so a property called "example" or "description" is still walked as a schema */
const MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])

/** A copy of an input schema whose JSON is at most `max` characters, made by cutting its longest `description` strings
 * (at any depth, never inside a value) to one common length, the largest that fits; null when it cannot fit even with
 * every description cut (the rest of it is too large). Names, types, required and every other key are never changed. */
export function shrinkSchema(schema: Record<string, unknown>, max: number): Record<string, unknown> | null {
  const lengths: number[] = []
  // `map`: v maps names to schemas (MAP_KEYS), so its keys are names, not keywords
  const walk = (v: unknown, at: number | null, map = false): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, at))
    if (!v || typeof v !== 'object') return v
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (map) out[k] = walk(x, at)
      else if (VALUE_KEYS.has(k)) out[k] = x
      else if (k === 'description' && typeof x === 'string') { if (at === null) lengths.push(x.length); out[k] = at === null ? x : cutWords(x, at) }
      else out[k] = walk(x, at, MAP_KEYS.has(k) && !!x && typeof x === 'object' && !Array.isArray(x))
    }
    return out
  }
  const size = (at: number) => JSON.stringify(walk(schema, at)).length
  walk(schema, null)
  if (!lengths.length) return null
  // the shortest a cut description may be: the marker alone
  const floor = SHORTENED.length
  if (size(floor) > max) return null
  // the largest common length that fits (size grows with it)
  let lo = floor, hi = Math.max(...lengths)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (size(mid) <= max) lo = mid
    else hi = mid - 1
  }
  return walk(schema, lo) as Record<string, unknown>
}

/** One tools/list entry as we keep it, or null when it cannot be offered. The AI and the connection's users read it:
 * the secrets are hidden in its words and schema, and a tool whose name carries one is left out (the name calls it).
 * A schema over MAX_SCHEMA_CHARS is shortened (shrinkSchema) and `note` told; one that cannot be is left out, and
 * `note` told too, never silently. */
export function toolOf(t: unknown, hide: Hide = keep, note?: SizeNote): RemoteTool | null {
  if (!t || typeof t !== 'object') return null
  const x = t as Record<string, any>
  if (typeof x.name !== 'string' || !x.name || x.name.length > 128 || /[\u0000-\u001f]/.test(x.name) || hide(x.name) !== x.name) return null
  const schema = x.inputSchema
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') return null
  let json: string
  try { json = JSON.stringify(hideDeep(schema, hide)) } catch { return null }
  if (json.length > MAX_SCHEMA_CHARS) {
    const small = shrinkSchema(JSON.parse(json), MAX_SCHEMA_CHARS)
    note?.(x.name, json.length, !!small)
    if (!small) return null
    json = JSON.stringify(small)
  }
  const title = clean(x.title ?? x.annotations?.title, 200, hide) || null
  // readOnly is the remote server's own readOnlyHint (not checked here), never with destructiveHint (a tool that says
  // both is taken as a change; QA TC-4900): it decides the room card and, for a scheduled run's result, whether a failed
  // call is a look-up (chat/schedule-outcome.ts). It never hides a refused change of our own tools. In a shared chat
  // the name must agree too (read-mark.ts)
  return { name: x.name, title, description: cutWords(clean(x.description, Infinity, hide), MAX_DESCRIPTION), readOnly: x.annotations?.readOnlyHint === true && x.annotations?.destructiveHint !== true, inputSchema: JSON.parse(json), ...(x.annotations?.readOnlyHint !== true && x.annotations?.destructiveHint === false ? { nonDestructive: true as const } : {}) }
}
