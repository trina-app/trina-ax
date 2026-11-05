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

/** the most tools the team server keeps of one MCP connection (every tool its service lists, up to this; a turn offers
 * the ones that do not fit an answer through find_tools / call_tool) */
export const INTEGRATION_TOOLS_MAX = 1000
/** what a server before the deferred tools kept of one MCP connection at most (100 tools, and 256,000 characters of
 * schemas: Higgsfield's list stopped at 46). A list of more can only have been cut by today's ceiling (1,000 tools or
 * 4,000,000 characters: at 33,000 characters a tool at most, that is past 120 tools), so only a list of at most this
 * many is "saved before; check again". */
export const INTEGRATION_TOOLS_OLD_MAX = 100

/** one tool an MCP server offers (from tools/list, saved when the connection is checked) */
export const IntegrationTool = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  /** the server marked it read-only (MCP readOnlyHint): the AI may run it without asking */
  readOnly: z.boolean(),
  /** offered to the AI; whoever manages the connection turns single tools off (setIntegrationTool). A tool the service
   * adds later is on. Older servers omit it (every tool on). */
  enabled: z.boolean().optional(),
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
  /** how many tools the service offers when that is more than `tools` holds: over INTEGRATION_TOOLS_MAX, or a list
   * an older server saved (it kept 100 at most; checking the connection again saves them all); absent when `tools` is
   * all of them */
  toolsTotal: z.number().int().nonnegative().optional(),
  /** true: the service offers more than `toolsTotal` (the server stopped reading its list with pages left: the list it
   * keeps was full, or it read 20 pages or 16 MiB), how many more is not known: "1,000 of more than 1,000 tools" */
  toolsTotalMore: z.literal(true).optional(),
  toolsUpdatedAt: IsoTime.nullable(),
  /** team connections only (null for personal ones, and for people who may use but not manage it) */
  access: IntegrationAccess.nullable(),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  lastUsedAt: IsoTime.nullable(),
  /** the caller may change or delete it (the owner of a personal one, an admin for a team one) */
  canManage: z.boolean(),
  /** a member's own connection made from an admin's template (its address, sign-in method and header are the
   * template's; the member changes only their key or sign-in and the write rule). Older servers omit it. */
  templateId: z.string().nullable().optional(),
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

// ---------------- an admin asks a member to connect a service as their own ----------------
// The admin fills in the service (as for a team connection, without a key or who may use it); the member adds their own
// key or signs in, and it becomes the member's personal connection. The admin never sees the key: a request holds none,
// and the member's connection is theirs alone (docs/INTEGRATIONS.md "Asking a member to connect").

/** how long a request waits for its member */
export const INTEGRATION_REQUEST_DAYS = 7
/** waiting: the member has not answered yet; connected: the member saved their key or finished signing in (what they do
 * with their connection afterwards is theirs alone); declined by the member; withdrawn by an admin; expired unanswered */
export const IntegrationRequestState = z.enum(['waiting', 'connected', 'declined', 'withdrawn', 'expired'])
export type IntegrationRequestState = z.infer<typeof IntegrationRequestState>

const Person = z.object({ id: z.string(), name: z.string() })
export const IntegrationRequest = z.object({
  id: z.string(),
  kind: IntegrationKind,
  name: z.string(),
  url: z.string(),
  /** never 'none': the point of a request is the member's own key or sign-in */
  auth: IntegrationAuth,
  authHeader: z.string().nullable(),
  /** how to use this API, for the AI (http connections); the member's connection gets it */
  notes: z.string().nullable(),
  /** the member asked to connect it */
  user: Person,
  /** the admin who asked (null: that account is gone) */
  requestedBy: Person.nullable(),
  state: IntegrationRequestState,
  createdAt: IsoTime,
  expiresAt: IsoTime,
  /** when it was connected, declined or withdrawn */
  endedAt: IsoTime.nullable(),
  /** the address that opens it in the app (Settings › External services) for its member; the admin may copy and send it.
   * It is not a key: anyone else who opens it, admins included, finds nothing. */
  link: z.string(),
})
export type IntegrationRequest = z.infer<typeof IntegrationRequest>

/** What an admin asks a member to connect: the same service fields as a team connection, with no key, no write rule
 * (the member's own, as for any personal connection) and no access rule (a personal connection is its owner's only). */
export const IntegrationRequestInput = z.object({
  userId: z.string().min(1).max(200),
  kind: IntegrationKind,
  name: Name,
  url: ServiceUrl,
  auth: z.enum(['bearer', 'header', 'oauth']),
  authHeader: HeaderName.nullable().optional(),
  notes: Notes.nullable().optional(),
  // strict: a key (or anything else) sent with a request is refused, not quietly dropped
}).strict().refine((v) => v.auth !== 'oauth' || v.kind === 'mcp', { message: 'sign-in (oauth) is for MCP servers', path: ['auth'] })
  .refine((v) => v.auth !== 'header' || !!v.authHeader, { message: 'give the header name', path: ['authHeader'] })
export type IntegrationRequestInput = z.infer<typeof IntegrationRequestInput>

/** The member's answer: their key (auth bearer / header; write-only), or nothing for a sign-in (the app signs in next),
 * and what the AI may change there (ask or refuse: "allow" stays the team's choice). */
export const IntegrationRequestAnswer = z.object({
  secret: z.string().min(1).max(8000).optional(),
  writePolicy: WritePolicy.optional(),
}).strict()
export type IntegrationRequestAnswer = z.infer<typeof IntegrationRequestAnswer>

const RequestList = z.object({ items: z.array(IntegrationRequest) })

// ---------------- templates: an admin registers a service once, each member connects it as their own ----------------
// The admin fills in the service (as for a team connection, with who it is for, but without a key); each member it is
// for connects it with their own key or sign-in, and it becomes that member's own connection, used only in their
// chats with their key. The admin never sees a key and sees only how many members connected (docs/INTEGRATIONS.md
// "Templates"). A new address, sign-in method or header on the template drops every member's key.

/** the most templates a team keeps */
export const INTEGRATION_TEMPLATES_MAX = 50

export const IntegrationTemplate = z.object({
  id: z.string(),
  kind: IntegrationKind,
  name: z.string(),
  url: z.string(),
  /** never 'none': the point of a template is each member's own key or sign-in */
  auth: z.enum(['bearer', 'header', 'oauth']),
  authHeader: z.string().nullable(),
  /** a note for the members, and how to use an API (the AI reads it in their chats) */
  notes: z.string().nullable(),
  /** who it is for (admins are not implied) */
  access: IntegrationAccess,
  /** members who connected it with a key or sign-in now */
  connected: z.number().int().nonnegative(),
  createdBy: Person.nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
})
export type IntegrationTemplate = z.infer<typeof IntegrationTemplate>

export const IntegrationTemplateInput = z.object({
  kind: IntegrationKind,
  name: Name,
  url: ServiceUrl,
  auth: z.enum(['bearer', 'header', 'oauth']),
  authHeader: HeaderName.nullable().optional(),
  notes: Notes.nullable().optional(),
  // who sees it to connect with their own key; left out = the whole team (a template carries no key)
  access: IntegrationAccess.optional(),
  // strict: a key sent with a template is refused, not quietly dropped
}).strict().refine((v) => v.auth !== 'oauth' || v.kind === 'mcp', { message: 'sign-in (oauth) is for MCP servers', path: ['auth'] })
  .refine((v) => v.auth !== 'header' || !!v.authHeader, { message: 'give the header name', path: ['authHeader'] })
export type IntegrationTemplateInput = z.infer<typeof IntegrationTemplateInput>

/** A new address, sign-in method or header drops every member's connection made from it (they connect again). */
export const IntegrationTemplatePatch = z.object({
  name: Name.optional(),
  url: ServiceUrl.optional(),
  auth: z.enum(['bearer', 'header', 'oauth']).optional(),
  authHeader: HeaderName.nullable().optional(),
  notes: Notes.nullable().optional(),
  access: IntegrationAccess.optional(),
}).strict()
export type IntegrationTemplatePatch = z.infer<typeof IntegrationTemplatePatch>

/** A template shared with me, and my connection made from it (null: not connected yet). */
export const MyIntegrationTemplate = z.object({
  id: z.string(),
  /** sent back when connecting: a template that changed since (its address above all) is refused with 409 */
  version: z.number().int().positive(),
  kind: IntegrationKind,
  name: z.string(),
  /** the address without its query (where my key or sign-in will go) */
  url: z.string(),
  auth: z.enum(['bearer', 'header', 'oauth']),
  authHeader: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: Person.nullable(),
  connection: Integration.nullable(),
})
export type MyIntegrationTemplate = z.infer<typeof MyIntegrationTemplate>

/** Connecting a template: my key (auth bearer / header; write-only), or nothing for a sign-in (the app signs in next),
 * what the AI may change there (ask or refuse), and the template's version as I saw it: 409 when it changed since, so
 * a key goes only where I agreed to send it. */
export const IntegrationTemplateAnswer = IntegrationRequestAnswer.extend({ version: z.number().int().positive() }).strict()
export type IntegrationTemplateAnswer = z.infer<typeof IntegrationTemplateAnswer>

export const INTEGRATIONS = {
  listIntegrations: endpoint({ method: 'GET', path: '/api/integrations', auth: 'user', owner: 'C', response: IntegrationList, summary: 'My personal connections and the team connections I may use. Never a key or token.' }),
  createIntegration: endpoint({ method: 'POST', path: '/api/integrations', auth: 'user', owner: 'C', status: 201, body: IntegrationInput, response: Integration, summary: 'A personal connection (403 when the team turned personal connections off). Checked right away; status says how it went.' }),
  updateIntegration: endpoint({ method: 'PATCH', path: '/api/integrations/:id', auth: 'user', owner: 'C', body: IntegrationPatch, response: Integration, summary: 'Change a connection: the owner of a personal one, an admin for a team one. A new address drops the stored key.' }),
  deleteIntegration: endpoint({ method: 'DELETE', path: '/api/integrations/:id', auth: 'user', owner: 'C', response: empty, status: 204, summary: 'Delete a connection (OAuth: revocation is tried, the local tokens go first).' }),
  refreshIntegration: endpoint({ method: 'POST', path: '/api/integrations/:id/refresh', auth: 'user', owner: 'C', body: z.object({}), response: Integration, summary: 'Check the connection now; MCP: save its current tool list.' }),
  authorizeIntegration: endpoint({ method: 'POST', path: '/api/integrations/:id/authorize', auth: 'user', owner: 'C', body: z.object({}), response: z.object({ flowId: z.string(), authorizationUrl: z.string().url(), expiresAt: IsoTime }), summary: 'Start signing in at an MCP server (OAuth with PKCE) in a browser window.' }),
  setIntegrationTool: endpoint({ method: 'POST', path: '/api/integrations/:id/tools', auth: 'user', owner: 'C', body: z.object({ name: z.string().min(1).max(200), enabled: z.boolean() }).strict(), response: Integration, summary: 'Turn one tool of an MCP connection on or off for the AI (whoever manages the connection). New tools are on.' }),
  integrationFlow: endpoint({ method: 'GET', path: '/api/integrations/flows/:id', auth: 'user', owner: 'C', response: IntegrationFlow, summary: 'Poll a sign-in started by this same session.' }),
  listTeamIntegrations: endpoint({ method: 'GET', path: '/api/admin/integrations', auth: 'admin', owner: 'C', response: z.object({ items: z.array(Integration) }), summary: 'Every team connection, with who may use it.' }),
  createTeamIntegration: endpoint({ method: 'POST', path: '/api/admin/integrations', auth: 'admin', owner: 'C', status: 201, body: IntegrationInput, response: Integration, summary: 'A team connection; access says who may use it (default: nobody until set).' }),
  listIntegrationRequests: endpoint({ method: 'GET', path: '/api/integration-requests', auth: 'user', owner: 'C', response: RequestList, summary: 'Requests from admins to connect a service as my own connection, still waiting for me.' }),
  getIntegrationRequest: endpoint({ method: 'GET', path: '/api/integration-requests/:id', auth: 'user', owner: 'C', response: IntegrationRequest, summary: 'One request to me, in any state (404 for anyone else, admins included).' }),
  completeIntegrationRequest: endpoint({ method: 'POST', path: '/api/integration-requests/:id/complete', auth: 'user', owner: 'C', body: IntegrationRequestAnswer, response: Integration, summary: 'Connect it as my own connection, with my key, or made for signing in next (MCP OAuth: the request is connected when the sign-in finishes). Only the member it asks.' }),
  declineIntegrationRequest: endpoint({ method: 'POST', path: '/api/integration-requests/:id/decline', auth: 'user', owner: 'C', body: z.object({}), response: IntegrationRequest, summary: 'Decline a waiting request to me.' }),
  listTeamIntegrationRequests: endpoint({ method: 'GET', path: '/api/admin/integration-requests', auth: 'admin', owner: 'C', response: RequestList, summary: 'Requests admins sent to members, with their state. Never a key.' }),
  createIntegrationRequest: endpoint({ method: 'POST', path: '/api/admin/integration-requests', auth: 'admin', owner: 'C', status: 201, body: IntegrationRequestInput, response: IntegrationRequest, summary: 'Ask a member to connect a service as their own connection (a notice and a link for them; waits 7 days).' }),
  listIntegrationTemplates: endpoint({ method: 'GET', path: '/api/integration-templates', auth: 'user', owner: 'C', response: z.object({ items: z.array(MyIntegrationTemplate) }), summary: 'Templates an admin shared with me, each with my connection made from it (or null). Never a key.' }),
  connectIntegrationTemplate: endpoint({ method: 'POST', path: '/api/integration-templates/:id/connect', auth: 'user', owner: 'C', body: IntegrationTemplateAnswer, response: Integration, summary: 'Connect a template shared with me as my own connection, with my key, or made for signing in next (MCP OAuth). Again with a key: replaces my key. 404 when it is not shared with me; 409 when it changed since the version I send.' }),
  listTeamIntegrationTemplates: endpoint({ method: 'GET', path: '/api/admin/integration-templates', auth: 'admin', owner: 'C', response: z.object({ items: z.array(IntegrationTemplate) }), summary: 'Every template, with who it is for and how many members connected it. Never a key.' }),
  createIntegrationTemplate: endpoint({ method: 'POST', path: '/api/admin/integration-templates', auth: 'admin', owner: 'C', status: 201, body: IntegrationTemplateInput, response: IntegrationTemplate, summary: 'Register a service once for the team; each member it is for connects it with their own key or sign-in.' }),
  updateIntegrationTemplate: endpoint({ method: 'PATCH', path: '/api/admin/integration-templates/:id', auth: 'admin', owner: 'C', body: IntegrationTemplatePatch, response: IntegrationTemplate, summary: 'Change a template. A new address, sign-in method or header deletes every member\'s connection made from it (and its key); they connect again. The address may not have a query (a key there would reach every member).' }),
  deleteIntegrationTemplate: endpoint({ method: 'DELETE', path: '/api/admin/integration-templates/:id', auth: 'admin', owner: 'C', response: empty, status: 204, summary: 'Delete a template and every member\'s connection made from it (OAuth: revocation is tried, the local tokens go first).' }),
  withdrawIntegrationRequest: endpoint({ method: 'POST', path: '/api/admin/integration-requests/:id/withdraw', auth: 'admin', owner: 'C', body: z.object({}), response: IntegrationRequest, summary: 'Withdraw a waiting request.' }),
} as const
