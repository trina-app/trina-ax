// How many Inbox notices I have not read: one count for the whole window, read once and again when the server says the
// Inbox changed (or after a reconnect, or a change of what I may open). The sidebar's 알림함 row and, on a phone, the 나
// tab and the 알림함 row on top of its list show it. Loaded while at least one of them is on screen.
import { useEffect } from 'react'
import { create } from 'zustand'
import { api, API } from '../lib/api'
import { accessChanged, notificationsChanged, reloadAsked } from './live'

export const useInbox = create<{ unread: number }>(() => ({ unread: 0 }))

let watchers = 0
let stop: (() => void) | null = null
/** the newest read wins: an older answer that arrives late is dropped */
let asked = 0

function load() {
  const n = ++asked
  api.call(API.listNotifications, { query: { limit: 1 } }).then(
    (r) => n === asked && useInbox.setState({ unread: r.unreadCount }),
    () => {},
  )
}

function watch(): () => void {
  if (watchers++ === 0) {
    // nothing on screen counted it meanwhile (another account may have signed in): no old count until the read
    useInbox.setState({ unread: 0 })
    load()
    const offs = [notificationsChanged.on(load), reloadAsked.on(load), accessChanged.on(load)]
    stop = () => offs.forEach((off) => off())
  }
  return () => {
    if (--watchers > 0) return
    stop?.()
    stop = null
  }
}

/** The unread Inbox count, kept up to date while the caller is mounted. */
export function useInboxUnread(): number {
  useEffect(watch, [])
  return useInbox((s) => s.unread)
}
