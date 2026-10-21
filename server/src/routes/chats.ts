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
import fs from 'node:fs'
import path from 'node:path'
import type { FolderRuleInput } from '@mycel/shared/api'
import { canRead, canWrite, ensureProjectFolder, ensureProjectFolderEx, lookupFolder, projectFolderName } from '../chat/projects'
import { badSegment } from '../policy/names'
import { componentC } from '../team-files/component'
import { mapErrors } from '../team-files/errors'
import { afterAccessChange, captureState, dropProjectMarker, ensureFolderRow, replaceRules, validateRules } from '../admin/folders'
import { atLeast, type Principal } from '../policy/access'
import { audit } from '../admin/audit'
import { tr } from '../chat/i18n'
import { safeModel } from '../chat/engines'
import { budgetBlock } from '../admin/budgets'

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

type ProjectRowT = NonNullable<ReturnType<ChatRuntime['store']['projectRow']>>
const isAdmin = (p: Principal) => p.role === 'owner' || p.role === 'admin'
const isPersonalPath = (folder: string) => folder === 'users' || folder.startsWith('users/')
/**
 * Name and instructions (which go into every member's AI context for the project): the creator and admins only,
 * and only while they can write the folder (design tabs 4 / 5 "지침 수정은 만든 사람과 admin 이상"). A personal
 * project under users/<me>/ is only ever reachable by its owner.
 */
const mayEdit = (ctx: AppContext, p: Principal, r: ProjectRowT) => canWrite(ctx.files, p, r.folder_path) && (isAdmin(p) || r.created_by === p.id)

/** Tell everyone else who can read the project folder that its instructions changed (tab 3 지침 6). */
function notifyInstructionsChanged(ctx: AppContext, r: ProjectRowT, by: AuthInfo['user']) {
  const rules = ctx.files.rules()
  const segs = r.folder_path === '' ? [] : r.folder_path.split('/')
  const people = ctx.db.query("SELECT id, locale FROM users WHERE status = 'active' AND deleted_at IS NULL AND id != ?").all(by.id) as { id: string; locale: Locale | null }[]
  for (const u of people) {
    let who: Principal
    try { who = ctx.files.principal(u.id) } catch { continue }
    if (!atLeast(rules.access(who, segs), 'read')) continue
    try {
      ctx.services.realtime.publish(u.id, { type: 'notice', data: { level: 'info', code: 'project_instructions_changed', message: tr('projectInstructionsChanged', u.locale ?? 'ko', { name: r.name, by: by.name }) } })
    } catch (e) { ctx.log.warn('project notice failed', { err: e }) }
  }
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
    const c = decodeCursor(cursor, ['before'])
    if (!c) fail('validation', undefined, { fields: { 'query.cursor': 'bad cursor' } })
    const i = pathRows.findIndex((m) => m.id === c!.before)
    if (i < 0) return { items: [], nextCursor: null }
    end = i
  }
  const start = Math.max(0, end - limit)
  const slice = pathRows.slice(start, end)
  return { items: slice.map((m) => rt.liveMessage(m)), nextCursor: start > 0 ? encodeCursor({ before: slice[0]!.id }) : null }
}

/** A model name from the request: null/undefined pass, anything else must be a plain model name (it reaches argv). */
function checkModel(model: string | null | undefined) {
  if (model !== null && model !== undefined && !safeModel(model)) fail('validation', undefined, { fields: { 'body.model': 'not a model name' } })
}

function pickEngine(rt: ChatRuntime, chat: ChatRow, body: { engine?: EngineId; model?: string | null }): { engine: EngineId; model: string | null } {
  checkModel(body.model)
  const engine: EngineId = body.engine ?? (chat.engine === 'codex' ? 'codex' : 'claude-code')
  const model = body.model !== undefined ? body.model : body.engine && body.engine !== chat.engine ? null : chat.model ?? rt.defaultModelFor(engine)
  return { engine, model: model ?? null }
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
      const cur = decodeCursor(query.cursor, ['u', 'id'])
      if (query.cursor && !cur) fail('validation', undefined, { fields: { 'query.cursor': 'bad cursor' } })
      if (cur) { where.push('(updated_at < ? OR (updated_at = ? AND id < ?))'); args.push(cur.u, cur.u, cur.id) }
      const rows = ctx.db.query(`SELECT ${CHAT_COLS} FROM chats WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args, limit + 1) as ChatRow[]
      const more = rows.length > limit
      const items = rows.slice(0, limit)
      const last = items[items.length - 1]
      return { items: items.map((r) => chatOut(rt, r)), nextCursor: more && last ? encodeCursor({ u: last.updated_at, id: last.id }) : null }
    })

    kit.handle(API.createChat, ({ body, auth }) => {
      checkModel(body.model)
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
      checkModel(body.model)
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
      checkBudget(ctx, auth.user.id, c.get('locale'))
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
      checkBudget(ctx, auth.user.id, c.get('locale'))
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
      checkBudget(ctx, auth.user.id, c.get('locale'))
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
      return { items: rows.filter((r) => canRead(ctx.files, p, r.folder_path)).map((r) => rt.store.toProject(r, mayEdit(ctx, p, r))) }
    })

    kit.handle(API.createProject, ({ c, body, auth }) => {
      const locale = c.get('locale')
      const p = principal(ctx, auth)
      const db = ctx.db
      const id = newId()
      const root = ctx.files.fx.root
      const insert = (folder: string) => db.query('INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, body.name, folder, body.instructions, auth.user.id, new Date().toISOString())
      const slug = body.slug?.normalize('NFC')
      if (slug !== undefined && (slug.includes('/') || badSegment(slug))) fail('validation', undefined, { fields: { 'body.slug': 'not a valid folder name' } })
      const folderRows = () => (db.query('SELECT path FROM folders').all() as { path: string }[]).map((r) => r.path)
      /** a folder made here goes again when the database step fails: nothing half-made stays behind */
      const undo = (top: string | null) => { if (top) try { fs.rmSync(top, { recursive: true, force: true }) } catch {} }

      // ③ personal: users/<me>/projects/<slug>/, the caller's alone (no folders row under users/: rules are not read
      // there, and admins would see the folder's name in the folder list)
      if (body.scope === 'personal') {
        if (body.participants.length) fail('validation', tr('projectParticipantsNewOnly', locale), { fields: { 'body.participants': 'a personal project has no participants' } })
        let want = body.folderPath
        if (want === undefined) {
          const parent = ensureProjectFolderEx(ctx.files, p, `users/${p.id}/projects`, locale)
          want = `${parent.path}/${projectFolderName(path.join(root, ...parent.path.split('/')), parent.path, [], slug ?? body.name, id)}`
        }
        const f = ensureProjectFolderEx(ctx.files, p, want, locale)
        const segs = f.path.split('/')
        if (segs[0] !== 'users' || segs[1] !== p.id || segs.length < 3) { undo(f.createdTop); fail('validation', tr('projectPersonalFolder', locale), { fields: { 'body.folderPath': 'a personal project lives in users/<me>/' } }) }
        try { db.transaction(() => { insert(f.path); audit(db, { actor: auth.user.id, action: 'project.create', target: id, detail: null }) })() } catch (e) { undo(f.createdTop); throw e }
        return rt.store.toProject(rt.store.projectRow(id)!, true)
      }

      // ① a new team project folder projects/<slug>/: admins only, with its rules (participants + creator write)
      let want = body.folderPath
      let fresh = false
      if (want === undefined) {
        if (!isAdmin(p)) fail('forbidden', tr('projectNewTeamAdminOnly', locale))
        fs.mkdirSync(path.join(root, 'projects'), { recursive: true, mode: 0o700 })
        want = `projects/${projectFolderName(path.join(root, 'projects'), 'projects', folderRows(), slug ?? body.name, id)}`
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
        return rt.store.toProject(rt.store.projectRow(id)!, true)
      }

      // ② an existing folder (or a new one inside a folder) the caller can write: rules unchanged; a rule-less
      // folders row marks it as a project folder (moves / renames are then admin-only, tab 4), not under users/
      const f = ensureProjectFolderEx(ctx.files, p, want, locale)
      try {
        db.transaction(() => {
          if (f.path !== '' && !isPersonalPath(f.path)) ensureFolderRow(db, f.path)
          insert(f.path)
          audit(db, { actor: auth.user.id, action: 'project.create', target: id, detail: isPersonalPath(f.path) ? null : { name: body.name, folderPath: f.path } })
        })()
      } catch (e) { undo(f.createdTop); throw e }
      return rt.store.toProject(rt.store.projectRow(id)!, mayEdit(ctx, p, rt.store.projectRow(id)!))
    })

    kit.handle(API.getProject, ({ params, auth }) => {
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canRead(ctx.files, p, r.folder_path)) fail('not_found')
      return rt.store.toProject(r!, mayEdit(ctx, p, r!))
    })

    kit.handle(API.updateProject, ({ c, params, body, auth }) => {
      const locale = c.get('locale')
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canRead(ctx.files, p, r.folder_path)) fail('not_found')
      if (!canWrite(ctx.files, p, r!.folder_path)) fail('forbidden', tr('projectFolderNoWrite', locale))
      if (!mayEdit(ctx, p, r!)) fail('forbidden', tr('projectCreatorOnly', locale))
      let folder = r!.folder_path
      if (body.folderPath !== undefined && body.folderPath !== r!.folder_path) {
        // repointing a team project changes who gets its instructions: admins only, and never into a personal folder
        // (it would vanish for everyone else, the creator included). Sharing a personal project is a copy (share).
        if (!isAdmin(p)) fail('forbidden', tr('projectFolderAdminOnly', locale))
        if (isPersonalPath(body.folderPath)) fail('validation', tr('projectFolderPersonal', locale), { fields: { 'body.folderPath': 'invalid_path: a team project cannot move under users/' } })
        folder = ensureProjectFolder(ctx.files, p, body.folderPath, locale)
        if (isPersonalPath(folder)) fail('validation', tr('projectFolderPersonal', locale), { fields: { 'body.folderPath': 'invalid_path: a team project cannot move under users/' } })
      }
      const next = { name: body.name ?? r!.name, instructions: body.instructions ?? r!.instructions }
      ctx.db.transaction(() => {
        ctx.db.query('UPDATE projects SET name = ?, folder_path = ?, instructions = ? WHERE id = ?').run(next.name, folder, next.instructions, r!.id)
        // the old folder stops being a project folder: its rule-less marker row goes (else it stays admin-only for good)
        if (folder !== r!.folder_path) dropProjectMarker(ctx.db, r!.folder_path)
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
      })()
      const after = rt.store.projectRow(r!.id)!
      if (after.instructions !== r!.instructions) notifyInstructionsChanged(ctx, after, auth.user)
      return rt.store.toProject(after, mayEdit(ctx, p, after))
    })

    kit.handle(API.shareProject, async ({ c, params, body, auth }) => {
      const locale = c.get('locale')
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canRead(ctx.files, p, r.folder_path)) fail('not_found')
      if (!mayEdit(ctx, p, r!)) fail('forbidden', tr('projectCreatorOnly', locale))
      const segs = r!.folder_path.split('/')
      // only a personal project is shared this way; a team project's audience is its folder rules (admin screen)
      if (segs[0] !== 'users' || segs[1] !== p.id || segs.length < 3) fail('validation', tr('projectShareNotPersonal', locale), { fields: { 'params.id': 'not a personal project' } })
      const out = await mapErrors(locale, () => componentC(ctx).files.copyFolderTree(p.id, r!.folder_path, body.toParent, { dryRun: body.dryRun }), 'toParent')
      if ('viewersAdded' in out) return out
      ctx.db.transaction(() => {
        // the copy is a project folder in a team folder: a rule-less folders row, like a project on an existing folder
        if (!isPersonalPath(out.path)) ensureFolderRow(ctx.db, out.path)
        ctx.db.query('UPDATE projects SET folder_path = ? WHERE id = ?').run(out.path, r!.id)
        dropProjectMarker(ctx.db, r!.folder_path)
        audit(ctx.db, { actor: auth.user.id, action: 'project.share', target: r!.id, detail: isPersonalPath(out.path) ? null : { name: r!.name, folderPath: out.path, files: out.files, bytes: out.bytes } })
      })()
      const after = rt.store.projectRow(r!.id)!
      return rt.store.toProject(after, mayEdit(ctx, p, after))
    })

    kit.handle(API.deleteProject, ({ c, params, auth }) => {
      const p = principal(ctx, auth)
      const r = rt.store.projectRow(params.id)
      if (!r || !canRead(ctx.files, p, r.folder_path)) fail('not_found')
      if (!canWrite(ctx.files, p, r!.folder_path)) fail('forbidden', tr('projectFolderNoWrite', c.get('locale')))
      // other people's chats lose the project context: the creator and admins only, like editing it
      if (!mayEdit(ctx, p, r!)) fail('forbidden', tr('projectCreatorOnly', c.get('locale')))
      ctx.db.transaction(() => {
        ctx.db.query('UPDATE chats SET project_id = NULL WHERE project_id = ?').run(r!.id)
        ctx.db.query('DELETE FROM projects WHERE id = ?').run(r!.id)
        // a rule-less folders row that only marked this project's folder goes with it (security review r2: it kept the
        // folder, and every folder above it, admin-only to move, rename or trash for good)
        dropProjectMarker(ctx.db, r!.folder_path)
        audit(ctx.db, { actor: auth.user.id, action: 'project.delete', target: r!.id, detail: isPersonalPath(r!.folder_path) ? null : { name: r!.name, folderPath: r!.folder_path } })
      })()
    })
  },
}
