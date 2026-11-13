// A project's page as this window last showed it (docs/DECISIONS.md "Folders, project pages and file previews open at
// once"): the project (GET /api/projects/:id?manage=1), its chats (GET /api/chats?projectId=…) and who is in it (GET
// /api/projects/:id/people: the faces under its name), by project id. Going back to the page shows them at once and the
// page reads them again behind it; its files come from store/teamFiles.ts.
// Chat events keep the kept chats current while the page is not on screen (the same change the page makes). An access
// change or a live connection that could not resume drops everything (who is a member may have changed); sign-out and
// another person signing in empty it (App.tsx dropPersonStores).
import { create } from 'zustand'
import type { Chat, Project, ProjectPeople } from '@mycel/shared/api'
import { accessChanged, chatChanged, filesChanged, reloadAsked } from './live'

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
  /** who is in it (components/ProjectPeople.tsx); absent: not read, or no such list */
  people?: ProjectPeople
}

interface ProjectPageState {
  pages: Record<string, KeptProjectPage>
  /** the page as it is on screen now */
  keep: (id: string, page: KeptProjectPage) => void
  /** gone, or not mine to see any more */
  drop: (id: string) => void
  /** who is in a kept page's project, read now (undefined: there is no list); nothing for a page not kept */
  keepPeople: (id: string, people: ProjectPeople | undefined) => void
  reset: () => void
}

export const useProjectPage = create<ProjectPageState>((set) => ({
  pages: {},
  keep: (id, page) => set((s) => {
    const next = { ...s.pages }
    // (its people stay: they are read apart, keepPeople)
    const people = 'people' in page ? page.people : s.pages[id]?.people
    delete next[id]
    next[id] = people ? { ...page, people } : page
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
  keepPeople: (id, people) => set((s) => {
    const page = s.pages[id]
    if (!page || page.people === people) return s
    const { people: _, ...rest } = page
    return { pages: { ...s.pages, [id]: people ? { ...rest, people } : rest } }
  }),
  reset: () => {
    moved.clear()
    set({ pages: {} })
  },
}))

/** folders moved or renamed while this window was open (a file event with `from`): a project known by one of them is
 * asked for again before its folder is opened (the server moved its folder with it) */
const moved = new Set<string>()
const key = (p: string) => p.normalize('NFC')
/** Whether this folder, or one it is in, was moved or renamed since the project was read. */
export const folderMoved = (folder: string) => [...moved].some((m) => key(folder) === m || key(folder).startsWith(`${m}/`))

filesChanged.on((changes) => {
  const from = changes.flatMap((c) => (c.from ? [key(c.from)] : []))
  if (!from.length) return
  for (const f of from) moved.add(f)
  while (moved.size > 200) moved.delete(moved.values().next().value!)
  const { pages } = useProjectPage.getState()
  for (const [id, page] of Object.entries(pages)) if (folderMoved(page.project.folderPath)) useProjectPage.getState().drop(id)
})

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
