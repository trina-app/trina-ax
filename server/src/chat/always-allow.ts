// "Always allow" on the AI's cards (docs/DECISIONS.md "Always allow on every card"). The owner, 2026-11-13: "항상
// 허용을 눌렀으면 안해야하는거 아니야?" Every permission card offers "Always allow" on its first showing; once a person picks
// it, that kind of card is not raised for them again, until they take it back in Settings › 트리나에게 허용한 것 (GET
// /api/ai-allowances) or an admin turns the team's switch off (TeamSettings.roomAlwaysAllow, on by default; rows are then
// ignored, not deleted). No caps, no "outside content asks again", no expiry.
//
// Per person, never another member's: the row is the turn's own person's, and it counts only in a turn that person
// watches from their own app (web, desktop, phone) or in their own scheduled run (also in a shared chat others wrote
// in), never a Slack question, a company profile draft or a confidential chat. Cards that stay (real security cases)
// never call this: an address that may carry data out, a redirect echo, a scheduled task's card, connect_service.
import type { Database } from 'bun:sqlite'
import crypto from 'node:crypto'
import { CARD_ALWAYS_KINDS, type CardAllowance, type CardAlwaysKind, type Locale, type PictureAllowance, type PictureAlwaysKey } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { getTeamSettings } from '../admin/settings'
import { isConfidentialChat } from '../safe-ops/confidential'
import { ALWAYS_WHAT, tr } from './i18n'

/** The apps a person asks from and watches the answer in. */
export const LIVE_CLIENTS: ReadonlySet<string> = new Set(['web', 'desktop', 'mobile'])

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
  /** told the kind while a card that offers "Always allow" is being raised (null right after): a card that waits after
   * the answer ends keeps it with its call (chat/turn.ts cardLater; docs/decisions/20261122-late-card-answer-resumes.md) */
  offering?: (kind: CardAlwaysKind | null) => void
}

const isKind = (k: string): k is CardAlwaysKind => (CARD_ALWAYS_KINDS as readonly string[]).includes(k)

/** Is "Always allow" on for this person and kind, as it works now (the team's switch on, the account active)? */
export function alwaysOn(db: Database, userId: string, kind: CardAlwaysKind | PictureAlwaysKey): boolean {
  if (!teamAllowsAlways(db)) return false
  return !!db.query("SELECT 1 FROM card_always_allow c JOIN users u ON u.id = c.user_id WHERE c.user_id = ? AND c.kind = ? AND u.status = 'active' AND u.deleted_at IS NULL").get(userId, kind)
}

/** 'on': no card for this kind here; 'offer': the card offers "Always allow"; null: the card as before (nobody is
 * watching, a confidential chat, or the team's switch off). */
export function alwaysHere(p: AlwaysPlace | null | undefined, kind: CardAlwaysKind | PictureAlwaysKey): 'on' | 'offer' | null {
  if (!p || p.restricted) return null
  // a scheduled run (owner 2026-11-14, QA TC-320): nobody is there to answer a card, so only the choice its own person
  // already made counts ('on'); it is never offered, and no one else's choice is used (alwaysOn reads p.userId only)
  const scheduled = p.clientKind === 'schedule'
  if (!scheduled && !LIVE_CLIENTS.has(p.clientKind ?? '')) return null
  if (!teamAllowsAlways(p.db) || isConfidentialChat(p.db, p.chatId)) return null
  // one Always for the person, for good, in every chat and in their scheduled runs: also in a shared chat with a guest
  // among the people and in a run another person's words steer (Rule A; the owner, 2026-11-23: no "Always in this
  // chat", docs/decisions/20261123-one-always-allow.md)
  return alwaysOn(p.db, p.userId, kind) ? 'on' : scheduled ? null : 'offer'
}

/** Keep the person's "Always allow" for this kind (their own answer on a card). Audited. */
export function keepAlways(db: Database, userId: string, kind: CardAlwaysKind | PictureAlwaysKey, turnId: string | null): void {
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

/** A picture's id in Settings: a hash of its key, so a path never goes in the address. */
const pictureId = (key: string) => `picture:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`

/** The pictures this person allowed for good, each named as its card named it (a team path, a chat file's name). A chat
 * file that is gone can never come back under its id: its row is removed here. */
export function listPictureAlways(db: Database, userId: string): PictureAllowance[] {
  const rows = db.query("SELECT kind, created_at FROM card_always_allow WHERE user_id = ? AND substr(kind, 1, 8) = 'picture:' ORDER BY created_at DESC").all(userId) as { kind: string; created_at: string }[]
  const out: PictureAllowance[] = []
  for (const r of rows) {
    const chat = r.kind.startsWith('picture:c:') ? r.kind.slice(10) : null
    const name = chat === null ? r.kind.slice(10) : (db.query('SELECT name FROM chat_files WHERE id = ?').get(chat) as { name: string } | null)?.name
    if (name === undefined) { db.query('DELETE FROM card_always_allow WHERE user_id = ? AND kind = ?').run(userId, r.kind); continue }
    out.push({ kind: 'picture', id: pictureId(r.kind), picture: name, createdAt: r.created_at })
  }
  return out
}

/** Take one picture back by its id; false when it is not this person's or not there. Audited. */
export function dropPictureAlways(db: Database, userId: string, id: string): boolean {
  const rows = db.query("SELECT kind FROM card_always_allow WHERE user_id = ? AND substr(kind, 1, 8) = 'picture:'").all(userId) as { kind: string }[]
  const key = rows.find((r) => pictureId(r.kind) === id)?.kind
  if (!key) return false
  db.query('DELETE FROM card_always_allow WHERE user_id = ? AND kind = ?').run(userId, key)
  audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind: key, on: false, via: 'settings' } })
  return true
}

/** The card for pictures the person did not upload: "Always allow" keeps exactly the pictures this card lists. Not told
 * to `offering`: an Always here never answers another open card, which may list other pictures. */
export async function withPictureAlways(p: AlwaysPlace | null | undefined, keys: readonly PictureAlwaysKey[], options: { label: string; value: string }[], yes: string,
  ask: (options: { label: string; value: string }[], extra: { buttons?: true; note?: string }) => Promise<unknown>): Promise<unknown> {
  if (!p || options.length < 2 || !keys.length || !keys.every((k) => alwaysHere(p, k) !== null)) return ask(options, {})
  const opts = [...options.slice(0, -1), { label: tr('cardAlways', p.locale), value: ALWAYS_VALUE }, options.at(-1)!]
  const answer = await ask(opts, { ...(opts.length === 3 ? { buttons: true as const } : {}), note: tr('cardAlwaysNotePicture', p.locale) })
  const v = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer
  if (v !== ALWAYS_VALUE) return answer
  for (const k of keys) keepAlways(p.db, p.userId, k, p.turnId)
  return yes
}

/** The words of a card's "Always allow" option: the usual, the skill-save card's, the room post card that offers the
 * linked files ("Always send with the files": which of its two yeses it keeps). */
export type AlwaysLabel = 'cardAlways' | 'cardAlwaysSkills'

/** A kind whose "Always allow" risk is said in its own words on the card (the folder cards). */
const KIND_NOTE: Partial<Record<CardAlwaysKind, 'cardAlwaysNoteShareFolder' | 'cardAlwaysNoteFolderAccess' | 'cardAlwaysNotePostFiles' | 'cardAlwaysNoteSaveWider' | 'cardAlwaysNoteMoveFiles' | 'cardAlwaysNotePostToRoom'>> = {
  share_folder: 'cardAlwaysNoteShareFolder', folder_access: 'cardAlwaysNoteFolderAccess',
  // the wider-audience card: a shorter line (docs/decisions/20261122-widening-card-wording.md)
  save_wider: 'cardAlwaysNoteSaveWider',
  // a room post whose Send carries copies of the linked files (chat/post-to-room.ts): what Always allow lets go later
  post_files: 'cardAlwaysNotePostFiles',
  // the move / copy card and the room post card: what Always allow lets go later, not the generic line (QA TC-cards-8)
  move_files: 'cardAlwaysNoteMoveFiles', post_to_room: 'cardAlwaysNotePostToRoom',
}

/** The line under a card's "Always allow" for `kind`: what it covers, in that kind's own words (KIND_NOTE), or the one
 * line with the kind's {what} (ALWAYS_WHAT; QA TC-ask2-15), never a line that does not say which cards stop. */
export function alwaysNote(kind: CardAlwaysKind, L: Locale): string {
  const own = KIND_NOTE[kind]
  if (own) return tr(own, L)
  const what = (ALWAYS_WHAT as Partial<Record<CardAlwaysKind, Record<Locale, string>>>)[kind]
  return what ? tr('cardAlwaysNoteKind', L, { what: what[L] ?? what.en }) : tr('cardAlwaysNote', L)
}

/** For a tool result when the person's own "Always allow" let the call run without its card (QA, integrate/sharing-all
 * final run 2026-11-17: the AI said "You approved the change" though no card was shown). */
export const RAN_UNDER_ALWAYS = 'No card was shown: the user chose "Always allow" for this kind of change earlier, so it ran without asking them. Say so in plain words if it matters (for example "Done. You set Trina to do this without asking; you can change that in Settings › Allowed for Trina."); never say they approved, confirmed or pressed anything this time.'

/** The value a card's "Always allow" answer carries (never one of a card's own values). */
export const ALWAYS_VALUE = '__always'

/**
 * One card with "Always allow": `options` are the card's own (yes first, the no last); `yes` the value that lets the
 * call go on. On already: `yes` at once, no card. Offered: "Always allow" goes in before the last option, and picking it
 * keeps the choice and answers `yes`. Otherwise the card as it was. `ask` raises the card with the options given and
 * returns the raw answer. `label`: the option's words (a card of its own words: the skill-save card's).
 */
export async function withAlways(p: AlwaysPlace | null | undefined, kind: CardAlwaysKind, options: { label: string; value: string }[], yes: string,
  ask: (options: { label: string; value: string }[], extra: { buttons?: true; note?: string }) => Promise<unknown>, label: AlwaysLabel = 'cardAlways'): Promise<unknown> {
  const here = alwaysHere(p, kind)
  if (here === 'on') return yes
  if (here !== 'offer' || options.length < 2) return ask(options, {})
  if (!p) return ask(options, {})
  const opts = [...options.slice(0, -1), { label: tr(label, p.locale), value: ALWAYS_VALUE }, options.at(-1)!]
  // (the kind is told while the card is raised: ask raises it before its first await)
  p.offering?.(kind)
  let pending: Promise<unknown>
  try { pending = ask(opts, { ...(opts.length === 3 ? { buttons: true as const } : {}), note: alwaysNote(kind, p.locale) }) } finally { p.offering?.(null) }
  const answer = await pending
  const v = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer
  if (v === ALWAYS_VALUE) {
    keepAlways(p.db, p.userId, kind, p.turnId)
    return yes
  }
  return answer
}
