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
/** Admin › App connectors: whether this server has a Google client, where it came from, and whether an admin can set
 * it up here. `source`: "app" set up in this page, "server" by the operator (installer, client file or environment).
 * `blocked`: why the page cannot set it up ("hosted" the hosting service owns it, "server" the operator's own client,
 * "public_host" no public https address to send Google back to). Never the client secret, never the client ID. */
export const DriveAdminStatus = z.object({
  configured: z.boolean(), source: z.enum(['app', 'server', 'none']), canSetUp: z.boolean(),
  blocked: z.enum(['hosted', 'server', 'public_host']).nullable(), redirectUri: z.string().nullable(), connectedMembers: z.number().int(),
})
export type DriveAdminStatus = z.infer<typeof DriveAdminStatus>
/** The Google OAuth web client: the JSON file Google Cloud downloads (`file`), or its client ID and secret. */
export const SetDriveClientBody = z.object({
  file: z.string().min(1).max(16_384).optional(), clientId: z.string().min(1).max(512).optional(), clientSecret: z.string().min(1).max(4096).optional(),
}).strict().refine((b) => (b.file !== undefined) !== (b.clientId !== undefined || b.clientSecret !== undefined) && (b.file !== undefined || (b.clientId !== undefined && b.clientSecret !== undefined)),
  { message: 'give the client file, or the client ID and secret' })
export const DRIVE = {
  myDriveConnection: endpoint({ method: 'GET', path: '/api/integrations/google-drive', auth: 'user', owner: 'C', response: DriveConnection, summary: 'Own Google Drive connection; never a token.' }),
  authorizeDrive: endpoint({ method: 'POST', path: '/api/integrations/google-drive/authorize', auth: 'user', owner: 'C', body: z.object({}), response: z.object({ flowId: z.string(), authorizationUrl: z.string().url(), expiresAt: z.string() }), summary: 'Start personal Google authorization in a system browser.' }),
  driveFlow: endpoint({ method: 'GET', path: '/api/integrations/google-drive/flows/:id', auth: 'user', owner: 'C', response: DriveFlow, summary: 'Poll the flow started by this same signed-in session.' }),
  completeDriveFlow: endpoint({ method: 'POST', path: '/api/integrations/google-drive/flows/:id/complete', auth: 'user', owner: 'C', body: z.object({}), response: DriveConnection, summary: 'Confirm the Google account shown by this own authorization flow.' }),
  cancelDriveFlow: endpoint({ method: 'DELETE', path: '/api/integrations/google-drive/flows/:id', auth: 'user', owner: 'C', response: empty, status: 204, summary: 'Cancel this own authorization flow.' }),
  disconnectDrive: endpoint({ method: 'DELETE', path: '/api/integrations/google-drive', auth: 'user', owner: 'C', response: z.object({ disconnected: z.literal(true), revocation: z.enum(['revoked', 'unavailable', 'not_needed']) }), summary: 'Immediately disable own Drive access, then attempt Google revocation.' }),
  driveAdminStatus: endpoint({ method: 'GET', path: '/api/admin/google-drive', auth: 'admin', owner: 'C', response: DriveAdminStatus, summary: 'Whether Google Drive is set up on this server, by whom, and how many members are connected; never the client.' }),
  setDriveClient: endpoint({ method: 'PUT', path: '/api/admin/google-drive/client', auth: 'admin', owner: 'C', body: SetDriveClientBody, response: DriveAdminStatus, summary: 'Set up Google Drive with a Google OAuth web client (stored as a private server file; members then connect their own account). Refused on hosted servers, without a public address, and when the operator set the client.' }),
} as const
