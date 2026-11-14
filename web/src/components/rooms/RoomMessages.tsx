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
// list shows a thread's root and replies (variant). A photo's thumbnail and a file chip's name open the viewer
// (components/ImageViewer.tsx, like Slack's: the whole window, the pane's other pictures and files by ← →; the page's
// ImageGroup is the timeline or the thread; docs/DECISIONS.md "The room file viewer"): a photo with its zoom, a
// document drawn as the side panel draws it, a file with no preview here as its card with the download. The chip has a
// small download icon of its own. Both read the room's copy through the room (lib/imageViewer.ts roomItem,
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
import { Copy, Download, FileText, MessageSquareText, Pencil, Trash2 } from 'lucide-react'
import { createContext, Fragment, useContext, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { ROOM_QUOTE_EXCERPT_MAX, type Locale, type RoomFile, type RoomMessage, type RoomQuote, type UserRef } from '@mycel/shared/api'
import { errorText, roomFileUrl, startDownload } from '../../lib/api'
import { formatDateTime, formatSize, intlTag } from '../../lib/format'
import { copiedMessages } from '../../lib/messageCopy'
import { ALL_MENTION_ID, allMentionNames, eventText, groupRuns, lineBreaks, localDayKey, type MessageRun } from '../../lib/rooms'
import { aiName } from '../../lib/tabs'
import { Markdown, PersonMarkdown } from '../LazyMarkdown'
import { roomPreview, type PreviewFile } from '../../lib/sidePanel'
import { roomFileOpens } from '../../lib/preview'
import { useLocale, useT } from '../../i18n'
import { useAvatarOf, useNameOf, usePeople } from '../../store/people'
import { useMe } from '../../store/session'
import { useRooms, type PendingSend } from '../../store/rooms'
import { toast } from '../../store/ui'
import { Avatar } from '../Avatar'
import { TokenTextarea } from '../TokenTextarea'
import { Button, confirmDialog, inputCls, useCopy } from '../ui'
import { AiFace, AiFaceInline, AiMark } from './AiFace'
import { MenuButton, useLongPress, type MenuItem } from './MenuButton'
import { MessageHoverBar } from './MessageHoverBar'
import { reactable, ReactionChips, ReactionPanel, ReactionStrip } from './Reactions'
import { LinkedText } from './MessageText'
import type { MessageMention } from '../../lib/messageMarkdown'
import { MENTION_ALL_WORDS, pickedInMessage, useMentionMenu } from './useMentionMenu'
import { Tooltip } from '../Tooltip'
import { StatusEmoji } from '../StatusMessage'
import { useViewerItem, useViewerMeta, ViewerMeta } from '../ImageViewer'
import { roomFileItem, roomItem, type ViewerItem, type ViewerMetaValue } from '../../lib/imageViewer'
import { itemImage, itemLink } from '../../lib/fileMenu'
import { askTrinaInRoom, fileSeed } from '../../lib/sideChatAsk'
import { useFileMenu } from '../FileMenu'
import type { SideSeed } from './SideChatPanel'
import { dismissKeyboard } from '../../lib/viewport'
import { useRoomTitle } from './RoomIcon'
import { AppCardView, AppQuietLine, AppReplyLines, AppTile } from './apps/AppParts'
import { AppSender } from './apps/AppSender'
import { appPlainText } from '../../lib/roomApps'
import { mayManageApps } from '../../store/roomApps'

const timeOf = (iso: string, locale: Locale) => new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))
const dayOf = (iso: string, locale: Locale) => new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'full' }).format(new Date(iso))
export const messageDomId = (id: string) => `room-msg-${id}`
/** A message's words: the one part of its row that can be selected (not on touch screens, where a long press opens its
 * menu), and what a copy of several messages takes from it (lib/messageCopy.ts) */
const WORDS = 'select-text pointer-coarse:select-none'
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

/** For each run: its time reads the same as the time shown above it on the same day (a date line starts a new day).
 * Phones show such a time once: the first run of that minute has it. An event line shows no time, so a run compares
 * with the nearest message run above it, never with an event line. */
export function sameTimeAsAbove(runs: readonly MessageRun[], time: (iso: string) => string): boolean[] {
  let shown: string | null = null
  return runs.map((run) => {
    if (run.newDay) shown = null
    const first = run.messages[0]!
    if (first.event) return false
    const t = time(first.createdAt)
    const same = shown === t
    shown = t
    return same
  })
}

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

/** Where the list is: the room's timeline, or the thread panel's root, or its replies. */
export type ListVariant = 'timeline' | 'root' | 'reply'

/** How long a message picked out by a link (an Inbox row) stays marked. */
export const HIGHLIGHT_MS = 2400

/** `dayBefore`: the time of what is shown above the list (a thread's root): no second date line for that same day.
 * `highlight`: a message a link points at (an Inbox row: pages/Room.tsx ?m=): once it is on the list it is scrolled to
 * the middle and marked for a moment, once. */
/** `onAskTrina`: "Ask Trina about this" on a message (the room's side chat opens with it quoted) */
export function RoomMessages({ roomId, messages, pending, meId, members, onThread, onAskTrina, onAskFile, variant = 'timeline', dayBefore = null, highlight = null }: { roomId: string; messages: RoomMessage[]; pending: PendingSend[]; meId: string | null; members: UserRef[]; onThread?: (rootId: string, focus?: boolean) => void; onAskTrina?: (m: RoomMessage) => void; onAskFile?: (seed: SideSeed) => void; variant?: ListVariant; dayBefore?: string | null; highlight?: string | null }) {
  const t = useT()
  // a picture's or file's 트리나에게 묻기 (its right-click menu): where this list asks about a message, it asks about a
  // file too, in the same side chat (the room page's, or the image viewer's column: `onAskFile`)
  const askFile = useMemo(() => (onAskTrina ? (fileId: string, name: string) => void (onAskFile ? onAskFile(fileSeed(fileId, name)) : askTrinaInRoom(roomId, fileSeed(fileId, name))) : null), [onAskTrina, onAskFile, roomId])
  const locale = useLocale()
  const runs = useMemo(() => groupRuns(messages), [messages])
  const [editing, setEditing] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
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
  const nameOf = useNameOf()
  const jump = (id: string) => {
    document.getElementById(messageDomId(id))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(id)
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600)
  }
  // the message a link points at, inside this list (the same message can be in the timeline and in its thread, a reply
  // sent to the room too): after the list has gone to its bottom (the page's layout effect), once
  const list = useRef<HTMLDivElement>(null)
  const [lit, setLit] = useState<string | null>(null)
  const shown = useRef<string | null>(null)
  useEffect(() => {
    if (!highlight || shown.current === highlight || !loaded.has(highlight)) return
    shown.current = highlight
    list.current?.querySelector<HTMLElement>(`[id="${messageDomId(highlight)}"]`)?.scrollIntoView({ block: 'center' })
    setLit(highlight)
    setTimeout(() => setLit((x) => (x === highlight ? null : x)), HIGHLIGHT_MS)
  }, [highlight, loaded])
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
            {run.newDay && !(i === 0 && dayBefore && localDayKey(dayBefore) === localDayKey(first.createdAt)) && (
              <div role="separator" className="flex items-center gap-3 py-3 text-micro font-medium text-faint" data-testid="room-day">
                <span className="h-px flex-1 bg-line" aria-hidden />
                {dayOf(first.createdAt, locale)}
                <span className="h-px flex-1 bg-line" aria-hidden />
              </div>
            )}
            {first.event ? <EventLine m={first} /> : (
            <div className="flex gap-3 pt-2" data-testid="room-run">
              <RunAvatar m={first} />
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2" data-testid="room-run-head">
                  {/* an app's message: its name (who set it up, a tap away) and the "App" tag, never a person */}
                  {first.app ? <AppSender roomId={roomId} app={first.app} /> : <span className="truncate text-sm font-medium text-ink">{first.authorKind === 'ai' ? t('rooms.aiName') : (nameOf(first.author) ?? t('rooms.goneUser'))}</span>}
                  {first.authorKind !== 'ai' && first.author && <StatusEmoji userId={first.author.id} tap className="-ml-1 self-center text-sm select-none" />}
                  <time dateTime={first.createdAt} title={formatDateTime(first.createdAt, locale)} className={clsx('shrink-0 text-xs text-faint', repeats[i] && 'max-md:hidden')} data-repeat={repeats[i] ? '' : undefined}>
                    {timeOf(first.createdAt, locale)}
                  </time>
                </p>
                {run.messages.map((m) => m.withheld ? (
                  <WithheldRow key={m.id} m={m} flash={flash === m.id || lit === m.id} onJump={m.replyTo && loaded.has(m.replyTo.id) ? () => jump(m.replyTo!.id) : undefined} />
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
                      flash={flash === m.id || lit === m.id}
                      highlighted={lit === m.id}
                      onEdit={() => setEditing(m.id)}
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
              </div>
            </div>
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
function useRoomFileMenu(f: RoomFile, item: ViewerItem) {
  const ask = useContext(AskFile)
  return useFileMenu({ name: f.name, image: itemImage(item), link: itemLink(item), download: item.download, ask: ask ? () => ask(f.id, f.name) : null })
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

/** "가나님이 방 이름을 '주간 회의'로 바꿨어요": the names as the directory has them now, the room name as plain text. */
function EventLine({ m }: { m: RoomMessage }) {
  const t = useT()
  const locale = useLocale()
  const nameOf = useNameOf()
  if (!m.event) return null
  const text = eventText(m.event, m.author, { t, nameOf: (u) => nameOf(u) ?? t('rooms.goneUser') })
  return (
    <p id={messageDomId(m.id)} className="px-6 pt-3 pb-1 text-center text-xs break-words text-faint" title={formatDateTime(m.createdAt, locale)} data-testid="room-event">
      {text}
    </p>
  )
}

function RunAvatar({ m }: { m: RoomMessage }) {
  const user = useAvatarOf(m.author)
  if (m.app) return <AppTile kind={m.app.kind} name={m.app.name} size={32} className="mt-0.5" />
  if (m.authorKind === 'ai') return <AiFace size={32} className="mt-0.5" />
  return user ? <Avatar user={user} size={32} className="mt-0.5 select-none" /> : <span aria-hidden className="mt-0.5 size-8 shrink-0 rounded-full bg-hover" />
}

/** A root's thread under it: up to 3 faces, "답글 3개", the last reply's time; a dot when a thread I follow has replies I
 * have not read. One tap opens the thread. */
function ThreadLine({ m, onOpen }: { m: RoomMessage; onOpen: () => void }) {
  const t = useT()
  const locale = useLocale()
  const th = m.thread
  if (!th || th.replyCount <= 0) return null
  return (
    <button type="button" onClick={onOpen} className="touch-hit group/thread mt-1 -ml-1 flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs hover:bg-hover" data-testid="room-thread-line" data-new={th.newReplies ? '' : undefined}>
      {th.repliers.length > 0 && (
        <span className="flex shrink-0 gap-0.5" aria-hidden>
          {th.repliers.map((u) => <ReplierFace key={u.id} user={u} />)}
        </span>
      )}
      {th.newReplies && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
      <span className="shrink-0 font-medium text-accent-text group-hover/thread:underline">{t('rooms.threadReplies', { n: th.replyCount })}</span>
      {th.newReplies && <span className="sr-only">{t('rooms.threadNew')}</span>}
      {th.lastReplyAt && <span className="truncate text-faint">· {t('rooms.threadLast', { time: timeOf(th.lastReplyAt, locale) })}</span>}
    </button>
  )
}

function ReplierFace({ user }: { user: UserRef }) {
  const u = useAvatarOf(user)
  return u ? <Avatar user={u} size={18} /> : <span className="size-[18px] rounded-full bg-hover" />
}

function MessageRow({ roomId, m, mine, names, members, meId, editing, flash, highlighted = false, onEdit, onEditDone, onEditAgain, onThread, onAskTrina, variant, onJump, barBelow = false }: { roomId: string; m: RoomMessage; mine: boolean; names: Map<string, string>; members: UserRef[]; meId: string | null; editing: boolean; flash: boolean; highlighted?: boolean; onEdit: () => void; onEditDone: () => void; onEditAgain: () => void; onThread?: (rootId: string, focus?: boolean) => void; onAskTrina?: (m: RoomMessage) => void; variant: ListVariant; onJump?: () => void; barBelow?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const deleted = !!m.deletedAt
  const ai = m.authorKind === 'ai'
  const me = useMe()
  const app = m.app ?? null
  const room = useRooms((s) => (app ? s.rooms.find((r) => r.id === roomId) ?? null : null))
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
  // "@전체" stands out like a person's name (it mentions everyone); a shared answer's note mentions nobody (the server
  // keeps no mention on it) (the mention highlight: me, or "@전체" in someone else's message)
  const marks = useMemo<MessageMention[]>(
    () => (ai || shared ? mentioned : [...mentioned, ...allMentionNames(m, MENTION_ALL_WORDS)]).map((x) => ({ ...x, strong: x.id === meId || (x.id === ALL_MENTION_ID && m.author?.id !== meId), all: x.id === ALL_MENTION_ID })),
    [m, mentioned, ai, shared, meId],
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
  const copyText = async () => {
    // an app's message: its card's plain words (its body escapes Markdown marks for older apps)
    await copy(app ? appPlainText(m) : m.body)
    toast({ level: 'success', text: t('rooms.copied') })
  }
  const del = async () => {
    const ok = await confirmDialog({ title: app ? t('roomApps.deleteTitle', { app: app.name }) : t('rooms.deleteTitle'), body: t('rooms.deleteBody'), confirm: t('common.delete'), danger: true })
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
    ...(mine && !ai && !m.sharedAnswer ? [{ label: t('common.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: onEdit, testId: 'message-edit' }] : []),
    ...(removable ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void del(), danger: true, testId: 'message-delete' }] : []),
  ]
  return (
    <div
      id={messageDomId(m.id)}
      className={clsx('group relative -mx-2 rounded-lg px-2 py-0.5 transition select-none pointer-coarse:[-webkit-touch-callout:none]', flash ? 'bg-accent-soft' : 'hover:bg-subtle has-[[role=menu]]:bg-subtle has-[[aria-expanded=true]]:bg-subtle has-[:focus-visible]:bg-subtle')}
      data-testid="room-message"
      data-highlight={highlighted ? '' : undefined}
      data-ai={ai ? '' : undefined}
      data-app={app ? app.kind : undefined}
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
        // an app's card: plain text, its one checked link (never Markdown, never links found in its words); a reply in
        // its thread as short lines; a quiet one (and the paused line) as one short line
        m.appCard ? (
          variant === 'reply' && !m.alsoInRoom ? <AppReplyLines card={m.appCard} />
            : app.quiet && !app.example ? <AppQuietLine app={app} card={m.appCard} />
            : <AppCardView app={app} card={m.appCard} />
        ) : <p className={clsx('text-reading leading-reading break-words whitespace-pre-wrap text-ink', WORDS)}>{appPlainText(m)}</p>
      ) : editing ? (
        <EditForm roomId={roomId} m={m} initial={mentioned.filter((x) => x.name)} members={members} meId={meId} onDone={onEditDone} onAgain={onEditAgain} />
      ) : deleted ? (
        <p className={clsx('text-reading leading-reading text-faint', WORDS)}>{t('rooms.deleted')}</p>
      ) : (
        <>
          {text && <PersonMarkdown text={text} mentions={marks} className={clsx('min-w-0', WORDS, ANSWER_QUOTES)} after={meta} />}
          {shared && <SharedAnswer text={m.body.slice(shared.at)} openable={openable} attached={attached} />}
          {m.files.length > 0 && <Files roomId={roomId} files={m.files} />}
          {!m.body && m.editedAt && <p className="leading-5">{meta}</p>}
        </>
      )}
      </ViewerMeta>
      {!deleted && <ReactionChips roomId={roomId} m={m} />}
      {variant === 'timeline' && onThread && !m.threadRootId && <ThreadLine m={m} onOpen={() => onThread(m.id)} />}
      {/* computers: the hover bar (reactions, reply in thread, ⋮); touch screens and phones: a long press opens the same
          as a sheet, with six emoji and "More emoji" on top (its own button never shows) */}
      {menuOn && (
        <>
          <MessageHoverBar roomId={roomId} m={m} below={barBelow} reactOn={reactOn} onThread={threadOn ? () => onThread!(m.id, true) : undefined} onAsk={askOn ? () => onAskTrina!(m) : undefined} more={moreItems} />
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
function WithheldRow({ m, flash, onJump }: { m: RoomMessage; flash: boolean; onJump?: () => void }) {
  const t = useT()
  return (
    <div id={messageDomId(m.id)} className={clsx('-mx-2 rounded-lg px-2 py-0.5 transition select-none', flash && 'bg-accent-soft')} data-testid="room-message" data-withheld="">
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
    <div className={clsx('mt-0.5 mb-1 block max-w-full border-l-2 border-line-strong pl-2 text-left text-xs', onJump && 'relative hover:border-ink')} data-testid="message-quote">
      {onJump && <button type="button" onClick={onJump} aria-labelledby={`${ids}n ${ids}t`} className="absolute inset-0 -left-0.5 rounded-sm" data-testid="message-quote-jump" />}
      <span id={`${ids}n`} className="block truncate font-medium text-muted">{nameOf(q.author) ?? t('rooms.goneUser')}</span>
      <span id={`${ids}t`} className="block truncate text-faint [&_a]:relative">
        {q.deleted || !q.excerpt ? what : <LinkedText text={q.excerpt} cut={q.excerpt.length >= ROOM_QUOTE_EXCERPT_MAX} oneLine />}
      </span>
    </div>
  )
}

function Files({ roomId, files }: { roomId: string; files: RoomFile[] }) {
  return (
    <div className="mt-1 mb-0.5 flex flex-wrap items-start gap-2">
      {files.map((f) =>
        f.kind === 'image' && f.thumb ? (
          <RoomPicture key={f.id} roomId={roomId} f={f} />
        ) : (
          <FileChip key={f.id} roomId={roomId} f={f} />
        ),
      )}
    </div>
  )
}

/** A photo under a message: its thumbnail opens the image viewer, with the original read through the room. */
function RoomPicture({ roomId, f }: { roomId: string; f: RoomFile }) {
  const t = useT()
  const make = (meta: ViewerMetaValue) => roomItem(roomId, f, meta)
  const viewer = useViewerItem(make)
  const fileMenu = useRoomFileMenu(f, make(useViewerMeta()))
  return (
    <>
      <Tooltip label={t('rooms.openImage', { name: f.name })}>
        <button type="button" ref={viewer.ref} onClick={(e) => !fileMenu.guard(e) && viewer.open()} {...fileMenu.bind} aria-label={t('rooms.openImage', { name: f.name })} className="overflow-hidden rounded-lg border border-line" data-testid="room-image" data-file-name={f.name}>
          <RoomThumb f={f} src={roomFileUrl(roomId, f.id, { thumb: '1' })} />
        </button>
      </Tooltip>
      {fileMenu.menu}
    </>
  )
}

/** A file under a message: its name and size open it in the viewer, in the pane's list with its pictures (a document as
 * the side panel draws it; one with no preview here, such as a ZIP, a Hangul file while the HWP preview is off or one
 * past the preview limit, as its card with the download: `data-opens` marks a chip with a preview, lib/preview.ts
 * roomFileOpens), and a small download icon sits at its end (on phones 44px wide, so its tap area never reaches over
 * the name; touch-hit gives the height). Each button is named by the words on it first (the name and size), then what
 * it does: a screen reader and voice control hear those words (WCAG 2.5.3). */
function FileChip({ roomId, f }: { roomId: string; f: RoomFile }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const make = (meta: ViewerMetaValue) => roomFileItem(roomId, f, me, meta)
  const viewer = useViewerItem(make)
  const fileMenu = useRoomFileMenu(f, make(useViewerMeta()))
  const download = () => startDownload(roomFileUrl(roomId, f.id, { download: '1' }), f.name)
  const opens = roomFileOpens(f, me)
  return (
    <span className="inline-flex max-w-full items-stretch rounded-xl border border-line bg-surface text-xs" data-testid="room-file" data-opens={opens ? '' : undefined} data-file-name={f.name} {...fileMenu.bind}>
      {fileMenu.menu}
      <button type="button" ref={viewer.ref} onClick={(e) => !fileMenu.guard(e) && viewer.open()} className="inline-flex min-w-0 items-center gap-2 rounded-l-xl py-1.5 pr-1 pl-2.5 hover:bg-hover" data-testid="room-file-open">
        <FileText size={15} className="shrink-0 text-muted" aria-hidden />
        <span className="max-w-[220px] truncate font-medium text-ink">{f.name}</span>
        <span className="shrink-0 text-faint">{formatSize(f.size, locale)}</span>
        {/* what the name does: a preview (a file without one opens its card, named by its name alone) */}
        {opens && <span className="sr-only">{t('common.preview')}</span>}
      </button>
      <Tooltip label={t('common.download')}>
        <button type="button" onClick={download} aria-label={t('rooms.downloadFile', { name: f.name })} className="touch-hit inline-flex shrink-0 items-center justify-center rounded-r-xl pr-2.5 pl-1.5 text-faint hover:bg-hover hover:text-ink max-md:min-w-11 max-md:px-0" data-testid="room-file-download">
          <Download size={13} aria-hidden />
        </button>
      </Tooltip>
    </span>
  )
}

/** an edit that failed, by message: its box opens again with the words typed and the people they mention (EditForm);
 * kept a moment only (the box opens at once, or not: another message's box is open, the room was left) */
const failedEdits = new Map<string, { text: string; mentions: string[] }>()

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
  return (
    <form
      className="my-1 rounded-2xl border border-field-border bg-surface p-2 has-[textarea:focus]:border-accent has-[textarea:focus]:ring-1 has-[textarea:focus]:ring-accent"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      {mention.list}
      <TokenTextarea
        ref={input}
        autoFocus
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
        className={clsx(inputCls, 'h-auto min-h-16 resize-y border-0 py-2 focus:ring-0!')}
        data-testid="room-edit-input"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
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
          <LinkedText text={p.body} menu={false} />
        </p>
      )}
      {p.files.length > 0 && <p className="truncate text-xs text-muted">{p.files.map((f) => f.name).join(', ')}</p>}
      {p.state === 'sending' ? (
        <p className="text-xs text-faint" role="status">
          {t('rooms.sending')}
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
