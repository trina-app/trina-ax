// "링크 복사" for an AI chat (docs/AGENTS/plan: chat-copy-link): the chat's own address on this team's origin, like a room's
// (components/rooms/RoomMenu.tsx roomLink), copied alone as text. The toast says who can open it: a shared project chat is
// open to the project's people now (Chat.shared.audience), any other chat to its person only. Copy only: it changes
// nothing about who sees a chat, and a person who cannot see it gets the "not found" page like for any chat address.
import { Link2 } from 'lucide-react'
import { createElement } from 'react'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { toast } from '../../store/ui'
import { useCopy } from '../ui'
import type { MenuItem } from '../rooms/MenuButton'

/** The address of a chat as people open it: the app's own route `/c/<id>` (App.tsx). */
export const chatLink = (chatId: string, origin = typeof location === 'undefined' ? '' : location.origin) => `${origin}/c/${chatId}`

/** What the "⋯" menus need of a chat. */
export type LinkChat = Pick<Chat, 'id'> & Partial<Pick<Chat, 'shared'>>

/** Copies a chat's address and says who can open it. */
export function useCopyChatLink() {
  const t = useT()
  const { copy } = useCopy()
  return async (chat: LinkChat) => {
    await copy(chatLink(chat.id))
    toast({ level: 'success', text: chat.shared ? t('chat.linkCopiedShared', { n: chat.shared.audience }) : t('chat.linkCopiedPrivate') })
  }
}

/** The menu item of the history rows' "⋯" (the header's menu has its own list type). */
export function useChatLinkItem(chat: LinkChat, testId: string, select: (fn: () => unknown) => () => void = (fn) => () => void fn()): MenuItem {
  const t = useT()
  const copyLink = useCopyChatLink()
  return { label: t('rooms.menu.copyLink'), icon: createElement(Link2, { size: 14, 'aria-hidden': true }), onSelect: select(() => copyLink(chat)), testId }
}
