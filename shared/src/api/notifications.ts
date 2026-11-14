import { z } from 'zod'
import { endpoint } from './endpoint'
import { IsoTime } from './common'
import { ScheduleRunOutcome } from './schedules'
import { QuietHours, RoomNotifyDefault } from './room-alerts'
import { RoomKind } from './rooms'
import { RoomAppKind, RoomAppPresetSeen } from './room-apps'
import { UserId } from '../ids'
import { RequestableService } from './service-requests'
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
  /** a push when an answer in my own AI chat needs me: it finished, failed, or the AI waits for me (a question or a
   * yes/no card) and I am not looking at that chat (docs/DECISIONS.md "AI 답변 알림"; default on). Older servers omit it. */
  chatAnswers: z.boolean().optional(),
  /** a push when someone shares a chat with me by name ("Chats shared with me", default on; docs/DECISIONS.md "Chats
   * shared with me: a push that names the sharer"). The Inbox row stays whatever it says. Older servers omit it. */
  chatShares: z.boolean().optional(),
  /** "Phone notifications only when I'm away" (docs/DECISIONS.md "Phone notifications when I'm away"): 'away' (default)
   * cancels a push to the phone app when, at the moment it would go, I am using Trina in a window (the computer showed
   * it; nothing is sent later); 'always' sends it as before. Older servers omit it (they always send). */
  phoneWhen: z.enum(['away', 'always']).optional(),
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
/** chat.answer_done: an answer in my own AI chat finished, failed or waits for me (a question or a yes/no card), for the
 * person who asked it only (chat_answer_notices with their own deliveries, chat_answer_push_deliveries; docs/DECISIONS.md
 * "AI 답변 알림"). Pushed only: never listed in the Inbox (the chat list's markers show these chats). */
/** chat.shared: someone shared a chat with me (chat_share_notices with their own deliveries,
 * chat_share_push_deliveries; docs/DECISIONS.md "Chats shared with me: a push that names the sharer"). Listed in the
 * Inbox always; pushed only for a share by name, while "Chats shared with me" (chatShares) is on. A group's people get
 * the Inbox row alone. */
/** room_app.paused: an app in a room the person manages reached the day's cap and paused (room_app_notices with their
 * own deliveries, room_app_push_deliveries, migration 352; docs/DECISIONS.md "Apps posting in rooms"). No setting of its
 * own: pushed while the notice is unread, the app still paused and the person still in its room. */
export const PushEventType = z.enum(['schedule.success', 'schedule.failure', 'connection.reconnect', 'room.dm', 'room.mention', 'owner.lead_joined', 'owner.reauth_locked', 'chat.answer_done', 'chat.shared', 'room_app.paused'])
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
 * when a password re-check of theirs locked after too many wrong tries, and a member's ask to add an app the team has
 * not set up (service_request_notices; shared/src/api/service-requests.ts): service.request to the owners and the
 * admins (one per app), service.ready to the member once they can connect it, and account.reset_link to a person when a password reset link
 * was made for their account, on the server or by an admin (reset_link_notices), and things done to the team from
 * outside it (hosting_notices): hosting.key_copied and hosting.exported to the owners when the hosting service copied
 * the AI connections' key or took a full export, relay.address_moved to the owners and admins when the relay stopped
 * taking this server's key because the team address was moved to another key, and account.deletion_due to a person whose
 * open account deletion request got its automatic date when this server started deleting by itself (account_deletion_due_notices),
 * and chat.shared to a person someone shared a chat with, by name or through a group (chat_share_notices), and room_app.paused to the people who manage an app in a room that paused for the day
 * (room_app_notices; a push too: PushEventType), and room_app.leaver to the people who may manage an app in a room
 * when someone who was shown its address can no longer manage it (room_app_leaver_notices, migration 352; docs/DECISIONS.md
 * "Apps posting in rooms"). */
export const NotificationEventType = z.enum([...PushEventType.options, 'skill.suggested', 'skill.reviewed', 'dev_env.job', 'dev_env.box', 'integration.request', 'onboarding.ai_request', 'team.joined', 'onboarding.first_run', 'account.deletion_request', 'integration.template', 'integration.template_reconnect', 'drive.share_reconnect', 'skills.merge_waiting', 'credential.change', 'owner.transferred', 'project.joined', 'service.request', 'service.ready', 'account.reset_link', 'hosting.key_copied', 'hosting.exported', 'relay.address_moved', 'account.deletion_due', 'room_app.leaver'])
export type NotificationEventType = z.infer<typeof NotificationEventType>
export const InboxNotification = z.object({
  id: z.string(), eventType: NotificationEventType, sourceId: z.string(), code: NotificationEventType,
  createdAt: z.string(), readAt: z.string().nullable(), chatId: z.string().nullable(), link: z.enum(['chat', 'connections', 'skills', 'project', 'integrations', 'admin_credentials', 'room', 'admin_members', 'admin_connectors', 'account_deletion']).nullable(),
  /** scheduled runs only: succeeded / finished with problems / failed (the inbox text follows it; older servers omit it) */
  outcome: ScheduleRunOutcome.nullable().optional(),
  /** 'schedule.success' and 'schedule.failure' for one task's run (not `review`), while the task is the person's and
   * there: its title, one plain line (plainLabel), so the Inbox says which task it was. Read when the notice is read,
   * never stored with it, and never in a push (the lock screen stays generic, server/src/notifications/text.ts). A
   * deleted task and older servers omit it: the app then says "a scheduled task". */
  schedule: z.object({ title: z.string() }).optional(),
  /** 'integration.request' only, while the request is there: the service's name and the host of its address (where the
   * member's key or sign-in would go); older servers omit it */
  request: z.object({ name: z.string(), host: z.string() }).optional(),
  /** 'onboarding.ai_request' only (owners): the member who asks for an AI connection, by display name; older servers omit it */
  requester: z.object({ name: z.string() }).optional(),
  /** 'project.joined' only (docs/DECISIONS.md "Project contents only for members"): who started to see the project (a
   * name while the account is there) and the project while the reader of the notice still sees it (link 'project') */
  projectJoined: z.object({ name: z.string().nullable(), project: z.object({ id: z.string(), name: z.string() }).nullable() }).optional(),
  /** 'onboarding.ai_request' only: true when the member tried to use Trina but it is not set up yet (the AI could not
   * start, POST /api/me/ai-not-ready/tell), not a wait for an AI connection; older servers omit it */
  notReady: z.literal(true).optional(),
  /** 'team.joined' only: the name of the person who joined through the team invite link, while the account is there;
   * older servers omit it. `guestPlace`: they joined as a guest, into this one room or project (its name; '' for a
   * group chat with no name, or when the reader is not in that place and is not the owner or an admin), not the team */
  joined: z.object({ name: z.string(), guestPlace: z.object({ kind: z.enum(['room', 'project']), name: z.string() }).optional() }).optional(),
  /** 'account.deletion_request' only (owners and admins): who asked for their account to be deleted, by display name while the
   * account is there (null once it is deleted), and where the request is now: open (waits for the owner or an admin; link
   * 'admin_members' opens that person in Admin › Members, sourceId is their id), cancelled (they took it back) or
   * handled (the account was deleted); dueAt: when the server deletes it by itself (absent from older servers); older
   * servers omit it */
  deletionRequest: z.object({ name: z.string().nullable(), state: z.enum(['open', 'cancelled', 'handled']), dueAt: IsoTime.nullable().optional() }).optional(),
  /** 'account.deletion_due' only (the person themselves): the date their account is deleted while the request is open
   * (link 'account_deletion' opens Settings › Profile › Delete account), null once it was cancelled or done */
  deletionDue: z.object({ dueAt: IsoTime.nullable() }).optional(),
  /** 'room_app.paused' only (the people who manage the app, docs/DECISIONS.md "Apps posting in rooms"): the app, its room
   * (link 'room' while I am still in it; roomId null else), the cap it reached, how many more were skipped that day and
   * whether it can be resumed now (paused, not resumed that day). The app's and the room's names are plain lines. Absent
   * once the app is removed, and from older servers */
  roomApp: z.object({
    appId: z.string(), name: z.string(), roomId: z.string().nullable(), roomKind: RoomKind.nullable(), roomName: z.string().nullable(),
    /** the app's kind (Google Forms counts responses); older servers omit it */
    kind: RoomAppKind.optional(),
    /** an Other app's service (its logo); older servers omit it */
    preset: RoomAppPresetSeen,
    day: z.string(), cap: z.number().int().positive(), skipped: z.number().int().nonnegative(), pausedUntil: IsoTime.nullable(), canResume: z.boolean(),
    /** the team's cap paused it (all the team's apps together reached it; `cap` is the team's then): nothing to resume
     * until `pausedUntil`, said in the team's `timeZone`. Older servers omit it */
    team: z.literal(true).optional(),
    timeZone: z.string().optional(),
  }).optional(),
  /** 'room_app.leaver' only (the people who may manage the app, docs/DECISIONS.md "Apps posting in rooms"): someone who
   * was shown the app's address (or a secret Trina made) left the room or the team, or is no longer an admin of a team
   * room, and still knows it ("Get a new address" in the app's settings). The app, its room (link 'room' while I am
   * still in it; roomId null else); the names are plain lines. Absent once the app is removed or got a new address, and
   * from older servers */
  roomAppLeaver: z.object({ appId: z.string(), name: z.string(), roomId: z.string().nullable(), roomKind: RoomKind.nullable(), roomName: z.string().nullable() }).optional(),
  /** 'onboarding.first_run' only (owners, during the 7-day team goal): who ran which team skill for the first time
   * (member null once the account is deleted; skill: its plain name), and how many people had run it then, of the
   * goal's target; older servers omit it */
  firstRun: z.object({ member: z.string().nullable(), skill: z.string(), runners: z.number().int().positive(), target: z.number().int().positive() }).optional(),
  /** 'integration.template' and 'integration.template_reconnect' only, while the template is there and still for this
   * person: its id and name (Settings › MCP opens it with ?template=<id>); older servers omit it */
  template: z.object({ id: z.string(), name: z.string() }).optional(),
  /** 'service.request' (the owners and the admins) and 'service.ready' (the member who asked): the app (Google Drive or a
   * Google app, shared/src/api/service-requests.ts). service.request: the newest member who asks, by display name
   * (null when none is left), how many others ask with them, and `open` while any request waits (the app opens its setup
   * in Admin › Connected apps); once none waits, who asked in the round that ended last, and `added` when it ended
   * because members can connect the app now. A viewer who is no longer an owner or admin gets the app only.
   * service.ready: the app, which they can connect now (its page, /connectors/<id>). Never an admin's name. Older
   * servers omit it */
  serviceRequest: z.object({
    service: RequestableService, name: z.string().nullable().optional(), others: z.number().int().nonnegative().optional(),
    open: z.boolean().optional(), added: z.literal(true).optional(),
  }).optional(),
  /** 'drive.share_reconnect' only (admins), while the share is there: its name (link 'admin_connectors' opens Google
   * Drive's page in Admin › Connectors); older servers omit it */
  driveShare: z.object({ id: z.string(), name: z.string() }).optional(),
  /** 'credential.change' only: who did what to the team's AI (the connection's name, or the engine's address and model;
   * never a token or key); older servers omit it. `action` is one of added, replaced, removed, disabled, reassigned, zero_limit, shared_on,
   * engine, personal_disabled, personal_removed, personal_login_stopped; a page that does not know one shows a generic line */
  credentialChange: z.object({
    who: z.string(), action: z.string(), subject: z.string(),
  }).optional(),
  /** 'account.reset_link' only: a password reset link was made for this account. `server`: made on the server itself
   * (mycel-account / mycel-ctl reset-link), else by `by` (the owner's or admin's name while their account is there,
   * null after); `open` while the link is unused, not replaced and not expired (changing the password ends it). Never
   * the token or the link. Older servers omit it */
  resetLink: z.object({ server: z.boolean(), by: z.string().nullable(), open: z.boolean() }).optional(),
  /** 'skills.merge_waiting' only (the owner, at the end of the welcome steps): how many skills wait to be merged into
   * team skills; link 'chat' opens the one merge chat (chatId); older servers omit it */
  merges: z.object({ n: z.number().int().positive() }).optional(),
  /** 'chat.shared' only (docs/DECISIONS.md "Chats shared with people and groups"; chat_share_notices): someone shared a
   * chat with me, by name or through a group. `name`: who shared it, by display name while their account is there;
   * `title`: the chat's title, read now and only while I still see the chat (link 'chat' then opens it); `gone`: I no
   * longer see it ("This chat is no longer shared with you": no title, no link). Never stored text. Older servers omit it */
  chatShared: z.object({ name: z.string().nullable(), title: z.string().nullable(), gone: z.literal(true).optional() }).optional(),
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
  /** with projectGone: the project is still there and the person (the owner or an admin) may add themselves; only its
   * members can use it since "Project contents only for members". The task is paused and starts again once they are a
   * member (docs/DECISIONS.md "Projects from before the update: one card, Add me to these"); older servers omit it */
  membersOnly: z.literal(true).optional(),
  /** 'schedule.failure' only: the task's save folder lapsed (moved, renamed, deleted, its permissions changed, or the
   * person's write access gone); its runs save in the person's own folder until they check it again on the Scheduled
   * page; older servers omit it */
  saveLapsed: z.literal(true).optional(),
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
  /** 'dev_env.job' only, while the person can see the project. The text stays in the job's own row, not in the inbox.
   * exitCode null: no exit code is known; note says why, in English. reason: why the job ended (timeout, oom, stopped,
   * disk, setting, expired, lost; older rows omit it). A job from a chat with no project has projectId and projectName
   * ''. 'dev_env.box' (a stop of the removed box runner) never has it. */
  devEnv: z.object({
    projectId: z.string(), projectName: z.string(),
    job: z.object({ name: z.string(), exitCode: z.number().int().nullable(), note: z.string(), tail: z.string(), reason: z.string().optional() }).optional(),
  }).optional(),
})
export type InboxNotification = z.infer<typeof InboxNotification>
/** Activity's tabs (web/src/pages/Activity.tsx). */
export const ActivityTab = z.enum(['all', 'dms', 'mentions', 'threads'])
export type ActivityTab = z.infer<typeof ActivityTab>
/** Which tabs a notice shows under besides All: a direct or group chat's under DMs, an @mention (or @everyone) under
 * Mentions, a reply in a thread under Threads (in a direct or group chat too). A notice of the app's own is under All
 * only. The page filters with it and the server marks a tab read with it (POST /api/notifications/read), so both follow
 * one rule. */
export function activityTabHas(item: Pick<InboxNotification, 'code' | 'room'>, tab: ActivityTab): boolean {
  if (tab === 'all') return true
  const room = item.room
  if (!room || (item.code !== 'room.dm' && item.code !== 'room.mention')) return false
  if (tab === 'dms') return room.kind === 'dm' || room.kind === 'group'
  if (tab === 'mentions') return item.code === 'room.mention' || room.reason === 'mention' || room.reason === 'everyone'
  return !!room.thread
}
/** GET /api/notifications: `unreadCount` counts every unread row; `roomUnreadCount` is its part that is conversation rows
 * (mentions, replies in threads I follow) of rooms I did not mute, which the rooms list counts too (a phone's 나 tab
 * leaves them to 대화); `noticeUnreadCount` the unread notices that are not conversation rows at all (the computer's 활동:
 * its list and its rail mark; older servers omit it). `only=rooms`: the conversation rows alone
 * (a phone's 멘션·스레드), `only=notices`: the other notices alone (활동's list beside the rail); the counts the same.
 * "Mark all as read" with `only=notices` reads those alone. */
export const NotificationsOnly = z.enum(['rooms', 'notices'])
export const NOTIFICATIONS = {
  getNotification: endpoint({ method: 'GET', path: '/api/notifications/:id', auth: 'user', owner: 'B', response: InboxNotification, summary: 'Read an own notification without marking read; current-access filtered and never cached.' }),
  listNotifications: endpoint({ method: 'GET', path: '/api/notifications', auth: 'user', owner: 'B', query: z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), only: NotificationsOnly.optional() }), response: z.object({ items: z.array(InboxNotification), nextCursor: z.string().nullable(), unreadCount: z.number().int().nonnegative(), roomUnreadCount: z.number().int().nonnegative().optional(), noticeUnreadCount: z.number().int().nonnegative().optional() }), summary: 'Own inbox, retained for 30 days: metadata, and for a room notice the first line of its message while the person may read it. only=rooms: the conversation rows alone; only=notices: the other notices alone.' }),
  markAllNotificationsRead: endpoint({ method: 'POST', path: '/api/notifications/read', auth: 'user', owner: 'B', body: z.object({ tab: ActivityTab, only: NotificationsOnly.optional() }).strict(), response: z.object({ read: z.number().int().nonnegative() }), summary: 'Mark every unread own notification of an Activity tab read (only=rooms: the conversation rows alone; only=notices: the other notices alone); a conversation row also moves my read place in its room or thread to its newest message. Returns how many rows it marked.' }),
  markNotificationRead: endpoint({ method: 'POST', path: '/api/notifications/:id/read', auth: 'user', owner: 'B', response: InboxNotification, summary: 'Mark an own notification read.' }),
  getNotificationPreferences: endpoint({ method: 'GET', path: '/api/notification-preferences', auth: 'user', owner: 'B', response: NotificationPreferences, summary: 'Own inbox event preferences. OS push opt-in is separate.' }),
  updateNotificationPreferences: endpoint({ method: 'PATCH', path: '/api/notification-preferences', auth: 'user', owner: 'B', body: NotificationPreferences.partial().strict(), response: NotificationPreferences, summary: 'Change own inbox event preferences and room notification settings (room default, thread replies, quiet hours).' }),
} as const
