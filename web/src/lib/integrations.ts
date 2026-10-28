// External-service connections (Settings > External services, Admin > External services): the add / edit form as plain
// data, its checks (the same limits as shared/src/api/integrations.ts, so most mistakes show before anything is sent),
// the request bodies it becomes, and the checks on what the server sends back (the sign-in address).
// Keys are write-only: the form only ever holds a key the person is typing now; a stored one is `hasSecret`.
import { ApiError, ERROR_MESSAGES, type Integration, type IntegrationAccess, type IntegrationAuth, type IntegrationInput, type IntegrationKind, type IntegrationPatch, type IntegrationStatus, type WritePolicy } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

/** how the connection proves who it is: sign in at the service (MCP only), a key, or nothing */
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
}

export type FormField = 'name' | 'url' | 'method' | 'headerName' | 'secret' | 'notes' | 'writePolicy' | 'access'
export type FormErrors = Partial<Record<FormField, MessageKey>>

export const NAME_MAX = 60
export const URL_MAX = 2000
export const SECRET_MAX = 8000
export const NOTES_MAX = 4000
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/

export const methodsFor = (kind: IntegrationKind): SignInMethod[] => (kind === 'mcp' ? ['oauth', 'key', 'none'] : ['key', 'none'])

export const NOBODY: IntegrationAccess = { everyone: false, groups: [], users: [] }

export function emptyForm(kind: IntegrationKind = 'mcp', access: IntegrationAccess | null = null): IntegrationForm {
  return { kind, name: '', url: '', method: kind === 'mcp' ? 'oauth' : 'key', header: 'bearer', headerName: '', secret: '', keyAction: 'keep', notes: '', writePolicy: 'ask', access }
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
  }
}

/** another kind: sign-in is for MCP servers only, so an API connection falls back to a key */
export function withKind(f: IntegrationForm, kind: IntegrationKind): IntegrationForm {
  return { ...f, kind, method: methodsFor(kind).includes(f.method) ? f.method : 'key' }
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
  return !!original && original.hasSecret && (f.url.trim() !== original.url || authOf(f) !== original.auth)
}

/** a key has to be typed before saving */
export function needsKey(f: IntegrationForm, original?: Integration): boolean {
  if (f.method !== 'key' || (original && f.keyAction === 'remove')) return false
  return !original || !original.hasSecret || dropsSecret(f, original) || f.keyAction === 'replace'
}

export function validate(f: IntegrationForm, original?: Integration): FormErrors {
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

/** sign-in (OAuth) is offered: an MCP server with sign-in that the person manages */
export const canSignIn = (i: Integration) => i.kind === 'mcp' && i.auth === 'oauth' && i.canManage

/** Personal connections first, then team ones; each by name. */
export function splitByScope(items: Integration[]): { mine: Integration[]; team: Integration[] } {
  const byName = (a: Integration, b: Integration) => a.name.localeCompare(b.name)
  return { mine: items.filter((x) => x.scope === 'personal').sort(byName), team: items.filter((x) => x.scope === 'team').sort(byName) }
}

const FIELD_OF: Record<string, FormField> = { name: 'name', slug: 'name', url: 'url', auth: 'method', authHeader: 'headerName', secret: 'secret', clearSecret: 'secret', notes: 'notes', writePolicy: 'writePolicy', access: 'access' }

/**
 * The form fields a refused save names (`fields` of a validation error: "body.url", "body.access.users" ...), with the
 * server's own words when it gave specific ones (they are in the person's language), else null (the screen says
 * "check this value"). Errors that name no field of the form: an empty object.
 */
export function serverFieldErrors(e: unknown): Partial<Record<FormField, string | null>> {
  if (!(e instanceof ApiError) || !e.body.fields) return {}
  const known = ERROR_MESSAGES[e.code]
  const specific = e.message && !(known && Object.values(known).includes(e.message)) ? e.message : null
  const out: Partial<Record<FormField, string | null>> = {}
  for (const key of Object.keys(e.body.fields)) {
    const parts = key.split('.')
    const field = FIELD_OF[(parts[0] === 'body' ? parts[1] : parts[0]) ?? '']
    if (field && !(field in out)) out[field] = specific
  }
  return out
}
