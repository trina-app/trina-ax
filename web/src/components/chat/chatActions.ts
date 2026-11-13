// Rename and delete a chat: the same steps from the chat's menu in the Trina list and from its name at the top of the chat.
// Pin and unpin ("상단에 고정" / "고정 해제", docs/DECISIONS.md "Pinned chats"): the Trina list row's menu.
// Each change shows at once and goes back with a toast when the server refuses it (lib/optimistic.ts; docs/DECISIONS.md
// "Optimistic changes: the screen first, the server after"): `changeChat` for a value of the chat (its name, engine,
// project, list folder), `trashChat` for the trash and back.
import { useNavigate, useParams } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { chatTrashDays } from '../../lib/chat-trash'
import { openHome } from '../../lib/screenHistory'
import { optimistic, optimisticPending, type OptimisticResult } from '../../lib/optimistic'
import { hideChatInGroups, showPinnedChat } from '../../store/chatGroups'
import { useChats } from '../../store/chats'
import { useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { confirmDialog, promptDialog } from '../ui'

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

/** what of a chat changes (the `chat:<id>:<field>` key; store/chats.ts keeps it on screen while it is on its way) */
export type ChatField = 'title' | 'engine' | 'project' | 'folder'

/**
 * Change a value of a chat at once on every list of this window (the chats store, 고정) and in `onShown` (a page's own
 * copy: the chat on screen, a project page's rows), then send it. A refusal puts back what the server last agreed to,
 * with one toast (the server's words; `failText` false: the caller says it). The server's copy settles it.
 */
export function changeChat<V>(o: {
  chat: Chat
  field: ChatField
  from: V
  to: V
  /** the chat with the value */
  apply: (c: Chat, v: V) => Chat
  send: () => Promise<Chat>
  /** the value in the server's copy */
  confirmed: (c: Chat) => V
  onShown?: (c: Chat) => void
  failText?: string | false
}): Promise<OptimisticResult<Chat>> {
  return optimistic<V, Chat>({
    key: `chat:${o.chat.id}:${o.field}`,
    from: o.from,
    to: o.to,
    show: (v) => {
      const c = o.apply(currentChat(o.chat), v)
      showChat(c)
      o.onShown?.(c)
    },
    send: o.send,
    confirmed: o.confirmed,
    settle: (c) => {
      // put in the trash here meanwhile: this answer is from before it and would bring the chat back
      if (trashedHere.has(o.chat.id) || optimisticPending(`chat:${o.chat.id}:trash`)) return
      // the server's copy joins my list as before (a chat my list had not loaded yet)
      useChats.getState().upsertChat(c)
      showPinnedChat(c)
      o.onShown?.(c)
    },
    failText: o.failText,
  })
}

/** chats put in the trash here (and not brought back since): a late answer of another change of theirs writes nothing */
const trashedHere = new Set<string>()

/** "now", for a change the server stamps with its own time (the row goes where the answer will put it) */
const now = () => new Date().toISOString()

/**
 * Put a chat in the trash (`trashed`) or bring it back, at once on every list of this window: out of 최근 기록, 고정 and
 * the history, or back in them (restored: unpinned and in no folder, as the server brings it back). `onShown` gets the
 * chat each time it changes on screen (a page's own copy: the trash list, the chat on screen). A refusal puts it back
 * with one toast (`failText`, by default the server's words).
 */
export function trashChat(chat: Chat, trashed: boolean, o: { onShown?: (c: Chat, trashed: boolean) => void; failText?: string } = {}): Promise<OptimisticResult<Chat | null>> {
  const was = currentChat(chat)
  const restored = (): Chat => {
    const { pinnedAt: _p, folderId: _f, ...rest } = was
    return { ...rest, deletedAt: null }
  }
  return optimistic<boolean, Chat | null>({
    key: `chat:${chat.id}:trash`,
    from: !!was.deletedAt,
    to: trashed,
    show: (inTrash) => {
      const s = useChats.getState()
      if (inTrash) trashedHere.add(chat.id)
      else trashedHere.delete(chat.id)
      if (inTrash) {
        s.removeChat(chat.id)
        hideChatInGroups(chat.id)
        o.onShown?.(was.deletedAt ? was : { ...was, deletedAt: now() }, true)
      } else {
        const c = was.deletedAt ? restored() : was
        s.upsertChat(c)
        showPinnedChat(c)
        o.onShown?.(c, false)
      }
    },
    send: async () => (trashed ? (await api.call(API.deleteChat, { params: { id: chat.id } }), null) : api.call(API.restoreChat, { params: { id: chat.id } })),
    settle: (c) => {
      if (!c) return
      useChats.getState().upsertChat(c)
      showPinnedChat(c)
      o.onShown?.(c, false)
    },
    failText: o.failText,
  })
}

/** "Undo" on the deleted toast: the chat comes back at once, or a failure says so (it stays in the trash, where it can
 * still be restored) */
export const undoDelete = async (chat: Chat, failText: string): Promise<void> => {
  await trashChat(chat, false, { failText })
}

export function useChatActions() {
  const t = useT()
  const { chatId } = useParams()
  const navigate = useNavigate()
  const me = useMeStrict()

  /** the renamed chat (the server's copy), or null when the dialog was cancelled, the rename failed or a newer change
   * of its name was made meanwhile. On screen at once: `onShown` gets the chat each time its name on screen changes. */
  const rename = async (chat: Chat, onShown?: (c: Chat) => void): Promise<Chat | null> => {
    const title = await promptDialog({ title: t('chat.rename'), label: t('chat.title'), initial: chat.title, confirm: t('common.save') })
    if (!title) return null
    const was = currentChat(chat)
    type Name = { title: string; updatedAt: string }
    const r = await changeChat<Name>({
      chat,
      field: 'title',
      from: { title: was.title, updatedAt: was.updatedAt },
      // the server trims it and stamps the chat (the row goes to the top of 최근 기록 now, not when it answers)
      to: { title: title.trim(), updatedAt: now() },
      apply: (c, v) => ({ ...c, ...v }),
      send: () => api.call(API.updateChat, { params: { id: chat.id }, body: { title } }),
      confirmed: (c) => ({ title: c.title, updatedAt: c.updatedAt }),
      onShown,
    })
    return r.ok && r.newest ? r.reply : null
  }

  /** true once the chat is in the trash (false: cancelled, or the delete failed). After the confirm it leaves the lists
   * at once; "Chat deleted." with its Undo comes when the server has it. `onShown`: a list's own copy (a project's
   * page), told each time the chat leaves it or, refused, comes back. */
  const remove = async (chat: Chat, onShown?: (c: Chat, trashed: boolean) => void): Promise<boolean> => {
    // the trash by the name of its row in the 트리나 panel (a rename there follows here)
    if (!(await confirmDialog({ title: t('chat.deleteTitle'), body: t('chat.deleteBody', { days: chatTrashDays(me), trash: t('sidebar.trash') }), confirm: t('common.delete'), danger: true }))) return false
    const was = currentChat(chat)
    // the chat on screen: Home, on a phone as 트리나 at its root, never on top of a project's stack (QA TC-255)
    if (chatId === chat.id) openHome(navigate, me.user.id, { drop: true })
    const r = await trashChat(was, true, { onShown })
    if (!r.ok) return false
    if (r.newest) {
      const undo = () => void undoDelete({ ...was, deletedAt: now() }, t('chat.restoreFailed', { trash: t('sidebar.trash') }))
      toast({ level: 'info', text: t('chat.deleted'), action: { label: t('common.undo'), run: undo } })
    }
    return true
  }

  /** pin a chat to the top of my list, or unpin it: mine only; my other windows hear it (chat.updated). On screen at
   * once (lib/optimistic.ts): `onShown` gets the chat each time its pin on screen changes (now, the server's copy, or
   * as it was after a failure), for lists that keep their own copy. The server's copy, or null when it failed or a newer
   * pin or unpin of the chat was made meanwhile. */
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
      confirmed: (c) => c.pinnedAt,
      settle: (c) => {
        // the server's copy joins my list as before (a project page's chat that my list had not loaded yet)
        useChats.getState().upsertChat(c)
        showPinnedChat(c)
        onShown?.(c)
      },
    })
    return r.ok && r.newest ? r.reply : null
  }

  return { rename, remove, togglePin }
}
