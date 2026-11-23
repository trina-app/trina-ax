// The floor of "do it, then offer undo" (docs/decisions/20261123-do-then-undo.md): a send whose recipient and content the
// person named goes without its card, unless it would show people content they could not see whose source the person
// did not name (floor 2). Decided here once, from the server's own provenance of what goes (chat/answer-share.ts), for
// the AI's post_to_room and for the app's "Send to a conversation" (the confirm's `direct`).
//
// Safe sources, and only these: files in the person's own personal folder (no share of it, never what came in through
// the in-app browser or a connected service: those read as "my files" on the card, but they can be a mailbox or a
// logged-in page), and a team-folder place when every file of it that counts is one the person named, attached or the
// AI made in this answer. Anything else some recipient cannot see asks: a room, a 1:1 or group chat, a connected
// service, a file shared with the person, the browser, a team folder file nobody named, anything not known (a room read
// without saying which, an answer off the branch, a source with no place).
import type { CountedSource } from './answer-share'
import { approvalsFor } from './card-approvals'

/** What of a provenance (answer-share.ts Prov) the floor reads */
export interface FloorProv { unknown: boolean; hidden: boolean; otherPlaces: boolean; keys: readonly string[]; counted?: readonly CountedSource[] }

/** True when nothing in `prov` is floor 2 for `userId`. `named(rel)`: a team-folder file the person named, attached or
 * the AI made in this answer. Fails closed. */
export function floorFree(prov: FloorProv, userId: string, named: (rel: string) => boolean = () => false, approved: ReadonlySet<string> = new Set()): boolean {
  const counted = prov.counted ?? []
  if (prov.unknown || prov.hidden || prov.otherPlaces) return false
  // a key that is no counted source (rooms read without saying which, 'unknown'): not known, so it asks
  if (prov.keys.length !== counted.length) return false
  return counted.every((c) => {
    // a source the person already said yes to sending, on a card in this chat (post_sources: one card per source)
    if (approved.has(c.key)) return true
    const s = c.source
    if (s.type === 'user') return s.id === userId && !s.via && !s.share
    if (s.type === 'folder') return c.files.size > 0 && [...c.files].every(named)
    return false
  })
}

/** `approved` for floorFree: the sources the person sent on a card in this chat (12 h, card-approvals.ts post_sources) */
export function approvedSources(db: import('bun:sqlite').Database, chatId: string, userId: string): Set<string> {
  const out = new Set<string>()
  for (const d of approvalsFor(db, { chatId, userId, kind: 'post_sources', target: '' })) for (const k of Array.isArray(d.keys) ? d.keys : []) if (typeof k === 'string') out.add(k)
  return out
}

/** A team path in the person's own personal folder (any spelling of users/: a case-insensitive disk). */
export function inOwnFolder(rel: string, userId: string): boolean {
  const segs = rel.normalize('NFC').replace(/^\/+/, '').split('/')
  return segs.length > 2 && segs[0]!.toLowerCase() === 'users' && segs[1] === userId
}
