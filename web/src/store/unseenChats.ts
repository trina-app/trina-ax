// PROTOTYPE (desktop sidebar, not approved yet): AI chats whose answer finished while I was not looking at that chat
// (another chat, another page, or the window hidden). Their row in "트리나 채팅" gets a dot until the chat is opened. This
// window only and forgotten on reload: the server keeps no "seen" mark per chat yet (that would be the real version).
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { create } from 'zustand'
import { useChats } from './chats'

export const useUnseenChats = create<{ ids: Record<string, true> }>(() => ({ ids: {} }))

const onScreen = (chatId: string) =>
  typeof location !== 'undefined' && location.pathname === `/c/${chatId}` && typeof document !== 'undefined' && !document.hidden

export function markChatSeen(chatId: string) {
  if (!useUnseenChats.getState().ids[chatId]) return
  useUnseenChats.setState((s) => {
    const ids = { ...s.ids }
    delete ids[chatId]
    return { ids }
  })
}

let watchers = 0
let stop: (() => void) | null = null
function watch(): () => void {
  if (watchers++ === 0) {
    stop = useChats.subscribe((s, prev) => {
      if (s.chats === prev.chats) return
      const before = new Map(prev.chats.map((c) => [c.id, c.runState]))
      const done = s.chats.filter((c) => c.runState === 'idle' && before.has(c.id) && before.get(c.id) !== 'idle' && !onScreen(c.id)).map((c) => c.id)
      if (done.length) useUnseenChats.setState((st) => ({ ids: { ...st.ids, ...Object.fromEntries(done.map((id) => [id, true as const])) } }))
    })
  }
  return () => {
    if (--watchers > 0) return
    stop?.()
    stop = null
  }
}

/** Keeps the marks while the caller is mounted, and clears a chat's mark once it is on screen. */
export function useUnseenChatsWatch() {
  const { pathname } = useLocation()
  useEffect(watch, [])
  useEffect(() => {
    const seen = () => {
      const m = /^\/c\/([^/]+)/.exec(pathname)
      if (m && !document.hidden) markChatSeen(m[1]!)
    }
    seen()
    document.addEventListener('visibilitychange', seen)
    return () => document.removeEventListener('visibilitychange', seen)
  }, [pathname])
}
