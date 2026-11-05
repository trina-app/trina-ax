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
import { clip, plain, questionText, say, sections, toMrkdwn } from './text'

export const LINK_TTL_MS = 10 * 60_000
const LINK_PER_HOUR = 10
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
  bot_user_id: string | null; bot_name: string | null; app_id: string | null; secret_enc: string | null; key_version: number | null
  link_origin: string | null; last_error: string | null
}
interface Tokens { bot: string; app: string }
interface LinkRow { id: string; user_id: string; team_id: string; enterprise_id: string; slack_user_id: string; slack_name: string | null; created_at: string }
interface RequestRow {
  id: string; turn_id: string; user_id: string; chat_id: string; message_id: string; team_id: string; channel_id: string
  channel_kind: 'im' | 'channel'; thread_ts: string; in_thread: number; slack_user_id: string; enterprise_id: string; progress_ts: string | null
  asked_notice: number; state: 'waiting' | 'delivered' | 'failed' | 'posted'; created_at: string
}
interface Question { team: string; enterprise: string; user: string; channel: string; kind: 'im' | 'channel'; ts: string; threadTs: string | null; text: string; userTeam: string | null }

const ID = /^[A-Z0-9]{2,40}$/
interface SlackPerson { id: string; ours: boolean; name: string | null; realName: string | null; handle: string | null; email: string | null }
export interface SlackMembers { available: boolean; truncated: boolean; members: { slackUserId: string; name: string | null; realName: string | null; handle: string | null; email: string | null; linkedTo: { id: string; name: string; username: string } | null }[] }
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
  const sameTeam = u.team_id === cfg.team_id || (!!cfg.enterprise_id && u.enterprise_user?.enterprise_id === cfg.enterprise_id)
  return {
    id: u.id, ours: sameTeam && u.is_bot !== true && u.deleted !== true && u.id !== 'USLACKBOT',
    name: cleanName(u.profile?.display_name), realName: cleanName(u.profile?.real_name) ?? cleanName(u.real_name), handle: cleanName(u.name),
    email: normEmail(u.profile?.email),
  }
}
const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,250}$/
const APP_TOKEN = /^xapp-[A-Za-z0-9-]{10,250}$/

export class SlackConnector {
  readonly api: SlackApi
  readonly box: SecretBox
  readonly now: () => number
  private socket: SlackSocket | null = null
  private poller: ReturnType<typeof setInterval> | null = null
  private delivering = false
  private swept = 0
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

  adminView(): SlackAdmin {
    const cfg = this.config()
    const manifest = slackManifest()
    const linked = (this.db.query('SELECT count(*) n FROM slack_links').get() as { n: number }).n
    const state: SlackState = !cfg?.enabled || !cfg.secret_enc ? 'off' : this.socket?.state ?? 'connecting'
    const lastError = (cfg?.enabled ? (this.socket?.lastError ?? cfg.last_error) : null) as SlackErrorCode | null
    return {
      enabled: !!cfg?.enabled, tokens: !!cfg?.secret_enc,
      workspace: cfg?.team_id ? { teamId: cfg.team_id, name: cfg.team_name ?? cfg.team_id, url: cfg.team_url } : null,
      botName: cfg?.bot_name ?? null, state, lastError: state === 'connected' ? null : lastError,
      linkOrigin: cfg?.link_origin ?? null, linked, manifest: JSON.stringify(manifest, null, 2), createUrl: createAppUrl(manifest),
    }
  }

  /** Check both tokens with Slack, then keep them sealed. Another workspace than before drops every link. */
  async saveTokens(actor: string, bot: string, app: string, origin: string): Promise<SlackAdmin> {
    bot = bot.trim(); app = app.trim()
    if (!BOT_TOKEN.test(bot)) throw new SlackError('not_bot_token', 'validation', { field: 'botToken' })
    if (!APP_TOKEN.test(app)) throw new SlackError('not_app_token', 'validation', { field: 'appToken' })
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
    let socketUrl: unknown
    try { socketUrl = (await this.api.call('apps.connections.open', app)).url } catch (e) {
      const code = errorCode(e)
      throw new SlackError(code === 'invalid_auth' || code === 'unknown' ? 'not_app_token' : code, 'validation', { field: 'appToken' })
    }
    // both tokens of one app: the bot's app (bots.info) and the app the socket address names, when it names one
    let appId: string | null = null
    try {
      const b = await this.api.call('bots.info', bot, { bot: who.bot_id })
      const id = (b.bot as { app_id?: unknown } | undefined)?.app_id
      if (typeof id === 'string' && ID.test(id)) appId = id
    } catch {}
    let socketApp: string | null = null
    try { socketApp = typeof socketUrl === 'string' ? new URL(socketUrl).searchParams.get('app_id') : null } catch {}
    if (appId && socketApp && socketApp !== appId) throw new SlackError('app_mismatch', 'validation', { field: 'appToken' })
    let sealed: { enc: string; keyVersion: number }
    try { sealed = this.box.seal(AAD, { bot, app } satisfies Tokens) } catch { throw new SlackError('key_unsafe', 'unavailable') }
    const before = this.config()
    const changed = !!before?.team_id && before.team_id !== team
    const now = iso(this.now())
    const url = typeof who.url === 'string' && /^https:\/\/[a-z0-9.-]+\/?$/i.test(who.url) ? who.url : null
    const enterprise = typeof who.enterprise_id === 'string' && ID.test(who.enterprise_id) ? who.enterprise_id : null
    this.db.transaction(() => {
      if (changed) this.forgetWorkspace()
      this.db.query(`INSERT INTO slack_config (id, enabled, team_id, team_name, team_url, enterprise_id, bot_user_id, bot_name, app_id, secret_enc, key_version, link_origin, last_error, updated_by, updated_at)
        VALUES (1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET team_id = excluded.team_id, team_name = excluded.team_name, team_url = excluded.team_url, enterprise_id = excluded.enterprise_id,
          bot_user_id = excluded.bot_user_id, bot_name = excluded.bot_name, app_id = excluded.app_id, secret_enc = excluded.secret_enc, key_version = excluded.key_version,
          link_origin = excluded.link_origin, last_error = NULL, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(team, cleanName(who.team) ?? team, url, enterprise, botUser, cleanName(who.user), appId, sealed.enc, sealed.keyVersion, origin, actor, now)
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
    for (const t of ['slack_links', 'slack_link_tokens', 'slack_threads', 'slack_requests', 'slack_events']) this.db.query(`DELETE FROM ${t}`).run()
  }

  // ---------------------------------------------------------------- people (Settings, the link page)
  private available(cfg = this.config()) { return !!cfg?.enabled && !!cfg.secret_enc && !!cfg.team_id }

  mine(userId: string): MySlack {
    const cfg = this.config()
    const l = this.db.query('SELECT * FROM slack_links WHERE user_id = ?').get(userId) as LinkRow | null
    return {
      available: this.available(cfg), workspace: cfg?.team_name ?? null,
      link: l ? { slackUserId: l.slack_user_id, slackName: l.slack_name, linkedAt: l.created_at } : null,
    }
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
  private emailProof(slack: SlackPerson | null, userId: string): 'match' | 'mismatch' | 'missing' | 'shared' | 'outsider' | 'unavailable' {
    if (!slack) return 'unavailable'
    if (!slack.ours) return 'outsider'
    const mine = normEmail((this.db.query('SELECT email FROM users WHERE id = ?').get(userId) as { email: string | null } | null)?.email)
    if (!slack.email || !mine) return 'missing'
    if (slack.email !== mine) return 'mismatch'
    // an address another active account also gives: it proves nobody in particular
    const others = this.db.query("SELECT email FROM users WHERE id != ? AND status = 'active' AND deleted_at IS NULL AND email IS NOT NULL").all(userId) as { email: string }[]
    return others.some((o) => normEmail(o.email) === mine) ? 'shared' : 'match'
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
      expiresAt: r.expires_at, linkedElsewhere: !!mine && !(mine.team_id === r.team_id && mine.enterprise_id === r.enterprise_id && mine.slack_user_id === r.slack_user_id),
      emailCheck: proof === 'match' ? 'match' : proof === 'unavailable' ? 'unavailable' : proof === 'mismatch' || proof === 'shared' || proof === 'outsider' ? 'mismatch' : 'missing',
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
    if (before && !(before.team_id === r.team_id && before.enterprise_id === r.enterprise_id && before.slack_user_id === r.slack_user_id)) throw new SlackError('linked_elsewhere', 'conflict')
    // the proof: Slack's own e-mail of the Slack account this link was sent to is the confirming person's e-mail
    const proof = this.emailProof(await this.slackMember(tk.bot, r.slack_user_id, cfg), userId)
    if (proof === 'unavailable') throw new SlackError('unreachable', 'unavailable')
    if (proof !== 'match') {
      audit(this.db, { actor: userId, action: 'slack.link_refused', target: userId, detail: { slackUser: r.slack_user_id, reason: `email_${proof}` } })
      throw new SlackError(proof === 'missing' ? 'email_missing' : 'email_mismatch', 'conflict')
    }
    const now = iso(this.now())
    let made = false
    this.db.transaction(() => {
      const mine = this.db.query('SELECT * FROM slack_links WHERE user_id = ?').get(userId) as LinkRow | null
      const same = !!mine && mine.team_id === r.team_id && mine.enterprise_id === r.enterprise_id && mine.slack_user_id === r.slack_user_id
      if (mine && !same) throw new SlackError('linked_elsewhere', 'conflict')
      const taken = this.db.query('SELECT user_id FROM slack_links WHERE team_id = ? AND enterprise_id = ? AND slack_user_id = ?').get(r.team_id, r.enterprise_id, r.slack_user_id) as { user_id: string } | null
      if (taken && taken.user_id !== userId) throw new SlackError('slack_taken', 'conflict')
      // used once: a second confirm of the same link (another tab, another person) finds it gone
      if (!this.db.query('UPDATE slack_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').run(now, r.token_hash, now).changes) throw new SlackError('link_expired', 'not_found')
      // every other open link of this Slack account goes too
      this.db.query('UPDATE slack_link_tokens SET used_at = ? WHERE team_id = ? AND slack_user_id = ? AND used_at IS NULL').run(now, r.team_id, r.slack_user_id)
      if (!same) {
        this.db.query('INSERT INTO slack_links (id, user_id, team_id, enterprise_id, slack_user_id, slack_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(newId(), userId, r.team_id, r.enterprise_id, r.slack_user_id, r.slack_name, now)
        made = true
      }
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

  // ---------------------------------------------------------------- the owner links someone (Slack and app e-mails differ)
  private membersCache: { at: number; teamId: string; members: SlackPerson[]; truncated: boolean } | null = null

  /** The people of the connected workspace (users.list, at most 2,000; a minute in memory), with whom each is linked to. */
  async members(): Promise<SlackMembers> {
    const cfg = this.config(), tk = this.tokens(cfg)
    if (!cfg || !tk || !this.available(cfg)) return { available: false, members: [], truncated: false }
    if (!this.membersCache || this.membersCache.teamId !== cfg.team_id || this.now() - this.membersCache.at > 60_000) {
      const members: SlackPerson[] = []
      let cursor = '', pages = 0
      try {
        do {
          const r = await this.api.call('users.list', tk.bot, { limit: 200, ...(cursor ? { cursor } : {}) })
          for (const u of Array.isArray(r.members) ? r.members : []) { const m = memberOf(u, cfg); if (m?.ours) members.push(m) }
          const next = (r.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor
          cursor = typeof next === 'string' && next.length <= 512 ? next : ''
        } while (cursor && ++pages < 10)
      } catch (e) { throw new SlackError(errorCode(e), 'unavailable') }
      this.membersCache = { at: this.now(), teamId: cfg.team_id!, members, truncated: !!cursor }
    }
    const links = new Map((this.db.query("SELECT l.slack_user_id, u.id, u.name, u.username FROM slack_links l JOIN users u ON u.id = l.user_id WHERE l.team_id = ?").all(cfg.team_id) as { slack_user_id: string; id: string; name: string; username: string }[]).map((l) => [l.slack_user_id, l]))
    return {
      available: true, truncated: this.membersCache.truncated,
      members: this.membersCache.members.map((m) => { const l = links.get(m.id); return { slackUserId: m.id, name: m.name, realName: m.realName, handle: m.handle, email: m.email, linkedTo: l ? { id: l.id, name: l.name, username: l.username } : null } }),
    }
  }

  /** The owner links a Slack person of this workspace to a member (their e-mails differ, so the person cannot). Slack
   * is asked again now; the Slack person gets one DM saying which account it is and how to undo it. */
  async ownerLink(actor: string, slackUserId: string, userId: string): Promise<void> {
    const cfg = this.config(), tk = this.tokens(cfg)
    if (!cfg || !tk || !this.available(cfg)) throw new SlackError('no_tokens', 'conflict')
    const who = this.person(userId) ?? (this.account(userId) ? this.db.query('SELECT id, name, username, role FROM users WHERE id = ?').get(userId) as { id: string; name: string; username: string; role: string } : null)
    if (!who) throw new SlackError('no_member', 'not_found')
    const slack = await this.slackMember(tk.bot, slackUserId, cfg)
    if (!slack) throw new SlackError('unreachable', 'unavailable')
    if (!slack.ours) throw new SlackError('outsider', 'validation')
    const enterprise = cfg.enterprise_id ?? ''
    const now = iso(this.now())
    this.db.transaction(() => {
      if (this.db.query('SELECT 1 FROM slack_links WHERE user_id = ?').get(userId)) throw new SlackError('linked_elsewhere', 'conflict')
      if (this.db.query('SELECT 1 FROM slack_links WHERE team_id = ? AND slack_user_id = ?').get(cfg.team_id, slackUserId)) throw new SlackError('slack_taken', 'conflict')
      this.db.query('UPDATE slack_link_tokens SET used_at = ? WHERE team_id = ? AND slack_user_id = ? AND used_at IS NULL').run(now, cfg.team_id, slackUserId)
      this.db.query('INSERT INTO slack_links (id, user_id, team_id, enterprise_id, slack_user_id, slack_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId(), userId, cfg.team_id, enterprise, slackUserId, slack.name ?? slack.realName ?? slack.handle, now)
    })()
    audit(this.db, { actor, action: 'slack.mapped', target: userId, detail: { slackUser: slackUserId, team: cfg.team_id } })
    // one DM to the Slack person: which account, and how to undo it
    const owner = this.db.query('SELECT name FROM users WHERE id = ?').get(actor) as { name: string } | null
    const locale = this.localeOf(userId)
    try {
      const im = await this.api.call('conversations.open', tk.bot, { users: slackUserId })
      const channel = (im.channel as { id?: unknown } | undefined)?.id
      if (typeof channel === 'string' && ID.test(channel)) await this.api.call('chat.postMessage', tk.bot, { channel, text: say('mapped', locale, { owner: plain(owner?.name ?? ''), name: plain(`${who.name} (@${who.username})`) }) })
    } catch (e) { this.log.warn('slack link notice could not be sent', { reason: e instanceof SlackApiError ? e.code : 'unknown' }) }
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
        await this.question(cfg!, { team: cb.data.team_id, enterprise, user: m.data.user, channel: m.data.channel, kind: 'channel', ts: m.data.ts, threadTs: m.data.thread_ts ?? null, text: m.data.text, userTeam: m.data.user_team ?? null })
      } else if (ev.type === 'message') {
        const m = ImMessage.safeParse(ev)
        if (!m.success || m.data.subtype || m.data.bot_id || m.data.user === cfg!.bot_user_id || !m.data.channel.startsWith('D')) return
        await this.question(cfg!, { team: cb.data.team_id, enterprise, user: m.data.user, channel: m.data.channel, kind: 'im', ts: m.data.ts, threadTs: m.data.thread_ts ?? null, text: m.data.text, userTeam: m.data.user_team ?? null })
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

  private linkOf(team: string, enterprise: string, user: string): LinkRow | null {
    return this.db.query('SELECT * FROM slack_links WHERE team_id = ? AND enterprise_id = ? AND slack_user_id = ?').get(team, enterprise, user) as LinkRow | null
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
    const link = this.linkOf(q.team, q.enterprise, q.user)
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
    this.db.query(`INSERT INTO slack_requests (id, turn_id, user_id, chat_id, message_id, team_id, enterprise_id, channel_id, channel_kind, thread_ts, in_thread, slack_user_id, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`)
      .run(id, started.turnId, who.id, started.assistantMessage.chatId, started.assistantMessage.id, q.team, q.enterprise, q.channel, q.kind, root, q.threadTs ? 1 : 0, q.user, iso(this.now()))
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
      // finished turns first, whatever waits before them
      const done = this.db.query("SELECT r.* FROM slack_requests r JOIN turns t ON t.id = r.turn_id WHERE r.state = 'waiting' AND t.status NOT IN ('queued', 'running') ORDER BY r.created_at LIMIT 20").all() as RequestRow[]
      for (const r of done) await this.deliver(r)
      const open = this.db.query("SELECT r.* FROM slack_requests r LEFT JOIN turns t ON t.id = r.turn_id WHERE r.state = 'waiting' AND (t.status IS NULL OR t.status IN ('queued', 'running')) ORDER BY r.created_at LIMIT 100").all() as RequestRow[]
      for (const r of open) {
        if (Date.parse(r.created_at) < this.now() - ANSWER_WAIT_MS) { await this.giveUp(r); continue }
        if (!r.asked_notice) await this.noticeQuestion(r)
      }
    } catch (e) { this.log.error('slack delivery failed', { err: String(e) }) }
    finally { this.delivering = false }
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
    const link = this.linkOf(r.team_id, r.enterprise_id, r.slack_user_id)
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
      const body = a.ok ? sections(toMrkdwn(a.text), 4) : { blocks: [{ type: 'section' as const, text: { type: 'mrkdwn' as const, text: toMrkdwn(a.text) } }], cut: false }
      const notes = [a.ok && body.cut ? say('more', locale) : '', this.chatLink(cfg, r.chat_id, locale)].filter(Boolean).join('  ')
      const fallback = plain(clip(a.text, 300).text)
      if (r.channel_kind === 'im') {
        // a new message (Slack notifies for it, not for an edit); the "working…" one goes
        const blocks = [...body.blocks, ...(notes ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: notes }] }] : [])]
        await this.api.call('chat.postMessage', tk.bot, { channel: r.channel_id, thread_ts: r.thread_ts, text: fallback, blocks, unfurl_links: false, unfurl_media: false })
        if (r.progress_ts) await this.api.call('chat.delete', tk.bot, { channel: r.channel_id, ts: r.progress_ts }).catch(() => {})
      } else {
        const blocks = [
          ...body.blocks,
          { type: 'context', elements: [{ type: 'mrkdwn', text: [say('onlyYou', locale), notes].filter(Boolean).join('  ') }] },
          ...(a.ok ? [{ type: 'actions', elements: [{ type: 'button', action_id: ACTION_POST, style: 'primary', value: r.id, text: { type: 'plain_text', text: say('post', locale).slice(0, 75) } }] }] : []),
        ]
        await this.api.call('chat.postEphemeral', tk.bot, { channel: r.channel_id, user: r.slack_user_id, ...(r.in_thread ? { thread_ts: r.thread_ts } : {}), text: fallback, blocks })
      }
      if (!a.ok) this.db.query("UPDATE slack_requests SET state = 'failed' WHERE id = ?").run(r.id)
    } catch (e) {
      const code = e instanceof SlackApiError ? e.code : 'unknown'
      // Slack's limit or a network problem: tried again at the next tick; anything else: the answer stays in the chat
      if (code === 'ratelimited' || code === 'unreachable') this.db.query("UPDATE slack_requests SET state = 'waiting', delivered_at = NULL WHERE id = ?").run(r.id)
      else this.db.query("UPDATE slack_requests SET state = 'failed' WHERE id = ?").run(r.id)
      this.log.warn('slack answer could not be delivered', { reason: code })
    }
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
    if (r.state === 'posted') { await reply(say('postedAlready', locale)); return }
    if (r.state !== 'delivered') { await reply(say('postGone', locale)); return }
    if (!this.stillLinked(r)) { await reply(say('notLinked', locale)); return }
    // a chat deleted in the app takes its answer with it
    if (!this.db.query('SELECT 1 FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(r.chat_id, r.user_id)) { await reply(say('postGone', locale)); return }
    const a = this.answerOf(r, locale)
    if (!a.ok) { await reply(say('postGone', locale)); return }
    const link = this.linkOf(r.team_id, r.enterprise_id, r.slack_user_id)!
    const body = sections(toMrkdwn(a.text), 10)
    const asker = link.slack_name ? plain(link.slack_name) : `<@${p.user.id}>`
    const blocks = [{ type: 'context', elements: [{ type: 'mrkdwn', text: say('askedBy', locale, { name: asker }) }] }, ...body.blocks]
    if (!this.db.query("UPDATE slack_requests SET state = 'posted', posted_at = ? WHERE id = ? AND state = 'delivered'").run(iso(this.now()), r.id).changes) { await reply(say('postedAlready', locale)); return }
    try {
      await this.api.call('chat.postMessage', tk.bot, { channel: r.channel_id, thread_ts: r.thread_ts, text: plain(clip(a.text, 300).text), blocks, unfurl_links: false, unfurl_media: false })
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

const instances = new WeakMap<AppContext, SlackConnector>()
/** The connector of this server. `deps` only from offline tests (a fake Slack): it replaces the one made at start,
 * never from HTTP, a file or the environment. */
export function slackOf(ctx: AppContext, deps?: SlackDeps): SlackConnector {
  let s = instances.get(ctx)
  if (!s || deps) { s?.close(); s = new SlackConnector(ctx, deps ?? {}); instances.set(ctx, s) }
  return s
}
