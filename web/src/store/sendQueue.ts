// Messages a person sent while an answer was still running, per chat (lib/sendQueue.ts has the rules). Kept in
// this browser's storage (per person, cleared at sign-out with the drafts), so a reload, a phone app sent to the
// background or a second window of the same chat sees the same waiting messages.
//
// A runner looks at every chat with waiting messages whenever the chats store or this one changes: when the
// answer has ended, the waiting messages go out together through the normal send (same permission checks, same
// "not sent [send again]" on a failure); a stopped or failed answer pauses them until "Send now".
import { create } from 'zustand'
import { uuidv7, type Attachment } from '@mycel/shared/api'
import { awaitedAnswer, combine, combinedClientId, emptyQueue, nextStep, parseQueue, QUEUE_ITEMS_MAX, QUEUE_KEY_PREFIX, queueKey, restoredQueue, serializeQueue, type ChatQueue, type QueuedMessage, type QueuePause } from '../lib/sendQueue'
import { useChats } from './chats'

export class QueueFull extends Error {
  constructor() {
    super('too many waiting messages')
    this.name = 'QueueFull'
  }
}

export interface NewQueued { content: string; attachments: Attachment[]; author: { id: string; name: string } }

interface SendQueueState {
  userId: string | null
  queues: Record<string, ChatQueue>
  /** the waiting message being edited in this window (nothing is sent meanwhile) */
  editing: Record<string, string | null>
  enqueue: (userId: string, chatId: string, m: NewQueued) => void
  remove: (chatId: string, id: string) => void
  update: (chatId: string, id: string, content: string) => void
  setEditing: (chatId: string, id: string | null) => void
  /** send the waiting messages now (paused queue), with `extra` (a message just typed) after them */
  sendNow: (chatId: string, extra?: NewQueued) => void
  /** the chat was opened: its waiting messages from this browser's storage, if any */
  restore: (userId: string, chatId: string) => void
  reset: () => void
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const storage = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
/** chats whose last write to storage failed (full): this window's copy is the truth for them until a write works */
const memoryOnly = new Set<string>()
/** what is stored for the chat (null: nothing; undefined: no storage in this browser, or only this window's copy) */
function readStored(userId: string, chatId: string): ChatQueue | null | undefined {
  const s = storage()
  if (!s || memoryOnly.has(queueKey(userId, chatId))) return undefined
  try {
    return parseQueue(s.getItem(queueKey(userId, chatId)))
  } catch {
    return undefined
  }
}
function writeStored(userId: string, chatId: string, q: ChatQueue) {
  const key = queueKey(userId, chatId)
  const s = storage()
  if (!s) return
  try {
    if (q.items.length) s.setItem(key, serializeQueue(q))
    else s.removeItem(key)
    memoryOnly.delete(key)
  } catch {
    // storage full or blocked: this window still has them. The older stored copy must not come back as the truth
    // (it lacks the newest message) in this window, another one or after a reload.
    memoryOnly.add(key)
    try { s.removeItem(key) } catch { /* blocked */ }
  }
}

/** chats whose waiting messages are being handed to send() right now */
const flushing = new Set<string>()
/** a chat whose send met a running answer (409): left alone for a moment while its state is reloaded */
const holdUntil = new Map<string, number>()
const HOLD_MS = 2000

export const useSendQueue = create<SendQueueState>((set, get) => {
  /** The chat's queue as it is now: the stored one is the truth (another window may have changed it), else ours. */
  const current = (chatId: string): ChatQueue => {
    const { userId, queues } = get()
    const stored = userId ? readStored(userId, chatId) : undefined
    // no storage in this browser (private mode, blocked): this window's copy is all there is
    if (stored === undefined) return queues[chatId] ?? emptyQueue()
    return stored ?? emptyQueue()
  }
  const put = (chatId: string, q: ChatQueue) => {
    const userId = get().userId
    if (userId) writeStored(userId, chatId, q)
    set((s) => {
      const queues = { ...s.queues }
      if (q.items.length) queues[chatId] = q
      else delete queues[chatId]
      const editing = q.items.some((i) => i.id === s.editing[chatId]) ? s.editing : { ...s.editing, [chatId]: null }
      return { queues, editing }
    })
  }
  /** Hand the waiting messages that fit into one message to the normal send. */
  function flush(chatId: string) {
    const q = current(chatId)
    if (!q.items.length || flushing.has(chatId)) return
    const { take, content, attachments } = combine(q.items)
    flushing.add(chatId)
    try {
      put(chatId, { items: q.items.slice(take.length), paused: null, after: null })
      // send() puts the message on screen as "sending" before it returns: from then on the chat is busy and the runner
      // waits (a failure shows "not sent [send again]" on that message, so nothing disappears)
      void useChats.getState().send({ chatId, content, attachments, author: take[0]!.author, clientMessageId: combinedClientId(take), onConflict: () => takeBack(chatId, take) }).catch(() => {})
    } finally {
      flushing.delete(chatId)
    }
  }

  /** The server still runs an answer in the chat: the messages wait again, in front of anything queued since. */
  function takeBack(chatId: string, take: QueuedMessage[]) {
    const q = current(chatId)
    const ids = new Set(q.items.map((i) => i.id))
    put(chatId, { ...q, items: [...take.filter((i) => !ids.has(i.id)), ...q.items], paused: null })
    holdUntil.set(chatId, Date.now() + HOLD_MS)
    setTimeout(schedule, HOLD_MS + 50)
    void useChats.getState().loadThread(chatId).catch(() => {})
  }

  return {
    userId: null,
    queues: {},
    editing: {},

    enqueue(userId, chatId, m) {
      if (get().userId !== userId) set({ userId, queues: {}, editing: {} })
      const q = current(chatId)
      if (q.items.length >= QUEUE_ITEMS_MAX) throw new QueueFull()
      const thread = useChats.getState().threads[chatId]
      const item: QueuedMessage = { id: uuidv7(), content: m.content, attachments: m.attachments, author: m.author, createdAt: new Date().toISOString() }
      // a message added while an answer runs means "send when it is done" for everything waiting (a pause ends)
      put(chatId, { items: [...q.items, item], paused: null, after: (thread ? awaitedAnswer(thread.messages) : null) ?? q.after })
    },

    remove(chatId, id) {
      const q = current(chatId)
      put(chatId, { ...q, items: q.items.filter((i) => i.id !== id) })
    },

    update(chatId, id, content) {
      const q = current(chatId)
      put(chatId, { ...q, items: q.items.map((i) => (i.id === id ? { ...i, content } : i)) })
    },

    setEditing(chatId, id) {
      set((s) => ({ editing: { ...s.editing, [chatId]: id } }))
    },

    sendNow(chatId, extra) {
      const q = current(chatId)
      const items = extra ? [...q.items, { id: uuidv7(), ...extra, createdAt: new Date().toISOString() }] : q.items
      if (!items.length) return
      put(chatId, { ...q, items, paused: null })
      holdUntil.delete(chatId)
      flush(chatId)
    },

    restore(userId, chatId) {
      if (get().userId !== userId) set({ userId, queues: {}, editing: {} })
      if (get().queues[chatId]?.items.length) return // this window already has them (and knows their state)
      const stored = readStored(userId, chatId)
      if (!stored) return
      const thread = useChats.getState().threads[chatId]
      if (!thread) return
      put(chatId, restoredQueue(stored, thread.messages))
    },

    reset() {
      flushing.clear()
      holdUntil.clear()
      memoryOnly.clear()
      set({ userId: null, queues: {}, editing: {} })
    },
  }
})

/** What every chat with waiting messages does now (nextStep); runs after each change of either store. */
function pump() {
  const s = useSendQueue.getState()
  for (const [chatId, q] of Object.entries(s.queues)) {
    if (!q.items.length || q.paused || s.editing[chatId] || flushing.has(chatId) || (holdUntil.get(chatId) ?? 0) > Date.now()) continue
    const thread = useChats.getState().threads[chatId]
    if (!thread) continue
    const step = nextStep(thread.messages)
    if (step === 'wait') {
      // remember which answer they wait for, so a reload can tell whether it ended meanwhile (restoredQueue)
      const awaited = awaitedAnswer(thread.messages)
      if (awaited && awaited !== q.after) {
        const next = { ...q, after: awaited }
        if (s.userId) writeStored(s.userId, chatId, next)
        useSendQueue.setState((st) => ({ queues: { ...st.queues, [chatId]: next } }))
      }
      continue
    }
    if (step === 'send') useSendQueue.getState().sendNow(chatId)
    else pause(chatId, step.pause)
  }
}

function pause(chatId: string, why: QueuePause) {
  const s = useSendQueue.getState()
  const q = s.queues[chatId]
  if (!q || q.paused === why) return
  const next = { ...q, paused: why }
  if (s.userId) writeStored(s.userId, chatId, next)
  useSendQueue.setState((st) => ({ queues: { ...st.queues, [chatId]: next } }))
}

let scheduled = false
function schedule() {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    pump()
  })
}
useChats.subscribe(schedule)
useSendQueue.subscribe(schedule)

// another window of this browser changed a chat's waiting messages (sent them, removed or edited one)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    const { userId, queues } = useSendQueue.getState()
    if (!userId || !e.key?.startsWith(`${QUEUE_KEY_PREFIX}${userId}:`)) return
    const chatId = e.key.slice(`${QUEUE_KEY_PREFIX}${userId}:`.length)
    if (!queues[chatId] && !useChats.getState().threads[chatId]) return
    const q = parseQueue(e.newValue)
    useSendQueue.setState((st) => {
      const next = { ...st.queues }
      if (q) next[chatId] = q
      else delete next[chatId]
      return { queues: next }
    })
  })
}

/** The person's waiting messages in a chat (empty list when none). */
export const useQueued = (chatId: string) => useSendQueue((s) => s.queues[chatId])
