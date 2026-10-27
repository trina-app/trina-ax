// Connected folders (server/src/team-files/connected.ts): a folder of the server Mac (NAS share, Google Drive for
// desktop, any visible folder) mirrored read-only into connected/<name>. Owner only; connecting needs the password.
// Owner: A (server/src/routes/admin.ts).
import { z } from 'zod'
import { endpoint, empty } from './endpoint'

export const ConnectedFolder = z.object({
  id: z.string(),
  name: z.string(),
  /** team path of the mirror, connected/<name> */
  path: z.string(),
  /** the folder on the server Mac */
  source: z.string(),
  lastSyncAt: z.string().nullable(),
  /** ok | partial (more next time) | error */
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  files: z.number(),
  bytes: z.number(),
  syncing: z.boolean(),
})
export type ConnectedFolder = z.infer<typeof ConnectedFolder>

export const AddConnectedBody = z.object({ name: z.string().min(1).max(60), source: z.string().min(1).max(1000), password: z.string().min(1).max(256) })

export const CONNECTED = {
  listConnected: endpoint({ method: 'GET', path: '/api/admin/connected', auth: 'owner', owner: 'A', response: z.object({ items: z.array(ConnectedFolder),
    /** false on the hosted cloud (server/src/system/deployment.ts): the card is hidden and adding one is refused (409). Absent from older servers = true. */
    available: z.boolean().optional() }), summary: 'Connected folders and their last sync.' }),
  addConnected: endpoint({ method: 'POST', path: '/api/admin/connected', auth: 'owner-reauth', owner: 'A', status: 201, body: AddConnectedBody, response: ConnectedFolder, summary: 'Connect a folder of the server Mac as connected/<name> (everyone can read it; first sync starts).' }),
  syncConnected: endpoint({ method: 'POST', path: '/api/admin/connected/:id/sync', auth: 'owner', owner: 'A', response: ConnectedFolder, summary: 'Start a sync now (runs in the background).' }),
  removeConnected: endpoint({ method: 'DELETE', path: '/api/admin/connected/:id', auth: 'owner', owner: 'A', response: empty, status: 204, summary: 'Disconnect: the mirrored files go away, anything people added stays.' }),
} as const
