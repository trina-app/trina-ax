import type { InboxNotification, NotificationEventType, NotificationPreferences, ScheduleRunOutcome } from '@mycel/shared/api'
import { outcomeEvent, storedRunOutcome } from '../chat/schedule-outcome'
import type { AppContext } from '../context'
import { newId } from '../db'
import { HttpError } from '../http/errors'
import { decodeCursor, encodeCursor } from '../chat/store'
import { admins } from '../credentials/store'
import { canUseAi } from '../credentials/access'
import { isManaged } from '../app-config'
import { authorize } from '../policy/authorize'
import { atLeast } from '../policy/access'
import { readScope } from '../chat/read-scope'
import { getRow as getIntegration, mayUse as mayUseIntegration } from '../integrations/connections/store'
import { eventEnabled, getPreferences, savePreferences } from './preferences'
import { cancelPushUser, cancelDisabledPushDeliveries } from './push-events'
import { goalSkillTitle } from '../onboarding/goal-names'
import { GOAL_PEOPLE } from '@mycel/shared/api'

export const NOTIFICATION_RETENTION_MS = 30 * 86400_000
/** Source of a "scheduled tasks paused for review" notice: the person and the time of the pause (stable while some of
 * those tasks are confirmed or deleted; a turn or skip id never starts with it). */
const REVIEW_SOURCE = 'schedule-review-'
const reviewSource = (userId: string, since: string) => `${REVIEW_SOURCE}${userId}-${Date.parse(since) || 0}`
const services = new WeakMap<AppContext, Notifications>()
type Row = { id: string; user_id: string; event_type: NotificationEventType; source_id: string; created_at: string; read_at: string | null }
type Terminal = { id: string; user_id: string; status: string; ended_at: string; run_outcome: string | null }
export type SkillNoticeEvent = Extract<NotificationEventType, 'skill.suggested' | 'skill.reviewed'>
export type DevEnvNoticeEvent = Extract<NotificationEventType, 'dev_env.job' | 'dev_env.box'>
const isSkillEvent = (e: NotificationEventType): e is SkillNoticeEvent => e === 'skill.suggested' || e === 'skill.reviewed'
const isDevEnvEvent = (e: NotificationEventType): e is DevEnvNoticeEvent => e === 'dev_env.job' || e === 'dev_env.box'
const tableOf = (e: NotificationEventType) => isSkillEvent(e) ? 'skill_notices' : isDevEnvEvent(e) ? 'dev_env_notices' : e === 'integration.request' ? 'integration_request_notices' : e === 'onboarding.ai_request' ? 'onboarding_notices' : e === 'team.joined' ? 'team_join_notices' : e === 'onboarding.first_run' ? 'onboarding_goal_notices' : e === 'account.deletion_request' ? 'account_deletion_notices' : 'notification_inbox'
/** One inbox over the tables: skill notices (migration 211, R2-SKILL-12), dev environment notices (migration 219),
 * requests to connect a service (migration 220), a member's request for an AI connection (migration 231), joins
 * through the team invite link (migration 111), a member's first run of a team skill during the 7-day team goal
 * (migration 223) and a person's request to have their account deleted (migration 241) have their own tables, because
 * notification_inbox has a fixed event_type CHECK list and tables are never rebuilt. */
const NOTICE_TABLES = ['notification_inbox', 'skill_notices', 'dev_env_notices', 'integration_request_notices', 'onboarding_notices', 'team_join_notices', 'onboarding_goal_notices', 'account_deletion_notices'] as const
const INBOX = `(${NOTICE_TABLES.map((t) => `SELECT id,user_id,event_type,source_id,created_at,read_at,suppressed FROM ${t}`).join(' UNION ALL ')})`
export class Notifications {
  constructor(readonly ctx: AppContext) {}
  private active(userId: string) { return !!this.ctx.db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(userId) }
  private cutoff(now = Date.now()) { return new Date(now - NOTIFICATION_RETENTION_MS).toISOString() }
  private signal(userId: string) {
    // No content, title, filename, credential, or dynamic error text in WS/OS-facing metadata.
    try { this.ctx.services.realtime.publish(userId, { type: 'notice', data: { level: 'info', code: 'notifications.changed', message: '' } }) }
    catch { this.ctx.log.warn('notification refresh signal failed') }
  }
  /** `always`: shown in the app whatever the person's setting for the event (OS push still follows it). */
  private record(userId: string, event: NotificationEventType, sourceId: string, at: string, always = false) {
    if (!this.active(userId) || at < this.cutoff()) return
    const enabled = always || eventEnabled(this.preferences(userId), event)
    const r = this.ctx.db.query(`INSERT INTO ${tableOf(event)}(id,user_id,event_type,source_id,created_at,suppressed) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,event_type,source_id) DO NOTHING`)
      .run(newId(), userId, event, sourceId, at, enabled ? 0 : 1)
    if (r.changes && enabled) this.signal(userId)
  }
  /** A skill suggestion to review, or the review result of an own suggestion. The source is the suggestion id only. */
  skillNotice(userId: string, event: SkillNoticeEvent, suggestionId: string, createdAt = new Date().toISOString()) {
    this.record(userId, event, suggestionId, createdAt)
  }
  /** A dev environment job ended, or boxd stopped a box. The source is the id of the job or the stop row only. */
  devEnvNotice(userId: string, event: DevEnvNoticeEvent, sourceId: string, createdAt = new Date().toISOString()) {
    this.record(userId, event, sourceId, createdAt)
  }
  /** An admin asks this person to connect a service as their own connection. The source is the request id only. Shown
   * always: someone waits for the answer, and the request ends by itself after 7 days. */
  integrationRequest(userId: string, requestId: string, createdAt = new Date().toISOString()) {
    this.record(userId, 'integration.request', requestId, createdAt, true)
  }
  /** A member without AI asks this owner to connect one. The source is the member's id only; a second ask is a no-op
   * (UNIQUE row, migration 231). Shown always. */
  onboardingAiRequest(ownerId: string, memberId: string, createdAt = new Date().toISOString()) {
    // a settled or read row from an earlier ask is armed again (unread, new time) instead of being swallowed by the unique row
    const again = this.ctx.db.query("UPDATE onboarding_notices SET read_at=NULL, created_at=? WHERE user_id=? AND event_type='onboarding.ai_request' AND source_id=? AND read_at IS NOT NULL").run(createdAt, ownerId, memberId)
    if (again.changes) { if (this.active(ownerId)) this.signal(ownerId); return }
    this.record(ownerId, 'onboarding.ai_request', memberId, createdAt, true)
  }
  /** Is this member's ask still waiting (an unread row for any owner)? A settled or read one is not: they can ask again. */
  aiRequested(memberId: string): boolean {
    return !!this.ctx.db.query("SELECT 1 FROM onboarding_notices WHERE event_type='onboarding.ai_request' AND source_id=? AND read_at IS NULL AND created_at>=? LIMIT 1").get(memberId, this.cutoff())
  }
  /** A request whose member can use AI now (or is gone) counts as read: the owner is not left with something done. */
  settleAiRequests(userId?: string) {
    if (!isManaged(this.ctx.config)) return
    const rows = this.ctx.db.query(`SELECT id, user_id, source_id FROM onboarding_notices WHERE read_at IS NULL ${userId ? 'AND user_id=?' : ''}`).all(...(userId ? [userId] : [])) as { id: string; user_id: string; source_id: string }[]
    const now = new Date().toISOString(), touched = new Set<string>()
    for (const r of rows) {
      const m = this.ctx.db.query("SELECT id, role FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(r.source_id) as { id: string; role: string } | null
      if (m && !canUseAi(this.ctx, m)) continue
      this.ctx.db.query('UPDATE onboarding_notices SET read_at=? WHERE id=? AND read_at IS NULL').run(now, r.id)
      touched.add(r.user_id)
    }
    for (const u of touched) this.signal(u)
  }
  /** Someone joined through the team invite link (auth/team-links.ts): told to the owners and the link's maker. The
   * source is the new account's id only. Shown always: there is no setting for it, and a join is rare. */
  teamJoined(userId: string, joinedUserId: string, createdAt = new Date().toISOString()) {
    this.record(userId, 'team.joined', joinedUserId, createdAt, true)
  }
  /** A person asks this owner to delete their account (auth/deletion-requests.ts). The source is the person's id only;
   * one row per owner and person (UNIQUE, migration 241): asking again after a cancel re-arms it (unread, new time)
   * instead of adding one, so asking and cancelling over and over never fills the inbox. Shown always: there is no
   * setting for it, and someone waits for the owner. Never the owner's own request. */
  deletionRequest(ownerId: string, requesterId: string, createdAt = new Date().toISOString()) {
    if (ownerId === requesterId) return
    const again = this.ctx.db.query("UPDATE account_deletion_notices SET read_at=NULL, created_at=?, suppressed=0 WHERE user_id=? AND event_type='account.deletion_request' AND source_id=? AND read_at IS NOT NULL").run(createdAt, ownerId, requesterId)
    if (again.changes) { if (this.active(ownerId)) this.signal(ownerId); return }
    this.record(ownerId, 'account.deletion_request', requesterId, createdAt, true)
  }
  /** A request that no longer waits (taken back, or the account was deleted): its entries count as read, so no owner is
   * left with something to do that is gone. The entry stays and says what happened. */
  settleDeletionRequests(requesterId: string) {
    const rows = this.ctx.db.query("UPDATE account_deletion_notices SET read_at=? WHERE source_id=? AND read_at IS NULL RETURNING user_id").all(new Date().toISOString(), requesterId) as { user_id: string }[]
    for (const u of new Set(rows.map((r) => r.user_id))) if (this.active(u)) this.signal(u)
  }
  /** Every owner has the entry of every open request: an owner made after the request (owner transfer) gets it too,
   * and a request still open after the 30 days of the inbox comes back as a new entry. A person who became the owner
   * since is left out (the owner cannot ask). */
  private openDeletionRequests() {
    const db = this.ctx.db
    const open = db.query(`SELECT r.user_id FROM account_deletion_requests r JOIN users u ON u.id=r.user_id
      WHERE r.cancelled_at IS NULL AND r.handled_at IS NULL AND u.deleted_at IS NULL AND u.role != 'owner'`).all() as { user_id: string }[]
    if (!open.length) return
    const owners = db.query("SELECT id FROM users WHERE role='owner' AND status='active' AND deleted_at IS NULL").all() as { id: string }[]
    const now = new Date().toISOString()
    for (const r of open) for (const o of owners) {
      if (!db.query("SELECT 1 FROM account_deletion_notices WHERE user_id=? AND event_type='account.deletion_request' AND source_id=?").get(o.id, r.user_id)) this.record(o.id, 'account.deletion_request', r.user_id, now, true)
    }
  }
  /** During the 7-day team goal (onboarding/goal.ts noteGoalRun): a member ran a team skill for the first time. The
   * source is the turn of that run; the member, the skill's path and how many people had run it then are kept for the
   * text. Once per owner, member and skill (UNIQUE row, migration 223). Shown always: there is no setting for it, and
   * it only happens in a new team's first week. */
  goalFirstRun(ownerId: string, o: { turnId: string; memberId: string; skillPath: string; runners: number }, createdAt = new Date().toISOString()) {
    if (!this.active(ownerId) || createdAt < this.cutoff()) return
    const r = this.ctx.db.query(`INSERT INTO onboarding_goal_notices(id,user_id,event_type,source_id,member_id,skill_path,runners,created_at,suppressed)
      VALUES(?,?,'onboarding.first_run',?,?,?,?,?,0) ON CONFLICT DO NOTHING`).run(newId(), ownerId, o.turnId, o.memberId, o.skillPath, o.runners, createdAt)
    if (r.changes) this.signal(ownerId)
  }
  /** A request that no longer waits (connected, declined, withdrawn, expired): its inbox entry counts as read, so the
   * member is not left with something to do that is gone. Expiry is caught by reconcile's tick. */
  settleIntegrationRequests(userId?: string) {
    const now = new Date().toISOString()
    const rows = this.ctx.db.query(`UPDATE integration_request_notices SET read_at=? WHERE read_at IS NULL ${userId ? 'AND user_id=?' : ''}
      AND NOT EXISTS(SELECT 1 FROM integration_requests q WHERE q.id=integration_request_notices.source_id AND q.state='pending' AND q.expires_at>?) RETURNING user_id`)
      .all(...(userId ? [now, userId, now] : [now, now])) as { user_id: string }[]
    for (const u of new Set(rows.map((r) => r.user_id))) this.signal(u)
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
    for (const table of NOTICE_TABLES) db.query(`DELETE FROM ${table} WHERE created_at < ?`).run(this.cutoff())
    this.settleIntegrationRequests(userId)
    this.settleAiRequests(userId)
    if (!userId) this.openDeletionRequests()
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
    // scheduled tasks nobody confirmed, paused for their owner's review (chat/schedules.ts): one notice per person and
    // pause, shown in the app always (the task stopped running), pushed per the "scheduled task failed" setting
    const reviews = db.query(`SELECT s.user_id, s.review_since FROM schedules s
      WHERE s.review_since IS NOT NULL AND s.review_since >= ? AND s.template_id IS NULL AND s.confirmed_at IS NULL
      AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL) ${userId ? 'AND s.user_id=?' : ''}
      GROUP BY s.user_id, s.review_since ORDER BY s.review_since LIMIT 500`).all(...(userId ? [this.cutoff(), userId] : [this.cutoff()])) as { user_id: string; review_since: string }[]
    for (const row of reviews) this.record(row.user_id, 'schedule.failure', reviewSource(row.user_id, row.review_since), row.review_since, true)
    return Math.max(rows.length, skips.length, reviews.length)
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
  /** The job's text and the chat link only while the person can read the project folder now, as for a scheduled run. A
   * stop notice has no log, and an admin must act on it, so an admin gets the project and the reason with no folder check;
   * the link stays out, because that person cannot open the project. */
  private devEnvOut(row: Row): InboxNotification {
    const base = { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null }
    const db = this.ctx.db
    const job = row.event_type === 'dev_env.job' ? db.query('SELECT project_id,name,chat_id,exit_code,end_note,log_tail FROM dev_env_jobs WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { project_id: string; name: string; chat_id: string | null; exit_code: number | null; end_note: string; log_tail: string } | null : null
    if (row.event_type === 'dev_env.job' && !job) return this.devEnvRunOut(row, base)
    const stop = row.event_type === 'dev_env.box' ? db.query('SELECT project_id,code FROM dev_env_stops WHERE id=?').get(row.source_id) as { project_id: string; code: string } | null : null
    const projectId = job?.project_id ?? stop?.project_id
    const project = projectId ? db.query('SELECT name,folder_path,trashed_with FROM projects WHERE id=?').get(projectId) as { name: string; folder_path: string; trashed_with: string | null } | null : null
    if (!project) return base
    const devEnv = { projectId: projectId!, projectName: project.name }
    try {
      // a project whose folder is in the trash is the admins' and the owner's (chat/projects.ts canSeeProject)
      if (project.trashed_with !== null && !admins(db).includes(row.user_id)) throw new Error('project folder in the trash')
      authorize(this.ctx.files.fx, this.ctx.files.rules(), this.ctx.files.principal(row.user_id), project.folder_path, 'read')
    } catch {
      return stop && admins(db).includes(row.user_id) ? { ...base, devEnv: { ...devEnv, stopCode: stop.code } } : base
    }
    if (stop) return { ...base, link: 'project', devEnv: { ...devEnv, stopCode: stop.code } }
    const chat = job!.chat_id ? db.query('SELECT id FROM chats WHERE id=? AND user_id=? AND deleted_at IS NULL').get(job!.chat_id, row.user_id) as { id: string } | null : null
    return { ...base, chatId: chat?.id ?? null, link: chat ? 'chat' : 'project', devEnv: { ...devEnv, job: { name: job!.name, exitCode: job!.exit_code, note: job!.end_note, tail: job!.log_tail } } }
  }
  /** A job of the srt runner (dev_env_runs): the person's own run, from any chat, with or without a project. With a
   * project it is shown while the person can see the project; with none, projectId and projectName are ''. */
  private devEnvRunOut(row: Row, base: InboxNotification): InboxNotification {
    const db = this.ctx.db
    const run = db.query('SELECT project_id,name,chat_id,exit_code,end_note,log_tail,end_reason FROM dev_env_runs WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { project_id: string | null; name: string; chat_id: string | null; exit_code: number | null; end_note: string; log_tail: string; end_reason: string } | null
    if (!run) return base
    const project = run.project_id ? db.query('SELECT name,folder_path,trashed_with FROM projects WHERE id=?').get(run.project_id) as { name: string; folder_path: string; trashed_with: string | null } | null : null
    if (project) {
      try {
        if (project.trashed_with !== null && !admins(db).includes(row.user_id)) throw new Error('project folder in the trash')
        authorize(this.ctx.files.fx, this.ctx.files.rules(), this.ctx.files.principal(row.user_id), project.folder_path, 'read')
      } catch { return base }
    }
    const chat = run.chat_id ? db.query('SELECT id FROM chats WHERE id=? AND user_id=? AND deleted_at IS NULL').get(run.chat_id, row.user_id) as { id: string } | null : null
    const job = { name: run.name, exitCode: run.exit_code, note: run.end_note, tail: run.log_tail, ...(run.end_reason && run.end_reason !== 'exit' ? { reason: run.end_reason } : {}) }
    return { ...base, chatId: chat?.id ?? null, link: chat ? 'chat' : project ? 'project' : null, devEnv: { projectId: project ? run.project_id! : '', projectName: project?.name ?? '', job } }
  }
  private out(row: Row): InboxNotification {
    let chatId: string | null = null, outcome: ScheduleRunOutcome | null = null
    if (isSkillEvent(row.event_type)) {
      // The Skills screen checks access again when it opens the suggestion (?review= only when the viewer may review).
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: 'skills', outcome: null }
    }
    if (isDevEnvEvent(row.event_type)) return this.devEnvOut(row)
    // Settings › External services opens the request (?request=<sourceId>) and says if it is no longer waiting. The
    // service's name with the host of its address (where the member's key would go), while the request is there.
    if (row.event_type === 'integration.request') {
      const q = this.ctx.db.query('SELECT name, url FROM integration_requests WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { name: string; url: string } | null
      let host = ''
      try { host = q ? new URL(q.url).host : '' } catch {}
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: 'integrations', outcome: null,
        ...(q && host ? { request: { name: q.name, host } } : {}) }
    }
    // the owner sees who asks (a name, nothing else) and goes to Admin › AI connections
    if (row.event_type === 'onboarding.ai_request') {
      const m = this.ctx.db.query("SELECT name FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(row.source_id) as { name: string } | null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: 'admin_credentials', outcome: null, ...(m ? { requester: { name: m.name } } : {}) }
    }
    // the name of who joined, while the account is there (a deleted one keeps the entry without a name)
    if (row.event_type === 'team.joined') {
      const u = this.ctx.db.query('SELECT name FROM users WHERE id=? AND deleted_at IS NULL').get(row.source_id) as { name: string } | null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null,
        ...(u ? { joined: { name: u.name } } : {}) }
    }
    // the owner sees who asks (a name while the account is there) and where the request is now; while it waits, the
    // link opens that person in Admin › Members, where the owner deletes the account
    if (row.event_type === 'account.deletion_request') {
      const u = this.ctx.db.query('SELECT name FROM users WHERE id=? AND deleted_at IS NULL').get(row.source_id) as { name: string } | null
      const q = this.ctx.db.query('SELECT cancelled_at, handled_at FROM account_deletion_requests WHERE user_id=?').get(row.source_id) as { cancelled_at: string | null; handled_at: string | null } | null
      const state = !q ? null : q.handled_at || !u ? 'handled' as const : q.cancelled_at ? 'cancelled' as const : 'open' as const
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: state === 'open' ? 'admin_members' : null, outcome: null,
        ...(state ? { deletionRequest: { name: u?.name ?? null, state } } : {}) }
    }
    // who ran which skill first (a name while the account is there) and the count then; no link
    if (row.event_type === 'onboarding.first_run') {
      const n = this.ctx.db.query('SELECT member_id, skill_path, runners FROM onboarding_goal_notices WHERE id=?').get(row.id) as { member_id: string; skill_path: string; runners: number } | null
      const u = n ? this.ctx.db.query('SELECT name FROM users WHERE id=? AND deleted_at IS NULL').get(n.member_id) as { name: string } | null : null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null,
        ...(n ? { firstRun: { member: u?.name ?? null, skill: goalSkillTitle(this.ctx, row.user_id, n.skill_path), runners: n.runners, target: GOAL_PEOPLE } } : {}) }
    }
    if (row.event_type === 'schedule.failure' && row.source_id.startsWith(REVIEW_SOURCE)) {
      // paused tasks to check again: the schedules list, never a chat
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null, review: true }
    }
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
            const project = this.ctx.db.query('SELECT folder_path, trashed_with FROM projects WHERE id=?').get(chat.project_id) as { folder_path: string; trashed_with: string | null } | null
            if (!project) throw new Error('missing project')
            if (project.trashed_with !== null && p.role !== 'owner' && p.role !== 'admin') throw new Error('project folder in the trash')
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
    const rows = db.query(`SELECT * FROM ${INBOX} WHERE user_id=? AND suppressed=0 AND created_at>=?
      ${cur ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...(cur ? [userId, cutoff, cur.t!, cur.t!, cur.id!, limit + 1] : [userId, cutoff, limit + 1])) as Row[]
    const selected = rows.slice(0, limit), last = selected.at(-1)
    const { n } = db.query(`SELECT COUNT(*) n FROM ${INBOX} WHERE user_id=? AND suppressed=0 AND read_at IS NULL AND created_at>=?`).get(userId, cutoff) as { n: number }
    return { items: selected.map(r => this.out(r)), nextCursor: rows.length > limit && last ? encodeCursor({ t: last.created_at, id: last.id }) : null, unreadCount: n }
  }
  get(userId: string, id: string): InboxNotification {
    if (!this.active(userId)) throw new HttpError('not_found')
    const row = this.ctx.db.query(`SELECT * FROM ${INBOX} WHERE id=? AND user_id=? AND suppressed=0 AND created_at>=?`).get(id,userId,this.cutoff()) as Row | null
    if (!row) throw new HttpError('not_found')
    return this.out(row)
  }
  read(userId: string, id: string): InboxNotification {
    if (!this.active(userId)) throw new HttpError('not_found')
    const db = this.ctx.db
    const args = [new Date().toISOString(), id, userId, this.cutoff()]
    const update = (table: string) => db.query(`UPDATE ${table} SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=? AND suppressed=0 AND created_at>=? RETURNING *`).get(...args) as Row | null
    let r: Row | null = null
    for (const table of NOTICE_TABLES) if ((r = update(table))) break
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
export function notifySkillSuggestion(ctx: AppContext, userId: string, event: SkillNoticeEvent, suggestionId: string) {
  try { notificationsOf(ctx).skillNotice(userId, event, suggestionId) }
  catch { ctx.log.warn('skill notification recording failed') }
}
export function notifyDevEnv(ctx: AppContext, userId: string, event: DevEnvNoticeEvent, sourceId: string) {
  try { notificationsOf(ctx).devEnvNotice(userId, event, sourceId) }
  catch { ctx.log.warn('dev env notification recording failed') }
}
export function notifyIntegrationRequest(ctx: AppContext, userId: string, requestId: string) {
  try { notificationsOf(ctx).integrationRequest(userId, requestId) }
  catch { ctx.log.warn('connection request notification recording failed') }
}
export function notifyTeamJoined(ctx: AppContext, userIds: Iterable<string>, joinedUserId: string) {
  for (const userId of new Set(userIds)) {
    try { notificationsOf(ctx).teamJoined(userId, joinedUserId) }
    catch { ctx.log.warn('team join notification recording failed') }
  }
}
export function notifyDeletionRequest(ctx: AppContext, ownerIds: Iterable<string>, requesterId: string) {
  for (const ownerId of new Set(ownerIds)) {
    try { notificationsOf(ctx).deletionRequest(ownerId, requesterId) }
    catch { ctx.log.warn('account deletion request notification recording failed') }
  }
}
export function settleDeletionRequestNotices(ctx: AppContext, requesterId: string) {
  try { notificationsOf(ctx).settleDeletionRequests(requesterId) }
  catch { ctx.log.warn('account deletion request notice not marked read') }
}
export function settleIntegrationRequestNotice(ctx: AppContext, userId: string) {
  try { notificationsOf(ctx).settleIntegrationRequests(userId) }
  catch { ctx.log.warn('connection request notice not marked read') }
}
export function notifyConnectionReconnect(ctx: AppContext, userId: string, sourceId: string, createdAt?: string) {
  try { notificationsOf(ctx).connectionReconnect(userId, sourceId, createdAt) }
  catch { ctx.log.warn('connection notification recording deferred') }
}
