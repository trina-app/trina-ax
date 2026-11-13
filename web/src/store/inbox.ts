// How many Inbox notices I have not read: one count for the whole window, read once and again when the server says the
// Inbox changed (or after a reconnect, or a change of what I may open). The rail's 활동 shows it whole. A phone
// counts each unread thing once across its tabs (QA TC-256): the conversation rows (mentions, thread replies) are the 대화
// tab's, which counts their rooms already, so the 나 tab and the 활동 row on top of its list show only the rest (the app's
// own notices), and 대화's 멘션·스레드 row a dot for them. Loaded while at least one of them is on screen.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { ActivityTab, InboxNotification } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { optimistic, optimisticEdits, optimisticPending, optimisticPendingKeys, type OptimisticResult } from '../lib/optimistic'
import { accessChanged, notificationsChanged, reloadAsked } from './live'

/** `unread`: every unread row; `rooms`: its part that is conversation rows (GET /api/notifications roomUnreadCount);
 * `notices`: the unread notices that are not conversation rows at all (noticeUnreadCount; an older server: the rest) */
export const useInbox = create<{ unread: number; rooms: number; notices: number }>(() => ({ unread: 0, rooms: 0, notices: 0 }))

let watchers = 0
let stop: (() => void) | null = null
/** the newest read wins: an older answer that arrives late is dropped */
let asked = 0

/** a notice marked read here (lib/optimistic.ts) */
export const noticeReadKey = (id: string) => `notice:${id}:read`
const isNoticeKey = (key: string) => key.startsWith('notice:')

function load() {
  const n = ++asked
  const edits = optimisticEdits(isNoticeKey)
  api.call(API.listNotifications, { query: { limit: 1 } }).then(
    (r) => {
      if (n !== asked) return
      // a notice marked read here meanwhile: this count may be from before it. Still on its way: its answer reads again;
      // else read again now
      if (optimisticPendingKeys(isNoticeKey).length) return
      if (optimisticEdits(isNoticeKey) !== edits) return load()
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

/** The computer's 활동 (rail/Rail.tsx, panels/ActivityPanel.tsx): the unread notices that are not
 * conversation rows, the same number as the 활동 list's own unread rows. Conversation rows are 대화's, of any room (a
 * muted room's too: that room's choice is to stay quiet). */
export function useActivityUnread(): number {
  useEffect(watch, [])
  return useInbox((s) => s.notices)
}

/** Read the count again now (the 활동 list read or marked something). */
export const reloadInboxCount = () => load()

/** a conversation row (a DM, a mention or a thread reply): counted on 대화, not in 활동's own number */
const roomRow = (item: InboxNotification) => item.code === 'room.dm' || item.code === 'room.mention'

/** The counts with one notice read (-1) or unread again (+1), before the server says so. */
function count(item: InboxNotification, by: 1 | -1) {
  useInbox.setState((s) => {
    const room = roomRow(item)
    return { unread: Math.max(0, s.unread + by), rooms: room ? Math.max(0, s.rooms + by) : s.rooms, notices: room ? s.notices : Math.max(0, s.notices + by) }
  })
}

/** Mark one notice read (docs/DECISIONS.md "Optimistic changes"): read on screen at once (`show` puts its readAt on the
 * caller's copy; the counts go down by one), then the server; a failure puts it back with a toast and every list reads
 * again. The counts are read again after. Never rejects. */
export async function markNoticeRead(item: InboxNotification, show: (readAt: string | null) => void): Promise<OptimisticResult<InboxNotification>> {
  // (the same notice read from two places at once, the list and its own view: counted once)
  let counted = !!item.readAt || optimisticPending(noticeReadKey(item.id))
  const r = await optimistic<string | null, InboxNotification>({
    key: noticeReadKey(item.id),
    from: item.readAt ?? null,
    to: new Date().toISOString(),
    show: (at) => {
      show(at)
      if (!!at === counted) return
      counted = !!at
      count(item, at ? -1 : 1)
    },
    send: () => api.call(API.markNotificationRead, { params: { id: item.id } }),
    confirmed: (reply) => reply.readAt ?? null,
  })
  // not read: every list of it reads again (another place may show it read: the list and its own view share one change)
  if (!r.ok) notificationsChanged.emit()
  else load()
  return r
}

/** "Mark all as read" of an Activity tab (`only`: its conversation rows, or the other notices, alone): read on screen
 * at once (`show` puts the time on the caller's unread rows, null puts them back), the counts it empties at zero; a
 * failure puts the rows back with a toast. The counts are read again after. Never rejects. */
export async function markAllNoticesRead(tab: ActivityTab, only: 'rooms' | 'notices' | undefined, show: (readAt: string | null) => void): Promise<OptimisticResult<unknown>> {
  const r = await optimistic<string | null, unknown>({
    key: `notice:all:${tab}:${only ?? 'any'}:read`,
    from: null,
    to: new Date().toISOString(),
    show: (at) => {
      show(at)
      // a tab other than All empties only part of a count: the read after says how much
      if (!at || tab !== 'all') return
      useInbox.setState((s) => (only === 'notices' ? { unread: s.rooms, notices: 0 } : only === 'rooms' ? { unread: Math.max(0, s.unread - s.rooms), rooms: 0 } : { unread: 0, rooms: 0, notices: 0 }))
    },
    send: () => api.call(API.markAllNotificationsRead, { body: { tab, ...(only ? { only } : {}) } }),
  })
  load()
  return r
}

/** Rows read again while a read of mine is still on its way (one notice, or "Mark all as read"): a row read on screen
 * keeps its mark (the read may be from before it; the change's own answer decides). */
export function keepPendingReads(items: InboxNotification[], before: readonly InboxNotification[] | null): InboxNotification[] {
  if (!before || !optimisticPendingKeys(isNoticeKey).length) return items
  const shown = new Map(before.map((y) => [y.id, y.readAt]))
  return items.map((x) => (x.readAt || !shown.get(x.id) ? x : { ...x, readAt: shown.get(x.id)! }))
}
