// The in-app browser's one notice in a shared project or shared chat (docs/decisions/20261126-shared-chat-own-tools.md;
// the same notice a connection has since docs/decisions/20261123-shared-connector-warning-once.md): the first time a
// person's AI uses their own browser there, "Other people in this chat can also see what the AI gets from your browser."
// with one button, Continue. Their press is kept per person and place (`p:<project id>` or `c:<chat id>`, tool-allow.ts
// warnPlace) in card_always_allow, whose rows are per person and need no connection (connector_tool_allow, where a
// connection's notice is kept, needs one), so no migration. Settings › Allowed for Trina lists it beside the
// connections' notices and can reset it (the notice then shows again). Not an Always: the team's "Always allow" switch
// does not end it, and listAlways never shows it (its kind is not a card's).
import type { Database } from 'bun:sqlite'
import type { ConnectorToolAllowance, Locale } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { placeName } from '../integrations/connections/tool-allow'
import { tr } from './i18n'

/** the notice's key in a turn (its pending notice and its yes or no in this answer) */
export const BROWSER_NOTICE = '\u0000browser'
/** card_always_allow.kind of a kept notice: this prefix and the place */
const KIND = 'seen:browser:'
const PLACE = /^[pc]:[^\s]{1,200}$/

/** The person went on from the browser's notice in this place (an active account) */
export function browserWarnSeen(db: Database, userId: string, place: string): boolean {
  return !!db.query("SELECT 1 FROM card_always_allow c JOIN users u ON u.id = c.user_id WHERE c.user_id = ? AND c.kind = ? AND u.status = 'active' AND u.deleted_at IS NULL").get(userId, KIND + place)
}

/** Keep that the person went on from it (their own press). Audited. */
export function keepBrowserWarnSeen(db: Database, userId: string, place: string, turnId: string | null): void {
  if (!PLACE.test(place)) return
  const r = db.query('INSERT INTO card_always_allow (user_id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, kind) DO NOTHING').run(userId, KIND + place, new Date().toISOString())
  if (r.changes) audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind: 'browser_warned', place, on: true, via: 'card', turnId } })
}

/** The person's kept browser notices, as Settings lists a connection's (ConnectorToolAllowance with `warned`): id
 * `bseen:<place>` */
export function listBrowserWarned(db: Database, userId: string, locale: Locale): ConnectorToolAllowance[] {
  const rows = db.query('SELECT kind, created_at FROM card_always_allow WHERE user_id = ? AND substr(kind, 1, ?) = ? ORDER BY created_at DESC').all(userId, KIND.length, KIND) as { kind: string; created_at: string }[]
  const name = tr('browserName', locale)
  return rows.map((r) => {
    const place = r.kind.slice(KIND.length)
    return { kind: 'connector_tool' as const, id: `bseen:${place}`, connection: name, tool: '', shared: true as const, warned: placeName(db, place), createdAt: r.created_at }
  })
}

/** Take one back by its id (`bseen:<place>`); false when it is not this person's or not there. Audited. */
export function dropBrowserWarned(db: Database, userId: string, id: string): boolean {
  if (!id.startsWith('bseen:')) return false
  const place = id.slice(6)
  if (!PLACE.test(place)) return false
  const n = db.query('DELETE FROM card_always_allow WHERE user_id = ? AND kind = ?').run(userId, KIND + place).changes
  if (n) audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind: 'browser_warned', place, on: false, via: 'settings' } })
  return n > 0
}
