// A member asks the owner and the admins to add an app the team has not set up (contract: shared/src/api/service-
// requests.ts; tables: server/migrations/343_c_service_requests.sql; docs/INTEGRATIONS.md "A member asks for an app").
// Like an app request in Slack: the member taps "Ask admin to add it" on the app's page, the owner and the admins get
// one notice per app in Activity that opens its setup, and when the member can connect it they get one quiet notice.
//
//   - Only the apps an admin sets up once for everyone (REQUESTABLE_SERVICES: Google Drive and the Google apps), and
//     only while not set up: an app the member can connect is refused (can_connect), and so is one the team turned off
//     for members or this computer cannot run (not_requestable). Any other name is refused (unknown_service): no free
//     text from a member ever reaches an admin. Owners and admins set it up themselves (403).
//   - One open request per member and app (a partial unique index); asking again while it is open changes nothing and
//     says "already". At most SERVICE_REQUESTS_PER_DAY new requests per member a day. Audited ('service_request.ask').
//   - The notice (notifications/service.ts serviceRequested): one per owner or admin and app, armed again by each new
//     ask; who asks is read when the inbox is shown (integrations/service-request-notices.ts). The answer to the member
//     and their notice never name an admin.
//   - Requests close (settleServiceRequests): 'added' once members can connect the app (right after an admin's setup or
//     members' switch, and on a 30-second check for a setup made elsewhere: the operator's file, the hosting service's
//     Google sign-in coming up), with a 'service.ready' notice to the member; 'left' when the member left the team or
//     became an owner or admin; 'expired' after the inbox's 30 days (they may ask again). With none left for an app,
//     the admins' notice counts as read.
import { isRequestableService, SERVICE_REQUESTS_PER_DAY, type AskServiceResult, type RequestableService, type ServiceRequest } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { HttpError } from '../http/errors'
import { audit } from '../admin/audit'
import { admins } from '../credentials/store'
import { NOTIFICATION_RETENTION_MS, notifyServiceReady, notifyServiceRequested, settleServiceRequestNotices } from '../notifications/service'
import { googleDriveOf } from './google-drive/oauth'
import { membersCanConnect } from './google-drive/shares'
import { googleAppsOf } from './google-apps/service'

const DAY_MS = 86_400_000
/** how often open requests are checked against the apps' setup (a setup made outside Admin › Connected apps) */
const CHECK_MS = 30_000

/** What the team's setup of an app means for a member now: it can be asked for (not set up), they can connect it
 * (available: a request closes), or neither (turned off for members, this computer cannot run it). */
export type ServiceState = 'not_set_up' | 'available' | 'other'

export function serviceState(ctx: AppContext, service: RequestableService): ServiceState {
  if (service === 'google-drive') {
    if (!googleDriveOf(ctx).enabled) return 'not_set_up'
    return membersCanConnect(ctx.db) ? 'available' : 'other'
  }
  const reason = googleAppsOf(ctx).reasonOf(service)
  // 'service_limited': set up, and the hosting service's Google review lets only its test users in for now
  return reason === 'not_set_up' ? 'not_set_up' : reason === null || reason === 'service_limited' ? 'available' : 'other'
}

const refuse = (code: 'bad_request' | 'forbidden' | 'conflict' | 'rate_limited', reason: string): never => { throw new HttpError(code, undefined, { params: { reason } }) }

/** My open requests (a member's; owners and admins have none). */
export function myServiceRequests(ctx: AppContext, userId: string): { items: ServiceRequest[] } {
  const rows = ctx.db.query('SELECT service, created_at FROM service_requests WHERE user_id = ? AND closed_at IS NULL ORDER BY created_at, id').all(userId) as { service: string; created_at: string }[]
  return { items: rows.flatMap((r) => (isRequestableService(r.service) ? [{ service: r.service, askedAt: r.created_at }] : [])) }
}

export function askService(ctx: AppContext, user: { id: string; role: string }, raw: string): AskServiceResult {
  if (!isRequestableService(raw)) refuse('bad_request', 'unknown_service')
  const service = raw as RequestableService
  if (user.role !== 'member') refuse('forbidden', 'admin')
  const db = ctx.db
  if (!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(user.id)) throw new HttpError('forbidden')
  // an app set up meanwhile: its requests close first (the member then hears it is ready, and this ask is refused)
  settleServiceRequests(ctx, service)
  const open = () => db.query('SELECT created_at FROM service_requests WHERE user_id = ? AND service = ? AND closed_at IS NULL').get(user.id, service) as { created_at: string } | null
  const was = open()
  if (was) return { service, state: 'already', askedAt: was.created_at }
  const state = serviceState(ctx, service)
  if (state === 'available') refuse('conflict', 'can_connect')
  if (state === 'other') refuse('conflict', 'not_requestable')
  const nowMs = Date.now(), now = new Date(nowMs).toISOString()
  const made = db.transaction(() => {
    const again = open()
    if (again) return again.created_at
    const { n } = db.query('SELECT COUNT(*) AS n FROM service_requests WHERE user_id = ? AND created_at > ?').get(user.id, new Date(nowMs - DAY_MS).toISOString()) as { n: number }
    if (n >= SERVICE_REQUESTS_PER_DAY) refuse('rate_limited', 'rate_limited')
    db.query('INSERT INTO service_requests (id, user_id, service, created_at) VALUES (?, ?, ?, ?)').run(newId(), user.id, service, now)
    audit(db, { actor: user.id, action: 'service_request.ask', detail: { service } })
    return null
  })()
  if (made) return { service, state: 'already', askedAt: made }
  notifyServiceRequested(ctx, admins(db), service)
  return { service, state: 'sent', askedAt: now }
}

/** Close the requests that no longer wait (see the top of this file); `service`: only that app's. Returns how many
 * closed. Never throws: an app whose setup cannot be read now is checked again on the next pass. */
export function settleServiceRequests(ctx: AppContext, service?: RequestableService): number {
  const db = ctx.db
  const rows = db.query(`SELECT r.id, r.user_id, r.service, r.created_at, u.role, u.status, u.deleted_at FROM service_requests r
    LEFT JOIN users u ON u.id = r.user_id WHERE r.closed_at IS NULL ${service ? 'AND r.service = ?' : ''}`).all(...(service ? [service] : [])) as
    { id: string; user_id: string; service: string; created_at: string; role: string | null; status: string | null; deleted_at: string | null }[]
  if (!rows.length) return 0
  const now = new Date().toISOString(), cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_MS).toISOString()
  const states = new Map<string, ServiceState | null>()
  const stateOf = (s: RequestableService) => {
    if (!states.has(s)) { try { states.set(s, serviceState(ctx, s)) } catch { ctx.log.warn('app request check deferred'); states.set(s, null) } }
    return states.get(s)
  }
  const ready: { userId: string; id: string }[] = []
  const touched = new Set<string>()
  let closed = 0
  db.transaction(() => {
    const close = db.query('UPDATE service_requests SET closed_at = ?, closed_reason = ? WHERE id = ? AND closed_at IS NULL')
    for (const r of rows) {
      const left = r.role !== 'member' || r.status !== 'active' || r.deleted_at !== null
      const reason = left ? 'left' : !isRequestableService(r.service) || r.created_at < cutoff ? 'expired' : stateOf(r.service) === 'available' ? 'added' : null
      if (!reason || !close.run(now, reason, r.id).changes) continue
      closed++
      touched.add(r.service)
      if (reason === 'added') ready.push({ userId: r.user_id, id: r.id })
    }
  })()
  for (const x of ready) notifyServiceReady(ctx, x.userId, x.id)
  for (const s of touched) if (!db.query('SELECT 1 FROM service_requests WHERE service = ? AND closed_at IS NULL').get(s)) settleServiceRequestNotices(ctx, s)
  return closed
}

/** After an admin set up an app or turned its members' switch: its requests close now when members can connect it. */
export function afterServiceSetup(ctx: AppContext, service: RequestableService) {
  try { settleServiceRequests(ctx, service) } catch { ctx.log.warn('app request check deferred') }
}

/** The 30-second check (a setup made outside Admin › Connected apps, the 30 days, members who left). */
export function installServiceRequests(ctx: AppContext) {
  const tick = () => { try { settleServiceRequests(ctx) } catch { ctx.log.warn('app request check deferred') } }
  const timer = setInterval(tick, CHECK_MS); timer.unref?.()
  ctx.onClose(() => clearInterval(timer))
}
