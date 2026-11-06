// Session markers (docs/DECISIONS.md "Session markers"): one marker per AI chat row, from the chat list's own fields
// (phone-nav's Chat.waiting / Chat.unseen, Chat.lastOutcome, runState) and the cards open in this window, and the one
// count n that bubbles up (the tab title, the dock badge). Pure: no React, no stores; unit-tested in
// test/unit/session-markers.test.tsx.
//   "?"      your turn: an open card (it stays until the card closes, on screen too), or a failed / paused answer not
//            seen yet
//   spinner  running or queued
//   dot      a new answer not seen yet
// Priority ? > spinner > dot. While a chat runs again, its earlier answer is behind the new one: a card's "?" or the
// spinner. The chat on screen in a visible window shows no dot and no failed "?" (the window sends /seen, and the
// server's word follows a moment later).
import type { Chat } from '@mycel/shared/api'
import { roomWantsMe } from './rooms'

export type MarkerKind = 'ask' | 'running' | 'new'
/** why: the first line of the hover peek and the row's label */
export type MarkerReason = 'card' | 'error' | 'paused' | 'running' | 'queued' | 'new'
export interface Marker { kind: MarkerKind; reason: MarkerReason }

export type MarkedChat = Pick<Chat, 'runState' | 'waiting' | 'unseen' | 'lastOutcome'>
/** How this window sees a chat: `here`, it is on screen and the window is visible; `card`, a card of it is open in this
 * window (a card one desktop window shows alone is in no list). */
export interface MarkerView { here?: boolean; card?: boolean }

/** The chat's one marker (null: nothing). */
export function markerOf(c: MarkedChat, v: MarkerView = {}): Marker | null {
  if (c.waiting || v.card) return { kind: 'ask', reason: 'card' }
  if (c.runState === 'running') return { kind: 'running', reason: 'running' }
  if (c.runState === 'queued') return { kind: 'running', reason: 'queued' }
  if (!c.unseen || v.here) return null
  if (c.lastOutcome) return { kind: 'ask', reason: c.lastOutcome }
  return { kind: 'new', reason: 'new' }
}

/** A chat that needs me: its row shows "?" or a dot (the spinner does not: it works on its own). */
export const needsMe = (m: Marker | null) => m?.kind === 'ask' || m?.kind === 'new'

type CountedChat = MarkedChat & Pick<Chat, 'id'>
type CountedRoom = Parameters<typeof roomWantsMe>[0]
/** The one count n: the AI chats showing "?" or a dot, and the rooms that want me (lib/rooms.ts roomWantsMe: the room's
 * AI waiting on me, or unread messages for me by my level for the room: by default a DM or group chat message, an
 * @mention, a reply in a thread I follow), each once. Chats and rooms, not events: a chat that ended twice counts once.
 * `ask`: any of them is a "?"; `chats` and `chatAsk`: the AI chats' part of it (the phone's ☰ dot: the drawer holds
 * only them). `here`: the chat on screen in a visible window; `cards`: the chats with a card open in this window;
 * `threadReplies`: my "replies in threads I follow" switch (the rooms list's alerts). */
export function attentionCount(chats: readonly CountedChat[], rooms: readonly CountedRoom[], o: { here?: string | null; cards?: ReadonlySet<string>; threadReplies?: boolean } = {}): { n: number; ask: boolean; chats: number; chatAsk: boolean } {
  let chatsN = 0, chatAsk = false
  for (const c of chats) {
    const m = markerOf(c, { here: c.id === o.here, card: o.cards?.has(c.id) })
    if (!needsMe(m)) continue
    chatsN++
    if (m!.kind === 'ask') chatAsk = true
  }
  let n = chatsN, ask = chatAsk
  for (const r of rooms) if (roomWantsMe(r, o.threadReplies ?? true)) { n++; if (r.aiWaits) ask = true }
  return { n, ask, chats: chatsN, chatAsk }
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
