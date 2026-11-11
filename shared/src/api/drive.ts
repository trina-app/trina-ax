// Google Drive: a person's own connection, and Drives an admin shares with the team (docs/GOOGLE-DRIVE.md "Sharing a
// Drive with the team"). OAuth secrets never cross this API.
import { z } from 'zod'
import { DriveId } from '../drive-tools'
import { endpoint, empty } from './endpoint'
import { IntegrationAccess } from './integrations'
export const DriveAccount = z.object({ name: z.string().nullable(), email: z.string().nullable() })
/** A folder (or a shared drive) a team share gives access to, with everything below it. */
export const DriveShareFolder = z.object({ id: z.string(), name: z.string(), kind: z.enum(['folder', 'drive']) })
export type DriveShareFolder = z.infer<typeof DriveShareFolder>
/** A team share as a member it is for sees it: its name and folders. Never the account, never a token. */
export const DriveTeamShare = z.object({ id: z.string(), name: z.string(), folders: z.array(DriveShareFolder), wholeDrive: z.boolean() })
export type DriveTeamShare = z.infer<typeof DriveTeamShare>
/** `personalAllowed`: the team lets members connect their own Drive (Admin › Connectors › Google Drive; older servers
 * leave it out: allowed). While it is false an owner or admin may still connect their own, turning it on at the confirm
 * (completeDriveFlow `membersOn`). `teamShares`: the Drives an admin shares with this person, usable without a connection. */
export const DriveConnection = z.object({
  configured: z.boolean(), status: z.enum(['disabled', 'disconnected', 'connected', 'needs_reconnect']),
  account: DriveAccount.nullable(), scopes: z.array(z.string()), expiresAt: z.string().nullable(),
  personalAllowed: z.boolean().optional(), teamShares: z.array(DriveTeamShare).optional(),
})
export type DriveConnection = z.infer<typeof DriveConnection>
export const DriveFlow = z.object({
  flowId: z.string(), state: z.enum(['pending', 'exchanging', 'ready', 'failed', 'expired', 'completed']),
  account: DriveAccount.nullable(), expiresAt: z.string(), reason: z.string().nullable(),
})
export type DriveFlow = z.infer<typeof DriveFlow>
/** Admin › App connectors: whether this server has a Google client, where it came from, and whether an admin can set
 * it up here. `source`: "app" set up in this page, "server" by the operator (installer, client file or environment),
 * "service" a hosted server that signs in through the hosting service (nothing to set up).
 * `blocked`: why the page cannot set it up ("hosted" the hosting service owns it, "server" the operator's own client,
 * "public_host" no public https address to send Google back to). Never the client secret, never the client ID. */
/** `membersCanConnect`: members may connect their own Google Drive (on for a new team; a team made before migration
 * 339 keeps what it had: off unless an admin turned it on or its members had connected before this switch). `sharesOn`: team shares that work now. A Google client alone turns
 * nothing on: it only makes Drive available. */
export const DriveAdminStatus = z.object({
  configured: z.boolean(), source: z.enum(['app', 'server', 'service', 'none']), canSetUp: z.boolean(),
  blocked: z.enum(['hosted', 'server', 'public_host']).nullable(), redirectUri: z.string().nullable(), connectedMembers: z.number().int(),
  membersCanConnect: z.boolean().optional(), sharesOn: z.number().int().optional(),
})
export type DriveAdminStatus = z.infer<typeof DriveAdminStatus>
/** A Drive an admin shares with the team, as admins see it. `reason` while it needs a new sign-in: "owner_gone" the
 * admin whose Google account it is left, was disabled or is no longer an admin (its tokens were deleted);
 * "signed_out" Google refused the sign-in; "client_changed" the server's Google client changed. `usedBy`: the active
 * people its rule reaches today. Never a token. */
export const DriveShare = z.object({
  id: z.string(), name: z.string(), account: DriveAccount, owner: z.object({ id: z.string(), name: z.string() }).nullable(),
  folders: z.array(DriveShareFolder), wholeDrive: z.boolean(), access: IntegrationAccess,
  status: z.enum(['connected', 'needs_reconnect']), reason: z.enum(['owner_gone', 'signed_out', 'client_changed']).nullable(),
  usedBy: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
})
export type DriveShare = z.infer<typeof DriveShare>
export const DriveShareName = z.string().trim().min(1).max(60)
export const UpdateDriveShareBody = z.object({
  name: DriveShareName.optional(), folders: z.array(DriveId).max(50).optional(), wholeDrive: z.boolean().optional(), access: IntegrationAccess.optional(),
}).strict()
/** `membersOn`: an owner or admin who connects their own Drive while members may not connect theirs also turns that on,
 * in the same step as the confirm (docs/DECISIONS.md "W6"); refused for anyone else, and needed then. */
export const CompleteDriveFlowBody = z.object({ membersOn: z.literal(true).optional() })
/** `connectUrl`: on a hosted team that signs in through the hosting service, its own start page for this sign-in
 * (it explains Google's screen, then links to `authorizationUrl`). The web opens it first; the phone app opens Google. */
const Authorization = z.object({ flowId: z.string(), authorizationUrl: z.string().url(), connectUrl: z.string().url().optional(), expiresAt: z.string() })
/** The Google OAuth web client: the JSON file Google Cloud downloads (`file`), or its client ID and secret. */
export const SetDriveClientBody = z.object({
  file: z.string().min(1).max(16_384).optional(), clientId: z.string().min(1).max(512).optional(), clientSecret: z.string().min(1).max(4096).optional(),
}).strict().refine((b) => (b.file !== undefined) !== (b.clientId !== undefined || b.clientSecret !== undefined) && (b.file !== undefined || (b.clientId !== undefined && b.clientSecret !== undefined)),
  { message: 'give the client file, or the client ID and secret' })
export const DRIVE = {
  myDriveConnection: endpoint({ method: 'GET', path: '/api/integrations/google-drive', auth: 'user', owner: 'C', response: DriveConnection, summary: 'Own Google Drive connection; never a token.' }),
  authorizeDrive: endpoint({ method: 'POST', path: '/api/integrations/google-drive/authorize', auth: 'user', owner: 'C', body: z.object({}), response: Authorization, summary: 'Start personal Google authorization in a system browser.' }),
  driveFlow: endpoint({ method: 'GET', path: '/api/integrations/google-drive/flows/:id', auth: 'user', owner: 'C', response: DriveFlow, summary: 'Poll the flow started by this same signed-in session.' }),
  completeDriveFlow: endpoint({ method: 'POST', path: '/api/integrations/google-drive/flows/:id/complete', auth: 'user', owner: 'C', body: CompleteDriveFlowBody, response: DriveConnection, summary: 'Confirm the Google account shown by this own authorization flow. While members may not connect their own Drive, an owner or admin confirms with membersOn: true, which turns that switch on with the connection.' }),
  cancelDriveFlow: endpoint({ method: 'DELETE', path: '/api/integrations/google-drive/flows/:id', auth: 'user', owner: 'C', response: empty, status: 204, summary: 'Cancel this own authorization flow.' }),
  disconnectDrive: endpoint({ method: 'DELETE', path: '/api/integrations/google-drive', auth: 'user', owner: 'C', response: z.object({ disconnected: z.literal(true), revocation: z.enum(['revoked', 'unavailable', 'not_needed']) }), summary: 'Immediately disable own Drive access, then attempt Google revocation.' }),
  driveAdminStatus: endpoint({ method: 'GET', path: '/api/admin/google-drive', auth: 'admin', owner: 'C', response: DriveAdminStatus, summary: 'Whether Google Drive is set up on this server, by whom, and how many members are connected; never the client.' }),
  setDriveClient: endpoint({ method: 'PUT', path: '/api/admin/google-drive/client', auth: 'admin', owner: 'C', body: SetDriveClientBody, response: DriveAdminStatus, summary: 'Set up Google Drive with a Google OAuth web client (stored as a private server file; members then connect their own account). Refused on hosted servers, without a public address, and when the operator set the client.' }),
  setDriveMembers: endpoint({ method: 'PUT', path: '/api/admin/google-drive/members', auth: 'admin', owner: 'C', body: z.object({ on: z.boolean() }).strict(), response: DriveAdminStatus, summary: 'Let members connect their own Google Drive, or not (off: their own connections are not used and none can be made).' }),
  listDriveShares: endpoint({ method: 'GET', path: '/api/admin/google-drive/shares', auth: 'admin', owner: 'C', response: z.object({ items: z.array(DriveShare) }), summary: 'Drives shared with the team: account, folders, who may use them; never a token.' }),
  authorizeDriveShare: endpoint({ method: 'POST', path: '/api/admin/google-drive/shares/authorize', auth: 'admin', owner: 'C', body: z.object({ shareId: z.string().optional() }).strict(), response: Authorization, summary: 'Start the Google sign-in for a Drive to share with the team (or a new sign-in for one, shareId). Polled and cancelled like an own flow.' }),
  completeDriveShareFlow: endpoint({ method: 'POST', path: '/api/admin/google-drive/shares/flows/:id/complete', auth: 'admin', owner: 'C', body: z.object({ name: DriveShareName.optional() }).strict(), response: DriveShare, summary: 'Confirm the Google account: a new share (no folders and nobody yet), or the new sign-in of a share.' }),
  driveShareFolders: endpoint({ method: 'GET', path: '/api/admin/google-drive/shares/:id/folders', auth: 'admin', owner: 'C', query: z.object({ q: z.string().trim().max(100).optional() }), response: z.object({ items: z.array(DriveShareFolder) }), summary: "The share account's top-level folders and shared drives, or folders whose name has q." }),
  updateDriveShare: endpoint({ method: 'PATCH', path: '/api/admin/google-drive/shares/:id', auth: 'admin', owner: 'C', body: UpdateDriveShareBody, response: DriveShare, summary: 'Change a share: its name, folders (checked with Google), the whole Drive, who may use it.' }),
  stopDriveShare: endpoint({ method: 'DELETE', path: '/api/admin/google-drive/shares/:id', auth: 'admin', owner: 'C', response: z.object({ stopped: z.literal(true), revocation: z.enum(['revoked', 'unavailable', 'not_needed']) }), summary: 'Stop sharing: the tokens are deleted at once, then Google revocation is attempted.' }),
} as const
