// Chats, the visible branch of each open chat, and everything the WebSocket says about them: streaming text, steps,
// queue position, ask_user / browser site / connect_service cards, artifacts being written. REST gives the state,
// events keep it current, and after a reconnect that the server could not resume (reset/resync) everything is
// reloaded from REST.
import { create } from 'zustand'
import { CARD_NEWS_ARTIFACT_KEY, DECK_ARTIFACT_KEY, PROMO_ARTIFACT_KEY, uuidv7, type Attachment, type Chat, type ChatQueueSnapshot, type EngineId, type Message, type ServerEvent, type ServerEventData, type TurnConnectBody, type TurnConnectResult, type TurnRequest, type TurnStarted } from '@mycel/shared/api'
import { api, API, ApiError, isNetworkError } from '../lib/api'
import { applyCreated, applyDelta, applyDone, applyStep, emptyThread, markLocal, mergeFresh, mergeTurnStarted, optimisticUserMessage, prependPage, type Delta, type Thread } from './thread'

const PAGE = 50
/** Artifacts that are the whole answer of their skill: the panel opens them by itself once they are saved (the intro
 * deck, the promo video, the card news). */
const OPENS_BY_ITSELF = new Set<string>([DECK_ARTIFACT_KEY, PROMO_ARTIFACT_KEY, CARD_NEWS_ARTIFACT_KEY])
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

/** An open card of a turn. `chatId`: the chat it shows in; none for a room's card read again (GET
 * /api/rooms/:id/ai/requests): a room finds its cards by their turn (components/rooms/RoomAiStatus.tsx). */
export interface OpenRequest { turnId: string; chatId?: string; messageId: string; request: TurnRequest }
/** What a connect_service card's button sends (POST /api/turns/:id/connect) besides the card's id. A key only ever
 * goes sealed (lib/connectCard.ts): the store never holds one. */
export type ConnectAction = TurnConnectBody extends infer B ? (B extends unknown ? Omit<B, 'requestId'> : never) : never

type Pending = { deltas: Delta[]; steps: ServerEventData<'message.step'>[]; done: Message | null }

interface ChatsState {
  chats: Chat[]
  /** shared project chats on screen that are not in my list (I neither made them nor wrote in them: Chat.shared.mine is
   * false): kept up to date by chat.updated without being added to the sidebar (docs/DECISIONS.md "Shared project
   * chats") */
  others: Record<string, Chat>
  chatsCursor: string | null
  chatsLoaded: boolean
  threads: Record<string, Thread>
  /** messageId -> estimated dispatch rank (1 = first queued, 0 = running), not turns ahead */
  queue: Record<string, number>
  /** open ask_user / browser_site / dev_env_site / connect_service cards by requestId */
  requests: Record<string, OpenRequest>
  /** chatId -> key -> artifact being written or just saved */
  liveArtifacts: Record<string, Record<string, LiveArtifact>>
  /** bumped when a chat's saved artifacts changed (artifact panel / cards refetch) */
  artifactsRev: Record<string, number>
  /** artifact the panel should open by itself (the AI started writing one, or an intro deck, a promo video or a card news
   * was saved) */
  autoOpen: { chatId: string; key: string; at: number } | null
  /** chatId -> the answer whose intro deck build already opened the panel by itself (store/deckBuilds.ts): its saved
   * deck does not open it again (the person may have closed it meanwhile) */
  buildOpened: Record<string, string>

  loadChats: (reset?: boolean) => Promise<void>
  upsertChat: (c: Chat) => void
  removeChat: (id: string) => void
  loadThread: (chatId: string) => Promise<void>
  loadOlder: (chatId: string) => Promise<void>
  /** `sent`: settles when the server took the message (rejects with its reason when it was not sent in the end); the
   * message shows as "sending" meanwhile, so most callers need not wait for it */
  send: (o: SendInput) => Promise<{ chatId: string; sent: Promise<void> }>
  resend: (chatId: string, localId: string) => Promise<void>
  discardLocal: (chatId: string, localId: string) => void
  stop: (chatId: string) => Promise<void>
  regenerate: (chatId: string, assistantId: string, engine?: { engine?: EngineId; model?: string | null }) => Promise<void>
  edit: (chatId: string, userMessageId: string, content: string, attachments: Attachment[]) => Promise<void>
  selectBranch: (chatId: string, messageId: string) => Promise<void>
  answer: (requestId: string, body: { kind: 'ask_user'; answer: string | string[] | null } | { kind: 'browser_site' | 'dev_env_site'; decision: 'once' | 'always' | 'deny' }) => Promise<void>
  /** a connect_service card's button: the server's outcome (null: the card is no longer open here). A connected or
   * skipped card closes right away (the server also closes it with turn.request.closed). */
  connect: (requestId: string, body: ConnectAction) => Promise<TurnConnectResult | null>
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
  /** messages that waited for an answer (store/sendQueue.ts): the same messages always go with the same id */
  clientMessageId?: string
  /** the server still has an answer running in this chat (409): the message is taken back instead of "not sent" */
  onConflict?: () => void
  /** a new chat is a side chat of this room (✦ Trina, components/rooms/SideChatPanel.tsx) */
  sideRoomId?: string
}

/** Sends waiting for the network to come back: localId -> body. */
const outbox = new Map<string, { chatId: string; clientMessageId: string; content: string; attachmentIds: string[]; parentId: string | undefined; engine?: EngineId; model?: string | null; firstTry: number; onConflict?: () => void }>()
/**
 * Events for messages we don't know yet (they raced the POST answer). Bounded: a message that never shows up (another
 * branch, a lost response) must not keep its events forever; the oldest entries go first, and past the per-message
 * cap the thread is simply reloaded from REST when the message appears.
 */
const pending = new Map<string, Pending>()
/**
 * chatId -> the reload of its messages that is running (one per chat at a time). Answer text, steps and new messages
 * that arrive meanwhile wait in `events` and are applied on top of the server's copy once it is in (overlap is cut by
 * offset, ws.ts); without that, each piece after the copy was read looked like a gap and started yet another reload.
 * `again`: newer data was asked for while it ran (a gap, a branch changed elsewhere, a reconnect), read once more.
 */
type Load = { promise: Promise<void>; events: ServerEvent[]; again: boolean }
const loads = new Map<string, Load>()
/** chatId -> local changes of the visible branch (a send, regenerate or edit answered, a branch switch): a reload that
 * began before one is read again instead of used (it would take the new question and answer away) */
const changes = new Map<string, number>()
const changed = (chatId: string) => changes.set(chatId, (changes.get(chatId) ?? 0) + 1)
/** a reload asked for again and again (the server keeps changing the branch) gives up after this many reads */
const LOAD_ROUNDS = 3
/** requests closed lately: a listTurnRequests answer computed before the close must not bring the card back */
const closedRequests = new Set<string>()
let generation = 0
let queueEpoch: string | null = null
const retiredEpochs = new Set<string>()
type QueueUpdate = Omit<ChatQueueSnapshot, 'epoch' | 'revision'> & { epoch?: string; revision?: number }
const queueVersions = new Map<string, QueueUpdate>()
const finishedMessages = new Set<string>()
const outputMessages = new Set<string>()
const remember = (set: Set<string>, id: string) => {
  set.add(id)
  if (set.size > 512) set.delete(set.values().next().value!)
}
const CLOSED_REQUESTS_MAX = 200
const rememberClosed = (id: string) => {
  closedRequests.add(id)
  if (closedRequests.size > CLOSED_REQUESTS_MAX) closedRequests.delete(closedRequests.values().next().value!)
}

/**
 * This chat's open cards after a listTurnRequests answer: the server's list, plus cards that arrived over the socket
 * while the request was on its way (not in `before`); cards closed meanwhile stay closed; other chats untouched.
 * `scope` is the chat's id, or which cards the list speaks for (a room's: those of my questions there, store/rooms.ts
 * loadAi with listRoomAiRequests).
 */
export function mergeOpenRequests(current: Record<string, OpenRequest>, scope: string | ((r: OpenRequest) => boolean), open: OpenRequest[], before: ReadonlySet<string>): Record<string, OpenRequest> {
  const ours = typeof scope === 'string' ? (r: OpenRequest) => r.chatId === scope : scope
  const listed = new Set(open.map((r) => r.request.requestId))
  const next: Record<string, OpenRequest> = {}
  for (const [id, r] of Object.entries(current)) if (!ours(r) || listed.has(id) || !before.has(id)) next[id] = r
  for (const r of open) if (ours(r) && !closedRequests.has(r.request.requestId)) next[r.request.requestId] = r
  return next
}
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
  others: {} as Record<string, Chat>,
  chatsCursor: null as string | null,
  chatsLoaded: false,
  threads: {} as Record<string, Thread>,
  queue: {} as Record<string, number>,
  requests: {} as Record<string, OpenRequest>,
  liveArtifacts: {} as Record<string, Record<string, LiveArtifact>>,
  artifactsRev: {} as Record<string, number>,
  autoOpen: null as ChatsState['autoOpen'],
  buildOpened: {} as Record<string, string>,
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
    load(chatId, true).catch(() => {})
  }

  /** One read of the thread from REST; false: a local change came in meanwhile, so its answer was not used. */
  const readThread = async (chatId: string): Promise<boolean> => {
    const session = generation, epoch = queueEpoch, change = changes.get(chatId) ?? 0
    // open ask_user / browser site cards come with the thread: after a reload or a resync the events that opened
    // them are not replayed, and the running turn would otherwise wait for an answer nobody can give
    const before = new Set(Object.keys(get().requests))
    const [page, open, queue] = await Promise.all([
      api.call(API.listMessages, { params: { id: chatId }, query: { limit: PAGE } }),
      api.call(API.listTurnRequests, { params: { id: chatId } }).catch(() => null),
      api.call(API.getChatQueue, { params: { id: chatId } }).catch(() => null),
    ])
    if (session !== generation) return true
    if ((changes.get(chatId) ?? 0) !== change) return false
    setThread(chatId, (t) => ({ messages: mergeFresh(t.messages, page.items), nextCursor: page.nextCursor, stale: false }))
    flushPending(chatId, page.items.map((m) => m.id))
    for (const m of thread(chatId).messages) if (m.role === 'assistant' && m.status !== 'streaming') { remember(finishedMessages, m.id); clearQueue(m.id) }
    if (queue) acceptQueue(chatId, queue, epoch)
    if (open) set((s) => ({ requests: mergeOpenRequests(s.requests, chatId, open.items, before) }))
    return true
  }

  /** Reload a chat's messages, one reload per chat at a time; `fresh`: one already running is not new enough, so it
   * reads once more when it is done (a missed piece, a reconnect). */
  const load = (chatId: string, fresh: boolean): Promise<void> => {
    const running = loads.get(chatId)
    if (running) {
      if (fresh) running.again = true
      return running.promise
    }
    const session = generation
    const l: Load = { promise: Promise.resolve(), events: [], again: false }
    loads.set(chatId, l)
    l.promise = (async () => {
      try {
        for (let round = 0; ; round++) {
          l.again = false
          const used = await readThread(chatId)
          if (session !== generation || (used && !l.again) || round + 1 >= LOAD_ROUNDS) return
        }
      } finally {
        if (loads.get(chatId) === l) loads.delete(chatId)
        // what came over the socket meanwhile, on top of the server's copy (a piece still beyond it reloads again)
        if (session === generation) for (const ev of l.events) get().handleEvent(ev)
      }
    })()
    return l.promise
  }
  /** Events of a chat whose messages are being read: kept for after (true), or not (false). */
  const held = (chatId: string, ev: ServerEvent) => {
    const l = loads.get(chatId)
    if (!l) return false
    if (l.events.length < PENDING_EVENTS_MAX) l.events.push(ev)
    else l.again = true
    return true
  }

  const clearQueue = (messageId: string) => {
    if (get().queue[messageId] === undefined) return
    set((s) => {
      const q = { ...s.queue }
      delete q[messageId]
      return { queue: q }
    })
  }

  // Socket revisions and REST snapshots share one ordering. A response from before a new epoch or logout must
  // never resurrect a completed turn or overwrite the new server's queue.
  const acceptQueue = (chatId: string, next: QueueUpdate, requestEpoch?: string | null) => {
    if (next.epoch !== undefined && next.revision !== undefined) {
      if (retiredEpochs.has(next.epoch)) return false
      if (requestEpoch !== undefined && requestEpoch !== queueEpoch && next.epoch !== queueEpoch) return false
      if (queueEpoch !== next.epoch) {
        if (queueEpoch) { remember(retiredEpochs, queueEpoch) }
        queueEpoch = next.epoch
        queueVersions.clear()
        set({ queue: {} })
      }
    }
    const previous = queueVersions.get(chatId)
    if (previous?.epoch && (next.epoch === undefined || next.revision === undefined)) return false
    if (previous?.epoch === next.epoch && previous?.revision !== undefined && next.revision !== undefined && next.revision < previous.revision) return false
    queueVersions.set(chatId, next)
    const message = next.messageId ? thread(chatId).messages.find(m => m.id === next.messageId) : undefined
    const terminal = next.messageId && (finishedMessages.has(next.messageId) || message && message.status !== 'streaming')
    const output = next.messageId && outputMessages.has(next.messageId)
    set(s => {
      const queue = { ...s.queue }
      if (previous?.messageId) delete queue[previous.messageId]
      if (next.messageId) {
        delete queue[next.messageId]
        if (!terminal && !output && next.position !== null) queue[next.messageId] = next.position
      }
      const state = terminal ? 'idle' : output ? 'running' : next.state
      const other = s.others[chatId]
      return { queue, chats: s.chats.map(c => c.id === chatId ? { ...c, runState: state } : c), ...(other ? { others: { ...s.others, [chatId]: { ...other, runState: state } } } : {}) }
    })
    return true
  }

  const afterStarted = (chatId: string, started: TurnStarted, o: { replaceId?: string; cutAt?: string }, requestEpoch: string | null) => {
    const existing = thread(chatId).messages.find(m => m.id === started.assistantMessage.id)
    if (existing && existing.status !== 'streaming') started = { ...started, assistantMessage: existing }
    else if (existing && started.assistantMessage.status === 'streaming') {
      const posted = started.assistantMessage
      const liveSteps = new Map(existing.steps.map(s => [s.id, s]))
      started = { ...started, assistantMessage: { ...posted,
        content: existing.content.length > posted.content.length && existing.content.startsWith(posted.content) ? existing.content : posted.content,
        steps: [...posted.steps.filter(s => !liveSteps.has(s.id)), ...existing.steps],
      } }
    }
    changed(chatId)
    setThread(chatId, (t) => ({ ...t, messages: mergeTurnStarted(t.messages, started, o) }))
    // text or steps that raced ahead of this response mean the turn is already running: no queue position
    const early = pending.get(started.assistantMessage.id)
    if (early?.done) remember(finishedMessages, started.assistantMessage.id)
    if (early?.deltas.length || early?.steps.length) remember(outputMessages, started.assistantMessage.id)
    flushPending(chatId, [started.assistantMessage.id, ...(started.userMessage ? [started.userMessage.id] : [])])
    acceptQueue(chatId, { state: started.queuePosition > 0 ? 'queued' : 'running', turnId: started.turnId,
      messageId: started.assistantMessage.id, position: started.queuePosition, epoch: started.queueEpoch, revision: started.queueRevision }, requestEpoch)
  }

  /** POST the message; on network failure retry with the same clientMessageId until SEND_RETRY_MS has passed. */
  const deliver = async (localId: string) => {
    const session = generation
    const job = outbox.get(localId)
    if (!job) return
    for (let attempt = 0; ; attempt++) {
      try {
        if (session !== generation || !outbox.has(localId)) return
        const epoch = queueEpoch
        const started = await api.call(API.sendMessage, {
          params: { id: job.chatId },
          body: { content: job.content, attachmentIds: job.attachmentIds, parentId: job.parentId, engine: job.engine, model: job.model, clientMessageId: job.clientMessageId },
        })
        if (session !== generation) return
        outbox.delete(localId)
        afterStarted(job.chatId, started, { replaceId: localId }, epoch)
        return
      } catch (e) {
        if (session !== generation) return
        if (isNetworkError(e) && Date.now() - job.firstTry < SEND_RETRY_MS) {
          await sleep(Math.min(8000, 1000 * 2 ** attempt))
          continue
        }
        // waiting messages sent the moment an answer ended, while another one already runs (another window or device
        // started it): they go back to waiting, nothing is lost and nothing shows as failed
        if (job.onConflict && e instanceof ApiError && e.code === 'conflict') {
          outbox.delete(localId)
          setThread(job.chatId, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== localId) }))
          job.onConflict()
          return
        }
        // team files the person attached but can no longer open: the message is marked "not sent" with the reason,
        // those files show as unavailable, and "send again" sends it without them
        const gone = e instanceof ApiError && e.body.params?.reason === 'team_files_unavailable' ? new Set(String(e.body.params.ids ?? '').split(',').filter(Boolean)) : null
        if (gone?.size) {
          job.attachmentIds = job.attachmentIds.filter((id) => !gone.has(id))
          setThread(job.chatId, (t) => ({
            ...t,
            messages: t.messages.map((m) => (m.id === localId ? { ...m, attachments: m.attachments.map((a) => (gone.has(a.id) ? { id: a.id, name: '', path: '', size: 0, mime: 'application/octet-stream', kind: 'other' as const, source: 'team' as const, unavailable: true } : a)) } : m)),
          }))
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
      generation++
      queueEpoch = null
      retiredEpochs.clear()
      queueVersions.clear()
      finishedMessages.clear()
      outputMessages.clear()
      outbox.clear()
      pending.clear()
      loads.clear()
      changes.clear()
      closedRequests.clear()
      set(initial())
    },

    async loadChats(reset = true) {
      const session = generation
      const cursor = reset ? undefined : get().chatsCursor ?? undefined
      if (!reset && !cursor) return
      const page = await api.call(API.listChats, { query: { limit: PAGE, cursor } })
      if (session !== generation) return
      set((s) => {
        const merged = reset ? page.items : [...s.chats, ...page.items.filter((c) => !s.chats.some((x) => x.id === c.id))]
        return { chats: merged, chatsCursor: page.nextCursor, chatsLoaded: true }
      })
    },

    upsertChat(c) {
      set((s) => {
        // someone else's shared chat that I have not written in is not mine to list: it is kept only while a screen
        // shows it (its thread is open), so its header and composer follow along
        if (c.shared && !c.shared.mine && !s.chats.some((x) => x.id === c.id)) return s.threads[c.id] || s.others[c.id] ? { others: { ...s.others, [c.id]: c } } : s
        const others = c.id in s.others ? Object.fromEntries(Object.entries(s.others).filter(([id]) => id !== c.id)) : s.others
        return { chats: sortChats([c, ...s.chats.filter((x) => x.id !== c.id)]), others }
      })
    },

    removeChat(id) {
      const active = queueVersions.get(id)
      if (active?.messageId) { remember(finishedMessages, active.messageId); clearQueue(active.messageId) }
      queueVersions.delete(id)
      set((s) => ({ chats: s.chats.filter((c) => c.id !== id), others: id in s.others ? Object.fromEntries(Object.entries(s.others).filter(([k]) => k !== id)) : s.others }))
    },

    loadThread(chatId) {
      return load(chatId, false)
    },

    async loadOlder(chatId) {
      const session = generation
      const cur = thread(chatId)
      if (!cur.nextCursor) return
      const page = await api.call(API.listMessages, { params: { id: chatId }, query: { limit: PAGE, cursor: cur.nextCursor } })
      if (session !== generation) return
      setThread(chatId, (t) => ({ ...t, messages: prependPage(t.messages, page.items), nextCursor: page.nextCursor }))
    },

    async send(o) {
      const session = generation
      let chatId = o.chatId
      if (!chatId) {
        const chat = await api.call(API.createChat, { body: { projectId: o.projectId ?? null, engine: o.engine, model: o.model ?? undefined, ...(o.sideRoomId ? { sideRoomId: o.sideRoomId } : {}) } })
        if (session !== generation) throw new Error('Session changed while creating the chat')
        get().upsertChat(chat)
        chatId = chat.id
        setThread(chatId, () => ({ ...emptyThread() }))
      }
      const t = thread(chatId)
      // answer under the last message we show; when nothing is loaded yet (a chat opened a moment ago), leave it to the
      // server's active leaf — null would start a new conversation at the root
      const last = t.messages.filter((m) => !m.local).at(-1)
      const localId = uuidv7()
      const clientMessageId = o.clientMessageId ?? uuidv7()
      const msg = optimisticUserMessage({ id: localId, chatId, parentId: last?.id ?? null, content: o.content, author: o.author, attachments: o.attachments, clientMessageId, now: new Date().toISOString() })
      setThread(chatId, (th) => ({ ...th, messages: [...th.messages, msg] }))
      outbox.set(localId, { chatId, clientMessageId, content: o.content, attachmentIds: o.attachments.map((a) => a.id), parentId: last?.id, engine: o.engine, model: o.model, firstTry: Date.now(), onConflict: o.onConflict })
      // the message shows as "sending" right away; a failure turns it into "not sent [send again]"
      const sent = deliver(localId)
      sent.catch(() => {})
      return { chatId, sent }
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
      const session = generation, epoch = queueEpoch
      const started = await api.call(API.regenerate, { params: { id: chatId, messageId: assistantId }, body: { engine: engine?.engine, model: engine?.model } })
      if (session === generation) afterStarted(chatId, started, { cutAt: assistantId }, epoch)
    },

    async edit(chatId, userMessageId, content, attachments) {
      const session = generation, epoch = queueEpoch
      // a team file that is no longer available stays out of the edited copy (the server would refuse it)
      const started = await api.call(API.editMessage, { params: { id: chatId, messageId: userMessageId }, body: { content, attachmentIds: attachments.filter((a) => !a.unavailable).map((a) => a.id), clientMessageId: uuidv7() } })
      if (session === generation) afterStarted(chatId, started, { cutAt: userMessageId }, epoch)
    },

    async selectBranch(chatId, messageId) {
      const session = generation
      const page = await api.call(API.selectBranch, { params: { id: chatId }, body: { messageId } })
      if (session !== generation) return
      changed(chatId)
      setThread(chatId, () => ({ messages: page.items, nextCursor: page.nextCursor, stale: false }))
    },

    async answer(requestId, body) {
      const session = generation
      const r = get().requests[requestId]
      if (!r) return
      await api.call(API.answerTurn, { params: { id: r.turnId }, body: { ...body, requestId } as never })
      if (session !== generation) return
      set((s) => {
        const next = { ...s.requests }
        delete next[requestId]
        return { requests: next }
      })
    },

    async connect(requestId, body) {
      const session = generation
      const r = get().requests[requestId]
      if (!r || r.request.kind !== 'connect_service') return null
      const res = await api.call(API.connectTurn, { params: { id: r.turnId }, body: { ...body, requestId } })
      if (session === generation && (res.state === 'connected' || res.state === 'skipped')) {
        rememberClosed(requestId)
        set((s) => {
          const next = { ...s.requests }
          delete next[requestId]
          return { requests: next }
        })
      }
      return res
    },

    async reloadAll() {
      const open = Object.keys(get().threads)
      await Promise.allSettled([get().loadChats(true), ...open.map((id) => load(id, true))])
    },

    handleEvent(ev) {
      switch (ev.type) {
        case 'message.created': {
          const { chatId, message } = ev.data
          if (held(chatId, ev) || !get().threads[chatId]) return
          const r = applyCreated(thread(chatId).messages, message)
          if (r === 'stale') markStale(chatId)
          else {
            setThread(chatId, (t) => ({ ...t, messages: r }))
            flushPending(chatId, [message.id])
          }
          return
        }
        case 'message.delta': {
          const { chatId, messageId, offset, text, reset } = ev.data
          const d = { messageId, offset, text, ...(reset ? { reset } : {}) }
          clearQueue(messageId)
          remember(outputMessages, messageId)
          if (held(chatId, ev) || !get().threads[chatId]) return
          const r = applyDelta(thread(chatId).messages, d)
          if (r.kind === 'applied') setThread(chatId, (t) => ({ ...t, messages: r.messages }))
          else if (r.kind === 'unknown') {
            const p = pendingOf(messageId)
            if (pendingFull(p)) {
              pending.delete(messageId)
              markStale(chatId)
            } else p.deltas.push(d)
          }
          else if (r.kind === 'gap') markStale(chatId)
          return
        }
        case 'message.step': {
          const { chatId, messageId, step } = ev.data
          clearQueue(messageId)
          remember(outputMessages, messageId)
          if (held(chatId, ev) || !get().threads[chatId]) return
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
          remember(finishedMessages, message.id)
          set((s) => ({ artifactsRev: { ...s.artifactsRev, [chatId]: (s.artifactsRev[chatId] ?? 0) + 1 } }))
          if (!get().threads[chatId]) { pendingOf(message.id).done = message; return }
          const r = applyDone(thread(chatId).messages, message)
          if (r) setThread(chatId, (t) => ({ ...t, messages: r }))
          else pendingOf(message.id).done = message
          return
        }
        case 'queue.position':
          acceptQueue(ev.data.chatId, { ...ev.data, state: ev.data.position > 0 ? 'queued' : 'running' })
          return
        case 'chat.updated': {
          const { chatId, change, chat } = ev.data
          // a chat in the trash is in no list, also when the end of a turn there tells about it after the delete
          if (change === 'deleted' || change === 'purged' || chat?.deletedAt) get().removeChat(chatId)
          else if (chat) get().upsertChat(chat)
          return
        }
        case 'turn.request': {
          const { turnId, chatId, messageId, request } = ev.data
          set((s) => ({ requests: { ...s.requests, [request.requestId]: { turnId, chatId, messageId, request } } }))
          return
        }
        case 'turn.request.closed':
          rememberClosed(ev.data.requestId)
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
            // the panel opens by itself when the AI starts writing (Claude parity). The team server sends no "writing"
            // previews yet, only the saved artifact: an intro deck, a promo video or a card news opens when it is saved,
            // since it is the whole answer (the welcome steps' first result and every later run, docs/DECISIONS.md "W2",
            // "V", "D2")
            // ("D2" round 2: an intro deck whose build opened the panel already does not open it again when it is saved)
            autoOpen: !prev && (d.status === 'writing' || (OPENS_BY_ITSELF.has(d.key) && !(d.key === DECK_ARTIFACT_KEY && d.messageId && s.buildOpened[d.chatId] === d.messageId))) ? { chatId: d.chatId, key: d.key, at: Date.now() } : s.autoOpen,
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
