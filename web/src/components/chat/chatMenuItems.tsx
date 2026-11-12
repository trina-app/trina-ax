// The "···" of an AI chat's row: the sidebar's history (the phone's drawer) and a project page's chat list show the same
// items by the same rules. 상단에 고정 / 고정 해제 for anyone who sees the chat, 링크 복사, 이름 바꾸기 for its creator,
// 프로젝트에 추가 / 프로젝트 변경 where a chat may move (never a shared one), 삭제 for its creator or an editor of its
// project (lib/sharedChat.ts sharedRights: the server's own rules).
import { FolderInput, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import type { RefObject } from 'react'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { sharedRights } from '../../lib/sharedChat'
import { useMeStrict } from '../../store/session'
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
  /** the chat went to the trash */
  onRemoved?: (c: Chat) => void
}

export function useChatMenuItems(chat: Chat, { testId, more, select = (fn) => () => void fn(), onMove, onChanged, onRemoved }: ChatMenuOptions): MenuItem[] {
  const t = useT()
  const actions = useChatActions()
  // a shared chat: rename for its creator, delete for its creator or a project editor, never a move; a pin for anyone
  const rights = sharedRights(chat, useMeStrict().user.id)
  const linkItem = useChatLinkItem(chat, `${testId}-copy-link`, select)
  const changed = (c: Chat | null) => c && onChanged?.(c)
  return [
    chat.pinnedAt
      ? { label: t('chat.unpin'), icon: <PinOff size={14} aria-hidden />, onSelect: select(() => actions.togglePin(chat).then(changed)), testId: `${testId}-unpin` }
      : { label: t('chat.pin'), icon: <Pin size={14} aria-hidden />, onSelect: select(() => actions.togglePin(chat).then(changed)), testId: `${testId}-pin` },
    linkItem,
    ...(rights.creator ? [{ label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: select(() => actions.rename(chat).then(changed)), testId: `${testId}-rename` }] : []),
    // the item goes with the menu: the dialog gives the keyboard back to "···" when it closes
    ...(rights.canMove && onMove ? [{ label: t(chat.projectId ? 'chat.project.change' : 'chat.project.add'), icon: <FolderInput size={14} aria-hidden />, onSelect: () => (more.current?.focus(), onMove(chat)), testId: `${testId}-move` }] : []),
    ...(rights.canDelete ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: select(() => actions.remove(chat).then((ok) => ok && onRemoved?.(chat))), testId: `${testId}-delete` }] : []),
  ]
}
