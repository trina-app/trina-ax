// `codex exec --json` events -> EngineEvent
import type { EngineEvent } from '@mycel/shared'
import { classifyError } from './claude-parse'

export class CodexEventParser {
  sessionId: string | null = null
  text = ''
  /** every item type seen (the lockdown test asserts no command_execution / collab / file_change items) */
  itemTypes = new Map<string, number>()
  items: any[] = []
  push(line: string): EngineEvent[] {
    let ev: any
    try { ev = JSON.parse(line) } catch { return [] }
    const out: EngineEvent[] = []
    if (ev.type === 'thread.started' && ev.thread_id) { this.sessionId = ev.thread_id; out.push({ type: 'session', sessionId: ev.thread_id }) }
    else if (ev.type === 'item.started' || ev.type === 'item.completed') {
      const it = ev.item ?? {}
      if (ev.type === 'item.completed') { this.itemTypes.set(it.type, (this.itemTypes.get(it.type) ?? 0) + 1); this.items.push(it) }
      switch (it.type) {
        case 'agent_message':
          if (ev.type === 'item.completed' && it.text) { const d = (this.text ? '\n\n' : '') + it.text; this.text += d; out.push({ type: 'text', delta: d }) }
          break
        case 'reasoning': if (ev.type === 'item.completed' && it.text) out.push({ type: 'thinking', delta: it.text }); break
        case 'mcp_tool_call':
          if (ev.type === 'item.started') out.push({ type: 'tool_start', id: it.id, name: `mcp__${it.server}__${it.tool}`, summary: JSON.stringify(it.arguments ?? {}).slice(0, 300) })
          else out.push({ type: 'tool_end', id: it.id, ok: it.status === 'completed' && !it.error && !it.result?.is_error })
          break
        case 'web_search':
          if (ev.type === 'item.started') out.push({ type: 'tool_start', id: it.id, name: 'web_search', summary: String(it.query ?? '').slice(0, 200) })
          else out.push({ type: 'tool_end', id: it.id, ok: true })
          break
        case 'command_execution': case 'file_change': case 'collab_tool_call':
          // must never happen with the locked profile; surfaced so tests and audit see it
          if (ev.type === 'item.started') out.push({ type: 'tool_start', id: it.id, name: `codex:${it.type}`, summary: JSON.stringify(it).slice(0, 300) })
          else out.push({ type: 'tool_end', id: it.id, ok: it.status === 'completed' })
          break
        case 'error': break // configuration warnings
      }
    } else if (ev.type === 'turn.completed') {
      const u = ev.usage ?? {}
      out.push({ type: 'usage', inputTokens: u.input_tokens ?? 0, outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0) })
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      const msg = String(ev.error?.message ?? ev.message ?? 'codex error')
      out.push({ type: 'error', code: classifyError(msg), message: msg })
    }
    return out
  }
}
