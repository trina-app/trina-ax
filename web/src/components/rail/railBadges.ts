// The marks on the rail's places (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1 "Badges"): one count per kind, nothing
// that needs me hidden without a mark, nothing counted twice.
// - 트리나: a dot from the session markers' AI part (store/sessionMarkers.ts useAttention): an amber "?" while an AI chat
//   waits on me, else an accent dot while one has an answer I have not seen. No number: the window title and the Dock
//   carry the number.
// - 대화: how many conversations have something unread (muted and hidden ones left out, as the phone's 대화 tab leaves
//   them out), not how many messages; an amber "?" while a room's AI waits on me. A mention or a followed thread's reply
//   is inside its room's count already; when only Activity's conversation rows are unread (a room read since, a notice
//   left), a dot, so 멘션·스레드 never loses its mark when 활동 stops counting it.
// - 활동: the unread notices that are not conversation rows (store/inbox.ts useNoticeUnread), the same number as the
//   phone's 나 tab.
// - 파일: none.
import { roomUnread, type Room } from '@mycel/shared/api'

export type RailMark = { kind: 'ask' } | { kind: 'dot' } | { kind: 'count'; n: number } | null

type CountedRoom = Pick<Room, 'unreadCount' | 'muted'> & Partial<Pick<Room, 'threadsUnread' | 'hidden'>>

/** 트리나's mark: `chats` = AI chats that need me, `chatAsk` = one of them is a "?" (attentionCount) */
export function aiMark(a: { chats: number; chatAsk: boolean }): RailMark {
  if (a.chats <= 0) return null
  return a.chatAsk ? { kind: 'ask' } : { kind: 'dot' }
}

/** how many of my conversations have something unread (muted and hidden ones not counted) */
export function unreadRooms(rooms: readonly CountedRoom[]): number {
  return rooms.filter((r) => !r.muted && !r.hidden && roomUnread(r) > 0).length
}

/** 대화's mark: the count of unread conversations, else a dot for unread mention/thread notices (`roomNotices`) */
export function chatsMark(rooms: readonly CountedRoom[], roomNotices: number): RailMark {
  const n = unreadRooms(rooms)
  if (n > 0) return { kind: 'count', n }
  return roomNotices > 0 ? { kind: 'dot' } : null
}

/** 활동's mark: the unread notices that are not conversation rows */
export function activityMark(notices: number): RailMark {
  return notices > 0 ? { kind: 'count', n: notices } : null
}
