// Pure helpers of the team chat rooms ("대화방" v1, shared/src/api/rooms.ts): a room's title, runs of one author's
// messages, event lines, and @mentions (the "@name" being typed, the members that fit it, and the parts of a sent
// text). No React, no requests: unit tested in test/unit/rooms-lib.test.ts.
import { isUuid7, roomCounts, roomLightsDot, roomNoticeWanted, roomUnread, roomWantsMe, ROOM_MENTIONS_MAX, type CountedRoomFields, type Room, type RoomEventLine, type RoomMessage, type SlackLineWhat, type UserRef } from '@mycel/shared/api'

/** The words a title falls back to: `all` for the everyone room, `gone` for a DM whose other person is gone, and for an
 * unnamed group chat its other members ("가, 나, 다 외 2명"; `alone` when nobody else is left). */
export interface TitleWords { all: string; gone: string; names?: (names: string, more: number) => string; sep?: string; alone?: string }

/** From this many members (me included) a message with "@전체" asks before it goes (components/rooms/RoomComposer.tsx),
 * unless the person said "Don't ask again" (prefs.mentionAllAsk). */
export const MENTION_ALL_CONFIRM = 10

/** How many of a group chat's other members its title names before "외 N명". */
export const TITLE_NAMES = 3

/** A group room with a name of its own is a private channel (listed under Channels with a lock); one with no name is a
 * group DM, titled by its people (docs/decisions/20261117-named-groups-private-channels.md). Renaming moves it. */
export const isPrivateChannel = (room: Pick<Room, 'kind' | 'name'>): boolean => room.kind === 'group' && !!room.name?.trim()

/** A team project's own chat room (docs/decisions/20261120-project-is-room.md), for every member (Room.projectRoom; a
 * member who cannot open the project's folder now has no Room.project). Its people are the project's, its name is the
 * project's, and its files go to the project: no Add people, Remove, Rename, Leave or guest invites in it. */
export const isProjectRoom = (room: Partial<Pick<Room, 'project' | 'projectRoom'>>): boolean => !!room.projectRoom || !!room.project?.room

/** The room's Files button in its header (docs/decisions/20261121-department-room-files.md): a room whose files go to a
 * team folder (a project's room, by projectRoom even for a member who cannot open the project; a department's team
 * room with a folder I can open) shows it only while it holds files of its own (Room.roomFiles); every other room
 * always. The server answers 404 for a project room's list. */
export const roomFilesButtonShown = (room: Partial<Pick<Room, 'project' | 'projectRoom' | 'kind' | 'groupFolder' | 'roomFiles'>>): boolean =>
  isProjectRoom(room) || (room.kind === 'team' && !!room.groupFolder) ? !!room.roomFiles : true

/** A project room's project, as I can open it now; null for every other room (and for a member who cannot open it). */
export const projectRoomOf = (room: Partial<Pick<Room, 'project'>>): NonNullable<Room['project']> | null => (room.project?.room ? room.project : null)

/** Shown in the 대화 lists: a project's chat room once it has a message (until then it is reached from the project), or
 * at once when it was made on purpose (Room.listed: a conversation made a project, "New project with"), or while it is
 * the room on screen. */
export const listedRoom = (room: Partial<Pick<Room, 'project' | 'projectRoom' | 'lastMessage' | 'listed' | 'id'>>, openId: string | null = null): boolean =>
  !isProjectRoom(room) || !!room.lastMessage || !!room.listed || room.id === openId

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
  t: (key: 'rooms.event.invited' | 'rooms.event.invitedMore' | 'rooms.event.renamed' | 'rooms.event.renamedBack' | 'rooms.event.left' | 'rooms.event.joined' | 'rooms.event.removed' | 'rooms.event.unknown' | ProjectEventKey | 'rooms.event.projectMade' | 'rooms.event.projectMadeUnnamed' | 'rooms.event.filesMoved' | 'rooms.event.filesMovedUnnamed' | 'rooms.event.filesMovedKept' | 'rooms.event.filesMovedKeptUnnamed' | 'rooms.event.person' | 'rooms.event.quoted' | 'rooms.nameSep' | SlackEventKey, params?: Record<string, string | number>) => string
  nameOf: (u: UserRef | null) => string
  /** the Chat attachments folder's name in the reader's language (CHAT_FILES_FOLDER; shared/src/folder-labels.ts chatFilesWord), for the files' move line */
  folder?: string
  /** a Slack line's app name in Slack ("/invite @<app>"), when known */
  bot?: string | null
}
/** The Slack relay's lines (docs/SLACK.md "Channel relay"), one per SlackLineWhat; bot_removed without the app's name too. */
const SLACK_LINE = {
  connected: 'slackConnected', disconnected: 'slackDisconnected', bot_removed: 'slackBotRemoved', archived: 'slackArchived', shared: 'slackShared',
  missing: 'slackMissing', team_removed: 'slackTeamRemoved', back: 'slackBack', capped: 'slackCapped',
} as const satisfies Record<SlackLineWhat, string>
export type SlackEventKey = `rooms.event.${(typeof SLACK_LINE)[SlackLineWhat]}` | 'rooms.event.slackBotRemovedNoBot'
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
    // a line that names a project (docs/decisions/20261119-channel-project-link.md, 20261120-project-is-room.md): the
    // project as it is now for this viewer (eventProjectOf): named while they can open it, "(in the trash)", "a deleted
    // project", else "a project"; project_room is written by the server, so no actor
    case 'project_linked':
    case 'project_unlinked':
    case 'project_room': {
      const p = eventProjectOf(e)
      const k = projectEventKey(e)
      return p.state === 'open' || p.state === 'trash' ? w.t(k, { actor, name: p.name }) : w.t(k, { actor })
    }
    // a conversation made a project by the author (docs/decisions/20261121-make-project-from-room.md): the project's
    // name for a viewer who can open it, else without a name
    case 'project_made': {
      const p = eventProjectOf(e)
      return p.state === 'open' ? w.t('rooms.event.projectMade', { actor, name: p.name }) : w.t('rooms.event.projectMadeUnnamed', { actor })
    }
    // its files' move ended (written by the server): how many went to the project's Chat attachments, and only when
    // some stayed, how many stayed in the conversation
    case 'project_files_moved': {
      const folder = w.folder ?? 'Chat attachments'
      const name = eventProjectOf(e)
      // the folder the files are in: the "-2" one when another project had the name (QA TC-6953)
      const n = name.state === 'open' ? (e.project?.folder ?? name.name) : null
      if (e.kept > 0) return n ? w.t('rooms.event.filesMovedKept', { n: e.moved, m: e.kept, name: n, folder }) : w.t('rooms.event.filesMovedKeptUnnamed', { n: e.moved, m: e.kept, folder })
      return n ? w.t('rooms.event.filesMoved', { n: e.moved, name: n, folder }) : w.t('rooms.event.filesMovedUnnamed', { n: e.moved, folder })
    }
    // the Slack channel relay: connected / disconnected by the author, the others by the server (no actor). A line of
    // a kind this build does not know reads as an unknown line
    case 'slack': {
      const k = SLACK_LINE[e.what]
      if (!k) return w.t('rooms.event.unknown')
      if (e.what === 'bot_removed' && !w.bot) return w.t('rooms.event.slackBotRemovedNoBot', { channel: e.channel })
      return w.t(`rooms.event.${k}`, { actor, channel: e.channel, ...(e.what === 'bot_removed' ? { bot: w.bot! } : {}) })
    }
    case 'unknown':
      return w.t('rooms.event.unknown')
  }
}

/** An event line that names a project. */
export type ProjectEventLine = Extract<RoomEventLine, { type: 'project_linked' | 'project_unlinked' | 'project_room' }>
type ProjectLineType = ProjectEventLine['type']
const LINE_WORD = { project_linked: 'projectLinked', project_unlinked: 'projectUnlinked', project_room: 'projectRoom' } as const satisfies Record<ProjectLineType, string>
export type ProjectEventKey = `rooms.event.${(typeof LINE_WORD)[ProjectLineType]}${'' | 'Named' | 'Trash' | 'Deleted'}`

/** The project a line names, as the server read it for me now (server/src/rooms/project-link.ts eventProjectsFor, the
 * one resolver): 'open' its name now and a link; 'trash' its name now as plain text; 'deleted'; 'hidden' I cannot
 * open it ("a project": never a name, so never a renamed one). An older server's line is 'open' or 'hidden'. */
export type EventProject = { state: 'open'; id: string; name: string } | { state: 'trash'; name: string } | { state: 'deleted' } | { state: 'hidden' }
export function eventProjectOf(e: Pick<ProjectEventLine, 'project' | 'projectGone'>): EventProject {
  if (e.project) return { state: 'open', id: e.project.id, name: e.project.name }
  const g = e.projectGone
  if (g?.state === 'trash') return g.name ? { state: 'trash', name: g.name } : { state: 'hidden' }
  if (g?.state === 'deleted') return { state: 'deleted' }
  return { state: 'hidden' }
}

/** The words of a project line for the project as it is now: named (open), named "(in the trash)", "a deleted
 * project", or neutral ("a project"). */
export function projectEventKey(e: ProjectEventLine): ProjectEventKey {
  const s = eventProjectOf(e).state
  return `rooms.event.${LINE_WORD[e.type]}${s === 'open' ? 'Named' : s === 'trash' ? 'Trash' : s === 'deleted' ? 'Deleted' : ''}`
}

/** Messages of one author close together share one avatar, name and time: a new run after another author, a pause
 * longer than this, or a new day. */
export const RUN_GAP_MS = 5 * 60_000

/** The local calendar day of a time ("2026-11-05"), for the day line between messages. */
export function localDayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** What runs are cut by: a room message, or a reply in the thread under a shared chat's AI answer
 * (components/chat/ChatThreadPanel.tsx), which has no AI author and no event lines. */
export interface RunItem {
  id: string
  createdAt: string
  author: { id: string } | null
  authorKind?: RoomMessage['authorKind']
  askedBy?: { id: string } | null
  event?: unknown
}

export interface MessageRun<M extends RunItem = RoomMessage> {
  /** the first message's id */
  key: string
  messages: M[]
  /** the first run of its day (the list shows the date above it) */
  newDay: boolean
}

const authorKey = (m: RunItem) => (m.authorKind === 'ai' ? `ai:${m.askedBy?.id ?? ''}` : `user:${m.author?.id ?? ''}`)

/** Cut the messages (oldest first) into runs of one author. An event line is a run of its own and ends the one before
 * it (the next message starts a new run with its name and time). */
export function groupRuns<M extends RunItem>(messages: readonly M[], dayOf: (iso: string) => string = localDayKey): MessageRun<M>[] {
  const runs: MessageRun<M>[] = []
  let prev: M | null = null
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
 * ("a@b" in an address is not a mention; a new line ends it). A space ends it too, unless one of `names` (the people the
 * list offers) starts with what was typed: "@QA Mem" still finds "QA Member", a name of two words (QA M7: the list
 * closed at the first space, so a full name typed out was sent as plain text and mentioned nobody). */
export function mentionAt(text: string, caret: number, names: readonly string[] = []): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null
  const query = before.slice(at + 1)
  if (query.length > 40 || query.includes('\n')) return null
  if (/\s/.test(query)) {
    const q = query.toLocaleLowerCase()
    if (!names.some((n) => n.toLocaleLowerCase().startsWith(q))) return null
    // a whole name and a space after it ("@QA Member "): done typing it, not the start of a longer one (Enter sends)
    if (/\s$/.test(q) && names.some((n) => n.toLocaleLowerCase() === q.trimEnd())) return null
  }
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

/** The class of a mention: the accent colour; mine on a soft background (as RoomMessages drew it before). One look for
 * a message's Markdown (lib/messageMarkdown.ts) and plain words (components/rooms/MessageText.tsx MentionedText). */
export const mentionClass = (strong?: boolean) => ['font-medium', 'text-accent-text', ...(strong ? ['rounded', 'bg-accent-soft', 'px-0.5'] : [])]

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

/** Every room's own number, added (messages, not rooms; the 대화 tab and the rail count conversations instead:
 * components/rail/railBadges.ts chatsMark), by roomCounts: a room that does not count adds nothing (a muted room's badge
 * is grey; plain messages in a room at 멘션만 have no number), nor a hidden one (docs/DECISIONS.md "대화 숨기기": what comes
 * for me brings it back first, and then it counts). */
export function totalUnread(rooms: (CountedRoomFields & Partial<Pick<Room, 'hidden'>>)[]): number {
  return rooms.reduce((n, r) => {
    const c = roomCounts(r)
    return n + (c.counts && !r.hidden ? c.number : 0)
  }, 0)
}

/** The rooms my lists show: the ones I did not hide (a project's chat room once it has a message: listedRoom), and the
 * room on screen whatever it is. */
export const shownInLists = <R extends Pick<Room, 'id'> & Partial<Pick<Room, 'hidden' | 'project' | 'projectRoom' | 'lastMessage' | 'listed'>>>(rooms: R[], openId: string | null = null): R[] =>
  rooms.filter((r) => (!r.hidden || r.id === openId) && listedRoom(r, openId))

type Pinnable = Pick<Room, 'id'> & Partial<Pick<Room, 'pinnedAt'>>
/** My pinned rooms (docs/DECISIONS.md "Pinned conversations"), the most recently pinned first. */
export const pinnedRooms = <R extends Pinnable>(rooms: R[]): R[] => rooms.filter((r) => r.pinnedAt).sort((a, b) => b.pinnedAt!.localeCompare(a.pinnedAt!) || b.id.localeCompare(a.id))
/** A list as the 대화 lists show it: my pinned rooms first (the most recently pinned first), then the others in the
 * order they came (by latest activity). */
export const pinnedFirst = <R extends Pinnable>(rooms: R[]): R[] => [...pinnedRooms(rooms), ...rooms.filter((r) => !r.pinnedAt)]

/** A room's one badge (roomCounts): "@" when one of the unread messages (or followed replies) mentions me (the count
 * would read as a count of mentions), else its number of unread messages of the timeline (a followed thread's reply is
 * not one: docs/decisions/20261119-room-unread-after-read.md); '' when it has none (plain messages in a room at 멘션만:
 * the row is only bold). */
export const roomBadge = (r: CountedRoomFields) => {
  const c = roomCounts(r)
  return c.mention ? '@' : c.number > 0 ? badgeText(c.number) : ''
}

// roomCounts, roomWantsMe, roomNoticeWanted, roomLightsDot and roomUnread: shared/src/api/attention.ts (the server counts a phone push's
// badge with them)
export { roomCounts, roomLightsDot, roomNoticeWanted, roomUnread, roomWantsMe }

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
/** The message a room's own timeline goes to and picks out (components/rooms/RoomMessages.tsx `highlight`): with no
 * thread open, the one a link points at (?m=: an Activity row, a search result, a message link); with a thread open from
 * a link, an Activity row or a push tap, the thread's first message, so the room shows the message the thread is under
 * beside it, as Slack does (a push names no ?m=: the thread's address is enough); none for a thread opened by a click in
 * this room (`openedHere`: that message is in sight already, and the room stays as it was). */
export function timelineTarget(o: { threadId: string | null; target: string | null; openedHere: boolean }): string | null {
  if (!o.threadId) return o.target
  return o.openedHere ? null : o.threadId
}
/** A phone notification's path to a message (/rooms/<room>[/t/<root>]/m/<message>: server/src/notifications/push-events.ts
 * roomPath) as the app's own address: the room or the thread at that message (?m=). An id that is not one: the room or
 * the thread alone (the page says what it says about a bad thread). */
export function pushedMessagePath(roomId: string, rootId: string | null, messageId: string): string {
  const room = `/rooms/${encodeURIComponent(roomId)}${rootId ? `/t/${encodeURIComponent(rootId)}` : ''}`
  return isUuid7(messageId) && messageId !== rootId ? `${room}?m=${encodeURIComponent(messageId)}` : room
}
/** Whether a list picks out (scrolls to and lights) `highlight` now: once for each place in the history that points at
 * it (`navKey`: the router's location key), so coming back to that place (closing a thread opened from it, Back) leaves
 * the reader where they scrolled, and a link or a notice clicked again (a new place) picks it out again. `seen` holds
 * what was picked out already, for the life of the list. */
export function highlightNow(seen: Set<string>, highlight: string | null, navKey: string | null): boolean {
  if (!highlight) return false
  const k = `${navKey ?? ''} ${highlight}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
}
/** An address's query without the message a link picked out (?m=), the rest kept as it was: "" when nothing is left. */
export function withoutTarget(search: string): string {
  const q = new URLSearchParams(search)
  if (!q.has('m')) return search
  q.delete('m')
  const rest = q.toString()
  return rest ? `?${rest}` : ''
}
/** Closing it: one step back when the room is that step, else to the room in place of the thread. */
export const threadClosing = (roomId: string, fromRoom: boolean): -1 | { path: string; replace: true } => (fromRoom ? -1 : { path: `/rooms/${roomId}`, replace: true })

/** The line of a room with no messages yet: "Send the first one" only where a message can be sent. A DM whose other
 * person left the team is read-only (no message box, pages/Room.tsx), so it says just "No messages." (QA TC-1973). */
export const roomEmptyKey = (room: Partial<Pick<Room, 'gone'>> | null | undefined) => (room?.gone ? 'rooms.emptyReadOnly' as const : 'rooms.empty' as const)

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

