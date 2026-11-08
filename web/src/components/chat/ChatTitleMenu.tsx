// The chat's title in the chat header, as a menu (main's TitleMenu): Rename, "Move to project…" ("Change project…"
// whenever the chat is in a project, also one the person can no longer see), "프로젝트 사람들과 공유…" for a chat of
// one person in a project whose new chats are shared (components/chat/ShareChat.tsx: the server's check, then a confirm
// when one comes back), Delete. The move item is here so that it works on a phone too, where the header has no room for
// more buttons.
// A shared project chat (docs/DECISIONS.md "Shared project chats") offers only what the person may do: rename for its
// creator, delete for its creator or a project editor, never a move (it stays in its project) and never a share (it is
// shared). With nothing to offer the title is a plain heading.
import { FolderInput, Pencil, Trash2, Users } from 'lucide-react'
import { useState } from 'react'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useMe } from '../../store/session'
import { useProjects } from '../../store/projects'
import { TitleMenu, type TitleMenuItem } from '../TitleMenu'
import { mayShareChat, ShareChatFlow } from './ShareChat'

type MenuChat = Pick<Chat, 'projectId'> & Partial<Pick<Chat, 'id' | 'shared' | 'confidential' | 'deletedAt'>>

export function ChatTitleMenu({ chat, title, onRename, onMove, onDelete }: { chat: MenuChat; title: string; onRename?: () => void; onMove?: () => void; onDelete?: () => void }) {
  const t = useT()
  const safeOps = !!useMe()?.server.allChatsConfidential
  // the project as this window knows it (store/projects.ts; the header's project name keeps it fresh)
  const project = useProjects((s) => (chat.projectId ? s.byId[chat.projectId] : undefined))
  const [sharing, setSharing] = useState(false)
  const share = !!chat.id && mayShareChat(chat, project, safeOps)
  const items: TitleMenuItem[] = [
    ...(onRename ? [{ label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: onRename, testId: 'chat-rename' }] : []),
    ...(onMove ? [{ label: t(chat.projectId ? 'chat.project.change' : 'chat.project.add'), icon: <FolderInput size={14} aria-hidden />, onSelect: onMove, testId: 'chat-project-move' }] : []),
    ...(share ? [{ label: t('chat.shareChat.menu'), icon: <Users size={14} aria-hidden />, onSelect: () => setSharing(true), testId: 'chat-share' }] : []),
    ...(onDelete ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: onDelete, danger: true, testId: 'chat-delete' }] : []),
  ]
  if (!items.length)
    return (
      <h1 className="min-w-0 truncate px-1.5 font-medium text-ink" data-testid="chat-title">
        {title}
      </h1>
    )
  return (
    <>
      <TitleMenu name={title} heading="chat-title" testId="chat-menu" items={items} />
      {sharing && chat.id && <ShareChatFlow chatId={chat.id} onClose={() => setSharing(false)} />}
    </>
  )
}
