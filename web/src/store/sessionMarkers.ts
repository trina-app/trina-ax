// Session markers in this window (docs/DECISIONS.md "Session markers"; the markers themselves: lib/sessionMarkers.ts).
//  - which chat is on screen (pages/Chat.tsx) and whether this window is visible: the tab is visible, and in the
//    desktop app its window is focused (the main process's word: the in-app browser may hold the keyboard)
//  - POST /api/chats/:id/seen for the chat on screen while the window is visible and the list says it has an unseen
//    answer (Chat.unseen: phone-nav's mark): once per state of the chat, so seeing never loops, whatever the server
//    sends back. A card never asks for /seen (it is answered, not seen).
//  - the one rule for notifications and toasts: a live chat.updated with `notify` (a card opened, a long answer ended;
//    never a replay after a reconnect, a reload or a resync), never for the chat on screen here, after NOTIFY_DELAY_MS
//    and only if it still holds (the answer is still unseen: no window had it on screen; the card is still open). The
//    desktop app shows its notification only while the window is not focused (a click opens the chat); the in-app toast
//    with [열기] only where the sidebar is not visible: below 768 px with the drawer closed. A confidential chat's
//    notification and toast say neither its title nor the AI's question.
//  - rooms follow the same rule in the desktop app: a room.message the server marked with my notice (its rule: my level
//    for the room, quiet hours, one per unread run) and the room's "?" (its AI waits on me), after the same wait and only
//    while the room still wants me. One per room (tag "room-<id>"), its click opens the room. The sound stays the rooms'
//    own (store/roomSound.ts); only the room's "?" gets a toast.
//  - the dock badge (desktop app, macOS) follows the one count n; so does an installed web app's icon (the Badging API:
//    the Dock or taskbar of a computer, an iPhone's Home Screen): the exact n, cleared at 0 (the service worker's dot
//    from a push while no window was open turns into it). A normal tab: the browser ignores it. The phone app has its
//    own (native) badge.
import { create } from 'zustand'
import { useMemo } from 'react'
import { API, plainLabel, type Chat, type Room, type ServerEvent } from '@mycel/shared/api'
import { api } from '../lib/api'
import { desktop } from '../lib/desktop'
import { mobileApp } from '../lib/mobile'
import { slideUrl } from '../lib/deckProgress'
import { navigateTo } from '../lib/nav'
import { roomTitle, roomWantsMe } from '../lib/rooms'
import { attentionCount, markerOf, NOTIFY_DELAY_MS, stillWorthTelling, type MarkerReason } from '../lib/sessionMarkers'
import { t, type MessageKey } from '../i18n'
import { useChats, type OpenRequest } from './chats'
import { openDeckChat, useDeckBuilds } from './deckBuilds'
import { useRooms } from './rooms'
import { toast, useUi } from './ui'

interface SessionMarkersState {
  /** the chat on screen in this window (pages/Chat.tsx), null elsewhere */
  onScreen: string | null
  /** this window is visible: the tab is, and in the desktop app the window is focused */
  visible: boolean
  setOnScreen: (chatId: string | null) => void
}

const pageVisible = () => typeof document !== 'undefined' && document.visibilityState === 'visible'
/** the desktop app's word on its window's focus (null: not in the desktop app, or an app without it) */
let appFocused: boolean | null = null
const computeVisible = () => pageVisible() && (appFocused ?? true)

export const useSessionMarkers = create<SessionMarkersState>((set, get) => ({
  onScreen: null,
  visible: computeVisible(),
  setOnScreen(chatId) {
    if (get().onScreen === chatId) return
    set({ onScreen: chatId })
    asked.clear()
    recheck()
  },
}))

/** the chat is on screen in this window and the window is visible */
export const seenHere = (chatId: string) => {
  const s = useSessionMarkers.getState()
  return s.visible && s.onScreen === chatId
}
/** the chats with a card open in this window (a card one desktop window shows alone is in no list) */
export const cardChats = (requests: Record<string, OpenRequest>): Set<string> => new Set(Object.values(requests).map((r) => r.chatId))

// ---------------- /seen ----------------
const inFlight = new Set<string>()
/** chat -> the state of it /seen was asked for last (each state once: a /seen that changes nothing never repeats) */
const asked = new Map<string, string>()
const stateOf = (c: Chat) => `${c.updatedAt}|${c.runState}`
function seen(chatId: string, state: string) {
  if (inFlight.has(chatId) || asked.get(chatId) === state) return
  asked.set(chatId, state)
  inFlight.add(chatId)
  // the answer changes nothing here: the server's chat.updated follows to every window (this one too), in order
  // a newer state that came meanwhile (another answer ended) is asked for once this one is back
  void api.call(API.markChatSeen, { params: { id: chatId } }).catch(() => {}).finally(() => {
    inFlight.delete(chatId)
    recheck()
  })
}
/** The chat on screen in a visible window, when the list says it has an answer not seen yet: /seen, once per state.
 * A chat that is not in the list (an old one opened by its address) is asked for once when it comes on screen. */
function recheck() {
  const { onScreen, visible } = useSessionMarkers.getState()
  if (!onScreen || !visible) return
  const c = useChats.getState().chats.find((x) => x.id === onScreen)
  if (!c) return seen(onScreen, 'unlisted')
  if (c.unseen) seen(onScreen, stateOf(c))
}

function setVisible(v: boolean) {
  if (useSessionMarkers.getState().visible === v) return
  useSessionMarkers.setState({ visible: v })
  // back on screen: what came meanwhile is seen now (a failed /seen too gets another go)
  if (v) asked.clear()
  recheck()
}

// ---------------- notifications and toasts ----------------
const pendingTell = new Map<string, { timer: ReturnType<typeof setTimeout>; notify: 'card' | 'answer' }>()
/** the wait before telling (tests shorten it) */
export const tellTiming = { delayMs: NOTIFY_DELAY_MS }

const REASON: Record<MarkerReason, MessageKey> = {
  card: 'marker.card', error: 'marker.error', paused: 'marker.paused', running: 'marker.running', queued: 'marker.queued', new: 'marker.new',
}
/** The AI's own open question in this chat as one line, when this window has the card (a server's safety check is
 * "waiting for you": its first line is a long explanation). */
export function cardQuestion(requests: Record<string, OpenRequest>, chatId: string): string | undefined {
  const r = Object.values(requests).find((x) => x.chatId === chatId && x.request?.kind === 'ask_user' && !x.request.origin)
  const q = r?.request.kind === 'ask_user' ? r.request.question.split('\n').find((l) => l.trim())?.trim() : undefined
  return q ? (q.length > 80 ? q.slice(0, 79) + '…' : q) : undefined
}
/** The reason in words: the AI's open question itself when this window has it (never for a confidential chat), else
 * the marker's words. */
export function reasonText(reason: MarkerReason, translate: (k: MessageKey) => string = t, question?: string): string {
  return (reason === 'card' && question) || translate(REASON[reason])
}

/** [열기] and a notification's click: that chat (with its intro deck beside it when it made one) */
export function openChat(chatId: string) {
  const b = useDeckBuilds.getState().builds[chatId]?.[0]
  if (b?.phase === 'done') openDeckChat(chatId)
  else navigateTo(`/c/${chatId}`)
}

/** the sidebar is not on screen: below 768 px with the drawer closed (from 768 px up it always shows) */
const sidebarHidden = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767.98px)').matches && !useUi.getState().drawerOpen

function tell(chatId: string, notify: 'card' | 'answer') {
  const c = useChats.getState().chats.find((x) => x.id === chatId)
  const card = cardChats(useChats.getState().requests).has(chatId)
  if (!stillWorthTelling(c, { notify, here: seenHere(chatId), card })) return
  const m = markerOf(c!, { card })
  if (!m || m.kind === 'running') return
  // a confidential chat: neither its title nor the AI's question leaves the page (the system's list keeps both)
  const secret = !!c!.confidential
  const title = secret ? t('sidebar.filter.confidential') : c!.title || t('chat.untitled')
  const body = reasonText(m.reason, t, secret ? undefined : cardQuestion(useChats.getState().requests, chatId))
  // shown by the desktop app only while its window is not focused; one per chat
  desktop()?.notify({ title, body, tag: `chat-${chatId}`, open: `/c/${chatId}` })
  if (sidebarHidden() && pageVisible()) {
    const b = useDeckBuilds.getState().builds[chatId]?.[0]
    const cover = !secret && b?.phase === 'done' && b.thumbs && b.slides[0]?.status === 'done' ? slideUrl(b, 0) : undefined
    toast({ level: 'info', text: title, detail: body, image: cover, ms: 10_000, action: { label: t('marker.open'), primary: true, run: () => openChat(chatId) } })
  }
}

/** A chat.updated, before the chat store applies it (store/live.ts): a live change worth telling is told after the
 * wait (a newer one for the same chat replaces it); a chat that went is told nothing. */
export function chatUpdated(ev: Extract<ServerEvent, { type: 'chat.updated' }>, meta: { replay: boolean }) {
  const { chatId, chat, notify } = ev.data
  if (!chat || ev.data.change === 'deleted' || ev.data.change === 'purged') {
    clearTimeout(pendingTell.get(chatId)?.timer)
    pendingTell.delete(chatId)
    return
  }
  if (!notify || meta.replay || seenHere(chatId)) return
  // an answer that ended after a card: the answer's news; a card after an answer: the card's (it waits on me)
  const was = pendingTell.get(chatId)
  clearTimeout(was?.timer)
  pendingTell.set(chatId, { notify, timer: setTimeout(() => { pendingTell.delete(chatId); tell(chatId, notify) }, tellTiming.delayMs) })
}

// ---------------- rooms ----------------
type RoomWhy = 'ai' | 'room.mention' | 'room.dm'
const pendingRoom = new Map<string, { timer: ReturnType<typeof setTimeout>; why: RoomWhy }>()
/** the room is on screen in this window and the window is visible */
const viewingHere = (roomId: string) => useSessionMarkers.getState().visible && useRooms.getState().openRoomId === roomId
const titleOf = (r: Room) => roomTitle(r, { all: t('rooms.all'), gone: t('rooms.goneUser'), alone: t('rooms.groupAlone'), sep: t('rooms.nameSep'),
  names: (names, n) => (n > 0 ? t('rooms.groupNamesMore', { names, n }) : names) })

const ROOM_WHY: Record<RoomWhy, MessageKey> = { ai: 'rooms.aiWaits', 'room.mention': 'rooms.mentionedYou', 'room.dm': 'rooms.newMessage' }
function laterRoom(roomId: string, why: RoomWhy) {
  // one per room: the "?" wins over a message told in the same moment, a newer message replaces an older one
  const was = pendingRoom.get(roomId)
  if (was?.why === 'ai' && why !== 'ai') return
  if (was) clearTimeout(was.timer)
  pendingRoom.set(roomId, { why, timer: setTimeout(() => { pendingRoom.delete(roomId); tellRoom(roomId, why) }, tellTiming.delayMs) })
}
function tellRoom(roomId: string, why: RoomWhy) {
  const r = useRooms.getState().rooms.find((x) => x.id === roomId)
  // read meanwhile (here or on another device), its AI no longer waiting, or on screen here: nothing
  if (!r || viewingHere(roomId) || (why === 'ai' ? !r.aiWaits : !roomWantsMe(r, useRooms.getState().alerts?.threadReplies ?? true))) return
  // people's names in a notice on the computer: one plain line (no control or bidirectional characters), capped
  const title = plainLabel(titleOf(r), 120)
  const body = t(ROOM_WHY[why])
  desktop()?.notify({ title, body, tag: `room-${roomId}`, open: `/rooms/${roomId}` })
  // a message rings the room sound here and the phone's own notification there; only the AI's "?" gets a toast
  if (why === 'ai' && sidebarHidden() && pageVisible()) toast({ level: 'info', text: title, detail: body, ms: 10_000, action: { label: t('marker.open'), primary: true, run: () => navigateTo(`/rooms/${roomId}`) } })
}

/** A new room message, before the rooms store applies it: one the server gave me a notice of is told in the desktop app
 * (never a replay). The page does not decide it again: the server's mark is the Inbox's and the push's decision. */
export function roomMessage(ev: Extract<ServerEvent, { type: 'room.message' }>, meta: { replay: boolean }) {
  const why = ev.data.notice
  if (!why || meta.replay || !desktop() || viewingHere(ev.data.roomId)) return
  laterRoom(ev.data.roomId, why)
}
/** A room changed, before the rooms store applies it: its AI started waiting on me (a card of my question). */
export function roomUpdated(ev: Extract<ServerEvent, { type: 'room.updated' }>, meta: { replay: boolean }) {
  const { roomId, room } = ev.data
  if (!room) { clearTimeout(pendingRoom.get(roomId)?.timer); pendingRoom.delete(roomId); return }
  const before = useRooms.getState().rooms.find((x) => x.id === roomId)
  if (room.aiWaits && !before?.aiWaits && !meta.replay && !viewingHere(roomId)) laterRoom(roomId, 'ai')
}

// ---------------- the window ----------------
/** The Badging API (an installed web app): navigator.setAppBadge / clearAppBadge, where the browser has them. */
type BadgeNavigator = { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
const badgeApi = (): BadgeNavigator | null => {
  if (typeof navigator === 'undefined' || desktop() || mobileApp()) return null
  const nav = navigator as unknown as BadgeNavigator
  return typeof nav.setAppBadge === 'function' ? nav : null
}
/** n on an installed web app's icon (0 clears it). Never throws: a refusal (not installed, notifications off, a browser
 * that only half has it) changes nothing on the page. */
function setWebBadge(nav: BadgeNavigator, n: number) {
  try {
    const done = n > 0 ? nav.setAppBadge!(n) : typeof nav.clearAppBadge === 'function' ? nav.clearAppBadge() : nav.setAppBadge!(0)
    void Promise.resolve(done).catch(() => {})
  } catch { /* the badge is a nicety */ }
}
/** a burst of changes (a resync, many rooms at once) sets the web badge once */
export const WEB_BADGE_MS = 250
let webBadge: BadgeNavigator | null = null
let started = false
const offs: (() => void)[] = []
/** visibility, the desktop app's focus and notification clicks, /seen when the list changes, the dock badge
 * (store/live.ts startLive) */
export function startSessionMarkers() {
  if (started || typeof document === 'undefined') return
  started = true
  const onVisibility = () => setVisible(computeVisible())
  document.addEventListener('visibilitychange', onVisibility)
  offs.push(() => document.removeEventListener('visibilitychange', onVisibility))
  const app = desktop()
  if (app?.focus) {
    appFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true
    offs.push(app.focus.onChange((f) => { appFocused = !!f; setVisible(computeVisible()) }))
    void app.focus.get().then((f) => { appFocused = !!f; setVisible(computeVisible()) }, () => {})
  }
  setVisible(computeVisible())
  // the list changed (a chat.updated, a reload, a resync after a server restart): the chat on screen may have an unseen
  // answer now
  offs.push(useChats.subscribe((now, before) => { if (now.chats !== before.chats) recheck() }))
  recheck()
  const onOpen = app?.onOpen?.((path) => {
    const chat = /^\/c\/([0-9a-f-]{36})$/.exec(String(path))
    if (chat) openChat(chat[1]!)
    else if (typeof path === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(path)) navigateTo(path)
  })
  if (onOpen) offs.push(onOpen)
  if (app?.setBadgeCount) {
    let shown = -1
    const badge = () => {
      const { n } = currentCount()
      if (n !== shown) { shown = n; app.setBadgeCount!(n) }
    }
    offs.push(useChats.subscribe(badge), useRooms.subscribe(badge), useSessionMarkers.subscribe(badge))
    badge()
  }
  // an installed web app: the same n on its icon, set once when it changes (a burst waits WEB_BADGE_MS), and at once now
  // (the worker's dot from a push while no window was open becomes the exact count)
  const nav = (webBadge = badgeApi())
  if (nav) {
    let shown = -1, timer: ReturnType<typeof setTimeout> | undefined
    const apply = () => {
      timer = undefined
      const { n } = currentCount()
      if (n !== shown) { shown = n; setWebBadge(nav, n) }
    }
    const later = () => { if (timer === undefined) timer = setTimeout(apply, WEB_BADGE_MS) }
    offs.push(useChats.subscribe(later), useRooms.subscribe(later), useSessionMarkers.subscribe(later), () => clearTimeout(timer))
    apply()
  }
}

export function stopSessionMarkers() {
  for (const off of offs.splice(0)) off()
  for (const p of [...pendingTell.values(), ...pendingRoom.values()]) clearTimeout(p.timer)
  pendingTell.clear()
  pendingRoom.clear()
  inFlight.clear()
  asked.clear()
  appFocused = null
  if (started) desktop()?.setBadgeCount?.(0)
  // signed out (or the page closing its live state): no count of this person stays on the icon
  if (started && webBadge) setWebBadge(webBadge, 0)
  webBadge = null
  started = false
}

/** the one count n, as this window shows it */
export const currentCount = () => {
  const s = useSessionMarkers.getState()
  const chats = useChats.getState(), rooms = useRooms.getState()
  return attentionCount(chats.chats, rooms.rooms, { here: s.visible ? s.onScreen : null, cards: cardChats(chats.requests), threadReplies: rooms.alerts?.threadReplies ?? true })
}

/** n, whether any is a "?", and the AI chats' part (tab title, phone ☰ dot); re-renders when the inputs change */
export function useAttention(): ReturnType<typeof attentionCount> {
  const chats = useChats((s) => s.chats)
  const requests = useChats((s) => s.requests)
  const rooms = useRooms((s) => s.rooms)
  const threadReplies = useRooms((s) => s.alerts?.threadReplies ?? true)
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  return useMemo(() => attentionCount(chats, rooms, { here, cards: cardChats(requests), threadReplies }), [chats, rooms, here, requests, threadReplies])
}
