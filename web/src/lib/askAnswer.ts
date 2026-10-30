// The message box answers the AI's open question (like Claude Code's AskUserQuestion, where typing is the "Other"
// answer): while an ask_user card of the AI waits in this chat, sending from the message box answers that card with
// the typed text instead of keeping the message waiting for an answer that waits for the card. Pure helpers (unit-
// tested in test/unit/ask-answer.test.ts) plus what the open cards of this window have ticked so far.
//
// Never answered from the message box: the server's own safety checks (origin 'server': open an unseen address,
// save where more people see it, ...) and browser site confirmations. A typed "yes" must not pass for a decision
// that only their buttons make; messages typed meanwhile wait like during any answer.
import type { TurnRequest } from '@mycel/shared/api'
import type { OpenRequest } from '../store/chats'

export type AskUserRequest = Extract<TurnRequest, { kind: 'ask_user' }>
export type OpenQuestion = OpenRequest & { request: AskUserRequest }

const isQuestion = (r: OpenRequest): r is OpenQuestion => r.request.kind === 'ask_user' && r.request.origin !== 'server'
/** the card shown first comes first: by the time it closes by itself (one timeout for all), then its id (uuidv7) */
const byAge = (a: OpenQuestion, b: OpenQuestion) =>
  (a.request.expiresAt ?? '').localeCompare(b.request.expiresAt ?? '') || a.request.requestId.localeCompare(b.request.requestId)

/** The question the message box answers now: the oldest open question of the AI in this chat (several can be open
 * when the AI asks more than one at a time: each send answers the next one), or null. */
export function composerQuestion(requests: Readonly<Record<string, OpenRequest>>, chatId: string): OpenQuestion | null {
  let first: OpenQuestion | null = null
  for (const r of Object.values(requests)) if (r.chatId === chatId && isQuestion(r) && (!first || byAge(r, first) < 0)) first = r
  return first
}

/** An open card in this chat that only its own buttons answer (a server safety check, a browser site). */
export function choiceWaiting(requests: Readonly<Record<string, OpenRequest>>, chatId: string): boolean {
  return Object.values(requests).some((r) => r.chatId === chatId && !isQuestion(r))
}

/**
 * The answer a message typed in the message box gives: the text, as the person's own answer (like typing in the
 * card's own box). On a question that takes several answers, the options already ticked on the card go along.
 */
export function composerAnswer(request: AskUserRequest, picked: readonly string[], text: string): string | string[] {
  const own = text.trim()
  if (!request.multiple) return own
  const valid = new Set((request.options ?? []).map((o) => o.value))
  return [...picked.filter((v) => valid.has(v)), own]
}

// ---------------- what the open cards of this window have ticked ----------------
const picks = new Map<string, readonly string[]>()
/** AskCard keeps this current while it is open. */
export function rememberPicks(requestId: string, picked: readonly string[]) {
  if (picked.length) picks.set(requestId, picked)
  else picks.delete(requestId)
}
export const forgetPicks = (requestId: string) => void picks.delete(requestId)
export const picksOf = (requestId: string): readonly string[] => picks.get(requestId) ?? []
