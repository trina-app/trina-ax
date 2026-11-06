import { z } from 'zod'
import { endpoint } from './endpoint'
import { ScheduleRunOutcome } from './schedules'
/** skillSuggestions: a suggestion to review, and the review result of an own suggestion (R2-SKILL-12) */
/** roomMessages: a DM message or an @mention in a room (docs/DECISIONS.md "대화방 v1"); older servers omit it */
export const NotificationPreferences = z.object({ scheduleSuccess: z.boolean(), scheduleFailure: z.boolean(), connectionReconnect: z.boolean(), skillSuggestions: z.boolean(), roomMessages: z.boolean().optional() })
export type NotificationPreferences = z.infer<typeof NotificationPreferences>
/** Events that can also go to OS push. Room notices (room.dm: a DM message, room.mention: an @mention) are kept in
 * room_notices with their own deliveries (room_push_deliveries); the rest in notification_inbox (push_deliveries). */
export const PushEventType = z.enum(['schedule.success', 'schedule.failure', 'connection.reconnect', 'room.dm', 'room.mention'])
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
 * "Templates"). */
export const NotificationEventType = z.enum([...PushEventType.options, 'skill.suggested', 'skill.reviewed', 'dev_env.job', 'dev_env.box', 'integration.request', 'onboarding.ai_request', 'team.joined', 'onboarding.first_run', 'account.deletion_request', 'integration.template', 'integration.template_reconnect'])
export type NotificationEventType = z.infer<typeof NotificationEventType>
export const InboxNotification = z.object({
  id: z.string(), eventType: NotificationEventType, sourceId: z.string(), code: NotificationEventType,
  createdAt: z.string(), readAt: z.string().nullable(), chatId: z.string().nullable(), link: z.enum(['chat', 'connections', 'skills', 'project', 'integrations', 'admin_credentials', 'room', 'admin_members']).nullable(),
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
  /** 'account.deletion_request' only (owners): who asked for their account to be deleted, by display name while the
   * account is there (null once it is deleted), and where the request is now: open (waits for the owner; link
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
  /** 'schedule.failure' only: the run did not start because it needs the person's own key for a template (named) they
   * have not connected, or whose key stopped working; older servers omit it */
  needsKey: z.object({ templateId: z.string(), name: z.string() }).optional(),
  /** 'room.dm' and 'room.mention' only, while the person is still in the room and the message is there: the room (link
   * 'room' opens /rooms/<id>) and who wrote it, by name. Never the message's text; older servers omit it */
  room: z.object({ id: z.string(), from: z.string().nullable() }).optional(),
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
  listNotifications: endpoint({ method: 'GET', path: '/api/notifications', auth: 'user', owner: 'B', query: z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), response: z.object({ items: z.array(InboxNotification), nextCursor: z.string().nullable(), unreadCount: z.number().int().nonnegative() }), summary: 'Own metadata-only inbox, retained for 30 days.' }),
  markNotificationRead: endpoint({ method: 'POST', path: '/api/notifications/:id/read', auth: 'user', owner: 'B', response: InboxNotification, summary: 'Mark an own notification read.' }),
  getNotificationPreferences: endpoint({ method: 'GET', path: '/api/notification-preferences', auth: 'user', owner: 'B', response: NotificationPreferences, summary: 'Own inbox event preferences. OS push opt-in is separate.' }),
  updateNotificationPreferences: endpoint({ method: 'PATCH', path: '/api/notification-preferences', auth: 'user', owner: 'B', body: NotificationPreferences.partial().strict(), response: NotificationPreferences, summary: 'Change own inbox event preferences.' }),
} as const
