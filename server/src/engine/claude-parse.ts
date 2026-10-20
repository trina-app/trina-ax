// Claude Code `--output-format stream-json --verbose --include-partial-messages` -> EngineEvent
// (ideas from Saram run.ts: text from stream_event deltas, tool steps from assistant messages, errors from result).
import type { EngineEvent, EngineErrorCode } from '@mycel/shared'

export function classifyError(msg: string): EngineErrorCode {
  const m = msg.toLowerCase()
  if (/not logged in|authentication|invalid api key|401|unauthorized|oauth/.test(m)) return 'auth'
  if (/rate.?limit|429|overloaded|usage limit|quota/.test(m)) return 'rate_limit'
  if (/prompt is too long|context|too many tokens/.test(m)) return 'context'
  if (/refus/.test(m)) return 'refused'
  if (/timed? ?out|timeout/.test(m)) return 'timeout'
  return 'crash'
}

export class ClaudeStreamParser {
  private sawDeltas = false
  private textOpen = false
  sessionId: string | null = null
  init: any = null
  result: any = null
  refused = false
  text = ''
  push(line: string): EngineEvent[] {
    let ev: any
    try { ev = JSON.parse(line) } catch { return [] }
    const out: EngineEvent[] = []
    if (ev.type === 'system' && ev.subtype === 'init') {
      this.init = ev
      if (ev.session_id) { this.sessionId = ev.session_id; out.push({ type: 'session', sessionId: ev.session_id }) }
    } else if (ev.type === 'stream_event') {
      const e = ev.event ?? {}
      if (e.type === 'content_block_start' && e.content_block?.type === 'text') { this.textOpen = true; if (this.text && !this.text.endsWith('\n\n')) { this.text += '\n\n'; out.push({ type: 'text', delta: '\n\n' }) } }
      else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { this.sawDeltas = true; this.text += e.delta.text; out.push({ type: 'text', delta: e.delta.text }) }
      else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') out.push({ type: 'thinking', delta: e.delta.thinking ?? '' })
      else if (e.type === 'content_block_stop') this.textOpen = false
      else if (e.type === 'message_delta' && e.delta?.stop_reason === 'refusal') this.refused = true
    } else if (ev.type === 'assistant') {
      const msg = ev.message ?? {}
      if (msg.stop_reason === 'refusal') this.refused = true
      for (const b of msg.content ?? []) {
        if (b.type === 'tool_use') out.push({ type: 'tool_start', id: b.id, name: b.name, summary: JSON.stringify(b.input ?? {}).slice(0, 300) })
        else if (b.type === 'text' && !this.sawDeltas && b.text) { this.text += (this.text ? '\n\n' : '') + b.text; out.push({ type: 'text', delta: b.text }) }
      }
      if (ev.error && ev.error !== 'refusal') out.push({ type: 'error', code: classifyError(String(ev.error) + ' ' + JSON.stringify(msg.content ?? '')), message: String(msg.content?.[0]?.text ?? ev.error) })
      if (ev.error === 'refusal') this.refused = true
    } else if (ev.type === 'user') {
      for (const b of ev.message?.content ?? []) if (b.type === 'tool_result') out.push({ type: 'tool_end', id: b.tool_use_id, ok: !b.is_error, summary: typeof b.content === 'string' ? b.content.slice(0, 200) : undefined })
    } else if (ev.type === 'result') {
      this.result = ev
      if (ev.session_id && !this.sessionId) this.sessionId = ev.session_id
      const u = ev.usage ?? {}
      out.push({ type: 'usage', inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, costUsd: ev.total_cost_usd })
      if (ev.stop_reason === 'refusal' || ev.terminal_reason === 'refusal') this.refused = true
      if (this.refused) out.push({ type: 'error', code: 'refused', message: 'the model declined this request' })
      else if (ev.is_error) out.push({ type: 'error', code: classifyError(String(ev.result ?? ev.subtype ?? '') + ' ' + String(ev.terminal_reason ?? '')), message: String(ev.result ?? ev.subtype ?? 'engine error') })
      if (!this.text && typeof ev.result === 'string' && !ev.is_error) { this.text = ev.result; out.push({ type: 'text', delta: ev.result }) }
    }
    return out
  }
}
