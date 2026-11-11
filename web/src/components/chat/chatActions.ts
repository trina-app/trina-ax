// Rename and delete a chat: the same steps from the chat's menu in the sidebar and from its name at the top of the chat.
// Pin and unpin ("상단에 고정" / "고정 해제", docs/DECISIONS.md "Pinned chats"): the sidebar row's menu.
import { useNavigate, useParams } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { chatTrashDays } from '../../lib/chat-trash'
import { useChats } from '../../store/chats'
import { useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { confirmDialog, promptDialog } from '../ui'

/** "Undo" on the deleted toast: the chat comes back, or a failure says so (it stays in the trash, where it can still be
 * restored) */
export const undoDelete = (chatId: string, failText: string): Promise<void> =>
  api.call(API.restoreChat, { params: { id: chatId } }).then(useChats.getState().upsertChat, () => void toast({ level: 'error', text: failText }))

export function useChatActions() {
  const t = useT()
  const locale = useLocale()
  const { chatId } = useParams()
  const navigate = useNavigate()
  const me = useMeStrict()
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })

  /** the renamed chat, or null when the dialog was cancelled or the rename failed */
  const rename = async (chat: Chat): Promise<Chat | null> => {
    const title = await promptDialog({ title: t('chat.rename'), label: t('chat.title'), initial: chat.title, confirm: t('common.save') })
    if (!title) return null
    try {
      const c = await api.call(API.updateChat, { params: { id: chat.id }, body: { title } })
      useChats.getState().upsertChat(c)
      return c
    } catch (e) {
      fail(e)
      return null
    }
  }

  /** true once the chat is in the trash (false: cancelled, or the delete failed) */
  const remove = async (chat: Chat): Promise<boolean> => {
    // the trash by the name the sidebar gives it (a rename there follows here)
    if (!(await confirmDialog({ title: t('chat.deleteTitle'), body: t('chat.deleteBody', { days: chatTrashDays(me), trash: t('sidebar.trash') }), confirm: t('common.delete'), danger: true }))) return false
    try {
      await api.call(API.deleteChat, { params: { id: chat.id } })
      useChats.getState().removeChat(chat.id)
      if (chatId === chat.id) navigate('/')
      const undo = () => void undoDelete(chat.id, t('chat.restoreFailed', { trash: t('sidebar.trash') }))
      toast({ level: 'info', text: t('chat.deleted'), action: { label: t('common.undo'), run: undo } })
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }

  /** pin a chat to the top of my list, or unpin it: mine only; my other windows hear it (chat.updated). The chat as it
   * is now, or null when it failed. */
  const togglePin = async (chat: Chat): Promise<Chat | null> => {
    try {
      const params = { id: chat.id }
      const c = chat.pinnedAt ? await api.call(API.unpinChat, { params }) : await api.call(API.pinChat, { params })
      useChats.getState().upsertChat(c)
      return c
    } catch (e) {
      fail(e)
      return null
    }
  }

  return { rename, remove, togglePin }
}
