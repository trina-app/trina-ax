// External services the AI can use with a person's or the team's own credentials (docs/INTEGRATIONS.md): MCP servers
// (Notion, Linear, GitHub ... the service lists its tools) and plain HTTP APIs with a key (one `api_request` tool).
// Personal connections: made by a member in Settings, used only in that member's chats. Team connections: made by an
// admin, used by the people the admin chose (everyone / groups / people, like folder rules). Keys and OAuth tokens are
// write-only here: no response ever carries them (only `hasSecret`).
// Not the "connectors" of remote-mcp.ts: those are the other direction (claude.ai using this server's files).
import { z } from 'zod'
import { IsoTime } from './common'
import { endpoint, empty } from './endpoint'

export const IntegrationKind = z.enum(['mcp', 'http'])
export type IntegrationKind = z.infer<typeof IntegrationKind>
export const IntegrationScope = z.enum(['personal', 'team'])
export type IntegrationScope = z.infer<typeof IntegrationScope>
/** none; bearer = "Authorization: Bearer <key>"; header = "<authHeader>: <key>"; oauth = sign in at the service (mcp only) */
export const IntegrationAuth = z.enum(['none', 'bearer', 'header', 'oauth'])
export type IntegrationAuth = z.infer<typeof IntegrationAuth>
/** what the AI may do that changes something at the service: ask the person each time (default), allow, or refuse */
export const WritePolicy = z.enum(['ask', 'allow', 'deny'])
export type WritePolicy = z.infer<typeof WritePolicy>
export const IntegrationStatus = z.enum(['connected', 'needs_auth', 'error'])
export type IntegrationStatus = z.infer<typeof IntegrationStatus>

/** who may use a team connection in their chats (admins are not implied: they manage it, using it needs a rule) */
export const IntegrationAccess = z.object({
  everyone: z.boolean(),
  groups: z.array(z.string()).max(100),
  users: z.array(z.string()).max(500),
})
export type IntegrationAccess = z.infer<typeof IntegrationAccess>

/** one tool an MCP server offers (from tools/list, saved when the connection is checked) */
export const IntegrationTool = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  /** the server marked it read-only (MCP readOnlyHint): the AI may run it without asking */
  readOnly: z.boolean(),
})
export type IntegrationTool = z.infer<typeof IntegrationTool>

const Slug = z.string().regex(/^[a-z0-9]{1,12}$/, 'lower-case letters and digits, at most 12')
const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'a header name such as X-API-Key')
/** https only, no user name or password, no fragment; the server also refuses private, local and office addresses */
const ServiceUrl = z.string().url().max(2000)
  .refine((u) => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password && !x.hash } catch { return false } }, 'an https address without a user name, password or #')

export const Integration = z.object({
  id: z.string(),
  scope: IntegrationScope,
  kind: IntegrationKind,
  name: z.string(),
  /** the part of the AI's tool names that names this connection (my_<slug>__… / team_<slug>__…, api_request's connection) */
  slug: z.string(),
  url: z.string(),
  auth: IntegrationAuth,
  /** the header that carries the key when auth is 'header' */
  authHeader: z.string().nullable(),
  /** a key or a signed-in account is stored (never shown) */
  hasSecret: z.boolean(),
  /** OAuth: the account the service said it is (when it says), for the person to recognise */
  account: z.string().nullable(),
  /** how to use this API, for the AI (http connections) */
  notes: z.string().nullable(),
  writePolicy: WritePolicy,
  status: IntegrationStatus,
  /** why the last check failed, in words a person can act on (never a secret or a raw server body) */
  lastError: z.string().nullable(),
  tools: z.array(IntegrationTool),
  toolsUpdatedAt: IsoTime.nullable(),
  /** team connections only (null for personal ones, and for people who may use but not manage it) */
  access: IntegrationAccess.nullable(),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  lastUsedAt: IsoTime.nullable(),
  /** the caller may change or delete it (the owner of a personal one, an admin for a team one) */
  canManage: z.boolean(),
})
export type Integration = z.infer<typeof Integration>

const Name = z.string().trim().min(1).max(60)
const Notes = z.string().max(4000)
/** A new connection. slug: derived from the name when missing. secret: the key (auth bearer / header); write-only. */
export const IntegrationInput = z.object({
  kind: IntegrationKind,
  name: Name,
  slug: Slug.optional(),
  url: ServiceUrl,
  auth: IntegrationAuth,
  authHeader: HeaderName.nullable().optional(),
  secret: z.string().min(1).max(8000).optional(),
  notes: Notes.nullable().optional(),
  writePolicy: WritePolicy.default('ask'),
  /** team connections (admin endpoint) only */
  access: IntegrationAccess.optional(),
}).refine((v) => v.auth !== 'oauth' || v.kind === 'mcp', { message: 'sign-in (oauth) is for MCP servers', path: ['auth'] })
  .refine((v) => v.auth !== 'header' || !!v.authHeader, { message: 'give the header name', path: ['authHeader'] })
export type IntegrationInput = z.infer<typeof IntegrationInput>

/** Changes. A new url (another origin or path) or auth drops the stored key / sign-in unless a new secret comes with it. */
export const IntegrationPatch = z.object({
  name: Name.optional(),
  url: ServiceUrl.optional(),
  auth: IntegrationAuth.optional(),
  authHeader: HeaderName.nullable().optional(),
  secret: z.string().min(1).max(8000).optional(),
  clearSecret: z.literal(true).optional(),
  notes: Notes.nullable().optional(),
  writePolicy: WritePolicy.optional(),
  access: IntegrationAccess.optional(),
})
export type IntegrationPatch = z.infer<typeof IntegrationPatch>

export const IntegrationFlow = z.object({
  flowId: z.string(),
  state: z.enum(['pending', 'exchanging', 'completed', 'failed', 'expired']),
  expiresAt: IsoTime,
  reason: z.string().nullable(),
})
export type IntegrationFlow = z.infer<typeof IntegrationFlow>

export const IntegrationList = z.object({
  items: z.array(Integration),
  /** the team lets members add their own connections (TeamSettings.personalIntegrations) */
  personalAllowed: z.boolean(),
})
export type IntegrationList = z.infer<typeof IntegrationList>

export const INTEGRATIONS = {
  listIntegrations: endpoint({ method: 'GET', path: '/api/integrations', auth: 'user', owner: 'C', response: IntegrationList, summary: 'My personal connections and the team connections I may use. Never a key or token.' }),
  createIntegration: endpoint({ method: 'POST', path: '/api/integrations', auth: 'user', owner: 'C', status: 201, body: IntegrationInput, response: Integration, summary: 'A personal connection (403 when the team turned personal connections off). Checked right away; status says how it went.' }),
  updateIntegration: endpoint({ method: 'PATCH', path: '/api/integrations/:id', auth: 'user', owner: 'C', body: IntegrationPatch, response: Integration, summary: 'Change a connection: the owner of a personal one, an admin for a team one. A new address drops the stored key.' }),
  deleteIntegration: endpoint({ method: 'DELETE', path: '/api/integrations/:id', auth: 'user', owner: 'C', response: empty, status: 204, summary: 'Delete a connection (OAuth: revocation is tried, the local tokens go first).' }),
  refreshIntegration: endpoint({ method: 'POST', path: '/api/integrations/:id/refresh', auth: 'user', owner: 'C', body: z.object({}), response: Integration, summary: 'Check the connection now; MCP: save its current tool list.' }),
  authorizeIntegration: endpoint({ method: 'POST', path: '/api/integrations/:id/authorize', auth: 'user', owner: 'C', body: z.object({}), response: z.object({ flowId: z.string(), authorizationUrl: z.string().url(), expiresAt: IsoTime }), summary: 'Start signing in at an MCP server (OAuth with PKCE) in a browser window.' }),
  integrationFlow: endpoint({ method: 'GET', path: '/api/integrations/flows/:id', auth: 'user', owner: 'C', response: IntegrationFlow, summary: 'Poll a sign-in started by this same session.' }),
  listTeamIntegrations: endpoint({ method: 'GET', path: '/api/admin/integrations', auth: 'admin', owner: 'C', response: z.object({ items: z.array(Integration) }), summary: 'Every team connection, with who may use it.' }),
  createTeamIntegration: endpoint({ method: 'POST', path: '/api/admin/integrations', auth: 'admin', owner: 'C', status: 201, body: IntegrationInput, response: Integration, summary: 'A team connection; access says who may use it (default: nobody until set).' }),
} as const
