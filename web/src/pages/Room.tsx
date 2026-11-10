// One room (/rooms/:roomId; the mobile app links here from a notice): a 48px header with the room's name (its mark
// beside it on computers) and member count, which open the room's info (components/rooms/MembersDialog.tsx: the name,
// 초대하기, the members), and the bell (my notifications for the room, components/rooms/RoomNotifyMenu.tsx); the messages (components/rooms/RoomMessages.tsx),
// older ones loaded on scrolling up; the message box at the bottom (a file dropped anywhere on the room's column, its
// header, messages or box, goes into the box: components/FileDropZone.tsx). What I see is marked read (POST
// /api/rooms/:id/read with the newest message) while the window has the focus and the bottom of the room is in sight.
// A link or a search result (?m=<message>) older than the newest page opens the room as a window around it
// (store/rooms.ts loadAround): newer pages load on scrolling down, nothing in it is marked read, new messages wait, and
// "최근 메시지로" (or sending) goes back to the newest.
// Phones: a back arrow in the header (the bottom tab bar stays away here: the box and the keyboard need the room).
// A thread (/rooms/:roomId/t/:messageId, components/rooms/ThreadPanel.tsx) opens beside the room on computers and over
// it on phones; while threads I follow have new replies, a small thread mark in the header opens the newest of them.
// ✦ opens my Trina side chat (components/rooms/SideChatPanel.tsx) in the same place: one of the two at a time, in the
// room's right column (components/rooms/RoomSideColumn.tsx). Which one shows is in the rooms store (side), so the file
// viewer can start the same way.
// Beside the bell, the room's "⋯" (components/rooms/RoomMenu.tsx: 알림 설정, 이름 바꾸기 for those who may, 링크 복사,
// and 대화방 나가기 or 숨기기 by kind). A room I hid opens all the same (a link, a notice, the full list) and is shown again by opening it
// (docs/DECISIONS.md "대화 숨기기").
import { ArrowDown, ChevronLeft, Loader2, MessagesSquare } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useNavigationType, useParams, type NavigationType } from 'react-router-dom'
import { isUuid7, type RoomMember, type RoomMessage } from '@mycel/shared/api'
import { errorText, isApiError } from '../lib/api'
import { lookingAt } from '../lib/attention'
import { newestSeq, threadClosing, threadOpening } from '../lib/rooms'
import { useBackLink } from '../lib/back'
import { followsAfterScroll, jumpToBottom, stickToBottom } from '../lib/stickToBottom'
import { useLocale, useT } from '../i18n'
import { usePeople, usePeopleList } from '../store/people'
import { useRooms, type PendingSend } from '../store/rooms'
import { useMe } from '../store/session'
import { MembersDialog } from '../components/rooms/MembersDialog'
import { PeoplePicker, type PickerMode } from '../components/rooms/PeoplePicker'
import { RoomComposer } from '../components/rooms/RoomComposer'
import { RoomMessages } from '../components/rooms/RoomMessages'
import { ImageGroup } from '../components/ImageViewer'
import { RoomAiStatus } from '../components/rooms/RoomAiStatus'
import { RoomIcon, useRoomTitle } from '../components/rooms/RoomIcon'
import { RoomMenu } from '../components/rooms/RoomMenu'
import { RoomNotifyMenu } from '../components/rooms/RoomNotifyMenu'
import { ThreadPanel } from '../components/rooms/ThreadPanel'
import { SideChatPanel, type SideSeed } from '../components/rooms/SideChatPanel'
import { RoomSideColumn } from '../components/rooms/RoomSideColumn'
import { AiMark } from '../components/rooms/AiFace'
import { aiName } from '../lib/tabs'
import { messageSeed, onAskTrinaInRoom } from '../lib/sideChatAsk'
import { EmptyState, ErrorNote, IconButton, Skeleton } from '../components/ui'
import { FileDropZone } from '../components/FileDropZone'
import { Tooltip } from '../components/Tooltip'
import { PresenceDot, PresenceText } from '../components/Presence'
import { StatusDmLine } from '../components/StatusMessage'
import { usePresenceOf } from '../store/presence'

/** Was the room opened by a choice (a tap, a link, a notice: a room I hid is shown again), not by the history's back or
 * forward inside the app or by the page reloading itself (an update, a refresh: docs/DECISIONS.md "대화 숨기기")?
 * `firstEntry`: the page's first address (react-router's key "default"); `documentLoad`: how the page itself was
 * loaded (PerformanceNavigationTiming.type). Going back to the page's first entry reads as the link that opened it. */
export function openedByChoice(navType: `${NavigationType}`, firstEntry: boolean, documentLoad: string | undefined): boolean {
  if (navType !== 'POP') return true
  return firstEntry && documentLoad !== 'reload' && documentLoad !== 'back_forward'
}
const documentLoad = () => {
  try { return (performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined)?.type } catch { return undefined }
}

const NO_MESSAGES: RoomMessage[] = []
const NO_PENDING: PendingSend[] = []

export default function RoomPage() {
  const { roomId = '', messageId } = useParams()
  if (!isUuid7(roomId)) return <RoomNotFound />
  // the same view with or without a thread: opening one keeps the room as it is (its scroll, its box)
  return <RoomView key={roomId} roomId={roomId} threadId={messageId && isUuid7(messageId) ? messageId : null} badThread={!!messageId && !isUuid7(messageId)} />
}

function RoomNotFound() {
  const t = useT()
  const backLink = useBackLink()
  return (
    <div className="flex h-full flex-col justify-center" data-testid="room-not-found">
      <EmptyState title={t('rooms.notFound')}>
        <p>{t('rooms.notFoundHint')}</p>
        <Link to="/rooms" replace onClick={backLink} className="mt-3 inline-block font-medium text-accent-text underline">
          {t('rooms.back')}
        </Link>
      </EmptyState>
    </div>
  )
}

function RoomView({ roomId, threadId, badThread }: { roomId: string; threadId: string | null; badThread: boolean }) {
  const t = useT()
  // ‹ goes back where I came from (else the 대화 list in place of the room): the phone's own back never loops
  const backLink = useBackLink()
  const locale = useLocale()
  const me = useMe()
  const meId = me?.user.id ?? null
  const title = useRoomTitle()
  const navigate = useNavigate()
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId) ?? null)
  const loaded = useRooms((s) => s.loaded)
  const timeline = useRooms((s) => (s.timeline?.roomId === roomId ? s.timeline : null))
  const allPending = useRooms((s) => s.pending[roomId]) ?? NO_PENDING
  // the timeline's own sends (a thread's are in its panel)
  const pending = useMemo(() => allPending.filter((p) => !p.threadRootId), [allPending])
  const roomMembers = useRooms((s) => s.members[roomId]) as RoomMember[] | undefined
  const members = useMemo(() => (roomMembers ?? []).map((m) => m.user), [roomMembers])
  const [missing, setMissing] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  // ✦ Trina: my private side chat beside the room (components/rooms/SideChatPanel.tsx), where a thread opens: one of
  // the two at a time (a thread that opens closes it). In the store (side), gone when the page leaves the room
  const sideOpen = useRooms((s) => s.side[roomId] === 'trina')
  const setSideOpen = useCallback((on: boolean) => useRooms.getState().setSide(roomId, on ? 'trina' : null), [roomId])
  useEffect(() => { if (threadId) setSideOpen(false) }, [threadId, setSideOpen])
  // "Ask Trina about this" on a message (the timeline's or a thread's): the side chat opens with it quoted
  const [sideSeed, setSideSeed] = useState<SideSeed | null>(null)
  const askTrina = useCallback((m: RoomMessage) => {
    setSideSeed(messageSeed(m, aiName(t)))
    setSideOpen(true)
  }, [t, setSideOpen])
  // "reply in thread" puts the cursor in the thread's box; a thread opened from its summary line or a link does not
  const [focusThread, setFocusThread] = useState(false)
  const location = useLocation()
  const fromRoom = !!(location.state as { fromRoom?: boolean } | null)?.fromRoom
  // ?m=<message>: the message a link points at (an Inbox row: components/settings/RoomNoticeRow.tsx), picked out in the
  // thread when one is open, else in the timeline
  const target = useMemo(() => { const m = new URLSearchParams(location.search).get('m'); return m && isUuid7(m) ? m : null }, [location.search])
  // a thread opened from this room is one step back from it (the back arrow, the browser's back, a phone's back
  // gesture all close it); one thread replaces another and keeps how the first was reached; a thread opened from a link
  // or a notice closes to its room
  const openThread = useCallback((id: string, focus = false) => {
    setFocusThread(focus)
    const to = threadOpening(roomId, id, { threadId, fromRoom })
    navigate(to.path, { replace: to.replace, state: to.state })
  }, [navigate, roomId, threadId, fromRoom])
  const closeThread = useCallback(() => {
    const to = threadClosing(roomId, fromRoom)
    if (to === -1) navigate(-1)
    else navigate(to.path, { replace: to.replace })
  }, [navigate, roomId, fromRoom])
  // "Ask Trina about this file" in the file preview of a file of this room (lib/sideChatAsk.ts)
  useEffect(() => onAskTrinaInRoom((a) => {
    if (a.roomId !== roomId) return
    if (threadId) closeThread()
    setSideSeed(a.seed)
    setSideOpen(true)
  }), [roomId, threadId, closeThread, setSideOpen])
  // 초대하기: into this group chat, or from a DM a new group chat with the other person ticked (the DM stays)
  const [picker, setPicker] = useState<PickerMode | null>(null)
  // the "⋯"'s 알림 설정 opens the bell's own menu
  const [notifyRequest, setNotifyRequest] = useState(0)
  usePeopleList()
  // opened while I hid it (a link, a notice, the full list): it is in my lists again. Only as it opens, and only when
  // that was a choice (openedByChoice): hiding it from here leaves the room in place of this entry (store/rooms.ts
  // setHidden), another device hiding it while it is on screen keeps it hidden, and Back or a reload does not bring it
  // back either
  const navType = useNavigationType()
  const [byChoice] = useState(() => openedByChoice(navType, location.key === 'default', documentLoad()))
  const shownOnOpen = useRef(false)
  useEffect(() => {
    if (!room || shownOnOpen.current) return
    shownOnOpen.current = true
    if (room.hidden && byChoice) void useRooms.getState().setHidden(room.id, false).catch(() => {})
  }, [room, byChoice])

  useEffect(() => {
    useRooms.getState().open(roomId)
    return () => useRooms.getState().close(roomId)
  }, [roomId])
  // not in my list (yet): ask for the room itself; "not found" when I am not in it
  useEffect(() => {
    if (!loaded || room || missing) return
    useRooms
      .getState()
      .fetchRoom(roomId)
      .then((r) => !r && setMissing(true), () => {})
  }, [loaded, room, roomId, missing])
  // the message a link or a search result points at but not in the newest page: the page around it, once for each
  const aroundFor = useRef<string | null>(null)
  useEffect(() => {
    if (!target || threadId || !timeline || timeline.loading || timeline.error || aroundFor.current === target) return
    if (timeline.messages.some((m) => m.id === target)) return
    aroundFor.current = target
    void useRooms.getState().loadAround(roomId, target)
  }, [target, threadId, timeline, roomId])
  const notFound = missing || badThread || (!!timeline?.error && (isApiError(timeline.error, 'not_found') || isApiError(timeline.error, 'forbidden')))

  const messages = timeline?.messages ?? NO_MESSAGES
  // the AI at work here (components/rooms/RoomAiStatus.tsx): the bottom follows its steps too
  const aiKey = useRooms((s) => { const a = s.ai[roomId]; return a ? `${a.answering}:${a.runs.map((r) => `${r.state}${r.steps.length}`).join(',')}` : '' })
  const peerTitle = usePeople((s) => (room?.kind === 'dm' && room.peers[0] ? s.byId[room.peers[0].id]?.title : undefined)) || null
  // a DM: the other person's online status (docs/DECISIONS.md "접속 상태"), on their picture on a computer and as a dot
  // before the name on a phone (which shows no picture here)
  const peerId = room?.kind === 'dm' ? (room.peers[0]?.id ?? null) : null
  const peerState = usePresenceOf(peerId)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  /** where the list was last: its last scroll event or its own last jump to the bottom (followsAfterScroll) */
  const lastTop = useRef(0)
  const last = messages.at(-1)
  // a window around an older message: its bottom is not the room's, so nothing sticks to it
  const detached = !!timeline?.newerCursor
  const detachedNow = useRef(detached)
  detachedNow.current = detached

  // follow new messages while the reader is at the bottom (and always after my own send)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current && !detachedNow.current) jumpToBottom(el, lastTop)
  }, [last?.id, messages.length, pending.length, aiKey])
  // thumbnails load after the text, a card of the AI's appears or grows (its preview), and a phone's keyboard shrinks
  // the list: stay at the bottom if we were there, so the whole card is in sight above the message box
  useEffect(() => {
    const s = scroller.current, c = content.current
    if (!s || !c) return
    return stickToBottom(s, c, () => stick.current && !detachedNow.current, undefined, () => { lastTop.current = s.scrollTop })
  }, [])
  const toNewest = () => {
    stick.current = true
    void useRooms.getState().loadNewest(roomId)
  }

  const tryRead = useCallback(() => {
    const el = scroller.current
    const s = useRooms.getState()
    const r = s.rooms.find((x) => x.id === roomId)
    const th = s.timeline
    if (!el || !r || !th || th.roomId !== roomId || !th.messages.length) return
    // a window around an older message: the newest is not on screen
    if (th.newerCursor) return
    // the timeline out of sight (a phone shows the thread over it): nothing in it is read
    if (!el.clientHeight) return
    // on screen and looked at (the phone app: on screen; lib/attention.ts)
    if (!lookingAt()) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) return
    const seq = newestSeq(th.messages)
    if (seq > r.lastReadSeq) void s.markRead(roomId, seq)
  }, [roomId])
  useEffect(() => {
    tryRead()
  }, [tryRead, last?.seq, room?.lastReadSeq, room?.unreadCount])
  useEffect(() => {
    window.addEventListener('focus', tryRead)
    document.addEventListener('visibilitychange', tryRead)
    return () => {
      window.removeEventListener('focus', tryRead)
      document.removeEventListener('visibilitychange', tryRead)
    }
  }, [tryRead])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const th = useRooms.getState().timeline
    // near the bottom, or no move up since the list was there (followsAfterScroll); never in a window around an older
    // message, whose bottom is not the room's
    stick.current = followsAfterScroll(el, stick.current, lastTop.current) && !th?.newerCursor
    lastTop.current = el.scrollTop
    // a window around an older message: newer pages as its bottom comes into sight
    if (fromBottom < 200 && th?.roomId === roomId && th.newerCursor && !th.loading) void useRooms.getState().loadNewer(roomId)
    if (el.scrollTop < 200 && th?.roomId === roomId && th.nextCursor && !th.loading) {
      const before = el.scrollHeight
      void useRooms
        .getState()
        .loadOlder(roomId)
        .then(() =>
          requestAnimationFrame(() => {
            if (scroller.current) scroller.current.scrollTop += scroller.current.scrollHeight - before
          }),
        )
    }
    tryRead()
  }

  if (notFound) return <RoomNotFound />

  // threads I follow with replies I have not read: the newest of them is one tap away (none open already)
  const nextThread = room && room.threadsUnread > 0 && room.nextThreadId && room.nextThreadId !== threadId ? room.nextThreadId : null

  return (
    <div className="flex h-full" data-testid="room-page">
    {/* a file dropped anywhere on the room's column (not on the thread or side chat beside it) goes into its box */}
    <FileDropZone className={clsx('flex h-full min-w-0 flex-1 flex-col', (threadId || sideOpen) && 'max-md:hidden')} data-testid="room">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2 max-md:gap-1 max-md:pl-0.5 sm:px-4">
        <Tooltip label={t('tabs.back')}>
          <Link to="/rooms" replace onClick={backLink} aria-label={t('tabs.back')} className="inline-flex items-center justify-center rounded-md p-3 text-muted hover:bg-hover hover:text-ink md:hidden" data-testid="room-back">
            <ChevronLeft size={20} aria-hidden />
          </Link>
        </Tooltip>
        {/* the room's mark beside its name: computers only (on a phone the name is enough; a DM's picture is on the
            person's messages) */}
        {room && (
          <span className="flex shrink-0 max-md:hidden">
            <RoomIcon room={room} size={24} presence />
          </span>
        )}
        {/* the name opens the room's info (its name, 초대하기, the members); beside it how many are in it, and
            for a DM the other person's title (직함) small under their name, as the people list shows it */}
        <div className="min-w-0 flex-1">
          <h1 className="flex min-w-0 text-base font-medium text-ink">
            <button type="button" disabled={!room} onClick={() => setShowMembers(true)} className="touch-hit -mx-1 flex max-w-full min-w-0 items-baseline gap-2 rounded-md px-1 text-left hover:bg-hover [--presence-bg:var(--c-canvas)] hover:[--presence-bg:var(--c-hover)]" data-testid="room-members-button">
              {peerId && peerState !== 'offline' && <PresenceDot state={peerState} className="self-center md:hidden" />}
              <span className="truncate" data-testid="room-title">
                {room ? title(room) : ''}
              </span>
              {peerId && <PresenceText userId={peerId} offline />}
              {room && room.kind !== 'dm' && (
                <span className="shrink-0 text-xs font-normal text-faint" data-testid="room-member-count">
                  {t('rooms.members', { n: room.memberCount })}
                </span>
              )}
            </button>
          </h1>
          {peerTitle && (
            <p className="truncate text-xs text-muted" data-testid="room-peer-title">
              {peerTitle}
            </p>
          )}
        </div>
        {nextThread && (
          <IconButton tip label={t('rooms.threadsUnread', { n: room!.threadsUnread })} className="touch-hit relative shrink-0" onClick={() => openThread(nextThread)} data-testid="room-next-thread">
            <MessagesSquare size={16} aria-hidden />
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent" aria-hidden />
          </IconButton>
        )}
        {room && (
          <IconButton tip label={t('sideChat.open', { name: aiName(t) })} className={clsx('touch-hit shrink-0', sideOpen && 'bg-hover')} aria-pressed={sideOpen}
            onClick={() => { if (sideOpen) setSideOpen(false); else { if (threadId) closeThread(); setSideOpen(true) } }} data-testid="room-side-chat-button">
            <AiMark />
          </IconButton>
        )}
        {/* the room's one setting, right here: the bell shows how it is now and opens its four levels; then the room's
            "⋯" (its 알림 설정 opens the bell's menu) */}
        {room && <RoomNotifyMenu room={room} openRequest={notifyRequest} />}
        {room && <RoomMenu room={room} onNotify={() => setNotifyRequest((n) => n + 1)} className="shrink-0" buttonClassName="touch-hit" />}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="room-scroller">
        <div ref={content} className="mx-auto max-w-[780px] px-4 pt-2 pb-4">
          {timeline?.loading && messages.length > 0 && <Loader2 size={16} className="mx-auto my-2 animate-spin text-faint" aria-label={t('common.loading')} />}
          {timeline?.loading && !messages.length && <Skeleton lines={5} className="pt-4" />}
          {!!timeline?.error && !notFound && (
            <div className="pt-4">
              <ErrorNote onRetry={() => void useRooms.getState().loadNewest(roomId)}>{errorText(timeline.error, locale, t('error.network'))}</ErrorNote>
            </div>
          )}
          {timeline && !timeline.loading && !timeline.error && !messages.length && !pending.length && <p className="py-12 text-center text-sm text-muted">{t('rooms.empty')}</p>}
          {/* the timeline's pictures: ← → in the image viewer walks through these (the thread panel has its own) */}
          <ImageGroup>
            <RoomMessages roomId={roomId} messages={messages} pending={pending} meId={meId} members={members} onThread={openThread} onAskTrina={askTrina} highlight={threadId ? null : target} />
            <RoomAiStatus roomId={roomId} />
          </ImageGroup>
          {detached && timeline?.loading && <Loader2 size={16} className="mx-auto my-2 animate-spin text-faint" aria-label={t('common.loading')} />}
        </div>
      </div>
      {/* a window around an older message (a search result, a link): one tap back to the newest */}
      {detached && (
        <button type="button" onClick={toNewest} className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm text-muted shadow-md hover:bg-hover hover:text-ink" data-testid="room-to-newest">
          <ArrowDown size={14} aria-hidden />
          {t('rooms.toNewest')}
        </button>
      )}
      </div>
      <RoomComposer
        roomId={roomId}
        members={members}
        meId={meId}
        above={peerId ? <StatusDmLine userId={peerId} name={room ? title(room) : ''} /> : undefined}
        empty={!!timeline && !timeline.loading && !timeline.error && !messages.length && !pending.length}
        onSent={() => {
          stick.current = true
        }}
      />
      <MembersDialog
        open={showMembers}
        onClose={() => setShowMembers(false)}
        room={room}
        members={roomMembers}
        meId={meId}
        onInvite={() => {
          setShowMembers(false)
          setPicker(room?.kind === 'dm' ? { kind: 'new', preselect: room.peers.map((p) => p.id) } : { kind: 'invite', roomId })
        }}
      />
      <PeoplePicker open={!!picker} onClose={() => setPicker(null)} mode={picker ?? undefined} />
    </FileDropZone>
    {/* the room's right column: the thread in the address, else my Trina side chat */}
    {threadId ? (
      <RoomSideColumn label={t('rooms.thread')} testId="room-thread" divider="thread">
        <ThreadPanel frame={false} key={threadId} roomId={roomId} rootId={threadId} roomTitle={room ? title(room) : ''} members={members} meId={meId} onClose={closeThread} onAskTrina={(m) => { closeThread(); askTrina(m) }} focusBox={focusThread} highlight={target} />
      </RoomSideColumn>
    ) : sideOpen ? (
      <RoomSideColumn label={t('sideChat.title', { name: aiName(t) })} testId="room-side-chat" divider="side-chat">
        <SideChatPanel frame={false} key={roomId} roomId={roomId} roomTitle={room ? title(room) : ''} seed={sideSeed} onClose={() => setSideOpen(false)} />
      </RoomSideColumn>
    ) : null}
    </div>
  )
}
