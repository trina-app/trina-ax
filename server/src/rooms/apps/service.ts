// Apps posting in rooms (docs/DECISIONS.md "Apps posting in rooms", plan docs/AGENTS/plan/20261114-0900-room-apps.md):
// the rows, who may manage them, and how an event becomes a message in the room. The public address is in inbound.ts.
//
// Who manages a room's apps (owner decisions 4 and 5): in a team room and the everyone room its owners and admins who
// are in it (a member gets 403); in a 1:1 or a group chat any of its members (there are no admins there). Anyone not
// in the room gets 404, as for every room route (Rooms.mine), whatever their role. An app belongs to its room: the
// person who added it may leave, it goes on.
//
// An app's message is a room message (room_messages, author NULL, app_id set): everyone who sees the room sees it
// (canSee; people who join a team room later too: rooms/history.ts never hides one), it counts as unread and alerts by
// the room's level like any message (never a mention: mentions '[]'), and a reply in its thread notifies who replied
// there. Quiet ones (app_quiet) count nowhere: no unread, no notice, not the rooms list's line, no activity bump.
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import {
  AI_OWN_NAMES, DEFAULT_LOCALE, ROOM_APP_DAILY_CAP, ROOM_APP_DEFAULT_NAMES, ROOM_APP_EXAMPLES_PER_HOUR, ROOM_APP_PRESET_NAMES, ROOM_APP_PRESET_SIGNING, ROOM_APP_PRESET_SWITCHES,
  ROOM_APP_SECRET_RE, ROOM_APP_SWITCHES, ROOM_APP_TEAM_DAILY_CAP, ROOM_APPS_MAX, ROOM_APPS_PER_HOUR, roomAppDefaults, SENTRY_SECRET_RE, ZENDESK_TEST_SECRET,
  type CreateRoomAppBody, type Locale, type RoomApp, type RoomAppAddress, type RoomAppCreated, type RoomAppKind, type RoomAppList, type RoomAppRefusal,
  type RoomAppSecretResult, type SetRoomAppSecretBody, type UpdateRoomAppBody,
} from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared/product'
import type { AppContext } from '../../context'
import { newId, nowIso } from '../../db'
import { fail } from '../../http/errors'
import { audit } from '../../admin/audit'
import { teamDefaultLocale, teamTimeZone } from '../../admin/settings'
import { credentialsOf } from '../../credentials/store'
import type { Vault } from '../../credentials/vault'
import { teamAddressOf } from '../../system/connection'
import { zonedDay, zonedParts, zonedToUtc } from '../../system/time-zone'
import { notificationsOf } from '../../notifications/service'
import { roomsOf } from '../service'
import { mayManageApps, messageRow, roomAuditRef, threadable, type MessageRow, type RoomRow } from '../store'
import { bodyOf, cleanCard, line, type StoredCard } from './card'
import { AppLimits } from './limits'
import type { AppEvent } from './parse'
import { presetOf } from './presets'
import { appText } from './text'

const TOKEN_KIND = 'room_app_token'
const SECRET_KIND = 'room_app_secret'
const HOUR = 3_600_000
const DAY = 86_400_000
/** a thing's thread is used this long after its last event; then the next event starts a new card */
const THREAD_DAYS = 30
/** deliveries are remembered this long (a vendor's retry within it posts once) */
const DELIVERY_DAYS = 7
const DAYS_KEPT = 30
const THREADS_KEPT_DAYS = 90
/** a refusal is written to the status line at most this often */
const REFUSAL_EVERY_MS = 60_000

export interface AppRow {
  id: string; room_id: string; kind: RoomAppKind; preset: string | null; name: string; token_hash: string; token_enc: string; secret_enc: string | null; key_version: number
  events: string; alert_seen: number; quiet: number; created_by: string | null; created_at: string; updated_at: string
  paused_until: string | null; resumed_on: string | null; first_ok_at: string | null; last_ok_at: string | null; last_refusal_at: string | null; last_refusal: string | null
}

export const sha256 = (s: string | Uint8Array) => crypto.createHash('sha256').update(s).digest('hex')
const newToken = () => `tax_in_${crypto.randomBytes(32).toString('base64url')}`
const newSecret = () => `tax_whs_${crypto.randomBytes(32).toString('base64url')}`
/** Latin lookalikes of Cyrillic and Greek letters (the common confusables), for comparing names */
const LOOKALIKE: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', г: 'r',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w', ζ: 'z',
}
/** a name as compared with people's: Unicode compatibility form, case, spaces, invisible marks and lookalike letters
 * (also 0/1 for o/l) do not count */
export const skeleton = (s: string) => [...s.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{Cf}\p{M}._\-·]+/gu, '')]
  .map((c) => LOOKALIKE[c] ?? (c === '0' ? 'o' : c === '1' ? 'l' : c)).join('')
/** Latin mixed with Cyrillic or Greek in one name: a lookalike, refused */
const mixedScripts = (s: string) => {
  const latin = /\p{Script=Latin}/u.test(s), cyr = /\p{Script=Cyrillic}/u.test(s), greek = /\p{Script=Greek}/u.test(s)
  return [latin, cyr, greek].filter(Boolean).length > 1
}
/** the AI's own names and the product's, as skeletons */
const aiNames = () => [...AI_OWN_NAMES, PRODUCT.displayName, PRODUCT.shortName].map(skeleton).filter((x) => x.length >= 2)

/** The team's day now, and the instant its next day starts (midnight in the team's time zone). */
export function teamDay(db: Database, now: number): { day: string; next: string } {
  const tz = teamTimeZone(db)
  const p = zonedParts(new Date(now), tz)
  return { day: zonedDay(new Date(now), tz), next: zonedToUtc(p.y, p.m, p.d + 1, 0, 0, tz).toISOString() }
}

export { mayManageApps }

/** The source of a "someone who left knows the address" notice for the app's current address (room_app_leaver_notices,
 * migration 352): one per person and address; a new address starts over. */
export const leaverSource = (row: Pick<AppRow, 'id' | 'token_hash'>) => `${row.id}.${row.token_hash.slice(0, 12)}`
const likePrefix = (id: string) => `${id.replace(/[\\%_]/g, (c) => `\\${c}`)}.%`

const services = new WeakMap<AppContext, RoomApps>()
export function roomAppsOf(ctx: AppContext): RoomApps {
  let s = services.get(ctx)
  if (!s) { s = new RoomApps(ctx); services.set(ctx, s) }
  return s
}

export class RoomApps {
  /** the clock (tests move it) */
  clock: () => number = () => Date.now()
  readonly limits = new AppLimits(() => this.clock())
  private added = new Map<string, number[]>()
  private examples = new Map<string, number[]>()
  constructor(readonly ctx: AppContext) {}
  private get db(): Database { return this.ctx.db }
  private get vault(): Vault { return credentialsOf(this.ctx).vault }

  // ---------------- addresses and secrets ----------------
  /** Where services reach this server: its team address when that is https (the relay, or its own public host). */
  base(): string | null {
    const a = teamAddressOf(this.ctx)
    if (!a) return null
    try { const u = new URL(a); return u.protocol === 'https:' ? u.origin : null } catch { return null }
  }
  /** The address, for `viewer` (who is recorded as someone who knows it: room_app_viewers). */
  addressOf(row: AppRow, viewer: string): string {
    const base = this.base()
    if (!base) return fail('conflict', appText('noAddress', this.locale()), { params: { reason: 'no_public_address' } })
    const address = `${base}/in/${this.tokenOf(row)}`
    this.saw(row.id, viewer)
    return address
  }
  private saw(appId: string, userId: string) {
    this.db.query('INSERT INTO room_app_viewers (app_id, user_id, at) VALUES (?, ?, ?) ON CONFLICT(app_id, user_id) DO UPDATE SET at = excluded.at').run(appId, userId, nowIso())
  }
  /** Someone who was shown the address (or a secret Trina made) can no longer manage the app: they left the room or the
   * team, or an admin of a team room became a member. The status line says so until "Get a new address". */
  leaverKnows(row: Pick<AppRow, 'id' | 'room_id'>): boolean {
    const room = this.db.query('SELECT kind FROM rooms WHERE id = ?').get(row.room_id) as Pick<RoomRow, 'kind'> | null
    if (!room) return true
    const viewers = this.db.query(`SELECT v.user_id, EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = ? AND m.user_id = v.user_id) inroom,
      EXISTS (SELECT 1 FROM users u WHERE u.id = v.user_id AND u.status = 'active' AND u.deleted_at IS NULL) active FROM room_app_viewers v WHERE v.app_id = ?`).all(row.room_id, row.id) as { user_id: string; inroom: number; active: number }[]
    return viewers.some((v) => !v.inroom || !v.active || !mayManageApps(this.db, room, v.user_id))
  }
  /** Tells the people who may manage an app that someone who left knows its address (Activity, 'room_app.leaver'), for
   * every app with viewers whose leaverKnows holds now. It does not hang on one code path (a room left, a member taken
   * out, a team left, an admin made a member, an account disabled or deleted): the 5-minute and hourly ticks run it
   * (routes/room-apps.ts). Idempotent: one notice per person and address (the table's UNIQUE). Returns how many apps had
   * a leaver. */
  leaverSweep(): number {
    const rows = this.db.query(`SELECT a.* FROM room_apps a JOIN rooms r ON r.id = a.room_id AND r.archived_at IS NULL
      WHERE EXISTS (SELECT 1 FROM room_app_viewers v WHERE v.app_id = a.id)`).all() as AppRow[]
    const n = notificationsOf(this.ctx)
    let found = 0
    for (const row of rows) {
      try {
        if (!this.leaverKnows(row)) continue
        found++
        const room = this.db.query('SELECT * FROM rooms WHERE id = ?').get(row.room_id) as RoomRow | null
        if (!room) continue
        const members = (this.db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(room.id) as { user_id: string }[]).map((m) => m.user_id)
        for (const u of members) if (mayManageApps(this.db, room, u)) n.roomAppLeaver(u, leaverSource(row))
      } catch (e) { this.ctx.log.warn('room app leaver notice failed', { err: e }) }
    }
    return found
  }
  tokenOf(row: AppRow): string {
    try { return (this.vault.decrypt(row.id, TOKEN_KIND, row.token_enc, row.key_version) as { token: string }).token } catch {
      // the key file it was sealed with is gone: only a new address helps (the status line says so)
      return fail('conflict', undefined, { params: { reason: 'address_unreadable' } })
    }
  }
  /** The app's secret (null: none) and whether Trina made it; a secret that does not decrypt counts as one that is set
   * but never matches (requests are refused until it is set again). */
  secretOf(row: AppRow): { secret: string; made: boolean } | null | 'broken' {
    if (!row.secret_enc) return null
    try { const v = this.vault.decrypt(row.id, SECRET_KIND, row.secret_enc, row.key_version) as { secret: string; made?: boolean }; return { secret: v.secret, made: !!v.made } } catch { return 'broken' }
  }
  /** The token and secret sealed under the vault's current key (both together: they share key_version). */
  private seal(id: string, token: string, secret: { secret: string; made: boolean } | null) {
    const t = this.vault.encrypt(id, TOKEN_KIND, { token })
    const s = secret ? this.vault.encrypt(id, SECRET_KIND, secret) : null
    return { token_hash: sha256(token), token_enc: t.enc, secret_enc: s?.enc ?? null, key_version: t.keyVersion }
  }

  // ---------------- reading ----------------
  private locale(): Locale { try { return teamDefaultLocale(this.db) } catch { return DEFAULT_LOCALE } }
  row(id: string): AppRow | null { return this.db.query('SELECT * FROM room_apps WHERE id = ?').get(id) as AppRow | null }
  /** The app's preset when this build knows it (an unknown one: none here; inbound.ts refuses its requests). */
  presetOf(row: Pick<AppRow, 'kind' | 'preset'>) {
    const p = row.kind === 'other' ? presetOf(row.preset) : null
    return p === 'unknown' ? null : p
  }
  switches(row: Pick<AppRow, 'kind' | 'events' | 'preset'>): Record<string, boolean> {
    let saved: Record<string, unknown> = {}
    try { saved = JSON.parse(row.events) as Record<string, unknown> } catch { saved = {} }
    const out = roomAppDefaults(row.kind, this.presetOf(row))
    for (const k of Object.keys(out)) if (typeof saved[k] === 'boolean') out[k] = saved[k] as boolean
    return out
  }
  private shownToday(appId: string, day: string): number {
    return (this.db.query('SELECT shown FROM room_app_days WHERE app_id = ? AND day = ?').get(appId, day) as { shown: number } | null)?.shown ?? 0
  }
  /** The day as the app's cap counts it: its own row and those of removed apps of the same kind in the same room (a
   * removed and added again app keeps its day), and whether "Resume now" was used on any of them that day. */
  private capDay(row: Pick<AppRow, 'id' | 'room_id' | 'kind'>, day: string): { shown: number; resumed: boolean } {
    const r = this.db.query(`SELECT COALESCE(SUM(shown), 0) shown, COALESCE(MAX(resumed), 0) resumed FROM room_app_days d WHERE d.day = ?
      AND (d.app_id = ? OR (d.room_id = ? AND d.kind = ? AND NOT EXISTS (SELECT 1 FROM room_apps a WHERE a.id = d.app_id)))`).get(day, row.id, row.room_id, row.kind) as { shown: number; resumed: number }
    return { shown: r.shown, resumed: !!r.resumed }
  }
  teamShownToday(day: string): number {
    return (this.db.query('SELECT COALESCE(SUM(shown), 0) n FROM room_app_days WHERE day = ?').get(day) as { n: number }).n
  }
  out(row: AppRow): RoomApp {
    const now = this.clock()
    const { day } = teamDay(this.db, now)
    const by = row.created_by ? this.db.query('SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL').get(row.created_by) as { id: string; name: string } | null : null
    const paused = row.paused_until && Date.parse(row.paused_until) > now ? row.paused_until : null
    const reason = row.last_refusal as RoomAppRefusal | null
    const preset = this.presetOf(row)
    return {
      id: row.id, roomId: row.room_id, kind: row.kind, ...(preset ? { preset } : {}), name: row.name, events: this.switches(row), quiet: !!row.quiet, signed: !!row.secret_enc,
      createdBy: by ? { id: by.id, name: by.name } : null, createdAt: row.created_at, firstOkAt: row.first_ok_at, lastOkAt: row.last_ok_at,
      lastRefusal: row.last_refusal_at && reason ? { at: row.last_refusal_at, reason } : null,
      pausedUntil: paused, canResume: !!paused && !this.capDay(row, day).resumed && this.teamShownToday(day) < ROOM_APP_TEAM_DAILY_CAP,
      ...(this.leaverKnows(row) ? { leaverKnows: true as const } : {}),
      today: this.shownToday(row.id, day),
    }
  }

  // ---------------- access ----------------
  /** The room (I am in it: else 404) and that I may manage its apps (else 403). */
  private managed(userId: string, roomId: string): RoomRow {
    const { room } = roomsOf(this.ctx).mine(userId, roomId)
    if (!mayManageApps(this.db, room, userId)) fail('forbidden')
    return room
  }
  /** One app of a room I manage; another room's app answers like one that is not there. */
  private mine(userId: string, roomId: string, appId: string): { room: RoomRow; row: AppRow } {
    const room = this.managed(userId, roomId)
    const row = this.row(appId)
    if (!row || row.room_id !== room.id) return fail('not_found')
    return { room, row }
  }

  // ---------------- managing ----------------
  list(userId: string, roomId: string): RoomAppList {
    const room = this.managed(userId, roomId)
    const rows = this.db.query('SELECT * FROM room_apps WHERE room_id = ? ORDER BY created_at, id').all(room.id) as AppRow[]
    return { items: rows.map((r) => this.out(r)), available: this.base() !== null, max: ROOM_APPS_MAX }
  }

  /** A name an app may take: not a person's in this team, nor one that looks like it (lookalike letters, mixed
   * scripts), nor the AI's or the product's (a card must never pass for a teammate or for Trina). */
  private checkName(name: string, locale: Locale) {
    const k = skeleton(name)
    const people = this.db.query('SELECT name, username FROM users').all() as { name: string; username: string }[]
    const bad = mixedScripts(name) || people.some((p) => skeleton(p.name) === k || skeleton(p.username) === k) || aiNames().some((a) => k.includes(a))
    if (bad) fail('validation', appText('nameIsPerson', locale), { fields: { 'body.name': 'the name of a person in this team, the AI\'s, or one that looks like it' } })
  }

  create(userId: string, roomId: string, b: CreateRoomAppBody, locale: Locale): RoomAppCreated {
    const room = this.managed(userId, roomId)
    if (this.base() === null) fail('conflict', appText('noAddress', locale), { params: { reason: 'no_public_address' } })
    // a name the person gave, else the kind's in the team's language (Google Forms and Other; Sentry and GitHub are names)
    const L = this.locale()
    // a preset only for Other (it is fixed from here on: a different service is a new app)
    if (b.preset && b.kind !== 'other') fail('validation', appText('presetNotForKind', locale), { fields: { 'body.preset': 'only with kind other' } })
    const preset = b.preset ?? null
    const name = line(b.name ?? (preset ? ROOM_APP_PRESET_NAMES[preset] : b.kind === 'google_forms' ? appText('nameForms', L) : b.kind === 'other' ? appText('nameOther', L) : ROOM_APP_DEFAULT_NAMES[b.kind]), 40)
    this.checkName(name, locale)
    const n = (this.db.query('SELECT COUNT(*) n FROM room_apps WHERE room_id = ?').get(room.id) as { n: number }).n
    if (n >= ROOM_APPS_MAX) fail('conflict', appText('full', locale, { max: ROOM_APPS_MAX }), { params: { reason: 'room_apps_full' } })
    this.takeHourly(this.added, userId, ROOM_APPS_PER_HOUR)
    const id = newId(), now = nowIso(), token = newToken()
    const s = this.seal(id, token, null)
    this.db.transaction(() => {
      this.db.query(`INSERT INTO room_apps (id, room_id, kind, preset, name, token_hash, token_enc, secret_enc, key_version, events, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run(id, room.id, b.kind, preset, name, s.token_hash, s.token_enc, s.key_version, JSON.stringify(roomAppDefaults(b.kind, preset)), userId, now, now)
      audit(this.db, { actor: userId, action: 'room_app.add', target: id, detail: { ...roomAuditRef(room), kind: b.kind, ...(preset ? { preset } : {}) } })
    })()
    const row = this.row(id)!
    return { app: this.out(row), address: this.addressOf(row, userId) }
  }

  address(userId: string, roomId: string, appId: string): RoomAppAddress {
    const { row } = this.mine(userId, roomId, appId)
    const s = this.secretOf(row)
    return { address: this.addressOf(row, userId), ...(s && s !== 'broken' && s.made ? { secret: s.secret } : {}) }
  }

  update(userId: string, roomId: string, appId: string, b: UpdateRoomAppBody, locale: Locale): RoomApp {
    const { room, row } = this.mine(userId, roomId, appId)
    const changed: string[] = []
    let events = this.switches(row)
    if (b.events) {
      const p = this.presetOf(row)
      const known = new Set<string>((p ? ROOM_APP_PRESET_SWITCHES[p] : ROOM_APP_SWITCHES[row.kind]).map((s) => s.key))
      for (const k of Object.keys(b.events)) if (!known.has(k)) fail('validation', undefined, { fields: { [`body.events.${k}`]: 'not a switch of this app' } })
      events = { ...events, ...b.events }
      changed.push('events')
    }
    const name = b.name !== undefined ? line(b.name, 40) : row.name
    if (b.name !== undefined && name !== row.name) { this.checkName(name, locale); changed.push('name') }
    if (b.quiet !== undefined && b.quiet !== !!row.quiet) changed.push('quiet')
    const quiet = b.quiet ?? !!row.quiet
    this.db.transaction(() => {
      this.db.query('UPDATE room_apps SET events = ?, name = ?, quiet = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(events), name, quiet ? 1 : 0, nowIso(), row.id)
      if (changed.length) audit(this.db, { actor: userId, action: 'room_app.update', target: row.id, detail: { ...roomAuditRef(room), changed } })
    })()
    return this.out(this.row(row.id)!)
  }

  setSecret(userId: string, roomId: string, appId: string, b: SetRoomAppSecretBody, locale: Locale): RoomAppSecretResult {
    const { room, row } = this.mine(userId, roomId, appId)
    // which services can sign: GitHub and Sentry, and the presets whose service signs (an unknown preset: none here)
    const unknownPreset = row.kind === 'other' && presetOf(row.preset) === 'unknown'
    const preset = this.presetOf(row)
    const signing = preset ? ROOM_APP_PRESET_SIGNING[preset] : null
    const canSign = row.kind === 'github' || row.kind === 'sentry' || (!!signing && signing.signing !== 'none')
    if (!canSign || unknownPreset) fail('validation', appText('noSecretForKind', locale), { fields: { body: 'this app takes no secret' }, params: { reason: 'no_signing' } })
    let secret: { secret: string; made: boolean } | null
    if ('generate' in b) {
      // a secret Trina makes is for a service with a field to paste it in (GitHub, Typeform, Tally); Stripe, Shopify and
      // Zendesk make their own, so one made here could never match
      if (signing?.signing === 'paste' || row.kind === 'sentry') fail('validation', undefined, { fields: { 'body.generate': 'this service makes its own secret: paste it' } })
      secret = { secret: newSecret(), made: true }
    } else if (b.secret === null || b.secret === '') secret = null
    else {
      // what the person pasted: Sentry's Client Secret, a service's signing secret, or (GitHub) a secret they chose there
      const v = b.secret.trim()
      if (row.kind === 'sentry' && !SENTRY_SECRET_RE.test(v)) fail('validation', appText('sentrySecretShape', locale), { fields: { 'body.secret': 'not a Sentry Client Secret' } })
      if (preset && signing?.signing === 'paste' && signing.shape && !signing.shape.test(v)) fail('validation', appText('presetSecretShape', locale, { app: ROOM_APP_PRESET_NAMES[preset] }), { fields: { 'body.secret': `not a ${ROOM_APP_PRESET_NAMES[preset]} signing secret` } })
      if (preset === 'zendesk' && v === ZENDESK_TEST_SECRET) fail('validation', appText('zendeskTestSecret', locale), { fields: { 'body.secret': "Zendesk's public test secret" } })
      if (v.length > 200 || /[^\x21-\x7e]/.test(v)) fail('validation', undefined, { fields: { 'body.secret': 'printable characters only' } })
      if (v.length < 16 || /\s/.test(v)) fail('validation', undefined, { fields: { 'body.secret': 'at least 16 characters, no spaces' } })
      secret = { secret: v, made: ROOM_APP_SECRET_RE.test(v) }
    }
    const token = this.tokenOf(row)
    const s = this.seal(row.id, token, secret)
    this.db.transaction(() => {
      this.db.query('UPDATE room_apps SET token_enc = ?, secret_enc = ?, key_version = ?, updated_at = ? WHERE id = ?').run(s.token_enc, s.secret_enc, s.key_version, nowIso(), row.id)
      audit(this.db, { actor: userId, action: 'room_app.secret', target: row.id, detail: { ...roomAuditRef(room), set: !!secret } })
    })()
    if (secret?.made) this.saw(row.id, userId)
    return { app: this.out(this.row(row.id)!), ...(secret?.made ? { secret: secret.secret } : {}) }
  }

  rotate(userId: string, roomId: string, appId: string): RoomAppCreated {
    const { room, row } = this.mine(userId, roomId, appId)
    if (this.base() === null) fail('conflict', appText('noAddress', this.locale()), { params: { reason: 'no_public_address' } })
    const prev = this.secretOf(row)
    // a secret that no longer opens must not turn into "no secret": set it again first
    if (prev === 'broken') return fail('conflict', undefined, { params: { reason: 'secret_unreadable' } })
    const s = this.seal(row.id, newToken(), prev)
    this.db.transaction(() => {
      this.db.query('UPDATE room_apps SET token_hash = ?, token_enc = ?, secret_enc = ?, key_version = ?, updated_at = ? WHERE id = ?').run(s.token_hash, s.token_enc, s.secret_enc, s.key_version, nowIso(), row.id)
      audit(this.db, { actor: userId, action: 'room_app.rotate', target: row.id, detail: roomAuditRef(room) })
    })()
    this.limits.forget(row.id)
    // a new address: only the person who got it knows it now
    this.db.query('DELETE FROM room_app_viewers WHERE app_id = ?').run(row.id)
    // the "someone who left knows the address" notices of the old address are settled (a later leaver of the new one
    // makes new ones: their source is the new address's)
    const read = this.db.query("UPDATE room_app_leaver_notices SET read_at = ? WHERE source_id LIKE ? ESCAPE '\\' AND read_at IS NULL RETURNING user_id").all(nowIso(), likePrefix(row.id)) as { user_id: string }[]
    for (const u of new Set(read.map((r) => r.user_id))) this.signal(u)
    const now = this.row(row.id)!
    const address = this.addressOf(now, userId)
    return { app: this.out(now), address }
  }

  remove(userId: string, roomId: string, appId: string): void {
    const { room, row } = this.mine(userId, roomId, appId)
    this.db.transaction(() => {
      this.db.query('DELETE FROM room_apps WHERE id = ?').run(row.id)
      // its paused and leaver notices go with it (a notice of an app that is gone opens nothing)
      this.db.query("DELETE FROM room_app_notices WHERE source_id LIKE ? ESCAPE '\\'").run(likePrefix(row.id))
      this.db.query("DELETE FROM room_app_leaver_notices WHERE source_id LIKE ? ESCAPE '\\'").run(likePrefix(row.id))
      audit(this.db, { actor: userId, action: 'room_app.remove', target: row.id, detail: { ...roomAuditRef(room), kind: row.kind, ...(row.preset ? { preset: row.preset } : {}) } })
    })()
    this.limits.forget(row.id)
  }

  resume(userId: string, roomId: string, appId: string, locale: Locale): RoomApp {
    const { room, row } = this.mine(userId, roomId, appId)
    const now = this.clock()
    const { day } = teamDay(this.db, now)
    if (!row.paused_until || Date.parse(row.paused_until) <= now) fail('conflict', appText('notPaused', locale), { params: { reason: 'not_paused' } })
    if (row.resumed_on === day || this.capDay(row, day).resumed) fail('conflict', appText('alreadyResumed', locale), { params: { reason: 'already_resumed' } })
    if (this.teamShownToday(day) >= ROOM_APP_TEAM_DAILY_CAP) fail('conflict', appText('teamCap', locale, { cap: ROOM_APP_TEAM_DAILY_CAP }), { params: { reason: 'team_cap' } })
    this.db.transaction(() => {
      this.db.query('UPDATE room_apps SET paused_until = NULL, resumed_on = ?, updated_at = ? WHERE id = ?').run(day, nowIso(), row.id)
      this.db.query(`INSERT INTO room_app_days (app_id, day, room_id, kind, resumed) VALUES (?, ?, ?, ?, 1) ON CONFLICT(app_id, day) DO UPDATE SET resumed = 1`).run(row.id, day, row.room_id, row.kind)
      audit(this.db, { actor: userId, action: 'room_app.resume', target: row.id, detail: roomAuditRef(room) })
    })()
    // the room is told who turned it back on (a quiet line from the app); the paused notices are settled
    const who = (this.db.query('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | null)?.name ?? appText('someone', this.locale())
    this.postLine(this.row(row.id)!, appText('resumedLine', this.locale(), { name: line(who, 80), app: row.name }))
    const read = this.db.query('UPDATE room_app_notices SET read_at = ? WHERE source_id = ? AND read_at IS NULL RETURNING user_id').all(nowIso(), `${row.id}.${day}`) as { user_id: string }[]
    for (const r of read) this.signal(r.user_id)
    return this.out(this.row(row.id)!)
  }

  example(userId: string, roomId: string, appId: string): void {
    const { row } = this.mine(userId, roomId, appId)
    this.takeHourly(this.examples, row.id, ROOM_APP_EXAMPLES_PER_HOUR)
    const L = this.locale()
    const card = cleanCard({ kind: appText('example', L), title: appText('exampleTitle', L, { app: row.name }), details: [], status: undefined })
    this.insert(row, { card, quiet: true, example: true })
  }

  private takeHourly(m: Map<string, number[]>, key: string, max: number) {
    const now = this.clock()
    const recent = (m.get(key) ?? []).filter((t) => now - t < HOUR)
    if (recent.length >= max) fail('rate_limited', undefined, { retryAfter: Math.max(1, Math.ceil((recent[0]! + HOUR - now) / 1000)) })
    recent.push(now)
    m.set(key, recent)
  }

  private signal(userId: string) {
    try { this.ctx.services.realtime.publish(userId, { type: 'notice', data: { level: 'info', code: 'notifications.changed', message: '' } }) } catch { /* nothing to tell */ }
  }

  /** A message an app deleted by someone who manages it (Rooms.remove asks; audited there). */
  mayDeleteMessage(room: RoomRow, userId: string): boolean { return mayManageApps(this.db, room, userId) }

  // ---------------- counters and status ----------------
  count(row: Pick<AppRow, 'id' | 'room_id' | 'kind'>, field: 'received' | 'shown' | 'skipped' | 'dropped', day: string, by = 1): number {
    return (this.db.query(`INSERT INTO room_app_days (app_id, day, room_id, kind, ${field}) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_id, day) DO UPDATE SET ${field} = ${field} + excluded.${field} RETURNING ${field} AS n`).get(row.id, day, row.room_id, row.kind, by) as { n: number }).n
  }
  /** A request the limits turned away: counted in memory and written at most once a minute per app (a flood must not
   * write a row per request). */
  private drops = new Map<string, { row: Pick<AppRow, 'id' | 'room_id' | 'kind'>; day: string; n: number; at: number }>()
  dropped(row: Pick<AppRow, 'id' | 'room_id' | 'kind'>, day: string) {
    const now = this.clock()
    const d = this.drops.get(row.id)
    if (d && d.day === day) d.n++
    else { if (d) this.flushOne(d); this.drops.set(row.id, { row, day, n: 1, at: d?.at ?? 0 }) }
    const cur = this.drops.get(row.id)!
    if (now - cur.at >= 60_000) { this.flushOne(cur); cur.at = now }
  }
  private flushOne(d: { row: Pick<AppRow, 'id' | 'room_id' | 'kind'>; day: string; n: number }) {
    if (d.n <= 0) return
    try { this.count(d.row, 'dropped', d.day, d.n) } catch (e) { this.ctx.log.warn('room app drop count failed', { err: e }) }
    d.n = 0
  }
  /** Writes what the drop counters hold (the hourly tick, tests). */
  flushDrops() { for (const d of this.drops.values()) this.flushOne(d); this.drops.clear() }
  refused(appId: string, reason: RoomAppRefusal) {
    const now = this.clock()
    this.db.query('UPDATE room_apps SET last_refusal = ?, last_refusal_at = ? WHERE id = ? AND (last_refusal_at IS NULL OR last_refusal_at < ?)').run(reason, new Date(now).toISOString(), appId, new Date(now - REFUSAL_EVERY_MS).toISOString())
  }
  connected(appId: string) {
    const at = new Date(this.clock()).toISOString()
    this.db.query('UPDATE room_apps SET last_ok_at = ?, first_ok_at = COALESCE(first_ok_at, ?) WHERE id = ?').run(at, at, appId)
  }
  /** Sentry's first alert: its "Alert fired" switch turns on by itself, once (alert_seen). */
  alertSeen(row: AppRow): AppRow {
    if (row.alert_seen) return row
    const events = { ...this.switches(row), alert: true }
    this.db.query('UPDATE room_apps SET alert_seen = 1, events = ? WHERE id = ? AND alert_seen = 0').run(JSON.stringify(events), row.id)
    return this.row(row.id) ?? row
  }

  /** The day's caps before a message is shown: null to go on, else when the pause ends (the app is paused now, or was
   * already). Reaching a cap pauses the app until the team's midnight: a quiet line in the room, one notice to each
   * person who manages it (and the person who added it, while they are in the room), an audit row. */
  capCheck(row: AppRow): string | null {
    const now = this.clock()
    if (row.paused_until && Date.parse(row.paused_until) > now) return row.paused_until
    const { day, next } = teamDay(this.db, now)
    const c = this.capDay(row, day)
    const own = c.shown >= ROOM_APP_DAILY_CAP * (c.resumed || row.resumed_on === day ? 2 : 1)
    const team = this.teamShownToday(day) >= ROOM_APP_TEAM_DAILY_CAP
    if (!own && !team) return null
    const paused = this.db.query('UPDATE room_apps SET paused_until = ? WHERE id = ? AND (paused_until IS NULL OR paused_until <= ?)').run(next, row.id, new Date(now).toISOString()).changes > 0
    if (paused) this.paused(this.row(row.id) ?? row, day, team && !own)
    return next
  }
  private paused(row: AppRow, day: string, team: boolean) {
    const cap = team ? ROOM_APP_TEAM_DAILY_CAP : ROOM_APP_DAILY_CAP
    const room = this.db.query('SELECT * FROM rooms WHERE id = ?').get(row.room_id) as RoomRow | null
    if (!room) return
    audit(this.db, { actor: null, action: 'room_app.paused', target: row.id, detail: { ...roomAuditRef(room), cap, team } })
    try { this.postLine(row, appText('pausedLine', this.locale(), { app: row.name, cap })) } catch (e) { this.ctx.log.warn('room app paused line failed', { err: e }) }
    // who is told: the people in the room who manage it, and the person who added it while they are in it
    const members = (this.db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(room.id) as { user_id: string }[]).map((m) => m.user_id)
    const to = members.filter((u) => u === row.created_by || mayManageApps(this.db, room, u))
    const n = notificationsOf(this.ctx)
    for (const u of to) { try { n.roomAppPaused(u, `${row.id}.${day}`) } catch (e) { this.ctx.log.warn('room app paused notice failed', { err: e }) } }
  }

  // ---------------- posting ----------------
  /** A quiet line from the app (the paused and resumed lines): no unread, no notice, not counted. */
  postLine(row: AppRow, text: string) {
    this.insert(row, { card: cleanCard({ title: text }), quiet: true })
  }

  /** Post an event (inbound.ts, after the checks): one transaction writes the delivery row (a delivery seen already
   * posts nothing: false), finds the thing's thread, writes the card (or its reply) and the root's new status, and
   * counts it; the room hears of it after. */
  post(row: AppRow, ev: AppEvent, day: string): boolean {
    const db = this.db, now = this.clock(), at = new Date(now).toISOString()
    const dh = sha256(ev.delivery)
    const dh2 = ev.alsoDelivery ? sha256(ev.alsoDelivery) : null
    const keyHash = ev.key ? sha256(ev.key) : null
    let out: { id: string | null; root: MessageRow | null; rootChanged: boolean } | null = null
    db.transaction(() => {
      const window = now - (ev.deliveryMinutes ? ev.deliveryMinutes * 60_000 : DELIVERY_DAYS * DAY)
      for (const h of [dh, dh2]) {
        if (!h) continue
        const prior = db.query('SELECT at FROM room_app_deliveries WHERE app_id = ? AND delivery_hash = ?').get(row.id, h) as { at: string } | null
        if (prior && Date.parse(prior.at) > window) return
      }
      for (const h of [dh, dh2]) if (h) db.query('INSERT OR REPLACE INTO room_app_deliveries (app_id, delivery_hash, at) VALUES (?, ?, ?)').run(row.id, h, at)
      let root: MessageRow | null = null
      let thread: { root_id: string; state: string | null; last_at: string } | null = null
      if (keyHash) {
        const t = db.query('SELECT root_id, state, last_at FROM room_app_threads WHERE app_id = ? AND key_hash = ?').get(row.id, keyHash) as { root_id: string; state: string | null; last_at: string } | null
        thread = t
        const keep = ev.keyMinutes ? ev.keyMinutes * 60_000 : THREAD_DAYS * DAY
        if (t && Date.parse(t.last_at) > now - keep) {
          const r = messageRow(db, row.room_id, t.root_id)
          if (r && !r.deleted_at && threadable(r)) root = r
        }
      }
      let rootChanged = false
      let id: string | null
      if (root) {
        const reply = ev.reply ?? { title: ev.card.title, details: ev.card.details?.slice(0, 1) }
        const card = cleanCard({ title: reply.title, details: reply.details ?? [], link: ev.card.link, unverified: reply.unverified })
        // `onlyStatus`: no reply, the root's status line below is the whole change
        // `backFrom`: shown in the room too when the thing was in one of those states (a solved ticket opened again)
        const back = !!ev.back || (!!ev.backFrom && !!thread!.state && !!ev.state && ev.backFrom.includes(thread!.state) && !ev.backFrom.includes(ev.state))
        id = ev.onlyStatus ? null : this.insert(row, { card, root, alsoInRoom: back, quiet: !!row.quiet, at })
        // the root's status line follows the thing's state
        if (ev.status && ev.state && ev.state !== thread!.state) {
          const stored = JSON.parse(root.app_card ?? '{}') as StoredCard
          if (stored && typeof stored.title === 'string' && stored.status !== ev.status) {
            const next: StoredCard = { ...stored, status: line(ev.status) }
            db.query('UPDATE room_messages SET app_card = ?, body = ? WHERE id = ?').run(JSON.stringify(next), bodyOf(next.app.name, cleanCard({ ...next, link: next.link?.url })), root.id)
            rootChanged = true
          }
        }
        db.query('UPDATE room_app_threads SET last_at = ?, state = COALESCE(?, state) WHERE app_id = ? AND key_hash = ?').run(at, ev.state ?? null, row.id, keyHash)
      } else {
        id = this.insert(row, { card: cleanCard(ev.card), quiet: !!row.quiet, at, extra: ev.extra })
        if (keyHash) db.query('INSERT OR REPLACE INTO room_app_threads (app_id, key_hash, root_id, state, last_at) VALUES (?, ?, ?, ?, ?)').run(row.id, keyHash, id, ev.state ?? null, at)
      }
      // a status-only change is no new message: not counted toward the cap
      if (id) this.count(row, 'shown', day)
      db.query('UPDATE room_apps SET last_ok_at = ?, first_ok_at = COALESCE(first_ok_at, ?) WHERE id = ?').run(at, at, row.id)
      out = { id, root, rootChanged }
    })()
    if (!out) return false
    const o = out as { id: string | null; root: MessageRow | null; rootChanged: boolean }
    // nothing changed at all (the second event of one payment, its status the same): counted as skipped
    if (!o.id && !o.rootChanged) return false
    // after the answer (the sender waits for it: Sentry gives a second)
    setImmediate(() => this.after(row.room_id, o.id, o.root, o.rootChanged))
    return true
  }

  /** Writes the message (inside the caller's transaction when there is one) and returns its id; outside one, the room
   * hears of it at once. */
  private insert(row: AppRow, o: { card: ReturnType<typeof cleanCard>; root?: MessageRow | null; alsoInRoom?: boolean; quiet?: boolean; example?: boolean; at?: string; extra?: string }): string {
    const db = this.db, id = newId(), at = o.at ?? new Date(this.clock()).toISOString()
    const inTimeline = !o.root || !!o.alsoInRoom
    const preset = this.presetOf(row)
    const stored: StoredCard = { ...o.card, app: { name: row.name, kind: row.kind, ...(preset ? { preset } : {}) }, ...(o.example ? { example: true as const } : {}) }
    const write = () => {
      // a quiet message does not bring the room to the top of the list
      const bump = inTimeline && !o.quiet
      const seq = (db.query(`UPDATE rooms SET last_seq = last_seq + 1${bump ? ', activity_at = ?' : ''} WHERE id = ? RETURNING last_seq`).get(...(bump ? [at, row.room_id] : [row.room_id])) as { last_seq: number }).last_seq
      db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, thread_root_id, thread_root_seq, also_in_room, mentions_all, app_id, app_card, app_quiet)
        VALUES (?, ?, ?, 'user', NULL, 'room', ?, '[]', ?, ?, ?, ?, 0, ?, ?, ?)`).run(id, row.room_id, seq, bodyOf(row.name, o.card, o.extra), at, o.root?.id ?? null, o.root?.seq ?? null, o.root && o.alsoInRoom ? 1 : 0,
        row.id, JSON.stringify(stored), o.quiet ? 1 : 0)
    }
    if (db.inTransaction) write()
    else { db.transaction(write)(); this.after(row.room_id, id, null, false) }
    return id
  }

  /** After the answer: the message to the members who see it (and its notices), the thread's summary, the root's new
   * status. Never throws: the message is posted. */
  private after(roomId: string, id: string | null, root: MessageRow | null, rootChanged: boolean) {
    try {
      const rooms = roomsOf(this.ctx)
      // id null: only the root's status line changed (no new message, nobody notified)
      const msg = id ? messageRow(this.db, roomId, id) : null
      if (id && !msg) return
      if (msg) rooms.messageEvent('room.message', msg, rooms.notify(msg))
      if (root) {
        const r = messageRow(this.db, roomId, root.id)
        if (r && rootChanged) rooms.messageEvent('room.message.updated', r)
        if (r && msg) rooms.afterReply(r)
      }
    } catch (e) { this.ctx.log.warn('room app message not sent out', { err: e }) }
  }

  // ---------------- upkeep ----------------
  /** Old deliveries, day counters and threads go (the hourly tick; the paused notices age out with the Inbox). */
  prune(now = this.clock()) {
    this.flushDrops()
    const iso = (ms: number) => new Date(now - ms).toISOString()
    const day = (n: number) => new Date(now - n * DAY).toISOString().slice(0, 10)
    this.db.query('DELETE FROM room_app_deliveries WHERE at < ?').run(iso(DELIVERY_DAYS * DAY))
    this.db.query('DELETE FROM room_app_days WHERE day < ?').run(day(DAYS_KEPT))
    this.db.query('DELETE FROM room_app_threads WHERE last_at < ?').run(iso(THREADS_KEPT_DAYS * DAY))
  }
}

/** credentials/rekey.ts: every app's token and secret sealed again under the new key (`write` inside its transaction).
 * `versions`: the key versions rows that did not decrypt still need (their files are kept). */
export function rekeyRoomApps(db: Database, from: Vault, next: Vault): { versions: number[]; write: () => void } {
  const rows = db.query('SELECT id, token_enc, secret_enc, key_version FROM room_apps').all() as Pick<AppRow, 'id' | 'token_enc' | 'secret_enc' | 'key_version'>[]
  const versions: number[] = []
  const writes: { id: string; token: string; secret: string | null; v: number }[] = []
  for (const r of rows) {
    try {
      const token = from.decrypt(r.id, TOKEN_KIND, r.token_enc, r.key_version)
      const secret = r.secret_enc ? from.decrypt(r.id, SECRET_KIND, r.secret_enc, r.key_version) : null
      const t = next.encrypt(r.id, TOKEN_KIND, token)
      writes.push({ id: r.id, token: t.enc, secret: secret ? next.encrypt(r.id, SECRET_KIND, secret).enc : null, v: t.keyVersion })
    } catch { versions.push(r.key_version) }
  }
  return {
    versions,
    write: () => { for (const w of writes) db.query('UPDATE room_apps SET token_enc = ?, secret_enc = ?, key_version = ? WHERE id = ?').run(w.token, w.secret, w.v, w.id) },
  }
}
