// Messages a person sends while an answer is still running ("waiting to send", like Claude Code's queued input).
// Pure helpers, no React and no network (unit-tested in test/unit/send-queue.test.ts): what a chat's waiting
// messages should do now, how several go out together as one message, and how they are kept in this browser.
//
// The queue lives in the browser (docs/DECISIONS.md "Messages typed during an answer"): the server still refuses a
// second turn in a chat (409), and nothing waiting reaches it before the running answer has ended. What to do is
// decided from the visible branch alone, so a reconnect, a reload or a missed event cannot lose the moment.
import { z } from 'zod'
import { Attachment, MESSAGE_ATTACHMENTS_MAX, type Attachment as AttachmentT } from '@mycel/shared/api'
import type { ViewMessage } from '../store/thread'

/** SendMessageBody.content's limit: waiting messages that would go over it wait for the next answer. */
export const QUEUE_CONTENT_MAX = 200_000
/** At most this many waiting messages per chat (the composer says so and keeps the text). */
export const QUEUE_ITEMS_MAX = 10

export interface QueuedMessage {
  /** uuidv7; also the start of the clientMessageId the combined message is sent with */
  id: string
  content: string
  attachments: AttachmentT[]
  author: { id: string; name: string }
  createdAt: string
}
/** stopped: the person stopped the answer; error: the answer or a send failed; away: the answer ended while this
 * page was not open (or something else happened in the chat since). Each waits for "Send now". */
export type QueuePause = 'stopped' | 'error' | 'away'
export interface ChatQueue {
  items: QueuedMessage[]
  paused: QueuePause | null
  /** the answer the messages wait for (the running answer when they were queued): a reload finds out whether that
   * answer ended meanwhile with nothing else in between, and only then still sends by itself */
  after: string | null
}
export const emptyQueue = (): ChatQueue => ({ items: [], paused: null, after: null })

export type QueueStep = 'wait' | 'send' | { pause: 'stopped' | 'error' }

/**
 * What the waiting messages of a chat do now, from its visible branch:
 * - an answer is running, queued at the server, or a message of ours is still on its way: wait;
 * - the last answer finished (also when it paused at the per-answer limit: the AI is told so with the next message): send;
 * - the person stopped the answer: pause, keep them, offer "Send now";
 * - the answer failed, or a send failed ("not sent"): pause the same way (the cause may still be there).
 */
export function nextStep(messages: readonly ViewMessage[]): QueueStep {
  if (messages.some((m) => m.local?.state === 'sending')) return 'wait'
  const last = messages.at(-1)
  if (!last) return 'send'
  if (last.local) return { pause: 'error' }
  if (last.role !== 'assistant' || last.status === 'streaming') return 'wait'
  if (last.status === 'stopped') return { pause: 'stopped' }
  if (last.status === 'error') return { pause: 'error' }
  return 'send'
}

/** The running answer the messages wait for, when one is visible. */
export const awaitedAnswer = (messages: readonly ViewMessage[]): string | null => {
  const last = messages.at(-1)
  return last && !last.local && last.role === 'assistant' && last.status === 'streaming' ? last.id : null
}

/**
 * The waiting messages that go out now, oldest first, as ONE message (texts joined by a blank line, attachments
 * together): like Claude Code, what was typed during an answer reaches the AI together when it is free. Messages
 * that would take it past the attachment or length limit stay for the next answer; the first always goes.
 */
export function combine(items: readonly QueuedMessage[]): { take: QueuedMessage[]; content: string; attachments: AttachmentT[] } {
  const take: QueuedMessage[] = []
  const attachments: AttachmentT[] = []
  let length = 0
  for (const it of items) {
    const have = new Set(attachments.map((a) => a.id))
    const add = it.attachments.filter((a) => !have.has(a.id))
    const extra = it.content.trim() ? it.content.length + (length ? 2 : 0) : 0
    if (take.length && (attachments.length + add.length > MESSAGE_ATTACHMENTS_MAX || length + extra > QUEUE_CONTENT_MAX)) break
    take.push(it)
    attachments.push(...add)
    length += extra
  }
  return { take, content: take.map((i) => i.content).filter((c) => c.trim()).join('\n\n'), attachments }
}

/** The clientMessageId of a combined send: the same messages give the same id, so two windows sending the same
 * queue at once make one message (the server answers a repeated id with the first result). */
export const combinedClientId = (take: readonly QueuedMessage[]) => `${take[0]!.id}.${take.length}`

/**
 * A queue read back after the page was opened again: it still sends by itself only while its answer runs, or when
 * the answer it waited for is the newest message (it ended meanwhile, nothing else happened). Otherwise it waits
 * for "Send now", so a message typed long ago never drops into a conversation that has moved on.
 */
export function restoredQueue(stored: ChatQueue, messages: readonly ViewMessage[]): ChatQueue {
  if (!stored.items.length || stored.paused) return stored
  if (nextStep(messages) === 'wait') return stored
  if (stored.after && messages.at(-1)?.id === stored.after) return stored
  return { ...stored, paused: 'away' }
}

// ---------------- kept in this browser ----------------
const PREFIX = 'mycel.queue:'
export const QUEUE_KEY_PREFIX = PREFIX
export const queueKey = (userId: string, chatId: string) => `${PREFIX}${userId}:${chatId}`

const Stored = z.object({
  v: z.literal(1),
  items: z.array(z.object({
    id: z.string().min(8).max(40),
    content: z.string().max(QUEUE_CONTENT_MAX),
    attachments: z.array(Attachment).max(MESSAGE_ATTACHMENTS_MAX),
    author: z.object({ id: z.string().max(200), name: z.string().max(500) }),
    createdAt: z.string().max(40),
  })).max(QUEUE_ITEMS_MAX),
  paused: z.enum(['stopped', 'error', 'away']).nullable(),
  after: z.string().max(64).nullable(),
})

/** A stored queue, or null when there is none (or it is not ours: wrong shape, too big). */
export function parseQueue(raw: string | null): ChatQueue | null {
  if (!raw) return null
  try {
    const r = Stored.safeParse(JSON.parse(raw))
    return r.success && r.data.items.length ? { items: r.data.items, paused: r.data.paused, after: r.data.after } : null
  } catch {
    return null
  }
}
export const serializeQueue = (q: ChatQueue) => JSON.stringify({ v: 1, items: q.items, paused: q.paused, after: q.after })
