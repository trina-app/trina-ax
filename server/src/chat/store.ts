// Chats, messages (a tree), projects, memories: rows <-> API shapes (shared/src/api/entities.ts).
import type { Database } from 'bun:sqlite'
import type { ApiErrorBody, Attachment, Chat, ChatRunState, EngineId, FileChangeSummary, Locale, Memory, Message, MessageStatus, Project, Step, TurnStopReason, Usage, UserRef } from '@mycel/shared/api'
import { knownStepTool, STEP_TEXT, stepWords } from '@mycel/shared'
import { newId } from '../db'
import { isConfidentialChat } from '../safe-ops/confidential'
import { isTeamFilePath, sourceCount, teamSourcePaths } from '../files/sources'
import { skillMakerName } from '../skills/author'

export interface ChatRow {
  id: string; user_id: string; project_id: string | null; title: string; engine: string; model: string | null
  engine_session_id: string | null; engine_session_leaf_id: string | null; session_tainted: number
  active_leaf_id: string | null; created_at: string; updated_at: string; deleted_at: string | null
  /** where the title came from (title.ts): 'auto' | 'ai' | 'user' | 'schedule' | 'legacy' */
  title_source: string
  /** migration 242: the AI session of this person in a team chat room (rooms/ai.ts); never one of their chats on screen */
  room_id: string | null
  /** migration 252: when the person last had the chat on screen (POST /api/chats/:id/seen); null: never since made */
  seen_at: string | null
  /** migration 265: made as a shared chat of its project (chat/shared.ts); null: one person's chat */
  shared_at: string | null
  /** migration 276: a chat opened from this room's side panel (✦ Trina); null: an ordinary chat */
  side_room_id: string | null
}
export interface MessageRow {
  id: string; chat_id: string; parent_id: string | null; role: 'user' | 'assistant'; author_id: string | null; content: string
  attachments: string; steps: string; status: MessageStatus; error: string | null; turn_id: string | null; engine: string | null
  model: string | null; files: string | null; client_message_id: string | null; created_at: string; updated_at: string | null
  /** migration 212: the answer paused at a per-answer limit (TurnStopReason), else null */
  stop_reason: string | null
  /** migration 213: 1 when the AI got only the recent part of the conversation for this answer */
  history_trimmed: number
}
export interface ProjectRow {
  id: string; name: string; folder_path: string; instructions: string; created_by: string | null; created_at: string
  /** migration 221: the one person who wrote every saved version of the instructions (null: several, or not known),
   * and the instructions as that person last saved them (a build without these columns may have changed them since) */
  instructions_author: string | null; instructions_authored: string | null
  /** migration 332: the trash item that took its folder to the trash (null: in place); admins and the owner only then */
  trashed_with: string | null
  /** migration 265: new chats in this project are shared with its people (chat/shared.ts) */
  share_chats: number
  /** migration 280: the server made its projects/<name> folder for it (chat/project-access.ts): only then is it its
   * creator's to change who sees it or to trash its folder with it */
  folder_made?: number
}

export const CHAT_COLS = 'id, user_id, project_id, title, engine, model, engine_session_id, engine_session_leaf_id, session_tainted, active_leaf_id, created_at, updated_at, deleted_at, title_source, room_id, seen_at, shared_at, side_room_id'
export const MESSAGE_COLS = 'id, chat_id, parent_id, role, author_id, content, attachments, steps, status, error, turn_id, engine, model, files, client_message_id, created_at, updated_at, stop_reason, history_trimmed'
export const PROJECT_COLS = 'id, name, folder_path, instructions, created_by, created_at, instructions_author, instructions_authored, trashed_with, share_chats, folder_made'

/** SQLite timestamps ("2026-10-21T03:04:05.678Z" from strftime, or ISO from JS) -> ISO with offset. */
export function iso(t: string | null | undefined): string {
  if (!t) return new Date(0).toISOString()
  if (/[zZ]|[+-]\d\d:\d\d$/.test(t)) return new Date(t).toISOString()
  return new Date(t.replace(' ', 'T') + 'Z').toISOString()
}

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

/** messages.error: JSON ApiErrorBody (stage 2) or a plain string (stage 1 rows). */
export function parseError(s: string | null): ApiErrorBody | null {
  if (!s) return null
  const j = json<ApiErrorBody | null>(s, null)
  if (j && typeof j === 'object' && typeof j.code === 'string' && typeof j.message === 'string') return j
  return { code: 'internal', message: s }
}

/** A team-file reference with everything about the file blanked (deleted, or not readable for the viewer). */
export const blankTeamAttachment = (a: Pick<Attachment, 'id'>): Attachment => ({ id: a.id, name: '', path: '', size: 0, mime: 'application/octet-stream', kind: 'other', source: 'team', unavailable: true })

/**
 * Who looks at a message of a shared project chat (chat/shared.ts messageView): each viewer sees the transcript as
 * their own access allows. A step label or a file summary names a path only for a viewer who may see that name; usage,
 * a failed answer's reason and a running answer's live text stay with the person whose turn it is; team-file references
 * are checked for the viewer (their name), a computer upload shows only to its sender.
 */
export interface MessageView {
  viewer: string
  /** may the viewer see this team path's name (it would show it in a listing) */
  canList(rel: string): boolean
  /** may the viewer read this team path (a skill a receipt names) */
  canRead(rel: string): boolean
  /** a failed answer as others see it: its reason is the runner's */
  failed: string
  /** set by toMessage: the viewer is the person whose turn (or message) this is */
  runner?: boolean
  /** the chat was shared after it was made (chat/share-chat.ts: some turn of it is marked SHARED_LATER), and the
   * viewer's language: the steps of an answer from before the share show their words alone to everyone but its runner */
  sharedLater?: boolean
  /** an answer hidden from the viewer (chat/shared-answers.ts: it used what they may not see, and they did not see the
   * chat then): one line in its place, nothing of it */
  withheld?: (messageId: string) => boolean
  locale?: Locale
}

/** turns.shared_checked of a turn that ran before its chat was shared (chat/share-chat.ts marks them when it shares):
 * checked by the share, so the rollback guard passes it (it looks for 0), and its steps are its runner's (viewSteps).
 * Turns this build runs are 1. */
export const SHARED_LATER = 2

/** A step of a shared chat as stored: `label` names no path, `sv` keeps the label the runner saw and the paths it names
 * (server-only: stripped before any step leaves the server, ChatStore.viewSteps). */
export interface SharedStepView { label: string; paths: string[] }
export type StoredStep = Step & { sv?: SharedStepView }
/** A step without the server-only part. */
export const publicStep = (s: StoredStep): Step => { if (!s.sv) return s; const { sv: _sv, ...rest } = s; return rest }

export class ChatStore {
  private names = new Map<string, string>()
  /** Team-file references as `userId` may see them now (component C, set by the runtime). Without it every reference
   * is blanked: a message never shows a referenced file's name to someone the server could not check. */
  viewAttachments: ((userId: string, atts: Attachment[]) => Attachment[]) | null = null
  /** Team-file references of a shared chat's message as `viewer` may see them now, whoever attached them (their name
   * for the viewer, never their content); computer uploads only for their sender (`author`). Set by the runtime;
   * without it every reference is blanked. */
  viewAttachmentsAs: ((viewer: string, author: string | null, atts: Attachment[]) => Attachment[]) | null = null
  constructor(readonly db: Database) {}

  /** A message's attachments for the chat's owner (the only person who sees its messages), team references re-checked. */
  attachmentsOf(r: Pick<MessageRow, 'chat_id' | 'attachments'> & { author_id?: string | null }, viewer?: string): Attachment[] {
    const atts = json<Attachment[]>(r.attachments, [])
    // a shared chat (chat/shared.ts): as this viewer may see them, whoever attached them
    if (viewer !== undefined) {
      const blank = (a: Attachment) => (a.source === 'team' ? blankTeamAttachment(a) : { ...blankTeamAttachment(a), source: a.source })
      if (!this.viewAttachmentsAs) return atts.map((a) => (a.source !== 'team' && r.author_id === viewer ? a : blank(a)))
      try { return this.viewAttachmentsAs(viewer, r.author_id ?? null, atts) } catch { return atts.map(blank) }
    }
    if (!atts.some((a) => a.source === 'team')) return atts
    const owner = (this.db.query('SELECT user_id FROM chats WHERE id = ?').get(r.chat_id) as { user_id: string } | null)?.user_id
    if (!owner || !this.viewAttachments) return atts.map((a) => (a.source === 'team' ? blankTeamAttachment(a) : a))
    try { return this.viewAttachments(owner, atts) } catch { return atts.map((a) => (a.source === 'team' ? blankTeamAttachment(a) : a)) }
  }

  /** The steps of an answer for the chat's owner: a step about an attached team file (id "attach-<reference id>",
   * TurnExec.attachmentsForTurn) loses its path once the owner can no longer open that file, like the attachment. */
  viewSteps(r: Pick<MessageRow, 'chat_id'> & { turn_id?: string | null }, stored: StoredStep[], view?: MessageView): Step[] {
    // an answer from before its chat was shared (chat/share-chat.ts; known by its turn's mark, not by the clock): its
    // steps ran without the read card and were stored with their whole label (a path, an address, a query, a remembered
    // text). Its runner sees them as they were; everyone else the words alone, without detail, search results, pictures
    // or a dev environment run, and the tool's name only when it is one of ours (a connection's tool names it)
    const earlier = !!view?.sharedLater && !view.runner && this.beforeShare(r.turn_id ?? null)
    // a shared chat: a label names its paths only for a viewer who may see every one of them (else the words alone)
    const steps: Step[] = stored.map((s) => {
      if (earlier) {
        const { sv: _sv, detail: _d, sources: _s, images: _i, devEnvRun: _r, posted: _p, tool, ...rest } = s
        return { ...rest, ...(tool && knownStepTool(tool) ? { tool } : {}), label: stepWords(s, view!.locale ?? 'en') }
      }
      if (!s.sv) return s
      const shows = !!view && s.sv.paths.every((p) => view.canList(p))
      const out = publicStep(s)
      if (shows) return { ...out, label: s.sv.label }
      const { detail: _d, ...rest } = out
      return rest
    })
    // a shared chat: a step's detail (a card's answer, an error's words) and where a post went (Step.posted: a room's
    // id) are the runner's alone
    if (view && !view.runner) for (let i = 0; i < steps.length; i++) if (steps[i]!.detail !== undefined || steps[i]!.posted !== undefined) { const { detail: _d, posted: _p, ...rest } = steps[i]!; steps[i] = rest }
    if (!steps.some((s) => s.tool === 'attachment')) return steps
    const owner = view?.viewer ?? (this.db.query('SELECT user_id FROM chats WHERE id = ?').get(r.chat_id) as { user_id: string } | null)?.user_id
    const gone = (s: Step): boolean => {
      if (!s.id.startsWith('attach-')) return !!s.label && s.label !== STEP_TEXT.attachUnavailable.en // an unknown attachment step: no path shown
      if (!owner || !this.viewAttachments) return true
      try { return !!this.viewAttachments(owner, [{ id: s.id.slice('attach-'.length), source: 'team' } as Attachment])[0]?.unavailable } catch { return true }
    }
    return steps.map((s) => (s.tool === 'attachment' && gone(s) ? { ...s, label: STEP_TEXT.attachUnavailable.en, status: s.status === 'running' ? s.status : 'ok' } : s))
  }

  userRef(id: string | null): UserRef | null {
    if (!id) return null
    let name = this.names.get(id)
    if (name === undefined) {
      const r = this.db.query('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | null
      name = r?.name ?? id
      this.names.set(id, name)
      if (this.names.size > 500) this.names.clear()
    }
    return { id, name }
  }
  forgetName(id: string) { this.names.delete(id) }

  // ---------------- chats ----------------
  chatRow(id: string): ChatRow | null {
    return this.db.query(`SELECT ${CHAT_COLS} FROM chats WHERE id = ?`).get(id) as ChatRow | null
  }
  /** own chat (optionally including the trash), for the server's own flows on a person's chat (drafts, merges). A room's
   * AI session is not a chat of the person's (it is asked, stopped and read through the room, rooms/ai.ts), and a shared
   * project chat is not theirs alone: the chat routes find both through chat/shared.ts chatFor, these flows never */
  ownChat(userId: string, id: string, o: { deleted?: boolean } = {}): ChatRow | null {
    const r = this.chatRow(id)
    if (!r || r.user_id !== userId || r.room_id || r.shared_at) return null
    // nor one others wrote in before it stopped being shared (a deleted project's, the rollback guard): their words and
    // answers there are not the person's alone either
    if (this.db.query("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'user' AND author_id IS NOT NULL AND author_id <> ? LIMIT 1").get(id, userId)) return null
    if (!o.deleted && r.deleted_at) return null
    return r
  }
  /** `waiting`: the runtime's word that the AI waits for the person here (ChatRuntime.waitsForPerson) */
  /** `answersOf`: whose answers the unseen marker and the last outcome come from (a shared chat: its creator's own
   * turns, for its creator; null for anyone else: no marker); absent: every answer (a chat of one person). `viewer`: whose
   * pin it shows (Chat.pinnedAt, chat/pins.ts). */
  toChat(r: ChatRow, runState: ChatRunState, waiting = false, o: { answersOf?: string | null; viewer?: string } = {}): Chat {
    const pinned = o.viewer ? this.pinnedAt(o.viewer, r.id) : null
    return {
      id: r.id, projectId: r.project_id, title: r.title, engine: (r.engine === 'codex' || r.engine === 'api' ? r.engine : 'claude-code') as EngineId, model: r.model,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), deletedAt: r.deleted_at ? iso(r.deleted_at) : null, runState,
      ...(isConfidentialChat(this.db, r.id) ? { confidential: true as const } : {}),
      ...(waiting ? { waiting: true as const } : {}),
      ...(o.answersOf === null ? {} : this.answerState(r, o.answersOf)),
      ...(this.mergeWaiting(r.id) ? { mergeWaiting: true as const } : {}),
      ...(r.side_room_id ? { sideRoomId: r.side_room_id } : {}),
      ...(pinned ? { pinnedAt: iso(pinned) } : {}),
    }
  }
  /** The newest finished answer (done, error or stopped), in one read: whether it finished after the person last had
   * the chat on screen (never since it was made: after it was made), and how it ended when not well (Chat.lastOutcome:
   * failed, a server stop included, or paused at the per-answer limit). An answer the person stopped is never unseen:
   * they stopped it, nothing waits for them there. Session markers: docs/DECISIONS.md. */
  answerState(r: Pick<ChatRow, 'id' | 'seen_at' | 'created_at'>, answersOf?: string): Pick<Chat, 'unseen' | 'lastOutcome'> {
    const row = (answersOf === undefined
      ? this.db.query(`SELECT COALESCE(updated_at, created_at) AS t, status, stop_reason FROM messages
      WHERE chat_id = ? AND role = 'assistant' AND status <> 'streaming' ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC LIMIT 1`).get(r.id)
      : this.db.query(`SELECT COALESCE(m.updated_at, m.created_at) AS t, m.status, m.stop_reason FROM messages m JOIN turns t ON t.id = m.turn_id
      WHERE m.chat_id = ? AND m.role = 'assistant' AND m.status <> 'streaming' AND t.user_id = ? ORDER BY COALESCE(m.updated_at, m.created_at) DESC, m.rowid DESC LIMIT 1`).get(r.id, answersOf)
    ) as { t: string; status: MessageStatus; stop_reason: string | null } | null
    if (!row) return {}
    const lastOutcome = row.status === 'error' ? 'error' as const : row.status === 'done' && stopReasonOf(row.stop_reason) ? 'paused' as const : null
    const unseen = row.status !== 'stopped' && iso(row.t) > iso(r.seen_at ?? r.created_at)
    return { ...(unseen ? { unseen: true as const } : {}), ...(lastOutcome ? { lastOutcome } : {}) }
  }
  /** When `userId` pinned the chat (chat/pins.ts), or null. */
  pinnedAt(userId: string, chatId: string): string | null {
    return (this.db.query('SELECT pinned_at FROM chat_pins WHERE user_id = ? AND chat_id = ?').get(userId, chatId) as { pinned_at: string } | null)?.pinned_at ?? null
  }
  /** An answer finished after the person last had the chat on screen (answerState). */
  unseen(r: Pick<ChatRow, 'id' | 'seen_at' | 'created_at'>): boolean { return !!this.answerState(r).unseen }
  /** The person has the chat on screen now: everything finished so far is seen. */
  markSeen(id: string, at = new Date().toISOString()) {
    this.db.query('UPDATE chats SET seen_at = ? WHERE id = ? AND (seen_at IS NULL OR seen_at < ?)').run(at, id, at)
  }
  /** A merge chat made at the end of the welcome steps whose turn waits for its person to open it (docs/DECISIONS.md
   * "W5"; skills/share-merge.ts startOpenedMerge). A database without the table reads as none. */
  private mergeWaiting(id: string): boolean {
    try { return !!this.db.query('SELECT 1 FROM skill_share_merges WHERE chat_id = ? AND started_at IS NULL LIMIT 1').get(id) } catch { return false }
  }
  touchChat(id: string, at = new Date().toISOString()) { this.db.query('UPDATE chats SET updated_at = ? WHERE id = ?').run(at, id) }

  // ---------------- messages ----------------
  messageRow(id: string): MessageRow | null {
    return this.db.query(`SELECT ${MESSAGE_COLS} FROM messages WHERE id = ?`).get(id) as MessageRow | null
  }
  children(chatId: string, parentId: string | null): MessageRow[] {
    return (parentId === null
      ? this.db.query(`SELECT ${MESSAGE_COLS} FROM messages WHERE chat_id = ? AND parent_id IS NULL ORDER BY created_at, id`).all(chatId)
      : this.db.query(`SELECT ${MESSAGE_COLS} FROM messages WHERE chat_id = ? AND parent_id = ? ORDER BY created_at, id`).all(chatId, parentId)) as MessageRow[]
  }
  siblingIds(r: Pick<MessageRow, 'chat_id' | 'parent_id'>): string[] {
    return (r.parent_id === null
      ? this.db.query('SELECT id FROM messages WHERE chat_id = ? AND parent_id IS NULL ORDER BY created_at, id').all(r.chat_id)
      : this.db.query('SELECT id FROM messages WHERE chat_id = ? AND parent_id = ? ORDER BY created_at, id').all(r.chat_id, r.parent_id)
    ).map((x) => (x as { id: string }).id)
  }
  /** Root -> leaf path ending at `leafId` (inclusive). */
  pathTo(leafId: string | null): MessageRow[] {
    const out: MessageRow[] = []
    const seen = new Set<string>()
    let cur = leafId
    while (cur && !seen.has(cur) && out.length < 100_000) {
      seen.add(cur)
      const r = this.messageRow(cur)
      if (!r) break
      out.push(r)
      cur = r.parent_id
    }
    return out.reverse()
  }
  /** The newest leaf under `id`: follow the most recently created child at every step. */
  newestLeafUnder(chatId: string, id: string): string {
    let cur = id
    for (let i = 0; i < 100_000; i++) {
      const r = this.db.query('SELECT id FROM messages WHERE chat_id = ? AND parent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(chatId, cur) as { id: string } | null
      if (!r) return cur
      cur = r.id
    }
    return cur
  }
  /** `view`: a shared project chat's message as one viewer sees it (MessageView); absent: the chat's own person. */
  toMessage(r: MessageRow, live?: { content: string; steps: StoredStep[] }, view?: MessageView): Message {
    const siblings = this.siblingIds(r)
    // a shared chat: the turn's person sees the answer as it is; anyone else not its live text, usage or failure reason
    const runner = !view || (r.role === 'assistant' ? !!r.turn_id && this.turnUser(r.turn_id) === view.viewer : r.author_id === view.viewer)
    if (view) view = { ...view, runner }
    const hideLive = !!view && !runner && r.status === 'streaming'
    // an answer hidden from the viewer: its place in the branch and nothing else (Message.withheld); a running one shows
    // nothing to anyone but its runner anyway
    if (view && !runner && r.role === 'assistant' && r.status !== 'streaming' && view.withheld?.(r.id)) {
      const branch = { index: Math.max(0, siblings.indexOf(r.id)), count: Math.max(1, siblings.length), siblingIds: siblings }
      return { id: r.id, chatId: r.chat_id, parentId: r.parent_id, role: r.role, author: null, content: '', attachments: [], steps: [], status: r.status, error: null,
        turnId: r.turn_id, engine: null, model: null, files: null, usage: null, createdAt: iso(r.created_at), branch, withheld: true }
    }
    const usage = r.role === 'assistant' && r.turn_id && runner ? this.turnUsage(r.turn_id) : null
    const error = parseError(r.error)
    const files = json<FileChangeSummary | null>(r.files, null)
    return {
      id: r.id, chatId: r.chat_id, parentId: r.parent_id, role: r.role, author: r.role === 'user' ? this.userRef(r.author_id) : null,
      content: hideLive ? '' : live?.content ?? r.content, attachments: this.attachmentsOf(r, view?.viewer),
      steps: hideLive ? [] : this.viewSteps(r, live?.steps ?? json<StoredStep[]>(r.steps, []).filter(isStep), view),
      status: r.status, error: error && view && !runner ? { code: 'internal', message: view.failed } : error, turnId: r.turn_id, engine: (r.engine === 'codex' || r.engine === 'claude-code' || r.engine === 'api' ? r.engine : null) as EngineId | null,
      model: r.model, files: files && view ? viewFiles(files, view) : files, usage, createdAt: iso(r.created_at),
      branch: { index: Math.max(0, siblings.indexOf(r.id)), count: Math.max(1, siblings.length), siblingIds: siblings },
      // only when it paused at a limit: every other message keeps its earlier shape
      ...(r.role === 'assistant' && stopReasonOf(r.stop_reason) ? { stopReason: stopReasonOf(r.stop_reason) } : {}),
      ...(r.role === 'assistant' && r.history_trimmed === 1 ? { historyTrimmed: true } : {}),
      // a finished answer's "참고한 파일" count; the list itself is checked for the viewer when it is opened
      ...(() => { const n = r.role === 'assistant' && r.status !== 'streaming' && !live ? sourceCount(this.db, r.id) : 0; return n ? { sourceCount: n } : {} })(),
      // a finished answer that ran a team skill: "팀 스킬 '할 일 정리' · 팀 파일 2개" (docs/DECISIONS.md "M — One meeting note")
      ...(r.role === 'assistant' && r.status !== 'streaming' && !live && r.turn_id ? this.receiptFor(r, view) : {}),
    }
  }
  /** The receipt as `view` may see it: none when the viewer cannot read the skill it names. */
  private receiptFor(r: MessageRow, view?: MessageView): ReturnType<ChatStore['receiptOf']> {
    const out = this.receiptOf(r)
    return out.receipt && view && !view.canRead(out.receipt.skill.path) ? {} : out
  }
  /** Who ran a turn (its person), or null. */
  /** An answer of a chat shared after it was made ran before the share: its turn is marked SHARED_LATER, or it has no
   * turn row to say otherwise. */
  beforeShare(turnId: string | null): boolean {
    if (!turnId) return true
    const t = this.db.query('SELECT shared_checked AS c FROM turns WHERE id = ?').get(turnId) as { c: number } | null
    return !t || t.c === SHARED_LATER
  }
  turnUser(turnId: string): string | null {
    return (this.db.query('SELECT user_id FROM turns WHERE id = ?').get(turnId) as { user_id: string } | null)?.user_id ?? null
  }
  /** The skill a finished answer ran (a command first, else the skill tool's first) and how many team files went into
   * it: the question's team-file references and the files it read, outside personal folders and skills/. Counts only:
   * the names stay behind the sources list, which checks the viewer's access. */
  receiptOf(r: MessageRow): { receipt?: { skill: { path: string; name: string; by?: string }; teamFiles: number } } {
    const run = this.db.query(`SELECT skill_path AS path, skill_name AS name FROM turn_skill_runs WHERE turn_id = ?
      ORDER BY CASE source WHEN 'command' THEN 0 ELSE 1 END, recorded_at LIMIT 1`).get(r.turn_id) as { path: string; name: string } | null
    if (!run) return {}
    const asked = r.parent_id ? (this.db.query('SELECT attachments, author_id FROM messages WHERE id = ?').get(r.parent_id) as { attachments: string; author_id: string | null } | null) : null
    const refs = json<Attachment[]>(asked?.attachments ?? '[]', []).filter((a) => a.source === 'team' && isTeamFilePath(a.path)).map((a) => a.path)
    // who made the skill (its file's first version, never its text), when that is someone else than the asker and not a
    // starter pack's text: "김지훈님의 팀 스킬 '견적서 쓰기'" (docs/DECISIONS.md "S")
    const maker = this.makerOf(run.path)
    const by = maker && maker.id !== asked?.author_id ? { by: maker.name } : {}
    return { receipt: { skill: { path: run.path, name: run.name, ...by }, teamFiles: new Set([...refs, ...teamSourcePaths(this.db, r.id)]).size } }
  }
  /** skills/author.ts for one path, kept a minute: a chat's answers often ran the same skill */
  private makers = new Map<string, { at: number; v: { id: string; name: string } | null }>()
  private makerOf(rel: string): { id: string; name: string } | null {
    const now = Date.now()
    const had = this.makers.get(rel)
    if (had && now - had.at < 60_000) return had.v
    const v = skillMakerName(this.db, rel)
    if (this.makers.size > 500) this.makers.clear()
    this.makers.set(rel, { at: now, v })
    return v
  }
  turnUsage(turnId: string): Usage | null {
    const t = this.db.query('SELECT input_tokens, output_tokens, cost_usd, status FROM turns WHERE id = ?').get(turnId) as { input_tokens: number; output_tokens: number; cost_usd: number; status: string } | null
    if (!t || t.status === 'queued' || t.status === 'running') return null
    return { inputTokens: t.input_tokens, outputTokens: t.output_tokens, costUsd: t.cost_usd }
  }
  insertMessage(m: {
    chatId: string; parentId: string | null; role: 'user' | 'assistant'; authorId: string | null; content: string; attachments?: Attachment[]
    status: MessageStatus; turnId?: string | null; engine?: string | null; model?: string | null; clientMessageId?: string | null; id?: string
    /** the server sent this user message for the person (a scheduled run): its web addresses are not the person's own (tools/url-gate.ts) */
    autoSent?: boolean
  }): string {
    const id = m.id ?? newId()
    const now = new Date().toISOString()
    this.db.query(`INSERT INTO messages (id, chat_id, parent_id, role, author_id, content, attachments, steps, status, turn_id, engine, model, client_message_id, created_at, updated_at, auto_sent)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, m.chatId, m.parentId, m.role, m.authorId, m.content, JSON.stringify(m.attachments ?? []), '[]', m.status,
      m.turnId ?? null, m.engine ?? null, m.model ?? null, m.clientMessageId ?? null, now, now, m.autoSent ? 1 : 0)
    return id
  }

  // ---------------- projects ----------------
  projectRow(id: string): ProjectRow | null { return this.db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(id) as ProjectRow | null }
  /** `share`: its shared chats as the caller sees them (chat/shared.ts projectShare) */
  toProject(r: ProjectRow, canEdit: boolean, share?: Pick<Project, 'shareChats' | 'audience' | 'sharedChats' | 'chatUploads'>): Project {
    return { id: r.id, name: r.name, folderPath: r.folder_path, instructions: r.instructions, createdBy: this.userRef(r.created_by), createdAt: iso(r.created_at), canEdit, inTrash: r.trashed_with !== null, ...(share ?? {}) }
  }

  // ---------------- memories ----------------
  toMemory(r: { id: string; text: string; source_chat_id: string | null; created_at: string }): Memory {
    return { id: r.id, text: r.text, sourceChatId: r.source_chat_id, createdAt: iso(r.created_at) }
  }
}

/** A file summary as `view` may see it: only the paths the viewer may see (no count of the others). */
function viewFiles(f: FileChangeSummary, view: MessageView): FileChangeSummary | null {
  const out: FileChangeSummary = {
    saved: f.saved.filter((x) => view.canList(x.path)),
    conflicts: f.conflicts.filter((x) => view.canList(x.path) && view.canList(x.copyPath)),
    rejected: f.rejected.filter((x) => view.canList(x.path)),
  }
  return out.saved.length || out.conflicts.length || out.rejected.length ? out : null
}

/** messages.stop_reason / turns.stop_reason: a known per-answer limit, else null */
export const stopReasonOf = (v: string | null | undefined): TurnStopReason | null => (v === 'tool_limit' || v === 'time_limit' ? v : null)

function isStep(s: unknown): s is StoredStep {
  // stage-1 rows stored a list of tool names; only full step objects are shown
  return !!s && typeof s === 'object' && typeof (s as Step).id === 'string' && typeof (s as Step).label === 'string'
}

/** Opaque cursor helpers (base64url JSON). */
export const encodeCursor = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
/** Decode a cursor whose fields `keys` are all strings; null when absent or not one of ours. */
export function decodeCursor<K extends string>(c: string | undefined, keys: readonly K[]): Record<K, string> | null {
  if (!c) return null
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>
    if (!v || typeof v !== 'object' || keys.some((k) => typeof v[k] !== 'string' || (v[k] as string).length > 200)) return null
    return v as Record<K, string>
  } catch { return null }
}
