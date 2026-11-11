// The phone's ‹ (a room, an AI chat, a page under a tab): back in the real history when the entry before this one is
// the app's own, so the phone's own back (Android, the WebView's history) and ‹ walk the same way and never loop. On a
// phone the entries before are the tab's stack, the screen's parents (lib/screenHistory.ts). With nothing of ours to go
// back to (a stack's first entry): the fallback, the screen's parent or the tab's list, in place of this entry
// (replace), never pushed on top of it.
import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'

/** React Router numbers its entries from the document's first one (0); above 0 the one before is ours */
export function hasAppHistory(): boolean {
  if (typeof window === 'undefined') return false
  const idx = (window.history?.state as { idx?: unknown } | null | undefined)?.idx
  return typeof idx === 'number' && idx > 0
}

/** For a ‹ button: back, or the fallback list in place of this entry. */
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate()
  return () => {
    if (hasAppHistory()) navigate(-1)
    else navigate(fallback, { replace: true })
  }
}

/** For a ‹ link (`<Link to={fallback} replace onClick={…}>`): the link itself is the fallback; with history behind it
 * the click goes back instead. Modified clicks (a new tab) are left to the browser. */
export function useBackLink(): (e: MouseEvent<HTMLAnchorElement>) => void {
  const navigate = useNavigate()
  return (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (!hasAppHistory()) return
    e.preventDefault()
    navigate(-1)
  }
}
