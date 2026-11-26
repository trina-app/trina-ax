// The chat's title in the chat header, as a menu (main's TitleMenu): "상단에 고정" / "고정 해제" first, the row menu's own
// item, icon and call (components/chat/chatMenuItems.tsx; docs/DECISIONS.md "Pinned chats": anyone who sees the chat),
// then Rename, "Move to project" ("Change project"
// whenever the chat is in a project, also one the person can no longer see), Delete. The move item is here so that it works on a phone too, where the header has no room for
// more buttons. "링크 복사" (the chat's address, for whoever may open it) is first, and is there for every chat that
// has been made, so the title is a menu even when the person may change nothing.
// A shared project chat (docs/DECISIONS.md "Shared project chats") offers only what the person may do: rename for its
// creator, delete for its creator or a project editor, never a move (it stays in its project) and never a share (it is
// shared). With nothing to offer the title is a plain heading. A shared chat also offers "Continue in a chat only you
// see" (docs/DECISIONS.md "Team project chats shared by default"): a new "Only me" chat in the same project with my
// last question in its box, where my memories and apps work (the AI points here when asked for one in a shared chat).
// No "Share" here any more: it is the button at the top right of the chat's header (docs/DECISIONS.md "Share in the title
// row"; pages/Chat.tsx, components/HeaderShare.tsx), one place for it. A chat someone shared with me offers "Hide from my list" (its creator never hides it) and "Leave this chat", and "Continue in a chat
// only you see" opens Home's box there (no project) with my last question.
// "Open in the app" (QA TC-2266; lib/team-link.ts pageOpenInAppHref) opens this chat in the desktop app, in a computer's
// web browser on macOS or Windows only (not at phone width, not inside the apps); a room's and a project's menus have it too.
// The items and their order are the one list's (components/menus/entityMenu.tsx; docs/decisions/20261126-shared-menus.md).
import { PRODUCT } from '@mycel/shared'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useMe } from '../../store/session'
import { mayHideChat, mayLeaveChat } from '../../lib/sharedChat'
import { clientKind } from '../../lib/desktop'
import { platform } from '../../lib/pwa'
import { pageOpenInAppHref } from '../../lib/team-link'
import { useMediaQuery } from '../ui'
import { TitleMenu } from '../TitleMenu'
import { menuItem, orderMenu } from '../menus/entityMenu'
import { useCopyChatLink } from './copyChatLink'
import { moveLabel } from './ChatProject'

type MenuChat = Pick<Chat, 'projectId'> & Partial<Pick<Chat, 'id' | 'title' | 'shared' | 'confidential' | 'deletedAt' | 'pinnedAt' | 'sideRoomId' | 'schedule' | 'muted'>>

export function ChatTitleMenu({ chat, title, compact, onPin, onMute, onRename, onMove, onDelete, onPrivately, onHide, onLeave }: { chat: MenuChat; title: string; compact?: boolean; onPin?: () => void; onMute?: () => void; onRename?: () => void; onMove?: () => void; onDelete?: () => void; onPrivately?: () => void; onHide?: () => void; onLeave?: () => void }) {
  const t = useT()
  const me = useMe()
  const safeOps = !!me?.server.allChatsConfidential
  const copyLink = useCopyChatLink()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const appHref = chat.id && !chat.deletedAt ? pageOpenInAppHref({ scheme: PRODUCT.linkScheme, origin: typeof location === 'undefined' ? '' : location.origin, path: `/c/${chat.id}`, platform: platform(), client: clientKind(), phone }) : null
  // the one list's order (components/menus/entityMenu.tsx), as the row's "···"
  const items = orderMenu([
    ...(chat.id && onPin ? [menuItem(t, chat.pinnedAt ? 'unpin' : 'pin', { onSelect: onPin, testId: chat.pinnedAt ? 'chat-unpin' : 'chat-pin' })] : []),
    // a chat shared with people is a conversation: "Mute this chat" / "Unmute this chat", as the row's "···"
    // (chat/message-notices.ts); a project's shared chat tells nothing but a mention, so it has no Mute (docs/decisions/
    // 20261126-project-chat-mention-only.md)
    ...(chat.id && chat.shared && !chat.projectId && !chat.deletedAt && onMute ? [menuItem(t, chat.muted ? 'unmute' : 'mute', { onSelect: onMute, testId: chat.muted ? 'chat-unmute' : 'chat-mute' })] : []),
    ...(chat.id ? [menuItem(t, 'copyLink', { onSelect: () => void copyLink({ id: chat.id!, shared: chat.shared, projectId: chat.projectId, confidential: chat.confidential, deletedAt: chat.deletedAt, sideRoomId: chat.sideRoomId }), testId: 'chat-copy-link' })] : []),
    ...(appHref ? [menuItem(t, 'openInApp', { onSelect: () => { location.href = appHref }, testId: 'chat-open-in-app' })] : []),
    ...(onRename ? [menuItem(t, 'rename', { onSelect: onRename, testId: 'chat-rename' })] : []),
    ...(onMove ? [menuItem(t, 'move', { label: t(moveLabel(chat)), onSelect: onMove, testId: 'chat-project-move' })] : []),
    ...(chat.id && chat.shared && !safeOps && onPrivately ? [menuItem(t, 'continuePrivately', { onSelect: onPrivately, testId: 'chat-continue-privately' })] : []),
    ...(onHide && me && mayHideChat(chat, me.user.id) ? [menuItem(t, 'hide', { onSelect: onHide, testId: 'chat-hide' })] : []),
    ...(onLeave && me && mayLeaveChat(chat, me.user.id) ? [menuItem(t, 'leave', { label: t('chat.leave'), onSelect: onLeave, testId: 'chat-leave' })] : []),
    ...(onDelete ? [menuItem(t, 'delete', { onSelect: onDelete, testId: 'chat-delete' })] : []),
  ])
  if (!items.length)
    return (
      <h1 className="min-w-0 truncate px-1.5 font-medium text-ink" title={title} data-testid="chat-title">
        {title}
      </h1>
    )
  return <TitleMenu name={title} heading="chat-title" testId="chat-menu" items={items} compact={compact} />
}
