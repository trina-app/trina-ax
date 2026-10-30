// Claude Code `--output-format stream-json --verbose --include-partial-messages` -> EngineEvent
// (ideas from Saram run.ts: text from stream_event deltas, tool steps from assistant messages, errors from result).
import type { AgentStats, EngineEvent, EngineErrorCode } from '@mycel/shared'

export function classifyError(msg: string): EngineErrorCode {
  const m = msg.toLowerCase()
  if (/not logged in|authentication|invalid api key|401|unauthorized|oauth/.test(m)) return 'auth'
  if (/rate.?limit|429|overloaded|usage limit|quota/.test(m)) return 'rate_limit'
  if (/prompt is too long|context|too many tokens/.test(m)) return 'context'
  if (/refus/.test(m)) return 'refused'
  if (/timed? ?out|timeout/.test(m)) return 'timeout'
  return 'crash'
}

/** tool results kept for step details / search cards (the full result stays in the engine session) */
export const TOOL_OUTPUT_MAX = 20_000
export function toolResultText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x: any) => (x?.type === 'text' && typeof x.text === 'string' ? x.text : '')).filter(Boolean).join('\n')
  return ''
}

/** A list of search hits as sources: http(s) addresses only, each once, title and address clipped, at most 50. */
export function hitList(list: unknown): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = []
  const seen = new Set<string>()
  if (!Array.isArray(list)) return out
  for (const x of list as { title?: unknown; url?: unknown }[]) {
    if (out.length >= 50) break
    if (typeof x?.url === 'string' && /^https?:\/\//i.test(x.url) && !seen.has(x.url)) { seen.add(x.url); out.push({ title: String(x.title ?? x.url).slice(0, 300), url: x.url.slice(0, 2000) }) }
  }
  return out
}

/**
 * The hits of a Claude Code WebSearch call from its structured result (stream-json `tool_use_result`, the tool's Output
 * object: { query, results: (string | { tool_use_id, content: { title, url }[] })[] }). The objects are the search
 * server's web_search_tool_result blocks; the strings are what the search model wrote, which the AI steers through its
 * query, so they are never sources. undefined: not a web search result (the caller falls back to the text).
 */
export function webSearchHits(r: unknown): { title: string; url: string }[] | undefined {
  if (!r || typeof r !== 'object' || typeof (r as { query?: unknown }).query !== 'string' || !Array.isArray((r as { results?: unknown }).results)) return undefined
  const hits: unknown[] = []
  for (const x of (r as { results: unknown[] }).results) if (x && typeof x === 'object' && Array.isArray((x as { content?: unknown }).content)) hits.push(...(x as { content: unknown[] }).content)
  return hitList(hits)
}

/** what a sub-agent did, from Claude Code's AgentOutput (the Agent call's tool_use_result) or a task_progress /
 * task_notification usage; null when there is none (a failed child's result is a plain string) */
export function agentStats(v: unknown): AgentStats | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : undefined)
  const toolUses = n(o.totalToolUseCount ?? o.tool_uses), ms = n(o.totalDurationMs ?? o.duration_ms), tokens = n(o.totalTokens ?? o.total_tokens)
  if (toolUses === undefined && ms === undefined && tokens === undefined) return null
  return { ...(toolUses !== undefined ? { toolUses } : {}), ...(ms !== undefined ? { ms } : {}), ...(tokens !== undefined ? { tokens } : {}) }
}

/** the Agent tool (Task in the init event of 2.1.305) */
const isAgentTool = (name: unknown) => name === 'Agent' || name === 'Task'

export class ClaudeStreamParser {
  private sawDeltas = false
  private textOpen = false
  /** ids of the main AI's Agent calls (their tool results carry the sub-agent's totals) */
  private agentCalls = new Set<string>()
  sessionId: string | null = null
  init: any = null
  result: any = null
  refused = false
  /** the run ended at --max-turns (the per-answer limit of tool rounds): a 'limit' event, not an error */
  maxTurns = false
  text = ''
  push(line: string): EngineEvent[] {
    let ev: any
    try { ev = JSON.parse(line) } catch { return [] }
    const out: EngineEvent[] = []
    // a sub-agent's message (Claude Code parent_tool_use_id, docs/DECISIONS.md "Sub-agents"): only its tool calls and
    // their results become events (steps under its sub-task). Its text, thinking, refusal and API error flags never
    // reach the answer or the turn's outcome: a failed child comes back to the main AI as an error result of its
    // Agent call, and the main AI decides what to tell the person (review M2).
    const parent = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id ? ev.parent_tool_use_id as string : null
    if (ev.type === 'system' && ev.subtype === 'init') {
      this.init = ev
      if (ev.session_id) { this.sessionId = ev.session_id; out.push({ type: 'session', sessionId: ev.session_id }) }
      out.push({ type: 'init', tools: strings(ev.tools), agents: strings(ev.agents) })
    } else if (ev.type === 'system' && (ev.subtype === 'task_progress' || ev.subtype === 'task_notification')) {
      const stats = agentStats(ev.usage)
      if (typeof ev.tool_use_id === 'string' && stats) out.push({ type: 'agent_progress', id: ev.tool_use_id, stats })
    } else if (ev.type === 'stream_event') {
      if (parent) return out
      const e = ev.event ?? {}
      if (e.type === 'content_block_start' && e.content_block?.type === 'text') { this.textOpen = true; if (this.text && !this.text.endsWith('\n\n')) { this.text += '\n\n'; out.push({ type: 'text', delta: '\n\n' }) } }
      else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { this.sawDeltas = true; this.text += e.delta.text; out.push({ type: 'text', delta: e.delta.text }) }
      else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') out.push({ type: 'thinking', delta: e.delta.thinking ?? '' })
      else if (e.type === 'content_block_stop') this.textOpen = false
      else if (e.type === 'message_delta' && e.delta?.stop_reason === 'refusal') this.refused = true
    } else if (ev.type === 'assistant') {
      const msg = ev.message ?? {}
      if (parent) {
        for (const b of msg.content ?? []) if (b?.type === 'tool_use') out.push({ type: 'tool_start', id: b.id, name: b.name, summary: JSON.stringify(b.input ?? {}).slice(0, 300), input: b.input ?? {}, parentId: parent })
        return out
      }
      if (msg.stop_reason === 'refusal') this.refused = true
      // an API error (401, limit …) comes as a synthetic assistant message whose text is the raw error: it becomes the
      // turn's error below, never answer text
      const apiError = !!ev.error && ev.error !== 'refusal'
      for (const b of msg.content ?? []) {
        if (b.type === 'tool_use') {
          if (isAgentTool(b.name)) this.agentCalls.add(b.id)
          out.push({ type: 'tool_start', id: b.id, name: b.name, summary: JSON.stringify(b.input ?? {}).slice(0, 300), input: b.input ?? {} })
        }
        else if (b.type === 'text' && !this.sawDeltas && b.text && !apiError) { this.text += (this.text ? '\n\n' : '') + b.text; out.push({ type: 'text', delta: b.text }) }
      }
      if (apiError) out.push({ type: 'error', code: classifyError(String(ev.error) + ' ' + JSON.stringify(msg.content ?? '')), message: String(msg.content?.[0]?.text ?? ev.error) })
      if (ev.error === 'refusal') this.refused = true
    } else if (ev.type === 'user') {
      const results = Array.isArray(ev.message?.content) ? ev.message.content.filter((b: any) => b?.type === 'tool_result') : []
      // the structured result belongs to the message's one tool result (Claude Code sends each result on its own); a
      // sub-agent's WebSearch gets the same handling as the main AI's (its hits are the search server's, or none)
      const hits = results.length === 1 ? webSearchHits(ev.tool_use_result) : undefined
      for (const b of results) {
        const text = toolResultText(b.content)
        const end: Extract<EngineEvent, { type: 'tool_end' }> = { type: 'tool_end', id: b.tool_use_id, ok: !b.is_error, summary: text.slice(0, 200) || undefined, output: text.slice(0, TOOL_OUTPUT_MAX), ...(hits ? { sources: hits } : {}) }
        if (parent) end.parentId = parent
        else if (this.agentCalls.has(b.tool_use_id) && results.length === 1) {
          // the sub-agent's totals; a child that failed (API error, refusal) has a plain string here instead (M2)
          const stats = agentStats(ev.tool_use_result)
          if (stats) end.agent = stats
          if (typeof ev.tool_use_result === 'string' || (ev.tool_use_result && typeof ev.tool_use_result === 'object' && ev.tool_use_result.status && ev.tool_use_result.status !== 'completed')) end.ok = false
        }
        out.push(end)
      }
    } else if (ev.type === 'result') {
      this.result = ev
      if (ev.session_id && !this.sessionId) this.sessionId = ev.session_id
      // tokens of the whole run: result.usage counts the main session only; modelUsage (per model) and total_cost_usd
      // include the sub-agents (review S7). Same sums as before: input = input + cache read + cache creation.
      const u = ev.usage ?? {}
      const models = ev.modelUsage && typeof ev.modelUsage === 'object' ? Object.values(ev.modelUsage as Record<string, any>) : []
      const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
      const usage = models.length
        ? { inputTokens: models.reduce((a, m) => a + num(m?.inputTokens) + num(m?.cacheReadInputTokens) + num(m?.cacheCreationInputTokens), 0), outputTokens: models.reduce((a, m) => a + num(m?.outputTokens), 0) }
        : { inputTokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens), outputTokens: num(u.output_tokens) }
      out.push({ type: 'usage', ...usage, costUsd: ev.total_cost_usd })
      if (ev.stop_reason === 'refusal' || ev.terminal_reason === 'refusal') this.refused = true
      // Claude Code ends a run that reached --max-turns with result subtype "error_max_turns" (is_error true; newer
      // versions also say terminal_reason "max_turns"): the answer so far stands and the person may continue
      if (this.refused) out.push({ type: 'error', code: 'refused', message: 'the model declined this request' })
      else if (ev.subtype === 'error_max_turns' || ev.terminal_reason === 'max_turns') { this.maxTurns = true; out.push({ type: 'limit', kind: 'turns' }) }
      else if (ev.is_error) out.push({ type: 'error', code: classifyError(String(ev.result ?? ev.subtype ?? '') + ' ' + String(ev.terminal_reason ?? '')), message: String(ev.result ?? ev.subtype ?? 'engine error') })
      if (!this.text && typeof ev.result === 'string' && !ev.is_error) { this.text = ev.result; out.push({ type: 'text', delta: ev.result }) }
    }
    return out
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
