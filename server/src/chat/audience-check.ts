// What new people would start to see in a chat, answer by answer (docs/DECISIONS.md "Share in one press", QA TC-3092;
// plan docs/AGENTS/plan/20261115-1400-share-dialog-one-press.md). One check behind the Share dialog's preview
// (POST /api/chats/:id/audience/preview), its save (PUT /api/chats/:id/audience: the key below must match), the widening
// list of one chat, and the project members' share of a private chat (chat/share-chat.ts). What is shown and what is
// enforced come from the same function, so they never drift apart.
//
// For the people who would start to see it (`newPeople`; never named here: only counts and places the sharer may look):
//   memoryAnswers   answers of the chat's private time written while the sharer had a personal memory (a turn of a
//                   private chat carries the memories in its instructions; a shared chat's never)
//   fileAnswers     answers whose own files (message_sources) a new person can't open and the hash rule does not cover,
//                   with the answers whose recorded places they can't open (chat/widening.ts: an already shared chat)
//   accountAnswers  older answers the read scope does not describe (it empties when a session starts on a first message)
//                   while a personal connection (a personal service, personal Google Drive) or the in-app browser was
//                   on for the sharer: what they read only the sharer saw
//   places          the scope's places a new person can't open (rooms, team connections, shared Drives, unlisted team
//                   files: not tied to one answer), named only where the sharer may look; `otherPlaces` for the rest
//   roomsUnseen     the chat read team chat rooms and the scope does not say which: someone new may not be in them
//   unchecked       answers nothing can be said about (the scope gap without personal accounts, dev environment
//                   commands): a grey line, no warning
// `hidden`: a new person would see a room it read but for old answers hidden from them (never shared, whatever is
// confirmed).
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { AnswerSharePlace } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { loadPrincipal } from '../policy/access'
import { confidentialChat } from '../safe-ops/confidential'
import { BROWSER_TOOL_NAMES } from '../realtime/browser-tools'
import { filesRead, provenanceChecker, withSkillReads, type BranchUse, type CountedSource } from './answer-share'
import { scopeWithListing, sourceKey, type ReadSource } from './read-scope'
import { instructionFiles } from './prompt'
import { roomMessagesSeen } from './read-rooms'

/** What the check found, with what the saved record needs (`use`). Ids sorted. */
export interface AudienceFindings {
  newPeople: string[]
  memoryAnswers: string[]
  fileAnswers: string[]
  accountAnswers: string[]
  places: AnswerSharePlace[]
  otherPlaces: boolean
  roomsUnseen: boolean
  unchecked: string[]
  hidden: boolean
  /** the people being added whom one of the warnings is about (they miss a place or a file, or every new person for
   * memories, personal accounts and rooms): the Share dialog names only the picks that bring one in (QA TC-7042) */
  missing: string[]
  /** the provenance keys (sources and who misses each) the confirm key binds */
  sourceKeys: string[]
  /** per answer: the new people it widens to and the counted places it used (the widening list of one chat) */
  perAnswer: Map<string, { widens: Set<string>; sources: ReadSource[] }>
  use: BranchUse
}

/** The chat's answers, in the order written (rowid), with their time. */
function answersOf(db: Database, chatId: string): { id: string; rid: number; at: string }[] {
  return db.query("SELECT id, rowid AS rid, created_at AS at FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY rowid").all(chatId) as { id: string; rid: number; at: string }[]
}

/** The answers the read scope does not describe: those before the newest answer to a first message (the scope empties
 * when a session starts on a first message: chat/turn.ts newSession). */
function scopeGap(db: Database, chatId: string, answers: readonly { id: string; rid: number }[]): string[] {
  const first = db.query(`SELECT a.rowid AS rid FROM messages a JOIN messages q ON q.id = a.parent_id
    WHERE a.chat_id = ? AND a.role = 'assistant' AND q.parent_id IS NULL ORDER BY a.rowid DESC LIMIT 1`).get(chatId) as { rid: number } | null
  if (!first) return answers.map((a) => a.id)
  return answers.filter((a) => a.rid < first.rid).map((a) => a.id)
}

/** The answers that ran dev environment commands (a box_shell step, or the dev_env.command audit line of their turn). */
function devAnswers(db: Database, ids: readonly string[]): Set<string> {
  const out = new Set<string>()
  if (!ids.length) return out
  const list = JSON.stringify(ids)
  for (const r of db.query(`SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND (steps LIKE '%box_shell"%' OR steps LIKE '%"devEnvRun"%')`).all(list) as { id: string }[]) out.add(r.id)
  const turns = db.query(`SELECT t.id AS turn, t.message_id AS msg FROM turns t WHERE t.message_id IN (SELECT value FROM json_each(?))
    UNION SELECT m.turn_id AS turn, m.id AS msg FROM messages m WHERE m.id IN (SELECT value FROM json_each(?)) AND m.turn_id IS NOT NULL`).all(list, list) as { turn: string; msg: string }[]
  if (turns.length) {
    const ran = new Set((db.query(`SELECT json_extract(detail, '$.turnId') AS t FROM audit_log WHERE action = 'dev_env.command'
      AND json_extract(detail, '$.turnId') IN (SELECT value FROM json_each(?))`).all(JSON.stringify(turns.map((t) => t.turn))) as { t: string }[]).map((r) => r.t))
    for (const t of turns) if (ran.has(t.turn)) out.add(t.msg)
  }
  return out
}

/** Answers of the chat's private time written while `userId` had a personal memory: a memory made by then, or one
 * deleted (memory.delete, memory.clear, the AI's forget) after it was written. `sharedAt`: when it was first shared
 * (people_shared_at or shared_at); later answers are a shared chat's, which never carry memories. */
function memoryAnswersOf(db: Database, userId: string, answers: readonly { id: string; at: string }[], sharedAt: string | null): string[] {
  const own = answers.filter((a) => !sharedAt || a.at < sharedAt)
  if (!own.length) return []
  const firstMemory = (db.query('SELECT MIN(created_at) AS at FROM memories WHERE user_id = ?').get(userId) as { at: string | null }).at
  const lastDelete = (db.query("SELECT MAX(at) AS at FROM audit_log WHERE actor_id = ? AND action IN ('memory.delete', 'memory.clear')").get(userId) as { at: string | null }).at
  const lastForget = (db.query(`SELECT MAX(m.created_at) AS at FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.user_id = ? AND m.role = 'assistant'
    AND m.steps LIKE '%"tool":"forget"%'`).get(userId) as { at: string | null }).at
  const lastGone = [lastDelete, lastForget].filter((x): x is string => !!x).sort().pop() ?? null
  return own.filter((a) => (firstMemory !== null && a.at >= firstMemory) || (lastGone !== null && a.at <= lastGone)).map((a) => a.id)
}

/** Was a personal connection or the in-app browser on for `userId` while these answers ran (`span`: the first and last
 * one's time)? A personal service or Google Drive connected by the last one and not removed before the first one, or a
 * browser step in them. */
function personalAccountsOn(db: Database, userId: string, ids: readonly string[], span: { first: string; last: string }): boolean {
  if (!ids.length) return false
  if (db.query("SELECT 1 FROM integrations WHERE scope = 'personal' AND owner_user_id = ? AND created_at <= ? LIMIT 1").get(userId, span.last)) return true
  if (db.query('SELECT 1 FROM drive_connections WHERE user_id = ? AND created_at <= ? LIMIT 1').get(userId, span.last)) return true
  // removed since: it was on before then
  if (db.query(`SELECT 1 FROM audit_log WHERE actor_id = ? AND at >= ? AND (action = 'drive.disconnected'
    OR (action = 'integration.delete' AND json_extract(detail, '$.scope') = 'personal')) LIMIT 1`).get(userId, span.first)) return true
  const browser = [...BROWSER_TOOL_NAMES].map((n) => `%"tool":"${n}"%`)
  return !!db.query(`SELECT 1 FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND (${browser.map(() => 'steps LIKE ?').join(' OR ')}) LIMIT 1`).get(JSON.stringify(ids), ...browser)
}

/**
 * The check of `chatId` for `newPeople` (ids, the sharer left out), as `userId` (its creator) may be told it.
 * `recorded`: the answers whose recorded places they can't open (chat/widening.ts), with the people each widens to.
 */
export async function checkAudience(ctx: AppContext, userId: string, chatId: string, newPeople: readonly string[],
  o: { sharedAt: string | null; recorded?: Map<string, Set<string>> }): Promise<AudienceFindings> {
  const db = ctx.db
  const answers = answersOf(db, chatId)
  const ids = answers.map((a) => a.id)
  const gap = new Set(scopeGap(db, chatId, answers))
  const dev = devAnswers(db, ids)
  const confidential = confidentialChat(db, chatId)
  // the scope describes the answers after the gap: its sources count for the chat (not for one answer); a confidential
  // chat's scope is not looked at (it is never shared: the callers refuse it first)
  const scope = confidential ? null : scopeWithListing(db, chatId)
  const unended = ids.length > 0 && !!db.query(`SELECT 1 FROM turns WHERE message_id IN (SELECT value FROM json_each(?)) AND status IN ('queued','running','interrupted') LIMIT 1`).get(JSON.stringify(ids))
  // the chat's own files and work folder ({type:'chat'} of this chat, chat/read-scope.ts): the people being added see them
  // once they are in it (an answer hidden from one of them is `hidden` below), so they are no place they miss (QA TC-7042:
  // a chat that only made a video warned of "Direct messages and private channels")
  const own = (s: ReadSource) => s.type === 'chat' && s.id === chatId
  const other = (scope?.sources ?? []).filter((s) => !own(s) && (unended || !scope!.listed(s)))
  const chat = db.query('SELECT rooms_seen FROM chats WHERE id = ?').get(chatId) as { rooms_seen: number } | null
  // it read rooms and the scope does not say which (or older answers read them before the scope began)
  const roomsUnseen = roomMessagesSeen(chat?.rooms_seen) && (gap.size > 0 || !(scope?.sources ?? []).some((s) => s.type === 'room'))
  const base: BranchUse = { answers: ids, files: filesRead(db, ids), other, known: true, roomsUnseen }
  const sender = loadPrincipal(db, userId)
  // a guest among them: what the chat took from skills/ and the instructions every turn carries count too
  const use = withSkillReads(db, base, newPeople, sender ? instructionFiles(ctx.files, sender) : [])
  const pc = provenanceChecker(ctx, userId, newPeople, ids)
  const prov = await pc.of([use], new Set())

  // each answer's own files that count, and who misses them
  const countedFiles = new Map<string, CountedSource>()
  for (const c of prov.counted) if (!own(c.source)) for (const f of c.files) countedFiles.set(f, c)
  const perAnswer = new Map<string, { widens: Set<string>; sources: ReadSource[] }>()
  const attributed = new Set<string>()
  if (countedFiles.size && ids.length) {
    for (const r of db.query(`SELECT message_id, path FROM message_sources WHERE message_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as { message_id: string; path: string }[]) {
      const c = countedFiles.get(r.path)
      if (!c) continue
      attributed.add(r.path)
      const x = perAnswer.get(r.message_id) ?? perAnswer.set(r.message_id, { widens: new Set(), sources: [] }).get(r.message_id)!
      for (const id of c.missing) x.widens.add(id)
      if (!x.sources.some((s) => sourceKey(s) === c.key)) x.sources.push(c.source)
    }
  }
  for (const [id, people] of o.recorded ?? []) {
    const x = perAnswer.get(id) ?? perAnswer.set(id, { widens: new Set(), sources: [] }).get(id)!
    for (const p of people) x.widens.add(p)
  }
  // the places line: what counts and is not one answer's (the scope's places, the instructions a guest's check adds)
  const places = new Map<string, AnswerSharePlace>()
  let otherPlaces = false
  const missing = new Set<string>()
  for (const c of prov.counted) {
    if (own(c.source)) continue
    if (!c.fromScope && [...c.files].every((f) => attributed.has(f))) continue
    for (const id of c.missing) missing.add(id)
    // a room the scope names: its own line says rooms (roomsUnseen) only when it does not say which
    const p = pc.placeOf(c.source)
    if (p) places.set(JSON.stringify(p), p)
    else otherPlaces = true
  }

  const memoryAnswers = memoryAnswersOf(db, userId, answers, o.sharedAt)
  // the scope gap: personal accounts on then, or nothing to say (grey)
  const gapIds = ids.filter((id) => gap.has(id))
  const at = new Map(answers.map((a) => [a.id, a.at]))
  const accounts = gapIds.length > 0 && personalAccountsOn(db, userId, gapIds, { first: at.get(gapIds[0]!)!, last: at.get(gapIds[gapIds.length - 1]!)! })
  const accountAnswers = accounts ? gapIds : []
  const unchecked = ids.filter((id) => (gap.has(id) && !accounts) || (dev.has(id) && !(accounts && gap.has(id))))
  const everyone = new Set(newPeople)
  for (const id of [...memoryAnswers, ...accountAnswers]) {
    const x = perAnswer.get(id) ?? perAnswer.set(id, { widens: new Set(), sources: [] }).get(id)!
    for (const p of everyone) x.widens.add(p)
  }
  const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()
  const fileAnswers = sorted([...perAnswer].filter(([id, x]) => x.widens.size && (x.sources.length || o.recorded?.has(id))).map(([id]) => id))
  for (const id of fileAnswers) for (const p of perAnswer.get(id)!.widens) missing.add(p)
  if (memoryAnswers.length || accountAnswers.length || otherPlaces || (roomsUnseen && newPeople.length > 0)) for (const p of newPeople) missing.add(p)
  return {
    newPeople: [...newPeople].sort(),
    memoryAnswers: sorted(memoryAnswers),
    fileAnswers,
    accountAnswers: sorted(accountAnswers),
    places: [...places.values()],
    otherPlaces,
    roomsUnseen: roomsUnseen && newPeople.length > 0,
    unchecked: sorted(unchecked),
    hidden: prov.hidden,
    missing: sorted([...missing].filter((p) => everyone.has(p))),
    sourceKeys: prov.keys,
    perAnswer,
    use,
  }
}

/** Does anything put something at stake (the warning, the yellow box)? */
export const atStake = (f: Pick<AudienceFindings, 'memoryAnswers' | 'fileAnswers' | 'accountAnswers' | 'places' | 'otherPlaces' | 'roomsUnseen'>): boolean =>
  f.memoryAnswers.length > 0 || f.fileAnswers.length > 0 || f.accountAnswers.length > 0 || f.places.length > 0 || f.otherPlaces || f.roomsUnseen

/** What a key binds of the findings: the answer ids, not counts (a "2" seen is no yes for another 2). */
export const findingsState = (f: AudienceFindings) => ({
  newPeople: f.newPeople, sources: f.sourceKeys, memoryAnswers: f.memoryAnswers, fileAnswers: f.fileAnswers, accountAnswers: f.accountAnswers,
  places: f.places, otherPlaces: f.otherPlaces, roomsUnseen: f.roomsUnseen, unchecked: f.unchecked,
})

/** A fingerprint of the folder rules (the preview cache's). */
export const rulesFingerprint = (ctx: AppContext): string => createHash('sha256').update(JSON.stringify(ctx.files.rules().world())).digest('base64url')

