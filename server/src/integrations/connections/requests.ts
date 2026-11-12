// An admin asks a member to connect a service as the member's own connection (docs/INTEGRATIONS.md "Asking a member to
// connect"). Some services log every call as the person whose key it is, so that key belongs in the person's own
// connection, which nobody else can see or use. The admin fills in the service (kind, name, address, how it signs in,
// the key's header, usage notes) for one member; the member gets an inbox notice and a link the admin can send, and adds
// their own key or signs in. That goes through the same create path as a connection the member adds themselves
// (service.ts create: the same checks, the key sealed for the member, the same audit), so the admin never sees the key
// and who may use the connection stays checked on every call as for any personal connection. A request waits 7 days;
// an admin may withdraw it, the member may decline it. Nothing here holds, returns or logs a key.
import { INTEGRATION_REQUEST_DAYS, Locale, type Integration, type IntegrationRequest, type IntegrationRequestAnswer, type IntegrationRequestInput, type IntegrationRequestState } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { audit } from '../../admin/audit'
import { getTeamSettings, teamDefaultLocale } from '../../admin/settings'
import { fail } from '../../http/errors'
import { notifyIntegrationRequest, settleIntegrationRequestNotice } from '../../notifications/service'
import { cleanNotes, fieldError, integrationsOf, normUrl, obviouslyPrivate, oneLine } from './service'
import { sharedAddressProblem } from './templates'
import { getRequest, getRow, isAdmin, REQUEST_COLUMNS, requestAuditDetail, view, type RequestRow, type Viewer } from './store'
import { say, type TextKey } from './text'

export const REQUEST_TTL_MS = INTEGRATION_REQUEST_DAYS * 86_400_000
/** waiting requests for one member, and for the whole team */
export const MAX_WAITING_PER_PERSON = 20
export const MAX_WAITING = 200
/** answered, withdrawn and expired requests stay in the admin's list this long */
const KEEP_MS = 30 * 86_400_000

const iso = (ms: number) => new Date(ms).toISOString()
/** A character something shows for. Not one: control and format characters, spaces, default-ignorable ones (the Hangul
 * fillers count as letters, so a list of what to refuse misses them) and the Braille blank. */
const SHOWS = /[^\p{Cc}\p{Cf}\p{Z}\p{DI}\u{2800}]/u
/** where the request opens in the app: Settings › External services */
export const requestPath = (id: string) => `/settings/integrations?request=${encodeURIComponent(id)}`
const ENDED: Record<Exclude<IntegrationRequestState, 'waiting'>, TextKey> = { connected: 'requestDone', declined: 'requestDeclined', withdrawn: 'requestWithdrawn', expired: 'requestExpired' }

export class ConnectionRequests {
  /** requests a member is connecting now (a second answer meanwhile is refused, so one request makes one connection) */
  private completing = new Set<string>()
  constructor(readonly ctx: AppContext) {}
  private get db() { return this.ctx.db }
  /** the connections service of now (offline tests replace it, with their clock) */
  private get svc() { return integrationsOf(this.ctx) }
  private now() { return this.svc.now() }

  private stateOf(r: RequestRow, now = this.now()): IntegrationRequestState {
    if (r.state === 'completed') return 'connected'
    if (r.state !== 'pending') return r.state
    return Date.parse(r.expires_at) <= now ? 'expired' : 'waiting'
  }
  private person(id: string | null) {
    return id ? this.db.query('SELECT id, name FROM users WHERE id = ?').get(id) as { id: string; name: string } | null : null
  }
  /** `forMember`: the member's own view, which never names the admin who asked (docs/DECISIONS.md "Admins are never
   * named": the people directory shows no roles, so a name here would tell the member who the admins are) */
  private view(r: RequestRow, base: string, forMember = false): IntegrationRequest {
    return {
      id: r.id, kind: r.kind, name: r.name, url: r.url, auth: r.auth, authHeader: r.auth_header, notes: r.notes,
      user: this.person(r.user_id) ?? { id: r.user_id, name: r.user_id }, requestedBy: forMember ? null : this.person(r.created_by),
      state: this.stateOf(r), createdAt: r.created_at, expiresAt: r.expires_at, endedAt: r.ended_at, link: new URL(requestPath(r.id), base).href,
    }
  }
  /** a waiting request, or a refusal that says what became of it */
  private waiting(r: RequestRow, L: Locale): void {
    const s = this.stateOf(r)
    if (s !== 'waiting') fail('conflict', say(ENDED[s], L), { params: { state: s } })
  }
  /** answered, withdrawn and expired requests go after KEEP_MS */
  private sweep() {
    const before = iso(this.now() - KEEP_MS)
    this.db.query("DELETE FROM integration_requests WHERE (state != 'pending' AND ended_at < ?) OR (state = 'pending' AND expires_at < ?)").run(before, before)
  }
  /** the member the request is for; anyone else (admins included) finds nothing */
  private mine(userId: string, id: string): RequestRow {
    const r = getRequest(this.db, id)
    return r && r.user_id === userId ? r : fail('not_found')
  }

  // ---------------- admins ----------------
  listTeam(base: string): IntegrationRequest[] {
    this.sweep()
    const rows = this.db.query(`SELECT ${REQUEST_COLUMNS} FROM integration_requests ORDER BY created_at DESC, id DESC`).all() as RequestRow[]
    // waiting ones first, newest first within each
    const now = this.now()
    return rows.sort((a, b) => Number(this.stateOf(b, now) === 'waiting') - Number(this.stateOf(a, now) === 'waiting')).map((r) => this.view(r, base))
  }

  create(viewer: Viewer, input: IntegrationRequestInput, base: string, locale: Locale): IntegrationRequest {
    const L = locale
    if (!isAdmin(viewer.role)) fail('forbidden')
    // the member's connection is made where they add their own: the team must allow that now
    if (!getTeamSettings(this.db).personalIntegrations) fail('conflict', say('requestPersonalOff', L))
    const member = this.db.query("SELECT id FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(input.userId) as { id: string } | null
    if (!member) fieldError(L, 'userId', 'requestNoUser')
    // the member's notice and the admin's list show this name: the schema trims spaces, nothing else that shows as nothing
    const name = oneLine(input.name)
    if (!SHOWS.test(name)) fieldError(L, 'name', 'requestNoName')
    // the same checks as a connection's own fields (service.ts create runs them all again when the member connects)
    const authHeader = input.auth === 'header' ? this.svc.headerName(input.authHeader ?? null, L) : null
    if (input.auth === 'oauth' && input.kind !== 'mcp') fieldError(L, 'auth', 'oauthMcpOnly')
    const url = normUrl(input.url)
    if (obviouslyPrivate(url)) fieldError(L, 'url', 'private_address')
    // the address goes with the member's own key: the admin's key in it would reach the member and be sent with every
    // call they make (a plain query, e.g. an instance id, stays allowed here as it was: a request is for one person)
    if (sharedAddressProblem(input.url) === 'secret') fieldError(L, 'url', 'requestAddressKey')
    this.sweep()
    const now = this.now(), at = iso(now)
    const waiting = (this.db.query("SELECT user_id, url FROM integration_requests WHERE state = 'pending' AND expires_at > ?").all(at) as { user_id: string; url: string }[])
    // a member's own connections are never looked at: whether they already have one is theirs to know
    if (waiting.some((w) => w.user_id === input.userId && w.url === url)) fail('conflict', say('requestDuplicate', L))
    if (waiting.filter((w) => w.user_id === input.userId).length >= MAX_WAITING_PER_PERSON) fail('conflict', say('requestTooMany', L, { n: MAX_WAITING_PER_PERSON }))
    if (waiting.length >= MAX_WAITING) fail('conflict', say('requestTooManyTeam', L, { n: MAX_WAITING }))
    const r: RequestRow = {
      id: newId(), user_id: input.userId, created_by: viewer.id, kind: input.kind, name, url, auth: input.auth, auth_header: authHeader,
      notes: input.kind === 'http' ? cleanNotes(input.notes) : null, state: 'pending', integration_id: null, created_at: at, expires_at: iso(now + REQUEST_TTL_MS), ended_at: null,
    }
    this.db.query(`INSERT INTO integration_requests (${REQUEST_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(r.id, r.user_id, r.created_by, r.kind, r.name, r.url, r.auth, r.auth_header, r.notes, r.state, r.integration_id, r.created_at, r.expires_at, r.ended_at)
    audit(this.db, { actor: viewer.id, action: 'integration_request.create', target: r.id, detail: requestAuditDetail(r) })
    this.tell(r)
    return this.view(r, base)
  }

  withdraw(viewer: Viewer, id: string, base: string, locale: Locale): IntegrationRequest {
    if (!isAdmin(viewer.role)) fail('forbidden')
    const r = getRequest(this.db, id) ?? fail('not_found')
    this.waiting(r, locale)
    // the member is connecting it right now: that answer came first (complete ends it as connected)
    if (this.completing.has(id)) fail('conflict', say('requestBusy', locale), { params: { state: 'waiting' } })
    const at = iso(this.now())
    if (!this.db.query("UPDATE integration_requests SET state = 'withdrawn', ended_at = ? WHERE id = ? AND state = 'pending'").run(at, id).changes) return this.conflictNow(id, locale)
    audit(this.db, { actor: viewer.id, action: 'integration_request.withdraw', target: id, detail: requestAuditDetail(r) })
    settleIntegrationRequestNotice(this.ctx, r.user_id)
    return this.view(getRequest(this.db, id)!, base)
  }

  /** the request changed under us (answered or withdrawn at the same moment): say what it is now */
  private conflictNow(id: string, L: Locale): never {
    const r = getRequest(this.db, id)
    if (!r) return fail('not_found')
    const s = this.stateOf(r)
    return fail('conflict', say(s === 'waiting' ? 'requestBusy' : ENDED[s], L), { params: { state: s } })
  }

  /** The member is told: an inbox entry (shown whatever their notice settings say; no OS push) and, when the app is
   * open, a banner with the way to the request, in their language. */
  private tell(r: RequestRow) {
    const L = this.localeOf(r.user_id)
    try {
      // the address's host with the name: the member's key goes there, whatever the name says. "An admin", never who
      this.ctx.services.realtime.publish(r.user_id, { type: 'notice', data: { level: 'info', code: 'integration_request', message: say('requestNotice', L, { name: r.name, host: new URL(r.url).host }), link: requestPath(r.id) } })
    } catch (err) { this.ctx.log.warn('connection request notice failed', { err }) }
    notifyIntegrationRequest(this.ctx, r.user_id, r.id)
  }
  private localeOf(userId: string): Locale {
    const v = Locale.safeParse((this.db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale: string } | null)?.locale)
    return v.success ? v.data : teamDefaultLocale(this.db)
  }

  // ---------------- the member ----------------
  /** the requests still waiting for this member */
  listMine(userId: string, base: string): IntegrationRequest[] {
    const rows = this.db.query(`SELECT ${REQUEST_COLUMNS} FROM integration_requests WHERE user_id = ? AND state = 'pending' AND expires_at > ? ORDER BY created_at DESC, id DESC`)
      .all(userId, iso(this.now())) as RequestRow[]
    return rows.map((r) => this.view(r, base, true))
  }
  getMine(userId: string, id: string, base: string): IntegrationRequest { return this.view(this.mine(userId, id), base, true) }

  decline(viewer: Viewer, id: string, base: string, locale: Locale): IntegrationRequest {
    const r = this.mine(viewer.id, id)
    this.waiting(r, locale)
    if (this.completing.has(id)) fail('conflict', say('requestBusy', locale), { params: { state: 'waiting' } })
    if (!this.db.query("UPDATE integration_requests SET state = 'declined', ended_at = ? WHERE id = ? AND state = 'pending'").run(iso(this.now()), id).changes) return this.conflictNow(id, locale)
    audit(this.db, { actor: viewer.id, action: 'integration_request.decline', target: id, detail: requestAuditDetail(r) })
    settleIntegrationRequestNotice(this.ctx, r.user_id)
    return this.view(getRequest(this.db, id)!, base, true)
  }

  /** The member connects it as their own connection, through service.ts create (as when they add one themselves). A key:
   * the request is connected once the connection is saved with it (its check says how the key does, as always). A
   * sign-in: the connection is made to sign in at next, and the request is connected when the sign-in finishes
   * (store.ts requestSignedIn); answering again before that gives the same connection, not another.
   * The answer counts from when it arrives: while it runs, withdraw and decline are refused (`completing`), and a
   * request that expires meanwhile still ends as the answer says. Never a 200 with the request left otherwise: if the
   * request cannot take the answer after all, the connection just made is deleted again and the answer refused. */
  async complete(viewer: Viewer, id: string, answer: IntegrationRequestAnswer, locale: Locale): Promise<Integration> {
    const L = locale
    const r = this.mine(viewer.id, id)
    this.waiting(r, L)
    if (this.completing.has(id)) fail('conflict', say('requestBusy', L), { params: { state: 'waiting' } })
    this.completing.add(id)
    try {
      if (r.auth === 'oauth') {
        const made = r.integration_id ? getRow(this.db, r.integration_id) : null
        if (made && made.scope === 'personal' && made.owner_user_id === viewer.id && made.url === r.url && made.auth === 'oauth') return view(this.db, made, viewer, L)
      } else if (answer.secret === undefined) fieldError(L, 'secret', 'no_secret')
      // a request made before addresses were checked: a key in its address is not passed on to the member
      if (sharedAddressProblem(r.url) === 'secret') fieldError(L, 'url', 'requestAddressKey')
      const created = await this.svc.create(viewer, {
        kind: r.kind, name: r.name, url: r.url, auth: r.auth, authHeader: r.auth_header, notes: r.notes, writePolicy: answer.writePolicy ?? 'ask',
        ...(answer.secret !== undefined ? { secret: answer.secret } : {}),
      }, 'personal', L)
      const at = iso(this.now())
      const took = r.auth === 'oauth'
        ? this.db.query("UPDATE integration_requests SET integration_id = ? WHERE id = ? AND state = 'pending'").run(created.id, id).changes
        : this.db.query("UPDATE integration_requests SET state = 'completed', integration_id = ?, ended_at = ? WHERE id = ? AND state = 'pending'").run(created.id, at, id).changes
      if (!took) {
        await this.svc.remove(viewer, created.id).catch(() => {})
        return this.conflictNow(id, L)
      }
      if (r.auth !== 'oauth') {
        audit(this.db, { actor: viewer.id, action: 'integration_request.complete', target: id, detail: requestAuditDetail(r) })
        settleIntegrationRequestNotice(this.ctx, viewer.id)
      }
      return created
    } finally { this.completing.delete(id) }
  }
}

const instances = new WeakMap<AppContext, ConnectionRequests>()
export function requestsOf(ctx: AppContext): ConnectionRequests {
  let s = instances.get(ctx)
  if (!s) { s = new ConnectionRequests(ctx); instances.set(ctx, s) }
  return s
}
