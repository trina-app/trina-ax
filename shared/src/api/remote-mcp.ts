import { z } from 'zod'
import { endpoint, empty } from './endpoint'
/** `scopes`: what the app asked for. `optional`: what the person may tick whatever the app asked (mcp:write, and
 * mcp:admin for an owner or admin); mcp:read is always granted. */
export const RemoteConsent = z.object({ id: z.string(), clientName: z.string(), redirectOrigin: z.string(), scopes: z.array(z.string()), optional: z.array(z.string()), resource: z.string(), expiresAt: z.string() })
export const RemoteConnection = z.object({ id: z.string(), clientName: z.string(), scopes: z.array(z.string()), createdAt: z.string(), expiresAt: z.string(), currentSession: z.boolean() })
export const REMOTE_MCP = {
  getRemoteConnectorConsent: endpoint({ method: 'GET', path: '/api/connectors/remote/requests/:id', auth: 'user', owner: 'A', response: RemoteConsent, summary: 'Inspect an OAuth request, bound to this user and login session.' }),
  decideRemoteConnectorConsent: endpoint({ method: 'POST', path: '/api/connectors/remote/requests/:id', auth: 'user', owner: 'A', body: z.object({ allow: z.boolean(), write: z.boolean().optional(), admin: z.boolean().optional() }).strict(), response: z.object({ redirectUrl: z.string() }), summary: 'Explicitly allow or deny an external app connection. The grant is mcp:read, plus mcp:write when `write` (left out: when the app asked for it), plus mcp:admin when `admin` (owners and admins only), plus offline_access when asked.' }),
  listRemoteConnectors: endpoint({ method: 'GET', path: '/api/connectors/remote', auth: 'user', owner: 'A', response: z.object({ configured: z.boolean(), resource: z.string().nullable(), items: z.array(RemoteConnection) }), summary: 'List only this user’s external connections.' }),
  revokeRemoteConnector: endpoint({ method: 'DELETE', path: '/api/connectors/remote/:id', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Revoke an own external connection and all of its tokens.' }),
} as const
export type RemoteConsentInfo = z.infer<typeof RemoteConsent>
export type RemoteConnectionInfo = z.infer<typeof RemoteConnection>
