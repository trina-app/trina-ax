// Rename and delete a chat: the same steps from the chat's menu in the Trina list and from its name at the top of the chat.
// Pin and unpin ("상단에 고정" / "고정 해제", docs/DECISIONS.md "Pinned chats"): the Trina list row's menu.
import { useNavigate, useParams } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { chatTrashDays } from '../../lib/chat-trash'
import { openHome } from '../../lib/screenHistory'
import { optimistic } from '../../lib/optimistic'
import { showPinnedChat } from '../../store/chatGroups'
import { useChats } from '../../store/chats'
import { useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { confirmDialog, promptDialog } from '../ui'

/** "Undo" on the deleted toast: the chat comes back, or a failure says so (it stays in the trash, where it can still be
 * restored) */
export const undoDelete = (chatId: string, failText: string): Promise<void> =>
  api.call(API.restoreChat, { params: { id: chatId } }).then(useChats.getState().upsertChat, () => void toast({ level: 'error', text: failText }))

/** the chat as this window has it now (a reply or an event may have changed it since the menu opened) */
const currentChat = (c: Chat): Chat => {
  const s = useChats.getState()
  return s.chats.find((x) => x.id === c.id) ?? s.others[c.id] ?? c
}

/** the chat with a pin from `at`, or none */
const withPin = (c: Chat, at: string | undefined): Chat => {
  const { pinnedAt: _was, ...rest } = c
  return at ? { ...rest, pinnedAt: at } : rest
}

/** a chat's pin on every list of this window: 최근 기록 and the history (the chats store), 고정 (the groups) */
const showChat = (c: Chat) => {
  const s = useChats.getState()
  if (s.chats.some((x) => x.id === c.id) || c.id in s.others) s.upsertChat(c)
  showPinnedChat(c)
}

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
    // the trash by the name of its row in the 트리나 panel (a rename there follows here)
    if (!(await confirmDialog({ title: t('chat.deleteTitle'), body: t('chat.deleteBody', { days: chatTrashDays(me), trash: t('sidebar.trash') }), confirm: t('common.delete'), danger: true }))) return false
    try {
      await api.call(API.deleteChat, { params: { id: chat.id } })
      useChats.getState().removeChat(chat.id)
      // the chat on screen: Home, on a phone as 트리나 at its root, never on top of a project's stack (QA TC-255)
      if (chatId === chat.id) openHome(navigate, me.user.id, { drop: true })
      const undo = () => void undoDelete(chat.id, t('chat.restoreFailed', { trash: t('sidebar.trash') }))
      toast({ level: 'info', text: t('chat.deleted'), action: { label: t('common.undo'), run: undo } })
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }

  /** pin a chat to the top of my list, or unpin it: mine only; my other windows hear it (chat.updated). On screen at
   * once (lib/optimistic.ts): `onShown` gets the chat each time its pin on screen changes (now, the server's copy, or
   * as it was after a failure), for lists that keep their own copy. The server's copy, or null when it failed. */
  const togglePin = async (chat: Chat, onShown?: (c: Chat) => void): Promise<Chat | null> => {
    const params = { id: chat.id }
    const pinning = !chat.pinnedAt
    const r = await optimistic<string | undefined, Chat>({
      key: `chat:${chat.id}:pin`,
      from: chat.pinnedAt,
      to: pinning ? new Date().toISOString() : undefined,
      show: (at) => {
        const c = withPin(currentChat(chat), at)
        showChat(c)
        onShown?.(c)
      },
      send: () => (pinning ? api.call(API.pinChat, { params }) : api.call(API.unpinChat, { params })),
      settle: (c) => {
        // the server's copy joins my list as before (a project page's chat that my list had not loaded yet)
        useChats.getState().upsertChat(c)
        showPinnedChat(c)
        onShown?.(c)
      },
    })
    return r.ok ? r.reply : null
  }

  return { rename, remove, togglePin }
}
