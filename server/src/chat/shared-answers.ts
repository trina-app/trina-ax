// Who sees an answer of a shared project chat (docs/DECISIONS.md "Shared project chats", "People who see a shared chat
// later: nothing new is hidden"; migrations 273, 296). The chat is seen by whoever sees its project now (chat/shared.ts).
// From the cutover (settings 'hidden_answers_cutover', written once by migration 296) on, no answer is hidden from
// anyone who sees the chat: the read card before reading says that what it finds stays in the chat for everyone who sees
// it, people who get access later included (QA TC-1404). An answer made before the cutover keeps the old rule where no
// card covered it: it stays visible to the person whose turn it was, to the people who saw the chat when it read what it
// used (the read card's audience, or everyone then when nobody missed a place), to anyone who may read every one of
// those places themselves now, and for a group a card's yes covered (y) to everyone. Everyone else gets one line in its
// place (Message.withheld) and nothing of it anywhere: not in the app or the API, a search, an export, a room's AI, or
// the engine of their own turns in the chat. The rule only ever shows more than before, never less.
//
//   shared_answer_reads.reads     groups {c, s, x?, y?}: the people who saw the chat (c) when the places (s) were read;
//                                 x: what it read is not all known, so only c (an answer from before the table, a chat
//                                 shared later whose check could not tell); y: a read card's yes covered it (written by
//                                 the card from now on, and by migration 296 for the groups of a turn whose audit row
//                                 chat.shared_read says 'shared'). Still written for every answer: nothing is hidden by
//                                 a new one, but explicit widening warns from them (chat/widening.ts)
//   shared_answer_reads.left_out  the answers above it on its branch that its runner did not see: they were not in its
//                                 context (a fresh session gets the transcript as its runner sees it), so they keep
//                                 nothing of it hidden from anyone
//
// For an older answer the walk goes down each branch, so an answer built on one hidden from a viewer is hidden from them
// too, unless that one was left out of its context. An older answer without a row (or with one that cannot be read) is
// hidden from everyone but its runner (fails closed). An answer from the cutover on (and not before its chat was shared)
// is not hidden, also one built on an older hidden answer its runner could see (as if they had copied it by hand:
// written down, accepted), but for an x group: what it read is not all known, so only that group's people see it.
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import { loadPrincipal, type Principal, type RuleSet } from '../policy/access'
import { sourceKey, viewersOf, type ReadSource } from './read-scope'

/** What an answer read while these people saw the chat. `x`: not all of it is known (only `c` may see it); `y`: a read
 * card's yes covered it (an answer from before the cutover is not hidden for it). */
export interface ReadGroup { c: string[]; s: ReadSource[]; x?: 1; y?: 1 }

/** The settings key of the cutover (migration 296). */
export const CUTOVER_KEY = 'hidden_answers_cutover'
const cutovers = new WeakMap<Database, string>()

/** The time from which no answer is hidden (ISO, as messages.created_at and room_messages.created_at), read once per
 * database; null when it is not there (then the old rule applies to every answer: hides more, never less). */
export function hiddenAnswersCutover(db: Database): string | null {
  const kept = cutovers.get(db)
  if (kept !== undefined) return kept
  let v: string | null = null
  try { v = (db.query('SELECT value FROM settings WHERE key = ?').get(CUTOVER_KEY) as { value: string } | null)?.value ?? null } catch { v = null }
  if (v) cutovers.set(db, v)
  return v
}

/** Set the cutover (tests): the stored value and the one kept in memory. */
export function setHiddenAnswersCutover(db: Database, at: string): void {
  db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CUTOVER_KEY, at)
  cutovers.set(db, at)
}

/** Made from the cutover on (never hidden)? `createdAt`: the message's created_at. `since`: also not before this (a
 * chat's shared_at: the earlier answers of a chat shared after the cutover were recorded by the share's check, and keep
 * the rule for older answers). */
export const afterCutover = (cutover: string | null, createdAt: string | null | undefined, since?: string | null): boolean =>
  !!cutover && !!createdAt && createdAt >= cutover && (!since || createdAt >= since)

/** One answer's record, as read back. */
export interface AnswerRecord { reads: ReadGroup[]; left: string[] }

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isSource = (v: unknown): v is ReadSource => !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'

/** A stored record, or null when it cannot be read (then the answer is hidden from everyone but its runner). */
export function parseRecord(reads: string | null, left: string | null): AnswerRecord | null {
  if (reads === null) return null
  try {
    const r = JSON.parse(reads) as unknown
    const l = JSON.parse(left ?? '[]') as unknown
    if (!Array.isArray(r) || !isStrings(l)) return null
    const groups: ReadGroup[] = []
    for (const g of r) {
      if (!g || typeof g !== 'object') return null
      const { c, s, x, y } = g as { c?: unknown; s?: unknown; x?: unknown; y?: unknown }
      if (!isStrings(c) || !Array.isArray(s) || !s.every(isSource)) return null
      groups.push({ c, s, ...(x ? { x: 1 as const } : {}), ...(y ? { y: 1 as const } : {}) })
    }
    return { reads: groups, left: l }
  } catch { return null }
}

/** The record of a new answer of a shared chat: nothing read yet, nothing left out (in the transaction that makes it). */
export function newAnswerRecord(db: Database, chatId: string, messageId: string): void {
  db.query('INSERT OR IGNORE INTO shared_answer_reads (message_id, chat_id) VALUES (?, ?)').run(messageId, chatId)
}

/** What the answer read so far (all of it: the groups replace what was stored). */
export function setAnswerReads(db: Database, chatId: string, messageId: string, groups: readonly ReadGroup[]): void {
  db.query(`INSERT INTO shared_answer_reads (message_id, chat_id, reads) VALUES (?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET reads = excluded.reads`).run(messageId, chatId, JSON.stringify(groups))
}

/** The answers above it that its runner did not see (set when its turn starts). */
export function setLeftOut(db: Database, chatId: string, messageId: string, ids: readonly string[]): void {
  db.query(`INSERT INTO shared_answer_reads (message_id, chat_id, left_out) VALUES (?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET left_out = excluded.left_out`).run(messageId, chatId, JSON.stringify([...ids]))
}

/** One answer's record, or null (none, or not readable). */
export function answerRecord(db: Database, messageId: string): AnswerRecord | null {
  const r = db.query('SELECT reads, left_out FROM shared_answer_reads WHERE message_id = ?').get(messageId) as { reads: string; left_out: string } | null
  return r ? parseRecord(r.reads, r.left_out) : null
}

/** Every record of a chat, by answer (a record that cannot be read: absent). */
export function answerRecords(db: Database, chatId: string): Map<string, AnswerRecord> {
  const out = new Map<string, AnswerRecord>()
  for (const r of db.query('SELECT message_id, reads, left_out FROM shared_answer_reads WHERE chat_id = ?').all(chatId) as { message_id: string; reads: string; left_out: string }[]) {
    const rec = parseRecord(r.reads, r.left_out)
    if (rec) out.set(r.message_id, rec)
  }
  return out
}

export type NodeRow = { id: string; parent_id: string | null; role: string; runner: string | null; reads: string | null; left_out: string | null; created_at: string | null; shared_at?: string | null }
/** One message of a chat as the walk needs it: an answer's record parsed once (`c` as a set; null: none or unreadable);
 * `late`: made from the cutover on and not before its chat was shared (hidden only by an x group: what it read is not
 * all known). */
export interface Node { id: string; parent: string | null; answer: boolean; runner: string | null; late: boolean; rec: { reads: ParsedGroup[]; left: ReadonlySet<string> } | null }
export interface ParsedGroup { c: ReadonlySet<string>; s: ReadSource[]; x: boolean; y: boolean }
const NONE: readonly string[] = []

/** A message row (with its turn's person and record) as the walk needs it; `cutover`: hiddenAnswersCutover. */
export function nodeOf(m: NodeRow, cutover: string | null): Node {
  const answer = m.role === 'assistant'
  const late = answer && afterCutover(cutover, m.created_at, m.shared_at)
  const rec = answer ? parseRecord(m.reads, m.left_out) : null
  return { id: m.id, parent: m.parent_id, answer, runner: m.runner, late, rec: rec && { reads: rec.reads.map((g) => ({ c: new Set(g.c), s: g.s, x: !!g.x, y: !!g.y })), left: new Set(rec.left) } }
}

/** A chat's messages with their turns' person and records, read and parsed once (any number of viewers then). */
export function chatNodes(db: Database, chatId: string): Node[] {
  const rows = db.query(`SELECT m.id, m.parent_id, m.role, t.user_id AS runner, r.reads, r.left_out, m.created_at, c.shared_at FROM messages m
    JOIN chats c ON c.id = m.chat_id LEFT JOIN turns t ON t.id = m.turn_id LEFT JOIN shared_answer_reads r ON r.message_id = m.id
    WHERE m.chat_id = ? ORDER BY m.rowid`).all(chatId) as NodeRow[]
  const cutover = hiddenAnswersCutover(db)
  return rows.map((m) => nodeOf(m, cutover))
}

/** A late answer (from the cutover on) is hidden from `who` only by an x group they are not in. */
export const lateHides = (groups: readonly ParsedGroup[], who: string): boolean => groups.some((g) => g.x && !g.c.has(who))

/** An older answer's verdict for one person by its record alone (rule b, without what is above it): hidden unless every
 * group has them in `c`, was covered by a card's yes, or has every place readable by them (`reads`). */
export const groupsHide = (groups: readonly ParsedGroup[], who: string, reads: (s: ReadSource) => boolean): boolean =>
  !groups.every((g) => g.c.has(who) || (!g.x && (g.y || g.s.every(reads))))

/** One viewer as the walk judges them: their account and what they may read, by place (kept across chats). `check`:
 * the rule check of one place, when the caller has its own (chat/widening.ts: folder paths read once); else viewersOf. */
export interface ViewerJudge { me: Principal | null; verdicts: Map<string, boolean>; check?: (s: ReadSource) => boolean }

/** The answers among `nodes` (chatNodes) hidden from `viewer`, on every branch; one rule check per place (`judge`: one
 * kept for the request, AnswerSight). */
export function withheldAmong(db: Database, rules: RuleSet, nodes: readonly Node[], viewer: string, judge: ViewerJudge = { me: loadPrincipal(db, viewer), verdicts: new Map() }): Set<string> {
  const byId = new Map(nodes.map((r) => [r.id, r]))
  const { me, verdicts } = judge
  const reads = (s: ReadSource): boolean => {
    const k = sourceKey(s)
    let ok = verdicts.get(k)
    if (ok === undefined) {
      try { ok = !!me && (judge.check ? judge.check(s) : viewersOf(db, rules, s, [me], viewer).has(viewer)) } catch { ok = false }
      verdicts.set(k, ok)
    }
    return ok
  }
  const hiddenHere = (m: Node, above: readonly string[]): boolean => {
    if (!m.answer || (m.runner !== null && m.runner === viewer)) return false
    // from the cutover on nothing is hidden (rule a), but what an x group read is not all known (memories, a scope the
    // share's check could not tell): only its `c` sees it, as before
    if (m.late) return !!m.rec && lateHides(m.rec.reads, viewer)
    if (!m.rec) return true
    // an older answer: a group the viewer was in, one a card's yes covered (not x), or one whose every place the viewer
    // may read now (rule b)
    if (groupsHide(m.rec.reads, viewer, reads)) return true
    // built on an answer hidden from them that was in its context
    const left = m.rec.left
    return above.some((id) => !left.has(id))
  }
  const out = new Set<string>()
  // per message: the answers hidden from the viewer above it on its branch (itself included when hidden)
  const below = new Map<string, readonly string[]>()
  const resolve = (start: Node): void => {
    // the chain up to the first message already worked out (parents are almost always earlier rows)
    const chain: Node[] = []
    const seen = new Set<string>()
    let cur: Node | undefined = start
    while (cur && !below.has(cur.id) && !seen.has(cur.id)) { seen.add(cur.id); chain.push(cur); cur = cur.parent ? byId.get(cur.parent) : undefined }
    for (let i = chain.length - 1; i >= 0; i--) {
      const m = chain[i]!
      const above = m.parent ? below.get(m.parent) ?? NONE : NONE
      const hid = hiddenHere(m, above)
      if (hid) out.add(m.id)
      below.set(m.id, hid ? [...above, m.id] : above)
    }
  }
  for (const r of nodes) if (!below.has(r.id)) resolve(r)
  return out
}

/**
 * The answers of this chat hidden from `viewer`, on every branch. One read of the chat's messages (with their turns'
 * person and records) and one rule check per place. `rules`: the folder rules to judge by (read once per request).
 */
export const withheldFrom = (db: Database, rules: RuleSet, chatId: string, viewer: string): Set<string> => withheldAmong(db, rules, chatNodes(db, chatId), viewer)

/** withheldFrom, kept for one request: each chat read once, each (chat, viewer) worked out once, the rules read once. */
export class AnswerSight {
  private rulesNow: RuleSet | null = null
  private chats = new Map<string, Node[]>()
  private sets = new Map<string, Set<string>>()
  private judges = new Map<string, ViewerJudge>()
  constructor(private db: Database, private files: FileService) {}
  get rules(): RuleSet { return (this.rulesNow ??= this.files.rules()) }
  /** each chat read and parsed once, whoever asks */
  private nodes(chatId: string): Node[] {
    let n = this.chats.get(chatId)
    if (!n) this.chats.set(chatId, (n = chatNodes(this.db, chatId)))
    return n
  }
  withheld(chatId: string, viewer: string): ReadonlySet<string> {
    const k = `${chatId} ${viewer}`
    let s = this.sets.get(k)
    if (!s) {
      let j = this.judges.get(viewer)
      if (!j) this.judges.set(viewer, (j = { me: loadPrincipal(this.db, viewer), verdicts: new Map() }))
      this.sets.set(k, (s = withheldAmong(this.db, this.rules, this.nodes(chatId), viewer, j)))
    }
    return s
  }
}

/** Where a word was found in a shared chat: a person's message (everyone who sees the chat sees it), and the answers
 * that hold it. */
export interface ChatHit { question: boolean; answers: string[] }

/** The messages of shared chats (of `chatIds` when given) whose text matches `like` (a LIKE pattern, `\` escapes), by
 * chat: one full-text search for a request, never one per chat (messages_fts does not index the chat). A search counts
 * a word in a shared chat only through a message the person sees (withheldFrom). */
export function sharedHits(db: Database, like: string, chatIds?: readonly string[]): Map<string, ChatHit> {
  const out = new Map<string, ChatHit>()
  const only = chatIds ? 'AND f.chat_id IN (SELECT value FROM json_each(?))' : 'AND f.chat_id IN (SELECT id FROM chats WHERE shared_at IS NOT NULL)'
  const args: string[] = chatIds ? [like, JSON.stringify(chatIds)] : [like]
  for (const r of db.query(`SELECT f.chat_id AS chat, f.message_id AS id, m.role FROM messages_fts f JOIN messages m ON m.id = f.message_id
    WHERE f.content LIKE ? ESCAPE '\\' ${only}`).all(...args) as { chat: string; id: string; role: string }[]) {
    let h = out.get(r.chat)
    if (!h) out.set(r.chat, (h = { question: false, answers: [] }))
    if (r.role === 'assistant') h.answers.push(r.id)
    else h.question = true
  }
  return out
}
