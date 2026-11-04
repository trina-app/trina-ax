// The chat's title in the chat header, as a menu (main's TitleMenu): Rename, "Move to project…" ("Change project…"
// whenever the chat is in a project, also one the person can no longer see), Delete. The move item is here so that it
// works on a phone too, where the header has no room for more buttons.
import { FolderInput, Pencil, Trash2 } from 'lucide-react'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { TitleMenu } from '../TitleMenu'

export function ChatTitleMenu({ chat, title, onRename, onMove, onDelete }: { chat: Pick<Chat, 'projectId'>; title: string; onRename: () => void; onMove: () => void; onDelete: () => void }) {
  const t = useT()
  return (
    <TitleMenu
      name={title}
      heading="chat-title"
      testId="chat-menu"
      items={[
        { label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: onRename, testId: 'chat-rename' },
        { label: t(chat.projectId ? 'chat.project.change' : 'chat.project.add'), icon: <FolderInput size={14} aria-hidden />, onSelect: onMove, testId: 'chat-project-move' },
        { label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: onDelete, danger: true, testId: 'chat-delete' },
      ]}
    />
  )
}
