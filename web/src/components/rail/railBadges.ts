// The marks on the rail's places (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1 "Badges"): one count per kind, nothing
// that needs me hidden without a mark, nothing counted twice.
// - 트리나: a dot from the session markers' AI part (store/sessionMarkers.ts useAttention): an amber "?" while an AI chat
//   waits on me, else an accent dot while one has an answer I have not seen. No number: the window title and the Dock
//   carry the number.
// - 대화: how many conversations count (shared roomCounts: muted and hidden ones left out, and a room at 멘션만 only
//   once a message mentions me, in a thread too; plain messages there only make its row bold), not how many messages.
//   A followed thread's reply without a mention counts nowhere here (docs/decisions/20261119-room-unread-after-read.md):
//   it is a 멘션·스레드 row. When only Activity's conversation rows are unread (a followed reply, a room read since, a
//   notice left), a dot, so 멘션·스레드 never loses its mark when 활동 stops counting it.
// - 활동: the unread notices that are not conversation rows (store/inbox.ts useNoticeUnread), the same number as the
//   phone's 나 tab.
// - 프로젝트: how many projects have something for me, as 대화 counts conversations (not messages): an unread thread
//   mention of me in one of its chats (store/chatMentions.ts byProject: the number on the project's row in the 프로젝트
//   list), or a chat of it with unread messages for me that I did not mute (Chat.unreadCount, summed by the chat's
//   project). The project's own room is 대화's (it opens there): its row keeps its own dot.
// - 파일: none.
import { roomCounts, type Chat, type CountedRoomFields, type Room } from '@mycel/shared/api'

export type RailMark = { kind: 'ask' } | { kind: 'dot' } | { kind: 'count'; n: number } | null

type CountedRoom = CountedRoomFields & Partial<Pick<Room, 'hidden'>>

/** 트리나's mark: `chats` = AI chats that need me, `chatAsk` = one of them is a "?" (attentionCount) */
export function aiMark(a: { chats: number; chatAsk: boolean }): RailMark {
  if (a.chats <= 0) return null
  return a.chatAsk ? { kind: 'ask' } : { kind: 'dot' }
}

/** how many of my conversations count (roomCounts; hidden ones not counted) */
export function unreadRooms(rooms: readonly CountedRoom[]): number {
  return rooms.filter((r) => !r.hidden && roomCounts(r).counts).length
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

/** the chat fields 프로젝트's mark reads (a chat shared with people: its unread messages, its mute) */
export type ProjectCountedChat = Pick<Chat, 'id' | 'projectId'> & Partial<Pick<Chat, 'unreadCount' | 'muted' | 'deletedAt'>>

/** The projects with something for me: `mentioned`, the projects with an unread thread mention of me (the list's
 * counts, store/chatMentions.ts byProject); `chats`, my chats (one counts while it has unread messages I did not mute). */
export function unreadProjects(mentioned: Iterable<string>, chats: readonly ProjectCountedChat[]): Set<string> {
  const out = new Set(mentioned)
  for (const c of chats) if (c.projectId && c.unreadCount && !c.muted && !c.deletedAt) out.add(c.projectId)
  return out
}

/** 프로젝트's mark: how many projects have something for me (unreadProjects) */
export function projectsMark(mentioned: Iterable<string>, chats: readonly ProjectCountedChat[]): RailMark {
  const n = unreadProjects(mentioned, chats).size
  return n > 0 ? { kind: 'count', n } : null
}
