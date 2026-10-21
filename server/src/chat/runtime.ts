// Chat runtime of one server: the turn queue (team-wide limit, one turn per chat), turn creation for send /
// edit / regenerate, stop, restart recovery, chat-trash purge, and the shared pieces turns need (hub, browser
// relay, engines, settings). Installed by the chats route module's init(); other B modules reach it with
// getChatRuntime(ctx).
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE, type Attachment, type ChatRunState, type EngineId, type FileChange, type Locale, type TurnStarted } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { Running } from '../server'
import { atLeast, type Principal } from '../policy/access'
import { canRead } from './projects'
import { newId } from '../db'
import { Hub, type HubOptions } from '../realtime/hub'
import { BrowserRelay, type BrowserRelayOptions } from '../realtime/browser-relay'
import { ChatStore, type ChatRow, type MessageRow } from './store'
import { LocalEngines, safeModel, type EngineProvider } from './engines'
import { TURN_TIMEOUT_MS, TurnExec, composeMessage, type TurnSpec } from './turn'
import { engineError } from './i18n'

export const DEFAULT_CONCURRENCY = 3
export const DEFAULT_ASK_USER_TIMEOUT_MS = 10 * 60_000
export const MAX_ASK_USER_TIMEOUT_MS = 15 * 60_000
export const DEFAULT_CHAT_TRASH_DAYS = 7
export const DEFAULT_MAX_ENGINE_TURNS = 50

export interface ChatRuntimeOptions {
  engines?: EngineProvider
  hub?: HubOptions
  relay?: BrowserRelayOptions
  turnTimeoutMs?: number
  askUserTimeoutMs?: number
  timeZone?: string
  maxEngineTurns?: number
  purgeIntervalMs?: number
}

const pendingOptions = new WeakMap<AppContext, ChatRuntimeOptions>()
const runtimes = new WeakMap<AppContext, ChatRuntime>()

/** Tests: options for the runtime that buildApp() will create for this context. */
export function configureChat(ctx: AppContext, o: ChatRuntimeOptions) { pendingOptions.set(ctx, o) }

export function installChatRuntime(ctx: AppContext): ChatRuntime {
  let rt = runtimes.get(ctx)
  if (!rt) { rt = new ChatRuntime(ctx, pendingOptions.get(ctx) ?? {}); runtimes.set(ctx, rt) }
  return rt
}

export function getChatRuntime(ctx: AppContext): ChatRuntime {
  const rt = runtimes.get(ctx)
  if (!rt) throw new Error('chat runtime not installed (routes/chats.ts init)')
  return rt
}

/**
 * Forget the engine sessions of a person's chats (their read access shrank or the account was disabled: tab 2
 * "권한 회수", review H7). The next turn of each chat starts a fresh session from the chat's DB history.
 * For component A (folder rule changes, account changes). Returns the number of chats reset.
 */
export function resetEngineSessions(ctx: AppContext, userId: string): number {
  // turns of this person running right now keep their session until they end; they must not store it then
  runtimes.get(ctx)?.revokeRunningSessions(userId)
  const rows = ctx.db.query('SELECT id FROM chats WHERE user_id = ? AND engine_session_id IS NOT NULL').all(userId) as { id: string }[]
  for (const r of rows) {
    ctx.db.query('UPDATE chats SET engine_session_id = NULL, engine_session_leaf_id = NULL WHERE id = ?').run(r.id)
    fs.rmSync(path.join(ctx.config.dataDir, 'sessions', r.id), { recursive: true, force: true })
  }
  return rows.length
}

/** A disabled or deleted account: its running and queued turns stop now (they would otherwise go on with the
 * engine for up to 20 minutes on the owner's subscription; their tool calls are already refused). */
export function stopTurnsOf(ctx: AppContext, userId: string): number {
  return runtimes.get(ctx)?.stopUserTurns(userId) ?? 0
}

/** settings table: key -> JSON value (tab 1). Unknown / bad values fall back to the default. */
export function readSetting<T>(db: AppContext['db'], key: string, ok: (v: unknown) => v is T, fallback: T): T {
  try {
    const r = db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null
    if (!r) return fallback
    const v = JSON.parse(r.value)
    return ok(v) ? v : fallback
  } catch { return fallback }
}
const isInt = (min: number, max: number) => (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

export class ChatRuntime {
  readonly store: ChatStore
  readonly hub: Hub
  readonly relay: BrowserRelay
  readonly engines: EngineProvider
  readonly turnTimeoutMs: number
  readonly maxEngineTurns: number
  readonly timeZone: string
  private queued: TurnSpec[] = []
  private running = new Map<string, TurnExec>()
  private positions = new Map<string, number>()
  private closing = false
  private closeHooked = false
  private purger: ReturnType<typeof setInterval>

  constructor(readonly ctx: AppContext, private o: ChatRuntimeOptions) {
    this.store = new ChatStore(ctx.db)
    this.store.viewAttachments = (userId, atts) => {
      const view = ctx.services.attachments?.view
      if (!view) throw new Error('no attachment view') // the store blanks team references
      return view(userId, atts)
    }
    this.hub = new Hub(ctx, o.hub)
    this.relay = new BrowserRelay(this.hub, ctx.log.child({ c: 'browser' }), o.relay)
    this.engines = o.engines ?? new LocalEngines(ctx)
    this.turnTimeoutMs = o.turnTimeoutMs ?? TURN_TIMEOUT_MS
    this.maxEngineTurns = o.maxEngineTurns ?? DEFAULT_MAX_ENGINE_TURNS
    this.timeZone = o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
    this.purger = setInterval(() => { try { this.purgeTrash() } catch (e) { this.log.error('chat purge failed', { err: e }) } }, o.purgeIntervalMs ?? 60 * 60_000)
    ;(this.purger as { unref?: () => void }).unref?.()
    ctx.onClose(() => this.shutdown())
  }

  get db() { return this.ctx.db }
  get files() { return this.ctx.files }
  get log() { return this.ctx.log }

  /** The engine core; once it runs, our shutdown hook is registered after its own so turns stop first. */
  async core(): Promise<Running> {
    const c = await this.ctx.core()
    if (!this.closeHooked) { this.closeHooked = true; this.ctx.onClose(() => this.shutdown()) }
    return c
  }

  // ---------------- settings ----------------
  concurrency(): number { return readSetting(this.db, 'concurrency', isInt(1, 16), DEFAULT_CONCURRENCY) }
  askUserTimeoutMs(): number {
    if (this.o.askUserTimeoutMs !== undefined) return this.o.askUserTimeoutMs
    return Math.min(MAX_ASK_USER_TIMEOUT_MS, readSetting(this.db, 'ask_user_timeout_sec', isInt(30, 900), DEFAULT_ASK_USER_TIMEOUT_MS / 1000) * 1000)
  }
  chatTrashDays(): number { return readSetting(this.db, 'chatTrashRetentionDays', isInt(1, 365), DEFAULT_CHAT_TRASH_DAYS) }
  defaultEngine(): EngineId { return readSetting(this.db, 'defaultEngine', (v): v is EngineId => v === 'claude-code' || v === 'codex', 'claude-code') }
  defaultModel(): string | null { return readSetting<string | null>(this.db, 'defaultModel', safeModel, null) }
  /** the team default model applies to the team default engine only */
  defaultModelFor(engine: EngineId): string | null { return engine === this.defaultEngine() ? this.defaultModel() : null }
  fallbackModel(model: string | undefined): string {
    const set = readSetting<string | null>(this.db, 'engine.fallbackModel', safeModel, null)
    if (set && set !== model) return set
    return model?.includes('sonnet') ? 'opus' : 'sonnet'
  }

  // ---------------- queue ----------------
  runState(chatId: string): ChatRunState {
    for (const e of this.running.values()) if (e.spec.chatId === chatId) return 'running'
    return this.queued.some((s) => s.chatId === chatId) ? 'queued' : 'idle'
  }
  activeTurn(chatId: string): string | null {
    for (const e of this.running.values()) if (e.spec.chatId === chatId) return e.id
    return this.queued.find((s) => s.chatId === chatId)?.turnId ?? null
  }
  execFor(turnId: string): TurnExec | undefined { return this.running.get(turnId) }
  execForMessage(messageId: string): TurnExec | undefined {
    for (const e of this.running.values()) if (e.spec.assistantId === messageId) return e
    return undefined
  }
  queuePosition(turnId: string): number {
    if (this.running.has(turnId)) return 0
    const i = this.queued.findIndex((s) => s.turnId === turnId)
    return i < 0 ? 0 : i + 1
  }
  runningCount() { return this.running.size }
  /** The person's engine sessions were reset (access shrank) while these turns ran: they end without stashing. */
  revokeRunningSessions(userId: string): number {
    let n = 0
    for (const e of this.running.values()) if (e.spec.userId === userId) { e.sessionRevoked = true; n++ }
    return n
  }
  queuedCount() { return this.queued.length }
  /** Stop every running and queued turn of one person (account disabled / deleted). */
  stopUserTurns(userId: string): number {
    const chats = new Set([...this.running.values()].map((e) => e.spec).concat(this.queued).filter((s) => s.userId === userId).map((s) => s.chatId))
    let n = 0
    for (const chatId of chats) if (this.stopChat(chatId)) n++
    return n
  }

  private enqueue(spec: TurnSpec) {
    this.queued.push(spec)
    this.schedule()
  }

  schedule() {
    if (this.closing) return
    const limit = this.concurrency()
    while (this.running.size < limit && this.queued.length) {
      const busy = new Set([...this.running.values()].map((e) => e.spec.chatId))
      const i = this.queued.findIndex((s) => !busy.has(s.chatId))
      if (i < 0) break
      const spec = this.queued.splice(i, 1)[0]!
      const exec = new TurnExec(this, spec)
      this.running.set(spec.turnId, exec)
      this.publishChat(spec.userId, spec.chatId, 'updated')
      void exec.run()
    }
    this.publishPositions()
  }

  private publishPositions() {
    const now = new Map<string, number>()
    for (const e of this.running.values()) now.set(e.id, 0)
    this.queued.forEach((s, i) => now.set(s.turnId, i + 1))
    const all = new Map([...this.running.values()].map((e) => [e.id, e.spec] as const))
    for (const s of this.queued) all.set(s.turnId, s)
    for (const [id, pos] of now) {
      if (this.positions.get(id) === pos) continue
      const s = all.get(id)!
      this.hub.publish(s.userId, { type: 'queue.position', data: { chatId: s.chatId, messageId: s.assistantId, turnId: id, position: pos } })
    }
    this.positions = now
  }

  /** called by TurnExec.finish */
  turnFinished(exec: TurnExec) {
    this.running.delete(exec.id)
    this.positions.delete(exec.id)
    this.schedule()
  }

  /** Stop the running or queued turn of a chat. */
  stopChat(chatId: string): string | null {
    for (const e of this.running.values()) if (e.spec.chatId === chatId) { e.stop('stopped'); return e.id }
    const i = this.queued.findIndex((s) => s.chatId === chatId)
    if (i < 0) return null
    const spec = this.queued.splice(i, 1)[0]!
    this.positions.delete(spec.turnId)
    const now = new Date().toISOString()
    this.db.query("UPDATE turns SET status = 'stopped', ended_at = ? WHERE id = ?").run(now, spec.turnId)
    this.db.query("UPDATE messages SET status = 'stopped', updated_at = ? WHERE id = ?").run(now, spec.assistantId)
    const row = this.store.messageRow(spec.assistantId)
    if (row) this.hub.publish(spec.userId, { type: 'message.done', data: { chatId, messageId: spec.assistantId, status: 'stopped', message: this.store.toMessage(row) } })
    this.publishChat(spec.userId, chatId, 'updated')
    this.publishPositions()
    return spec.turnId
  }

  // ---------------- turns ----------------
  /**
   * Save the (optional) user message and the empty answer, record the turn as queued and enqueue it.
   * `user` = new user message (send / edit); `answerTo` = existing user message (regenerate).
   */
  createTurn(o: {
    chat: ChatRow; userId: string; locale: Locale; windowId: string | null; clientKind: string | null
    engine: EngineId; model: string | null
    user?: { parentId: string | null; content: string; attachments: Attachment[]; clientMessageId: string }
    answerTo?: MessageRow
  }): TurnStarted {
    const turnId = newId()
    const now = new Date().toISOString()
    let userMessageId = o.answerTo?.id ?? ''
    let assistantId = ''
    this.db.transaction(() => {
      if (o.user) {
        userMessageId = this.store.insertMessage({ chatId: o.chat.id, parentId: o.user.parentId, role: 'user', authorId: o.userId, content: o.user.content,
          attachments: o.user.attachments, status: 'done', clientMessageId: o.user.clientMessageId })
      }
      assistantId = this.store.insertMessage({ chatId: o.chat.id, parentId: userMessageId, role: 'assistant', authorId: null, content: '', status: 'streaming',
        turnId, engine: o.engine, model: o.model })
      this.db.query(`INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, queued_at, message_id, user_message_id, window_id, client_kind)
        VALUES (?,?,?,?,?, 'queued', ?, ?, ?, ?, ?, ?)`).run(turnId, o.chat.id, o.userId, o.engine, o.model, now, now, assistantId, userMessageId, o.windowId, o.clientKind)
      const title = o.chat.title || (o.user ? titleFrom(o.user.content, o.user.attachments) : '')
      this.db.query('UPDATE chats SET active_leaf_id = ?, title = ?, engine = ?, model = ?, updated_at = ? WHERE id = ?')
        .run(assistantId, title, o.engine, o.model, now, o.chat.id)
    })()
    const spec: TurnSpec = { turnId, chatId: o.chat.id, userId: o.userId, assistantId, userMessageId, windowId: o.windowId, clientKind: o.clientKind, engine: o.engine, model: o.model, locale: o.locale }
    const userMessage = o.user ? this.store.toMessage(this.store.messageRow(userMessageId)!) : null
    const assistantMessage = this.store.toMessage(this.store.messageRow(assistantId)!)
    if (userMessage) this.hub.publish(o.userId, { type: 'message.created', data: { chatId: o.chat.id, message: userMessage } })
    this.hub.publish(o.userId, { type: 'message.created', data: { chatId: o.chat.id, message: assistantMessage } })
    this.enqueue(spec)
    this.publishChat(o.userId, o.chat.id, 'updated')
    return { userMessage, assistantMessage: this.store.toMessage(this.store.messageRow(assistantId)!), turnId, queuePosition: this.queuePosition(turnId) }
  }

  /** The turn that answers a client message id (idempotent resend). */
  existingTurn(chatId: string, clientMessageId: string): TurnStarted | null {
    const u = this.db.query('SELECT id FROM messages WHERE chat_id = ? AND client_message_id = ?').get(chatId, clientMessageId) as { id: string } | null
    if (!u) return null
    const t = this.db.query('SELECT id, message_id FROM turns WHERE user_message_id = ? ORDER BY id LIMIT 1').get(u.id) as { id: string; message_id: string } | null
    const user = this.store.messageRow(u.id)
    const answer = t ? this.store.messageRow(t.message_id) : null
    if (!t || !user || !answer) return null
    return { userMessage: this.store.toMessage(user), assistantMessage: this.liveMessage(answer), turnId: t.id, queuePosition: this.queuePosition(t.id) }
  }

  /** A message as the API returns it: a streaming answer carries the live text, not the last 0.3 s save. */
  liveMessage(r: MessageRow) {
    const e = r.status === 'streaming' ? this.execForMessage(r.id) : undefined
    return this.store.toMessage(r, e ? { content: e.content, steps: e.steps.map((s) => ({ ...s })) } : undefined)
  }

  // ---------------- what turns need ----------------
  sessionStash(chatId: string, sid: string) { return path.join(this.ctx.config.dataDir, 'sessions', chatId, `${sid}.jsonl`) }

  groupNames(p: { groups: string[] }): string[] {
    if (!p.groups.length) return []
    return (this.db.query(`SELECT name FROM groups WHERE id IN (${p.groups.map(() => '?').join(',')}) ORDER BY name`).all(...p.groups) as { name: string }[]).map((r) => r.name)
  }
  memoriesForPrompt(userId: string): { id: string; text: string }[] {
    return this.db.query('SELECT id, text FROM memories WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(userId) as { id: string; text: string }[]
  }
  /** The chat's project as the turn sees it: only while the person can still read the project folder (tab 2
   * "권한 회수": a project stays attached to the chat, but its name, folder and instructions stop reaching the AI). */
  projectForChat(projectId: string | null, user: Principal) {
    if (!projectId) return null
    const p = this.store.projectRow(projectId)
    if (!p || !canRead(this.files, user, p.folder_path)) return null
    return { name: p.name, folderPath: p.folder_path, instructions: p.instructions, createdBy: p.created_by }
  }
  /** project instructions someone else wrote count as outside content (remember protection) */
  projectTaints(project: { instructions: string; createdBy: string | null } | null, userId: string): boolean {
    return !!project && project.createdBy !== userId && project.instructions.trim() !== ''
  }
  /** Messages of a branch up to `leafId` (inclusive), for a fresh engine session. */
  history(leafId: string | null): { role: 'user' | 'assistant'; content: string }[] {
    return this.store.pathTo(leafId).filter((m) => m.content.trim() || m.role === 'user').map((m) => ({ role: m.role, content: m.role === 'user' ? composeMessage(m, this.store.attachmentsOf(m)) : m.content }))
  }

  siteGranted(userId: string, host: string): boolean {
    return !!this.db.query('SELECT 1 FROM browser_site_grants WHERE user_id = ? AND host = ?').get(userId, host)
  }
  grantSite(userId: string, host: string) {
    this.db.query('INSERT OR IGNORE INTO browser_site_grants (user_id, host) VALUES (?, ?)').run(userId, host)
  }

  /** files.changed to everyone who can read the changed paths (each person sees only their visible paths).
   * Component C owns files.changed (team-files/changes.ts): once it listens to the FileService 'changed' events it
   * already published every tool write (and make_file / uploads), so this fallback only runs without C. */
  publishFileChanges(changes: FileChange[]) {
    if (this.files.events.listenerCount('changed') > 0) return
    const rules = this.files.rules()
    this.hub.publishEach((uid) => {
      let p
      try { p = this.files.principal(uid) } catch { return null }
      const mine = changes.filter((c) => atLeast(rules.access(p, c.path.split('/')), 'read'))
      return mine.length ? { type: 'files.changed', data: { changes: mine } } : null
    })
  }

  publishChat(userId: string, chatId: string, change: 'created' | 'updated' | 'deleted' | 'restored' | 'purged') {
    const r = change === 'purged' ? null : this.store.chatRow(chatId)
    this.hub.publish(userId, { type: 'chat.updated', data: { chatId, change, chat: r ? this.store.toChat(r, this.runState(chatId)) : null } })
  }

  // ---------------- start / stop ----------------
  /** Server start: turns that were running are interrupted (never re-run: tools may have written files);
   * queued turns start again in order (tab 3 "서버 재시작"). */
  recover() {
    const now = new Date().toISOString()
    const running = this.db.query("SELECT id, message_id, user_id FROM turns WHERE status = 'running'").all() as { id: string; message_id: string | null; user_id: string }[]
    for (const t of running) {
      const locale = this.userLocale(t.user_id)
      this.db.query("UPDATE turns SET status = 'interrupted', ended_at = ?, error = 'interrupted' WHERE id = ?").run(now, t.id)
      if (t.message_id) this.db.query("UPDATE messages SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status = 'streaming'").run(JSON.stringify(engineError('interrupted', locale)), now, t.message_id)
      this.db.query('UPDATE proxy_tokens SET revoked_at = ? WHERE turn_id = ? AND revoked_at IS NULL').run(now, t.id)
    }
    const queued = this.db.query(`SELECT t.id, t.chat_id, t.user_id, t.message_id, t.user_message_id, t.window_id, t.client_kind, t.engine, t.model
      FROM turns t JOIN chats c ON c.id = t.chat_id WHERE t.status = 'queued' AND c.deleted_at IS NULL ORDER BY COALESCE(t.queued_at, t.started_at), t.id`).all() as {
      id: string; chat_id: string; user_id: string; message_id: string | null; user_message_id: string | null; window_id: string | null; client_kind: string | null; engine: string; model: string | null }[]
    // queued turns of chats in the trash never run (stop would have caught them; a crash between writes may not)
    this.db.query(`UPDATE messages SET status = 'stopped', updated_at = ? WHERE status = 'streaming' AND id IN (SELECT t.message_id FROM turns t JOIN chats c ON c.id = t.chat_id
      WHERE t.status = 'queued' AND c.deleted_at IS NOT NULL)`).run(now)
    this.db.query(`UPDATE turns SET status = 'stopped', ended_at = ? WHERE status = 'queued'
      AND (chat_id IN (SELECT id FROM chats WHERE deleted_at IS NOT NULL) OR chat_id NOT IN (SELECT id FROM chats))`).run(now)
    const seen = new Set<string>()
    for (const t of queued) {
      if (!t.message_id || !t.user_message_id || seen.has(t.chat_id)) {
        this.db.query("UPDATE turns SET status = 'stopped', ended_at = ? WHERE id = ?").run(now, t.id)
        if (t.message_id) this.db.query("UPDATE messages SET status = 'stopped' WHERE id = ? AND status = 'streaming'").run(t.message_id)
        continue
      }
      seen.add(t.chat_id)
      this.queued.push({ turnId: t.id, chatId: t.chat_id, userId: t.user_id, assistantId: t.message_id, userMessageId: t.user_message_id, windowId: t.window_id,
        clientKind: t.client_kind, engine: t.engine === 'codex' ? 'codex' : 'claude-code', model: t.model, locale: this.userLocale(t.user_id) })
    }
    // answers left streaming without a turn (crash between writes)
    const queuedIds = new Set(this.queued.map((s) => s.assistantId))
    const stale = this.db.query("SELECT id, chat_id FROM messages WHERE status = 'streaming'").all() as { id: string; chat_id: string }[]
    for (const m of stale) if (!queuedIds.has(m.id)) {
      const owner = (this.db.query('SELECT user_id FROM chats WHERE id = ?').get(m.chat_id) as { user_id: string } | null)?.user_id
      this.db.query("UPDATE messages SET status = 'error', error = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(engineError('interrupted', owner ? this.userLocale(owner) : DEFAULT_LOCALE)), now, m.id)
    }
    if (running.length || this.queued.length) this.log.info('turn queue recovered', { interrupted: running.length, requeued: this.queued.length })
    this.schedule()
  }

  userLocale(userId: string): Locale {
    const r = this.db.query('SELECT locale, prefs FROM users WHERE id = ?').get(userId) as { locale: string; prefs: string | null } | null
    let answer: unknown
    try { answer = JSON.parse(r?.prefs ?? '{}')?.answerLocale } catch {}
    const l = (answer ?? r?.locale) as string | undefined
    return l === 'en' || l === 'id' || l === 'ko' ? l : DEFAULT_LOCALE
  }

  /** Delete chats that stayed in the trash past the retention (messages, artifacts, engine session, work folder). */
  purgeTrash(now = Date.now()) {
    const cutoff = new Date(now - this.chatTrashDays() * 86400_000).toISOString()
    const rows = this.db.query('SELECT id, user_id FROM chats WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff) as { id: string; user_id: string }[]
    for (const c of rows) {
      if (this.activeTurn(c.id)) continue
      this.purgeChat(c.id)
      this.publishChat(c.user_id, c.id, 'purged')
    }
    return rows.length
  }
  purgeChat(chatId: string) {
    this.db.transaction(() => {
      this.db.query('DELETE FROM messages WHERE chat_id = ?').run(chatId)
      this.db.query('DELETE FROM artifacts WHERE chat_id = ?').run(chatId)
      this.db.query('UPDATE memories SET source_chat_id = NULL WHERE source_chat_id = ?').run(chatId)
      this.db.query('DELETE FROM chats WHERE id = ?').run(chatId)
    })()
    fs.rmSync(path.join(this.ctx.config.dataDir, 'sessions', chatId), { recursive: true, force: true })
    fs.rmSync(path.join(this.ctx.engineConfig.agentRoot, chatId), { recursive: true, force: true })
  }

  /** Stop taking new turns and wait for the running ones (planned restart / update). */
  async drain(maxMs: number): Promise<boolean> {
    this.closing = true
    const all = Promise.all([...this.running.values()].map((e) => e.done))
    const r = await Promise.race([all.then(() => true), Bun.sleep(maxMs).then(() => false)])
    return r
  }
  resume() { this.closing = false; this.schedule() }

  private shutdownP: Promise<void> | null = null
  shutdown(): Promise<void> {
    if (this.shutdownP) return this.shutdownP
    this.closing = true
    clearInterval(this.purger)
    this.shutdownP = (async () => {
      const execs = [...this.running.values()]
      for (const e of execs) e.stop('shutdown')
      await Promise.race([Promise.all(execs.map((e) => e.done)), Bun.sleep(6000)])
      this.relay.close()
      this.hub.close()
    })()
    return this.shutdownP
  }
}

function titleFrom(content: string, atts: Attachment[]): string {
  // a team file's name is not used: the title outlives the person's access to the file
  const line = content.split('\n').map((l) => l.trim()).find(Boolean) ?? atts.find((a) => a.source !== 'team')?.name ?? ''
  return line.length > 60 ? line.slice(0, 59) + '…' : line
}
