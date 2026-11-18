// The stored secrets of a person's connections, kept out of what the server itself sends and saves for them (QA INT-13,
// B-W5-4; docs/DECISIONS.md "No stored key in the answer"). hide.ts hides them in what a service sends back; the AI
// can still repeat a value it read in the person's message ("the string you sent (…) matched the stored key"). So
// the turn's own outgoing text goes through one redactor too: the streamed answer and the saved answer (one stream,
// below), the steps, the audit lines (tool_events) and the chat title. The person's own message is kept as typed
// (the AI's history needs it).
import type { AppContext } from '../../context'
import { errorForLog, hideWith, matchesAny, secretRegexes, secretValuesOf } from './hide'
import { integrationsOf, WITHHELD } from './service'

export interface Redactor {
  /** the text with every form of every value replaced by HIDDEN (WITHHELD for any text when `withheld`) */
  hide(text: string): string
  /** the values (for the stream's carry-over); empty: hide changes nothing */
  readonly values: readonly string[]
  /** the regular expressions, applied in order (hide.ts secretRegexes); empty: nothing to look for */
  readonly res: readonly RegExp[]
  /** the keys could not be made into a hider (QA TC-4770): nothing is let out unchecked, every text is WITHHELD */
  readonly withheld?: boolean
}

const NONE: Redactor = { hide: (s) => s, values: [], res: [] }
/** fails closed: what cannot be checked is not shown */
export const WITHHOLDING: Redactor = { hide: (s) => (s ? WITHHELD : s), values: [], res: [], withheld: true }

/** a redactor that changes nothing (no stored keys): callers may skip it */
export const nothingToHide = (r: Redactor) => !r.withheld && r.res.length === 0
/** whether a form of a value is in `text` (a withholding redactor: any text) */
export const holdsKey = (r: Redactor, text: string) => (r.withheld ? !!text : matchesAny(r.res, text))

/** SecretTooLarge (hide.ts) when a value cannot be hidden: the callers below fail closed */
export function redactorOf(values: Iterable<string | null | undefined>): Redactor {
  const vs = secretValuesOf(values)
  const res = secretRegexes(vs)
  if (!res.length) return NONE
  return { hide: (s) => (s ? hideWith(res, s) : s), values: vs, res }
}

/** The redactor of this person's stored connection secrets now. A secret that cannot be opened is left out (the tools'
 * own hiding, tools.ts `hiding`, still withholds an answer it cannot check); a failure to read them or to build the
 * hider is logged and fails closed: the redactor withholds every text (QA TC-4770). */
export function redactorFor(ctx: AppContext, userId: string): Redactor {
  try {
    const has = ctx.db.query('SELECT 1 FROM integrations WHERE secret_enc IS NOT NULL LIMIT 1').get()
    if (!has) return NONE
    return redactorOf(integrationsOf(ctx).secretsFor(userId))
  } catch (e) {
    ctx.log?.warn('reading connection secrets for redaction failed', { err: errorForLog(e) })
    return WITHHOLDING
  }
}

export const MEMORY_SCAN_KEY = 'memory.storedKeyScan'
export const MEMORY_SCAN_VERSION = 1

/** This person's redactor only when every stored secret of theirs can be read now; null otherwise (a failure, or a
 * secret that cannot be opened): redactorFor would quietly leave such a secret out. Also what a call to a connected
 * service is checked with (chat/tools.ts hideKeys): it is not sent when a secret cannot be read. */
export function completeRedactorFor(ctx: AppContext, userId: string): Redactor | null {
  try {
    const has = ctx.db.query('SELECT 1 FROM integrations WHERE secret_enc IS NOT NULL LIMIT 1').get()
    if (!has) return NONE
    const values = integrationsOf(ctx).allSecretsFor(userId)
    return values ? redactorOf(values) : null
  } catch (e) {
    ctx.log?.warn('reading connection secrets for the memory clean-up failed', { err: errorForLog(e) })
    return null
  }
}

/**
 * Once, at server start (QA TC-2981): memories the AI saved before the remember tool hid stored keys
 * (created_turn_id set, also when the person edited them later) get HIDDEN in place of each of their person's stored
 * connection secrets. Memories the person added in Settings › Memory stay as typed. When a person's secrets cannot all
 * be read, the memories that can be cleaned are, and the clean-up is not marked done: it runs again at the next start.
 * Returns the number of memories changed.
 */
export function hideKeysInStoredMemories(ctx: AppContext): number {
  const db = ctx.db
  const done = db.query('SELECT value FROM settings WHERE key = ?').get(MEMORY_SCAN_KEY) as { value: string } | null
  if (done && Number(JSON.parse(done.value)) >= MEMORY_SCAN_VERSION) return 0
  let n = 0
  const users = db.query('SELECT DISTINCT user_id FROM memories WHERE created_turn_id IS NOT NULL').all() as { user_id: string }[]
  // the secrets are read before the write transaction (decrypting may log, and must not hold the database)
  let complete = true
  const hiders: { userId: string; r: Redactor }[] = []
  for (const u of users) {
    let r = completeRedactorFor(ctx, u.user_id)
    if (!r) { complete = false; r = redactorFor(ctx, u.user_id) }
    if (r.withheld) { complete = false; continue }
    if (r.res.length) hiders.push({ userId: u.user_id, r })
  }
  db.transaction(() => {
    for (const { userId, r } of hiders) {
      for (const m of db.query('SELECT id, text FROM memories WHERE user_id = ? AND created_turn_id IS NOT NULL').all(userId) as { id: string; text: string }[]) {
        const text = r.hide(m.text)
        if (text === m.text) continue
        db.query('UPDATE memories SET text = ? WHERE id = ?').run(text, m.id)
        n++
      }
    }
    if (complete) db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MEMORY_SCAN_KEY, JSON.stringify(MEMORY_SCAN_VERSION))
  })()
  return n
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

/** The characters any written form of these values is made of (hide.ts: the value's own characters, base64, and the
 * %, JSON and HTML escapes), and the longest such form without zero padding. */
function formsOf(values: readonly string[]): { chars: Set<string>; longest: number } {
  const chars = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-%&#;\\"\'')
  let longest = 0
  for (const v of values) {
    for (const c of v) chars.add(c)
    // a character at its longest: four %-escaped UTF-8 bytes (12), an HTML entity or a JSON escape (at most 10)
    longest = Math.max(longest, [...v].length * 12)
  }
  return { chars, longest }
}

/** How many characters at the end of `text` could be the start of a written form of one of the values (escaped,
 * base64): the run of characters such a form is made of, at most as long as the longest form. */
export function formCarryLength(text: string, values: readonly string[]): number {
  if (!values.length) return 0
  const { chars, longest } = formsOf(values)
  let n = 0
  for (let i = text.length - 1; i >= 0 && n < longest && chars.has(text[i]!); i--) n++
  return n
}

/** The characters any written form of these values is made of (formRunLength's set), for a caller that scans text as it
 * grows (chat/live-answer.ts OthersText). */
export function formChars(values: readonly string[]): ReadonlySet<string> { return formsOf(values).chars }

/** How many characters at the end of `text` are one run of the characters a written form of these values is made of,
 * with no length cap: the part of a shared answer the others do not get yet (chat/live-answer.ts OthersText). A form
 * padded past formCarryLength's longest (HTML entities with leading zeros, `&#0000…065;`) stays in it, so no form is
 * cut in two at what is let out. 0 with no values. */
export function formRunLength(text: string, values: readonly string[]): number {
  if (!values.length) return 0
  const { chars } = formsOf(values)
  let n = 0
  for (let i = text.length - 1; i >= 0 && chars.has(text[i]!); i--) n++
  return n
}

/**
 * Text that arrives in pieces (the engine's text deltas), let out with the values hidden. A value cut across two
 * pieces is still found: the end of the text that could be the start of a value, as written or in one of its other
 * forms (escaped, base64: formCarryLength), waits for the next piece. So the answer shown while the turn runs, or while
 * it waits on a card, never lets out part of a form that the next piece completes (QA TC-2981); the whole answer is
 * checked again at the end (`all`), for a form padded past the longest length.
 * What `push` and `flush` return, joined, is the answer: the client places each piece at the length shown so far.
 */
export class RedactingText {
  private pending = ''
  /** a withholding redactor: WITHHELD was let out once, the rest of the text goes nowhere */
  private saidWithheld = false
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
    if (r.withheld) { this.pending = ''; if (this.saidWithheld) return ''; this.saidWithheld = true; return r.hide(text) }
    if (!r.res.length) { this.pending = ''; return text }
    let cut = all ? text.length : text.length - Math.max(carryLength(text, r.values), formCarryLength(text, r.values))
    // a whole form of a value across the cut stays with the held part (it is hidden together), for every regular
    // expression of the chain: moving the cut back can put it inside another one's match, so until none crosses it
    for (let moved = cut < text.length; moved;) {
      moved = false
      for (const re of r.res) {
        for (const m of text.matchAll(re)) {
          if (m.index! >= cut) break
          if (m.index! + m[0].length > cut) { cut = m.index!; moved = true; break }
        }
      }
    }
    this.pending = text.slice(cut)
    return r.hide(text.slice(0, cut))
  }
}
