// Is the person looking at this page now? What reading a room (pages/Room.tsx, components/rooms/ThreadPanel.tsx) and
// the room sound (store/roomSound.ts) go by.
//
// In a browser or the desktop app on a computer: the page is on screen and its window has the focus. On a phone (the
// phone app, or a browser whose only pointer is a finger) the page on screen is what the person looks at: there is no
// other window to lose focus to. And a WKWebView (the phone app on an iPhone, and Chrome, Firefox or Edge there) reports
// no focus until the person touches the page (WebKit bug 226025), so `document.hasFocus()` said "not looking" while the
// person read a room they had opened from a notice: nothing was marked read, and every other window and device of theirs
// kept the room's badge and rang for it.
import { mobileApp } from './mobile'

export function lookingAt(): boolean {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false
  if (mobileApp() || touchOnly()) return true
  return typeof document.hasFocus !== 'function' || document.hasFocus()
}

/** a phone or tablet whose only pointer is a finger (as the room sound counts a phone) */
const touchOnly = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches
