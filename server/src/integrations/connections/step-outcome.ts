// What a connection's call came back with, in a few words beside its step's line (Step.outcome; docs/decisions/
// 20261124-step-key-input.md), like Claude Code's short result under a call: how many items the service's answer
// listed, or why the call did not run. Only what is sure: a count from an answer that is JSON with one list in it, an
// end from the server's own reason for stopping. Nothing here reads the meaning of a service's words.
import { maskSecrets } from '@mycel/shared'
import type { StepOutcome } from '@mycel/shared/api'

/** Names a list of results goes by in a JSON answer (when an object holds more than one list). */
const LIST_NAMES = new Set(['results', 'items', 'data', 'hits', 'records', 'entries', 'rows', 'list', 'organic', 'matches', 'documents', 'files', 'pages', 'issues', 'messages'])
const MAX_JSON = 2_000_000

/** How many items an answer lists: a JSON list, or an object with one list (or one named like a result list). */
export function answerCount(structured: unknown, text: string): number | undefined {
  let v: unknown = structured
  if (v === undefined || v === null) {
    const t = text.trim()
    if (!t || t.length > MAX_JSON || !/^[[{]/.test(t)) return undefined
    try { v = JSON.parse(t) } catch { return undefined }
  }
  if (Array.isArray(v)) return v.length
  if (!v || typeof v !== 'object') return undefined
  const lists = Object.entries(v as Record<string, unknown>).filter(([, x]) => Array.isArray(x)) as [string, unknown[]][]
  if (lists.length === 1) return lists[0]![1].length
  const named = lists.filter(([k]) => LIST_NAMES.has(k.toLowerCase()))
  return named.length === 1 ? named[0]![1].length : undefined
}

/** Why a call stopped, from the server's own short reason (CallError.kind), or undefined for a stop the step marks
 * itself (the person's Stop, the answer's end). */
export function endOfKind(kind: string): StepOutcome['end'] | undefined {
  if (kind === 'stopped' || kind === 'the answer stopped') return undefined
  if (kind === 'not allowed by the user') return 'declined'
  if (kind === 'no answer in time') return 'unanswered'
  if (kind === 'not fetched (shared chat)') return 'skipped'
  if (kind.startsWith('refused') || kind === 'tool off' || kind === 'no access' || kind.startsWith('nobody to ask') || kind === 'not from the desktop app') return 'refused'
  return 'failed'
}

/** A service's error answer as its step shows it when opened: its first line, without "Error:", secrets out, cut. */
export function errorLine(text: string, max = 160): string | undefined {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean)
  if (!line) return undefined
  const v = maskSecrets(line.replace(/^(?:error|err)\s*[:-]\s*/i, '').replace(/\s+/g, ' '), '…').trim()
  if (!v) return undefined
  return v.length > max ? v.slice(0, max - 1).trimEnd() + '…' : v
}
