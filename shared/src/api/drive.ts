// Personal Google Drive only. OAuth secrets never cross this API.
import { z } from 'zod'
import { endpoint, empty } from './endpoint'
export const DriveAccount = z.object({ name: z.string().nullable(), email: z.string().nullable() })
export const DriveConnection = z.object({
  configured: z.boolean(), status: z.enum(['disabled', 'disconnected', 'connected', 'needs_reconnect']),
  account: DriveAccount.nullable(), scopes: z.array(z.string()), expiresAt: z.string().nullable(),
})
export type DriveConnection = z.infer<typeof DriveConnection>
export const DriveFlow = z.object({
  flowId: z.string(), state: z.enum(['pending', 'exchanging', 'ready', 'failed', 'expired', 'completed']),
  account: DriveAccount.nullable(), expiresAt: z.string(), reason: z.string().nullable(),
})
export type DriveFlow = z.infer<typeof DriveFlow>
export const DRIVE = {
  myDriveConnection: endpoint({ method: 'GET', path: '/api/integrations/google-drive', auth: 'user', owner: 'C', response: DriveConnection, summary: 'Own Google Drive connection; never a token.' }),
  authorizeDrive: endpoint({ method: 'POST', path: '/api/integrations/google-drive/authorize', auth: 'user', owner: 'C', body: z.object({}), response: z.object({ flowId: z.string(), authorizationUrl: z.string().url(), expiresAt: z.string() }), summary: 'Start personal Google authorization in a system browser.' }),
  driveFlow: endpoint({ method: 'GET', path: '/api/integrations/google-drive/flows/:id', auth: 'user', owner: 'C', response: DriveFlow, summary: 'Poll the flow started by this same signed-in session.' }),
  completeDriveFlow: endpoint({ method: 'POST', path: '/api/integrations/google-drive/flows/:id/complete', auth: 'user', owner: 'C', body: z.object({}), response: DriveConnection, summary: 'Confirm the Google account shown by this own authorization flow.' }),
  cancelDriveFlow: endpoint({ method: 'DELETE', path: '/api/integrations/google-drive/flows/:id', auth: 'user', owner: 'C', response: empty, status: 204, summary: 'Cancel this own authorization flow.' }),
  disconnectDrive: endpoint({ method: 'DELETE', path: '/api/integrations/google-drive', auth: 'user', owner: 'C', response: z.object({ disconnected: z.literal(true), revocation: z.enum(['revoked', 'unavailable', 'not_needed']) }), summary: 'Immediately disable own Drive access, then attempt Google revocation.' }),
} as const
