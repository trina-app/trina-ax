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

export interface ApiEngineConf { baseUrl: string; model: string; label: string; key: string | null }

const MAX_STEPS = 30
const TOOL_OUTPUT_MAX = 30_000

export function apiEngineConfPath(dataDir: string) { return path.join(dataDir, 'engine-api.json') }
export function apiEngineKeyPath(dataDir: string) { return path.join(dataDir, 'secrets', 'api-engine.key') }

/** The configured API engine, or null (not set up, or the file is broken). */
export function readApiEngine(dataDir: string): ApiEngineConf | null {
  try {
    const j = JSON.parse(fs.readFileSync(apiEngineConfPath(dataDir), 'utf8')) as Partial<ApiEngineConf>
    if (typeof j.baseUrl !== 'string' || !/^https?:\/\//.test(j.baseUrl) || typeof j.model !== 'string' || !j.model) return null
    let key: string | null = null
    try { key = fs.readFileSync(apiEngineKeyPath(dataDir), 'utf8').trim() || null } catch {}
    return { baseUrl: j.baseUrl.replace(/\/+$/, ''), model: j.model, label: typeof j.label === 'string' && j.label.trim() ? j.label.trim().slice(0, 40) : j.model, key }
  } catch { return null }
}

export function writeApiEngine(dataDir: string, c: { baseUrl: string; model: string; label?: string; key?: string | null }) {
  fs.writeFileSync(apiEngineConfPath(dataDir), JSON.stringify({ baseUrl: c.baseUrl, model: c.model, label: c.label ?? '' }, null, 2), { mode: 0o600 })
  if (c.key !== undefined) {
    const p = apiEngineKeyPath(dataDir)
    if (c.key === null || c.key === '') fs.rmSync(p, { force: true })
    else { fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }); fs.writeFileSync(p, c.key.trim(), { mode: 0o600 }) }
  }
}

type Rpc = (msg: unknown) => Promise<any>
interface ToolCall { id: string; name: string; args: string }
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string }

function errorOf(status: number, body: string): EngineEvent {
  const text = body.slice(0, 300)
  if (status === 401 || status === 403) return { type: 'error', code: 'auth', message: `HTTP ${status}: ${text}` }
  if (status === 429) return { type: 'error', code: 'rate_limit', message: text }
  if (status === 400 && /context|too long|maximum.*tokens|token limit/i.test(body)) return { type: 'error', code: 'context', message: text }
  return { type: 'error', code: 'crash', message: `HTTP ${status}: ${text}` }
}

/** One streamed completion: text deltas out as events; returns the tool calls and whether the model stopped. */
async function complete(conf: ApiEngineConf, messages: ChatMessage[], tools: unknown[], emit: (e: EngineEvent) => void, signal: AbortSignal, fetchFn: typeof fetch): Promise<{ text: string; calls: ToolCall[] } | null> {
  const res = await fetchFn(`${conf.baseUrl}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(conf.key ? { Authorization: `Bearer ${conf.key}` } : {}) },
    body: JSON.stringify({ model: conf.model, messages, tools: tools.length ? tools : undefined, stream: true, stream_options: { include_usage: true } }),
  })
  if (!res.ok || !res.body) { emit(errorOf(res.status, await res.text().catch(() => ''))); return null }
  let text = ''
  const calls: ToolCall[] = []
  const dec = new TextDecoder()
  let buf = ''
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
      if (j.error) { emit({ type: 'error', code: 'crash', message: JSON.stringify(j.error).slice(0, 300) }); return null }
      if (j.usage) emit({ type: 'usage', inputTokens: j.usage.prompt_tokens ?? 0, outputTokens: j.usage.completion_tokens ?? 0 })
      const d = j.choices?.[0]?.delta
      if (!d) continue
      if (typeof d.content === 'string' && d.content) { text += d.content; emit({ type: 'text', delta: d.content }) }
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : calls.length
        const c = (calls[i] ??= { id: '', name: '', args: '' })
        if (tc.id) c.id = tc.id
        if (tc.function?.name) c.name += tc.function.name
        if (tc.function?.arguments) c.args += tc.function.arguments
      }
    }
  }
  // the instructions name the tools mcp__team__<name> (the other engines' spelling): the handler knows <name>
  return { text, calls: calls.filter(Boolean).map((c, i) => ({ ...c, name: c.name.replace(/^mcp__team__/, ''), id: c.id || `call_${i}_${Date.now()}` })) }
}

/**
 * Run one turn: system prompt + the message, the turn's tools offered as functions, tool calls answered through `rpc`
 * (the MCP handler), until the model answers without tools (or 30 rounds). Events go to `emit` like a parsed engine's.
 */
export async function runApiAgent(o: { conf: ApiEngineConf; systemPrompt: string; message: string; rpc: Rpc; emit: (e: EngineEvent) => void; signal: AbortSignal; fetchFn?: typeof fetch; maxSteps?: number }): Promise<void> {
  const fetchFn = o.fetchFn ?? fetch
  const listed = await o.rpc({ jsonrpc: '2.0', id: 'l', method: 'tools/list', params: {} })
  const tools = (listed?.result?.tools ?? []).map((t: { name: string; description: string; inputSchema: unknown }) => ({ type: 'function', function: { name: t.name, description: t.description.slice(0, 1024), parameters: t.inputSchema } }))
  const messages: ChatMessage[] = [{ role: 'system', content: o.systemPrompt }, { role: 'user', content: o.message }]
  for (let step = 0; step < (o.maxSteps ?? MAX_STEPS); step++) {
    if (o.signal.aborted) return
    let r: Awaited<ReturnType<typeof complete>>
    try { r = await complete(o.conf, messages, tools, o.emit, o.signal, fetchFn) } catch (e) {
      if (o.signal.aborted) return
      o.emit({ type: 'error', code: 'crash', message: `the model API could not be reached: ${String((e as Error)?.message ?? e).slice(0, 200)}` })
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
        const res = await o.rpc({ jsonrpc: '2.0', id: c.id, method: 'tools/call', params: { name: c.name, arguments: args } })
        out = (res?.result?.content ?? []).map((x: { text?: string }) => x.text ?? '').join('\n') || (res?.error ? `Error: ${res.error.message}` : '')
        ok = !res?.result?.isError && !res?.error
      }
      o.emit({ type: 'tool_end', id: c.id, ok, output: out.slice(0, 4000) })
      messages.push({ role: 'tool', tool_call_id: c.id, content: out.slice(0, TOOL_OUTPUT_MAX) })
      if (o.signal.aborted) return
    }
  }
  o.emit({ type: 'text', delta: '\n\n(Stopped after 30 tool rounds.)' })
  o.emit({ type: 'done' })
}
