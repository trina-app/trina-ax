// Claude Code `--output-format stream-json --verbose --include-partial-messages` -> EngineEvent
// (ideas from Saram run.ts: text from stream_event deltas, tool steps from assistant messages, errors from result).
import type { AgentStats, EngineEvent, EngineErrorCode } from '@mycel/shared'

/** the conversation no longer fits the model (Anthropic "prompt is too long: N tokens > M maximum", "input length and
 * `max_tokens` exceed context limit"; OpenAI "context_length_exceeded", "maximum context length", Codex "exceeds the
 * context window"; Claude Code "Conversation too long"; Anthropic's request_too_large: a fresh start sends less) */
export const CONTEXT_FULL = /prompt is too long|context[ _](window|length|limit)|context_length_exceeded|maximum context|too many tokens|conversation (is )?too long|request_too_large|request too large/

/** a per-minute token limit (Anthropic / OpenAI TPM: "too many tokens per minute", "Request too large for gpt-4o on
 * tokens per min"): a rate limit, never a full conversation, though it says "too many tokens" or "request too large" */
const PER_MINUTE = /per min|\btpm\b|per minute|rate.?limit/
/** the text says the conversation does not fit (CONTEXT_FULL), and is not a per-minute limit */
export const contextFull = (text: string): boolean => { const m = text.toLowerCase(); return CONTEXT_FULL.test(m) && !PER_MINUTE.test(m) }

export function classifyError(msg: string): EngineErrorCode {
  const m = msg.toLowerCase()
  // the error class or the leading text, never a number inside an id (a request_id with "401" in it is not a sign-in error)
  if (/not logged in|authentication_error|authentication_failed|authentication failed|failed to authenticate|invalid api key|invalid x-api-key|oauth token (has expired|has been revoked|is invalid)|please run \/login|\bunauthorized\b/.test(m)
    || /(^|\bapi error:?\s*|\bstatus:?\s*)401\b/.test(m.trim())) return 'auth'
  // only what the providers say when the conversation does not fit (limits audit 2 #13): "context" alone matched any
  // error that named a context ("execution context destroyed", a tool's "context" field) and ended the answer as full.
  // Before the limit check: a token count such as "214290 tokens" holds "429"
  if (contextFull(m)) return 'context'
  if (/rate.?limit|\b429\b|overloaded|usage limit|quota/.test(m) || PER_MINUTE.test(m)) return 'rate_limit'
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

/** A limit's reset time in Claude Code's own words (QA TC-f3-01: a weekly limit read "try again a bit later"): the
 * older "Claude AI usage limit reached|<epoch seconds>" form. null: none in the text. */
export function limitResetIn(text: string): string | null {
  const m = /limit reached\|(\d{9,11})\b/i.exec(text)
  if (!m) return null
  const ms = Number(m[1]) * 1000
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
/** The text names a limit of a week or longer ("weekly limit", "7-day", "monthly"): retrying soon cannot help. */
export const LONG_LIMIT = /weekly|seven.?day|7.?day|monthly|opus limit/i

export class ClaudeStreamParser {
  /** the newest reset time of a refused subscription limit Claude Code reported (stream-json rate_limit_event,
   * rate_limit_info.status 'rejected', resetsAt in epoch seconds), with whether it is a week or longer */
  private limit: { at: string; long: boolean } | null = null
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
  /** the input tokens of the model call under way (its message_start), of the main AI ('') and of each sub-agent */
  private callInput = new Map<string, number>()
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
    if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info ?? {}
      const at = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : NaN
      if (info.status === 'rejected' && Number.isFinite(at)) this.limit = { at: new Date(at).toISOString(), long: LONG_LIMIT.test(String(info.rateLimitType ?? '')) }
      return out
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      this.init = ev
      if (ev.session_id) { this.sessionId = ev.session_id; out.push({ type: 'session', sessionId: ev.session_id }) }
      out.push({ type: 'init', tools: strings(ev.tools), agents: strings(ev.agents), mcpServers: Array.isArray(ev.mcp_servers) ? strings(ev.mcp_servers.map((m: any) => m?.name)) : [] })
    } else if (ev.type === 'system' && !parent && (ev.subtype === 'compact_boundary' || ev.subtype === 'microcompact_boundary')) {
      // the main AI's session dropped text it saw (a compaction): reads made before it no longer allow a whole-file
      // replace (chat/carried-reads.ts); a sub-agent never replaces a whole file from an earlier read anyway
      out.push({ type: 'compacted' })
    } else if (ev.type === 'system' && (ev.subtype === 'task_progress' || ev.subtype === 'task_notification')) {
      const stats = agentStats(ev.usage)
      if (typeof ev.tool_use_id === 'string' && stats) out.push({ type: 'agent_progress', id: ev.tool_use_id, stats })
    } else if (ev.type === 'stream_event') {
      const e = ev.event ?? {}
      // one model call's tokens as soon as it ends (input from its start, output from its last delta), the main AI's
      // and each sub-agent's: the turn counts them while the run goes on, so a used-up budget stops the answer before
      // the run's total comes (result below: it includes the sub-agents and replaces these)
      const key = parent ?? ''
      if (e.type === 'message_start') this.callInput.set(key, inputOf(e.message?.usage))
      else if (e.type === 'message_delta' && e.usage && typeof e.usage === 'object') {
        // the main AI's call that ends without a tool call is the answer's last: counted, but never a reason to stop
        const continues = !!parent || e.delta?.stop_reason === 'tool_use'
        out.push({ type: 'usage', running: true, inputTokens: Math.max(this.callInput.get(key) ?? 0, inputOf(e.usage)), outputTokens: num(e.usage.output_tokens), ...(continues ? { continues: true } : {}) })
        this.callInput.delete(key)
      }
      if (parent) return out
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
      if (apiError) out.push(this.limited({ type: 'error', code: classifyError(String(ev.error) + ' ' + JSON.stringify(msg.content ?? '')), message: String(msg.content?.[0]?.text ?? ev.error) }))
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
      const usage = models.length
        ? { inputTokens: models.reduce((a, m) => a + num(m?.inputTokens) + num(m?.cacheReadInputTokens) + num(m?.cacheCreationInputTokens), 0), outputTokens: models.reduce((a, m) => a + num(m?.outputTokens), 0) }
        : { inputTokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens), outputTokens: num(u.output_tokens) }
      out.push({ type: 'usage', ...usage, costUsd: ev.total_cost_usd })
      if (ev.stop_reason === 'refusal' || ev.terminal_reason === 'refusal') this.refused = true
      // Claude Code ends a run that reached --max-turns with result subtype "error_max_turns" (is_error true; newer
      // versions also say terminal_reason "max_turns"): the answer so far stands and the person may continue
      if (this.refused) out.push({ type: 'error', code: 'refused', message: 'the model declined this request' })
      else if (ev.subtype === 'error_max_turns' || ev.terminal_reason === 'max_turns') { this.maxTurns = true; out.push({ type: 'limit', kind: 'turns' }) }
      else if (ev.is_error) out.push(this.limited({ type: 'error', code: classifyError(String(ev.result ?? ev.subtype ?? '') + ' ' + String(ev.terminal_reason ?? '')), message: String(ev.result ?? ev.subtype ?? 'engine error') }))
      if (!this.text && typeof ev.result === 'string' && !ev.is_error) { this.text = ev.result; out.push({ type: 'text', delta: ev.result }) }
    }
    return out
  }

  /** A limit error with when it starts again, as Claude Code told it: its rate_limit_event, else the time in its words;
   * `weekly` when it names a week or longer and gives no time. Any other error as it is. */
  private limited(e: Extract<EngineEvent, { type: 'error' }>): Extract<EngineEvent, { type: 'error' }> {
    if (e.code !== 'rate_limit') return e
    const at = this.limit?.at ?? limitResetIn(e.message)
    if (at && Date.parse(at) > Date.now()) return { ...e, retryAt: at }
    return LONG_LIMIT.test(e.message) || this.limit?.long ? { ...e, weekly: true } : e
  }
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)
/** input tokens of one model call, the same sum as the run's total: input + cache read + cache creation */
const inputOf = (u: any) => (u && typeof u === 'object' ? num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) : 0)

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
