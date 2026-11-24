// ⌘/Ctrl+K: one place to find the team's own things, like Claude's search. Type tabs (all, chats, projects, files,
// skills, scheduled, MCP); with no text it shows what needs attention, recent chats and projects, and actions (the
// inbox among them, with its unread count).
// "Needs attention" shows the AI chats with the 트리나 list's session markers and their words ("?" your turn, the ring, the
// dot for a new answer; lib/sessionMarkers.ts markedChats), from the 트리나 list's own chats, then scheduled tasks to
// confirm and broken connections. History rows (the list and search results) say when the chat was last active and its
// project, grey on the right; opened on a project's page or in a chat of a project, History lists that project's chats
// first (docs/DECISIONS.md "Getting back to earlier work, part A").
// Chats are searched on the server by title and content (GET /api/chats?q=). Projects, skills, scheduled tasks and MCP
// connections come from the lists the app already reads and are matched here by name (a scheduled task also by its
// instruction, and then the row shows the matching part of it, so the match is not hidden). Files: file names are
// searched on the server (GET /api/files/find); the dialog does not search file contents itself, so a key press starts
// no content search (R2-ETC-02); its last row opens the file screen's content search with the same text.
// Messages of the rooms, 1:1 and group chats I am in (docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기"): searched on the
// server (GET /api/room-messages), only what I would see by opening the room, on the 전체 tab after the chat records:
// the first few, then a "메시지 더 보기" row that shows more in place (and asks for the next page). A row: the sender's
// picture and name, the room ("#팀방", "1:1 대화", a group chat's name), "스레드" for a reply, the time, and one line of
// the text around the match; it opens the room at that message (a reply: its thread), marked for a moment.
// For owners and admins two more actions are found by their words, not listed before anything is typed: "Admin" and
// "Invite people" (the team menu's two items, TeamMenu.tsx; docs/DECISIONS.md "The team menu").
// Rooms & people (전체 tab, first, only while something is typed): the rooms of my rooms list (GET /api/rooms; hidden ones
// too: opening one shows it again, as opening it from 숨긴 대화 does) and the team's people (the new-DM list), matched
// here by name: any case and width, every word, a Korean initial consonant for the syllables that start with it ("ㄱㅈ"
// finds "견적"; shared/src/search-text.ts nameMatch). Rooms and DMs first (a DM stands for its person), then people
// with no DM: one of those opens the new-DM list with them ticked (components/rooms/PeoplePicker.tsx), so nothing is
// made until they press its button. Both lists load in the background when no screen has read them yet.
// One more type, 대화 (QA TC-256): my rooms, the team's people and the rooms' messages, nothing else. The phone's 대화
// tab's 🔍 and the computer's 대화 panel's 🔍 open search on it (store/ui.ts searchScope; components/PhoneTopBar.tsx,
// panels/ChatsPanel.tsx); with no text it lists my rooms. ⌘K also finds 프로젝트 (all projects), 사용량 (Usage, not in
// the account menu) and the files by "팀 폴더" (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1 "⌘K aliases").
// Files sent in rooms (전체 and 파일 tabs, after the team files' names, 4 file rows in all on 전체): searched on the server
// by name (GET /api/room-files), only those of messages I see; a row is the name, then who sent it, where and when;
// it opens its message in the room, as a message found does. Before anything is typed, 전체 and 파일 show "Recent files":
// the newest five files of my rooms (GET /api/room-files/recent: the same checks as the search, a project room's file
// only while I can open it), each opening in the file viewer as its chip in the room does (lib/imageViewer.ts
// roomFileItem), with who sent it, where and when.
// Chips (docs/decisions/20261120-search-shortcuts-slack.md), between the box and the types on 전체, 대화 and 파일: "This
// conversation" (only when search was opened in a room, a DM or a thread: ⌘F there, or the room menu's Search in this
// conversation; store/ui.ts searchHere) sends room= and searches that room's messages and files only, and with no text
// asks nothing (a one-line hint); "Sent by me" and "Mentions me" add from:me and mentions:me to the text sent, so the
// chip and the typed words are one search. Backspace in an empty box turns the last chip off. With no text, "Needs
// attention" also lists up to 3 conversations with unread messages (mentions first; not muted or hidden ones).
// Every word of the text counts, in any order (room messages, chat records, room files). A result from the server is
// kept with the words it answered and used only while they are the words in the box, so nothing from an older text is
// shown or opened: a fast Enter opens the top row shown at that moment. The highlighted row is kept by its key, so
// results arriving above it do not move it.
import clsx from 'clsx'
import { Bell, BookMarked, Paperclip, Cable, CalendarClock, CalendarPlus, Check, ChevronDown, CornerDownLeft, File as FileIcon, FileSearch, Folder, FolderKanban, FolderOpen, FolderPlus, Gauge, Image as ImageIcon, Link2, MessageSquare, MoreHorizontal, Pencil, Plus, Shield, Trash2, UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import { nameMatch, nearNames, parseSearch, searchWords } from '@mycel/shared'
import { skillTitle, type Chat, type FileEntry, type Integration, type Person, type Project, type RecentRoomFiles, type Room, type RoomFileSearchHit, type RoomSearchFilters, type RoomSearchHit, type RoomSearchRoom, type RoomSearchSort, type Schedule } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { connectionHref, CONNECTORS_HOME } from '../lib/connectors'
import { formatRelative, listTime } from '../lib/format'
import { markedChats, type Marker, type MarkerKind } from '../lib/sessionMarkers'
import { pinnedFirst, plainLine, shownInLists } from '../lib/rooms'
import { platform } from '../lib/pwa'
import { scheduleName } from '../lib/scheduleText'
import { useLocale, useT, type MessageKey } from '../i18n'
import { aiName } from '../lib/tabs'
import { newChatPath } from '../lib/newChat'
import { useOverlayEntry } from '../lib/backCloses'
import { isAdmin, useMe } from '../store/session'
import { useFreeRoam } from '../store/demo'
import { useGuestAiOff, useGuestFolderHref } from './GuestView'
import { openTeamFile } from '../lib/sidePanel'
import { openImageViewer, roomFileItem } from '../lib/imageViewer'
import { isGuestMe, meGuest } from '../lib/guests'
import { useUi } from '../store/ui'
import { useEdgeFade, useFocusTrap, useMediaQuery } from './ui'
import { contentQueryReady } from './FileContentSearch'
import { skillFileLink } from './AvailableSkills'
import { useChatActions } from './chat/chatActions'
import { useCopyChatLink } from './chat/copyChatLink'
import { openTeamInvite } from './TeamMenu'
import { Tooltip } from './Tooltip'
import { Avatar } from './Avatar'
import { MenuButton, useLongPress } from './rooms/MenuButton'
import { AiFace, AiMark } from './rooms/AiFace'
import { PeoplePicker } from './rooms/PeoplePicker'
import { RoomIcon, useRoomTitle } from './rooms/RoomIcon'
import { useAvatarOf, usePeopleList } from '../store/people'
import { useRooms } from '../store/rooms'
import { useChats } from '../store/chats'
import { useInboxUnread } from '../store/inbox'
import { readIntegrations, readSchedules, readSkillList, RECENT_ROOM_FILES, SHARED, useCachedRead } from '../store/listCache'
import { useProjects } from '../store/projects'
import { cardChats, cardQuestion, reasonText, useSessionMarkers } from '../store/sessionMarkers'
import { SessionMarker } from './chat/ChatState'
import { ChatFaces, otherWriters } from './chat/SharedChat'
import { AppTile, SenderTag, useAppName } from './rooms/apps/AppParts'
import { serviceOf } from '../lib/roomApps'
import { awayFromComputer } from '../lib/integrations'
import { useTeamPlace } from '../lib/teamPlace'

export default function SearchDialog() {
  const open = useUi((s) => s.searchOpen)
  const scope = useUi((s) => s.searchScope)
  const here = useUi((s) => s.searchHere)
  const setOpen = useUi((s) => s.setSearchOpen)
  // phones: Back closes search and stays on the page; a result opened takes its history entry (lib/backCloses.ts)
  useOverlayEntry(open, () => setOpen(false))
  // a person with no DM, chosen in the palette: the new-DM list with them ticked, after the palette has closed
  const [dmWith, setDmWith] = useState<string | null>(null)
  return (
    <>
      {open && <SearchBox scope={scope} here={here} onClose={() => setOpen(false)} onPerson={setDmWith} />}
      <PeoplePicker open={!!dmWith} onClose={() => setDmWith(null)} mode={{ kind: 'new', preselect: dmWith ? [dmWith] : [] }} />
    </>
  )
}

/** "트리나에게 묻기": the mark that asks the AI (rooms/AiFace.tsx), as on the 트리나 panel's row */
const AskAi = () => <AiMark place="nav" />

export const SEARCH_TABS = ['all', 'chats', 'projects', 'files', 'skills', 'scheduled', 'mcp'] as const
export type SearchTab = (typeof SEARCH_TABS)[number]
/** the types: 대화 too (rooms, people, messages), right after 전체 */
type SearchType = SearchTab | 'rooms'
export const SEARCH_TYPES: readonly SearchType[] = ['all', 'rooms', ...SEARCH_TABS.slice(1)]
const TAB_LABEL: Record<SearchType, MessageKey> = {
  all: 'search.tab.all', rooms: 'search.tab.rooms', chats: 'search.tab.chats', projects: 'search.tab.projects', files: 'search.tab.files',
  skills: 'search.tab.skills', scheduled: 'search.tab.scheduled', mcp: 'search.tab.mcp',
}
/** the rooms and people found on the 대화 type, and my rooms listed there before anything is typed */
const ROOMS_FEW = 10

type Kind = 'room' | 'person' | 'chat' | 'message' | 'project' | 'file' | 'skill' | 'schedule' | 'mcp' | 'action'
interface Row {
  key: string
  kind: Kind
  title: string
  /** dim second part: where it is (project, folder) or why it needs attention */
  sub?: string
  attention?: boolean
  /** an AI chat in "Needs attention": the 트리나 list's session marker, its words in `sub` (lib/sessionMarkers.ts) */
  marker?: Marker
  /** grey, on the right: a History row's last activity and project ("2 hours ago · Launch plan") */
  meta?: string
  /** highlight the typed text in the title */
  match?: boolean
  /** highlight the typed text in the second part too (the part of an instruction that matched) */
  subMatch?: boolean
  /** more words the typed text may match (an action's other name) */
  terms?: string
  /** drawn at 16 px: a lucide icon, or Trina's mark (AskAi) */
  icon: ComponentType<{ size?: number }>
  href: string
  chat?: Chat
  /** a room message found (MessageHit draws it) */
  hit?: { hit: RoomSearchHit; room: RoomSearchRoom | undefined }
  /** drawn in place of the icon: a room's icon (a DM's person), or a person's face */
  face?: { room: Room } | { person: Person }
  /** a file sent in a room (RoomFileHit draws it) */
  roomFile?: { hit: RoomFileSearchHit; room: RoomSearchRoom | undefined }
  /** done in place of opening `href`: the dialog stays (메시지 더 보기) */
  run?: () => void
  /** done in place of opening `href`, once the dialog has closed (Invite people: its own dialog) */
  after?: () => void
  /** an action found by its words only, not listed before anything is typed */
  typed?: boolean
}
interface Section { id: string; label: string; rows: Row[] }
interface Skill { path: string; name: string; description: string; title?: string }

const onMac = () => platform() === 'mac' || platform() === 'ios'
const norm = (s: string) => s.toLocaleLowerCase()
/** lower case for A–Z only: what SQLite's LIKE takes in any case (the server's searches) */
const foldAZ = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())
const has = (q: string, ...xs: (string | null | undefined)[]) => xs.some((x) => !!x && norm(x).includes(q))
const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')
/** The part of a long text around the first match (of the text, or of the word found first), on one line: "…every
 * Monday, summarise the weekly notes…". */
export function snippetAround(text: string, q: string | readonly string[], before = 24, after = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const low = norm(flat)
  const [i, n] = (typeof q === 'string' ? [q] : q).map((w) => [low.indexOf(w), w.length] as const).filter(([x]) => x >= 0).sort((a, b) => a[0] - b[0])[0] ?? [-1, 0]
  if (i < 0) return ''
  const from = Math.max(0, i - before), to = Math.min(flat.length, i + n + after)
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`
}
/** The first match of every word in `text` (any case), in order and not overlapping: what the palette marks. None when
 * lower case changes the text's length (its positions would not map back); a match by initial consonants or by a
 * full-width letter is not a plain part of the text either, so it is found but not marked. */
export function wordSpans(text: string, words: readonly string[]): [number, number][] {
  const low = norm(text)
  if (low.length !== text.length) return []
  const spans = words.map((w) => [low.indexOf(w), low.indexOf(w) + w.length] as [number, number]).filter(([s, e]) => s >= 0 && e > s).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [s, e] of spans) {
    const last = out.at(-1)
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** Room messages on the 전체 tab before 메시지 더 보기, and how many more each press shows */
export const MESSAGES_FEW = 5
const MESSAGES_PAGE = 20
/** Where a room message found opens: its room at it, or a reply's thread at it (pages/Room.tsx ?m=). */
export const hitHref = (h: Pick<RoomSearchHit, 'id' | 'roomId' | 'threadRootId'>) =>
  h.threadRootId ? `/rooms/${h.roomId}/t/${h.threadRootId}?m=${h.id}` : `/rooms/${h.roomId}?m=${h.id}`
/** A hit's text as the row shows it: an answer's Markdown as plain text, starting a little before the match so it is
 * in sight on a phone too. */
export function hitText(h: Pick<RoomSearchHit, 'snippet' | 'markdown'>, q: string | readonly string[]): string {
  const text = h.markdown ? plainLine(h.snippet) : h.snippet.replace(/\s+/g, ' ').trim()
  return snippetAround(text, q, 16, 400) || text
}

/** Chats found by the server (newest first) with those whose title has every word first, so Enter opens the chat the
 * person named and not a newer one that has the words only in its messages. `q`: the text in lower case, or its words. */
export function titleFirst(chats: Chat[], q: string | readonly string[]): Chat[] {
  const words = typeof q === 'string' ? searchWords(q) : q
  const named = (c: Chat) => Number(words.length > 0 && words.every((w) => has(norm(w), c.title)))
  return [...chats].sort((a, b) => named(b) - named(a))
}

/** Rooms & people rows on the 전체 tab, and file rows (the team's, then the rooms'), at most: so the chat records stay
 * in sight on a 390 px phone */
export const NAMED_FEW = 3
export const FILES_FEW = 4
/** room files asked for at once (the 파일 tab shows them all) */
const ROOM_FILES_PAGE = 20
/** Where a room file found opens: the message it was sent with, in its room (a thread reply: in its thread). */
export const roomFileHref = (h: Pick<RoomFileSearchHit, 'messageId' | 'roomId' | 'threadRootId'>) => hitHref({ id: h.messageId, roomId: h.roomId, threadRootId: h.threadRootId })

/** The rooms and people whose name matches `q` (shared/src/search-text.ts nameMatch): rooms and DMs first (a DM stands
 * for its person, named as the room list names it), then people with no DM in the list (never me); in each, the best
 * first: the whole text at the start of the name, then inside it, then by words or initial consonants; when none
 * matches so, the names with a typing mistake in a word (the fewest first); rooms by their latest activity, people by
 * name. `title`: a room's name as the app shows it (rooms/RoomIcon.tsx useRoomTitle). */
export function roomsAndPeople(rooms: readonly Room[], people: readonly Person[], meId: string | undefined, q: string, title: (r: Room) => string, few = NAMED_FEW): ({ room: Room; name: string } | { person: Person; name: string })[] {
  if (!q.trim()) return []
  const found: { rank: number; at: string; name: string; item: { room: Room; name: string } | { person: Person; name: string } }[] = []
  const withDm = new Set<string>()
  for (const room of rooms) {
    if (room.kind === 'dm' && room.peers[0]) withDm.add(room.peers[0].id)
    const name = title(room)
    const rank = nameMatch(name, q)
    if (rank !== null) found.push({ rank, at: room.activityAt, name, item: { room, name } })
  }
  for (const person of people) {
    if (person.id === meId || withDm.has(person.id)) continue
    const rank = nameMatch(person.name, q)
    if (rank !== null) found.push({ rank, at: '', name: person.name, item: { person, name: person.name } })
  }
  // none: the names with every word as typed or with a typing mistake ("alcie kim" finds "Alice Kim"), the closest first
  // (shared/src/search-near.ts nearNames)
  const near = found.length ? null : nearNames(searchWords(q))
  if (near) {
    for (const room of rooms) {
      const name = title(room)
      const s = near(name)
      if (s !== null) found.push({ rank: 3 + s, at: room.activityAt, name, item: { room, name } })
    }
    for (const person of people) {
      if (person.id === meId || withDm.has(person.id)) continue
      const s = near(person.name)
      if (s !== null) found.push({ rank: 3 + s, at: '', name: person.name, item: { person, name: person.name } })
    }
  }
  const isPerson = (x: (typeof found)[number]) => Number('person' in x.item)
  return found.sort((a, b) => isPerson(a) - isPerson(b) || a.rank - b.rank || b.at.localeCompare(a.at) || a.name.localeCompare(b.name)).slice(0, few).map((x) => x.item)
}

/** How long a list Search read stays good for the next time it opens: a list read that recently shows as it is,
 * without asking the server again (the realtime changes that touch one mark it stale: store/listCache.ts). */
export const SEARCH_LIST_AGE_MS = 30_000

/** A list Search shows (store/listCache.ts): what this window last read at once, read again when it opens unless that
 * read is recent (`always`: read again on every open, for lists no realtime change marks stale: a task the AI made, a
 * connection added on another device); null while nothing was read yet, 'error' when it could not be read and nothing
 * was kept. */
function useList<T>(key: string, load: () => Promise<T>, o: { always?: boolean } = {}): T | null | 'error' {
  const { data, failed } = useCachedRead<T>(key, load, { minAgeMs: o.always ? undefined : SEARCH_LIST_AGE_MS })
  return data !== undefined ? data : failed ? 'error' : null
}
const readRecent = () => api.call(API.listChats, { query: { limit: 30 } }).then((p) => p.items)
const readRecentRoomFiles = () => api.call(API.recentRoomFiles)
const readProjects = () => api.call(API.listProjects).then((r) => r.items)
const ok = <T,>(v: T | null | 'error'): T | null => (v === 'error' ? null : v)

/** The project search was opened in (QA TC-421): a project's page (its files too) or a chat in a project; null anywhere
 * else; undefined while a chat that is in none of this window's lists is read. Where it was opened: opening a result
 * closes search. */
function useHereProject(): string | null | undefined {
  const { pathname } = useLocation()
  const [at] = useState(pathname)
  const page = matchPath('/projects/:projectId/*', at)?.params.projectId
  const chatId = (matchPath('/c/:chatId', at) ?? matchPath('/c/:chatId/t/:messageId', at))?.params.chatId
  const known = useChats((s) => (chatId ? s.chats.find((c) => c.id === chatId) ?? s.others[chatId] : undefined))
  const [read, setRead] = useState<string | null | undefined>(undefined)
  const missing = !!chatId && !known && !page
  useEffect(() => {
    if (!missing) return
    let live = true
    api.call(API.getChat, { params: { id: chatId! } }).then((c) => live && setRead(c.projectId), () => live && setRead(null))
    return () => {
      live = false
    }
  }, [missing, chatId])
  if (page) return page
  if (!chatId) return null
  return known ? known.projectId : read
}

const NO_CHATS: Chat[] = []
/** A "Needs attention" row's words in the colours of the 트리나 list's hover peek: your turn amber, a new answer accent */
const MARKER_TEXT: Record<MarkerKind, string> = { ask: 'text-warn', new: 'text-accent-text', running: 'text-faint' }
/** What a task's search may match besides its name: a task's own instruction. A template's prompt is the server's own
 *  and never shown, so it is not searched. */
const scheduleText = (s: Schedule) => (s.templateId ? '' : s.prompt)

/** The types the chips apply on (the ones that show room messages or room files) */
const CHIP_TYPES: readonly SearchType[] = ['all', 'rooms', 'files']
type Chip = 'here' | 'mine' | 'mentions'
const CHIP_LABEL: Record<Chip, MessageKey> = { here: 'search.chip.here', mine: 'search.chip.mine', mentions: 'search.chip.mentions' }
/** What the chips add to the text sent to the server: the typed filters themselves (shared/src/search-text.ts) */
const CHIP_TEXT: Record<Exclude<Chip, 'here'>, string> = { mine: 'from:me', mentions: 'mentions:me' }
/** Unread conversations in the empty search's "Needs attention", at most */
export const UNREAD_FEW = 3
/** The conversations with unread messages that empty search lists: not muted (끄기) or hidden ones, those that mention
 * me first, then the latest. */
export function unreadRooms<R extends Pick<Room, 'id' | 'unreadCount' | 'mentioned' | 'muted' | 'activityAt'> & Partial<Pick<Room, 'hidden'>>>(rooms: readonly R[], few = UNREAD_FEW): R[] {
  return rooms.filter((r) => r.unreadCount > 0 && !r.muted && !r.hidden)
    .sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || b.activityAt.localeCompare(a.activityAt))
    .slice(0, few)
}

function SearchBox({ scope, here, onClose, onPerson }: { scope: 'rooms' | null; here: string | null; onClose: () => void; onPerson: (userId: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const chatActions = useChatActions()
  const copyChatLink = useCopyChatLink()
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [tab, setTabState] = useState<SearchType>(scope ?? 'all')
  // the chips that are on, in the order they were turned on (Backspace in an empty box turns off the last); "This
  // conversation" is on when search opened in a room
  const [chips, setChips] = useState<Chip[]>(here ? ['here'] : [])
  const toggleChip = (c: Chip) => {
    setChips((xs) => (xs.includes(c) ? xs.filter((x) => x !== c) : [...xs, c]))
    setSel({ key: null, index: 0 })
  }
  // the highlighted row: by its key once arrows or the mouse chose one (results arriving above it do not move it), else
  // the row at `index` (the first; after 메시지 더 보기, where that row was, so the keys go on to the first new message)
  const [sel, setSel] = useState<{ key: string | null; index: number }>({ key: null, index: 0 })
  const [menu, setMenu] = useState<{ row: Row; top: number } | null>(null)
  // What the server answered, each with the words (`q`, as `key` below) it answered: used only while those are the
  // words in the box, so a result of an older text is never shown nor opened by Enter.
  // chats by title and content; a failure's words
  const [found, setFound] = useState<{ q: string; items: Chat[] } | null>(null)
  const [error, setError] = useState<{ q: string; text: string } | null>(null)
  // files whose name holds the text, and whether that search failed
  const [names, setNames] = useState<{ q: string; items: FileEntry[]; failed: boolean } | null>(null)
  // room messages that hold the text, the next page's cursor, whether that search failed; how many rows show
  const [hits, setHits] = useState<{ q: string; items: RoomSearchHit[]; rooms: Map<string, RoomSearchRoom>; next: string | null; failed: boolean; near?: boolean; filters?: RoomSearchFilters } | null>(null)
  // messages: the best match first (as Slack's "Most relevant"), or the newest first
  const [sort, setSort] = useState<RoomSearchSort>('relevant')
  const [hitsShown, setHitsShown] = useState(MESSAGES_FEW)
  const [hitsMore, setHitsMore] = useState(false)
  // files sent in rooms whose name holds the text, and whether that search failed
  const [roomFiles, setRoomFiles] = useState<{ q: string; items: RoomFileSearchHit[]; rooms: Map<string, RoomSearchRoom>; failed: boolean; filters?: RoomSearchFilters } | null>(null)
  // another text or type: back to the first row
  const setTab = (x: SearchType | ((x: SearchType) => SearchType)) => {
    setTabState(x)
    setSel({ key: null, index: 0 })
  }
  // Esc closes an open row menu first, then the dialog
  useFocusTrap(ref, true, () => (menu ? closeMenu() : onClose()))

  const recent = useList('search:recent', readRecent)
  // the newest files of my rooms, read on every open (a file sent a moment ago is the one looked for). What was kept
  // shows while it is read, never once that read failed (the kept rows may be of a room I am no longer in), and only the
  // rows of rooms in my list now (a room I left or was taken out of: store/rooms.ts drops its rows too)
  const recentRead = useCachedRead<RecentRoomFiles>(RECENT_ROOM_FILES, readRecentRoomFiles)
  const recentFiles = recentRead.failed ? null : recentRead.data ?? null
  const me = useMe()
  // the project list as Search last read it, with each project's name as this window knows it now (a rename here)
  const projectsRead = useList('search:projects', readProjects)
  const projectsById = useProjects((s) => s.byId)
  const projects = useMemo(() => (Array.isArray(projectsRead) ? projectsRead.map((p) => projectsById[p.id] ?? p) : projectsRead), [projectsRead, projectsById])
  const skills = useList<Skill[]>(SHARED.skills, readSkillList)
  const scheduleList = useList(SHARED.schedules, readSchedules, { always: true })
  const schedules = useMemo(() => (scheduleList && scheduleList !== 'error' ? scheduleList.items : scheduleList), [scheduleList])
  const mcp = useList(SHARED.integrations, readIntegrations, { always: true })
  // the window's own unread count (the rail's), not a read of its own
  const unread = useInboxUnread()
  const admin = isAdmin(useMe())
  // a free-roam demo: no Invite people or Scheduled actions (server/src/demo/guard.ts refuses both)
  const freeRoam = useFreeRoam()
  const guest = isGuestMe(useMe())
  const guestFolder = useGuestFolderHref()
  // a file's, a skill's and a project's folder in words ("My files › 공문"), never the disk path (QA TC-8922)
  const teamPlace = useTeamPlace()
  const place = (p: string) => (p ? teamPlace(p) : '')
  const guestHasProject = !!meGuest(useMe())?.project
  const guestAiOff = useGuestAiOff()
  const meId = useMe()?.user.id
  // rooms & people: my rooms list and the team's people, as the app has them (read now if no screen has yet)
  const myRooms = useRooms((s) => s.rooms)
  const roomsLoaded = useRooms((s) => s.loaded)
  useEffect(() => {
    if (!useRooms.getState().loaded) void useRooms.getState().loadRooms()
  }, [])
  const people = usePeopleList()
  const roomTitle = useRoomTitle()
  const where = useWhere()
  // the messages' order, above the results when messages are found (the dialog keeps the keys in the box)
  const sortMenu = useMemo(() => (
    <MenuButton
      label={`${t('search.sort')}: ${t(sort === 'relevant' ? 'search.sortRelevant' : 'search.sortRecent')}`}
      heading={t('search.sort')}
      compact
      testId="search-sort"
      buttonClassName="gap-1 px-2! py-0.5! text-xs"
      focusBack={() => inputRef.current?.focus()}
      icon={<>{t(sort === 'relevant' ? 'search.sortRelevant' : 'search.sortRecent')}<ChevronDown size={12} aria-hidden /></>}
      items={(['relevant', 'recent'] as const).map((x) => ({ label: t(x === 'relevant' ? 'search.sortRelevant' : 'search.sortRecent'), checked: sort === x, onSelect: () => { setSort(x); inputRef.current?.focus() }, testId: `search-sort-${x}` }))}
    />
  ), [sort, t])
  // "Needs attention": the 트리나 list's own chats and markers (one source: the same rows, the same rule, the same view)
  const listed = useChats((s) => s.chats)
  const listLoaded = useChats((s) => s.chatsLoaded)
  const requests = useChats((s) => s.requests)
  const onScreen = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  // opened in a project: its chats first in History (the project page's own list), then the rest
  const hereProject = useHereProject()
  const [projectChats, setProjectChats] = useState<{ id: string; items: Chat[] } | null>(null)
  useEffect(() => {
    if (!hereProject) return
    let live = true
    api.call(API.listChats, { query: { projectId: hereProject, limit: 30 } }).then(
      (p) => live && setProjectChats({ id: hereProject, items: p.items }),
      () => live && setProjectChats({ id: hereProject, items: [] }),
    )
    return () => {
      live = false
    }
  }, [hereProject])
  // null while that is not known yet (History waits for it rather than reordering under the pointer)
  const projectFirst = hereProject === undefined ? null : hereProject ? (projectChats?.id === hereProject ? projectChats.items : null) : NO_CHATS

  const query = norm(q.trim())
  const words = useMemo(() => searchWords(query), [query])
  // the chips, where they apply: the text sent for room messages and files (the typed text and each chip's filter), and
  // the room of "This conversation"
  const chipsShown = CHIP_TYPES.includes(tab)
  const chipsOn = chipsShown ? chips : []
  const room = here && chipsOn.includes('here') ? here : undefined
  const sent = [q.trim(), ...chipsOn.filter((c): c is Exclude<Chip, 'here'> => c !== 'here').map((c) => CHIP_TEXT[c])].filter(Boolean).join(' ')
  // the room messages' and room files' own reading of the text (shared/src/search-text.ts parseSearch): from:, in: and
  // mentions:, "quoted phrases", each word by its part without a Korean particle or an English ending (what is marked
  // in their rows)
  const parts = useMemo(() => parseSearch(norm(sent)), [sent])
  // what their rows mark: every form a word is found by (a Korean verb's other forms too: "만든" marks "만들었어요")
  const terms = useMemo(() => parts.forms.flat(), [parts])
  // from:, in:, mentions: in the text or a chip on: only the rooms' messages and files are searched (nothing else has a
  // sender or a room)
  const filtered = parts.from.length > 0 || parts.in.length > 0 || parts.mentions.length > 0 || !!room
  // What the server's answers are kept by: the words as the server reads them (searchWords), with only the letters it
  // takes in any case folded, so a space more or such a letter in another case asks nothing again and shows what is
  // there, and nothing else is taken for the same search. Chats, room messages and room files: LIKE, A–Z only ("Été" and
  // "été" are two searches). Team file names: every letter (team-files/find.ts).
  const key = useMemo(() => `${searchWords(sent).map(foldAZ).join(' ')}${room ? ` room=${room}` : ''}`, [sent, room])
  const namesKey = useMemo(() => searchWords(q.trim()).map((w) => w.toLowerCase()).join(' '), [q])
  // the server's answers to the text in the box now (null: none yet)
  const foundNow = found?.q === key ? found.items : null
  const errorNow = error?.q === key ? error.text : null
  const namesNow = names?.q === namesKey ? names : null
  const hitsKey = `${sort}:${key}`
  // a change of order keeps the other order's messages in sight until its own answer comes (nothing jumps under the menu)
  const hitsFresh = hits?.q === hitsKey
  const hitsNow = hitsFresh || (hits && hits.q.slice(hits.q.indexOf(':') + 1) === key) ? hits : null
  const roomFilesNow = roomFiles?.q === key ? roomFiles : null
  // chats by title and content, on the server
  useEffect(() => {
    if (!query || filtered) return
    let live = true
    const ctrl = new AbortController()
    const asked = key
    const timer = setTimeout(async () => {
      try {
        const page = await api.call(API.listChats, { query: { q: q.trim(), limit: 30 }, signal: ctrl.signal })
        if (live) setFound({ q: asked, items: page.items })
      } catch (e) {
        if (live && !ctrl.signal.aborted) setError({ q: asked, text: errorText(e, locale, t('error.network')) })
      }
    }, 200)
    return () => {
      live = false
      ctrl.abort()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, filtered])
  // files by name, on the server, only where file rows are shown: the team's files and the files sent in my rooms
  const wantNames = !!sent && (tab === 'all' || tab === 'files')
  useEffect(() => {
    if (!wantNames || filtered) return
    let live = true
    const ctrl = new AbortController()
    const asked = namesKey
    const timer = setTimeout(() => {
      api.call(API.findFiles, { query: { q: q.trim(), path: '', limit: 30, folders: '1' }, signal: ctrl.signal }).then(
        (r) => live && setNames({ q: asked, items: r.items, failed: false }),
        () => live && !ctrl.signal.aborted && setNames({ q: asked, items: [], failed: true }),
      )
    }, 200)
    return () => {
      live = false
      ctrl.abort()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey, wantNames, filtered])
  useEffect(() => {
    if (!wantNames) return
    let live = true
    const ctrl = new AbortController()
    const asked = key
    const timer = setTimeout(() => {
      api.call(API.searchRoomFiles, { query: { q: sent, limit: ROOM_FILES_PAGE, ...(room ? { room } : {}) }, signal: ctrl.signal }).then(
        (r) => live && setRoomFiles({ q: asked, items: r.items, rooms: new Map(r.rooms.map((x) => [x.id, x])), failed: false, filters: r.filters }),
        () => live && !ctrl.signal.aborted && setRoomFiles({ q: asked, items: [], rooms: new Map(), failed: true }),
      )
    }, 200)
    return () => {
      live = false
      ctrl.abort()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wantNames])

  // room messages, on the server, only on the 전체 and 대화 tabs
  const wantMessages = !!sent && (tab === 'all' || tab === 'rooms')
  useEffect(() => {
    setHitsShown(MESSAGES_FEW)
    setHitsMore(false)
    if (!wantMessages) return
    let live = true
    const ctrl = new AbortController()
    const asked = hitsKey
    const timer = setTimeout(() => {
      api.call(API.searchRoomMessages, { query: { q: sent, limit: MESSAGES_PAGE, sort, ...(room ? { room } : {}) }, signal: ctrl.signal }).then(
        (r) => live && setHits({ q: asked, items: r.items, rooms: new Map(r.rooms.map((x) => [x.id, x])), next: r.nextCursor, failed: false, near: r.near, filters: r.filters }),
        () => live && !ctrl.signal.aborted && setHits({ q: asked, items: [], rooms: new Map(), next: null, failed: true }),
      )
    }, 200)
    return () => {
      live = false
      ctrl.abort()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hitsKey, wantMessages])
  /** 메시지 더 보기: more of what is here, and the next page when that runs out (kept only for the same text) */
  const moreHits = () => {
    if (!hitsNow || !hitsFresh) return
    const want = hitsShown + MESSAGES_PAGE
    setHitsShown(want)
    if (want <= hitsNow.items.length || !hitsNow.next || hitsMore) return
    setHitsMore(true)
    const asked = hitsKey
    api.call(API.searchRoomMessages, { query: { q: sent, limit: MESSAGES_PAGE, cursor: hitsNow.next, sort, ...(room ? { room } : {}) } }).then(
      (r) => {
        setHits((h) => (h?.q === asked ? { ...h, items: [...h.items, ...r.items.filter((x) => !h.items.some((y) => y.id === x.id))], rooms: new Map([...h.rooms, ...r.rooms.map((x) => [x.id, x] as const)]), next: r.nextCursor } : h))
        setHitsMore(false)
      },
      () => {
        setHits((h) => (h?.q === asked ? { ...h, failed: true } : h))
        setHitsMore(false)
      },
    )
  }

  const projectName = useMemo(() => new Map((ok(projects) ?? []).map((p) => [p.id, p.name])), [projects])
  const chatRow = (c: Chat): Row => ({
    key: `chat:${c.id}`, kind: 'chat', icon: MessageSquare, title: c.title || t('chat.untitled'), href: `/c/${c.id}`, chat: c,
    sub: c.projectId ? projectName.get(c.projectId) : undefined, match: true,
  })
  /** A History row (the list and search results): when it was last active and its project, grey on the right (QA TC-420) */
  const historyRow = (c: Chat): Row => ({
    ...chatRow(c), sub: undefined,
    meta: [formatRelative(c.updatedAt, locale), c.projectId ? projectName.get(c.projectId) : undefined].filter(Boolean).join(' · '),
  })
  /** A "Needs attention" chat: the 트리나 list's marker and its words (the AI's question itself when this window has its card,
   * never for a confidential chat), as that list's row and hover peek say them (QA TC-419) */
  const markedRow = (c: Chat, marker: Marker): Row => ({
    ...chatRow(c), attention: true, marker,
    sub: reasonText(marker.reason, t, marker.reason === 'card' && !c.confidential ? cardQuestion(requests, c.id) : undefined),
  })
  const projectRow = (p: Project): Row => ({ key: `project:${p.id}`, kind: 'project', icon: FolderKanban, title: p.name, sub: place(p.folderPath), href: `/projects/${p.id}`, match: true })
  const skillRow = (s: Skill): Row => ({ key: `skill:${s.path}`, kind: 'skill', icon: BookMarked, title: skillTitle(s), sub: place(parentOf(s.path)), href: skillFileLink(s.path), match: true })
  /** A task's name as the Scheduled page shows it. When the typed text is only in its instruction (hidden in the list),
   *  the second part shows that part of the instruction, highlighted, so the row does not look like a wrong result. */
  const scheduleRow = (s: Schedule, attention?: string): Row => {
    const title = scheduleName(s, t)
    const inInstruction = !attention && !!query && !has(query, title) ? snippetAround(scheduleText(s), query) : ''
    return {
      key: `schedule:${s.id}`, kind: 'schedule', icon: CalendarClock, title, href: `/scheduled/${encodeURIComponent(s.id)}`, match: true,
      sub: attention ?? (inInstruction ? t('search.inInstruction', { text: inInstruction }) : s.projectId ? projectName.get(s.projectId) : undefined),
      subMatch: !!inInstruction, attention: !!attention,
    }
  }
  const mcpRow = (i: Integration, attention?: string): Row => ({
    key: `mcp:${i.id}`, kind: 'mcp', icon: Cable, title: i.name, href: i.scope === 'personal' ? connectionHref(i.id) : CONNECTORS_HOME, match: true,
    sub: attention ?? (i.scope === 'team' ? t('search.team') : undefined), attention: !!attention,
  })
  // a guest has no 파일 screen (/files goes Home): a folder or file of their project opens its files screen (lib/guests.ts
  // guestFolderHref); one no screen of theirs lists is not offered
  const fileNameRow = (f: FileEntry): Row | null => {
    const href = !guestFolder ? (f.type === 'folder' ? `/files?path=${encodeURIComponent(f.path)}` : skillFileLink(f.path))
      : f.type === 'folder' ? guestFolder(f.path) : guestFolder(parentOf(f.path), f.path)
    const row = { key: `file:${f.path}`, kind: 'file' as const, icon: f.type === 'folder' ? Folder : FileIcon, title: f.name, sub: place(parentOf(f.path)), match: true }
    // a guest's file no screen of theirs lists (their own folder): it opens in the preview, as their AI's links do
    if (!href && guestFolder && f.type !== 'folder') return { ...row, href: '', after: () => openTeamFile(f.path) }
    return href ? { ...row, href } : null
  }
  const filesRow = (): Row => ({ key: 'files', kind: 'file', icon: FileSearch, title: t('search.inFiles', { q: q.trim() }), href: `/files?q=${encodeURIComponent(q.trim())}` })
  const messageRow = (h: RoomSearchHit): Row => ({ key: `message:${h.id}`, kind: 'message', icon: MessageSquare, title: h.snippet, href: hitHref(h), hit: { hit: h, room: hitsNow?.rooms.get(h.roomId) } })
  const moreMessagesRow = (): Row => ({ key: 'messages:more', kind: 'message', icon: ChevronDown, title: t('search.moreMessages'), href: '', run: moreHits })
  // a room (a DM: its person) opens; a person with no DM opens the new-DM list with them ticked (nothing is made until
  // they press its button: a DM made from here would show at once in the other person's list)
  const roomRow = (room: Room, name: string): Row => ({ key: `room:${room.id}`, kind: 'room', icon: MessageSquare, title: name, href: `/rooms/${room.id}`, match: true, face: { room } })
  const personRow = (p: Person): Row => ({
    key: `person:${p.id}`, kind: 'person', icon: MessageSquare, title: p.name, sub: p.title, href: '', match: true, face: { person: p }, after: () => onPerson(p.id),
  })
  /** a file sent in a room (RoomFileHit draws it): it opens the message it was sent with */
  const roomFileRow = (h: RoomFileSearchHit): Row => ({
    key: `roomfile:${h.file.id}`, kind: 'file', icon: h.file.kind === 'image' ? ImageIcon : FileIcon, title: h.file.name, href: roomFileHref(h), match: true,
    roomFile: { hit: h, room: roomFilesNow?.rooms.get(h.roomId) },
  })
  /** a recent file of my rooms (before anything is typed): it opens in the file viewer, as its chip in the room does */
  const recentFileRow = (h: RoomFileSearchHit, rooms: readonly RoomSearchRoom[]): Row => ({
    key: `recentfile:${h.file.id}`, kind: 'file', icon: h.file.kind === 'image' ? ImageIcon : FileIcon, title: h.file.name, href: '',
    roomFile: { hit: h, room: rooms.find((r) => r.id === h.roomId) },
    after: () => {
      const item = roomFileItem(h.roomId, h.file, me, { ...(h.author ? { sender: { kind: 'user' as const, user: h.author } } : {}), at: h.createdAt, messageId: h.messageId, rootId: h.threadRootId ?? h.messageId })
      openImageViewer({ group: null, entry: { item, el: null }, opener: null, openerKey: item.key })
    },
  })

  const actions: Row[] = useMemo(() => {
    const list: Row[] = [
      { key: 'act:chat', kind: 'action', icon: AskAi, title: t('sidebar.askAi', { name: aiName(t) }), href: newChatPath() },
      // a guest makes no projects or scheduled tasks and has no Files page (components/GuestView.tsx)
      ...(guest ? [] : [
        { key: 'act:project', kind: 'action' as const, icon: FolderPlus, title: t('projects.new'), href: '/projects?new=1' },
        ...(freeRoam ? [] : [{ key: 'act:schedule', kind: 'action' as const, icon: CalendarPlus, title: t('search.newScheduled'), href: '/scheduled' }]),
      ]),
    ]
    const m = ok(mcp)
    // Settings › Connectors for everyone (it has no item in the rail or its panels): owners and admins who may add their own go straight to
    // the add-by-address form; everyone else to the list of what they can connect (the Google apps also when members
    // may not add their own). "MCP", "Connectors" and "Settings" find it.
    if (m) list.push({ key: 'act:mcp', kind: 'action', icon: Plus, title: t('search.addMcp'), href: admin && m.personalAllowed ? `${CONNECTORS_HOME}?add=1` : CONNECTORS_HOME, terms: `MCP ${t('integrations.title')} ${t('settings.title')}` })
    if (!guest) list.push({ key: 'act:files', kind: 'action', icon: FolderOpen, title: t('search.openFiles'), href: '/files', terms: t('files.root') })
    // my own files in conversations, largest first, to tidy (guests too: pages/SentFiles.tsx)
    list.push({ key: 'act:sentFiles', kind: 'action', icon: Paperclip, title: t('sentFiles.title'), href: '/sent-files', terms: `${t('search.tab.files')} ${t('rooms.title')}`, typed: true })
    // 모든 프로젝트 and Usage (in Settings) are found here too
    list.push(
      { key: 'act:projects', kind: 'action', icon: FolderKanban, title: t('sidebar.projects'), href: '/projects', typed: true },
      ...(freeRoam ? [] : [{ key: 'act:usage', kind: 'action' as const, icon: Gauge, title: t('sidebar.usage'), href: '/settings/usage', terms: t('settings.title'), typed: true }]),
    )
    // the inbox lives in Settings > Notifications; unread notifications show as a count and an attention dot
    const n = unread
    list.push({
      key: 'act:inbox', kind: 'action', icon: Bell, title: t('inbox.open'), href: '/activity', terms: `${t('inbox.title')} ${t('notifications.title')}`,
      sub: n > 0 ? t('notifications.unread', { count: n }) : undefined, attention: n > 0,
    })
    // the team menu's items (owners and admins), found by their words: "Invite teammates", "Members & invites" too
    if (admin && !freeRoam)
      list.push(
        { key: 'act:invite', kind: 'action', icon: UserPlus, title: t('teamMenu.invite'), href: '', terms: `${t('goal.invite')} ${t('admin.members')}`, typed: true, after: () => void openTeamInvite(navigate, null) },
        { key: 'act:admin', kind: 'action', icon: Shield, title: t('sidebar.admin'), href: '/admin', terms: `${t('admin.title')} ${t('admin.members')} ${t('admin.settings')}`, typed: true },
      )
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcp, unread, locale, admin, guest, freeRoam])

  const sections: Section[] = useMemo(() => {
    const chats = ok(recent) ?? []
    const allProjects = ok(projects) ?? []
    const allSkills = ok(skills) ?? []
    const allSchedules = ok(schedules) ?? []
    const allMcp = ok(mcp)?.items ?? []
    const out: Section[] = []
    const push = (id: string, label: string, rows: Row[]) => rows.length && out.push({ id, label, rows })
    const recentFileRows = () => {
      if (!recentFiles) return []
      const mine = roomsLoaded ? new Set(myRooms.map((r) => r.id)) : null
      return recentFiles.items.filter((h) => !mine || mine.has(h.roomId)).map((h) => recentFileRow(h, recentFiles.rooms))
    }
    // the messages found: "Close matches" when nothing matched as typed; what from: and in: were read as
    const pushMessages = () => {
      if (!hitsNow) return
      const f = hitsNow.filters
      // what a chip that is on says already is not said again (only what was typed)
      const fromMeOnly = chipsOn.includes('mine') && parts.from.length === 1
      const label = hitsNow.near ? t('search.messagesNear') : [
        t('search.messages'),
        ...(f?.from.length && !fromMeOnly ? [t('search.fromWho', { name: f.from.map((p) => p.name).join(', ') })] : []),
        ...(f?.in.length ? [t('search.inWhere', { room: f.in.map((r) => where(r, undefined)).join(', ') })] : []),
        ...(f?.mentions && !chipsOn.includes('mentions') ? [t('search.mentionsYou')] : []),
      ].join(' · ')
      push('messages', label, [...hitsNow.items.slice(0, hitsShown).map(messageRow), ...(hitsShown < hitsNow.items.length || hitsNow.next ? [moreMessagesRow()] : [])])
    }
    const typeLabel = (x: SearchType) => t(TAB_LABEL[x])

    if (!sent) {
      // "This conversation" with no text: nothing is asked (a hint says to type)
      if (room) return out
      if (tab === 'all') {
        const attention: Row[] = [
          ...markedChats(listLoaded ? listed : chats, { here: onScreen, cards: cardChats(requests) }).map((x) => markedRow(x.chat, x.marker)),
          // conversations with unread messages, as the 대화 list marks them (mentions first)
          ...unreadRooms(myRooms).map((r) => ({ ...roomRow(r, roomTitle(r)), key: `unread:${r.id}`, match: false, attention: true, sub: t('rooms.unread', { n: r.unreadCount }) })),
          ...allSchedules.filter((s) => s.needsReview).map((s) => scheduleRow(s, t('search.attn.review'))),
          // an app on a computer checked from elsewhere is not a fault (lib/integrations.ts awayFromComputer)
          ...allMcp.filter((i) => i.status !== 'connected' && !awayFromComputer(i)).map((i) => mcpRow(i, t(i.status === 'needs_auth' ? 'search.attn.signIn' : 'search.attn.error'))),
        ].slice(0, 5)
        push('attention', t('search.attention'), attention)
        const busy = new Set(attention.map((r) => r.key))
        const mixed = [
          // the newest by date: the list's first page starts with my pinned chats (docs/DECISIONS.md "Pinned chats")
          ...[...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map((c) => ({ at: c.updatedAt, row: chatRow(c) })),
          ...[...allProjects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 2).map((p) => ({ at: p.createdAt, row: projectRow(p) })),
        ]
          .filter((x) => !busy.has(x.row.key))
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, 6)
          .map((x) => x.row)
        push('recents', t('search.recents'), mixed)
        push('recentFiles', t('search.recentFiles'), recentFileRows())
        push('actions', t('search.actions'), actions.filter((a) => !a.typed))
      } else if (tab === 'chats') {
        // opened in a project: its chats first (once they are here), then the rest of my list
        if (projectFirst) {
          const first = new Set(projectFirst.map((c) => c.id))
          push('chats', typeLabel('chats'), [...projectFirst, ...chats.filter((c) => !first.has(c.id))].map(historyRow))
        }
      }
      else if (tab === 'projects') push('projects', typeLabel('projects'), allProjects.map(projectRow))
      else if (tab === 'skills') push('skills', typeLabel('skills'), allSkills.map(skillRow))
      else if (tab === 'scheduled') push('scheduled', typeLabel('scheduled'), allSchedules.map((s) => scheduleRow(s)))
      else if (tab === 'mcp') push('mcp', typeLabel('mcp'), allMcp.map((i) => mcpRow(i)))
      else if (tab === 'files') {
        push('recentFiles', t('search.recentFiles'), recentFileRows())
        push('files', typeLabel('files'), actions.filter((a) => a.key === 'act:files' || a.key === 'act:sentFiles'))
      }
      // 대화: my rooms as the 대화 list has them (pinned first), to jump to one
      else if (tab === 'rooms') push('rooms', typeLabel('rooms'), pinnedFirst(shownInLists(myRooms)).slice(0, ROOMS_FEW).map((r) => roomRow(r, roomTitle(r))))
      return out
    }
    if (tab === 'rooms') {
      if (!filtered) push('people', t('search.roomsPeople'), roomsAndPeople(myRooms, people ?? [], meId, query, roomTitle, ROOMS_FEW).map((x) => ('room' in x ? roomRow(x.room, x.name) : personRow(x.person))))
      pushMessages()
      // "Files you sent" is the conversations' too: found here by its words
      push('actions', t('search.actions'), actions.filter((a) => a.key === 'act:sentFiles' && has(query, a.title, a.terms)))
      return out
    }

    const few = tab === 'all' ? 4 : 50
    // from: or in: in the text: the rooms' messages and files only
    if (filtered) {
      if (tab === 'all') pushMessages()
      if (tab === 'all' || tab === 'files') push('files', typeLabel('files'), (roomFilesNow?.items ?? []).map(roomFileRow).slice(0, tab === 'all' ? FILES_FEW : undefined))
      return out
    }
    // a name jump first, matched here in the lists the app has (they may load a moment after the text)
    if (tab === 'all') push('people', t('search.roomsPeople'), roomsAndPeople(myRooms, people ?? [], meId, query, roomTitle).map((x) => ('room' in x ? roomRow(x.room, x.name) : personRow(x.person))))
    if (tab === 'all' || tab === 'chats') push('chats', typeLabel('chats'), titleFirst(foundNow ?? [], words).slice(0, tab === 'all' ? 5 : 30).map(historyRow))
    if (tab === 'all') pushMessages()
    if (tab === 'all' || tab === 'projects') push('projects', typeLabel('projects'), allProjects.filter((p) => has(query, p.name, p.folderPath)).slice(0, few).map(projectRow))
    if (!guest && (tab === 'all' || tab === 'skills')) push('skills', typeLabel('skills'), allSkills.filter((s) => has(query, s.name, s.title, s.description)).slice(0, few).map(skillRow))
    if (!guest && !freeRoam && (tab === 'all' || tab === 'scheduled')) push('scheduled', typeLabel('scheduled'), allSchedules.filter((s) => has(query, scheduleName(s, t), scheduleText(s))).slice(0, few).map((s) => scheduleRow(s)))
    if (!guest && (tab === 'all' || tab === 'mcp')) push('mcp', typeLabel('mcp'), allMcp.filter((i) => has(query, i.name, i.url)).slice(0, few).map((i) => mcpRow(i)))
    // the team's files by name, then the files sent in my rooms: 4 in all on 전체
    if (tab === 'all' || tab === 'files')
      push('files', typeLabel('files'), [
        ...[...(namesNow?.items ?? []).slice(0, 30).map(fileNameRow).filter((r): r is Row => r !== null), ...(roomFilesNow?.items ?? []).map(roomFileRow)].slice(0, tab === 'all' ? FILES_FEW : undefined),
        // the 파일 screen's search: not a guest's (/files goes Home for them)
        ...(contentQueryReady(q) && !guestFolder ? [filesRow()] : []),
      ])
    if (tab === 'all') push('actions', t('search.actions'), actions.filter((a) => has(query, a.title, a.terms)))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sent, room, chips, chipsShown, parts, tab, recent, projects, skills, schedules, mcp, foundNow, namesNow, hitsNow, roomFilesNow, hitsShown, hitsMore, actions, locale, myRooms, people, meId, roomTitle, listed, listLoaded, requests, onScreen, projectFirst, guestFolder, guest, filtered, where, freeRoam, recentFiles, roomsLoaded, me])

  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections])
  const chosen = sel.key === null ? -1 : rows.findIndex((r) => r.key === sel.key)
  const activeIndex = chosen >= 0 ? chosen : Math.min(sel.index, rows.length - 1)
  const active = rows[activeIndex]
  const choose = (i: number) => setSel({ key: rows[i]?.key ?? null, index: i })
  /** the row drawn as highlighted: the one Enter opens; on a phone only once a finger or a key chose it (the first
   * row lit on its own reads as already tapped) */
  const lit = (r: Row) => r === active && (!phone || sel.key !== null)
  useEffect(() => {
    if (active) listRef.current?.querySelector(`[data-key="${CSS.escape(active.key)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const go = (r: Row) => {
    if (r.run) {
      // done in place (메시지 더 보기): the keys stay with the box, as after choosing a tab, and the highlight stays where
      // the row was, on the first message it brings
      setSel({ key: null, index: rows.indexOf(r) })
      r.run()
      inputRef.current?.focus()
      return
    }
    onClose()
    if (r.after) r.after()
    else navigate(r.href)
  }
  const closeMenu = () => {
    setMenu(null)
    inputRef.current?.focus()
  }
  const openMenu = (r: Row) => {
    if (!r.chat) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(r.key)}"]`)
    const box = ref.current?.getBoundingClientRect()
    const at = el?.getBoundingClientRect()
    setMenu({ row: r, top: at && box ? at.bottom - box.top : 0 })
  }
  // a phone (below 768px): the types as one picker ("전체 ⌄") that opens a sheet, a chat row's "⋯" (44px, on every chat
  // row) or a long press on it opens its actions as a sheet, and no row is lit before a finger or a key chose one
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [typeAsk, setTypeAsk] = useState(0)
  const typeButton = useRef<HTMLButtonElement>(null)
  // `long`: a long press opened it (the finger lifting is no tap on the sheet: MenuButton's openSignal), else the "⋯"
  // (openRequest); `n`: a new sheet each time
  const [sheet, setSheet] = useState<{ row: Row; n: number; long: boolean } | null>(null)
  const openSheet = (r: Row, long = false) => setSheet((x) => ({ row: r, n: (x?.n ?? 0) + 1, long }))
  const pressed = useRef<Row | null>(null)
  const longAt = useRef(0)
  const longPress = useLongPress(() => {
    if (!pressed.current) return
    longAt.current = Date.now()
    openSheet(pressed.current, true)
  })
  const press = (r: Row) => (phone && r.chat ? { ...longPress, onPointerDown: (e: React.PointerEvent) => { pressed.current = r; longPress.onPointerDown(e) } } : {})
  // the type tabs scroll sideways on a narrow window: fade the cut edge, and bring the chosen one into view (arrow keys
  // at the ends of the text choose another)
  const tabRow = useRef<HTMLDivElement>(null)
  useEdgeFade(tabRow)
  const chipRow = useRef<HTMLDivElement>(null)
  useEdgeFade(chipRow)
  useEffect(() => {
    const row = tabRow.current
    if (!row || row.scrollWidth <= row.clientWidth) return
    row.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])
  // a guest: only what they can reach (no team skills, scheduled tasks or services; 프로젝트 only with a project, 기록
  // only with AI): docs/DECISIONS.md "Search results and Open in Files for guests"
  const types = guest ? SEARCH_TYPES.filter((x) => x === 'all' || x === 'rooms' || x === 'files' || (x === 'projects' && guestHasProject) || (x === 'chats' && !guestAiOff)) : freeRoam ? SEARCH_TYPES.filter((x) => x !== 'scheduled') : SEARCH_TYPES
  const moveTab = (d: 1 | -1) => setTab((x) => types[(Math.max(0, types.indexOf(x)) + d + types.length) % types.length]!)
  // a from:/in: that named nobody or none of my conversations (the messages' answer, or the room files' on 파일)
  const missingFilters = (wantMessages ? hitsNow?.filters : wantNames ? roomFilesNow?.filters : undefined)?.missing
  const loading = (tab === 'all' && !!sent && (((foundNow === null && !errorNow) && !filtered) || (wantMessages && hitsNow === null))) || (tab === 'rooms' && wantMessages && hitsNow === null) || (tab === 'chats' && (query ? foundNow === null && !errorNow && !filtered : recent === null || projectFirst === null)) || (tab === 'projects' && projects === null) || (tab === 'skills' && skills === null) || (tab === 'scheduled' && schedules === null) || (tab === 'mcp' && mcp === null) || (tab === 'files' && wantNames && ((namesNow === null && !filtered) || roomFilesNow === null))
  const failed = (tab === 'projects' && projects === 'error') || (tab === 'skills' && skills === 'error') || (tab === 'scheduled' && schedules === 'error') || (tab === 'mcp' && mcp === 'error') || (tab === 'chats' && !query && recent === 'error')

  // the first match of every word, marked (a room message or file: of each term, parseSearch)
  const mark = (text: string, by: readonly string[] = words): ReactNode => {
    const spans = wordSpans(text, by.map(norm))
    if (!spans.length) return text
    const out: ReactNode[] = []
    let at = 0
    for (const [from, to] of spans) {
      out.push(text.slice(at, from), <mark key={from} className="rounded-sm bg-accent/20 text-inherit">{text.slice(from, to)}</mark>)
      at = to
    }
    out.push(text.slice(at))
    return <>{out}</>
  }
  const optId = (r: Row) => `sr-${r.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`

  return (
    // phones: the whole screen, ending on the keyboard (lib/viewport.ts --kb-inset), so the last results scroll into sight
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 max-sm:bottom-[var(--kb-inset,0px)] sm:p-4 sm:pt-[10vh]" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t('search.title')}
        data-testid="search-palette"
        className="relative flex h-full w-full flex-col overflow-hidden bg-surface pt-[var(--safe-top)] pb-[var(--safe-bottom)] shadow-2xl sm:h-auto sm:pt-0 sm:pb-0 sm:max-h-[80vh] sm:max-w-2xl sm:rounded-2xl sm:border sm:border-line"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-4 pb-2">
          <input
            ref={inputRef}
            data-autofocus
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            aria-controls="search-results"
            aria-activedescendant={active ? optId(active) : undefined}
            aria-label={t('search.title')}
            aria-describedby={chipsShown ? 'search-chips' : undefined}
            className="h-10 min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-faint"
            placeholder={tab === 'rooms' ? t('search.placeholderRooms') : t('search.placeholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setSel({ key: null, index: 0 })
              setMenu(null)
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              const input = e.currentTarget
              if (e.key === 'Backspace' && !input.value && chipsOn.length) {
                // an empty box: the last chip turned on goes off, as in Slack
                e.preventDefault()
                toggleChip(chipsOn.at(-1)!)
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setMenu(null)
                if (rows.length) choose(e.key === 'ArrowDown' ? Math.min(rows.length - 1, activeIndex + 1) : Math.max(0, activeIndex - 1))
              } else if (e.key === 'Enter' && e.altKey) {
                e.preventDefault()
                if (active?.chat) (menu ? closeMenu() : openMenu(active))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (active) go(active)
              } else if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && input.selectionStart === input.selectionEnd) {
                // ← at the start or → at the end of the text changes the type; elsewhere the caret moves as usual
                if (e.key === 'ArrowRight' && input.selectionEnd === input.value.length) {
                  e.preventDefault()
                  moveTab(1)
                } else if (e.key === 'ArrowLeft' && input.selectionStart === 0) {
                  e.preventDefault()
                  moveTab(-1)
                }
              }
            }}
          />
          <Tooltip label={t('search.close')}>
            <button type="button" onClick={onClose} aria-label={t('search.close')} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-hover hover:text-text">
              <X size={18} aria-hidden />
            </button>
          </Tooltip>
        </div>
        {/* the chips: toggle buttons (aria-pressed), never part of the results' listbox; one row that scrolls sideways */}
        {chipsShown && (
          <div ref={chipRow} id="search-chips" role="group" aria-label={t('search.chips')} className="scroll-thin edge-fade flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-2" data-testid="search-chips">
            {(['here', 'mine', 'mentions'] as const).filter((c) => c !== 'here' || here).map((c) => {
              const on = chips.includes(c)
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  data-testid={`search-chip-${c}`}
                  onClick={() => {
                    toggleChip(c)
                    inputRef.current?.focus()
                  }}
                  className={clsx('inline-flex shrink-0 items-center gap-1 rounded-full border px-3 text-xs max-md:h-11 max-md:px-2.5 md:h-7', on ? 'border-accent bg-accent/10 font-medium text-accent-text' : 'border-line text-muted hover:bg-hover hover:text-text')}
                >
                  {/* the tick on a computer only: three chips fit a 390 px phone without it (on: the colour says so) */}
                  {on && <Check size={13} aria-hidden className="max-md:hidden" />}
                  {t(CHIP_LABEL[c])}
                </button>
              )
            })}
          </div>
        )}
        {/* the line under the tabs sits outside the row, so the row's edge fade does not fade it too */}
        <div className="shrink-0 border-b border-line">
          {phone ? (
            // a phone: the seven types do not fit a row; the chosen one, and a sheet with all of them
            <div className="px-3 pb-2">
              <button ref={typeButton} type="button" aria-haspopup="menu" aria-label={`${t('search.types')}: ${t(TAB_LABEL[tab])}`} onClick={() => setTypeAsk((n) => n + 1)} className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-text hover:bg-hover" data-testid="search-type">
                {t(TAB_LABEL[tab])}
                <ChevronDown size={16} className="text-faint" aria-hidden />
              </button>
              <MenuButton
                label={t('search.types')}
                heading={t('search.types')}
                className="contents"
                buttonClassName="hidden!"
                openRequest={typeAsk}
                focusBack={() => typeButton.current?.focus()}
                items={types.map((x) => ({ label: t(TAB_LABEL[x]), checked: tab === x, onSelect: () => setTab(x), testId: `search-type-${x}` }))}
              />
            </div>
          ) : (
          <div ref={tabRow} role="tablist" aria-label={t('search.types')} className="scroll-thin edge-fade flex gap-1 overflow-x-auto px-4 pb-3">
            {types.map((x) => (
              <button
                key={x}
                type="button"
                role="tab"
                aria-selected={tab === x}
                tabIndex={tab === x ? 0 : -1}
                data-testid={`search-tab-${x}`}
                onClick={() => {
                  setTab(x)
                  inputRef.current?.focus()
                }}
                className={clsx('shrink-0 rounded-lg px-3 py-1.5 text-sm', tab === x ? 'bg-hover font-medium text-text' : 'text-muted hover:text-text')}
              >
                {t(TAB_LABEL[x])}
              </button>
            ))}
          </div>
          )}
        </div>
        {wantMessages && !!hitsNow?.items.length && !hitsNow.near && (tab === 'all' || tab === 'rooms') && (
          <div className="flex shrink-0 justify-end px-3 pt-1" data-testid="search-sort-bar">{sortMenu}</div>
        )}
        <div ref={listRef} id="search-results" role="listbox" aria-label={t('search.title')} className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 sm:max-h-[56vh]">
          {errorNow && <p className="px-3 py-2 text-sm text-danger">{errorNow}</p>}
          {failed && <p className="px-3 py-2 text-sm text-danger">{t('search.loadFailed')}</p>}
          {(namesNow?.failed || roomFilesNow?.failed) && wantNames && <p className="px-3 py-2 text-sm text-danger" data-testid="search-names-failed">{t('search.fileNamesFailed')}</p>}
          {hitsNow?.failed && wantMessages && <p className="px-3 py-2 text-sm text-danger" data-testid="search-messages-failed">{t('search.messagesFailed')}</p>}
          {(wantMessages ? hitsNow?.filters : wantNames ? roomFilesNow?.filters : undefined)?.roomGone && <p className="px-3 py-2 text-sm text-muted" data-testid="search-here-gone">{t('search.hereGone')}</p>}
          {!!missingFilters?.length && <p className="px-3 py-2 text-sm text-muted" data-testid="search-filter-missing">{t('search.filterMissing', { filters: missingFilters.join(', ') })}</p>}
          {sections.map((s) => (
            <div key={s.id} role="group" aria-labelledby={`sh-${s.id}`} data-testid={`search-section-${s.id}`} className="pb-1">
              <p id={`sh-${s.id}`} className="px-3 pt-3 pb-1.5 text-xs text-faint">{s.label}</p>
              {s.rows.map((r) => {
                const on = r === active
                const Icon = r.icon
                if (r.roomFile)
                  return (
                    <div
                      key={r.key}
                      id={optId(r)}
                      data-key={r.key}
                      role="option"
                      aria-selected={on}
                      onMouseMove={() => !on && choose(rows.indexOf(r))}
                      onClick={() => go(r)}
                      className={clsx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm', lit(r) && 'bg-hover')}
                      data-testid="search-room-file"
                    >
                      <RoomFileHit hit={r.roomFile.hit} room={r.roomFile.room} name={mark(r.title, terms)} />
                      {on && <CornerDownLeft size={15} className="shrink-0 text-faint max-md:hidden" aria-hidden />}
                    </div>
                  )
                if (r.hit)
                  return (
                    <div
                      key={r.key}
                      id={optId(r)}
                      data-key={r.key}
                      role="option"
                      aria-selected={on}
                      onMouseMove={() => !on && choose(rows.indexOf(r))}
                      onClick={() => go(r)}
                      className={clsx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2', lit(r) && 'bg-hover')}
                      data-testid="search-message"
                    >
                      <MessageHit hit={r.hit.hit} room={r.hit.room} text={mark(hitText(r.hit.hit, hitsNow?.near ? words : terms), hitsNow?.near ? words : terms)} />
                      {on && <CornerDownLeft size={15} className="shrink-0 text-faint max-md:hidden" aria-hidden />}
                    </div>
                  )
                return (
                  <div
                    key={r.key}
                    id={optId(r)}
                    data-key={r.key}
                    role="option"
                    aria-selected={on}
                    onMouseMove={() => !on && choose(rows.indexOf(r))}
                    // the finger lifting after a long press that opened the row's sheet opens no chat
                    onClick={() => Date.now() - longAt.current > 800 && go(r)}
                    {...press(r)}
                    className={clsx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm max-md:min-h-11', lit(r) && 'bg-hover', phone && r.chat && 'py-0 pr-0 select-none [-webkit-touch-callout:none]')}
                  >
                    {r.face ? (
                      'room' in r.face ? <RoomIcon room={r.face.room} size={20} /> : <Avatar user={r.face.person} size={20} />
                    ) : (
                      <span className="relative shrink-0 text-muted">
                        <Icon size={16} aria-hidden />
                        {r.attention && !r.marker && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent" data-testid="search-attention-dot" />}
                      </span>
                    )}
                    {r.meta ? (
                      // a History row: when and where, grey on the right; on a phone under the title, which keeps the width
                      <span className="flex min-w-0 flex-1 items-center gap-3 max-md:flex-col max-md:items-stretch max-md:gap-0 max-md:py-1.5">
                        <span className="min-w-0 truncate md:flex-1" data-testid="search-row-name">{r.match ? mark(r.title) : r.title}</span>
                        <span className="min-w-0 shrink-0 truncate text-xs text-faint tabular-nums md:max-w-[45%]" data-testid="search-row-meta">{r.meta}</span>
                      </span>
                    ) : (
                      <span className="min-w-0 flex-1 truncate" data-testid="search-row-name">
                        {r.match ? mark(r.title) : r.title}
                        {r.sub && <span className={clsx('ml-2 text-xs', r.marker ? clsx('font-medium', MARKER_TEXT[r.marker.kind]) : r.attention ? 'text-accent-text' : 'text-faint')} data-testid={r.marker ? 'search-marker-reason' : undefined}>{r.subMatch ? mark(r.sub) : r.sub}</span>}
                      </span>
                    )}
                    {/* a shared chat someone else wrote in: their faces, as in the Trina list (docs/DECISIONS.md "Faces in every
                        chat list"); the names are in the option's words for a screen reader */}
                    {r.chat && otherWriters(r.chat.shared) && (
                      <span className="flex shrink-0 items-center" data-testid="search-row-faces">
                        <ChatFaces shared={r.chat.shared!} on="surface" selected={lit(r)} testId="search-row" />
                      </span>
                    )}
                    {/* the 트리나 list's own marker; its words are the row's second part already */}
                    {r.marker && (
                      <span aria-hidden className="flex shrink-0 items-center" data-testid="search-row-marker" data-marker={r.marker.kind}>
                        <SessionMarker marker={r.marker} label={r.sub ?? ''} />
                      </span>
                    )}
                    {r.chat && (on || phone) && (
                      <Tooltip label={t('search.rowActions')}>
                        <span
                          role="presentation"
                          data-testid="search-row-more"
                          className={clsx('grid shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-text', phone ? 'size-11' : 'size-6')}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (phone) openSheet(r)
                            else if (menu?.row.key === r.key) closeMenu()
                            else openMenu(r)
                          }}
                        >
                          <MoreHorizontal size={16} aria-hidden />
                        </span>
                      </Tooltip>
                    )}
                    {/* the Enter hint is for a keyboard: phones (below 768px) have none */}
                    {on && <CornerDownLeft size={15} className="shrink-0 text-faint max-md:hidden" aria-hidden />}
                  </div>
                )
              })}
            </div>
          ))}
          {!sections.length && !loading && !failed && !errorNow && (
            <p className="px-3 py-8 text-center text-sm text-faint" data-testid="search-none">{room && !sent ? t('search.hereHint') : tab === 'files' && !sent ? t(guestFolder ? 'search.filesHintGuest' : 'search.filesHint') : t('search.none')}</p>
          )}
          {!sections.length && loading && <p className="px-3 py-8 text-center text-sm text-faint">…</p>}
        </div>
        {menu?.row.chat && (
          <div role="menu" aria-label={t('search.rowActions')} data-testid="search-row-menu" className="absolute right-6 z-10 w-44 rounded-xl border border-line bg-surface p-1 shadow-xl" style={{ top: menu.top }}>
            {[
              { label: t('chat.rename'), icon: Pencil, run: () => void chatActions.rename(menu.row.chat!) },
              { label: t('rooms.menu.copyLink'), icon: Link2, run: () => void copyChatLink(menu.row.chat!) },
              { label: t('common.delete'), icon: Trash2, run: () => void chatActions.remove(menu.row.chat!), danger: true },
            ].map((m, i) => (
              <button
                key={m.label}
                type="button"
                role="menuitem"
                autoFocus={i === 0}
                className={clsx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover', m.danger && 'text-danger')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const items = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
                    items[(items.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
                  }
                }}
                onClick={() => {
                  onClose()
                  m.run()
                }}
              >
                <m.icon size={15} aria-hidden /> {m.label}
              </button>
            ))}
          </div>
        )}
        {phone && sheet?.row.chat && (
          // a phone's sheet of a chat row's actions (rooms/MenuButton.tsx): opened by its "⋯" or a long press, the chat's
          // name on top; the keyboard stays down (no focusBack: the person was reading the results, and each item closes
          // the search)
          <MenuButton
            key={sheet.n}
            label={t('search.rowActions')}
            sheetTitle={sheet.row.title}
            className="contents"
            buttonClassName="hidden!"
            openSignal={sheet.long ? 1 : 0}
            openRequest={sheet.long ? 0 : 1}
            items={[
              { label: t('chat.rename'), icon: <Pencil size={18} aria-hidden />, onSelect: () => { onClose(); void chatActions.rename(sheet.row.chat!) }, testId: 'search-row-rename' },
              { label: t('rooms.menu.copyLink'), icon: <Link2 size={18} aria-hidden />, onSelect: () => { onClose(); void copyChatLink(sheet.row.chat!) }, testId: 'search-row-copy-link' },
              { label: t('common.delete'), icon: <Trash2 size={18} aria-hidden />, onSelect: () => { onClose(); void chatActions.remove(sheet.row.chat!) }, danger: true, testId: 'search-row-delete' },
            ]}
          />
        )}
        <div className="hidden shrink-0 items-center gap-5 border-t border-line px-5 py-2.5 text-xs text-faint sm:flex" data-testid="search-hints">
          <Hint label={t('search.hintClose')} keys={['Esc']} />
          <Hint label={t('search.hintType')} keys={['←', '→']} />
          <Hint label={t('search.hintOpen')} keys={['↵']} />
          <Hint label={t('search.hintFilters')} keys={['from:', 'in:', '" "']} />
          {active?.chat && <Hint label={t('search.hintActions')} keys={[onMac() ? '⌥' : 'Alt', '↵']} />}
        </div>
      </div>
    </div>
  )
}

/** A room message found: the sender's picture (the AI's mark for its answer), name, the room, "스레드" for a reply,
 * the time, and one line of its text with the typed text marked. */
/** Where a hit is, as its row says it: a team room and the everyone room as #name; a 1:1 chat as such, with the other
 * person unless they wrote it; a group chat by its name. */
export function useWhere(): (room: RoomSearchRoom | undefined, authorId: string | undefined) => string {
  const t = useT()
  const title = useRoomTitle()
  return (room, authorId) => {
    if (!room) return ''
    if (room.kind === 'team' || room.kind === 'all') return `#${title(room)}`
    if (room.kind !== 'dm') return title(room)
    const peer = room.peers[0]
    return peer && peer.id !== authorId ? `${t('search.dm')} · ${title(room)}` : t('search.dm')
  }
}

function MessageHit({ hit, room, text }: { hit: RoomSearchHit; room: RoomSearchRoom | undefined; text: ReactNode }) {
  const t = useT()
  const locale = useLocale()
  const person = useAvatarOf(hit.author)
  const ai = hit.authorKind === 'ai'
  // an app's message (docs/DECISIONS.md "Apps posting in rooms"): the app's name with the "App" tag, never a person
  const appName = useAppName()
  const name = hit.app ? appName(hit.app) : ai ? aiName(t) : hit.author?.name ?? t('rooms.goneUser')
  const where = useWhere()(room, hit.author?.id)
  return (
    <>
      {hit.app ? <AppTile service={serviceOf(hit.app)} app={hit.app} size="face" /> : ai ? <AiFace size={32} /> : person ? <Avatar user={person} size={32} /> : <span aria-hidden className="size-8 shrink-0 rounded-full bg-hover" />}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
          <span className="shrink-0 font-medium text-ink" data-testid="search-message-author">{name}</span>
          {hit.app && <SenderTag />}
          <span className="min-w-0 truncate text-xs text-faint" data-testid="search-message-room">
            {where}
            {hit.threadRootId && ` · ${t('search.inThread')}`}
          </span>
          <span className="ml-auto shrink-0 pl-2 text-xs text-faint tabular-nums">{listTime(hit.createdAt, locale, t('sidebar.yesterday'))}</span>
        </span>
        <span className="block truncate text-sm text-muted" data-testid="search-message-text">{text}</span>
      </span>
    </>
  )
}

/** A file sent in a room: its icon and name (the typed words marked), then who sent it, where and when, on one line. */
function RoomFileHit({ hit, room, name }: { hit: RoomFileSearchHit; room: RoomSearchRoom | undefined; name: ReactNode }) {
  const t = useT()
  const locale = useLocale()
  const where = useWhere()(room, hit.author?.id)
  const Icon = hit.file.kind === 'image' ? ImageIcon : FileIcon
  return (
    <>
      <span className="shrink-0 text-muted">
        <Icon size={16} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {name}
        <span className="ml-2 text-xs text-faint" data-testid="search-room-file-where">
          {[hit.author?.name ?? t('rooms.goneUser'), where, listTime(hit.createdAt, locale, t('sidebar.yesterday'))].filter(Boolean).join(' · ')}
        </span>
      </span>
    </>
  )
}

function Hint({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="flex items-center gap-1.5">
      {label}
      {keys.map((k) => (
        <kbd key={k} className="rounded border border-line px-1.5 py-px font-sans text-micro text-muted">{k}</kbd>
      ))}
    </span>
  )
}
