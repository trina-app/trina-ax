// What an Admin page tells the phone's bar (AdminLayout.tsx PhonePageBar) about the page on show: the title of an item's
// own page (a connector's, a person's name: the layout knows only the section), and a check before ‹ leaves (the rule
// editor asks first when its rules were changed). And the way up from an item's page for the page's own buttons
// (a computer's "← Connected apps"): back in the history when the page under it is that list, else the list in place.
import { createContext, useContext, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { hasAppHistory } from '../../lib/back'
import { entryBelow } from '../../lib/backStack'

export interface AdminBar {
  /** the bar's title for this page (null: the section's name) */
  title: string | null
  /** before ‹ goes back: false keeps the page (the person chose to stay) */
  beforeBack?: () => Promise<boolean>
}

const SetBar = createContext<(bar: AdminBar | null) => void>(() => {})
export const AdminBarProvider = SetBar.Provider

/** Give the phone's bar this page's title (and a check before ‹ leaves) while the page is on screen. */
export function useAdminBar(title: string | null | undefined, beforeBack?: () => Promise<boolean>) {
  const set = useContext(SetBar)
  const check = useRef(beforeBack)
  check.current = beforeBack
  const asks = !!beforeBack
  useEffect(() => {
    if (title == null && !asks) return
    set({ title: title ?? null, beforeBack: asks ? () => check.current?.() ?? Promise.resolve(true) : undefined })
    return () => set(null)
  }, [set, title, asks])
}

const pathOf = (to: string) => to.split(/[?#]/)[0]

/** Up to `parent` (an item's page → its list): Back when the entry under this one is that page, so the history does
 * not grow and the list keeps its place; else the list in place of this entry (a pasted address, a link from elsewhere). */
export function useUpTo(): (parent: string) => void {
  const navigate = useNavigate()
  const location = useLocation()
  return (parent) => {
    const below = entryBelow(location.key)
    if (hasAppHistory() && below != null && pathOf(below) === pathOf(parent)) navigate(-1)
    else navigate(parent, { replace: true })
  }
}
