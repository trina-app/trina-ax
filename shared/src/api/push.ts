import { z } from 'zod'
import { endpoint, empty } from './endpoint'
export const PushSettings = z.object({ configured: z.boolean(), enabled: z.boolean(), publicKey: z.string().nullable(), subscriptionId: z.string().nullable() })
export const PushSubscriptionInput = z.object({ consent: z.literal(true), endpoint: z.string().min(1).max(4096), keys: z.object({ p256dh: z.string().min(1).max(128), auth: z.string().min(1).max(64) }).strict() }).strict()
export const PUSH = {
  getPushSettings: endpoint({ method: 'GET', path: '/api/push', auth: 'user', owner: 'B', response: PushSettings, summary: 'Own push opt-in and current-session binding; disabled until the server is configured.' }),
  subscribePush: endpoint({ method: 'POST', path: '/api/push/subscriptions', auth: 'user', owner: 'B', body: PushSubscriptionInput, response: z.object({ id: z.string() }), summary: 'Explicitly consent to an encrypted push subscription bound to this login session.' }),
  updatePushSettings: endpoint({ method: 'PATCH', path: '/api/push', auth: 'user', owner: 'B', body: z.object({ enabled: z.boolean(), consent: z.literal(true).optional() }).strict().refine(v => !v.enabled || v.consent === true), response: PushSettings, summary: 'Own opt-in preference; turning off removes own subscriptions and queued deliveries.' }),
  unsubscribePush: endpoint({ method: 'DELETE', path: '/api/push/subscriptions/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Remove an own current-session subscription.' }),
} as const
