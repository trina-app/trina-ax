// The chat's title in the chat header, as a menu (main's TitleMenu): Rename, "Move to project…" ("Change project…"
// whenever the chat is in a project, also one the person can no longer see), Delete. The move item is here so that it
// works on a phone too, where the header has no room for more buttons.
// A shared project chat (docs/DECISIONS.md "Shared project chats") offers only what the person may do: rename for its
// creator, delete for its creator or a project editor, never a move (it stays in its project). With nothing to offer the
// title is a plain heading.
import { FolderInput, Pencil, Trash2 } from 'lucide-react'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { TitleMenu, type TitleMenuItem } from '../TitleMenu'

export function ChatTitleMenu({ chat, title, onRename, onMove, onDelete }: { chat: Pick<Chat, 'projectId'>; title: string; onRename?: () => void; onMove?: () => void; onDelete?: () => void }) {
  const t = useT()
  const items: TitleMenuItem[] = [
    ...(onRename ? [{ label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: onRename, testId: 'chat-rename' }] : []),
    ...(onMove ? [{ label: t(chat.projectId ? 'chat.project.change' : 'chat.project.add'), icon: <FolderInput size={14} aria-hidden />, onSelect: onMove, testId: 'chat-project-move' }] : []),
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
