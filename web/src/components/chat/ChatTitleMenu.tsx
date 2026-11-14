// The chat's title in the chat header, as a menu (main's TitleMenu): "상단에 고정" / "고정 해제" first, the row menu's own
// item, icon and call (components/chat/chatMenuItems.tsx; docs/DECISIONS.md "Pinned chats": anyone who sees the chat),
// then Rename, "Move to project" ("Change project"
// whenever the chat is in a project, also one the person can no longer see), "프로젝트 멤버와 공유" for a chat of
// one person in a project whose new chats are shared (components/chat/ShareChat.tsx: the server's check, then a confirm
// when one comes back), Delete. The move item is here so that it works on a phone too, where the header has no room for
// more buttons. "링크 복사" (the chat's address, for whoever may open it) is first, and is there for every chat that
// has been made, so the title is a menu even when the person may change nothing.
// A shared project chat (docs/DECISIONS.md "Shared project chats") offers only what the person may do: rename for its
// creator, delete for its creator or a project editor, never a move (it stays in its project) and never a share (it is
// shared). With nothing to offer the title is a plain heading. A shared chat also offers "Continue in a chat only you
// see" (docs/DECISIONS.md "Team project chats shared by default"): a new "Only me" chat in the same project with my
// last question in its box, where my memories and apps work (the AI points here when asked for one in a shared chat).
// "Share…" (docs/DECISIONS.md "Chats shared with people and groups"; lib/sharedChat.ts shareKindOf) is one item for both
// kinds: a chat outside projects that is mine opens the Share dialog (components/chat/ChatShareDialog.tsx), my private
// chat in a team project the project members' share, my chat in a personal project the dialog that explains and offers
// Move…. A chat someone shared with me offers "Hide from my list" (its creator never hides it), and "Continue in a chat
// only you see" opens Home's box there (no project) with my last question.
import { EyeOff, FolderInput, Link2, Lock, Pencil, Pin, PinOff, Trash2, Users } from 'lucide-react'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useMe } from '../../store/session'
import { useProjects } from '../../store/projects'
import { mayHideChat, shareKindOf } from '../../lib/sharedChat'
import { TitleMenu, type TitleMenuItem } from '../TitleMenu'
import { startShare } from './ChatShareDialog'
import { useCopyChatLink } from './copyChatLink'
import { moveLabel } from './ChatProject'

type MenuChat = Pick<Chat, 'projectId'> & Partial<Pick<Chat, 'id' | 'title' | 'shared' | 'confidential' | 'deletedAt' | 'pinnedAt' | 'sideRoomId' | 'schedule'>>

export function ChatTitleMenu({ chat, title, onPin, onRename, onMove, onDelete, onPrivately, onHide }: { chat: MenuChat; title: string; onPin?: () => void; onRename?: () => void; onMove?: () => void; onDelete?: () => void; onPrivately?: () => void; onHide?: () => void }) {
  const t = useT()
  const me = useMe()
  const safeOps = !!me?.server.allChatsConfidential
  // the project as this window knows it (store/projects.ts; the header's project name keeps it fresh)
  const project = useProjects((s) => (chat.projectId ? s.byId[chat.projectId] : undefined))
  const copyLink = useCopyChatLink()
  const share = chat.id && me ? shareKindOf(chat, project, me.user.id, safeOps) : null
  const items: TitleMenuItem[] = [
    ...(chat.id && onPin
      ? [chat.pinnedAt
        ? { label: t('chat.unpin'), icon: <PinOff size={14} aria-hidden />, onSelect: onPin, testId: 'chat-unpin' }
        : { label: t('chat.pin'), icon: <Pin size={14} aria-hidden />, onSelect: onPin, testId: 'chat-pin' }]
      : []),
    ...(chat.id ? [{ label: t('rooms.menu.copyLink'), icon: <Link2 size={14} aria-hidden />, onSelect: () => void copyLink({ id: chat.id!, shared: chat.shared, projectId: chat.projectId, confidential: chat.confidential, deletedAt: chat.deletedAt, sideRoomId: chat.sideRoomId }), testId: 'chat-copy-link' }] : []),
    ...(onRename ? [{ label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: onRename, testId: 'chat-rename' }] : []),
    ...(onMove ? [{ label: t(moveLabel(chat)), icon: <FolderInput size={14} aria-hidden />, onSelect: onMove, testId: 'chat-project-move' }] : []),
    ...(share ? [{ label: t('chat.share.menu'), icon: <Users size={14} aria-hidden />, onSelect: () => startShare({ id: chat.id!, title: chat.title ?? title, projectId: chat.projectId, shared: chat.shared }, share), testId: 'chat-share' }] : []),
    ...(chat.id && chat.shared && !safeOps && onPrivately ? [{ label: t('chat.continuePrivately'), icon: <Lock size={14} aria-hidden />, onSelect: onPrivately, testId: 'chat-continue-privately' }] : []),
    ...(onHide && me && mayHideChat(chat, me.user.id) ? [{ label: t('chat.hide'), icon: <EyeOff size={14} aria-hidden />, onSelect: onHide, testId: 'chat-hide' }] : []),
    ...(onDelete ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: onDelete, danger: true, testId: 'chat-delete' }] : []),
  ]
  if (!items.length)
    return (
      <h1 className="min-w-0 truncate px-1.5 font-medium text-ink" data-testid="chat-title">
        {title}
      </h1>
    )
  return <TitleMenu name={title} heading="chat-title" testId="chat-menu" items={items} />
}
