// Where somebody mentioned me in a chat and I have not read it yet, for the 프로젝트 panel's counts
// (docs/decisions/20261120-project-chat-accordion.md): my unread Inbox notices 'chat.thread_reply' whose
// `chatThread.mention` is set (docs/decisions/20261118-chat-thread-mentions.md), one per unread thread, grouped by chat
// and, through the chat's project, by project. Who mentioned me is the notice's `chatThread.name` (the newest one).
// Read once while a list that shows them is on screen, and again whenever the Inbox changes (a notice read or a new one).
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { InboxNotification } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useChats } from './chats'
import { accessChanged, chatChanged, notificationsChanged, reloadAsked } from './live'

/** One chat's unread mentions of me: how many (threads) and who, the newest first, each name once; `ids`: the notices
 * (opening the chat reads them: readChatMentions). */
export interface ChatMention { chatId: string; count: number; names: string[]; ids: string[] }

/** The Inbox's conversation rows are read in pages of this many (`only: 'rooms'`: the chat-thread notices are
 * conversation rows, listed with the rooms' rows, which are one per place; the app's own notices are never chat-thread
 * mentions), at most MENTIONS_PAGES pages: the Inbox keeps 30 days, so this reaches
 * every unread mention of all but the busiest people, and the newest ones always. */
export const MENTIONS_READ = 100
export const MENTIONS_PAGES = 5

/** The unread mentions of me among `items`, by chat, the newest notice first (the list's own order). */
export function mentionsByChat(items: readonly InboxNotification[]): Map<string, ChatMention> {
  const out = new Map<string, ChatMention>()
  for (const n of items) {
    const th = n.chatThread
    if (n.code !== 'chat.thread_reply' || n.readAt || !th?.mention || th.gone) continue
    const chatId = th.chatId ?? n.chatId
    if (!chatId) continue
    const m = out.get(chatId) ?? { chatId, count: 0, names: [], ids: [] }
    m.count++
    m.ids.push(n.id)
    if (th.name && !m.names.includes(th.name)) m.names.push(th.name)
    out.set(chatId, m)
  }
  return out
}

/** How many unread mentions of me (threads) in all: the one count n adds them (store/sessionMarkers.ts). */
export function mentionCount(byChat: ReadonlyMap<string, ChatMention>): number {
  let n = 0
  for (const m of byChat.values()) n += m.count
  return n
}

/** The mentions by project: each chat's count added to its project's (a chat whose project is not known is left out). */
export type ProjectMention = ChatMention & { chats: number; chatIds: string[] }
export function mentionsByProject(byChat: ReadonlyMap<string, ChatMention>, projectOf: (chatId: string) => string | null | undefined): Map<string, ProjectMention> {
  const out = new Map<string, ProjectMention>()
  for (const m of byChat.values()) {
    const p = projectOf(m.chatId)
    if (!p) continue
    const t = out.get(p) ?? { chatId: m.chatId, count: 0, names: [], ids: [], chats: 0, chatIds: [] }
    t.count += m.count
    t.ids.push(...m.ids)
    t.chats++
    t.chatIds.push(m.chatId)
    for (const n of m.names) if (!t.names.includes(n)) t.names.push(n)
    out.set(p, t)
  }
  return out
}

interface State {
  byChat: Map<string, ChatMention>
  /** the project of a mentioned chat not in the chats store (GET /api/chats/:id), null: none, or it could not be read */
  projectOf: Record<string, string | null>
}
export const useChatMentions = create<State>(() => ({ byChat: new Map(), projectOf: {} }))

let watchers = 0
let stop: (() => void) | null = null
let asked = 0
/** raised only when the person changes: a chat's project read for the last person is dropped (a newer read of the
 * notices does not drop it, or the chat would stay without a project) */
let epoch = 0

async function readNotices(n: number): Promise<InboxNotification[] | null> {
  const items: InboxNotification[] = []
  let cursor: string | undefined
  for (let page = 0; page < MENTIONS_PAGES; page++) {
    const r = await api.call(API.listNotifications, { query: { limit: MENTIONS_READ, only: 'rooms', ...(cursor ? { cursor } : {}) } })
    if (n !== asked) return null
    items.push(...r.items)
    if (!r.nextCursor) break
    cursor = r.nextCursor
  }
  return items
}

function load() {
  const n = ++asked
  readNotices(n).then(
    (all) => {
      if (!all || n !== asked) return
      const byChat = mentionsByChat(all)
      useChatMentions.setState({ byChat })
      // the project of a mentioned chat this window does not hold yet: read once
      const st = useChats.getState()
      const known = useChatMentions.getState().projectOf
      for (const id of byChat.keys()) {
        if (id in known || st.chats.some((c) => c.id === id) || st.others[id]) continue
        useChatMentions.setState((s) => ({ projectOf: { ...s.projectOf, [id]: null } }))
        const e = epoch
        api.call(API.getChat, { params: { id } }).then(
          (c) => e === epoch && useChatMentions.setState((s) => ({ projectOf: { ...s.projectOf, [id]: c.projectId } })),
          () => {},
        )
      }
    },
    () => {},
  )
}

function watch(): () => void {
  if (watchers++ === 0) {
    load()
    // a chat moved to another project: its count follows it (a chat the chats store holds follows by itself)
    const moved = chatChanged.on((d) => {
      const known = useChatMentions.getState().projectOf
      if (d.chat && d.chatId in known && known[d.chatId] !== d.chat.projectId) useChatMentions.setState((s) => ({ projectOf: { ...s.projectOf, [d.chatId]: d.chat!.projectId } }))
    })
    const offs = [notificationsChanged.on(load), reloadAsked.on(load), accessChanged.on(load), moved]
    stop = () => offs.forEach((off) => off())
  }
  return () => {
    if (--watchers > 0) return
    stop?.()
    stop = null
  }
}

/** The chat is open on screen (pages/Chat.tsx): its mentions of me count as read, in the 프로젝트 panel and on the
 * project's page at once (the same counts), then on the server (each notice read, as the Inbox reads one), and the
 * Inbox's count and these counts are read again after. Known mentions only: what a list on screen read. Never rejects. */
export async function readChatMentions(chatId: string): Promise<void> {
  const m = useChatMentions.getState().byChat.get(chatId)
  if (!m?.ids.length) return
  useChatMentions.setState((s) => {
    const byChat = new Map(s.byChat)
    byChat.delete(chatId)
    return { byChat }
  })
  await Promise.all(m.ids.map((id) => api.call(API.markNotificationRead, { params: { id } }).catch(() => {})))
  // the server's answer (one that could not be read comes back) and the Inbox's count: every list of them reads again
  notificationsChanged.emit()
}

/** Signed out or another person in this window: nothing of the last person's stays. */
export function resetChatMentions() {
  asked++
  epoch++
  useChatMentions.setState({ byChat: new Map(), projectOf: {} })
}

/** My unread mentions by chat and by project, kept up to date while the caller is mounted. */
export function useMentions() {
  useEffect(watch, [])
  const byChat = useChatMentions((s) => s.byChat)
  const projectOf = useChatMentions((s) => s.projectOf)
  const chats = useChats((s) => s.chats)
  const others = useChats((s) => s.others)
  const byProject = useMemo(() => {
    const local = new Map([...Object.values(others), ...chats].map((c) => [c.id, c.projectId]))
    return mentionsByProject(byChat, (id) => local.get(id) ?? projectOf[id])
  }, [byChat, projectOf, chats, others])
  return { byChat, byProject }
}
