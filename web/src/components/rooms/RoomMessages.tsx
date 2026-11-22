// The messages of a room, oldest first: one author's messages close together share one avatar, name and time
// (lib/rooms.ts groupRuns; on phones the time only when it differs from the one above), and a date line starts each
// day. Nobody is shown who has read what (docs/DECISIONS.md "스레드와 반응": no read receipts). A message's text is
// another member's words in Markdown, as the AI's answers are (QA TC-072; docs/DECISIONS.md "Markdown in people's
// messages"; Markdown.tsx PersonMarkdown): bold, italic, code, lists, code blocks and links, with its line breaks kept;
// raw HTML stays text and no picture loads by itself; the @names it mentions stand out, and its plain web addresses
// are links (lib/messageMarkdown.ts, MessageText.tsx). Its quote and a message being sent stay plain text (with links).
// On a computer a message's hover row has a reaction, "reply in thread" and "…" (copy, edit and delete one's own); on a
// touch screen a long press opens the same as a sheet with the reactions on top. Under a message: its reactions
// (components/rooms/Reactions.tsx) and, for a root, its thread ("답글 3개 · 오후 2:10", up to 3 faces; a dot when a
// thread I follow has new replies), which opens the thread. A reply also sent to the room says so above it. The same
// list shows a thread's root and replies (variant). A photo's thumbnail, a video's frame (RoomVideo) and a file chip's name open the viewer
// (components/ImageViewer.tsx, like Slack's: the whole window, the pane's other pictures and files by ← →; the page's
// ImageGroup is the timeline or the thread; docs/DECISIONS.md "The room file viewer"): a photo with its zoom, a
// document drawn as the side panel draws it, a file with no preview here as its card with the download. The chip has a
// small download icon of its own, and beside it on hover "Save to team folder" (also in a file's menu, a picture's too;
// docs/decisions/20261117-room-file-save-btn.md), which once the file is in the team folder where I can open it becomes a
// quiet link to it. Both read the room's copy through the room (lib/imageViewer.ts roomItem,
// roomFileItem) and have the download too; the viewer's bar says who sent it, when and where.
// The room AI's earlier answers (docs/DECISIONS.md "대화방의 트리나"; that AI was removed, "Room @트리나 code removed") are
// shown like an answer in the AI chat (Markdown) without its steps, with who asked ("○○ 님이 물어봄", a click goes to the
// question). An event line (a
// rename, people invited, someone left or taken out: RoomMessage.event) is one quiet line in the middle, nothing more:
// no avatar, menu, reaction or thread.
// An answer someone sent here from their own AI chat ("대화방에 보내기", RoomMessage.sharedAnswer) is their message: their
// note in Markdown as their other messages, then the answer as a quote headed "<AI> 답변", in Markdown like the AI's own answers (a team file
// in it as a link for those who may open it; for the others, a link to its copy when it went with the message
// (RoomMessage.attachedLinks), else its name after a lock). It cannot be edited (copy and delete stay).
// An old answer hidden from me (RoomMessage.withheld: I joined a team room or the everyone room after it, and it used
// something I cannot open) is one faint line in its place ("볼 수 없는 자료를 참고한 답이라 가려졌어요"): who asked it (or
// whose message it is) and when, nothing else: no hover row, menu, reaction, thread or sources.
// Only a message's words can be selected (not its hover row, reactions, thread line, "수정됨", quote or file chips); ⌘C
// over several messages copies their words as plain text, one message per block under its author and time
// (lib/messageCopy.ts).
import clsx from 'clsx'
import { Copy, Download, FileText, FileX, FolderCheck, FolderInput, Link2, MessageSquareText, Pencil, Play, Trash2, X } from 'lucide-react'
import { createContext, Fragment, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react'
import { CHAT_FILES_FOLDER, chatFilesWord } from '@mycel/shared'
import { parseMessageLinks, ROOM_QUOTE_EXCERPT_MAX, type Room, type RoomFile, type RoomMessage, type RoomQuote, type UserRef, type Locale } from '@mycel/shared/api'
import { errorText, roomFileUrl, startDownload } from '../../lib/api'
import { formatDateTime, formatSize } from '../../lib/format'
import { copiedMessages } from '../../lib/messageCopy'
import { ALL_MENTION_ID, allMentionNames, eventProjectOf, eventText, groupRuns, highlightNow, lineBreaks, localDayKey, projectEventKey, projectRoomOf } from '../../lib/rooms'
import { aiName } from '../../lib/tabs'
import { Markdown, PersonMarkdown } from '../LazyMarkdown'
import { AppCardText } from './AppCard'
import { roomPreview, type PreviewFile } from '../../lib/sidePanel'
import { previewKind, roomFileOpens } from '../../lib/preview'
import { useLocale, useT } from '../../i18n'
import { useNameOf, usePeople } from '../../store/people'
import { useMe } from '../../store/session'
import { placeKey, useRooms, type PendingSend } from '../../store/rooms'
import { toast } from '../../store/ui'
import { TokenTextarea } from '../TokenTextarea'
import { Button, cancelDialog, confirmDialog, useCopy, useMediaQuery } from '../ui'
import { useAutoGrow } from '../../lib/autoGrow'
import { failedEdits, focusRoomBox, hasRoomBox, useRoomEdit } from '../../store/roomEdit'
import { AiFaceInline, AiMark } from './AiFace'
import { DayLine, messageRowClass, RunFace, RunName, RunShell, sameTimeAsAbove, timeOf, WORDS } from './MessageRun'
import { MenuButton, useLongPress, type MenuItem } from './MenuButton'
import { MessageHoverBar } from './MessageHoverBar'
import { reactable, ReactionChips, ReactionPanel, ReactionStrip } from './Reactions'
import { LinkedText } from './MessageText'
import { ThreadLine } from '../ThreadLine'
import type { MessageMention } from '../../lib/messageMarkdown'
import { MENTION_ALL_WORDS, pickedInMessage, useMentionMenu } from './useMentionMenu'
import { Tooltip } from '../Tooltip'
import { useViewerItem, useViewerMeta, ViewerMeta } from '../ImageViewer'
import { roomFileItem, roomItem, type ViewerItem, type ViewerMetaValue } from '../../lib/imageViewer'
import { itemImage, itemLink } from '../../lib/fileMenu'
import { GALLERY_GAP_PX, GALLERY_PX, galleryRows } from '../../lib/imageGallery'
import { askTrinaInRoom, fileSeed } from '../../lib/sideChatAsk'
import { useFileMenu } from '../FileMenu'
import type { SideSeed } from './SideChatPanel'
import { dismissKeyboard } from '../../lib/viewport'
import { useRoomTitle } from './RoomIcon'
import { AppTile } from './apps/AppParts'
import { AppSender } from './apps/AppSender'
import { appPlainText, serviceOf, unescapeAppBody } from '../../lib/roomApps'
import { mayManageApps } from '../../store/roomApps'
import { copyLinkOf } from '../../lib/messageLinks'
import { MessageLinkCard } from './MessageLinkCard'
import { MessageLinkPreviews, useLinkHosts, usePlaceLabel } from './MessageLinkChip'
import { navigateTo } from '../../lib/nav'
import { folderOfPath } from '../../lib/roomSave'
import { useFolderWords } from '../../lib/folderLabels'
import { useRoomSaves } from '../../store/roomSaves'
import { capBlankLines } from '../../lib/blankLines'

export const messageDomId = (id: string) => `room-msg-${id}`
/** A message's words: the one part of its row that can be selected (not on touch screens, where a long press opens its
 * menu), and what a copy of several messages takes from it (lib/messageCopy.ts) */
/** An answer's `>` quotes, as the AI chat shows them (Markdown.tsx CopyableQuote): without the quote marks the typography
 * adds to a quote's first and last paragraph. An answer that quotes a message puts its own marks around it, so a shared
 * answer in a thread read “"…"” (QA 2026-11-11). */
export const ANSWER_QUOTES = '[&_blockquote_p:first-of-type]:before:content-none [&_blockquote_p:last-of-type]:after:content-none'

/** ⌘C over several messages (or a run's name and a message): their words as plain text, one message per block
 * (lib/messageCopy.ts); inside one message, the browser's own copy */
function copyMessages(e: ClipboardEvent<HTMLDivElement>) {
  const text = copiedMessages(window.getSelection())
  if (text === null) return
  e.clipboardData.setData('text/plain', text)
  e.preventDefault()
}

export { sameTimeAsAbove }

/** the largest box a thumbnail takes, so the list does not jump while it loads */
export function thumbBox(f: { width?: number | null; height?: number | null }): { width: number; height: number } | undefined {
  if (!f.width || !f.height) return undefined
  const k = Math.min(1, 320 / f.width, 240 / f.height)
  return { width: Math.round(f.width * k), height: Math.round(f.height * k) }
}

/** A photo's thumbnail: in the box its stored size gives until it loads, then in its own shape when that differs. The
 * thumbnail is always upright; a photo sent before the server stored the upright size (a portrait phone photo stored
 * landscape with EXIF orientation 6) has a landscape size, which would crop it to its middle band. The soft box only
 * holds the place while it loads: a picture with transparency (a seal stamp, a logo) then sits on the page itself. */
function RoomThumb({ f, src }: { f: RoomFile; src: string }) {
  const [own, setOwn] = useState<{ width: number; height: number } | null>(null)
  const [loaded, setLoaded] = useState(false)
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      style={thumbBox(own ?? f)}
      onLoad={(e) => {
        setLoaded(true)
        const { naturalWidth: width, naturalHeight: height } = e.currentTarget
        if (width && height && (!f.width || !f.height || Math.abs(width / height - f.width / f.height) > 0.05)) setOwn({ width, height })
      }}
      className={clsx('block max-h-60 max-w-full object-cover', !loaded && 'bg-subtle')}
    />
  )
}

/** A gallery tile's thumbnail: it fills the tile (cropped), the soft box only until it loads. Out of the flow, so the
 * picture's own size never stretches the tile past its ratio. */
function TileThumb({ src }: { src: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <>
      <img src={src} alt="" loading="lazy" onLoad={() => setLoaded(true)} className={clsx('absolute inset-0 block h-full w-full object-cover', !loaded && 'bg-subtle')} />
      {/* the picture's hairline over it: a border on the tile would add to its width and not to its height */}
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-lg border border-line" />
    </>
  )
}

/** Where the list is: the room's timeline, or the thread panel's root, or its replies. */
export type ListVariant = 'timeline' | 'root' | 'reply'

/** How long a message picked out by a link (an Inbox row) keeps its `data-highlight` mark. The mark has no look: the
 * list only scrolls to the message (owner 2026-11-21: no coloured box, only the place). */
export const HIGHLIGHT_MS = 2400

/** `dayBefore`: the time of what is shown above the list (a thread's root): no second date line for that same day.
 * `highlight`: a message a link points at (an Inbox row: pages/Room.tsx ?m=): once it is on the list it is scrolled to
 * the middle and marked (`data-highlight`, no look) for a moment, once. */
/** `onAskTrina`: "Ask Trina about this" on a message (the room's side chat opens with it quoted) */
export function RoomMessages({ roomId, messages, pending, meId, members, onThread, onAskTrina, onAskFile, variant = 'timeline', dayBefore = null, highlight = null, highlightKey = null }: { roomId: string; messages: RoomMessage[]; pending: PendingSend[]; meId: string | null; members: UserRef[]; onThread?: (rootId: string, focus?: boolean) => void; onAskTrina?: (m: RoomMessage) => void; onAskFile?: (seed: SideSeed) => void; variant?: ListVariant; dayBefore?: string | null; highlight?: string | null; highlightKey?: string | null }) {
  // a picture's or file's 트리나에게 묻기 (its right-click menu): where this list asks about a message, it asks about a
  // file too, in the same side chat (the room page's, or the image viewer's column: `onAskFile`)
  const askFile = useMemo(() => (onAskTrina ? (fileId: string, name: string) => void (onAskFile ? onAskFile(fileSeed(fileId, name)) : askTrinaInRoom(roomId, fileSeed(fileId, name))) : null), [onAskTrina, onAskFile, roomId])
  const locale = useLocale()
  const runs = useMemo(() => groupRuns(messages), [messages])
  const [editing, setEditing] = useState<string | null>(null)
  // a phone edits in the box at the bottom of the list's place (the room's, or the thread's), where it has one on
  // screen (store/roomEdit.ts, RoomComposer.tsx); a computer, and a place with no box, inside the message
  const phone = useMediaQuery('(max-width: 767.98px)')
  const inBox = useRoomEdit((s) => s.editing)
  const placeOf = (m: RoomMessage) => (variant === 'timeline' ? placeKey(roomId) : placeKey(roomId, m.threadRootId ?? m.id))
  const startEdit = (m: RoomMessage) => {
    const place = placeOf(m)
    if (!phone || !hasRoomBox(place)) return setEditing(m.id)
    setEditing(null)
    useRoomEdit.getState().start(place, m.id)
    focusRoomBox(place)
    // the message stays in sight above the box (the keyboard comes up)
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[id="${messageDomId(m.id)}"]`)?.scrollIntoView({ block: 'nearest' }))
  }
  const loaded = useMemo(() => new Set(messages.map((m) => m.id)), [messages])
  const byId = usePeople((s) => s.byId)
  /** a mentioned person's name: the room's member list, else the directory */
  const names = useMemo(() => {
    const map = new Map<string, string>()
    // the directory last: it has a name changed since the member list was read
    for (const m of members) map.set(m.id, m.name)
    for (const p of Object.values(byId)) map.set(p.id, p.name)
    return map
  }, [byId, members])
  // the message a link points at, inside this list (the same message can be in the timeline and in its thread, a reply
  // sent to the room too): after the list has gone to its bottom (the page's layout effect), once. Like a quote's jump
  // below, only the place: the message is marked (`data-highlight`) for a moment, with no colour or box
  const list = useRef<HTMLDivElement>(null)
  const [lit, setLit] = useState<string | null>(null)
  const mark = (id: string) => {
    setLit(id)
    setTimeout(() => setLit((x) => (x === id ? null : x)), HIGHLIGHT_MS)
  }
  // a quote's name: to the quoted message
  const jump = (id: string) => {
    document.getElementById(messageDomId(id))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    mark(id)
  }
  // once for each place in the history that points at it (`highlightKey`): back at that place (a thread opened from it
  // closed) the reader stays where they scrolled; a notice clicked again picks it out again (lib/rooms.ts highlightNow)
  const shown = useRef(new Set<string>())
  useEffect(() => {
    if (!highlight || !loaded.has(highlight) || !highlightNow(shown.current, highlight, highlightKey)) return
    list.current?.querySelector<HTMLElement>(`[id="${messageDomId(highlight)}"]`)?.scrollIntoView({ block: 'center' })
    mark(highlight)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, highlightKey, loaded])
  const lastMine = runs.at(-1)?.messages[0]?.author?.id === meId && meId !== null && !runs.at(-1)?.messages[0]?.event
  // phones: a run's time only when it differs from the run above it ("오전 11:56" once for four messages of that minute)
  const repeats = useMemo(() => sameTimeAsAbove(runs, (iso) => timeOf(iso, locale)), [runs, locale])
  const where = useViewerWhere(roomId)

  return (
    <AskFile.Provider value={askFile}>
    <ViewerMeta where={where}>
    <div ref={list} data-testid="room-messages" onCopy={copyMessages}>
      {runs.map((run, i) => {
        const first = run.messages[0]!
        return (
          <Fragment key={run.key}>
            {run.newDay && !(i === 0 && dayBefore && localDayKey(dayBefore) === localDayKey(first.createdAt)) && <DayLine at={first.createdAt} />}
            {first.event ? <EventLine m={first} /> : (
            <RunShell
              face={first.app ? <AppTile service={serviceOf(first.app)} app={first.app} size="face" className="mt-0.5" /> : <RunFace user={first.author} ai={first.authorKind === 'ai'} />}
              // an app's message: its name (who set it up, a tap away) and the "App" tag, never a person
              name={first.app ? <AppSender roomId={roomId} app={first.app} /> : <RunName user={first.author} ai={first.authorKind === 'ai'} />}
              at={first.createdAt}
              repeat={repeats[i]}
            >
                {run.messages.map((m) => m.withheld ? (
                  <WithheldRow key={m.id} m={m} highlighted={lit === m.id} onJump={m.replyTo && loaded.has(m.replyTo.id) ? () => jump(m.replyTo!.id) : undefined} />
                ) : (
                  <Fragment key={m.id}>
                    <MessageRow
                      roomId={roomId}
                      m={m}
                      mine={!!meId && m.author?.id === meId}
                      names={names}
                      members={members}
                      meId={meId}
                      editing={editing === m.id}
                      inBox={phone && inBox[placeOf(m)] === m.id}
                      highlighted={lit === m.id}
                      onEdit={() => startEdit(m)}
                      onEditDone={() => setEditing(null)}
                      onEditAgain={() => setEditing((e) => e ?? m.id)}
                      onThread={onThread}
                      onAskTrina={onAskTrina}
                      variant={variant}
                      // the list's first message (the top of the room, a thread's root): its bar goes under it, where the
                      // header above cannot cut it
                      barBelow={variant !== 'reply' && m.id === messages[0]?.id}
                      onJump={m.replyTo && loaded.has(m.replyTo.id) ? () => jump(m.replyTo!.id) : undefined}
                    />
                  </Fragment>
                ))}
            </RunShell>
            )}
          </Fragment>
        )
      })}
      {pending.length > 0 && (
        <div className={clsx('pl-11', !lastMine && 'pt-2')} data-testid="room-pending">
          {pending.map((p) => (
            <PendingRow key={p.clientMessageId} roomId={roomId} p={p} />
          ))}
        </div>
      )}
    </div>
    </ViewerMeta>
    </AskFile.Provider>
  )
}

/** 트리나에게 묻기 about a file of the list (RoomMessages `askFile`); null: this list asks nothing */
const AskFile = createContext<((fileId: string, name: string) => void) | null>(null)

/** The right-click menu of a picture or file under a message (components/FileMenu.tsx): 이미지 복사 (a picture),
 * 링크 복사 (its message), 내려받기, 트리나에게 묻기 where the list asks. */
function useRoomFileMenu(f: RoomFile, item: ViewerItem, team?: RoomFileSave | null) {
  const ask = useContext(AskFile)
  return useFileMenu({ name: f.name, image: itemImage(item), link: itemLink(item), download: item.download, team: team ? { saved: !!team.saved, run: team.saved ? team.open : team.save } : null, ask: ask ? () => ask(f.id, f.name) : null })
}

/** "Save to team folder" of a file under a message (docs/decisions/20261117-room-file-save-btn.md): where it is in the
 * team folder for me (store/roomSaves.ts), opening it there, or the save sheet for the message's files. null for a guest
 * (no team folder to save to; the server refuses them too). */
type RoomFileSave = { saved: string | undefined; open: () => void; save: () => void }
function useRoomFileSave(roomId: string, f: RoomFile, siblings: readonly RoomFile[]): RoomFileSave | null {
  // (a partial Me, as some tests give, counts as not a guest; the server decides anyway)
  const guest = useMe()?.user?.role === 'guest'
  const saved = useRoomSaves((s) => s.byRoom[roomId]?.[f.id])
  useEffect(() => { if (!guest) useRoomSaves.getState().load(roomId) }, [guest, roomId])
  if (guest) return null
  // a project room's file is in the team folder already (RoomFile.teamFile): its place there, nothing to save
  if (f.teamFile) return f.teamPath ? { saved: f.teamPath, open: () => navigateTo(`/files/view?path=${encodeURIComponent(f.teamPath!)}`), save: () => {} } : null
  // the tapped file first, then the message's other files (one sheet for all of them)
  const ids = [f.id, ...siblings.filter((x) => x.id !== f.id).map((x) => x.id)]
  const openPath = (p: string) => navigateTo(`/files/view?path=${encodeURIComponent(p)}`)
  return {
    saved,
    open: () => { if (saved) openPath(saved) },
    save: () => useRoomSaves.getState().open(roomId, ids),
  }
}

/** Where the room's pictures and files were sent, for the viewer's bar: "#마케팅에서", "디자인 리뷰에서", "벤 님과의 1:1
 * 대화에서" (the room's name as the 대화 list shows it). */
function useViewerWhere(roomId: string): string | null {
  const t = useT()
  const title = useRoomTitle()
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId))
  if (!room) return null
  const name = title(room)
  return room.kind === 'dm' ? t('viewer.inDm', { name }) : room.kind === 'group' ? t('viewer.inGroup', { room: name }) : t('viewer.inRoom', { room: name })
}

/** A department's team room whose files go to its group's folder (Room.groupFolder, for a viewer who can open it;
 * docs/decisions/20261121-department-room-files.md): the group's name and its folder, so a file's place reads
 * "{group} › Chat attachments". null for every other room. */
function useGroupFolderBase(roomId: string): { name: string; folderPath: string } | null {
  const folderPath = useRooms((s) => { const r = s.rooms.find((x) => x.id === roomId); return r?.kind === 'team' ? r.groupFolder ?? null : null })
  const name = useRooms((s) => s.rooms.find((x) => x.id === roomId)?.name ?? '')
  return useMemo(() => (folderPath ? { name: name || (folderPath.split('/').pop() ?? folderPath), folderPath } : null), [folderPath, name])
}

/** A file's place under a folder of its room (`base`: a project's or a group's): "{name} › Chat attachments", or null
 * when the file is not under it. */
export function placeUnder(path: string, base: { name: string; folderPath: string } | null, locale: Locale = 'en'): string | null {
  if (!base) return null
  const folder = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  if (folder !== base.folderPath && !folder.startsWith(base.folderPath + '/')) return null
  return [base.name, ...folder.slice(base.folderPath.length + 1).split('/').filter(Boolean).map((s) => chatFilesWord(s, locale))].join(' › ')
}

/** A message's files that stay when it is deleted: kept in the team folder where I can open them (RoomFile.teamPath).
 * None for room-stored files (an ordinary room, a converted channel's older files): they go with the message. */
export const keptFiles = (m: Pick<RoomMessage, 'files'>): RoomFile[] => m.files.filter((f) => f.teamFile && f.teamPath)

/** The delete confirm's words for a message whose files are kept in the team folder (RoomFile.teamPath): the message
 * goes for everyone, and "The file stays in <project> › Chat attachments." (a department's room: "<group> › Chat
 * attachments"), that place a link to the folder the file is in now (it closes the confirm and opens it). `others`: the
 * message also has files kept in the room, which go with it. */
export function FileStaysLines({ project, at, n, others = false }: { project: Pick<NonNullable<Room['project']>, 'name' | 'folderPath'> | null; at: string; n: number; others?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const folder = at.slice(0, Math.max(0, at.lastIndexOf('/')))
  // the place as people read it: the project's (or the department's) name for its folder, then the folders under it
  const label = placeUnder(at, project, locale) ?? folder.split('/').map((s) => chatFilesWord(s, locale)).join(' › ')
  const href = `/files?path=${encodeURIComponent(folder)}`
  const parts = t('rooms.deleteFileStays', { n, place: '\u0000' }).split('\u0000')
  const place = (
    <a href={href} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; ev.preventDefault(); cancelDialog(); navigateTo(href) }} className="font-medium text-ink underline underline-offset-2" data-testid="room-delete-file-place">
      {label}
    </a>
  )
  return (
    <span className="block space-y-2" data-testid="room-delete-file-stays">
      <span className="block">{t(others ? 'rooms.deleteBody' : 'rooms.deleteBodyKeepsFiles')}</span>
      <span className="block">{parts.length === 2 ? <>{parts[0]}{place}{parts[1]}</> : t('rooms.deleteFileStays', { n, place: label })}</span>
    </span>
  )
}

/** "가나님이 방 이름을 '주간 회의'로 바꿨어요": the names as the directory has them now, the room name as plain text. */
function EventLine({ m }: { m: RoomMessage }) {
  const t = useT()
  const locale = useLocale()
  const nameOf = useNameOf()
  if (!m.event) return null
  // the chat attachments folder in my language (shown so everywhere: chatFilesWord), not the team's
  const text = eventText(m.event, m.author, { t, nameOf: (u) => nameOf(u) ?? t('rooms.goneUser'), folder: CHAT_FILES_FOLDER[locale] ?? CHAT_FILES_FOLDER.en })
  // a line that names a project: its name opens the project page only while I can open it now (eventProjectOf); in the
  // trash, deleted or out of my reach it is plain text
  const e = m.event
  const project = e.type === 'project_linked' || e.type === 'project_unlinked' || e.type === 'project_room' || e.type === 'project_made' ? eventProjectOf(e) : null
  let body: ReactNode = text
  if (project?.state === 'open' && (e.type === 'project_linked' || e.type === 'project_unlinked' || e.type === 'project_room' || e.type === 'project_made')) {
    const parts = t(e.type === 'project_made' ? 'rooms.event.projectMade' : projectEventKey(e), { actor: nameOf(m.author) ?? t('rooms.goneUser'), name: '\u0000' }).split('\u0000')
    body = parts.length === 2 ? <>{parts[0]}<a href={`/projects/${project.id}`} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; ev.preventDefault(); navigateTo(`/projects/${project.id}`) }} className="font-medium text-muted underline underline-offset-2 hover:text-ink" data-testid="room-event-project">{project.name}</a>{parts[1]}</> : text
  }
  return (
    <p id={messageDomId(m.id)} className="px-6 pt-3 pb-1 text-center text-xs break-words text-faint" title={formatDateTime(m.createdAt, locale)} data-testid="room-event" data-project={project?.state}>
      {body}
    </p>
  )
}


/** A root's thread under it: up to 3 faces, "답글 3개", the last reply's time; a dot when a thread I follow has replies I
 * have not read. One tap opens the thread. */
function MessageRow({ roomId, m, mine, names, members, meId, editing, inBox = false, highlighted = false, onEdit, onEditDone, onEditAgain, onThread, onAskTrina, variant, onJump, barBelow = false }: { roomId: string; m: RoomMessage; mine: boolean; names: Map<string, string>; members: UserRef[]; meId: string | null; editing: boolean; /** being edited in the box at the bottom (a phone): marked */ inBox?: boolean; /** picked out by a link or a quote's jump: marked, with no look */ highlighted?: boolean; onEdit: () => void; onEditDone: () => void; onEditAgain: () => void; onThread?: (rootId: string, focus?: boolean) => void; onAskTrina?: (m: RoomMessage) => void; variant: ListVariant; onJump?: () => void; barBelow?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const deleted = !!m.deletedAt
  const ai = m.authorKind === 'ai'
  const me = useMe()
  const app = m.app ?? null
  const room = useRooms((s) => (app ? s.rooms.find((r) => r.id === roomId) ?? null : null))
  const roomProject = useRooms((s) => projectRoomOf(s.rooms.find((r) => r.id === roomId) ?? {}))
  const groupBase = useGroupFolderBase(roomId)
  // an earlier AI answer: the person who asked puts it away; an owner or admin any answer they see; an app's message:
  // whoever manages the room's apps (the server's rooms/service.ts removable)
  const removable = mine || (ai && !!meId && (m.askedBy?.id === meId || me?.user.role === 'owner' || me?.user.role === 'admin')) || (!!app && mayManageApps(room, me))
  // an answer sent from someone's own AI chat: their note before `at`, the answer after it
  const shared = !ai && !deleted ? m.sharedAnswer ?? null : null
  const openable = useMemo(() => (ai || shared ? new Set(m.openable ?? []) : undefined), [ai, shared, m.openable])
  // a shared answer's links whose file went with it: the copy, for a viewer who may not open the team file
  const attached = useMemo(() => (shared ? attachedCopies(roomId, m) : undefined), [shared, roomId, m])
  // a mention is the name as it was typed: the person's name now (the directory) and as the member list has it, so
  // "@Ben" still stands out after Ben renamed himself
  const mentioned = useMemo(() => m.mentions.flatMap((id) => [...new Set([names.get(id) ?? '', members.find((x) => x.id === id)?.name ?? ''])].map((name) => ({ id, name }))), [m.mentions, names, members])
  const text = shared ? m.body.slice(0, shared.at).trim() : m.body
  // "@전체" stands out like a person's name (it mentions everyone); a shared answer's note marks only the people the
  // server kept as its mentions (none for the button's share; the AI's post_to_room: the room members the person's card
  // named, and its "@전체" when the asker wrote it: docs/decisions/20261118-ai-post-real-mentions.md) (the mention
  // highlight: me, or "@전체" in someone else's message)
  const marks = useMemo<MessageMention[]>(
    () => (ai ? mentioned : [...mentioned, ...allMentionNames(m, MENTION_ALL_WORDS)]).map((x) => ({ ...x, strong: x.id === meId || (x.id === ALL_MENTION_ID && m.author?.id !== meId), all: x.id === ALL_MENTION_ID })),
    [m, mentioned, ai, meId],
  )
  const [press, setPress] = useState(0)
  const pressedAt = useRef(0)
  // the emoji picker from the long-press sheet's "More emoji" (a sheet of its own)
  const [picking, setPicking] = useState(false)
  const menuOn = !deleted && !editing && (m.visibility === 'room' || removable)
  // a thread under it: only a message of the timeline for everyone, and only from the timeline (no thread in a thread)
  const threadOn = variant === 'timeline' && !!onThread && !m.threadRootId && m.visibility === 'room' && !deleted
  const reactOn = reactable(m) && !editing
  // "Ask Trina about this": a message with text that the whole room sees (or my own private one), not an event line
  const askOn = !!onAskTrina && !deleted && !editing && !m.event && !!m.body.trim()
  // a touch screen: no hover row on every message; a long press opens its menu (with the reactions on top)
  const longPress = useLongPress(() => {
    pressedAt.current = Date.now()
    setPress((n) => n + 1)
  })
  const { copy } = useCopy()
  const copyLink = async () => {
    // the team address when there is one: a link copied in the desktop app on the office network opens for the others too
    await copy(copyLinkOf(roomId, m.id, m.threadRootId, me?.team?.address, location.origin))
    toast({ level: 'success', text: t('rooms.menu.linkCopied') })
  }
  const placeLabel = usePlaceLabel()
  // only links on this team's own hosts get a chip or a card: the server reads ids on any host, so a look-alike
  // address of another site never shows a real-looking card under it
  const hosts = useLinkHosts()
  const ownLinks = useMemo(() => new Set(parseMessageLinks(m.body).filter((l) => hosts.has(l.host)).map((l) => l.messageId)), [m.body, hosts])
  const previews = useMemo(() => (!deleted && !editing ? (m.linkPreviews ?? []).filter((p) => ownLinks.has(p.messageId)) : []), [deleted, editing, m.linkPreviews, ownLinks])
  // (a removed one stays a chip: no card)
  const cards = previews.filter((p) => !p.removed)
  const removePreview = (linked: string) => void useRooms.getState().hidePreview(roomId, m.id, linked)
  // "Remove preview": my own message (not an AI answer, an app's card or a shared answer)
  const mayRemovePreview = mine && !ai && !app && !m.sharedAnswer
  const copyText = async () => {
    // an app's message: its card's plain words (its body escapes Markdown marks for older apps)
    await copy(app ? appPlainText(m) : m.body)
    toast({ level: 'success', text: t('rooms.copied') })
  }
  const del = async () => {
    // a project's chat room: the message goes, its files stay in the project's Chat attachments folder (docs/decisions/
    // 20261120-project-is-room.md D3), one line says where, a link to it
    // per file (RoomFile.teamPath: a file kept in the team folder that I can open there): those stay, and the line links
    // to where they are; a room-stored file (a converted channel's older files) goes with the message as before
    const kept = keptFiles(m)
    const body = kept.length ? <FileStaysLines project={roomProject ?? groupBase} at={kept[0]!.teamPath!} n={kept.length} others={kept.length < m.files.length} /> : t('rooms.deleteBody')
    const ok = await confirmDialog({ title: app ? t('roomApps.deleteTitle', { app: app.name }) : t('rooms.deleteTitle'), body, confirm: t('common.delete'), danger: true })
    if (!ok) return
    await useRooms
      .getState()
      .remove(roomId, m.id)
      .catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  }
  // (one element while nothing changes: PersonMarkdown is memo'd and would read the Markdown again for a new one)
  const meta = useMemo(() => (m.editedAt && !deleted ? <span className="ml-1 text-xs text-faint select-none">{t('rooms.edited')}</span> : null), [m.editedAt, deleted, t])
  // ⋮ 더 보기 (the hover bar) and the end of the long-press sheet: copy; my own message's edit; delete what I may (my own,
  // an AI answer I asked for, any AI answer for an owner or admin), with the confirm
  const moreItems: MenuItem[] = [
    ...(m.body ? [{ label: t('common.copy'), icon: <Copy size={14} aria-hidden />, onSelect: () => void copyText(), testId: 'message-copy' }] : []),
    // the message's address (docs/DECISIONS.md "Message links and their previews"): pasted elsewhere, it shows as a card
    ...(m.visibility === 'room' && !m.event ? [{ label: t('rooms.menu.copyLink'), icon: <Link2 size={14} aria-hidden />, onSelect: () => void copyLink(), testId: 'message-copy-link' }] : []),
    ...(mine && !ai && !m.sharedAnswer ? [{ label: t('common.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: onEdit, testId: 'message-edit' }] : []),
    ...(mayRemovePreview ? cards.map((p) => ({ label: cards.length > 1 ? `${t('rooms.link.removePreview')} · ${placeLabel(p)}` : t('rooms.link.removePreview'), icon: <X size={14} aria-hidden />, onSelect: () => removePreview(p.messageId), testId: 'message-remove-preview' })) : []),
    ...(removable ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void del(), danger: true, testId: 'message-delete' }] : []),
  ]
  return (
    <div
      id={messageDomId(m.id)}
      className={messageRowClass(inBox)}
      data-testid="room-message"
      data-highlight={highlighted ? '' : undefined}
      data-editing={inBox ? '' : undefined}
      data-ai={ai ? '' : undefined}
      data-app={app ? serviceOf(app) : undefined}
      data-visibility={m.visibility}
      {...(menuOn ? { ...longPress, onPointerDown: (e: React.PointerEvent) => !(e.target as Element).closest?.('[data-own-menu]') && longPress.onPointerDown(e) } : {})}
    >
      {/* a reply sent to the room too: in the timeline it says it belongs to a thread (a tap opens it); in the thread it
          says it went to the room as well */}
      {m.alsoInRoom && m.threadRootId && (variant === 'timeline' && onThread ? (
        <button type="button" onClick={() => onThread(m.threadRootId!)} className="mb-0.5 flex items-center gap-1 text-xs text-faint hover:text-ink hover:underline" data-testid="room-thread-reply-mark">
          <MessageSquareText size={12} aria-hidden />
          {t('rooms.threadReplyMark')}
        </button>
      ) : variant === 'reply' ? (
        <p className="mb-0.5 text-xs text-faint" data-testid="room-also-sent">{t('rooms.alsoSent')}</p>
      ) : null)}
      {ai ? <AskedBy m={m} onJump={onJump} /> : m.replyTo && <Quote q={m.replyTo} onJump={onJump} />}
      {/* the pictures in it say who sent them and when in the image viewer's bar, and its column shows their thread (a
          reply's thread, or the message's own; one that cannot have a thread, alone) */}
      <ViewerMeta sender={ai ? { kind: 'ai' } : { kind: 'user', user: m.author }} at={m.createdAt} messageId={m.id} rootId={m.threadRootId ?? m.id} threadable={!!m.threadRootId || (m.visibility === 'room' && !m.event)}>
      {ai && !deleted ? (
        <Markdown text={m.body} className={clsx('min-w-0', WORDS, ANSWER_QUOTES)} openable={openable} />
      ) : app && !deleted ? (
        // an app's card (components/rooms/AppCard.tsx): plain text, its one checked link (never Markdown, never links
        // found in its words); a reply in its thread as short lines; a quiet one (and the paused line) as one short line
        <AppCardText m={m} variant={variant === 'reply' && !m.alsoInRoom ? 'reply' : app.quiet && !app.example ? 'quiet' : 'card'} className={WORDS} />
      ) : editing ? (
        <EditForm roomId={roomId} m={m} initial={mentioned.filter((x) => x.name)} members={members} meId={meId} onDone={onEditDone} onAgain={onEditAgain} />
      ) : deleted ? (
        <p className={clsx('text-reading leading-reading text-faint', WORDS)}>{t('rooms.deleted')}</p>
      ) : (
        <>
          {text && (
            <MessageLinkPreviews.Provider value={previews.length ? previews : null}>
              <PersonMarkdown text={text} mentions={marks} className={clsx('min-w-0', WORDS, ANSWER_QUOTES)} after={meta} />
            </MessageLinkPreviews.Provider>
          )}
          {/* the messages it links to, as this viewer may see them (MessageLinkCard.tsx) */}
          {cards.map((p) => <MessageLinkCard key={p.messageId} p={p} nested={previews} onRemove={mayRemovePreview ? () => removePreview(p.messageId) : undefined} />)}
          {shared && <SharedAnswer text={m.body.slice(shared.at)} openable={openable} attached={attached} />}
          {m.files.length > 0 && <Files roomId={roomId} files={m.files} />}
          {!m.body && m.editedAt && <p className="leading-5">{meta}</p>}
        </>
      )}
      </ViewerMeta>
      {!deleted && <ReactionChips roomId={roomId} m={m} />}
      {variant === 'timeline' && onThread && !m.threadRootId && <ThreadLine summary={m.thread} onOpen={() => onThread(m.id)} testId="room-thread-line" />}
      {/* computers: the hover bar (reactions, reply in thread, ⋮); touch screens and phones: a long press opens the same
          as a sheet, with six emoji and "More emoji" on top (its own button never shows) */}
      {menuOn && (
        <>
          <MessageHoverBar react={reactOn ? { roomId, m } : null} below={barBelow} onThread={threadOn ? () => onThread!(m.id, true) : undefined} onAsk={askOn ? () => onAskTrina!(m) : undefined} more={moreItems} />
          <MenuButton
            label={t('rooms.messageMenu')}
            className="absolute top-0 right-0"
            buttonClassName="hidden!"
            testId="message-menu"
            openSignal={press}
            header={reactOn ? (close) => (
              <ReactionStrip
                className="justify-between"
                mine={(m.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji)}
                onPick={(e) => {
                  // the finger lifting after the long press is no pick
                  if (Date.now() - pressedAt.current < 400) return
                  close()
                  void useRooms.getState().react(roomId, m.id, e, !(m.reactions ?? []).some((r) => r.emoji === e && r.mine))
                }}
                onMore={() => {
                  if (Date.now() - pressedAt.current < 400) return
                  close()
                  // before the emoji sheet takes the focus (it gives it back on closing): no text field to give it back
                  // to, so the keyboard does not come back by itself
                  dismissKeyboard()
                  setPicking(true)
                }}
              />
            ) : undefined}
            items={[...(threadOn ? [{ label: t('rooms.replyInThread'), icon: <MessageSquareText size={14} aria-hidden />, onSelect: () => onThread!(m.id, true), testId: 'message-reply-thread' }] : []), ...(askOn ? [{ label: t('sideChat.askAbout'), icon: <AiMark place="menu" />, onSelect: () => onAskTrina!(m), testId: 'message-ask-trina-menu' }] : []), ...moreItems]}
          />
          {picking && reactOn && <ReactionPanel roomId={roomId} m={m} anchor={null} onClose={() => setPicking(false)} />}
        </>
      )}
    </div>
  )
}

/** An old answer hidden from me: who asked it (an AI answer, a click goes to the question) and one faint line; a
 * person's message (an answer they shared, a message an AI app sent for them) by its author's name above it. */
function WithheldRow({ m, highlighted, onJump }: { m: RoomMessage; highlighted: boolean; onJump?: () => void }) {
  const t = useT()
  return (
    <div id={messageDomId(m.id)} className="-mx-2 rounded-lg px-2 py-0.5 select-none" data-testid="room-message" data-withheld="" data-highlight={highlighted ? '' : undefined}>
      {m.authorKind === 'ai' && <AskedBy m={m} onJump={onJump} />}
      <p className={clsx('text-reading leading-reading text-faint', WORDS)} data-testid="room-withheld">{t(m.authorKind === 'ai' ? 'rooms.withheldAnswer' : 'rooms.withheldMessage')}</p>
    </div>
  )
}

/** A shared answer's links whose file went with it as a copy (RoomMessage.attachedLinks), as the preview panel opens
 * each copy; only files of this message. None (an older message, nothing attached): undefined. */
export function attachedCopies(roomId: string, m: Pick<RoomMessage, 'attachedLinks' | 'files'>): ReadonlyMap<string, PreviewFile> | undefined {
  const out = new Map<string, PreviewFile>()
  for (const l of m.attachedLinks ?? []) {
    const f = m.files.find((x) => x.id === l.fileId)
    if (f && !out.has(l.path)) out.set(l.path, roomPreview(roomId, f))
  }
  return out.size ? out : undefined
}

/** An answer someone sent from their own AI chat, under their note: a quiet quote headed "<AI> 답변", in Markdown like
 * the AI's answers here (`openable`: the team files in it this viewer may open; `attached`: the copies that went with
 * it, opened in their place; the others are their names after a lock). */
function SharedAnswer({ text, openable, attached }: { text: string; openable?: ReadonlySet<string>; attached?: ReadonlyMap<string, PreviewFile> }) {
  const t = useT()
  return (
    <figure className="mt-1 mb-0.5 rounded-r-lg border-l-2 border-line-strong bg-ink/[0.035] py-2 pr-3 pl-3" data-testid="room-shared-answer">
      <figcaption className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted" data-testid="room-shared-answer-head">
        <AiFaceInline />
        {t('shareRoom.quoteHead', { ai: aiName(t) })}
      </figcaption>
      {/* not a <blockquote>: the answer's own Markdown would take the quote marks a quote's paragraphs get; its own quotes
          go without them too (ANSWER_QUOTES) */}
      <Markdown text={text} className={clsx('min-w-0', WORDS, ANSWER_QUOTES)} openable={openable} attached={attached} />
    </figure>
  )
}

/** "○○ 님이 물어봄" above an earlier AI answer; a click goes to the question when it is loaded. */
function AskedBy({ m, onJump }: { m: RoomMessage; onJump?: () => void }) {
  const t = useT()
  const nameOf = useNameOf()
  const text = t('rooms.aiAskedBy', { name: nameOf(m.askedBy) ?? t('rooms.goneUser') })
  return onJump ? (
    <button type="button" onClick={onJump} className="mb-0.5 block max-w-full truncate text-left text-xs text-faint hover:text-ink hover:underline" data-testid="room-ai-asked-by">
      {text}
    </button>
  ) : (
    <p className="mb-0.5 truncate text-xs text-faint" data-testid="room-ai-asked-by">
      {text}
    </p>
  )
}

function Quote({ q, onJump }: { q: RoomQuote; onJump?: () => void }) {
  const t = useT()
  const nameOf = useNameOf()
  const what = q.withheld ? t('rooms.withheldMessage') : q.deleted ? t('rooms.deleted') : q.excerpt || (q.fileCount ? t('rooms.lastFiles', { n: q.fileCount }) : '')
  const ids = useId()
  // the jump is a button over the whole quote, and the links in the excerpt sit above it (a link inside a button is no
  // link); an excerpt the server cut with "…" at its length leaves an address cut there as text
  return (
    <div className={clsx('mt-0.5 mb-1 block max-w-full border-l-2 border-line-strong pl-2 text-left text-xs', onJump && 'relative z-[2] hover:border-ink')} data-testid="message-quote">
      {onJump && <button type="button" onClick={onJump} aria-labelledby={`${ids}n ${ids}t`} className="absolute inset-0 -left-0.5 rounded-sm" data-testid="message-quote-jump" />}
      <span id={`${ids}n`} className="block truncate font-medium text-muted">{q.app ? q.app.name : nameOf(q.author) ?? t('rooms.goneUser')}</span>
      <span id={`${ids}t`} className="block truncate text-faint [&_a]:relative">
        {/* an app's words are plain text: no link found in them (its body's escapes are undone by the server) */}
        {q.deleted || !q.excerpt ? what : q.app ? unescapeAppBody(q.excerpt) : <LinkedText text={q.excerpt} cut={q.excerpt.length >= ROOM_QUOTE_EXCERPT_MAX} oneLine />}
      </span>
    </div>
  )
}

function Files({ roomId, files }: { roomId: string; files: RoomFile[] }) {
  const me = useMe()
  // two or more pictures: an even gallery first, like Slack's (lib/imageGallery.ts), then the other files as chips
  const pictures = files.filter((f) => !f.state && f.kind === 'image' && f.thumb)
  const gallery = pictures.length > 1
  const chips = gallery ? files.filter((f) => !pictures.includes(f)) : files
  return (
    <>
      {gallery && <PictureGallery roomId={roomId} pictures={pictures} siblings={files} />}
      {chips.length > 0 && (
        <div className="mt-1 mb-0.5 flex flex-wrap items-start gap-2">
          {chips.map((f) =>
            f.state ? (
              <GoneFile key={f.id} state={f.state} />
            ) : f.kind === 'image' && f.thumb ? (
              <RoomPicture key={f.id} roomId={roomId} f={f} siblings={files} />
            ) : roomVideoFrame(f, me) ? (
              <RoomVideo key={f.id} roomId={roomId} f={f} siblings={files} />
            ) : (
              <FileChip key={f.id} roomId={roomId} f={f} siblings={files} />
            ),
          )}
        </div>
      )}
    </>
  )
}

/** A message's pictures (two or more) in rows of one height, each cropped to fill its tile, both edges lined up
 * (lib/imageGallery.ts). As wide as the column up to GALLERY_PX, so a phone scales it down. Each tile is the picture's
 * own button: the viewer with the whole picture and ← →, its menu, its label. "Only in this conversation" once under it
 * when every picture is kept in the room (a mix: in each tile's label). */
function PictureGallery({ roomId, pictures, siblings }: { roomId: string; pictures: RoomFile[]; siblings: readonly RoomFile[] }) {
  const t = useT()
  const rows = useMemo(() => galleryRows(pictures), [pictures])
  return (
    <div className="mt-1 mb-0.5 flex w-full flex-col" style={{ maxWidth: GALLERY_PX, gap: GALLERY_GAP_PX }} data-testid="room-gallery" data-count={pictures.length}>
      {rows.map((row, i) => (
        <div key={i} className="flex items-start" style={{ gap: GALLERY_GAP_PX }} data-testid="room-gallery-row">
          {row.map(({ file, ratio }) => <RoomPicture key={file.id} roomId={roomId} f={file} siblings={siblings} ratio={ratio} />)}
        </div>
      ))}
      {pictures.every((f) => f.roomOnly) && <span className="text-xs text-faint" aria-hidden data-testid="room-image-room-only">{t('rooms.file.roomOnly')}</span>}
    </div>
  )
}

/** A project room's file that is not there for me now (RoomFile.state; docs/decisions/20261120-project-is-room.md D3):
 * "File deleted" (trashed or deleted in Files: a restore brings the chip back) or "File unavailable" (moved where I cannot
 * open it). No name, no menu: the server sends nothing about it. */
function GoneFile({ state }: { state: 'deleted' | 'unavailable' }) {
  const t = useT()
  return (
    <span className="inline-flex items-center gap-1.5 rounded-xl border border-dashed border-line px-3 py-1.5 text-xs text-faint" data-testid="room-file-gone" data-state={state}>
      <FileX size={14} className="shrink-0" aria-hidden />
      {t(state === 'deleted' ? 'rooms.file.deleted' : 'rooms.file.unavailable')}
    </span>
  )
}

/** A photo under a message: its thumbnail opens the image viewer, with the original read through the room. `ratio`: a
 * tile of a gallery (PictureGallery), that wide for its height, the thumbnail cropped to fill it. */
function RoomPicture({ roomId, f, siblings, ratio }: { roomId: string; f: RoomFile; siblings: readonly RoomFile[]; ratio?: number }) {
  const t = useT()
  const make = (meta: ViewerMetaValue) => roomItem(roomId, f, meta)
  const viewer = useViewerItem(make)
  // a picture has no icons of its own: "Save to team folder" is in its menu (right-click, long press)
  const fileMenu = useRoomFileMenu(f, make(useViewerMeta()), useRoomFileSave(roomId, f, siblings))
  // a picture kept in the team folder (a project room's, a group channel's): its place in its name and tooltip
  // ("leads › Chat attachments"), as a file chip shows it; "Show in Files" is in its menu
  const words = useFolderWords()
  const groupBase = useGroupFolderBase(roomId)
  const locale = useLocale()
  const place = f.teamFile && f.teamPath ? placeUnder(f.teamPath, groupBase, locale) ?? folderOfPath(f.teamPath, words).full : null
  const label = [t('rooms.openImage', { name: f.name }), f.roomOnly ? t('rooms.file.roomOnly') : place].filter(Boolean).join(' · ')
  const tile = ratio !== undefined
  const src = roomFileUrl(roomId, f.id, { thumb: '1' })
  const picture = (
    <Tooltip label={label}>
      <button
        type="button"
        ref={viewer.ref}
        onClick={(e) => !fileMenu.guard(e) && viewer.open()}
        {...fileMenu.bind}
        aria-label={label}
        className={clsx('overflow-hidden rounded-lg', tile ? 'relative min-w-0' : 'border border-line')}
        style={tile ? { aspectRatio: ratio, flexGrow: ratio, flexBasis: 0 } : undefined}
        data-testid="room-image"
        data-file-name={f.name}
        data-room-only={f.roomOnly ? '' : undefined}
        data-team-file={f.teamFile ? '' : undefined}
      >
        {tile ? <TileThumb src={src} /> : <RoomThumb f={f} src={src} />}
      </button>
    </Tooltip>
  )
  if (tile) return <>{picture}{fileMenu.menu}</>
  return (
    <>
      {/* a picture kept in the room where files otherwise go to a team folder: "Only in this conversation" in its name
          and as a quiet caption under it, at every width (a phone has no tooltip) */}
      {f.roomOnly ? (
        <span className="inline-flex max-w-full flex-col items-start gap-0.5">
          {picture}
          <span className="text-xs text-faint" aria-hidden data-testid="room-image-room-only">{t('rooms.file.roomOnly')}</span>
        </span>
      ) : picture}
      {fileMenu.menu}
    </>
  )
}

/** A video under a message shows a frame of it (QA TC-7239): one the browser plays here (mp4, mov, webm within the
 * preview rules: lib/preview.ts roomFileOpens). Any other video stays a file chip. */
export function roomVideoFrame(f: Pick<RoomFile, 'name' | 'size' | 'kind' | 'state'>, me: Parameters<typeof roomFileOpens>[1]): boolean {
  return !f.state && previewKind(f.name) === 'video' && roomFileOpens(f, me)
}

/** A video under a message: its frame at 0.1 s, read by the browser itself (only the first parts of the file: the
 * server makes no poster), in a picture's box (thumbBox: 16:9 until its size is known) with a play mark; a click opens
 * the viewer's player, as a photo's thumbnail opens the photo. One this browser cannot decode becomes its file chip. */
function RoomVideo({ roomId, f, siblings }: { roomId: string; f: RoomFile; siblings: readonly RoomFile[] }) {
  const t = useT()
  const me = useMe()
  const make = (meta: ViewerMetaValue) => roomFileItem(roomId, f, me, meta)
  const viewer = useViewerItem(make)
  const fileMenu = useRoomFileMenu(f, make(useViewerMeta()), useRoomFileSave(roomId, f, siblings))
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  if (failed) return <FileChip roomId={roomId} f={f} siblings={siblings} />
  const label = f.roomOnly ? `${t('rooms.playVideo', { name: f.name })} · ${t('rooms.file.roomOnly')}` : t('rooms.playVideo', { name: f.name })
  const box = thumbBox(size ?? (f.width && f.height ? f : { width: 320, height: 180 }))
  const video = (
    <Tooltip label={label}>
      <button type="button" ref={viewer.ref} onClick={(e) => !fileMenu.guard(e) && viewer.open()} {...fileMenu.bind} aria-label={label} className="relative block max-w-full overflow-hidden rounded-lg border border-line bg-black" style={box} data-testid="room-video" data-file-name={f.name} data-room-only={f.roomOnly ? '' : undefined}>
        <video
          src={`${roomFileUrl(roomId, f.id)}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          aria-hidden
          onLoadedMetadata={(e) => {
            const { videoWidth: width, videoHeight: height } = e.currentTarget
            if (width && height) setSize({ width, height })
          }}
          onError={() => setFailed(true)}
          className="pointer-events-none block size-full object-cover"
          data-testid="room-video-frame"
        />
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
          <span className="flex size-11 items-center justify-center rounded-full bg-black/55 text-white">
            <Play size={20} className="translate-x-px" fill="currentColor" />
          </span>
        </span>
      </button>
    </Tooltip>
  )
  return (
    <>
      {f.roomOnly ? (
        <span className="inline-flex max-w-full flex-col items-start gap-0.5">
          {video}
          <span className="text-xs text-faint" aria-hidden data-testid="room-video-room-only">{t('rooms.file.roomOnly')}</span>
        </span>
      ) : video}
      {fileMenu.menu}
    </>
  )
}

/** A file under a message: its name and size open it in the viewer, in the pane's list with its pictures (a document as
 * the side panel draws it; one with no preview here, such as a ZIP, a Hangul file while the HWP preview is off or one
 * past the preview limit, as its card with the download: `data-opens` marks a chip with a preview, lib/preview.ts
 * roomFileOpens), "Save to team folder" (on hover and focus with a mouse; on a touch screen in the long-press menu) or
 * its place in the team folder, and a small download icon sits at its end (on phones 44px wide, so its tap area never reaches over
 * the name; touch-hit gives the height). Each button is named by the words on it first (the name and size), then what
 * it does: a screen reader and voice control hear those words (WCAG 2.5.3). */
function FileChip({ roomId, f, siblings }: { roomId: string; f: RoomFile; siblings: readonly RoomFile[] }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const make = (meta: ViewerMetaValue) => roomFileItem(roomId, f, me, meta)
  const viewer = useViewerItem(make)
  const team = useRoomFileSave(roomId, f, siblings)
  const fileMenu = useRoomFileMenu(f, make(useViewerMeta()), team)
  const download = () => startDownload(roomFileUrl(roomId, f.id, { download: '1' }), f.name)
  const opens = roomFileOpens(f, me)
  const groupBase = useGroupFolderBase(roomId)
  return (
    <span className="group/chip inline-flex max-w-full items-stretch rounded-xl border border-line bg-surface text-xs" data-testid="room-file" data-opens={opens ? '' : undefined} data-file-name={f.name} {...fileMenu.bind}>
      {fileMenu.menu}
      <button type="button" ref={viewer.ref} onClick={(e) => !fileMenu.guard(e) && viewer.open()} className="inline-flex min-w-0 items-center gap-2 rounded-l-xl py-1.5 pr-1 pl-2.5 hover:bg-hover" data-testid="room-file-open">
        <FileText size={15} className="shrink-0 text-muted" aria-hidden />
        <span className="max-w-[220px] truncate font-medium text-ink">{f.name}</span>
        <span className="shrink-0 text-faint">{formatSize(f.size, locale)}</span>
        {/* kept in the room where files otherwise go to a team folder (RoomFile.roomOnly), at every width: a phone shows
            the short words ("Here only") so the name keeps its room, and hears the whole label */}
        {f.roomOnly && (
          <span className="shrink-0 text-faint" data-testid="room-file-room-only">
            <span className="max-md:hidden">{t('rooms.file.roomOnly')}</span>
            <span className="md:hidden" aria-hidden>{t('rooms.file.roomOnlyShort')}</span>
            <span className="sr-only md:hidden">{t('rooms.file.roomOnly')}</span>
          </span>
        )}
        {/* what the name does: a preview (a file without one opens its card, named by its name alone) */}
        {opens && <span className="sr-only">{t('common.preview')}</span>}
      </button>
      {/* in the team folder where I can open it: a quiet link to it (its folder's name; the whole place in the tooltip) */}
      {team?.saved && <InTeamLink path={team.saved} onOpen={team.open} place={f.teamFile ? placeUnder(team.saved, groupBase, locale) : null} />}
      {/* not there yet: a small save icon beside the download, seen only on hover and keyboard focus with a mouse; its
          place is kept (a fixed 24px) so the chip never changes width and a row of chips never re-wraps; on a touch
          screen it is not there at all (the long-press menu has it) */}
      {team && !team.saved && (
        <Tooltip label={t('rooms.save.action')}>
          <button type="button" onClick={team.save} aria-label={t('rooms.save.actionFor', { name: f.name })} className="inline-flex w-6 shrink-0 items-center justify-center text-faint opacity-0 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/chip:opacity-100 group-focus-within/chip:opacity-100 pointer-coarse:hidden" data-testid="room-file-save">
            <FolderInput size={13} aria-hidden />
          </button>
        </Tooltip>
      )}
      <Tooltip label={t('common.download')}>
        <button type="button" onClick={download} aria-label={t('rooms.downloadFile', { name: f.name })} className="touch-hit inline-flex shrink-0 items-center justify-center rounded-r-xl pr-2.5 pl-1.5 text-faint hover:bg-hover hover:text-ink max-md:min-w-11 max-md:px-0" data-testid="room-file-download">
          <Download size={13} aria-hidden />
        </button>
      </Tooltip>
    </span>
  )
}

/** A room file in the team folder where I can open it: its folder's name, the whole place in the tooltip and the
 * accessible name ("In team folder · Company-wide › Acme › Quotes"); a tap opens the file. `place`: a department room's
 * file in its group's folder reads "{group} › Chat attachments" (placeUnder). */
export function InTeamLink({ path, onOpen, place }: { path: string; onOpen: () => void; place?: string | null }) {
  const t = useT()
  const found = folderOfPath(path, useFolderWords())
  const where = place ? { short: place, full: found.full } : found
  const label = t('rooms.save.inTeam', { folder: where.full })
  const cut = where.short.lastIndexOf(' › ')
  const head = cut > 0 ? where.short.slice(0, cut) : where.short
  const tail = cut > 0 ? where.short.slice(cut + 3) : ''
  return (
    <Tooltip label={label}>
      <button type="button" onClick={onOpen} aria-label={label} className={clsx('touch-hit inline-flex shrink-0 items-center gap-1 px-1.5 text-faint hover:bg-hover hover:text-ink', tail ? 'max-w-[220px]' : 'max-w-[140px]')} data-testid="room-file-in-team">
        <FolderCheck size={13} className="shrink-0 text-accent-text" aria-hidden />
        {/* a phone keeps the file's name readable: the icon alone, the place in its name. A place of several folders
            keeps its last one whole ("Chat attachments") and cuts the name before it first (TC-6732) */}
        {tail ? (
          <span className="flex min-w-0 max-md:hidden" data-testid="room-file-in-team-place">
            <span className="truncate" data-testid="room-file-in-team-head">{head}</span>
            <span className="shrink-0 whitespace-nowrap" data-testid="room-file-in-team-tail">{` › ${tail}`}</span>
          </span>
        ) : (
          <span className="truncate max-md:hidden">{where.short}</span>
        )}
      </button>
    </Tooltip>
  )
}

/** `onAgain`: the edit failed (the old text is back): open the box again, with the words typed */
function EditForm({ roomId, m, initial, members, meId, onDone, onAgain }: { roomId: string; m: RoomMessage; initial: UserRef[]; members: UserRef[]; meId: string | null; onDone: () => void; onAgain: () => void }) {
  const t = useT()
  // the box gives line breaks back as "\n" (a message from another app may have "\r\n"): the mentions' places are counted
  // in the same text
  const body0 = useMemo(() => lineBreaks(m.body), [m.body])
  const [kept] = useState(() => {
    const failed = failedEdits.get(m.id)
    failedEdits.delete(m.id)
    return failed ?? null
  })
  const start = kept?.text ?? body0
  const [draft, setDraft] = useState(start)
  const input = useRef<HTMLTextAreaElement>(null)
  // the mentions it has stand out as they do on the message (its "@전체" too), and stay mentions while they are whole;
  // a failed edit's text: the people it mentioned too
  const [picked] = useState(() => pickedInMessage(start, [...initial, ...(kept ? members.filter((x) => kept.mentions.includes(x.id)) : []), ...allMentionNames(m, MENTION_ALL_WORDS)]))
  // "@전체" only kept or taken out: an edit notifies nobody, so it cannot add one (the server refuses it)
  const everyone = m.mentionsAll ? { count: members.filter((x) => x.id !== meId).length } : null
  const mention = useMentionMenu({ text: draft, setText: setDraft, input, members, meId, initial: picked, everyone })
  // the new text shows at once and the box closes; a failure puts the old text back with its own toast (store/rooms.ts
  // edit) and opens the box again with the words typed
  const save = () => {
    const body = draft.trim()
    if (!body) return
    if (body === body0) return onDone()
    const mentions = mention.mentions(), all = mention.mentionsAll()
    onDone()
    void useRooms.getState().edit(roomId, m.id, body, mentions, all).then((ok) => {
      if (ok) return
      failedEdits.set(m.id, { text: draft, mentions })
      onAgain()
      setTimeout(() => failedEdits.delete(m.id), 1000)
    })
  }
  // as tall as its text (no line cut off under the buttons), then it scrolls; the buttons in their own row under it
  useAutoGrow(input, [draft])
  // the caret at the end of the text (as in the box at the bottom), once
  useLayoutEffect(() => {
    const ta = input.current
    if (!ta) return
    ta.setSelectionRange(ta.value.length, ta.value.length)
    ta.scrollTop = ta.scrollHeight
  }, [])
  return (
    <form
      className="my-1 flex flex-col gap-1.5 rounded-xl border border-field-border bg-surface px-3 pt-2 pb-2 transition has-[textarea:focus]:border-accent has-[textarea:focus]:ring-1 has-[textarea:focus]:ring-accent"
      data-testid="room-edit-form"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      {mention.list}
      <TokenTextarea
        ref={input}
        autoFocus
        rows={1}
        aria-label={t('rooms.editLabel')}
        value={draft}
        {...mention.inputProps}
        onKeyDown={(e) => {
          if (mention.onKeyDown(e)) return
          if (e.key === 'Escape') {
            e.preventDefault()
            onDone()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && !window.matchMedia?.('(pointer: coarse)').matches) {
            e.preventDefault()
            save()
          }
        }}
        className="block max-h-[min(24rem,50dvh)] min-h-0 resize-none overflow-y-auto bg-transparent p-0 text-reading leading-reading text-ink outline-none"
        data-testid="room-edit-input"
      />
      <div className="flex shrink-0 justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone} data-testid="room-edit-cancel">
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!draft.trim()} data-testid="room-edit-save">
          {t('common.save')}
        </Button>
      </div>
    </form>
  )
}

function PendingRow({ roomId, p }: { roomId: string; p: PendingSend }) {
  const t = useT()
  return (
    <div className="py-0.5" data-testid="room-pending-message" data-state={p.state}>
      {p.body && (
        <p className="text-reading leading-reading break-words whitespace-pre-wrap text-muted">
          <LinkedText text={capBlankLines(p.body)} menu={false} />
        </p>
      )}
      {p.files.length > 0 && <p className="truncate text-xs text-muted">{p.files.map((f) => f.name).join(', ')}</p>}
      {p.state === 'sending' ? (
        <p className="text-xs text-faint" role="status" data-testid={p.updating ? 'room-send-waiting-update' : undefined}>
          {p.updating ? t('conn.updatingUnsent') : t('rooms.sending')}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="alert">
          {p.restored ? (
            // kept from before the app closed: it may have reached the server (store/rooms.ts keptUnsent)
            <span className="text-muted">{t('rooms.notConfirmed')}</span>
          ) : (
            <span className="text-danger">
              {t('rooms.sendFailed')}
              {p.error && ` · ${p.error}`}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => useRooms.getState().retry(roomId, p.clientMessageId)}>
            {t('common.retry')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => useRooms.getState().discard(roomId, p.clientMessageId)}>
            {t('rooms.discard')}
          </Button>
        </div>
      )}
    </div>
  )
}
