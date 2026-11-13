// Session markers (docs/DECISIONS.md "Session markers"): one marker per AI chat row, from the chat list's own fields
// (phone-nav's Chat.waiting / Chat.unseen, Chat.lastOutcome, runState) and the cards open in this window, and the one
// count n that bubbles up (the tab title, the dock badge; at 0 the icon's dot for other unread rooms). Pure: no React,
// no stores; unit-tested in test/unit/session-markers.test.tsx.
//   "?"      your turn: an open card (it stays until the card closes, on screen too), or a failed / paused answer not
//            seen yet
//   spinner  running or queued
//   dot      a new answer not seen yet
// Priority ? > spinner > dot. While a chat runs again, its earlier answer is behind the new one: a card's "?" or the
// spinner. The chat on screen in a visible window shows no dot and no failed "?" (the window sends /seen, and the
// server's word follows a moment later).
import { attentionCount, markerOf, needsMe, type Chat, type MarkedChat, type Marker, type MarkerKind, type MarkerReason, type MarkerView } from '@mycel/shared/api'

// the count rules live in shared/src/api/attention.ts: the server counts a phone push's badge with the same code
export { attentionCount, markerOf, needsMe }
export type { MarkedChat, Marker, MarkerKind, MarkerReason, MarkerView }

/** What the app icon shows (the desktop app's Dock, an installed web app's icon): n; at 0 a plain dot while some room
 * has unread messages n does not count, as Slack and Discord do; else nothing (0 clears it). */
export type IconBadge = number | 'dot'
export const iconBadge = (a: { n: number; unread: boolean }): IconBadge => (a.n > 0 ? a.n : a.unread ? 'dot' : 0)

/** ⌘K's "Needs attention" (components/SearchDialog.tsx): the chats whose row shows a marker, each with it, by the same
 * rule and view as the history's rows (`here`: the chat on screen in a visible window; `cards`: the chats with a card
 * open in this window). Your turn ("?") first, then a new answer, then the ring; the latest activity first in each. */
export function markedChats<C extends MarkedChat & Pick<Chat, 'id' | 'updatedAt'>>(chats: readonly C[], o: { here?: string | null; cards?: ReadonlySet<string> } = {}): { chat: C; marker: Marker }[] {
  const rank: Record<MarkerKind, number> = { ask: 0, new: 1, running: 2 }
  return chats
    .flatMap((chat) => {
      const marker = markerOf(chat, { here: chat.id === o.here, card: o.cards?.has(chat.id) })
      return marker ? [{ chat, marker }] : []
    })
    .sort((a, b) => rank[a.marker.kind] - rank[b.marker.kind] || b.chat.updatedAt.localeCompare(a.chat.updatedAt))
}

/** The 트리나 기록 filter "답변 중이거나 내 답을 기다림": spinner and "?" rows (failed and paused included), not new ones. */
export const waitingOrRunning = (c: MarkedChat, v: MarkerView = {}) => {
  const m = markerOf(c, v)
  return m?.kind === 'ask' || m?.kind === 'running'
}

/** How long a notification or a toast waits for the chat to be seen (or its card answered) before it shows. */
export const NOTIFY_DELAY_MS = 3000

/** After the wait: tell the person only if what was worth telling still holds (an answer is still unseen: no window
 * had the chat on screen meanwhile; a card is still open) and the chat is not on screen here. */
export function stillWorthTelling(c: (MarkedChat & Pick<Chat, 'id'>) | undefined, o: { notify: 'card' | 'answer'; here: boolean; card?: boolean }): boolean {
  if (!c || o.here) return false
  return o.notify === 'card' ? !!(c.waiting || o.card) : !!c.unseen
}
