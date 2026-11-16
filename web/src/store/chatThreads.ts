// Threads on AI answers in shared chats (docs/decisions/20261116-chat-answer-threads.md; the server's chat/threads.ts):
// the open thread of a chat answer (its answer and replies, read over REST), the replies on their way from this window
// (a lost connection keeps the text with "Send again"; the same clientId posts once; while Trina updates they wait and
// go by themselves; a 429 waits the seconds the server says), and the live changes (chat.thread: a reply came or went,
// I read it on another device). Each change also puts the thread's summary on its answer in the chat's messages
// (store/chats.ts), so the line under the answer follows without a reload.
import { create } from 'zustand'
import { uuidv7, type ChatThreadPage, type ChatThreadReply, type ChatThreadSummary, type ServerEventData } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isApiError } from '../lib/api'
import { waitForUpdate, waitsForUpdate } from '../lib/serverUpdating'
import { currentLocale, t } from '../i18n'
import { useChats } from './chats'
import { toast } from './ui'

/** one thread's key: its chat and its answer */
export const threadKey = (chatId: string, rootId: string) => `${chatId}:${rootId}`

export interface ChatThreadView extends Partial<Omit<ChatThreadPage, 'replies'>> {
  replies: ChatThreadReply[]
  loading: boolean
  error: unknown
}
/** a reply on its way: 'sending' (`updating`: waiting while Trina updates), or 'failed' (kept with "Send again") */
export interface PendingReply { clientId: string; text: string; state: 'sending' | 'failed'; at: string; error?: string; updating?: true }

interface State {
  views: Record<string, ChatThreadView>
  pending: Record<string, PendingReply[]>
  /** a refused reply's text, given back to its thread's box once (takeReturned) */
  returned: Record<string, string>
  load: (chatId: string, rootId: string) => Promise<void>
  loadOlder: (chatId: string, rootId: string) => Promise<void>
  send: (chatId: string, rootId: string, text: string) => Promise<void>
  sendAgain: (chatId: string, rootId: string, clientId: string) => Promise<void>
  dropPending: (chatId: string, rootId: string, clientId: string) => void
  remove: (chatId: string, rootId: string, replyId: string) => Promise<void>
  markRead: (chatId: string, rootId: string, upTo: string) => Promise<void>
  handleEvent: (ev: ServerEventData<'chat.thread'>) => void
  reset: () => void
}

const EMPTY_VIEW: ChatThreadView = { replies: [], loading: false, error: null }

/** the summary under the answer in the chat's messages (store/chats.ts threads), without touching anything else */
function putSummary(chatId: string, rootId: string, thread: ChatThreadSummary | null) {
  useChats.setState((s) => {
    const th = s.threads[chatId]
    if (!th || !th.messages.some((m) => m.id === rootId)) return {}
    const messages = th.messages.map((m) => {
      if (m.id !== rootId) return m
      const { thread: _, ...rest } = m
      return thread && thread.replyCount > 0 ? { ...rest, thread } : rest
    })
    return { threads: { ...s.threads, [chatId]: { ...th, messages } } }
  })
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
/** the replies with one added or replaced, in order (ids sort by time) */
const withReply = (list: ChatThreadReply[], r: ChatThreadReply) => [...list.filter((x) => x.id !== r.id), r].sort(byId)

export const useChatThreads = create<State>((set, get) => {
  const patch = (key: string, f: (v: ChatThreadView) => ChatThreadView) => set((s) => ({ views: { ...s.views, [key]: f(s.views[key] ?? EMPTY_VIEW) } }))
  const setPending = (key: string, f: (list: PendingReply[]) => PendingReply[]) => set((s) => {
    const list = f(s.pending[key] ?? [])
    const { [key]: _, ...rest } = s.pending
    return { pending: list.length ? { ...rest, [key]: list } : rest }
  })
  const mine = (key: string, clientId: string) => get().pending[key]?.find((p) => p.clientId === clientId)

  const post = async (chatId: string, rootId: string, p: PendingReply): Promise<void> => {
    const key = threadKey(chatId, rootId)
    try {
      const r = await api.call(API.sendChatThreadReply, { params: { id: chatId, messageId: rootId }, body: { text: p.text, clientId: p.clientId } })
      patch(key, (v) => ({ ...v, replies: withReply(v.replies, r) }))
      setPending(key, (list) => list.filter((x) => x.clientId !== p.clientId))
    } catch (e) {
      if (!mine(key, p.clientId)) return
      // Trina is updating: it waits with the connection banner and goes once the server is back, with the same id
      if (waitsForUpdate(e)) {
        setPending(key, (list) => list.map((x) => (x.clientId === p.clientId ? { ...x, updating: true } : x)))
        await waitForUpdate()
        const still = mine(key, p.clientId)
        if (!still) return
        setPending(key, (list) => list.map((x) => (x.clientId === p.clientId ? { ...x, state: 'sending', updating: undefined } : x)))
        return post(chatId, rootId, { ...still, state: 'sending', updating: undefined })
      }
      // sending fast: it waits the seconds the server says, then goes by itself
      if (isApiError(e, 'rate_limited')) {
        const wait = Math.min(60, Math.max(1, Number(e.body.retryAfter ?? 1)))
        toast({ level: 'info', text: t('chat.thread.fast') })
        await new Promise((r) => setTimeout(r, wait * 1000))
        const still = mine(key, p.clientId)
        return still ? post(chatId, rootId, still) : undefined
      }
      const error = errorText(e, currentLocale(), t('error.network'))
      // the server said no (full, read-only, too long…): sending it again gets the same answer; the reply goes, its text
      // comes back to the box (the panel takes it) and the reason is told. A thread that is gone keeps the faint reply
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 404) {
        setPending(key, (list) => list.filter((x) => x.clientId !== p.clientId))
        set((s) => ({ returned: { ...s.returned, [key]: p.text } }))
        toast({ level: 'warn', text: error })
        if (e.body.params?.reason === 'thread_full' || e.body.params?.reason === 'safe_ops' || e.body.params?.reason === 'not_shared') void get().load(chatId, rootId)
        return
      }
      setPending(key, (list) => list.map((x) => (x.clientId === p.clientId ? { ...x, state: 'failed', error } : x)))
    }
  }

  return {
    views: {},
    pending: {},
    returned: {},

    async load(chatId, rootId) {
      const key = threadKey(chatId, rootId)
      patch(key, (v) => ({ ...v, loading: true }))
      try {
        const page = await api.call(API.listChatThread, { params: { id: chatId, messageId: rootId }, query: {} })
        set((s) => ({ views: { ...s.views, [key]: { ...page, replies: page.replies, loading: false, error: null } } }))
        putSummary(chatId, rootId, page.root.thread ?? null)
      } catch (e) {
        patch(key, (v) => ({ ...v, loading: false, error: e }))
      }
    },

    async loadOlder(chatId, rootId) {
      const key = threadKey(chatId, rootId)
      const v = get().views[key]
      if (!v?.nextCursor || v.loading) return
      patch(key, (x) => ({ ...x, loading: true }))
      try {
        const page = await api.call(API.listChatThread, { params: { id: chatId, messageId: rootId }, query: { cursor: v.nextCursor } })
        patch(key, (x) => ({ ...x, replies: [...page.replies, ...x.replies].filter((r, i, all) => all.findIndex((y) => y.id === r.id) === i).sort(byId), nextCursor: page.nextCursor, loading: false }))
      } catch (e) {
        patch(key, (x) => ({ ...x, loading: false, error: e }))
      }
    },

    async send(chatId, rootId, text) {
      const key = threadKey(chatId, rootId)
      const p: PendingReply = { clientId: `ct-${uuidv7()}`, text, state: 'sending', at: new Date().toISOString() }
      setPending(key, (list) => [...list, p])
      await post(chatId, rootId, p)
    },

    async sendAgain(chatId, rootId, clientId) {
      const key = threadKey(chatId, rootId)
      const p = mine(key, clientId)
      if (!p) return
      setPending(key, (list) => list.map((x) => (x.clientId === clientId ? { ...x, state: 'sending', error: undefined } : x)))
      await post(chatId, rootId, { ...p, state: 'sending', error: undefined })
    },

    dropPending(chatId, rootId, clientId) {
      setPending(threadKey(chatId, rootId), (list) => list.filter((x) => x.clientId !== clientId))
    },

    async remove(chatId, rootId, replyId) {
      const key = threadKey(chatId, rootId)
      await api.call(API.deleteChatThreadReply, { params: { id: chatId, replyId } })
      patch(key, (v) => ({ ...v, replies: v.replies.filter((r) => r.id !== replyId) }))
    },

    async markRead(chatId, rootId, upTo) {
      try {
        await api.call(API.markChatThreadRead, { params: { id: chatId, messageId: rootId }, body: { upTo } })
      } catch {
        // not marked (offline, gone): the next look marks it
      }
    },

    handleEvent(ev) {
      const key = threadKey(ev.chatId, ev.rootId)
      putSummary(ev.chatId, ev.rootId, ev.thread)
      const v = get().views[key]
      if (!v) return
      if (ev.change === 'reply' && ev.reply) patch(key, (x) => ({ ...x, replies: withReply(x.replies, ev.reply!), root: x.root && ev.thread ? { ...x.root, thread: ev.thread } : x.root }))
      else if (ev.change === 'deleted' && ev.replyId) patch(key, (x) => ({ ...x, replies: x.replies.filter((r) => r.id !== ev.replyId), root: x.root ? (ev.thread ? { ...x.root, thread: ev.thread } : { ...x.root, thread: undefined }) : x.root }))
      else if (ev.change === 'read') patch(key, (x) => ({ ...x, root: x.root && ev.thread ? { ...x.root, thread: ev.thread } : x.root }))
    },

    reset() {
      set({ views: {}, pending: {}, returned: {} })
    },
  }
})

/** a refused reply's text, given back to the box once (the panel takes it): per thread */
export function takeReturned(chatId: string, rootId: string): string | null {
  const key = threadKey(chatId, rootId)
  const text = useChatThreads.getState().returned[key] ?? null
  if (text !== null) useChatThreads.setState((s) => { const { [key]: _, ...rest } = s.returned; return { returned: rest } })
  return text
}
