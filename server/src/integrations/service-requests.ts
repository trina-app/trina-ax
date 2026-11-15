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
//     the admins' notice counts as read. The same check keeps the admins' notices with the people who are owners and
//     admins now (notifications/service.ts syncServiceRequests).
//   - An app whose setup is not the admins' to make (a hosted team's, an operator's) cannot be asked for: nobody could
//     answer it here.
import { isGoogleRequestable, isRequestableService, SERVICE_REQUESTS_PER_DAY, type AskServiceResult, type RequestableService, type ServiceRequest, type TeamServiceRequest } from '@mycel/shared/api'
import { catalogAt } from '@mycel/shared'
import { mayUse, selectRows, type Row } from './connections/store'
import type { AppContext } from '../context'
import { newId } from '../db'
import { HttpError } from '../http/errors'
import { audit } from '../admin/audit'
import { admins } from '../credentials/store'
import { NOTIFICATION_RETENTION_MS, notifyServiceReady, notifyServiceRequested, settleServiceRequestNotices, syncServiceRequestNotices } from '../notifications/service'
import { googleDriveOf } from './google-drive/oauth'
import { googleAppsOf } from './google-apps/service'
import { setupOf } from './google-apps/config'
import { isHosted } from '../system/deployment'

const DAY_MS = 86_400_000
/** how often open requests are checked against the apps' setup (a setup made outside Admin › Connected apps) */
const CHECK_MS = 30_000

/** What the team's setup of an app means for a member now: it can be asked for (not set up, and an admin can set it
 * up here), they can connect it (available: a request closes), or neither (turned off for members, this computer cannot
 * run it, the hosting service's Google review lets only its test users in for now, or the setup is not the admins' to
 * make: a hosted team's comes from the hosting service, an operator's file from the server). */
export type ServiceState = 'not_set_up' | 'available' | 'other'

export function serviceState(ctx: AppContext, service: RequestableService, userId?: string): ServiceState {
  // a service of the app's list (QA TC-133): added for this member once a team connection to its official address
  // exists that they may use. Any admin may connect it for the team here, so it is never 'other'
  if (!isGoogleRequestable(service)) return userId && teamCovers(ctx, service, userId) ? 'available' : 'not_set_up'
  if (service === 'google-drive') {
    const drive = googleDriveOf(ctx)
    if (!drive.enabled) return isHosted(ctx.config) || drive.clientFromEnv ? 'other' : 'not_set_up'
    return 'available'
  }
  const reason = googleAppsOf(ctx).reasonOf(service)
  if (reason === 'not_set_up') return isHosted(ctx.config) || setupOf(ctx, service).byOperator ? 'other' : 'not_set_up'
  return reason === null ? 'available' : 'other'
}

/** A working team connection to one of the listed service's official addresses (any spelling of it) that this member may
 * use. */
function teamCovers(ctx: AppContext, service: string, userId: string): boolean {
  const rows = ctx.db.query(`${selectRows(ctx.db)} WHERE scope = 'team'`).all() as Row[]
  // at any of its official addresses (Atlassian's v1 and v2: catalogAt); only one that works: a team connection that
  // needs a sign-in or fails would close the request and say "ready" for something the member cannot use yet (review
  // of #601)
  return rows.some((r) => r.status === 'connected' && catalogAt(r.url)?.id === service && mayUse(ctx.db, r, userId))
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
  const state = serviceState(ctx, service, user.id)
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
  const rows = db.query(`SELECT r.id, r.user_id, r.service, r.created_at, CASE WHEN u.guest = 1 THEN 'guest' ELSE u.role END AS role, u.status, u.deleted_at FROM service_requests r
    LEFT JOIN users u ON u.id = r.user_id WHERE r.closed_at IS NULL ${service ? 'AND r.service = ?' : ''}`).all(...(service ? [service] : [])) as
    { id: string; user_id: string; service: string; created_at: string; role: string | null; status: string | null; deleted_at: string | null }[]
  if (!rows.length) return 0
  const now = new Date().toISOString(), cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_MS).toISOString()
  const states = new Map<string, ServiceState | null>()
  // a Google app's state is the team's; a listed service's is the member's (a team connection they may use)
  const stateOf = (s: RequestableService, userId: string) => {
    const key = isGoogleRequestable(s) ? s : `${s}\n${userId}`
    if (!states.has(key)) { try { states.set(key, serviceState(ctx, s, userId)) } catch { ctx.log.warn('app request check deferred'); states.set(key, null) } }
    return states.get(key)
  }
  const ready: { userId: string; id: string }[] = []
  const touched = new Set<string>()
  let closed = 0
  db.transaction(() => {
    const close = db.query('UPDATE service_requests SET closed_at = ?, closed_reason = ? WHERE id = ? AND closed_at IS NULL')
    for (const r of rows) {
      const left = r.role !== 'member' || r.status !== 'active' || r.deleted_at !== null
      const reason = left ? 'left' : !isRequestableService(r.service) || r.created_at < cutoff ? 'expired' : stateOf(r.service, r.user_id) === 'available' ? 'added' : null
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

/** A member takes back their own open request (nothing happens when there is none). Closed with no reason (the
 * column's CHECK allows NULL: withdrawn or dismissed); it still counts toward the day's limit. Audited. With none left
 * for the app, the admins' notice counts as read. */
export function withdrawService(ctx: AppContext, userId: string, raw: string) {
  if (!isRequestableService(raw)) refuse('bad_request', 'unknown_service')
  const n = ctx.db.query('UPDATE service_requests SET closed_at = ? WHERE user_id = ? AND service = ? AND closed_at IS NULL').run(new Date().toISOString(), userId, raw).changes
  if (!n) return
  audit(ctx.db, { actor: userId, action: 'service_request.withdraw', detail: { service: raw } })
  if (!ctx.db.query('SELECT 1 FROM service_requests WHERE service = ? AND closed_at IS NULL').get(raw)) settleServiceRequestNotices(ctx, raw)
}

/** The open requests, by app, for the owner and the admins: who asked (active members), newest first. */
export function teamServiceRequests(ctx: AppContext): { items: TeamServiceRequest[] } {
  const rows = ctx.db.query(`SELECT r.service, r.created_at, u.id, u.name FROM service_requests r JOIN users u ON u.id = r.user_id
    WHERE r.closed_at IS NULL AND u.status = 'active' AND u.deleted_at IS NULL ORDER BY r.created_at DESC, r.id DESC`).all() as { service: string; created_at: string; id: string; name: string }[]
  const by = new Map<string, TeamServiceRequest>()
  for (const r of rows) {
    if (!isRequestableService(r.service)) continue
    const x = by.get(r.service) ?? { service: r.service, askers: [], askedAt: r.created_at }
    x.askers.push({ id: r.id, name: r.name })
    by.set(r.service, x)
  }
  return { items: [...by.values()] }
}

/** An owner or admin closes the open requests for an app without adding it: nobody is told, the members may ask again.
 * Audited; the admins' notice counts as read. */
export function dismissServiceRequests(ctx: AppContext, actor: string, raw: string) {
  if (!isRequestableService(raw)) refuse('bad_request', 'unknown_service')
  const n = ctx.db.query('UPDATE service_requests SET closed_at = ? WHERE service = ? AND closed_at IS NULL').run(new Date().toISOString(), raw).changes
  if (!n) return
  audit(ctx.db, { actor, action: 'service_request.dismiss', detail: { service: raw, requests: n } })
  settleServiceRequestNotices(ctx, raw)
}

/** A team connection was made or changed (its address, who may use it): requests for the listed service at that
 * address close for the members who may use it now. */
export function afterTeamConnection(ctx: AppContext, url: string) {
  const c = catalogAt(url)
  if (c) afterServiceSetup(ctx, c.id)
}

/** After an admin set up an app or turned its members' switch: its requests close now when members can connect it. */
export function afterServiceSetup(ctx: AppContext, service: RequestableService) {
  try { settleServiceRequests(ctx, service) } catch { ctx.log.warn('app request check deferred') }
}

/** The 30-second check: a setup made outside Admin › Connected apps, the 30 days, members who left; and who gets the
 * admins' notices (someone no longer an owner or admin loses them, a new one gets those of the apps asked for now). */
export function serviceRequestsTick(ctx: AppContext) {
  try { settleServiceRequests(ctx) } catch { ctx.log.warn('app request check deferred') }
  syncServiceRequestNotices(ctx)
}
export function installServiceRequests(ctx: AppContext) {
  const timer = setInterval(() => serviceRequestsTick(ctx), CHECK_MS); timer.unref?.()
  ctx.onClose(() => clearInterval(timer))
}
