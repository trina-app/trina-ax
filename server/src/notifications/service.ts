import type { ActivityTab, InboxNotification, NotificationEventType, NotificationPreferences, ScheduleRunOutcome } from '@mycel/shared/api'
import { invitedPlace, placeName, placePeopleOf, roleSql } from '../auth/guests'
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
import { membersOnlyNow } from '../chat/projects'
import { readScope } from '../chat/read-scope'
import { getRow as getIntegration, mayUse as mayUseIntegration, templateCovers } from '../integrations/connections/store'
import { shareCovers, shareRow } from '../integrations/google-drive/shares'
import { eventEnabled, getPreferences, roomAlertsChanged, savePreferences } from './preferences'
import { cancelPushUser, cancelDisabledPushDeliveries } from './push-events'
import { goalSkillTitle } from '../onboarding/goal-names'
import { contributionOf } from '../skills/suggestions'
import { ROOM_ALERTS_CHANGED } from '../rooms/alerts'
import { roomAppLeaverOut, roomAppNoticeOut } from '../rooms/apps/notice'
import { roomNoticeOut, roomRowOf, roomRowOut, roomRows, type RoomRow } from '../rooms/inbox'
import { getUser } from '../auth/users'
import { teamDefaultLocale } from '../admin/settings'
import { activityTabHas, AI_NOT_READY_WINDOW_MS, GOAL_PEOPLE, MEMBER_WELCOME_DAYS, plainLabel } from '@mycel/shared/api'
import { handoverNoticeOut, isHandoverEvent, type HandoverEvent } from '../admin/handover-notices'
import { serviceRequestOut } from '../integrations/service-request-notices'
import { inPeopleAudience, isPeopleRow } from '../chat/chat-audience'
import { chatGoneAt } from '../chat/chat-lost'
import { redactorFor } from '../integrations/connections/redact'
import { FILE_SCAN_VERSION, storedKeyFilesOf } from '../integrations/connections/file-scan'
import { datedSql } from '../auth/deletion-requests'
import { REQUEST_SOURCE, parseRequestSource } from '../devenv/request-outcome'
import { CHAT_ANSWER_COALESCE_MS, CHAT_ANSWER_PUSH_DELAY_MS, CHAT_CARD_PUSH_DELAY_MS, chatOpenFor, type ChatAnswerKind } from './chat-answers'
import { fileSharesOf } from '../files/shares'
import { chatMessageLink } from '../chat/message-notices'
import { accessRequestsOf } from '../chat/access-requests'
import { CHAT_THREAD_PUSH_DELAY_MS, chatThreadNoticeOut, threadSummaries } from '../chat/threads'

/** At most this many template notices per 30-second backstop pass (security review 2, #1). */
const OFFER_BATCH = 500

export const NOTIFICATION_RETENTION_MS = 30 * 86400_000
/** Source of a "scheduled tasks paused for review" notice: the person and the time of the pause (stable while some of
 * those tasks are confirmed or deleted; a turn or skip id never starts with it). */
const REVIEW_SOURCE = 'schedule-review-'
const reviewSource = (userId: string, since: string) => `${REVIEW_SOURCE}${userId}-${Date.parse(since) || 0}`
/** Source of a "check the save folder again" notice: the task and the time its save permission lapsed (one notice per
 * lapse, chat/schedule-scope.ts markLapsed). */
const SAVE_LAPSE_SOURCE = 'schedule-save-'
const saveLapseSource = (scheduleId: string, at: string) => `${SAVE_LAPSE_SOURCE}${scheduleId}-${Date.parse(at) || 0}`
/** Source of a "tried to use Trina but it isn't set up yet" notice (Notifications.aiNotReady): never a user id. */
const NOT_READY_SOURCE = 'not-ready:'
const notReadySource = (memberId: string) => `${NOT_READY_SOURCE}${memberId}`
const services = new WeakMap<AppContext, Notifications>()
type Row = { id: string; user_id: string; event_type: NotificationEventType; source_id: string; created_at: string; read_at: string | null; sort_at?: string }
type Terminal = { id: string; user_id: string; status: string; ended_at: string; run_outcome: string | null }
export type SkillNoticeEvent = Extract<NotificationEventType, 'skill.suggested' | 'skill.reviewed'>
export type DevEnvNoticeEvent = Extract<NotificationEventType, 'dev_env.job' | 'dev_env.box'>
const isSkillEvent = (e: NotificationEventType): e is SkillNoticeEvent => e === 'skill.suggested' || e === 'skill.reviewed'
const isDevEnvEvent = (e: NotificationEventType): e is DevEnvNoticeEvent => e === 'dev_env.job' || e === 'dev_env.box'
export type RoomNoticeEvent = Extract<NotificationEventType, 'room.dm' | 'room.mention'>
const isRoomEvent = (e: NotificationEventType): e is RoomNoticeEvent => e === 'room.dm' || e === 'room.mention'
export type TemplateNoticeEvent = Extract<NotificationEventType, 'integration.template' | 'integration.template_reconnect'>
const isTemplateEvent = (e: NotificationEventType): e is TemplateNoticeEvent => e === 'integration.template' || e === 'integration.template_reconnect'
/** a reconnect notice's source: the template and the version its address, sign-in method or header changed to (one
 * notice per change, never one per member's dropped row) */
const reconnectSource = (templateId: string, version: number) => `${templateId}.v${version}`
/** A member a template no longer covers lost their connection made from it (QA TC-2980): the reconnect notice's table and
 * event type (so no new CHECK value), its own source: the template id and the connection that went */
const leftSource = (templateId: string, connectionId: string) => `${templateId}.left.${connectionId}`
const LEFT_SOURCE = /\.left\.[^.]+$/
/** the template id of a template notice's source (reconnectSource, leftSource, or the bare id) */
const templateOfSource = (sourceId: string) => sourceId.replace(LEFT_SOURCE, '').replace(/\.v\d+$/, '')
export type ServiceRequestEvent = Extract<NotificationEventType, 'service.request' | 'service.ready'>
const isServiceRequestEvent = (e: NotificationEventType): e is ServiceRequestEvent => e === 'service.request' || e === 'service.ready'
export type HostingNoticeEvent = Extract<NotificationEventType, 'hosting.key_copied' | 'hosting.exported' | 'relay.address_moved'>
const isHostingEvent = (e: NotificationEventType): e is HostingNoticeEvent => e === 'hosting.key_copied' || e === 'hosting.exported' || e === 'relay.address_moved'
export type FileShareEvent = Extract<NotificationEventType, 'file.shared' | 'file.access_requested' | 'file.access_answered' | 'file.unshared_by_move'>
const isFileShareEvent = (e: NotificationEventType): e is FileShareEvent => e === 'file.shared' || e === 'file.access_requested' || e === 'file.access_answered' || e === 'file.unshared_by_move'
export type AccessRequestEvent = Extract<NotificationEventType, 'access.requested' | 'access.answered'>
const isAccessRequestEvent = (e: NotificationEventType): e is AccessRequestEvent => e === 'access.requested' || e === 'access.answered'
/** A re-share within this long of a share still unread updates that notice in place (chatShared): no second push. */
const SHARE_AGAIN_QUIET_MS = 10 * 60_000
const tableOf = (e: NotificationEventType) => e === 'chat.answer_done' ? 'chat_answer_notices' : isSkillEvent(e) ? 'skill_notices' : isDevEnvEvent(e) ? 'dev_env_notices' : e === 'integration.request' ? 'integration_request_notices' : e === 'onboarding.ai_request' ? 'onboarding_notices' : e === 'team.joined' ? 'team_join_notices' : e === 'onboarding.first_run' ? 'onboarding_goal_notices' : isRoomEvent(e) ? 'room_notices' : e === 'account.deletion_request' ? 'account_deletion_notices' : e === 'account.deletion_due' ? 'account_deletion_due_notices' : isTemplateEvent(e) ? 'integration_template_notices' : e === 'drive.share_reconnect' ? 'drive_share_notices' : e === 'skills.merge_waiting' ? 'skill_merge_notices' : e === 'credential.change' ? 'credential_change_notices' : isHandoverEvent(e) ? 'handover_notices' : e === 'project.joined' ? 'project_notices' : e === 'chat.shared' ? 'chat_share_notices' : e === 'service.closed' ? 'service_request_closed_notices' : e === 'files.stored_key' ? 'stored_key_file_notices' : isServiceRequestEvent(e) ? 'service_request_notices' : e === 'account.reset_link' ? 'reset_link_notices' : isHostingEvent(e) ? 'hosting_notices' : e === 'engine.start_failed' ? 'engine_start_notices' : e === 'storage.filling' || e === 'storage.cleanup' ? 'storage_notices' : e === 'room_app.paused' ? 'room_app_notices' : e === 'room_app.leaver' ? 'room_app_leaver_notices' : isFileShareEvent(e) ? 'file_share_notices' : isAccessRequestEvent(e) ? 'access_request_notices' : e === 'chat.thread_reply' ? 'chat_thread_notices' : e === 'chat.lost' ? 'chat_lost_notices' : 'notification_inbox'
/** One inbox over the tables: skill notices (migration 211, R2-SKILL-12), dev environment notices (migration 219),
 * requests to connect a service (migration 220), a member's request for an AI connection (migration 231), joins
 * through the team invite link (migration 111), a member's first run of a team skill during the 7-day team goal
 * (migration 223), room notices (a DM message or an @mention, migration 241), a person's request to have their
 * account deleted (migration 244), connection templates to connect or reconnect (migration 334) and, for admins, a
 * Drive shared with the team that needs a new sign-in (migration 337) and, for the owner at the end of the welcome
 * steps, the skills to merge that waited for it (migration 253), and the handover's (a join with the owner's lead link,
 * a transfer, a locked password check: migration 270), someone who started to see a team project (migration 284) and
 * a member's ask to add an app with its answer (migration 343), a password reset link made for the person (migration 119)
 * and the hosting service's copies of the team's key or data, or the team address moved away (migration 120), the AI
 * that could not start on this server (migration 127), the team's disk filling up (migration 702), and an
 * app in a room that paused for the day (migration 299) and someone who left who still knows an app's address (migration 352)
 * have their own tables, because notification_inbox has a fixed event_type CHECK list and tables are never rebuilt. */
const NOTICE_TABLES = ['notification_inbox', 'skill_notices', 'dev_env_notices', 'integration_request_notices', 'onboarding_notices', 'team_join_notices', 'onboarding_goal_notices', 'room_notices', 'account_deletion_notices', 'account_deletion_due_notices', 'integration_template_notices', 'drive_share_notices', 'skill_merge_notices', 'credential_change_notices', 'handover_notices', 'project_notices', 'service_request_notices', 'service_request_closed_notices', 'stored_key_file_notices', 'reset_link_notices', 'hosting_notices', 'engine_start_notices', 'storage_notices', 'room_app_notices', 'room_app_leaver_notices', 'chat_answer_notices', 'chat_share_notices', 'file_share_notices', 'chat_thread_notices', 'access_request_notices', 'chat_lost_notices'] as const
const union = (tables: readonly string[]) => `(${tables.map((t) => `SELECT id,user_id,event_type,source_id,created_at,read_at,suppressed FROM ${t}`).join(' UNION ALL ')})`
/** A person's message in a chat shared with people (chat_message_notices, migration 436; chat/message-notices.ts): read
 * by id (what a push opens) like every notice, never listed, counted or marked read in Activity: the chat row's number
 * shows it and reading the chat reads it. */
const PUSH_ONLY_TABLES = ['chat_message_notices'] as const
const INBOX = union([...NOTICE_TABLES, ...PUSH_ONLY_TABLES])
/** What the Inbox lists and counts besides the rooms' notices, newest first: every other notice. The rooms' notices
 * make rows of their own (rooms/inbox.ts roomRows: mentions and replies in threads I follow, one row per place; from
 * 2026-11-05 to then none were listed, docs/DECISIONS.md "알림함의 대화 알림"), merged into the same order by `sort_at`. */
/** An AI chat's answer (chat_answer_notices) is pushed only: the chat list's markers show those chats, so the Inbox
 * neither lists nor counts it (docs/DECISIONS.md "AI 답변 알림"). */
/** A row of LISTED that is a reply in a thread under a shared chat's answer (chat_thread_notices): a conversation row,
 * listed and counted with the rooms' rows on 대화's 멘션·스레드, not with the app's own notices on 활동 (rooms do the same
 * with their mentions and thread replies). */
const CHAT_THREAD_ROW = "event_type='chat.thread_reply'"
const LISTED = `(${NOTICE_TABLES.filter((t) => t !== 'room_notices' && t !== 'chat_answer_notices').map((t) => `SELECT id,user_id,event_type,source_id,created_at,read_at,suppressed,created_at AS sort_at FROM ${t}`).join(' UNION ALL ')})`
/** A notice (alias `n`) whose phone push was cancelled (notifications/away.ts: the person was at Trina; or it was read
 * or no longer wanted) does not hold the next one of its run back: the next message makes a new notice, decided afresh,
 * so one cancelled push never silences the phone for the rest of an unread run (docs/DECISIONS.md "Phone notifications
 * when I'm away"). */
const NOT_SKIPPED = (deliveries: string) => `NOT EXISTS(SELECT 1 FROM ${deliveries} d JOIN push_subscriptions s ON s.id=d.subscription_id AND s.kind='native' WHERE d.notification_id=n.id AND d.state='cancelled')`

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
  /** True: a new row (the same source again adds none). */
  private record(userId: string, event: NotificationEventType, sourceId: string, at: string, always = false): boolean {
    if (!this.active(userId) || at < this.cutoff()) return false
    const enabled = always || eventEnabled(this.preferences(userId), event)
    const r = this.ctx.db.query(`INSERT INTO ${tableOf(event)}(id,user_id,event_type,source_id,created_at,suppressed) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,event_type,source_id) DO NOTHING`)
      .run(newId(), userId, event, sourceId, at, enabled ? 0 : 1)
    if (r.changes && enabled) this.signal(userId)
    return r.changes > 0
  }
  /** Something changed in this person's Inbox that the app should read again (chat/threads.ts: a thread read, a
   * notice gone with its reply). Metadata only. */
  changed(userId: string) { this.signal(userId) }
  /** A reply in a thread I follow under an AI answer of a shared chat (chat/threads.ts sendReply; the caller checked that
   * I still see the thread). One unread notice per thread: while one is open, a new reply updates it in place (the
   * newest replier and reply; its time and push stay those of the first), so a burst of replies is one row and one
   * push; once read, the next reply makes a new one. Shown always; the push waits CHAT_THREAD_PUSH_DELAY_MS and follows
   * "Replies in threads I'm part of" (chat/threads.ts chatThreadWanted). */
  chatThreadReply(userId: string, o: { chatId: string; rootId: string; replyId: string; by: string; mention?: boolean }, at = new Date().toISOString()): 'new' | 'mention' | 'updated' | null {
    if (!this.active(userId)) return null
    // what this reply changed, for the desktop app's one notification per unread run (chat/threads.ts sendReply): a new
    // notice, a first mention in one still open, or only the newest reply of one already told
    const open = this.ctx.db.query('SELECT mention_id FROM chat_thread_notices WHERE user_id=? AND source_id=? AND read_at IS NULL').get(userId, o.rootId) as { mention_id: string | null } | null
    // `mention`: this reply mentions them (docs/decisions/20261118-chat-thread-mentions.md): the notice keeps its FIRST
    // mention (mention_id), the start of the replies the Inbox looks through for one that still mentions them
    // (chat/threads.ts mentionerOf), so a deleted mention falls back to another one still there
    const mention = o.mention ? o.replyId : null
    const up = this.ctx.db.query('UPDATE chat_thread_notices SET by_user=?, reply_id=?, mention_id=COALESCE(mention_id, ?) WHERE user_id=? AND source_id=? AND read_at IS NULL').run(o.by, o.replyId, mention, userId, o.rootId)
    // the first mention in a notice still open (made by a plain reply, which rang nothing while "Replies in threads I'm
    // part of" is off, its default): pushed now as a new one, as a room's mention is: its finished deliveries go and it
    // is dated now (the queue takes notices of the last day only), its wait starting again
    if (up.changes && mention && open && !open.mention_id) {
      this.ctx.db.query(`DELETE FROM chat_thread_push_deliveries WHERE state IN ('sent','failed','cancelled') AND notification_id IN
        (SELECT id FROM chat_thread_notices WHERE user_id=? AND source_id=? AND read_at IS NULL)`).run(userId, o.rootId)
      this.ctx.db.query('UPDATE chat_thread_notices SET created_at=?, push_at=? WHERE user_id=? AND source_id=? AND read_at IS NULL').run(at, new Date(Date.parse(at) + CHAT_THREAD_PUSH_DELAY_MS).toISOString(), userId, o.rootId)
    }
    if (!up.changes) this.ctx.db.query(`INSERT INTO chat_thread_notices(id,user_id,event_type,source_id,chat_id,by_user,reply_id,created_at,push_at,suppressed,mention_id)
      VALUES(?,?,'chat.thread_reply',?,?,?,?,?,?,0,?)`).run(newId(), userId, o.rootId, o.chatId, o.by, o.replyId, at, new Date(Date.parse(at) + CHAT_THREAD_PUSH_DELAY_MS).toISOString(), mention)
    this.signal(userId)
    return !up.changes || !open ? 'new' : mention && !open.mention_id ? 'mention' : 'updated'
  }
  /** A file shared with me, an access request to answer, a decline of mine, or my file's grants removed by someone
   * else's move (files/shares.ts; docs/DECISIONS.md "A member shares their own files"). Activity only, shown always.
   * `rearm`: the same source again brings its row back up as unread (a new request, a share again after a removal).
   * `named`: a file shared with the person by name (not through a group or the whole team): that notice is also pushed
   * (push-service.ts, files/share-push.ts; migration 356), as a request to open a file is (named or not). Several files in one press are one notice (source 'b:<id>'). */
  fileShareNotice(userId: string, event: FileShareEvent, sourceId: string, rearm: boolean, named = false) {
    if (!this.active(userId)) return
    const at = new Date().toISOString()
    const r = this.ctx.db.query('INSERT INTO file_share_notices(id,user_id,event_type,source_id,created_at,suppressed,named) VALUES(?,?,?,?,?,0,?) ON CONFLICT(user_id,event_type,source_id) DO ' + (rearm ? 'UPDATE SET created_at = excluded.created_at, read_at = NULL, named = MAX(named, excluded.named)' : 'NOTHING'))
      .run(newId(), userId, event, sourceId, at, named ? 1 : 0)
    // a new request to open the same file (the last one answered or closed: request() makes no second waiting one) is
    // pushed again: the finished deliveries of the row's earlier request go, so the next round queues it anew. Bounded
    // by the request limits (files/shares.ts: one waiting per file and asker, 5 a day per owner, 20 an hour per asker)
    if (r.changes && rearm && event === 'file.access_requested') this.ctx.db.query(`DELETE FROM file_share_push_deliveries WHERE state IN ('sent','failed','cancelled')
      AND notification_id = (SELECT id FROM file_share_notices WHERE user_id = ? AND event_type = ? AND source_id = ?)`).run(userId, event, sourceId)
    if (r.changes) this.signal(userId)
  }
  /** Someone asks to open a chat or project the person answers for, or the answer to the person's own ask
   * (chat/access-requests.ts; migration 411). Activity only, shown always; `rearm`: a new ask brings the row back up
   * unread, and its finished pushes go so the next round pushes it again (as a file request's). */
  accessRequestNotice(userId: string, event: AccessRequestEvent, sourceId: string, rearm: boolean) {
    if (!this.active(userId)) return
    const r = this.ctx.db.query('INSERT INTO access_request_notices(id,user_id,event_type,source_id,created_at,suppressed) VALUES(?,?,?,?,?,0) ON CONFLICT(user_id,event_type,source_id) DO ' + (rearm ? 'UPDATE SET created_at = excluded.created_at, read_at = NULL' : 'NOTHING'))
      .run(newId(), userId, event, sourceId, new Date().toISOString())
    if (r.changes && rearm && event === 'access.requested') this.ctx.db.query(`DELETE FROM access_request_push_deliveries WHERE state IN ('sent','failed','cancelled')
      AND notification_id = (SELECT id FROM access_request_notices WHERE user_id = ? AND event_type = ? AND source_id = ?)`).run(userId, event, sourceId)
    if (r.changes) this.signal(userId)
  }
  /** A skill suggestion to review, or the review result of an own suggestion. The source is the suggestion id only. */
  skillNotice(userId: string, event: SkillNoticeEvent, suggestionId: string, createdAt = new Date().toISOString()) {
    this.record(userId, event, suggestionId, createdAt)
  }
  /** A DM message, an @mention or a reply in a followed thread in a room (rooms/service.ts notify). The source is the
   * message id only, never its text. Every message that alerts the person is a notice of its own and so a push of its
   * own, as in Slack and KakaoTalk (docs/decisions/20261120-push-every-message.md: before, a burst of messages or
   * mentions was one notice and one push, and the phone stayed silent for the rest); the iPhone groups them under the
   * room (the notification's thread). Reading the room, or the thread, marks them read; the Inbox makes one row of a
   * place's unread notices (rooms/inbox.ts). Whether there is a notice at all is the room's level for the person
   * (Rooms.notify). `quiet`: made inside their quiet hours (docs/DECISIONS.md "대화방 알림 설정"): kept, never pushed
   * (room_notices.quiet), one per unread run (any unread notice of the place holds the next quiet one back, which is
   * recorded as the newest of its run: `seq`; last_seq / last_at, so the Inbox's row sits where the run ends); it never
   * holds back a notice made once the quiet hours are over (that one pushes). True when a notice that may ring was
   * recorded now (not a quiet one): the room.message to the person says so, and the desktop app tells the same ones
   * (docs/DECISIONS.md "Session markers"). `run`: an app's message (rooms/apps; an app may post a burst of 30, then one a
   * second) stays one per unread run as before, as a quiet one does, so an app cannot ring a phone 30 times in a row or
   * run into the gateway's 20 a minute per device (review of #108, finding 2); only an unread notice that may ring holds
   * it back. */
  roomNotice(userId: string, event: RoomNoticeEvent, messageId: string, roomId: string, at = new Date().toISOString(), threadRootId: string | null = null, quiet = false, seq?: number, run = false): boolean {
    if (!this.active(userId) || at < this.cutoff()) return false
    const open = quiet || run ? this.ctx.db.query(`SELECT n.id FROM room_notices n JOIN room_messages m ON m.id=n.source_id WHERE n.user_id=? AND n.room_id=? AND n.event_type=? AND n.read_at IS NULL AND n.suppressed=0 AND n.created_at>=?
      AND m.thread_root_id IS ? AND (n.quiet=0 OR ?=1) AND ${NOT_SKIPPED('room_push_deliveries')} ORDER BY n.created_at DESC, n.id DESC LIMIT 1`).get(userId, roomId, event, this.cutoff(), threadRootId, quiet ? 1 : 0) as { id: string } | null : null
    if (open) {
      // only for the kinds the Inbox lists (a mention, a reply: rooms/inbox.ts; a DM's message is no row). No signal: the
      // Inbox's count is the same, and an open Inbox reads its rows again as the rooms change
      if (seq !== undefined && (event === 'room.mention' || threadRootId !== null)) this.ctx.db.query('UPDATE room_notices SET last_seq=?, last_at=? WHERE id=? AND COALESCE(last_seq, 0) < ?').run(seq, at, open.id, seq)
      return false
    }
    const r = this.ctx.db.query('INSERT INTO room_notices(id,user_id,event_type,source_id,room_id,created_at,suppressed,quiet) VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(user_id,event_type,source_id) DO NOTHING')
      .run(newId(), userId, event, messageId, roomId, at, quiet ? 1 : 0)
    if (r.changes) this.signal(userId)
    return r.changes > 0 && !quiet
  }
  /** A dev environment job ended. The source is the id of the run row only. */
  devEnvNotice(userId: string, event: DevEnvNoticeEvent, sourceId: string, createdAt = new Date().toISOString()): boolean {
    return this.record(userId, event, sourceId, createdAt)
  }
  /** An admin asks this person to connect a service as their own connection. The source is the request id only. Shown
   * always: someone waits for the answer, and the request ends by itself after 7 days. */
  integrationRequest(userId: string, requestId: string, createdAt = new Date().toISOString()) {
    this.record(userId, 'integration.request', requestId, createdAt, true)
  }
  /** A member without AI asks this owner or admin to connect one. The source is the member's id only; a second ask is a no-op
   * (UNIQUE row, migration 231). Shown always. */
  onboardingAiRequest(ownerId: string, memberId: string, createdAt = new Date().toISOString()) {
    // a settled or read row from an earlier ask is armed again (unread, new time) instead of being swallowed by the unique row
    const again = this.ctx.db.query("UPDATE onboarding_notices SET read_at=NULL, created_at=? WHERE user_id=? AND event_type='onboarding.ai_request' AND source_id=? AND read_at IS NOT NULL").run(createdAt, ownerId, memberId)
    if (again.changes) { if (this.active(ownerId)) this.signal(ownerId); return }
    this.record(ownerId, 'onboarding.ai_request', memberId, createdAt, true)
  }
  /** "<name> tried to use Trina but it isn't set up yet" (the AI could not start: chat error engine_missing): one
   * notice per owner and admin, at most once per member in AI_NOT_READY_WINDOW_MS. It shares the inbox table of the
   * member's ask for an AI connection (the event type's CHECK list is fixed, and the same page fixes both) under a
   * source of its own (`not-ready:<member id>`), so that ask and its "알렸어요" are untouched; it is never settled (the
   * server cannot tell when it is fixed). True: told now; false: told within the window, nothing sent. */
  aiNotReady(memberId: string, now = new Date()): boolean {
    if (this.aiNotReadyTold(memberId, now)) return false
    const source = notReadySource(memberId), at = now.toISOString()
    for (const id of admins(this.ctx.db)) {
      if (id === memberId) continue
      // an earlier notice (read or not) comes back unread at the top instead of a second row
      const again = this.ctx.db.query("UPDATE onboarding_notices SET read_at=NULL, created_at=?, suppressed=0 WHERE user_id=? AND event_type='onboarding.ai_request' AND source_id=?").run(at, id, source)
      if (again.changes) { if (this.active(id)) this.signal(id); continue }
      this.record(id, 'onboarding.ai_request', source, at, true)
    }
    return true
  }
  /** Did this member tell the owner(s) and admins that Trina isn't ready within AI_NOT_READY_WINDOW_MS (the limit of
   * aiNotReady, the same rows)? Their [Tell an admin] then reads "Told" after a reload too (GET /api/me/ai-access
   * notReadyTold; owner decision 2026-11-12). */
  aiNotReadyTold(memberId: string, now = new Date()): boolean {
    const since = new Date(now.getTime() - AI_NOT_READY_WINDOW_MS).toISOString()
    return !!this.ctx.db.query("SELECT 1 FROM onboarding_notices WHERE event_type='onboarding.ai_request' AND source_id=? AND created_at>? LIMIT 1").get(notReadySource(memberId), since)
  }
  /** Is this member's ask still waiting (an unread row for any owner)? A settled or read one is not: they can ask again. */
  aiRequested(memberId: string): boolean {
    return !!this.ctx.db.query("SELECT 1 FROM onboarding_notices WHERE event_type='onboarding.ai_request' AND source_id=? AND read_at IS NULL AND created_at>=? LIMIT 1").get(memberId, this.cutoff())
  }
  /** A request whose member can use AI now (or is gone) counts as read: the owner is not left with something done. */
  settleAiRequests(userId?: string) {
    if (!isManaged(this.ctx.config)) return
    const rows = this.ctx.db.query(`SELECT id, user_id, source_id FROM onboarding_notices WHERE read_at IS NULL AND substr(source_id, 1, ${NOT_READY_SOURCE.length}) != '${NOT_READY_SOURCE}' ${userId ? 'AND user_id=?' : ''}`).all(...(userId ? [userId] : [])) as { id: string; user_id: string; source_id: string }[]
    const now = new Date().toISOString(), touched = new Set<string>()
    for (const r of rows) {
      const m = this.ctx.db.query("SELECT id, CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(r.source_id) as { id: string; role: string } | null
      if (m && !canUseAi(this.ctx, m)) continue
      this.ctx.db.query('UPDATE onboarding_notices SET read_at=? WHERE id=? AND read_at IS NULL').run(now, r.id)
      touched.add(r.user_id)
    }
    for (const u of touched) this.signal(u)
  }
  /** Someone joined (a team link, an invite or an admin's "Add directly"): told to the owners and the inviter. The
   * source is the new account's id only. Shown always: there is no setting for it, and a join is rare. */
  teamJoined(userId: string, joinedUserId: string, createdAt = new Date().toISOString()) {
    this.record(userId, 'team.joined', joinedUserId, createdAt, true)
  }
  /** Someone started to see a team project (chat/project-joins.ts): told to its members. The source is the
   * project.member_gained audit row's id only. Shown always and never pushed: it is rare and quiet. */
  projectJoined(userId: string, auditId: string, createdAt = new Date().toISOString()) {
    this.record(userId, 'project.joined', auditId, createdAt, true)
  }
  /** Someone shared a chat with this person (chat/people-share.ts): by name (`named`) or through a group. The source is
   * the chat.audience audit row's id; the chat and who shared it are kept to name them when the notice is read (only
   * while the reader still sees the chat). One row a day per chat and person. Shown always. A share by name is also
   * pushed to the person's devices (push-service.ts, notifications/chat-shares.ts) while their "Chats shared with me" is
   * on; a group's people get the Inbox row alone. It is called only for people who start to see the chat (they did not
   * just before), so the same day's row is about a share they lost since: a share again replaces it with a new row
   * (unread, at the top, pushed by the same rule as a first share; its push rows go with the old one), as a first
   * share would (QA TC-7047: a re-share said nothing new). A row still unread from the last SHARE_AGAIN_QUIET_MS is
   * brought up to date in place instead (no second push for a quick remove and add). A quick remove and add is that too:
   * the removal's unread 'stopped' chat.lost of the same day (chatLost, which marked this row read) goes, and a row that
   * was unread until that removal comes back unread in place (not a new row, no second push); a real loss later is told
   * again (a new chat.lost row). */
  chatShared(userId: string, auditId: string, chatId: string, byUser: string, named: boolean, at = new Date().toISOString()) {
    if (!this.active(userId) || at < this.cutoff()) return
    const db = this.ctx.db
    const day = at.slice(0, 10)
    db.transaction(() => {
      const old = db.query("SELECT id, read_at, created_at, suppressed FROM chat_share_notices WHERE user_id=? AND chat_id=? AND day=? AND event_type='chat.shared'").get(userId, chatId, day) as { id: string; read_at: string | null; created_at: string; suppressed: number } | null
      // taken out a moment ago (the same day's unread 'stopped' notice, within the quiet time): that notice says
      // something untrue now and goes
      const lost = db.query("SELECT id, created_at FROM chat_lost_notices WHERE user_id=? AND chat_id=? AND day=? AND reason='stopped' AND read_at IS NULL").get(userId, chatId, day) as { id: string; created_at: string } | null
      const quick = !!lost && Date.parse(at) - Date.parse(lost.created_at) < SHARE_AGAIN_QUIET_MS
      if (quick) db.query('DELETE FROM chat_lost_notices WHERE id=?').run(lost!.id)
      // unread, or read only by that removal (chatLost marks it read at the removal's time)
      const unread = !!old && (!old.read_at || (quick && old.read_at >= lost!.created_at))
      if (old && unread && !old.suppressed && Date.parse(at) - Date.parse(old.created_at) < SHARE_AGAIN_QUIET_MS) {
        db.query('UPDATE chat_share_notices SET source_id=?, by_user=?, named=MAX(named, ?), read_at=NULL WHERE id=?').run(auditId, byUser, named ? 1 : 0, old.id)
        return
      }
      if (old) db.query('DELETE FROM chat_share_notices WHERE id=?').run(old.id)
      db.query(`INSERT INTO chat_share_notices(id,user_id,event_type,source_id,chat_id,by_user,named,day,created_at,suppressed)
        VALUES(?,?,'chat.shared',?,?,?,?,?,?,0) ON CONFLICT DO NOTHING`).run(newId(), userId, auditId, chatId, byUser, named ? 1 : 0, day, at)
    })()
    this.signal(userId)
  }
  /** This person lost a chat shared with them (docs/decisions/20261122-shared-chat-leave-and-lost-notices.md): its
   * creator took them out or stopped sharing it ('stopped', chat/people-share.ts), moved it to the trash ('deleted',
   * routes/chats.ts) or the creator's account was deleted ('account', admin/users.ts). Ids only; who and the title are
   * read when it is shown. At most one per chat, reason and day. Shown always; never pushed. */
  chatLost(userId: string, chatId: string, byUser: string | null, reason: 'stopped' | 'deleted' | 'account', at = new Date().toISOString()) {
    if (!this.active(userId) || at < this.cutoff()) return
    const day = at.slice(0, 10)
    const r = this.ctx.db.query(`INSERT INTO chat_lost_notices(id,user_id,event_type,source_id,chat_id,by_user,reason,day,created_at,suppressed)
      VALUES(?,?,'chat.lost',?,?,?,?,?,?,0) ON CONFLICT DO NOTHING`).run(newId(), userId, `${chatId}:${reason}:${day}`, chatId, byUser, reason, day, at)
    // the unread "shared a chat with you" of that chat would now say "no longer shared" beside this one: read
    this.ctx.db.query('UPDATE chat_share_notices SET read_at = ? WHERE user_id = ? AND chat_id = ? AND read_at IS NULL').run(at, userId, chatId)
    if (r.changes) this.signal(userId)
  }
  /** A chat came back from the trash: the unread 'deleted' notices about it go (they would say something untrue now). */
  chatLostTakenBack(chatId: string) {
    const gone = this.ctx.db.query("DELETE FROM chat_lost_notices WHERE chat_id = ? AND reason = 'deleted' AND read_at IS NULL RETURNING user_id").all(chatId) as { user_id: string }[]
    for (const u of new Set(gone.map((g) => g.user_id))) this.signal(u)
  }
  /** A member asked to add an app the team has not set up (integrations/service-requests.ts): one notice per owner or
   * admin and app (the source is the app's id). A new ask arms it again (unread, its time now: it moves up and names
   * the newest asker) instead of adding a second row, so many asks are one notice. Shown always: there is no setting
   * for it, and someone waits. */
  serviceRequested(userId: string, service: string, at = new Date().toISOString()) {
    if (!this.active(userId)) return
    const again = this.ctx.db.query("UPDATE service_request_notices SET read_at=NULL, created_at=?, suppressed=0 WHERE user_id=? AND event_type='service.request' AND source_id=?").run(at, userId, service)
    if (again.changes) { this.signal(userId); return }
    this.record(userId, 'service.request', service, at, true)
  }
  /** The app a member asked for can be connected now: one quiet notice for them (the source is the request's id).
   * Inbox only, never an OS push. */
  serviceReady(userId: string, requestId: string, at = new Date().toISOString()) {
    this.record(userId, 'service.ready', requestId, at, true)
  }
  /** A member's ask closed without the app (an admin's Dismiss, or the 30 days): one quiet notice for them that they may
   * ask again (the source is the request's id; QA TC-2946). Inbox only, never an OS push. */
  serviceClosed(userId: string, requestId: string, at = new Date().toISOString()) {
    this.record(userId, 'service.closed', requestId, at, true)
  }
  /** Files the AI saved earlier that still hold one of the person's stored connection keys (integrations/connections/
   * file-scan.ts, QA TC-3082): one notice per person and scan version (source `scan-v<version>`, so a later version of
   * the scan can tell them again), listing them when shown. Activity only, never an OS push, shown whatever the
   * preferences say. */
  storedKeyFiles(userId: string, at = new Date().toISOString()) {
    this.record(userId, 'files.stored_key', `scan-v${FILE_SCAN_VERSION}`, at, true)
  }
  /** Who handles the asks changed (the 30-second check): someone no longer an active owner or admin loses the notices
   * (nothing there is theirs to do), and an owner or admin made since gets the notice of each app asked for now. */
  syncServiceRequests() {
    const db = this.ctx.db
    const gone = db.query(`DELETE FROM service_request_notices WHERE event_type='service.request'
      AND user_id NOT IN (SELECT id FROM users WHERE role IN ('owner','admin') AND status='active' AND deleted_at IS NULL) RETURNING user_id`).all() as { user_id: string }[]
    for (const u of new Set(gone.map((r) => r.user_id))) if (this.active(u)) this.signal(u)
    const open = (db.query('SELECT DISTINCT service FROM service_requests WHERE closed_at IS NULL').all() as { service: string }[]).map((r) => r.service)
    if (!open.length) return
    const has = db.query("SELECT 1 FROM service_request_notices WHERE user_id=? AND event_type='service.request' AND source_id=?")
    const at = new Date().toISOString()
    for (const id of admins(db)) for (const s of open) if (!has.get(id, s)) this.record(id, 'service.request', s, at, true)
  }
  /** No request for the app waits any more: the owners' and admins' notice for it counts as read. */
  settleServiceRequests(service: string) {
    const rows = this.ctx.db.query("UPDATE service_request_notices SET read_at=? WHERE event_type='service.request' AND source_id=? AND read_at IS NULL RETURNING user_id").all(new Date().toISOString(), service) as { user_id: string }[]
    for (const u of new Set(rows.map((r) => r.user_id))) if (this.active(u)) this.signal(u)
  }
  /** A password reset link was made for this person (auth/accounts.ts createResetLink): on the server (mycel-account /
   * mycel-ctl reset-link) or by an owner or admin. The source is the link's row id, never the token. Shown always: the
   * link signs its holder in as them, and only they know whether they asked for it (QA TC-202). */
  resetLinkMade(userId: string, resetId: string, createdAt = new Date().toISOString()) {
    this.record(userId, 'account.reset_link', resetId, createdAt, true)
  }
  /** The hosting service copied the team's AI connections' key or took a full export (system/cli.ts; source: the audit
   * row), or the relay stopped taking this server's key because the team address moved to another key
   * (relay-client/index.ts; source: the relay event). Shown always: only the owners and admins know whether they asked
   * for it (QA TC-348, TC-350). The words are the event's own; nothing else is stored or read. */
  hostingNotice(userId: string, event: HostingNoticeEvent, sourceId: string, createdAt = new Date().toISOString()) {
    this.record(userId, event, sourceId, createdAt, true)
  }
  /** The AI could not start on this server (chat/turn.ts engineStartFailed; source: the failed turn). Shown always: every
   * answer of the team fails until an owner or admin has the server fixed (QA TC-3521). */
  engineStartNotice(userId: string, sourceId: string, createdAt = new Date().toISOString()) {
    this.record(userId, 'engine.start_failed', sourceId, createdAt, true)
  }
  /** The team's disk is 80 % or 95 % full (system/storage.ts checkAlert; source: '<80|95>:<time>'). Shown always: the
   * owner and admins are the only ones who can free the space, and the live toast missed whoever was away. Inbox only,
   * no push. `roomsBytes`: the files in conversations as last measured (one number, never a name). */
  storageNotice(userId: string, sourceId: string, percent: number, roomsBytes: number | null, createdAt = new Date().toISOString()) {
    if (!this.active(userId) || createdAt < this.cutoff()) return
    const id = newId()
    const r = this.ctx.db.query("INSERT INTO storage_notices(id,user_id,event_type,source_id,created_at,suppressed,percent,rooms_bytes) VALUES(?,?,'storage.filling',?,?,0,?,?) ON CONFLICT(user_id,event_type,source_id) DO NOTHING")
      .run(id, userId, sourceId, createdAt, Math.max(0, Math.min(100, Math.round(percent))), roomsBytes === null ? null : Math.max(0, Math.floor(roomsBytes)))
    if (!r.changes) return
    // one current fact: a full disk for days is one unread row, not one a day (the older ones count as read)
    this.ctx.db.query("UPDATE storage_notices SET read_at=? WHERE user_id=? AND event_type='storage.filling' AND read_at IS NULL AND id<>?").run(createdAt, userId, id)
    this.signal(userId)
  }
  /** An owner or admin asked the people whose files in conversations take the most space to tidy them
   * (system/storage-cleanup.ts; source: the team's day, so one a day; `by`: who asked). Shown always, Activity only. */
  storageCleanupNotice(userId: string, sourceId: string, by: string, createdAt = new Date().toISOString()) {
    if (!this.active(userId) || createdAt < this.cutoff()) return
    const r = this.ctx.db.query("INSERT INTO storage_notices(id,user_id,event_type,source_id,created_at,suppressed,by_user) VALUES(?,?,'storage.cleanup',?,?,0,?) ON CONFLICT(user_id,event_type,source_id) DO NOTHING")
      .run(newId(), userId, sourceId, createdAt, by)
    if (r.changes) this.signal(userId)
  }
  /** 팀장 넘기기 (admin/handover.ts): a join with the owner's lead link (source: the invite; also pushed), a transfer
   * (source: the transfer, to both people and the other admins), a locked password check (source: its window). Shown
   * always: there is no setting for them, and each needs the person's eye. */
  handoverNotice(userId: string, event: HandoverEvent, sourceId: string, createdAt = new Date().toISOString()) {
    this.record(userId, event, sourceId, createdAt, true)
  }
  /** The owner handed the team over: their lead-join notices count as read (the card and its [넘기기] are gone). */
  settleLeadNotices(userId: string) {
    const n = this.ctx.db.query("UPDATE handover_notices SET read_at=? WHERE user_id=? AND event_type='owner.lead_joined' AND read_at IS NULL").run(new Date().toISOString(), userId).changes
    if (n && this.active(userId)) this.signal(userId)
  }
  /** A person asks this owner (or admin) to delete their account (auth/deletion-requests.ts). The source is the person's id only;
   * one row per owner or admin and person (UNIQUE, migration 244): asking again after a cancel re-arms it (unread, new time)
   * instead of adding one, so asking and cancelling over and over never fills the inbox. Shown always: there is no
   * setting for it, and someone waits. Never the person's own request. */
  deletionRequest(ownerId: string, requesterId: string, createdAt = new Date().toISOString()) {
    if (ownerId === requesterId) return
    const again = this.ctx.db.query("UPDATE account_deletion_notices SET read_at=NULL, created_at=?, suppressed=0 WHERE user_id=? AND event_type='account.deletion_request' AND source_id=? AND read_at IS NOT NULL").run(createdAt, ownerId, requesterId)
    if (again.changes) { if (this.active(ownerId)) this.signal(ownerId); return }
    this.record(ownerId, 'account.deletion_request', requesterId, createdAt, true)
  }
  /** The person's own request got its automatic date (auth/deletion-requests.ts deleteDueAccounts: a request open when
   * this build first ran, or re-opened by an older build). One row per person, re-armed if it was read. Shown always: the
   * account goes on that date. The date is read from the request when the inbox is shown. */
  deletionDue(userId: string, createdAt = new Date().toISOString()) {
    const again = this.ctx.db.query("UPDATE account_deletion_due_notices SET read_at=NULL, created_at=?, suppressed=0 WHERE user_id=? AND event_type='account.deletion_due' AND source_id=?").run(createdAt, userId, userId)
    if (again.changes) { if (this.active(userId)) this.signal(userId); return }
    this.record(userId, 'account.deletion_due', userId, createdAt, true)
  }
  /** An app in a room this person manages (or added) reached the day's cap and paused (rooms/apps/service.ts). The source
   * is "<app id>.<team day>": one notice per app, person and day. Shown always: there is no setting for it, and the
   * room's messages from that app stop until midnight or "Resume now". */
  roomAppPaused(userId: string, sourceId: string, createdAt = new Date().toISOString()) {
    this.record(userId, 'room_app.paused', sourceId, createdAt, true)
  }
  /** Someone who was shown the address of an app in a room this person may manage can no longer manage it (rooms/apps/
   * service.ts leaverSweep). The source is "<app id>.<first 12 of the address's token hash>": one notice per app,
   * person and address. Shown always: there is no setting for it, and only "Get a new address" ends it. Activity only. */
  roomAppLeaver(userId: string, sourceId: string, createdAt = new Date().toISOString()) {
    this.record(userId, 'room_app.leaver', sourceId, createdAt, true)
  }
  /** A role changed: what an owner or admin no longer handles leaves their inbox. A person who became a member is no
   * longer told of anyone's request; a member who became an admin is now the owner's business only, so the admins'
   * entries for that person go (the owners keep theirs). */
  forgetDeletionNotices(o: { userId: string } | { requesterId: string }) {
    const db = this.ctx.db
    const rows = 'userId' in o
      ? db.query('DELETE FROM account_deletion_notices WHERE user_id=? RETURNING user_id').all(o.userId)
      : db.query("DELETE FROM account_deletion_notices WHERE source_id=? AND user_id IN (SELECT id FROM users WHERE role='admin') RETURNING user_id").all(o.requesterId)
    for (const u of new Set((rows as { user_id: string }[]).map((r) => r.user_id))) if (this.active(u)) this.signal(u)
  }
  /** A request that no longer waits (taken back, or the account was deleted): its entries count as read, so no owner is
   * left with something to do that is gone. The entry stays and says what happened. */
  settleDeletionRequests(requesterId: string) {
    const rows = this.ctx.db.query("UPDATE account_deletion_notices SET read_at=? WHERE source_id=? AND read_at IS NULL RETURNING user_id").all(new Date().toISOString(), requesterId) as { user_id: string }[]
    for (const u of new Set(rows.map((r) => r.user_id))) if (this.active(u)) this.signal(u)
  }
  /** Every owner has the entry of every open request, and every admin that of every open member's request: an owner
   * or admin made after the request gets it too, and a request still open after the 30 days of the inbox comes back
   * as a new entry. A person who became the owner since is left out (the owner cannot ask). */
  private openDeletionRequests() {
    const db = this.ctx.db
    const open = db.query(`SELECT r.user_id FROM account_deletion_requests r JOIN users u ON u.id=r.user_id
      WHERE r.cancelled_at IS NULL AND r.handled_at IS NULL AND u.deleted_at IS NULL AND u.role != 'owner'`).all() as { user_id: string }[]
    if (!open.length) return
    const now = new Date().toISOString()
    for (const r of open) for (const id of deletionHandlers(this.ctx, (db.query(`SELECT CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role FROM users WHERE id=?`).get(r.user_id) as { role: string }).role)) {
      const o = { id }
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
  /** The end of the owner's welcome steps (skills/share-merge.ts startWaitingMerges): "합칠 스킬 N개 확인하기", one
   * notice per merge chat (its id is the source; UNIQUE row, migration 253). Shown always: the merges waited for it. */
  mergesWaiting(ownerId: string, chatId: string, n: number, createdAt = new Date().toISOString()) {
    if (!this.active(ownerId) || createdAt < this.cutoff()) return
    const r = this.ctx.db.query(`INSERT INTO skill_merge_notices(id,user_id,event_type,source_id,n,created_at,suppressed)
      VALUES(?,?,'skills.merge_waiting',?,?,?,0) ON CONFLICT DO NOTHING`).run(newId(), ownerId, chatId, Math.max(1, n), createdAt)
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
  /** An answer in an AI chat needs the person who asked it (notifications/chat-answers.ts noteChatAnswer): it finished
   * (`done`), failed, or the AI waits for them (`waiting`: a question or a yes/no card). One notice per answer: the
   * source is the turn (a card: '<turn>.ask', one per turn however many cards it opens). A finished answer of a chat
   * whose earlier finished answer was told within CHAT_ANSWER_COALESCE_MS, unread and not seen since, adds none (a
   * burst is one push). Nothing when the person turned "AI answers" off. Never listed in the Inbox; push_at is when the
   * push may go (a window that has the chat on screen marks it seen meanwhile). True: recorded now. */
  chatAnswer(userId: string, o: { chatId: string; turnId: string; kind: ChatAnswerKind }, now = Date.now()): boolean {
    if (!this.active(userId) || !eventEnabled(this.preferences(userId), 'chat.answer_done')) return false
    const db = this.ctx.db, at = new Date(now).toISOString()
    if (o.kind !== 'waiting') {
      const c = db.query('SELECT user_id, seen_at FROM chats WHERE id=?').get(o.chatId) as { user_id: string; seen_at: string | null } | null
      if (!c) return false
      // the chat's seen mark is its creator's (a shared chat keeps one)
      const since = [new Date(now - CHAT_ANSWER_COALESCE_MS).toISOString(), c.user_id === userId ? c.seen_at ?? '' : ''].sort().at(-1)!
      if (db.query(`SELECT 1 FROM chat_answer_notices n WHERE user_id=? AND chat_id=? AND kind IN ('done','failed') AND read_at IS NULL AND created_at>? AND ${NOT_SKIPPED('chat_answer_push_deliveries')} LIMIT 1`).get(userId, o.chatId, since)) return false
    }
    const delay = o.kind === 'waiting' ? CHAT_CARD_PUSH_DELAY_MS : CHAT_ANSWER_PUSH_DELAY_MS
    const r = db.query(`INSERT INTO chat_answer_notices(id,user_id,event_type,source_id,chat_id,kind,created_at,push_at,suppressed) VALUES(?,?,'chat.answer_done',?,?,?,?,?,0)
      ON CONFLICT(user_id,event_type,source_id) DO NOTHING`).run(newId(), userId, o.kind === 'waiting' ? `${o.turnId}.ask` : o.turnId, o.chatId, o.kind, at, new Date(now + delay).toISOString())
    return r.changes > 0
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
  /** Connection templates (docs/INTEGRATIONS.md "Templates"): each active person a template is for, who has not
   * connected it and was not told about it before, gets one notice that it is there to connect with their own key. That
   * covers a new template, a change of who it is for, a person added to one of its groups and someone who joins while
   * it is for everyone: whatever made it reach them, this finds it. Its maker is not told about their own template. The
   * source is the template's id only, and integration_template_offers keeps a second notice from coming once the first
   * is past its 30 days. Shown always: the person has something to do before their AI can use the service. Not, for
   * a template already there when they joined, someone who joined in the last days and has not opened Connected apps
   * yet (member_welcome, migration 286). */
  offerTemplates(opts: { templateId?: string; userId?: string; limit?: number } = {}, at = new Date().toISOString()): number {
    // One set-based query (security review 2, #1): templates × active people, the same test as templateCovers in SQL,
    // so the cost is a single indexed scan instead of 1–3 queries per template and person. Only the pairs still owed a
    // notice come back, at most `limit` per call: the 30-second backstop stays light however big the team is, and the
    // events that change who a template reaches (made, its rule changed, a group joined, someone activated) call this
    // straight away for just that template or person.
    const db = this.ctx.db
    const where: string[] = []
    const args: (string | number)[] = []
    if (opts.templateId) { where.push('t.id = ?'); args.push(opts.templateId) }
    if (opts.userId) { where.push('u.id = ?'); args.push(opts.userId) }
    // someone who joined lately is not told at join about the templates already there (docs/DECISIONS.md "A welcome for
    // invited people"): those wait until they open Connected apps (onboarding/member-welcome.ts templatesSeen) or their
    // welcome days are over. A template made after they joined is news, and is told as before
    args.push(new Date(Date.now() - MEMBER_WELCOME_DAYS * 86_400_000).toISOString())
    args.push(Math.max(1, Math.min(opts.limit ?? OFFER_BATCH, 100_000)))
    const owed = db.query(`SELECT t.id AS template_id, u.id AS user_id
      FROM integration_templates t JOIN users u ON u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0 AND (t.created_by IS NULL OR u.id <> t.created_by)
      WHERE ${where.length ? `${where.join(' AND ')} AND ` : ''}
        NOT EXISTS (SELECT 1 FROM integration_template_offers o WHERE o.template_id = t.id AND o.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM member_welcome w WHERE w.user_id = u.id AND w.apps_seen_at IS NULL AND w.joined_at >= ? AND t.created_at <= w.joined_at)
        AND NOT EXISTS (SELECT 1 FROM integrations i WHERE i.template_id = t.id AND i.owner_user_id = u.id)
        AND EXISTS (SELECT 1 FROM integration_template_access a WHERE a.template_id = t.id AND (a.subject_type = 'everyone'
          OR (a.subject_type = 'user' AND a.subject_id = u.id)
          OR (a.subject_type = 'group' AND EXISTS (SELECT 1 FROM group_members g WHERE g.group_id = a.subject_id AND g.user_id = u.id))))
      ORDER BY t.created_at, t.id, u.id LIMIT ?`).all(...args) as { template_id: string; user_id: string }[]
    if (!owed.length) return 0
    const mark = db.query('INSERT OR IGNORE INTO integration_template_offers(template_id,user_id,created_at) VALUES(?,?,?)')
    for (const r of owed) {
      if (mark.run(r.template_id, r.user_id, at).changes) this.record(r.user_id, 'integration.template', r.template_id, at, true)
    }
    return owed.length
  }
  /** A template's address, sign-in method or header changed, so the member's own connection made from it (and their key)
   * was dropped: they connect it again. One notice per member and change. Shown always, like the first one. */
  templateReconnect(userId: string, templateId: string, version: number, at = new Date().toISOString()) {
    this.record(userId, 'integration.template_reconnect', reconnectSource(templateId, version), at, true)
  }
  /** A template no longer covers the member (an admin narrowed who it is for, maybe with a new address, or they left one
   * of its groups), so their own connection made from it went: one plain notice that they no longer have it, never a
   * "connect it again". One per connection that went. Shown always, like the others. */
  templateLeft(userId: string, templateId: string, connectionId: string, at = new Date().toISOString()) {
    this.record(userId, 'integration.template_reconnect', leftSource(templateId, connectionId), at, true)
  }
  /** A Drive shared with the team stopped (its admin left, or Google signed it out): every active admin is told to sign
   * in again, once per episode (`sourceId`: the share and its version). Shown always: members lose the folders. */
  driveShareReconnect(sourceId: string, at = new Date().toISOString()) {
    if (!/^[A-Za-z0-9_.-]{1,160}$/.test(sourceId)) throw new HttpError('validation')
    for (const id of admins(this.ctx.db)) this.record(id, 'drive.share_reconnect', sourceId, at, true)
  }
  /** Terminal DB rows are the source of truth. Missing hooks, queued cancellation and interrupted recovery converge. */
  reconcile(userId?: string) {
    const db = this.ctx.db
    for (const table of NOTICE_TABLES) db.query(`DELETE FROM ${table} WHERE created_at < ?`).run(this.cutoff())
    for (const table of PUSH_ONLY_TABLES) db.query(`DELETE FROM ${table} WHERE created_at < ?`).run(this.cutoff())
    // a Share press of several files (migration 356) goes with its last notice
    db.query("DELETE FROM file_share_batches WHERE created_at < ? AND NOT EXISTS(SELECT 1 FROM file_share_notices n WHERE n.event_type = 'file.shared' AND n.source_id = 'b:' || file_share_batches.id)").run(this.cutoff())
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
    // a run that did not start because it needs the owner's own key for a template (chat/schedules.ts): a failure
    // notice that names the template (out below)
    const needs = db.query(`SELECT s.id,s.user_id,s.created_at FROM schedule_template_skips s
      WHERE s.created_at>=? AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL)
      ${userId ? 'AND s.user_id=?' : ''} AND NOT EXISTS(SELECT 1 FROM notification_inbox n WHERE n.user_id=s.user_id AND n.source_id=s.id AND n.event_type='schedule.failure')
      ORDER BY s.created_at,s.id LIMIT 500`).all(...(userId ? [this.cutoff(), userId] : [this.cutoff()])) as { id: string; user_id: string; created_at: string }[]
    for (const row of needs) this.record(row.user_id, 'schedule.failure', row.id, row.created_at, true)
    db.query('DELETE FROM schedule_template_skips WHERE created_at < ?').run(this.cutoff())
    // a run that did not start because its owner no longer sees its project (chat/schedules.ts): a failure notice that
    // says so (out below), always shown (the task will not run until the project is back or the task is changed)
    const gone = db.query(`SELECT s.id,s.user_id,s.created_at FROM schedule_project_skips s
      WHERE s.created_at>=? AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL)
      ${userId ? 'AND s.user_id=?' : ''} AND NOT EXISTS(SELECT 1 FROM notification_inbox n WHERE n.user_id=s.user_id AND n.source_id=s.id AND n.event_type='schedule.failure')
      ORDER BY s.created_at,s.id LIMIT 500`).all(...(userId ? [this.cutoff(), userId] : [this.cutoff()])) as { id: string; user_id: string; created_at: string }[]
    for (const row of gone) this.record(row.user_id, 'schedule.failure', row.id, row.created_at, true)
    db.query('DELETE FROM schedule_project_skips WHERE created_at < ?').run(this.cutoff())
    if (!userId) { try { this.offerTemplates({ limit: OFFER_BATCH }) } catch { this.ctx.log.warn('template notices deferred') } }
    // scheduled tasks nobody confirmed, paused for their owner's review (chat/schedules.ts): one notice per person and
    // pause, shown in the app always (the task stopped running), pushed per the "scheduled task failed" setting
    const reviews = db.query(`SELECT s.user_id, s.review_since FROM schedules s
      WHERE s.review_since IS NOT NULL AND s.review_since >= ? AND s.template_id IS NULL AND s.confirmed_at IS NULL
      AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL) ${userId ? 'AND s.user_id=?' : ''}
      GROUP BY s.user_id, s.review_since ORDER BY s.review_since LIMIT 500`).all(...(userId ? [this.cutoff(), userId] : [this.cutoff()])) as { user_id: string; review_since: string }[]
    for (const row of reviews) this.record(row.user_id, 'schedule.failure', reviewSource(row.user_id, row.review_since), row.review_since, true)
    // a task whose save folder lapsed (moved, renamed, deleted, its rules changed, the owner's write access gone): one
    // notice per lapse, shown in the app always (its runs save in the own folder until the owner checks it again)
    const lapses = db.query(`SELECT s.id, s.user_id, s.save_lapsed_at FROM schedules s
      WHERE s.save_lapsed_at IS NOT NULL AND s.save_lapsed_at >= ? AND s.save_folder IS NOT NULL
      AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL) ${userId ? 'AND s.user_id=?' : ''}
      ORDER BY s.save_lapsed_at LIMIT 500`).all(...(userId ? [this.cutoff(), userId] : [this.cutoff()])) as { id: string; user_id: string; save_lapsed_at: string }[]
    for (const row of lapses) this.record(row.user_id, 'schedule.failure', saveLapseSource(row.id, row.save_lapsed_at), row.save_lapsed_at, true)
    return Math.max(rows.length, skips.length, reviews.length, needs.length, gone.length, lapses.length)
  }
  preferences(userId: string) { return getPreferences(this.ctx.db, userId) }
  private locale(userId: string) { return getUser(this.ctx.db, userId)?.locale ?? teamDefaultLocale(this.ctx.db) }
  setPreferences(userId: string, patch: Partial<NotificationPreferences>) {
    if (!this.active(userId)) throw new HttpError('not_found')
    // Process previous terminal events with the old preferences before committing a change.
    const { before, result } = this.ctx.db.transaction(() => {
      while (this.reconcile(userId) === 500) { /* drain all prior events under the old preferences */ }
      const before = this.preferences(userId)
      const preferences = savePreferences(this.ctx.db, userId, patch)
      cancelDisabledPushDeliveries(this.ctx, userId, preferences)
      return { before, result: preferences }
    })()
    cancelPushUser(this.ctx, userId)
    this.signal(userId)
    // every room's level and the quiet hours may have changed: the person's windows read their rooms again
    if (roomAlertsChanged(before, result)) {
      try { this.ctx.services.realtime.publish(userId, ROOM_ALERTS_CHANGED) }
      catch { this.ctx.log.warn('room alerts signal failed') }
    }
    return result
  }
  /** A dev environment notice. A job is a row of dev_env_runs (devEnvRunOut). The rows of the removed box runner
   * (dev_env_jobs, dev_env_stops; docs/DECISIONS.md "Dev environment: box runner removed, srt only") show only the
   * generic text of their event, with no project, log or link. */
  private devEnvOut(row: Row): InboxNotification {
    const base = { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null }
    return row.event_type === 'dev_env.job' ? this.devEnvRunOut(row, base) : base
  }
  /** A job (dev_env_runs): the person's own run, from any chat, with or without a project. With a
   * project it is shown while the person can see the project; with none, projectId and projectName are ''. */
  private devEnvRunOut(row: Row, base: InboxNotification): InboxNotification {
    const db = this.ctx.db
    if (row.source_id.startsWith(REQUEST_SOURCE)) return this.devEnvRequestOut(row, base)
    const run = db.query('SELECT project_id,name,chat_id,exit_code,end_reason FROM dev_env_runs WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { project_id: string | null; name: string; chat_id: string | null; exit_code: number | null; end_reason: string } | null
    if (!run) return base
    const project = run.project_id ? db.query('SELECT name,folder_path,trashed_with FROM projects WHERE id=?').get(run.project_id) as { name: string; folder_path: string; trashed_with: string | null } | null : null
    if (project) {
      try {
        if (project.trashed_with !== null) throw new Error('project folder in the trash')
        authorize(this.ctx.files.fx, this.ctx.files.rules(), this.ctx.files.principal(row.user_id), project.folder_path, 'read')
      } catch { return base }
    }
    const chat = run.chat_id ? db.query('SELECT id,title FROM chats WHERE id=? AND user_id=? AND deleted_at IS NULL').get(run.chat_id, row.user_id) as { id: string; title: string } | null : null
    // the result in plain words (done or not, in which chat): never the log or the English end note, which stay in the
    // job's row for the AI of that chat (the people reading Activity are not developers)
    const job = { name: run.name, exitCode: run.exit_code, ...(run.end_reason && run.end_reason !== 'exit' ? { reason: run.end_reason } : {}), ...(chat?.title ? { chatTitle: chat.title } : {}) }
    return { ...base, chatId: chat?.id ?? null, link: chat ? 'chat' : project ? 'project' : null, devEnv: { projectId: project ? run.project_id! : '', projectName: project?.name ?? '', job } }
  }
  /** A request whose dev environment jobs ended while its answer ran (devenv/jobs.ts tellHeldJobs): how the answer
   * ended (done, or stopped and why), in the chat the person asked in while they can open it. The person's own answer
   * only. */
  private devEnvRequestOut(row: Row, base: InboxNotification): InboxNotification {
    // the outcome as it was when the answer ended, kept in the source: a question answered later must not turn it into "done"
    const r = parseRequestSource(row.source_id)
    const turn = r ? this.ctx.db.query('SELECT chat_id FROM turns WHERE id=? AND user_id=?').get(r.turnId, row.user_id) as { chat_id: string } | null : null
    if (!r || !turn) return base
    const chat = this.ctx.db.query('SELECT id,title FROM chats WHERE id=? AND deleted_at IS NULL').get(turn.chat_id) as { id: string; title: string } | null
    const open = !!chat && chatOpenFor(this.ctx, row.user_id, chat.id)
    const request = { ...r.outcome, ...(open && chat!.title ? { chatTitle: chat!.title } : {}) }
    return { ...base, chatId: open ? chat!.id : null, link: open ? 'chat' : null, devEnv: { projectId: '', projectName: '', request } }
  }
  /** `rows`: the Inbox's list, whose room notices are rows (roomRows) with the first line of their newest message; a
   * single notice (what a push opens) has no text. */
  private out(row: Row | RoomRow): InboxNotification {
    let chatId: string | null = null, outcome: ScheduleRunOutcome | null = null
    if (isSkillEvent(row.event_type)) {
      // The Skills screen checks access again when it opens the suggestion (?review= only when the viewer may review).
      // A batch of a member's skill folders (docs/DECISIONS.md "MC"): who sent it and how many, never a skill's name.
      const contribution = row.event_type === 'skill.suggested' ? contributionOf(this.ctx.db, row.source_id) : null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: 'skills', outcome: null,
        ...(contribution ? { contribution } : {}) }
    }
    if (isDevEnvEvent(row.event_type)) return this.devEnvOut(row)
    if (isFileShareEvent(row.event_type)) return fileSharesOf(this.ctx).noticeOut(row)
    if (isAccessRequestEvent(row.event_type)) return accessRequestsOf(this.ctx).noticeOut(row)
    // an AI chat's answer (what a push opens): the chat while the person may still open it, nothing else
    if (row.event_type === 'chat.answer_done') {
      const n = this.ctx.db.query('SELECT chat_id FROM chat_answer_notices WHERE id=?').get(row.id) as { chat_id: string } | null
      const open = !!n && chatOpenFor(this.ctx, row.user_id, n.chat_id)
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: open ? n!.chat_id : null, link: open ? 'chat' : null, outcome: null }
    }
    // a person's message in a chat shared with people (what a push opens): the chat and the message while I still see it
    if (row.event_type === 'chat.message') {
      const l = chatMessageLink(this.ctx, row.id)
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: l?.chatId ?? null, link: l ? 'chat' : null, outcome: null, ...(l ? { chatMessage: { messageId: l.messageId } } : {}) }
    }
    // the handover's: what each row offers is read now (admin/handover-notices.ts)
    if (isHandoverEvent(row.event_type)) return handoverNoticeOut(this.ctx, row)
    // a room notice links to the room (a reply: its thread) and says who wrote what where while the person is still in
    // the room and may read the message (rooms/inbox.ts); the first line of the message in the Inbox's list, and in the
    // single notice a push opens while the person's messagePreview is on
    if (isRoomEvent(row.event_type)) {
      const base = { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, outcome: null }
      const room = 'group' in row ? roomRowOut(this.ctx.db, row) : roomNoticeOut(this.ctx.db, row, this.locale(row.user_id), { preview: getPreferences(this.ctx.db, row.user_id).messagePreview })
      return room ? { ...base, link: 'room', room } : { ...base, link: null }
    }
    // Settings › External services opens the request (?request=<sourceId>) and says if it is no longer waiting. The
    // service's name with the host of its address (where the member's key would go), while the request is there.
    if (row.event_type === 'integration.request') {
      const q = this.ctx.db.query('SELECT name, url FROM integration_requests WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { name: string; url: string } | null
      let host = ''
      try { host = q ? new URL(q.url).host : '' } catch {}
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: 'integrations', outcome: null,
        ...(q && host ? { request: { name: q.name, host } } : {}) }
    }
    // a member's ask to add an app: for an owner or admin, who asks (the newest asker by name, and how many others)
    // while any request waits, else who asked in the round that ended; the app only for someone who is neither now.
    // The asker's answer: the app, to connect (never who set it up)
    if (isServiceRequestEvent(row.event_type) || row.event_type === 'service.closed') return serviceRequestOut(this.ctx.db, row)
    // older AI-made files with one of my stored keys in them: how many, and the ones I may open now (never the key)
    if (row.event_type === 'files.stored_key') return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null,
      keyFiles: storedKeyFilesOf(this.ctx, row.user_id) }
    // the owner sees who asks (a name, nothing else) and goes to Admin › AI connections
    if (row.event_type === 'onboarding.ai_request') {
      const notReady = row.source_id.startsWith(NOT_READY_SOURCE)
      const m = this.ctx.db.query("SELECT name FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(notReady ? row.source_id.slice(NOT_READY_SOURCE.length) : row.source_id) as { name: string } | null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: 'admin_credentials', outcome: null, ...(m ? { requester: { name: m.name } } : {}), ...(notReady ? { notReady: true as const } : {}) }
    }
    // a chat shared with me: who shared it, and the chat while I still see it (chatFor's rule for a people-shared chat);
    // else "no longer shared with you" with who shared it (QA TC-7047), no title (it may have been renamed since) and no link
    if (row.event_type === 'chat.shared') {
      const n = this.ctx.db.query('SELECT chat_id, by_user FROM chat_share_notices WHERE id = ?').get(row.id) as { chat_id: string; by_user: string | null } | null
      // the sharer while their account is there and switched on (the same rule as the push label, chat-shares.ts sharerName)
      const u = n?.by_user ? this.ctx.db.query("SELECT name FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(n.by_user) as { name: string } | null : null
      const c = n ? this.ctx.db.query('SELECT id, user_id, title, project_id, people_shared_at, deleted_at, room_id FROM chats WHERE id = ?').get(n.chat_id) as { id: string; user_id: string; title: string; project_id: string | null; people_shared_at: string | null; deleted_at: string | null; room_id: string | null } | null : null
      const sees = !!c && !c.deleted_at && !c.room_id && isPeopleRow(c) && inPeopleAudience(this.ctx.db, c, row.user_id)
      const title = sees ? plainLabel(redactorFor(this.ctx, c!.user_id).hide(c!.title || '')) : null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: sees ? c!.id : null, link: sees ? 'chat' : null, outcome: null,
        chatShared: { name: u?.name ?? null, title: title || null, ...(sees ? {} : { gone: true as const }) } }
    }
    // a chat shared with me that I lost: why and who; its title and link only while I see it again (a restore, a share)
    if (row.event_type === 'chat.lost') {
      const n = this.ctx.db.query('SELECT chat_id, by_user, reason, created_at FROM chat_lost_notices WHERE id = ?').get(row.id) as { chat_id: string; by_user: string | null; reason: 'stopped' | 'deleted' | 'account'; created_at: string } | null
      // the name stays after the account is deleted (the tombstone keeps it): the notice is about that very change
      const u = n?.by_user ? this.ctx.db.query('SELECT name FROM users WHERE id=?').get(n.by_user) as { name: string } | null : null
      const c = n ? this.ctx.db.query('SELECT id, user_id, title, project_id, people_shared_at, deleted_at, room_id FROM chats WHERE id = ?').get(n.chat_id) as { id: string; user_id: string; title: string; project_id: string | null; people_shared_at: string | null; deleted_at: string | null; room_id: string | null } | null : null
      const sees = !!c && !c.deleted_at && !c.room_id && isPeopleRow(c) && inPeopleAudience(this.ctx.db, c, row.user_id)
      const title = sees ? plainLabel(redactorFor(this.ctx, c!.user_id).hide(c!.title || '')) : null
      const until = n?.reason === 'account' && c ? chatGoneAt(this.ctx, c.user_id) : null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: sees ? c!.id : null, link: sees ? 'chat' : null, outcome: null,
        ...(n ? { chatLost: { reason: n.reason, name: u?.name ?? null, title: title || null, ...(until ? { until } : {}) } } : {}) }
    }
    // a reply in a thread I follow under an AI answer of a shared chat: who and which chat, read now while I still see the
    // thread (chat/threads.ts); else no name, title or link
    if (row.event_type === 'chat.thread_reply') return chatThreadNoticeOut(this.ctx, row)
    // who started to see a project, and the project while the reader still sees it (its contents' rule, canSeeProject)
    if (row.event_type === 'project.joined') {
      const a = this.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE id = ? AND action = 'project.member_gained'").get(Number(row.source_id)) as { actor_id: string | null; detail: string | null } | null
      let d: { projectId?: string; userId?: string } = {}
      try { d = JSON.parse(a?.detail ?? '{}') } catch {}
      const u = d.userId ? this.ctx.db.query('SELECT name FROM users WHERE id=? AND deleted_at IS NULL').get(d.userId) as { name: string } | null : null
      const pr = d.projectId ? this.ctx.db.query('SELECT id, name, folder_path, trashed_with FROM projects WHERE id = ?').get(d.projectId) as { id: string; name: string; folder_path: string; trashed_with: string | null } | null : null
      let sees = false
      if (pr && pr.trashed_with === null) { try { sees = atLeast(this.ctx.files.rules().access(this.ctx.files.principal(row.user_id), pr.folder_path.split('/')), 'read') } catch { sees = false } }
      // the notice of the person who was let in (chat/project-joins.ts, QA TC-r2u-03): who let them in, while that account is there
      const you = !!d.userId && d.userId === row.user_id
      const by = you && a?.actor_id ? this.ctx.db.query('SELECT name FROM users WHERE id=? AND deleted_at IS NULL').get(a.actor_id) as { name: string } | null : null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: sees ? 'project' : null, outcome: null,
        projectJoined: { name: u?.name ?? null, project: sees && pr ? { id: pr.id, name: pr.name } : null, ...(you ? { you: true as const, by: by?.name ?? null } : {}) } }
    }
    // the name of who joined, while the account is there (a deleted one keeps the entry without a name)
    if (row.event_type === 'team.joined') {
      const u = this.ctx.db.query('SELECT name FROM users WHERE id=? AND deleted_at IS NULL').get(row.source_id) as { name: string } | null
      // a guest joined the place their invite opened, not the team: "X joined 'Quote prep' as a guest"
      // (auth/guests.ts invitedPlace). The place's name as it is now, only to a reader who is in that place or is the
      // owner or an admin (who see it in Admin › Guests anyway); an inviter who left it reads "a group chat" / "a
      // project", never a later rename. A second place they were added to later is not this notice's
      const invited = u ? invitedPlace(this.ctx.db, row.source_id) : null
      const place = invited ? { ...invited, name: placeName(this.ctx.db, invited) } : undefined
      // Its link: the owner and admins keep Admin › Members (no id); anyone else, the place itself while they are in it
      // (its id), else nowhere (null): Admin is not theirs
      const staff = !!place && isStaff(this.ctx.db, row.user_id)
      const inPlace = !!place && !staff && placePeopleOf(this.ctx.db, row.source_id, place).has(row.user_id)
      const named = staff || inPlace
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null,
        ...(u ? { joined: { name: u.name, ...(place ? { guestPlace: { kind: place.kind, name: named ? place.name : '', ...(staff ? {} : { id: inPlace ? place.id : null }) } } : {}) } } : {}) }
    }
    // the owner and the admins see who asks (a name while the account is there) and where the request is now; while it
    // waits, the link opens that person in Admin › Members, where the account is deleted
    if (row.event_type === 'account.deletion_request') {
      const u = this.ctx.db.query('SELECT name FROM users WHERE id=? AND deleted_at IS NULL').get(row.source_id) as { name: string } | null
      const q = this.ctx.db.query(`SELECT cancelled_at, handled_at, CASE WHEN ${datedSql()} THEN due_at END AS due_at FROM account_deletion_requests WHERE user_id=?`).get(row.source_id) as { cancelled_at: string | null; handled_at: string | null; due_at: string | null } | null
      const state = !q ? null : q.handled_at || !u ? 'handled' as const : q.cancelled_at ? 'cancelled' as const : 'open' as const
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: state === 'open' ? 'admin_members' : null, outcome: null,
        ...(state ? { deletionRequest: { name: u?.name ?? null, state, dueAt: state === 'open' ? q!.due_at : null } } : {}) }
    }
    // my own account's deletion date (while the request is open; the link opens the page where I can cancel it)
    if (row.event_type === 'account.deletion_due') {
      const q = this.ctx.db.query(`SELECT due_at FROM account_deletion_requests WHERE user_id=? AND cancelled_at IS NULL AND handled_at IS NULL AND ${datedSql()}`).get(row.user_id) as { due_at: string } | null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: q ? 'account_deletion' : null, outcome: null,
        deletionDue: { dueAt: q?.due_at ?? null } }
    }
    // who ran which skill first (a name while the account is there) and the count then; no link
    if (row.event_type === 'onboarding.first_run') {
      const n = this.ctx.db.query('SELECT member_id, skill_path, runners FROM onboarding_goal_notices WHERE id=?').get(row.id) as { member_id: string; skill_path: string; runners: number } | null
      const u = n ? this.ctx.db.query('SELECT name FROM users WHERE id=? AND deleted_at IS NULL').get(n.member_id) as { name: string } | null : null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null,
        ...(n ? { firstRun: { member: u?.name ?? null, skill: goalSkillTitle(this.ctx, row.user_id, n.skill_path), runners: n.runners, target: GOAL_PEOPLE } } : {}) }
    }
    // an admin's change to the team's AI, told to the owners, or to a member's own connection: who, what, the name (the
    // text is the page's); the owners' open Admin › AI providers
    if (row.event_type === 'credential.change') {
      const n = this.ctx.db.query('SELECT actor_name, action, subject FROM credential_change_notices WHERE id=?').get(row.id) as { actor_name: string; action: string; subject: string } | null
      const own = !!n && n.action.startsWith('personal_')
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: n && !own ? 'admin_credentials' : null, outcome: null,
        ...(n ? { credentialChange: { who: n.actor_name, action: n.action, subject: n.subject } } : {}) }
    }
    // a reset link made for me: by the server or by whom (a name while the account is there), and whether it still works
    // (unused, not replaced, not expired: read now, so the advice to change the password goes once it no longer helps)
    // the hosting service's copy of the team's key or data, or the team address moved away: the words say it all, no link
    // an app that paused in a room: what it is now, read when the notice is read (rooms/apps/notice.ts)
    if (row.event_type === 'room_app.paused') {
      const roomApp = roomAppNoticeOut(this.ctx, row.user_id, row.source_id)
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: roomApp?.roomId ? 'room' : null, outcome: null,
        ...(roomApp ? { roomApp } : {}) }
    }
    // someone who left knows an app's address: the app and its room now, absent once removed or given a new address
    if (row.event_type === 'room_app.leaver') {
      const roomAppLeaver = roomAppLeaverOut(this.ctx, row.user_id, row.source_id)
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: roomAppLeaver?.roomId ? 'room' : null, outcome: null,
        ...(roomAppLeaver ? { roomAppLeaver } : {}) }
    }
    // the AI could not start on this server: the words say what to do, no link (the health page is the owner's only)
    if (row.event_type === 'engine.start_failed') return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null }
    // the disk filling: how full it was and the files in conversations then, and the storage card, while the reader is
    // still the owner or an admin; one demoted since gets the plain words only (no number of the team's files, no link)
    if (row.event_type === 'storage.filling') {
      const staff = isStaff(this.ctx.db, row.user_id)
      const n = staff ? this.ctx.db.query('SELECT percent, rooms_bytes FROM storage_notices WHERE id=?').get(row.id) as { percent: number | null; rooms_bytes: number | null } | null : null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: staff ? 'admin_storage' : null, outcome: null,
        ...(n && n.percent !== null ? { storage: { percent: n.percent, roomsBytes: n.rooms_bytes } } : {}) }
    }
    // asked to tidy my files in conversations: who asked while that account is active (else "An admin"); my own files
    if (row.event_type === 'storage.cleanup') {
      const n = this.ctx.db.query('SELECT by_user FROM storage_notices WHERE id=?').get(row.id) as { by_user: string | null } | null
      const by = n?.by_user ? this.ctx.db.query("SELECT name FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(n.by_user) as { name: string } | null : null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: 'sent_files', outcome: null,
        cleanup: { by: by ? plainLabel(by.name, 80) : null } }
    }
    if (isHostingEvent(row.event_type)) return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null }
    if (row.event_type === 'account.reset_link') {
      const r = this.ctx.db.query('SELECT created_by, expires_at, used_at FROM password_resets WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { created_by: string | null; expires_at: string; used_at: string | null } | null
      const by = r?.created_by ? getUser(this.ctx.db, r.created_by) : null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null,
        ...(r ? { resetLink: { server: r.created_by === null, by: by ? plainLabel(by.name, 80) : null, open: !r.used_at && Date.parse(r.expires_at) > Date.now() } } : {}) }
    }
    // the skills to merge after the welcome steps: how many, and the merge chat while it is the owner's and not deleted
    if (row.event_type === 'skills.merge_waiting') {
      const n = this.ctx.db.query('SELECT n FROM skill_merge_notices WHERE id=?').get(row.id) as { n: number } | null
      const chat = this.ctx.db.query('SELECT id FROM chats WHERE id=? AND user_id=? AND deleted_at IS NULL').get(row.source_id, row.user_id) as { id: string } | null
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: chat?.id ?? null, link: chat ? 'chat' : null, outcome: null,
        ...(n ? { merges: { n: n.n } } : {}) }
    }
    // a Drive shared with the team that needs a new sign-in: its name while it is there, for an admin (Admin ›
    // Connectors › Google Drive opens it)
    if (row.event_type === 'drive.share_reconnect') {
      const share = shareRow(this.ctx.db, row.source_id.replace(/\.v\d+$/, ''))
      const shown = !!share && admins(this.ctx.db).includes(row.user_id)
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: shown ? 'admin_connectors' : null, outcome: null,
        ...(shown ? { driveShare: { id: share!.id, name: share!.name } } : {}) }
    }
    // a connection template: its id, name and whether it is a sign-in while it is there (the words follow: sign in again
    // or enter the key again; QA TC-2980), and a link (Settings › Connectors opens it) only while it is still for this
    // person. One it no longer covers keeps its name, which they were told before. A reconnect notice's source is the
    // template id and its version (reconnectSource); the "no longer for you" notice's, leftSource (templateLeft)
    if (isTemplateEvent(row.event_type)) {
      const id = row.event_type === 'integration.template_reconnect' ? templateOfSource(row.source_id) : row.source_id
      const left = row.event_type === 'integration.template_reconnect' && LEFT_SOURCE.test(row.source_id)
      const t = this.ctx.db.query('SELECT id, name, auth FROM integration_templates WHERE id=?').get(id) as { id: string; name: string; auth: string } | null
      const linked = !!t && !left && templateCovers(this.ctx.db, t.id, row.user_id)
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: linked ? 'integrations' : null, outcome: null,
        ...(t ? { template: { id: t.id, name: t.name, ...(t.auth === 'oauth' ? { signIn: true as const } : {}) } } : {}),
        ...(left ? { templateLeft: true as const } : {}) }
    }
    // a scheduled run that did not start for want of the owner's own key for a template: which one (by the name it had
    // then), and Settings › MCP to connect it
    if (row.event_type === 'schedule.failure') {
      const skip = this.ctx.db.query('SELECT template_id, template_name, schedule_id FROM schedule_template_skips WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { template_id: string; template_name: string; schedule_id: string } | null
      // a template members sign in to (OAuth) says so, not "your own key" (QA TC-3052); a removed template keeps the key words
      const signIn = skip ? (this.ctx.db.query('SELECT auth FROM integration_templates WHERE id=?').get(skip.template_id) as { auth: string } | null)?.auth === 'oauth' : false
      if (skip) return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: 'integrations', outcome: 'failed',
        needsKey: { templateId: skip.template_id, name: skip.template_name, ...(signIn ? { signIn: true as const } : {}) }, ...this.scheduleOf(row.user_id, skip.schedule_id) }
      // a run whose project its owner no longer sees: says so, no link (the project is not theirs to open now)
      const gone = this.ctx.db.query('SELECT schedule_id, project_id FROM schedule_project_skips WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { schedule_id: string; project_id: string } | null
      if (gone) return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: 'failed', projectGone: true,
        ...(membersOnlyNow(this.ctx.db, this.ctx.files, row.user_id, gone.project_id) ? { membersOnly: true as const } : {}), ...this.scheduleOf(row.user_id, gone.schedule_id) }
    }
    if (row.event_type === 'schedule.failure' && row.source_id.startsWith(SAVE_LAPSE_SOURCE)) {
      // its save folder to check again: the Scheduled page, never a chat; the task by its title while it is there
      const id = row.source_id.slice(SAVE_LAPSE_SOURCE.length).replace(/-\d+$/, '')
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null, saveLapsed: true, ...this.scheduleOf(row.user_id, id) }
    }
    if (row.event_type === 'schedule.failure' && row.source_id.startsWith(REVIEW_SOURCE)) {
      // paused tasks to check again: the schedules list, never a chat
      return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null, review: true }
    }
    // a person's own connection other than Google Drive (connections/service.ts tellSignInAgain, source "<id>_<ms>"): its
    // name and its page while it is still theirs (QA TC-2945); Google Drive's and a removed one's: the generic line
    if (row.event_type === 'connection.reconnect') {
      const id = /^(.+)_\d+$/.exec(row.source_id)?.[1]
      const c = id ? this.ctx.db.query("SELECT id, name, google_app FROM integrations WHERE id=? AND scope='personal' AND owner_user_id=?").get(id, row.user_id) as { id: string; name: string; google_app: string | null } | null : null
      if (c) return { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: 'connections', outcome: null,
        connection: { id: c.id, name: plainLabel(c.name), googleApp: c.google_app } }
    }
    let schedule: Pick<InboxNotification, 'schedule'> = {}
    if (row.event_type !== 'connection.reconnect') {
      // Metadata only: the stored result code, never the turn's error text. No turn = an admission skip (failed).
      const run = this.ctx.db.query('SELECT status,run_outcome,schedule_id FROM turns WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { status: string; run_outcome: string | null; schedule_id: string | null } | null
      outcome = run ? storedRunOutcome(run) : 'failed'
      const skipped = run ? null : this.ctx.db.query('SELECT schedule_id FROM schedule_outcomes WHERE id=? AND user_id=?').get(row.source_id, row.user_id) as { schedule_id: string } | null
      schedule = this.scheduleOf(row.user_id, run?.schedule_id ?? skipped?.schedule_id)
      const chat = this.ctx.db.query(`SELECT c.id,c.project_id,t.template_source_path FROM turns t JOIN chats c ON c.id=t.chat_id
        WHERE t.id=? AND t.user_id=? AND c.user_id=? AND c.deleted_at IS NULL`).get(row.source_id, row.user_id, row.user_id) as { id: string; project_id: string | null; template_source_path: string | null } | null
      if (chat) {
        try {
          const p = this.ctx.files.principal(row.user_id), rules = this.ctx.files.rules()
          if (chat.template_source_path) authorize(this.ctx.files.fx, rules, p, chat.template_source_path, 'read')
          if (chat.project_id) {
            const project = this.ctx.db.query('SELECT folder_path, trashed_with FROM projects WHERE id=?').get(chat.project_id) as { folder_path: string; trashed_with: string | null } | null
            if (!project) throw new Error('missing project')
            if (project.trashed_with !== null) throw new Error('project folder in the trash')
            authorize(this.ctx.files.fx, rules, p, project.folder_path, 'read')
          }
          for (const source of readScope(this.ctx.db, chat.id) ?? []) {
            if (source.type === 'user') { if (source.id !== row.user_id) throw new Error('private source revoked'); continue }
            if (source.type === 'integration') { const c = getIntegration(this.ctx.db, source.id); if (!c || !mayUseIntegration(this.ctx.db, c, row.user_id)) throw new Error('source revoked'); continue }
            if (source.type === 'drive_share') { if (!shareCovers(this.ctx.db, source.id, row.user_id)) throw new Error('source revoked'); continue }
            if (source.type === 'slack') { if (source.userId !== row.user_id) throw new Error('private source revoked'); continue }
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
      chatId, link: chatId ? 'chat' : row.event_type === 'connection.reconnect' ? 'connections' : null, outcome, ...schedule }
  }
  /** A scheduled run's task by its title, while the task is the person's and there (a deleted one: nothing, and the
   * Inbox says "a scheduled task"). The person's own words, read now and never stored with the notice; a push never
   * carries it (the lock screen's text is generic, text.ts). */
  private scheduleOf(userId: string, scheduleId: string | null | undefined): Pick<InboxNotification, 'schedule'> {
    if (!scheduleId) return {}
    const s = this.ctx.db.query('SELECT title FROM schedules WHERE id=? AND user_id=?').get(scheduleId, userId) as { title: string } | null
    const title = s ? plainLabel(s.title) : ''
    return title ? { schedule: { title } } : {}
  }
  /** `only: 'rooms'`: the conversation rows alone (a phone's 멘션·스레드, opened from 대화); `only: 'notices'`: the other
   * notices alone (활동's list beside the rail); paged the same way; the counts are the whole Inbox's either way. */
  list(userId: string, o: { cursor?: string; limit?: number; only?: 'rooms' | 'notices' }) {
    const cur = decodeCursor(o.cursor, ['t', 'id'])
    if (o.cursor && (!cur || !Number.isFinite(Date.parse(cur.t!)))) throw new HttpError('validation')
    if (!this.active(userId)) return { items: [], nextCursor: null, unreadCount: 0, roomUnreadCount: 0, noticeUnreadCount: 0 }
    const limit = Math.min(100, Math.max(1, o.limit ?? 30)), db = this.ctx.db, cutoff = this.cutoff()
    // newest first by sort_at: a notice's own time, a room row's its newest message's
    // a reply in a thread under a shared chat's answer is a conversation row (CHAT_THREAD_ROW): on 대화's 멘션·스레드
    // (`only: 'rooms'`), never with the app's own notices (`only: 'notices'`)
    const kind = o.only === 'rooms' ? `AND ${CHAT_THREAD_ROW}` : o.only === 'notices' ? `AND NOT ${CHAT_THREAD_ROW}` : ''
    const rows = db.query(`SELECT * FROM ${LISTED} WHERE user_id=? AND suppressed=0 AND created_at>=? ${kind}
      ${cur ? 'AND (sort_at<? OR (sort_at=? AND id<?))' : ''} ORDER BY sort_at DESC,id DESC LIMIT ?`)
      .all(...(cur ? [userId, cutoff, cur.t!, cur.t!, cur.id!, limit + 1] : [userId, cutoff, limit + 1])) as (Row & { sort_at: string })[]
    const rooms = roomRows(db, userId, cutoff)
    const listedRooms = o.only === 'notices' ? [] : rooms
    const after = (r: { sort_at: string; id: string }) => !cur || r.sort_at < cur.t! || (r.sort_at === cur.t! && r.id < cur.id!)
    const merged = [...rows, ...listedRooms.filter(after)].sort((a, b) => (a.sort_at === b.sort_at ? (a.id < b.id ? 1 : -1) : a.sort_at < b.sort_at ? 1 : -1)).slice(0, limit + 1)
    const selected = merged.slice(0, limit), last = selected.at(-1)
    const { n } = db.query(`SELECT COUNT(*) n FROM ${LISTED} WHERE user_id=? AND suppressed=0 AND read_at IS NULL AND created_at>=?`).get(userId, cutoff) as { n: number }
    // the conversation rows' part on its own: the rooms list counts those too, so a phone's 나 tab leaves them to 대화.
    // Not a room I muted: the 대화 tab does not count it (lib/rooms.ts totalUnread), so its row counts on 나 instead
    const counted = rooms.filter((r) => r.counted)
    // the unread chat-thread rows are conversation rows too: 대화's part, never 활동's
    const { t } = db.query(`SELECT COUNT(*) t FROM chat_thread_notices WHERE user_id=? AND suppressed=0 AND read_at IS NULL AND created_at>=?`).get(userId, cutoff) as { t: number }
    const roomUnreadCount = counted.filter((r) => !r.muted).length + t
    // a "shared with you" notice whose file no longer opens drops out once it is read (docs/decisions/20261120-file-share-gone-notice.md):
    // an unread one stays to say so once; the cursor is the rows', so the next page starts after it either way
    const items = selected.map(r => this.out(r)).filter((x) => !(x.eventType === 'file.shared' && x.fileShare?.gone && x.readAt))
    return { items, nextCursor: merged.length > limit && last ? encodeCursor({ t: last.sort_at, id: last.id }) : null, unreadCount: n + counted.length, roomUnreadCount, noticeUnreadCount: n - t }
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
    // a room notice's row in the Inbox is every unread notice of its place (rooms/inbox.ts): read together, at one time,
    // so they stay one row
    const row = db.query('SELECT 1 FROM room_notices WHERE id=? AND user_id=?').get(id, userId) ? roomRowOf(db, userId, id, this.cutoff()) : null
    const update = (table: string) => db.query(`UPDATE ${table} SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=? AND suppressed=0 AND created_at>=? RETURNING *`).get(...args) as Row | null
    let r: Row | null = null
    for (const table of NOTICE_TABLES) if ((r = update(table))) break
    if (!r) throw new HttpError('not_found')
    if (row && !row.read_at && row.group.ids.length > 1) db.query(`UPDATE room_notices SET read_at=? WHERE user_id=? AND read_at IS NULL AND id IN (${row.group.ids.map(() => '?').join(',')})`).run(args[0] as string, userId, ...row.group.ids)
    this.signal(userId)
    return this.out(r)
  }
  /** Activity's "Mark all as read" for a tab (activityTabHas, the page's own rule): All reads every unread notice of
   * mine (`only: 'rooms'`: the conversation rows alone, the phone's 멘션·스레드; `only: 'notices'`: the others alone,
   * 활동 beside the rail), the other tabs only the conversation
   * rows they show; also the ones not loaded yet. A conversation row reads as opening it does: its notices, and my place
   * in its room (a thread's: in the thread) moves to the row's newest message, as a notification's "Mark as read" does
   * (`room.seq`), so the room's unread count and the attention count follow; my other windows and devices hear it
   * through room.read / room.thread and notifications.changed. Nothing is deleted; a second call marks nothing. Returns
   * how many rows it marked. `rooms`: the rooms service (rooms/service.ts, which imports this one). */
  readAll(userId: string, o: { tab: ActivityTab; only?: 'rooms' | 'notices' }, rooms: RoomReader): { read: number } {
    if (!this.active(userId)) return { read: 0 }
    const db = this.ctx.db, cutoff = this.cutoff(), now = new Date().toISOString()
    const threads: { chatId: string; rootId: string }[] = []
    // one transaction, and the rooms' own per-row "notifications changed" signals held back: one signal at the end
    const read = rooms.hold(userId, () => db.transaction(() => {
      let n = 0
      if (o.tab === 'all' && o.only !== 'rooms') {
        for (const table of NOTICE_TABLES) {
          // the chat-thread rows are conversation rows: below
          if (table === 'room_notices' || table === 'chat_thread_notices') continue
          n += db.query(`UPDATE ${table} SET read_at=? WHERE user_id=? AND read_at IS NULL AND suppressed=0 AND created_at>=?`).run(now, userId, cutoff).changes
        }
      }
      // a thread under a shared chat's answer: read as the thread's own read does (chat/threads.ts markRead), my read
      // mark moved up to the notice's reply (never back)
      if (o.only !== 'notices') {
        const unread = db.query('SELECT * FROM chat_thread_notices WHERE user_id=? AND read_at IS NULL AND suppressed=0 AND created_at>=?').all(userId, cutoff) as (Row & { reply_id: string; chat_id: string })[]
        for (const row of unread) {
          if (o.tab !== 'all' && !activityTabHas(this.out(row), o.tab)) continue
          db.query('UPDATE chat_thread_notices SET read_at=? WHERE id=? AND read_at IS NULL').run(now, row.id)
          db.query('UPDATE chat_thread_follows SET last_read_id=? WHERE root_id=? AND user_id=? AND (last_read_id IS NULL OR last_read_id<?)').run(row.reply_id, row.source_id, userId, row.reply_id)
          db.query(`UPDATE chat_thread_push_deliveries SET state='cancelled', lease_until=NULL WHERE state IN ('pending','sending') AND notification_id=?`).run(row.id)
          threads.push({ chatId: row.chat_id, rootId: row.source_id })
          n++
        }
      }
      // `only: 'notices'` (활동 beside the rail): the conversation rows stay as they are (they are read in 대화)
      for (const row of o.only === 'notices' ? [] : roomRows(db, userId, cutoff)) {
        // All holds every row: no need to build what the row says
        if (row.read_at || (o.tab !== 'all' && !activityTabHas(this.out(row), o.tab))) continue
        const { roomId, place, to, ids } = row.group
        try { if (place) rooms.markThreadRead(userId, roomId, place, to); else rooms.markRead(userId, roomId, to) }
        catch { this.ctx.log.warn('room read place not moved') }
        db.query(`UPDATE room_notices SET read_at=? WHERE user_id=? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(now, userId, ...ids)
        n++
      }
      return n
    })())
    if (read) this.signal(userId)
    // my other windows hear each thread read, as the thread's own read tells them (chat/threads.ts markRead)
    for (const th of threads) {
      try { this.ctx.services.realtime.publish(userId, { type: 'chat.thread', data: { chatId: th.chatId, rootId: th.rootId, change: 'read', thread: threadSummaries(db, [th.rootId], userId).get(th.rootId) ?? null } }) }
      catch { this.ctx.log.warn('chat thread read not told') }
    }
    return { read }
  }
}
/** What readAll needs of the rooms service: moving my read place (never back). */
export interface RoomReader {
  markRead(userId: string, roomId: string, seq: number): unknown
  markThreadRead(userId: string, roomId: string, rootId: string, seq: number): unknown
  /** runs fn with my per-row "notifications changed" signals held back */
  hold<T>(userId: string, fn: () => T): T
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
/** True: the notice is new (its live toast may go); false: told before, or it could not be recorded. */
export function notifyDevEnv(ctx: AppContext, userId: string, event: DevEnvNoticeEvent, sourceId: string): boolean {
  try { return notificationsOf(ctx).devEnvNotice(userId, event, sourceId) }
  catch { ctx.log.warn('dev env notification recording failed'); return false }
}
export function notifyIntegrationRequest(ctx: AppContext, userId: string, requestId: string) {
  try { notificationsOf(ctx).integrationRequest(userId, requestId) }
  catch { ctx.log.warn('connection request notification recording failed') }
}
export function notifyResetLink(ctx: AppContext, userId: string, resetId: string) {
  try { notificationsOf(ctx).resetLinkMade(userId, resetId) }
  catch { ctx.log.warn('reset link notification recording failed') }
}
/** One hosting notice to each active owner (`admins: false`) or owner and admin. Never throws: the copy or the move
 * happened whether or not the notice could be recorded. */
export function notifyHosting(ctx: AppContext, event: HostingNoticeEvent, sourceId: string, o: { admins: boolean }) {
  try {
    const roles = o.admins ? "'owner', 'admin'" : "'owner'"
    const ids = (ctx.db.query(`SELECT id FROM users WHERE role IN (${roles}) AND status = 'active' AND deleted_at IS NULL`).all() as { id: string }[]).map((u) => u.id)
    for (const id of ids) notificationsOf(ctx).hostingNotice(id, event, sourceId)
  } catch { ctx.log.warn('hosting notification recording failed') }
}
/** The AI could not start on this server (chat/turn.ts engineStartFailed): one Inbox notice to each active owner and
 * admin per breakage, not per failed answer. A notice made since the last answer that worked means they were told
 * already; one that works arms it again. Never throws: the answer's own error is what matters. */
export function notifyEngineStartFailed(ctx: AppContext, turnId: string) {
  try {
    const ok = (ctx.db.query("SELECT MAX(ended_at) AS at FROM turns WHERE status = 'done'").get() as { at: string | null } | null)?.at ?? ''
    if (ctx.db.query('SELECT 1 FROM engine_start_notices WHERE created_at > ? LIMIT 1').get(ok)) return
    const ids = (ctx.db.query("SELECT id FROM users WHERE role IN ('owner', 'admin') AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((u) => u.id)
    const at = new Date().toISOString()
    for (const id of ids) notificationsOf(ctx).engineStartNotice(id, turnId, at)
  } catch { ctx.log.warn('engine start notification recording failed') }
}
/** The team's disk is filling (system/storage.ts checkAlert): one Inbox notice to each active owner and admin (never a
 * member or guest: they cannot free the space). The caller decides how often (once a day per threshold). Never throws:
 * the toast and the audit row happened anyway. */
export function notifyStorageFilling(ctx: AppContext, threshold: 80 | 95, percent: number, roomsBytes: number | null, at = new Date().toISOString()) {
  try {
    // a guest's users.role is 'member' (auth/guests.ts), so this is the owner and the admins only, as for the engine notice
    const ids = (ctx.db.query("SELECT id FROM users WHERE role IN ('owner', 'admin') AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((u) => u.id)
    for (const id of ids) notificationsOf(ctx).storageNotice(id, `${threshold}:${at}`, percent, roomsBytes, at)
  } catch { ctx.log.warn('storage notification recording failed') }
}
/** The owner or an admin (the guest-aware role: auth/guests.ts roleSql). */
function isStaff(db: AppContext['db'], userId: string): boolean {
  return !!db.query(`SELECT 1 FROM users WHERE id = ? AND ${roleSql()} IN ('owner', 'admin')`).get(userId)
}
export function notifyTeamJoined(ctx: AppContext, userIds: Iterable<string>, joinedUserId: string) {
  for (const userId of new Set(userIds)) {
    try { notificationsOf(ctx).teamJoined(userId, joinedUserId) }
    catch { ctx.log.warn('team join notification recording failed') }
  }
}
/** Who is told about, and handles, a request from someone with this role: the owners, and the admins when a member asks.
 * A guest's request is handled as a member's (owner decision 2026-11-14). The filter reads the stored role: a guest is
 * stored as 'member' (users.guest = 1), and only owners and admins are selected, so no guest is ever a handler. */
export function deletionHandlers(ctx: AppContext, requesterRole: string): string[] {
  const roles = requesterRole === 'member' || requesterRole === 'guest' ? "'owner', 'admin'" : "'owner'"
  return (ctx.db.query(`SELECT id FROM users WHERE role IN (${roles}) AND status = 'active' AND deleted_at IS NULL`).all() as { id: string }[]).map((u) => u.id)
}

export function notifyDeletionRequest(ctx: AppContext, handlerIds: Iterable<string>, requesterId: string) {
  for (const ownerId of new Set(handlerIds)) {
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
/** A template was made or its rule changed (templateId), or who it reaches may have changed for one person (userId: a
 * group joined, an account activated) or for many (neither: a group's members changed). Uncapped for one template or
 * person; a team-wide call does one batch and leaves the rest to the 30-second backstop. */
export function notifyTemplateOffers(ctx: AppContext, scope: { templateId?: string; userId?: string } = {}) {
  try { notificationsOf(ctx).offerTemplates({ ...scope, limit: scope.templateId || scope.userId ? 100_000 : OFFER_BATCH }) }
  catch { ctx.log.warn('template notices deferred') }
}
export function notifyDriveShareReconnect(ctx: AppContext, _shareId: string, sourceId: string) {
  try { notificationsOf(ctx).driveShareReconnect(sourceId) }
  catch { ctx.log.warn('drive share notice deferred') }
}
export function notifyTemplateReconnect(ctx: AppContext, userId: string, templateId: string, version: number) {
  try { notificationsOf(ctx).templateReconnect(userId, templateId, version) }
  catch { ctx.log.warn('template reconnect notice deferred') }
}
export function notifyTemplateLeft(ctx: AppContext, userId: string, templateId: string, connectionId: string) {
  try { notificationsOf(ctx).templateLeft(userId, templateId, connectionId) }
  catch { ctx.log.warn('template left notice deferred') }
}
/** A member asked to add an app: told to each owner and admin (one notice per person and app). */
export function notifyServiceRequested(ctx: AppContext, userIds: Iterable<string>, service: string) {
  for (const userId of new Set(userIds)) {
    try { notificationsOf(ctx).serviceRequested(userId, service) }
    catch { ctx.log.warn('app request notice deferred') }
  }
}
export function notifyServiceReady(ctx: AppContext, userId: string, requestId: string) {
  try { notificationsOf(ctx).serviceReady(userId, requestId) }
  catch { ctx.log.warn('app ready notice deferred') }
}
export function notifyServiceClosed(ctx: AppContext, userId: string, requestId: string) {
  try { notificationsOf(ctx).serviceClosed(userId, requestId) }
  catch { ctx.log.warn('app request closed notice deferred') }
}
export function notifyStoredKeyFiles(ctx: AppContext, userId: string) {
  try { notificationsOf(ctx).storedKeyFiles(userId) }
  catch { ctx.log.warn('stored key files notice deferred') }
}
export function syncServiceRequestNotices(ctx: AppContext) {
  try { notificationsOf(ctx).syncServiceRequests() }
  catch { ctx.log.warn('app request notices deferred') }
}
export function settleServiceRequestNotices(ctx: AppContext, service: string) {
  try { notificationsOf(ctx).settleServiceRequests(service) }
  catch { ctx.log.warn('app request notice not marked read') }
}
