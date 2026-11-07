// Shared project chats (docs/DECISIONS.md "Shared project chats"). A project editor turns on "share its chats"
// (projects.share_chats); every chat made in that project from then on (chats.shared_at, only at creation) is seen by
// the people who can see the project (canSeeProject: who can read its folder, owner and admins included; while its
// folder is in the trash, the owner and admins) and may be continued by them. Nothing about who sees a chat is stored:
// the audience is the project's readers now, so a rule change applies at once (losing access hides the chat, from its
// creator too). Each turn is its sender's (chat/turn.ts: their access, AI connection, engine, budget, queue and usage),
// and what some of the audience cannot read enters the transcript only after the sender's yes on a card
// (TurnExec.confirmSharedRead).
//
// Never shared: a chat in a personal project, a chat made while safe operations (1A) are on, a confidential chat
// (markConfidentialTurn refuses a shared one). While 1A is on, shared chats are read-only.
import type { Database } from 'bun:sqlite'
import type { Chat, Locale } from '@mycel/shared/api'
import type { ChatRuntime } from './runtime'
import type { ChatRow, MessageRow, MessageView, ProjectRow } from './store'
import type { FileService } from '../files/service'
import { atLeast, loadPrincipal, type Principal } from '../policy/access'
import { canSeeProject, isPersonalFolder, mayEditProject } from './projects'
import { fail } from '../http/errors'
import { tr } from './i18n'
import { safeOpsEnabled } from '../safe-ops/runner'
import { confidentialChat } from '../safe-ops/confidential'
import { redactorFor } from '../integrations/connections/redact'

/** A chat row that is a shared project chat: made shared and still in a project. */
export const isSharedRow = (r: Pick<ChatRow, 'shared_at' | 'project_id'>): boolean => !!r.shared_at && !!r.project_id

/** Is this chat a shared project chat? (one read) */
export function isSharedChat(db: Database, chatId: string): boolean {
  const r = db.query('SELECT shared_at, project_id FROM chats WHERE id = ?').get(chatId) as Pick<ChatRow, 'shared_at' | 'project_id'> | null
  return !!r && isSharedRow(r)
}

/** May this project share its chats at all: a team project (never a personal one). */
export const projectCanShare = (p: Pick<ProjectRow, 'folder_path'>): boolean => !isPersonalFolder(p.folder_path)

/** Does a chat made in this project now become a shared chat: its setting is on, it is a team project in place, and
 * safe operations are off (a chat made while 1A is on would be confidential, and those are never shared). */
export const sharesNewChats = (p: Pick<ProjectRow, 'folder_path' | 'share_chats' | 'trashed_with'>): boolean =>
  p.share_chats === 1 && projectCanShare(p) && p.trashed_with === null && !safeOpsEnabled()

/** The active accounts as principals. */
export function activePrincipals(db: Database): Principal[] {
  const ids = db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY id").all() as { id: string }[]
  return ids.map((r) => loadPrincipal(db, r.id)).filter((p): p is Principal => !!p)
}

/**
 * The audience of projects (who sees a shared chat of it): the active people who can see the project now. One per
 * request or event: the people are loaded once and each project's audience is kept.
 */
export class Audiences {
  private people: Principal[] | null = null
  private byProject = new Map<string, string[]>()
  constructor(private db: Database, private files: FileService) {}
  of(p: ProjectRow): string[] {
    let ids = this.byProject.get(p.id)
    if (!ids) {
      this.people ??= activePrincipals(this.db)
      ids = this.people.filter((x) => canSeeProject(this.files, x, p)).map((x) => x.id)
      this.byProject.set(p.id, ids)
    }
    return ids
  }
  sees(userId: string, p: ProjectRow): boolean { return this.of(p).includes(userId) }
}

/** The audience of one project now. */
export const audienceOf = (db: Database, files: FileService, p: ProjectRow): string[] => new Audiences(db, files).of(p)

/** Did this person send a message in the chat (a shared chat they wrote in is in their chat list)? */
export function wroteIn(db: Database, chatId: string, userId: string): boolean {
  return !!db.query("SELECT 1 FROM messages WHERE author_id = ? AND chat_id = ? AND role = 'user' LIMIT 1").get(userId, chatId)
}

export interface ChatAccess {
  row: ChatRow
  /** a shared project chat (and its project); else the caller's own chat */
  shared: boolean
  project: ProjectRow | null
  /** the caller made it */
  creator: boolean
  /** the caller may edit its project (delete or restore a shared chat in it) */
  editor: boolean
}

/**
 * The chat `id` for `userId`, or the route's error. Every chat route and every other place that takes a chat id from a
 * request goes through here (it replaced ChatStore.ownChat). A chat of one person: its person only (anyone else, and a
 * missing chat, get not_found; a room's AI session is never a chat here). A shared project chat:
 *   - 'view': whoever sees its project now (its creator too: losing access hides it);
 *   - 'continue': the same, not in the trash, and not while safe operations are on (409 safe_ops) — send, edit,
 *     regenerate, a branch, a team file attached;
 *   - 'manage': its creator or an editor of its project (delete, restore; 403 for the others who see it).
 * Renaming and the engine are its creator's (`creator`); stop and cards are the runner's (the route checks the turn).
 * `deleted`: a chat in the trash too (a shared one only for those who may manage it).
 */
export function chatFor(rt: ChatRuntime, userId: string, id: string, mode: 'view' | 'continue' | 'manage', o: { deleted?: boolean; locale?: Locale } = {}): ChatAccess {
  const L = o.locale ?? 'en'
  const r = rt.store.chatRow(id)
  if (!r || r.room_id) return fail('not_found')
  if (!isSharedRow(r)) {
    if (r.user_id !== userId) return fail('not_found')
    if (r.deleted_at && (!o.deleted || mode === 'continue')) return fail('not_found')
    return { row: r, shared: false, project: null, creator: true, editor: false }
  }
  const project = rt.store.projectRow(r.project_id!)
  const me = loadPrincipal(rt.db, userId)
  if (!project || !me || !canSeeProject(rt.files, me, project)) return fail('not_found')
  const creator = r.user_id === userId
  const editor = mayEditProject(rt.files, me, project)
  if (r.deleted_at && (!o.deleted || mode === 'continue' || !(creator || editor))) return fail('not_found')
  if (mode === 'manage' && !creator && !editor) return fail('forbidden', tr('sharedChatDeleteNo', L), { params: { reason: 'shared_chat_manage' } })
  // while 1A is on every conversation is confidential, and a shared chat never is: read-only until it is off
  if (mode === 'continue' && (safeOpsEnabled() || confidentialChat(rt.db, r.id))) return fail('conflict', tr('sharedChatSafeOps', L), { params: { reason: 'safe_ops' } })
  return { row: r, shared: true, project, creator, editor }
}

/** Chat.shared for `viewer` (who made it, how many see it, whose question is being answered, whether it is theirs). */
export function sharedOf(rt: ChatRuntime, viewer: string, r: ChatRow, aud: Audiences): NonNullable<Chat['shared']> {
  const project = rt.store.projectRow(r.project_id!)
  const runner = rt.activeTurnUser(r.id)
  const me = loadPrincipal(rt.db, viewer)
  return {
    by: rt.store.userRef(r.user_id) ?? { id: r.user_id, name: r.user_id },
    audience: project ? aud.of(project).length : 0,
    answering: runner && runner !== viewer ? { name: rt.store.userRef(runner)?.name ?? '', ...(rt.waitsForPerson(r.id) ? { waiting: true as const } : {}) } : null,
    mine: r.user_id === viewer || wroteIn(rt.db, r.id, viewer),
    canDelete: r.user_id === viewer || (!!me && !!project && mayEditProject(rt.files, me, project)),
  }
}

/**
 * A chat as `viewer` sees it in the API and in chat.updated: a stored connection secret of its creator never shows in
 * the title (QA B-W5-1). A shared chat: the AI's wait and the unseen marker are only for its runner and creator (no
 * marker for anyone else in phase 1), plus Chat.shared.
 */
export function chatView(rt: ChatRuntime, viewer: string, r: ChatRow, o: { aud?: Audiences; hide?: (s: string) => string } = {}): Chat {
  const hide = o.hide ?? redactorFor(rt.ctx, r.user_id).hide
  if (!isSharedRow(r)) {
    const c = rt.store.toChat(r, rt.runState(r.id), rt.waitsForPerson(r.id))
    return { ...c, title: hide(c.title) }
  }
  const runner = rt.activeTurnUser(r.id)
  const c = rt.store.toChat(r, rt.runState(r.id), runner === viewer && rt.waitsForPerson(r.id), { answersOf: r.user_id === viewer ? viewer : null })
  return { ...c, title: hide(c.title), shared: sharedOf(rt, viewer, r, o.aud ?? new Audiences(rt.db, rt.files)) }
}

/** How `viewer` sees the messages of a shared chat (ChatStore.toMessage); undefined for a chat of one person. */
export function messageView(rt: ChatRuntime, r: Pick<ChatRow, 'shared_at' | 'project_id'>, viewer: string, locale: Locale): MessageView | undefined {
  if (!isSharedRow(r)) return undefined
  const me = loadPrincipal(rt.db, viewer)
  const rules = rt.files.rules()
  const segs = (p: string) => p.split('/').filter(Boolean)
  return {
    viewer,
    canList: (p) => !!me && rules.canList(me, segs(p)),
    canRead: (p) => !!me && atLeast(rules.access(me, segs(p)), 'read'),
    failed: tr('sharedAnswerFailed', locale),
  }
}

/** A message of the chat as `viewer` sees it (a streaming answer with its live text for its runner). */
export function messageFor(rt: ChatRuntime, chat: Pick<ChatRow, 'shared_at' | 'project_id'>, m: MessageRow, viewer: string, locale: Locale) {
  const view = messageView(rt, chat, viewer, locale)
  const e = m.status === 'streaming' ? rt.execForMessage(m.id) : undefined
  return rt.store.toMessage(m, e ? { content: e.content, steps: e.steps.map((s) => ({ ...s })) } : undefined, view)
}

/** Project.shareChats / audience / sharedChats as the caller sees them. */
export function projectShare(db: Database, files: FileService, p: ProjectRow, aud?: Audiences): { shareChats: boolean; audience: number; sharedChats: number } {
  const n = (db.query('SELECT COUNT(*) AS n FROM chats WHERE project_id = ? AND shared_at IS NOT NULL AND deleted_at IS NULL').get(p.id) as { n: number }).n
  return { shareChats: projectCanShare(p) && p.share_chats === 1, audience: (aud ?? new Audiences(db, files)).of(p).length, sharedChats: n }
}

/**
 * Rollback guard (migration 265). This build marks every turn it makes (turns.shared_checked). An older build knows
 * nothing about shared chats and runs turns there without the read gate; when this build starts again, a shared chat
 * with a turn after it was shared that this build did not make stops being shared (its creator keeps it as their own
 * chat), and turns still queued there by anyone else are stopped. Returns the chats unshared.
 */
export function unshareUncheckedChats(db: Database): string[] {
  const rows = db.query(`SELECT c.id, c.user_id FROM chats c WHERE c.shared_at IS NOT NULL AND EXISTS (SELECT 1 FROM turns t
    WHERE t.chat_id = c.id AND t.shared_checked = 0 AND COALESCE(t.queued_at, t.started_at) >= c.shared_at)`).all() as { id: string; user_id: string }[]
  if (!rows.length) return []
  const now = new Date().toISOString()
  db.transaction(() => {
    for (const r of rows) {
      db.query('UPDATE chats SET shared_at = NULL WHERE id = ?').run(r.id)
      const queued = db.query("SELECT id, message_id FROM turns WHERE chat_id = ? AND status = 'queued' AND user_id <> ?").all(r.id, r.user_id) as { id: string; message_id: string | null }[]
      for (const t of queued) {
        db.query("UPDATE turns SET status = 'stopped', ended_at = ? WHERE id = ?").run(now, t.id)
        if (t.message_id) db.query("UPDATE messages SET status = 'stopped', updated_at = ? WHERE id = ? AND status = 'streaming'").run(now, t.message_id)
      }
    }
  })()
  return rows.map((r) => r.id)
}

/** The engine session stash of this chat was written by `userId`'s own turn (resume only then, chat/turn.ts):
 * engine_session_leaf_id is the answer that ended the session; its turn's person wrote it. */
export function stashWrittenBy(db: Database, chat: Pick<ChatRow, 'engine_session_leaf_id'>, userId: string): boolean {
  if (!chat.engine_session_leaf_id) return false
  const r = db.query('SELECT t.user_id FROM messages m JOIN turns t ON t.id = m.turn_id WHERE m.id = ?').get(chat.engine_session_leaf_id) as { user_id: string } | null
  return r?.user_id === userId
}

/** Who ran the latest turn of this chat before `turnId` (any state), or null: whose engine folder it is now. */
export function previousRunner(db: Database, chatId: string, turnId: string): string | null {
  const r = db.query('SELECT user_id FROM turns WHERE chat_id = ? AND id <> ? ORDER BY COALESCE(queued_at, started_at) DESC, id DESC LIMIT 1').get(chatId, turnId) as { user_id: string } | null
  return r?.user_id ?? null
}

/** A shared chat (not in the trash) that `userId` sees now, or null: a chat of one person, someone else's chat they do
 * not see, a missing one. For the places outside the chat routes that take a chat id (team-file attachments, uploads,
 * thumbnails, artifacts). */
export function visibleSharedChat(db: Database, files: FileService, userId: string, chatId: string): ChatRow | null {
  const r = db.query('SELECT id, user_id, project_id, shared_at, deleted_at, room_id FROM chats WHERE id = ?').get(chatId) as (Pick<ChatRow, 'id' | 'user_id' | 'project_id' | 'shared_at' | 'deleted_at' | 'room_id'>) | null
  if (!r || r.room_id || r.deleted_at || !isSharedRow(r)) return null
  const p = db.query('SELECT id, folder_path, trashed_with FROM projects WHERE id = ?').get(r.project_id!) as Pick<ProjectRow, 'id' | 'folder_path' | 'trashed_with'> | null
  const me = loadPrincipal(db, userId)
  return p && me && canSeeProject(files, me, p) ? r as ChatRow : null
}
