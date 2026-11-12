// How many Inbox notices I have not read: one count for the whole window, read once and again when the server says the
// Inbox changed (or after a reconnect, or a change of what I may open). The sidebar's 알림함 row shows it whole. A phone
// counts each unread thing once across its tabs (QA TC-256): the conversation rows (mentions, thread replies) are the 대화
// tab's, which counts their rooms already, so the 나 tab and the 활동 row on top of its list show only the rest (the app's
// own notices), and 대화's 멘션·스레드 row a dot for them. Loaded while at least one of them is on screen.
import { useEffect } from 'react'
import { create } from 'zustand'
import { api, API } from '../lib/api'
import { accessChanged, notificationsChanged, reloadAsked } from './live'

/** `unread`: every unread row; `rooms`: its part that is conversation rows (GET /api/notifications roomUnreadCount);
 * `notices`: the unread notices that are not conversation rows at all (noticeUnreadCount; an older server: the rest) */
export const useInbox = create<{ unread: number; rooms: number; notices: number }>(() => ({ unread: 0, rooms: 0, notices: 0 }))

let watchers = 0
let stop: (() => void) | null = null
/** the newest read wins: an older answer that arrives late is dropped */
let asked = 0

function load() {
  const n = ++asked
  api.call(API.listNotifications, { query: { limit: 1 } }).then(
    (r) => {
      if (n !== asked) return
      const rooms = Math.min(r.unreadCount, r.roomUnreadCount ?? 0)
      useInbox.setState({ unread: r.unreadCount, rooms, notices: r.noticeUnreadCount ?? r.unreadCount - rooms })
    },
    () => {},
  )
}

function watch(): () => void {
  if (watchers++ === 0) {
    // nothing on screen counted it meanwhile (another account may have signed in): no old count until the read
    useInbox.setState({ unread: 0, rooms: 0, notices: 0 })
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

/** Signed out, or another person signed in in this window (App.tsx): no count of the last person's stays, and an answer
 * to a read made for them is dropped. */
export function resetInbox() {
  asked++
  useInbox.setState({ unread: 0, rooms: 0, notices: 0 })
}

/** The unread Inbox count, kept up to date while the caller is mounted. */
export function useInboxUnread(): number {
  useEffect(watch, [])
  return useInbox((s) => s.unread)
}

/** A phone's 나 count: the unread notices that are not conversation rows (those are counted on 대화). */
export function useNoticeUnread(): number {
  useEffect(watch, [])
  return useInbox((s) => s.unread - s.rooms)
}

/** How many conversation rows (mentions, thread replies) are unread: a phone's 멘션·스레드 row shows a dot for them. */
export function useRoomNoticeUnread(): number {
  useEffect(watch, [])
  return useInbox((s) => s.rooms)
}

/** The computer's 활동 with the new navigation (rail/Rail.tsx, panels/ActivityPanel.tsx): the unread notices that are not
 * conversation rows, the same number as the 활동 list's own unread rows. Conversation rows are 대화's, of any room (a
 * muted room's too: that room's choice is to stay quiet). */
export function useActivityUnread(): number {
  useEffect(watch, [])
  return useInbox((s) => s.notices)
}

/** Read the count again now (the 활동 list read or marked something). */
export const reloadInboxCount = () => load()
