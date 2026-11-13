// A project's page as this window last showed it (docs/DECISIONS.md "Folders, project pages and file previews open at
// once"): the project (GET /api/projects/:id?manage=1) and its chats (GET /api/chats?projectId=…), by project id. Going
// back to the page shows them at once and the page reads both again behind it; its files come from store/teamFiles.ts.
// Chat events keep the kept chats current while the page is not on screen (the same change the page makes). An access
// change or a live connection that could not resume drops everything (who is a member may have changed); sign-out and
// another person signing in empty it (App.tsx dropPersonStores).
import { create } from 'zustand'
import type { Chat, Project } from '@mycel/shared/api'
import { accessChanged, chatChanged, reloadAsked } from './live'

/** how many project pages stay (the one seen longest ago goes first) */
const KEPT_PAGES = 12

/** A project's chats as its page lists them: my pinned ones first (the most recently pinned first, as the server's first
 * page has them), then the newest. */
export const chatOrder = (a: Chat, b: Chat) =>
  a.pinnedAt || b.pinnedAt
    ? (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '')
    : a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1

/** A chat of the list as it is now, with the faces of who wrote in it it had: those come with the list only, not with a
 * chat event or an action's answer. */
export const keepFaces = (old: Chat | undefined, chat: Chat): Chat =>
  old?.shared?.people && chat.shared && !chat.shared.people ? { ...chat, shared: { ...chat.shared, people: old.shared.people, peopleCount: old.shared.peopleCount } } : chat

/** A project's chats after a chat event (a chat of it made, renamed or restored shows; one deleted, moved away or no
 * longer visible goes). */
export function withChatEvent(cur: Chat[], projectId: string, e: { chatId: string; change: string; chat?: Chat | null }): Chat[] {
  const old = cur.find((c) => c.id === e.chatId)
  const rest = cur.filter((c) => c.id !== e.chatId)
  if (e.change === 'deleted' || e.change === 'purged' || !e.chat || e.chat.deletedAt || e.chat.projectId !== projectId) return old ? rest : cur
  return [keepFaces(old, e.chat), ...rest].sort(chatOrder)
}

export interface KeptProjectPage {
  project: Project
  /** null: not read yet when the page was left */
  chats: Chat[] | null
}

interface ProjectPageState {
  pages: Record<string, KeptProjectPage>
  /** the page as it is on screen now */
  keep: (id: string, page: KeptProjectPage) => void
  /** gone, or not mine to see any more */
  drop: (id: string) => void
  reset: () => void
}

export const useProjectPage = create<ProjectPageState>((set) => ({
  pages: {},
  keep: (id, page) => set((s) => {
    const next = { ...s.pages }
    delete next[id]
    next[id] = page
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - KEPT_PAGES))) delete next[k]
    return { pages: next }
  }),
  drop: (id) => set((s) => {
    if (!(id in s.pages)) return s
    const next = { ...s.pages }
    delete next[id]
    return { pages: next }
  }),
  reset: () => set({ pages: {} }),
}))

chatChanged.on((e) => {
  const { pages } = useProjectPage.getState()
  let changed = false
  const next: Record<string, KeptProjectPage> = {}
  for (const [id, page] of Object.entries(pages)) {
    const chats = page.chats && withChatEvent(page.chats, id, e)
    changed ||= chats !== page.chats
    next[id] = chats === page.chats ? page : { ...page, chats }
  }
  if (changed) useProjectPage.setState({ pages: next })
})
accessChanged.on(() => useProjectPage.getState().reset())
reloadAsked.on(() => useProjectPage.getState().reset())
