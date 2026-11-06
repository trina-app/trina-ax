// The "api" engine: the app's own small agent loop inside the server, for any model behind an OpenAI-compatible
// Chat Completions API (OpenAI, Google Gemini's OpenAI endpoint, OpenRouter, a local Ollama / LM Studio …).
// Unlike Claude Code and the Codex CLI it is not a program the server has to lock down: it never had a shell or file
// access, it can only call the turn's MCP tools, through the same handler the gate uses for the other engines
// (mcp/protocol.ts makeHandler: person reloaded per call, audit, per-turn limits, the wider-audience check). The team's
// API key stays in the server (<data>/secrets/api-engine.key); only the model's provider sees the conversation, as with
// the other engines.
//
// Settings: <data>/engine-api.json { "baseUrl": "https://api.openai.com/v1", "model": "gpt-4.1", "label": "GPT-4.1" }.
import fs from 'node:fs'
import path from 'node:path'
import type { EngineEvent } from '@mycel/shared'
import { apiEngineFetch } from '../system/egress'
import { claudeCost, claudePrice, openaiCost, openaiPrice } from '../credentials/prices'
import { LinkGuard } from './api-links'

/** `setBy: 'admin'`: the address was set by an admin, not the owner: it is checked to be a public address before every call
 * (system/egress.ts apiEngineFetch), as the address may name a private place through DNS or a redirect */
export interface ApiEngineConf { baseUrl: string; model: string; label: string; key: string | null; setBy?: 'admin' }

/**
 * Spend control per completion, for a key someone else pays for (the hosting service's trial credit,
 * credentials/hosted-chat.ts createTrialMeter). Completions of one run are sent one after another, so the meter holds
 * at most one at a time.
 */
export interface ApiMeter {
  /** just before a completion is sent, with what it may cost at most (its body's bytes, its max_tokens): the key to send
   * it with (read again for every completion), or null to send nothing and end the run (the meter has said why) */
  start(est: { bodyBytes: number; maxTokens: number }): { key: string } | null
  /** that completion is over: what it cost in dollars; 'none' when no answer came (refused, not reached: nothing to
   * count); 'unfinished' when an answer started but its cost never came (stopped, broken off, no price) */
  end(cost: number | 'none' | 'unfinished'): void
  /** the provider refused it (HTTP status, or the code of an error inside the stream; its text; the key it was sent
   * with): true when the meter takes it as its own (a used credit, a refused key) and has said so; the run then ends
   * without the provider error */
  refused(status: number, body: string, key: string): boolean
}

const MAX_STEPS = 30
const TOOL_OUTPUT_MAX = 30_000

/**
 * Added to the team instructions for this engine only. Models behind an OpenAI-compatible API made up preview and
 * Drive links and statistics that no tool gave (QA B-API-2, 2026-10-29). The server also removes team-file links that
 * no tool gave (engine/api-links.ts); this tells the model the rule so the answer stays readable.
 */
export const API_GROUNDING_RULES = [
  '## Grounded answers',
  '- Give a link to a team file only by copying it exactly from a make_file or share_file result (or from this conversation). Never build a link yourself and never invent hosts, preview, Drive or download links. To link a file you saved with write or another tool, call share_file first.',
  '- State facts, numbers and quotes only when a tool result, a file or the user gave them. If you do not know, say so plainly; do not guess statistics or sources.',
  '- If a tool returns an error, read it, fix the call and try again, or tell the user what went wrong. Do not say a step worked when its tool failed.',
].join('\n')

export function apiEngineConfPath(dataDir: string) { return path.join(dataDir, 'engine-api.json') }
export function apiEngineKeyPath(dataDir: string) { return path.join(dataDir, 'secrets', 'api-engine.key') }

/** scheme + host + port of an address; the text itself when it is not an address */
export function originOf(u: string): string { try { return new URL(u).origin } catch { return u } }
/** The whole address a key belongs to: scheme, host, port, path and query, without a trailing slash and without a
 * fragment. The path counts: a gateway serves many tenants under one host (`/v1/{account}/{gateway}/…`). */
export function addressOf(u: string): string {
  try { const x = new URL(u); return (x.origin + x.pathname.replace(/\/+$/, '') + x.search) } catch { return u.replace(/\/+$/, '') }
}

/**
 * The key file holds the key AND the whole address it was made for: {"key":"…","url":"https://host/v1/acct"}. A key is
 * only ever read back for that same address (readApiEngine), so no sequence of saves, however they interleave, can leave
 * another address, another path on the same host included, holding it. Older files are bound the first time they are
 * rewritten (writeApiEngine): a bare key, and {"key","origin"} from earlier builds of this change; until then they are
 * read for the address that is set (bare) or for that origin.
 */
interface StoredKey { key: string; url: string | null; origin: string | null }
function readKeyFile(dataDir: string): StoredKey | null {
  let raw: string
  try { raw = fs.readFileSync(apiEngineKeyPath(dataDir), 'utf8').trim() } catch { return null }
  if (!raw) return null
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as { key?: unknown; url?: unknown; origin?: unknown }
      if (typeof j.key !== 'string' || !j.key.trim()) return null
      if (typeof j.url === 'string') return { key: j.key.trim(), url: j.url, origin: null }
      if (typeof j.origin === 'string') return { key: j.key.trim(), url: null, origin: j.origin }
    } catch {}
    return null
  }
  return { key: raw, url: null, origin: null }
}

/** Is a key stored (whatever address it is for)? */
export function hasStoredApiKey(dataDir: string): boolean { return readKeyFile(dataDir) !== null }

/** The configured API engine, or null (not set up, or the file is broken). The key comes back only for the address it
 * was stored for: another address, or another path at the same host, gets `key: null`. */
export function readApiEngine(dataDir: string): ApiEngineConf | null {
  try {
    const j = JSON.parse(fs.readFileSync(apiEngineConfPath(dataDir), 'utf8')) as Partial<ApiEngineConf>
    if (typeof j.baseUrl !== 'string' || !/^https?:\/\//.test(j.baseUrl) || typeof j.model !== 'string' || !j.model) return null
    const stored = readKeyFile(dataDir)
    const ok = !!stored && (stored.url !== null ? stored.url === addressOf(j.baseUrl) : stored.origin !== null ? stored.origin === originOf(j.baseUrl) : true)
    return { baseUrl: j.baseUrl.replace(/\/+$/, ''), model: j.model, label: typeof j.label === 'string' && j.label.trim() ? j.label.trim().slice(0, 40) : j.model, key: ok ? stored!.key : null,
      ...((j as { setBy?: unknown }).setBy === 'admin' ? { setBy: 'admin' as const } : {}) }
  } catch { return null }
}

export function writeApiEngine(dataDir: string, c: { baseUrl: string; model: string; label?: string; key?: string | null; setBy?: 'owner' | 'admin' }) {
  const keyPath = apiEngineKeyPath(dataDir)
  const was = readApiEngine(dataDir)
  const stored = readKeyFile(dataDir)
  const put = (key: string, url: string) => { fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(keyPath, JSON.stringify({ key, url }), { mode: 0o600 }) }
  // The key file first, then the settings: if writing the key fails, the address has not moved, and an older key
  // (bare, or bound to an origin) is never left readable for a new one.
  if (c.key === null || c.key === '') fs.rmSync(keyPath, { force: true })
  else if (c.key !== undefined) put(c.key.trim(), addressOf(c.baseUrl))
  else if (stored && stored.url === null) {
    // an older key file: it belongs to the address that was set until now, and to no other
    if (was && was.key) put(stored.key, addressOf(was.baseUrl)); else fs.rmSync(keyPath, { force: true })
  }
  fs.writeFileSync(apiEngineConfPath(dataDir), JSON.stringify({ baseUrl: c.baseUrl, model: c.model, label: c.label ?? '', ...(c.setBy === 'admin' ? { setBy: 'admin' } : {}) }, null, 2), { mode: 0o600 })
}

type Rpc = (msg: unknown) => Promise<any>
interface ToolCall { id: string; name: string; args: string }
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** The key and any bearer token out of a provider text before it goes to the log (the person sees only our own text). */
export function redact(text: string, key: string | null): string {
  let out = key && key.length >= 4 ? text.split(key).join('[key]') : text
  out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[key]').replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[key]')
  return out
}

/** "model not found" as OpenAI, OpenRouter, Gemini, Ollama and LM Studio say it (not "model does not support tools") */
const MODEL_MISSING = /model_not_found|no such model|(invalid|unknown) model\b|not a valid model|model\b[^\n]{0,120}?\b(not[ _-]?found|does not exist|is not available|is not a valid)/i

/**
 * A provider's refusal -> the turn's error, by kind: auth (401/403), rate_limit (429), context (too long),
 * model_not_found, endpoint_unreachable (404 without a model word: the address is wrong), provider_error (anything
 * else, with its status). `status` 0 = no HTTP status (an error inside the stream). The message is for the log only.
 */
export function errorOf(status: number, body: string, key: string | null = null): Extract<EngineEvent, { type: 'error' }> {
  const text = redact(body.slice(0, 300), key)
  const st = status > 0 ? { status } : {}
  const message = status > 0 ? `HTTP ${status}: ${text}` : text
  if (status === 401 || status === 403) return { type: 'error', code: 'auth', message, ...st }
  if (status === 429) return { type: 'error', code: 'rate_limit', message, ...st }
  if ((status === 400 || status === 413 || status === 0) && /context|too long|maximum.*tokens|token limit/i.test(body)) return { type: 'error', code: 'context', message, ...st }
  if (MODEL_MISSING.test(body)) return { type: 'error', code: 'model_not_found', message, ...st }
  if (status === 404) return { type: 'error', code: 'endpoint_unreachable', message, ...st }
  return { type: 'error', code: 'provider_error', message, ...st }
}

/** The list price of a model the price table knows (credentials/prices.ts), else null: "vendor/model" (OpenRouter)
 * is looked up without the vendor, and Claude's "4.5" spelling as "4-5". Never the table's most-expensive fallback. */
export function listPriceCost(model: string, u: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }): number | null {
  const bare = model.replace(/^[^/]+\//, '').replace(/:[a-z]+$/, '')
  const input = u.prompt_tokens ?? 0
  const output = u.completion_tokens ?? 0
  if (openaiPrice(bare)) return openaiCost(bare, { input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 } })
  const claude = bare.startsWith('claude-') ? bare.replace(/(\d)\.(\d)/g, '$1-$2') : bare
  if (claudePrice(claude)) {
    const cached = Math.min(input, u.prompt_tokens_details?.cached_tokens ?? 0)
    return claudeCost(claude, { input_tokens: input - cached, cache_read_input_tokens: cached, output_tokens: output })
  }
  return null
}

/** The usage event of one completion: the provider's own cost (OpenRouter usage.cost) first, else the list price,
 * else tokens only with costUnknown (an unknown price is never recorded as free). */
export function usageEvent(model: string, u: any, requestId: string | undefined): Extract<EngineEvent, { type: 'usage' }> {
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)
  const base = { type: 'usage' as const, inputTokens: n(u?.prompt_tokens), outputTokens: n(u?.completion_tokens), ...(requestId ? { requestId } : {}) }
  if (typeof u?.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0) return { ...base, costUsd: u.cost }
  const listed = listPriceCost(model, u ?? {})
  return listed === null ? { ...base, costUnknown: true } : { ...base, costUsd: listed }
}

/** How long a provider may take to start answering (response headers); the stream itself has no limit here. */
export const HEADERS_TIMEOUT_MS = 90_000

interface Send { fetchFn: typeof fetch; headersTimeoutMs: number; guard: LinkGuard; meter?: ApiMeter; maxTokens?: number }
/** One streamed completion: text deltas out as events; returns the tool calls and whether the model stopped. */
async function complete(conf: ApiEngineConf, messages: ChatMessage[], tools: unknown[], emit: (e: EngineEvent) => void, signal: AbortSignal, o: Send): Promise<{ text: string; calls: ToolCall[] } | null> {
  const { guard } = o
  // the text the guard still holds goes out at the end of every completion (normal end, error or abort)
  try { return await metered(conf, messages, tools, emit, signal, o) } finally {
    const rest = guard.flush()
    if (rest) emit({ type: 'text', delta: rest })
  }
}

/** One completion with its meter, if any: started (or refused) before it is sent, ended once whatever happens. */
async function metered(conf: ApiEngineConf, messages: ChatMessage[], tools: unknown[], emit: (e: EngineEvent) => void, signal: AbortSignal, o: Send): Promise<{ text: string; calls: ToolCall[] } | null> {
  // OpenRouter reports the request's cost in the usage only when asked (other providers refuse unknown fields)
  const openrouter = /^https:\/\/openrouter\.ai\//.test(conf.baseUrl + '/')
  const body = JSON.stringify({ model: conf.model, messages, tools: tools.length ? tools : undefined, stream: true, stream_options: { include_usage: true }, ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}), ...(openrouter ? { usage: { include: true } } : {}) })
  if (!o.meter) return stream(conf, conf.key, body, emit, signal, o, { cost: 'none' })
  const m = o.meter.start({ bodyBytes: Buffer.byteLength(body), maxTokens: o.maxTokens ?? 0 })
  if (!m) return null
  const spent: { cost: number | 'none' | 'unfinished' } = { cost: 'none' }
  try { return await stream(conf, m.key, body, emit, signal, o, spent) } finally { o.meter.end(spent.cost) }
}

async function stream(conf: ApiEngineConf, key: string | null, body: string, emit: (e: EngineEvent) => void, signal: AbortSignal, o: Send, spent: { cost: number | 'none' | 'unfinished' }): Promise<{ text: string; calls: ToolCall[] } | null> {
  const { fetchFn, headersTimeoutMs, guard, meter } = o
  // an address that never answers fails after headersTimeoutMs instead of at the turn's time limit
  const hdr = new AbortController()
  const timer = setTimeout(() => hdr.abort(new Error(`no answer within ${Math.round(headersTimeoutMs / 1000)} s`)), headersTimeoutMs)
  let res: Response
  try {
    res = await fetchFn(`${conf.baseUrl}/chat/completions`, {
      method: 'POST', signal: AbortSignal.any([signal, hdr.signal]),
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body,
    })
  } finally { clearTimeout(timer) }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    if (key && meter?.refused(res.status, text, key)) return null
    emit(errorOf(res.status, text, key))
    return null
  }
  // an answer started: from here on it costs something even if it never finishes
  spent.cost = 'unfinished'
  let text = ''
  const calls: ToolCall[] = []
  const dec = new TextDecoder()
  let buf = ''
  // one usage per completion: some providers repeat the (cumulative) usage on several chunks
  let usage: unknown = null
  let requestId: string | undefined
  // why the model stopped ("stop", "tool_calls", "length" …)
  let finish: string | undefined
  // the completion's usage goes out as an event; its cost is what the meter counts (none known: its reservation)
  const counted = (ev: Extract<EngineEvent, { type: 'usage' }>) => { emit(ev); spent.cost = ev.costUsd ?? 'unfinished' }
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let j: any
      try { j = JSON.parse(data) } catch { continue }
      if (j.error) {
        if (usage) counted(usageEvent(conf.model, usage, requestId))
        const code = typeof j.error.code === 'number' ? j.error.code : 0
        if (key && meter?.refused(code, JSON.stringify(j.error), key)) return null
        emit(errorOf(code, JSON.stringify(j.error), key))
        return null
      }
      if (typeof j.id === 'string' && j.id && !requestId) requestId = j.id.slice(0, 120)
      if (j.usage) usage = j.usage
      if (typeof j.choices?.[0]?.finish_reason === 'string') finish = j.choices[0].finish_reason
      const d = j.choices?.[0]?.delta
      if (!d) continue
      if (typeof d.content === 'string' && d.content) {
        text += d.content
        const shown = guard.push(d.content)
        if (shown) emit({ type: 'text', delta: shown })
      }
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : calls.length
        const c = (calls[i] ??= { id: '', name: '', args: '' })
        if (tc.id) c.id = tc.id
        if (tc.function?.name) c.name += tc.function.name
        if (tc.function?.arguments) c.args += tc.function.arguments
      }
    }
  }
  if (usage) counted(usageEvent(conf.model, usage, requestId))
  // the model stopped at its output limit (max_tokens): the answer is cut off, and a tool call in it may be too (its
  // arguments half written). Nothing more is sent: another round would cost again and could only repeat the cut
  if (finish === 'length') {
    emit({ type: 'error', code: 'output_limit', message: 'the model stopped at its output limit (finish_reason length)' })
    return null
  }
  // the instructions name the tools mcp__team__<name> (the other engines' spelling): the handler knows <name>
  return { text, calls: calls.filter(Boolean).map((c, i) => ({ ...c, name: c.name.replace(/^mcp__team__/, ''), id: c.id || `call_${i}_${Date.now()}` })) }
}

/** What the model gets back for one tool call: the output, and the team links in it named once more at the end. */
function toolContent(out: string, links: string[]): string {
  const text = out.slice(0, TOOL_OUTPUT_MAX) || '(no output)'
  if (!links.length) return text
  return `${text}\n\nLinks for the user from this result (copy them exactly; there are no other links to these files):\n${links.slice(0, 20).map((l) => `- ${l}`).join('\n')}`
}

/**
 * Run one turn: system prompt + the message, the turn's tools offered as functions, tool calls answered through `rpc`
 * (the MCP handler), until the model answers without tools (or 30 rounds: then a 'limit' event). Events go to `emit`
 * like a parsed engine's.
 * A failed tool call (error result, bad arguments, or a handler that throws) goes back to the model as the tool's
 * answer and the loop goes on, so the model can correct the call (QA B-API-1). Team-file links in the answer must
 * come from a tool result, the instructions or the message (engine/api-links.ts); `publicOrigins` are this server's
 * own addresses, so absolute links to them are checked too.
 */
export async function runApiAgent(o: { conf: ApiEngineConf; systemPrompt: string; message: string; rpc: Rpc; emit: (e: EngineEvent) => void; signal: AbortSignal; fetchFn?: typeof fetch; maxSteps?: number; headersTimeoutMs?: number; publicOrigins?: readonly string[]
  /** spend control per completion (ApiMeter); `maxTokens`: sent as max_tokens (none: the provider's default) */
  meter?: ApiMeter; maxTokens?: number }): Promise<void> {
  // the hosted cloud: every call's address is checked first (public https only, system/egress.ts)
  const fetchFn = apiEngineFetch(o.fetchFn ?? fetch, { publicCheck: o.conf.setBy === 'admin' })
  const listed = await o.rpc({ jsonrpc: '2.0', id: 'l', method: 'tools/list', params: {} })
  const tools = (listed?.result?.tools ?? []).map((t: { name: string; description: string; inputSchema: unknown }) => ({ type: 'function', function: { name: t.name, description: t.description.slice(0, 1024), parameters: t.inputSchema } }))
  const systemPrompt = `${o.systemPrompt}\n\n${API_GROUNDING_RULES}`
  const guard = new LinkGuard(o.publicOrigins)
  // links that earlier answers of this chat showed (history in the instructions or the message) stay allowed
  guard.allow(o.systemPrompt)
  guard.allow(o.message)
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, { role: 'user', content: o.message }]
  for (let step = 0; step < (o.maxSteps ?? MAX_STEPS); step++) {
    if (o.signal.aborted) return
    let r: Awaited<ReturnType<typeof complete>>
    try { r = await complete(o.conf, messages, tools, o.emit, o.signal, { fetchFn, headersTimeoutMs: o.headersTimeoutMs ?? HEADERS_TIMEOUT_MS, guard, meter: o.meter, maxTokens: o.maxTokens }) } catch (e) {
      if (o.signal.aborted) return
      // refused connection, unknown host, no answer in time, a cut stream, an address the cloud does not allow
      const why = (e as Error)?.cause instanceof Error ? `${(e as Error).message}: ${((e as Error).cause as Error).message}` : String((e as Error)?.message ?? e)
      o.emit({ type: 'error', code: 'endpoint_unreachable', message: `the model API could not be reached: ${redact(why, o.conf.key).slice(0, 200)}` })
      return
    }
    if (!r) return
    if (!r.calls.length) { o.emit({ type: 'done' }); return }
    messages.push({ role: 'assistant', content: r.text || null, tool_calls: r.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) })
    for (const c of r.calls) {
      let args: unknown = {}
      try { args = c.args ? JSON.parse(c.args) : {} } catch { args = null }
      o.emit({ type: 'tool_start', id: c.id, name: c.name, summary: c.name, input: args ?? {} })
      let out = ''
      let ok = false
      if (args === null) out = 'Error: the arguments were not valid JSON'
      else {
        try {
          const res = await o.rpc({ jsonrpc: '2.0', id: c.id, method: 'tools/call', params: { name: c.name, arguments: args } })
          out = (res?.result?.content ?? []).map((x: { text?: string }) => x.text ?? '').join('\n') || (res?.error ? `Error: ${res.error.message}` : '')
          ok = !res?.result?.isError && !res?.error
        } catch (e) {
          out = `Error: the tool failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`
        }
      }
      o.emit({ type: 'tool_end', id: c.id, ok, output: out.slice(0, 4000) })
      messages.push({ role: 'tool', tool_call_id: c.id, content: toolContent(out, guard.allow(out)) })
      if (o.signal.aborted) return
    }
  }
  // the per-answer limit of tool rounds: the turn records it (stopReason 'tool_limit') and the chat offers "continue"
  o.emit({ type: 'limit', kind: 'turns' })
  o.emit({ type: 'done' })
}
