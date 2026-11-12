// "Allow all websites" for the AI's web reads (docs/DECISIONS.md "Allow all websites covers the AI's web reads"): a
// person's own switch that lets the address gate (url-gate.ts rule ①d) open ordinary public addresses without the
// address card when that person asks (in chats and rooms). This file keeps the switch and the team's policy epoch.
//
// The switch counts only while (webAllowAll): the row is on, its warning is the current risk sentence
// (WEB_ALLOW_ALL_WARNING_VERSION), its epoch is the team's current policy epoch, the team allows it (browserAllowAll and
// webAllowAll, both on by default) and the account is active. Turning the team policy off raises the epoch in the
// same transaction that turns every row off and audits each person who had it on: a PUT or a card answer reads the
// policy and the epoch and writes its row in one transaction, so a row written under the old policy never counts.
// Only PUT /api/me/web-access (the person, with the risk sentence accepted) and the address card's own answer (the
// person, on a server card) turn it on; no tool writes it.
import type { Database } from 'bun:sqlite'
import { WEB_ALLOW_ALL_WARNING_VERSION } from '@mycel/shared'
import { audit } from '../admin/audit'
import { getSetting, getTeamSettings, setSetting } from '../admin/settings'

/** settings key: how many times the team turned the policy off (rows of an older epoch never count) */
export const WEB_ALL_EPOCH_SETTING = 'web.allowAllEpoch'

export type WebAllOnVia = 'settings' | 'card'
export type WebAllOffVia = 'settings' | 'policy' | 'warning' | 'account'

/** The team lets members turn it on: "Allow all websites" for the desktop's browser and, under it, for web reads. */
export function teamAllowsWebAll(db: Database): boolean {
  const s = getTeamSettings(db)
  return s.browserAllowAll && s.webAllowAll
}

export function policyEpoch(db: Database): number {
  const v = getSetting<unknown>(db, WEB_ALL_EPOCH_SETTING)
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
}

type Row = { allow_all: number; warning: number; epoch: number }
const rowOf = (db: Database, userId: string) => db.query('SELECT allow_all, warning, epoch FROM user_web_access WHERE user_id = ?').get(userId) as Row | null
const active = (db: Database, userId: string) => !!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId)
const offRow = (db: Database, userId: string) => db.query("UPDATE user_web_access SET allow_all = 0, updated_at = ? WHERE user_id = ?").run(new Date().toISOString(), userId)

/** Is the person's switch on as it works now? A row with an older risk sentence is turned off here, once, and audited. */
export function webAllowAll(db: Database, userId: string | null | undefined): boolean {
  if (!userId) return false
  const r = rowOf(db, userId)
  if (!r || !r.allow_all) return false
  if (r.warning !== WEB_ALLOW_ALL_WARNING_VERSION) {
    db.transaction(() => {
      offRow(db, userId)
      audit(db, { actor: null, action: 'web.allow_all_off', target: userId, detail: { via: 'warning' satisfies WebAllOffVia, warningVersion: r.warning, current: WEB_ALLOW_ALL_WARNING_VERSION } })
    })()
    return false
  }
  return r.epoch === policyEpoch(db) && teamAllowsWebAll(db) && active(db, userId)
}

/**
 * Turn the person's switch on or off. On only while the team allows it, read in the same transaction as the write (with
 * the epoch). Returns the switch as it works afterwards. Audited when it changes (`turnId`: the card's answer).
 */
export function setWebAllowAll(db: Database, userId: string, on: boolean, o: { via: WebAllOnVia; turnId?: string | null }): boolean {
  return db.transaction(() => {
    const before = webAllowAll(db, userId)
    if (on) {
      if (!teamAllowsWebAll(db) || !active(db, userId)) return false
      db.query(`INSERT INTO user_web_access (user_id, allow_all, warning, epoch, via, turn_id, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET allow_all = 1, warning = excluded.warning, epoch = excluded.epoch, via = excluded.via, turn_id = excluded.turn_id, updated_at = excluded.updated_at`)
        .run(userId, WEB_ALLOW_ALL_WARNING_VERSION, policyEpoch(db), o.via, o.turnId ?? null, new Date().toISOString())
      if (!before) audit(db, { actor: userId, action: 'web.allow_all_on', target: userId, detail: { via: o.via, warningVersion: WEB_ALLOW_ALL_WARNING_VERSION, ...(o.turnId ? { turnId: o.turnId } : {}) } })
      return true
    }
    const had = rowOf(db, userId)?.allow_all === 1
    if (had) offRow(db, userId)
    if (before) audit(db, { actor: userId, action: 'web.allow_all_off', target: userId, detail: { via: 'settings' satisfies WebAllOffVia } })
    return false
  })()
}

/**
 * The team turned the policy off (browserAllowAll or webAllowAll, Admin › Team settings): one transaction audits each
 * person whose switch was on, turns every row off and raises the epoch. Returns the people to tell.
 */
export function teamPolicyOff(db: Database, actor: string): string[] {
  return db.transaction(() => {
    const epoch = policyEpoch(db)
    const rows = db.query(`SELECT w.user_id, w.warning, w.epoch, u.status = 'active' AND u.deleted_at IS NULL AS live FROM user_web_access w
      JOIN users u ON u.id = w.user_id WHERE w.allow_all = 1`).all() as { user_id: string; warning: number; epoch: number; live: number }[]
    const on: string[] = []
    for (const r of rows) {
      // a row that counted until now: the policy turned it off; one with an older risk sentence: that did (once, here)
      if (r.warning !== WEB_ALLOW_ALL_WARNING_VERSION) audit(db, { actor: null, action: 'web.allow_all_off', target: r.user_id, detail: { via: 'warning' satisfies WebAllOffVia, warningVersion: r.warning, current: WEB_ALLOW_ALL_WARNING_VERSION } })
      else if (r.epoch === epoch && r.live) { on.push(r.user_id); audit(db, { actor, action: 'web.allow_all_off', target: r.user_id, detail: { via: 'policy' satisfies WebAllOffVia } }) }
    }
    db.query('UPDATE user_web_access SET allow_all = 0, updated_at = ? WHERE allow_all = 1').run(new Date().toISOString())
    setSetting(db, WEB_ALL_EPOCH_SETTING, epoch + 1)
    return on
  })()
}

/** An account was deactivated (Admin › Members): its switch goes off, audited when it was on. */
export function accountDeactivated(db: Database, userId: string, actor: string | null) {
  db.transaction(() => {
    const r = rowOf(db, userId)
    if (!r?.allow_all) return
    offRow(db, userId)
    audit(db, { actor, action: 'web.allow_all_off', target: userId, detail: { via: 'account' satisfies WebAllOffVia } })
  })()
}
