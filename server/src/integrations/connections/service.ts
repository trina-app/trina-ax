// External-service connections (docs/INTEGRATIONS.md): personal ones (a member's own account, used only in their chats)
// and team ones (an admin's, used by the people the admin chose). Creating, changing, checking, signing in at an MCP
// server (OAuth), and the calls the AI's tools make (integrations/connections/tools.ts). Nothing here ever returns,
// logs or audits a key or a token; a check stores a reason code, never the service's own words. What a service sends
// back has the connection's secrets hidden (hider, hide.ts) before anyone sees it.
import crypto from 'node:crypto'
import path from 'node:path'
import net from 'node:net'
import type { Integration, IntegrationAccess, IntegrationFlow, IntegrationInput, IntegrationKind, IntegrationList, IntegrationPatch, Locale, OAuthClientInput } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { audit } from '../../admin/audit'
import { getTeamSettings } from '../../admin/settings'
import { fail, HttpError } from '../../http/errors'
import { resolveLayout } from '../../system/layout'
import { egressOf } from '../../tools/egress'
import { checkHostName, isLocalAddress, isPublicAddress } from '../../tools/web-fetch'
import { secretHider } from './hide'
import { MCP_LIST_TIMEOUT_MS, McpClient, McpError } from './mcp'
import { NetError, serviceRequest, TIMEOUT_MS, type NetOptions, type NetResponse } from './net'
import { authorizationUrl, canonicalResource, discover, GrantError, issuerMatches, manualServer, ownClient, register, revoke, tokenRequest, type OAuthClient, type OAuthSecret, type OAuthServer, type OAuthTokens, type OwnClient } from './oauth'
import {
  accessOf, activeUser, clientAad, clientInfo, connectionAad, disabledTools, flowAad, getRow, isAdmin, MAX_DISABLED_TOOLS, mayUse, requestSignedIn, savedTools, SecretBox, secretHere, selectRows, setAccess, StoreError, templateClientAad, templateCovers, toolListsOf, usable, view,
  type ClientInfo, type FlowRow, type Row, type Viewer,
} from './store'
import { say, type Reason, type TextKey } from './text'
import { notifyTemplateReconnect } from '../../notifications/service'
import { refreshGoogleApp } from '../google-apps/tokens'
import { APP_NAMES, appTools } from '../google-apps/catalog'
import { downMessage, libraryRequest, LibraryDown } from '../google-apps/transport'
import { workspaceLibraryOf } from '../google-apps/library'

export const MAX_PERSONAL = 20
/** to a member whose connection made from a template was dropped: their Connectors page reads its lists again (no text:
 * the inbox notice says what to do, notifyTemplateReconnect) */
export const INTEGRATIONS_CHANGED = { type: 'notice', data: { level: 'info', code: 'integrations_changed', message: '' } } as const
export const MAX_TEAM = 50
const FLOW_TTL = 10 * 60_000
const FLOWS_PER_HOUR = 20
const CLIENT_IDLE_MS = 10 * 60_000
/** earlier secret values remembered per connection for hiding (OAuth tokens rotate; an old one may still work) */
const RECENT_SECRETS = 16
/** what is shown instead of an answer when the connection's secret cannot be read to hide it */
export const WITHHELD = '(not shown: this answer could not be checked for the connection\'s key)'
/** headers a connection's key may not be sent in (they would break the request or our own MCP headers) */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect', 'accept',
  'accept-encoding', 'user-agent', 'cookie', 'mcp-session-id', 'mcp-protocol-version', 'proxy-authorization', 'keep-alive'])

type KeySecret = { type: 'key'; key: string }
type Secret = KeySecret | OAuthSecret
/** pinOnto: the own app as read when the sign-in started, when it has a client secret, finds its addresses and has no
 * token address remembered yet: the one this sign-in uses is remembered onto it once the sign-in worked (pinFound).
 * appVersion: for a member's connection made from a template with an app, the template's version then (callback).
 * own: signed in through an own app, the person's own ('mine', their connection's 고급) or the one an admin set on the
 * template the connection was made from ('template', which the member never sees): a refused one is said as such, with
 * who can fix it (true: from a build before this was told apart, read as 'mine') */
interface FlowSecret {
  verifier: string; server: OAuthServer; client: OAuthClient; resource: string | null; scope: string | null
  pinOnto?: { json: string; enc: string | null } | null; appVersion?: number | null; own?: 'mine' | 'template' | boolean
}
/** Why a sign-in did not finish (integration_oauth_flows.reason, IntegrationFlow.reason; the app says it in words,
 * web/src/lib/integrations.ts flowReasonKey): the person said no at the service (denied), the answer was not one we
 * can use (invalid), the connection or its app changed meanwhile (changed), an own app's client ID or secret was
 * refused at the token address (client: the person's own app; client_template: the app an admin set on the template),
 * another error there (exchange), a newer sign-in started (superseded). */
export type FlowFailure = 'denied' | 'invalid' | 'changed' | 'client' | 'client_template' | 'exchange' | 'superseded'
/** The sign-in window's answer: done, or why not (null: not a sign-in this browser may finish, e.g. not signed in to
 * the team here, or the link was used already) */
export type CallbackResult = { ok: true } | { ok: false; reason: FlowFailure | null }
/** the token address refused the client itself (RFC 6749 5.2), not the code */
const CLIENT_REFUSED = new Set(['invalid_client', 'unauthorized_client'])
/** an own app's client secret as sealed (clientAad, templateClientAad) */
export interface SealedClientSecret { clientSecret: string }

/** A call the AI made could not run. The message is for the AI (never a secret); `kind` is the audit summary's word, and
 * `answered`: the service did answer (a JSON-RPC error), so the answer counts as external data. */
export class CallError extends Error {
  name = 'CallError'
  constructor(message: string, readonly kind = 'error', readonly answered = false) { super(message) }
}
class NeedsAuth extends Error { constructor(readonly reason: Reason) { super(reason) } }

export interface IntegrationDeps { net?: NetOptions; now?: () => number }

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const iso = (ms: number) => new Date(ms).toISOString()

/** A short name from the connection's name: lower-case letters and digits, at most 12. */
export function slugOf(name: string, kind: 'mcp' | 'http'): string {
  const s = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
  return s || (kind === 'mcp' ? 'mcp' : 'api')
}

/** Refused before any lookup: an address that names this computer or a private network outright. */
export function obviouslyPrivate(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) return !isPublicAddress(host) || isLocalAddress(host)
  return !!checkHostName(host)
}

export const normUrl = (u: string) => new URL(u).href
/** names go into the AI's instructions and tool descriptions: one line, no control characters */
export const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
export const cleanNotes = (s: string | null | undefined) => s?.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim() || null

// Characters that show nothing or turn the text around them: format characters (zero-width ones, bidi marks,
// overrides and isolates, the tag block), other default-ignorable ones (variation selectors, Hangul fillers),
// private-use characters, lone surrogates, noncharacters and C1 controls. ASCII controls are not here: oneLine and
// cleanNotes make them spaces.
const HIDDEN = /[\p{Cf}\p{DI}\p{Co}\p{Cs}\p{Noncharacter_Code_Point}\u0080-\u009f]/u
const EMOJI = /\p{Emoji}/u
const PICTOGRAPH = /\p{Extended_Pictographic}/u
/** an emoji ends just before `i` (its emoji selector and skin tone may follow it) */
const pictographBefore = (cps: string[], i: number) => {
  let j = i - 1
  if (cps[j] === '\ufe0f') j--
  if (j >= 0 && /\p{Emoji_Modifier}/u.test(cps[j]!)) j--
  return j >= 0 && PICTOGRAPH.test(cps[j]!)
}
/**
 * Whether the text holds a character a person cannot see or that changes the direction of the text (HIDDEN): text the
 * AI writes for a person to approve (a connection's name and notes, connect_service's line on the card) could hide
 * words from them that the AI reads later. Emoji keep working: a zero-width joiner between two emoji ("👩\u200d💻") and an
 * emoji's presentation selector ("❤\ufe0f") are allowed; Korean, Japanese and line breaks have none of these characters.
 */
export function hiddenText(s: string): boolean {
  const cps = [...s]
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!
    if (!HIDDEN.test(c)) continue
    if ((c === '\ufe0f' || c === '\ufe0e') && i > 0 && EMOJI.test(cps[i - 1]!)) continue
    if (c === '\u200d' && pictographBefore(cps, i) && PICTOGRAPH.test(cps[i + 1] ?? '')) continue
    return true
  }
  return false
}
/** what the admin audit says about a change: team connections in full; a member's own ones without name or address */
const auditDetail = (row: Pick<Row, 'scope' | 'kind' | 'auth' | 'name' | 'url'>, more: Record<string, unknown> = {}) =>
  row.scope === 'team' ? { scope: row.scope, kind: row.kind, name: row.name, host: new URL(row.url).host, auth: row.auth, ...more } : { scope: row.scope, kind: row.kind, auth: row.auth }

/** A refusal of one field: `validation`, the words (in the person's language) under that field too. */
export function fieldError(L: Locale, field: string, key: TextKey, vars: Record<string, string | number> = {}): never {
  const m = say(key, L, vars)
  return fail('validation', m, { fields: { [`body.${field}`]: m } })
}

/** An own app as it is stored (docs/INTEGRATIONS.md "Your own app"): its addresses checked like a connection's (https,
 * not this server or the office network); an HTTP API needs both addresses (nothing to find them from). Also for a
 * template's app (templates.ts). */
export function appFrom(kind: IntegrationKind, input: OAuthClientInput, L: Locale): ClientInfo {
  const authorizationUrl = input.authorizationUrl ? normUrl(input.authorizationUrl) : null
  const tokenUrl = input.tokenUrl ? normUrl(input.tokenUrl) : null
  if (!authorizationUrl !== !tokenUrl || (kind === 'http' && !tokenUrl)) fieldError(L, 'oauthClient', 'oauthHttpNeedsApp')
  for (const u of [authorizationUrl, tokenUrl]) if (u && obviouslyPrivate(u)) fieldError(L, 'oauthClient', 'private_address')
  if (hiddenText(input.clientId) || (input.scope && hiddenText(input.scope))) fieldError(L, 'oauthClient', 'appHidden')
  return { clientId: input.clientId.trim(), authorizationUrl, tokenUrl, scope: input.scope?.trim() || null }
}

export class Integrations {
  readonly box: SecretBox
  readonly net: NetOptions
  readonly now: () => number
  private clients = new Map<string, McpClient>()
  private refreshes = new Map<string, Promise<string>>()
  private recent = new Map<string, string[]>()

  constructor(readonly ctx: AppContext, deps: IntegrationDeps = {}) {
    this.now = deps.now ?? Date.now
    this.box = new SecretBox(path.join(resolveLayout(ctx.config).secretsDir, 'integrations', 'connections'))
    this.net = { ...deps.net, blockedIps: () => [...(deps.net?.blockedIps?.() ?? []), ...egressOf(ctx).ips] }
  }
  private get db() { return this.ctx.db }

  // ---------------- reading ----------------
  list(viewer: Viewer, locale: Locale): IntegrationList {
    // Gmail, Calendar, Docs and Sheets have their own page (google-apps/): not in the generic list
    const personal = this.db.query(`${selectRows(this.db)} WHERE scope = 'personal' AND owner_user_id = ? AND google_app IS NULL ORDER BY name, id`).all(viewer.id) as Row[]
    const team = (this.db.query(`${selectRows(this.db)} WHERE scope = 'team' ORDER BY name, id`).all() as Row[]).filter((r) => mayUse(this.db, r, viewer.id))
    return { items: [...personal, ...team].map((r) => view(this.db, r, viewer, locale)), personalAllowed: getTeamSettings(this.db).personalIntegrations }
  }
  listTeam(viewer: Viewer, locale: Locale): Integration[] {
    return (this.db.query(`${selectRows(this.db)} WHERE scope = 'team' ORDER BY name, id`).all() as Row[]).map((r) => view(this.db, r, viewer, locale))
  }
  /** connections this person may use in a chat now (tools.ts) */
  usable(userId: string): Row[] { return usable(this.db, userId) }

  /** The row for a manage action: someone else's personal connection is "not found"; a team one needs an admin. */
  private manageable(viewer: Viewer, id: string): Row {
    const row = getRow(this.db, id)
    // a Google app connection is managed on its own page only (google-apps/service.ts)
    if (!row || row.google_app || !activeUser(this.db, viewer.id)) return fail('not_found')
    if (row.scope === 'personal') return row.owner_user_id === viewer.id ? row : fail('not_found')
    if (isAdmin(viewer.role)) return row
    return mayUse(this.db, row, viewer.id) ? fail('forbidden') : fail('not_found')
  }

  // ---------------- creating and changing ----------------
  /** `templateId`: a member's own connection made from an admin's template (templates.ts connect, which checked that
   * the template is for them and filled in its address, sign-in method and header). The team's switch for members' own
   * connections and their limit of MAX_PERSONAL do not apply to it: the admin registered the service. */
  async create(viewer: Viewer, input: IntegrationInput, scope: 'personal' | 'team', locale: Locale, templateId?: string): Promise<Integration> {
    const L = locale
    if (templateId && scope !== 'personal') fail('validation')
    if (scope === 'personal' && !templateId && !getTeamSettings(this.db).personalIntegrations) fail('forbidden', say('personalOff', L))
    if (scope === 'personal' && input.access) fieldError(L, 'access', 'accessTeamOnly')
    // sending without asking is the team's choice (an admin's), never one person's for their own connection
    if (scope === 'personal' && input.writePolicy === 'allow') fieldError(L, 'writePolicy', 'allowTeamOnly')
    const count = templateId ? 0 : scope === 'personal'
      ? (this.db.query("SELECT count(*) AS n FROM integrations WHERE scope = 'personal' AND owner_user_id = ? AND template_id IS NULL AND google_app IS NULL").get(viewer.id) as { n: number }).n
      : (this.db.query("SELECT count(*) AS n FROM integrations WHERE scope = 'team'").get() as { n: number }).n
    const max = scope === 'personal' ? MAX_PERSONAL : MAX_TEAM
    if (count >= max) fail('conflict', say('tooMany', L, { n: max }))
    const authHeader = input.auth === 'header' ? this.headerName(input.authHeader ?? null, L) : null
    // a template's members sign in through the template's app (templates.ts), never one of their own
    if (input.oauthClient && (input.auth !== 'oauth' || templateId)) fieldError(L, 'oauthClient', 'appNeedsOauth')
    if (input.auth === 'oauth' && input.kind !== 'mcp' && !templateId && !input.oauthClient) fieldError(L, 'oauthClient', 'oauthHttpNeedsApp')
    const id = newId()
    if (input.secret !== undefined && input.auth !== 'bearer' && input.auth !== 'header') fieldError(L, 'secret', 'keyNeedsKeyAuth')
    if (input.secret !== undefined && /[\r\n\0]/.test(input.secret)) fieldError(L, 'secret', 'keyLineBreak')
    const url = normUrl(input.url)
    if (obviouslyPrivate(url)) fieldError(L, 'url', 'private_address')
    const owner = scope === 'personal' ? viewer.id : null
    const slug = this.freeSlug(scope, owner, input.slug ?? null, input.name, input.kind, L)
    if (input.access) this.checkAccess(input.access, L)
    const app = input.oauthClient ? this.appAfter(clientAad({ id, scope, owner_user_id: owner }), { json: null, enc: null, keyVersion: 1 }, input.kind, input.auth, input.oauthClient, { before: url, after: url }, L) : null
    const now = iso(this.now())
    const row: Row = {
      id, scope, owner_user_id: owner, created_by: viewer.id, kind: input.kind, name: oneLine(input.name), slug, url, auth: input.auth, auth_header: authHeader,
      secret_enc: null, key_version: 1, account: null, notes: cleanNotes(input.notes), write_policy: input.writePolicy ?? 'ask',
      status: input.auth === 'oauth' ? 'needs_auth' : 'error', last_error: input.auth === 'oauth' ? 'sign_in' : input.auth === 'none' ? null : 'no_secret', tools_rev: 0, tools_updated_at: null,
      last_used_at: null, version: 1, created_at: now, updated_at: now, disabled_tools: '[]', template_id: templateId ?? null,
      oauth_client: app?.json ?? null, oauth_client_enc: app?.enc ?? null, oauth_client_key_version: app?.keyVersion ?? 1,
    }
    if (input.secret !== undefined) {
      const sealed = this.sealFor(row, { type: 'key', key: input.secret } satisfies KeySecret, L)
      row.secret_enc = sealed.enc; row.key_version = sealed.keyVersion; row.last_error = null
    }
    this.db.transaction(() => {
      this.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, auth_header, secret_enc, key_version, account, notes,
        write_policy, status, last_error, tools_json, tools_updated_at, last_used_at, version, created_at, updated_at, template_id, oauth_client, oauth_client_enc, oauth_client_key_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,?,?,?,?,?,?)`)
        .run(row.id, row.scope, row.owner_user_id, row.created_by, row.kind, row.name, row.slug, row.url, row.auth, row.auth_header, row.secret_enc, row.key_version,
          row.account, row.notes, row.write_policy, row.status, row.last_error, row.tools_updated_at, row.last_used_at, row.version, row.created_at, row.updated_at, row.template_id ?? null,
          row.oauth_client ?? null, row.oauth_client_enc ?? null, row.oauth_client_key_version ?? 1)
      if (scope === 'team') setAccess(this.db, id, input.access ?? { everyone: false, groups: [], users: [] })
    })()
    // made from a template: logged like any member's own connection, without which template (that would say which
    // service, and that this member connected it: admins see only how many did)
    audit(this.db, { actor: viewer.id, action: 'integration.create', target: id, detail: auditDetail(row, { slug, writePolicy: row.write_policy, access: scope === 'team' ? accessOf(this.db, id) : undefined, ...(app ? { ownApp: true } : {}) }) })
    const checked = await this.check(getRow(this.db, id)!)
    return view(this.db, checked, viewer, L)
  }

  async update(viewer: Viewer, id: string, patch: IntegrationPatch, locale: Locale): Promise<Integration> {
    const L = locale
    const row = this.manageable(viewer, id)
    // made from an admin's template: the address, sign-in method, header, name and notes are the template's (a key
    // must only ever go where the admin registered); the member changes only their key and the write rule
    if (row.template_id) {
      for (const k of ['name', 'url', 'auth', 'authHeader', 'notes', 'access', 'oauthClient'] as const) if (patch[k] !== undefined) fieldError(L, k, 'fromTemplate')
    }
    const next: Row = { ...row }
    const changed: string[] = []
    if (patch.name !== undefined && oneLine(patch.name) !== row.name) { next.name = oneLine(patch.name); changed.push('name') }
    if (patch.notes !== undefined && cleanNotes(patch.notes) !== row.notes) { next.notes = cleanNotes(patch.notes); changed.push('notes') }
    if (patch.writePolicy === 'allow' && row.scope === 'personal') fieldError(L, 'writePolicy', 'allowTeamOnly')
    if (patch.writePolicy !== undefined && patch.writePolicy !== row.write_policy) { next.write_policy = patch.writePolicy; changed.push('writePolicy') }
    if (patch.url !== undefined && normUrl(patch.url) !== row.url) {
      next.url = normUrl(patch.url)
      if (obviouslyPrivate(next.url)) fieldError(L, 'url', 'private_address')
      changed.push('url')
    }
    if (patch.auth !== undefined && patch.auth !== row.auth) { next.auth = patch.auth; changed.push('auth') }
    // the own app: a new one (another ID, secret, address or scope) is a new way in, like a new address
    if (!row.template_id) {
      const app = this.appAfter(clientAad(row), { json: row.oauth_client ?? null, enc: row.oauth_client_enc ?? null, keyVersion: row.oauth_client_key_version ?? 1 }, next.kind, next.auth, patch.oauthClient, { before: row.url, after: next.url }, L)
      if (app.changed) changed.push('oauthClient')
      else if (app.forgot) changed.push('tokenAddress')
      next.oauth_client = app.json; next.oauth_client_enc = app.enc; next.oauth_client_key_version = app.keyVersion
    }
    if (next.auth === 'header') {
      const h = patch.authHeader !== undefined ? patch.authHeader : row.auth_header
      next.auth_header = this.headerName(h ?? null, L)
    } else next.auth_header = null
    if (next.auth_header !== row.auth_header && !changed.includes('auth')) changed.push('authHeader')
    if (patch.secret !== undefined && next.auth !== 'bearer' && next.auth !== 'header') fieldError(L, 'secret', 'keyNeedsKeyAuth')
    if (patch.secret !== undefined && /[\r\n\0]/.test(patch.secret)) fieldError(L, 'secret', 'keyLineBreak')
    if (patch.access !== undefined && row.scope !== 'team') fieldError(L, 'access', 'accessTeamOnly')
    if (patch.access) this.checkAccess(patch.access, L)
    // a stored key or sign-in is never sent to another address or in another way: it goes unless a new key comes with it
    const moved = changed.some((c) => c === 'url' || c === 'auth' || c === 'authHeader' || c === 'oauthClient')
    let secret: 'kept' | 'replaced' | 'removed' = 'kept'
    const old = row.secret_enc ? this.tryOpen(row) : null
    if (patch.secret !== undefined) {
      const sealed = this.sealFor(next, { type: 'key', key: patch.secret } satisfies KeySecret, L)
      next.secret_enc = sealed.enc; next.key_version = sealed.keyVersion; secret = 'replaced'
    } else if ((moved || patch.clearSecret) && row.secret_enc) { next.secret_enc = null; secret = 'removed' }
    // a moved connection's saved tools go too (the UPDATE below empties tools_json)
    if (moved) { next.tools_updated_at = null; next.account = null }
    const recheck = moved || secret !== 'kept'
    if (recheck) { next.status = next.auth === 'oauth' && !next.secret_enc ? 'needs_auth' : 'error'; next.last_error = next.auth === 'none' || next.secret_enc ? null : next.auth === 'oauth' ? 'sign_in' : 'no_secret' }
    const accessBefore = row.scope === 'team' ? accessOf(this.db, id) : null
    const now = iso(this.now())
    this.db.transaction(() => {
      const r = this.db.query(`UPDATE integrations SET name=?, notes=?, write_policy=?, url=?, auth=?, auth_header=?, secret_enc=?, key_version=?, account=?,
        tools_json=CASE WHEN ? THEN '[]' ELSE tools_json END, tools_updated_at=?, status=?, last_error=?, oauth_client=?, oauth_client_enc=?, oauth_client_key_version=?,
        version=version+1, updated_at=? WHERE id=? AND version=?`)
        .run(next.name, next.notes, next.write_policy, next.url, next.auth, next.auth_header, next.secret_enc, next.key_version, next.account, moved ? 1 : 0,
          next.tools_updated_at, next.status, next.last_error, next.oauth_client ?? null, next.oauth_client_enc ?? null, next.oauth_client_key_version ?? 1, now, id, row.version)
      if (!r.changes) fail('conflict')
      if (patch.access) setAccess(this.db, id, patch.access)
      // the sign-in is gone (removed, or moved with the address or the way in): so is the record of whose it was
      if (secret !== 'kept') this.db.query("DELETE FROM team_sign_ins WHERE kind = 'team_connection' AND target_id = ?").run(id)
    })()
    this.dropClient(id)
    // one entry per change; who may use a team connection is part of it (before and after)
    const accessAfter = row.scope === 'team' ? accessOf(this.db, id) : null
    const accessChanged = !!patch.access && JSON.stringify(accessBefore) !== JSON.stringify(accessAfter)
    if (accessChanged) changed.push('access')
    if (changed.length || secret !== 'kept') {
      audit(this.db, { actor: viewer.id, action: 'integration.update', target: id, detail: { ...auditDetail(next), changed, secret, ...(accessChanged ? { access: { before: accessBefore, after: accessAfter } } : {}) } })
    }
    if (old?.type === 'oauth' && (secret !== 'kept')) void this.revokeTokens(old)
    const cur = getRow(this.db, id)!
    return view(this.db, recheck ? await this.check(cur) : cur, viewer, L)
  }

  /** One tool of an MCP connection on or off for the AI, by whoever manages the connection (manageable: the owner of a
   * personal one, an admin for a team one). Only a tool the service lists now can be changed; names stay off when the
   * tool disappears. The version moves on, so a write the AI asked for before is asked again (tools.ts). */
  setTool(viewer: Viewer, id: string, name: string, enabled: boolean, locale: Locale): Integration {
    const L = locale
    const row = this.manageable(viewer, id)
    if (row.kind !== 'mcp') fieldError(L, 'name', 'toolsMcpOnly')
    if (!savedTools(this.db, row).some((t) => t.name === name)) fieldError(L, 'name', 'toolUnknown')
    const off = disabledTools(row)
    if (off.has(name) === !enabled) return view(this.db, row, viewer, L)
    if (enabled) off.delete(name)
    else {
      off.add(name)
      // names of tools the service no longer lists go first when the list is full
      if (off.size > MAX_DISABLED_TOOLS) {
        const listed = new Set(savedTools(this.db, row).map((t) => t.name))
        for (const n of [...off]) { if (off.size <= MAX_DISABLED_TOOLS) break; if (!listed.has(n)) off.delete(n) }
      }
    }
    const r = this.db.query('UPDATE integrations SET disabled_tools=?, version=version+1, updated_at=? WHERE id=? AND version=?')
      .run(JSON.stringify([...off].sort()), iso(this.now()), id, row.version)
    if (!r.changes) fail('conflict')
    // a member's own connection: not which tool (its name says which service), as for its name and address
    audit(this.db, { actor: viewer.id, action: 'integration.update', target: id, detail: { ...auditDetail(row), changed: ['tools'], enabled, ...(row.scope === 'team' ? { tool: name } : {}), off: off.size } })
    return view(this.db, getRow(this.db, id)!, viewer, L)
  }

  async remove(viewer: Viewer, id: string): Promise<void> {
    const row = this.manageable(viewer, id)
    const old = row.secret_enc ? this.tryOpen(row) : null
    // local first: the tokens are gone even when the service cannot be told
    this.db.query('DELETE FROM integrations WHERE id = ?').run(id)
    this.db.query("DELETE FROM team_sign_ins WHERE kind = 'team_connection' AND target_id = ?").run(id)
    this.dropClient(id)
    this.recent.delete(id)
    toolListsOf(this.db).drop(id)
    audit(this.db, { actor: viewer.id, action: 'integration.delete', target: id, detail: auditDetail(row) })
    if (old?.type === 'oauth') await this.revokeTokens(old)
  }

  /** Delete connections made from an admin's template (templates.ts: the template moved to another address or sign-in,
   * was deleted, or no longer covers their member). Local first, then each OAuth sign-in is revoked at its service:
   * waited for when an admin's change caused it (`wait`), only started when a list someone loads found it (sweep).
   * `actor`: who caused it (null: nobody, e.g. a group change); `why` goes into the activity log, as for any member's
   * own connection without its name, address, template or member. */
  async dropFromTemplate(rows: Row[], actor: string | null, why: 'template_moved' | 'template_deleted' | 'not_covered', wait = true): Promise<void> {
    const olds: Secret[] = []
    const owners = new Set<string>()
    for (const row of rows) {
      if (!row.template_id) continue
      const old = row.secret_enc ? this.tryOpen(row) : null
      if (!this.db.query('DELETE FROM integrations WHERE id = ? AND template_id = ?').run(row.id, row.template_id).changes) continue
      if (row.owner_user_id) owners.add(row.owner_user_id)
      this.dropClient(row.id)
      this.recent.delete(row.id)
      toolListsOf(this.db).drop(row.id)
      audit(this.db, { actor, action: 'integration.delete', target: row.id, detail: { ...auditDetail(row), why } })
      if (old?.type === 'oauth') olds.push(old)
      // the template moved (a new address, sign-in method or header): the member connects it again, and is told so
      // (its id and new version only; never the address)
      if (why === 'template_moved' && row.owner_user_id) {
        const t = this.db.query('SELECT version FROM integration_templates WHERE id = ?').get(row.template_id) as { version: number } | null
        if (t) notifyTemplateReconnect(this.ctx, row.owner_user_id, row.template_id, t.version)
      }
    }
    // a member's page open now still shows the connection: it reads its lists again (a quiet notice, no text; QA on dev
    // 1565b39f1: the old row's "try again" said "not found" until a reload)
    for (const id of owners) {
      try { this.ctx.services.realtime.publish(id, INTEGRATIONS_CHANGED) } catch (err) { this.ctx.log.warn('connections notice failed', { err }) }
    }
    const revoking = Promise.all(olds.map((o) => this.revokeTokens(o).catch(() => false)))
    if (wait) await revoking
  }

  /** Who signed a team connection in (team_sign_ins, migration 270: set by the sign-in, cleared when it ends), or null
   * when that is not known (signed in before the record existed). 팀장 넘기기 (admin/handover.ts) lists the ones signed in
   * with the owner's own account; never read from the audit log, whose details hold names an admin or a service picks. */
  teamSigner(id: string): string | null {
    return (this.db.query("SELECT user_id FROM team_sign_ins WHERE kind = 'team_connection' AND target_id = ?").get(id) as { user_id: string } | null)?.user_id ?? null
  }

  /** 팀장 넘기기 (admin/handover.ts): a team connection signed in with the account of the person handing the team over
   * ends that sign-in. The connection stays (its address, rule and tools: an admin signs in again with another account);
   * its tokens go at once, calls under way get a fresh client, then the service is told. Only a team OAuth connection
   * whose last sign-in was `signer`'s and that still holds tokens; null otherwise (nothing changed). */
  async endTeamSignIn(id: string, signer: string, actor: string | null): Promise<'revoked' | 'unavailable' | null> {
    const row = getRow(this.db, id)
    if (!row || row.scope !== 'team' || row.auth !== 'oauth' || !row.secret_enc || this.teamSigner(id) !== signer) return null
    const old = this.tryOpen(row)
    const n = this.db.query("UPDATE integrations SET secret_enc=NULL, status='needs_auth', last_error=NULL, version=version+1, updated_at=? WHERE id=? AND version=? AND secret_enc IS NOT NULL")
      .run(iso(this.now()), id, row.version).changes
    if (!n) return null
    this.db.query("DELETE FROM team_sign_ins WHERE kind = 'team_connection' AND target_id = ?").run(id)
    this.dropClient(id)
    audit(this.db, { actor, action: 'integration.update', target: id, detail: { ...auditDetail(row), changed: ['signOut'], secret: 'removed', reason: 'owner_handover' } })
    if (old?.type !== 'oauth') return 'unavailable'
    return (await this.revokeTokens(old).catch(() => false)) ? 'revoked' : 'unavailable'
  }

  /** A member's sign-ins at services made from templates, read before their account goes (admin/users.ts deleteUser
   * deletes the rows): what tells those services, run after the local delete and not waited for. */
  signInsToRevoke(userId: string): () => void {
    const rows = this.db.query(`${selectRows(this.db)} WHERE scope = 'personal' AND owner_user_id = ? AND template_id IS NOT NULL AND auth = 'oauth' AND secret_enc IS NOT NULL`).all(userId) as Row[]
    const olds = rows.map((r) => this.tryOpen(r)).filter((s): s is Secret => s?.type === 'oauth')
    return () => { for (const o of olds) void this.revokeTokens(o).catch(() => false) }
  }

  async refresh(viewer: Viewer, id: string, locale: Locale): Promise<Integration> {
    const row = this.manageable(viewer, id)
    this.stillCovered(row, viewer, locale)
    return view(this.db, await this.check(row), viewer, locale)
  }

  /** The own app after a change (a connection's, or a template's: templates.ts). `input` undefined keeps it, null
   * removes it, an app replaces it. It goes with sign-in (another way in has no app), and an HTTP API's sign-in needs one.
   * The secret is write-only, and a stored one only ever goes where it went before (docs/INTEGRATIONS.md "Secrets": a key
   * is never sent anywhere else): it stays only with the same client ID, the same sign-in and token addresses and the
   * same service address (`url` before and after the change), also when the app's addresses are given: the people who
   * sign in through the app send their tokens to the service address, and whoever typed the secret chose that one
   * (review 3: a second admin moved a template elsewhere and kept the first admin's app). Otherwise it goes unless a new
   * one comes. A secret kept or entered is bound to the service address (boundUrl, store.ts secretHere).
   * `changed`: another ID, secret, address or scope (a sign-in made with the old app is dropped). A change that leaves
   * the secret where it was never opens it (a key folder that cannot be read must not cost the secret, or a template's
   * members their connections, on a rename); it is opened only to compare a secret typed again. The token address a
   * sign-in found (pinFound) stays while the place and the secret do, also when only the scope changes; a secret entered
   * with the app, the same one too, forgets it (what appTokenMoved asks the admin to do when the server moved it). */
  appAfter(aad: string, prev: { json: string | null; enc: string | null; keyVersion: number }, kind: IntegrationKind, auth: Row['auth'], input: OAuthClientInput | null | undefined, url: { before: string; after: string }, L: Locale) {
    const was = clientInfo(prev.json)
    if (input && auth !== 'oauth') fieldError(L, 'oauthClient', 'appNeedsOauth')
    const app = auth !== 'oauth' || input === null ? null : input ? appFrom(kind, input, L) : was
    let out: { json: string | null; enc: string | null; keyVersion: number; changed: boolean } = { json: null, enc: null, keyVersion: 1, changed: !!was || !!prev.enc }
    if (app) {
      // the stored secret, unless it was entered for another address (an older build moved the connection without it)
      const kept = secretHere(was, prev.enc, url.before) ? prev.enc : null
      const samePlace = !!was && was.clientId === app.clientId && was.authorizationUrl === app.authorizationUrl && was.tokenUrl === app.tokenUrl && url.after === url.before
      const typed = input?.clientSecret
      let sealed: { enc: string; keyVersion: number } | null = null
      if (typed !== undefined) {
        // the same secret typed again keeps its sealed value (when it can be read to compare); another one is sealed anew
        const old = samePlace && kept ? this.tryOpenClient(aad, kept, prev.keyVersion) : null
        sealed = old !== null && old === typed && kept ? { enc: kept, keyVersion: prev.keyVersion } : this.sealClient(aad, typed, L)
      } else if (samePlace && kept) sealed = { enc: kept, keyVersion: prev.keyVersion }
      const secretSame = (sealed?.enc ?? null) === prev.enc
      const same = samePlace && was!.scope === app.scope && secretSame
      const { foundTokenUrl: _found, boundUrl: _bound, ...plain } = app
      const pin = samePlace && secretSame && typed === undefined && was!.foundTokenUrl ? { foundTokenUrl: was!.foundTokenUrl } : {}
      const json = JSON.stringify({ ...plain, ...pin, ...(sealed ? { boundUrl: url.after } : {}) })
      // the stored text stays when nothing in it changes (it is a policy column)
      out = { json: JSON.stringify(clientInfo(json)) === JSON.stringify(was) ? prev.json : json, enc: sealed?.enc ?? null, keyVersion: sealed?.keyVersion ?? 1, changed: !same }
    }
    if (auth === 'oauth' && kind === 'http' && !clientInfo(out.json)?.tokenUrl) fieldError(L, 'oauthClient', 'oauthHttpNeedsApp')
    // the same app, but the token address a sign-in found is forgotten: a choice to trust the next one (audited)
    return { ...out, forgot: !out.changed && !!was?.foundTokenUrl && !clientInfo(out.json)?.foundTokenUrl }
  }
  /** An own app whose addresses are found from the server sends its client secret only to the token address that the
   * first sign-in that worked found (pinFound); a sign-in whose server names another one now is refused before anything
   * is sent there, so a server that changes where its sign-in is cannot take the secret elsewhere. Entering the secret
   * again forgets the address (appAfter). */
  private checkPin(row: Row, app: OwnClient, tokenUrl: string, L: Locale): void {
    // a template's member cannot enter the secret again: their admin can
    if (app.clientSecret && !app.tokenUrl && app.foundTokenUrl && app.foundTokenUrl !== tokenUrl) fail('validation', say(row.template_id ? 'appTokenMovedMember' : 'appTokenMoved', L, { host: new URL(tokenUrl).host }))
  }
  /** Whether the connection's own app (or its template's) remembers another token address than `tokenUrl` now: a sign-in
   * that worked since this one started found another one (callback). */
  private pinnedElsewhere(row: Row, tokenUrl: string): boolean {
    const info = clientInfo(this.appSource(row)?.oauth_client)
    return !!info && !info.tokenUrl && !!info.foundTokenUrl && info.foundTokenUrl !== tokenUrl
  }
  /** After a sign-in that worked, the token address it used is remembered onto the app as it was read when that sign-in
   * started (`onto`, compare-and-set: an admin's change meanwhile wins, and so does another sign-in that remembered one
   * first). Never when a sign-in only starts: one that is never finished must not decide where the secret may go. */
  private pinFound(row: Pick<Row, 'id' | 'template_id'>, onto: { json: string; enc: string | null }, tokenUrl: string): void {
    const info = clientInfo(onto.json)
    if (!info || info.foundTokenUrl) return
    const table = row.template_id ? 'integration_templates' : 'integrations', id = row.template_id ?? row.id
    this.db.query(`UPDATE ${table} SET oauth_client = ? WHERE id = ? AND oauth_client = ? AND oauth_client_enc IS ?`)
      .run(JSON.stringify({ ...info, foundTokenUrl: tokenUrl }), id, onto.json, onto.enc)
  }
  /** an own app's client secret sealed (also a template's, templates.ts) */
  sealClient(aad: string, secret: string, L: Locale) {
    try { return this.box.seal(aad, { clientSecret: secret } satisfies SealedClientSecret) } catch { return fail('unavailable', say('key_unsafe', L)) }
  }
  tryOpenClient(aad: string, enc: string, keyVersion: number): string | null {
    try { return this.box.open<SealedClientSecret>(aad, enc, keyVersion).clientSecret ?? null } catch { return null }
  }
  /** where a connection's own app is stored: the connection, or for one made from a template the template (with its
   * address) */
  private appSource(row: Row): Pick<Row, 'url' | 'oauth_client' | 'oauth_client_enc' | 'oauth_client_key_version' | 'version'> | null {
    return row.template_id
      ? this.db.query('SELECT url, oauth_client, oauth_client_enc, oauth_client_key_version, version FROM integration_templates WHERE id = ?').get(row.template_id) as Pick<Row, 'url' | 'oauth_client' | 'oauth_client_enc' | 'oauth_client_key_version' | 'version'> | null
      : row
  }
  /** a member's connection made from a template is used only while the template is for them: the next sweep removes it,
   * and until then neither a sign-in nor a check (which may refresh a token with the team's app) runs */
  private stillCovered(row: Row, viewer: Viewer, L: Locale): void {
    if (row.template_id && !templateCovers(this.db, row.template_id, viewer.id)) fail('not_found', say('templateNotForYou', L))
  }
  /** The own app a sign-in uses: the connection's, or for a member's connection made from a template the template's
   * (the member never sees it). null: none (the service registers the app itself). Its secret only at the address it was
   * entered for (store.ts secretHere; a member's connection at the template's address): else none is sent. Throws
   * StoreError when its secret cannot be read. */
  appOf(row: Row): OwnClient | null {
    const src = this.appSource(row)
    const info = clientInfo(src?.oauth_client)
    if (!src || !info) return null
    const aad = row.template_id ? templateClientAad(row.template_id) : clientAad(row)
    const here = secretHere(info, src.oauth_client_enc, src.url) && row.url === src.url
    const clientSecret = here ? this.box.open<SealedClientSecret>(aad, src.oauth_client_enc!, src.oauth_client_key_version ?? 1).clientSecret : null
    return { ...info, foundTokenUrl: info.foundTokenUrl ?? null, clientSecret, stored: { json: src.oauth_client!, enc: src.oauth_client_enc ?? null, version: src.version } }
  }

  /** the header a key is sent in, or a refusal of the field (also for what an admin asks a member to connect, requests.ts) */
  headerName(h: string | null, L: Locale): string {
    if (!h || !/^[A-Za-z0-9-]{1,64}$/.test(h) || RESERVED_HEADERS.has(h.toLowerCase())) return fieldError(L, 'authHeader', 'badHeader')
    return h
  }
  private checkAccess(a: IntegrationAccess, L: Locale) {
    const groups = new Set((this.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
    const users = new Set((this.db.query('SELECT id FROM users WHERE deleted_at IS NULL').all() as { id: string }[]).map((u) => u.id))
    const bad = [...a.groups.filter((g) => !groups.has(g)), ...a.users.filter((u) => !users.has(u))]
    if (bad.length) fieldError(L, 'access', 'unknownSubjects', { list: bad.slice(0, 5).join(', ') })
  }
  private freeSlug(scope: 'personal' | 'team', owner: string | null, wanted: string | null, name: string, kind: 'mcp' | 'http', L: Locale): string {
    const taken = (s: string) => !!this.db.query("SELECT 1 FROM integrations WHERE scope = ? AND COALESCE(owner_user_id, '') = ? AND slug = ?").get(scope, owner ?? '', s)
    if (wanted) return taken(wanted) ? fieldError(L, 'slug', 'slugTaken') : wanted
    const base = slugOf(name, kind)
    if (!taken(base)) return base
    for (let i = 2; i < 1000; i++) { const s = base.slice(0, 12 - String(i).length) + i; if (!taken(s)) return s }
    return fieldError(L, 'slug', 'slugTaken')
  }

  // ---------------- secrets ----------------
  private sealFor(row: Pick<Row, 'id' | 'scope' | 'owner_user_id'>, value: Secret, L: Locale) {
    try { return this.box.seal(connectionAad(row), value) } catch { return fail('unavailable', say('key_unsafe', L)) }
  }
  private tryOpen(row: Row): Secret | null { try { return this.box.open<Secret>(connectionAad(row), row.secret_enc, row.key_version) } catch { return null } }
  /** the connection's secret as it is now (a refresh may have rotated it since `row` was read) */
  private secretOf(row: Row): Secret {
    const cur = getRow(this.db, row.id)
    if (!cur || cur.version !== row.version) throw new CallError('the connection changed while this ran; try again', 'changed')
    if (!cur.secret_enc) throw new NeedsAuth(row.auth === 'oauth' ? 'sign_in' : 'no_secret')
    try { return this.box.open<Secret>(connectionAad(cur), cur.secret_enc, cur.key_version) }
    catch (e) { throw e instanceof StoreError && e.code === 'key_unsafe' ? new NetError('key_unsafe') : new NeedsAuth(row.auth === 'oauth' ? 'sign_in' : 'no_secret') }
  }
  /** the header that carries the key or token; `deadline`: when a check's request must end (oauthToken) */
  async authHeaders(row: Row, deadline?: number): Promise<[string, string][]> {
    if (row.auth === 'none') return []
    const s = this.secretOf(row)
    if (row.auth === 'oauth') {
      if (s.type !== 'oauth') throw new NeedsAuth('sign_in')
      return [['Authorization', `Bearer ${await this.oauthToken(row, undefined, deadline)}`]]
    }
    if (s.type !== 'key') throw new NeedsAuth('no_secret')
    return row.auth === 'bearer' ? [['Authorization', `Bearer ${s.key}`]] : [[row.auth_header ?? 'X-API-Key', s.key]]
  }

  /** A usable access token: refreshed ahead of expiry or after a 401 (`rejected`), one refresh at a time per connection.
   * `deadline` (a check's): a token still valid is used as it is when a refresh (its own 30 s) could end after it. */
  private async oauthToken(row: Row, rejected?: string, deadline?: number): Promise<string> {
    const s = this.secretOf(row) as OAuthSecret
    const fresh = s.tokens.expiresAt === null || s.tokens.expiresAt > this.now() + 60_000
    const late = deadline !== undefined && Date.now() + (this.net.timeoutMs ?? TIMEOUT_MS) > deadline && s.tokens.expiresAt !== null && s.tokens.expiresAt > this.now()
    if ((fresh || late) && s.tokens.accessToken !== rejected) return s.tokens.accessToken
    const pending = this.refreshes.get(row.id)
    if (pending) return pending
    if (!s.tokens.refreshToken) { this.setStatus(row, 'needs_auth', 'sign_in'); throw new NeedsAuth('sign_in') }
    const task = (async () => {
      try {
        // a Google app: the card's client as set up now, or the hosting service (google-apps/tokens.ts)
        const tokens = row.google_app
          ? await refreshGoogleApp(this.ctx, s, this.now())
          : await tokenRequest(s, { grant_type: 'refresh_token', refresh_token: s.tokens.refreshToken!, ...(s.resource ? { resource: s.resource } : {}) }, this.net, this.now(), s.tokens)
        const cur = getRow(this.db, row.id)
        if (!cur || cur.version !== row.version) throw new CallError('the connection changed while this ran; try again', 'changed')
        const sealed = this.box.seal(connectionAad(cur), { ...s, tokens } satisfies OAuthSecret)
        this.db.query('UPDATE integrations SET secret_enc=?, key_version=? WHERE id=? AND version=?').run(sealed.enc, sealed.keyVersion, row.id, row.version)
        return tokens.accessToken
      } catch (e) {
        if (e instanceof GrantError) { this.setStatus(row, 'needs_auth', 'sign_in'); throw new NeedsAuth('sign_in') }
        throw e
      }
    })()
    this.refreshes.set(row.id, task)
    try { return await task } finally { if (this.refreshes.get(row.id) === task) this.refreshes.delete(row.id) }
  }

  /** Every value of a connection's secret this server knows: as `row` holds it, as stored now (a refresh during a call
   * rotates OAuth tokens) and the earlier ones seen since the server started. The key; OAuth access and refresh tokens
   * and the client secret. null when a stored secret cannot be read now. Only for hiding them (hider). */
  private secretValues(row: Row, partial = false): string[] | null {
    const seen = new Set(this.recent.get(row.id))
    let unreadable = false
    for (const r of [row, getRow(this.db, row.id)]) {
      if (!r?.secret_enc) continue
      const s = this.tryOpen(r)
      if (!s) { unreadable = true; continue }
      for (const v of s.type === 'key' ? [s.key] : [s.tokens.accessToken, s.tokens.refreshToken, s.client.clientSecret]) if (v) seen.add(v)
    }
    const all = [...seen].slice(-RECENT_SECRETS)
    if (all.length) this.recent.set(row.id, all)
    return unreadable && !partial ? null : all
  }

  /** Every secret value this server holds for connections of this person: their own personal ones (also while
   * personal connections are switched off) and the team ones they may use, with the earlier values seen since the
   * server started. A secret that cannot be read now is left out. For the turn's own outgoing text: the answer, the
   * steps, the audit lines and the chat title (redact.ts) never repeat one. */
  secretsFor(userId: string): string[] {
    const personal = this.db.query(`${selectRows(this.db)} WHERE scope = 'personal' AND owner_user_id = ? AND secret_enc IS NOT NULL`).all(userId) as Row[]
    const team = (this.db.query(`${selectRows(this.db)} WHERE scope = 'team' AND secret_enc IS NOT NULL`).all() as Row[]).filter((r) => mayUse(this.db, r, userId))
    const out: string[] = []
    for (const r of [...personal, ...team]) out.push(...(this.secretValues(r, true) ?? []))
    return out
  }

  /** A function that hides these connections' secrets in what their services sent back (hide.ts). Made after the call,
   * so tokens refreshed during it are included; when a secret cannot be read, nothing of the text is shown. */
  hider(rows: Row[]): (text: string) => string {
    const values: string[] = []
    for (const r of rows) {
      const v = this.secretValues(r)
      if (!v) return () => WITHHELD
      values.push(...v)
    }
    return secretHider(values)
  }

  private async revokeTokens(s: Secret) {
    if (s.type !== 'oauth') return false
    const t = s.tokens.refreshToken ?? s.tokens.accessToken
    return revoke(s, t, s.tokens.refreshToken ? 'refresh_token' : 'access_token', this.net)
  }

  // ---------------- checking ----------------
  /** `total`: how many tools the server offers when it keeps fewer (null: all of them); `totalMore`: the service offers
   * more than `total` (the check stopped with pages of its list unread) */
  private setStatus(row: Row, status: Row['status'], reason: string | null, extra: { tools?: string; total?: number | null; totalMore?: boolean } = {}) {
    const now = iso(this.now())
    if (extra.tools !== undefined) {
      this.db.query('UPDATE integrations SET status=?, last_error=?, tools_json=?, tools_total=?, tools_total_more=?, tools_updated_at=?, updated_at=? WHERE id=? AND version=?')
        .run(status, reason, extra.tools, extra.total ?? null, extra.totalMore ? 1 : 0, now, now, row.id, row.version)
    } else this.db.query('UPDATE integrations SET status=?, last_error=?, updated_at=? WHERE id=? AND version=?').run(status, reason, now, row.id, row.version)
  }

  /** a call's failure -> what the connection's status says */
  private noteFailure(row: Row, e: unknown) {
    const s = statusOf(e)
    if (s) this.setStatus(row, s.status, s.reason)
  }

  /** Check the connection now; MCP: save its tool list. Returns the row as stored afterwards. An MCP server with a
   * saved list, connected or in an error that was only for now (PASSING), whose list could not be read this time for
   * such a reason keeps that list and is connected, with the reason (lastError): its tools keep working, and Settings
   * says the last check failed and which list the AI uses (not "Error"). The next check that reads the list, or a call
   * that goes through (used), clears it. */
  async check(row: Row, signal?: AbortSignal): Promise<Row> {
    try {
      if (row.kind === 'mcp') {
        // one deadline for the whole check: every request of it ends by then, and no new session or token refresh
        // starts that would end later (withMcp, mcp.ts listTools)
        const deadline = Date.now() + (this.net.listTimeoutMs ?? MCP_LIST_TIMEOUT_MS)
        // the list has the connection's secrets hidden (mcp.ts toolOf): the AI and the people who use it read it
        const listed = await this.withMcp(row, (c) => c.listTools(signal, deadline), deadline)
        // a Google app: only its own app's tools of the library's four (google-apps/catalog.ts)
        const { tools, more, total, unread } = row.google_app ? { ...listed, tools: appTools(row.google_app, listed.tools), more: false, unread: false } : listed
        // more than the server keeps (its hard ceiling): the total is saved so Settings and the AI's instructions can
        // say "1,000 of 1,200", or "1,000 of more than 1,000" when reading stopped with pages left (mcp.ts listTools)
        this.setStatus(row, 'connected', null, { tools: JSON.stringify(tools), total: more ? Math.max(total, tools.length) : null, totalMore: unread })
      } else {
        const res = await this.send(row, row.url, { method: 'GET', headers: [['Accept', 'application/json, text/plain;q=0.9, */*;q=0.5']], signal })
        if (res.status === 401 || res.status === 403) this.setStatus(row, 'needs_auth', `refused:${res.status}`)
        else if (res.status >= 500) this.setStatus(row, 'error', `http_status:${res.status}`)
        else this.setStatus(row, 'connected', null)
      }
    } catch (e) {
      // a Google app whose library cannot be reached now: nothing about the connection changed (it comes back by itself)
      if (row.google_app && e instanceof CallError) return getRow(this.db, row.id) ?? row
      const s = statusOf(e)
      // the row as it is now: a call during the check may have found a sign-in needed (that stays), or an error
      const now = getRow(this.db, row.id)
      if (now && now.version === row.version && now.status === 'needs_auth' && row.status !== 'needs_auth') return now
      const working = now?.status === 'connected' || (now?.status === 'error' && PASSING.test(now.last_error ?? ''))
      const kept = !!s && row.kind === 'mcp' && s.status === 'error' && PASSING.test(s.reason) && working && savedTools(this.db, now!).length > 0
      // a failure we do not know (a JSON-RPC error on tools/list): not MCP as we can use it, never only for now
      this.setStatus(row, kept ? 'connected' : s?.status ?? 'error', s?.reason ?? (row.kind === 'mcp' ? 'not_mcp' : 'unreachable'))
    }
    return getRow(this.db, row.id) ?? row
  }

  // ---------------- calls ----------------
  private client(row: Row): McpClient {
    // a Google app: the library on this machine, at the address it listens on now (google-apps/transport.ts); its
    // connection's own address is a placeholder that is never used
    const library = row.google_app ? workspaceLibraryOf(this.ctx).endpoint() : null
    if (row.google_app && !library) throw new CallError(downMessage(APP_NAMES[row.google_app]), 'service down')
    const key = `${row.id}:${row.version}`
    const c = this.clients.get(key)
    if (c && this.now() - c.usedAt < CLIENT_IDLE_MS && (!library || c.url === library)) return c
    this.dropClient(row.id)
    const fresh = library
      ? new McpClient(library, (deadline) => this.authHeaders(row, deadline), this.net, () => this.hider([row]), (url, r) => libraryRequest(library, url, r).catch((e) => {
        throw e instanceof LibraryDown ? new CallError(downMessage(APP_NAMES[row.google_app!]), 'service down') : e
      }))
      : new McpClient(row.url, (deadline) => this.authHeaders(row, deadline), this.net, () => this.hider([row]))
    this.clients.set(key, fresh)
    return fresh
  }
  private dropClient(id: string) { for (const k of [...this.clients.keys()]) if (k.startsWith(id + ':')) this.clients.delete(k) }
  /** A connection deleted elsewhere (google-apps/service.ts disconnect): its client, remembered secrets and tool list go. */
  forget(id: string) { this.dropClient(id); this.recent.delete(id); toolListsOf(this.db).drop(id) }

  /** Run against the MCP server: a new session when the server forgot ours, one token refresh after a 401. `deadline`
   * (a check's): neither once it has passed, nor a token refresh (its own 30 s) that would end after it. */
  private async withMcp<T>(row: Row, fn: (c: McpClient) => Promise<T>, deadline = Infinity): Promise<T> {
    let renewed = false, refreshed = false
    for (;;) {
      const c = this.client(row)
      try { return await fn(c) } catch (e) {
        const renew = e instanceof McpError && e.code === 'session_gone' && !renewed
        const refresh = e instanceof McpError && e.code === 'unauthorized' && row.auth === 'oauth' && !refreshed && !!row.secret_enc
        // a check without the time for it: its deadline ended it, not a lost session or a token to refresh
        if ((renew && Date.now() >= deadline) || (refresh && Date.now() + (this.net.timeoutMs ?? TIMEOUT_MS) > deadline)) throw new NetError('list_timeout')
        if (renew) { renewed = true; this.dropClient(row.id); continue }
        if (refresh) {
          refreshed = true
          const s = this.secretOf(row)
          if (s.type === 'oauth') { await this.oauthToken(row, s.tokens.accessToken); this.dropClient(row.id); continue }
        }
        // a Google app refused again with a token Google just refreshed: the library answers 401 whenever its own check
        // with Google fails (a timeout, Google busy), so it is for now, not a sign-in to redo (a refused refresh is a
        // GrantError in oauthToken and asks for one)
        if (row.google_app && refreshed && e instanceof McpError && e.code === 'unauthorized') throw new CallError(downMessage(APP_NAMES[row.google_app]), 'service down')
        throw e
      }
    }
  }

  /** The connection this person may use now, for one call (checked on every call: people, rules and settings change). */
  forCall(userId: string, id: string): Row {
    const row = getRow(this.db, id)
    if (!row) throw new CallError('this connection no longer exists', 'gone')
    if (!mayUse(this.db, row, userId)) throw new CallError('the user may not use this connection (any more); the person who manages it can change that', 'no access')
    if (row.auth !== 'none' && !row.secret_enc) throw new CallError(`${row.name} needs ${row.auth === 'oauth' ? 'a new sign-in' : 'its key'}; the user can fix it in ${fixWhere(row)}`, 'needs sign-in or key')
    return row
  }

  async callTool(row: Row, tool: string, args: unknown, signal?: AbortSignal): Promise<Record<string, any>> {
    try {
      const r = await this.withMcp(row, (c) => c.callTool(tool, args, signal))
      this.used(row)
      return r
    } catch (e) {
      // a Google app's answer too large (a big Gmail attachment) says nothing about the connection
      if (!signal?.aborted && !(row.google_app && e instanceof NetError && e.reason === 'too_large')) this.noteFailure(row, e)
      throw e instanceof CallError ? e : new CallError(callMessage(e, row), kindOf(e), e instanceof McpError && e.code === 'rpc')
    }
  }

  /** api_request: one request under the connection's address (the URL was built and checked by the caller). */
  async apiRequest(row: Row, url: string, req: { method: string; body: Buffer | null; contentType: string | null }, signal?: AbortSignal): Promise<NetResponse> {
    try {
      const res = await this.send(row, url, { method: req.method, headers: [['Accept', 'application/json, text/plain;q=0.9, */*;q=0.5'], ...(req.contentType ? [['Content-Type', req.contentType] as [string, string]] : [])], body: req.body, signal })
      if (res.status === 401) this.setStatus(row, 'needs_auth', 'refused:401')
      // only a 2xx says the API works (a 4xx may be the AI's path, a 5xx the service's trouble)
      this.used(row, res.status >= 200 && res.status < 300)
      return res
    } catch (e) {
      if (!signal?.aborted) this.noteFailure(row, e)
      throw e instanceof CallError ? e : new CallError(callMessage(e, row), kindOf(e))
    }
  }

  /** One request with the connection's key or token. A token the service refused (401) is refreshed once and the request
   * sent again: an HTTP API's token runs out like an MCP server's (withMcp), and a refused request did nothing. */
  private async send(row: Row, url: string, r: { method: string; headers: [string, string][]; body?: Buffer | null; signal?: AbortSignal }) {
    const auth = await this.authHeaders(row)
    const first = await serviceRequest(url, { ...r, headers: [...r.headers, ...auth] }, this.net)
    if (first.status !== 401 || row.auth !== 'oauth' || r.signal?.aborted) return first
    // the token this request sent: another call may have refreshed it meanwhile, then that one is used as it is
    const sent = auth.find(([k]) => k === 'Authorization')?.[1].replace(/^Bearer /, '')
    const token = await this.oauthToken(row, sent)
    return serviceRequest(url, { ...r, headers: [...r.headers, ['Authorization', `Bearer ${token}`]] }, this.net)
  }
  /** `works`: the call went through, so what a failed check or call left (an error, or "the last check failed") is
   * cleared; a sign-in that is needed is not (no call runs then, tools.ts) */
  private used(row: Row, works = true) {
    const now = iso(this.now())
    this.db.query('UPDATE integrations SET last_used_at=? WHERE id=?').run(now, row.id)
    if (works) this.db.query("UPDATE integrations SET status='connected', last_error=NULL, updated_at=? WHERE id=? AND version=? AND status IN ('connected','error') AND (status='error' OR last_error IS NOT NULL)")
      .run(now, row.id, row.version)
  }

  // ---------------- signing in (OAuth: an MCP server, or an HTTP API with its own app) ----------------
  private liveSession(user: string, session: string) {
    if (!activeUser(this.db, user) || !this.db.query('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(session, user, iso(this.now()))) fail('unauthorized')
  }
  sweep() {
    const now = iso(this.now())
    this.db.query("UPDATE integration_oauth_flows SET state='expired', secret_enc=NULL WHERE expires_at<=? AND state IN ('pending','exchanging')").run(now)
    this.db.query('DELETE FROM integration_oauth_flows WHERE expires_at<?').run(iso(this.now() - 86_400_000))
  }

  async authorize(viewer: Viewer, session: string, id: string, origin: string, locale: Locale): Promise<{ flowId: string; authorizationUrl: string; expiresAt: string }> {
    const L = locale
    const row = this.manageable(viewer, id)
    if (row.auth !== 'oauth') fail('validation', say('notOauth', L))
    this.stillCovered(row, viewer, L)
    this.liveSession(viewer.id, session)
    this.sweep()
    const n = (this.db.query('SELECT count(*) AS n FROM integration_oauth_flows WHERE user_id=? AND created_at>?').get(viewer.id, iso(this.now() - 3600_000)) as { n: number }).n
    if (n >= FLOWS_PER_HOUR) fail('rate_limited')
    let app: OwnClient | null
    try { app = this.appOf(row) } catch { return fail('unavailable', say('key_unsafe', L)) }
    // an API has nothing to find its sign-in from: only its own app's addresses
    if (row.kind !== 'mcp' && !app?.tokenUrl) {
      if (!row.secret_enc) this.setStatus(row, 'needs_auth', 'oauth_unsupported')
      return fail('validation', say('oauthHttpNeedsApp', L))
    }
    let setup: { server: OAuthServer; resource: string | null; scope: string | null; authMethods: string[] | null }
    let client: OAuthClient
    const redirectUri = new URL('/api/integrations/oauth/callback', origin).href
    try {
      if (app?.authorizationUrl && app.tokenUrl) {
        // the app's own addresses: nothing to find (an MCP server keeps its resource indicator, an API has none)
        setup = { server: manualServer(app), resource: row.kind === 'mcp' ? canonicalResource(row.url) : null, scope: app.scope, authMethods: null }
      } else {
        // the server's 401 names its metadata (WWW-Authenticate); without one the well-known addresses are tried
        let header = ''
        try { await new McpClient(row.url, async () => [], this.net).start() } catch (e) { if (e instanceof McpError && e.code === 'unauthorized') header = e.detail }
        const found = await discover(row.url, this.net, header)
        // an own app asks for its scopes when it names them (Google's servers list every scope they know)
        setup = app?.scope ? { ...found, scope: app.scope } : found
      }
      // the client secret goes to this token address: the one a sign-in that worked found before, or none
      if (app) this.checkPin(row, app, setup.server.tokenEndpoint, L)
      // a registered app is used again for the same server; an own app is always the one set now
      const old = row.secret_enc ? this.tryOpen(row) : null
      client = app ? ownClient(app, redirectUri, setup.authMethods)
        : old?.type === 'oauth' && old.server.issuer && old.server.issuer === setup.server.issuer && old.client.redirectUri === redirectUri ? old.client
          : await register(setup.server, redirectUri, this.net)
    } catch (e) {
      if (e instanceof HttpError) throw e
      // a service that registers no apps: its own app is the fix, which a member of a template cannot set
      const raw = e instanceof NetError ? e.reason : 'oauth_unsupported'
      const reason = raw === 'oauth_no_registration' && row.template_id ? 'oauth_no_registration_member' : raw
      // signed in already: the row stays as it is (the answer says why signing in again failed; a connected row with a
      // reason would read as "the last check failed")
      if (!row.secret_enc) this.setStatus(row, 'needs_auth', reason)
      return fail('validation', say(reason as Reason, L, { status: e instanceof NetError ? e.status ?? '?' : '?' }))
    }
    const flowId = newId(), state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url')
    // no token address remembered yet: this one is, once this sign-in worked (callback)
    const pinOnto = app?.clientSecret && !app.tokenUrl && !app.foundTokenUrl ? { json: app.stored.json, enc: app.stored.enc } : null
    const secret: FlowSecret = { verifier, server: setup.server, client, resource: setup.resource, scope: setup.scope, pinOnto, appVersion: row.template_id && app ? app.stored.version : null, own: app ? (row.template_id ? 'template' : 'mine') : undefined }
    let sealed
    try { sealed = this.box.seal(flowAad({ id: flowId, user_id: viewer.id }), secret) } catch { return fail('unavailable', say('key_unsafe', L)) }
    const expiresAt = iso(this.now() + FLOW_TTL)
    this.db.transaction(() => {
      this.db.query("UPDATE integration_oauth_flows SET state='failed', reason='superseded', secret_enc=NULL WHERE user_id=? AND integration_id=? AND state='pending'").run(viewer.id, id)
      this.db.query(`INSERT INTO integration_oauth_flows (id, integration_id, integration_version, user_id, session_id, state_hash, state, secret_enc, key_version, expires_at, created_at)
        VALUES (?,?,?,?,?,?,'pending',?,?,?,?)`).run(flowId, id, row.version, viewer.id, session, hash(state), sealed.enc, sealed.keyVersion, expiresAt, iso(this.now()))
    })()
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    return { flowId, authorizationUrl: authorizationUrl(secret, state, challenge), expiresAt }
  }

  flow(userId: string, session: string, id: string): IntegrationFlow {
    this.liveSession(userId, session)
    this.sweep()
    const f = this.db.query('SELECT * FROM integration_oauth_flows WHERE id=?').get(id) as FlowRow | null
    if (!f || f.user_id !== userId || f.session_id !== session) return fail('not_found')
    return { flowId: f.id, state: f.state, expiresAt: f.expires_at, reason: f.reason }
  }

  /** The browser comes back from the service. It must be signed in as the same person who started (any of their live
   * sessions); a flow started by someone else, or a browser without a session, changes nothing. */
  async callback(q: { state?: string; code?: string; error?: string; iss?: string }, browser?: { userId: string; sessionId: string }): Promise<CallbackResult> {
    this.sweep()
    const no: CallbackResult = { ok: false, reason: null }
    if (!q.state || !/^[A-Za-z0-9_-]{43}$/.test(q.state)) return no
    const f = this.db.query('SELECT * FROM integration_oauth_flows WHERE state_hash=?').get(hash(q.state)) as FlowRow | null
    if (!f || f.state !== 'pending') return no
    if (!browser || browser.userId !== f.user_id) return no
    try { this.liveSession(browser.userId, browser.sessionId); this.liveSession(f.user_id, f.session_id) } catch { return no }
    if (!this.db.query("UPDATE integration_oauth_flows SET state='exchanging' WHERE id=? AND state='pending'").run(f.id).changes) return no
    const failed = (reason: FlowFailure): CallbackResult => { this.db.query("UPDATE integration_oauth_flows SET state='failed', reason=?, secret_enc=NULL WHERE id=? AND state='exchanging'").run(reason, f.id); return { ok: false, reason } }
    try {
      if (q.error) return failed('denied')
      if (!q.code || q.code.length > 4096) return failed('invalid')
      const s = this.box.open<FlowSecret>(flowAad(f), f.secret_enc, f.key_version)
      // RFC 9207: an "iss" in the answer must name the server we started at: the one found, or the given sign-in
      // address's (oauth.ts issuerMatches)
      if (q.iss && !issuerMatches(q.iss, s.server)) return failed('invalid')
      const row = getRow(this.db, f.integration_id)
      const viewer = activeUser(this.db, f.user_id)
      if (!row || !viewer || row.version !== f.integration_version || row.auth !== 'oauth') return failed('changed')
      if (row.scope === 'personal' ? row.owner_user_id !== viewer.id : !isAdmin(viewer.role)) return failed('changed')
      // made from a template: still for this member (authorize checked when the sign-in started)
      const covered = (r: Row) => !r.template_id || templateCovers(this.db, r.template_id, viewer.id)
      // the app is still the one this sign-in started with: a template's app that changed meanwhile (its version; the
      // same secret entered again can bring its stored text back to what it was before an address was remembered), or a
      // token address another sign-in that worked remembered meanwhile (the client secret does not go to this one)
      const appMoved = (r: Row) => (s.appVersion != null && this.appSource(r)?.version !== s.appVersion) || (!!s.client.clientSecret && this.pinnedElsewhere(r, s.server.tokenEndpoint))
      if (!covered(row) || appMoved(row)) return failed('changed')
      let tokens: OAuthTokens
      try { tokens = await tokenRequest(s, { grant_type: 'authorization_code', code: q.code, redirect_uri: s.client.redirectUri, code_verifier: s.verifier, ...(s.resource ? { resource: s.resource } : {}) }, this.net, this.now()) }
      // the service's answer is never kept or shown (it may repeat what was sent): only whether it refused the app
      catch (e) {
        if (!s.own || !(e instanceof GrantError) || !CLIENT_REFUSED.has(e.message)) return failed('exchange')
        return failed(s.own === 'template' ? 'client_template' : 'client')
      }
      const cur = getRow(this.db, row.id)
      if (!cur || cur.version !== row.version || !covered(cur)) return failed('changed')
      const sealed = this.box.seal(connectionAad(cur), { type: 'oauth', server: s.server, client: s.client, resource: s.resource, scope: s.scope, tokens } satisfies OAuthSecret)
      const old = cur.secret_enc ? this.tryOpen(cur) : null
      let kept = false
      this.db.transaction(() => {
        // checked again with the write: of two sign-ins whose exchanges overlapped, the one that comes second keeps no
        // tokens (their refreshes would send the client secret to an address the app does not remember)
        if (appMoved(cur)) return
        kept = true
        const stored = this.db.query("UPDATE integrations SET secret_enc=?, key_version=?, status='needs_auth', last_error=NULL, version=version+1, updated_at=? WHERE id=? AND version=?")
          .run(sealed.enc, sealed.keyVersion, iso(this.now()), cur.id, cur.version).changes
        // done once the check below has ended (the app reads the connection again when the flow says completed, and
        // would find it still waiting for a sign-in)
        // and the check may take up to its deadline: the flow gets a new lifetime from now, so a poll after the first one
        // ended does not find it expired (sweep) while it is only waiting for the check
        this.db.query("UPDATE integration_oauth_flows SET secret_enc=NULL, expires_at=? WHERE id=?").run(iso(this.now() + FLOW_TTL), f.id)
        // whose sign-in a team connection serves on (팀장 넘기기 reads it; a personal one is its owner's anyway), only when
        // these tokens are the ones stored now
        if (stored && cur.scope === 'team') this.db.query("INSERT INTO team_sign_ins (kind, target_id, user_id, at) VALUES ('team_connection', ?, ?, ?) ON CONFLICT(kind, target_id) DO UPDATE SET user_id = excluded.user_id, at = excluded.at").run(cur.id, viewer.id, iso(this.now()))
        // the sign-in worked: its token address is where the app's secret may go from now on
        if (stored && s.pinOnto) this.pinFound(cur, s.pinOnto, s.server.tokenEndpoint)
      })()
      // its tokens are dropped, not revoked: revoking would send the client secret once more to the address that lost
      if (!kept) return failed('changed')
      // the tokens are kept: whatever happens next, the sign-in is done, marked once the check has ended
      try {
        this.dropClient(cur.id)
        audit(this.db, { actor: viewer.id, action: 'integration.update', target: cur.id, detail: { ...auditDetail(cur), changed: ['signIn'], secret: 'replaced' } })
        // made from an admin's request (requests.ts): the request is connected now that the member signed in (its
        // bookkeeping never undoes a sign-in that worked)
        try { requestSignedIn(this.db, cur, viewer.id, iso(this.now())) } catch (err) { this.ctx.log.warn('connection request not marked connected', { err }) }
        if (old?.type === 'oauth' && old.tokens.refreshToken !== tokens.refreshToken) void this.revokeTokens(old)
        await this.check(getRow(this.db, cur.id)!)
      } finally { this.db.query("UPDATE integration_oauth_flows SET state='completed', secret_enc=NULL WHERE id=?").run(f.id) }
      return { ok: true }
    } catch { return failed('exchange') }
  }
}

/** reasons a check fails for now while the service and its saved tools may still work: no answer in time, not
 * reachable, a list over the limits, the service busy or failing (HTTP 408, 429, 5xx). Not a refused key or sign-in,
 * an address that is not allowed, a redirect or a bad certificate: those stop the calls too. */
const PASSING = /^(timeout|list_timeout|unreachable|too_large|http_status:(408|429|5\d\d))$/

/** What a failure says about the connection (null: nothing to record, e.g. the call was stopped). */
function statusOf(e: unknown): { status: Row['status']; reason: string } | null {
  // no key at all is a setup error; no sign-in (or a lost one) needs the person to sign in
  if (e instanceof NeedsAuth) return { status: e.reason === 'no_secret' ? 'error' : 'needs_auth', reason: e.reason }
  if (e instanceof GrantError) return { status: 'needs_auth', reason: 'sign_in' }
  if (e instanceof McpError) {
    if (e.code === 'unauthorized' || e.code === 'forbidden') return { status: 'needs_auth', reason: `refused:${e.status}` }
    if (e.code === 'http' || e.code === 'session_gone') return { status: 'error', reason: `http_status:${e.status}` }
    if (e.code === 'rpc') return null
    return { status: 'error', reason: 'not_mcp' }
  }
  if (e instanceof NetError) return { status: 'error', reason: e.status ? `${e.reason}:${e.status}` : e.reason }
  if (e instanceof StoreError) return { status: 'error', reason: 'key_unsafe' }
  return null
}

/** where the person fixes a connection's sign-in: a Google app on its card under Connectors */
const fixWhere = (row: Pick<Row, 'google_app'>) => (row.google_app ? `Connected apps › ${APP_NAMES[row.google_app]} (Reconnect)` : 'Settings › Connected apps')

/** the audit summary's word for a failed call */
function kindOf(e: unknown): string {
  if (e instanceof NeedsAuth || e instanceof GrantError) return 'needs sign-in or key'
  if (e instanceof McpError) return e.code === 'rpc' ? 'error answer' : e.status ? `HTTP ${e.status}` : e.code
  if (e instanceof NetError) return e.reason
  return 'error'
}

/** A failed call in words for the AI: our own words and status codes, plus a JSON-RPC error's message (the tool's answer). */
function callMessage(e: unknown, row: Row): string {
  if (e instanceof CallError) return e.message
  if (e instanceof NeedsAuth) return `${row.name} needs ${e.reason === 'sign_in' ? 'a new sign-in' : 'its key'}; the user can fix it in ${fixWhere(row)}`
  if (e instanceof McpError) {
    if (e.code === 'rpc') return `${row.name} answered with an error: ${e.detail}`
    if (e.code === 'unauthorized' || e.code === 'forbidden') return `${row.name} refused the stored key or sign-in (HTTP ${e.status}); the user can fix it in ${fixWhere(row)}`
    if (e.code === 'not_mcp') return `${row.name} did not answer like an MCP server`
    return `${row.name} answered HTTP ${e.status}`
  }
  if (e instanceof NetError) {
    const words: Record<string, string> = {
      timeout: 'did not answer within 30 seconds', private_address: 'points to a private, local or office address, which is not allowed', blocked_port: 'uses a port other than 443',
      tls: 'has a certificate that could not be verified', redirect: `redirected (HTTP ${e.status}); redirects are not followed`, too_large: 'sent an answer that is too large (over 25 MB for a tool call, 1 MB otherwise)',
      key_unsafe: 'cannot be used: the server\'s key folder is unsafe', unreachable: 'could not be reached',
    }
    return `${row.name} ${words[e.reason] ?? 'could not be reached'}`
  }
  if (e instanceof GrantError) return `${row.name} needs a new sign-in; the user can fix it in ${fixWhere(row)}`
  return `${row.name} could not be reached`
}

const instances = new WeakMap<AppContext, Integrations>()
/** Dependencies come only from offline tests, never from HTTP or model input. */
export function integrationsOf(ctx: AppContext, deps?: IntegrationDeps): Integrations {
  let svc = instances.get(ctx)
  if (!svc || deps) { svc = new Integrations(ctx, deps); instances.set(ctx, svc) }
  return svc
}
