// The Slack connector (docs/SLACK.md, docs/DECISIONS.md "Slack 커넥터"): one workspace per team server, its tokens
// sealed in their own key directory, one Socket Mode connection, and for each question asked in Slack a normal chat
// turn run as the Slack user's linked person.
//
//   unlinked asker   -> an ephemeral message (only they see it) with a one-time link: hashed, 10 minutes, used once,
//                       bound to the enterprise / workspace / user of Slack's own event. Opening it needs a sign-in here
//                       and an explicit confirm that shows both accounts (routes/slack.ts, web /slack/link).
//   linked asker     -> the chat of that Slack thread for that person (a new one for a new thread), a turn exactly as if
//                       they had typed it here (their permissions, engine, budget, usage). "Working…" to them only.
//   answer, DM       -> in the DM's thread (the "working" message is replaced).
//   answer, channel  -> ephemeral to the asker with one button, "Post to channel"; posting writes the answer alone to
//                       the thread, "asked by <name>", without steps, sources or the link to the chat. Ephemeral messages
//                       are not kept by Slack, so the answer stays in the chat here and the message links to it.
// Envelopes are acknowledged by the socket before any of this runs; an event id or a message seen before is ignored.
import crypto from 'node:crypto'
import path from 'node:path'
import { DEFAULT_LOCALE, type Locale, type MySlack, type SlackAdmin, type SlackErrorCode, type SlackLinkPreview, type SlackState } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { audit } from '../../admin/audit'
import { budgetBlock } from '../../admin/budgets'
import { newChatEngine, turnEngine } from '../../admin/engine-choice'
import { teamDefaultLocale } from '../../admin/settings'
import { getChatRuntime } from '../../chat/runtime'
import type { ChatRow } from '../../chat/store'
import { HttpError } from '../../http/errors'
import { resolveLayout } from '../../system/layout'
import { SecretBox } from '../connections/store'
import { redactorFor } from '../connections/redact'
import { SlackApi, SlackApiError, type SlackDeps } from './api'
import { AppMention, BlockActions, EventCallback, ImMessage, type Envelope } from './envelope'
import { BOT_SCOPES, createAppUrl, slackManifest } from './manifest'
import { SlackSocket, errorCode } from './socket'
import { slackAnswer } from './rich-text'
import { clip, plain, questionText, say } from './text'

export const LINK_TTL_MS = 10 * 60_000
const LINK_PER_HOUR = 10
const EMAIL_TRUST_MS = 7 * 86_400_000
export const SLACK_CALLBACK_PATH = '/api/integrations/slack/oauth/callback'
const SLACK_AUTHORIZE = 'https://slack.com/openid/connect/authorize'
const LINK_AGAIN_MS = 60_000
const ANSWER_WAIT_MS = 2 * 60 * 60_000
const KEEP_MS = 7 * 86_400_000
const AAD = 'slack:workspace'
const ACTION_POST = 'trina_post'
const ACTION_LINK = 'trina_link'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class SlackError extends Error {
  constructor(readonly reason: string, readonly code: HttpError['code'] = 'validation', readonly params: Record<string, string> = {}) { super(`slack_${reason}`) }
}

interface ConfigRow {
  enabled: number; team_id: string | null; team_name: string | null; team_url: string | null; enterprise_id: string | null
  bot_user_id: string | null; bot_name: string | null; app_id: string | null; client_id: string | null; secret_enc: string | null; key_version: number | null
  link_origin: string | null; last_error: string | null
}
/** sealed together: the two tokens and, for Sign in with Slack, the app's client secret */
interface Tokens { bot: string; app: string; clientSecret?: string }
interface LinkRow { id: string; user_id: string; team_id: string; enterprise_id: string; slack_user_id: string; slack_name: string | null; created_at: string }
interface RequestRow {
  id: string; turn_id: string; user_id: string; chat_id: string; message_id: string; team_id: string; channel_id: string
  channel_kind: 'im' | 'channel'; thread_ts: string; in_thread: number; ext_shared: number; attempts: number; slack_user_id: string; enterprise_id: string; progress_ts: string | null
  asked_notice: number; state: 'waiting' | 'delivered' | 'failed' | 'posted'; created_at: string
}
interface Question { team: string; enterprise: string; user: string; channel: string; kind: 'im' | 'channel'; ts: string; threadTs: string | null; text: string; userTeam: string | null; extShared: boolean }
const ID = /^[A-Z0-9]{2,40}$/
interface SlackPerson { id: string; ours: boolean; name: string | null; realName: string | null; handle: string | null; email: string | null }
/** An e-mail address as compared: Unicode NFC, no surrounding space, lower case. Never NFKC: that would make a
 * look-alike (full-width) address equal to a real one. */
export const normEmail = (e: unknown): string | null => {
  if (typeof e !== 'string') return null
  const n = e.normalize('NFC').trim().toLowerCase()
  return n.length >= 3 && n.length <= 320 && n.includes('@') ? n : null
}
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const cleanName = (s: unknown) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 80) || null : null
const iso = (ms: number) => new Date(ms).toISOString()
/** A Slack user object (users.info, users.list) as we use it; `ours`: a person of the connected workspace (not a bot,
 * not deactivated, not of another workspace in a shared channel). null: not a user object. */
function memberOf(raw: unknown, cfg: Pick<ConfigRow, 'team_id' | 'enterprise_id'>): SlackPerson | null {
  const u = raw as { id?: unknown; team_id?: unknown; is_bot?: unknown; deleted?: unknown; name?: unknown; real_name?: unknown; enterprise_user?: { enterprise_id?: unknown }; profile?: { display_name?: unknown; real_name?: unknown; email?: unknown } } | null
  if (!u || typeof u !== 'object' || typeof u.id !== 'string' || !ID.test(u.id)) return null
  // the connected workspace only (also in an Enterprise Grid organization): the same rule as a question's (user_team)
  const sameTeam = u.team_id === cfg.team_id
  return {
    id: u.id, ours: sameTeam && u.is_bot !== true && u.deleted !== true && u.id !== 'USLACKBOT',
    name: cleanName(u.profile?.display_name), realName: cleanName(u.profile?.real_name) ?? cleanName(u.real_name), handle: cleanName(u.name),
    email: normEmail(u.profile?.email),
  }
}
/** The claims of the id_token Slack's token method gave the server itself over TLS (OpenID Connect Core 3.1.3.7: then
 * TLS stands for the signature); issuer, audience, time and nonce are checked by the caller. */
function idTokenClaims(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length > 16_384) throw new SlackApiError('invalid_response')
  const part = raw.split('.')[1]
  if (!part) throw new SlackApiError('invalid_response')
  try { const j = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); if (j && typeof j === 'object') return j as Record<string, unknown> } catch {}
  throw new SlackApiError('invalid_response')
}
const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,250}$/
const CLIENT_ID = /^\d{3,20}\.\d{3,20}$/
const CLIENT_SECRET = /^[A-Za-z0-9]{16,128}$/
const STATE = /^[A-Za-z0-9_-]{43}$/
/** The app an app-level token belongs to, from its prefix (xapp-1-A0CF4QNBQ1Y-…), or null when it does not read so */
export const appIdOfToken = (token: string): string | null => /^xapp-\d+-(A[A-Z0-9]{2,40})-/.exec(token)?.[1] ?? null
/** an authorization code as Slack sends it back (dot-separated parts) */
export const SIGNIN_CODE = /^[A-Za-z0-9._-]{8,512}$/
const CODE = SIGNIN_CODE
const APP_TOKEN = /^xapp-[A-Za-z0-9-]{10,250}$/

export class SlackConnector {
  readonly api: SlackApi
  readonly box: SecretBox
  readonly now: () => number
  private socket: SlackSocket | null = null
  private poller: ReturnType<typeof setInterval> | null = null
  private delivering = false
  private swept = 0
  private emailAuditSeen: number | null = null
  private closed = false

  constructor(readonly ctx: AppContext, readonly deps: SlackDeps = {}) {
    this.api = new SlackApi(deps)
    this.now = deps.now ?? Date.now
    this.box = new SecretBox(path.join(resolveLayout(ctx.config).secretsDir, 'integrations', 'slack'))
    ctx.onClose(() => this.close())
  }

  get log() { return this.ctx.log.child({ c: 'slack' }) }
  private get db() { return this.ctx.db }

  close() {
    this.closed = true
    this.socket?.stop(); this.socket = null
    if (this.poller) clearInterval(this.poller)
    this.poller = null
  }

  // ---------------------------------------------------------------- configuration (the owner)
  config(): ConfigRow | null { return this.db.query('SELECT * FROM slack_config WHERE id = 1').get() as ConfigRow | null }

  private tokens(cfg = this.config()): Tokens | null {
    if (!cfg?.secret_enc || cfg.key_version === null) return null
    try { return this.box.open<Tokens>(AAD, cfg.secret_enc, cfg.key_version) } catch { return null }
  }

  /** Start or stop the connection as the configuration says (turned on, tokens saved). */
  refresh() {
    if (this.closed) return
    const cfg = this.config()
    const on = !!cfg?.enabled && !!cfg.secret_enc
    if (!on) { this.socket?.stop(); this.socket = null; this.stopPoller(); return }
    if (!this.socket) {
      this.socket = new SlackSocket({
        api: this.api, log: this.log, retryMs: this.deps.retryMs, expectedAppId: cfg!.app_id,
        appToken: () => this.tokens()?.app ?? null,
        onEnvelope: (e) => { void this.onEnvelope(e).catch((err) => this.log.error('slack event failed', { err: String(err) })) },
        onState: (s, err) => this.noteState(s, err),
      })
      this.socket.start()
    }
    this.startPoller()
  }

  private noteState(_s: SlackState, err: SlackErrorCode | null) {
    try { this.db.query('UPDATE slack_config SET last_error = ? WHERE id = 1 AND last_error IS NOT ?').run(err, err) } catch {}
  }

  private startPoller() {
    if (this.poller) return
    this.poller = setInterval(() => { void this.tick() }, this.deps.pollMs ?? 1000)
    ;(this.poller as { unref?: () => void }).unref?.()
  }
  private stopPoller() { if (this.poller) clearInterval(this.poller); this.poller = null }

  /** `origin`: the address the owner uses now (the manifest's redirect URL before any is saved) */
  adminView(origin: string | null = null): SlackAdmin {
    const cfg = this.config()
    const redirect = this.redirectUri(cfg?.link_origin ?? origin)
    const manifest = slackManifest(undefined, redirect)
    const linked = (this.db.query('SELECT count(*) n FROM slack_links').get() as { n: number }).n
    const state: SlackState = !cfg?.enabled || !cfg.secret_enc ? 'off' : this.socket?.state ?? 'connecting'
    const lastError = (cfg?.enabled ? (this.socket?.lastError ?? cfg.last_error) : null) as SlackErrorCode | null
    return {
      enabled: !!cfg?.enabled, tokens: !!cfg?.secret_enc,
      workspace: cfg?.team_id ? { teamId: cfg.team_id, name: cfg.team_name ?? cfg.team_id, url: cfg.team_url } : null,
      botName: cfg?.secret_enc ? manifest.features.bot_user.display_name : null, appId: cfg?.app_id ?? null, state, lastError: state === 'connected' ? null : lastError,
      linkOrigin: cfg?.link_origin ?? null, linked, manifest: JSON.stringify(manifest, null, 2), createUrl: createAppUrl(manifest),
      signIn: !!cfg?.client_id && !!this.tokens(cfg)?.clientSecret, redirectUrl: redirect,
    }
  }

  /** Check both tokens with Slack, then keep them sealed. Another workspace than before drops every link. */
  async saveTokens(actor: string, bot: string, app: string, client: { id: string; secret: string }, origin: string): Promise<SlackAdmin> {
    bot = bot.trim(); app = app.trim()
    const clientId = client.id.trim(), clientSecret = client.secret.trim()
    if (!BOT_TOKEN.test(bot)) throw new SlackError('not_bot_token', 'validation', { field: 'botToken' })
    if (!APP_TOKEN.test(app)) throw new SlackError('not_app_token', 'validation', { field: 'appToken' })
    if (!CLIENT_ID.test(clientId)) throw new SlackError('not_client_id', 'validation', { field: 'clientId' })
    if (!CLIENT_SECRET.test(clientSecret)) throw new SlackError('not_client_secret', 'validation', { field: 'clientSecret' })
    let who: Record<string, unknown> & { scopes: string[] | null }
    try { who = await this.api.call('auth.test', bot) } catch (e) { throw new SlackError(errorCode(e), 'validation', { field: 'botToken' }) }
    if (who.is_enterprise_install === true) throw new SlackError('enterprise_install', 'validation', { field: 'botToken' })
    const team = typeof who.team_id === 'string' && ID.test(who.team_id) ? who.team_id : null
    const botUser = typeof who.user_id === 'string' && ID.test(who.user_id) ? who.user_id : null
    if (!team || !botUser) throw new SlackError('not_bot_token', 'validation', { field: 'botToken' })
    if (who.scopes) {
      const missing = BOT_SCOPES.filter((s) => !who.scopes!.includes(s))
      if (missing.length) throw new SlackError('missing_scope', 'validation', { field: 'botToken', scopes: missing.join(', ') })
    }
    try { await this.api.call('apps.connections.open', app) } catch (e) {
      const code = errorCode(e)
      throw new SlackError(code === 'invalid_auth' || code === 'unknown' ? 'not_app_token' : code, 'validation', { field: 'appToken' })
    }
    // both tokens of one app: the bot's app (bots.info) and the app the app-level token names in its prefix
    // (xapp-<n>-<A…>-…). Not the socket address's app_id: real Slack puts a hash there, not the app id.
    let appId: string | null = null
    try {
      const b = await this.api.call('bots.info', bot, { bot: who.bot_id })
      const id = (b.bot as { app_id?: unknown } | undefined)?.app_id
      if (typeof id === 'string' && ID.test(id)) appId = id
    } catch {}
    const tokenApp = appIdOfToken(app)
    // either one unknown: no check here (the connection's hello names the app, and envelopes must carry it)
    if (appId && tokenApp && tokenApp !== appId) throw new SlackError('app_mismatch', 'validation', { field: 'appToken' })
    appId = appId ?? tokenApp
    let sealed: { enc: string; keyVersion: number }
    try { sealed = this.box.seal(AAD, { bot, app, clientSecret } satisfies Tokens) } catch { throw new SlackError('key_unsafe', 'unavailable') }
    const before = this.config()
    const changed = !!before?.team_id && before.team_id !== team
    const now = iso(this.now())
    const url = typeof who.url === 'string' && /^https:\/\/[a-z0-9.-]+\/?$/i.test(who.url) ? who.url : null
    const enterprise = typeof who.enterprise_id === 'string' && ID.test(who.enterprise_id) ? who.enterprise_id : null
    this.db.transaction(() => {
      if (changed) this.forgetWorkspace()
      this.db.query(`INSERT INTO slack_config (id, enabled, team_id, team_name, team_url, enterprise_id, bot_user_id, bot_name, app_id, client_id, secret_enc, key_version, link_origin, last_error, updated_by, updated_at)
        VALUES (1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET team_id = excluded.team_id, team_name = excluded.team_name, team_url = excluded.team_url, enterprise_id = excluded.enterprise_id,
          bot_user_id = excluded.bot_user_id, bot_name = excluded.bot_name, app_id = excluded.app_id, client_id = excluded.client_id, secret_enc = excluded.secret_enc, key_version = excluded.key_version,
          link_origin = excluded.link_origin, last_error = NULL, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(team, cleanName(who.team) ?? team, url, enterprise, botUser, cleanName(who.user), appId, clientId, sealed.enc, sealed.keyVersion, origin, actor, now)
    })()
    audit(this.db, { actor, action: 'slack.tokens', target: team, detail: { workspaceChanged: changed } })
    // the new tokens: a fresh connection
    this.socket?.stop(); this.socket = null
    this.refresh()
    return this.adminView()
  }

  setEnabled(actor: string, enabled: boolean): SlackAdmin {
    const cfg = this.config()
    if (enabled && !cfg?.secret_enc) throw new SlackError('no_tokens', 'conflict')
    if (cfg) this.db.query('UPDATE slack_config SET enabled = ?, updated_by = ?, updated_at = ? WHERE id = 1').run(enabled ? 1 : 0, actor, iso(this.now()))
    if (cfg && !!cfg.enabled !== enabled) audit(this.db, { actor, action: enabled ? 'slack.enabled' : 'slack.disabled', target: cfg.team_id })
    this.refresh()
    return this.adminView()
  }

  remove(actor: string): SlackAdmin {
    const cfg = this.config()
    this.db.transaction(() => { this.forgetWorkspace(); this.db.query('DELETE FROM slack_config').run() })()
    if (cfg) audit(this.db, { actor, action: 'slack.removed', target: cfg.team_id })
    this.refresh()
    return this.adminView()
  }

  private forgetWorkspace() {
    for (const t of ['slack_links', 'slack_link_tokens', 'slack_signin_flows', 'slack_threads', 'slack_requests', 'slack_events']) this.db.query(`DELETE FROM ${t}`).run()
  }

  // ---------------------------------------------------------------- people (Settings, the link page)
  private available(cfg = this.config()) { return !!cfg?.enabled && !!cfg.secret_enc && !!cfg.team_id }

  mine(userId: string): MySlack {
    const cfg = this.config()
    const l = this.db.query('SELECT * FROM slack_links WHERE user_id = ?').get(userId) as LinkRow | null
    return {
      available: this.available(cfg), workspace: cfg?.team_name ?? null,
      link: l ? { slackUserId: l.slack_user_id, slackName: l.slack_name, linkedAt: l.created_at } : null,
      signIn: this.signInReady(cfg),
      emailSetByOther: this.emailSetByOther(userId),
    }
  }

  /** "Sign in with Slack" can be offered: turned on, the app's client id and secret saved, an https address */
  private signInReady(cfg = this.config()): boolean {
    return this.available(cfg) && !!cfg!.client_id && !!this.tokens(cfg)?.clientSecret && !!this.redirectUri(cfg!.link_origin)
  }

  unlink(userId: string): MySlack {
    const l = this.db.query('SELECT * FROM slack_links WHERE user_id = ?').get(userId) as LinkRow | null
    if (l) {
      this.db.transaction(() => {
        this.db.query('DELETE FROM slack_links WHERE user_id = ?').run(userId)
        this.db.query('DELETE FROM slack_threads WHERE user_id = ?').run(userId)
      })()
      audit(this.db, { actor: userId, action: 'slack.unlinked', target: userId, detail: { reason: 'self', slackUser: l.slack_user_id } })
    }
    return this.mine(userId)
  }

  private sweep() {
    const now = this.now()
    this.db.query('DELETE FROM slack_link_tokens WHERE expires_at < ?').run(iso(now - 86_400_000))
    this.db.query('DELETE FROM slack_events WHERE seen_at < ?').run(iso(now - 86_400_000))
    this.db.query("DELETE FROM slack_requests WHERE state != 'waiting' AND created_at < ?").run(iso(now - KEEP_MS))
    this.db.query('DELETE FROM slack_signin_flows WHERE expires_at < ?').run(iso(now - 86_400_000))
  }

  private tokenRow(token: string) {
    const r = this.db.query('SELECT * FROM slack_link_tokens WHERE token_hash = ?').get(sha(token)) as
      { token_hash: string; team_id: string; enterprise_id: string; slack_user_id: string; slack_name: string | null; slack_real_name: string | null; slack_handle: string | null; channel_id: string | null; thread_ts: string | null; expires_at: string; used_at: string | null } | null
    const cfg = this.config()
    // unknown, used, past its time, or of another workspace than the one connected now: the same "not found"
    if (!r || r.used_at || r.expires_at <= iso(this.now()) || !this.available(cfg) || r.team_id !== cfg!.team_id) throw new SlackError('link_expired', 'not_found')
    return { r, cfg: cfg! }
  }

  /** an account that is there (active, not deleted), whatever its password state */
  private account(userId: string) {
    return this.db.query("SELECT id FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId) as { id: string } | null
  }

  /** an account that may use the app now (no password change pending) */
  private person(userId: string) {
    return this.db.query("SELECT id, name, username, role FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL AND must_change_password = 0").get(userId) as { id: string; name: string; username: string; role: string } | null
  }

  /** The Slack account as Slack says it now (users.info): of this workspace, a person (no bot, not deactivated), and its
   * e-mail (scope users:read.email; null when Slack has none or hides it). null: Slack did not answer. */
  private async slackMember(bot: string, slackUserId: string, cfg: ConfigRow): Promise<SlackPerson | null> {
    try {
      const info = await this.api.call('users.info', bot, { user: slackUserId })
      return memberOf(info.user, cfg)
    } catch (e) { this.log.info('slack user unavailable', { reason: e instanceof SlackApiError ? e.code : 'unknown' }); return null }
  }

  /** Whether the Slack account may be linked to this person: of this workspace, and its e-mail is the person's own (the
   * proof that the one who confirms owns the Slack account; docs/DECISIONS.md "Slack 커넥터"). */
  private emailProof(slack: SlackPerson | null, userId: string): 'match' | 'mismatch' | 'missing' | 'shared' | 'outsider' | 'recent' | 'unavailable' {
    if (!slack) return 'unavailable'
    if (!slack.ours) return 'outsider'
    const mine = normEmail((this.db.query('SELECT email FROM users WHERE id = ?').get(userId) as { email: string | null } | null)?.email)
    if (!slack.email || !mine) return 'missing'
    if (slack.email !== mine) return 'mismatch'
    if (this.emailSetByOther(userId)) return 'recent'
    // an address another active account also gives: it proves nobody in particular
    const others = this.db.query("SELECT email FROM users WHERE id != ? AND status = 'active' AND deleted_at IS NULL AND email IS NOT NULL").all(userId) as { email: string }[]
    return others.some((o) => normEmail(o.email) === mine) ? 'shared' : 'match'
  }

  /** The account's e-mail was last set by someone else (an admin's create or change, audited) less than 7 days ago: an
   * admin could have given a member a colleague's Slack e-mail, so it proves nothing yet. The person's own change
   * (Settings › Profile) has no audit entry; a change of theirs after the admin's makes it theirs again. */
  private emailSetByOther(userId: string): boolean {
    const last = (this.db.query('SELECT changed_at FROM slack_email_changes WHERE user_id = ?').get(userId) as { changed_at: string } | null)?.changed_at
    if (!last || Date.parse(last) < this.now() - EMAIL_TRUST_MS) return false
    // the admin's audit entry is written in the same transaction as the change (within this margin of its time)
    const from = iso(Math.max(Date.parse(last) - 1000, this.now() - EMAIL_TRUST_MS))
    return !!this.db.query(`SELECT 1 FROM audit_log WHERE target = ? AND at >= ? AND actor_id IS NOT NULL AND actor_id != ?
      AND (action = 'user.create' OR (action = 'user.update' AND json_type(detail, '$.email') IS NOT NULL)) LIMIT 1`).get(userId, from, userId)
  }

  async preview(userId: string, token: string): Promise<SlackLinkPreview> {
    const { r, cfg } = this.tokenRow(token)
    const me = this.person(userId)
    if (!me) throw new SlackError('link_expired', 'not_found')
    const mine = this.db.query('SELECT * FROM slack_links WHERE user_id = ?').get(userId) as LinkRow | null
    const tk = this.tokens(cfg)
    const proof = tk ? this.emailProof(await this.slackMember(tk.bot, r.slack_user_id, cfg), userId) : 'unavailable'
    return {
      workspace: cfg.team_name ?? cfg.team_id!, slack: { userId: r.slack_user_id, name: r.slack_name, realName: r.slack_real_name, handle: r.slack_handle }, me: { name: me.name, username: me.username },
      expiresAt: r.expires_at, linkedElsewhere: !!mine && !(mine.team_id === r.team_id && mine.slack_user_id === r.slack_user_id),
      emailCheck: proof === 'match' ? 'match' : proof === 'unavailable' ? 'unavailable' : proof === 'recent' ? 'recent' : proof === 'mismatch' || proof === 'shared' || proof === 'outsider' ? 'mismatch' : 'missing',
      email: (this.db.query('SELECT email FROM users WHERE id = ?').get(userId) as { email: string | null } | null)?.email ?? null,
      signIn: this.signInReady(cfg),
    }
  }

  async confirm(userId: string, token: string): Promise<MySlack> {
    const { r, cfg } = this.tokenRow(token)
    const me = this.person(userId)
    if (!me) throw new SlackError('link_expired', 'not_found')
    const tk = this.tokens(cfg)
    if (!tk) throw new SlackError('unreachable', 'unavailable')
    // already linked to another Slack account: said first (checked again below, where it counts)
    const before = this.db.query('SELECT * FROM slack_links WHERE user_id = ?').get(userId) as LinkRow | null
    if (before && !(before.team_id === r.team_id && before.slack_user_id === r.slack_user_id)) throw new SlackError('linked_elsewhere', 'conflict')
    // the proof: Slack's own e-mail of the Slack account this link was sent to is the confirming person's e-mail
    const proof = this.emailProof(await this.slackMember(tk.bot, r.slack_user_id, cfg), userId)
    if (proof === 'unavailable') throw new SlackError('unreachable', 'unavailable')
    if (proof !== 'match') {
      audit(this.db, { actor: userId, action: 'slack.link_refused', target: userId, detail: { slackUser: r.slack_user_id, reason: `email_${proof}` } })
      throw new SlackError(proof === 'missing' ? 'email_missing' : proof === 'recent' ? 'email_recent' : 'email_mismatch', 'conflict')
    }
    const now = iso(this.now())
    let made = false
    this.db.transaction(() => {
      const same = this.bindable(userId, r.team_id, r.slack_user_id)
      // used once: a second confirm of the same link (another tab, another person) finds it gone
      if (!this.db.query('UPDATE slack_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').run(now, r.token_hash, now).changes) throw new SlackError('link_expired', 'not_found')
      if (!same) { this.bind(userId, r.team_id, r.slack_user_id, r.slack_name, now); made = true }
    })()
    if (made) {
      audit(this.db, { actor: userId, action: 'slack.linked', target: userId, detail: { slackUser: r.slack_user_id, team: r.team_id } })
      // tell the Slack account, where it asked (only it sees this), which account it now asks as
      if (r.channel_id) {
        const locale = this.localeOf(userId)
        void this.api.call('chat.postEphemeral', tk.bot, { channel: r.channel_id, user: r.slack_user_id, ...(r.thread_ts ? { thread_ts: r.thread_ts } : {}), text: say('linked', locale, { name: plain(`${me.name} (@${me.username})`) }) }).catch(() => {})
      }
    }
    return this.mine(userId)
  }

  /** One message in the app's DM with a Slack person (conversations.open, scope im:write). Best effort. */
  private async dm(bot: string, slackUserId: string, text: string) {
    try {
      const im = await this.api.call('conversations.open', bot, { users: slackUserId })
      const channel = (im.channel as { id?: unknown } | undefined)?.id
      if (typeof channel === 'string' && ID.test(channel)) await this.api.call('chat.postMessage', bot, { channel, text })
    } catch (e) { this.log.warn('slack message could not be sent', { reason: e instanceof SlackApiError ? e.code : 'unknown' }) }
  }

  // ---------------------------------------------------------------- Sign in with Slack (the person proves the Slack account)
  /** The address Slack sends the browser back to (registered in the app as its redirect URL): https only (Slack's rule). */
  redirectUri(origin: string | null): string | null {
    if (!origin) return null
    try { const u = new URL(origin); return u.protocol === 'https:' && !u.username && !u.password ? `${u.origin}${SLACK_CALLBACK_PATH}` : null } catch { return null }
  }

  /** One check for every way a link is made (the one-time link, Sign in with Slack): this person is not linked to another
   * Slack account, and this Slack user of the workspace not to another person. true: already this very link. Inside the
   * caller's transaction. */
  private bindable(userId: string, team: string, slackUser: string): boolean {
    const mine = this.db.query('SELECT * FROM slack_links WHERE user_id = ?').get(userId) as LinkRow | null
    const same = !!mine && mine.team_id === team && mine.slack_user_id === slackUser
    if (mine && !same) throw new SlackError('linked_elsewhere', 'conflict')
    const owner = this.ownerOf(team, slackUser)
    if (owner && owner.user_id !== userId) throw new SlackError('slack_taken', 'conflict')
    return same
  }

  /** The link itself: the workspace's enterprise id as auth.test gave it (events carry the same), the person's open
   * one-time links used up. Inside the caller's transaction. */
  private bind(userId: string, team: string, slackUser: string, name: string | null, now: string) {
    this.db.query('UPDATE slack_link_tokens SET used_at = ? WHERE team_id = ? AND slack_user_id = ? AND used_at IS NULL').run(now, team, slackUser)
    this.db.query('INSERT INTO slack_links (id, user_id, team_id, enterprise_id, slack_user_id, slack_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), userId, team, this.config()?.enterprise_id ?? '', slackUser, name, now)
  }

  /** Start "Sign in with Slack" for the signed-in person (docs.slack.dev "Sign in with Slack"): state and nonce random,
   * stored hashed, bound to this person, 10 minutes. The person's browser goes to Slack: in the desktop app the system
   * browser, in the phone app an in-app browser, so it may come back without the app's session (then the person signs
   * in there and it goes on). `client`: where it started, for the page at the end. */
  startSignIn(userId: string, sessionId: string, client: string = 'web'): { authorizationUrl: string } {
    const cfg = this.config(), creds = this.tokens(cfg)
    if (!cfg || !this.available(cfg) || !cfg.client_id || !creds?.clientSecret) throw new SlackError('signin_off', 'conflict')
    const redirect = this.redirectUri(cfg.link_origin)
    if (!redirect) throw new SlackError('https_needed', 'conflict')
    if (!this.person(userId)) throw new SlackError('signin_off', 'conflict')
    const now = this.now()
    const recent = (this.db.query('SELECT count(*) n FROM slack_signin_flows WHERE user_id = ? AND created_at > ?').get(userId, iso(now - 3600_000)) as { n: number }).n
    if (recent >= 20) throw new SlackError('ratelimited', 'rate_limited')
    const state = crypto.randomBytes(32).toString('base64url'), nonce = crypto.randomBytes(32).toString('base64url')
    this.db.transaction(() => {
      // only the newest flow of this person works
      this.db.query("UPDATE slack_signin_flows SET state = 'failed', reason = 'superseded' WHERE user_id = ? AND state = 'pending'").run(userId)
      this.db.query("INSERT INTO slack_signin_flows (id, user_id, session_id, state_hash, nonce_hash, redirect_uri, client, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
        .run(newId(), userId, sessionId, sha(state), sha(nonce), redirect, client === 'desktop' || client === 'mobile' ? client : 'web', iso(now), iso(now + LINK_TTL_MS))
    })()
    const u = new URL(SLACK_AUTHORIZE)
    // `team`: this workspace (an app that is not distributed signs in to its own workspace only)
    for (const [k, v] of Object.entries({ response_type: 'code', scope: 'openid profile', client_id: cfg.client_id, state, nonce, redirect_uri: redirect, team: cfg.team_id! })) u.searchParams.set(k, v)
    return { authorizationUrl: u.href }
  }

  /** Slack sent the browser back. Only a browser signed in as the person who started it finishes it (any of their
   * sessions); a browser with no session is sent to sign in first, and the flow waits (`signin_needed`); another
   * person's session refuses and ends it. The code is exchanged by the server (openid.connect.token, with the client
   * secret) and the id_token's claims checked (issuer, audience, time, nonce); the Slack user it names is the one who
   * signed in to Slack, so it is linked. `client`: where the flow started. */
  async finishSignIn(input: { state?: string; code?: string; error?: string }, browser: { userId: string } | null): Promise<{ result: string; client: string }> {
    if (!input.state || !STATE.test(input.state)) return { result: 'signin_expired', client: 'web' }
    const f = this.db.query('SELECT * FROM slack_signin_flows WHERE state_hash = ?').get(sha(input.state)) as { id: string; user_id: string; nonce_hash: string; redirect_uri: string; client: string; state: string; expires_at: string } | null
    if (!f || f.state !== 'pending' || f.expires_at <= iso(this.now())) return { result: 'signin_expired', client: f?.client ?? 'web' }
    const out = (result: string) => ({ result, client: f.client })
    const end = (reason: string) => { this.db.query("UPDATE slack_signin_flows SET state = 'failed', reason = ? WHERE id = ? AND state = 'pending'").run(reason, f.id); return out(reason) }
    if (input.error) return end('signin_cancelled')
    if (!input.code || !CODE.test(input.code)) return end('signin_failed')
    // no session in this browser (the desktop app's system browser, the phone app's in-app browser, another address):
    // sign in here first, then this same address again; the flow waits
    if (!browser) return out('signin_needed')
    // signed in as somebody else: never that person's link
    if (browser.userId !== f.user_id) return end('signin_other_user')
    if (!this.db.query("UPDATE slack_signin_flows SET state = 'failed', reason = 'used' WHERE id = ? AND state = 'pending'").run(f.id).changes) return out('signin_expired')
    const fail = (reason: string) => { this.db.query('UPDATE slack_signin_flows SET reason = ? WHERE id = ?').run(reason, f.id); return out(reason) }
    const cfg = this.config(), creds = this.tokens(cfg)
    const me = this.person(f.user_id)
    if (!cfg || !this.available(cfg) || !cfg.client_id || !creds?.clientSecret || !me) return fail('signin_off')
    let r: Record<string, unknown>
    try { r = await this.api.call('openid.connect.token', '', { client_id: cfg.client_id, client_secret: creds.clientSecret, code: input.code, grant_type: 'authorization_code', redirect_uri: f.redirect_uri }, { noAuth: true }) }
    catch (e) { this.log.warn('slack sign-in exchange failed', { reason: e instanceof SlackApiError ? e.code : 'unknown' }); return fail('signin_failed') }
    // the person's Slack user token is never kept: revoked whatever the id_token turns out to be
    const userToken = typeof r.access_token === 'string' ? r.access_token : null
    let claims: Record<string, unknown>
    try { claims = idTokenClaims(r.id_token) } catch { return fail('signin_failed') }
    finally { if (userToken) void this.api.call('auth.revoke', userToken).catch(() => {}) }
    const nowS = this.now() / 1000
    if (claims.iss !== 'https://slack.com' || claims.aud !== cfg.client_id || typeof claims.exp !== 'number' || claims.exp < nowS - 60 || typeof claims.nonce !== 'string' || sha(claims.nonce) !== f.nonce_hash) return fail('signin_failed')
    const slackUser = claims['https://slack.com/user_id']
    if (typeof slackUser !== 'string' || !ID.test(slackUser) || claims['https://slack.com/team_id'] !== cfg.team_id) return fail('outsider')
    const team = cfg.team_id!
    // Slack says now who this is: a person of this workspace (no bot, not deactivated), as for every link
    const m = await this.slackMember(creds.bot, slackUser, cfg)
    if (!m) return fail('signin_failed')
    if (!m.ours) return fail('outsider')
    const now = iso(this.now())
    let made = false
    try {
      this.db.transaction(() => {
        if (!this.bindable(f.user_id, team, slackUser)) { this.bind(f.user_id, team, slackUser, m.name ?? m.realName ?? m.handle, now); made = true }
        this.db.query("UPDATE slack_signin_flows SET state = 'done', reason = NULL WHERE id = ?").run(f.id)
      })()
    } catch (e) { if (e instanceof SlackError) return fail(e.reason); throw e }
    // already this very link (signed in again): nothing new to record or say
    if (made) {
      audit(this.db, { actor: f.user_id, action: 'slack.linked', target: f.user_id, detail: { slackUser, team, via: 'slack_signin' } })
      // the Slack account is told which account it now asks as, and how to undo it
      await this.dm(creds.bot, slackUser, say('mapped', this.localeOf(f.user_id), { name: plain(`${me.name} (@${me.username})`) }))
    }
    return out('linked')
  }

  cancel(userId: string, token: string) {
    const { r } = this.tokenRow(token)
    if (!this.person(userId)) throw new SlackError('link_expired', 'not_found')
    this.db.query('UPDATE slack_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(iso(this.now()), r.token_hash)
  }

  private localeOf(userId: string | null): Locale {
    if (userId) try { return getChatRuntime(this.ctx).userLocale(userId) } catch {}
    try { return teamDefaultLocale(this.db) } catch { return DEFAULT_LOCALE }
  }

  // ---------------------------------------------------------------- events
  /** One envelope (already acknowledged). Exported for tests through the instance. */
  async onEnvelope(env: Envelope) {
    const cfg = this.config()
    if (!this.available(cfg)) return
    // the app the tokens were saved for (else the one Slack's hello named); unknown: nothing is handled
    const appId = cfg!.app_id ?? this.socket?.appId ?? null
    if (!appId) return
    if (env.type === 'events_api') {
      const cb = EventCallback.safeParse(env.payload)
      if (!cb.success || cb.data.team_id !== cfg!.team_id || cb.data.api_app_id !== appId) return
      if (!this.seen(`e:${cb.data.event_id}`)) return
      const enterprise = cb.data.enterprise_id ?? ''
      const ev = cb.data.event
      if (ev.type === 'app_mention') {
        const m = AppMention.safeParse(ev)
        if (!m.success || m.data.subtype || m.data.bot_id || m.data.user === cfg!.bot_user_id) return
        // a DM is message.im; a channel id starting with D here is not ours to answer as a channel
        if (m.data.channel.startsWith('D')) return
        await this.question(cfg!, { team: cb.data.team_id, enterprise, user: m.data.user, channel: m.data.channel, kind: 'channel', ts: m.data.ts, threadTs: m.data.thread_ts ?? null, text: m.data.text, userTeam: m.data.user_team ?? null, extShared: cb.data.is_ext_shared_channel === true })
      } else if (ev.type === 'message') {
        const m = ImMessage.safeParse(ev)
        if (!m.success || m.data.subtype || m.data.bot_id || m.data.user === cfg!.bot_user_id || !m.data.channel.startsWith('D')) return
        await this.question(cfg!, { team: cb.data.team_id, enterprise, user: m.data.user, channel: m.data.channel, kind: 'im', ts: m.data.ts, threadTs: m.data.thread_ts ?? null, text: m.data.text, userTeam: m.data.user_team ?? null, extShared: cb.data.is_ext_shared_channel === true })
      }
      return
    }
    if (env.type === 'interactive') {
      const p = BlockActions.safeParse(env.payload)
      if (!p.success || p.data.api_app_id !== appId) return
      const team = p.data.team?.id ?? p.data.user.team_id
      if (team !== cfg!.team_id) return
      await this.action(cfg!, p.data, p.data.enterprise?.id ?? '')
    }
    // slash commands and anything else: acknowledged, nothing to do
  }

  /** true the first time a key is seen (event id or message), across restarts and processes */
  private seen(key: string): boolean {
    return this.db.query('INSERT OR IGNORE INTO slack_events (key, seen_at) VALUES (?, ?)').run(key, iso(this.now())).changes === 1
  }

  /** The person this Slack user of the workspace is linked to (the enterprise id is not part of the match) */
  private ownerOf(team: string, slackUser: string): LinkRow | null {
    return this.db.query('SELECT * FROM slack_links WHERE team_id = ? AND slack_user_id = ?').get(team, slackUser) as LinkRow | null
  }

  private async ephemeral(bot: string, q: Pick<Question, 'channel' | 'user' | 'threadTs'>, text: string, blocks?: unknown[]) {
    try { await this.api.call('chat.postEphemeral', bot, { channel: q.channel, user: q.user, ...(q.threadTs ? { thread_ts: q.threadTs } : {}), text, ...(blocks ? { blocks } : {}) }) }
    catch (e) { this.log.warn('slack ephemeral message failed', { reason: e instanceof SlackApiError ? e.code : 'unknown' }) }
  }

  private async question(cfg: ConfigRow, q: Question) {
    // the same message twice (as a mention and as a DM, or sent again): once
    if (!this.seen(`m:${q.channel}:${q.ts}`)) return
    const tk = this.tokens(cfg)
    if (!tk) return
    // a person of another workspace (Slack Connect): never linked, never answered
    if (q.userTeam && q.userTeam !== q.team) { await this.ephemeral(tk.bot, q, say('outsider', this.localeOf(null))); return }
    const link = this.ownerOf(q.team, q.user)
    const account = link ? this.account(link.user_id) : null
    if (!link || !account) { await this.offerLink(cfg, tk.bot, q, link); return }
    const locale = this.localeOf(account.id)
    // a password to change first (a temporary one): no turn until they did, the link stays
    const who = this.person(account.id)
    if (!who) { await this.ephemeral(tk.bot, q, say('signInFirst', locale)); return }
    const text = questionText(q.text, cfg.bot_user_id)
    if (!text) { await this.ephemeral(tk.bot, q, say('empty', locale)); return }
    const rt = getChatRuntime(this.ctx)
    const block = budgetBlock(this.db, who.id, locale)
    if (block) { await this.ephemeral(tk.bot, q, say('cannotStart', locale, { reason: block.message })); return }
    const root = q.threadTs ?? q.ts
    const existing = this.db.query('SELECT c.* FROM slack_threads s JOIN chats c ON c.id = s.chat_id WHERE s.team_id = ? AND s.channel_id = ? AND s.thread_ts = ? AND s.user_id = ? AND c.user_id = s.user_id AND c.deleted_at IS NULL')
      .get(q.team, q.channel, root, who.id) as ChatRow | null
    const person = { id: who.id, role: who.role }
    let started
    try {
      const fresh = existing ? null : newChatEngine(this.ctx, person, {}, locale)
      const te = turnEngine(this.ctx, person, existing ?? { engine: fresh!.engine, model: fresh!.model }, {}, locale, (e) => rt.defaultModelFor(e))
      const chatId = existing?.id ?? newId()
      const chat = existing ?? (() => {
        const ts = iso(this.now())
        this.db.query("INSERT INTO chats (id, user_id, project_id, title, title_source, engine, model, created_at, updated_at) VALUES (?, ?, NULL, '', 'auto', ?, ?, ?, ?)")
          .run(chatId, who.id, fresh!.engine, fresh!.model ?? null, ts, ts)
        this.db.query('INSERT OR REPLACE INTO slack_threads (team_id, channel_id, thread_ts, user_id, chat_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(q.team, q.channel, root, who.id, chatId, ts)
        return rt.store.chatRow(chatId)!
      })
      started = rt.createTurn({
        chat, userId: who.id, locale, windowId: null, clientKind: 'slack', engine: te.engine, model: te.model, ...(te.substitutedFrom ? { substitutedFrom: te.substitutedFrom } : {}),
        user: { parentId: existing?.active_leaf_id ?? null, content: text, attachments: [], clientMessageId: `slack-${sha(`${q.team}:${q.channel}:${q.ts}`).slice(0, 40)}` },
      })
      if (!existing) rt.publishChat(who.id, chatId, 'created')
    } catch (e) {
      const why = e instanceof HttpError
        ? e.code === 'conflict' ? say('busy', locale) : e.code === 'unavailable' || e.code === 'rate_limited' ? say('queueFull', locale) : say('cannotStart', locale, { reason: e.userMessage ?? e.code })
        : say('cannotStart', locale, { reason: 'internal' })
      if (!(e instanceof HttpError)) this.log.error('slack question could not start a turn', { err: String(e) })
      await this.ephemeral(tk.bot, q, why)
      return
    }
    const id = newId()
    this.db.query(`INSERT INTO slack_requests (id, turn_id, user_id, chat_id, message_id, team_id, enterprise_id, channel_id, channel_kind, thread_ts, in_thread, ext_shared, slack_user_id, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`)
      .run(id, started.turnId, who.id, started.assistantMessage.chatId, started.assistantMessage.id, q.team, q.enterprise, q.channel, q.kind, root, q.threadTs ? 1 : 0, q.extShared ? 1 : 0, q.user, iso(this.now()))
    // "working…": to the asker only (in a DM a message of its own, deleted when the answer comes), naming the account
    // it answers as, so a Slack account linked to the wrong person shows at once
    const blocks = [{ type: 'context', elements: [{ type: 'mrkdwn', text: [say('working', locale), say('as', locale, { name: plain(`${who.name} (@${who.username})`) }), this.chatLink(cfg, started.assistantMessage.chatId, locale)].filter(Boolean).join('  ') }] }]
    if (q.kind === 'im') {
      try {
        const r = await this.api.call('chat.postMessage', tk.bot, { channel: q.channel, thread_ts: root, text: say('working', locale), blocks })
        if (typeof r.ts === 'string' && /^\d{1,12}\.\d{1,9}$/.test(r.ts)) this.db.query('UPDATE slack_requests SET progress_ts = ? WHERE id = ?').run(r.ts, id)
      } catch (e) { this.log.warn('slack working message failed', { reason: e instanceof SlackApiError ? e.code : 'unknown' }) }
    } else await this.ephemeral(tk.bot, q, say('working', locale), blocks)
  }

  private chatLink(cfg: ConfigRow, chatId: string, locale: Locale): string {
    return cfg.link_origin ? `<${cfg.link_origin}/c/${chatId}|${say('open', locale)}>` : ''
  }

  /** The one-time link, to the asker only. A link still fresh is not made again; a person may get 10 an hour. */
  private async offerLink(cfg: ConfigRow, bot: string, q: Question, stale: LinkRow | null) {
    const locale = this.localeOf(null)
    if (stale) this.db.query('DELETE FROM slack_links WHERE id = ?').run(stale.id)
    if (!cfg.link_origin) return
    const tooSoon = () => {
      const now = this.now()
      const recent = this.db.query('SELECT count(*) n, max(created_at) last FROM slack_link_tokens WHERE team_id = ? AND slack_user_id = ? AND created_at > ?').get(q.team, q.user, iso(now - 3600_000)) as { n: number; last: string | null }
      return recent.n >= LINK_PER_HOUR || (!!recent.last && Date.parse(recent.last) > now - LINK_AGAIN_MS)
    }
    if (tooSoon()) { await this.ephemeral(bot, q, say('linkWait', locale)); return }
    // who this Slack account is, as Slack says: shown on the link page next to the person who confirms. No answer from
    // Slack: no link (we could not check the account is of this workspace)
    const m = await this.slackMember(bot, q.user, cfg)
    if (!m) { await this.ephemeral(bot, q, say('queueFull', locale)); return }
    if (!m.ours) { await this.ephemeral(bot, q, say('outsider', locale)); return }
    const names = { display: m.name, real: m.realName, handle: m.handle }
    const token = crypto.randomBytes(32).toString('base64url')
    let made = false
    this.db.transaction(() => {
      // two questions at once: the second sees the first's link (the check above ran before the wait for Slack)
      if (tooSoon()) return
      const now = this.now()
      // only the newest link of this Slack account works
      this.db.query('UPDATE slack_link_tokens SET used_at = ? WHERE team_id = ? AND slack_user_id = ? AND used_at IS NULL').run(iso(now), q.team, q.user)
      this.db.query('INSERT INTO slack_link_tokens (token_hash, team_id, enterprise_id, slack_user_id, slack_name, slack_real_name, slack_handle, channel_id, thread_ts, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(sha(token), q.team, q.enterprise, q.user, names.display ?? names.real ?? names.handle, names.real, names.handle, q.channel, q.threadTs, iso(now + LINK_TTL_MS), iso(now))
      made = true
    })()
    if (!made) { await this.ephemeral(bot, q, say('linkWait', locale)); return }
    const url = `${cfg.link_origin}/slack/link?t=${token}`
    await this.ephemeral(bot, q, say('linkPrompt', locale), [
      { type: 'section', text: { type: 'mrkdwn', text: say('linkPrompt', locale) } },
      { type: 'actions', elements: [{ type: 'button', action_id: ACTION_LINK, style: 'primary', text: { type: 'plain_text', text: say('linkButton', locale).slice(0, 75) }, url }] },
    ])
  }

  // ---------------------------------------------------------------- answers
  private async tick() {
    if (this.delivering || this.closed) return
    this.delivering = true
    try {
      if (this.now() - this.swept > 60_000) { this.swept = this.now(); this.sweep() }
      this.emailNotices()
      // finished turns first, whatever waits before them
      const done = this.db.query("SELECT r.* FROM slack_requests r JOIN turns t ON t.id = r.turn_id WHERE r.state = 'waiting' AND t.status NOT IN ('queued', 'running') AND (r.not_before IS NULL OR r.not_before <= ?) ORDER BY r.created_at LIMIT 20").all(iso(this.now())) as RequestRow[]
      for (const r of done) await this.deliver(r)
      const open = this.db.query("SELECT r.* FROM slack_requests r LEFT JOIN turns t ON t.id = r.turn_id WHERE r.state = 'waiting' AND (t.status IS NULL OR t.status IN ('queued', 'running')) ORDER BY r.created_at LIMIT 100").all() as RequestRow[]
      for (const r of open) {
        if (Date.parse(r.created_at) < this.now() - ANSWER_WAIT_MS) { await this.giveUp(r); continue }
        if (!r.asked_notice) await this.noticeQuestion(r)
      }
    } catch (e) { this.log.error('slack delivery failed', { err: String(e) }) }
    finally { this.delivering = false }
  }

  /** An admin changed someone's e-mail (Admin › Members): that person is told in the app, since for 7 days it is no
   * proof for a Slack link. Only changes from after this server started are looked at. */
  private emailNotices() {
    if (this.emailAuditSeen === null) { this.emailAuditSeen = (this.db.query('SELECT COALESCE(max(id), 0) id FROM audit_log').get() as { id: number }).id; return }
    const rows = this.db.query(`SELECT id, target FROM audit_log WHERE id > ? AND action = 'user.update' AND json_type(detail, '$.email') IS NOT NULL
      AND actor_id IS NOT NULL AND actor_id != target ORDER BY id LIMIT 100`).all(this.emailAuditSeen) as { id: number; target: string }[]
    const last = (this.db.query('SELECT COALESCE(max(id), 0) id FROM audit_log').get() as { id: number }).id
    for (const r of rows) {
      try { this.ctx.services.realtime.publish(r.target, { type: 'notice', data: { level: 'info', code: 'slack_email_changed', message: say('emailChangedNotice', this.localeOf(r.target)), link: '/settings/connectors' } }) } catch {}
    }
    this.emailAuditSeen = rows.length === 100 ? rows.at(-1)!.id : last
  }

  private where(r: RequestRow) { return { channel: r.channel_id, user: r.slack_user_id, threadTs: r.channel_kind === 'im' || r.in_thread ? r.thread_ts : null } }

  /** Two hours without an answer: the asker is told, the chat keeps whatever comes later. */
  private async giveUp(r: RequestRow) {
    if (!this.db.query("UPDATE slack_requests SET state = 'failed' WHERE id = ? AND state = 'waiting'").run(r.id).changes) return
    const cfg = this.config(), tk = this.tokens(cfg)
    if (!cfg || !tk || !this.stillLinked(r)) return
    const locale = this.localeOf(r.user_id)
    await this.ephemeral(tk.bot, this.where(r), say('tooLong', locale), [{ type: 'section', text: { type: 'mrkdwn', text: `${say('tooLong', locale)} ${this.chatLink(cfg, r.chat_id, locale)}` } }])
  }

  /** The answer waits for a card in the app (a question of the AI, a confirmation): say so, once. */
  private async noticeQuestion(r: RequestRow) {
    let open = 0
    try { open = getChatRuntime(this.ctx).execFor(r.turn_id)?.openRequests().length ?? 0 } catch {}
    if (!open) return
    this.db.query('UPDATE slack_requests SET asked_notice = 1 WHERE id = ?').run(r.id)
    const cfg = this.config(), tk = this.tokens(cfg)
    if (!cfg || !tk || !this.stillLinked(r)) return
    const locale = this.localeOf(r.user_id)
    const text = `${say('needsAnswer', locale)} ${this.chatLink(cfg, r.chat_id, locale)}`
    await this.ephemeral(tk.bot, this.where(r), say('needsAnswer', locale), [{ type: 'section', text: { type: 'mrkdwn', text } }])
  }

  /** The Slack account that asked is still linked to the person the turn ran as, who may still use the app. */
  private stillLinked(r: Pick<RequestRow, 'team_id' | 'enterprise_id' | 'slack_user_id' | 'user_id'>): boolean {
    const link = this.ownerOf(r.team_id, r.slack_user_id)
    return !!link && link.user_id === r.user_id && !!this.person(r.user_id)
  }

  private answerOf(r: Pick<RequestRow, 'message_id' | 'user_id'>, locale: Locale): { ok: boolean; text: string } {
    const m = this.db.query('SELECT content, status, error FROM messages WHERE id = ?').get(r.message_id) as { content: string; status: string; error: string | null } | null
    if (!m) return { ok: false, text: say('failed', locale, { reason: 'gone' }) }
    if (m.status === 'stopped') return { ok: false, text: say('stopped', locale) }
    if (m.status !== 'done' || !m.content.trim()) {
      let reason = m.status
      try { const e = m.error ? JSON.parse(m.error) as { message?: unknown } : null; if (typeof e?.message === 'string') reason = e.message } catch {}
      return { ok: false, text: say('failed', locale, { reason: clip(reason, 300).text }) }
    }
    return { ok: true, text: redactorFor(this.ctx, r.user_id).hide(m.content) }
  }

  private async deliver(r: RequestRow) {
    const cfg = this.config(), tk = this.tokens(cfg)
    if (!cfg || !tk || !cfg.enabled) return
    // claimed first: another tick or process never sends it twice
    if (!this.db.query("UPDATE slack_requests SET state = 'delivered', delivered_at = ? WHERE id = ? AND state = 'waiting'").run(iso(this.now()), r.id).changes) return
    try {
      // unlinked or disabled meanwhile: nothing goes to that Slack account any more (the chat keeps the answer)
      if (!this.stillLinked(r)) { this.db.query("UPDATE slack_requests SET state = 'failed' WHERE id = ?").run(r.id); return }
      const locale = this.localeOf(r.user_id)
      const a = this.answerOf(r, locale)
      // rich text (rich-text.ts): bold next to Hangul stays bold; a failure is our own sentence, shown as it is
      const body = slackAnswer(a.text, cfg.link_origin, a.ok ? 4 : 1, a.ok)
      const notes = [a.ok && body.cut ? say('more', locale) : '', this.chatLink(cfg, r.chat_id, locale)].filter(Boolean).join('  ')
      const fallback = body.text
      if (r.channel_kind === 'im') {
        // a new message (Slack notifies for it, not for an edit); the "working…" one goes. A try that timed out may
        // have reached Slack: the thread is read first, so the answer is never there twice
        const blocks = (answer: unknown[]) => [...answer, ...(notes ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: notes }] }] : [])]
        const there = r.attempts > 0 ? await this.alreadyInThread(tk.bot, cfg, r, fallback) : false
        // Slack did not say whether it is there: tried again later rather than risk a second copy (after 3 tries it is sent)
        if (there === null && r.attempts < 4) throw new SlackApiError('unreachable')
        if (!there) await refusedBlocksAgain(body, (answer) => this.api.call('chat.postMessage', tk.bot, { channel: r.channel_id, thread_ts: r.thread_ts, text: fallback, blocks: blocks(answer), unfurl_links: false, unfurl_media: false }))
        if (r.progress_ts) await this.api.call('chat.delete', tk.bot, { channel: r.channel_id, ts: r.progress_ts }).catch(() => {})
      } else {
        // a channel shared with another organization (Slack Connect): no button; it says why
        const postable = a.ok && !r.ext_shared
        const blocks = (answer: unknown[]) => [
          ...answer,
          { type: 'context', elements: [{ type: 'mrkdwn', text: [r.ext_shared ? say('sharedChannel', locale) : say('onlyYou', locale), notes].filter(Boolean).join('  ') }] },
          ...(postable ? [{ type: 'actions', elements: [{ type: 'button', action_id: ACTION_POST, style: 'primary', value: r.id, text: { type: 'plain_text', text: say('post', locale).slice(0, 75) } }] }] : []),
        ]
        await refusedBlocksAgain(body, (answer) => this.api.call('chat.postEphemeral', tk.bot, { channel: r.channel_id, user: r.slack_user_id, ...(r.in_thread ? { thread_ts: r.thread_ts } : {}), text: fallback, blocks: blocks(answer) }))
      }
      if (!a.ok) this.db.query("UPDATE slack_requests SET state = 'failed' WHERE id = ?").run(r.id)
    } catch (e) {
      const code = e instanceof SlackApiError ? e.code : 'unknown'
      // Slack's limit (after the wait it asked for) or a network problem (after 15 s): tried again; anything else: the
      // answer stays in the chat
      if (code === 'ratelimited' || code === 'unreachable') {
        const wait = code === 'ratelimited' ? Math.max(1, Math.min(3600, (e as SlackApiError).retryAfter ?? 30)) * 1000 : 15_000
        this.db.query("UPDATE slack_requests SET state = 'waiting', delivered_at = NULL, attempts = attempts + 1, not_before = ? WHERE id = ?").run(iso(this.now() + wait), r.id)
      }
      else this.db.query("UPDATE slack_requests SET state = 'failed' WHERE id = ?").run(r.id)
      this.log.warn('slack answer could not be delivered', { reason: code })
    }
  }

  /** Our answer to this request is in its DM thread already (conversations.replies, scope im:history): a message of
   * the app with this text, written after the request was made (an earlier answer with the same words does not count).
   * null: Slack did not answer (the caller waits and asks again). */
  private async alreadyInThread(bot: string, cfg: ConfigRow, req: RequestRow, text: string): Promise<boolean | null> {
    const since = Date.parse(req.created_at) / 1000
    try {
      const r = await this.api.call('conversations.replies', bot, { channel: req.channel_id, ts: req.thread_ts, limit: 200 })
      const msgs = Array.isArray(r.messages) ? r.messages as { user?: unknown; bot_id?: unknown; text?: unknown; ts?: unknown }[] : []
      return msgs.some((m) => (m.user === cfg.bot_user_id || typeof m.bot_id === 'string') && m.text === text && typeof m.ts === 'string' && Number(m.ts) > since)
    } catch { return null }
  }

  /** "Post to channel": the asker's answer alone, in the thread, once. */
  private async action(cfg: ConfigRow, p: BlockActions, enterprise: string) {
    const act = p.actions[0]!
    if (act.action_id !== ACTION_POST) return // the link button opens a page; nothing to do here
    const tk = this.tokens(cfg)
    if (!tk) return
    const reply = (text: string) => p.response_url ? this.api.respond(p.response_url, { replace_original: true, text }) : Promise.resolve(false)
    const r = act.value && UUID.test(act.value) ? this.db.query('SELECT * FROM slack_requests WHERE id = ?').get(act.value) as RequestRow | null : null
    const locale = this.localeOf(r?.user_id ?? null)
    // only the asker's own answer (an ephemeral message is only theirs; the check holds even if a value is replayed)
    if (!r || r.slack_user_id !== p.user.id || r.team_id !== cfg.team_id || r.enterprise_id !== enterprise || r.channel_kind !== 'channel') { await reply(say('postGone', locale)); return }
    if (r.ext_shared) { await reply(say('sharedChannel', locale)); return }
    // asked again now (a channel can be shared after the question): Slack must say it is not shared outside
    let shared: boolean | null = null
    try {
      const info = await this.api.call('conversations.info', tk.bot, { channel: r.channel_id })
      const ch = info.channel as { is_ext_shared?: unknown; is_pending_ext_shared?: unknown } | undefined
      if (typeof ch?.is_ext_shared === 'boolean') shared = ch.is_ext_shared || ch.is_pending_ext_shared === true
    } catch {}
    if (shared !== false) { await reply(say(shared ? 'sharedChannel' : 'postCheckFailed', locale)); return }
    if (r.state === 'posted') { await reply(say('postedAlready', locale)); return }
    if (r.state !== 'delivered') { await reply(say('postGone', locale)); return }
    if (!this.stillLinked(r)) { await reply(say('notLinked', locale)); return }
    // a chat deleted in the app takes its answer with it
    if (!this.db.query('SELECT 1 FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(r.chat_id, r.user_id)) { await reply(say('postGone', locale)); return }
    const a = this.answerOf(r, locale)
    if (!a.ok) { await reply(say('postGone', locale)); return }
    const link = this.ownerOf(r.team_id, r.slack_user_id)!
    const body = slackAnswer(a.text, cfg.link_origin, 10)
    // a name as text, never a mention (no ping)
    const asker = link.slack_name ? plain(link.slack_name) : say('teammate', locale)
    const blocks = (answer: unknown[]) => [{ type: 'context', elements: [{ type: 'mrkdwn', text: say('askedBy', locale, { name: asker }) }] }, ...answer]
    if (!this.db.query("UPDATE slack_requests SET state = 'posted', posted_at = ? WHERE id = ? AND state = 'delivered'").run(iso(this.now()), r.id).changes) { await reply(say('postedAlready', locale)); return }
    try {
      await refusedBlocksAgain(body, (answer) => this.api.call('chat.postMessage', tk.bot, { channel: r.channel_id, thread_ts: r.thread_ts, text: body.text, blocks: blocks(answer), unfurl_links: false, unfurl_media: false }))
    } catch (e) {
      this.db.query("UPDATE slack_requests SET state = 'delivered', posted_at = NULL WHERE id = ?").run(r.id)
      this.log.warn('slack answer could not be posted', { reason: e instanceof SlackApiError ? e.code : 'unknown' })
      await reply(say('postFailed', locale))
      return
    }
    audit(this.db, { actor: r.user_id, action: 'slack.posted', target: r.chat_id, detail: { channel: r.channel_id } })
    await reply(say('posted', locale))
  }
}

/** Slack refused the answer's blocks (their size or shape): the same answer once more as plain text in one block,
 * rather than no answer. Nothing was posted by the refused call. */
const REFUSED_BLOCKS = new Set(['invalid_blocks', 'invalid_blocks_format', 'msg_blocks_too_long', 'msg_too_long'])
async function refusedBlocksAgain(body: { blocks: unknown[]; plainBlocks: unknown[] }, send: (answer: unknown[]) => Promise<unknown>) {
  try { await send(body.blocks) } catch (e) {
    if (!(e instanceof SlackApiError) || !REFUSED_BLOCKS.has(e.code)) throw e
    await send(body.plainBlocks)
  }
}

const instances = new WeakMap<AppContext, SlackConnector>()
/** The connector of this server. `deps` only from offline tests (a fake Slack): it replaces the one made at start,
 * never from HTTP, a file or the environment. */
export function slackOf(ctx: AppContext, deps?: SlackDeps): SlackConnector {
  let s = instances.get(ctx)
  if (!s || deps) { s?.close(); s = new SlackConnector(ctx, deps ?? {}); instances.set(ctx, s) }
  return s
}
