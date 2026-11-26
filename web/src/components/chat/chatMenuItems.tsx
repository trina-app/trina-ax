// The "···" of an AI chat's row: the Trina list (the 트리나 panel, the phone's 트리나 tab) and a project page's chat list show the same
// items by the same rules, in the one list's order (components/menus/entityMenu.tsx; docs/decisions/20261126-shared-menus.md):
// 상단에 고정 / 고정 해제 for anyone who sees the chat, its sections, 알림 끄기 / 켜기 for a shared chat, 링크 복사,
// 이름 바꾸기 for its creator, 프로젝트에 추가 / 프로젝트 변경 where a chat may move (never a shared one), "Share" where
// sharing is possible (lib/sharedChat.ts shareKindOf: a chat outside projects that is mine, my private chat in a team
// project, my chat in a personal project, which explains and offers Move; never a shared project chat: docs/DECISIONS.md
// "Chats shared with people and groups"), "Hide from my list" for a chat someone shared with me (opening it brings it
// back), "Leave this chat" (out of it until its creator adds me again), 삭제 for its creator or an editor of its project
// (lib/sharedChat.ts sharedRights: the server's own rules). 포크 / "나만 보는 채팅에서 이어 하기" and, for a fork under a
// chat, 최상위로 꺼내기 (components/chat/forkItems.tsx) sit with people and tools.
import type { RefObject } from 'react'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { mayHideChat, mayLeaveChat, sharedRights, shareKindOf } from '../../lib/sharedChat'
import { useProjects } from '../../store/projects'
import { useMeStrict } from '../../store/session'
import { startShare } from './ChatShareDialog'
import { menuItem, orderMenu, type EntityItem } from '../menus/entityMenu'
import { useChatActions } from './chatActions'
import { useCopyChatLink } from './copyChatLink'
import { moveLabel } from './ChatProject'
import { useForkItems } from './forkItems'

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
  /** Move to section / Remove from section (nav/SidebarSections.tsx useSectionRowItems), in the list's place for them */
  extra?: EntityItem[]
}

export function useChatMenuItems(chat: Chat, { testId, more, select = (fn) => () => void fn(), onMove, onChanged, onRemoved, extra = [] }: ChatMenuOptions): EntityItem[] {
  const t = useT()
  const actions = useChatActions()
  // a shared chat: rename for its creator, delete for its creator or a project editor, never a move; a pin for anyone
  const me = useMeStrict()
  const rights = sharedRights(chat, me.user.id)
  // my private chat in a team project (the project as this window knows it)
  const project = useProjects((s) => (chat.projectId ? s.byId[chat.projectId] : undefined))
  // (a chat that is not shared is always mine: nobody else lists another person's private chat)
  const share = shareKindOf(chat, project, me.user.id, !!me.server?.allChatsConfidential)
  const copyLink = useCopyChatLink()
  const pin = () => actions.togglePin(chat, onChanged)
  const mute = () => actions.toggleMute(chat, onChanged)
  // Fork (my own chat) or "Continue in a chat only you see" (a shared one), and Detach to top level for a fork under a
  // chat in my history (components/chat/forkItems.tsx; docs/decisions/20261126-chat-fork-tree.md)
  const forkItems = useForkItems(chat, { testId, onFork: select(() => actions.fork(chat)), ...(rights.creator ? { onDetach: select(() => actions.detachFork(chat, onChanged)) } : {}) })
  // the one list's order (components/menus/entityMenu.tsx): pin, section, mute, link, rename, move, share, fork, hide, leave, delete
  return orderMenu([
    menuItem(t, chat.pinnedAt ? 'unpin' : 'pin', { onSelect: select(pin), testId: `${testId}-${chat.pinnedAt ? 'unpin' : 'pin'}` }),
    ...forkItems,
    ...extra,
    // a chat shared with people is a conversation: its new messages tell me unless I mute it (chat/message-notices.ts). A
    // project's shared chat tells nothing but a mention (docs/decisions/20261126-project-chat-mention-only.md): no Mute
    ...(chat.shared && !chat.projectId && !chat.deletedAt ? [menuItem(t, chat.muted ? 'unmute' : 'mute', { onSelect: select(mute), testId: `${testId}-${chat.muted ? 'unmute' : 'mute'}` })] : []),
    menuItem(t, 'copyLink', { onSelect: select(() => copyLink(chat)), testId: `${testId}-copy-link` }),
    ...(rights.creator ? [menuItem(t, 'rename', { onSelect: select(() => actions.rename(chat, onChanged)), testId: `${testId}-rename` })] : []),
    // the item goes with the menu: the dialog gives the keyboard back to "···" when it closes
    ...(rights.canMove && onMove ? [menuItem(t, 'move', { label: t(moveLabel(chat)), onSelect: () => (more.current?.focus(), onMove(chat)), testId: `${testId}-move` })] : []),
    ...(share ? [menuItem(t, 'share', { onSelect: select(() => startShare(chat, share)), testId: `${testId}-share` })] : []),
    ...(mayHideChat(chat, me.user.id) ? [menuItem(t, 'hide', { onSelect: select(() => actions.hide(chat, onRemoved)), testId: `${testId}-hide` })] : []),
    // "Leave this chat": out of it for good, until its creator adds me again (QA TC-7651)
    ...(mayLeaveChat(chat, me.user.id) ? [menuItem(t, 'leave', { label: t('chat.leave'), onSelect: select(() => actions.leave(chat, onRemoved)), testId: `${testId}-leave` })] : []),
    ...(rights.canDelete ? [menuItem(t, 'delete', { onSelect: select(() => actions.remove(chat, (c, trashed) => (trashed ? onRemoved?.(c) : onChanged?.(c)))), testId: `${testId}-delete` })] : []),
  ])
}
