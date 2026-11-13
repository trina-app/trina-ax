// The Trina list's groups as the server last said them (GET /api/chats/groups; docs/DECISIONS.md "The Trina list:
// pinned, folders, projects, other chats"): each folder's and project's count, first rows and marks, never worked out
// from the chat pages this window happens to have loaded. Read when the list first shows, again a moment after a chat
// of mine changes (chat.updated: a new chat, a pin, a move, an answer), when my folders change, when the server asks
// for a reload (a reconnect it could not resume) or project access changes, and when the window comes back to the
// front after a minute. One read at a time; a change during a read reads once more after it. The rows themselves are
// drawn from the chats store when it has them (fresher marks), else as the server sent them.
import { create } from 'zustand'
import type { ChatGroups } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface ChatGroupsState {
  groups: ChatGroups | null
  /** the last read failed and nothing was read before it */
  error: unknown
  reset: () => void
}

export const useChatGroups = create<ChatGroupsState>((set) => ({
  groups: null,
  error: null,
  reset: () => {
    generation++
    inFlight = null
    again = false
    lastRead = 0
    if (timer) clearTimeout(timer)
    timer = null
    set({ groups: null, error: null })
  },
}))

/** a read started before a reset (another person signed in since) never lands */
let generation = 0
let inFlight: Promise<void> | null = null
/** something changed while a read was on its way: read once more after it */
let again = false
let lastRead = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** Read the groups (one read at a time; `minAgeMs`: not again that soon). */
export function readChatGroups(o: { minAgeMs?: number } = {}): Promise<void> {
  if (inFlight) {
    again = true
    return inFlight
  }
  if (o.minAgeMs && lastRead && Date.now() - lastRead < o.minAgeMs) return Promise.resolve()
  const mine = generation
  inFlight = api.call(API.listChatGroups).then(
    (groups) => {
      if (mine !== generation) return
      lastRead = Date.now()
      useChatGroups.setState({ groups, error: null })
    },
    (e: unknown) => {
      if (mine !== generation) return
      useChatGroups.setState({ error: e ?? new Error('failed') })
    },
  ).finally(() => {
    if (mine !== generation) return
    inFlight = null
    if (again) {
      again = false
      void readChatGroups()
    }
  })
  return inFlight
}

/** how long a burst of changes (an answer's run state, a pin and its move) waits before the one read after it */
export const GROUPS_SETTLE_MS = 600

/** Read again a moment after a change (many changes in a row make one read). */
export function chatGroupsChanged(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void readChatGroups()
  }, GROUPS_SETTLE_MS)
}
