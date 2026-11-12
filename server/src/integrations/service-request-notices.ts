// What the inbox shows for a member's ask to add an app (integrations/service-requests.ts; notifications/service.ts
// out). A leaf module: the database and the shared contract only, so the inbox can read it without the services.
//
// service.request (an owner or admin; the source is the app's id): while any request for the app waits, the newest
// asker by name and how many others ask with them (state 'open': the app's setup opens from it); when none waits, who
// asked in the round that ended last and how it ended ('added': members can connect it now, 'ended': the asks expired
// or their members left). Someone who is no longer an owner or admin gets the app only, and no names.
// service.ready (the member who asked; the source is the request's id): the app, to connect. Never who set it up.
import type { Database } from 'bun:sqlite'
import { isRequestableService, plainLabel, type InboxNotification, type NotificationEventType } from '@mycel/shared/api'
import { admins } from '../credentials/store'

interface NoticeRow { id: string; user_id: string; event_type: NotificationEventType; source_id: string; created_at: string; read_at: string | null }

const ACTIVE = "u.status = 'active' AND u.deleted_at IS NULL"

export function serviceRequestOut(db: Database, row: NoticeRow): InboxNotification {
  const base: InboxNotification = { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null }
  if (row.event_type === 'service.ready') {
    const r = db.query('SELECT service FROM service_requests WHERE id = ? AND user_id = ?').get(row.source_id, row.user_id) as { service: string } | null
    return r && isRequestableService(r.service) ? { ...base, serviceRequest: { service: r.service } } : base
  }
  const service = row.source_id
  if (!isRequestableService(service)) return base
  if (!admins(db).includes(row.user_id)) return { ...base, serviceRequest: { service } }
  const open = db.query(`SELECT u.name FROM service_requests r JOIN users u ON u.id = r.user_id
    WHERE r.service = ? AND r.closed_at IS NULL AND ${ACTIVE} ORDER BY r.created_at DESC, r.id DESC`).all(service) as { name: string }[]
  if (open.length) return { ...base, serviceRequest: { service, name: plainLabel(open[0]!.name), others: open.length - 1, open: true } }
  // the round that ended last: the requests closed at the same moment (an admin's setup closes them together)
  const last = db.query('SELECT MAX(closed_at) AS at FROM service_requests WHERE service = ? AND closed_at IS NOT NULL').get(service) as { at: string | null }
  const round = last.at ? db.query(`SELECT u.name, r.closed_reason FROM service_requests r JOIN users u ON u.id = r.user_id
    WHERE r.service = ? AND r.closed_at = ? AND u.deleted_at IS NULL ORDER BY r.created_at DESC, r.id DESC`).all(service, last.at) as { name: string; closed_reason: string }[] : []
  return { ...base, serviceRequest: { service, name: round[0] ? plainLabel(round[0].name) : null, others: Math.max(0, round.length - 1), open: false, ...(round.some((r) => r.closed_reason === 'added') ? { added: true } : {}) } }
}
