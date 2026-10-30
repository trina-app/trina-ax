// Chat runtime of one server: the turn queue (team-wide limit, one turn per chat), turn creation for send /
// edit / regenerate, stop, restart recovery, chat-trash purge, and the shared pieces turns need (hub, browser
// relay, engines, settings). Installed by the chats route module's init(); other B modules reach it with
// getChatRuntime(ctx).
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE, type Attachment, type ChatRunState, type ChatQueueSnapshot, type EngineId, type FileChange, type Locale, type TurnStarted } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { Running } from '../server'
import { atLeast, type Principal } from '../policy/access'
import { canRead } from './projects'
import { newId } from '../db'
import { Schedules } from './schedules'
import { Hub, type HubOptions } from '../realtime/hub'
import { BrowserRelay, type BrowserRelayOptions } from '../realtime/browser-relay'
import { ChatStore, type ChatRow, type MessageRow } from './store'
import { LocalEngines, safeModel, type EngineProvider } from './engines'
import { TURN_TIMEOUT_MS, TurnExec, composeMessage, type TurnSpec } from './turn'
import { engineError } from './i18n'
import { forgetPurgedChats, retryPendingForgets } from './forget'
import { effectiveConcurrency, memoryAdmission } from '../system/limits'
import { teamTimeZone } from '../admin/settings'
import { setTeamTimeZoneSource } from '../system/time-zone'
import { HttpError } from '../http/errors'
import { fairOrder, selectFairHead, type QueueTiming } from './fair-queue'
import { QueueStore } from './queue-store'
import { launcherStatus } from '../native'
import { maskStoredTitles, placeholderTitle } from './title'
import { redactorFor } from '../integrations/connections/redact'

export const DEFAULT_CONCURRENCY = 3
export const DEFAULT_ASK_USER_TIMEOUT_MS = 10 * 60_000
export const MAX_ASK_USER_TIMEOUT_MS = 15 * 60_000
export const DEFAULT_CHAT_TRASH_DAYS = 7
export const DEFAULT_MAX_ENGINE_TURNS = 50
/** Queue capacity is separate from execution capacity; supports all 60 people asking three times. */
export const QUEUE_TEAM_MIN = 10
export const QUEUE_PER_USER = 3
export const QUEUE_RETRY_AFTER_S = 30
/** how often answers held back for memory look again (system/limits.ts memoryAdmission) */
export const MEMORY_RECHECK_MS = 2000
const QUEUE_FULL: Record<Locale, Record<'queue_full' | 'queue_full_user', string>> = {
  ko: { queue_full: '지금 요청이 많아 잠시 뒤 다시 보내 주세요.', queue_full_user: '이미 기다리는 질문이 3개 있습니다. 앞의 답이 끝난 뒤 다시 보내 주세요.' },
  en: { queue_full: 'There are many requests right now. Please send it again in a moment.', queue_full_user: 'You already have 3 questions waiting. Send it again when an earlier answer is done.' },
  id: { queue_full: 'Sedang banyak permintaan. Kirim lagi sebentar lagi.', queue_full_user: 'Sudah ada 3 pertanyaan Anda yang menunggu. Kirim lagi setelah jawaban sebelumnya selesai.' }, ja: { queue_full: "現在リクエストが集中しています。しばらくしてから再送信してください。", queue_full_user: "すでに3件の質問が待機中です。先の回答が完了してから再送信してください。" }, es: { queue_full: "Hay muchas solicitudes en este momento. Vuelva a enviarla en un momento.", queue_full_user: "Ya tiene 3 preguntas en espera. Vuelva a enviarla cuando termine una respuesta anterior." },
}

export interface ChatRuntimeOptions {
  engines?: EngineProvider
  hub?: HubOptions
  relay?: BrowserRelayOptions
  turnTimeoutMs?: number
  wallTimeoutMs?: number
  /** Status-only polling while installed startup waits for an idle launcher. */
  recoveryPollMs?: number
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
  /** scheduled tasks (schedules.ts); its loop runs outside tests */
  readonly schedules: Schedules
  readonly hub: Hub
  readonly relay: BrowserRelay
  readonly engines: EngineProvider
  readonly turnTimeoutMs: number
  readonly wallTimeoutMs: number
  readonly queueStore: QueueStore
  readonly queueEpoch = newId()
  private queueRevision = 0
  private quarantined = new Set<string>()
  private dispatching = false
  private recovering = false
  private recoveryTask: Promise<void> | null = null
  private recoveryRetry: ReturnType<typeof setTimeout> | null = null
  private recoveryAbort = new AbortController()
  private recoveryState: 'ready' | 'checking_launcher' | 'launcher_unreachable' | 'launcher_busy' | 'launcher_unknown' = 'ready'
  private queueRejections = { queue_full: 0, queue_full_user: 0, draining: 0 }
  private lastConcurrency = 0
  /** queued answers are waiting for memory (schedule() below); the watcher re-checks every MEMORY_RECHECK_MS */
  private memoryHeld = false
  private memoryCheckedAt = 0
  private capacityWatcher: ReturnType<typeof setInterval>
  readonly maxEngineTurns: number
  private queued: (TurnSpec & QueueTiming)[] = []
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
    this.wallTimeoutMs = o.wallTimeoutMs ?? 45 * 60_000
    this.queueStore = new QueueStore(ctx.db)
    this.lastConcurrency = this.concurrency()
    // Plan updates can arrive outside the settings route. Lower C never kills existing turns.
    this.capacityWatcher = setInterval(() => {
      try {
        if (this.concurrency() !== this.lastConcurrency) this.schedule()
        else if (this.memoryHeld && Date.now() - this.memoryCheckedAt >= MEMORY_RECHECK_MS) this.schedule()
      }
      catch (err) { this.log.error('queue capacity refresh failed', { err }) }
    }, 250)
    this.capacityWatcher.unref?.()
    this.maxEngineTurns = o.maxEngineTurns ?? DEFAULT_MAX_ENGINE_TURNS
    // the engines get the team's zone as TZ (engine/claude.ts, engine/codex.ts; one team per server process)
    if (!o.timeZone) setTeamTimeZoneSource(() => teamTimeZone(ctx.db))
    this.schedules = new Schedules(this.db, this)
    if (process.env.NODE_ENV !== 'test') this.schedules.startLoop(ctx)
    this.purger = setInterval(() => { try { this.purgeTrash() } catch (e) { this.log.error('chat purge failed', { err: e }) } }, o.purgeIntervalMs ?? 60 * 60_000)
    ;(this.purger as { unref?: () => void }).unref?.()
    // titles saved before they were checked for secrets (title.ts): once
    try {
      const masked = maskStoredTitles(ctx.db)
      if (masked) this.log.info('chat titles that looked like secrets were masked', { n: masked })
    } catch (e) { this.log.warn('masking chat titles failed', { err: e }) }
    // engine folders a launcher did not take before the last stop (chat/forget.ts)
    const retry = setTimeout(() => { void retryPendingForgets(ctx) }, 30_000)
    ;(retry as { unref?: () => void }).unref?.()
    ctx.onClose(() => clearTimeout(retry))
    ctx.onClose(() => this.shutdown())
  }

  get db() { return this.ctx.db }
  /** the team's time zone (Admin > Settings, admin/settings.ts teamTimeZone); a test may fix one */
  get timeZone(): string { return this.o.timeZone ?? teamTimeZone(this.ctx.db) }
  get files() { return this.ctx.files }
  get log() { return this.ctx.log }

  /** The engine core; once it runs, our shutdown hook is registered after its own so turns stop first. */
  async core(): Promise<Running> {
    const c = await this.ctx.core()
    if (!this.closeHooked) { this.closeHooked = true; this.ctx.onClose(() => this.shutdown()) }
    return c
  }

  // ---------------- settings ----------------
  /** min(the admin's setting, the plan's maxConcurrency): system/limits.ts, the same number diagnostics show */
  concurrency(): number { return effectiveConcurrency(this.db) }
  askUserTimeoutMs(): number {
    if (this.o.askUserTimeoutMs !== undefined) return this.o.askUserTimeoutMs
    return Math.min(MAX_ASK_USER_TIMEOUT_MS, readSetting(this.db, 'ask_user_timeout_sec', isInt(30, 900), DEFAULT_ASK_USER_TIMEOUT_MS / 1000) * 1000)
  }
  chatTrashDays(): number { return readSetting(this.db, 'chatTrashRetentionDays', isInt(1, 365), DEFAULT_CHAT_TRASH_DAYS) }
  defaultEngine(): EngineId { return readSetting(this.db, 'defaultEngine', (v): v is EngineId => v === 'api' || v === 'claude-code' || v === 'codex', 'claude-code') }
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
  queuePosition(turnId: string): number | null {
    if (this.running.has(turnId)) return 0
    const i = this.orderedQueue().findIndex((s) => s.turnId === turnId)
    return i < 0 ? null : i + 1
  }
  queueSnapshot(chatId: string): ChatQueueSnapshot {
    const id = this.activeTurn(chatId)
    const spec = id ? this.running.get(id)?.spec ?? this.queued.find(s => s.turnId === id) : null
    return { state: this.runState(chatId), turnId: id, messageId: spec?.assistantId ?? null, position: id ? this.queuePosition(id) : null,
      epoch: this.queueEpoch, revision: this.queueRevision }
  }
  private activeCounts() {
    const counts = new Map<string, number>()
    for (const e of this.running.values()) counts.set(e.spec.userId, (counts.get(e.spec.userId) ?? 0) + 1)
    return counts
  }
  private queueEntries() { return this.queued.map((s, i) => ({ ...s, queueSeq: s.queueSeq ?? i + 1 })) }
  private orderedQueue() {
    return fairOrder(this.queueEntries(), this.activeCounts(), this.queueStore.tickets(), new Set([...this.running.values()].map(e => e.spec.chatId)))
  }
  get acceptingTurns() { return !this.closing && !this.recovering }
  queueDiagnostics() {
    const wait = this.db.query("SELECT MIN(COALESCE(queued_at,started_at)) AS oldest FROM turns WHERE status='queued'").get() as { oldest: string | null }
    const deferred = this.db.query('SELECT COUNT(*) n,MIN(pending_due_at) oldest FROM schedules WHERE pending_due_at IS NOT NULL').get() as { n: number; oldest: string | null }
    return { queuePolicyVersion: 1, recovery: this.recoveryState, waitingForMemory: this.memoryHeld, waitingUsers: new Set(this.queued.map(s => s.userId)).size,
      oldestWaitMs: wait.oldest ? Math.max(0, Date.now() - Date.parse(wait.oldest)) : 0,
      maxRunningPerUser: Math.max(0, ...this.activeCounts().values()), quarantined: this.quarantined.size, deferredSchedules: deferred.n,
      deferredOldestWaitMs: deferred.oldest ? Math.max(0, Date.now() - Date.parse(deferred.oldest)) : 0,
      rejected: { ...this.queueRejections } }
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
    this.db.query('UPDATE schedules SET pending_due_at=NULL, retry_at=NULL, enabled=0 WHERE user_id=?').run(userId)
    const chats = new Set([...this.running.values()].map((e) => e.spec).concat(this.queued).filter((s) => s.userId === userId).map((s) => s.chatId))
    let n = 0
    for (const chatId of chats) if (this.stopChat(chatId)) n++
    return n
  }

  private enqueue(spec: TurnSpec & QueueTiming) {
    this.queued.push(spec)
    this.queueRevision++
  }

  schedule() {
    if (!this.acceptingTurns || this.dispatching) return
    this.dispatching = true
    try {
    const limit = this.concurrency()
    if (limit !== this.lastConcurrency) { this.lastConcurrency = limit; this.queueRevision++ }
    // Invalid queued state is terminal, never a permanent head blocking another user.
    for (const s of [...this.queued]) {
      const valid = this.db.query(`SELECT 1 FROM turns t JOIN users u ON u.id=t.user_id JOIN chats c ON c.id=t.chat_id
        JOIN messages a ON a.id=t.message_id JOIN messages m ON m.id=t.user_message_id
        WHERE t.id=? AND t.status='queued' AND u.status='active' AND u.deleted_at IS NULL AND c.deleted_at IS NULL`).get(s.turnId)
      if (!valid) this.stopChat(s.chatId)
    }
    // short of memory: the rest wait in the queue and the capacity watcher looks again (system/limits.ts)
    const room = this.queued.length && this.running.size < limit ? memoryAdmission(this.running.size, limit) : limit
    this.memoryCheckedAt = Date.now()
    while (this.running.size < room && this.queued.length) {
      const busy = new Set([...this.running.values()].map((e) => e.spec.chatId))
      const head = selectFairHead(this.queueEntries(), this.activeCounts(), this.queueStore.tickets(), busy)
      if (!head) break
      const i = this.queued.findIndex(s => s.turnId === head.turnId)
      const timing = this.queueStore.claim(head.turnId, head.userId, this.wallTimeoutMs)
      const spec = this.queued.splice(i, 1)[0]!
      this.queueRevision++
      if (!timing) { this.queueStore.settle(spec.userId); continue }
      Object.assign(spec, timing)
      const exec = new TurnExec(this, spec)
      this.running.set(spec.turnId, exec)
      this.publishChat(spec.userId, spec.chatId, 'updated')
      void exec.run()
    }
    const held = this.queued.length > 0 && this.running.size < limit && this.running.size >= room
    if (held !== this.memoryHeld) {
      if (held) this.log.warn('queued answers wait for memory', { running: this.running.size, concurrency: limit, queued: this.queued.length })
      else this.log.info('memory is back; queued answers run again')
      this.memoryHeld = held
    }
    this.publishPositions()
    } catch (err) {
      // A committed claim is never automatically replayed after a failed in-memory transition.
      this.closing = true
      this.log.error('queue dispatch halted; recovery required', { err })
      throw err
    } finally { this.dispatching = false }
  }

  private publishPositions() {
    const now = new Map<string, number>()
    for (const e of this.running.values()) now.set(e.id, 0)
    this.orderedQueue().forEach((s, i) => now.set(s.turnId, i + 1))
    const all = new Map([...this.running.values()].map((e) => [e.id, e.spec] as const))
    for (const s of this.queued) all.set(s.turnId, s)
    for (const [id, pos] of now) {
      if (this.positions.get(id) === pos) continue
      const s = all.get(id)!
      this.hub.publish(s.userId, { type: 'queue.position', data: { chatId: s.chatId, messageId: s.assistantId, turnId: id, position: pos, epoch: this.queueEpoch, revision: this.queueRevision } })
    }
    this.positions = now
  }

  /** called by TurnExec.finish */
  turnFinished(exec: TurnExec) {
    if (this.running.get(exec.id) !== exec) return
    this.running.delete(exec.id)
    this.quarantined.delete(exec.id)
    this.queueRevision++
    this.positions.delete(exec.id)
    this.schedule()
  }
  /** An engine whose termination is unproven still owns its slot until turnFinished confirms it. */
  turnQuarantined(exec: TurnExec) {
    if (this.running.get(exec.id) !== exec || this.quarantined.has(exec.id)) return
    this.quarantined.add(exec.id)
    this.log.error('turn slot quarantined: termination unconfirmed', { turn: exec.id })
  }

  /** Stop the running or queued turn of a chat. */
  stopChat(chatId: string): string | null {
    for (const e of this.running.values()) if (e.spec.chatId === chatId) { e.stop('stopped'); return e.id }
    const i = this.queued.findIndex((s) => s.chatId === chatId)
    if (i < 0) return null
    const spec = this.queued[i]!
    const now = new Date().toISOString()
    this.db.transaction(() => {
      this.db.query("UPDATE turns SET status = 'stopped', ended_at = ? WHERE id = ? AND status='queued'").run(now, spec.turnId)
      this.db.query("UPDATE messages SET status = 'stopped', updated_at = ? WHERE id = ? AND status='streaming'").run(now, spec.assistantId)
      this.queueStore.settle(spec.userId)
    })()
    this.queued.splice(i, 1)
    this.positions.delete(spec.turnId)
    this.queueRevision++
    const row = this.store.messageRow(spec.assistantId)
    if (row) this.hub.publish(spec.userId, { type: 'message.done', data: { chatId, messageId: spec.assistantId, status: 'stopped', message: this.store.toMessage(row) } })
    this.publishChat(spec.userId, chatId, 'updated')
    this.schedule()
    this.publishPositions()
    return spec.turnId
  }

  // ---------------- turns ----------------
  /**
   * Save the (optional) user message and the empty answer, record the turn as queued and enqueue it.
   * `user` = new user message (send / edit); `answerTo` = existing user message (regenerate).
   */
  createTurn(o: {
    /** Scheduled runs create their chat inside the admission transaction, after the capacity check. */
    chat: ChatRow | (() => ChatRow); userId: string; locale: Locale; windowId: string | null; clientKind: string | null
    engine: EngineId; model: string | null
    substitutedFrom?: EngineId
    user?: { parentId: string | null; content: string; attachments: Attachment[]; clientMessageId: string }
    answerTo?: MessageRow
    scheduled?: { id: string; dueAt: string; commit(chatId: string): void }
  }): TurnStarted {
    // A resend is a read even during drain or at capacity. It never gets a new ticket.
    if (typeof o.chat !== 'function' && o.user) {
      const existing = this.existingTurn(o.chat.id, o.user.clientMessageId)
      if (existing) return existing
    }
    if (o.scheduled) {
      const existing = this.db.query('SELECT chat_id, user_message_id FROM turns WHERE schedule_id=? AND scheduled_for=? AND user_id=?')
        .get(o.scheduled.id, o.scheduled.dueAt, o.userId) as { chat_id: string; user_message_id: string } | null
      if (existing) {
        const message = this.store.messageRow(existing.user_message_id)
        if (!message?.client_message_id) throw new Error('scheduled occurrence lost its message')
        const result = this.existingTurn(existing.chat_id, message.client_message_id)
        if (!result) throw new Error('scheduled occurrence lost its turn')
        this.db.transaction(() => o.scheduled!.commit(existing.chat_id))()
        return result
      }
    }
    const turnId = newId(), now = new Date().toISOString()
    let userMessageId = o.answerTo?.id ?? '', assistantId = '', queueSeq = 0
    let chat!: ChatRow
    this.db.transaction(() => {
      this.checkQueueRoom(o.userId, o.locale)
      chat = typeof o.chat === 'function' ? o.chat() : o.chat
      if (this.activeTurn(chat.id) || this.db.query("SELECT 1 FROM turns WHERE chat_id=? AND status IN ('queued','running')").get(chat.id))
        throw new HttpError('conflict')
      queueSeq = this.queueStore.admit(o.userId)
      if (o.user) {
        userMessageId = this.store.insertMessage({ chatId: chat.id, parentId: o.user.parentId, role: 'user', authorId: o.userId, content: o.user.content,
          attachments: o.user.attachments, status: 'done', clientMessageId: o.user.clientMessageId, autoSent: !!o.scheduled })
      }
      assistantId = this.store.insertMessage({ chatId: chat.id, parentId: userMessageId, role: 'assistant', authorId: null, content: '', status: 'streaming',
        turnId, engine: o.engine, model: o.model })
      this.db.query(`INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, queued_at, message_id, user_message_id, window_id, client_kind, queue_seq, schedule_id, scheduled_for)
        VALUES (?,?,?,?,?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(turnId, chat.id, o.userId, o.engine, o.model, now, now, assistantId, userMessageId, o.windowId, o.clientKind, queueSeq, o.scheduled?.id ?? null, o.scheduled?.dueAt ?? null)
      // a chat without a title gets a placeholder from this message (title.ts); the AI may name it later (set_title)
      // never a stored connection secret of this person in it (QA INT-13, B-W5-1)
      const title = chat.title || (o.user ? placeholderTitle(o.user.content, o.user.attachments, redactorFor(this.ctx, o.userId).hide) : '')
      this.db.query('UPDATE chats SET active_leaf_id = ?, title = ?, engine = ?, model = ?, updated_at = ? WHERE id = ?')
        .run(assistantId, title, o.engine, o.model, now, chat.id)
      o.scheduled?.commit(chat.id)
    })()
    const spec: TurnSpec & QueueTiming = { turnId, chatId: chat.id, userId: o.userId, assistantId, userMessageId, windowId: o.windowId, clientKind: o.clientKind, engine: o.engine, model: o.model, locale: o.locale,
      queueSeq, ...(o.substitutedFrom ? { substitutedFrom: o.substitutedFrom } : {}) }
    const userMessage = o.user ? this.store.toMessage(this.store.messageRow(userMessageId)!) : null
    const assistantMessage = this.store.toMessage(this.store.messageRow(assistantId)!)
    // Admission is already durable. Notification failure must not leave it outside the live queue.
    this.enqueue(spec)
    try {
    if (o.scheduled) this.publishChat(o.userId, chat.id, 'created')
    if (userMessage) this.hub.publish(o.userId, { type: 'message.created', data: { chatId: chat.id, message: userMessage } })
    this.hub.publish(o.userId, { type: 'message.created', data: { chatId: chat.id, message: assistantMessage } })
    } finally { this.schedule() }
    this.publishChat(o.userId, chat.id, 'updated')
    return { userMessage, assistantMessage: this.store.toMessage(this.store.messageRow(assistantId)!), turnId,
      queuePosition: this.queuePosition(turnId) ?? 0, queueEpoch: this.queueEpoch, queueRevision: this.queueRevision }
  }

  /**
   * The queue is held in memory: it may not grow without end (docs/DECISIONS.md "클라우드 리눅스 서버"). The team may
   * have at most max(10, 4 × concurrency, 3 × min(active people,100)) waiting, one person at most 3; above that the send is refused with
   * 429 and Retry-After (the composer keeps the text). Running turns do not count.
   */
  checkQueueRoom(userId: string, locale: Locale): void {
    if (!this.acceptingTurns) {
      this.queueRejections.draining++
      throw new HttpError('unavailable', undefined, { retryAfter: QUEUE_RETRY_AFTER_S, params: { reason: this.recovering ? 'queue_recovery' : 'draining' } })
    }
    const counts = this.db.query("SELECT COUNT(*) team, COALESCE(SUM(user_id = ?),0) mine FROM turns WHERE status='queued'").get(userId) as { team: number; mine: number }
    // Conservatively include an in-memory item until reconciliation, including after a failed DB write.
    const team = Math.max(counts.team, this.queued.length)
    const mine = Math.max(counts.mine, this.queued.filter((s) => s.userId === userId).length)
    const people = (this.db.query("SELECT COUNT(*) n FROM users WHERE status='active' AND deleted_at IS NULL").get() as { n: number }).n
    const teamMax = Math.max(QUEUE_TEAM_MIN, 4 * this.concurrency(), QUEUE_PER_USER * Math.min(people, 100))
    if (team < teamMax && mine < QUEUE_PER_USER) return
    const reason = team >= teamMax ? 'queue_full' : 'queue_full_user'
    this.queueRejections[reason]++
    throw new HttpError('rate_limited', (QUEUE_FULL[locale] ?? QUEUE_FULL.en)[reason], { retryAfter: QUEUE_RETRY_AFTER_S, params: { reason } })
  }

  /** The turn that answers a client message id (idempotent resend). */
  existingTurn(chatId: string, clientMessageId: string): TurnStarted | null {
    const u = this.db.query('SELECT id FROM messages WHERE chat_id = ? AND client_message_id = ?').get(chatId, clientMessageId) as { id: string } | null
    if (!u) return null
    const t = this.db.query('SELECT id, message_id FROM turns WHERE user_message_id = ? ORDER BY id LIMIT 1').get(u.id) as { id: string; message_id: string } | null
    const user = this.store.messageRow(u.id)
    const answer = t ? this.store.messageRow(t.message_id) : null
    if (!t || !user || !answer) return null
    return { userMessage: this.store.toMessage(user), assistantMessage: this.liveMessage(answer), turnId: t.id, queuePosition: this.queuePosition(t.id) ?? 0, queueEpoch: this.queueEpoch, queueRevision: this.queueRevision }
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
    const chat = r ? this.store.toChat(r, this.runState(chatId)) : null
    // never a stored connection secret of the person in the title (QA B-W5-1)
    if (chat) chat.title = redactorFor(this.ctx, r!.user_id).hide(chat.title)
    this.hub.publish(userId, { type: 'chat.updated', data: { chatId, change, chat } })
  }

  // ---------------- start / stop ----------------
  /** Server start: turns that were running are interrupted (never re-run: tools may have written files);
   * queued turns start again in order (tab 3 "서버 재시작"). */
  async recover() {
    // A blocked startup retries only the launcher status, never the DB recovery writes or ticket repair.
    if (this.recovering) return this.recoveryTask ?? Promise.resolve()
    this.recoveryTask = this.recoverState()
    try { await this.recoveryTask } finally { this.recoveryTask = null }
  }

  private async recoverState() {
    if (this.recoveryAbort.signal.aborted) return
    if (this.running.size) throw new Error('cannot recover over live turn executions')
    this.recovering = true
    this.queued = []
    const now = new Date().toISOString()
    this.db.query("UPDATE schedules SET enabled=0,pending_due_at=NULL,retry_at=NULL WHERE user_id NOT IN (SELECT id FROM users WHERE status='active' AND deleted_at IS NULL)").run()
    const running = this.db.query("SELECT id, message_id, user_id FROM turns WHERE status = 'running'").all() as { id: string; message_id: string | null; user_id: string }[]
    this.db.transaction(() => { for (const t of running) {
      const locale = this.userLocale(t.user_id)
      this.db.query("UPDATE turns SET status = 'interrupted', ended_at = ?, error = 'interrupted' WHERE id = ?").run(now, t.id)
      if (t.message_id) this.db.query("UPDATE messages SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status = 'streaming'").run(JSON.stringify(engineError('interrupted', locale)), now, t.message_id)
      this.db.query('UPDATE proxy_tokens SET revoked_at = ? WHERE turn_id = ? AND revoked_at IS NULL').run(now, t.id)
    } })()
    // Invalid users/chats/messages never survive a restart as runnable work.
    this.db.transaction(() => {
      const bad = this.db.query(`SELECT t.id,t.message_id FROM turns t WHERE t.status='queued' AND
        (NOT EXISTS(SELECT 1 FROM users u WHERE u.id=t.user_id AND u.status='active' AND u.deleted_at IS NULL)
         OR NOT EXISTS(SELECT 1 FROM chats c WHERE c.id=t.chat_id AND c.deleted_at IS NULL)
         OR NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=t.message_id AND m.chat_id=t.chat_id)
         OR NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=t.user_message_id AND m.chat_id=t.chat_id)
         -- a scheduled run of a free-text task nobody confirmed (queued before the upgrade): never runs (schedules.ts)
         OR EXISTS(SELECT 1 FROM schedules s WHERE s.id=t.schedule_id AND s.template_id IS NULL AND s.confirmed_at IS NULL))`).all() as { id: string; message_id: string | null }[]
      for (const t of bad) {
        this.db.query("UPDATE turns SET status='stopped',ended_at=? WHERE id=?").run(now,t.id)
        if (t.message_id) this.db.query("UPDATE messages SET status='stopped',updated_at=? WHERE id=? AND status='streaming'").run(now,t.message_id)
      }
      this.queueStore.repair()
    })()
    const queued = this.db.query(`SELECT t.id, t.chat_id, t.user_id, t.message_id, t.user_message_id, t.window_id, t.client_kind, t.engine, t.model,t.queue_seq
      FROM turns t JOIN chats c ON c.id = t.chat_id WHERE t.status = 'queued' AND c.deleted_at IS NULL ORDER BY t.queue_seq,t.id`).all() as {
      id: string; chat_id: string; user_id: string; message_id: string | null; user_message_id: string | null; window_id: string | null; client_kind: string | null; engine: string; model: string | null; queue_seq: number }[]
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
        clientKind: t.client_kind, engine: t.engine === 'codex' || t.engine === 'api' ? t.engine : 'claude-code', model: t.model, locale: this.userLocale(t.user_id), queueSeq: t.queue_seq })
    }
    this.queueStore.repair()
    this.queueRevision++
    // answers left streaming without a turn (crash between writes)
    const queuedIds = new Set(this.queued.map((s) => s.assistantId))
    const stale = this.db.query("SELECT id, chat_id FROM messages WHERE status = 'streaming'").all() as { id: string; chat_id: string }[]
    for (const m of stale) if (!queuedIds.has(m.id)) {
      const owner = (this.db.query('SELECT user_id FROM chats WHERE id = ?').get(m.chat_id) as { user_id: string } | null)?.user_id
      this.db.query("UPDATE messages SET status = 'error', error = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(engineError('interrupted', owner ? this.userLocale(owner) : DEFAULT_LOCALE)), now, m.id)
    }
    if (running.length || this.queued.length) this.log.info('turn queue recovered', { interrupted: running.length, requeued: this.queued.length })
    if (this.ctx.config.mode === 'prod') {
      this.recoveryState = 'checking_launcher'
      await this.checkRecoveryLauncher()
      return
    }
    this.recovering = false
    this.schedule()
  }

  private async checkRecoveryLauncher(): Promise<void> {
    if (!this.recovering || this.recoveryAbort.signal.aborted) return
    const sock = this.ctx.config.engine.launcherSock ?? path.join(this.ctx.engineConfig.runDir, 'launcher.sock')
    const status = await launcherStatus(sock, 1000, this.recoveryAbort.signal)
    if (this.recoveryAbort.signal.aborted) return
    if (status?.liveTurns === 0) {
      this.recoveryState = 'ready'
      this.recovering = false
      this.log.info('queue recovery launcher confirmed idle')
      this.schedule()
      return
    }
    const state = !status ? 'launcher_unreachable' : status.liveTurns === undefined ? 'launcher_unknown' : 'launcher_busy'
    if (this.recoveryState !== state) this.log.warn('queue recovery waiting for an idle launcher', { reason: state })
    this.recoveryState = state
    // Schedule only after this probe finished: one outstanding connect, no overlapping recovery attempts.
    this.recoveryRetry = setTimeout(() => {
      this.recoveryRetry = null
      void this.checkRecoveryLauncher().catch(err => this.log.error('queue recovery check failed', { err }))
    }, this.o.recoveryPollMs ?? 1000)
    this.recoveryRetry.unref?.()
  }

  userLocale(userId: string): Locale {
    const r = this.db.query('SELECT locale, prefs FROM users WHERE id = ?').get(userId) as { locale: string; prefs: string | null } | null
    let answer: unknown
    try { answer = JSON.parse(r?.prefs ?? '{}')?.answerLocale } catch {}
    const l = (answer ?? r?.locale) as string | undefined
    return l === 'en' || l === 'id' || l === 'ko' || l === 'ja' || l === 'es' ? l : DEFAULT_LOCALE
  }

  /** The launcher's answers for the last purge run (tests wait on it; chat/forget.ts never rejects). */
  lastForget: Promise<void> = Promise.resolve()

  /** Delete chats that stayed in the trash past the retention (messages, artifacts, engine session, work folder). */
  purgeTrash(now = Date.now()) {
    const cutoff = new Date(now - this.chatTrashDays() * 86400_000).toISOString()
    const rows = this.db.query('SELECT id, user_id FROM chats WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff) as { id: string; user_id: string }[]
    const purged: string[] = []
    for (const c of rows) {
      if (this.activeTurn(c.id)) continue
      this.purgeChat(c.id)
      purged.push(c.id)
      this.publishChat(c.user_id, c.id, 'purged')
    }
    // the engine folders of these chats (the launcher's, in production) and any the launcher missed before
    this.lastForget = retryPendingForgets(this.ctx).then(() => forgetPurgedChats(this.ctx, purged))
    return rows.length
  }
  /** The chat's rows; what it left outside the DB goes with forgetPurgedChats (chat/forget.ts). */
  purgeChat(chatId: string) {
    this.db.transaction(() => {
      this.db.query('DELETE FROM messages WHERE chat_id = ?').run(chatId)
      this.db.query('DELETE FROM artifacts WHERE chat_id = ?').run(chatId)
      this.db.query('UPDATE memories SET source_chat_id = NULL WHERE source_chat_id = ?').run(chatId)
      this.db.query('DELETE FROM chats WHERE id = ?').run(chatId)
    })()
  }

  /** Stop taking new turns and wait for the running ones (planned restart / update). */
  async drain(maxMs: number): Promise<boolean> {
    this.closing = true
    const all = Promise.all([...this.running.values()].map((e) => e.done))
    const r = await Promise.race([all.then(() => this.running.size === 0), Bun.sleep(maxMs).then(() => false)])
    return r
  }
  resume() { this.closing = false; this.schedule() }

  private shutdownP: Promise<void> | null = null
  shutdown(): Promise<void> {
    if (this.shutdownP) return this.shutdownP
    this.closing = true
    clearInterval(this.purger)
    clearInterval(this.capacityWatcher)
    if (this.recoveryRetry) clearTimeout(this.recoveryRetry)
    this.recoveryRetry = null
    this.recoveryAbort.abort()
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
