// The stored secrets of a person's connections, kept out of what the server itself sends and saves for them (QA INT-13,
// B-W5-4; docs/DECISIONS.md "No stored key in the answer"). hide.ts hides them in what a service sends back; the AI
// can still repeat a value it read in the person's message ("the string you sent (…) matched the stored key"). So
// the turn's own outgoing text goes through one redactor too: the streamed answer and the saved answer (one stream,
// below), the steps, the audit lines (tool_events) and the chat title. The person's own message is kept as typed
// (the AI's history needs it).
import type { AppContext } from '../../context'
import { HIDDEN, secretRegex, secretValuesOf } from './hide'
import { integrationsOf } from './service'

export interface Redactor {
  /** the text with every form of every value replaced by HIDDEN */
  hide(text: string): string
  /** the values (for the stream's carry-over); empty: hide changes nothing */
  readonly values: readonly string[]
  readonly re: RegExp | null
}

const NONE: Redactor = { hide: (s) => s, values: [], re: null }

export function redactorOf(values: Iterable<string | null | undefined>): Redactor {
  const vs = secretValuesOf(values)
  const re = secretRegex(vs)
  if (!re) return NONE
  return { hide: (s) => (s ? s.replace(re, HIDDEN) : s), values: vs, re }
}

/** The redactor of this person's stored connection secrets now. A failure to read them leaves the text as it is (and
 * is logged): the tools' own hiding (tools.ts `hiding`) still withholds an answer it cannot check. */
export function redactorFor(ctx: AppContext, userId: string): Redactor {
  try {
    const has = ctx.db.query('SELECT 1 FROM integrations WHERE secret_enc IS NOT NULL LIMIT 1').get()
    if (!has) return NONE
    return redactorOf(integrationsOf(ctx).secretsFor(userId))
  } catch (e) {
    ctx.log?.warn('reading connection secrets for redaction failed', { err: e })
    return NONE
  }
}

/** How many characters at the end of `text` could be the start of one of the values (to wait for the next piece). */
export function carryLength(text: string, values: readonly string[]): number {
  let best = 0
  for (const v of values) {
    for (let k = Math.min(v.length - 1, text.length); k > best; k--) {
      if (text.endsWith(v.slice(0, k))) { best = k; break }
    }
  }
  return best
}

/**
 * Text that arrives in pieces (the engine's text deltas), let out with the values hidden. A value cut across two
 * pieces is still found: the end of the text that could be the start of a value waits for the next piece (only the
 * value as written; an escaped or base64 form cut across pieces is hidden when the whole answer is checked, `all`).
 * What `push` and `flush` return, joined, is the answer: the client places each piece at the length shown so far.
 */
export class RedactingText {
  private pending = ''
  constructor(private redactor: () => Redactor) {}

  /** the part of the text so far that can be let out now */
  push(piece: string): string {
    this.pending += piece
    return this.take(false)
  }
  /** everything held back (the text ended, or a tool call, a retry or a stop comes next) */
  flush(): string { return this.take(true) }
  get held(): string { return this.pending }
  /** drop what is held back (the text it belongs to is discarded) */
  clear() { this.pending = '' }

  private take(all: boolean): string {
    const text = this.pending
    if (!text) return ''
    const r = this.redactor()
    if (!r.re) { this.pending = ''; return text }
    let cut = all ? text.length : text.length - carryLength(text, r.values)
    if (cut < text.length) {
      // a whole form of a value across the cut stays with the held part (it is hidden together)
      r.re.lastIndex = 0
      for (const m of text.matchAll(r.re)) {
        if (m.index! < cut && m.index! + m[0].length > cut) { cut = m.index!; break }
        if (m.index! >= cut) break
      }
    }
    this.pending = text.slice(cut)
    return r.hide(text.slice(0, cut))
  }
}
