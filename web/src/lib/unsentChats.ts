// A chat's messages on their way or not sent, kept on this device per person and chat (QA TC-r2d-06): a reload, or
// the app closed while offline, does not lose them. The chat opened again puts them back on screen; the ones still on
// their way go by themselves with the same clientMessageId (the server keeps the first one, so a send it did get comes
// back as that message, never a second one), the ones that did not go show "not sent [send again]". Sent or let go:
// gone from here too. Signing out clears them with the drafts (lib/localData.ts clearLocalData).
import type { Attachment, EngineId } from '@mycel/shared/api'
import { readDraft, writeDraft } from './localData'

/** older than this: not put back (a message from a month ago is no longer what the person meant to say now) */
export const UNSENT_CHAT_DAYS = 30

export interface KeptChatSend {
  localId: string
  clientMessageId: string
  content: string
  attachments: Attachment[]
  /** the message it answered under when it was written (sent again: under the newest end of that branch) */
  parentId?: string
  after?: string
  engine?: EngineId
  model?: string | null
  author: { id: string; name: string }
  createdAt: string
  /** it did not go (the server said no, or the connection stayed down after it was back): "send again" */
  failed?: true
  error?: string
}

type Store = Parameters<typeof readDraft>[2]
const storeId = (chatId: string) => `chatUnsent:${chatId}`

const isKept = (x: unknown): x is KeptChatSend => {
  const p = x as KeptChatSend
  return !!p && typeof p === 'object' && typeof p.localId === 'string' && typeof p.clientMessageId === 'string' && typeof p.content === 'string'
    && Array.isArray(p.attachments) && typeof p.createdAt === 'string' && !!p.author && typeof p.author.id === 'string' && typeof p.author.name === 'string'
}
const fresh = (p: KeptChatSend, now: number) => Date.parse(p.createdAt) > now - UNSENT_CHAT_DAYS * 86_400_000

export function readUnsentChat(userId: string, chatId: string, s?: Store, now = Date.now()): KeptChatSend[] {
  try {
    const v = JSON.parse(readDraft(userId, storeId(chatId), s) || '[]') as unknown
    return Array.isArray(v) ? v.filter(isKept).filter((p) => fresh(p, now)) : []
  } catch { return [] }
}

export function writeUnsentChat(userId: string, chatId: string, list: KeptChatSend[], s?: Store) {
  const sorted = [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  writeDraft(userId, storeId(chatId), sorted.length ? JSON.stringify(sorted) : '', s)
}
