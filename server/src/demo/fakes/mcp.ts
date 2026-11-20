// A small MCP server in this process for the demo's fakes (Gmail behind google-apps/transport.ts, Higgsfield behind
// connections/net.ts): JSON answers to initialize, tools/list and tools/call, 202 to notifications. It answers the
// NetRequest the connection code would have sent over the network, so everything above it (tool lists, cards,
// external-data marks, media) runs exactly as with the real service.
import type { NetRequest, NetResponse } from '../../integrations/connections/net'

export interface McpContent { type: 'text'; text: string }
export interface McpImage { type: 'image'; data: string; mimeType: string }
export interface McpResult { content: (McpContent | McpImage)[]; isError?: boolean }

export interface FakeTool {
  name: string
  title: string
  description: string
  readOnly: boolean
  inputSchema: Record<string, unknown>
  call: (args: Record<string, any>) => McpResult | Promise<McpResult>
}

export const text = (t: string, isError = false): McpResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

const json = (status: number, body: unknown, headers: Record<string, string> = {}): NetResponse =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body)), truncated: false })

/**
 * One request to the fake MCP server `name`. `needsAuth`: a request without a Bearer token gets 401 (Gmail; the real
 * library checks every call's token).
 */
export async function answerMcp(name: string, tools: readonly FakeTool[], r: NetRequest, o: { needsAuth?: boolean; unavailable?: (tool: string) => string } = {}): Promise<NetResponse> {
  if (r.method !== 'POST') return json(405, { error: 'method not allowed' })
  if (o.needsAuth && !r.headers.some(([k, v]) => k.toLowerCase() === 'authorization' && /^Bearer \S+$/.test(v))) return json(401, { error: 'unauthorized' })
  let msg: { id?: unknown; method?: unknown; params?: any }
  try { msg = JSON.parse(r.body?.toString('utf8') ?? '') } catch { return json(400, { error: 'not JSON' }) }
  if (msg.id === undefined || msg.id === null) return { status: 202, headers: {}, body: Buffer.alloc(0), truncated: false }
  const reply = (result: unknown) => json(200, { jsonrpc: '2.0', id: msg.id, result }, { 'mcp-session-id': `demo-${name}` })
  if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `demo-${name}`, version: '1' } })
  if (msg.method === 'tools/list') {
    return reply({
      tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: t.readOnly, ...(t.readOnly ? {} : { destructiveHint: false }) } })),
    })
  }
  if (msg.method === 'tools/call') {
    const toolName = String(msg.params?.name ?? '')
    const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments as Record<string, any> : {}
    const t = tools.find((x) => x.name === toolName)
    if (!t) return reply(text(o.unavailable?.(toolName) ?? `${toolName} isn't available in the demo.`, true))
    try { return reply(await t.call(args)) } catch (e) { return reply(text(`${toolName} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, true)) }
  }
  return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
}

/** a string argument, trimmed and cut */
export const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
/** a list of strings from an array or one comma-separated string */
export const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 100)
