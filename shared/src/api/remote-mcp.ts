import { z } from 'zod'
import { endpoint, empty } from './endpoint'
/** `scopes`: what the app asked for. `optional`: what the person may tick whatever the app asked (mcp:write); mcp:read
 * is always granted. `admin`: the person is an owner or admin, so the connection also manages the team's groups
 * (mcp:admin, no box). */
/** `browserProfiles`: how many browser profiles the person linked (the "Use my browser profiles" box says to link one
 * first when 0). */
export const RemoteConsent = z.object({ id: z.string(), clientName: z.string(), redirectOrigin: z.string(), scopes: z.array(z.string()), optional: z.array(z.string()), admin: z.boolean(), resource: z.string(), expiresAt: z.string(), browserProfiles: z.number().int().nonnegative().optional() })
/** `browserPausedUntil`: the person pressed Stop in their browser on one of this app's tasks; its browser calls wait
 * until then or until Resume (docs/decisions/20261128-mcp-browser-tools.md). */
export const RemoteConnection = z.object({ id: z.string(), clientName: z.string(), scopes: z.array(z.string()), createdAt: z.string(), expiresAt: z.string(), browserPausedUntil: z.string().nullable().optional() })
/** `params.reason` of the consent request's 404 when the request expired, was already decided, or another login session
 * opened it: the page says so instead of "not found or no access". */
export const REMOTE_CONSENT_EXPIRED = 'request_expired'
export const REMOTE_MCP = {
  getRemoteConnectorConsent: endpoint({ method: 'GET', path: '/api/connectors/remote/requests/:id', auth: 'user', owner: 'A', response: RemoteConsent, summary: 'Inspect an OAuth request, bound to this user and login session. 404 with params.reason request_expired: the request expired, was decided, or another login session opened it.' }),
  decideRemoteConnectorConsent: endpoint({ method: 'POST', path: '/api/connectors/remote/requests/:id', auth: 'user', owner: 'A', body: z.object({ allow: z.boolean(), write: z.boolean().optional(), rooms: z.boolean().optional(), roomsWrite: z.boolean().optional(), browser: z.boolean().optional(), admin: z.boolean().optional() }).strict(), response: z.object({ redirectUrl: z.string() }), summary: 'Explicitly allow or deny an external app connection. The grant is mcp:read, plus mcp:write when `write` (left out: when the app asked for it), plus mcp:rooms (read my conversations) when `rooms` and mcp:rooms.write (send messages as me) when `rooms` and `roomsWrite` (left out: no), plus mcp:browser (the person\'s linked browser profiles) when `browser` (left out: no; never for a guest), plus mcp:admin when the person is an owner or admin now, plus offline_access always (a refresh token whether the app asked or not). `admin` is ignored (an older page sent it). 404 with params.reason request_expired as for GET.' }),
  listRemoteConnectors: endpoint({ method: 'GET', path: '/api/connectors/remote', auth: 'user', owner: 'A', response: z.object({ configured: z.boolean(), resource: z.string().nullable(), items: z.array(RemoteConnection) }), summary: 'List only this user’s external connections.' }),
  resumeRemoteConnectorBrowser: endpoint({ method: 'POST', path: '/api/connectors/remote/:id/browser-resume', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Let an own external connection use the browser again after the person stopped one of its tasks in their browser.' }),
  revokeRemoteConnector: endpoint({ method: 'DELETE', path: '/api/connectors/remote/:id', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Revoke an own external connection and all of its tokens.' }),
} as const
export type RemoteConsentInfo = z.infer<typeof RemoteConsent>
export type RemoteConnectionInfo = z.infer<typeof RemoteConnection>
