// The "···" of an AI chat's row: the Trina list (the 트리나 panel, the phone's 트리나 tab) and a project page's chat list show the same
// items by the same rules. 상단에 고정 / 고정 해제 for anyone who sees the chat, 링크 복사, 이름 바꾸기 for its creator,
// 프로젝트에 추가 / 프로젝트 변경 where a chat may move (never a shared one), "Share with project members…" for my private
// chat in a team project (as the title menu has it; components/chat/ShareChat.tsx mayShareChat, never gated by a project
// setting: docs/DECISIONS.md "Team project chats shared by default"), 삭제 for its creator or an editor of its project
// (lib/sharedChat.ts sharedRights: the server's own rules).
import { FolderInput, Pencil, Pin, PinOff, Trash2, Users } from 'lucide-react'
import type { RefObject } from 'react'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { sharedRights } from '../../lib/sharedChat'
import { useProjects } from '../../store/projects'
import { useMeStrict } from '../../store/session'
import { mayShareChat, openShareChat } from './ShareChat'
import type { MenuItem } from '../rooms/MenuButton'
import { useChatActions } from './chatActions'
import { useChatLinkItem } from './copyChatLink'

export interface ChatMenuOptions {
  /** the items' test ids: `<testId>-pin`, `-copy-link`, `-rename`, `-move`, `-delete` */
  testId: string
  /** the row's "···": the keyboard goes back there when a dialog an item opens closes */
  more: RefObject<HTMLButtonElement | null>
  /** how an item runs (the project page puts the keyboard back on "···" first) */
  select?: (fn: () => unknown) => () => void
  /** 프로젝트에 추가 / 변경: the move dialog; no item without it */
  onMove?: (c: Chat) => void
  /** the chat as it is after a rename or a pin (lists that keep their own copy of it) */
  onChanged?: (c: Chat) => void
  /** the chat went to the trash: told at once after the confirm (refused, it comes back through `onChanged`) */
  onRemoved?: (c: Chat) => void
  /** more items after 이름 바꾸기 (폴더로 옮기기 / 폴더에서 빼기, nav/NavFolders.tsx) */
  extra?: MenuItem[]
}

export function useChatMenuItems(chat: Chat, { testId, more, select = (fn) => () => void fn(), onMove, onChanged, onRemoved, extra = [] }: ChatMenuOptions): MenuItem[] {
  const t = useT()
  const actions = useChatActions()
  // a shared chat: rename for its creator, delete for its creator or a project editor, never a move; a pin for anyone
  const me = useMeStrict()
  const rights = sharedRights(chat, me.user.id)
  // my private chat in a team project (the project as this window knows it)
  const project = useProjects((s) => (chat.projectId ? s.byId[chat.projectId] : undefined))
  // (a chat that is not shared is always mine: nobody else lists another person's private chat)
  const share = mayShareChat(chat, project, !!me.server?.allChatsConfidential)
  const linkItem = useChatLinkItem(chat, `${testId}-copy-link`, select)
  return [
    chat.pinnedAt
      ? { label: t('chat.unpin'), icon: <PinOff size={14} aria-hidden />, onSelect: select(() => actions.togglePin(chat, onChanged)), testId: `${testId}-unpin` }
      : { label: t('chat.pin'), icon: <Pin size={14} aria-hidden />, onSelect: select(() => actions.togglePin(chat, onChanged)), testId: `${testId}-pin` },
    linkItem,
    ...(rights.creator ? [{ label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: select(() => actions.rename(chat, onChanged)), testId: `${testId}-rename` }] : []),
    ...extra,
    // the item goes with the menu: the dialog gives the keyboard back to "···" when it closes
    ...(rights.canMove && onMove ? [{ label: t(chat.projectId ? 'chat.project.change' : 'chat.project.add'), icon: <FolderInput size={14} aria-hidden />, onSelect: () => (more.current?.focus(), onMove(chat)), testId: `${testId}-move` }] : []),
    ...(share ? [{ label: t('chat.shareChat.menu'), icon: <Users size={14} aria-hidden />, onSelect: select(() => openShareChat(chat.id)), testId: `${testId}-share` }] : []),
    ...(rights.canDelete ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: select(() => actions.remove(chat, (c, trashed) => (trashed ? onRemoved?.(c) : onChanged?.(c)))), testId: `${testId}-delete` }] : []),
  ]
}
