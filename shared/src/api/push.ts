import { z } from 'zod'
import { endpoint, empty } from './endpoint'
import { PushEventType } from './notifications'
export const PushSettings = z.object({ configured: z.boolean(), enabled: z.boolean(), publicKey: z.string().nullable(), subscriptionId: z.string().nullable(),
  // Older servers omit display text; keep settings usable during an upgrade or rollback.
  messages: z.object({ title: z.string(), bodies: z.record(PushEventType, z.string()) }).optional(),
  // The phone app (push-token-v1): whether this server can reach the push gateway, and this session's device.
  // gateway: the host phone tokens go through (owners and admins see it in Settings › Notifications); null = off.
  native: z.object({ available: z.boolean(), deviceId: z.string().nullable(), gateway: z.string().nullable().optional() }).optional(),
  /** the person turned push off: the phone app does not register again by itself */
  optedOut: z.boolean().optional(),
})
export const PushSubscriptionInput = z.object({ consent: z.literal(true), endpoint: z.string().min(1).max(4096), keys: z.object({ p256dh: z.string().min(1).max(128), auth: z.string().min(1).max(64) }).strict() }).strict()
/** The phone's own APNs (hex) / FCM token, as the app's bridge hands it to the signed-in page. */
export const PushDeviceInput = z.object({ consent: z.literal(true), platform: z.enum(['ios', 'android']), environment: z.enum(['sandbox', 'production']), token: z.string().min(32).max(3000) }).strict()
/** The removal key the app got at registration (base64url, 32 bytes): proof enough to drop that one device. */
export const PushDeviceRemoveInput = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
export const PUSH = {
  getPushSettings: endpoint({ method: 'GET', path: '/api/push', auth: 'user', owner: 'B', response: PushSettings, summary: 'Own push opt-in and current-session binding; disabled until the server is configured.' }),
  subscribePush: endpoint({ method: 'POST', path: '/api/push/subscriptions', auth: 'user', owner: 'B', body: PushSubscriptionInput, response: z.object({ id: z.string() }), summary: 'Explicitly consent to an encrypted push subscription bound to this login session.' }),
  updatePushSettings: endpoint({ method: 'PATCH', path: '/api/push', auth: 'user', owner: 'B', body: z.object({ enabled: z.boolean(), consent: z.literal(true).optional() }).strict().refine(v => !v.enabled || v.consent === true), response: PushSettings, summary: 'Own opt-in preference; turning off removes own subscriptions and queued deliveries.' }),
  unsubscribePush: endpoint({ method: 'DELETE', path: '/api/push/subscriptions/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Remove an own current-session subscription.' }),
  registerPushDevice: endpoint({ method: 'POST', path: '/api/push/devices', auth: 'user', owner: 'B', body: PushDeviceInput, response: z.object({ id: z.string(), removeKey: z.string() }), summary: 'The phone app registers its device token for this login session; delivered through the push gateway. Returns a key the app keeps to remove the device later.' }),
  removePushDevice: endpoint({ method: 'POST', path: '/api/push/devices/:id/remove', auth: 'public', owner: 'B', body: PushDeviceRemoveInput, response: empty, status: 204, summary: 'The phone app removes its device when the person switches team, with the key it got at registration (no session needed; always 204).' }),
  unregisterPushDevice: endpoint({ method: 'DELETE', path: '/api/push/devices/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Remove this session\'s phone app device.' }),
} as const
