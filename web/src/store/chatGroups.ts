// The Trina list's groups as the server last said them (GET /api/chats/groups; docs/DECISIONS.md "The Trina list:
// pinned, folders, projects, other chats"): each folder's and project's count, first rows and marks, never worked out
// from the chat pages this window happens to have loaded. Read when the list first shows, again a moment after a chat
// of mine changes (chat.updated: a new chat, a pin, a move, an answer), when my folders change, when the server asks
// for a reload (a reconnect it could not resume) or project access changes, and when the window comes back to the
// front after a minute. One read at a time; a change during a read reads once more after it. The rows themselves are
// drawn from the chats store when it has them (fresher marks), else as the server sent them.
// The list listens for those changes only while it is on screen (panels/TrinaList.tsx); a change while it is not (a
// phone's /new or a chat, a computer's 트리나 panel hidden) marks what was read stale here, so the list shown again reads
// at once instead of keeping its 5 s rule and missing the new chat until a reload.
import { create } from 'zustand'
import type { Chat, ChatGroups } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { optimisticEdits, optimisticPendingKeys } from '../lib/optimistic'
import { chatChanged, navFoldersChanged } from './live'

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
    stale = false
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
/** a chat or a chat folder of mine changed since the last read started */
let stale = false
let timer: ReturnType<typeof setTimeout> | null = null

/** Read the groups (one read at a time; `minAgeMs`: not again that soon). */
export function readChatGroups(o: { minAgeMs?: number } = {}): Promise<void> {
  if (inFlight) {
    again = true
    return inFlight
  }
  if (o.minAgeMs && !stale && lastRead && Date.now() - lastRead < o.minAgeMs) return Promise.resolve()
  stale = false
  const mine = generation
  const edits = optimisticEdits(isChatPin)
  inFlight = api.call(API.listChatGroups).then(
    (groups) => {
      if (mine !== generation) return
      // a pin made here while it was asked (lib/optimistic.ts): this answer may be from before it and would move the
      // row back for a moment, read once more instead
      if (edits !== optimisticEdits(isChatPin)) {
        again = true
        return
      }
      lastRead = Date.now()
      useChatGroups.setState({ groups: withPendingPins(groups), error: null })
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

const isChatPin = (key: string) => key.startsWith('chat:') && key.endsWith(':pin')
const byPinTime = (a: Chat, b: Chat) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '')

/** a read's 고정 with the chats whose pin is still on its way as they are on screen (the read may be from before it) */
function withPendingPins(groups: ChatGroups): ChatGroups {
  const pending = new Set(optimisticPendingKeys(isChatPin).map((k) => k.slice('chat:'.length, -':pin'.length)))
  if (!pending.size) return groups
  const shown = useChatGroups.getState().groups?.pinned ?? []
  const pinned = [...groups.pinned.filter((c) => !pending.has(c.id)), ...shown.filter((c) => pending.has(c.id))].sort(byPinTime)
  return { ...groups, pinned }
}

/** A chat pinned or unpinned here: its row in 고정 at once, the most recently pinned first (the read a moment after it
 * says the same). Nothing before the first read. */
export function showPinnedChat(chat: Chat): void {
  const g = useChatGroups.getState().groups
  if (!g) return
  const rest = g.pinned.filter((c) => c.id !== chat.id)
  if (!chat.pinnedAt && rest.length === g.pinned.length) return
  const pinned = chat.pinnedAt ? [chat, ...rest].sort(byPinTime) : rest
  useChatGroups.setState({ groups: { ...g, pinned } })
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

// what makes the list stale, heard whether it is on screen or not (the same changes TrinaList reads again after)
chatChanged.on((d) => { if (!d.chat?.shared || d.chat.shared.mine || d.change !== 'updated') stale = true })
navFoldersChanged.on((k) => { if (k === 'chats') stale = true })
