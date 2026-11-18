// A running answer of a shared chat, live for the others who see the chat (docs/decisions/
// 20261118-shared-chat-live-answers.md, QA TC-4961). The person whose turn it is gets every event as before. Everyone
// else who sees the chat now gets the answer's text as it is written and its steps as the finished answer shows them to
// them (ChatStore.viewSteps: a line names its paths only to a viewer who may see them all, no step detail, no card's
// answer, no record of a post or a share), and the finished message as the API gives it to them (messageFor). Nobody
// gets it whom the answer is hidden from (chat/shared-answers.ts: a connected service's answer a later joiner may not
// see), nobody who stopped seeing the chat, and never a card, a queue position, a busy notice, usage or a failure's
// reason: those stay with the person of the turn (chat/turn.ts sends them to `spec.userId` only).
//
// The others' text is a copy of its own (OthersText): the asker's stream is let out with a short hold for a secret's
// written forms (RedactingText), but an HTML entity form padded with zeros can be longer than that hold (security
// review of #1311). The others get the text only up to the last character no written form of a stored secret is made
// of, each part redacted as a whole, and nothing more of it live once that held run passes OTHERS_HOLD_MAX (the end
// brings the answer). The REST read of a running answer gives them the same copy.
//
// Live events go only to people with a window open (Hub.publishOpen, each frame's data serialized once); anyone else
// reads the chat over REST when they open it.
//
// Who gets it is worked out again at most every LIVE_VIEWERS_MS, at once after the answer's read record changes
// (TurnExec.noteSharedReads), after every access change (admin/folders.ts afterAccessChange, ChatRuntime.stopUserTurnsIn)
// and when an account is turned off (stopUserTurns); only among the people who saw the chat when its first piece went
// out. A check that fails gives nobody (fails closed).
import type { MessageStatus, Step } from '@mycel/shared/api'
import { personLocale } from '../files/media-text'
import { formRunLength, type Redactor } from '../integrations/connections/redact'
import type { ChatRuntime } from './runtime'
import { Audiences, isSharedRow, messageFor, messageView } from './shared'
import { AnswerSight } from './shared-answers'
import type { MessageView, StoredStep } from './store'

/** How long a list of live viewers is used before it is worked out again (who sees the chat, the answer's record). */
export const LIVE_VIEWERS_MS = 1000
/** The longest run at the end of the answer held back from the others; past it nothing more goes to them live. */
export const OTHERS_HOLD_MAX = 64 * 1024

/** Someone else who sees the chat and the answer now, with how they see its messages. */
export interface LiveViewer { id: string; view: MessageView }

/**
 * The asker's answer text as the others may get it while it runs: up to the last character no written form of a stored
 * secret of the asker's is made of (redact.ts formRunLength: no length cap, unlike the asker's own stream), each part
 * redacted whole. A form never crosses that point (it is made only of those characters), so the parts may be redacted
 * one after the other. Built again from the start when the text before the point changes (a refused attempt's text
 * dropped) or the redactor changes (a token refreshed). Closed for good when the held run passes OTHERS_HOLD_MAX, or
 * when the redactor withholds everything: the others get nothing more until the end.
 */
export class OthersText {
  private raw = ''
  private safe = ''
  private by: Redactor | null = null
  private closed = false
  constructor(private redactor: () => Redactor) {}

  of(content: string): string {
    if (this.closed) return this.safe
    let r: Redactor
    try { r = this.redactor() } catch { this.closed = true; return this.safe }
    if (r.withheld) { this.closed = true; return this.safe }
    if (r !== this.by || !content.startsWith(this.raw)) { this.raw = ''; this.safe = ''; this.by = r }
    if (!r.res.length) { this.raw = content; this.safe = content; return content }
    const tail = formRunLength(content, r.values)
    if (tail > OTHERS_HOLD_MAX) { this.closed = true; return this.safe }
    const cut = content.length - tail
    if (cut > this.raw.length) {
      this.safe += r.hide(content.slice(this.raw.length, cut))
      this.raw = content.slice(0, cut)
    }
    return this.safe
  }
}

export class LiveAnswer {
  private kept: { at: number; viewers: LiveViewer[] } | null = null
  /** who saw the chat when the answer's first piece went out: someone who starts seeing it later gets the answer at its
   * end (message.done, as they may see it then) and over REST, never part of it live. So a person the answer becomes
   * hidden from later (a card's audience they were not in) never holds pieces of it they would then keep */
  private first: Set<string> | null = null
  /** the others' copy of the text, and what of it went out */
  readonly others: OthersText
  private sent = ''
  constructor(private rt: ChatRuntime, private chatId: string, private messageId: string, private turnId: string, private runner: string, redactor: () => Redactor, private now: () => number = () => performance.now()) {
    this.others = new OthersText(redactor)
  }

  /** Work the viewers out again at the next event. */
  forget() { this.kept = null }

  /** The others who see this answer now (not the person of the turn). One read of the chat's records for all of them. */
  viewers(): LiveViewer[] {
    const at = this.now()
    if (this.kept && at - this.kept.at < LIVE_VIEWERS_MS) return this.kept.viewers
    let viewers: LiveViewer[] = []
    try {
      const chat = this.rt.store.chatRow(this.chatId)
      if (chat && !chat.deleted_at && isSharedRow(chat)) {
        const sight = new AnswerSight(this.rt.db, this.rt.files)
        for (const id of new Set(new Audiences(this.rt.db, this.rt.files).ofChat(chat))) {
          if (id === this.runner || (this.first && !this.first.has(id))) continue
          // an answer hidden from them: nothing of it
          if (sight.withheld(this.chatId, id).has(this.messageId)) continue
          const view = messageView(this.rt, chat, id, personLocale(this.rt.db, id))
          if (!view) continue
          viewers.push({ id, view: { ...view, runner: false } })
        }
        this.first ??= new Set(viewers.map((v) => v.id))
      }
    } catch (err) {
      this.rt.log.warn('live viewers of a shared answer not worked out', { err, turn: this.turnId })
      viewers = []
    }
    this.kept = { at, viewers }
    return viewers
  }

  /** The asker's text changed (grew, or a part was dropped): the others get their copy's change, as a reset when text
   * they already have changed. */
  text(content: string) {
    const safe = this.others.of(content)
    const sent = this.sent
    if (safe === sent) return
    this.sent = safe
    const base = { chatId: this.chatId, messageId: this.messageId }
    let data
    if (safe.startsWith(sent)) data = { ...base, offset: sent.length, text: safe.slice(sent.length) }
    else {
      let k = 0
      while (k < sent.length && k < safe.length && sent[k] === safe[k]) k++
      data = { ...base, offset: k, text: safe.slice(k), reset: true as const }
    }
    const ids = this.viewers().map((v) => v.id)
    if (ids.length) this.rt.hub.publishOpen(ids, { type: 'message.delta', data })
  }

  /** A step started, changed or ended, as each viewer sees it in the finished answer (viewers who see it alike share one
   * frame's data). */
  step(stored: StoredStep) {
    const groups = new Map<string, { step: Step; ids: string[] }>()
    for (const v of this.viewers()) {
      if (!this.rt.hub.hasOpenWindow(v.id)) continue
      let step: Step | undefined
      try { step = this.rt.store.viewSteps({ chat_id: this.chatId, turn_id: this.turnId }, [stored], v.view)[0] } catch { step = undefined }
      if (!step) continue
      const k = JSON.stringify(step)
      const g = groups.get(k)
      if (g) g.ids.push(v.id)
      else groups.set(k, { step, ids: [v.id] })
    }
    for (const g of groups.values()) this.rt.hub.publishOpen(g.ids, { type: 'message.step', data: { chatId: this.chatId, messageId: this.messageId, step: g.step } })
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
