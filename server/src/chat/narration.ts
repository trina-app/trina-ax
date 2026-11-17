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
 *
 * 2026-11-17 (docs/decisions/20261117-answer-work-notes.md): a piece before a call is also dropped when it is a note
 * about the work in no fixed opening ("Find the price list first.", "Only one thread; read it."): it names the work
 * (a file, a folder, a thread, a page, a skill …), gives itself an order or a plan, or talks about "the user", and it
 * neither speaks to people (you, we, team, hi, please …) nor is a title. Position stays the main rule: only a piece
 * followed by a call, never the last one, and never one copied into that call's arguments or taken from the person's
 * message.
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
  'english', 'translat', 'spanish', 'español', 'indonesian', 'bahasa', 'french', 'german', 'vietnamese', 'japanese',
  'chinese', 'korean',
  // text that is often in English though the chat is not: a slogan, copy, a commit message, a button or label
  '영작', '슬로건', '카피', '문구', '캐치프레이즈', '커밋', 'commit', '버튼', '라벨',
  // the message quotes 3 or more Latin words (after ":" or in quotes)
  '[:：]\\s*[A-Za-z]+(?:[\\s,.\'-]+[A-Za-z]+){2,}', '["“\'‘「][A-Za-z]+(?:[\\s,.-]+[A-Za-z]+){2,}',
].join('|'), 'i')

/** The longest piece (trimmed) that can be dropped, and at most this many sentences and lines. */
export const NARRATION_MAX_CHARS = 200
const NARRATION_MAX_SENTENCES = 3
const NARRATION_MAX_LINES = 2

/** What the AI does while it works: the verbs of a status line ("Let me check …", "Now renaming …"; "now" only with
 * a gerund: "Now open on weekends." is content). */
const WORK = '(?:check|look|search|read|open|find|verify|rename|create|update|save|export|try|review|compare|scan|list|move|copy|fetch|load|split|match|inspect|examine|pull)'
/** "check in with you", "look forward to", "check out": said to people, not work */
const NOT_PHRASAL = '(?!\\s+(?:in|out|back|forward|up on|with)\\b)'
const WORKING = '(?:checking|looking|searching|reading|opening|finding|verifying|renaming|creating|updating|saving|exporting|trying|reviewing|comparing|scanning|listing|moving|copying|fetching|loading|matching|inspecting|examining|pulling)'
/** What a working gerund at the start goes on with: "the", "both", "this" …, or a file or path ("Checking the folder",
 * "Renaming IMG_2041.jpg"), never a noun ("Reading list for the week", "Opening hours: …"). */
const WORK_OBJECT = '(?:the|both|all|each|this|that|these|those|it|them|its|my|your|[^\\s]*[./][^\\s]*)\\b'
/** How a status line starts (review of #1066, second round: only openings that are almost never content). */
const STATUS_OPENING = new RegExp(`^(?:(?:(?:let me|i'll|i will)\\s+${WORK}\\b${NOT_PHRASAL}|now\\s+${WORKING}\\b)|${WORKING}\\s+${WORK_OBJECT}|found it\\b|verify:?$)`, 'i')
/** Inside the piece: after "," or ";", a plan ("…, so I'll match it.") or an order to itself ("…; check it.", not
 * "check it out"); anywhere, the person named "the user" with what they want ("the user asked …"). */
const STATUS_PLAN = new RegExp(`[,;]\\s*(?:so\\s+|then\\s+)?(?:(?:i'll|i will|let me)\\s+${WORK}\\b${NOT_PHRASAL}|(?:check|verify)\\s+(?:it|this|that|them|both)\\b(?!\\s+out))|\\bthe user\\s+(?:wants|asked|needs|said|request)`, 'i')
/** Content that looks like a status line: always kept. */
const CONTENT_LINE = /^let me know|^let me introduce|^i'?m (?:happy|pleased|excited|writing)|^i am writing|out of (?:the )?office|^looking forward|^following up|[?!]/i
/** A note about the work (2026-11-17): what the AI works on, by name ("the CSV", "both rooms", "page 2", "edit_pdf",
 * "users/sora") … */
const WORK_NOUN = /\b(?:file|files|filename|folders?|subfolders?|threads?|rooms?|messages?|mails?|pages?|skills?|cop(?:y|ies)|drafts?|scan|scanned|csv|pdf|docx|xlsx|pptx|hwpx?|path|links?|rows?|columns?|header|seal|stamped|chart|project|root|server|drive|tool|parameters?|statements?|original|version|photos?|images?|naming|edit)\b|\b[a-z]+_[a-z_]+\b|\b[a-z]+\/[a-z]/i
/** … an order to itself at the start of a sentence ("Need to find …", "Search files.", "Use edit_pdf instead.") … */
const SELF_ORDER = /(?:^|[.;:]\s+)(?:(?:i\s+)?need\s+(?:to\s+)?|find|search|read|load|use|save|check|try|fetch|open|look\s+(?:for|at)|overwrite|regenerate)\b/i
/** … a plan of its own ("I'll read them in parallel", "Let me also check …") … */
const OWN_PLAN = /\b(?:i'll|i will|let me|i'm going to|i am going to)\s+(?:also\s+|now\s+|first\s+|just\s+)?[a-z]+/i
/** … or the person as "the user" ("Skills folder is read-only for this user", "User's own dictated words."). */
const THE_USER = /\b(?:the|this) user(?:'s|\s+(?:wants|asked|asks|needs|said|says|requested|is|has|can|cannot|can't|may|might|didn't|doesn't|did|would|only|probably|explicitly))\b|\bfor (?:the|this) user\b|^user's\b/i
/** Words said to people: content, never a note ("Hi all, the price list is in the shared folder.", "Your file is ready."). */
const TO_PEOPLE = /\bteam\s*[,!]|\b(?:you|your|yours|we|our|ours|us|everyone|hi|hello|hey|dear|please|thanks|thank|regards|cheers|welcome)\b/i
/** A title: two or more words, every word of four letters or more capitalised ("Q3 Sales Report"). */
const isTitle = (t: string) => {
  const words = t.replace(/[.:]$/, '').split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.filter((w) => /^[A-Za-z]{4,}/.test(w)).every((w) => /^[A-Z]/.test(w)) && words.some((w) => /^[A-Z][a-z]/.test(w))
}
/** A report to the person, not a note: what the AI did, could not do or can do ("I didn't change the original.", "I
 * can't open that chat.", "I used the quote skill."), what a source says, a piece that adds to the answer ("Also, …",
 * "According to …", "One note: …") or leads into what follows ("…:"). */
const REPORT = /\bi (?:can|could|can't|cannot|couldn't|didn't|did not|haven't|have not|have no|don't|do not|wasn't|won't|found|changed|left|made|saved|moved|updated|sent|stamped|put|wrote|used|added|removed|kept)\b|\bi've\b|\b(?:says|said|shows|showed)\b|^(?:also|one note|note|according to|however|but|so|btw|by the way|for example)\b|:$/i
/** A note about the work, in no fixed opening (whole piece, names and `code` taken out): an order or plan of its own,
 * "the user", or a short line (100 characters at most) that names the work. */
const isWorkNote = (t: string) => {
  t = t.trim()
  if (TO_PEOPLE.test(t) || REPORT.test(t) || isTitle(t)) return false
  return SELF_ORDER.test(t) || OWN_PLAN.test(t) || THE_USER.test(t) || (WORK_NOUN.test(t) && t.length <= 100)
}

/** typographic dashes, apostrophes and ellipses count as ASCII (the model writes "—" and "I’ll") */
const plainPunct = (s: string) => s.replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/\u2026/g, '...')

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
const CONTENT_WORDS = /["“”«»「」『』]|[$€£¥₩]\s*\d|(?<!\b(?:page|pages|row|rows|column|columns|step|line|slide|sheet|tab)\s+)\b\d[\d,.]*\s*(?:%|(?!(?:is|are|was|were|of|and|or|to|in|on|at|for|with|by|from|as|the|a|an|first|before|after|then|instead|again|only|too)\b)[A-Za-z]+\b)/

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
  if (CONTENT_LINE.test(t)) return true
  // still coming: "…, so I'll …" may be on its way, so only the whole piece decides
  if (!partial && !STATUS_OPENING.test(t) && !STATUS_PLAN.test(t) && !isWorkNote(withoutNames(t))) return true
  return false
}

/** Text for "is this piece copied there": lower case, plain punctuation, single spaces, no end mark. */
const norm = (s: string) => plainPunct(s).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?:;]+$/, '')

/** Every string in a call's arguments, joined. */
function argText(input: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 200) return out
  if (typeof input === 'string') out.push(input)
  else if (Array.isArray(input)) for (const v of input) argText(v, out, depth + 1)
  else if (input && typeof input === 'object') for (const v of Object.values(input)) argText(v, out, depth + 1)
  return out
}

/** The piece is in the next call's arguments (a message it posts, a file it writes) or in the person's message: it is
 * content shown before it is used, not a note. */
function copied(piece: string, input: unknown, message: string): boolean {
  const p = norm(piece)
  if (p.length < 8) return false
  if (norm(message).includes(p)) return true
  return norm(argText(input).join('\n')).includes(p)
}

/** A whole piece that is a status line: it has Latin letters and nothing marks it as content. */
const isStatusLine = (piece: string, script: AnswerScript, input: unknown, message: string) =>
  /[A-Za-z]/.test(piece) && !mustKeep(piece, script) && !copied(piece, input, message)

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

  /** script: narrationScript(); message: the person's message (a piece taken from it is content) */
  constructor(private readonly script: AnswerScript | null, private readonly message = '') {}

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

  /** A tool call ends the piece: '' when it was a status line, else what was held. input: the call's arguments, when
   * known (a piece copied into them is content). */
  toolStart(input?: unknown): string {
    if (!this.script) return ''
    const piece = this.buf
    this.decided = false
    if (isStatusLine(piece, this.script, input, this.message)) {
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
