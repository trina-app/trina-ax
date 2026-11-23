// The floor of "do it, then offer undo" (docs/decisions/20261123-do-then-undo.md): a send whose recipient and content the
// person named goes without its card, unless it would show people content they could not see whose source the person
// did not name (floor 2). Decided here once, from the server's own provenance of what goes (chat/answer-share.ts), for
// the AI's post_to_room and for the app's "Send to a conversation" (the confirm's `direct`).
//
// Safe sources (narrowed 2026-11-23 by the owner: the floor is ONLY content from someone else's private place the person
// did not name): the person's own folder (a share of it too) and what their own browser or connection showed them; a
// chat the person is in (the AI's work there is theirs); a team-folder place when every file of it that counts is one
// the person named, made here or may share themselves. Anything else some recipient cannot see asks: a room, a 1:1 or
// group chat of others, Slack, a team connection, a Drive file shared with them, another person's folder, a team file
// they may not share, anything not known (a room read without saying which, an answer off the branch, no place).
import type { CountedSource } from './answer-share'
import { approvalsFor } from './card-approvals'

/** What of a provenance (answer-share.ts Prov) the floor reads */
export interface FloorProv { unknown: boolean; hidden: boolean; otherPlaces: boolean; keys: readonly string[]; counted?: readonly CountedSource[] }

/** True when nothing in `prov` is floor 2 for `userId`. `named(rel)`: a team-folder file the person named, attached or
 * the AI made in this answer. Fails closed. */
export function floorFree(prov: FloorProv, userId: string, named: (rel: string) => boolean = () => false, approved: ReadonlySet<string> = new Set(), mine: (chatId: string) => boolean = () => false, ownProjectFolder: string | null = null): boolean {
  const counted = prov.counted ?? []
  if (prov.unknown || prov.hidden || prov.otherPlaces) return false
  // a key that is no counted source (rooms read without saying which, 'unknown'): not known, so it asks
  if (prov.keys.length !== counted.length) return false
  return counted.every((c) => {
    // a source the person already said yes to sending, on a card in this chat (post_sources: one card per source)
    if (approved.has(c.key)) return true
    const s = c.source
    // the person's own things: their folder (a share of it too), what their browser or own connection showed them
    // (the owner, 2026-11-23: the floor is only someone ELSE's private place)
    if (s.type === 'user') return s.id === userId
    // a chat the person is in: the AI's work in their own chat is their own work (QA F5: the file it made there)
    if (s.type === 'chat') return mine(s.id)
    // a team folder: each file that counts is one the person named, made here or may share themselves
    // (the project folder of the project chat this is sent from: the person's work with their project, as a whole)
    if (s.type === 'folder') return (!!ownProjectFolder && s.id === ownProjectFolder) || (c.files.size > 0 && [...c.files].every(named))
    return false
  })
}

/** `approved` for floorFree: the sources the person sent on a card in this chat (12 h, card-approvals.ts post_sources),
 * only those whose card showed them to everyone `audience` holds (a new place's people all saw it then: security review,
 * so one yes never widens to new people) */
export function approvedSources(db: import('bun:sqlite').Database, chatId: string, userId: string, audience: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const d of approvalsFor(db, { chatId, userId, kind: 'post_sources', target: '' })) {
    const seen = new Set(Array.isArray(d.people) ? d.people.filter((x): x is string => typeof x === 'string') : [])
    if (!audience.every((id) => seen.has(id))) continue
    for (const k of Array.isArray(d.keys) ? d.keys : []) if (typeof k === 'string') out.add(k)
  }
  return out
}

/** A team path in the person's own personal folder (any spelling of users/: a case-insensitive disk). */
export function inOwnFolder(rel: string, userId: string): boolean {
  const segs = rel.normalize('NFC').replace(/^\/+/, '').split('/')
  return segs.length > 2 && segs[0]!.toLowerCase() === 'users' && segs[1] === userId
}

/** A run of a scheduled task made without its card (schedules.quiet, tools/schedules.ts askedInOwnWords): it sends,
 * posts and shares nothing, whatever the person's Always says. Fails closed (an unreadable row counts as quiet). */
export function quietRun(db: import('bun:sqlite').Database, turnId: string | null | undefined): boolean {
  if (!turnId) return false
  try {
    const r = db.query('SELECT s.quiet AS q FROM turns t JOIN schedules s ON s.id = t.schedule_id WHERE t.id = ?').get(turnId) as { q: number } | null
    return !!r?.q
  } catch { return true }
}

/**
 * A chat of the person's that never took in anything another person wrote, in any session (security review of
 * 34deea9c0): its own marks (others_words, rooms_seen, room_outside), every turn of it with no outside content (a turn's
 * mark survives a new session), no side chat of a room, no quoted room message on the answer's branch, nobody else wrote
 * in it. Its answers are then the person's own work also where the read scope cannot list every source. Fails closed.
 */
export function ownWorkChat(db: import('bun:sqlite').Database, chatId: string, userId: string, answerId: string | null, quotes: (db: import('bun:sqlite').Database, answerId: string) => boolean): boolean {
  try {
    const ch = db.query('SELECT user_id, others_words, rooms_seen, room_outside, side_room_id FROM chats WHERE id = ?').get(chatId) as { user_id: string; others_words: number; rooms_seen: number | null; room_outside: number; side_room_id: string | null } | null
    if (!ch || ch.user_id !== userId || ch.others_words || ch.rooms_seen || ch.room_outside || ch.side_room_id) return false
    if (db.query('SELECT 1 FROM turns WHERE chat_id = ? AND outside_content <> 0 LIMIT 1').get(chatId)) return false
    if (db.query("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'user' AND author_id IS NOT NULL AND author_id <> ? LIMIT 1").get(chatId, userId)) return false
    if (answerId && quotes(db, answerId)) return false
    return true
  } catch { return false }
}
