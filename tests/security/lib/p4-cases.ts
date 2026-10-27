import type { Spec } from './cases'
import { USER_OF, type Who } from './world'

/** Configured OAuth flows have separate synthetic-provider tests. This permanent matrix also covers disabled setup. */
export const P4_SPECS: Record<string, Spec> = {
  frequentQuestions: { build: c => c.get('/api/questions/frequent?userId=alice'), scope: 'self' },
  popularSkills: { build: c => c.get('/api/skills/popular'), scope: 'self' },
  listScheduleTemplates: { build: c => c.get('/api/schedule-templates'), scope: 'self' },
  createScheduleFromTemplate: {
    build: c => c.post('/api/schedule-templates', { requestId: crypto.randomUUID(), templateId: 'daily-file-index', version: 1,
      sourcePath: 'shared', outputPath: `users/${USER_OF[c.label as Who] ?? 'nobody'}/reports`, time: '09:00' }), scope: 'self',
    check: (r, _w, who) => { if (r.status < 300 && r.json?.outputPath !== `users/${USER_OF[who]}/reports`) throw new Error('template output is not private to the caller') },
  },
  listNotifications: { build: c => c.get('/api/notifications?userId=alice'), scope: 'self' },
  getNotification: { build: c => c.get('/api/notifications/00000000-0000-7000-8000-000000000000'), scope: 'nobody' },
  markNotificationRead: { build: c => c.post('/api/notifications/00000000-0000-7000-8000-000000000000/read'), scope: 'nobody' },
  getNotificationPreferences: { build: c => c.get('/api/notification-preferences?userId=alice'), scope: 'self' },
  updateNotificationPreferences: { build: c => c.patch('/api/notification-preferences', { scheduleSuccess: false }), scope: 'self' },
  getPushSettings: { build: c => c.get('/api/push'), scope: 'self' },
  subscribePush: { build: c => c.post('/api/push/subscriptions', { consent: true, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-matrix', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }), scope: 'self' },
  updatePushSettings: { build: c => c.patch('/api/push', { enabled: false }), scope: 'self' },
  unsubscribePush: { build: c => c.del('/api/push/subscriptions/00000000-0000-7000-8000-000000000000'), scope: 'nobody' },
  myDriveConnection: { build: c => c.get('/api/integrations/google-drive?userId=alice'), scope: 'self' },
  authorizeDrive: { build: c => c.post('/api/integrations/google-drive/authorize', {}), scope: 'self' },
  driveFlow: { build: c => c.get('/api/integrations/google-drive/flows/00000000-0000-7000-8000-000000000000'), scope: 'nobody' },
  completeDriveFlow: { build: c => c.post('/api/integrations/google-drive/flows/00000000-0000-7000-8000-000000000000/complete', {}), scope: 'self' },
  cancelDriveFlow: { build: c => c.del('/api/integrations/google-drive/flows/00000000-0000-7000-8000-000000000000'), scope: 'nobody' },
  disconnectDrive: { build: c => c.del('/api/integrations/google-drive'), scope: 'self' },
}
// Callback state/session binding is exercised by c-drive-oauth and p4-route-access (static HTML never reflects input).
export const P4_RAW_COVERED = ['RAW GET CALLBACK_PATH']
