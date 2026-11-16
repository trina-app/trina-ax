// The one place that tells the server what this window shows (lib/lookingAt.ts; the AI's looking_at tool reads it):
// the address and the side panel, as ids. Called once, in the layout. A confidential chat on the screen reports
// nothing, also while it is not known yet whether the chat is one.
import { useEffect } from 'react'
import { matchPath, useLocation } from 'react-router-dom'
import { useConfidentialChat } from '../lib/confidential'
import { lookingOf, reportLooking } from '../lib/lookingAt'
import { useSidePanel } from '../lib/sidePanel'

export function useReportLooking() {
  const { pathname, search } = useLocation()
  const panel = useSidePanel()
  const chatId = matchPath('/c/:chatId/*', pathname)?.params.chatId ?? null
  // true, false, or null while a chat outside the loaded list is being asked about: only a known "no" reports
  const confidential = useConfidentialChat(chatId)
  const looking = lookingOf(pathname, search, panel, confidential !== false)
  const key = JSON.stringify(looking)
  useEffect(() => {
    reportLooking(JSON.parse(key))
  }, [key])
}
