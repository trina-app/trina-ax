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
import { accessChanged, notificationsChanged, reloadAsked } from './live'

/** One chat's unread mentions of me: how many (threads) and who, the newest first, each name once. */
export interface ChatMention { chatId: string; count: number; names: string[] }

/** How many notices are read: the Inbox's first page at its largest (a person with more unread mentions than this sees
 * the newest ones counted). */
export const MENTIONS_READ = 100

/** The unread mentions of me among `items`, by chat, the newest notice first (the list's own order). */
export function mentionsByChat(items: readonly InboxNotification[]): Map<string, ChatMention> {
  const out = new Map<string, ChatMention>()
  for (const n of items) {
    const th = n.chatThread
    if (n.code !== 'chat.thread_reply' || n.readAt || !th?.mention || th.gone) continue
    const chatId = th.chatId ?? n.chatId
    if (!chatId) continue
    const m = out.get(chatId) ?? { chatId, count: 0, names: [] }
    m.count++
    if (th.name && !m.names.includes(th.name)) m.names.push(th.name)
    out.set(chatId, m)
  }
  return out
}

/** The mentions by project: each chat's count added to its project's (a chat whose project is not known is left out). */
export function mentionsByProject(byChat: ReadonlyMap<string, ChatMention>, projectOf: (chatId: string) => string | null | undefined): Map<string, ChatMention & { chats: number }> {
  const out = new Map<string, ChatMention & { chats: number }>()
  for (const m of byChat.values()) {
    const p = projectOf(m.chatId)
    if (!p) continue
    const t = out.get(p) ?? { chatId: m.chatId, count: 0, names: [], chats: 0 }
    t.count += m.count
    t.chats++
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

function load() {
  const n = ++asked
  api.call(API.listNotifications, { query: { limit: MENTIONS_READ } }).then(
    (r) => {
      if (n !== asked) return
      const byChat = mentionsByChat(r.items)
      useChatMentions.setState({ byChat })
      // the project of a mentioned chat this window does not hold yet: read once
      const st = useChats.getState()
      const known = useChatMentions.getState().projectOf
      for (const id of byChat.keys()) {
        if (id in known || st.chats.some((c) => c.id === id) || st.others[id]) continue
        useChatMentions.setState((s) => ({ projectOf: { ...s.projectOf, [id]: null } }))
        api.call(API.getChat, { params: { id } }).then(
          (c) => useChatMentions.setState((s) => ({ projectOf: { ...s.projectOf, [id]: c.projectId } })),
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
    const offs = [notificationsChanged.on(load), reloadAsked.on(load), accessChanged.on(load)]
    stop = () => offs.forEach((off) => off())
  }
  return () => {
    if (--watchers > 0) return
    stop?.()
    stop = null
  }
}

/** Signed out or another person in this window: nothing of the last person's stays. */
export function resetChatMentions() {
  asked++
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
