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
// The server's own safety cards of some tools (delete, share, a website, a browser site: CARD_LATER_TOOLS) wait the same
// way (docs/decisions/20261119-safety-cards-wait.md): the card is kept here with the call that raised it (`call`), that
// call ends without doing anything, and the next turn runs it again once with the person's answer (chat/turn.ts
// replayCalls), every check made again at that moment.
import type { Database } from 'bun:sqlite'
import type { OpenTurnRequest, TurnRequest } from '@mycel/shared/api'
import { ALWAYS_VALUE } from './always-allow'
import type { CardAlwaysKind } from '@mycel/shared/api'
import { BROWSER_TOOL_NAMES } from '../realtime/browser-tools'
import { TEXT, tr } from './i18n'
import type { Locale } from '@mycel/shared/api'
import { answerRecord } from './shared-answers'

type AskRequest = Extract<TurnRequest, { kind: 'ask_user' }>
interface Row { request_id: string; chat_id: string; message_id: string; turn_id: string; user_id: string; request: string; answer: string | null; created_at: string; call_tool: string | null; call_args: string | null; window_id: string | null; call_meta?: string | null }
/** The turn that asked for a waiting call (docs/decisions/20261122-late-card-answer-resumes.md): its id, its user
 * message (the person's own words the call's checks read) and its answer (what the call's content came from). A card
 * re-raised while the call runs again keeps the first asking turn. */
export interface AskedIn { turnId: string; userMessageId: string; assistantId: string }
/** one earlier card of the same call and the answer it took (a call with two cards never asks the first again) */
export interface PriorAnswer { card: TurnRequest; answer: unknown }
/** what a waiting call keeps besides its tool and arguments (open_questions.call_meta, migration 444) */
export interface CallMeta {
  asked?: AskedIn
  /** the kind of the card's "Always allow" (chat/always-allow.ts): kept when the person picked it */
  always?: CardAlwaysKind
  prior?: PriorAnswer[]
}
/** a tool call that raised a safety card and runs again with its answer (chat/turn.ts replayCalls) */
export interface WaitingCall extends CallMeta { tool: string; args: unknown; card: TurnRequest; window: string | null }
/** one answered question (or safety card, with its call), as the next turn's engine message names it */
export interface AnsweredQuestion {
  question: string; answer: unknown; call?: WaitingCall
  /** saved with the message since 2026-11-20 (answersToSave), never sent to the AI (answeredNote): the words its card
   * shows for this answer (a button's or option's words, null for Skip) when no answer of the message was typed; the
   * message is then the cards' choices, not the person's words (Message.cardAnswer, cardAnswerOf) */
  shown?: string | null
  /** saved since 2026-11-20: some answer of this message was typed (the message is the person's own words) */
  typed?: true
  /** saved since 2026-11-20: the labels are hidden in this shared chat (labelsHidden): the line says only "answered" */
  hidden?: true
}

/** Tools whose safety cards (delete, share, a website, a browser site) wait after the answer ends: the call raises
 * its card before it changes anything, so it can end and run again with the answer (chat/turn.ts cardLater) */
export const CARD_LATER_TOOLS: ReadonlySet<string> = new Set(['delete_files', 'share_with_person', 'share_folder', 'stop_sharing', 'web_fetch', 'save_url', ...BROWSER_TOOL_NAMES,
  // since docs/decisions/20261122-late-card-answer-resumes.md: each asks before it changes anything (a room post, members,
  // folder access, a skill's files or place, a scheduled task, a memory). A connected service's tools join by their
  // provider (chat/tools.ts: every tool of the integrations provider but connection_result and find_tools)
  'post_to_room', 'change_project_members', 'change_folder_access', 'skill_files', 'move_skill', 'schedule_create', 'remember',
  // since docs/decisions/20261123-fewer-asks-b5.md: the file tools whose every card (the shared read or save card, the
  // card after a room read, a skill's, the wider-audience card) comes before they write anything. Not with arguments
  // over CARD_LATER_ARGS_MAX (TurnExec.cardLater: such a card waits inside the call as before)
  'write', 'edit', 'make_file'])

/** The largest arguments (as JSON) a waiting call keeps in the database (a write's whole text): a call with more keeps
 * its card inside the call, with its time limit, as before */
export const CARD_LATER_ARGS_MAX = 1024 * 1024

/** Turns of these apps keep the card inside the tool call (see the header): null is a turn the server started itself. */
export const questionsWaitInCall = (clientKind: string | null): boolean => clientKind === null || clientKind === 'schedule' || clientKind === 'slack'

const parse = (s: string): TurnRequest | null => {
  try { const v = JSON.parse(s) as TurnRequest; return v && typeof v.kind === 'string' && typeof v.requestId === 'string' ? v : null } catch { return null }
}
/** what a card asks, in words (a browser site card: its reason) */
const cardWords = (r: TurnRequest): string => (r.kind === 'ask_user' ? r.question : r.kind === 'browser_site' ? r.reason ?? r.host : r.kind === 'dev_env_site' ? r.host : r.name)
const metaOf = (s: string | null | undefined): CallMeta => {
  if (!s) return {}
  try {
    const m = JSON.parse(s) as CallMeta
    if (!m || typeof m !== 'object') return {}
    const a = m.asked
    return {
      ...(a && typeof a.turnId === 'string' && typeof a.userMessageId === 'string' && typeof a.assistantId === 'string' ? { asked: { turnId: a.turnId, userMessageId: a.userMessageId, assistantId: a.assistantId } } : {}),
      ...(typeof m.always === 'string' ? { always: m.always } : {}),
      ...(Array.isArray(m.prior) ? { prior: m.prior.filter((x) => x && typeof x === 'object' && x.card && typeof x.card.kind === 'string') } : {}),
    }
  } catch { return {} }
}
const callOf = (r: Row, card: TurnRequest): WaitingCall | undefined => {
  if (!r.call_tool) return undefined
  let args: unknown = {}
  try { args = JSON.parse(r.call_args ?? '{}') } catch {}
  // a row saved before call_meta: the asking turn is the row's own (its user message read from the turn)
  return { tool: r.call_tool, args, card, window: r.window_id, ...metaOf(r.call_meta) }
}

export function saveQuestion(db: Database, o: { request: TurnRequest; chatId: string; messageId: string; turnId: string; userId: string; call?: { tool: string; args: unknown; window: string | null } & CallMeta }): void {
  const meta: CallMeta | null = o.call ? { ...(o.call.asked ? { asked: o.call.asked } : {}), ...(o.call.always ? { always: o.call.always } : {}), ...(o.call.prior?.length ? { prior: o.call.prior } : {}) } : null
  db.query('INSERT INTO open_questions (request_id, chat_id, message_id, turn_id, user_id, request, answer, created_at, call_tool, call_args, window_id, call_meta) VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?)')
    .run(o.request.requestId, o.chatId, o.messageId, o.turnId, o.userId, JSON.stringify(o.request), new Date().toISOString(),
      o.call?.tool ?? null, o.call ? JSON.stringify(o.call.args ?? {}) : null, o.call?.window ?? null, meta && Object.keys(meta).length ? JSON.stringify(meta) : null)
}

/** The open card of this person in this chat that a call of the same tool with the same arguments left waiting, and
 * that reads the same as `request` (sameCard): its request id, or null. One card per call (QA batch 5 flow 3): the AI
 * that calls the very same thing again while its card waits gets that card, not a second one that would run it twice. */
export function waitingTwin(db: Database, o: { chatId: string; userId: string; tool: string; args: unknown; request: TurnRequest; window?: string | null }): string | null {
  const args = JSON.stringify(o.args ?? {})
  const rows = db.query('SELECT request_id, request FROM open_questions WHERE chat_id = ? AND user_id = ? AND answer IS NULL AND call_tool = ? AND call_args = ? AND window_id IS ?').all(o.chatId, o.userId, o.tool, args, o.window ?? null) as { request_id: string; request: string }[]
  for (const r of rows) { const q = parse(r.request); if (q && sameCard(q, o.request)) return r.request_id }
  return null
}

/** The person's open cards in this chat, oldest first, as GET /api/chats/:id/requests lists cards: a card for one
 * desktop window (a browser site) only to that window. */
export function openQuestionsOf(db: Database, chatId: string, userId: string, window: string | null = null): OpenTurnRequest[] {
  const rows = db.query('SELECT * FROM open_questions WHERE chat_id = ? AND user_id = ? AND answer IS NULL ORDER BY created_at, request_id').all(chatId, userId) as Row[]
  const out: OpenTurnRequest[] = []
  for (const r of rows) {
    if (r.window_id && r.window_id !== window) continue
    const request = parse(r.request); if (request) out.push({ turnId: r.turn_id, chatId: r.chat_id, messageId: r.message_id, request })
  }
  return out
}

/** A question still waits in this chat (for `userId`, when given). */
export function hasOpenQuestion(db: Database, chatId: string, userId?: string): boolean {
  // a card for one desktop window (a browser site) is that window's, not the chat list's (as for a live card)
  return !!(userId === undefined
    ? db.query('SELECT 1 FROM open_questions WHERE chat_id = ? AND answer IS NULL AND window_id IS NULL LIMIT 1').get(chatId)
    : db.query('SELECT 1 FROM open_questions WHERE chat_id = ? AND user_id = ? AND answer IS NULL AND window_id IS NULL LIMIT 1').get(chatId, userId))
}

/** A question of this turn still waits for `userId` (the push of a waiting card is still wanted). */
export function turnQuestionOpen(db: Database, turnId: string, userId: string): boolean {
  return !!db.query('SELECT 1 FROM open_questions WHERE turn_id = ? AND user_id = ? AND answer IS NULL AND window_id IS NULL LIMIT 1').get(turnId, userId)
}

/** The open question `requestId` of `turnId`, the caller's own, or null (answered, closed, someone else's). */
export function openQuestion(db: Database, turnId: string, requestId: string, userId: string): { chatId: string; messageId: string; request: TurnRequest; window: string | null } | null {
  const r = db.query('SELECT * FROM open_questions WHERE request_id = ? AND turn_id = ? AND user_id = ? AND answer IS NULL').get(requestId, turnId, userId) as Row | null
  const request = r ? parse(r.request) : null
  return r && request ? { chatId: r.chat_id, messageId: r.message_id, request, window: r.window_id } : null
}

/** All questions of one answer, answered, in the order they were asked; null while one is still open (or none). */
export function readyAnswers(db: Database, messageId: string, userId: string): { answers: AnsweredQuestion[]; requests: TurnRequest[]; window: string | null } | null {
  const all = db.query('SELECT * FROM open_questions WHERE message_id = ? AND user_id = ? ORDER BY created_at, request_id').all(messageId, userId) as Row[]
  if (!all.length || all.some((x) => x.answer === null)) return null
  const requests = all.map((x) => parse(x.request) ?? { kind: 'ask_user' as const, requestId: x.request_id, question: '' })
  // a waiting call saved before call_meta (migration 444): its asking turn is the row's own turn, the same person's
  const askedOf = (x: Row): AskedIn | undefined => {
    const t = db.query('SELECT id, user_message_id, message_id FROM turns WHERE id = ? AND user_id = ?').get(x.turn_id, x.user_id) as { id: string; user_message_id: string | null; message_id: string | null } | null
    return t?.user_message_id && t.message_id ? { turnId: t.id, userMessageId: t.user_message_id, assistantId: t.message_id } : undefined
  }
  const answers = all.map((x, i) => {
    const call = callOf(x, requests[i]!)
    if (call && !call.asked) { const asked = askedOf(x); if (asked) call.asked = asked }
    return { question: cardWords(requests[i]!), answer: JSON.parse(x.answer!) as unknown, ...(call ? { call } : {}) }
  })
  return { requests, answers, window: all.find((x) => x.window_id)?.window_id ?? null }
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
export function recordAnswer(db: Database, requestId: string, value: unknown): { state: 'closed' } | { state: 'waiting'; also: string[] } | { state: 'ready'; answers: AnsweredQuestion[]; requests: TurnRequest[]; window: string | null; also: string[]; undo(): void } {
  return db.transaction(() => {
    const r = db.query('SELECT * FROM open_questions WHERE request_id = ? AND answer IS NULL').get(requestId) as Row | null
    if (!r) return { state: 'closed' as const }
    const set = db.query('UPDATE open_questions SET answer = ? WHERE request_id = ?')
    set.run(JSON.stringify(value ?? null), requestId)
    // "Always allow" on one waiting card answers every other waiting card of the same kind of this answer with it (the
    // owner, 2026-11-23: "항상 허용하면 뒤에것들은 안해도 되어야지"): their calls run with it, no further card
    const also = alwaysAlso(db, r, value)
    for (const id of also) set.run(JSON.stringify(value ?? null), id)
    const ready = readyAnswers(db, r.message_id, r.user_id)
    if (!ready) return { state: 'waiting' as const, also }
    const undoIds = [requestId, ...also]
    return { state: 'ready' as const, ...ready, also, undo: () => { for (const id of undoIds) db.query('UPDATE open_questions SET answer = NULL WHERE request_id = ?').run(id) } }
  })()
}

/** The other open waiting cards of the same answer and person that offer the same "Always allow" as `r`, when `value`
 * is that Always (each takes it: chat/turn.ts replayCalls keeps the choice once and runs every call). */
function alwaysAlso(db: Database, r: Row, value: unknown): string[] {
  const one = Array.isArray(value) && value.length === 1 ? value[0] : value
  if (one !== ALWAYS_VALUE) return []
  const kind = metaOf(r.call_meta).always
  if (!kind) return []
  const rows = db.query('SELECT * FROM open_questions WHERE message_id = ? AND user_id = ? AND answer IS NULL AND request_id <> ?').all(r.message_id, r.user_id, r.request_id) as Row[]
  return rows.filter((x) => {
    if (metaOf(x.call_meta).always !== kind || (x.window_id ?? null) !== (r.window_id ?? null)) return false
    const card = parse(x.request)
    return card?.kind === 'ask_user' && (card.options ?? []).some((o) => o.value === one)
  }).map((x) => x.request_id)
}

/** A new turn starts in the chat: the AI's own questions still there go (answered ones with their turn, the rest because
 * the conversation went on without them). A waiting call's card stays, unanswered, with any answered card of the same
 * answer (docs/decisions/20261122-late-card-answer-resumes.md: the person typed instead of pressing; the card still
 * runs that call when pressed, and the new turn's AI is told it waits, waitingCardsNote). What the apps are told to
 * close; `question`: the AI's own ask_user question, for closedQuestionNote (null for the server's safety cards: delete,
 * share, a site, which name files, people and links only their asker sees). */
export function closeChatQuestions(db: Database, chatId: string, under: string | null = null): { requestId: string; turnId: string; userId: string; answered: boolean; question: string | null }[] {
  const rows = db.query('SELECT request_id, message_id, turn_id, user_id, answer, request, call_tool FROM open_questions WHERE chat_id = ?').all(chatId) as Pick<Row, 'request_id' | 'message_id' | 'turn_id' | 'user_id' | 'answer' | 'request' | 'call_tool'>[]
  if (!rows.length) return []
  // a message whose waiting call's card is still open keeps its call cards (answered or not), while the new turn goes
  // on under its asking answer (`under`: the new turn's user message): an edit, a regenerate or another branch went on
  // without it, so its card goes there as an AI question does
  // (a turn with no message of its own, a scheduled run: the chat did not go on from a branch, the cards stay)
  const onBranch = (id: string) => !under || descends(db, under, id)
  const waiting = new Set(rows.filter((r) => r.call_tool && r.answer === null && onBranch(r.message_id)).map((r) => `${r.message_id}\u0000${r.user_id}`))
  const keep = (r: (typeof rows)[number]) => !!r.call_tool && waiting.has(`${r.message_id}\u0000${r.user_id}`)
  const gone = rows.filter((r) => !keep(r))
  if (!gone.length) return []
  const del = db.query('DELETE FROM open_questions WHERE request_id = ?')
  for (const r of gone) del.run(r.request_id)
  return gone.map((r) => {
    const card = parse(r.request)
    return { requestId: r.request_id, turnId: r.turn_id, userId: r.user_id, answered: r.answer !== null, question: card?.kind === 'ask_user' && card.origin !== 'server' && !r.call_tool ? card.question : null }
  })
}

/** `id` is `ancestor` or comes after it in the chat's message tree (parent_id links; fails closed after many steps). */
export function descends(db: Database, id: string, ancestor: string): boolean {
  const up = db.query('SELECT parent_id FROM messages WHERE id = ?')
  let at: string | null = id
  for (let i = 0; at && i < 5000; i++) {
    if (at === ancestor) return true
    at = (up.get(at) as { parent_id: string | null } | null)?.parent_id ?? null
  }
  return false
}

/** Where the turn a late press starts goes on (routes/chats.ts answerLater, ChatRuntime.startAnsweredTurns): the chat's
 * newest answer when it comes after the asking answer (the card stayed while the chat went on), else the asking answer
 * (the person switched to another branch since: the press goes on where the card was asked). */
export const pressParent = (db: Database, leaf: string | null, asking: string): string => (leaf && descends(db, leaf, asking) ? leaf : asking)

/** The engine message's block when a waiting call's card of this person is still open in the chat (or ''): the
 * person wrote instead of pressing it. Their message never answers it (a safety card is decided by its buttons). */
export function waitingCardsNote(db: Database, chatId: string, userId: string, turnId: string): string {
  // (a card this turn raised itself, running a call again, is not an earlier one)
  const rows = db.query('SELECT call_tool FROM open_questions WHERE chat_id = ? AND user_id = ? AND turn_id != ? AND answer IS NULL AND call_tool IS NOT NULL ORDER BY created_at').all(chatId, userId, turnId) as { call_tool: string }[]
  if (!rows.length) return ''
  const tools = [...new Set(rows.map((r) => r.call_tool))].slice(0, 10)
  return `<waiting_card>\nA card of your earlier ${tools.length > 1 ? 'calls' : 'call'} (${tools.join(', ')}) still waits above for the user's press; nothing of ${tools.length > 1 ? 'them' : 'it'} was done. This message does not answer it: only the card's own buttons do. If the message is about it (a yes, "go ahead", "allow"), say in one short line that they can press the button on the card above and it will run right then; never call that tool again for the same thing (that makes a second card). Otherwise answer the message as usual.\n</waiting_card>`
}

/** The questions of other people's answers a person's message closed unanswered in a shared chat (QA S-125): the next
 * turn's engine message names them, so another person's request is not dropped without a word (prompt.ts sharedSection
 * "opposite requests"). `name`: the asker's label name (chat/shared.ts labelName). '' when there are none. */
export function closedQuestionNote(closed: readonly { name: string; question?: string }[]): string {
  if (!closed.length) return ''
  // the words inside the block, never a tag of their own (as answeredNote). A question without its words: its answer is
  // kept from some who see the chat (runtime.ts closedOthers), so only who asked
  const json = JSON.stringify(closed.map((c) => (c.question === undefined ? { person: c.name } : { person: c.name, question: c.question.slice(0, 300) }))).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  const hidden = closed.some((c) => c.question === undefined) ? ' A question without its words is private to its asker: never guess or repeat what it was about; only say that their question is still open.' : ''
  return `<closed_question>\nThis message closed ${closed.length > 1 ? 'questions' : 'a question'} you had asked another person here about their own request, still unanswered: ${json}.${hidden} Their request is not done. If this message asks for something that contradicts it, follow the "Opposite requests" rule; otherwise do what this message asks and add one line that their request still needs their answer and they can reply in this chat.\n</closed_question>`
}

/** Each answer in words: the picked options by their labels (`picked`: as these words instead), a site card's choice in
 * the person's words (`decisions`), `skipped` for Skip, typed text as typed (`typed` true: some answer was the person's
 * own text, not a card's choice). */
function answerLabels(answers: AnsweredQuestion[], requests: readonly TurnRequest[], skipped: string, decisions: Partial<Record<string, string>>, picked?: string): { labels: string[]; skips: boolean[]; typed: boolean } {
  let typed = false
  const label = (i: number, v: unknown): string => {
    if (v === null || v === undefined) return skipped
    const r = requests[i]
    // a browser or dev-environment site card answers once / always / deny: in the person's words
    if (r && r.kind !== 'ask_user' && typeof v === 'string' && decisions[v]) return decisions[v]!
    const opts = r?.kind === 'ask_user' ? r.options ?? [] : []
    const one = (x: unknown) => {
      const s = typeof x === 'string' ? x : JSON.stringify(x)
      const o = opts.find((y) => y.value === s)
      if (!o) typed = true
      return o ? picked ?? o.label : s
    }
    return Array.isArray(v) ? v.map(one).join(', ') : one(v)
  }
  const labels = answers.map((a, i) => label(i, a.answer))
  return { labels, skips: answers.map((a) => a.answer === null || a.answer === undefined), typed }
}

/** What the answer's user message says on screen: the picked options by their labels, typed text as typed, `skipped`
 * for a question the person skipped (Skip on the card: the AI goes on without that answer); with several questions,
 * one line each after its question. This is also what the AI reads of the answer in later turns (a history rebuilt for
 * a new session or another engine), so the questions stay; the apps show a message of the cards' choices alone as one
 * quiet line (Message.cardAnswer), never this text. */
export function answerText(answers: AnsweredQuestion[], requests: readonly TurnRequest[], skipped: string, decisions: Partial<Record<string, string>> = {}, picked?: string): string {
  const { labels } = answerLabels(answers, requests, skipped, decisions, picked)
  if (answers.length === 1) return labels[0]!
  // the questions are the AI's words too: with the labels hidden (`picked`), so are they (one line per answer)
  if (picked !== undefined) return labels.join('\n')
  return answers.map((a, i) => `${a.question}\n${labels[i]}`).join('\n\n')
}

const decisionWords = (L: Locale) => ({ once: tr('siteOnce', L), always: tr('siteAlways', L), deny: tr('siteDeny', L) })

/** The visible message of an answer (answerText) in the person's words: Skip, and a site card's choices */
export const answerWords = (answers: AnsweredQuestion[], requests: readonly TurnRequest[], L: Locale, hideLabels = false): string =>
  answerText(answers, requests, tr('questionSkipped', L), decisionWords(L), hideLabels ? tr('questionAnswered', L) : undefined)

/** The answers as they are saved with the message (saveAnswered), each marked: typed (some answer was the person's own
 * text: their message), or the words its card shows (`shown`, null for Skip), with `hidden` when the labels are hidden
 * in a shared chat. cardAnswerOf reads these marks; only rows saved before them go by the older rules. */
export function answersToSave(answers: AnsweredQuestion[], requests: readonly TurnRequest[], L: Locale, hideLabels = false): AnsweredQuestion[] {
  const { labels, skips, typed } = answerLabels(answers, requests, tr('questionSkipped', L), decisionWords(L))
  if (typed) return answers.map((a) => ({ ...a, typed: true as const }))
  return answers.map((a, i) => ({ ...a, shown: skips[i] ? null : labels[i]!, ...(hideLabels && !skips[i] ? { hidden: true as const } : {}) }))
}

/** A safety card is decided by its own buttons only (as when it waited inside its call, TurnExec.answer): a typed
 * answer is not one of them. True: this answer may go to it. */
export function cardAnswerOk(r: TurnRequest, value: unknown): boolean {
  if (value === null || r.kind !== 'ask_user' || r.origin !== 'server') return true
  const one = Array.isArray(value) && value.length === 1 ? value[0] : value
  return typeof one === 'string' && (r.options ?? []).some((o) => o.value === one)
}

/**
 * In a shared chat, the card's option labels are the AI's words from the asking answer, which may hold what a connected
 * service returned (shared_answer_reads k) or what is not all known (x): that answer is hidden from people who join
 * later and may not read it (chat/shared-answers.ts), and the person's message under it must not repeat it. Then a
 * picked option shows as plain words ("Answered the AI's question"); typed text is the person's own, as any message.
 */
export function labelsHidden(db: Database, shared: boolean, askingId: string): boolean {
  if (!shared) return false
  const rec = answerRecord(db, askingId)
  return !rec || rec.reads.some((g) => !!g.k || !!g.x)
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
  if (!Array.isArray(list)) return ''
  // the safety cards' calls run again at the turn's start (chat/turn.ts replayCalls): they say what happened themselves
  list = list.filter((a) => !a.call)
  // the apps' marks (answersToSave) are not the AI's business
  list = list.map(({ shown: _s, typed: _t, hidden: _h, ...a }) => a)
  if (!list.length) return ''
  // a skipped question reads as it did when the card closed without an answer ({"skipped": true})
  list = list.map((a) => (a.answer === null || a.answer === undefined ? { question: a.question, skipped: true } as unknown as AnsweredQuestion : a))
  // (the questions and answers inside the block, never a tag of their own: < and > as JSON escapes, the same text)
  const json = JSON.stringify(list).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  return `<answered_questions>\nThis message is the user's answer to the question${list.length > 1 ? 's' : ''} you asked with ask_user in your previous answer (the card waited until they answered). Each answer as the card gave it: ${json}\nContinue the work from there.\n</answered_questions>`
}

/** A safety card's button value in words (a row saved before the marks: its card is kept with its call) */
function buttonWords(card: TurnRequest | undefined, v: unknown, decisions: Partial<Record<string, string>>): string | null {
  const one = Array.isArray(v) && v.length === 1 ? v[0] : v
  if (!card || typeof one !== 'string') return null
  if (card.kind === 'ask_user') return card.options?.find((o) => o.value === one)?.label ?? null
  return decisions[one] ?? null
}

/** What a message of the cards' choices shows (Message.cardAnswer): each card's words (null for Skip), or `hidden`
 * when the labels are hidden in a shared chat (the line says only "answered"). */
export interface CardAnswer { choices: (string | null)[]; hidden?: true }

/**
 * The cards' choices this user message is (Message.cardAnswer), or null: the message is the person's own words (some
 * answer was typed) or answers no card. Rows saved since 2026-11-20 carry their marks (answersToSave). A row saved
 * before them is read only when every answer is a safety card's (kept with its call: its own buttons only, never typed
 * text), by the card's button; an older answer to the AI's own question cannot be told from typed text, so that
 * message stays as it was.
 */
export function cardAnswerOf(db: Database, messageId: string, L: () => Locale): CardAnswer | null {
  const r = db.query('SELECT questions FROM answered_questions WHERE message_id = ?').get(messageId) as { questions: string } | null
  if (!r) return null
  let list: AnsweredQuestion[]
  try { list = JSON.parse(r.questions) } catch { return null }
  if (!Array.isArray(list) || !list.length || list.some((a) => !a || typeof a !== 'object')) return null
  if (list.some((a) => a.typed)) return null
  const choices: (string | null)[] = []
  let hidden = false
  for (const a of list) {
    if (a.shown === null || typeof a.shown === 'string') { choices.push(a.shown); if (a.hidden) hidden = true; continue }
    // a row saved before the marks: a safety card's only
    if (!a.call) return null
    if (a.answer === null || a.answer === undefined) { choices.push(null); continue }
    const words = buttonWords(a.call.card, a.answer, decisionWords(L()))
    if (words === null) return null
    choices.push(words)
  }
  return hidden ? { choices: [], hidden: true } : { choices }
}

/**
 * The calls this user message's answers run again (chat/turn.ts replayCalls), each with the card it raised and the
 * person's answer, in the order they were asked; taken by `turnId` in the same step, once: a regenerate, an edit's
 * retry or any later turn of the same message gets none (`ran`: they were taken by an earlier turn), so a saved yes
 * never runs again without a card.
 */
export function takeAnsweredCalls(db: Database, messageId: string, turnId: string): { calls: (WaitingCall & { answer: unknown })[]; ran: boolean } {
  return db.transaction(() => {
    const r = db.query('SELECT questions, calls_ran_turn FROM answered_questions WHERE message_id = ?').get(messageId) as { questions: string; calls_ran_turn: string | null } | null
    if (!r) return { calls: [], ran: false }
    const calls = callsIn(r.questions)
    if (!calls.length) return { calls, ran: false }
    if (r.calls_ran_turn !== null) return { calls: [], ran: r.calls_ran_turn !== turnId }
    db.query('UPDATE answered_questions SET calls_ran_turn = ? WHERE message_id = ? AND calls_ran_turn IS NULL').run(turnId, messageId)
    return { calls, ran: false }
  })()
}
function callsIn(questions: string): (WaitingCall & { answer: unknown })[] {
  try {
    const list = JSON.parse(questions) as AnsweredQuestion[]
    return Array.isArray(list) ? list.flatMap((a) => (a.call ? [{ ...a.call, answer: a.answer }] : [])) : []
  } catch { return [] }
}

/** The card a call raises again (`now`) is the card the person answered (`answered`): the same kind, rows and choices,
 * and its words the same, or the answered card's with a reason paragraph fewer (a reason that no longer holds; a new
 * reason is a different card). A card that reads differently now, because something changed, is asked again. The Always
 * allow choice, the time limit and the changed line (CHANGED_MARK) are not compared: they depend on the moment. */
export function sameCard(answered: TurnRequest, now: TurnRequest): boolean {
  if (answered.kind !== now.kind) return false
  const strip = (r: TurnRequest) => {
    const { requestId: _i, expiresAt: _e, ...rest } = r as TurnRequest & { expiresAt?: string }
    const x = { ...rest } as Record<string, unknown>
    if (Array.isArray(x.options)) x.options = (x.options as { value: string }[]).map((o) => o.value).filter((v) => v !== ALWAYS_VALUE).sort()
    delete x.note
    // how the app groups the card with others of the same answer (AskUserRequest.batch): presentation only
    delete x.batch
    if (x.share && typeof x.share === 'object') { const { why: _w, ...share } = x.share as Record<string, unknown>; x.share = share }
    const question = typeof x.question === 'string' ? x.question : null
    delete x.question
    return { rest: stable(x), paras: question === null ? null : paragraphs(question) }
  }
  const a = strip(answered), b = strip(now)
  if (a.rest !== b.rest) return false
  if (a.paras === null || b.paras === null) return a.paras === b.paras
  // the card now is the card answered with some of its reason lines (REASON_LINES) left out, nothing else
  let i = 0
  for (const p of a.paras) {
    if (p === b.paras[i]) i++
    else if (!REASON_LINES.has(p)) return false
  }
  return i === b.paras.length
}
/** The first paragraph of a card re-raised because it reads differently since the person's press (chat/turn.ts) */
export const CHANGED_MARK = '\u2063'
const paragraphs = (q: string) => q.split(/\n{2,}/).map((p) => placeCountsOff(p.trim())).filter((p) => p && !p.startsWith(CHANGED_MARK))
/** A place of a post card's sources line with how many files were read there ("내 파일의 파일 1개", "1 file in My
 * folder": chat/post-to-room.ts placeName), in every language: the count shows only when the answer's saved list holds
 * every file read there, so the run after a press (which reads that saved list) counts a source the live run named
 * without one. The same place for the same people is the same card (QA of #414: a post re-asked "Something changed"
 * for that alone). The people count and the places are still compared. */
const PLACE_COUNTS: readonly RegExp[] = (() => {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = new Map<string, RegExp>()
  for (const L of Object.keys(TEXT.postRoomPlaceFiles) as Locale[]) {
    for (const n of ['1', '2']) {
      const s = tr('postRoomPlaceFiles', L, { place: '\uE000', n })
      const src = `^${esc(s).replace('\uE000', '(.+)').replace(n, '\\d+')}$`
      out.set(src, new RegExp(src, 'u'))
    }
  }
  return [...out.values()]
})()
/** `p` with each place inside the sources line's brackets "(…)" / "（…）" named without its file count */
function placeCountsOff(p: string): string {
  return p.replace(/([(（])([^()（）]*)([)）])/g, (_m, open: string, inside: string, close: string) =>
    open + inside.split(', ').map((x) => { for (const re of PLACE_COUNTS) { const m = re.exec(x); if (m) return m[1]! } return x }).join(', ') + close)
}
/** The lines a server card leads with to say why it asks first (rooms read here, a file someone shared, a target taken
 * from the screen), in every language: the only paragraphs a card may have lost since the press and still be the same
 * card (that reason no longer holds now; the card asked more carefully when it was pressed). Any other paragraph, and
 * any new one, makes another card. */
const REASON_LINES: ReadonlySet<string> = new Set((['roomsSeenWhy', 'sharedFileSeenWhy', 'lookedWhy'] as const).flatMap((k) => Object.values(TEXT[k]).map((x) => String(x).trim())))

/** The answer is the card's no: Skip (null), its last option (the no comes last on every server card: withAlways), a
 * site's deny. Such an answer never runs the call again (docs/decisions/20261122-late-card-answer-resumes.md). */
export function declined(card: TurnRequest, answer: unknown): boolean {
  if (answer === null || answer === undefined) return true
  const one = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer
  if (card.kind === 'browser_site' || card.kind === 'dev_env_site') return one === 'deny'
  if (card.kind !== 'ask_user') return false
  const last = card.options?.at(-1)?.value
  return card.origin === 'server' && typeof one === 'string' && last !== undefined && one === last && (card.options?.length ?? 0) > 1
}
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  : JSON.stringify(v ?? null)

/** The turn a waiting card was raised in (null: no such card). */
export function turnOfQuestion(db: Database, requestId: string): string | null {
  return (db.query('SELECT turn_id FROM open_questions WHERE request_id = ?').get(requestId) as { turn_id: string } | null)?.turn_id ?? null
}
