// Route module "chats" — owner: component B (docs/WORKPLAN.md).
// Implements: CHATS (chats, messages, stop, regenerate, edit, branch, turn cards, projects)
// Contract: shared/src/api/chats.ts. Only the person's own chats; "not yours" and "missing" are both not_found.
import { API, WINDOW_HEADER, type Attachment, type Chat, type EngineId, type Locale, type Message } from '@mycel/shared/api'
import type { Context } from 'hono'
import type { RouteModule } from './module'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import type { AuthInfo } from '../services'
import { fail } from '../http/errors'
import { newId } from '../db'
import { getChatRuntime, installChatRuntime, type ChatRuntime } from '../chat/runtime'
import { CHAT_COLS, decodeCursor, encodeCursor, type ChatRow, type MessageRow } from '../chat/store'
import { canRead, canWrite, ensureProjectFolder } from '../chat/projects'
import { tr } from '../chat/i18n'

const WINDOW_RE = /^[A-Za-z0-9_-]{8,64}$/
export const windowOf = (c: Context<AppEnv>) => { const w = c.req.header(WINDOW_HEADER); return w && WINDOW_RE.test(w) ? w : null }
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m)

function ownChat(rt: ChatRuntime, auth: AuthInfo, id: string, o: { deleted?: boolean } = {}): ChatRow {
  const r = rt.store.ownChat(auth.user.id, id, o)
  if (!r) fail('not_found')
  return r!
}
function chatOut(rt: ChatRuntime, r: ChatRow): Chat { return rt.store.toChat(r, rt.runState(r.id)) }

function principal(ctx: AppContext, auth: AuthInfo) {
  try { return ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
}

/** Attachments of the message (component C stores them; B only reads them back by id). */
function attachments(ctx: AppContext, auth: AuthInfo, chatId: string, ids: string[], locale: Locale): Attachment[] {
  if (!ids.length) return []
  const store = ctx.services.attachments
  const found = store ? store.get(auth.user.id, chatId, ids) : []
  if (found.length !== new Set(ids).size) fail('validation', tr('attachmentsUnavailable', locale), { fields: { 'body.attachmentIds': 'unknown attachment' } })
  return found
}

/** The active branch, newest `limit` messages (or the ones before `cursor`), oldest first. */
function messagesPage(rt: ChatRuntime, chat: ChatRow, cursor: string | undefined, limit: number): { items: Message[]; nextCursor: string | null } {
  const pathRows = rt.store.pathTo(chat.active_leaf_id)
  let end = pathRows.length
  if (cursor) {
    const c = decodeCursor<{ before: string }>(cursor)
    const i = c ? pathRows.findIndex((m) => m.id === c.before) : -1
    if (i < 0) return { items: [], nextCursor: null }
    end = i
  }
  const start = Math.max(0, end - limit)
  const slice = pathRows.slice(start, end)
  return { items: slice.map((m) => rt.liveMessage(m)), nextCursor: start > 0 ? encodeCursor({ before: slice[0]!.id }) : null }
}

function pickEngine(rt: ChatRuntime, chat: ChatRow, body: { engine?: EngineId; model?: string | null }): { engine: EngineId; model: string | null } {
  const engine: EngineId = body.engine ?? (chat.engine === 'codex' ? 'codex' : 'claude-code')
  const model = body.model !== undefined ? body.model : body.engine && body.engine !== chat.engine ? null : chat.model ?? rt.defaultModelFor(engine)
  return { engine, model: model ?? null }
}

function messageInChat(rt: ChatRuntime, chatId: string, id: string): MessageRow {
  const m = rt.store.messageRow(id)
  if (!m || m.chat_id !== chatId) fail('not_found')
  return m!
}

const isClientIdClash = (e: unknown) => /UNIQUE constraint failed: messages\.chat_id, messages\.client_message_id/.test(String((e as Error)?.message ?? e))

export const chatsRoutes: RouteModule = {
  name: 'chats',
  owner: 'B',
  init(ctx) {
    const rt = installChatRuntime(ctx)
    ctx.services.realtime = rt.hub
    rt.recover()
  },
  register(kit, ctx) {
    const rt = getChatRuntime(ctx)

    // ---------------- chats ----------------
    kit.handle(API.listChats, ({ query, auth }) => {
      const limit = query.limit ?? 50
      const where: string[] = ['user_id = ?']
      const args: (string | number)[] = [auth.user.id]
      where.push(query.trash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL')
      if (query.projectId) { where.push('project_id = ?'); args.push(query.projectId) }
      const q = query.q?.trim()
      if (q) {
        const like = `%${likeEscape(q)}%`
        where.push(`(title LIKE ? ESCAPE '\\' OR id IN (SELECT chat_id FROM messages_fts WHERE content LIKE ? ESCAPE '\\'))`)
        args.push(like, like)
      }
      const cur = decodeCursor<{ u: string; id: string }>(query.cursor)
      if (cur) { where.push('(updated_at < ? OR (updated_at = ? AND id < ?))'); args.push(cur.u, cur.u, cur.id) }
      const rows = ctx.db.query(`SELECT ${CHAT_COLS} FROM chats WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args, limit + 1) as ChatRow[]
      const more = rows.length > limit
      const items = rows.slice(0, limit)
      const last = items[items.length - 1]
      return { items: items.map((r) => chatOut(rt, r)), nextCursor: more && last ? encodeCursor({ u: last.updated_at, id: last.id }) : null }
    })

    kit.handle(API.createChat, ({ body, auth }) => {
      if (body.projectId) {
        const p = rt.store.projectRow(body.projectId)
        if (!p || !canRead(ctx.files, principal(ctx, auth), p.folder_path)) fail('not_found')
      }
      const id = newId()
      const now = new Date().toISOString()
      const engine = body.engine ?? rt.defaultEngine()
      const model = body.model !== undefined ? body.model : (body.engine ? null : rt.defaultModel())
      ctx.db.query('INSERT INTO chats (id, user_id, project_id, title, engine, model, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, auth.user.id, body.projectId ?? null, body.title?.trim() ?? '', engine, model ?? null, now, now)
      rt.publishChat(auth.user.id, id, 'created')
      return chatOut(rt, rt.store.chatRow(id)!)
    })

    kit.handle(API.getChat, ({ params, auth }) => chatOut(rt, ownChat(rt, auth, params.id, { deleted: true })))

    kit.handle(API.updateChat, ({ params, body, auth }) => {
      const chat = ownChat(rt, auth, params.id)
      if (body.projectId) {
        const p = rt.store.projectRow(body.projectId)
        if (!p || !canRead(ctx.files, principal(ctx, auth), p.folder_path)) fail('not_found')
      }
      const sets: string[] = []
      const args: (string | null)[] = []
      if (body.title !== undefined) { sets.push('title = ?'); args.push(body.title.trim()) }
      if (body.projectId !== undefined) { sets.push('project_id = ?'); args.push(body.projectId) }
      if (body.engine !== undefined) { sets.push('engine = ?'); args.push(body.engine) }
      if (body.model !== undefined) { sets.push('model = ?'); args.push(body.model) }
      else if (body.engine !== undefined && body.engine !== chat.engine) sets.push('model = NULL')
      if (sets.length) {
        sets.push('updated_at = ?'); args.push(new Date().toISOString())
        ctx.db.query(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...args, chat.id)
        rt.publishChat(auth.user.id, chat.id, 'updated')
      }
      return chatOut(rt, rt.store.chatRow(chat.id)!)
    })

    kit.handle(API.deleteChat, ({ params, auth }) => {
      const chat = ownChat(rt, auth, params.id)
      rt.stopChat(chat.id)
      const now = new Date()
      ctx.db.query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(now.toISOString(), chat.id)
      rt.publishChat(auth.user.id, chat.id, 'deleted')
      return { id: chat.id, deletedAt: now.toISOString(), purgeAt: new Date(now.getTime() + rt.chatTrashDays() * 86400_000).toISOString() }
    })

    kit.handle(API.restoreChat, ({ params, auth }) => {
      const chat = ownChat(rt, auth, params.id, { deleted: true })
      if (chat.deleted_at) {
        ctx.db.query('UPDATE chats SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), chat.id)
        rt.publishChat(auth.user.id, chat.id, 'restored')
      }
      return chatOut(rt, rt.store.chatRow(chat.id)!)
    })

    // ---------------- messages ----------------
    kit.handle(API.listMessages, ({ params, query, auth }) => {
      const chat = ownChat(rt, auth, params.id, { deleted: true })
      return messagesPage(rt, chat, query.cursor, query.limit ?? 50)
    })

    kit.handle(API.sendMessage, ({ c, params, body, auth }) => {
      const chat = ownChat(rt, auth, params.id)
      const again = rt.existingTurn(chat.id, body.clientMessageId)
      if (again) return again
      if (rt.activeTurn(chat.id)) fail('conflict', tr('turnInProgress', c.get('locale')))
      const parentId = body.parentId === undefined ? chat.active_leaf_id : body.parentId
      if (parentId) {
        const p = messageInChat(rt, chat.id, parentId)
        if (p.role !== 'assistant') fail('validation', tr('badParent', c.get('locale')), { fields: { 'body.parentId': 'must be an answer' } })
      }
      const atts = attachments(ctx, auth, chat.id, body.attachmentIds, c.get('locale'))
      const { engine, model } = pickEngine(rt, chat, body)
      try {
        return rt.createTurn({ chat, userId: auth.user.id, locale: rt.userLocale(auth.user.id), windowId: windowOf(c), clientKind: auth.session.client, engine, model,
          user: { parentId, content: body.content, attachments: atts, clientMessageId: body.clientMessageId } })
      } catch (e) {
        if (isClientIdClash(e)) { const r = rt.existingTurn(chat.id, body.clientMessageId); if (r) return r }
        throw e
      }
    })

    kit.handle(API.stop, ({ params, auth }) => {
      const chat = ownChat(rt, auth, params.id)
      const turnId = rt.stopChat(chat.id)
      return { stopped: !!turnId, turnId }
    })

    kit.handle(API.regenerate, ({ c, params, body, auth }) => {
      const chat = ownChat(rt, auth, params.id)
      const target = messageInChat(rt, chat.id, params.messageId)
      if (target.role !== 'assistant' || !target.parent_id) fail('validation', tr('notAssistantMessage', c.get('locale')))
      const question = messageInChat(rt, chat.id, target.parent_id!)
      if (question.role !== 'user') fail('validation', tr('notAssistantMessage', c.get('locale')))
      if (rt.activeTurn(chat.id)) fail('conflict', tr('turnInProgress', c.get('locale')))
      const { engine, model } = pickEngine(rt, chat, body)
      return rt.createTurn({ chat, userId: auth.user.id, locale: rt.userLocale(auth.user.id), windowId: windowOf(c), clientKind: auth.session.client, engine, model, answerTo: question })
    })

    kit.handle(API.editMessage, ({ c, params, body, auth }) => {
      const chat = ownChat(rt, auth, params.id)
      const again = rt.existingTurn(chat.id, body.clientMessageId)
      if (again) return again
      const target = messageInChat(rt, chat.id, params.messageId)
      if (target.role !== 'user') fail('validation', tr('notUserMessage', c.get('locale')))
      if (rt.activeTurn(chat.id)) fail('conflict', tr('turnInProgress', c.get('locale')))
      const atts = attachments(ctx, auth, chat.id, body.attachmentIds, c.get('locale'))
      const { engine, model } = pickEngine(rt, chat, body)
      try {
        return rt.createTurn({ chat, userId: auth.user.id, locale: rt.userLocale(auth.user.id), windowId: windowOf(c), clientKind: auth.session.client, engine, model,
          user: { parentId: target.parent_id, content: body.content, attachments: atts, clientMessageId: body.clientMessageId } })
      } catch (e) {
        if (isClientIdClash(e)) { const r = rt.existingTurn(chat.id, body.clientMessageId); if (r) return r }
        throw e
      }
    })

    kit.handle(API.selectBranch, ({ params, body, auth }) => {
      const chat = ownChat(rt, auth, params.id)
      messageInChat(rt, chat.id, body.messageId)
      const leaf = rt.store.newestLeafUnder(chat.id, body.messageId)
      ctx.db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(leaf, chat.id)
      return messagesPage(rt, { ...chat, active_leaf_id: leaf }, undefined, 50)
    })

    // ---------------- cards (ask_user, browser site) ----------------
    kit.handle(API.listTurnRequests, ({ c, params, auth }) => {
      const chat = ownChat(rt, auth, params.id)
      const turnId = rt.activeTurn(chat.id)
      const exec = turnId ? rt.execFor(turnId) : undefined
      if (!exec) return { items: [] }
      const w = windowOf(c)
      return {
        items: exec.openRequests().filter((r) => !r.window || r.window === w)
          .map((r) => ({ turnId: exec.id, chatId: chat.id, messageId: exec.spec.assistantId, request: r.request })),
      }
    })

    kit.handle(API.answerTurn, ({ c, params, body, auth }) => {
      const t = ctx.db.query('SELECT user_id FROM turns WHERE id = ?').get(params.id) as { user_id: string } | null
      if (!t || t.user_id !== auth.user.id) fail('not_found')
      const exec = rt.execFor(params.id)
      const value = body.kind === 'ask_user' ? body.answer : body.decision
      if (!exec || !exec.answer(body.requestId, body.kind, value)) fail('conflict', tr('requestClosed', c.get('locale')))
    })

    // ---------------- projects ----------------
    kit.handle(API.listProjects, ({ auth }) => {
      const p = principal(ctx, auth)
      const rows = ctx.db.query('SELECT id, name, folder_path, instructions, created_by, created_at FROM projects ORDER BY name COLLATE NOCASE, id').all() as Parameters<typeof rt.store.toProject>[0][]
      return { items: rows.filter((r) => canRead(ctx.files, p, r.folder_path)).map((r) => rt.store.toProject(r, canWrite(ctx.files, p, r.folder_path))) }
    })

    kit.handle(API.createProject, ({ c, body, auth }) => {
      const p = principal(ctx, auth)
      const folder = ensureProjectFolder(ctx.files, p, body.folderPath, c.get('locale'))
      const id = newId()
      ctx.db.query('INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, body.name, folder, body.instructions, auth.user.id, new Date().toISOString())
      return rt.store.toProject(rt.store.projectRow(id)!, true)
    })

    kit.handle(API.getProject, ({ params, auth }) => {
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canRead(ctx.files, p, r.folder_path)) fail('not_found')
      return rt.store.toProject(r!, canWrite(ctx.files, p, r!.folder_path))
    })

    kit.handle(API.updateProject, ({ c, params, body, auth }) => {
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canRead(ctx.files, p, r.folder_path)) fail('not_found')
      if (!canWrite(ctx.files, p, r!.folder_path)) fail('forbidden', tr('projectFolderNoWrite', c.get('locale')))
      const folder = body.folderPath !== undefined && body.folderPath !== r!.folder_path ? ensureProjectFolder(ctx.files, p, body.folderPath, c.get('locale')) : r!.folder_path
      ctx.db.query('UPDATE projects SET name = ?, folder_path = ?, instructions = ? WHERE id = ?')
        .run(body.name ?? r!.name, folder, body.instructions ?? r!.instructions, r!.id)
      return rt.store.toProject(rt.store.projectRow(r!.id)!, true)
    })

    kit.handle(API.deleteProject, ({ c, params, auth }) => {
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canRead(ctx.files, p, r.folder_path)) fail('not_found')
      if (!canWrite(ctx.files, p, r!.folder_path)) fail('forbidden', tr('projectFolderNoWrite', c.get('locale')))
      ctx.db.transaction(() => {
        ctx.db.query('UPDATE chats SET project_id = NULL WHERE project_id = ?').run(r!.id)
        ctx.db.query('DELETE FROM projects WHERE id = ?').run(r!.id)
      })()
    })
  },
}
