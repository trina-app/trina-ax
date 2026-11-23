// Email into rooms on this server (plan docs/AGENTS/plan/20261123-0421-room-email.md): which addresses the mail service
// takes mail for, the long poll that brings sealed mail here, and each mail as a card in its room.
//
// - Off unless an owner or admin turned on "Let rooms get email" (TeamSettings.roomEmail, off by default) AND the
//   operator gave this server a mail service (MYCEL_MAIL_IN_URL + MYCEL_MAIL_IN_DOMAIN, mail/client.ts).
// - The mail service gets the complete set of address hashes after every change (sync): a new address, "Get a new
//   address", Remove, the switch, a room archived. Turned off: the empty set, so all mail is refused at SMTP.
// - "Get a new address" stops the old one here at once: a mail is posted only when its hash is the app's current
//   token_hash, whatever the mail service still had queued or accepted before the sync reached it.
// - At least once: an item opened and handled is acknowledged with the next poll; a repeat posts nothing (the delivery
//   rows of RoomApps.post: the item id and the mail's own Message-ID).
import type { KeyObject } from 'node:crypto'
import type { RoomAppMail, RoomAppMailAvailability } from '@mycel/shared/api'
import { MAIL_IN_POLL_MAX_WAIT_MS, type MailInItem } from '@mycel/shared/cloud-protocol'
import type { AppContext } from '../../../context'
import { getTeamSettings, teamDefaultLocale } from '../../../admin/settings'
import { credentialsOf } from '../../../credentials/store'
import { loadOrCreateKey } from '../../../relay-client/registration'
import { NOT_HELD_SQL } from '../../project-room'
import { roomAppsOf, teamDay, type AppRow } from '../service'
import { appText } from '../text'
import { MailInClient, MailInError, mailInConfig, openMailItem, sealKeyOf, type MailInOptions } from './client'
import { parseMail } from './parse'

const CONFIRMATION_MS = 7 * 86_400_000

export interface MailInDeps { env?: Record<string, string | undefined>; fetch?: MailInOptions['fetch']; retryMs?: number; waitMs?: number }

const services = new WeakMap<AppContext, MailIn>()
export function mailInOf(ctx: AppContext): MailIn {
  let s = services.get(ctx)
  if (!s) { s = new MailIn(ctx); services.set(ctx, s) }
  return s
}

export class MailIn {
  deps: MailInDeps = {}
  /** the last sync failed (the mail service could not be reached or refused): 'unavailable' on the apps */
  syncFailed = false
  private client_: MailInClient | null = null
  private syncing: Promise<void> | null = null
  private again = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private feed: { stop: () => void; done: Promise<void> } | null = null
  private ack: string[] = []
  constructor(readonly ctx: AppContext) {}

  config() { return mailInConfig(this.deps.env ?? process.env) }
  /** The team turned it on (Admin › Team settings). */
  switchedOn(): boolean { try { return getTeamSettings(this.ctx.db).roomEmail === true } catch { return false } }
  availability(): RoomAppMailAvailability {
    if (!this.config()) return { available: false, reason: 'not_connected' }
    if (!this.switchedOn()) return { available: false, reason: 'off' }
    return { available: true }
  }
  domain(): string | null { return this.config()?.domain ?? null }
  isEmail(row: Pick<AppRow, 'kind' | 'preset'>): boolean { return row.kind === 'other' && row.preset === 'email' }

  /** An Email app's state for the people who manage it. */
  stateOf(row: AppRow & { mail_confirmation?: string | null; mail_synced_hash?: string | null }): RoomAppMail {
    const on = this.availability().available
    const state: RoomAppMail['state'] = !on ? 'unavailable' : row.mail_synced_hash === row.token_hash ? 'ready' : this.syncFailed ? 'unavailable' : 'setting_up'
    let confirmation: RoomAppMail['confirmation']
    try {
      const c = row.mail_confirmation ? JSON.parse(row.mail_confirmation) : null
      if (c && typeof c.at === 'string' && Date.parse(c.at) > Date.now() - CONFIRMATION_MS) confirmation = c
    } catch { confirmation = undefined }
    return { state, ...(confirmation ? { confirmation } : {}) }
  }

  private client(): MailInClient | null {
    const c = this.config()
    if (!c) return null
    if (!this.client_ || this.client_.o.origin !== c.origin) {
      this.client_ = new MailInClient({ origin: c.origin, domain: c.domain, fetch: this.deps.fetch, identity: () => { const { key, publicKey } = loadOrCreateKey(this.ctx.config.dataDir); return { key, publicKey } } })
    }
    return this.client_
  }

  /** The addresses the mail service should take mail for now: every Email app of a room that is not archived, while
   * the team has email on. */
  private wanted(): { id: string; token_hash: string }[] {
    if (!this.availability().available) return []
    return this.ctx.db.query(`SELECT a.id, a.token_hash FROM room_apps a JOIN rooms r ON r.id = a.room_id WHERE a.kind = 'other' AND a.preset = 'email' AND r.archived_at IS NULL AND ${NOT_HELD_SQL('r')}`).all() as { id: string; token_hash: string }[]
  }

  private sealKey(): { privateKey: KeyObject; sealKey: string } { return sealKeyOf(this.ctx.db, credentialsOf(this.ctx).vault) }

  /** Tell the mail service the current set (after a change; also at start). Several changes in a row: one more sync
   * after the running one. Resolves when this round is done (tests await it). */
  sync(): Promise<void> {
    if (this.syncing) { this.again = true; return this.syncing }
    this.syncing = (async () => {
      do {
        this.again = false
        await this.syncOnce()
      } while (this.again)
    })().finally(() => { this.syncing = null; this.startOrStopFeed() })
    return this.syncing
  }

  private async syncOnce() {
    const c = this.client()
    if (!c) return
    const rows = this.wanted()
    try {
      if (rows.length || this.everSynced()) {
        const { sealKey } = this.sealKey()
        const st = await c.status()
        if (st.domain !== c.o.domain) throw new MailInError('domain_mismatch')
        if (st.sealKey !== sealKey) await c.setKey(sealKey)
        await c.sync(rows.map((r) => r.token_hash))
        this.ctx.db.transaction(() => {
          this.ctx.db.query("UPDATE room_apps SET mail_synced_hash = NULL WHERE kind = 'other' AND preset = 'email'").run()
          for (const r of rows) this.ctx.db.query('UPDATE room_apps SET mail_synced_hash = ? WHERE id = ? AND token_hash = ?').run(r.token_hash, r.id, r.token_hash)
        })()
        this.markSynced()
      }
      this.syncFailed = false
      this.failures = 0
    } catch (e) {
      this.syncFailed = true
      this.ctx.log.warn('mail in sync failed', { code: e instanceof MailInError ? e.code : 'error' })
      // try again: 5 s, 10 s, … at most 5 minutes
      if (!this.retry) {
        const wait = Math.min(300_000, (this.deps.retryMs ?? 5000) * 2 ** Math.min(this.failures++, 6))
        this.retry = setTimeout(() => { this.retry = null; void this.sync() }, wait)
        ;(this.retry as { unref?: () => void }).unref?.()
      }
    }
  }
  /** a set was sent once: an empty one must be sent too when the last address goes or the switch goes off */
  private everSynced(): boolean { return !!this.ctx.db.query("SELECT 1 FROM settings WHERE key = 'mailIn.synced'").get() }
  private markSynced() { this.ctx.db.query("INSERT INTO settings (key, value) VALUES ('mailIn.synced', 'true') ON CONFLICT(key) DO NOTHING").run() }

  // ---------------- the long poll ----------------
  private startOrStopFeed() {
    const want = !!this.client() && this.wanted().length > 0
    if (want && !this.feed) this.startFeed()
    else if (!want && this.feed) { this.feed.stop(); this.feed = null }
  }

  private startFeed() {
    const abort = new AbortController()
    let stopped = false
    const done = (async () => {
      let failures = 0
      while (!stopped) {
        const c = this.client()
        if (!c) return
        let answer
        try { answer = await c.poll(this.ack, failures ? 0 : (this.deps.waitMs ?? MAIL_IN_POLL_MAX_WAIT_MS), abort.signal) } catch {
          if (stopped) return
          await new Promise<void>((r) => { const t = setTimeout(r, Math.min(60_000, (this.deps.retryMs ?? 1000) * 2 ** Math.min(failures++, 6))); (t as { unref?: () => void }).unref?.(); abort.signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
          continue
        }
        failures = 0
        this.ack = []
        for (const item of answer.items) {
          try { await this.handle(item) } catch (e) { this.ctx.log.error('mail in item failed', { err: e instanceof Error ? e.name : 'unknown' }) }
          this.ack.push(item.id)
        }
      }
    })()
    this.feed = { stop: () => { stopped = true; abort.abort() }, done }
  }

  /** Stop the poll (the server closes). */
  stop() { this.feed?.stop(); this.feed = null; if (this.retry) clearTimeout(this.retry); this.retry = null }

  /** One mail from the mail service. Never throws for a mail it cannot read: it is dropped (and acknowledged). */
  async handle(item: MailInItem): Promise<'posted' | 'skipped' | 'dropped' | 'confirmation'> {
    const db = this.ctx.db
    if (!this.availability().available) return 'dropped'
    // only the app's CURRENT address: an old one (Get a new address, Remove) posts nothing from that moment
    const row = db.query(`SELECT a.* FROM room_apps a JOIN rooms r ON r.id = a.room_id WHERE a.token_hash = ? AND a.kind = 'other' AND a.preset = 'email' AND r.archived_at IS NULL AND ${NOT_HELD_SQL('r')}`).get(item.hash) as AppRow | null
    if (!row) return 'dropped'
    let opened
    try { opened = openMailItem(item, this.sealKey().privateKey) } catch { return 'dropped' }
    const apps = roomAppsOf(this.ctx)
    const { day } = teamDay(db, apps.clock())
    apps.count(row, 'received', day)
    let locale
    try { locale = teamDefaultLocale(db) } catch { locale = 'en' as const }
    const parsed = await parseMail(opened.raw, { locale, itemId: item.id })
    if (!parsed) { apps.refused(row.id, 'format'); return 'dropped' }
    if (parsed.confirmation) {
      const at = new Date(apps.clock()).toISOString()
      const prev = (db.query('SELECT mail_confirmation FROM room_apps WHERE id = ?').get(row.id) as { mail_confirmation: string | null } | null)?.mail_confirmation
      db.query('UPDATE room_apps SET mail_confirmation = ? WHERE id = ?').run(JSON.stringify({ ...parsed.confirmation, at }), row.id)
      apps.connected(row.id)
      // one quiet line in the room, never the code (it confirms forwarding someone's mail here)
      let samePending = false
      try { samePending = !!prev && JSON.parse(prev).code === parsed.confirmation.code && Date.parse(JSON.parse(prev).at) > apps.clock() - CONFIRMATION_MS } catch { samePending = false }
      if (!samePending) apps.postLine(row, appText('mailConfirmLine', locale, { provider: parsed.confirmation.provider === 'gmail' ? 'Gmail' : parsed.confirmation.provider === 'outlook' ? 'Outlook' : appText('nameEmail', locale) }))
      return 'confirmation'
    }
    const switches = apps.switches(row)
    if (!switches.mail || (parsed.autoReply && !switches.auto_replies)) { apps.count(row, 'skipped', day); return 'skipped' }
    // the app's burst limit and the day's caps, as for a Webhook URL (a mail is not sent again: dropped and counted)
    if (apps.limits.appWait(row.id) !== null) { apps.dropped(row, day); return 'dropped' }
    if (apps.capCheck(row)) { apps.count(row, 'skipped', day); return 'skipped' }
    apps.sawEvent(row, parsed.event.switch)
    const ev = { ...parsed.event, alsoDelivery: `item:${item.id}` }
    return apps.post(row, ev, day) ? 'posted' : 'skipped'
  }
}
