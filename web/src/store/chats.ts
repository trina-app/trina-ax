// Chats, the visible branch of each open chat, and everything the WebSocket says about them: streaming text, steps,
// queue position, ask_user cards, artifacts being written. REST gives the state, events keep it current, and after
// a reconnect that the server could not resume (reset/resync) everything is reloaded from REST.
import { create } from 'zustand'
import { uuidv7, type Attachment, type Chat, type EngineId, type Message, type ServerEvent, type ServerEventData, type TurnRequest, type TurnStarted } from '@mycel/shared/api'
import { api, API, ApiError, isNetworkError } from '../lib/api'
import { applyCreated, applyDelta, applyDone, applyStep, emptyThread, markLocal, mergeFresh, mergeTurnStarted, optimisticUserMessage, prependPage, type Delta, type Thread } from './thread'

const PAGE = 50
/** Keep retrying a send that failed on the network for this long (same clientMessageId: the server dedupes). */
export const SEND_RETRY_MS = 30_000

export interface LiveArtifact {
  key: string
  chatId: string
  messageId: string | null
  type: ServerEventData<'artifact.updated'>['type']
  title: string | null
  status: 'writing' | 'done'
  content: string
  artifactId: string | null
  version: number | null
}

export interface OpenRequest { turnId: string; chatId: string; messageId: string; request: TurnRequest }

type Pending = { deltas: Delta[]; steps: ServerEventData<'message.step'>[]; done: Message | null }

interface ChatsState {
  chats: Chat[]
  chatsCursor: string | null
  chatsLoaded: boolean
  threads: Record<string, Thread>
  /** messageId -> turns ahead in the queue (0 = running) */
  queue: Record<string, number>
  /** open ask_user / browser_site cards by requestId */
  requests: Record<string, OpenRequest>
  /** chatId -> key -> artifact being written or just saved */
  liveArtifacts: Record<string, Record<string, LiveArtifact>>
  /** bumped when a chat's saved artifacts changed (artifact panel / cards refetch) */
  artifactsRev: Record<string, number>
  /** artifact the panel should open by itself (the AI started writing one) */
  autoOpen: { chatId: string; key: string; at: number } | null

  loadChats: (reset?: boolean) => Promise<void>
  upsertChat: (c: Chat) => void
  removeChat: (id: string) => void
  loadThread: (chatId: string) => Promise<void>
  loadOlder: (chatId: string) => Promise<void>
  send: (o: SendInput) => Promise<{ chatId: string }>
  resend: (chatId: string, localId: string) => Promise<void>
  discardLocal: (chatId: string, localId: string) => void
  stop: (chatId: string) => Promise<void>
  regenerate: (chatId: string, assistantId: string, engine?: { engine?: EngineId; model?: string | null }) => Promise<void>
  edit: (chatId: string, userMessageId: string, content: string, attachments: Attachment[]) => Promise<void>
  selectBranch: (chatId: string, messageId: string) => Promise<void>
  answer: (requestId: string, body: { kind: 'ask_user'; answer: string | string[] | null } | { kind: 'browser_site'; decision: 'once' | 'always' | 'deny' }) => Promise<void>
  handleEvent: (ev: ServerEvent) => void
  reloadAll: () => Promise<void>
  reset: () => void
}

export interface SendInput {
  chatId: string | null
  content: string
  attachments: Attachment[]
  author: { id: string; name: string }
  projectId?: string | null
  engine?: EngineId
  model?: string | null
}

/** Sends waiting for the network to come back: localId -> body. */
const outbox = new Map<string, { chatId: string; clientMessageId: string; content: string; attachmentIds: string[]; parentId: string | undefined; engine?: EngineId; model?: string | null; firstTry: number }>()
/**
 * Events for messages we don't know yet (they raced the POST answer). Bounded: a message that never shows up (another
 * branch, a lost response) must not keep its events forever; the oldest entries go first, and past the per-message
 * cap the thread is simply reloaded from REST when the message appears.
 */
const pending = new Map<string, Pending>()
export const PENDING_MESSAGES_MAX = 50
export const PENDING_EVENTS_MAX = 2000
const pendingOf = (id: string) => {
  let p = pending.get(id)
  if (!p) {
    pending.set(id, (p = { deltas: [], steps: [], done: null }))
    while (pending.size > PENDING_MESSAGES_MAX) pending.delete(pending.keys().next().value!)
  }
  return p
}
const pendingFull = (p: Pending) => p.deltas.length + p.steps.length >= PENDING_EVENTS_MAX
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const initial = () => ({
  chats: [] as Chat[],
  chatsCursor: null as string | null,
  chatsLoaded: false,
  threads: {} as Record<string, Thread>,
  queue: {} as Record<string, number>,
  requests: {} as Record<string, OpenRequest>,
  liveArtifacts: {} as Record<string, Record<string, LiveArtifact>>,
  artifactsRev: {} as Record<string, number>,
  autoOpen: null as ChatsState['autoOpen'],
})

const sortChats = (list: Chat[]) => list.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))

export const useChats = create<ChatsState>((set, get) => {
  const thread = (chatId: string) => get().threads[chatId] ?? emptyThread()
  const setThread = (chatId: string, fn: (t: Thread) => Thread) =>
    set((s) => ({ threads: { ...s.threads, [chatId]: fn(s.threads[chatId] ?? emptyThread()) } }))

  /** Apply what arrived for a message before we knew it (event raced the POST response). */
  const flushPending = (chatId: string, ids: string[]) => {
    for (const id of ids) {
      const p = pending.get(id)
      if (!p) continue
      pending.delete(id)
      let msgs = thread(chatId).messages
      for (const d of p.deltas) {
        const r = applyDelta(msgs, d)
        if (r.kind === 'applied') msgs = r.messages
      }
      for (const st of p.steps) msgs = applyStep(msgs, st.messageId, st.step) ?? msgs
      if (p.done) msgs = applyDone(msgs, p.done) ?? msgs
      setThread(chatId, (t) => ({ ...t, messages: msgs }))
    }
  }

  const markStale = (chatId: string) => {
    if (!get().threads[chatId]) return
    setThread(chatId, (t) => ({ ...t, stale: true }))
    void get().loadThread(chatId)
  }

  const clearQueue = (messageId: string) => {
    if (get().queue[messageId] === undefined) return
    set((s) => {
      const q = { ...s.queue }
      delete q[messageId]
      return { queue: q }
    })
  }

  const afterStarted = (chatId: string, started: TurnStarted, o: { replaceId?: string; cutAt?: string }) => {
    setThread(chatId, (t) => ({ ...t, messages: mergeTurnStarted(t.messages, started, o) }))
    // text or steps that raced ahead of this response mean the turn is already running: no queue position
    const early = pending.get(started.assistantMessage.id)
    if (!early || (!early.deltas.length && !early.steps.length && !early.done)) set((s) => ({ queue: { ...s.queue, [started.assistantMessage.id]: started.queuePosition } }))
    flushPending(chatId, [started.assistantMessage.id, ...(started.userMessage ? [started.userMessage.id] : [])])
    const c = get().chats.find((x) => x.id === chatId)
    if (c) get().upsertChat({ ...c, runState: started.queuePosition > 0 ? 'queued' : 'running', updatedAt: new Date().toISOString() })
  }

  /** POST the message; on network failure retry with the same clientMessageId until SEND_RETRY_MS has passed. */
  const deliver = async (localId: string) => {
    const job = outbox.get(localId)
    if (!job) return
    for (let attempt = 0; ; attempt++) {
      try {
        const started = await api.call(API.sendMessage, {
          params: { id: job.chatId },
          body: { content: job.content, attachmentIds: job.attachmentIds, parentId: job.parentId, engine: job.engine, model: job.model, clientMessageId: job.clientMessageId },
        })
        outbox.delete(localId)
        afterStarted(job.chatId, started, { replaceId: localId })
        return
      } catch (e) {
        if (isNetworkError(e) && Date.now() - job.firstTry < SEND_RETRY_MS) {
          await sleep(Math.min(8000, 1000 * 2 ** attempt))
          continue
        }
        // the server's reason is already in the person's words (budget used up, attachment gone, …); a network
        // failure has only the browser's English text, so the screen says "not sent" without it
        setThread(job.chatId, (t) => ({ ...t, messages: markLocal(t.messages, localId, 'failed', e instanceof ApiError ? e.message : undefined) }))
        throw e
      }
    }
  }

  return {
    ...initial(),

    reset: () => {
      outbox.clear()
      pending.clear()
      set(initial())
    },

    async loadChats(reset = true) {
      const cursor = reset ? undefined : get().chatsCursor ?? undefined
      if (!reset && !cursor) return
      const page = await api.call(API.listChats, { query: { limit: PAGE, cursor } })
      set((s) => {
        const merged = reset ? page.items : [...s.chats, ...page.items.filter((c) => !s.chats.some((x) => x.id === c.id))]
        return { chats: merged, chatsCursor: page.nextCursor, chatsLoaded: true }
      })
    },

    upsertChat(c) {
      set((s) => ({ chats: sortChats([c, ...s.chats.filter((x) => x.id !== c.id)]) }))
    },

    removeChat(id) {
      set((s) => ({ chats: s.chats.filter((c) => c.id !== id) }))
    },

    async loadThread(chatId) {
      const page = await api.call(API.listMessages, { params: { id: chatId }, query: { limit: PAGE } })
      setThread(chatId, (t) => ({ messages: mergeFresh(t.messages, page.items), nextCursor: page.nextCursor, stale: false }))
      flushPending(chatId, page.items.map((m) => m.id))
    },

    async loadOlder(chatId) {
      const cur = thread(chatId)
      if (!cur.nextCursor) return
      const page = await api.call(API.listMessages, { params: { id: chatId }, query: { limit: PAGE, cursor: cur.nextCursor } })
      setThread(chatId, (t) => ({ ...t, messages: prependPage(t.messages, page.items), nextCursor: page.nextCursor }))
    },

    async send(o) {
      let chatId = o.chatId
      if (!chatId) {
        const chat = await api.call(API.createChat, { body: { projectId: o.projectId ?? null, engine: o.engine, model: o.model ?? undefined } })
        get().upsertChat(chat)
        chatId = chat.id
        setThread(chatId, () => ({ ...emptyThread() }))
      }
      const t = thread(chatId)
      // answer under the last message we show; when nothing is loaded yet (a chat opened a moment ago), leave it to the
      // server's active leaf — null would start a new conversation at the root
      const last = t.messages.filter((m) => !m.local).at(-1)
      const localId = uuidv7()
      const clientMessageId = uuidv7()
      const msg = optimisticUserMessage({ id: localId, chatId, parentId: last?.id ?? null, content: o.content, author: o.author, attachments: o.attachments, clientMessageId, now: new Date().toISOString() })
      setThread(chatId, (th) => ({ ...th, messages: [...th.messages, msg] }))
      outbox.set(localId, { chatId, clientMessageId, content: o.content, attachmentIds: o.attachments.map((a) => a.id), parentId: last?.id, engine: o.engine, model: o.model, firstTry: Date.now() })
      // the message shows as "sending" right away; a failure turns it into "not sent [send again]"
      void deliver(localId).catch(() => {})
      return { chatId }
    },

    async resend(chatId, localId) {
      const job = outbox.get(localId)
      if (!job) return
      job.firstTry = Date.now()
      setThread(chatId, (t) => ({ ...t, messages: markLocal(t.messages, localId, 'sending') }))
      await deliver(localId).catch(() => {})
    },

    discardLocal(chatId, localId) {
      outbox.delete(localId)
      setThread(chatId, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== localId) }))
    },

    async stop(chatId) {
      await api.call(API.stop, { params: { id: chatId } })
    },

    async regenerate(chatId, assistantId, engine) {
      const started = await api.call(API.regenerate, { params: { id: chatId, messageId: assistantId }, body: { engine: engine?.engine, model: engine?.model } })
      afterStarted(chatId, started, { cutAt: assistantId })
    },

    async edit(chatId, userMessageId, content, attachments) {
      const started = await api.call(API.editMessage, { params: { id: chatId, messageId: userMessageId }, body: { content, attachmentIds: attachments.map((a) => a.id), clientMessageId: uuidv7() } })
      afterStarted(chatId, started, { cutAt: userMessageId })
    },

    async selectBranch(chatId, messageId) {
      const page = await api.call(API.selectBranch, { params: { id: chatId }, body: { messageId } })
      setThread(chatId, () => ({ messages: page.items, nextCursor: page.nextCursor, stale: false }))
    },

    async answer(requestId, body) {
      const r = get().requests[requestId]
      if (!r) return
      await api.call(API.answerTurn, { params: { id: r.turnId }, body: { ...body, requestId } as never })
      set((s) => {
        const next = { ...s.requests }
        delete next[requestId]
        return { requests: next }
      })
    },

    async reloadAll() {
      const open = Object.keys(get().threads)
      await Promise.allSettled([get().loadChats(true), ...open.map((id) => get().loadThread(id))])
      set({ queue: {} })
    },

    handleEvent(ev) {
      switch (ev.type) {
        case 'message.created': {
          const { chatId, message } = ev.data
          if (!get().threads[chatId]) return
          const r = applyCreated(thread(chatId).messages, message)
          if (r === 'stale') markStale(chatId)
          else {
            setThread(chatId, (t) => ({ ...t, messages: r }))
            flushPending(chatId, [message.id])
          }
          return
        }
        case 'message.delta': {
          const { chatId, messageId, offset, text } = ev.data
          clearQueue(messageId)
          if (!get().threads[chatId]) return
          const r = applyDelta(thread(chatId).messages, { messageId, offset, text })
          if (r.kind === 'applied') setThread(chatId, (t) => ({ ...t, messages: r.messages }))
          else if (r.kind === 'unknown') {
            const p = pendingOf(messageId)
            if (pendingFull(p)) {
              pending.delete(messageId)
              markStale(chatId)
            } else p.deltas.push({ messageId, offset, text })
          }
          else if (r.kind === 'gap') markStale(chatId)
          return
        }
        case 'message.step': {
          const { chatId, messageId, step } = ev.data
          clearQueue(messageId)
          if (!get().threads[chatId]) return
          const r = applyStep(thread(chatId).messages, messageId, step)
          if (r) setThread(chatId, (t) => ({ ...t, messages: r }))
          else {
            const p = pendingOf(messageId)
            if (pendingFull(p)) {
              pending.delete(messageId)
              markStale(chatId)
            } else p.steps.push(ev.data)
          }
          return
        }
        case 'message.done': {
          const { chatId, message } = ev.data
          clearQueue(message.id)
          set((s) => ({ artifactsRev: { ...s.artifactsRev, [chatId]: (s.artifactsRev[chatId] ?? 0) + 1 } }))
          if (!get().threads[chatId]) return
          const r = applyDone(thread(chatId).messages, message)
          if (r) setThread(chatId, (t) => ({ ...t, messages: r }))
          else pendingOf(message.id).done = message
          return
        }
        case 'queue.position':
          set((s) => ({ queue: { ...s.queue, [ev.data.messageId]: ev.data.position } }))
          return
        case 'chat.updated': {
          const { chatId, change, chat } = ev.data
          if (change === 'deleted' || change === 'purged') get().removeChat(chatId)
          else if (chat) get().upsertChat(chat)
          return
        }
        case 'turn.request': {
          const { turnId, chatId, messageId, request } = ev.data
          set((s) => ({ requests: { ...s.requests, [request.requestId]: { turnId, chatId, messageId, request } } }))
          return
        }
        case 'turn.request.closed':
          set((s) => {
            const next = { ...s.requests }
            delete next[ev.data.requestId]
            return { requests: next }
          })
          return
        case 'artifact.updated': {
          const d = ev.data
          const prev = get().liveArtifacts[d.chatId]?.[d.key]
          const live: LiveArtifact = {
            key: d.key,
            chatId: d.chatId,
            messageId: d.messageId,
            type: d.type,
            title: d.title,
            status: d.status,
            content: d.content ?? prev?.content ?? '',
            artifactId: d.artifact?.id ?? prev?.artifactId ?? null,
            version: d.artifact?.version ?? prev?.version ?? null,
          }
          set((s) => ({
            liveArtifacts: { ...s.liveArtifacts, [d.chatId]: { ...(s.liveArtifacts[d.chatId] ?? {}), [d.key]: live } },
            artifactsRev: d.status === 'done' ? { ...s.artifactsRev, [d.chatId]: (s.artifactsRev[d.chatId] ?? 0) + 1 } : s.artifactsRev,
            // the panel opens by itself when the AI starts writing (Claude parity)
            autoOpen: d.status === 'writing' && !prev ? { chatId: d.chatId, key: d.key, at: Date.now() } : s.autoOpen,
          }))
          return
        }
        default:
          return
      }
    },
  }
})

/** Queue position of a message, or undefined when not queued. */
export const useQueuePosition = (messageId: string | undefined) => useChats((s) => (messageId ? s.queue[messageId] : undefined))
