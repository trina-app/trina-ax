// "링크 복사" for an AI chat (docs/AGENTS/plan: chat-copy-link): the chat's own address on this team's origin, like a room's
// (components/rooms/RoomMenu.tsx roomLink), copied alone as text. The toast says who can open it: a shared project chat is
// open to the project's people now (Chat.shared.audience), any other chat to its person only. A private chat in a team
// project says it plainly ("Only you can open this chat. People you send the link to can't.") with "Share with members"
// (the share flow, components/chat/ShareChat.tsx), since a teammate's link that opens nothing was the confusion (QA
// TC-919, TC-949). Copy only: it changes nothing about who sees a chat, and a person who cannot see it gets the "not
// found" page like for any chat address.
import { Link2 } from 'lucide-react'
import { createElement } from 'react'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useProjects } from '../../store/projects'
import { useSession } from '../../store/session'
import { toast } from '../../store/ui'
import { mayShareChat, openShareChat } from './ShareChat'
import { useCopyLink, useTeamOrigin } from '../ShareCopyLink'
import { localLinkToast } from '../LocalLinkNote'
import type { MenuItem } from '../rooms/MenuButton'

/** The address of a chat as people open it: the app's own route `/c/<id>` (App.tsx), on `origin` (the team origin:
 * components/ShareCopyLink.tsx useTeamOrigin, as a message's Copy link). */
export const chatLink = (chatId: string, origin = typeof location === 'undefined' ? '' : location.origin) => `${origin}/c/${chatId}`

/** What the "⋯" menus need of a chat. */
export type LinkChat = Pick<Chat, 'id'> & Partial<Pick<Chat, 'shared' | 'projectId' | 'confidential' | 'deletedAt' | 'sideRoomId'>>

/** Copies a chat's address (on the team address) and says who can open it; nothing is said copied when the browser
 * refused it. `inDialog`: from the Share dialog itself, so the private-chat toast offers no second share flow over it,
 * and an address on this computer only says so in the toast (components/LocalLinkNote.tsx localLinkToast). */
export function useCopyChatLink() {
  const t = useT()
  const origin = useTeamOrigin()
  const copy = useCopyLink()
  return async (chat: LinkChat, o: { inDialog?: boolean } = {}) => {
    const href = chatLink(chat.id, origin)
    if (!(await copy(href))) return
    const local = o.inDialog ? localLinkToast(t, href) : {}
    // (a chat shared with a group, to anyone but its creator and admins: how many is not told)
    if (chat.shared) return void toast({ level: 'success', text: chat.shared.audienceHidden ? t('chat.share.linkCopied') : t('chat.linkCopiedShared', { n: chat.shared.audience }), ...local })
    // a private chat in a team project (the project as this window knows it)
    const project = chat.projectId ? useProjects.getState().byId[chat.projectId] : undefined
    const st = useSession.getState().status
    const safeOps = st.kind === 'signed-in' && !!st.me.server?.allChatsConfidential
    if (project && mayShareChat(chat, project, safeOps))
      return void toast({ level: 'info', text: t('chat.linkCopiedOnlyMe'), ms: 8000, ...local, ...(o.inDialog ? {} : { action: { label: t('chat.linkShareAction'), run: () => openShareChat(chat.id) } }) })
    toast({ level: 'success', text: t('chat.linkCopiedPrivate'), ...local })
  }
}

/** The menu item of the history rows' "⋯" (the header's menu has its own list type). */
export function useChatLinkItem(chat: LinkChat, testId: string, select: (fn: () => unknown) => () => void = (fn) => () => void fn()): MenuItem {
  const t = useT()
  const copyLink = useCopyChatLink()
  return { label: t('rooms.menu.copyLink'), icon: createElement(Link2, { size: 14, 'aria-hidden': true }), onSelect: select(() => copyLink(chat)), testId }
}
