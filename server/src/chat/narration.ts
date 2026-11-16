import type { Locale } from '@mycel/shared/api'

/**
 * English status lines between tool calls stay out of a Korean, Japanese or Chinese answer
 * (docs/decisions/20261116-answer-no-english-narration.md).
 *
 * The engines write short text of their own before a tool call ("Let me check that the seal printed correctly.").
 * The answer keeps every text piece, so such a line ended up at the top of a Korean answer although the prompt says
 * not to (LANGUAGE_RULE). A text piece is what the engine writes between two tool calls (or before the first one).
 * While a piece could still be such a line it is held: not streamed, not saved. The next event decides it: a tool call
 * drops it when it is a short line in Latin letters with none of the answer's own script; anything else lets it out
 * as it was. The last piece (no tool call after it) is always kept: an English email asked for in a Korean chat is
 * the answer, not a status line.
 */

/** The answer's own script, by the answer language: only languages that do not use Latin letters. */
export type AnswerScript = 'ko' | 'ja' | 'zh'

const SCRIPT_LETTER: Record<AnswerScript, RegExp> = {
  ko: /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯ힰ-퟿]/,
  ja: /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿ｦ-ﾟ]/,
  zh: /[㐀-䶿一-鿿豈-﫿]/,
}

/** a message that asks for English or a translation: no piece is dropped in that answer */
const ASKS_FOR_LATIN = /영어|영문|번역|英語|英文|英语|翻訳|翻译|english|translat/i

/** The longest piece (trimmed) that can be dropped, and at most this many sentences and lines. */
export const NARRATION_MAX_CHARS = 200
const NARRATION_MAX_SENTENCES = 2
const NARRATION_MAX_LINES = 2

/**
 * The script whose answers drop English status lines, or null (the hold lets everything through): the answer
 * language (the person's app language) is ko, ja or zh and the person's message is written in it (a Korean app with
 * an English message gets an English answer), and the message does not ask for English or a translation.
 */
export function narrationScript(locale: Locale, message: string): AnswerScript | null {
  if (locale !== 'ko' && locale !== 'ja' && locale !== 'zh') return null
  if (!SCRIPT_LETTER[locale].test(message)) return null
  if (ASKS_FOR_LATIN.test(message)) return null
  return locale
}

/** The piece is surely not a status line: long, in the answer's script, or content (code, a quote, a link, a table). */
function mustKeep(piece: string, script: AnswerScript, partial = false): boolean {
  const t = piece.trim()
  // while the piece streams, its last word may be a file name still coming: it counts once it is whole
  const words = partial ? piece.replace(/\S+$/, '') : t
  if (t.length > NARRATION_MAX_CHARS) return true
  // the answer's script in the words themselves: a file name or `code` in it does not count ("Following the existing
  // naming pattern (매장-전경.jpg).")
  if (SCRIPT_LETTER[script].test(words.replace(/`[^`\n]*`/g, '').replace(/[^\s()]+\.[A-Za-z0-9]{1,5}(?=[\s).,;:!?]|$)/g, ''))) return true
  if (/```|~~~|["“”«»「」『』]|\]\(|\|/.test(t)) return true
  if (/^\s*>/m.test(t)) return true
  if (t.split('\n').filter((l) => l.trim()).length > NARRATION_MAX_LINES) return true
  if ((t.match(/[.!?;:](?=\s|$)/g) ?? []).length > NARRATION_MAX_SENTENCES) return true
  return false
}

const leadingSpace = (s: string) => /^\s*/.exec(s)![0]

export class NarrationHold {
  /** the current piece while it is undecided */
  private buf = ''
  /** the current piece was let out: the rest of it passes straight through */
  private decided = false
  /** the space a dropped piece started with (the engine's separator): it replaces the next piece's own */
  private lead: string | null = null
  /** how many pieces were dropped, for the log */
  dropped = 0

  constructor(private readonly script: AnswerScript | null) {}

  /** The part of the piece held back now. */
  get held(): string { return this.buf }

  /** Engine text: what can go out now ('' while the piece is undecided). */
  push(t: string): string {
    if (!t) return ''
    if (!this.script || this.decided) return t
    this.buf += t
    if (!mustKeep(this.buf, this.script, true)) return ''
    return this.release()
  }

  /** A tool call ends the piece: '' when it was a status line, else what was held. */
  toolStart(): string {
    if (!this.script) return ''
    const piece = this.buf
    this.decided = false
    if (piece.trim() && /[A-Za-z]/.test(piece) && !mustKeep(piece, this.script)) {
      this.buf = ''
      if (this.lead === null) this.lead = leadingSpace(piece)
      this.dropped++
      return ''
    }
    const out = this.release()
    this.decided = false
    return out
  }

  /** The end (of the answer, or of an attempt): everything held goes out as it was. */
  flush(): string {
    const out = this.release()
    this.decided = false
    return out
  }

  /** Forget what is held (the attempt's text is discarded). */
  clear() { this.buf = ''; this.decided = false; this.lead = null }

  private release(): string {
    let out = this.buf
    this.buf = ''
    this.decided = true
    if (this.lead !== null && out.trim()) { out = this.lead + out.slice(leadingSpace(out).length); this.lead = null }
    else if (this.lead !== null) out = '' // only space after a dropped piece: the next piece brings the separator
    return out
  }
}
