// Android's Back (and the browser's) closes a full-screen panel on a phone instead of leaving the page (QA TC-080: Back
// with the room's ✦ side chat open went to the Chats list). Opening adds one history entry at the same address with the
// router's state copied (its idx, key and usr), as the image viewer does (lib/imageViewer.ts); a popstate that leaves
// that entry closes the panel. Closing it any other way goes back off the entry when it is still on top, so none is left
// behind. The image viewer opened from the panel copies the state too, so Back from the viewer lands on the panel's
// entry and keeps the panel open.
// A page opened while the panel is open (a link in the drawer, "open in folder") is pushed on top of our entry, which
// then stays in the history under it. Such a left-behind entry is skipped: Back from the new page lands on it and goes
// on to the page under it, so one Back is one step (QA TC-141). Forward over it goes on the same way.
import { useEffect, useRef } from 'react'

const KEY = '__backCloses'
let seq = 0
type State = Record<string, unknown> | null

const stateNow = () => window.history.state as State

/** entries left under a newer page; the one skipped back over last, so Forward onto it goes on forward */
const leftBehind = new Set<number>()
let skippedBack: number | null = null
const skipLeftBehind = () => {
  const id = stateNow()?.[KEY]
  if (typeof id !== 'number' || !leftBehind.has(id)) return
  if (skippedBack === id) {
    skippedBack = null
    window.history.forward()
  } else {
    skippedBack = id
    window.history.back()
  }
}
// the same listener added again is ignored, so this may run on every entry left behind
const watchLeftBehind = () => window.addEventListener('popstate', skipLeftBehind)

/**
 * Hold one history entry while something is open. `onBack` runs once when a Back leaves the entry. The function
 * returned lets go of it: with `goBack`, a history.back() when the entry is still the one on top.
 */
export function holdBackEntry(onBack: () => void): (goBack?: boolean) => void {
  const mine = ++seq
  let done = false
  try {
    window.history.pushState({ ...(stateNow() ?? {}), [KEY]: mine }, '')
  } catch {
    // a history the page may not change (a sandbox): the panel still opens, Back just leaves the page as before
    return () => {}
  }
  const onPop = () => {
    if (done || stateNow()?.[KEY] === mine) return
    done = true
    window.removeEventListener('popstate', onPop)
    onBack()
  }
  window.addEventListener('popstate', onPop)
  return (goBack = true) => {
    if (done) return
    done = true
    window.removeEventListener('popstate', onPop)
    if (stateNow()?.[KEY] === mine) {
      if (goBack) window.history.back()
    } else {
      // a newer page is on top: our entry stays under it, and Back skips it
      leftBehind.add(mine)
      watchLeftBehind()
    }
  }
}

/**
 * While `open` and `active` (a phone), Back runs `close` instead of leaving the page. `at` (the router location's key):
 * a panel that stays open when the page changes holds a new entry on top of the new page.
 */
export function useBackCloses(open: boolean, close: () => void, active: boolean, at?: string) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open || !active) return
    const release = holdBackEntry(() => closeRef.current())
    // closed by its own button, or the page left: back off the entry only when it is still on top
    return () => release(true)
  }, [open, active, at])
}
