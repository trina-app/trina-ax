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
// "Open in the app" (QA TC-2266; lib/team-link.ts chatOpenInAppHref) opens this chat in the desktop app, in a computer's
// web browser on macOS or Windows only (not at phone width, not inside the apps).
import { Bell, BellOff, EyeOff, FolderInput, Link2, Lock, LogOut, Monitor, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { PRODUCT } from '@mycel/shared'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useMe } from '../../store/session'
import { mayHideChat, mayLeaveChat } from '../../lib/sharedChat'
import { clientKind } from '../../lib/desktop'
import { platform } from '../../lib/pwa'
import { chatOpenInAppHref } from '../../lib/team-link'
import { useMediaQuery } from '../ui'
import { TitleMenu, type TitleMenuItem } from '../TitleMenu'
import { useCopyChatLink } from './copyChatLink'
import { moveLabel } from './ChatProject'

type MenuChat = Pick<Chat, 'projectId'> & Partial<Pick<Chat, 'id' | 'title' | 'shared' | 'confidential' | 'deletedAt' | 'pinnedAt' | 'sideRoomId' | 'schedule' | 'muted'>>

export function ChatTitleMenu({ chat, title, compact, onPin, onMute, onRename, onMove, onDelete, onPrivately, onHide, onLeave }: { chat: MenuChat; title: string; compact?: boolean; onPin?: () => void; onMute?: () => void; onRename?: () => void; onMove?: () => void; onDelete?: () => void; onPrivately?: () => void; onHide?: () => void; onLeave?: () => void }) {
  const t = useT()
  const me = useMe()
  const safeOps = !!me?.server.allChatsConfidential
  const copyLink = useCopyChatLink()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const appHref = chat.id && !chat.deletedAt ? chatOpenInAppHref({ scheme: PRODUCT.linkScheme, origin: typeof location === 'undefined' ? '' : location.origin, chatId: chat.id, platform: platform(), client: clientKind(), phone }) : null
  const items: TitleMenuItem[] = [
    ...(chat.id && onPin
      ? [chat.pinnedAt
        ? { label: t('chat.unpin'), icon: <PinOff size={14} aria-hidden />, onSelect: onPin, testId: 'chat-unpin' }
        : { label: t('chat.pin'), icon: <Pin size={14} aria-hidden />, onSelect: onPin, testId: 'chat-pin' }]
      : []),
    // a shared chat is a conversation: "Mute this chat" / "Unmute this chat", as the row's "···" (chat/message-notices.ts;
    // a project chat I never wrote in has no row of mine but its project's)
    ...(chat.id && chat.shared && !chat.deletedAt && onMute
      ? [chat.muted
        ? { label: t('chat.unmute'), icon: <Bell size={14} aria-hidden />, onSelect: onMute, testId: 'chat-unmute' }
        : { label: t('chat.mute'), icon: <BellOff size={14} aria-hidden />, onSelect: onMute, testId: 'chat-mute' }]
      : []),
    ...(chat.id ? [{ label: t('rooms.menu.copyLink'), icon: <Link2 size={14} aria-hidden />, onSelect: () => void copyLink({ id: chat.id!, shared: chat.shared, projectId: chat.projectId, confidential: chat.confidential, deletedAt: chat.deletedAt, sideRoomId: chat.sideRoomId }), testId: 'chat-copy-link' }] : []),
    ...(appHref ? [{ label: t('auth.openInApp'), icon: <Monitor size={14} aria-hidden />, onSelect: () => { location.href = appHref }, testId: 'chat-open-in-app' }] : []),
    ...(onRename ? [{ label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: onRename, testId: 'chat-rename' }] : []),
    ...(onMove ? [{ label: t(moveLabel(chat)), icon: <FolderInput size={14} aria-hidden />, onSelect: onMove, testId: 'chat-project-move' }] : []),
    ...(chat.id && chat.shared && !safeOps && onPrivately ? [{ label: t('chat.continuePrivately'), icon: <Lock size={14} aria-hidden />, onSelect: onPrivately, testId: 'chat-continue-privately' }] : []),
    ...(onHide && me && mayHideChat(chat, me.user.id) ? [{ label: t('chat.hide'), icon: <EyeOff size={14} aria-hidden />, onSelect: onHide, testId: 'chat-hide' }] : []),
    ...(onLeave && me && mayLeaveChat(chat, me.user.id) ? [{ label: t('chat.leave'), icon: <LogOut size={14} aria-hidden />, onSelect: onLeave, danger: true, testId: 'chat-leave' }] : []),
    ...(onDelete ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: onDelete, danger: true, testId: 'chat-delete' }] : []),
  ]
  if (!items.length)
    return (
      <h1 className="min-w-0 truncate px-1.5 font-medium text-ink" title={title} data-testid="chat-title">
        {title}
      </h1>
    )
  return <TitleMenu name={title} heading="chat-title" testId="chat-menu" items={items} compact={compact} />
}
