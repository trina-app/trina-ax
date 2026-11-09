import { z } from 'zod'
import { endpoint } from './endpoint'
import { ScheduleRunOutcome } from './schedules'
import { QuietHours, RoomNotifyDefault } from './room-alerts'
import { RoomKind } from './rooms'
import { UserId } from '../ids'
/** skillSuggestions: a suggestion to review, and the review result of an own suggestion (R2-SKILL-12) */
/** Rooms (docs/DECISIONS.md "대화방 알림 설정", room-alerts.ts): roomLevel is my default for rooms without a level of
 * their own (direct: every message of 1:1 and group chats and what mentions me elsewhere; all: every message; none:
 * nothing), roomThreadReplies whether replies in threads I follow alert me, quietHours when nothing pushes or rings (the
 * team's time zone). roomMessages is the older apps' one switch: false is roomLevel 'none', true brings 'none' back to
 * 'direct' (roomLevel wins when both are sent). Older servers omit the room fields (roomMessages only, or nothing). */
export const NotificationPreferences = z.object({
  scheduleSuccess: z.boolean(), scheduleFailure: z.boolean(), connectionReconnect: z.boolean(), skillSuggestions: z.boolean(),
  roomMessages: z.boolean().optional(),
  roomLevel: RoomNotifyDefault.optional(),
  roomThreadReplies: z.boolean().optional(),
  /** a room notification on a device (a push, the desktop app) shows the message's first line (default on); off: who
   * and where only, with the generic line. Older servers omit it (they never show the text). */
  messagePreview: z.boolean().optional(),
  quietHours: QuietHours.optional(),
})
export type NotificationPreferences = z.infer<typeof NotificationPreferences>
/** A name or line from people (a person's or a room's name, a message's first line) made safe to show in one line of the
 * Inbox or a notification on a device: no control or format characters (bidirectional overrides and isolates, zero-width
 * spaces, the byte order mark, …; the zero-width joiner of emoji stays), no line breaks, spaces made single, at most
 * `max` characters (then "…"). The app also shows such text inside <bdi>. */
export function plainLabel(s: string, max = 80): string {
  const line = s.replace(/(?!\u200d)\p{Cf}/gu, '').replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : line
}
/** Events that can also go to OS push. Room notices (room.dm: a message for me, by the room's level: a DM or group chat
 * message, any message of a room at 모든 메시지, a reply in a thread I follow; room.mention: an @mention) are kept in
 * room_notices with their own deliveries (room_push_deliveries); the rest in notification_inbox (push_deliveries). */
/** owner.lead_joined: someone joined with the owner's lead link; owner.reauth_locked: the owner's password re-check
 * locked after too many wrong tries (docs/DECISIONS.md "W6"; handover_notices with their own deliveries,
 * handover_push_deliveries): no setting of their own, the owner may be away for days, and a note left only in the app
 * would reach the very session that may be stolen. */
export const PushEventType = z.enum(['schedule.success', 'schedule.failure', 'connection.reconnect', 'room.dm', 'room.mention', 'owner.lead_joined', 'owner.reauth_locked'])
/** The room notices among them (server/src/rooms/notices.ts). */
export const ROOM_PUSH_EVENTS = ['room.dm', 'room.mention'] as const
export type PushEventType = z.infer<typeof PushEventType>
/** Skill suggestion notices are inbox only (table skill_notices), and so are dev environment notices (dev_env_notices),
 * an admin's request to connect a service as one's own connection (integration_request_notices), a member's request
 * for an AI connection (onboarding_notices) and, for the owners, someone who joined through the team invite link
 * (team_join_notices; shared/src/api/team-links.ts), and during the 7-day team goal a member's first run of a team skill
 * (onboarding_goal_notices; shared/src/api/onboarding-goal.ts), for the owners a person who asks for their account
 * to be deleted (account_deletion_notices; shared/src/api/account-deletion.ts), and a connection template an admin
 * shared with the person or whose address or sign-in changed (integration_template_notices; docs/INTEGRATIONS.md
 * "Templates"), and for admins a Drive shared with the team that stopped working and needs a new sign-in
 * (drive_share_notices; docs/GOOGLE-DRIVE.md "Sharing a Drive with the team"), and for the owner at the end of the
 * welcome steps the skills to merge that waited for it (skill_merge_notices; docs/DECISIONS.md "W5"), and a change to the team's AI an admin made
 * (told to the owners) or to a member's own connection (told to that member; credential_change_notices), and the
 * handover's (docs/DECISIONS.md "W6"; handover_notices): owner.lead_joined to the owner when someone joins with their
 * lead link, owner.transferred to the new owner, the old owner and the other admins, owner.reauth_locked to the owner
 * when a password re-check of theirs locked after too many wrong tries. */
export const NotificationEventType = z.enum([...PushEventType.options, 'skill.suggested', 'skill.reviewed', 'dev_env.job', 'dev_env.box', 'integration.request', 'onboarding.ai_request', 'team.joined', 'onboarding.first_run', 'account.deletion_request', 'integration.template', 'integration.template_reconnect', 'drive.share_reconnect', 'skills.merge_waiting', 'credential.change', 'owner.transferred'])
export type NotificationEventType = z.infer<typeof NotificationEventType>
export const InboxNotification = z.object({
  id: z.string(), eventType: NotificationEventType, sourceId: z.string(), code: NotificationEventType,
  createdAt: z.string(), readAt: z.string().nullable(), chatId: z.string().nullable(), link: z.enum(['chat', 'connections', 'skills', 'project', 'integrations', 'admin_credentials', 'room', 'admin_members', 'admin_connectors']).nullable(),
  /** scheduled runs only: succeeded / finished with problems / failed (the inbox text follows it; older servers omit it) */
  outcome: ScheduleRunOutcome.nullable().optional(),
  /** 'integration.request' only, while the request is there: the service's name and the host of its address (where the
   * member's key or sign-in would go); older servers omit it */
  request: z.object({ name: z.string(), host: z.string() }).optional(),
  /** 'onboarding.ai_request' only (owners): the member who asks for an AI connection, by display name; older servers omit it */
  requester: z.object({ name: z.string() }).optional(),
  /** 'team.joined' only: the name of the person who joined through the team invite link, while the account is there;
   * older servers omit it */
  joined: z.object({ name: z.string() }).optional(),
  /** 'account.deletion_request' only (owners and admins): who asked for their account to be deleted, by display name while the
   * account is there (null once it is deleted), and where the request is now: open (waits for the owner or an admin; link
   * 'admin_members' opens that person in Admin › Members, sourceId is their id), cancelled (they took it back) or
   * handled (the account was deleted); older servers omit it */
  deletionRequest: z.object({ name: z.string().nullable(), state: z.enum(['open', 'cancelled', 'handled']) }).optional(),
  /** 'onboarding.first_run' only (owners, during the 7-day team goal): who ran which team skill for the first time
   * (member null once the account is deleted; skill: its plain name), and how many people had run it then, of the
   * goal's target; older servers omit it */
  firstRun: z.object({ member: z.string().nullable(), skill: z.string(), runners: z.number().int().positive(), target: z.number().int().positive() }).optional(),
  /** 'integration.template' and 'integration.template_reconnect' only, while the template is there and still for this
   * person: its id and name (Settings › MCP opens it with ?template=<id>); older servers omit it */
  template: z.object({ id: z.string(), name: z.string() }).optional(),
  /** 'drive.share_reconnect' only (admins), while the share is there: its name (link 'admin_connectors' opens Google
   * Drive's page in Admin › Connectors); older servers omit it */
  driveShare: z.object({ id: z.string(), name: z.string() }).optional(),
  /** 'credential.change' only: who did what to the team's AI (the connection's name, or the engine's address and model;
   * never a token or key); older servers omit it. `action` is one of added, replaced, removed, disabled, reassigned, zero_limit, shared_on,
   * engine, personal_disabled, personal_removed, personal_login_stopped; a page that does not know one shows a generic line */
  credentialChange: z.object({
    who: z.string(), action: z.string(), subject: z.string(),
  }).optional(),
  /** 'skills.merge_waiting' only (the owner, at the end of the welcome steps): how many skills wait to be merged into
   * team skills; link 'chat' opens the one merge chat (chatId); older servers omit it */
  merges: z.object({ n: z.number().int().positive() }).optional(),
  /** 'skill.suggested' for a batch of skill folders a member sent (docs/DECISIONS.md "MC"; for the owners and admins):
   * who sent it, while their account is there, and how many skills it held. "민준 님이 스킬 2개를 팀에 올리자고 했어요";
   * the link opens Skills › 검토 at that person. Never a skill's name. Older servers omit it */
  contribution: z.object({ name: z.string().nullable(), n: z.number().int().positive() }).optional(),
  /** 'schedule.failure' only: the run did not start because it needs the person's own key for a template (named) they
   * have not connected, or whose key stopped working; older servers omit it */
  needsKey: z.object({ templateId: z.string(), name: z.string() }).optional(),
  /** 'schedule.failure' only: the run did not start because its owner no longer sees the task's project (its folder's
   * access was taken away, or it is in the trash); older servers omit it */
  projectGone: z.literal(true).optional(),
  /** 'room.dm' and 'room.mention' only, while the person is still in the room and may read the message: the room (link
   * 'room' opens /rooms/<id>), who wrote it, by name, and for a reply in a thread the thread's root (/rooms/<id>/t/<thread>);
   * older servers omit it. The rest says where and why (docs/DECISIONS.md "알림함의 대화 알림"; older servers omit each,
   * the app then falls back to the line above). In the Inbox's list a row stands for one place (a room's timeline, or a
   * thread) and what is unread there for me (or, once read, what was read together): how many messages (`count`) from
   * how many people (`people`), its newest message's writer (`from`, `fromId`, `ai`), first line (`preview`, ≤ 200
   * characters, '' for one with only files, then `files`) and time (`at`), and the message to open it at (`message`: the
   * first of them, the first unread one while unread). Names and the line are one plain line (plainLabel). The kind and
   * name of the room (name null: a DM, or a group chat without a name of its own); the reason (the strongest of the row:
   * mention, everyone ("@전체"), reply, message). `preview` in the Inbox's list, and in the single notice a push opens
   * only while the person's messagePreview is on (the notification's body; never for a private message); `label`
   * ("민준 · #마케팅 › 스레드", a DM "민준", in the person's language) only in the single notice a push opens, for the
   * notification's title. */
  room: z.object({
    id: z.string(), from: z.string().nullable(), thread: z.string().optional(),
    kind: RoomKind.optional(),
    name: z.string().nullable().optional(),
    reason: z.enum(['mention', 'everyone', 'reply', 'message']).optional(),
    message: z.string().optional(),
    fromId: z.string().nullable().optional(),
    ai: z.literal(true).optional(),
    preview: z.string().optional(),
    files: z.number().int().nonnegative().optional(),
    count: z.number().int().positive().optional(),
    people: z.number().int().positive().optional(),
    at: z.string().optional(),
    label: z.string().optional(),
    /** the message's place in its room (the single notice a push opens only): a notification's "Mark as read" moves my
     * read position there (markRoomRead, or markRoomThreadRead for a reply in a thread). Older servers omit it. */
    seq: z.number().int().nonnegative().optional(),
  }).optional(),
  /** The handover's notices (docs/DECISIONS.md "W6"); older servers omit it.
   * lead_joined ('owner.lead_joined', the owner who flagged the invite): the owner's own words for whom the link was
   * (`leadFor`) beside the joiner's account (name, username, null once deleted) and the join time; `open` while it
   * still holds (the joiner is active, the flag stands, I am still the owner): the row's [넘기기] opens the confirm
   * from this notice, never from an address.
   * transferred ('owner.transferred'): `me` from (I handed it over), to (I am the new owner) or other (an admin); from
   * and to by name while their accounts are there; `removable` (for me = to while I am the owner): the old owner is an
   * active admin I may disable ([내보내기]); `setupUnfinished` (me = to): the welcome steps wait for me; `recovery`
   * hosted: the hosting account can still reset passwords; `ended`: what the old owner ended at the transfer; `pending`:
   * what is still to end.
   * reauth_locked ('owner.reauth_locked', the owner): a password re-check of the owner (팀장 넘기기, updates, restore,
   * the current password …) locked after 5 wrong tries in 15 minutes; also pushed. */
  handover: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('lead_joined'), leadFor: z.string(), user: z.object({ id: UserId, name: z.string(), username: z.string() }).nullable(), joinedAt: z.string(), open: z.boolean() }),
    z.object({
      kind: z.literal('transferred'), me: z.enum(['from', 'to', 'other']),
      from: z.object({ id: UserId, name: z.string() }).nullable(), to: z.object({ id: UserId, name: z.string() }).nullable(),
      removable: z.boolean(), setupUnfinished: z.boolean(), recovery: z.enum(['hosted']).nullable(),
      ended: z.object({ teamAi: z.number().int().nonnegative(), driveShares: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), connections: z.number().int().nonnegative().optional() }),
      /** me = to while I am the owner: what the old owner asked to end and is not ended yet (a failure, or the server
       * stopped before it could); the row's [끊기] sends POST /api/admin/handover/end-pending */
      pending: z.array(z.object({ kind: z.enum(['team_ai', 'drive_share', 'team_connection']), id: z.string(), label: z.string() })).optional(),
    }),
    z.object({ kind: z.literal('reauth_locked') }),
  ]).optional(),
  /** 'schedule.failure' only: scheduled tasks nobody confirmed were paused until their owner checks them again
   * (Settings › Scheduled tasks, "다시 확인"); older servers omit it */
  review: z.boolean().optional(),
  /** 'dev_env.job' and 'dev_env.box' only, while the person can read the project folder, and 'dev_env.box' for an admin too.
   * The text stays in the job's own row, not in the inbox. exitCode null: no exit code is known; note says why, in
   * English, from boxd. reason: why the job ended (srt runner: timeout, oom, stopped, disk, setting, expired, lost; older
   * rows and the box omit it). stopCode: why the box stopped. A job of the srt runner from a chat with no project has
   * projectId and projectName ''. */
  devEnv: z.object({
    projectId: z.string(), projectName: z.string(),
    job: z.object({ name: z.string(), exitCode: z.number().int().nullable(), note: z.string(), tail: z.string(), reason: z.string().optional() }).optional(),
    stopCode: z.string().optional(),
  }).optional(),
})
export type InboxNotification = z.infer<typeof InboxNotification>
export const NOTIFICATIONS = {
  getNotification: endpoint({ method: 'GET', path: '/api/notifications/:id', auth: 'user', owner: 'B', response: InboxNotification, summary: 'Read an own notification without marking read; current-access filtered and never cached.' }),
  listNotifications: endpoint({ method: 'GET', path: '/api/notifications', auth: 'user', owner: 'B', query: z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), response: z.object({ items: z.array(InboxNotification), nextCursor: z.string().nullable(), unreadCount: z.number().int().nonnegative() }), summary: 'Own inbox, retained for 30 days: metadata, and for a room notice the first line of its message while the person may read it.' }),
  markNotificationRead: endpoint({ method: 'POST', path: '/api/notifications/:id/read', auth: 'user', owner: 'B', response: InboxNotification, summary: 'Mark an own notification read.' }),
  getNotificationPreferences: endpoint({ method: 'GET', path: '/api/notification-preferences', auth: 'user', owner: 'B', response: NotificationPreferences, summary: 'Own inbox event preferences. OS push opt-in is separate.' }),
  updateNotificationPreferences: endpoint({ method: 'PATCH', path: '/api/notification-preferences', auth: 'user', owner: 'B', body: NotificationPreferences.partial().strict(), response: NotificationPreferences, summary: 'Change own inbox event preferences and room notification settings (room default, thread replies, quiet hours).' }),
} as const
