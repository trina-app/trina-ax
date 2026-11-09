// External-service connections (Settings > External services, Admin > External services): the add / edit form as plain
// data, its checks (the same limits as shared/src/api/integrations.ts, so most mistakes show before anything is sent),
// the request bodies it becomes, and the checks on what the server sends back (the sign-in address).
// Keys are write-only: the form only ever holds a key the person is typing now; a stored one is `hasSecret`.
import { ApiError, ERROR_MESSAGES, INTEGRATION_TOOLS_OLD_MAX, type Integration, type IntegrationAccess, type IntegrationAuth, type IntegrationInput, type IntegrationKind, type IntegrationPatch, type IntegrationRequestInput, type IntegrationRequestState, type IntegrationStatus, type IntegrationTemplate, type OAuthClientInput, type OAuthClientView, type WritePolicy } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

/** how the connection proves who it is: sign in at the service (an API: with your own app), a key, or nothing */
export type SignInMethod = 'oauth' | 'key' | 'none'
/** where a key goes: "Authorization: Bearer <key>" or "<header name>: <key>" */
export type HeaderChoice = 'bearer' | 'custom'
/** editing a connection that has a stored key: keep it, type a new one, or remove it */
export type KeyAction = 'keep' | 'replace' | 'remove'

export interface IntegrationForm {
  kind: IntegrationKind
  name: string
  url: string
  method: SignInMethod
  header: HeaderChoice
  headerName: string
  /** a key typed now (never a stored one) */
  secret: string
  keyAction: KeyAction
  notes: string
  writePolicy: WritePolicy
  /** team connections only (null: a personal one) */
  access: IntegrationAccess | null
  /** sign in through your own app at the service (docs/INTEGRATIONS.md "Your own app"): an MCP server that does not
   * register apps itself (Google's); an API always signs in this way */
  ownApp: boolean
  clientId: string
  /** a client secret typed now (never a stored one) */
  clientSecret: string
  /** a stored client secret: keep it, or type a new one */
  clientSecretAction: 'keep' | 'replace'
  /** the app's sign-in and token addresses (an API; an MCP server finds them from its address) */
  authUrl: string
  tokenUrl: string
  /** the scopes to ask for, separated by spaces */
  scope: string
}

export type FormField = 'name' | 'url' | 'method' | 'headerName' | 'secret' | 'notes' | 'writePolicy' | 'access' | 'clientId' | 'clientSecret' | 'authUrl' | 'tokenUrl' | 'scope'
export type FormErrors = Partial<Record<FormField, MessageKey>>

export const NAME_MAX = 60
export const URL_MAX = 2000
export const SECRET_MAX = 8000
export const NOTES_MAX = 4000
export const CLIENT_ID_MAX = 1000
export const CLIENT_SECRET_MAX = 4000
export const SCOPE_MAX = 2000
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/

export const methodsFor = (kind: IntegrationKind): SignInMethod[] => (kind === 'mcp' ? ['oauth', 'key', 'none'] : ['key', 'oauth', 'none'])

/** the form's own-app fields filled from a stored app (none: empty) */
const appFields = (c: OAuthClientView | null | undefined, kind: IntegrationKind, auth: IntegrationAuth) => ({
  ownApp: !!c || (kind === 'http' && auth === 'oauth'),
  clientId: c?.clientId ?? '',
  clientSecret: '',
  clientSecretAction: 'keep' as const,
  authUrl: c?.authorizationUrl ?? '',
  tokenUrl: c?.tokenUrl ?? '',
  scope: c?.scope ?? '',
})

export const NOBODY: IntegrationAccess = { everyone: false, groups: [], users: [] }

export function emptyForm(kind: IntegrationKind = 'mcp', access: IntegrationAccess | null = null): IntegrationForm {
  return { kind, name: '', url: '', method: kind === 'mcp' ? 'oauth' : 'key', header: 'bearer', headerName: '', secret: '', keyAction: 'keep', notes: '', writePolicy: 'ask', access, ...appFields(null, kind, 'none') }
}

/** the form for editing `i` (no key in it: a stored key stays on the server) */
export function formFrom(i: Integration): IntegrationForm {
  return {
    kind: i.kind,
    name: i.name,
    url: i.url,
    method: i.auth === 'oauth' ? 'oauth' : i.auth === 'none' ? 'none' : 'key',
    header: i.auth === 'header' ? 'custom' : 'bearer',
    headerName: i.authHeader ?? '',
    secret: '',
    keyAction: 'keep',
    notes: i.notes ?? '',
    writePolicy: i.writePolicy,
    access: i.scope === 'team' ? i.access ?? NOBODY : null,
    ...appFields(i.oauthClient, i.kind, i.auth),
  }
}

/** the form for editing an admin's template (never a key: each member adds their own) */
export function formFromTemplate(t: IntegrationTemplate): IntegrationForm {
  return {
    kind: t.kind,
    name: t.name,
    url: t.url,
    method: t.auth === 'oauth' ? 'oauth' : 'key',
    header: t.auth === 'header' ? 'custom' : 'bearer',
    headerName: t.authHeader ?? '',
    secret: '',
    keyAction: 'keep',
    notes: t.notes ?? '',
    writePolicy: 'ask',
    access: t.access,
    ...appFields(t.oauthClient, t.kind, t.auth),
  }
}

/** another kind: an API starts with a key (most take one); sign-in there is a choice, always with your own app */
export function withKind(f: IntegrationForm, kind: IntegrationKind): IntegrationForm {
  const method = kind === 'http' && f.method === 'oauth' ? 'key' : methodsFor(kind).includes(f.method) ? f.method : 'key'
  // back to an MCP server: its own app is chosen only when one was filled in
  return { ...f, kind, method, ownApp: kind === 'http' ? true : f.kind === 'mcp' ? f.ownApp : !!f.clientId.trim() }
}

/** sign-in goes through your own app: an API always, an MCP server when chosen */
export const usesApp = (f: Pick<IntegrationForm, 'method' | 'kind' | 'ownApp'>) => f.method === 'oauth' && (f.kind === 'http' || f.ownApp)

/** The stored client secret stays with this form (the server's rule, service.ts appAfter): the same client ID, the
 * same sign-in and token addresses and the same service address (`storedUrl`), also when the app's addresses are given.
 * Else it goes, and a secret has to be typed again. */
export function storedSecretStays(f: IntegrationForm, stored: OAuthClientView | null | undefined, storedUrl?: string): boolean {
  return !!stored?.hasSecret && stored.clientId === f.clientId.trim() && (stored.authorizationUrl ?? '') === f.authUrl.trim()
    && (stored.tokenUrl ?? '') === f.tokenUrl.trim() && (storedUrl === undefined || f.url.trim() === storedUrl)
}
const typedClientSecret = (f: IntegrationForm, stored?: OAuthClientView | null, storedUrl?: string) =>
  usesApp(f) && f.clientSecret.trim() && (!storedSecretStays(f, stored, storedUrl) || f.clientSecretAction === 'replace') ? f.clientSecret.trim() : undefined

/** the own app as the API takes it (the secret only when one was typed now) */
export function appInput(f: IntegrationForm, stored?: OAuthClientView | null, storedUrl?: string): OAuthClientInput {
  const secret = typedClientSecret(f, stored, storedUrl)
  return {
    clientId: f.clientId.trim(),
    ...(secret ? { clientSecret: secret } : {}),
    ...(f.authUrl.trim() && f.tokenUrl.trim() ? { authorizationUrl: f.authUrl.trim(), tokenUrl: f.tokenUrl.trim() } : {}),
    ...(f.scope.trim() ? { scope: f.scope.trim() } : {}),
  }
}

/** The own-app part of a change: undefined when it stays, null when it goes (back to the service's own registration),
 * else the app. Another ID, secret, address or scope drops the sign-in (the server does it). */
export function appPatch(f: IntegrationForm, stored: OAuthClientView | null | undefined, storedUrl?: string): OAuthClientInput | null | undefined {
  if (!usesApp(f)) return stored && f.method === 'oauth' ? null : undefined
  const next = appInput(f, stored, storedUrl)
  const same = !!stored && stored.clientId === next.clientId && (stored.authorizationUrl ?? undefined) === next.authorizationUrl
    && (stored.tokenUrl ?? undefined) === next.tokenUrl && (stored.scope ?? undefined) === next.scope && !next.clientSecret
  return same ? undefined : next
}

export function authOf(f: Pick<IntegrationForm, 'method' | 'header'>): IntegrationAuth {
  return f.method === 'oauth' ? 'oauth' : f.method === 'none' ? 'none' : f.header === 'custom' ? 'header' : 'bearer'
}

/** what is wrong with a service address, like the contract: https, no user name or password, no #, not too long */
export function urlProblem(value: string): MessageKey | null {
  const v = value.trim()
  if (!v) return 'integrations.error.url'
  if (v.length > URL_MAX) return 'integrations.error.urlLong'
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return 'integrations.error.url'
  }
  if (u.protocol !== 'https:' || !u.hostname) return 'integrations.error.url'
  if (u.username || u.password || u.hash || v.includes('#')) return 'integrations.error.urlParts'
  return null
}

/** the change drops the stored key or sign-in (the server does it: a key must never follow a connection elsewhere) */
export function dropsSecret(f: IntegrationForm, original?: Integration): boolean {
  return !!original && original.hasSecret && (f.url.trim() !== original.url || authOf(f) !== original.auth
    // another own app: the sign-in was made with the old one (a member's connection made from a template has none)
    || (original.auth === 'oauth' && !original.templateId && appPatch(f, original.oauthClient, original.url) !== undefined))
}

/** a key has to be typed before saving */
export function needsKey(f: IntegrationForm, original?: Integration): boolean {
  if (f.method !== 'key' || (original && f.keyAction === 'remove')) return false
  return !original || !original.hasSecret || dropsSecret(f, original) || f.keyAction === 'replace'
}

/** `storedApp`: a template's app and address being edited (a connection's come with `original`) */
export function validate(f: IntegrationForm, original?: Integration, storedApp?: { app: OAuthClientView | null | undefined; url: string }): FormErrors {
  const e: FormErrors = {}
  const name = f.name.trim()
  if (!name) e.name = 'integrations.error.name'
  else if (name.length > NAME_MAX) e.name = 'integrations.error.nameLong'
  const url = urlProblem(f.url)
  if (url) e.url = url
  if (!methodsFor(f.kind).includes(f.method)) e.method = 'integrations.error.field'
  if (f.method === 'key' && f.header === 'custom' && !HEADER_RE.test(f.headerName.trim())) e.headerName = 'integrations.error.header'
  const secret = f.secret.trim()
  if (needsKey(f, original) && !secret) e.secret = 'integrations.error.key'
  else if (secret.length > SECRET_MAX) e.secret = 'integrations.error.keyLong'
  if (f.kind === 'http' && f.notes.length > NOTES_MAX) e.notes = 'integrations.error.notes'
  if (usesApp(f) && !original?.templateId) {
    const id = f.clientId.trim()
    if (!id || /\s/.test(id) || id.length > CLIENT_ID_MAX) e.clientId = 'integrations.error.clientId'
    if (f.clientSecret.length > CLIENT_SECRET_MAX) e.clientSecret = 'integrations.error.keyLong'
    else if (/[\r\n]/.test(f.clientSecret)) e.clientSecret = 'integrations.error.field'
    // the same app at another address: its stored secret does not follow (storedSecretStays), so it is asked for again
    const stored = original ? original.oauthClient : storedApp?.app
    if (stored?.hasSecret && stored.clientId === id && !f.clientSecret.trim() && !storedSecretStays(f, stored, original?.url ?? storedApp?.url)) e.clientSecret = 'integrations.error.clientSecretAgain'
    if (f.scope.length > SCOPE_MAX || /[\r\n]/.test(f.scope)) e.scope = 'integrations.error.scope'
    // an API has nothing to find its sign-in from; an MCP server's addresses are both given or both found
    if (f.kind === 'http' || f.authUrl.trim() || f.tokenUrl.trim()) {
      const a = urlProblem(f.authUrl), t = urlProblem(f.tokenUrl)
      if (a) e.authUrl = a
      if (t) e.tokenUrl = t
    }
  }
  return e
}

const notesOf = (f: IntegrationForm) => (f.kind === 'http' ? f.notes.trim() || null : null)
const headerOf = (f: IntegrationForm) => (authOf(f) === 'header' ? f.headerName.trim() : null)
const typedKey = (f: IntegrationForm) => (f.method === 'key' && f.keyAction !== 'remove' && f.secret.trim() ? f.secret.trim() : undefined)

/** the body of a new connection */
export function toInput(f: IntegrationForm): IntegrationInput {
  const secret = typedKey(f)
  return {
    kind: f.kind,
    name: f.name.trim(),
    url: f.url.trim(),
    auth: authOf(f),
    authHeader: headerOf(f),
    ...(secret ? { secret } : {}),
    notes: notesOf(f),
    writePolicy: f.writePolicy,
    ...(f.access ? { access: normalAccess(f.access) } : {}),
    ...(usesApp(f) ? { oauthClient: appInput(f) } : {}),
  }
}

/** only what changed; an empty object when nothing did */
export function toPatch(f: IntegrationForm, original: Integration): IntegrationPatch {
  const p: IntegrationPatch = {}
  const name = f.name.trim()
  if (name !== original.name) p.name = name
  const url = f.url.trim()
  if (url !== original.url) p.url = url
  const auth = authOf(f)
  if (auth !== original.auth) p.auth = auth
  const header = headerOf(f)
  if (header !== (original.authHeader ?? null)) p.authHeader = header
  const secret = typedKey(f)
  if (secret && (needsKey(f, original) || f.keyAction === 'replace')) p.secret = secret
  if (f.method === 'key' && f.keyAction === 'remove' && original.hasSecret && !dropsSecret(f, original)) p.clearSecret = true
  const notes = notesOf(f)
  if (original.kind === 'http' && notes !== (original.notes ?? null)) p.notes = notes
  if (f.writePolicy !== original.writePolicy) p.writePolicy = f.writePolicy
  if (original.scope === 'team' && f.access && !sameAccess(f.access, original.access ?? NOBODY)) p.access = normalAccess(f.access)
  // a member's connection made from a template signs in through the template's app
  if (!original.templateId) {
    const app = appPatch(f, original.oauthClient, original.url)
    if (app !== undefined && (app !== null || original.oauthClient)) p.oauthClient = app
  }
  return p
}

/** "everyone" needs no list; lists without repeats */
export function normalAccess(a: IntegrationAccess): IntegrationAccess {
  return a.everyone ? { everyone: true, groups: [], users: [] } : { everyone: false, groups: [...new Set(a.groups)], users: [...new Set(a.users)] }
}

export function sameAccess(a: IntegrationAccess, b: IntegrationAccess): boolean {
  const x = normalAccess(a), y = normalAccess(b)
  const same = (p: string[], q: string[]) => p.length === q.length && [...p].sort().every((v, i) => v === [...q].sort()[i])
  return x.everyone === y.everyone && same(x.groups, y.groups) && same(x.users, y.users)
}

/** the rule lets this person use the connection in their own chats (admins are not implied) */
export function covers(a: IntegrationAccess | null, person: { id: string; groupIds: string[] }): boolean {
  if (!a) return false
  return a.everyone || a.users.includes(person.id) || a.groups.some((g) => person.groupIds.includes(g))
}

export const isEmptyAccess = (a: IntegrationAccess) => !a.everyone && !a.groups.length && !a.users.length

/** The sign-in address the server sent, before a window is sent there: https only (never javascript:, data:, http:),
 * no user name or password in it. Throws otherwise. */
export function authorizationUrl(value: string): string {
  const u = new URL(value.trim())
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) throw new Error('unsafe sign-in address')
  return u.href
}

export const STATUS_TONE: Record<IntegrationStatus, 'ok' | 'warn' | 'danger'> = { connected: 'ok', needs_auth: 'warn', error: 'danger' }

/** What Settings says under a connection's tools when the server holds fewer than the service offers: over the
 * server's ceiling of 1,000 tools or 4,000,000 characters (`toolsCapped`; `toolsCappedMore` when the server stopped
 * reading the list with pages left, so it only knows the service offers more than `toolsTotal`), or a list an older
 * server cut at 100 tools or 256,000 characters (`toolsStale`: checking again saves every tool;
 * INTEGRATION_TOOLS_OLD_MAX); null when it holds them all, so a service with 186 tools just shows "186 tools". */
export function toolsShortfall(i: Pick<Integration, 'tools' | 'toolsTotal' | 'toolsTotalMore'>): 'integrations.toolsCapped' | 'integrations.toolsCappedMore' | 'integrations.toolsStale' | null {
  if (!i.toolsTotal) return null
  if (i.toolsTotalMore) return i.toolsTotal >= i.tools.length ? 'integrations.toolsCappedMore' : null
  if (i.toolsTotal <= i.tools.length) return null
  return i.tools.length > INTEGRATION_TOOLS_OLD_MAX ? 'integrations.toolsCapped' : 'integrations.toolsStale'
}

/** What Settings says under a connection that is connected although its last check failed (the server keeps a
 * connected MCP server whose list could not be read this time, slow or away for a moment, with the list saved before:
 * integrations/connections/service.ts check): why, and which list the AI uses. null: nothing failed, or the row's
 * status says it (an error, a sign-in needed). */
export function lastCheckNote(i: Pick<Integration, 'status' | 'lastError' | 'toolsUpdatedAt'>): { key: 'integrations.checkFailedKept' | 'integrations.lastCheckFailed'; reason: string; date: string | null } | null {
  if (i.status !== 'connected' || !i.lastError) return null
  return i.toolsUpdatedAt ? { key: 'integrations.checkFailedKept', reason: i.lastError, date: i.toolsUpdatedAt } : { key: 'integrations.lastCheckFailed', reason: i.lastError, date: null }
}

/** An address without what does not change the service (letter case, a trailing slash), to compare two of them. */
export function canonicalService(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

/** sign-in (OAuth) is offered: a connection with sign-in that the person manages (an MCP server, or an API with its own app) */
export const canSignIn = (i: Integration) => i.auth === 'oauth' && i.canManage

/** Personal connections first, then team ones; each by name. */
export function splitByScope(items: Integration[]): { mine: Integration[]; team: Integration[] } {
  const byName = (a: Integration, b: Integration) => a.name.localeCompare(b.name)
  return { mine: items.filter((x) => x.scope === 'personal' && !x.templateId).sort(byName), team: items.filter((x) => x.scope === 'team').sort(byName) }
}

const FIELD_OF: Record<string, FormField> = { name: 'name', slug: 'name', url: 'url', auth: 'method', authHeader: 'headerName', secret: 'secret', clearSecret: 'secret', notes: 'notes', writePolicy: 'writePolicy', access: 'access', oauthClient: 'clientId' }

/**
 * The form fields a refused save names (`fields` of a validation error: "body.url", "body.access.users" ...), with the
 * server's own words when it gave specific ones (they are in the person's language), else null (the screen says
 * "check this value"). Errors that name no field of the form: an empty object.
 */
export function serverFieldErrors(e: unknown): Partial<Record<FormField, string | null>>
export function serverFieldErrors<F extends string>(e: unknown, fieldOf: Record<string, F>): Partial<Record<F, string | null>>
export function serverFieldErrors(e: unknown, fieldOf: Record<string, string> = FIELD_OF): Partial<Record<string, string | null>> {
  if (!(e instanceof ApiError) || !e.body.fields) return {}
  const known = ERROR_MESSAGES[e.code]
  const specific = e.message && !(known && Object.values(known).includes(e.message)) ? e.message : null
  const out: Partial<Record<string, string | null>> = {}
  for (const key of Object.keys(e.body.fields)) {
    const parts = key.split('.')
    const field = fieldOf[(parts[0] === 'body' ? parts[1] : parts[0]) ?? '']
    if (field && !(field in out)) out[field] = specific
  }
  return out
}

// ---------------- asking a member to connect a service as their own (Admin › External services) ----------------
/** What an admin fills in for a member: the service, never a key (the member adds their own) and never 'none'. */
export interface RequestForm {
  userId: string
  kind: IntegrationKind
  name: string
  url: string
  method: 'oauth' | 'key'
  header: HeaderChoice
  headerName: string
  notes: string
}
export type RequestField = 'userId' | 'name' | 'url' | 'method' | 'headerName' | 'notes'

/** the request's fields a refused send names (serverFieldErrors) */
export const REQUEST_FIELD_OF: Record<string, RequestField> = { userId: 'userId', name: 'name', url: 'url', auth: 'method', authHeader: 'headerName', notes: 'notes' }

export const requestMethodsFor = (kind: IntegrationKind): ('oauth' | 'key')[] => (kind === 'mcp' ? ['oauth', 'key'] : ['key'])

export function emptyRequestForm(kind: IntegrationKind = 'mcp'): RequestForm {
  return { userId: '', kind, name: '', url: '', method: kind === 'mcp' ? 'oauth' : 'key', header: 'bearer', headerName: '', notes: '' }
}

/** the same limits as a connection's own fields (validate), plus the member */
export function validateRequest(f: RequestForm): Partial<Record<RequestField, MessageKey>> {
  const e: Partial<Record<RequestField, MessageKey>> = {}
  if (!f.userId) e.userId = 'integrations.request.error.user'
  const name = f.name.trim()
  if (!name) e.name = 'integrations.error.name'
  else if (name.length > NAME_MAX) e.name = 'integrations.error.nameLong'
  const url = urlProblem(f.url)
  if (url) e.url = url
  if (!requestMethodsFor(f.kind).includes(f.method)) e.method = 'integrations.error.field'
  if (f.method === 'key' && f.header === 'custom' && !HEADER_RE.test(f.headerName.trim())) e.headerName = 'integrations.error.header'
  if (f.kind === 'http' && f.notes.length > NOTES_MAX) e.notes = 'integrations.error.notes'
  return e
}

export function toRequestInput(f: RequestForm): IntegrationRequestInput {
  const auth = f.method === 'oauth' ? 'oauth' : f.header === 'custom' ? 'header' : 'bearer'
  return {
    userId: f.userId,
    kind: f.kind,
    name: f.name.trim(),
    url: f.url.trim(),
    auth,
    authHeader: auth === 'header' ? f.headerName.trim() : null,
    notes: f.kind === 'http' ? f.notes.trim() || null : null,
  }
}

export const REQUEST_STATE_TONE: Record<IntegrationRequestState, 'accent' | 'ok' | 'warn' | 'neutral'> = { waiting: 'accent', connected: 'ok', declined: 'warn', withdrawn: 'neutral', expired: 'neutral' }

/** The request a link opens (Settings › External services ?request=<id>): an id the server made, nothing else. */
export function requestIdFrom(search: string): string | null {
  const id = new URLSearchParams(search).get('request')
  return id && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null
}
