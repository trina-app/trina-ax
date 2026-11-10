// Is the person looking at this page now? What reading a room (pages/Room.tsx, components/rooms/ThreadPanel.tsx), the
// room sound (store/roomSound.ts) and the session markers (store/sessionMarkers.ts) go by.
//
// In a browser on a computer: the page is on screen and its window has the focus. In the desktop app: the page is on
// screen and the app's window has the focus, as the app says (DesktopBridge.focus). The team page is one of several
// views in that window, and its own `document.hasFocus()` is false while the window is focused: after the app starts
// with a team (a login start, a relaunch after an update) until the person clicks into the page, and while the in-app
// browser or the address strip has the keyboard. Going by the page's own focus, a new message in the room on screen
// rang and was not marked read (the owner, 2026-11-10: "the desktop app open on that conversation, and the sound still
// played"). An app without the word (older than session markers): the page's own focus, as before.
// On a phone (the phone app, or a browser whose only pointer is a finger) the page on screen is what the person looks
// at: there is no other window to lose focus to. And a WKWebView (the phone app on an iPhone, and Chrome, Firefox or
// Edge there) reports no focus until the person touches the page (WebKit bug 226025), so `document.hasFocus()` said "not
// looking" while the person read a room they had opened from a notice: nothing was marked read, and every other window
// and device of theirs kept the room's badge and rang for it.
//
// The rule for a new room message (docs/DECISIONS.md "화면에 연 대화는 울리지 않는다"): while the person looks at this
// window and it shows that conversation (conversationOnScreen), the message only appears: no sound, no notification, no
// badge. Looking at another conversation, or not looking (another app in front, the window hidden): as before.
import { desktop } from './desktop'
import { mobileApp } from './mobile'

/** the desktop app's word on its window's focus (null: not in the desktop app, an app without the word, or not
 * watched: signed out) */
let windowFocus: boolean | null = null
const watchers = new Set<() => void>()
let unwatch: (() => void) | null = null

function setWindowFocus(f: boolean | null) {
  if (windowFocus === f) return
  windowFocus = f
  for (const w of [...watchers]) {
    try { w() } catch { /* one watcher never stops the others */ }
  }
}

/** The desktop app's word on its window's focus, null where there is none. */
export const windowFocused = (): boolean | null => windowFocus

/** Call `fn` when the desktop app's window gains or loses the focus. Returns the call that stops it. */
export function onWindowFocus(fn: () => void): () => void {
  watchers.add(fn)
  return () => { watchers.delete(fn) }
}

/** Follow the desktop app's word on its window's focus (store/sessionMarkers.ts, with the live updates). Nothing outside
 * the desktop app or in one without the word. Until the app answers, the page's own focus. */
export function watchWindowFocus() {
  const app = desktop()
  if (unwatch || !app?.focus || typeof document === 'undefined') return
  let on = true
  setWindowFocus(typeof document.hasFocus === 'function' ? document.hasFocus() : true)
  const off = app.focus.onChange((f) => { if (on) setWindowFocus(!!f) })
  void app.focus.get().then((f) => { if (on) setWindowFocus(!!f) }, () => {})
  unwatch = () => {
    on = false
    off()
  }
}

/** Stop following it (signed out, the live updates stopped). */
export function unwatchWindowFocus() {
  unwatch?.()
  unwatch = null
  setWindowFocus(null)
}

export function lookingAt(): boolean {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false
  if (mobileApp() || touchOnly()) return true
  if (windowFocus !== null) return windowFocus
  return typeof document.hasFocus !== 'function' || document.hasFocus()
}

/** What a window shows of the rooms: the room open (its timeline) and the threads its panels show ("<room id>/<root
 * id>", store/rooms.ts placeKey: the one beside the room or over it, the one beside a file in the viewer). */
export interface RoomsOnScreen {
  room: string | null
  threads?: readonly string[]
}

/** Is the conversation of a new message on screen there? Its room open (the timeline; a reply in one of its threads
 * too, as before), or, for a reply in a thread, a panel showing that thread (beside a file opened outside the room). */
export function conversationOnScreen(on: RoomsOnScreen | null, roomId: string, threadRootId?: string | null): boolean {
  if (!on) return false
  if (on.room === roomId) return true
  return !!threadRootId && !!on.threads?.includes(`${roomId}/${threadRootId}`)
}

/** a phone or tablet whose only pointer is a finger (as the room sound counts a phone) */
const touchOnly = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches
