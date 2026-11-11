import type { Spec } from './cases'
import { USER_OF, type Who } from './world'

/** Configured OAuth flows have separate synthetic-provider tests. This permanent matrix also covers disabled setup. */
export const P4_SPECS: Record<string, Spec> = {
  frequentQuestions: { build: c => c.get('/api/questions/frequent?userId=alice'), scope: 'self' },
  oftenAsked: { build: c => c.get('/api/questions/often-asked?userId=alice&groupId=marketing'), scope: 'self' },
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
  updateNotificationPreferences: { build: c => c.patch('/api/notification-preferences', { scheduleSuccess: false, roomLevel: 'direct', roomThreadReplies: true, quietHours: { on: false, start: '22:00', end: '08:00', weekends: false } }), scope: 'self' },
  getPushSettings: { build: c => c.get('/api/push'), scope: 'self' },
  subscribePush: { build: c => c.post('/api/push/subscriptions', { consent: true, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-matrix', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }), scope: 'self' },
  updatePushSettings: { build: c => c.patch('/api/push', { enabled: false }), scope: 'self' },
  unsubscribePush: { build: c => c.del('/api/push/subscriptions/00000000-0000-7000-8000-000000000000'), scope: 'nobody' },
  registerPushDevice: { build: c => c.post('/api/push/devices', { consent: true, platform: 'ios', environment: 'production', token: 'ab'.repeat(32) }), scope: 'self' },
  unregisterPushDevice: { build: c => c.del('/api/push/devices/00000000-0000-7000-8000-000000000000'), scope: 'nobody' },
  // public by design (the app removes its device after a team switch, without the old team's session); 204 for anyone
  removePushDevice: { build: c => c.post('/api/push/devices/00000000-0000-7000-8000-000000000000/remove', { key: 'A'.repeat(43) }), scope: 'byLevel' },
  // public by design (the iPhone's notification extension, with the label key; no session): {} for every failure
  labelPushDevice: { build: c => c.post('/api/push/devices/00000000-0000-7000-8000-000000000000/label', { key: 'A'.repeat(43), notificationId: 'n-1' }), scope: 'byLevel' },
  myDriveConnection: { build: c => c.get('/api/integrations/google-drive?userId=alice'), scope: 'self' },
  authorizeDrive: { build: c => c.post('/api/integrations/google-drive/authorize', {}), scope: 'self' },
  driveFlow: { build: c => c.get('/api/integrations/google-drive/flows/00000000-0000-7000-8000-000000000000'), scope: 'nobody' },
  completeDriveFlow: { build: c => c.post('/api/integrations/google-drive/flows/00000000-0000-7000-8000-000000000000/complete', {}), scope: 'self' },
  cancelDriveFlow: { build: c => c.del('/api/integrations/google-drive/flows/00000000-0000-7000-8000-000000000000'), scope: 'nobody' },
  disconnectDrive: { build: c => c.del('/api/integrations/google-drive'), scope: 'self' },
  // Admin › App connectors: setting up Google (admins only; this world has no public address, so a 409 after the check)
  driveAdminStatus: { build: c => c.get('/api/admin/google-drive'), scope: 'byLevel' },
  setDriveClient: { build: c => c.put('/api/admin/google-drive/client', { clientId: 'matrix-client', clientSecret: 'matrix-secret' }), scope: 'byLevel' },
  // Drives shared with the team and the members' switch (admins only; c-drive-shares covers a configured server)
  setDriveMembers: { build: c => c.put('/api/admin/google-drive/members', { on: false }), scope: 'byLevel' },
  // Gmail, Calendar, Docs and Sheets (routes/google-apps.ts): own connection only; flows belong to the session that started them
  myGoogleApps: { build: c => c.get('/api/integrations/google-apps?userId=alice'), scope: 'self' },
  authorizeGoogleApp: { build: c => c.post('/api/integrations/google-apps/gmail/authorize', {}), scope: 'self' },
  googleAppFlow: { build: c => c.get('/api/integrations/google-apps/gmail/flows/00000000-0000-7000-8000-000000000000'), scope: 'nobody' },
  completeGoogleAppFlow: { build: c => c.post('/api/integrations/google-apps/gmail/flows/00000000-0000-7000-8000-000000000000/complete', {}), scope: 'nobody' },
  cancelGoogleAppFlow: { build: c => c.del('/api/integrations/google-apps/gmail/flows/00000000-0000-7000-8000-000000000000'), scope: 'nobody' },
  updateGoogleApp: { build: c => c.patch('/api/integrations/google-apps/gmail', { writePolicy: 'ask' }), scope: 'self' },
  disconnectGoogleApp: { build: c => c.del('/api/integrations/google-apps/gmail'), scope: 'self' },
  googleAppsAdminStatus: { build: c => c.get('/api/admin/google-apps'), scope: 'byLevel' },
  setGoogleAppClient: { build: c => c.put('/api/admin/google-apps/gmail/client', { clientId: 'matrix-client', clientSecret: 'matrix-secret' }), scope: 'byLevel' },
  setGoogleAppMembers: { build: c => c.put('/api/admin/google-apps/gmail/members', { on: true }), scope: 'byLevel' },
  listDriveShares: { build: c => c.get('/api/admin/google-drive/shares'), scope: 'byLevel' },
  authorizeDriveShare: { build: c => c.post('/api/admin/google-drive/shares/authorize', {}), scope: 'byLevel' },
  completeDriveShareFlow: { build: c => c.post('/api/admin/google-drive/shares/flows/00000000-0000-7000-8000-000000000000/complete', {}), scope: 'byLevel' },
  driveShareFolders: { build: c => c.get('/api/admin/google-drive/shares/00000000-0000-7000-8000-000000000000/folders'), scope: 'byLevel' },
  updateDriveShare: { build: c => c.patch('/api/admin/google-drive/shares/00000000-0000-7000-8000-000000000000', { name: 'Matrix Drive' }), scope: 'byLevel' },
  stopDriveShare: { build: c => c.del('/api/admin/google-drive/shares/00000000-0000-7000-8000-000000000000'), scope: 'byLevel' },
}
// Callback state/session binding is exercised by c-drive-oauth and p4-route-access (static HTML never reflects input).
export const P4_RAW_COVERED = ['RAW GET CALLBACK_PATH']
