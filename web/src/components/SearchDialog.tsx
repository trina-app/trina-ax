// ⌘/Ctrl+K: one place to find the team's own things, like Claude's search. Type tabs (all, chats, projects, files,
// skills, scheduled, MCP); with no text it shows what needs attention, recent chats and projects, and actions (the
// inbox among them, with its unread count).
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
// Files sent in rooms (전체 and 파일 tabs, after the team files' names, 4 file rows in all on 전체): searched on the server
// by name (GET /api/room-files), only those of messages I see; a row is the name, then who sent it, where and when;
// it opens its message in the room, as a message found does.
// Every word of the text counts, in any order (room messages, chat records, room files). A result from the server is
// kept with the words it answered and used only while they are the words in the box, so nothing from an older text is
// shown or opened: a fast Enter opens the top row shown at that moment. The highlighted row is kept by its key, so
// results arriving above it do not move it.
import clsx from 'clsx'
import { Bell, BookMarked, Cable, CalendarClock, CalendarPlus, ChevronDown, CornerDownLeft, File as FileIcon, FileSearch, Folder, FolderKanban, FolderOpen, FolderPlus, Image as ImageIcon, Link2, MessageSquare, MoreHorizontal, Pencil, Plus, Shield, Trash2, UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { nameMatch, searchWords } from '@mycel/shared'
import { skillTitle, type Chat, type FileEntry, type Integration, type Person, type Project, type Room, type RoomFileSearchHit, type RoomSearchHit, type RoomSearchRoom, type Schedule } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { listTime } from '../lib/format'
import { plainLine } from '../lib/rooms'
import { platform } from '../lib/pwa'
import { scheduleName } from '../lib/scheduleText'
import { useLocale, useT, type MessageKey } from '../i18n'
import { aiName } from '../lib/tabs'
import { isAdmin, useMe } from '../store/session'
import { useUi } from '../store/ui'
import { useEdgeFade, useFocusTrap } from './ui'
import { contentQueryReady } from './FileContentSearch'
import { skillFileLink } from './AvailableSkills'
import { useChatActions } from './chat/chatActions'
import { useCopyChatLink } from './chat/copyChatLink'
import { openTeamInvite } from './TeamMenu'
import { Tooltip } from './Tooltip'
import { Avatar } from './Avatar'
import { AiFace, AiMark } from './rooms/AiFace'
import { PeoplePicker } from './rooms/PeoplePicker'
import { RoomIcon, useRoomTitle } from './rooms/RoomIcon'
import { useAvatarOf, usePeopleList } from '../store/people'
import { useRooms } from '../store/rooms'

export default function SearchDialog() {
  const open = useUi((s) => s.searchOpen)
  const setOpen = useUi((s) => s.setSearchOpen)
  // a person with no DM, chosen in the palette: the new-DM list with them ticked, after the palette has closed
  const [dmWith, setDmWith] = useState<string | null>(null)
  return (
    <>
      {open && <SearchBox onClose={() => setOpen(false)} onPerson={setDmWith} />}
      <PeoplePicker open={!!dmWith} onClose={() => setDmWith(null)} mode={{ kind: 'new', preselect: dmWith ? [dmWith] : [] }} />
    </>
  )
}

/** "트리나에게 묻기": the mark that asks the AI (rooms/AiFace.tsx), as on the sidebar's row */
const AskAi = () => <AiMark place="nav" />

export const SEARCH_TABS = ['all', 'chats', 'projects', 'files', 'skills', 'scheduled', 'mcp'] as const
export type SearchTab = (typeof SEARCH_TABS)[number]
const TAB_LABEL: Record<SearchTab, MessageKey> = {
  all: 'search.tab.all', chats: 'search.tab.chats', projects: 'search.tab.projects', files: 'search.tab.files',
  skills: 'search.tab.skills', scheduled: 'search.tab.scheduled', mcp: 'search.tab.mcp',
}

type Kind = 'room' | 'person' | 'chat' | 'message' | 'project' | 'file' | 'skill' | 'schedule' | 'mcp' | 'action'
interface Row {
  key: string
  kind: Kind
  title: string
  /** dim second part: where it is (project, folder) or why it needs attention */
  sub?: string
  attention?: boolean
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
 * first: the whole text at the start of the name, then inside it, then by words or initial consonants; rooms by their
 * latest activity, people by name. `title`: a room's name as the app shows it (rooms/RoomIcon.tsx useRoomTitle). */
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
  const isPerson = (x: (typeof found)[number]) => Number('person' in x.item)
  return found.sort((a, b) => isPerson(a) - isPerson(b) || a.rank - b.rank || b.at.localeCompare(a.at) || a.name.localeCompare(b.name)).slice(0, few).map((x) => x.item)
}

/** The lists Search reads once when it opens; null while loading, 'error' when one could not be read. */
function useList<T>(load: () => Promise<T>): T | null | 'error' {
  const [v, setV] = useState<T | null | 'error'>(null)
  useEffect(() => {
    let live = true
    load().then((x) => live && setV(x), () => live && setV('error'))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return v
}
const ok = <T,>(v: T | null | 'error'): T | null => (v === 'error' ? null : v)
/** What a task's search may match besides its name: a task's own instruction. A template's prompt is the server's own
 *  and never shown, so it is not searched. */
const scheduleText = (s: Schedule) => (s.templateId ? '' : s.prompt)

function SearchBox({ onClose, onPerson }: { onClose: () => void; onPerson: (userId: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const chatActions = useChatActions()
  const copyChatLink = useCopyChatLink()
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [tab, setTabState] = useState<SearchTab>('all')
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
  const [hits, setHits] = useState<{ q: string; items: RoomSearchHit[]; rooms: Map<string, RoomSearchRoom>; next: string | null; failed: boolean } | null>(null)
  const [hitsShown, setHitsShown] = useState(MESSAGES_FEW)
  const [hitsMore, setHitsMore] = useState(false)
  // files sent in rooms whose name holds the text, and whether that search failed
  const [roomFiles, setRoomFiles] = useState<{ q: string; items: RoomFileSearchHit[]; rooms: Map<string, RoomSearchRoom>; failed: boolean } | null>(null)
  // another text or type: back to the first row
  const setTab = (x: SearchTab | ((x: SearchTab) => SearchTab)) => {
    setTabState(x)
    setSel({ key: null, index: 0 })
  }
  // Esc closes an open row menu first, then the dialog
  useFocusTrap(ref, true, () => (menu ? closeMenu() : onClose()))

  const recent = useList(() => api.call(API.listChats, { query: { limit: 30 } }).then((p) => p.items))
  const projects = useList(() => api.call(API.listProjects).then((r) => r.items))
  const skills = useList<Skill[]>(() => api.call(API.listSkills).then((r) => r.items))
  const schedules = useList(() => api.call(API.listSchedules).then((r) => r.items))
  const mcp = useList(() => api.call(API.listIntegrations))
  const unread = useList(() => api.call(API.listNotifications, { query: { limit: 1 } }).then((r) => r.unreadCount))
  const admin = isAdmin(useMe())
  const meId = useMe()?.user.id
  // rooms & people: my rooms list and the team's people, as the app has them (read now if no screen has yet)
  const myRooms = useRooms((s) => s.rooms)
  useEffect(() => {
    if (!useRooms.getState().loaded) void useRooms.getState().loadRooms()
  }, [])
  const people = usePeopleList()
  const roomTitle = useRoomTitle()

  const query = norm(q.trim())
  const words = useMemo(() => searchWords(query), [query])
  // What the server's answers are kept by: the words as the server reads them (searchWords), with only the letters it
  // takes in any case folded, so a space more or such a letter in another case asks nothing again and shows what is
  // there, and nothing else is taken for the same search. Chats, room messages and room files: LIKE, A–Z only ("Été" and
  // "été" are two searches). Team file names: every letter (team-files/find.ts).
  const key = useMemo(() => searchWords(q.trim()).map(foldAZ).join(' '), [q])
  const namesKey = useMemo(() => searchWords(q.trim()).map((w) => w.toLowerCase()).join(' '), [q])
  // the server's answers to the text in the box now (null: none yet)
  const foundNow = found?.q === key ? found.items : null
  const errorNow = error?.q === key ? error.text : null
  const namesNow = names?.q === namesKey ? names : null
  const hitsNow = hits?.q === key ? hits : null
  const roomFilesNow = roomFiles?.q === key ? roomFiles : null
  // chats by title and content, on the server
  useEffect(() => {
    if (!query) return
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
  }, [key])
  // files by name, on the server, only where file rows are shown: the team's files and the files sent in my rooms
  const wantNames = !!query && (tab === 'all' || tab === 'files')
  useEffect(() => {
    if (!wantNames) return
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
  }, [namesKey, wantNames])
  useEffect(() => {
    if (!wantNames) return
    let live = true
    const ctrl = new AbortController()
    const asked = key
    const timer = setTimeout(() => {
      api.call(API.searchRoomFiles, { query: { q: q.trim(), limit: ROOM_FILES_PAGE }, signal: ctrl.signal }).then(
        (r) => live && setRoomFiles({ q: asked, items: r.items, rooms: new Map(r.rooms.map((x) => [x.id, x])), failed: false }),
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

  // room messages, on the server, only on the 전체 tab
  const wantMessages = !!query && tab === 'all'
  useEffect(() => {
    setHitsShown(MESSAGES_FEW)
    setHitsMore(false)
    if (!wantMessages) return
    let live = true
    const ctrl = new AbortController()
    const asked = key
    const timer = setTimeout(() => {
      api.call(API.searchRoomMessages, { query: { q: q.trim(), limit: MESSAGES_PAGE }, signal: ctrl.signal }).then(
        (r) => live && setHits({ q: asked, items: r.items, rooms: new Map(r.rooms.map((x) => [x.id, x])), next: r.nextCursor, failed: false }),
        () => live && !ctrl.signal.aborted && setHits({ q: asked, items: [], rooms: new Map(), next: null, failed: true }),
      )
    }, 200)
    return () => {
      live = false
      ctrl.abort()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wantMessages])
  /** 메시지 더 보기: more of what is here, and the next page when that runs out (kept only for the same text) */
  const moreHits = () => {
    if (!hitsNow) return
    const want = hitsShown + MESSAGES_PAGE
    setHitsShown(want)
    if (want <= hitsNow.items.length || !hitsNow.next || hitsMore) return
    setHitsMore(true)
    const asked = key
    api.call(API.searchRoomMessages, { query: { q: q.trim(), limit: MESSAGES_PAGE, cursor: hitsNow.next } }).then(
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
  const chatRow = (c: Chat, attention?: string): Row => ({
    key: `chat:${c.id}`, kind: 'chat', icon: MessageSquare, title: c.title || t('chat.untitled'), href: `/c/${c.id}`, chat: c,
    sub: attention ?? (c.projectId ? projectName.get(c.projectId) : undefined), attention: !!attention, match: true,
  })
  const projectRow = (p: Project): Row => ({ key: `project:${p.id}`, kind: 'project', icon: FolderKanban, title: p.name, sub: p.folderPath, href: `/projects/${p.id}`, match: true })
  const skillRow = (s: Skill): Row => ({ key: `skill:${s.path}`, kind: 'skill', icon: BookMarked, title: skillTitle(s), sub: parentOf(s.path), href: skillFileLink(s.path), match: true })
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
    key: `mcp:${i.id}`, kind: 'mcp', icon: Cable, title: i.name, href: i.scope === 'personal' ? `/connectors/mcp/${i.id}` : '/connectors', match: true,
    sub: attention ?? (i.scope === 'team' ? t('search.team') : undefined), attention: !!attention,
  })
  const fileNameRow = (f: FileEntry): Row => ({
    key: `file:${f.path}`, kind: 'file', icon: f.type === 'folder' ? Folder : FileIcon, title: f.name, sub: parentOf(f.path), match: true,
    href: f.type === 'folder' ? `/files?path=${encodeURIComponent(f.path)}` : skillFileLink(f.path),
  })
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

  const actions: Row[] = useMemo(() => {
    const list: Row[] = [
      { key: 'act:chat', kind: 'action', icon: AskAi, title: t('sidebar.askAi', { name: aiName(t) }), href: '/' },
      { key: 'act:project', kind: 'action', icon: FolderPlus, title: t('projects.new'), href: '/projects?new=1' },
      { key: 'act:schedule', kind: 'action', icon: CalendarPlus, title: t('search.newScheduled'), href: '/scheduled' },
    ]
    const m = ok(mcp)
    // owners and admins go straight to the add-by-address form; a member to the page, which lists the services to
    // connect (the form is an admin's job). "MCP" and the page's name still find it.
    if (m?.personalAllowed) list.push({ key: 'act:mcp', kind: 'action', icon: Plus, title: t('search.addMcp'), href: admin ? '/connectors?add=1' : '/connectors', terms: `MCP ${t('integrations.title')}` })
    list.push({ key: 'act:files', kind: 'action', icon: FolderOpen, title: t('search.openFiles'), href: '/files' })
    // the inbox lives in Settings > Notifications; unread notifications show as a count and an attention dot
    const n = ok(unread) ?? 0
    list.push({
      key: 'act:inbox', kind: 'action', icon: Bell, title: t('inbox.open'), href: '/activity', terms: `${t('inbox.title')} ${t('notifications.title')}`,
      sub: n > 0 ? t('notifications.unread', { count: n }) : undefined, attention: n > 0,
    })
    // the team menu's items (owners and admins), found by their words: "Invite teammates", "Members & invites" too
    if (admin)
      list.push(
        { key: 'act:invite', kind: 'action', icon: UserPlus, title: t('teamMenu.invite'), href: '', terms: `${t('goal.invite')} ${t('admin.members')}`, typed: true, after: () => void openTeamInvite(navigate, null) },
        { key: 'act:admin', kind: 'action', icon: Shield, title: t('sidebar.admin'), href: '/admin', terms: `${t('admin.title')} ${t('admin.members')} ${t('admin.settings')}`, typed: true },
      )
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcp, unread, locale, admin])

  const sections: Section[] = useMemo(() => {
    const chats = ok(recent) ?? []
    const allProjects = ok(projects) ?? []
    const allSkills = ok(skills) ?? []
    const allSchedules = ok(schedules) ?? []
    const allMcp = ok(mcp)?.items ?? []
    const out: Section[] = []
    const push = (id: string, label: string, rows: Row[]) => rows.length && out.push({ id, label, rows })
    const typeLabel = (x: SearchTab) => t(TAB_LABEL[x])

    if (!query) {
      if (tab === 'all') {
        const attention: Row[] = [
          ...chats.filter((c) => c.runState !== 'idle').map((c) => chatRow(c, t(c.runState === 'running' ? 'search.attn.running' : 'search.attn.queued'))),
          ...allSchedules.filter((s) => s.needsReview).map((s) => scheduleRow(s, t('search.attn.review'))),
          ...allMcp.filter((i) => i.status !== 'connected').map((i) => mcpRow(i, t(i.status === 'needs_auth' ? 'search.attn.signIn' : 'search.attn.error'))),
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
        push('actions', t('search.actions'), actions.filter((a) => !a.typed))
      } else if (tab === 'chats') push('chats', typeLabel('chats'), chats.map((c) => chatRow(c)))
      else if (tab === 'projects') push('projects', typeLabel('projects'), allProjects.map(projectRow))
      else if (tab === 'skills') push('skills', typeLabel('skills'), allSkills.map(skillRow))
      else if (tab === 'scheduled') push('scheduled', typeLabel('scheduled'), allSchedules.map((s) => scheduleRow(s)))
      else if (tab === 'mcp') push('mcp', typeLabel('mcp'), allMcp.map((i) => mcpRow(i)))
      else if (tab === 'files') push('files', typeLabel('files'), actions.filter((a) => a.key === 'act:files'))
      return out
    }

    const few = tab === 'all' ? 4 : 50
    // a name jump first, matched here in the lists the app has (they may load a moment after the text)
    if (tab === 'all') push('people', t('search.roomsPeople'), roomsAndPeople(myRooms, people ?? [], meId, query, roomTitle).map((x) => ('room' in x ? roomRow(x.room, x.name) : personRow(x.person))))
    if (tab === 'all' || tab === 'chats') push('chats', typeLabel('chats'), titleFirst(foundNow ?? [], words).slice(0, tab === 'all' ? 5 : 30).map((c) => chatRow(c)))
    if (tab === 'all' && hitsNow) push('messages', t('search.messages'), [...hitsNow.items.slice(0, hitsShown).map(messageRow), ...(hitsShown < hitsNow.items.length || hitsNow.next ? [moreMessagesRow()] : [])])
    if (tab === 'all' || tab === 'projects') push('projects', typeLabel('projects'), allProjects.filter((p) => has(query, p.name, p.folderPath)).slice(0, few).map(projectRow))
    if (tab === 'all' || tab === 'skills') push('skills', typeLabel('skills'), allSkills.filter((s) => has(query, s.name, s.title, s.description)).slice(0, few).map(skillRow))
    if (tab === 'all' || tab === 'scheduled') push('scheduled', typeLabel('scheduled'), allSchedules.filter((s) => has(query, scheduleName(s, t), scheduleText(s))).slice(0, few).map((s) => scheduleRow(s)))
    if (tab === 'all' || tab === 'mcp') push('mcp', typeLabel('mcp'), allMcp.filter((i) => has(query, i.name, i.url)).slice(0, few).map((i) => mcpRow(i)))
    // the team's files by name, then the files sent in my rooms: 4 in all on 전체
    if (tab === 'all' || tab === 'files')
      push('files', typeLabel('files'), [
        ...[...(namesNow?.items ?? []).slice(0, 30).map(fileNameRow), ...(roomFilesNow?.items ?? []).map(roomFileRow)].slice(0, tab === 'all' ? FILES_FEW : undefined),
        ...(contentQueryReady(q) ? [filesRow()] : []),
      ])
    if (tab === 'all') push('actions', t('search.actions'), actions.filter((a) => has(query, a.title, a.terms)))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tab, recent, projects, skills, schedules, mcp, foundNow, namesNow, hitsNow, roomFilesNow, hitsShown, hitsMore, actions, locale, myRooms, people, meId, roomTitle])

  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections])
  const chosen = sel.key === null ? -1 : rows.findIndex((r) => r.key === sel.key)
  const activeIndex = chosen >= 0 ? chosen : Math.min(sel.index, rows.length - 1)
  const active = rows[activeIndex]
  const choose = (i: number) => setSel({ key: rows[i]?.key ?? null, index: i })
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
  // the type tabs scroll sideways on a phone: fade the cut edge, and bring the chosen one into view (arrow keys at the
  // ends of the text choose another)
  const tabRow = useRef<HTMLDivElement>(null)
  useEdgeFade(tabRow)
  useEffect(() => {
    const row = tabRow.current
    if (!row || row.scrollWidth <= row.clientWidth) return
    row.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])
  const moveTab = (d: 1 | -1) => setTab((x) => SEARCH_TABS[(SEARCH_TABS.indexOf(x) + d + SEARCH_TABS.length) % SEARCH_TABS.length]!)
  const loading = (tab === 'all' && !!query && ((foundNow === null && !errorNow) || (wantMessages && hitsNow === null))) || (tab === 'chats' && (query ? foundNow === null && !errorNow : recent === null)) || (tab === 'projects' && projects === null) || (tab === 'skills' && skills === null) || (tab === 'scheduled' && schedules === null) || (tab === 'mcp' && mcp === null) || (tab === 'files' && wantNames && (namesNow === null || roomFilesNow === null))
  const failed = (tab === 'projects' && projects === 'error') || (tab === 'skills' && skills === 'error') || (tab === 'scheduled' && schedules === 'error') || (tab === 'mcp' && mcp === 'error') || (tab === 'chats' && !query && recent === 'error')

  // the first match of every word, marked
  const mark = (text: string): ReactNode => {
    const spans = wordSpans(text, words)
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
            className="h-10 min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-faint"
            placeholder={t('search.placeholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setSel({ key: null, index: 0 })
              setMenu(null)
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              const input = e.currentTarget
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
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
        {/* the line under the tabs sits outside the row, so the row's edge fade does not fade it too */}
        <div className="shrink-0 border-b border-line">
          <div ref={tabRow} role="tablist" aria-label={t('search.types')} className="scroll-thin edge-fade flex gap-1 overflow-x-auto px-4 pb-3">
            {SEARCH_TABS.map((x) => (
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
        </div>
        <div ref={listRef} id="search-results" role="listbox" aria-label={t('search.title')} className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 sm:max-h-[56vh]">
          {errorNow && <p className="px-3 py-2 text-sm text-danger">{errorNow}</p>}
          {failed && <p className="px-3 py-2 text-sm text-danger">{t('search.loadFailed')}</p>}
          {(namesNow?.failed || roomFilesNow?.failed) && wantNames && <p className="px-3 py-2 text-sm text-danger" data-testid="search-names-failed">{t('search.fileNamesFailed')}</p>}
          {hitsNow?.failed && wantMessages && <p className="px-3 py-2 text-sm text-danger" data-testid="search-messages-failed">{t('search.messagesFailed')}</p>}
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
                      className={clsx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm', on && 'bg-hover')}
                      data-testid="search-room-file"
                    >
                      <RoomFileHit hit={r.roomFile.hit} room={r.roomFile.room} name={mark(r.title)} />
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
                      className={clsx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2', on && 'bg-hover')}
                      data-testid="search-message"
                    >
                      <MessageHit hit={r.hit.hit} room={r.hit.room} text={mark(hitText(r.hit.hit, words))} />
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
                    onClick={() => go(r)}
                    className={clsx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm', on && 'bg-hover')}
                  >
                    {r.face ? (
                      'room' in r.face ? <RoomIcon room={r.face.room} size={20} /> : <Avatar user={r.face.person} size={20} />
                    ) : (
                      <span className="relative shrink-0 text-muted">
                        <Icon size={16} aria-hidden />
                        {r.attention && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent" data-testid="search-attention-dot" />}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {r.match ? mark(r.title) : r.title}
                      {r.sub && <span className={clsx('ml-2 text-xs', r.attention ? 'text-accent-text' : 'text-faint')}>{r.subMatch ? mark(r.sub) : r.sub}</span>}
                    </span>
                    {on && r.chat && (
                      <Tooltip label={t('search.rowActions')}>
                        <span
                          role="presentation"
                          data-testid="search-row-more"
                          className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-text"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (menu?.row.key === r.key) closeMenu()
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
            <p className="px-3 py-8 text-center text-sm text-faint" data-testid="search-none">{tab === 'files' && !query ? t('search.filesHint') : t('search.none')}</p>
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
        <div className="hidden shrink-0 items-center gap-5 border-t border-line px-5 py-2.5 text-xs text-faint sm:flex" data-testid="search-hints">
          <Hint label={t('search.hintClose')} keys={['Esc']} />
          <Hint label={t('search.hintType')} keys={['←', '→']} />
          <Hint label={t('search.hintOpen')} keys={['↵']} />
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
function useWhere(): (room: RoomSearchRoom | undefined, authorId: string | undefined) => string {
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
  const name = ai ? aiName(t) : hit.author?.name ?? t('rooms.goneUser')
  const where = useWhere()(room, hit.author?.id)
  return (
    <>
      {ai ? <AiFace size={32} /> : person ? <Avatar user={person} size={32} /> : <span aria-hidden className="size-8 shrink-0 rounded-full bg-hover" />}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
          <span className="shrink-0 font-medium text-ink">{name}</span>
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
