// The line above a shared chat's message box about someone else's turn or card. It says what Send does now: while their
// answer runs, a message waits for it; on a card kept after their answer ended nothing runs, so a message goes at once.
import type { Chat } from '@mycel/shared/api'

type Note = { key: 'chat.sharedWaiting' | 'chat.sharedBusy' | 'chat.sharedWaitingCanSend'; name: string }
export function sharedNote(chat: Pick<Chat, 'waitsFor' | 'shared'> | null | undefined): Note | null {
  const turn = chat?.shared?.answering
  if (turn) return { key: turn.waiting ? 'chat.sharedWaiting' : 'chat.sharedBusy', name: turn.name }
  return chat?.waitsFor ? { key: 'chat.sharedWaitingCanSend', name: chat.waitsFor } : null
}
