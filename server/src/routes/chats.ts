// Route module "chats" — owner: component B (docs/WORKPLAN.md).
// Implements: CHATS (chats, messages, stop, regenerate, edit, branch, turn cards, projects)
// Contract: shared/src/api/chats.ts. The person's own chats, and the shared project chats they see (chat/shared.ts
// chatFor); "not yours" and "missing" are both not_found.
import { redactorFor } from '../integrations/connections/redact'
import { API, WINDOW_HEADER, type Attachment, type Chat, type EngineId, type Locale, type Message } from '@mycel/shared/api'
import type { Context } from 'hono'
import type { RouteModule } from './module'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import type { AuthInfo } from '../services'
import { fail } from '../http/errors'
import { newId } from '../db'
import { getChatRuntime, installChatRuntime, type ChatRuntime } from '../chat/runtime'
import { CHAT_COLS, PROJECT_COLS, decodeCursor, encodeCursor, type ChatRow, type MessageRow } from '../chat/store'
import { frequentQuestions } from '../chat/frequent-questions'
import { hideTitle } from '../chat/title'
import { notInternalChat } from '../chat/internal-chats'
import fs from 'node:fs'
import path from 'node:path'
import type { FolderRuleInput } from '@mycel/shared/api'
import { assertFolderFree, canRead, canSeeProject, canWrite, ensureProjectFolderEx, lookupFolder, mayEditProject, parentFolder, projectFolderName, projectPaths } from '../chat/projects'
import { badSegment } from '../policy/names'
import { componentC } from '../team-files/component'
import { mapErrors } from '../team-files/errors'
import { afterAccessChange, captureState, dropProjectMarker, ensureFolderRow, replaceRules, validateRules } from '../admin/folders'
import { atLeast, type Principal } from '../policy/access'
import { audit } from '../admin/audit'
import { tr } from '../chat/i18n'
import { chatEnginesFor, checkChatEngineChange, newChatEngine, turnEngine, type TurnEngine } from '../admin/engine-choice'
import { budgetBlock } from '../admin/budgets'
import { viewSources } from '../files/sources'
import { shareAnswerToRoom } from '../chat/answer-share'
import { shareChat } from '../chat/share-chat'
import { finishCard } from '../chat/connect-service'
import { refuseDraftAttachments } from '../onboarding/draft'
import { refuseSkillDraftAttachments } from '../onboarding/skill-draft'
import { refuseShareJudgeAttachments } from '../skills/share-judge'
import { Audiences, accountSeesProject, chatFor, chatPeople, chatView, isSharedRow, messageFor, messageView, projectCanShare, projectShare, sharesNewChats, type ChatAccess, type ChatPeople } from '../chat/shared'
import { AnswerSight, sharedHits, type ChatHit } from '../chat/shared-answers'
import { safeOpsEnabled } from '../safe-ops/runner'
import { forgetPurgedChats } from '../chat/forget'

const WINDOW_RE = /^[A-Za-z0-9_-]{8,64}$/
export const windowOf = (c: Context<AppEnv>) => { const w = c.req.header(WINDOW_HEADER); return w && WINDOW_RE.test(w) ? w : null }
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m)

/** The chat for this request (chat/shared.ts chatFor): the caller's own, or a shared project chat they see, with the
 * access `mode` needs. */
function chatOf(rt: ChatRuntime, c: Context<AppEnv>, auth: AuthInfo, id: string, mode: 'view' | 'continue' | 'manage', o: { deleted?: boolean } = {}): ChatAccess {
  return chatFor(rt, auth.user.id, id, mode, { ...o, locale: c.get('locale') })
}
/** A chat as the API shows it to `viewer` (chat/shared.ts chatView): a stored connection secret of its person never
 * shows in the title (a title made before the key was saved, or a rename; QA B-W5-1). `hide` and `aud`: one each for a
 * whole list; `people`: a project's list, who wrote in its shared chats. */
function chatOut(rt: ChatRuntime, viewer: string, r: ChatRow, o: { hide?: (s: string) => string; aud?: Audiences; people?: Map<string, ChatPeople> } = {}): Chat {
  return chatView(rt, viewer, r, o)
}

function principal(ctx: AppContext, auth: AuthInfo) {
  try { return ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
}

type ProjectRowT = NonNullable<ReturnType<ChatRuntime['store']['projectRow']>>
const isAdmin = (p: Principal) => p.role === 'owner' || p.role === 'admin'
const isPersonalPath = (folder: string) => folder === 'users' || folder.startsWith('users/')
/**
 * Name and instructions (which go into every member's AI context for the project): the creator and admins only,
 * and only while they can write the folder (design tabs 4 / 5 "지침 수정은 만든 사람과 admin 이상"). A personal
 * project under users/<me>/ is only ever reachable by its owner.
 */
const mayEdit = (ctx: AppContext, p: Principal, r: ProjectRowT) => mayEditProject(ctx.files, p, r)
/** a folder made for a request goes again when a later step of it fails: nothing half-made stays behind */
const removeMade = (top: string | null) => { if (top) try { fs.rmSync(top, { recursive: true, force: true }) } catch {} }

/** Tell everyone else who sees the project that its instructions changed (tab 3 지침 6): who can read its folder, and
 * while the folder is in the trash only admins and the owner (canSeeProject; its old path may be read by others now). */
function notifyInstructionsChanged(ctx: AppContext, r: ProjectRowT, by: AuthInfo['user']) {
  const people = ctx.db.query("SELECT id, locale FROM users WHERE status = 'active' AND deleted_at IS NULL AND id != ?").all(by.id) as { id: string; locale: Locale | null }[]
  for (const u of people) {
    let who: Principal
    try { who = ctx.files.principal(u.id) } catch { continue }
    if (!canSeeProject(ctx.files, who, r)) continue
    try {
      ctx.services.realtime.publish(u.id, { type: 'notice', data: { level: 'info', code: 'project_instructions_changed', message: tr('projectInstructionsChanged', u.locale ?? 'ko', { name: r.name, by: by.name }) } })
    } catch (e) { ctx.log.warn('project notice failed', { err: e }) }
  }
}

/** Attachments of the message (component C stores them; B only reads them back by id). */
function attachments(ctx: AppContext, auth: AuthInfo, chatId: string, ids: string[], locale: Locale): Attachment[] {
  if (!ids.length) return []
  // a company profile draft chat takes none (onboarding/draft.ts): no team file reaches its card-free web turn
  refuseDraftAttachments(ctx.db, chatId, ids, locale)
  refuseSkillDraftAttachments(ctx.db, chatId, ids, locale)
  refuseShareJudgeAttachments(ctx.db, chatId, ids)
  const store = ctx.services.attachments
  const r = store?.lookup ? store.lookup(auth.user.id, chatId, ids) : { found: store ? store.get(auth.user.id, chatId, ids) : [], unavailable: [] }
  if (r.found.length === new Set(ids).size) return r.found
  // the caller's own team files that they can no longer open: say so and name those ids (they attached them), so the
  // web can mark them and send without them; any other unknown id gets the general answer
  if (r.unavailable.length && r.found.length + new Set(r.unavailable).size === new Set(ids).size)
    fail('validation', tr('attachmentsTeamUnavailable', locale), { fields: { 'body.attachmentIds': 'team file unavailable' }, params: { reason: 'team_files_unavailable', ids: [...new Set(r.unavailable)].join(',') } })
  return fail('validation', tr('attachmentsUnavailable', locale), { fields: { 'body.attachmentIds': 'unknown attachment' } })
}

/** The active branch, newest `limit` messages (or the ones before `cursor`), oldest first, as `viewer` sees them. */
function messagesPage(rt: ChatRuntime, chat: ChatRow, cursor: string | undefined, limit: number, viewer: string, locale: Locale): { items: Message[]; nextCursor: string | null } {
  const pathRows = rt.store.pathTo(chat.active_leaf_id)
  let end = pathRows.length
  if (cursor) {
    const c = decodeCursor(cursor, ['before'])
    if (!c) fail('validation', undefined, { fields: { 'query.cursor': 'bad cursor' } })
    const i = pathRows.findIndex((m) => m.id === c!.before)
    if (i < 0) return { items: [], nextCursor: null }
    end = i
  }
  const start = Math.max(0, end - limit)
  const slice = pathRows.slice(start, end)
  // one view for the page (a shared chat: the answers hidden from the viewer are worked out once)
  const view = messageView(rt, chat, viewer, locale)
  return { items: slice.map((m) => messageFor(rt, chat, m, viewer, locale, view)), nextCursor: start > 0 ? encodeCursor({ before: slice[0]!.id }) : null }
}

/** The turn's engine and model: the chat's (or the team default when the admin switched it off); a choice in the
 * request only from people who may pick (admin/engine-choice.ts). */
function pickEngine(ctx: AppContext, rt: ChatRuntime, auth: AuthInfo, chat: ChatRow, body: { engine?: EngineId; model?: string | null }, locale: Locale): TurnEngine {
  return turnEngine(ctx, auth.user, chat, body, locale, (e) => rt.defaultModelFor(e))
}

function messageInChat(rt: ChatRuntime, chatId: string, id: string): MessageRow {
  const m = rt.store.messageRow(id)
  if (!m || m.chat_id !== chatId) fail('not_found')
  return m!
}

/** A used-up "block" budget of this person stops the turn before it is queued (tab 5 "사용 한도 도달"). */
function checkBudget(ctx: AppContext, userId: string, locale: Locale): void {
  const b = budgetBlock(ctx.db, userId, locale)
  if (b) fail('budget_exceeded', b.message)
}

/** One turn at a time per chat. A shared chat busy with someone else's question: 409 shared_chat_busy, naming them
 * (the composer keeps the text; Chat.shared.answering shows the same line). */
function busyCheck(rt: ChatRuntime, a: ChatAccess, locale: Locale, me: string) {
  if (!rt.activeTurn(a.row.id)) return
  const runner = rt.activeTurnUser(a.row.id)
  if (a.shared && runner && runner !== me) fail('conflict', tr('sharedChatBusy', locale, { name: rt.store.userRef(runner)?.name ?? '' }), { params: { reason: 'shared_chat_busy' } })
  fail('conflict', tr('turnInProgress', locale))
}

const isClientIdClash = (e: unknown) => /UNIQUE constraint failed: messages\.chat_id, messages\.client_message_id/.test(String((e as Error)?.message ?? e))

export const chatsRoutes: RouteModule = {
  name: 'chats',
  owner: 'B',
  async init(ctx) {
    const rt = installChatRuntime(ctx)
    ctx.services.realtime = rt.hub
    await rt.recover()
  },
  register(kit, ctx) {
    const rt = getChatRuntime(ctx)
    const busy = (a: ChatAccess, locale: Locale, me: string) => busyCheck(rt, a, locale, me)
    /** a project as the API shows it, with its shared chats (chat/shared.ts projectShare) */
    const projectOut = (r: ProjectRowT, canEdit: boolean) => rt.store.toProject(r, canEdit, projectShare(ctx.db, ctx.files, r))
    kit.handle(API.frequentQuestions, ({ auth }) => frequentQuestions(ctx.db, auth.user.id))

    // ---------------- chats ----------------
    kit.handle(API.listChats, ({ query, auth }) => {
      const me = auth.user.id
      const limit = query.limit ?? 50
      // a room's AI session (rooms/ai.ts) and the server's own draft chats (the company profile, a team skill) are not
      // the person's conversations: never listed or found by a search (chat/internal-chats.ts)
      const where: string[] = ['room_id IS NULL', notInternalChat(ctx.db)]
      const args: (string | number)[] = []
      if (query.trash) {
        // the trash holds my own chats (a deleted shared chat goes to its creator's) and the shared chats I deleted (an
        // editor of the project finds someone else's there too), each once and only while I may restore it (below)
        where.push('deleted_at IS NOT NULL', '(user_id = ? OR (deleted_by = ? AND shared_at IS NOT NULL AND project_id IS NOT NULL))'); args.push(me, me)
        if (query.projectId) { where.push('project_id = ?'); args.push(query.projectId) }
      } else if (query.projectId) {
        // a project's page: my chats there and every shared chat of it (each only while I see the project, below)
        where.push('deleted_at IS NULL', 'project_id = ?', '(user_id = ? OR shared_at IS NOT NULL)'); args.push(query.projectId, me)
      } else {
        // my chat list: my chats and the shared chats I wrote in (docs/DECISIONS.md "Shared project chats": no section
        // of their own)
        where.push('deleted_at IS NULL', "(user_id = ? OR (shared_at IS NOT NULL AND id IN (SELECT chat_id FROM messages WHERE role = 'user' AND author_id = ?)))"); args.push(me, me)
      }
      const q = query.q?.trim()
      if (q) {
        const like = `%${likeEscape(q)}%`
        where.push(`(title LIKE ? ESCAPE '\\' OR id IN (SELECT chat_id FROM messages_fts WHERE content LIKE ? ESCAPE '\\'))`)
        args.push(like, like)
      }
      const cur = decodeCursor(query.cursor, ['u', 'id'])
      if (query.cursor && !cur) fail('validation', undefined, { fields: { 'query.cursor': 'bad cursor' } })
      // a shared chat only while I see its project now (its creator too): pages are read until one is full. A search
      // finds a shared chat by its title or a message I see: never by an answer hidden from me (chat/shared-answers.ts).
      // In the trash only what I may restore (chatFor 'manage'): its creator, or an editor of its project now
      const aud = new Audiences(ctx.db, ctx.files)
      const sight = new AnswerSight(ctx.db, ctx.files)
      // the messages of shared chats that hold the words: one search for the request (the chat id is not indexed)
      let hits: Map<string, ChatHit> | null = null
      const found = (r: ChatRow) => {
        const like = `%${likeEscape(q!)}%`
        if (ctx.db.query("SELECT 1 FROM chats WHERE id = ? AND title LIKE ? ESCAPE '\\'").get(r.id, like)) return true
        hits ??= sharedHits(ctx.db, like)
        const hit = hits.get(r.id)
        if (!hit) return false
        if (hit.question) return true
        const hidden = sight.withheld(r.id, me)
        return hit.answers.some((id) => !hidden.has(id))
      }
      let who: Principal | null | undefined
      const mayRestore = (r: ChatRow, p: ProjectRowT) => {
        if (r.user_id === me) return true
        if (who === undefined) { try { who = ctx.files.principal(me) } catch { who = null } }
        return !!who && mayEdit(ctx, who, p)
      }
      const visible = (r: ChatRow) => {
        if (!isSharedRow(r)) return true
        const p = rt.store.projectRow(r.project_id!)
        return !!p && aud.sees(me, p) && (!q || found(r)) && (!query.trash || mayRestore(r, p))
      }
      const out: ChatRow[] = []
      let after = cur
      for (let round = 0; round < 50 && out.length <= limit; round++) {
        const w = [...where], a = [...args]
        if (after) { w.push('(updated_at < ? OR (updated_at = ? AND id < ?))'); a.push(after.u, after.u, after.id) }
        const rows = ctx.db.query(`SELECT ${CHAT_COLS} FROM chats WHERE ${w.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...a, limit + 1) as ChatRow[]
        for (const r of rows) if (visible(r)) out.push(r)
        const last = rows[rows.length - 1]
        if (!last || rows.length < limit + 1) break
        after = { u: last.updated_at, id: last.id }
      }
      const more = out.length > limit
      const items = out.slice(0, limit)
      const lastItem = items[items.length - 1]
      const hide = redactorFor(ctx, me).hide
      // a project's page: who wrote in each of its shared chats listed here (all of them visible to me, above), in one
      // query for the page
      const people = query.projectId && !query.trash ? chatPeople(ctx.db, items.filter(isSharedRow).map((r) => r.id)) : undefined
      return { items: items.map((r) => chatOut(rt, me, r, { aud, ...(r.user_id === me ? { hide } : {}), ...(people ? { people } : {}) })), nextCursor: more && lastItem ? encodeCursor({ u: lastItem.updated_at, id: lastItem.id }) : null }
    })

    kit.handle(API.chatEngines, ({ c, auth }) => chatEnginesFor(ctx, auth.user, rt.engines.get().problems, c.get('locale')))

    kit.handle(API.createChat, ({ c, body, auth }) => {
      const { engine, model } = newChatEngine(ctx, auth.user, body, c.get('locale'))
      // a chat made in a project that shares its chats is a shared chat, from its first moment and for good (never a
      // personal project, never while safe operations are on: chat/shared.ts sharesNewChats)
      let shared = false
      if (body.projectId) {
        const p = rt.store.projectRow(body.projectId)
        if (!p || !canSeeProject(ctx.files, principal(ctx, auth), p)) fail('not_found')
        // only admins see a project whose folder is in the trash, and no turn gets it: a chat there would get nothing
        if (p!.trashed_with !== null) fail('conflict', tr('projectInTrash', c.get('locale')), { fields: { 'body.projectId': 'project_in_trash' }, params: { reason: 'project_in_trash' } })
        shared = sharesNewChats(p!)
      }
      const id = newId()
      const now = new Date().toISOString()
      // a title given here is the person's own (the AI does not rename it); none: the first message gives one
      // a stored connection secret or a secret-looking part is never kept in a title (QA B-W5-1, SEC-16, B-W47-3)
      const title = hideTitle(body.title?.trim() ?? '', redactorFor(ctx, auth.user.id).hide)
      ctx.db.query('INSERT INTO chats (id, user_id, project_id, title, title_source, engine, model, created_at, updated_at, shared_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, auth.user.id, body.projectId ?? null, title, title ? 'user' : 'auto', engine, model ?? null, now, now, shared ? now : null)
      rt.publishChat(auth.user.id, id, 'created')
      return chatOut(rt, auth.user.id, rt.store.chatRow(id)!)
    })

    kit.handle(API.getChat, ({ c, params, auth }) => chatOut(rt, auth.user.id, chatOf(rt, c, auth, params.id, 'view', { deleted: true }).row))
    // the person has the chat on screen: its finished answers are seen; every window and device hears it (chat.updated).
    // A shared chat keeps one mark, its creator's (unseen markers per viewer are not in phase 1)
    kit.handle(API.markChatSeen, ({ c, params, auth }) => {
      const a = chatOf(rt, c, auth, params.id, 'view', { deleted: true })
      const chat = a.row
      if (a.shared && !a.creator) return chatOut(rt, auth.user.id, chat)
      const was = rt.store.unseen(chat)
      rt.store.markSeen(chat.id)
      const after = rt.store.chatRow(chat.id)!
      // only a change is told (an answer the mark cannot reach, one dated after the server's clock, is no change: the
      // windows would ask again and again); a chat in the trash is not in any sidebar (an 'updated' would put it back
      // there). Session markers: docs/DECISIONS.md.
      if (was && !rt.store.unseen(after) && !chat.deleted_at) rt.publishChat(auth.user.id, chat.id, 'updated')
      return chatOut(rt, auth.user.id, after)
    })
    // a shared chat: the place in the queue and the turn are the runner's; the others learn only the state
    kit.handle(API.getChatQueue, ({ c, params, auth }) => {
      const a = chatOf(rt, c, auth, params.id, 'view', { deleted: true })
      const snap = rt.queueSnapshot(a.row.id)
      const runner = rt.activeTurnUser(a.row.id)
      return a.shared && runner && runner !== auth.user.id ? { ...snap, turnId: null, messageId: null, position: null } : snap
    })

    kit.handle(API.updateChat, ({ c, params, body, auth }) => {
      const a = chatOf(rt, c, auth, params.id, 'view')
      const chat = a.row
      if (a.shared) {
        // a shared chat's name and engine are its creator's; it stays in its project (its people see it there)
        if (!a.creator) fail('forbidden', tr('sharedChatCreatorOnly', c.get('locale')), { params: { reason: 'shared_chat_creator' } })
        if (body.projectId !== undefined && body.projectId !== chat.project_id) fail('conflict', tr('sharedChatMove', c.get('locale')), { fields: { 'body.projectId': 'shared_chat_move' }, params: { reason: 'shared_chat_move' } })
      }
      checkChatEngineChange(ctx, auth.user, chat, body, c.get('locale'))
      if (body.projectId) {
        const p = rt.store.projectRow(body.projectId)
        if (!p || !canSeeProject(ctx.files, principal(ctx, auth), p)) fail('not_found')
        // only admins see a project whose folder is in the trash, and no turn gets it: a chat there would get nothing
        if (p!.trashed_with !== null) fail('conflict', tr('projectInTrash', c.get('locale')), { fields: { 'body.projectId': 'project_in_trash' }, params: { reason: 'project_in_trash' } })
      }
      const sets: string[] = []
      const args: (string | null)[] = []
      // a rename is the person's: the AI does not name this chat after it (chat/title.ts)
      if (body.title !== undefined) { sets.push('title = ?', "title_source = 'user'"); args.push(hideTitle(body.title.trim(), redactorFor(ctx, auth.user.id).hide)) }
      if (body.projectId !== undefined) { sets.push('project_id = ?'); args.push(body.projectId) }
      if (body.engine !== undefined) { sets.push('engine = ?'); args.push(body.engine) }
      if (body.model !== undefined) { sets.push('model = ?'); args.push(body.model) }
      else if (body.engine !== undefined && body.engine !== chat.engine) sets.push('model = NULL')
      if (sets.length) {
        sets.push('updated_at = ?'); args.push(new Date().toISOString())
        ctx.db.query(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...args, chat.id)
        rt.publishChat(auth.user.id, chat.id, 'updated')
      }
      return chatOut(rt, auth.user.id, rt.store.chatRow(chat.id)!)
    })

    // a shared chat: its creator or an editor of its project; someone else's deletion is audited (it leaves the
    // creator's list for their trash, and is in the deleter's trash too while they may restore it)
    kit.handle(API.deleteChat, ({ c, params, auth }) => {
      const a = chatOf(rt, c, auth, params.id, 'manage')
      const chat = a.row
      rt.stopChat(chat.id)
      const now = new Date()
      // who deleted it: a shared chat is in their trash too while they may restore it (listChats)
      ctx.db.query('UPDATE chats SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now.toISOString(), auth.user.id, chat.id)
      if (a.shared && !a.creator) audit(ctx.db, { actor: auth.user.id, action: 'chat.delete', target: chat.id, detail: { shared: true, projectId: chat.project_id } })
      rt.publishChat(auth.user.id, chat.id, 'deleted')
      return { id: chat.id, deletedAt: now.toISOString(), purgeAt: new Date(now.getTime() + rt.chatTrashDays() * 86400_000).toISOString() }
    })

    // a shared chat comes back only while its project is visible (chatFor), by its creator or an editor of the project
    kit.handle(API.restoreChat, ({ c, params, auth }) => {
      const chat = chatOf(rt, c, auth, params.id, 'manage', { deleted: true }).row
      if (chat.deleted_at) {
        ctx.db.query('UPDATE chats SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), chat.id)
        rt.publishChat(auth.user.id, chat.id, 'restored')
      }
      return chatOut(rt, auth.user.id, rt.store.chatRow(chat.id)!)
    })

    // ---------------- messages ----------------
    kit.handle(API.listMessages, ({ c, params, query, auth }) => {
      const chat = chatOf(rt, c, auth, params.id, 'view', { deleted: true }).row
      return messagesPage(rt, chat, query.cursor, query.limit ?? 50, auth.user.id, c.get('locale'))
    })

    // "참고한 파일" under an answer: each file checked again for this person now (files/sources.ts); a file they cannot
    // open is only counted. The chat is one the caller sees, as for every message route.
    kit.handle(API.messageSources, ({ c, params, auth }) => {
      const chat = chatOf(rt, c, auth, params.id, 'view', { deleted: true }).row
      const m = messageInChat(rt, chat.id, params.messageId)
      if (m.role !== 'assistant') return { files: [], unavailable: 0 }
      // a shared chat's answer hidden from me: nothing of it (chat/shared-answers.ts)
      if (messageView(rt, chat, auth.user.id, c.get('locale'))?.withheld?.(m.id) && (!m.turn_id || rt.store.turnUser(m.turn_id) !== auth.user.id)) return { files: [], unavailable: 0 }
      return viewSources(ctx.db, ctx.files.fx, () => ctx.files.rules(), auth.user.id, m.id)
    })

    // "대화방에 보내기": a finished answer of my own chat to a room I am in, as my message, with the linked files asked
    // for attached; "confirm" first when some member cannot open a linked file or see material it used
    // (chat/answer-share.ts). Not from a room's AI session or a deleted chat (404).
    // A shared chat (phase 1): only the person whose question the answer was, an answer of their own turn
    kit.handle(API.shareAnswerToRoom, ({ c, params, body, auth }) => {
      const a = chatOf(rt, c, auth, params.id, 'view')
      const m = messageInChat(rt, a.row.id, params.messageId)
      if (a.shared && (!m.turn_id || rt.store.turnUser(m.turn_id) !== auth.user.id)) fail('not_found')
      return shareAnswerToRoom(ctx, auth.user.id, a.row, m, body, c.get('locale'))
    })

    // "프로젝트 사람들과 공유": my private chat in a team project that shares its chats becomes a shared chat, after a check
    // of what it contains, every branch (chat/share-chat.ts); a shared chat answers 409 already_shared to whoever sees it
    kit.handle(API.shareChat, ({ c, params, body, auth }) => shareChat(ctx, rt, auth.user.id, chatOf(rt, c, auth, params.id, 'view'), body, c.get('locale')))

    kit.handle(API.sendMessage, ({ c, params, body, auth }) => {
      const a = chatOf(rt, c, auth, params.id, 'continue')
      const chat = a.row
      const again = rt.existingTurn(chat.id, body.clientMessageId, auth.user.id)
      if (again) return again
      busy(a, c.get('locale'), auth.user.id)
      const parentId = body.parentId === undefined ? chat.active_leaf_id : body.parentId
      if (parentId) {
        const p = messageInChat(rt, chat.id, parentId)
        if (p.role !== 'assistant') fail('validation', tr('badParent', c.get('locale')), { fields: { 'body.parentId': 'must be an answer' } })
      }
      const atts = attachments(ctx, auth, chat.id, body.attachmentIds, c.get('locale'))
      // a shared chat takes team files only (D3): a computer upload never reaches it
      if (a.shared && atts.some((x) => x.source !== 'team')) fail('conflict', tr('sharedChatUpload', c.get('locale')), { params: { reason: 'shared_chat_upload' } })
      checkBudget(ctx, auth.user.id, c.get('locale'))
      const { engine, model, substitutedFrom } = pickEngine(ctx, rt, auth, chat, body, c.get('locale'))
      try {
        return rt.createTurn({ chat, userId: auth.user.id, locale: rt.userLocale(auth.user.id), windowId: windowOf(c), clientKind: auth.session.client, engine, model, substitutedFrom,
          user: { parentId, content: body.content, attachments: atts, clientMessageId: body.clientMessageId } })
      } catch (e) {
        if (isClientIdClash(e)) { const r = rt.existingTurn(chat.id, body.clientMessageId, auth.user.id); if (r) return r }
        throw e
      }
    })

    // a shared chat: only the person whose turn it is stops it
    kit.handle(API.stop, ({ c, params, auth }) => {
      const a = chatOf(rt, c, auth, params.id, 'view')
      const runner = rt.activeTurnUser(a.row.id)
      if (a.shared && runner && runner !== auth.user.id) fail('forbidden', tr('sharedChatRunnerOnly', c.get('locale')), { params: { reason: 'shared_chat_runner' } })
      const turnId = rt.stopChat(a.row.id)
      return { stopped: !!turnId, turnId }
    })

    // a shared chat: an answer to one's own question only
    kit.handle(API.regenerate, ({ c, params, body, auth }) => {
      const a = chatOf(rt, c, auth, params.id, 'continue')
      const chat = a.row
      const target = messageInChat(rt, chat.id, params.messageId)
      if (target.role !== 'assistant' || !target.parent_id) fail('validation', tr('notAssistantMessage', c.get('locale')))
      const question = messageInChat(rt, chat.id, target.parent_id!)
      if (question.role !== 'user') fail('validation', tr('notAssistantMessage', c.get('locale')))
      if (a.shared && question.author_id !== auth.user.id) fail('forbidden', tr('sharedChatOwnMessages', c.get('locale')), { params: { reason: 'shared_chat_own_messages' } })
      busy(a, c.get('locale'), auth.user.id)
      checkBudget(ctx, auth.user.id, c.get('locale'))
      const { engine, model, substitutedFrom } = pickEngine(ctx, rt, auth, chat, body, c.get('locale'))
      return rt.createTurn({ chat, userId: auth.user.id, locale: rt.userLocale(auth.user.id), windowId: windowOf(c), clientKind: auth.session.client, engine, model, substitutedFrom, answerTo: question })
    })

    // a shared chat: one's own messages only
    kit.handle(API.editMessage, ({ c, params, body, auth }) => {
      const a = chatOf(rt, c, auth, params.id, 'continue')
      const chat = a.row
      const again = rt.existingTurn(chat.id, body.clientMessageId, auth.user.id)
      if (again) return again
      const target = messageInChat(rt, chat.id, params.messageId)
      if (target.role !== 'user') fail('validation', tr('notUserMessage', c.get('locale')))
      if (a.shared && target.author_id !== auth.user.id) fail('forbidden', tr('sharedChatOwnMessages', c.get('locale')), { params: { reason: 'shared_chat_own_messages' } })
      busy(a, c.get('locale'), auth.user.id)
      const atts = attachments(ctx, auth, chat.id, body.attachmentIds, c.get('locale'))
      if (a.shared && atts.some((x) => x.source !== 'team')) fail('conflict', tr('sharedChatUpload', c.get('locale')), { params: { reason: 'shared_chat_upload' } })
      checkBudget(ctx, auth.user.id, c.get('locale'))
      const { engine, model, substitutedFrom } = pickEngine(ctx, rt, auth, chat, body, c.get('locale'))
      try {
        return rt.createTurn({ chat, userId: auth.user.id, locale: rt.userLocale(auth.user.id), windowId: windowOf(c), clientKind: auth.session.client, engine, model, substitutedFrom,
          user: { parentId: target.parent_id, content: body.content, attachments: atts, clientMessageId: body.clientMessageId } })
      } catch (e) {
        if (isClientIdClash(e)) { const r = rt.existingTurn(chat.id, body.clientMessageId, auth.user.id); if (r) return r }
        throw e
      }
    })

    kit.handle(API.selectBranch, ({ c, params, body, auth }) => {
      const chat = chatOf(rt, c, auth, params.id, 'continue').row
      messageInChat(rt, chat.id, body.messageId)
      const leaf = rt.store.newestLeafUnder(chat.id, body.messageId)
      ctx.db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(leaf, chat.id)
      return messagesPage(rt, { ...chat, active_leaf_id: leaf }, undefined, 50, auth.user.id, c.get('locale'))
    })

    // ---------------- cards (ask_user, browser site, connect_service) ----------------
    // a shared chat: the cards are the runner's only (the others see "waiting for ○○'s yes", Chat.shared.answering)
    kit.handle(API.listTurnRequests, ({ c, params, auth }) => {
      const a = chatOf(rt, c, auth, params.id, 'view')
      const chat = a.row
      if (a.shared && rt.activeTurnUser(chat.id) !== auth.user.id) return { items: [] }
      const turnId = rt.activeTurn(chat.id)
      const exec = turnId ? rt.execFor(turnId) : undefined
      if (!exec) return { items: [] }
      const w = windowOf(c)
      return {
        items: exec.openRequests().filter((r) => !r.window || r.window === w)
          .map((r) => ({ turnId: exec.id, chatId: chat.id, messageId: exec.spec.assistantId, request: r.request })),
      }
    })

    /** the caller's own turn (another person's and a missing one are both not_found) */
    const ownTurn = (id: string, auth: AuthInfo) => {
      const t = ctx.db.query('SELECT user_id FROM turns WHERE id = ?').get(id) as { user_id: string } | null
      if (!t || t.user_id !== auth.user.id) fail('not_found')
      return rt.execFor(id)
    }

    kit.handle(API.answerTurn, ({ c, params, body, auth }) => {
      const exec = ownTurn(params.id, auth)
      // a connect_service card is finished only through /connect: what comes here reaches the AI
      if (exec?.openRequest(body.requestId)?.kind === 'connect_service') fail('conflict', tr('requestClosed', c.get('locale')))
      const value = body.kind === 'ask_user' ? body.answer : body.decision
      const done = exec ? exec.answer(body.requestId, body.kind, value) : 'closed'
      if (done === 'closed') fail('conflict', tr('requestClosed', c.get('locale')))
      if (done === 'not_an_option') fail('validation', tr('answerNotOption', c.get('locale')))
    })

    // a connect_service card (chat/connect-service.ts): the key arrives sealed for 'integration.secret' and goes into the
    // connection's store only; the AI learns the outcome
    kit.handle(API.connectTurn, ({ c, params, body, auth }) => finishCard(ctx, ownTurn(params.id, auth), auth, body, c.get('locale')))

    // ---------------- projects ----------------
    kit.handle(API.listProjects, ({ auth }) => {
      const p = principal(ctx, auth)
      const rows = ctx.db.query(`SELECT ${PROJECT_COLS} FROM projects ORDER BY name COLLATE NOCASE, id`).all() as Parameters<typeof rt.store.toProject>[0][]
      const aud = new Audiences(ctx.db, ctx.files)
      return { items: rows.filter((r) => canSeeProject(ctx.files, p, r)).map((r) => rt.store.toProject(r, mayEdit(ctx, p, r), projectShare(ctx.db, ctx.files, r, aud))) }
    })

    kit.handle(API.createProject, ({ c, body, auth }) => {
      const locale = c.get('locale')
      const p = principal(ctx, auth)
      const db = ctx.db
      const id = newId()
      const root = ctx.files.fx.root
      // one project per folder, checked in the transaction that writes the row (docs/DECISIONS.md "Projects: a folder
      // with instructions"). The creator wrote this first version of the instructions: the turns of anyone else count
      // them as outside content (chat/runtime.ts projectTaints).
      const seen = (f: string) => canRead(ctx.files, p, f)
      const insert = (folder: string) => {
        assertFolderFree(db, ctx.files.fx.caseInsensitive, folder, locale, { mayName: seen })
        db.query('INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at, instructions_author, instructions_authored) VALUES (?,?,?,?,?,?,?,?)')
          .run(id, body.name, folder, body.instructions, auth.user.id, new Date().toISOString(), auth.user.id, body.instructions)
      }
      const slug = body.slug?.normalize('NFC')
      if (slug !== undefined && (slug.includes('/') || badSegment(slug))) fail('validation', undefined, { fields: { 'body.slug': 'not a valid folder name' } })
      /** names a new project folder steps around: folders rows (kept rules) and the folders other projects name */
      const takenPaths = () => [...(db.query('SELECT path FROM folders').all() as { path: string }[]).map((r) => r.path), ...projectPaths(db)]
      const undo = removeMade

      // ③ personal: users/<me>/projects/<slug>/, the caller's alone (no folders row under users/: rules are not read
      // there, and admins would see the folder's name in the folder list)
      if (body.scope === 'personal') {
        if (body.participants.length) fail('validation', tr('projectParticipantsNewOnly', locale), { fields: { 'body.participants': 'a personal project has no participants' } })
        let want = body.folderPath
        if (want === undefined) {
          const parent = ensureProjectFolderEx(ctx.files, p, `users/${p.id}/projects`, locale)
          want = `${parent.path}/${projectFolderName(path.join(root, ...parent.path.split('/')), parent.path, projectPaths(db), slug ?? body.name, id)}`
        }
        const f = ensureProjectFolderEx(ctx.files, p, want, locale)
        const segs = f.path.split('/')
        if (segs[0] !== 'users' || segs[1] !== p.id || segs.length < 3) { undo(f.createdTop); fail('validation', tr('projectPersonalFolder', locale), { fields: { 'body.folderPath': 'a personal project lives in users/<me>/' } }) }
        try { db.transaction(() => { insert(f.path); audit(db, { actor: auth.user.id, action: 'project.create', target: id, detail: null }) })() } catch (e) { undo(f.createdTop); throw e }
        return projectOut(rt.store.projectRow(id)!, true)
      }

      // ① a new team project folder projects/<slug>/: admins only, with its rules (participants + creator write)
      let want = body.folderPath
      let fresh = false
      if (want === undefined) {
        if (!isAdmin(p)) fail('forbidden', tr('projectNewTeamAdminOnly', locale))
        fs.mkdirSync(path.join(root, 'projects'), { recursive: true, mode: 0o700 })
        want = `projects/${projectFolderName(path.join(root, 'projects'), 'projects', takenPaths(), slug ?? body.name, id)}`
        fresh = true
      } else {
        const look = lookupFolder(ctx.files, p, want, locale)
        const segs = look.path.split('/')
        if (!look.exists && segs[0] === 'projects' && segs.length === 2) {
          // members may have write somewhere under projects/ through a rule, but a new team project folder is admin+
          if (!isAdmin(p)) fail('forbidden', tr('projectNewTeamAdminOnly', locale))
          fresh = true
        }
        want = look.path
      }
      if (body.participants.length && !fresh) fail('validation', tr('projectParticipantsNewOnly', locale), { fields: { 'body.participants': 'only for a new projects/<slug> folder; existing folders keep their rules' } })

      if (fresh) {
        // an old folder's rules kept by path (renamed, trashed) must not be picked up by the new project
        if (db.query("SELECT 1 FROM folders WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/' LIMIT 1").get(want, want, want)) fail('conflict', tr('projectFolderTaken', locale), { fields: { 'body.folderPath': 'taken' } })
        const rules: FolderRuleInput[] = []
        const seen = new Set<string>()
        for (const x of [...body.participants, { subjectType: 'user' as const, subjectId: p.id }]) {
          const k = `${x.subjectType}:${x.subjectId}`
          if (seen.has(k)) continue
          seen.add(k)
          rules.push({ subjectType: x.subjectType, subjectId: x.subjectId, access: 'write' } as FolderRuleInput)
        }
        validateRules(db, rules, locale, 'body.participants')
        const before = captureState(db)
        const f = ensureProjectFolderEx(ctx.files, p, want, locale)
        try {
          db.transaction(() => {
            const row = ensureFolderRow(db, f.path)
            replaceRules(db, row.id, rules, auth.user.id)
            insert(f.path)
            audit(db, { actor: auth.user.id, action: 'project.create', target: id, detail: { name: body.name, folderPath: f.path, rules } })
          })()
        } catch (e) { undo(f.createdTop); throw e }
        afterAccessChange(ctx, before, { actor: auth.user.id, target: f.path })
        return projectOut(rt.store.projectRow(id)!, true)
      }

      // ② an existing folder (or a new one inside a folder) the caller can write: rules unchanged; a rule-less
      // folders row marks it as a project folder (moves / renames are then admin-only, tab 4), not under users/.
      // That lock may only come from someone who could get around it: on a folder that is not managed yet, the caller
      // must also write the folder it is in (owner decision, docs/DECISIONS.md "Projects: a folder with instructions").
      // A guard: today it refuses nothing. A folder that is not managed has no rules, and a folder without rules has
      // its parent's access (policy/access.ts: the deepest rule that names the person decides), so write on it is
      // write on its parent. It stays in case inheritance ever changes. A member may still make a project on a
      // teammate's subfolder: they could already move or trash that folder themselves.
      // A managed folder (rules, a group's, shared/, skills/, or one holding such a folder) is admin-only already and
      // keeps the rule above; nothing is locked under users/ or on the team root.
      if (want !== '' && !isPersonalPath(want) && !canWrite(ctx.files, p, parentFolder(want)) && !componentC(ctx).files.managedFolder(want))
        fail('forbidden', tr('projectFolderParentNoWrite', locale), { params: { reason: 'parent_not_writable' } })
      const f = ensureProjectFolderEx(ctx.files, p, want, locale)
      try {
        db.transaction(() => {
          if (f.path !== '' && !isPersonalPath(f.path)) ensureFolderRow(db, f.path)
          insert(f.path)
          audit(db, { actor: auth.user.id, action: 'project.create', target: id, detail: isPersonalPath(f.path) ? null : { name: body.name, folderPath: f.path } })
        })()
      } catch (e) { undo(f.createdTop); throw e }
      return projectOut(rt.store.projectRow(id)!, mayEdit(ctx, p, rt.store.projectRow(id)!))
    })

    kit.handle(API.getProject, ({ params, auth }) => {
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canSeeProject(ctx.files, p, r)) fail('not_found')
      return projectOut(r!, mayEdit(ctx, p, r!))
    })

    kit.handle(API.updateProject, ({ c, params, body, auth }) => {
      const locale = c.get('locale')
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canSeeProject(ctx.files, p, r)) fail('not_found')
      if (!canWrite(ctx.files, p, r!.folder_path)) fail('forbidden', tr('projectFolderNoWrite', locale))
      if (!mayEdit(ctx, p, r!)) fail('forbidden', tr('projectCreatorOnly', locale))
      // sharing its chats (docs/DECISIONS.md "Shared project chats"): team projects only; turning it on is refused while
      // safe operations are on (every chat would be confidential) or while its folder is in the trash. Off keeps the
      // chats already shared
      const shareTo = body.shareChats === undefined || (body.shareChats ? 1 : 0) === r!.share_chats ? null : body.shareChats
      if (shareTo !== null) {
        if (!projectCanShare(r!)) fail('conflict', tr('sharedProjectPersonal', locale), { fields: { 'body.shareChats': 'project_personal' }, params: { reason: 'project_personal' } })
        if (shareTo && safeOpsEnabled()) fail('conflict', tr('sharedProjectSafeOps', locale), { fields: { 'body.shareChats': 'safe_ops' }, params: { reason: 'safe_ops' } })
        if (shareTo && r!.trashed_with !== null) fail('conflict', tr('projectInTrash', locale), { fields: { 'body.shareChats': 'project_in_trash' }, params: { reason: 'project_in_trash' } })
      }
      let folder = r!.folder_path
      let made: string | null = null
      // a project whose folder is in the trash (or was purged from it) gets a folder again only this way: an admin
      // points it at a folder, which may be the one now at its old path
      const repoint = body.folderPath !== undefined && (body.folderPath !== r!.folder_path || r!.trashed_with !== null)
      if (repoint && body.folderPath !== undefined) {
        // repointing a team project changes who gets its instructions: admins only, and never into a personal folder
        // (it would vanish for everyone else, the creator included). Sharing a personal project is a copy (share).
        if (!isAdmin(p)) fail('forbidden', tr('projectFolderAdminOnly', locale))
        if (isPersonalPath(body.folderPath)) fail('validation', tr('projectFolderPersonal', locale), { fields: { 'body.folderPath': 'invalid_path: a team project cannot move under users/' } })
        // a project whose folder is in the trash is pointed only at a folder that is there: a folder made for it, at its
        // old path or elsewhere, has no rules of its own and would open its instructions to whoever reads the folder above
        // (review round 4: the edit dialog sent the old path on every save, and a finance project opened to shared/)
        if (r!.trashed_with !== null && !lookupFolder(ctx.files, p, body.folderPath, locale).exists)
          fail('conflict', tr('projectFolderMissing', locale), { fields: { 'body.folderPath': 'project_folder_missing' }, params: { reason: 'project_folder_missing' } })
        const f = ensureProjectFolderEx(ctx.files, p, body.folderPath, locale)
        folder = f.path
        made = f.createdTop
        if (isPersonalPath(folder)) { removeMade(made); fail('validation', tr('projectFolderPersonal', locale), { fields: { 'body.folderPath': 'invalid_path: a team project cannot move under users/' } }) }
      }
      const next = { name: body.name ?? r!.name, instructions: body.instructions ?? r!.instructions }
      // who wrote the instructions: one person only while every saved version is theirs (and the text is still what
      // they saved: a build without these columns may have changed it); otherwise nobody (chat/runtime.ts projectTaints)
      const sole = r!.instructions_author === auth.user.id && r!.instructions_authored === r!.instructions
      const author = next.instructions === r!.instructions ? { by: r!.instructions_author, text: r!.instructions_authored } : sole ? { by: auth.user.id, text: next.instructions } : { by: null, text: null }
      const save = ctx.db.transaction(() => {
        // one project per folder (the folder was checked for write above; an admin can read every team folder)
        if (repoint) assertFolderFree(ctx.db, ctx.files.fx.caseInsensitive, folder, locale, { except: r!.id, mayName: (f) => canRead(ctx.files, p, f) })
        ctx.db.query('UPDATE projects SET name = ?, folder_path = ?, instructions = ?, instructions_author = ?, instructions_authored = ?, trashed_with = ? WHERE id = ?')
          .run(next.name, folder, next.instructions, author.by, author.text, repoint ? null : r!.trashed_with, r!.id)
        if (shareTo !== null) {
          ctx.db.query('UPDATE projects SET share_chats = ? WHERE id = ?').run(shareTo ? 1 : 0, r!.id)
          audit(ctx.db, { actor: auth.user.id, action: 'project.share_chats', target: r!.id, detail: { on: shareTo } })
        }
        // the old folder stops being a project folder: its rule-less marker row goes (else it stays admin-only for good).
        // Not for a project whose folder is in the trash: its marker went there with the folder, and the old path may be
        // another folder's now, whose own rule-less row (an admin's "follow the folder above") must stay.
        if (folder !== r!.folder_path && r!.trashed_with === null) dropProjectMarker(ctx.db, r!.folder_path)
        // a personal project's content stays out of the audit log (admins read it; they cannot read users/<id>/)
        const personal = isPersonalPath(r!.folder_path) && isPersonalPath(folder)
        const changed = { name: next.name !== r!.name, instructions: next.instructions !== r!.instructions, folder: folder !== r!.folder_path }
        if (changed.name || changed.instructions || changed.folder) {
          audit(ctx.db, {
            actor: auth.user.id, action: 'project.update', target: r!.id,
            detail: personal ? { changed } : {
              changed,
              ...(changed.name ? { name: { before: r!.name, after: next.name } } : {}),
              ...(changed.instructions ? { instructions: { before: r!.instructions, after: next.instructions } } : {}),
              ...(changed.folder ? { folderPath: { before: r!.folder_path, after: folder } } : {}),
            },
          })
        }
      })
      try { save() } catch (e) { removeMade(made); throw e }
      const after = rt.store.projectRow(r!.id)!
      if (after.instructions !== r!.instructions) notifyInstructionsChanged(ctx, after, auth.user)
      return projectOut(after, mayEdit(ctx, p, after))
    })

    kit.handle(API.shareProject, async ({ c, params, body, auth }) => {
      const locale = c.get('locale')
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canSeeProject(ctx.files, p, r)) fail('not_found')
      if (!mayEdit(ctx, p, r!)) fail('forbidden', tr('projectCreatorOnly', locale))
      const segs = r!.folder_path.split('/')
      // only a personal project is shared this way; a team project's audience is its folder rules (admin screen)
      if (segs[0] !== 'users' || segs[1] !== p.id || segs.length < 3) fail('validation', tr('projectShareNotPersonal', locale), { fields: { 'params.id': 'not a personal project' } })
      const out = await mapErrors(locale, () => componentC(ctx).files.copyFolderTree(p.id, r!.folder_path, body.toParent, { dryRun: body.dryRun }), 'toParent')
      if ('viewersAdded' in out) return out
      const save = ctx.db.transaction(() => {
        // one project per folder: the copy's name already steps around the folders projects name (copyFolderTree);
        // a project made on that path in the moment since is refused here, and the copy goes again
        assertFolderFree(ctx.db, ctx.files.fx.caseInsensitive, out.path, locale, { except: r!.id, mayName: (f) => canRead(ctx.files, p, f) })
        // the copy is a project folder in a team folder: a rule-less folders row, like a project on an existing folder
        if (!isPersonalPath(out.path)) ensureFolderRow(ctx.db, out.path)
        ctx.db.query('UPDATE projects SET folder_path = ? WHERE id = ?').run(out.path, r!.id)
        dropProjectMarker(ctx.db, r!.folder_path)
        audit(ctx.db, { actor: auth.user.id, action: 'project.share', target: r!.id, detail: isPersonalPath(out.path) ? null : { name: r!.name, folderPath: out.path, files: out.files, bytes: out.bytes } })
      })
      try { save() } catch (e) { componentC(ctx).files.discardCopy(p.id, out.path); throw e }
      const after = rt.store.projectRow(r!.id)!
      return projectOut(after, mayEdit(ctx, p, after))
    })

    kit.handle(API.deleteProject, ({ c, params, auth }) => {
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canSeeProject(ctx.files, p, r)) fail('not_found')
      if (!canWrite(ctx.files, p, r!.folder_path)) fail('forbidden', tr('projectFolderNoWrite', c.get('locale')))
      // other people's chats lose the project context: the creator and admins only, like editing it
      if (!mayEdit(ctx, p, r!)) fail('forbidden', tr('projectCreatorOnly', c.get('locale')))
      // the private chats stay, without project. Its shared chats (those in the trash too) go to their creators' trash,
      // as a single delete does (docs/DECISIONS.md "Shared project chats: the trash and live lists"): each stops being
      // shared and, restored, is its creator's chat without project, keeping the several-authors rules (chat/turn.ts
      // othersWrote, chat/shared.ts messageView). One whose creator would not see the project now (they lost its folder,
      // or the account was deleted) goes for good, as before: nobody could restore it, and giving it back would show its
      // creator what was said after they lost it. Their turns stop; everyone else who saw one hears it is gone.
      const shared = ctx.db.query('SELECT id, user_id, deleted_at FROM chats WHERE project_id = ? AND shared_at IS NOT NULL').all(r!.id) as { id: string; user_id: string; deleted_at: string | null }[]
      const audience = new Audiences(ctx.db, ctx.files).of(r!)
      const kept = shared.filter((x) => accountSeesProject(ctx.db, ctx.files, r!, x.user_id))
      const purged = shared.filter((x) => !kept.includes(x))
      for (const x of shared) rt.stopChat(x.id)
      const now = new Date().toISOString()
      ctx.db.transaction(() => {
        for (const x of purged) rt.purgeChat(x.id)
        // one already in the trash keeps its time there (and who put it there)
        for (const x of kept) ctx.db.query('UPDATE chats SET shared_at = NULL, project_id = NULL, deleted_at = COALESCE(deleted_at, ?), deleted_by = CASE WHEN deleted_at IS NULL THEN ? ELSE deleted_by END WHERE id = ?').run(now, auth.user.id, x.id)
        ctx.db.query('UPDATE chats SET project_id = NULL WHERE project_id = ?').run(r!.id)
        ctx.db.query('DELETE FROM projects WHERE id = ?').run(r!.id)
        // a rule-less folders row that only marked this project's folder goes with it (security review r2: it kept the
        // folder, and every folder above it, admin-only to move, rename or trash for good). Not when its folder is in the
        // trash: the marker is there with it, and the old path may be another folder's now.
        if (r!.trashed_with === null) dropProjectMarker(ctx.db, r!.folder_path)
        audit(ctx.db, { actor: auth.user.id, action: 'project.delete', target: r!.id, detail: isPersonalPath(r!.folder_path) ? null : { name: r!.name, folderPath: r!.folder_path, ...(shared.length ? { sharedChats: shared.length } : {}), ...(purged.length ? { sharedChatsPurged: purged.length } : {}) } })
      })()
      const gone = (id: string, uid: string) => rt.hub.publish(uid, { type: 'chat.updated', data: { chatId: id, change: 'purged', chat: null } })
      for (const x of kept) {
        // its creator: now in their trash (a chat of theirs); one already there was out of their lists
        if (!x.deleted_at) rt.publishChat(x.user_id, x.id, 'deleted')
        for (const uid of audience) if (uid !== x.user_id) gone(x.id, uid)
      }
      for (const x of purged) for (const uid of audience) gone(x.id, uid)
      if (purged.length) void forgetPurgedChats(ctx, purged.map((x) => x.id))
    })
  },
}
