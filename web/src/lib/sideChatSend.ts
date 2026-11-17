// Where one click sends an answer of a room's Trina side chat (components/rooms/SendHere.tsx; docs/DECISIONS.md "Trina
// side chat: send here"). A question about a room message carries that message's thread in its quote's header
// (shared rooms.ts threadRefToken, written by components/rooms/SideChatPanel.tsx withQuote). An answer goes to the thread
// named by the nearest earlier question on its branch that quotes something: a follow-up without a quote ("더 짧게")
// keeps the thread; a question quoting a file, or a message that cannot have a thread, sends to the room. A question
// asked with the box's "Looking at this thread" chip on starts with a thread line (shared rooms.ts threadLineOf): its
// answer goes to that thread, and the line counts for that question only (a later one without it was asked with the
// chip off: the room). A chat whose
// questions carry no token (older ones) sends to the room only: nothing is guessed from a quote's text. Read from the
// messages themselves, so it is the same after a reload, from 🕘, as a full chat (↗) and after regenerate. No React, no
// requests: test/unit/side-chat-send.test.tsx.
import { hideThreadRef, quotesRoom, threadLineOf, threadRefOf, threadRefToken } from '@mycel/shared/api'

/** A thread an answer goes to, and the message asked about as the question quoted it (who · when, its lines) */
export interface SendTarget { rootId: string; head: string; text: string }

/** Does the question start with a quote (a message or a file of the room asked about)? One rule with the server's
 * post_to_room (shared rooms.ts quotesRoom, nearestThreadOf). */
export const quotes = quotesRoom

/** The quote at the top of a question, as people read it: its header line without the token, then its lines; null when
 * it starts with none. */
export function quotedOf(content: string): { head: string; text: string } | null {
  if (!quotes(content)) return null
  const lines: string[] = []
  for (const l of hideThreadRef(content).split('\n')) {
    if (!l.startsWith('>')) break
    lines.push(l.replace(/^> ?/, ''))
  }
  const [head = '', ...rest] = lines
  return { head, text: rest.join('\n') }
}

/** Each answer's target (null: the room), by its id, for one branch of a chat in order (the visible messages). */
export function sendTargets(messages: readonly { id: string; role: string; content: string }[]): Map<string, SendTarget | null> {
  const out = new Map<string, SendTarget | null>()
  let current: SendTarget | null = null
  /** `current` came from a thread line: it holds for that question's answers only */
  let once = false
  for (const m of messages) {
    if (m.role === 'user') {
      if (!quotes(m.content)) {
        if (once) current = null
        once = false
        continue
      }
      const rootId = threadRefOf(m.content)
      const line = threadLineOf(m.content)
      const q = quotedOf(m.content)!
      // (a thread line's header starts with its mark, which is not part of who started it)
      current = rootId ? { rootId, head: line ? [line.author, line.at].filter(Boolean).join(' · ') : q.head, text: q.text } : null
      once = !!line
    } else out.set(m.id, current)
  }
  return out
}

/** An edited question (the box showed it without the token): its quote's thread back on while the quote's header line is
 * still the first line as it was; a quote taken out or rewritten leaves it out (its answers then go to the room). A
 * question with a thread line was edited without it (shownQuestion): the line goes back on top as it was. */
export function keepThreadRef(edited: string, original: string): string {
  const line = threadLineOf(original)
  if (line) return `${line.line}\n\n${edited}`
  const rootId = threadRefOf(original)
  if (!rootId || threadRefOf(edited)) return edited
  const head = hideThreadRef(original).split('\n')[0]!
  const at = edited.indexOf('\n')
  const first = at < 0 ? edited : edited.slice(0, at)
  return first === head ? first + threadRefToken(rootId) + edited.slice(first.length) : edited
}

/** A question as the person copies or edits it: without its quote's thread token, and without a thread line (the app
 * put that there, they did not type it). */
export const shownQuestion = (content: string): string => threadLineOf(content)?.question ?? hideThreadRef(content)
