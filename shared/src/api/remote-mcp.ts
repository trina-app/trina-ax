import { z } from 'zod'
import { endpoint, empty } from './endpoint'
/** `scopes`: what the app asked for. `optional`: what the person may tick whatever the app asked (mcp:write); mcp:read
 * is always granted. `admin`: the person is an owner or admin, so the connection also manages the team's groups
 * (mcp:admin, no box). */
export const RemoteConsent = z.object({ id: z.string(), clientName: z.string(), redirectOrigin: z.string(), scopes: z.array(z.string()), optional: z.array(z.string()), admin: z.boolean(), resource: z.string(), expiresAt: z.string() })
export const RemoteConnection = z.object({ id: z.string(), clientName: z.string(), scopes: z.array(z.string()), createdAt: z.string(), expiresAt: z.string(), currentSession: z.boolean() })
export const REMOTE_MCP = {
  getRemoteConnectorConsent: endpoint({ method: 'GET', path: '/api/connectors/remote/requests/:id', auth: 'user', owner: 'A', response: RemoteConsent, summary: 'Inspect an OAuth request, bound to this user and login session.' }),
  decideRemoteConnectorConsent: endpoint({ method: 'POST', path: '/api/connectors/remote/requests/:id', auth: 'user', owner: 'A', body: z.object({ allow: z.boolean(), write: z.boolean().optional(), rooms: z.boolean().optional(), roomsWrite: z.boolean().optional(), admin: z.boolean().optional() }).strict(), response: z.object({ redirectUrl: z.string() }), summary: 'Explicitly allow or deny an external app connection. The grant is mcp:read, plus mcp:write when `write` (left out: when the app asked for it), plus mcp:rooms (read my conversations) when `rooms` and mcp:rooms.write (send messages as me) when `rooms` and `roomsWrite` (left out: no), plus mcp:admin when the person is an owner or admin now, plus offline_access when asked. `admin` is ignored (an older page sent it).' }),
  listRemoteConnectors: endpoint({ method: 'GET', path: '/api/connectors/remote', auth: 'user', owner: 'A', response: z.object({ configured: z.boolean(), resource: z.string().nullable(), items: z.array(RemoteConnection) }), summary: 'List only this user’s external connections.' }),
  revokeRemoteConnector: endpoint({ method: 'DELETE', path: '/api/connectors/remote/:id', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Revoke an own external connection and all of its tokens.' }),
} as const
export type RemoteConsentInfo = z.infer<typeof RemoteConsent>
export type RemoteConnectionInfo = z.infer<typeof RemoteConnection>
