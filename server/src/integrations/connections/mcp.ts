// A small MCP client over Streamable HTTP (no SDK): JSON-RPC POSTs that accept JSON or an event stream, the server's
// Mcp-Session-Id kept for the session, MCP-Protocol-Version on every request after initialize.
// initialize -> notifications/initialized -> tools/list (cursor pages) -> tools/call. The server's words that are cut
// here (an error message, tool descriptions) have the connection's secrets hidden first (hide.ts).
import crypto from 'node:crypto'
import { INTEGRATION_TOOLS_MAX } from '@mycel/shared/api'
import { hideDeep } from './hide'
import { NetError, serviceRequest, type NetOptions } from './net'

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
const KNOWN_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])
/** tools kept per connection: every tool a service lists, up to this hard ceiling (docs/DECISIONS.md "Connection
 * tools: deferred, found and called"). A turn offers what fits its budget as tools and the rest through find_tools /
 * call_tool (tools.ts), so a big catalog no longer goes to the engine whole with every turn. */
export const MAX_TOOLS = INTEGRATION_TOOLS_MAX
/** one tool's input schema */
const MAX_SCHEMA_CHARS = 32_000
/** all kept input schemas and descriptions of one connection together (what tools_json holds; Higgsfield's is about
 * 1.07 million characters) */
export const MAX_SCHEMAS_CHARS = 4_000_000
const MAX_DESCRIPTION = 1000

export class McpError extends Error {
  name = 'McpError'
  /** unauthorized: 401 (wwwAuthenticate: its header); forbidden: 403; session_gone: 404 for our session; rpc: a
   * JSON-RPC error (message: the server's, cut); not_mcp: an answer that is not MCP */
  constructor(readonly code: 'unauthorized' | 'forbidden' | 'session_gone' | 'rpc' | 'not_mcp' | 'http', readonly status = 0, readonly detail = '') { super(code) }
}

export interface RemoteTool { name: string; title: string | null; description: string; readOnly: boolean; inputSchema: Record<string, unknown> }

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

export class McpClient {
  sessionId: string | null = null
  version: string | null = null
  private ready: Promise<void> | null = null
  usedAt = Date.now()

  /** `hider` makes the function that hides the connection's secrets, when an answer is in (a refresh may have rotated them) */
  constructor(readonly url: string, private auth: () => Promise<[string, string][]>, private net: NetOptions, private hider: () => Hide = () => keep) {}

  /** `read`: the answer's bytes are added to it (also when it is cut) */
  private async post(message: Record<string, unknown>, signal?: AbortSignal, maxBytes?: number, read?: { bytes: number }): Promise<Record<string, any> | null> {
    const id = typeof message.id === 'string' ? message.id : null
    const headers: [string, string][] = [['Content-Type', 'application/json'], ['Accept', 'application/json, text/event-stream'], ...(await this.auth())]
    if (this.version) headers.push(['MCP-Protocol-Version', this.version])
    if (this.sessionId) headers.push(['Mcp-Session-Id', this.sessionId])
    const res = await serviceRequest(this.url, {
      method: 'POST', headers, body: Buffer.from(JSON.stringify(message)), signal, ...(maxBytes ? { maxBytes } : {}),
      // an event stream may stay open after our reply: stop reading once it is in
      until: id ? (body, head) => /text\/event-stream/i.test(head.headers['content-type'] ?? '') && !!findReply(sseEvents(body.toString('utf8')).map(parse), id) : undefined,
    }, this.net)
    this.usedAt = Date.now()
    if (read) read.bytes += res.body.length
    if (res.status === 401) throw new McpError('unauthorized', 401, res.headers['www-authenticate'] ?? '')
    if (res.status === 403) throw new McpError('forbidden', 403)
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

  private request(method: string, params: Record<string, unknown>, signal?: AbortSignal, maxBytes?: number, read?: { bytes: number }) {
    return this.post({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }, signal, maxBytes, read)
  }

  /** initialize + notifications/initialized, once per session */
  start(signal?: AbortSignal): Promise<void> {
    this.ready ??= (async () => {
      const r = await this.request('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'team-integrations', version: '1.0' } }, signal)
      const v = typeof r?.protocolVersion === 'string' ? r.protocolVersion : ''
      if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new McpError('not_mcp')
      this.version = KNOWN_VERSIONS.has(v) ? v : MCP_PROTOCOL
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal)
    })().catch((e) => { this.ready = null; this.sessionId = null; this.version = null; throw e })
    return this.ready
  }

  /** the pages of tools/list; tools without a usable input schema are left out; at most MAX_TOOLS (and
   * MAX_SCHEMAS_CHARS) kept. Reading stops once the list kept is full, after MCP_LIST_MAX_PAGES pages, or at
   * MCP_LIST_TOTAL_BYTES (a later page that does not fit in what is left is not read whole, and the pages before it are
   * kept). `total`: how many usable tools the pages read listed (counted on past the ceiling within a page, so people
   * and the AI can be told "1,000 of 1,200"); `more`: some were not kept, or pages were left unread; `unread`: pages
   * were left unread, so the service offers more than `total` ("1,000 of more than 1,000"). */
  async listTools(signal?: AbortSignal): Promise<{ tools: RemoteTool[]; more: boolean; total: number; unread: boolean }> {
    await this.start(signal)
    const tools: RemoteTool[] = []
    const seen = new Set<string>()
    const read = { bytes: 0 }
    let cursor: string | undefined
    let full = false
    let size = 0
    for (let page = 0; page < MCP_LIST_MAX_PAGES; page++) {
      const room = MCP_LIST_TOTAL_BYTES - read.bytes
      if (room <= 0) break
      const cap = Math.min(MCP_LIST_MAX_BYTES, room)
      let r: Record<string, any> | null
      try { r = await this.request('tools/list', cursor ? { cursor } : {}, signal, cap, read) } catch (e) {
        // cut by what is left of the check's bytes, not by the page limit: the pages read are kept
        if (page > 0 && cap < MCP_LIST_MAX_BYTES && e instanceof NetError && e.reason === 'too_large') break
        throw e
      }
      const list = Array.isArray(r?.tools) ? r!.tools : null
      if (!list) throw new McpError('not_mcp')
      const hide = this.hider()
      for (const t of list) {
        const tool = toolOf(t, hide)
        if (!tool || seen.has(tool.name)) continue
        seen.add(tool.name)
        if (full) continue
        const cost = JSON.stringify(tool.inputSchema).length + tool.description.length
        if (tools.length >= MAX_TOOLS || size + cost > MAX_SCHEMAS_CHARS) { full = true; continue }
        size += cost
        tools.push(tool)
      }
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined
      // the list kept is full: the pages after this one would only be counted
      if (!cursor || full || tools.length >= MAX_TOOLS) break
    }
    return { tools, more: full || !!cursor, total: seen.size, unread: !!cursor }
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<Record<string, any>> {
    await this.start(signal)
    return (await this.request('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }, signal, MCP_CALL_MAX_BYTES)) ?? {}
  }
}

const clean = (s: unknown, max: number, hide: Hide) => (typeof s === 'string' ? hide(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')

/** One tools/list entry as we keep it, or null when it cannot be offered. The AI and the connection's users read it:
 * the secrets are hidden in its words and schema, and a tool whose name carries one is left out (the name calls it). */
export function toolOf(t: unknown, hide: Hide = keep): RemoteTool | null {
  if (!t || typeof t !== 'object') return null
  const x = t as Record<string, any>
  if (typeof x.name !== 'string' || !x.name || x.name.length > 128 || /[\u0000-\u001f]/.test(x.name) || hide(x.name) !== x.name) return null
  const schema = x.inputSchema
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') return null
  let json: string
  try { json = JSON.stringify(hideDeep(schema, hide)) } catch { return null }
  if (json.length > MAX_SCHEMA_CHARS) return null
  const title = clean(x.title ?? x.annotations?.title, 200, hide) || null
  return { name: x.name, title, description: clean(x.description, MAX_DESCRIPTION, hide), readOnly: x.annotations?.readOnlyHint === true, inputSchema: JSON.parse(json) }
}
