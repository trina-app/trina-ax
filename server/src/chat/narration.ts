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

/** A message that asks for another language or a translation (영어로, 인도네시아어로, 일본말로, 스페인어 버전, 英語で, 用西班牙语,
 * English, translate …): no piece is dropped in that answer. */
const ASKS_FOR_OTHER_LANGUAGE = new RegExp([
  '영어', '영문', '번역', '[가-힣]어\\s*(?:로|으로|버전|번역|판)', '[가-힣]말로',
  '[\\u4E00-\\u9FFF\\u30A0-\\u30FF]語(?:で|に|版|訳)', '翻訳', '英語',
  '用[\\u4E00-\\u9FFF]{1,6}[语文語]', '[\\u4E00-\\u9FFF]{1,6}[语文]版', '翻译', '英文', '英语',
  'english', 'translat', 'spanish', 'español', 'indonesian', 'bahasa', 'french', 'german', 'vietnamese',
].join('|'), 'i')

/** The longest piece (trimmed) that can be dropped, and at most this many sentences and lines. */
export const NARRATION_MAX_CHARS = 200
const NARRATION_MAX_SENTENCES = 2
const NARRATION_MAX_LINES = 2

/** How a status line starts: only a piece that opens like this is ever dropped ("Let me check …", "Only one thread
 * exists; check it.", "Existing pattern: …"). Content written before a call ("Hi team, …", "Total: 42 files",
 * "Work smarter, together.") does not. */
const STATUS_OPENING = /^(?:let me|let's|let us|i'll|i will|i'm|i am|i need|i should|i can|i see|now|next|first|then|checking|check|looking|reading|searching|opening|trying|only|found|verify|verifying|ok|okay|good|great|alright|done|following|existing|same|still|nothing|no )\b/i
/** a plan in the first person, an order to itself ("…; check it.") or the person named "the user", anywhere ("The
 * existing file uses the pattern …, so I'll match it.", "User's own dictated words."), unless the piece
 * opens like a message to someone ("Hi team, I'll be out Friday.") */
const STATUS_PLAN = /\b(?:i'll|i will|i'm going to|let me|let's)\b|\b(?:check|verify|confirm) (?:it|this|that|them|both)\b|\bthe user(?:'s)?\b|^user(?:'s)?\b/i
const GREETING = /^(?:hi|hello|hey|dear|thanks|thank you|good (?:morning|afternoon|evening))\b/i
/** typographic dashes, apostrophes and ellipses count as ASCII (the model writes "—" and "I’ll") */
const plainPunct = (s: string) => s.replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/\u2026/g, '...')
/** the longest opening word above, plus room: a piece this long that does not start with one is let out */
const OPENING_DECIDED_AT = 12

/** about 3 or more Latin words and none of the answer's script: the person wrote in a Latin language */
const writesLatin = (m: string, script: AnswerScript) => !SCRIPT_LETTER[script].test(m) && (m.match(/[A-Za-z]{2,}/g) ?? []).length >= 3

/**
 * The script whose answers drop English status lines, or null (the hold lets everything through). The answer language
 * (the person's app language) is ko, ja or zh, and the message does not ask for another language or a translation. A
 * message written in Latin words (3 or more, none of the script: "What did we agree in the room?") gets an answer in
 * that language: off. A short or mixed message ("ok", "👍", an attachment, pasted English with a Korean question)
 * follows the person's message before it, else the app language.
 */
export function narrationScript(locale: Locale, message: string, previous?: string | null): AnswerScript | null {
  if (locale !== 'ko' && locale !== 'ja' && locale !== 'zh') return null
  if (ASKS_FOR_OTHER_LANGUAGE.test(message)) return null
  if (SCRIPT_LETTER[locale].test(message)) return locale
  if (writesLatin(message, locale)) return null
  if (previous && writesLatin(previous, locale)) return null
  return locale
}

/** The piece without `code` and file names, quoted or not ("Existing pattern: "매장-전경.jpg" (hyphenated Korean)."):
 * a Korean file name does not make a line Korean, and quote marks around a file name do not make it a quote. */
const withoutNames = (s: string) => s.replace(/(?<!`)`[^`\n]+`(?!`)/g, '')
  .replace(/["“'‘「『][^"”'’」』\n]*\.[A-Za-z0-9]{1,5}["”'’」』]/g, '')
  .replace(/[^\s()"“”'‘’「」『』]+\.[A-Za-z0-9]{1,5}(?=[\s).,;:!?"”'’」』]|$)/g, '')

/** Markers of content: a link or address, Markdown (heading, list, bold, table, code, quote), quote marks, a number
 * with a unit or a currency ("Total: 42 files", "339,400 KRW", "$5"). */
const CONTENT = /https?:\/\/|www\.|\]\(|```|~~~|\*\*|__|\||^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/m
const CONTENT_WORDS = /["“”«»「」『』]|[$€£¥₩]\s*\d|\d[\d,.]*\s*(?:%|[A-Za-z]+\b)/

/** The piece is surely not a status line, so it can go out now. partial: the piece is still coming (its last word may
 * be a file name not yet whole, its opening not yet known). */
function mustKeep(piece: string, script: AnswerScript, partial = false): boolean {
  piece = plainPunct(piece)
  const t = piece.trim()
  if (t.length > NARRATION_MAX_CHARS) return true
  const words = withoutNames(partial ? piece.replace(/\S+$/, '') : t)
  if (SCRIPT_LETTER[script].test(words)) return true
  // only ASCII text is ever a status line ("Hola equipo, ya está listo." is not one)
  if (/[^\x00-\x7F]/.test(words)) return true
  if (CONTENT.test(t) || CONTENT_WORDS.test(words)) return true
  if (t.split('\n').filter((l) => l.trim()).length > NARRATION_MAX_LINES) return true
  if ((t.match(/[.!?;:](?=\s|$)/g) ?? []).length > NARRATION_MAX_SENTENCES) return true
  const status = STATUS_OPENING.test(t) || (STATUS_PLAN.test(t) && !GREETING.test(t))
  // still coming: "so I'll …" may be on its way, so only a greeting decides before the end
  if (partial ? t.length >= OPENING_DECIDED_AT && GREETING.test(t) : !status) return true
  return false
}

/** A whole piece that is a status line: it has Latin letters and nothing marks it as content. */
const isStatusLine = (piece: string, script: AnswerScript) => /[A-Za-z]/.test(piece) && !mustKeep(piece, script)

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
    if (isStatusLine(piece, this.script)) {
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
