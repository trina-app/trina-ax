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
 * A message created elsewhere (another window/device of the same person), or my own question saved before its POST
 * answered. If we already have it, it is updated; my question takes the place of its "sending" copy; if it continues
 * the visible branch (the last message the server knows, not one still being sent) it goes after it; otherwise the
 * visible branch changed → 'stale'.
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
  // the server's copy of a question this page is sending (the event can come before the POST's answer); a copy whose
  // parent is not known yet (sent before the messages were in) answers under the server's active leaf: not matched
  const own = msg.role === 'user' ? messages.findIndex((m) => m.local?.state === 'sending' && m.parentId === msg.parentId && m.content === msg.content && m.author?.id === msg.author?.id) : -1
  if (own >= 0) {
    const next = messages.slice()
    next[own] = msg
    return next
  }
  const at = messages.map((m) => !m.local).lastIndexOf(true)
  const last = at >= 0 ? messages[at] : undefined
  if ((last && msg.parentId === last.id) || (!last && msg.parentId === null)) return [...messages.slice(0, at + 1), msg, ...messages.slice(at + 1)]
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

/** Steps of a running answer: the server's copy as it was read and what the socket said since. A step the socket saw
 * end stays ended; steps the copy does not have yet stay. */
function mergeSteps(saved: Step[], live: Step[]): Step[] {
  const byId = new Map(live.map((s) => [s.id, s]))
  const out = saved.map((s) => {
    const l = byId.get(s.id)
    return l && s.status === 'running' && l.status !== 'running' ? l : s
  })
  const have = new Set(saved.map((s) => s.id))
  for (const l of live) if (!have.has(l.id)) out.push(l)
  return out
}

/**
 * Replace the thread with a fresh REST page while keeping local optimistic messages that the server doesn't know
 * yet, and keeping streamed text that is ahead of the server's last save.
 */
export function mergeFresh(current: ViewMessage[], fresh: Message[]): ViewMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]))
  const out: ViewMessage[] = fresh.map((m) => {
    const cur = byId.get(m.id)
    if (cur && m.status === 'streaming' && cur.status === 'streaming') {
      const ahead = cur.content.length > m.content.length && cur.content.startsWith(m.content)
      return { ...m, content: ahead ? cur.content : m.content, steps: mergeSteps(m.steps, cur.steps) }
    }
    // a reload that left the server while the answer was still running, answered after message.done: the finished
    // message is newer (staging 2026-10-22: the answer stayed cut at its first line until the page was reloaded)
    if (cur && m.status === 'streaming' && cur.status !== 'streaming' && !cur.local) return cur
    return m
  })
  // a question still "sending" whose server copy is in the page already (its message.created came during the read)
  // is not shown twice; one sent before any message was in (no parent) cannot be told from an older question
  const sentCopy = (m: ViewMessage) => m.local?.state === 'sending' && m.parentId !== null && fresh.some((x) => x.role === 'user' && x.parentId === m.parentId && x.content === m.content && x.author?.id === m.author?.id && !current.some((c) => c.id === x.id))
  for (const m of current) if (m.local && !out.some((x) => x.id === m.id) && !sentCopy(m)) out.push(m)
  return out
}

/** The newest assistant message still running in this branch. */
export const runningMessage = (messages: ViewMessage[]) => [...messages].reverse().find((m) => m.role === 'assistant' && m.status === 'streaming')

/** The message rows' buttons (version arrows, edit, regenerate) wait while an answer runs or a question is sending,
 * while the chat is read-only, and while someone else's answer runs in a shared chat: its live answer is not on this
 * screen, but switching versions then would drop it off the branch (the server answers 409 branch_while_answering). */
export const rowButtonsWait = (messages: ViewMessage[], o: { readOnly: boolean; othersTurn: unknown }) =>
  !!runningMessage(messages) || messages.some((m) => m.local?.state === 'sending') || o.readOnly || !!o.othersTurn
