// 내 스킬 가져오기 (docs/DECISIONS.md "W5"): a merge chat made at the end of the welcome steps (`Chat.mergeWaiting`) does
// not run by itself. Its one turn raises a save card per skill, and a card waits about ten minutes; queued at the end of
// the steps, every card would be gone (and every merge refused) by the time the owner opens the Inbox notice "합칠 스킬
// N개 확인하기". So the chat page starts it: the first time the chat is on screen in a visible window (a phone too), it
// asks the server once (POST /api/skill-shares/merge-chats/:id/start), and the cards come up while the owner looks. The
// server starts a chat once; this page never asks twice at the same time, and a hidden tab (a restored session) waits
// until it is shown.
import { useEffect } from 'react'
import type { Chat } from '@mycel/shared/api'
import { api, API } from './api'

const asking = new Set<string>()

/**
 * Start a waiting merge chat's turn. Resolves true when this call queued it, false when the server had started it
 * before (another window, a second open) or this page is already asking; rejects with the server's reason (a budget
 * used up, a full queue: the chat keeps waiting for the next open).
 */
export async function startWaitingMerge(chatId: string): Promise<boolean> {
  if (asking.has(chatId)) return false
  asking.add(chatId)
  try {
    return (await api.call(API.startSkillMerge, { params: { id: chatId } })).started
  } finally {
    asking.delete(chatId)
  }
}

/** The page is on screen (a browser's hidden tab is not; a fake or old browser without the property is). */
const visible = () => (globalThis.document as { visibilityState?: string } | undefined)?.visibilityState !== 'hidden'

/**
 * The chat page's part: while `chat` waits for its merge to start, start it as soon as the page is visible (now, or when
 * the tab is shown). `onStarted` gets the chat back from the server (no longer waiting); `onError` the reason.
 */
export function useWaitingMerge(chat: Pick<Chat, 'id' | 'mergeWaiting' | 'deletedAt'> | null, on: { started: (chatId: string) => void; error: (e: unknown) => void }): void {
  const id = chat && chat.mergeWaiting && !chat.deletedAt ? chat.id : null
  useEffect(() => {
    if (!id) return
    let live = true
    const go = () => {
      if (!visible()) return
      startWaitingMerge(id).then(() => { if (live) on.started(id) }, (e) => { if (live) on.error(e) })
    }
    go()
    const doc = globalThis.document
    doc?.addEventListener?.('visibilitychange', go)
    return () => {
      live = false
      doc?.removeEventListener?.('visibilitychange', go)
    }
    // the handlers are the page's, read when called
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
}
