// Continue a chat in a new one, from its title's "···" and from its row's "···" (docs/decisions/20261126-chat-fork-tree.md):
// my own chat says "새 채팅에서 이어 하기" / "Continue in a new chat"; a shared one "나만 보는 새 채팅에서 이어 하기" / "Continue
// in a new chat only you see" (the copy is only mine; the AI quotes it to people: server chat/prompt.ts privatelyMenu,
// policy/refusal.ts). Never "fork" in words people read. A chat made this way that sits under another in my history also
// has "목록에서 따로 두기" / "Move out on its own". Shown only where the server forks the chat: never a
// room's side chat, a scheduled run, a confidential chat or while safe operations are on, a chat in the trash, nor for a
// guest outside their one project or without AI (POST /api/chats/:id/fork refuses those). A first answer still running
// with nothing finished before it: the server's words say so.
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { isGuestMe, meGuest } from '../../lib/guests'
import { useMe } from '../../store/session'
import { useGuestAiOff } from '../GuestView'
import { menuItem, type EntityItem } from '../menus/entityMenu'

type ForkChat = Pick<Chat, 'projectId'> & Partial<Pick<Chat, 'id' | 'shared' | 'confidential' | 'deletedAt' | 'sideRoomId' | 'schedule' | 'forkParents'>>

/** 'fork': my own chat ("Fork"); 'private': a shared chat ("Continue in a chat only you see"); null: no fork here */
export function useForkKind(chat: ForkChat): 'fork' | 'private' | null {
  const me = useMe()
  const guestAiOff = useGuestAiOff()
  if (!me || !chat.id || chat.deletedAt || chat.sideRoomId || chat.schedule || chat.confidential || me.server.allChatsConfidential) return null
  if (isGuestMe(me) && (guestAiOff || !chat.projectId || meGuest(me)?.project?.id !== chat.projectId)) return null
  return chat.shared ? 'private' : 'fork'
}

/** The menu items: Fork (or Continue in a chat only you see), and Detach to top level for a fork under a chat, as the
 * one list's kinds (components/menus/entityMenu.tsx: fork, continuePrivately, forkDetach), so each menu orders them alike. */
export function useForkItems(chat: ForkChat, o: { testId: string; onFork?: () => void; onDetach?: () => void }): EntityItem[] {
  const t = useT()
  const kind = useForkKind(chat)
  const items: EntityItem[] = []
  if (kind && o.onFork) items.push(kind === 'private'
    ? menuItem(t, 'continuePrivately', { onSelect: o.onFork, testId: `${o.testId}-continue-privately` })
    : menuItem(t, 'fork', { onSelect: o.onFork, testId: `${o.testId}-fork` }))
  if (o.onDetach && chat.forkParents?.length && !chat.deletedAt) items.push(menuItem(t, 'forkDetach', { onSelect: o.onDetach, testId: `${o.testId}-fork-detach` }))
  return items
}
