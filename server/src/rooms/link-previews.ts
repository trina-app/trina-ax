// Message links and their previews (docs/DECISIONS.md "Message links and their previews", plan
// docs/AGENTS/plan/20261114-1705-message-link-previews.md). A person's message that holds the address of another room
// message ("Copy link": /rooms/<room>?m=<message>, a reply /rooms/<room>/t/<root>?m=<reply>) shows that message as a card,
// decided here for each viewer on every read (messagesOut, so the timeline, threads, the window around a message and the
// live events all get the same answer):
//   - live: the viewer may see the original now (a member of its room, not archived, the DM still open to them, canSee:
//     from where they see the room, not a hidden old answer or in its thread, not a private preview, not an event line).
//     Its place is named as they name it (roomNaming), never stored.
//   - a snapshot: the sender chose "Show message" when they sent it (snapshotsAtSend, only the web app's send), built here
//     from the original with the sender's own access at that moment; only a person's own message (never an AI answer, an
//     app's card or a shared answer). Shown to a viewer who cannot see the original, marked who shared it.
//   - nothing: no entry at all, the same for a message they may not see, one that is not there and another team's link
//     (no way to learn that a conversation or a message exists).
// The sender's "Remove preview" (hidden) takes a card away for everyone. Push, the rooms list's line, search and every
// AI read the typed text only: none of them reads link_previews.
import type { Database } from 'bun:sqlite'
import { linkCount, MESSAGE_LINK_PREVIEWS_MAX, MESSAGE_LINK_TEXT_MAX, parseMessageLinks, type MessageLinkRef, type RoomKind, type RoomLinkPreview, type UserRef } from '@mycel/shared/api'
import { dmPairOk } from './guest-reach'
import { appRefsOf, canSee, MSG_COLS, openableFor, parseMentions, pathCheckFor, refsOf, roomNaming, sharedAnswerOf, type MemberRow, type MessageRow, type RoomRow } from './store'

/** A card's text: at most MESSAGE_LINK_TEXT_MAX characters, never half an emoji at the cut. */
const clipText = (s: string) => (s.length <= MESSAGE_LINK_TEXT_MAX ? s : s.slice(0, MESSAGE_LINK_TEXT_MAX).replace(/[\ud800-\udbff]$/, ''))
/** At most this many linked messages are looked at for one read (a page of 50 messages × 5 links stays bounded). */
const LINKED_PER_READ = 100

/** A snapshot as room_messages.link_previews keeps it: ids and words, never names (read when shown) nor file ids. */
export interface StoredSnapshot {
  roomId: string; messageId: string; rootId: string | null
  kind: RoomKind
  /** a team room's (or the everyone room's own) name as the sender saw it; null for a DM, a group chat and the everyone room */
  name: string | null
  authorId: string | null
  createdAt: string
  body: string
  mentions: string[]
  files: { count: number; first?: { name: string; kind: string } }
  /** the original was deleted since: its words are gone */
  deleted?: boolean
}
export interface StoredLinkPreviews { hidden?: string[]; snapshots?: StoredSnapshot[] }

export function readStored(s: string | null | undefined): StoredLinkPreviews {
  if (!s) return {}
  try {
    const v = JSON.parse(s) as StoredLinkPreviews
    return {
      hidden: Array.isArray(v?.hidden) ? v.hidden.filter((x): x is string => typeof x === 'string') : [],
      snapshots: Array.isArray(v?.snapshots) ? v.snapshots.filter((x) => x && typeof x.messageId === 'string' && typeof x.body === 'string') : [],
    }
  } catch { return {} }
}
export const writeStored = (v: StoredLinkPreviews): string | null => (v.hidden?.length || v.snapshots?.length ? JSON.stringify({ ...(v.hidden?.length ? { hidden: v.hidden } : {}), ...(v.snapshots?.length ? { snapshots: v.snapshots } : {}) }) : null)

/** The part of a message whose links count: a person's own words (a shared answer's note, not the AI's answer). App
 * cards, AI answers, event lines and deleted messages link to nothing. */
function linkText(r: MessageRow): string {
  if (r.event || r.deleted_at || r.author_kind !== 'user' || r.app_card) return ''
  const shared = sharedAnswerOf(r)
  return shared ? r.body.slice(0, shared.at) : r.body
}
/** The message links of a message that may get a card: none with more than MESSAGE_LINK_PREVIEWS_MAX links of any kind
 * (Slack's rule), else the first MESSAGE_LINK_PREVIEWS_MAX different messages. */
export function cardLinks(text: string): MessageLinkRef[] {
  if (!text || linkCount(text) > MESSAGE_LINK_PREVIEWS_MAX) return []
  return parseMessageLinks(text).slice(0, MESSAGE_LINK_PREVIEWS_MAX)
}

/** What one read shares between its viewers (a live event goes to every member): the linked rows, their rooms, files,
 * people and apps, read once. Only what each viewer may see differs (per viewer: their member rows, canSee). */
export interface LinkPrep {
  links: Map<string, MessageLinkRef[]>
  /** messages with more links than MESSAGE_LINK_PREVIEWS_MAX: chips only, no card (Slack's rule) */
  chipsOnly: Set<string>
  stored: Map<string, StoredLinkPreviews>
  originals: Map<string, MessageRow>
  rooms: Map<string, RoomRow>
  files: Map<string, { count: number; first?: { name: string; kind: string } }>
  people: Map<string, UserRef>
  apps: ReturnType<typeof appRefsOf>
  /** whether each linked DM is still open to its two (guests: rooms/guest-reach.ts dmPairOk), worked out once per read:
   * it does not depend on who reads */
  dmOk: Map<string, boolean>
}

export function prepareLinkPreviews(db: Database, rows: readonly MessageRow[]): LinkPrep | null {
  const links = new Map<string, MessageLinkRef[]>()
  const chipsOnly = new Set<string>()
  const stored = new Map<string, StoredLinkPreviews>()
  const ids = new Set<string>()
  for (const r of rows) {
    const text = linkText(r)
    let l = cardLinks(text)
    // more links than a card is drawn for: the message links still read as chips (their place), with no card
    if (!l.length && text.includes('/rooms/')) {
      l = parseMessageLinks(text).slice(0, MESSAGE_LINK_PREVIEWS_MAX)
      if (l.length) chipsOnly.add(r.id)
    }
    if (!l.length) continue
    const kept: MessageLinkRef[] = []
    for (const x of l) {
      if (!ids.has(x.messageId) && ids.size >= LINKED_PER_READ) continue
      ids.add(x.messageId)
      kept.push(x)
    }
    if (!kept.length) continue
    links.set(r.id, kept)
    const s = readStored((r as MessageRow & { link_previews?: string | null }).link_previews)
    if (s.hidden?.length || s.snapshots?.length) stored.set(r.id, s)
  }
  if (!links.size) return null
  const want = [...ids]
  const originals = new Map((db.query(`SELECT ${MSG_COLS} FROM room_messages WHERE id IN (${want.map(() => '?').join(',')})`).all(...want) as MessageRow[]).map((m) => [m.id, m]))
  const roomIds = [...new Set([...originals.values()].map((m) => m.room_id))]
  const rooms = new Map(roomIds.length ? (db.query(`SELECT * FROM rooms WHERE id IN (${roomIds.map(() => '?').join(',')})`).all(...roomIds) as RoomRow[]).map((r) => [r.id, r]) : [])
  const files = new Map<string, { count: number; first?: { name: string; kind: string } }>()
  const live = [...originals.values()].filter((m) => !m.deleted_at && !m.event)
  if (live.length) {
    for (const f of db.query(`SELECT message_id, name, kind FROM room_files WHERE message_id IN (${live.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...live.map((m) => m.id)) as { message_id: string; name: string; kind: string }[]) {
      const x = files.get(f.message_id)
      if (x) x.count++
      else files.set(f.message_id, { count: 1, first: { name: f.name, kind: f.kind } })
    }
  }
  const snapshotPeople = [...stored.values()].flatMap((s) => (s.snapshots ?? []).map((x) => x.authorId))
  const senders = rows.filter((r) => stored.get(r.id)?.snapshots?.length).map((r) => r.author_id)
  const people = refsOf(db, [...[...originals.values()].flatMap((m) => [m.author_id]), ...snapshotPeople, ...senders])
  return { links, chipsOnly, stored, originals, rooms, files, people, apps: appRefsOf(db, live), dmOk: new Map() }
}

/** The viewer's member rows of the linked rooms (with has_hidden), one query. */
function viewerRows(db: Database, prep: LinkPrep, userId: string): Map<string, MemberRow> {
  if (!userId || !prep.rooms.size) return new Map()
  const ids = [...prep.rooms.keys()]
  return new Map((db.query(`SELECT m.*, EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = m.user_id) has_hidden
    FROM room_members m WHERE m.user_id = ? AND m.room_id IN (${ids.map(() => '?').join(',')})`).all(userId, ...ids) as MemberRow[]).map((m) => [m.room_id, m]))
}

/** May this member (their row of its room) see the linked message: the room not archived, a DM still open to them,
 * canSee, the link's room (and thread) its own. The same rule as reading the room (Rooms.mine), message by message. */
/** `dmOk`: the DM's pair check already made for this read (one per room, whoever reads). */
export function seesLinked(db: Database, link: Pick<MessageLinkRef, 'roomId' | 'rootId'>, m: MessageRow | undefined, room: RoomRow | undefined, member: MemberRow | undefined, dmOk?: Map<string, boolean>): boolean {
  if (!m || !room || !member || m.room_id !== link.roomId || room.archived_at || m.event) return false
  if (link.rootId && m.thread_root_id !== link.rootId) return false
  let ok = dmOk?.get(room.id)
  if (ok === undefined) {
    ok = dmPairOk(db, room.kind, room.dm_key)
    dmOk?.set(room.id, ok)
  }
  if (!ok) return false
  return canSee(db, m, member)
}

/** The previews of each message of `rows` (by id) for `viewer`; messages with none are not in it. */
export function linkPreviewsFor(db: Database, prep: LinkPrep | null, rows: readonly MessageRow[], viewer: Pick<MemberRow, 'user_id'>): Map<string, RoomLinkPreview[]> {
  const out = new Map<string, RoomLinkPreview[]>()
  if (!prep) return out
  const mine = viewerRows(db, prep, viewer.user_id)
  const naming = new Map<string, ReturnType<typeof roomNaming>>()
  const nameOf = (room: RoomRow) => naming.get(room.id) ?? naming.set(room.id, roomNaming(db, room, viewer.user_id)).get(room.id)!
  let opens: ((rel: string) => boolean) | undefined | null = null
  for (const r of rows) {
    const links = prep.links.get(r.id)
    if (!links) continue
    const stored = prep.stored.get(r.id)
    const chipsOnly = prep.chipsOnly.has(r.id)
    const hidden = new Set(stored?.hidden ?? [])
    const list: RoomLinkPreview[] = []
    for (const link of links) {
      const m = prep.originals.get(link.messageId)
      const room = m ? prep.rooms.get(m.room_id) : undefined
      const sees = !!m && seesLinked(db, link, m, room, mine.get(m.room_id), prep.dmOk)
      // the sender removed its card, or the message has too many links for cards: a chip still for who sees the
      // original (its place only), nothing for anyone else
      if (chipsOnly || hidden.has(link.messageId)) {
        if (!sees) continue
        const n = nameOf(room!)
        list.push({ roomId: m!.room_id, messageId: m!.id, rootId: m!.thread_root_id, place: { kind: room!.kind, name: n.name, peers: n.peers }, author: null, authorKind: m!.author_kind, mentions: [], createdAt: m!.created_at, editedAt: null, deleted: !!m!.deleted_at, body: '', files: { count: 0 }, removed: true })
        continue
      }
      if (m && sees) {
        const n = nameOf(room!)
        const ai = m.author_kind === 'ai'
        const shared = sharedAnswerOf(m)
        if ((ai || shared) && opens === null) opens = pathCheckFor(db, viewer.user_id)
        const app = prep.apps.get(m.id)
        list.push({
          roomId: m.room_id, messageId: m.id, rootId: m.thread_root_id,
          place: { kind: room!.kind, name: n.name, peers: n.peers },
          author: m.author_id ? prep.people.get(m.author_id) ?? null : null, authorKind: m.author_kind,
          ...(app ? { app } : {}),
          mentions: m.deleted_at ? [] : parseMentions(m.mentions),
          createdAt: m.created_at, editedAt: m.edited_at, deleted: !!m.deleted_at,
          body: m.deleted_at ? '' : clipText(m.body),
          // (a shared answer: the links of its answer part, as on the message itself)
          ...(!m.deleted_at && (ai || shared) ? { openable: openableFor(opens ?? undefined, shared ? m.body.slice(shared.at) : m.body) } : {}),
          files: m.deleted_at ? { count: 0 } : prep.files.get(m.id) ?? { count: 0 },
        })
        continue
      }
      // not theirs to see: the snapshot the sender chose to show, if any (its words gone once the original was deleted)
      const snap = stored?.snapshots?.find((s) => s.messageId === link.messageId)
      if (!snap) continue
      list.push(snapshotOut(snap, prep.people, r.author_id, !m || !!m.deleted_at))
    }
    if (list.length) out.set(r.id, list)
  }
  return out
}

/** May a snapshot be made of this message ("Show message" is offered): a person's own message for the whole room, not
 * deleted, not an event line, an app's card, an AI answer or an answer shared from someone's AI chat (those carry
 * team-file links and what they read; sharing them wider has its own way, docs/DECISIONS.md "대화방에 보내기"). */
export const snapshotAllowed = (m: MessageRow): boolean =>
  m.author_kind === 'user' && !!m.author_id && !m.event && !m.app_card && !m.deleted_at && m.visibility === 'room' && !sharedAnswerOf(m)

/** The snapshots a web send asked for (`show`: SendRoomMessageBody.showMessages), built from the originals with the
 * sender's own access now. An id not linked in `body`, one the sender cannot see, one that is not there or not a person's
 * message: left out without a word (the same for each: no way to learn what exists). */
export function snapshotsAtSend(db: Database, body: string, show: readonly string[] | undefined, senderId: string): StoredSnapshot[] {
  if (!show?.length) return []
  const want = new Set(show.map((x) => x.toLowerCase()))
  const links = cardLinks(body).filter((l) => want.has(l.messageId))
  return links.map((l) => snapshotOf(db, l, senderId)).filter((x): x is StoredSnapshot => !!x)
}

/** The snapshot of one linked message as `senderId` may make it now, or null (not theirs to see, not there, not a
 * person's message). */
export function snapshotOf(db: Database, link: Pick<MessageLinkRef, 'roomId' | 'messageId' | 'rootId'>, senderId: string): StoredSnapshot | null {
  const m = db.query(`SELECT ${MSG_COLS} FROM room_messages WHERE id = ?`).get(link.messageId) as MessageRow | null
  const room = m ? db.query('SELECT * FROM rooms WHERE id = ?').get(m.room_id) as RoomRow | null : null
  const member = m ? db.query(`SELECT m.*, EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = m.user_id) has_hidden FROM room_members m WHERE m.room_id = ? AND m.user_id = ?`).get(m.room_id, senderId) as MemberRow | null : null
  if (!m || !seesLinked(db, link, m, room ?? undefined, member ?? undefined) || !snapshotAllowed(m)) return null
  const files = db.query('SELECT name, kind FROM room_files WHERE message_id = ? ORDER BY created_at, id').all(m.id) as { name: string; kind: string }[]
  return {
    roomId: m.room_id, messageId: m.id, rootId: m.thread_root_id, kind: room!.kind,
    // a team room's name as the sender sees it; a DM or a group chat by its kind only (who is in it is not the
    // destination's business)
    name: room!.kind === 'team' || room!.kind === 'all' ? roomNaming(db, room!, senderId).name : null,
    authorId: m.author_id, createdAt: m.created_at, body: clipText(m.body), mentions: parseMentions(m.mentions),
    files: files.length ? { count: files.length, first: { name: files[0]!.name, kind: files[0]!.kind } } : { count: 0 },
  }
}

/** A snapshot as the readers who cannot see the original get it (also what the sender's box shows before the send). */
export function snapshotOut(s: StoredSnapshot, people: ReadonlyMap<string, UserRef>, sharedBy: string | null, originalGone = false): RoomLinkPreview {
  const gone = !!s.deleted || originalGone
  return {
    roomId: s.roomId, messageId: s.messageId, rootId: s.rootId,
    place: { kind: s.kind, name: s.kind === 'team' || s.kind === 'all' ? s.name : null, peers: [] },
    author: s.authorId ? people.get(s.authorId) ?? null : null, authorKind: 'user',
    mentions: gone ? [] : s.mentions, createdAt: s.createdAt, editedAt: null, deleted: gone,
    body: gone ? '' : s.body, files: gone ? { count: 0 } : s.files,
    sharedBy: sharedBy ? people.get(sharedBy) ?? null : null,
  }
}

/** After an edit: what is kept of a message's stored previews (only the links its new text still has). */
export function keptAfterEdit(stored: string | null | undefined, body: string): string | null {
  const s = readStored(stored)
  const now = new Set(cardLinks(body).map((l) => l.messageId))
  return writeStored({ hidden: (s.hidden ?? []).filter((id) => now.has(id)), snapshots: (s.snapshots ?? []).filter((x) => now.has(x.messageId)) })
}

/** The original `messageId` was deleted: every snapshot of it loses its words (one scan of the messages that hold any
 * snapshot; a delete is rare). Returns the messages changed. */
export function wipeSnapshotsOf(db: Database, messageId: string): { id: string; room_id: string }[] {
  const rows = db.query("SELECT id, room_id, link_previews FROM room_messages WHERE link_previews IS NOT NULL AND instr(link_previews, ?) > 0").all(messageId) as { id: string; room_id: string; link_previews: string }[]
  const changed: { id: string; room_id: string }[] = []
  for (const r of rows) {
    const s = readStored(r.link_previews)
    let hit = false
    const snapshots = (s.snapshots ?? []).map((x) => {
      if (x.messageId !== messageId || x.deleted) return x
      hit = true
      return { ...x, body: '', mentions: [], files: { count: 0 }, deleted: true }
    })
    if (!hit) continue
    db.query('UPDATE room_messages SET link_previews = ? WHERE id = ?').run(writeStored({ ...s, snapshots }), r.id)
    changed.push({ id: r.id, room_id: r.room_id })
  }
  return changed
}
