import type { InboxNotification, NotificationEventType, NotificationPreferences, ScheduleRunOutcome } from '@mycel/shared/api'
import { outcomeEvent, storedRunOutcome } from '../chat/schedule-outcome'
import type { AppContext } from '../context'
import { newId } from '../db'
import { HttpError } from '../http/errors'
import { decodeCursor, encodeCursor } from '../chat/store'
import { authorize } from '../policy/authorize'
import { atLeast } from '../policy/access'
import { readScope } from '../chat/read-scope'
import { getRow as getIntegration, mayUse as mayUseIntegration } from '../integrations/connections/store'
import { eventEnabled, getPreferences, savePreferences } from './preferences'
import { cancelPushUser, cancelDisabledPushDeliveries } from './push-events'

export const NOTIFICATION_RETENTION_MS = 30 * 86400_000
const services = new WeakMap<AppContext, Notifications>()
type Row = { id: string; user_id: string; event_type: NotificationEventType; source_id: string; created_at: string; read_at: string | null }
type Terminal = { id: string; user_id: string; status: string; ended_at: string; run_outcome: string | null }
export class Notifications {
  constructor(readonly ctx: AppContext) {}
  private active(userId: string) { return !!this.ctx.db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(userId) }
  private cutoff(now = Date.now()) { return new Date(now - NOTIFICATION_RETENTION_MS).toISOString() }
  private signal(userId: string) {
    // No content, title, filename, credential, or dynamic error text in WS/OS-facing metadata.
    try { this.ctx.services.realtime.publish(userId, { type: 'notice', data: { level: 'info', code: 'notifications.changed', message: '' } }) }
    catch { this.ctx.log.warn('notification refresh signal failed') }
  }
  private record(userId: string, event: NotificationEventType, sourceId: string, at: string) {
    if (!this.active(userId) || at < this.cutoff()) return
    const enabled = eventEnabled(this.preferences(userId), event)
    const r = this.ctx.db.query('INSERT INTO notification_inbox(id,user_id,event_type,source_id,created_at,suppressed) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,event_type,source_id) DO NOTHING')
      .run(newId(), userId, event, sourceId, at, enabled ? 0 : 1)
    if (r.changes && enabled) this.signal(userId)
  }
  afterTurn(turnId: string) {
    try {
      const row = this.ctx.db.query("SELECT id,user_id,status,ended_at,run_outcome FROM turns WHERE id=? AND schedule_id IS NOT NULL AND status IN ('done','error','stopped','interrupted') AND ended_at IS NOT NULL").get(turnId) as Terminal | null
      if (row) this.record(row.user_id, outcomeEvent(storedRunOutcome(row)), row.id, row.ended_at)
    } catch { this.ctx.log.warn('notification recording deferred to reconciliation') }
  }
  connectionReconnect(userId: string, sourceId: string, createdAt = new Date().toISOString()) {
    // Producer passes a stable opaque episode identifier, never a token, address, URL, or error message.
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sourceId)) throw new HttpError('validation')
    if (!Number.isFinite(Date.parse(createdAt))) throw new HttpError('validation')
    this.record(userId, 'connection.reconnect', sourceId, new Date(createdAt).toISOString())
  }
  /** Terminal DB rows are the source of truth. Missing hooks, queued cancellation and interrupted recovery converge. */
  reconcile(userId?: string) {
    const db = this.ctx.db
    db.query('DELETE FROM notification_inbox WHERE created_at < ?').run(this.cutoff())
    db.query('DELETE FROM schedule_outcomes WHERE created_at < ?').run(this.cutoff())
    const rows = db.query(`SELECT t.id,t.user_id,t.status,t.ended_at,t.run_outcome FROM turns t
      WHERE EXISTS(SELECT 1 FROM users u WHERE u.id=t.user_id AND u.status='active' AND u.deleted_at IS NULL)
      AND t.schedule_id IS NOT NULL AND t.status IN ('done','error','stopped','interrupted') AND t.ended_at >= ?
      ${userId ? 'AND t.user_id=?' : ''} AND NOT EXISTS(SELECT 1 FROM notification_inbox n WHERE n.user_id=t.user_id AND n.source_id=t.id AND n.event_type IN ('schedule.success','schedule.failure'))
      ORDER BY t.ended_at,t.id LIMIT 500`).all(...(userId ? [this.cutoff(), userId] : [this.cutoff()])) as Terminal[]
    for (const row of rows) this.record(row.user_id, outcomeEvent(storedRunOutcome(row)), row.id, row.ended_at)
    const skips = db.query(`SELECT s.id,s.user_id,s.created_at FROM schedule_outcomes s
      WHERE s.created_at>=? AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL)
      ${userId ? 'AND s.user_id=?' : ''} AND NOT EXISTS(SELECT 1 FROM notification_inbox n WHERE n.user_id=s.user_id AND n.source_id=s.id AND n.event_type='schedule.failure')
      ORDER BY s.created_at,s.id LIMIT 500`).all(...(userId ? [this.cutoff(), userId] : [this.cutoff()])) as { id: string; user_id: string; created_at: string }[]
    for (const row of skips) this.record(row.user_id, 'schedule.failure', row.id, row.created_at)
    return Math.max(rows.length, skips.length)
  }
  preferences(userId: string) { return getPreferences(this.ctx.db, userId) }
  setPreferences(userId: string, patch: Partial<NotificationPreferences>) {
    if (!this.active(userId)) throw new HttpError('not_found')
    // Process previous terminal events with the old preferences before committing a change.
    const result = this.ctx.db.transaction(() => {
      while (this.reconcile(userId) === 500) { /* drain all prior events under the old preferences */ }
      const preferences = savePreferences(this.ctx.db, userId, patch)
      cancelDisabledPushDeliveries(this.ctx, userId, preferences)
      return preferences
    })()
    cancelPushUser(this.ctx, userId)
    this.signal(userId)
    return result
  }
  private out(row: Row): InboxNotification {
    let chatId: string | null = null, outcome: ScheduleRunOutcome | null = null
    if (row.event_type !== 'connection.reconnect') {
      // Metadata only: the stored result code, never the turn's error text. No turn = an admission skip (failed).
      const run = this.ctx.db.query('SELECT status,run_outcome FROM turns WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { status: string; run_outcome: string | null } | null
      outcome = run ? storedRunOutcome(run) : 'failed'
      const chat = this.ctx.db.query(`SELECT c.id,c.project_id,t.template_source_path FROM turns t JOIN chats c ON c.id=t.chat_id
        WHERE t.id=? AND t.user_id=? AND c.user_id=? AND c.deleted_at IS NULL`).get(row.source_id, row.user_id, row.user_id) as { id: string; project_id: string | null; template_source_path: string | null } | null
      if (chat) {
        try {
          const p = this.ctx.files.principal(row.user_id), rules = this.ctx.files.rules()
          if (chat.template_source_path) authorize(this.ctx.files.fx, rules, p, chat.template_source_path, 'read')
          if (chat.project_id) {
            const project = this.ctx.db.query('SELECT folder_path FROM projects WHERE id=?').get(chat.project_id) as { folder_path: string } | null
            if (!project) throw new Error('missing project')
            authorize(this.ctx.files.fx, rules, p, project.folder_path, 'read')
          }
          for (const source of readScope(this.ctx.db, chat.id) ?? []) {
            if (source.type === 'user') { if (source.id !== row.user_id) throw new Error('private source revoked'); continue }
            if (source.type === 'integration') { const c = getIntegration(this.ctx.db, source.id); if (!c || !mayUseIntegration(this.ctx.db, c, row.user_id)) throw new Error('source revoked'); continue }
            let folder = ''
            if (source.type === 'folder') {
              const found = this.ctx.db.query('SELECT path FROM folders WHERE id=?').get(source.id) as { path: string } | null
              if (!found) throw new Error('source deleted')
              folder = found.path
            } else if (source.type !== 'root') throw new Error('unknown source')
            if (!atLeast(rules.access(p, folder ? folder.split('/') : []), 'read')) throw new Error('source revoked')
          }
          chatId = chat.id
        } catch { /* revoked/deleted source: generic entry remains, deep link does not */ }
      }
    }
    return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at,
      chatId, link: chatId ? 'chat' : row.event_type === 'connection.reconnect' ? 'connections' : null, outcome }
  }
  list(userId: string, o: { cursor?: string; limit?: number }) {
    const cur = decodeCursor(o.cursor, ['t', 'id'])
    if (o.cursor && (!cur || !Number.isFinite(Date.parse(cur.t!)))) throw new HttpError('validation')
    if (!this.active(userId)) return { items: [], nextCursor: null, unreadCount: 0 }
    const limit = Math.min(100, Math.max(1, o.limit ?? 30)), db = this.ctx.db, cutoff = this.cutoff()
    const rows = db.query(`SELECT * FROM notification_inbox WHERE user_id=? AND suppressed=0 AND created_at>=?
      ${cur ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...(cur ? [userId, cutoff, cur.t!, cur.t!, cur.id!, limit + 1] : [userId, cutoff, limit + 1])) as Row[]
    const selected = rows.slice(0, limit), last = selected.at(-1)
    const { n } = db.query('SELECT COUNT(*) n FROM notification_inbox WHERE user_id=? AND suppressed=0 AND read_at IS NULL AND created_at>=?').get(userId, cutoff) as { n: number }
    return { items: selected.map(r => this.out(r)), nextCursor: rows.length > limit && last ? encodeCursor({ t: last.created_at, id: last.id }) : null, unreadCount: n }
  }
  get(userId: string, id: string): InboxNotification {
    if (!this.active(userId)) throw new HttpError('not_found')
    const row = this.ctx.db.query('SELECT * FROM notification_inbox WHERE id=? AND user_id=? AND suppressed=0 AND created_at>=?').get(id,userId,this.cutoff()) as Row | null
    if (!row) throw new HttpError('not_found')
    return this.out(row)
  }
  read(userId: string, id: string): InboxNotification {
    if (!this.active(userId)) throw new HttpError('not_found')
    const db = this.ctx.db
    const r = db.query('UPDATE notification_inbox SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=? AND suppressed=0 AND created_at>=? RETURNING *').get(new Date().toISOString(), id, userId, this.cutoff()) as Row | null
    if (!r) throw new HttpError('not_found')
    this.signal(userId)
    return this.out(r)
  }
}
export function notificationsOf(ctx: AppContext): Notifications {
  let service = services.get(ctx)
  if (!service) { service = new Notifications(ctx); services.set(ctx, service) }
  return service
}
export function installNotifications(ctx: AppContext) {
  const service = notificationsOf(ctx)
  const tick = () => { try { service.reconcile() } catch { ctx.log.warn('notification reconciliation deferred') } }
  tick()
  const interval = setInterval(tick, 30_000); interval.unref?.()
  ctx.onClose(() => clearInterval(interval))
}
export function notifyConnectionReconnect(ctx: AppContext, userId: string, sourceId: string, createdAt?: string) {
  try { notificationsOf(ctx).connectionReconnect(userId, sourceId, createdAt) }
  catch { ctx.log.warn('connection notification recording deferred') }
}
