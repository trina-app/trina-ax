import { z } from 'zod'
import { endpoint } from './endpoint'
import { ScheduleRunOutcome } from './schedules'
/** skillSuggestions: a suggestion to review, and the review result of an own suggestion (R2-SKILL-12) */
export const NotificationPreferences = z.object({ scheduleSuccess: z.boolean(), scheduleFailure: z.boolean(), connectionReconnect: z.boolean(), skillSuggestions: z.boolean() })
export type NotificationPreferences = z.infer<typeof NotificationPreferences>
/** Events that can also go to OS push (push_deliveries refers to notification_inbox only). */
export const PushEventType = z.enum(['schedule.success', 'schedule.failure', 'connection.reconnect'])
export type PushEventType = z.infer<typeof PushEventType>
/** Skill suggestion notices are inbox only (table skill_notices). */
export const NotificationEventType = z.enum([...PushEventType.options, 'skill.suggested', 'skill.reviewed'])
export type NotificationEventType = z.infer<typeof NotificationEventType>
export const InboxNotification = z.object({
  id: z.string(), eventType: NotificationEventType, sourceId: z.string(), code: NotificationEventType,
  createdAt: z.string(), readAt: z.string().nullable(), chatId: z.string().nullable(), link: z.enum(['chat', 'connections', 'skills']).nullable(),
  /** scheduled runs only: succeeded / finished with problems / failed (the inbox text follows it; older servers omit it) */
  outcome: ScheduleRunOutcome.nullable().optional(),
})
export type InboxNotification = z.infer<typeof InboxNotification>
export const NOTIFICATIONS = {
  getNotification: endpoint({ method: 'GET', path: '/api/notifications/:id', auth: 'user', owner: 'B', response: InboxNotification, summary: 'Read an own notification without marking read; current-access filtered and never cached.' }),
  listNotifications: endpoint({ method: 'GET', path: '/api/notifications', auth: 'user', owner: 'B', query: z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), response: z.object({ items: z.array(InboxNotification), nextCursor: z.string().nullable(), unreadCount: z.number().int().nonnegative() }), summary: 'Own metadata-only inbox, retained for 30 days.' }),
  markNotificationRead: endpoint({ method: 'POST', path: '/api/notifications/:id/read', auth: 'user', owner: 'B', response: InboxNotification, summary: 'Mark an own notification read.' }),
  getNotificationPreferences: endpoint({ method: 'GET', path: '/api/notification-preferences', auth: 'user', owner: 'B', response: NotificationPreferences, summary: 'Own inbox event preferences. OS push opt-in is separate.' }),
  updateNotificationPreferences: endpoint({ method: 'PATCH', path: '/api/notification-preferences', auth: 'user', owner: 'B', body: NotificationPreferences.partial().strict(), response: NotificationPreferences, summary: 'Change own inbox event preferences.' }),
} as const
