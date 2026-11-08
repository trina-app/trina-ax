// Rename and delete a chat: the same steps from the chat's menu in the sidebar and from its name at the top of the chat.
import { useNavigate, useParams } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { chatTrashDays } from '../../lib/chat-trash'
import { useChats } from '../../store/chats'
import { useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { confirmDialog, promptDialog } from '../ui'

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

  const remove = async (chat: Chat) => {
    // the trash by the name the sidebar gives it (a rename there follows here)
    if (!(await confirmDialog({ title: t('chat.deleteTitle'), body: t('chat.deleteBody', { days: chatTrashDays(me), trash: t('sidebar.trash') }), confirm: t('common.delete'), danger: true }))) return
    try {
      await api.call(API.deleteChat, { params: { id: chat.id } })
      useChats.getState().removeChat(chat.id)
      if (chatId === chat.id) navigate('/')
      toast({ level: 'info', text: t('chat.deleted'), action: { label: t('common.undo'), run: () => void api.call(API.restoreChat, { params: { id: chat.id } }).then(useChats.getState().upsertChat) } })
    } catch (e) {
      fail(e)
    }
  }

  return { rename, remove }
}
