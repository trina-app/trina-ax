// "Always allow" on the AI's cards (docs/DECISIONS.md "Always allow on every card"). The owner, 2026-11-13: "항상
// 허용을 눌렀으면 안해야하는거 아니야?" Every permission card offers "Always allow" on its first showing; once a person picks
// it, that kind of card is not raised for them again, until they take it back in Settings › 트리나에게 허용한 것 (GET
// /api/ai-allowances) or an admin turns the team's switch off (TeamSettings.roomAlwaysAllow, on by default; rows are then
// ignored, not deleted). No caps, no "outside content asks again", no expiry.
//
// Per person, never another member's: the row is the turn's own person's, and it counts only in a turn that person
// watches from their own app (web, desktop, phone), never in a scheduled run, a Slack question, a company profile draft
// or a confidential chat. Cards that stay (real security cases) never call this: an address that may carry data out,
// a redirect echo, a dev environment command that uses a login, a scheduled task's card, connect_service.
import type { Database } from 'bun:sqlite'
import { CARD_ALWAYS_KINDS, type CardAllowance, type CardAlwaysKind, type Locale } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { getTeamSettings } from '../admin/settings'
import { isConfidentialChat } from '../safe-ops/confidential'
import { tr } from './i18n'

/** The apps a person asks from and watches the answer in. */
const LIVE_CLIENTS: ReadonlySet<string> = new Set(['web', 'desktop', 'mobile'])

/** The team lets people choose "Always allow" (Admin › Team settings; on unless an admin turns it off). */
export const teamAllowsAlways = (db: Database): boolean => getTeamSettings(db).roomAlwaysAllow !== false

/** Where a card is raised: the turn's own person, their app, the chat. */
export interface AlwaysPlace {
  db: Database
  userId: string
  chatId: string
  turnId: string
  locale: Locale
  clientKind: string | null | undefined
  /** a company profile draft and other restricted turns */
  restricted?: boolean
}

const isKind = (k: string): k is CardAlwaysKind => (CARD_ALWAYS_KINDS as readonly string[]).includes(k)

/** Is "Always allow" on for this person and kind, as it works now (the team's switch on, the account active)? */
export function alwaysOn(db: Database, userId: string, kind: CardAlwaysKind): boolean {
  if (!teamAllowsAlways(db)) return false
  return !!db.query("SELECT 1 FROM card_always_allow c JOIN users u ON u.id = c.user_id WHERE c.user_id = ? AND c.kind = ? AND u.status = 'active' AND u.deleted_at IS NULL").get(userId, kind)
}

/** 'on': no card for this kind here; 'offer': the card offers "Always allow"; null: the card as before (nobody is
 * watching, a confidential chat, or the team's switch off). */
export function alwaysHere(p: AlwaysPlace | null | undefined, kind: CardAlwaysKind): 'on' | 'offer' | null {
  if (!p || p.restricted) return null
  // a scheduled run (owner 2026-11-14, QA TC-320): nobody is there to answer a card, so only the choice its own person
  // already made counts ('on'); it is never offered, and no one else's choice is used (alwaysOn reads p.userId only)
  const scheduled = p.clientKind === 'schedule'
  if (!scheduled && !LIVE_CLIENTS.has(p.clientKind ?? '')) return null
  if (!teamAllowsAlways(p.db) || isConfidentialChat(p.db, p.chatId)) return null
  return alwaysOn(p.db, p.userId, kind) ? 'on' : scheduled ? null : 'offer'
}

/** Keep the person's "Always allow" for this kind (their own answer on a card). Audited. */
export function keepAlways(db: Database, userId: string, kind: CardAlwaysKind, turnId: string | null): void {
  const r = db.query('INSERT INTO card_always_allow (user_id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, kind) DO NOTHING').run(userId, kind, new Date().toISOString())
  if (r.changes) audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind, on: true, via: 'card', turnId } })
}

/** The person's own "Always allow" rows, newest first (Settings › 트리나에게 허용한 것). */
export function listAlways(db: Database, userId: string): CardAllowance[] {
  return (db.query('SELECT kind, created_at FROM card_always_allow WHERE user_id = ? ORDER BY created_at DESC').all(userId) as { kind: string; created_at: string }[])
    .filter((r) => isKind(r.kind)).map((r) => ({ kind: 'card' as const, id: `card:${r.kind}`, card: r.kind as CardAlwaysKind, createdAt: r.created_at }))
}

/** Take one back by its id (`card:<kind>`); false when it is not this person's or not there. Audited. */
export function dropAlways(db: Database, userId: string, id: string): boolean {
  const kind = id.startsWith('card:') ? id.slice(5) : ''
  if (!isKind(kind)) return false
  const n = db.query('DELETE FROM card_always_allow WHERE user_id = ? AND kind = ?').run(userId, kind).changes
  if (n) audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind, on: false, via: 'settings' } })
  return n > 0
}

/** The value a card's "Always allow" answer carries (never one of a card's own values). */
export const ALWAYS_VALUE = '__always'

/**
 * One card with "Always allow": `options` are the card's own (yes first, the no last); `yes` the value that lets the
 * call go on. On already: `yes` at once, no card. Offered: "Always allow" goes in before the last option, and picking it
 * keeps the choice and answers `yes`. Otherwise the card as it was. `ask` raises the card with the options given and
 * returns the raw answer.
 */
export async function withAlways(p: AlwaysPlace | null | undefined, kind: CardAlwaysKind, options: { label: string; value: string }[], yes: string,
  ask: (options: { label: string; value: string }[], extra: { buttons?: true; note?: string }) => Promise<unknown>): Promise<unknown> {
  const here = alwaysHere(p, kind)
  if (here === 'on') return yes
  if (here !== 'offer' || options.length < 2) return ask(options, {})
  if (!p) return ask(options, {})
  const opts = [...options.slice(0, -1), { label: tr('cardAlways', p.locale), value: ALWAYS_VALUE }, options.at(-1)!]
  const answer = await ask(opts, { ...(opts.length === 3 ? { buttons: true as const } : {}), note: tr('cardAlwaysNote', p.locale) })
  const v = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer
  if (v === ALWAYS_VALUE) {
    keepAlways(p.db, p.userId, kind, p.turnId)
    return yes
  }
  return answer
}
