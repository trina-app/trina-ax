// Pure updates of one chat's visible branch (no React, no network; unit-tested in test/unit/thread.test.ts).
//
// Streaming rules (ws.ts): message.delta.offset is the character position in message.content where the text
// starts. The server saves streaming answers every 0.3 s, so after a REST reload we may already have part of a
// delta: overlap is cut by offset. A delta that starts beyond what we have means we missed one → reload. A delta
// with `reset` cuts the text at its offset first (the server discarded a refused attempt's partial answer).
import type { Message, Step, TurnStarted } from '@mycel/shared/api'

/** A message as the page keeps it: the server's shape plus, for a message still being sent, local state. */
export type ViewMessage = Message & {
  local?: {
    clientMessageId: string
    state: 'sending' | 'failed'
    error?: string
  }
}

export interface Thread {
  messages: ViewMessage[]
  /** older messages exist (fetch with this cursor and prepend) */
  nextCursor: string | null
  /** missed a delta or the branch changed elsewhere: reload from REST */
  stale: boolean
}

export const emptyThread = (): Thread => ({ messages: [], nextCursor: null, stale: false })

export interface Delta { messageId: string; offset: number; text: string; reset?: true }

export type DeltaResult = { kind: 'applied'; messages: ViewMessage[] } | { kind: 'unknown' } | { kind: 'gap' } | { kind: 'ignored' }

export function applyDelta(messages: ViewMessage[], d: Delta): DeltaResult {
  const i = messages.findIndex((m) => m.id === d.messageId)
  if (i < 0) return { kind: 'unknown' }
  const m = messages[i]!
  if (m.status !== 'streaming') return { kind: 'ignored' } // late delta after done
  const have = m.content.length
  if (d.offset > have) return { kind: 'gap' }
  if (d.reset) { // the text from offset on was discarded (a refused attempt before the retry)
    const next = messages.slice()
    next[i] = { ...m, content: m.content.slice(0, d.offset) + d.text }
    return { kind: 'applied', messages: next }
  }
  const end = d.offset + d.text.length
  if (end <= have) return { kind: 'ignored' } // already have all of it
  const add = d.text.slice(have - d.offset)
  const next = messages.slice()
  next[i] = { ...m, content: m.content + add }
  return { kind: 'applied', messages: next }
}

/** Insert or update a step by id (a step goes running → ok/error with the same id). */
export function applyStep(messages: ViewMessage[], messageId: string, step: Step): ViewMessage[] | null {
  const i = messages.findIndex((m) => m.id === messageId)
  if (i < 0) return null
  const m = messages[i]!
  const j = m.steps.findIndex((s) => s.id === step.id)
  const steps = j < 0 ? [...m.steps, step] : m.steps.map((s, k) => (k === j ? step : s))
  const next = messages.slice()
  next[i] = { ...m, steps }
  return next
}

/** The final message of a turn replaces what we built from deltas (it is the source of truth). */
export function applyDone(messages: ViewMessage[], final: Message): ViewMessage[] | null {
  const i = messages.findIndex((m) => m.id === final.id)
  if (i < 0) return null
  const next = messages.slice()
  next[i] = final
  return next
}

/**
 * A message created elsewhere (another window/device of the same person). If it continues the visible branch it is
 * appended; if we already have it, it is updated; otherwise the visible branch changed → 'stale'.
 */
export function applyCreated(messages: ViewMessage[], msg: Message): ViewMessage[] | 'stale' {
  const i = messages.findIndex((m) => m.id === msg.id)
  if (i >= 0) {
    const next = messages.slice()
    // keep streamed text if the event's copy is older than what deltas already gave us
    const cur = next[i]!
    next[i] = cur.status === 'streaming' && msg.status === 'streaming' && cur.content.length > msg.content.length ? { ...msg, content: cur.content, steps: cur.steps } : msg
    return next
  }
  const last = messages.at(-1)
  if ((last && msg.parentId === last.id) || (!last && msg.parentId === null)) return [...messages, msg]
  return 'stale'
}

/** Optimistic user message while POST /messages is in flight. */
export function optimisticUserMessage(o: { id: string; chatId: string; parentId: string | null; content: string; author: { id: string; name: string }; attachments: Message['attachments']; clientMessageId: string; now: string }): ViewMessage {
  return {
    id: o.id,
    chatId: o.chatId,
    parentId: o.parentId,
    role: 'user',
    author: o.author,
    content: o.content,
    attachments: o.attachments,
    steps: [],
    status: 'done',
    error: null,
    turnId: null,
    engine: null,
    model: null,
    files: null,
    usage: null,
    createdAt: o.now,
    branch: { index: 0, count: 1, siblingIds: [o.id] },
    local: { clientMessageId: o.clientMessageId, state: 'sending' },
  }
}

export function markLocal(messages: ViewMessage[], localId: string, state: 'sending' | 'failed', error?: string): ViewMessage[] {
  return messages.map((m) => (m.id === localId && m.local ? { ...m, local: { ...m.local, state, error } } : m))
}

/**
 * Merge the answer of send / edit / regenerate.
 * - send: the optimistic message `replaceId` becomes the saved user message, then the empty answer follows.
 * - edit: everything from the edited message (`cutAt`) on is replaced by the new user message + answer.
 * - regenerate: everything from the old answer (`cutAt`) on is replaced by the new answer.
 * Branch counters of the new messages come from the server; the visible older siblings are gone from the path.
 */
export function mergeTurnStarted(messages: ViewMessage[], started: TurnStarted, o: { replaceId?: string; cutAt?: string }): ViewMessage[] {
  let base = messages
  if (o.cutAt) {
    const i = base.findIndex((m) => m.id === o.cutAt)
    if (i >= 0) base = base.slice(0, i)
  }
  if (o.replaceId) base = base.filter((m) => m.id !== o.replaceId)
  const out = base.filter((m) => m.id !== started.userMessage?.id && m.id !== started.assistantMessage.id)
  if (started.userMessage) out.push(started.userMessage)
  out.push(started.assistantMessage)
  return out
}

/** Prepend an older page (dropping overlap by id). */
export function prependPage(messages: ViewMessage[], older: Message[]): ViewMessage[] {
  const have = new Set(messages.map((m) => m.id))
  return [...older.filter((m) => !have.has(m.id)), ...messages]
}

/**
 * Replace the thread with a fresh REST page while keeping local optimistic messages that the server doesn't know
 * yet, and keeping streamed text that is ahead of the server's last save.
 */
export function mergeFresh(current: ViewMessage[], fresh: Message[]): ViewMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]))
  const out: ViewMessage[] = fresh.map((m) => {
    const cur = byId.get(m.id)
    if (cur && m.status === 'streaming' && cur.status === 'streaming' && cur.content.length > m.content.length && cur.content.startsWith(m.content)) {
      return { ...m, content: cur.content }
    }
    // a reload that left the server while the answer was still running, answered after message.done: the finished
    // message is newer (staging 2026-10-22: the answer stayed cut at its first line until the page was reloaded)
    if (cur && m.status === 'streaming' && cur.status !== 'streaming' && !cur.local) return cur
    return m
  })
  for (const m of current) if (m.local && !out.some((x) => x.id === m.id)) out.push(m)
  return out
}

/** The newest assistant message still running in this branch. */
export const runningMessage = (messages: ViewMessage[]) => [...messages].reverse().find((m) => m.role === 'assistant' && m.status === 'streaming')
