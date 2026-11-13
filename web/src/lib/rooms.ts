// Pure helpers of the team chat rooms ("대화방" v1, shared/src/api/rooms.ts): a room's title, runs of one author's
// messages, event lines, and @mentions (the "@name" being typed, the members that fit it, and the parts of a sent
// text). No React, no requests: unit tested in test/unit/rooms-lib.test.ts.
import { roomLightsDot, roomUnread, roomWantsMe, ROOM_MENTIONS_MAX, type Room, type RoomEventLine, type RoomMessage, type UserRef } from '@mycel/shared/api'

/** The words a title falls back to: `all` for the everyone room, `gone` for a DM whose other person is gone, and for an
 * unnamed group chat its other members ("가, 나, 다 외 2명"; `alone` when nobody else is left). */
export interface TitleWords { all: string; gone: string; names?: (names: string, more: number) => string; sep?: string; alone?: string }

/** How many of a group chat's other members its title names before "외 N명". */
export const TITLE_NAMES = 3

/** The room's own name when it has one; else team: the group's name; all: the app's word for everyone; dm: the other
 * person (peers[0]); group: the other members (the first TITLE_NAMES of peers, then how many more). */
export function roomTitle(room: Pick<Room, 'kind' | 'name' | 'peers'> & Partial<Pick<Room, 'memberCount'>>, words: TitleWords): string {
  if (room.kind === 'dm') return room.peers[0]?.name ?? words.gone
  if (room.kind === 'group' && !room.name) {
    const shown = room.peers.slice(0, TITLE_NAMES).map((p) => p.name)
    if (!shown.length) return words.alone ?? words.gone
    const others = Math.max(shown.length, (room.memberCount ?? room.peers.length + 1) - 1)
    const list = shown.join(words.sep ?? ', ')
    return words.names ? words.names(list, others - shown.length) : list
  }
  return room.name ?? words.all
}

/** The words of an event line (lib, not React: the component passes t). `person` puts a language's honorific after a
 * name ("{name}님"), `quote` puts a room name in the language's quotes. */
export interface EventWords {
  t: (key: 'rooms.event.invited' | 'rooms.event.invitedMore' | 'rooms.event.renamed' | 'rooms.event.renamedBack' | 'rooms.event.left' | 'rooms.event.joined' | 'rooms.event.removed' | 'rooms.event.unknown' | 'rooms.event.person' | 'rooms.event.quoted' | 'rooms.nameSep', params?: Record<string, string | number>) => string
  nameOf: (u: UserRef | null) => string
}
/** "가나님이 다라님, 마바님을 초대했어요": every name but the last gets the language's honorific here, the last one the
 * text's own (so a name that ends with 님 already gets no second one, and the particle after it fits); past TITLE_NAMES
 * names "외 N명". */
export function eventText(e: RoomEventLine, author: UserRef | null, w: EventWords): string {
  const actor = w.nameOf(author)
  switch (e.type) {
    case 'created':
    case 'added': {
      const names = e.users.map((u) => w.nameOf(u))
      const shown = names.slice(0, TITLE_NAMES)
      const list = shown.map((n, i) => (i < shown.length - 1 ? w.t('rooms.event.person', { name: n }) : n)).join(w.t('rooms.nameSep'))
      return names.length > shown.length ? w.t('rooms.event.invitedMore', { actor, names: list, n: names.length - shown.length }) : w.t('rooms.event.invited', { actor, names: list })
    }
    case 'renamed':
      return e.name ? w.t('rooms.event.renamed', { actor, name: w.t('rooms.event.quoted', { name: e.name }) }) : w.t('rooms.event.renamedBack', { actor })
    case 'left':
      return w.t('rooms.event.left', { actor })
    case 'joined':
      return w.t('rooms.event.joined', { actor })
    case 'removed':
      return w.t('rooms.event.removed', { actor, name: w.nameOf(e.user) })
    case 'unknown':
      return w.t('rooms.event.unknown')
  }
}

/** Messages of one author close together share one avatar, name and time: a new run after another author, a pause
 * longer than this, or a new day. */
export const RUN_GAP_MS = 5 * 60_000

/** The local calendar day of a time ("2026-11-05"), for the day line between messages. */
export function localDayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface MessageRun {
  /** the first message's id */
  key: string
  messages: RoomMessage[]
  /** the first run of its day (the list shows the date above it) */
  newDay: boolean
}

const authorKey = (m: RoomMessage) => (m.authorKind === 'ai' ? `ai:${m.askedBy?.id ?? ''}` : `user:${m.author?.id ?? ''}`)

/** Cut the messages (oldest first) into runs of one author. An event line is a run of its own and ends the one before
 * it (the next message starts a new run with its name and time). */
export function groupRuns(messages: RoomMessage[], dayOf: (iso: string) => string = localDayKey): MessageRun[] {
  const runs: MessageRun[] = []
  let prev: RoomMessage | null = null
  let prevDay: string | null = null
  for (const m of messages) {
    const day = dayOf(m.createdAt)
    const sameDay = day === prevDay
    const joins = prev !== null && sameDay && !prev.event && !m.event && authorKey(prev) === authorKey(m) && (m.author !== null || m.authorKind === 'ai') && Date.parse(m.createdAt) - Date.parse(prev.createdAt) <= RUN_GAP_MS
    if (joins) runs.at(-1)!.messages.push(m)
    else runs.push({ key: m.id, messages: [m], newDay: !sameDay })
    prev = m
    prevDay = day
  }
  return runs
}

/** The "@word" being typed right before the caret: where its "@" is and what follows it. null: the caret is not in one
 * ("a@b" in an address is not a mention; a space or a new line ends it). */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query) || query.length > 40) return null
  return { start: at, query }
}

/** The members whose name holds the query (names that start with it first), never the person typing, at most `limit`. */
export function matchMembers<T extends { id: string; name: string }>(members: T[], query: string, meId: string | null, limit = 8): T[] {
  const q = query.toLocaleLowerCase()
  const starts = (m: T) => m.name.toLocaleLowerCase().startsWith(q)
  return members
    .filter((m) => m.id !== meId && m.name.toLocaleLowerCase().includes(q))
    .sort((a, b) => Number(!starts(a)) - Number(!starts(b)) || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/** "@name " in place of the "@query" from `start` to the caret: the new text and where the caret goes. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length }
}

/** A text with "\n" line breaks only, as a text area gives it back. */
export const lineBreaks = (text: string) => text.replace(/\r\n?/g, '\n')

/** Where a mention's "@" may stand: at the start, or after a space or an opening mark (the server's "@전체" check,
 * shared roomMentionAllIn, and mentionParts go by the same rule). */
export const mentionCanStart = (text: string, at: number) => at === 0 || /[\s([{"'“‘]/.test(text[at - 1] ?? '')

/** A person picked from the "@" list (or "@전체": id ALL_MENTION_ID, name the word it was written with), and where their
 * "@name" went in the message box. */
export interface PickedMention { start: number; end: number; id: string; name: string }
/** A mention as the message box shows it: a person the message will notify, or everyone in the room ("@전체"). */
export interface MentionToken { start: number; end: number; kind: 'person' | 'all'; id: string }

/** The mentions in a message box, which are what is sent: the picked people whose "@name" is still whole where it was put
 * and may start a mention there (a letter typed right before it pauses it). Text that only looks like a mention
 * (pasted, typed without the list, a picked name broken by an edit) is plain text: it notifies nobody. */
export function mentionTokens(text: string, picked: readonly PickedMention[]): MentionToken[] {
  const whole = picked.filter((p) => p.name && p.end === p.start + p.name.length + 1 && text.startsWith(`@${p.name}`, p.start) && mentionCanStart(text, p.start))
  const tokens: MentionToken[] = whole.map((p) => (p.id === ALL_MENTION_ID ? { start: p.start, end: p.end, kind: 'all' as const, id: ALL_MENTION_ID } : { start: p.start, end: p.end, kind: 'person' as const, id: p.id }))
  return tokens.sort((a, b) => a.start - b.start)
}

/** Does what is sent mention everyone ("@전체" stands in the box)? */
export const tokenMentionsAll = (tokens: readonly MentionToken[]) => tokens.some((x) => x.kind === 'all')

/** The people a message mentions, for what is sent: its people's tokens, each once, at most ROOM_MENTIONS_MAX. */
export function tokenMentions(tokens: readonly MentionToken[]): string[] {
  const ids: string[] = []
  for (const x of tokens) if (x.kind === 'person' && !ids.includes(x.id)) ids.push(x.id)
  return ids.slice(0, ROOM_MENTIONS_MAX)
}

/** These people's "@name"s in a text (a message to edit, a send that came back), as mentionParts marks them. */
export function mentionsIn(text: string, people: { id: string; name: string }[]): PickedMention[] {
  const out: PickedMention[] = []
  let at = 0
  for (const part of mentionParts(text, people)) {
    if (part.userId) out.push({ start: at, end: at + part.text.length, id: part.userId, name: part.text.slice(1) })
    at += part.text.length
  }
  return out
}

/** A sent text cut into plain parts and the "@name"s of the people it mentions (the longest name wins where one name
 * starts another). Only shown as text: another member's words are never HTML. */
export function mentionParts(body: string, mentioned: { id: string; name: string }[]): { text: string; userId?: string }[] {
  const names = mentioned.filter((p) => p.name).sort((a, b) => b.name.length - a.name.length)
  if (!names.length || !body.includes('@')) return [{ text: body }]
  const parts: { text: string; userId?: string }[] = []
  let plain = ''
  for (let i = 0; i < body.length; ) {
    const hit = body[i] === '@' && mentionCanStart(body, i) ? names.find((p) => body.startsWith(p.name, i + 1)) : undefined
    if (hit) {
      if (plain) parts.push({ text: plain })
      plain = ''
      parts.push({ text: `@${hit.name}`, userId: hit.id })
      i += hit.name.length + 1
    } else {
      plain += body[i]
      i++
    }
  }
  if (plain) parts.push({ text: plain })
  return parts
}

/** The newest loaded message's position (an event line's too): what "read up to here" sends once the bottom of the room
 * is in sight. */
export function newestSeq(messages: RoomMessage[]): number {
  return messages.at(-1)?.seq ?? 0
}

/** How far the room is read as it is on screen now (0: nothing to mark). The read position covers every message up to
 * it, so it only moves over messages that were loaded and came into sight (QA TC-155):
 * - nothing while a page is on its way or failed: the list may hold only messages that came meanwhile (a room opened
 *   from a notice, its first page still loading), with the unread ones before them not shown yet;
 * - nothing while unread messages are older than the pages loaded (more unread than one page): marking the newest
 *   would read the ones never loaded too. Scrolling up to them loads them, and then it reads;
 *   (a seq the timeline never lists, a reply kept in its thread, right after the read position at a page's edge waits
 *   the same way: the safe side);
 * - else the newest message whose top has come into sight (`inSight`), so a reader scrolled up reads up to there.
 * A window around an older message (a search result) reads nothing: its newest is not the room's. */
export function readUpTo(th: { messages: RoomMessage[]; nextCursor: string | null; newerCursor?: string | null; loading: boolean; error: unknown }, lastReadSeq: number, inSight: (m: RoomMessage) => boolean): number {
  if (th.loading || th.error || th.newerCursor || !th.messages.length) return 0
  if (th.nextCursor && th.messages[0]!.seq > lastReadSeq + 1) return 0
  for (let i = th.messages.length - 1; i >= 0; i--) {
    const m = th.messages[i]!
    if (m.seq <= lastReadSeq) return 0
    if (inSight(m)) return m.seq
  }
  return 0
}

/** The total for the 대화 tab: every room's own badge, added; a muted room's never (its badge is grey), nor a hidden
 * one's (docs/DECISIONS.md "대화 숨기기": what comes for me brings it back first, and then it counts). */
export function totalUnread(rooms: (Pick<Room, 'unreadCount' | 'muted'> & Partial<Pick<Room, 'threadsUnread' | 'hidden'>>)[]): number {
  return rooms.reduce((n, r) => n + (r.muted || r.hidden ? 0 : roomUnread(r)), 0)
}

/** The rooms my lists show: the ones I did not hide, and the room on screen whatever it is. */
export const shownInLists = <R extends Pick<Room, 'id'> & Partial<Pick<Room, 'hidden'>>>(rooms: R[], openId: string | null = null): R[] =>
  rooms.filter((r) => !r.hidden || r.id === openId)

type Pinnable = Pick<Room, 'id'> & Partial<Pick<Room, 'pinnedAt'>>
/** My pinned rooms (docs/DECISIONS.md "Pinned conversations"), the most recently pinned first. */
export const pinnedRooms = <R extends Pinnable>(rooms: R[]): R[] => rooms.filter((r) => r.pinnedAt).sort((a, b) => b.pinnedAt!.localeCompare(a.pinnedAt!) || b.id.localeCompare(a.id))
/** A list as the 대화 lists show it: my pinned rooms first (the most recently pinned first), then the others in the
 * order they came (by latest activity). */
export const pinnedFirst = <R extends Pinnable>(rooms: R[]): R[] => [...pinnedRooms(rooms), ...rooms.filter((r) => !r.pinnedAt)]

/** A room's one badge: "?" while its AI waits on me (docs/DECISIONS.md "Session markers"), else "@" when one of the
 * unread messages (or followed replies) mentions me (the count would read as a count of mentions), else the count. */
export const roomBadge = (r: Pick<Room, 'unreadCount' | 'mentioned'> & Partial<Pick<Room, 'threadsUnread'>>) => (r.mentioned ? '@' : badgeText(roomUnread(r)))

// roomWantsMe, roomLightsDot and roomUnread: shared/src/api/attention.ts (the server counts a phone push's badge with them)
export { roomLightsDot, roomUnread, roomWantsMe }

/** Who put a reaction there, for its tooltip: the names given ("가나, 다라"), then how many more ("외 3명"). */
export function reactionWho(r: { count: number; users: { name: string }[] }, w: { sep: string; more: (names: string, n: number) => string }): string {
  const names = r.users.map((u) => u.name).join(w.sep)
  const more = r.count - r.users.length
  return more > 0 ? w.more(names, more) : names
}

/** An AI answer's Markdown as one plain line for the rooms list: no #, **, list marks, backticks or link addresses (the
 * excerpt may end inside a link). */
export function plainLine(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)?/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)?/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|[^\p{L}\p{N}*_])[*_]([^*_\n]+)[*_](?![\p{L}\p{N}])/gu, '$1$2')
    .replace(/`+/g, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}.*$/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Opening a thread from the room page (pages/Room.tsx): a new history entry from the room, marked as reached from it;
 * from an open thread it replaces that one and keeps how it was reached (a thread opened from a link or a notice stays
 * unmarked, so closing it never steps back out of the room). */
export function threadOpening(roomId: string, rootId: string, open: { threadId: string | null; fromRoom: boolean }): { path: string; replace: boolean; state: { fromRoom: boolean } } {
  return { path: `/rooms/${roomId}/t/${rootId}`, replace: !!open.threadId, state: { fromRoom: open.threadId ? open.fromRoom : true } }
}
/** Closing it: one step back when the room is that step, else to the room in place of the thread. */
export const threadClosing = (roomId: string, fromRoom: boolean): -1 | { path: string; replace: true } => (fromRoom ? -1 : { path: `/rooms/${roomId}`, replace: true })

/** "99+" past 99, like the Inbox count. */
export const badgeText = (n: number) => (n > 99 ? '99+' : String(n))
/** How many older pages a linked reply (an Inbox row's or a search result's ?m=) is looked for in a thread: pages of
 * 50, so its last 500 replies. (In a room's timeline the page around the message is asked for: store/rooms.ts
 * loadAround.) */
export const TARGET_PAGES = 10

// ---------------- "@전체" (docs/DECISIONS.md "@전체") ----------------
/** "@전체" in the "@" list and in the box (no person has this id: user ids start with a letter or a digit). */
export const ALL_MENTION_ID = '@all'
/** Slack's words, which find "@전체" in the "@" list in every language too (beside each language's own word). */
const MENTION_ALL_ALIASES = ['all', 'channel', 'everyone', 'みんな']
/** "@전체"'s entry in the "@" list fits the query when one of its words starts with it ("" too: it comes first). `words`: each language's word for it (rooms.mentionAll). */
export function allMatches(query: string, words: readonly string[]): boolean {
  const q = query.toLocaleLowerCase()
  return [...words, ...MENTION_ALL_ALIASES].some((w) => w.toLocaleLowerCase().startsWith(q))
}
/** A message's "@전체" as pseudo-mentions for mentionParts: its word in any language (the sender's may not be mine). */
export const allMentionNames = (m: { mentionsAll?: boolean }, words: readonly string[]): { id: string; name: string }[] =>
  m.mentionsAll ? words.map((name) => ({ id: ALL_MENTION_ID, name })) : []
/** Does this message mention me: picked by name, or "@전체" by someone else (the sound, the "@" badge)? */
export const mentionsMe = (m: { mentions: readonly string[]; mentionsAll?: boolean; author?: { id: string } | null }, meId: string | null | undefined) =>
  !!meId && (m.mentions.includes(meId) || (!!m.mentionsAll && m.author?.id !== meId))

