// The AI's questions wait as long as it takes, like Claude Code's AskUserQuestion (docs/decisions/20261118-questions-
// wait-and-todo-card.md). The main AI's ask_user in a chat a person watches saves its card here and returns at once; the
// AI ends its answer, and nothing is held meanwhile (no queue slot, no engine). The card stays under that answer with no
// time limit, after a reload and after a restart (GET /api/chats/:id/requests reads it from here). The person's answer
// (the card or the message box, POST /api/turns/:id/answer), even hours later, starts the chat's next turn with the
// answer as its user message, continuing from the asking answer (Claude resumes its session there). Several questions
// of one answer: the turn starts once the last one is answered. Any other turn started in the chat closes them
// (ChatRuntime.createTurn): the conversation went on without them.
// In a shared chat the card is the asker's only (listed for them, answered only by them: the turn's own person), and
// the answer becomes their message there, which everyone in the chat reads (owner 2026-11-19: in a shared chat
// everything is shared). A Slack turn and a scheduled run keep the wait inside the call (chat/turn.ts waitForPerson):
// Slack's answer goes back from that same turn, and nobody watches a scheduled run.
import type { Database } from 'bun:sqlite'
import type { OpenTurnRequest, TurnRequest } from '@mycel/shared/api'

type AskRequest = Extract<TurnRequest, { kind: 'ask_user' }>
interface Row { request_id: string; chat_id: string; message_id: string; turn_id: string; user_id: string; request: string; answer: string | null; created_at: string }
/** one answered question, as the next turn's engine message names it */
export interface AnsweredQuestion { question: string; answer: unknown }

/** Turns of these apps keep the card inside the tool call (see the header): null is a turn the server started itself. */
export const questionsWaitInCall = (clientKind: string | null): boolean => clientKind === null || clientKind === 'schedule' || clientKind === 'slack'

const parse = (s: string): AskRequest | null => {
  try { const v = JSON.parse(s) as AskRequest; return v && v.kind === 'ask_user' ? v : null } catch { return null }
}

export function saveQuestion(db: Database, o: { request: AskRequest; chatId: string; messageId: string; turnId: string; userId: string }): void {
  db.query('INSERT INTO open_questions (request_id, chat_id, message_id, turn_id, user_id, request, answer, created_at) VALUES (?,?,?,?,?,?,NULL,?)')
    .run(o.request.requestId, o.chatId, o.messageId, o.turnId, o.userId, JSON.stringify(o.request), new Date().toISOString())
}

/** The person's open questions in this chat, oldest first, as GET /api/chats/:id/requests lists cards. */
export function openQuestionsOf(db: Database, chatId: string, userId: string): OpenTurnRequest[] {
  const rows = db.query('SELECT * FROM open_questions WHERE chat_id = ? AND user_id = ? AND answer IS NULL ORDER BY created_at, request_id').all(chatId, userId) as Row[]
  const out: OpenTurnRequest[] = []
  for (const r of rows) { const request = parse(r.request); if (request) out.push({ turnId: r.turn_id, chatId: r.chat_id, messageId: r.message_id, request }) }
  return out
}

/** A question still waits in this chat (for `userId`, when given). */
export function hasOpenQuestion(db: Database, chatId: string, userId?: string): boolean {
  return !!(userId === undefined
    ? db.query('SELECT 1 FROM open_questions WHERE chat_id = ? AND answer IS NULL LIMIT 1').get(chatId)
    : db.query('SELECT 1 FROM open_questions WHERE chat_id = ? AND user_id = ? AND answer IS NULL LIMIT 1').get(chatId, userId))
}

/** A question of this turn still waits for `userId` (the push of a waiting card is still wanted). */
export function turnQuestionOpen(db: Database, turnId: string, userId: string): boolean {
  return !!db.query('SELECT 1 FROM open_questions WHERE turn_id = ? AND user_id = ? AND answer IS NULL LIMIT 1').get(turnId, userId)
}

/** The open question `requestId` of `turnId`, the caller's own, or null (answered, closed, someone else's). */
export function openQuestion(db: Database, turnId: string, requestId: string, userId: string): { chatId: string; messageId: string; request: AskRequest } | null {
  const r = db.query('SELECT * FROM open_questions WHERE request_id = ? AND turn_id = ? AND user_id = ? AND answer IS NULL').get(requestId, turnId, userId) as Row | null
  const request = r ? parse(r.request) : null
  return r && request ? { chatId: r.chat_id, messageId: r.message_id, request } : null
}

/** All questions of one answer, answered, in the order they were asked; null while one is still open (or none). */
export function readyAnswers(db: Database, messageId: string, userId: string): { answers: AnsweredQuestion[]; requests: AskRequest[] } | null {
  const all = db.query('SELECT * FROM open_questions WHERE message_id = ? AND user_id = ? ORDER BY created_at, request_id').all(messageId, userId) as Row[]
  if (!all.length || all.some((x) => x.answer === null)) return null
  const requests = all.map((x) => parse(x.request) ?? { kind: 'ask_user' as const, requestId: x.request_id, question: '' })
  return { requests, answers: all.map((x, i) => ({ question: requests[i]!.question, answer: JSON.parse(x.answer!) as unknown })) }
}

/** Open the answered questions of one answer again (the next turn could not start): what the apps show again. */
export function reopenAnswers(db: Database, messageId: string, userId: string): OpenTurnRequest[] {
  db.query('UPDATE open_questions SET answer = NULL WHERE message_id = ? AND user_id = ?').run(messageId, userId)
  const rows = db.query('SELECT * FROM open_questions WHERE message_id = ? AND user_id = ? ORDER BY created_at, request_id').all(messageId, userId) as Row[]
  return rows.flatMap((r) => { const request = parse(r.request); return request ? [{ turnId: r.turn_id, chatId: r.chat_id, messageId: r.message_id, request }] : [] })
}

/**
 * Keep the answer of one question. 'waiting': other questions of the same answer are still open (the next turn starts
 * with the last one); 'ready': all of them are answered now, in the order they were asked; 'closed': not open any more.
 * undo() takes the answer back (the next turn could not start: the card stays open).
 */
export function recordAnswer(db: Database, requestId: string, value: unknown): { state: 'closed' } | { state: 'waiting' } | { state: 'ready'; answers: AnsweredQuestion[]; requests: AskRequest[]; undo(): void } {
  return db.transaction(() => {
    const r = db.query('SELECT * FROM open_questions WHERE request_id = ? AND answer IS NULL').get(requestId) as Row | null
    if (!r) return { state: 'closed' as const }
    db.query('UPDATE open_questions SET answer = ? WHERE request_id = ?').run(JSON.stringify(value ?? null), requestId)
    const ready = readyAnswers(db, r.message_id, r.user_id)
    if (!ready) return { state: 'waiting' as const }
    return { state: 'ready' as const, ...ready, undo: () => { db.query('UPDATE open_questions SET answer = NULL WHERE request_id = ?').run(requestId) } }
  })()
}

/** A new turn starts in the chat: every question still there goes (answered ones with their turn, the rest because the
 * conversation went on without them). What the apps are told to close. */
export function closeChatQuestions(db: Database, chatId: string): { requestId: string; turnId: string; userId: string; answered: boolean }[] {
  const rows = db.query('SELECT request_id, turn_id, user_id, answer FROM open_questions WHERE chat_id = ?').all(chatId) as Pick<Row, 'request_id' | 'turn_id' | 'user_id' | 'answer'>[]
  if (!rows.length) return []
  db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chatId)
  return rows.map((r) => ({ requestId: r.request_id, turnId: r.turn_id, userId: r.user_id, answered: r.answer !== null }))
}

/** What the answer's user message says on screen: the picked options by their labels, typed text as typed, `skipped`
 * for a question the person skipped (Skip on the card: the AI goes on without that answer); with several questions,
 * one line each after its question. */
export function answerText(answers: AnsweredQuestion[], requests: readonly AskRequest[], skipped: string): string {
  const label = (i: number, v: unknown): string => {
    if (v === null || v === undefined) return skipped
    const opts = requests[i]?.options ?? []
    const one = (x: unknown) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return opts.find((o) => o.value === s)?.label ?? s }
    return Array.isArray(v) ? v.map(one).join(', ') : one(v)
  }
  if (answers.length === 1) return label(0, answers[0]!.answer)
  return answers.map((a, i) => `${a.question}\n${label(i, a.answer)}`).join('\n\n')
}

export function saveAnswered(db: Database, messageId: string, answers: AnsweredQuestion[]): void {
  db.query('INSERT OR REPLACE INTO answered_questions (message_id, questions) VALUES (?, ?)').run(messageId, JSON.stringify(answers))
}

/** The engine message's first block when this user message answers the AI's questions (or ''): which question, and the
 * answer as the card gave it (option values, as ask_user returned them before). */
export function answeredNote(db: Database, messageId: string): string {
  const r = db.query('SELECT questions FROM answered_questions WHERE message_id = ?').get(messageId) as { questions: string } | null
  if (!r) return ''
  let list: AnsweredQuestion[]
  try { list = JSON.parse(r.questions) } catch { return '' }
  if (!Array.isArray(list) || !list.length) return ''
  // a skipped question reads as it did when the card closed without an answer ({"skipped": true})
  list = list.map((a) => (a.answer === null || a.answer === undefined ? { question: a.question, skipped: true } as unknown as AnsweredQuestion : a))
  return `<answered_questions>\nThis message is the user's answer to the question${list.length > 1 ? 's' : ''} you asked with ask_user in your previous answer (the card waited until they answered). Each answer as the card gave it: ${JSON.stringify(list)}\nContinue the work from there.\n</answered_questions>`
}
