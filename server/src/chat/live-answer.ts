// A running answer of a shared chat, live for the others who see the chat (docs/decisions/
// 20261118-shared-chat-live-answers.md, QA TC-4961). The person whose turn it is gets every event as before. Everyone
// else who sees the chat now gets the answer's text as it is written and its steps as the finished answer shows them to
// them (ChatStore.viewSteps: a line names its paths only to a viewer who may see them all, no step detail, no card's
// answer, no record of a post or a share), and the finished message as the API gives it to them (messageFor). Nobody
// gets it whom the answer is hidden from (chat/shared-answers.ts: a connected service's answer a later joiner may not
// see), nobody who stopped seeing the chat, and never a card, a queue position, a busy notice, usage or a failure's
// reason: those stay with the person of the turn (chat/turn.ts sends them to `spec.userId` only).
//
// Who gets it is worked out again at most every LIVE_VIEWERS_MS, at once after the answer's read record changes
// (TurnExec.noteSharedReads) and when someone stops seeing the chat (ChatRuntime.stopUserTurnsIn, from every access
// change). A check that fails gives nobody (fails closed).
import type { MessageStatus, Step } from '@mycel/shared/api'
import { personLocale } from '../files/media-text'
import type { ChatRuntime } from './runtime'
import { Audiences, isSharedRow, messageFor, messageView } from './shared'
import type { MessageView, StoredStep } from './store'

/** How long a list of live viewers is used before it is worked out again (who sees the chat, the answer's record). */
export const LIVE_VIEWERS_MS = 1000

/** Someone else who sees the chat and the answer now, with how they see its messages. */
export interface LiveViewer { id: string; view: MessageView }

export class LiveAnswer {
  private kept: { at: number; viewers: LiveViewer[] } | null = null
  constructor(private rt: ChatRuntime, private chatId: string, private messageId: string, private turnId: string, private runner: string, private now: () => number = () => performance.now()) {}

  /** Work the viewers out again at the next event. */
  forget() { this.kept = null }

  /** The others who see this answer now (not the person of the turn). */
  viewers(): LiveViewer[] {
    const at = this.now()
    if (this.kept && at - this.kept.at < LIVE_VIEWERS_MS) return this.kept.viewers
    let viewers: LiveViewer[] = []
    try {
      const chat = this.rt.store.chatRow(this.chatId)
      if (chat && !chat.deleted_at && isSharedRow(chat)) {
        for (const id of new Set(new Audiences(this.rt.db, this.rt.files).ofChat(chat))) {
          if (id === this.runner) continue
          const view = messageView(this.rt, chat, id, personLocale(this.rt.db, id))
          // a chat of one person has no view (nobody else); an answer hidden from them: nothing of it
          if (!view || view.withheld?.(this.messageId) !== false) continue
          viewers.push({ id, view: { ...view, runner: false } })
        }
      }
    } catch (err) {
      this.rt.log.warn('live viewers of a shared answer not worked out', { err, turn: this.turnId })
      viewers = []
    }
    this.kept = { at, viewers }
    return viewers
  }

  /** The answer's text from `offset` on (`reset`: what was there from `offset` on is gone first). */
  text(offset: number, text: string, reset = false) {
    for (const v of this.viewers()) this.rt.hub.publish(v.id, { type: 'message.delta', data: { chatId: this.chatId, messageId: this.messageId, offset, text, ...(reset ? { reset: true as const } : {}) } })
  }

  /** A step started, changed or ended, as each viewer sees it in the finished answer. */
  step(stored: StoredStep) {
    for (const v of this.viewers()) {
      let step: Step | undefined
      try { step = this.rt.store.viewSteps({ chat_id: this.chatId, turn_id: this.turnId }, [stored], v.view)[0] } catch { step = undefined }
      if (step) this.rt.hub.publish(v.id, { type: 'message.step', data: { chatId: this.chatId, messageId: this.messageId, step } })
    }
  }
}

/**
 * The end of an answer of a shared chat for everyone else who sees the chat now: the message as the API gives it to
 * each of them (an answer hidden from them: its place alone). Nothing for a chat of one person.
 */
export function publishDoneToOthers(rt: ChatRuntime, chatId: string, messageId: string, runner: string, status: MessageStatus) {
  const chat = rt.store.chatRow(chatId)
  if (!chat || chat.deleted_at || !isSharedRow(chat)) return
  const row = rt.store.messageRow(messageId)
  if (!row) return
  for (const id of new Set(new Audiences(rt.db, rt.files).ofChat(chat))) {
    if (id === runner) continue
    try {
      const message = messageFor(rt, chat, row, id, personLocale(rt.db, id))
      rt.hub.publish(id, { type: 'message.done', data: { chatId, messageId, status, message } })
    } catch (err) { rt.log.warn('the end of a shared answer not sent to a viewer', { err, chat: chatId }) }
  }
}
