// A message list that stays at its newest message while the reader is there: the room's timeline (DMs and group chats
// too), a thread, the ✦ side chat and the AI chat all use useStickToBottom. The list's own layout effect follows new
// messages (`follow`); the size watcher follows sizes: the content growing after the text arrived (a picture, a
// diagram, code highlighting) and the list itself getting shorter or taller. On a phone the keyboard shrinks the list
// from below (interactive-widget=resizes-content in index.html; iOS through visualViewport and --app-h,
// lib/viewport.ts): at the bottom it stays at the bottom, so the newest message is right above the message box;
// scrolled up, the first message in sight stays where it was. Closing the keyboard is the same in reverse.
//
// The list's own size changing is not the reader scrolling. In the iPhone app's WebView the keyboard shrinks the list
// and, in the same frame, the engine moves its scrollTop up a little (22 px measured, iOS 26.5): that scroll event comes
// before the size watcher and read as the reader leaving the bottom, so the list stopped following and the newest
// messages went behind the box. A scroll event while the list's height differs from the height last seen, moving it no
// further than that difference, is left to the size watcher, which runs after it in the same frame.
import { useEffect, useRef } from 'react'

/** Near the bottom: a list this close to its end follows it. */
export const NEAR_BOTTOM_PX = 80

/** The list's own box, as the size watcher last saw it. */
export interface ListSize { height: number; width: number }

type Box = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight' | 'clientWidth'>

/** After a scroll event: does the list follow its newest message now? Near the bottom it does. Further up it stops only
 * when the list moved up (`scrollTop` below `lastTop`: where the last scroll event left it, or the list's own last jump
 * to the bottom, jumpToBottom): the event of that jump comes a frame later, and what was added meanwhile (a room card
 * that came right after the step before it) would read as the reader having scrolled up, so the room stopped following
 * and the card stayed below the message box with only its first line in sight. A scroll at the same place or further
 * down keeps what it was; a move up in the same frame as the jump (a link's message scrolled into view) still counts,
 * as `lastTop` is the jump's. */
export function followsAfterScroll(el: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>, was: boolean, lastTop: number): boolean {
  if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) return true
  return el.scrollTop < lastTop - 1 ? false : was
}

/** Is this scroll event the reader's (or the app's own: a link's message scrolled into view)? Not when the list's own
 * height differs from the height the watcher last saw and the list moved no further than that difference: the browser
 * moved it while laying the list out again (clamping as it grows; the iPhone app's WebView nudging it 22 px as the
 * keyboard shrinks it 381 px), and the watcher, which runs next, decides. A bigger move is a real scroll. Nothing seen
 * yet (no ResizeObserver): the reader's, as before. */
export function scrolledByReader(el: Pick<HTMLElement, 'clientHeight' | 'scrollTop'>, seen: ListSize | null, lastTop: number): boolean {
  if (!seen || el.clientHeight === seen.height) return true
  return Math.abs(el.scrollTop - lastTop) > Math.abs(el.clientHeight - seen.height) + 1
}

/** Where the list goes after it or its content changed size (null: where it is). Following: to the bottom. Not
 * following and the list itself got shorter or taller with the visual viewport (`keyboard`: a phone's keyboard came
 * up or went down just now): back to where the reader left it (`lastTop`), so the first message in sight stays in its
 * place and nothing the browser did in that frame moves it. Any other change (the message box growing, a computer's
 * window narrower, the content alone): the browser's place, so a reader's scroll in that frame is never undone. */
export function placeAfterResize(el: Box, follows: boolean, lastTop: number, seen: ListSize | null, keyboard = true): number | null {
  if (follows) return el.scrollHeight
  if (!keyboard || !seen || el.clientWidth !== seen.width || el.clientHeight === seen.height) return null
  return lastTop
}

/** How long after a visual viewport event a change of the list's height counts as the keyboard's (placeAfterResize). */
export const KEYBOARD_MS = 1000

/** What useStickToBottom keeps for a list. */
export interface ListState {
  /** follows its newest message */
  stick: { current: boolean }
  /** where the list was last: its last scroll event by the reader, its own last jump to the bottom, or where the size
   * watcher left it (followsAfterScroll, placeAfterResize) */
  lastTop: { current: number }
  /** the list's own size as the size watcher last saw it */
  seen: { current: ListSize | null }
}

/** The list's scroll event (useStickToBottom's onScroll): whether the reader is at the bottom now. False and nothing
 * changed when the scroll was the browser's, during the list's own size change (scrolledByReader). */
export function onListScroll(el: Box, st: ListState, canStick: () => boolean = () => true): boolean {
  if (!scrolledByReader(el, st.seen.current, st.lastTop.current)) return false
  st.stick.current = followsAfterScroll(el, st.stick.current, st.lastTop.current) && canStick()
  st.lastTop.current = el.scrollTop
  return true
}

/** The list's own jump to its bottom, remembered as its last position (followsAfterScroll compares the next scroll event
 * with it). */
export function jumpToBottom(el: Pick<HTMLElement, 'scrollTop' | 'scrollHeight'>, lastTop: { current: number }) {
  el.scrollTop = el.scrollHeight
  lastTop.current = el.scrollTop
}

/** Watch the list and its content (ResizeObserver, after layout) and the visual viewport (a phone's keyboard; iOS
 * changes only that): when a size changed, put the list where placeAfterResize says. Only the observer records the
 * size and the place, as it runs last in a frame: a scroll event the engine sends after a visual viewport event of the
 * same frame is still told apart (scrolledByReader). Returns the cleanup. No ResizeObserver (an old browser, a test without a DOM):
 * nothing is watched. */
export function watchListSize(
  scroller: HTMLElement,
  content: HTMLElement,
  st: { follows: () => boolean; lastTop: { current: number }; seen: { current: ListSize | null } },
  RO: typeof ResizeObserver | undefined = globalThis.ResizeObserver,
  vv: Pick<VisualViewport, 'addEventListener' | 'removeEventListener'> | null | undefined = globalThis.visualViewport,
): () => void {
  if (typeof RO === 'undefined') return () => {}
  /** when the visual viewport last changed (a keyboard): -Infinity for never */
  let viewportAt = -Infinity
  const settle = (record: boolean) => {
    const keyboard = Date.now() - viewportAt < KEYBOARD_MS
    const to = placeAfterResize(scroller, st.follows(), st.lastTop.current, st.seen.current, keyboard)
    if (to !== null) scroller.scrollTop = to
    if (!record) return
    st.seen.current = { height: scroller.clientHeight, width: scroller.clientWidth }
    st.lastTop.current = scroller.scrollTop
  }
  const ro = new RO(() => settle(true))
  ro.observe(content)
  ro.observe(scroller)
  const early = () => {
    viewportAt = Date.now()
    settle(false)
  }
  vv?.addEventListener('resize', early)
  vv?.addEventListener('scroll', early)
  return () => {
    ro.disconnect()
    vv?.removeEventListener('resize', early)
    vv?.removeEventListener('scroll', early)
  }
}

/** The message rows holdPlace keeps in place: a room's or a thread's (components/rooms/RoomMessages.tsx, as
 * lib/messageCopy.ts finds them) and an AI chat's (components/chat/Messages.tsx). */
export const ROOM_ROW = '[data-testid="room-message"]'
export const CHAT_ROW = '[data-message-id]'

type Rect = { getBoundingClientRect(): { top: number; bottom: number } }
/** What holdPlace needs of the list. */
export type HoldBox = Rect & { scrollTop: number; style: { overflowAnchor: string }; querySelectorAll(rows: string): Iterable<Rect & { isConnected: boolean }> }

/**
 * Older messages are about to be put above the ones on screen (a list scrolled up to its top: the AI chat, a room, a
 * thread): keep the message the reader is looking at where it is (QA TC-237). Notes the first row in sight (`rows`:
 * what marks a message row) and its place in the list's content, and turns the browser's own scroll anchoring off for
 * the list meanwhile. The returned function, called once the older messages are on screen, scrolls the list down by how
 * far that row moved down (what came in above it) and turns anchoring back on.
 * Before, the list added the height it grew by (scrollHeight) on top of what the browser's scroll anchoring had done
 * already (Chromium, current Safari): the view jumped down by a whole page. Doing it here, once, gives the same result
 * whether the engine anchors or not (an older iPhone does not), at the very top too, and what grew below the row (a
 * streaming answer, a new message) is not counted. A row that is gone by then: the list stays as it is.
 */
export function holdPlace(scroller: HoldBox, rows: string): () => void {
  const top = () => scroller.getBoundingClientRect().top
  let row: (Rect & { isConnected: boolean }) | null = null
  for (const r of scroller.querySelectorAll(rows)) {
    if (r.getBoundingClientRect().bottom > top()) { row = r; break }
  }
  /** the row's top in the list's content (not on screen: what the reader scrolls does not count) */
  const at = (r: Rect) => r.getBoundingClientRect().top - top() + scroller.scrollTop
  const before = row ? at(row) : 0
  const anchor = scroller.style.overflowAnchor
  scroller.style.overflowAnchor = 'none'
  return () => {
    if (row?.isConnected) {
      const added = at(row) - before
      if (Math.abs(added) >= 1) scroller.scrollTop += added
    }
    scroller.style.overflowAnchor = anchor
  }
}

/** A message list's scrolling, the same in every list. Put `scroller` on the scrolling box and `content` on the box of
 * its messages; call `onScroll()` first in the list's scroll handler and `follow()` in a layout effect on what makes
 * the list grow (new messages, a streaming answer). `stick` is true while it follows the newest message (set it to true
 * after the person's own send). `canStick`: false while the list shows a window whose bottom is not the conversation's
 * (a room opened around an older message). */
export function useStickToBottom(canStick?: () => boolean) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const lastTop = useRef(0)
  const seen = useRef<ListSize | null>(null)
  const may = useRef(canStick)
  may.current = canStick
  const can = () => may.current?.() ?? true
  const follows = () => stick.current && can()
  useEffect(() => {
    const s = scroller.current, c = content.current
    if (!s || !c) return
    return watchListSize(s, c, { follows, lastTop, seen })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return {
    scroller,
    content,
    stick,
    /** the list's scroll event (onListScroll) */
    onScroll(): boolean {
      const el = scroller.current
      return !!el && onListScroll(el, { stick, lastTop, seen }, can)
    },
    /** to the bottom while following (after new messages) */
    follow() {
      const el = scroller.current
      if (el && follows()) jumpToBottom(el, lastTop)
    },
  }
}
