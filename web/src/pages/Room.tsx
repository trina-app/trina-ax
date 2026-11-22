// One room (/rooms/:roomId; the mobile app links here from a notice): a 48px header with the room's name (its mark
// beside it on computers) and member count, which open the room's info (components/rooms/MembersDialog.tsx: the name,
// 초대하기, the members), and the bell (my notifications for the room, components/rooms/RoomNotifyMenu.tsx); the messages (components/rooms/RoomMessages.tsx),
// older ones loaded on scrolling up; the message box at the bottom (a file dropped anywhere on the room's column, its
// header, messages or box, goes into the box: components/FileDropZone.tsx). What I see is marked read (POST
// /api/rooms/:id/read up to the newest message in sight) while the window has the focus: not while a page is loading,
// and not over unread messages older than the pages loaded (lib/rooms.ts readUpTo).
// A link or a search result (?m=<message>) older than the newest page opens the room as a window around it
// (store/rooms.ts loadAround): newer pages load on scrolling down, nothing in it is marked read, new messages wait, and
// "최근 메시지로" (or sending) goes back to the newest, at the bottom with my reply in sight.
// Phones: a back arrow in the header (the bottom tab bar stays away here: the box and the keyboard need the room).
// A thread (/rooms/:roomId/t/:messageId, components/rooms/ThreadPanel.tsx) opens beside the room on computers and over
// it on phones; while threads I follow have new replies, a small thread mark in the header opens the newest of them.
// Until it is closed or ✦ is used, one line under the header says what ✦ is (components/rooms/RoomAskHint.tsx).
// ✦ opens my Trina side chat (components/rooms/SideChatPanel.tsx) on the room's right too (components/rooms/
// RoomSideColumn.tsx). A thread and the side chat show together (docs/decisions/20261117-thread-plus-trina.md;
// lib/roomColumns.ts): room, thread, side chat as three columns where the page's row holds them (the conversation list
// folds away first: components/rail/railPanel.ts); in a narrower row the thread and the side chat share it half and
// half over the room, which waits under them; where only one panel fits (a sheet, a phone) the side chat is over the
// thread and its ✕ or ‹ goes back to it. With a thread open the side chat's box says it is looking at that thread
// (SideChatPanel.tsx `thread`). Whether the side chat shows is in the rooms store (side), so the file viewer can start
// the same way. Its ✕ (‹ on a phone), ✦ again and leaving the room close the side chat: the next ✦ opens it afresh
// (store/sideChats.ts open). Where only one panel fits, a thread that opens takes its place (✦ brings the same chat
// back), and that thread closing closes it (SideChatPanel.tsx threadClosedOn).
// Beside the bell, the room's "⋯" (components/rooms/RoomMenu.tsx: 알림 설정, 이름 바꾸기 for those who may, 링크 복사,
// and 대화방 나가기 or 숨기기 by kind). A room I hid opens all the same (a link, a notice, the full list) and is shown again by opening it
// (docs/DECISIONS.md "대화 숨기기").
// Phones (QA TC-257): ‹, the name with the member count under it, ✦ and ⋯ only, so a long name has the room. The bell's
// choices are ⋯ › 알림 설정 (the level now after it; a crossed-out bell after the name when it is off), the threads with
// new replies are ⋯'s first entry (a dot on ⋯), and ⋯ has no 이름 바꾸기 (the name opens the room's info, where it is
// changed).
import { ArrowDown, BellOff, ChevronLeft, Files, Folder, Loader2, MessagesSquare } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useNavigationType, useParams, type NavigationType } from 'react-router-dom'
import { isUuid7, type RoomMember, type RoomMessage } from '@mycel/shared/api'
import { isApiError } from '../lib/api'
import { lookingAt, onWindowFocus } from '../lib/attention'
import { isPrivateChannel, readUpTo, roomFilesButtonShown, roomEmptyKey, threadClosing, threadOpening, timelineTarget, pushedMessagePath, withoutTarget } from '../lib/rooms'
import { roomColumns, roomSqueezed, useElementWidth } from '../lib/roomColumns'
import { getSidePanel } from '../lib/sidePanel'
import { PANEL_ALWAYS_BOTH_PX } from '../components/rail/railPanel'
import { PANEL_ID } from '../components/panels/PanelFrame'
import { useBackLink } from '../lib/back'
import { useOverlayEntry } from '../lib/backCloses'
import { holdPlace, listPlace, restorePlace, ROOM_ROW, useStickToBottom } from '../lib/stickToBottom'
import { useT } from '../i18n'
import { usePeople, usePeopleList, useReadPeopleFor } from '../store/people'
import { findMessage, keptFor, keptPlace, placeKey, useRooms, type PendingSend, type RoomPlace } from '../store/rooms'
import { useMe } from '../store/session'
import { useUi } from '../store/ui'
import { sideChatOf, useSideChats } from '../store/sideChats'
import { MembersDialog, SameAsGroupLine } from '../components/rooms/MembersDialog'
import { PeoplePicker, type PickerMode } from '../components/rooms/PeoplePicker'
import { RoomComposer } from '../components/rooms/RoomComposer'
import { messageDomId, RoomMessages } from '../components/rooms/RoomMessages'
import { ImageGroup } from '../components/ImageViewer'
import { RoomIcon, useRoomTitle } from '../components/rooms/RoomIcon'
import { RoomMenu } from '../components/rooms/RoomMenu'
import { mayManageApps, useRoomApps } from '../store/roomApps'
import { SaveToTeamSheet } from '../components/rooms/SaveToTeamSheet'
import { isAppService } from '../lib/roomApps'
import { RoomNotifyMenu, roomNotify } from '../components/rooms/RoomNotifyMenu'
import { ThreadPanel } from '../components/rooms/ThreadPanel'
import { handOffDone, handOffToThread, roomLeft, SideChatPanel, sideChatComesBack, threadClosedOn, type SideSeed, type SideThread } from '../components/rooms/SideChatPanel'
import { RoomSideColumn } from '../components/rooms/RoomSideColumn'
import { RoomFilesPanel } from '../components/rooms/RoomFilesPanel'
import { RoomAskHint, useRoomAskHint } from '../components/rooms/RoomAskHint'
import { AiMark } from '../components/rooms/AiFace'
import { aiName } from '../lib/tabs'
import { messageSeed, onAskTrinaInRoom } from '../lib/sideChatAsk'
import { buttonClass, EmptyState, IconButton, Skeleton, useMediaQuery } from '../components/ui'
import { LoadError } from '../components/LoadError'
import { FileDropZone } from '../components/FileDropZone'
import { Tooltip } from '../components/Tooltip'
import { PresenceDot, PresenceText } from '../components/Presence'
import { StatusDmLine } from '../components/StatusMessage'
import { usePresenceOf } from '../store/presence'
import { IncludesGuests, useGuestCount } from '../components/GuestTag'
import { useGuestAiOff } from '../components/GuestView'

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
/** the rows of the timeline by their message (a message, an event line): where the reader was is kept by them */
const ROOM_ROW_ID = messageDomId('')
const ROOM_PLACE_ROWS = `[id^="${ROOM_ROW_ID}"]`

/** the thread or side chat as a sheet over the room (a narrow computer window), or the side chat over the thread
 * where only one panel fits */
const SHEET = 'absolute inset-0 z-20 border-l-0! shadow-xl'
/** the thread and the side chat half and half over the room (a row too narrow for three columns) */
const PAIR_THREAD = 'absolute inset-y-0 left-0 z-20 w-1/2 border-l-0!'
const PAIR_SIDE = 'absolute inset-y-0 right-0 z-20 w-1/2'

export default function RoomPage() {
  const { roomId = '', messageId, target } = useParams()
  if (!isUuid7(roomId)) return <RoomNotFound />
  // …/m/<message>: a phone notification's tap (its path names no query: server/src/notifications/push-events.ts roomPath)
  // is the same place as ?m=<message>, in place of this address
  if (target !== undefined) return <Navigate replace to={pushedMessagePath(roomId, messageId ?? null, target)} />
  // the same view with or without a thread: opening one keeps the room as it is (its scroll, its box)
  return <RoomView key={roomId} roomId={roomId} threadId={messageId && isUuid7(messageId) ? messageId : null} badThread={!!messageId && !isUuid7(messageId)} />
}

function RoomNotFound() {
  const t = useT()
  const backLink = useBackLink()
  return (
    <div className="flex h-full flex-col justify-center" data-testid="room-not-found">
      <EmptyState screen title={t('rooms.notFound')}>
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
  const me = useMe()
  const meId = me?.user.id ?? null
  const title = useRoomTitle()
  const navigate = useNavigate()
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId) ?? null)
  const loaded = useRooms((s) => s.loaded)
  // (a room left a moment ago shows as it was from the first frame: kept until the open below takes it)
  const timeline = useRooms((s) => (s.timeline?.roomId === roomId ? s.timeline : keptFor(s, roomId)))
  const allPending = useRooms((s) => s.pending[roomId]) ?? NO_PENDING
  // the timeline's own sends (a thread's are in its panel)
  const pending = useMemo(() => allPending.filter((p) => !p.threadRootId), [allPending])
  const roomMembers = useRooms((s) => s.members[roomId]) as RoomMember[] | undefined
  const guestNoAi = useGuestAiOff()
  const members = useMemo(() => (roomMembers ?? []).map((m) => m.user), [roomMembers])
  const memberIds = useMemo(() => (roomMembers ?? []).map((m) => m.user.id), [roomMembers])
  // the header's count line is cut short on a phone: its full text stays on hover (QA TC-6127)
  const headerGuests = useGuestCount(memberIds)
  // someone who joined while the room is open: the directory says whether they are a guest (the tag, "Includes 1 guest")
  useReadPeopleFor(memberIds)
  const [missing, setMissing] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  // ✦ Trina: my private side chat beside the room (components/rooms/SideChatPanel.tsx), beside a thread when one is
  // open. In the store (side), gone when the page leaves the room
  const sideOpen = useRooms((s) => s.side[roomId] === 'trina')
  // the room's Files list (components/rooms/RoomFilesPanel.tsx) in the side chat's place: one of the two at a time, laid
  // out as the side chat is (beside a thread, over it, a sheet). `rightOpen`: either of them
  const filesOpen = useRooms((s) => s.side[roomId] === 'files')
  const rightOpen = sideOpen || filesOpen
  // (opened by the person: a hand-off to a thread, 보기, is over: SideChatPanel.tsx handOffDone)
  const setSideOpen = useCallback((on: boolean) => {
    if (on) handOffDone(roomId)
    useRooms.getState().setSide(roomId, on ? 'trina' : null)
  }, [roomId])
  // a phone's header: ‹, the name, ✦ and ⋯ only (QA TC-257)
  const wide = useMediaQuery('(min-width: 768px)')
  // a narrow computer window (below 812 px: the 72 px rail and a room of 420 px beside a 320 px thread do not fit;
  // docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1 "Thread rule"): the thread or the side chat is a sheet over the
  // room, as on a phone, and the room under it waits as it was
  const roomy = useMediaQuery('(min-width: 812px)')
  // the thread and the side chat together (lib/roomColumns.ts), by the width of the page's own row: three columns, the
  // two over the room, or one at a time (a phone; a row squeezed by a file preview beside the page)
  const page = useRef<HTMLDivElement>(null)
  // one panel alone in a row too narrow for the room's 420 px beside it (a file preview beside the page at 1440 px: QA
  // TC-r2b-06, the room was one character wide): it is a sheet over the room too (lib/roomColumns.ts roomSqueezed)
  const rowNow = useElementWidth(page)
  const sheet = wide && (!roomy || (!(threadId && rightOpen) && !!(threadId || rightOpen) && roomSqueezed(rowNow)))
  /** The row's width once the conversation list has folded for the two panels (components/rail/railPanel.ts): the
   * page as it is laid out now, plus the list while it still shows in a window where it folds for them. Read from the
   * page itself (the render in which the second panel opens comes before the list is gone, and before any resize is
   * told), so the first frame of the two is already the right layout. null: not laid out (a test). */
  const rowForBoth = useCallback((): number | null => {
    const now = page.current?.offsetWidth
    if (!now) return null
    const list = window.innerWidth < PANEL_ALWAYS_BOTH_PX ? document.getElementById(PANEL_ID)?.offsetWidth ?? 0 : 0
    return now + list
  }, [])
  // (drawn again whenever the row changes size: a window resize, the list folding, a file preview beside the page:
  // rowNow above)
  const both = !!threadId && rightOpen
  const columns = both ? roomColumns(rowForBoth()) : null
  const pair = columns === 'pair'
  /** the side chat over the thread */
  const over = columns === 'one'
  /** would the room, a thread and the side chat fit as three columns? Not laid out (a test): yes. */
  const fitsThree = useCallback(() => roomColumns(rowForBoth()) === 'three', [rowForBoth])
  // the open thread as the side chat's box names it (SideChatPanel.tsx `thread`): its first message, when the window
  // has it and it can have a thread
  const threadRoot = useRooms((s) => (threadId ? s.threadViews[placeKey(roomId, threadId)]?.root ?? findMessage(s, roomId, threadId) ?? null : null))
  const sideThread = useMemo<SideThread | null>(() => {
    if (!threadRoot) return null
    const seed = messageSeed(threadRoot, aiName(t))
    return seed.thread === threadRoot.id ? { rootId: threadRoot.id, author: seed.author, at: seed.at } : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadRoot?.id, threadRoot?.author?.name, threadRoot?.app?.name, threadRoot?.visibility, t])
  // a thread opened from the room while the side chat is open: where the three would not fit as columns it takes the
  // side chat's place, as before (a click in the room does not make the room give way; the side chat stays open: ✦
  // brings it back beside the thread). openThread below does that with the click; this is for a thread opened by its
  // address (a notice, Back or Forward). A thread in place of another keeps what shows. That thread closing with
  // nothing in its place closes the side chat; so do the side chat's ✕, ‹ or ✦
  const lastThread = useRef(threadId)
  useEffect(() => {
    const was = lastThread.current
    lastThread.current = threadId
    if (threadId && !was && useRooms.getState().side[roomId] && !fitsThree()) useRooms.getState().setSide(roomId, null)
    if (was && !threadId) threadClosedOn(roomId)
    // the box's "Looking at this thread" chip, taken off for the thread that was open: back for the next one, and for
    // this one opened again
    if (was !== threadId && sideChatOf(useSideChats.getState(), roomId).chipOff) useSideChats.getState().patch(roomId, { chipOff: null })
  }, [threadId, roomId, fitsThree, setSideOpen])
  const closeSide = useCallback(() => {
    handOffDone(roomId)
    useSideChats.getState().close(roomId)
    setSideOpen(false)
  }, [roomId, setSideOpen])
  const closeFiles = useCallback(() => useRooms.getState().setSide(roomId, null), [roomId])
  /** the Files list on or off; on in place of the side chat, which closes as its ✕ closes it */
  const toggleFiles = useCallback(() => {
    if (useRooms.getState().side[roomId] === 'files') return closeFiles()
    if (useRooms.getState().side[roomId] === 'trina') { handOffDone(roomId); useSideChats.getState().close(roomId) }
    useRooms.getState().setSide(roomId, 'files')
  }, [roomId, closeFiles])
  /** the panel on the right that is open (the side chat or the Files list) closes */
  const closeRight = filesOpen ? closeFiles : closeSide
  // the side chat comes back by itself (QA TC-4963, SideChatPanel.tsx sideChatComesBack): after a reload when it was open
  // in this tab, and on a computer when messages of mine wait in it. Asked once per room page, once the room is known;
  // never for a guest whose invite gives them no AI (no ✦ either)
  const askedBack = useRef(false)
  const here = useRef(true)
  useEffect(() => { here.current = true; return () => { here.current = false } }, [])
  useEffect(() => {
    if (!meId || !room || guestNoAi || askedBack.current) return
    askedBack.current = true
    const phone = typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 768px)').matches
    void sideChatComesBack(roomId, meId, phone).then((on) => { if (on && here.current && !useRooms.getState().side[roomId]) setSideOpen(true) })
  }, [roomId, meId, room, guestNoAi, setSideOpen])
  // the one-time "✦ Ask Trina about this room" line under the header (components/rooms/RoomAskHint.tsx): gone for good
  // once closed or once ✦ was used
  const askHint = useRoomAskHint()
  const seenHint = askHint.seen
  useEffect(() => { if (sideOpen) seenHint() }, [sideOpen, seenHint])
  // on a phone the side chat fills the screen: Android's Back closes it and the room stays (QA TC-080), or the thread
  // it is over
  useOverlayEntry(sideOpen, closeSide)
  useOverlayEntry(filesOpen, closeFiles)
  // "Ask Trina about this" on a message (the timeline's or a thread's): the side chat opens with it quoted
  const [sideSeed, setSideSeed] = useState<SideSeed | null>(null)
  // `ask`: a question that goes at once with the message quoted (an app's thread: "Summarise this thread")
  const askTrina = useCallback((m: RoomMessage, ask?: string) => {
    setSideSeed({ ...messageSeed(m, aiName(t)), ...(ask ? { ask } : {}) })
    setSideOpen(true)
  }, [t, setSideOpen])
  // "reply in thread" puts the cursor in the thread's box; a thread opened from its summary line or a link does not
  const [focusThread, setFocusThread] = useState(false)
  const location = useLocation()
  const fromRoom = !!(location.state as { fromRoom?: boolean } | null)?.fromRoom
  // ?m=<message>: the message a link points at (an Inbox row: components/settings/RoomNoticeRow.tsx), picked out in the
  // thread when one is open, else in the timeline
  const target = useMemo(() => { const m = new URLSearchParams(location.search).get('m'); return m && isUuid7(m) ? m : null }, [location.search])
  // what the room's own timeline goes to and picks out: that message with no thread open; a thread opened from a link, a
  // notice or a push, its first message (the room shows what the thread is under, as Slack does); none for a thread opened
  // by a click in this room (lib/rooms.ts timelineTarget)
  const openedHere = !!(location.state as { here?: boolean } | null)?.here
  const roomTarget = timelineTarget({ threadId, target, openedHere })
  // a phone: the thread is over the room (the room is hidden), so the room goes to that message once the thread closes
  const [behind, setBehind] = useState<string | null>(null)
  useEffect(() => { if (threadId) setBehind(!wide && roomTarget === threadId ? threadId : null) }, [threadId, roomTarget, wide])
  const litInRoom = !wide && threadId ? null : (roomTarget ?? behind)
  // the room's apps (docs/DECISIONS.md "Apps posting in rooms"), for those who manage them: the ⋯ says how many post
  // here; ?apps=<app id> (the paused notice's "Open settings") opens that app's settings, ?apps=add:<service>
  // (Connectors' "Add to a conversation") that service's Add an app guide, once
  const manages = mayManageApps(room, me)
  useEffect(() => { if (manages) void useRoomApps.getState().load(roomId).catch(() => {}) }, [manages, roomId])
  const appsParam = useMemo(() => new URLSearchParams(location.search).get('apps'), [location.search])
  useEffect(() => {
    if (!appsParam || !manages) return
    const add = appsParam.startsWith('add:') ? appsParam.slice(4) : null
    useRoomApps.getState().open(roomId, add !== null ? (isAppService(add) ? { view: 'guide', service: add } : { view: 'auto' })
      : isUuid7(appsParam) || /^[A-Za-z0-9_-]{1,64}$/.test(appsParam) ? { view: 'settings', appId: appsParam } : { view: 'auto' })
    navigate({ pathname: location.pathname, search: '' }, { replace: true, state: location.state })
  }, [appsParam, manages, roomId, navigate, location.pathname, location.state])
  // a thread opened from this room is one step back from it (the back arrow, the browser's back, a phone's back
  // gesture all close it); one thread replaces another and keeps how the first was reached; a thread opened from a link
  // or a notice closes to its room
  const openThread = useCallback((id: string, focus = false) => {
    setFocusThread(focus)
    // the side chat open and no room for three columns: the thread takes its place, in the same step (the list never
    // folds for a moment in between)
    if (!threadId && useRooms.getState().side[roomId] === 'trina' && !fitsThree()) setSideOpen(false)
    const to = threadOpening(roomId, id, { threadId, fromRoom })
    navigate(to.path, { replace: to.replace, state: { ...to.state, here: true } })
  }, [navigate, roomId, threadId, fromRoom, fitsThree, setSideOpen])
  // a thread closed by a step back lands on the room's own entry, which may still name the message a link opened it at
  // (?m=): that is put away there (replace, the entry stays where it is in the history), so a reload does not jump
  // back to it (QA TC-6923)
  const dropTarget = useRef(false)
  const closeThread = useCallback(() => {
    const to = threadClosing(roomId, fromRoom)
    if (to === -1) {
      // a second close (Esc pressed twice, a key held down) before the step back has landed would step past the room
      if (dropTarget.current) return
      dropTarget.current = true
      navigate(-1)
    } else navigate(to.path, { replace: to.replace })
  }, [navigate, roomId, fromRoom])
  useEffect(() => {
    if (threadId || !dropTarget.current) return
    dropTarget.current = false
    const search = withoutTarget(location.search)
    if (search !== location.search) navigate({ pathname: location.pathname, search, hash: location.hash }, { replace: true, state: location.state })
  }, [threadId, location, navigate])
  // "View" under an answer the side chat sent to a thread: the thread at the reply, in place of the one that is open
  // (the thread's ✕ still steps back to the room once). Where the side chat would hide it (over the thread; three
  // columns that do not fit), the side chat steps aside as a hand-off: ✦ brings the same chat back
  const viewThread = useCallback((rootId: string, messageId: string) => {
    if (over || (!threadId && !fitsThree())) handOffToThread(roomId)
    if (over) setSideOpen(false)
    const to = threadOpening(roomId, rootId, { threadId, fromRoom })
    navigate(`${to.path}?m=${messageId}`, { replace: to.replace, state: to.state })
  }, [navigate, roomId, threadId, fromRoom, over, fitsThree, setSideOpen])
  // "Ask Trina about this file" in the file preview of a file of this room (lib/sideChatAsk.ts)
  useEffect(() => onAskTrinaInRoom((a) => {
    if (a.roomId !== roomId) return
    setSideSeed(a.seed)
    setSideOpen(true)
  }), [roomId, setSideOpen])
  // 초대하기: into this group chat, or from a DM a new group chat with the other person ticked (the DM stays)
  const [picker, setPicker] = useState<PickerMode | null>(null)
  // from the room info and from the header's "⋯" (its first row: Invite a guest, in a group chat)
  const invitePeople = () => {
    setShowMembers(false)
    setPicker(room?.kind === 'dm' ? { kind: 'new', preselect: room.gone ? [] : room.peers.map((p) => p.id) } : { kind: 'invite', roomId })
  }
  // the "⋯"'s 알림 설정 opens the bell's own menu (a phone shows no bell: the keyboard then goes back to the "⋯")
  const [notifyRequest, setNotifyRequest] = useState(0)
  const moreRef = useRef<HTMLButtonElement>(null)
  // panels over the room (a sheet below 812 px; the thread and the side chat half and half in a row too narrow for
  // three columns): the keyboard goes into the panel that opened and, when the room shows again, back to where it was
  // in the room; Esc closes one panel a press: the one the keyboard is in, else the side chat first, then the thread
  // (not while a menu or dialog of its own is open, nor while an input method composes). Beside the room, as columns,
  // the effect after this one closes the thread (QA TC-6923)
  const covering = wide && ((sheet && !!(threadId || rightOpen)) || pair || over)
  // a room under panels is out of sight: nothing in it is read (tryRead)
  const covered = useRef(covering)
  covered.current = covering
  useEffect(() => {
    if (!covering) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      requestAnimationFrame(() => {
        const panels = '[data-testid="room-thread"], [data-testid="room-side-chat"], [data-testid="room-files-panel"]'
        if (document.activeElement?.closest(panels)) return
        // a panel stays beside the room (the other one closed): the keyboard goes on in it
        const box = document.querySelector<HTMLElement>(panels)?.querySelector<HTMLElement>('textarea')
        if (box) box.focus({ preventScroll: true })
        else if (before?.isConnected) before.focus({ preventScroll: true })
      })
    }
  }, [covering])
  useEffect(() => {
    if (!covering) return
    // the panel on top (the last one drawn): the side chat when both are open
    const sheets = [...document.querySelectorAll<HTMLElement>('[data-sheet]:not([inert])')]
    if (sheets.length && !sheets.some((el) => el.contains(document.activeElement))) {
      const el = sheets.at(-1)!
      ;(el.matches('[role="dialog"]') ? el : el.querySelector<HTMLElement>('textarea') ?? el).focus({ preventScroll: true })
    }
    // a file preview beside the page closes first (the app frame's Esc, components/Layout.tsx, which leaves it alone
    // only under a dialog): seen before that handler runs, whichever of the two listens first
    let preview = false
    const onKeyFirst = (e: KeyboardEvent) => { if (e.key === 'Escape') preview = !!getSidePanel() && !document.querySelector('[role="dialog"]') }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || e.defaultPrevented || e.isComposing || e.keyCode === 229 || preview || document.querySelector('[role="menu"], [role="dialog"]:not([data-sheet])')) return
      e.preventDefault()
      const inThread = pair && !!document.activeElement?.closest('[data-testid="room-thread"]')
      if (threadId && (inThread || !rightOpen)) closeThread()
      else closeRight()
    }
    window.addEventListener('keydown', onKeyFirst, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKeyFirst, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [covering, pair, threadId, rightOpen, closeThread, closeRight])
  // a thread beside the room, as a column: Esc closes it, except while the keyboard types in the room (its box, an edit:
  // Esc there stays theirs). Below 768 px the thread is the whole screen, and the side chat or the files over it close
  // first (QA TC-6923)
  useEffect(() => {
    if (covering || !threadId) return
    let preview = false
    const onKeyFirst = (e: KeyboardEvent) => { if (e.key === 'Escape') preview = !!getSidePanel() && !document.querySelector('[role="dialog"]') }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || e.defaultPrevented || e.isComposing || e.keyCode === 229 || preview || document.querySelector('[role="menu"], [role="dialog"]:not([data-sheet])')) return
      const at = document.activeElement
      if (wide && at instanceof HTMLElement && (at.isContentEditable || at.matches('input, textarea, select')) && !at.closest('[data-testid="room-thread"]')) return
      e.preventDefault()
      if (!wide && rightOpen) closeRight()
      else closeThread()
    }
    window.addEventListener('keydown', onKeyFirst, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKeyFirst, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [covering, threadId, wide, rightOpen, closeThread, closeRight])
  usePeopleList()
  // a private channel: its project (Room.project) is read again when the window comes back, so a project renamed or
  // one I can no longer open shows without a reload
  const channelHere = !!room && isPrivateChannel(room)
  useEffect(() => {
    if (!channelHere) return
    const again = () => { if (document.visibilityState !== 'hidden') void useRooms.getState().fetchRoom(roomId).catch(() => {}) }
    window.addEventListener('focus', again)
    const offWindow = onWindowFocus(again)
    return () => { window.removeEventListener('focus', again); offWindow() }
  }, [channelHere, roomId])
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

  // where the reader was when the page leaves the room (read while its messages are still on screen), kept with the
  // room for going back
  const leftPlace = useRef<RoomPlace | null>(null)
  useEffect(() => {
    useRooms.getState().open(roomId)
    return () => {
      useRooms.getState().close(roomId, leftPlace.current)
      // back in the room, ✦ opens the side chat afresh
      roomLeft(roomId)
    }
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
    if (!roomTarget || !timeline || timeline.loading || timeline.error || aroundFor.current === roomTarget) return
    if (timeline.messages.some((m) => m.id === roomTarget)) return
    aroundFor.current = roomTarget
    void useRooms.getState().loadAround(roomId, roomTarget)
  }, [roomTarget, timeline, roomId])
  const notFound = missing || badThread || (!!timeline?.error && (isApiError(timeline.error, 'not_found') || isApiError(timeline.error, 'forbidden')))

  const messages = timeline?.messages ?? NO_MESSAGES
  const peerTitle = usePeople((s) => (room?.kind === 'dm' && room.peers[0] ? s.byId[room.peers[0].id]?.title : undefined)) || null
  // a DM: the other person's online status (docs/DECISIONS.md "접속 상태"), on their picture on a computer and as a dot
  // before the name on a phone (which shows no picture here)
  const peerId = room?.kind === 'dm' ? (room.peers[0]?.id ?? null) : null
  const peerState = usePresenceOf(peerId)
  const last = messages.at(-1)
  // a window around an older message: its bottom is not the room's, so nothing sticks to it (the store's timeline too:
  // a scroll event can come before the page has drawn a new window)
  const detached = !!timeline?.newerCursor
  const detachedNow = useRef(detached)
  detachedNow.current = detached
  // thumbnails load after the text, and a phone's keyboard shrinks the list: stay at the bottom if we were there
  // (lib/stickToBottom.ts)
  const list = useStickToBottom(() => {
    const th = useRooms.getState().timeline
    return !detachedNow.current && !(th?.roomId === roomId && th.newerCursor)
  })
  const { scroller, content, stick } = list

  // follow new messages while the reader is at the bottom (and always after my own send)
  useLayoutEffect(() => {
    list.follow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, messages.length, pending.length])
  // my send or "최근 메시지로" from a window around an older message: the list lands at the bottom once the newest page
  // has taken the window's place. The scroll events on the way (the box clearing, the window's own place) come while the
  // window is still there and the list may not stick to it (onListScroll's canStick), so `stick` alone was lost and the
  // reply stayed below the list with "최근 메시지로" gone (QA TC-155)
  const toBottom = useRef(false)
  // (not after a failed read: the old window stays on screen, and a retry lands)
  const landing = !!timeline && !detached && !timeline.loading && !timeline.error
  useLayoutEffect(() => {
    if (!landing || !toBottom.current) return
    toBottom.current = false
    stick.current = true
    list.follow()
    // the message the address pointed at is behind: a reload opens at the newest too
    if (target) navigate({ pathname: location.pathname, search: '', hash: location.hash }, { replace: true, state: location.state })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing, timeline?.messages])
  const toNewest = () => {
    stick.current = true
    toBottom.current = true
    void useRooms.getState().loadNewest(roomId)
  }
  // back in a room left a moment ago with the reader part way up: the same message in the same place (at the bottom
  // when it was there, or when something came since: the newest, as on any open; not for a link to a message, which
  // goes to it). After the follow above, before the first frame shows
  const [place] = useState(() => (roomTarget ? null : keptPlace(keptFor(useRooms.getState(), roomId))))
  useLayoutEffect(() => {
    const el = scroller.current
    // (its own row: a thread beside it shows its root too; out of sight, a phone's thread over it, it opens at the bottom)
    if (place && el?.clientHeight && restorePlace(el, el.querySelector(`[id="${messageDomId(place.messageId)}"]`), place.offset)) stick.current = false
    // leaving: where the reader is now (none at the bottom), for the next time
    return () => {
      const at = scroller.current
      leftPlace.current = at ? listPlace(at, ROOM_PLACE_ROWS, (row) => row.id.slice(ROOM_ROW_ID.length) || null, stick.current) : null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tryRead = useCallback(() => {
    const el = scroller.current
    const s = useRooms.getState()
    const r = s.rooms.find((x) => x.id === roomId)
    const th = s.timeline
    if (!el || !r || !th || th.roomId !== roomId) return
    // the timeline out of sight (a phone shows the thread over it; panels over the room on a computer): nothing in it
    // is read
    if (!el.clientHeight || covered.current) return
    // on screen and looked at (the phone app: on screen; lib/attention.ts)
    if (!lookingAt()) return
    // up to the newest message shown (lib/rooms.ts readUpTo: not while a page loads, not over unread ones not loaded)
    const bottom = el.getBoundingClientRect().bottom
    const seq = readUpTo(th, r.lastReadSeq, (m) => {
      const row = document.getElementById(messageDomId(m.id))
      return !!row && row.getBoundingClientRect().top < bottom
    })
    if (seq > r.lastReadSeq) void s.markRead(roomId, seq)
  }, [roomId])
  // (a page that arrived, the older pages reaching the first unread, a message in sight, the thread or side chat over it
  // on a phone closing: after the list has drawn it)
  useEffect(() => {
    tryRead()
  }, [tryRead, last?.seq, messages[0]?.seq, timeline?.loading, timeline?.error, detached, room?.lastReadSeq, room?.unreadCount, threadId, rightOpen, covering])
  useEffect(() => {
    window.addEventListener('focus', tryRead)
    document.addEventListener('visibilitychange', tryRead)
    // the desktop app's window came to the front (its page may get no focus event of its own)
    const offWindow = onWindowFocus(tryRead)
    return () => {
      window.removeEventListener('focus', tryRead)
      document.removeEventListener('visibilitychange', tryRead)
      offWindow()
    }
  }, [tryRead])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const th = useRooms.getState().timeline
    // near the bottom, or no move up since the list was there (followsAfterScroll); never in a window around an older
    // message, whose bottom is not the room's
    list.onScroll()
    // a window around an older message: newer pages as its bottom comes into sight
    if (fromBottom < 200 && th?.roomId === roomId && th.newerCursor && !th.loading) void useRooms.getState().loadNewer(roomId)
    if (el.scrollTop < 200 && th?.roomId === roomId && th.nextCursor && !th.loading) {
      // the message in sight stays where it is (lib/stickToBottom.ts holdPlace)
      const keep = holdPlace(el, ROOM_ROW, list.reanchor)
      void useRooms
        .getState()
        .loadOlder(roomId)
        .finally(() => requestAnimationFrame(keep))
    }
    tryRead()
  }

  if (notFound) return <RoomNotFound />

  // threads I follow with replies I have not read: the newest of them is one tap away (none open already); on a phone
  // it is the "⋯"'s first entry
  const nextThread = room && room.threadsUnread > 0 && room.nextThreadId && room.nextThreadId !== threadId ? room.nextThreadId : null
  const threadsLabel = nextThread ? t('rooms.threadsUnread', { n: room!.threadsUnread }) : ''
  const muted = !!room && roomNotify(room).level === 'off'
  // the room's files go to a team folder, whose button comes first (a project's room; a department's room with a folder
  // I can open): its Files list only while it holds files of its own (Room.roomFiles)
  const folderButton = !!room && (!!room.project?.room || (room.kind === 'team' && !!room.groupFolder))

  return (
    <div ref={page} className="relative flex h-full" data-columns={columns ?? undefined} data-testid="room-page">
    {/* a file dropped anywhere on the room's column (not on the thread or side chat beside it) goes into its box */}
    <FileDropZone className={clsx('flex h-full min-w-0 flex-1 flex-col', (threadId || rightOpen) && 'max-md:hidden')} inert={covering || undefined} data-testid="room">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2 max-md:gap-1 max-md:pl-0.5 sm:px-4" data-testid="room-header">
        <Tooltip label={t('tabs.back')}>
          <Link to="/rooms" replace onClick={backLink} aria-label={t('tabs.back')} className="inline-flex items-center justify-center rounded-md p-3 text-muted hover:bg-hover hover:text-ink md:hidden" data-testid="room-back">
            <ChevronLeft size={20} aria-hidden />
          </Link>
        </Tooltip>
        {/* the room's mark beside its name. A phone shows it too, small (lock for a private channel, # for a team
            channel, the people mark for everyone and a group DM), so a private channel reads as one at 390; it sits in
            the back button's empty right padding (taps go through to it). A DM has none there: its picture is on the
            person's messages and the name is enough */}
        {room && (
          <span className="flex shrink-0 max-md:hidden">
            <RoomIcon room={room} size={24} presence />
          </span>
        )}
        {room && room.kind !== 'dm' && (
          <span className="pointer-events-none -ml-1.5 flex shrink-0 md:hidden" data-testid="room-header-icon">
            <RoomIcon room={room} size={16} />
          </span>
        )}
        {/* the name opens the room's info (its name, 초대하기, the members); beside it how many are in it, and
            for a DM the other person's title (직함) small under their name, as the people list shows it */}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
          <h1 className="flex min-w-0 text-title-sm font-semibold text-ink">
            {/* a phone: the count on its own line under the name (the name keeps the whole width) */}
            <button type="button" disabled={!room} onClick={() => setShowMembers(true)} aria-haspopup="dialog" className="touch-hit -mx-1 flex max-w-[calc(100%+0.5rem)] min-w-0 items-baseline gap-2 rounded-md px-1 text-left hover:bg-hover [--presence-bg:var(--c-canvas)] hover:[--presence-bg:var(--c-hover)] max-md:flex-wrap max-md:gap-x-1 max-md:gap-y-0" data-testid="room-members-button">
              {peerId && peerState !== 'offline' && <PresenceDot state={peerState} className="self-center md:hidden" />}
              <span className="truncate" data-testid="room-title">
                {room ? title(room) : ''}
              </span>
              {/* a screen reader hears what the name does: it is the way to the members and the room's name (QA TC-257) */}
              <span className="sr-only">{t('rooms.nameOpensInfo')}</span>
              {peerId && <PresenceText userId={peerId} offline />}
              {!wide && muted && <BellOff size={13} className="shrink-0 self-center text-faint" role="img" aria-label={t('rooms.notify.button', { level: t('rooms.notify.off') })} data-testid="room-muted" />}
              {room && room.kind !== 'dm' && (
                <span className="shrink-0 text-xs font-normal text-faint max-md:min-w-0 max-md:shrink max-md:basis-full max-md:truncate max-md:leading-4" title={t('rooms.members', { n: room.memberCount }) + (headerGuests ? ` · ${t('guest.includes', { n: headerGuests })}` : '')} data-testid="room-member-count">
                  {t('rooms.members', { n: room.memberCount })}
                  {/* "· Includes 1 guest" (components/GuestTag.tsx): people from outside the team are in it */}
                  <IncludesGuests ids={roomMembers?.map((m) => m.user.id)} prefix=" · " short={!wide} />
                  {/* a conversation made a project whose files are still on their way to Chat attachments (Room.filesMoving):
                      quiet, on the count's line, gone when the move ends (its closing line says how it went) */}
                  {room.filesMoving && <span data-testid="room-files-moving">{` · ${t('rooms.filesMoving')}`}</span>}
                </span>
              )}
            </button>
          </h1>
          {/* the folder this room's files go to, first (docs/decisions/20261121-department-room-files.md): a project's
              own chat room has Open project (its folder icon and the words; the project's name in the tooltip: the room's
              name above is the project's already), which opens the project page (its folder, Chat attachments included,
              and its AI chats); a department's team room with a folder I can open has 📁 {group} (Room.groupFolder),
              which opens that folder in Files. A phone: the folder icon alone, at the end of the line beside ✦ */}
          {room?.project?.room && (
            <Tooltip label={t('rooms.project.openTip', { name: room.project.name })}>
              <Link to={`/projects/${room.project.id}`} aria-label={t('rooms.project.open')} className={buttonClass({ variant: 'ghost', size: 'sm', className: 'touch-hit shrink-0 max-md:ml-auto max-md:px-0' })} data-testid="room-project">
                <Folder size={15} className="shrink-0" aria-hidden />
                <span className="max-md:hidden" data-testid="room-project-label">{t('rooms.project.open')}</span>
              </Link>
            </Tooltip>
          )}
          {room && !room.project?.room && room.kind === 'team' && room.groupFolder && (
            <Tooltip label={t('rooms.groupFilesTip', { name: room.groupFolder.split('/').pop() ?? room.groupFolder })}>
              <Link to={`/files?path=${encodeURIComponent(room.groupFolder)}`} aria-label={t('rooms.groupFilesTip', { name: room.groupFolder.split('/').pop() ?? room.groupFolder })} className={buttonClass({ variant: 'ghost', size: 'sm', className: 'touch-hit min-w-0 shrink max-md:ml-auto max-md:px-0' })} data-testid="room-group-folder">
                <Folder size={15} className="shrink-0" aria-hidden />
                <span className="truncate max-md:hidden">{title(room)}</span>
              </Link>
            </Tooltip>
          )}
          {/* Files: the room's Files list on its right (components/rooms/RoomFilesPanel.tsx; docs/decisions/
              20261120-project-is-room.md D8), for a channel, a 1:1 and a group chat. Beside a folder button above only
              while the room still holds files of its own (Room.roomFiles: older ones, ones that stayed when it became a
              project, uploads that fell back), which the list then shows alone. A phone: the icon alone */}
          {room && roomFilesButtonShown(room) && (
            <Tooltip label={t('rooms.files.open')}>
              <button type="button" onClick={toggleFiles} aria-pressed={filesOpen} aria-label={t('rooms.files.open')} className={buttonClass({ variant: 'ghost', size: 'sm', className: clsx('touch-hit shrink-0 max-md:px-0', !folderButton && 'max-md:ml-auto', filesOpen && 'bg-hover') })} data-testid="room-files-button">
                <Files size={15} aria-hidden />
                <span className="max-md:hidden">{t('rooms.groupFiles')}</span>
              </button>
            </Tooltip>
          )}
          </div>
          {peerTitle && (
            <p className="truncate text-xs text-muted" data-testid="room-peer-title">
              {peerTitle}
            </p>
          )}
        </div>
        {nextThread && wide && (
          <IconButton tip label={threadsLabel} className="touch-hit relative shrink-0" onClick={() => openThread(nextThread)} data-testid="room-next-thread">
            <MessagesSquare size={16} aria-hidden />
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent" aria-hidden />
          </IconButton>
        )}
        {/* ✦: not for a guest whose invite gives them no AI (components/GuestView.tsx useGuestAiOff) */}
        {room && !guestNoAi && (
          <IconButton tip label={t('sideChat.open', { name: aiName(t) })} className={clsx('touch-hit shrink-0', sideOpen && 'bg-hover')} aria-pressed={sideOpen}
            onClick={() => { if (sideOpen) closeSide(); else setSideOpen(true) }} data-testid="room-side-chat-button">
            <AiMark />
          </IconButton>
        )}
        {/* the room's one setting, right here: the bell shows how it is now and opens its four levels; then the room's
            "⋯" (its 알림 설정 opens the bell's menu). A phone: no bell (its menu stays, as a sheet from ⋯ › 알림 설정) */}
        {room && <RoomNotifyMenu room={room} openRequest={notifyRequest} bare={!wide} className={wide ? undefined : 'contents'} focusBack={() => moreRef.current?.focus()} />}
        {/* a box of its own around the "⋯", so its Move to section list opens under the button (it is drawn beside it,
            from the box's bottom right), not at the bottom of the conversation's column */}
        {room && (
          <div className="relative flex shrink-0" data-testid="room-menu-box">
            <RoomMenu
              room={room}
              onNotify={() => setNotifyRequest((n) => n + 1)}
              onInvite={invitePeople}
              onSearch={() => useUi.getState().setSearchOpen(true, undefined, room.id)}
              className="shrink-0"
              buttonClassName="touch-hit"
              buttonRef={moreRef}
              phone={wide ? undefined : { first: nextThread ? [{ label: threadsLabel, icon: <MessagesSquare size={14} aria-hidden />, onSelect: () => openThread(nextThread), testId: 'room-menu-next-thread' }] : [] }}
              dot={!wide && !!nextThread}
              label={!wide && nextThread ? `${t('rooms.menu.label')}, ${threadsLabel}` : undefined}
              folders
            />
          </div>
        )}
      </div>
      {room && askHint.show && !guestNoAi && <RoomAskHint onAsk={() => setSideOpen(true)} onClose={askHint.seen} />}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="room-scroller">
        <div ref={content} className="mx-auto max-w-[780px] px-4 pt-2 pb-6">
          {timeline?.loading && messages.length > 0 && !timeline.error && <Loader2 size={16} className="mx-auto my-2 animate-spin text-faint" aria-label={t('common.loading')} />}
          {timeline?.loading && !messages.length && !timeline.error && <Skeleton lines={5} className="pt-4" />}
          {!!timeline?.error && !notFound && (
            <div className="pt-4">
              <LoadError error={timeline.error} onRetry={() => useRooms.getState().loadNewest(roomId)} what="room-messages" />
            </div>
          )}
          {/* the room's start (its first messages are loaded): a project room with the same people as a department's
              says so, and where this project's talk goes (Room.project.sameAsGroup) */}
          {timeline && !timeline.loading && !timeline.error && !timeline.nextCursor && room?.project?.sameAsGroup && (
            <p className="px-6 pt-3 pb-1 text-center text-xs break-words text-faint">
              <SameAsGroupLine project={room.project} />
            </p>
          )}
          {timeline && !timeline.loading && !timeline.error && !messages.length && !pending.length && <p className="py-12 text-center text-sm text-muted">{t(roomEmptyKey(room))}</p>}
          {/* the timeline's pictures: ← → in the image viewer walks through these (the thread panel has its own) */}
          <ImageGroup>
            <RoomMessages roomId={roomId} messages={messages} pending={pending} meId={meId} members={members} onThread={openThread} onAskTrina={guestNoAi ? undefined : askTrina} highlight={litInRoom} highlightKey={location.key} />
          </ImageGroup>
          {detached && timeline?.loading && <Loader2 size={16} className="mx-auto my-2 animate-spin text-faint" aria-label={t('common.loading')} />}
        </div>
      </div>
      {/* a window around an older message (a search result, a link): one tap back to the newest (above the typing line,
          components/rooms/RoomTypingLine.tsx) */}
      {detached && (
        <button type="button" onClick={toNewest} className="absolute bottom-8 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm text-muted shadow-md hover:bg-hover hover:text-ink" data-testid="room-to-newest">
          <ArrowDown size={14} aria-hidden />
          {t('rooms.toNewest')}
        </button>
      )}
      </div>
      {room?.gone ? (
        // the other person was deleted from the team: the history stays readable, the box is gone
        <p role="status" className="shrink-0 border-t border-line px-4 py-3 text-center text-sm text-muted" data-testid="room-peer-gone">{t('rooms.peerGone', { name: room.peers[0]?.name ?? t('rooms.goneUser') })}</p>
      ) : (
      <RoomComposer
        roomId={roomId}
        members={members}
        meId={meId}
        above={peerId ? <StatusDmLine userId={peerId} name={room ? title(room) : ''} /> : undefined}
        onSent={() => {
          stick.current = true
          // from a window around an older message the send goes back to the newest (store/rooms.ts send)
          if (detached) toBottom.current = true
        }}
      />
      )}
      <MembersDialog
        open={showMembers}
        onClose={() => setShowMembers(false)}
        room={room}
        members={roomMembers}
        meId={meId}
        onInvite={invitePeople}
      />
      <PeoplePicker open={!!picker} onClose={() => setPicker(null)} mode={picker ?? undefined} />
      {/* "Save to team folder" of a file in the timeline or the thread (store/roomSaves.ts) */}
      <SaveToTeamSheet />
    </FileDropZone>
    {/* the room's right: the thread in the address and my Trina side chat, each alone or the two together (three
        columns; half and half over the room; the side chat over the thread where one panel fits) */}
    {threadId && (
      <RoomSideColumn label={t('rooms.thread')} testId="room-thread" divider={sheet || columns === 'pair' || columns === 'three' ? undefined : 'thread'} shared={columns === 'three'}
        className={pair ? PAIR_THREAD : sheet ? SHEET : undefined} modal={sheet && !pair} data-sheet={sheet || pair ? '' : undefined} inert={over}>
        <ThreadPanel frame={false} key={threadId} roomId={roomId} rootId={threadId} roomTitle={room ? title(room) : ''} members={members} meId={meId} onClose={closeThread} onAskTrina={guestNoAi ? undefined : askTrina} focusBox={focusThread} highlight={target} covered={over} />
      </RoomSideColumn>
    )}
    {filesOpen && (
      <RoomSideColumn label={t('rooms.files.title')} testId="room-files-panel" divider={both || sheet ? undefined : 'side-chat'} shared={columns === 'three'}
        className={pair ? PAIR_SIDE : sheet || over ? SHEET : undefined} modal={sheet && !pair} data-sheet={sheet || pair || over ? '' : undefined}>
        <RoomFilesPanel key={roomId} roomId={roomId} refresh={last?.id ?? null} onClose={closeFiles} />
      </RoomSideColumn>
    )}
    {sideOpen && (
      <RoomSideColumn label={t('sideChat.title', { name: aiName(t) })} testId="room-side-chat" divider={both || sheet ? undefined : 'side-chat'} shared={columns === 'three'}
        className={pair ? PAIR_SIDE : sheet || over ? SHEET : undefined} modal={sheet && !pair} data-sheet={sheet || pair || over ? '' : undefined}>
        <SideChatPanel frame={false} key={roomId} roomId={roomId} roomTitle={room ? title(room) : ''} seed={sideSeed} onClose={closeSide} thread={sideThread} onViewThread={viewThread} />
      </RoomSideColumn>
    )}
    </div>
  )
}
