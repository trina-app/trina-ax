// External-service connections (docs/INTEGRATIONS.md): personal ones (a member's own account, used only in their chats)
// and team ones (an admin's, used by the people the admin chose). Creating, changing, checking, signing in at an MCP
// server (OAuth), and the calls the AI's tools make (integrations/connections/tools.ts). Nothing here ever returns,
// logs or audits a key or a token; a check stores a reason code, never the service's own words. What a service sends
// back has the connection's secrets hidden (hider, hide.ts) before anyone sees it.
import crypto from 'node:crypto'
import path from 'node:path'
import net from 'node:net'
import type { Integration, IntegrationAccess, IntegrationFlow, IntegrationInput, IntegrationList, IntegrationPatch, Locale } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { audit } from '../../admin/audit'
import { getTeamSettings } from '../../admin/settings'
import { fail } from '../../http/errors'
import { resolveLayout } from '../../system/layout'
import { egressOf } from '../../tools/egress'
import { checkHostName, isLocalAddress, isPublicAddress } from '../../tools/web-fetch'
import { secretHider } from './hide'
import { McpClient, McpError } from './mcp'
import { NetError, serviceRequest, type NetOptions, type NetResponse } from './net'
import { authorizationUrl, discover, GrantError, register, revoke, tokenRequest, type OAuthClient, type OAuthSecret, type OAuthServer, type OAuthTokens } from './oauth'
import {
  accessOf, activeUser, connectionAad, flowAad, getRow, isAdmin, mayUse, SecretBox, setAccess, StoreError, usable, view,
  type FlowRow, type Row, type Viewer,
} from './store'
import { say, type Reason, type TextKey } from './text'

export const MAX_PERSONAL = 20
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
interface FlowSecret { verifier: string; server: OAuthServer; client: OAuthClient; resource: string; scope: string | null }

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
function obviouslyPrivate(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) return !isPublicAddress(host) || isLocalAddress(host)
  return !!checkHostName(host)
}

const normUrl = (u: string) => new URL(u).href
/** names go into the AI's instructions and tool descriptions: one line, no control characters */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
const cleanNotes = (s: string | null | undefined) => s?.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim() || null
/** what the admin audit says about a change: team connections in full; a member's own ones without name or address */
const auditDetail = (row: Pick<Row, 'scope' | 'kind' | 'auth' | 'name' | 'url'>, more: Record<string, unknown> = {}) =>
  row.scope === 'team' ? { scope: row.scope, kind: row.kind, name: row.name, host: new URL(row.url).host, auth: row.auth, ...more } : { scope: row.scope, kind: row.kind, auth: row.auth }

/** A refusal of one field: `validation`, the words (in the person's language) under that field too. */
function fieldError(L: Locale, field: string, key: TextKey, vars: Record<string, string | number> = {}): never {
  const m = say(key, L, vars)
  return fail('validation', m, { fields: { [`body.${field}`]: m } })
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
    const personal = this.db.query("SELECT * FROM integrations WHERE scope = 'personal' AND owner_user_id = ? ORDER BY name, id").all(viewer.id) as Row[]
    const team = (this.db.query("SELECT * FROM integrations WHERE scope = 'team' ORDER BY name, id").all() as Row[]).filter((r) => mayUse(this.db, r, viewer.id))
    return { items: [...personal, ...team].map((r) => view(this.db, r, viewer, locale)), personalAllowed: getTeamSettings(this.db).personalIntegrations }
  }
  listTeam(viewer: Viewer, locale: Locale): Integration[] {
    return (this.db.query("SELECT * FROM integrations WHERE scope = 'team' ORDER BY name, id").all() as Row[]).map((r) => view(this.db, r, viewer, locale))
  }
  /** connections this person may use in a chat now (tools.ts) */
  usable(userId: string): Row[] { return usable(this.db, userId) }

  /** The row for a manage action: someone else's personal connection is "not found"; a team one needs an admin. */
  private manageable(viewer: Viewer, id: string): Row {
    const row = getRow(this.db, id)
    if (!row || !activeUser(this.db, viewer.id)) return fail('not_found')
    if (row.scope === 'personal') return row.owner_user_id === viewer.id ? row : fail('not_found')
    if (isAdmin(viewer.role)) return row
    return mayUse(this.db, row, viewer.id) ? fail('forbidden') : fail('not_found')
  }

  // ---------------- creating and changing ----------------
  async create(viewer: Viewer, input: IntegrationInput, scope: 'personal' | 'team', locale: Locale): Promise<Integration> {
    const L = locale
    if (scope === 'personal' && !getTeamSettings(this.db).personalIntegrations) fail('forbidden', say('personalOff', L))
    if (scope === 'personal' && input.access) fieldError(L, 'access', 'accessTeamOnly')
    const count = scope === 'personal'
      ? (this.db.query("SELECT count(*) AS n FROM integrations WHERE scope = 'personal' AND owner_user_id = ?").get(viewer.id) as { n: number }).n
      : (this.db.query("SELECT count(*) AS n FROM integrations WHERE scope = 'team'").get() as { n: number }).n
    const max = scope === 'personal' ? MAX_PERSONAL : MAX_TEAM
    if (count >= max) fail('conflict', say('tooMany', L, { n: max }))
    const authHeader = input.auth === 'header' ? this.headerName(input.authHeader ?? null, L) : null
    if (input.auth === 'oauth' && input.kind !== 'mcp') fieldError(L, 'auth', 'oauthMcpOnly')
    if (input.secret !== undefined && input.auth !== 'bearer' && input.auth !== 'header') fieldError(L, 'secret', 'keyNeedsKeyAuth')
    if (input.secret !== undefined && /[\r\n\0]/.test(input.secret)) fieldError(L, 'secret', 'keyLineBreak')
    const url = normUrl(input.url)
    if (obviouslyPrivate(url)) fieldError(L, 'url', 'private_address')
    const owner = scope === 'personal' ? viewer.id : null
    const slug = this.freeSlug(scope, owner, input.slug ?? null, input.name, input.kind, L)
    if (input.access) this.checkAccess(input.access, L)
    const id = newId(), now = iso(this.now())
    const row: Row = {
      id, scope, owner_user_id: owner, created_by: viewer.id, kind: input.kind, name: oneLine(input.name), slug, url, auth: input.auth, auth_header: authHeader,
      secret_enc: null, key_version: 1, account: null, notes: cleanNotes(input.notes), write_policy: input.writePolicy ?? 'ask',
      status: input.auth === 'oauth' ? 'needs_auth' : 'error', last_error: input.auth === 'oauth' ? 'sign_in' : input.auth === 'none' ? null : 'no_secret', tools_json: '[]', tools_updated_at: null,
      last_used_at: null, version: 1, created_at: now, updated_at: now,
    }
    if (input.secret !== undefined) {
      const sealed = this.sealFor(row, { type: 'key', key: input.secret } satisfies KeySecret, L)
      row.secret_enc = sealed.enc; row.key_version = sealed.keyVersion; row.last_error = null
    }
    this.db.transaction(() => {
      this.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, auth_header, secret_enc, key_version, account, notes,
        write_policy, status, last_error, tools_json, tools_updated_at, last_used_at, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(row.id, row.scope, row.owner_user_id, row.created_by, row.kind, row.name, row.slug, row.url, row.auth, row.auth_header, row.secret_enc, row.key_version,
          row.account, row.notes, row.write_policy, row.status, row.last_error, row.tools_json, row.tools_updated_at, row.last_used_at, row.version, row.created_at, row.updated_at)
      if (scope === 'team') setAccess(this.db, id, input.access ?? { everyone: false, groups: [], users: [] })
    })()
    audit(this.db, { actor: viewer.id, action: 'integration.create', target: id, detail: auditDetail(row, { slug, writePolicy: row.write_policy, access: scope === 'team' ? accessOf(this.db, id) : undefined }) })
    const checked = await this.check(getRow(this.db, id)!)
    return view(this.db, checked, viewer, L)
  }

  async update(viewer: Viewer, id: string, patch: IntegrationPatch, locale: Locale): Promise<Integration> {
    const L = locale
    const row = this.manageable(viewer, id)
    const next: Row = { ...row }
    const changed: string[] = []
    if (patch.name !== undefined && oneLine(patch.name) !== row.name) { next.name = oneLine(patch.name); changed.push('name') }
    if (patch.notes !== undefined && cleanNotes(patch.notes) !== row.notes) { next.notes = cleanNotes(patch.notes); changed.push('notes') }
    if (patch.writePolicy !== undefined && patch.writePolicy !== row.write_policy) { next.write_policy = patch.writePolicy; changed.push('writePolicy') }
    if (patch.url !== undefined && normUrl(patch.url) !== row.url) {
      next.url = normUrl(patch.url)
      if (obviouslyPrivate(next.url)) fieldError(L, 'url', 'private_address')
      changed.push('url')
    }
    if (patch.auth !== undefined && patch.auth !== row.auth) {
      if (patch.auth === 'oauth' && row.kind !== 'mcp') fieldError(L, 'auth', 'oauthMcpOnly')
      next.auth = patch.auth; changed.push('auth')
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
    const moved = changed.some((c) => c === 'url' || c === 'auth' || c === 'authHeader')
    let secret: 'kept' | 'replaced' | 'removed' = 'kept'
    const old = row.secret_enc ? this.tryOpen(row) : null
    if (patch.secret !== undefined) {
      const sealed = this.sealFor(next, { type: 'key', key: patch.secret } satisfies KeySecret, L)
      next.secret_enc = sealed.enc; next.key_version = sealed.keyVersion; secret = 'replaced'
    } else if ((moved || patch.clearSecret) && row.secret_enc) { next.secret_enc = null; secret = 'removed' }
    if (moved) { next.tools_json = '[]'; next.tools_updated_at = null; next.account = null }
    const recheck = moved || secret !== 'kept'
    if (recheck) { next.status = next.auth === 'oauth' && !next.secret_enc ? 'needs_auth' : 'error'; next.last_error = next.auth === 'none' || next.secret_enc ? null : next.auth === 'oauth' ? 'sign_in' : 'no_secret' }
    const accessBefore = row.scope === 'team' ? accessOf(this.db, id) : null
    const now = iso(this.now())
    this.db.transaction(() => {
      const r = this.db.query(`UPDATE integrations SET name=?, notes=?, write_policy=?, url=?, auth=?, auth_header=?, secret_enc=?, key_version=?, account=?, tools_json=?,
        tools_updated_at=?, status=?, last_error=?, version=version+1, updated_at=? WHERE id=? AND version=?`)
        .run(next.name, next.notes, next.write_policy, next.url, next.auth, next.auth_header, next.secret_enc, next.key_version, next.account, next.tools_json,
          next.tools_updated_at, next.status, next.last_error, now, id, row.version)
      if (!r.changes) fail('conflict')
      if (patch.access) setAccess(this.db, id, patch.access)
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

  async remove(viewer: Viewer, id: string): Promise<void> {
    const row = this.manageable(viewer, id)
    const old = row.secret_enc ? this.tryOpen(row) : null
    // local first: the tokens are gone even when the service cannot be told
    this.db.query('DELETE FROM integrations WHERE id = ?').run(id)
    this.dropClient(id)
    this.recent.delete(id)
    audit(this.db, { actor: viewer.id, action: 'integration.delete', target: id, detail: auditDetail(row) })
    if (old?.type === 'oauth') await this.revokeTokens(old)
  }

  async refresh(viewer: Viewer, id: string, locale: Locale): Promise<Integration> {
    const row = this.manageable(viewer, id)
    return view(this.db, await this.check(row), viewer, locale)
  }

  private headerName(h: string | null, L: Locale): string {
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
  /** the header that carries the key or token */
  async authHeaders(row: Row): Promise<[string, string][]> {
    if (row.auth === 'none') return []
    const s = this.secretOf(row)
    if (row.auth === 'oauth') {
      if (s.type !== 'oauth') throw new NeedsAuth('sign_in')
      return [['Authorization', `Bearer ${await this.oauthToken(row)}`]]
    }
    if (s.type !== 'key') throw new NeedsAuth('no_secret')
    return row.auth === 'bearer' ? [['Authorization', `Bearer ${s.key}`]] : [[row.auth_header ?? 'X-API-Key', s.key]]
  }

  /** A usable access token: refreshed ahead of expiry or after a 401 (`rejected`), one refresh at a time per connection. */
  private async oauthToken(row: Row, rejected?: string): Promise<string> {
    const s = this.secretOf(row) as OAuthSecret
    const fresh = s.tokens.expiresAt === null || s.tokens.expiresAt > this.now() + 60_000
    if (fresh && s.tokens.accessToken !== rejected) return s.tokens.accessToken
    const pending = this.refreshes.get(row.id)
    if (pending) return pending
    if (!s.tokens.refreshToken) { this.setStatus(row, 'needs_auth', 'sign_in'); throw new NeedsAuth('sign_in') }
    const task = (async () => {
      try {
        const tokens = await tokenRequest(s, { grant_type: 'refresh_token', refresh_token: s.tokens.refreshToken!, resource: s.resource }, this.net, this.now(), s.tokens)
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
    const personal = this.db.query("SELECT * FROM integrations WHERE scope = 'personal' AND owner_user_id = ? AND secret_enc IS NOT NULL").all(userId) as Row[]
    const team = (this.db.query("SELECT * FROM integrations WHERE scope = 'team' AND secret_enc IS NOT NULL").all() as Row[]).filter((r) => mayUse(this.db, r, userId))
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
  private setStatus(row: Row, status: Row['status'], reason: string | null, extra: { tools?: string } = {}) {
    const now = iso(this.now())
    if (extra.tools !== undefined) this.db.query('UPDATE integrations SET status=?, last_error=?, tools_json=?, tools_updated_at=?, updated_at=? WHERE id=? AND version=?').run(status, reason, extra.tools, now, now, row.id, row.version)
    else this.db.query('UPDATE integrations SET status=?, last_error=?, updated_at=? WHERE id=? AND version=?').run(status, reason, now, row.id, row.version)
  }

  /** a call's failure -> what the connection's status says */
  private noteFailure(row: Row, e: unknown) {
    const s = statusOf(e)
    if (s) this.setStatus(row, s.status, s.reason)
  }

  /** Check the connection now; MCP: save its tool list. Returns the row as stored afterwards. */
  async check(row: Row, signal?: AbortSignal): Promise<Row> {
    try {
      if (row.kind === 'mcp') {
        // the list has the connection's secrets hidden (mcp.ts toolOf): the AI and the people who use it read it
        const { tools } = await this.withMcp(row, (c) => c.listTools(signal))
        this.setStatus(row, 'connected', null, { tools: JSON.stringify(tools) })
      } else {
        const res = await this.send(row, row.url, { method: 'GET', headers: [['Accept', 'application/json, text/plain;q=0.9, */*;q=0.5']], signal })
        if (res.status === 401 || res.status === 403) this.setStatus(row, 'needs_auth', `refused:${res.status}`)
        else if (res.status >= 500) this.setStatus(row, 'error', `http_status:${res.status}`)
        else this.setStatus(row, 'connected', null)
      }
    } catch (e) {
      const s = statusOf(e)
      this.setStatus(row, s?.status ?? 'error', s?.reason ?? 'unreachable')
    }
    return getRow(this.db, row.id) ?? row
  }

  // ---------------- calls ----------------
  private client(row: Row): McpClient {
    const key = `${row.id}:${row.version}`
    const c = this.clients.get(key)
    if (c && this.now() - c.usedAt < CLIENT_IDLE_MS) return c
    this.dropClient(row.id)
    const fresh = new McpClient(row.url, () => this.authHeaders(row), this.net, () => this.hider([row]))
    this.clients.set(key, fresh)
    return fresh
  }
  private dropClient(id: string) { for (const k of [...this.clients.keys()]) if (k.startsWith(id + ':')) this.clients.delete(k) }

  /** Run against the MCP server: a new session when the server forgot ours, one token refresh after a 401. */
  private async withMcp<T>(row: Row, fn: (c: McpClient) => Promise<T>): Promise<T> {
    let renewed = false, refreshed = false
    for (;;) {
      const c = this.client(row)
      try { return await fn(c) } catch (e) {
        if (e instanceof McpError && e.code === 'session_gone' && !renewed) { renewed = true; this.dropClient(row.id); continue }
        if (e instanceof McpError && e.code === 'unauthorized' && row.auth === 'oauth' && !refreshed && row.secret_enc) {
          refreshed = true
          const s = this.secretOf(row)
          if (s.type === 'oauth') { await this.oauthToken(row, s.tokens.accessToken); this.dropClient(row.id); continue }
        }
        throw e
      }
    }
  }

  /** The connection this person may use now, for one call (checked on every call: people, rules and settings change). */
  forCall(userId: string, id: string): Row {
    const row = getRow(this.db, id)
    if (!row) throw new CallError('this connection no longer exists', 'gone')
    if (!mayUse(this.db, row, userId)) throw new CallError('the user may not use this connection (any more); the person who manages it can change that', 'no access')
    if (row.auth !== 'none' && !row.secret_enc) throw new CallError(`${row.name} needs ${row.auth === 'oauth' ? 'a new sign-in' : 'its key'}; the user can fix it in Settings > External services`, 'needs sign-in or key')
    return row
  }

  async callTool(row: Row, tool: string, args: unknown, signal?: AbortSignal): Promise<Record<string, any>> {
    try {
      const r = await this.withMcp(row, (c) => c.callTool(tool, args, signal))
      this.used(row)
      return r
    } catch (e) {
      if (!signal?.aborted) this.noteFailure(row, e)
      throw e instanceof CallError ? e : new CallError(callMessage(e, row), kindOf(e), e instanceof McpError && e.code === 'rpc')
    }
  }

  /** api_request: one request under the connection's address (the URL was built and checked by the caller). */
  async apiRequest(row: Row, url: string, req: { method: string; body: Buffer | null; contentType: string | null }, signal?: AbortSignal): Promise<NetResponse> {
    try {
      const res = await this.send(row, url, { method: req.method, headers: [['Accept', 'application/json, text/plain;q=0.9, */*;q=0.5'], ...(req.contentType ? [['Content-Type', req.contentType] as [string, string]] : [])], body: req.body, signal })
      if (res.status === 401) this.setStatus(row, 'needs_auth', 'refused:401')
      this.used(row)
      return res
    } catch (e) {
      if (!signal?.aborted) this.noteFailure(row, e)
      throw e instanceof CallError ? e : new CallError(callMessage(e, row), kindOf(e))
    }
  }

  private async send(row: Row, url: string, r: { method: string; headers: [string, string][]; body?: Buffer | null; signal?: AbortSignal }) {
    return serviceRequest(url, { ...r, headers: [...r.headers, ...(await this.authHeaders(row))] }, this.net)
  }
  private used(row: Row) { this.db.query('UPDATE integrations SET last_used_at=? WHERE id=?').run(iso(this.now()), row.id) }

  // ---------------- signing in (OAuth, MCP only) ----------------
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
    this.liveSession(viewer.id, session)
    this.sweep()
    const n = (this.db.query('SELECT count(*) AS n FROM integration_oauth_flows WHERE user_id=? AND created_at>?').get(viewer.id, iso(this.now() - 3600_000)) as { n: number }).n
    if (n >= FLOWS_PER_HOUR) fail('rate_limited')
    let setup: Awaited<ReturnType<typeof discover>>
    let client: OAuthClient
    const redirectUri = new URL('/api/integrations/oauth/callback', origin).href
    try {
      // the server's 401 names its metadata (WWW-Authenticate); without one the well-known addresses are tried
      let header = ''
      try { await new McpClient(row.url, async () => [], this.net).start() } catch (e) { if (e instanceof McpError && e.code === 'unauthorized') header = e.detail }
      setup = await discover(row.url, this.net, header)
      const old = row.secret_enc ? this.tryOpen(row) : null
      client = old?.type === 'oauth' && old.server.issuer === setup.server.issuer && old.client.redirectUri === redirectUri ? old.client : await register(setup.server, redirectUri, this.net)
    } catch (e) {
      const reason = e instanceof NetError ? e.reason : 'oauth_unsupported'
      this.setStatus(row, row.secret_enc ? row.status : 'needs_auth', reason)
      return fail('validation', say(reason as Reason, L, { status: e instanceof NetError ? e.status ?? '?' : '?' }))
    }
    const flowId = newId(), state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url')
    const secret: FlowSecret = { verifier, server: setup.server, client, resource: setup.resource, scope: setup.scope }
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
  async callback(q: { state?: string; code?: string; error?: string; iss?: string }, browser?: { userId: string; sessionId: string }): Promise<boolean> {
    this.sweep()
    if (!q.state || !/^[A-Za-z0-9_-]{43}$/.test(q.state)) return false
    const f = this.db.query('SELECT * FROM integration_oauth_flows WHERE state_hash=?').get(hash(q.state)) as FlowRow | null
    if (!f || f.state !== 'pending') return false
    if (!browser || browser.userId !== f.user_id) return false
    try { this.liveSession(browser.userId, browser.sessionId); this.liveSession(f.user_id, f.session_id) } catch { return false }
    if (!this.db.query("UPDATE integration_oauth_flows SET state='exchanging' WHERE id=? AND state='pending'").run(f.id).changes) return false
    const failed = (reason: string) => { this.db.query("UPDATE integration_oauth_flows SET state='failed', reason=?, secret_enc=NULL WHERE id=? AND state='exchanging'").run(reason, f.id); return false }
    try {
      if (q.error) return failed('denied')
      if (!q.code || q.code.length > 4096) return failed('invalid')
      const s = this.box.open<FlowSecret>(flowAad(f), f.secret_enc, f.key_version)
      // RFC 9207: an "iss" in the answer must be the server we started at
      if (q.iss && q.iss.replace(/\/+$/, '') !== s.server.issuer) return failed('invalid')
      const row = getRow(this.db, f.integration_id)
      const viewer = activeUser(this.db, f.user_id)
      if (!row || !viewer || row.version !== f.integration_version || row.auth !== 'oauth') return failed('changed')
      if (row.scope === 'personal' ? row.owner_user_id !== viewer.id : !isAdmin(viewer.role)) return failed('changed')
      let tokens: OAuthTokens
      try { tokens = await tokenRequest(s, { grant_type: 'authorization_code', code: q.code, redirect_uri: s.client.redirectUri, code_verifier: s.verifier, resource: s.resource }, this.net, this.now()) }
      catch { return failed('exchange') }
      const cur = getRow(this.db, row.id)
      if (!cur || cur.version !== row.version) return failed('changed')
      const sealed = this.box.seal(connectionAad(cur), { type: 'oauth', server: s.server, client: s.client, resource: s.resource, scope: s.scope, tokens } satisfies OAuthSecret)
      const old = cur.secret_enc ? this.tryOpen(cur) : null
      this.db.transaction(() => {
        this.db.query("UPDATE integrations SET secret_enc=?, key_version=?, status='needs_auth', last_error=NULL, version=version+1, updated_at=? WHERE id=? AND version=?")
          .run(sealed.enc, sealed.keyVersion, iso(this.now()), cur.id, cur.version)
        this.db.query("UPDATE integration_oauth_flows SET state='completed', secret_enc=NULL WHERE id=?").run(f.id)
      })()
      this.dropClient(cur.id)
      audit(this.db, { actor: viewer.id, action: 'integration.update', target: cur.id, detail: { ...auditDetail(cur), changed: ['signIn'], secret: 'replaced' } })
      if (old?.type === 'oauth' && old.tokens.refreshToken !== tokens.refreshToken) void this.revokeTokens(old)
      await this.check(getRow(this.db, cur.id)!)
      return true
    } catch { return failed('exchange') }
  }
}

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
  if (e instanceof NeedsAuth) return `${row.name} needs ${e.reason === 'sign_in' ? 'a new sign-in' : 'its key'}; the user can fix it in Settings > External services`
  if (e instanceof McpError) {
    if (e.code === 'rpc') return `${row.name} answered with an error: ${e.detail}`
    if (e.code === 'unauthorized' || e.code === 'forbidden') return `${row.name} refused the stored key or sign-in (HTTP ${e.status}); the user can fix it in Settings > External services`
    if (e.code === 'not_mcp') return `${row.name} did not answer like an MCP server`
    return `${row.name} answered HTTP ${e.status}`
  }
  if (e instanceof NetError) {
    const words: Record<string, string> = {
      timeout: 'did not answer within 30 seconds', private_address: 'points to a private, local or office address, which is not allowed', blocked_port: 'uses a port other than 443',
      tls: 'has a certificate that could not be verified', redirect: `redirected (HTTP ${e.status}); redirects are not followed`, too_large: 'sent an answer over 1 MB',
      key_unsafe: 'cannot be used: the server\'s key folder is unsafe', unreachable: 'could not be reached',
    }
    return `${row.name} ${words[e.reason] ?? 'could not be reached'}`
  }
  if (e instanceof GrantError) return `${row.name} needs a new sign-in; the user can fix it in Settings > External services`
  return `${row.name} could not be reached`
}

const instances = new WeakMap<AppContext, Integrations>()
/** Dependencies come only from offline tests, never from HTTP or model input. */
export function integrationsOf(ctx: AppContext, deps?: IntegrationDeps): Integrations {
  let svc = instances.get(ctx)
  if (!svc || deps) { svc = new Integrations(ctx, deps); instances.set(ctx, svc) }
  return svc
}
