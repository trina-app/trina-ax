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
  '영작', 'commit', 'chinese', 'korean',
  // the message quotes 3 or more Latin words (after ":" or in quotes)
  '[:：]\\s*[A-Za-z]+(?:[\\s,.\'-]+[A-Za-z]+){2,}', '["“\'‘「][A-Za-z]+(?:[\\s,.-]+[A-Za-z]+){2,}',
].join('|'), 'i')
/** Text that is often in English though the chat is not: a slogan, copy, a commit message, a button or label. Such a
 * message turns the hold off unless it gives the new words in the answer's own script (OWN_SCRIPT_COPY): "배너 문구를
 * '작지 않아 큰 햇살이야!'로 바꿔 줘" asks for Korean words (demo re-test 11-22: "Try with a full team path." went out at
 * the top of that Korean answer). */
const OFTEN_ENGLISH = /슬로건|카피|문구|캐치프레이즈|커밋|버튼|라벨/
/** the new words in the script: quoted, or right before "(으)로 바꿔/변경/수정/고쳐" ("…큰 햇살이야!로 바꿔 줘") */
const ownScriptCopy = (m: string, script: AnswerScript) => {
  for (const q of m.matchAll(/["“'‘「『]([^"”'’」』\n]{1,80})["”'’」』]/g)) if (SCRIPT_LETTER[script].test(q[1]!)) return true
  return script === 'ko' && /[가-힣][^\s]*\s*(?:으로|로)\s*(?:바꿔|바꾸|변경|수정|고쳐)/.test(m)
}

/** The longest piece (trimmed) that can be dropped, and at most this many sentences and lines. */
export const NARRATION_MAX_CHARS = 200
const NARRATION_MAX_SENTENCES = 2
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
const WORK_NOUN = /\b(?:file|files|filename|folders?|subfolders?|threads?|rooms?|messages?|mails?|pages?|skills?|cop(?:y|ies)|scan|scanned|csv|pdf|docx|xlsx|pptx|hwpx?|path|links?|rows?|columns?|seal|stamped|chart|root|parameters?|statements?|naming|slides?|headings?|decks?|layouts?)\b|\b[a-z]+_[a-z_]+\b|\b(?:users|groups|projects|shared|skills)\/[^\s/]/i
/** … an order to itself at the start of a sentence: "Need to …", or a verb rarely said to people ("Find the CSV.",
 * "Search files.", not "Find attached …"), or a common verb in a note's shape: after an earlier sentence ("Only one
 * thread; read it."), or ending on first / instead / both / it ("Use edit_pdf instead."), not "Read the attached file
 * before the meeting." … */
const SELF_ORDER = new RegExp(`(?:^|[.;:]\\s+)(?:(?:i\\s+)?need\\s+to\\s+${WORK}\\b|(?:find(?!\\s+(?:attached|enclosed|below|out))|search(?!\\s+(?:is|are|was|were|results?)\\b)|overwrite|regenerate)\\b|(?:load|fetch)\\s+(?:it|them)\\b)`, 'i')
const NOTE_ORDER = /(?:[.;:]\s+(?:read|use|save|check|try|open)\b)|^(?:read|use|save|check|try|open)\b[^.;:]*(?:\b(?:first|instead|both|it|them|again|once)|\bthen (?:regenerate|redo|retry|overwrite|save|print))[.]?$/i
/** An order said to people ("Read the attached file before the meeting.", "Use code SAVE10 at checkout."): a piece that
 * opens with a verb and has no note shape (NOTE_ORDER, SELF_ORDER) is content. */
const ORDER_TO_PEOPLE = /^(?:find|read|use|check|save|open|try|send|review|sign|fill|bring|see|visit|click|download|reply|share|call|meet|join|submit|print|keep|remember|make sure)\b/i
/** … a plan of its own ("I'll read them in parallel", "Let me also check …") … */
const OWN_PLAN = new RegExp(`\\b(?:i'll|i will|let me|i'm going to|i am going to)\\s+(?:also\\s+|now\\s+|first\\s+|just\\s+)?(?:${WORK}|follow|stamp|transcribe|overwrite|use|leave|edit|attempt|make it again|reduce|print|redo|merge|regenerate)\\b${NOT_PHRASAL}`, 'i')
/** … or the person as "the user" ("Skills folder is read-only for this user", "User's own dictated words."). */
const THE_USER = /\b(?:the|this) user(?:'s|\s+(?:wants|asked|asks|needs|said|says|requested|probably|explicitly))\b|\bfor (?:the|this) user\b|^user(?:'s own| asked)\b/i
/** Words said to people: content, never a note ("Hi all, the price list is in the shared folder.", "Your file is ready."). */
const TO_PEOPLE = /\bteam\s*[,!]|^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?,|,\s*[A-Z][a-z]+[.!]?$|\b(?:mr|ms|mrs|dr)\.|\b(?:you|your|yours|my|we|our|ours|us|everyone|folks|kindly|fyi|heads up|hi|hello|hey|dear|please|thanks|thank|regards|cheers|welcome)\b/i
/** A title: two or more words, every word of four letters or more capitalised ("Q3 Sales Report"). */
const isTitle = (t: string) => {
  const words = t.replace(/[.:]$/, '').split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.filter((w) => /^[A-Za-z]{4,}/.test(w)).every((w) => /^[A-Z]/.test(w)) && words.some((w) => /^[A-Z][a-z]/.test(w))
}
/** A report to the person, not a note: what the AI did, could not do or can do ("I didn't change the original.", "I
 * can't open that chat.", "I used the quote skill."), what a source says, a piece that adds to the answer ("Also, …",
 * "According to …", "One note: …") or leads into what follows ("…:"). */
const REPORT = /\bi (?:can|could|can't|cannot|couldn't|didn't|did not|haven't|have not|have no|don't|do not|wasn't|won't|found|changed|left|made|saved|moved|updated|sent|stamped|put|wrote|used|added|removed|kept)\b|\bi've\b|\b(?:says|said|shows|showed)\b|^(?:also|one note|note|according to|however|but|so|btw|by the way|for example|error|warning|notice|reminder|update)\b|\b(?:do not|don't|never|must|should|not found|expired|protected|skipped|kept|match|matches the|mismatch|ready|due|deadline|confidential|attached)\b|:$/i
/** A note's shape around a named work thing: a ";" joining fragments ("No subfolders; save at project top."), a
 * telegraphic opening ("Only one file.", "No dedicated room", "Matches quote-writer skill.", "Now the PDF, …",
 * "Leaving page out", "Following the existing naming pattern"), or a next step after a sentence ("Seal lands on (인)
 * correctly. Now post to the room.", 2026-11-18 CHT-02.room). */
/** "Now the PDF.", "Now the SKILL.md.": a next step, in two to five words, with no verb said to people */
const NOW_NOTE = /^now\s+(?:the|its|this|that|both)\s+\S+(?:\s+\S+){0,2}[.:]?$/i
const NOTE_MARK = /;|^(?:now|following|existing|leaving|checking|trying|only|no|matches|nine|two|three)\b|[.]\s+now\s+(?:post|send|save|stamp|write|make|put|add|upload|share|attach|print|export|overwrite)\b/i
/** … or a change it is about to make to its own work, as an order to itself ("Shrink the chart a bit so it fits on one
 * page.", 2026-11-22 scenario QA on Claude Code: the line led a Korean answer) */
/** … or how a long job of its own is going ("Encoding is wrapping up.", "Rendering is still running.", 2026-11-22 owner
 * live on Claude Code: saved above the Korean answer) */
const PROGRESS = /^(?:the\s+)?(?:[a-z]+ing|render|export|upload|download|build|install|conversion|job|process)\s+(?:is|are)\s+(?:still\s+|now\s+|almost\s+)?[a-z]+ing\b[^.!?]*[.]?$/i
const EDIT_ORDER = /^(?:shrink|resize|enlarge|widen|narrow|tighten|trim|fit|fix|adjust|swap|redo|rebuild|regenerate|convert|rename|move|drop|remove|replace|change|make)\s+(?:the|it|this|that|them|both|all|each)\b/i
/** … or where it will put something, as an order to itself ("Add under section 1.", "Append it at the end of the
 * notes."; 2026-11-18, EDIT-17.project). */
const PLACE_ORDER = /^(?:add|append|insert|put|place)\s+(?:(?:it|this|that|them|the (?:line|row|note|entry|item)|a (?:line|row|note|bullet)|one line)\s+)?(?:under|below|beneath|after|before|above|into|at the (?:end|top|bottom|start) of)\b/i
/** The AI thinking aloud about how it works ("That folder is listed as read-only, but I should call the tool and let the
 * server decide.", 2026-11-18 TC-4865: it paraphrased the write-access rule of the instructions): a plan of its own
 * ("I should / I need to / I'll / let me") to call or try the tool, or the exact access phrases ("let the server
 * decide", "listed as read-only"). Not "The server checks the token." or "I need to call the vendor." (review of
 * #1272). Checked before REPORT, whose "should" would keep it. */
const META = /\b(?:i\s+(?:should|must|need\s+to|will|am\s+going\s+to)|i'll|i'm\s+going\s+to|let\s+me)\s+(?:just\s+)?(?:call|try|attempt|use|run)\s+(?:the|this|that)\s+(?:tool|write|edit|save)\b|\blet\s+the\s+server\s+decide\b|\b(?:listed|marked)\s+as\s+read-only\b/i
/** The AI's next try after a tool error, naming the work ("Try with a full team path.", demo re-test 11-22: it opened a
 * Korean answer): an order to itself, not to people, when it names a path, a file or a folder (WORK_NOUN) */
const RETRY_NOTE = /^(?:try|retry)\s+(?:again\s+)?(?:with|using|via|a|an|the|another)\b/i
/** A note about the work, in no fixed opening (whole piece, names and `code` taken out): an order or plan of its own,
 * "the user", the AI's thoughts about its tools (META), or a short line (100 characters at most) that names the work in
 * a note's shape. */
const isWorkNote = (t: string) => {
  t = t.trim()
  if (TO_PEOPLE.test(t) || isTitle(t)) return false
  if (META.test(t)) return true
  if (REPORT.test(t)) return false
  if (RETRY_NOTE.test(t) && WORK_NOUN.test(t) && t.length <= 100) return true
  // (a ';' joining two fragments about the work is a note's shape even after such a verb: 'Use only "##" headings; the
  // title slide becomes the first one.', TC-r2b-05)
  if (ORDER_TO_PEOPLE.test(t) && !NOTE_ORDER.test(t) && !SELF_ORDER.test(t) && !(t.includes(';') && WORK_NOUN.test(t) && t.length <= 100)) return false
  return SELF_ORDER.test(t) || NOTE_ORDER.test(t) || OWN_PLAN.test(t) || THE_USER.test(t) || (PROGRESS.test(t) && t.length <= 80) || ((PLACE_ORDER.test(t) || (WORK_NOUN.test(t) && (NOTE_MARK.test(t) || EDIT_ORDER.test(t)))) && t.length <= 100)
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
  if (OFTEN_ENGLISH.test(message) && !ownScriptCopy(message, locale)) return null
  if (SCRIPT_LETTER[locale].test(message)) return locale
  if (writesLatin(message, locale)) return null
  if (previous && writesLatin(previous, locale)) return null
  return locale
}

/** The piece without `code` and file names, quoted or not ("Existing pattern: "매장-전경.jpg" (hyphenated Korean)."):
 * a Korean file name does not make a line Korean, and quote marks around a file name do not make it a quote. */
/** A bracket's inside that is a label in another script, not content: non-ASCII, no Latin letter, no digit, currency
 * or sentence mark ("인", "서명 날인"; not "339,400원", "₩5") */
const isBracketName = (inner: string) => /[^\x00-\x7F]/.test(inner) && !/[A-Za-z0-9.!?。！？$€£¥₩%]/.test(inner)
/** `as`: what a name becomes. '' for the script checks (a Korean file name does not make a line Korean); 'file' for the
 * work-note checks, where a file name is the work named ("Now the SKILL.md.", 2026-11-22: taken out, it left "Now the ."
 * which named nothing, and the line led a Korean answer) */
const withoutNames = (s: string, as = '') => s.replace(/(?<!`)`[^`\n]+`(?!`)/g, as)
  // a quoted mark of no letters ("##", '---'): a name of markup, not a quote (TC-r2b-05)
  .replace(/["“'‘][^A-Za-z0-9\s"”'’]{1,4}["”'’]/g, as)
  // a short piece of another script in brackets is a name too: a form's own label ("Seal lands on (인) correctly.",
  // 2026-11-18 CHT-02.room); no Latin letter and no sentence mark in it
  .replace(/\(([^()\n]{1,12})\)/g, (m, inner: string) => isBracketName(inner) ? '' : m)
  .replace(/["“'‘「『][^"”'’」』\n]*\.[A-Za-z0-9]{1,5}["”'’」』]/g, as)
  .replace(/[^\s()"“”'‘’「」『』]+\.[A-Za-z0-9]{1,5}(?=[\s).,;:!?"”'’」』]|$)/g, as)

/** The person's own words in quote marks are a name too (2026-11-18, EDIT-17.project: '"공용 회의록" — likely in shared.
 * Find it.' went out because of the Korean in the quote): a quoted phrase of at most 40 characters found in the
 * person's message is taken out; partial: so is a quote still open at the end whose words so far are the person's
 * ('"공용 회'), as a file name not yet whole is. open: such an open quote was taken out. said: the person's message, as
 * norm() gives it. An apostrophe after a letter ("I'll", "Sora's") opens no quote. */
const QUOTED = /(?:["“‘「『]|(?<![A-Za-z])')([^"”'’」』\n]{1,40})["”'’」』]/g
const OPEN_QUOTE = /(?:["“‘「『]|(?<![A-Za-z])')([^"”'’」』\n]{1,40})$/
function withoutTheirWords(s: string, said: string, partial: boolean): { text: string; open: boolean } {
  if (!said) return { text: s, open: false }
  const theirs = (inner: string) => { const n = norm(inner); return n.length > 0 && said.includes(n) }
  s = s.replace(QUOTED, (q, inner: string) => theirs(inner) ? '' : q)
  const m = partial ? OPEN_QUOTE.exec(s) : null
  return m && theirs(m[1]!) ? { text: s.slice(0, m.index), open: true } : { text: s, open: false }
}

/** Markers of content: a link or address, Markdown (heading, list, bold, table, code, quote), quote marks, a number
 * with a unit or a currency ("Total: 42 files", "339,400 KRW", "$5"). */
const CONTENT = /https?:\/\/|www\.|\]\(|```|~~~|\*\*|__|\||^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/m
const CONTENT_WORDS = /["“”«»「」『』]|[$€£¥₩]\s*\d|(?<!\b(?:page|pages|row|rows|column|columns|step|line|slide|sheet|tab)\s+)\b\d[\d,.]*\s*(?:%|(?!(?:is|are|was|were|of|and|or|to|in|on|at|for|with|by|from|as|the|first|before|after|then|instead|again|only|too)\b)[A-Za-z]+\b)/i

/** The piece is surely not a status line, so it can go out now. partial: the piece is still coming (its last word may
 * be a file name not yet whole, its opening not yet known). */
function mustKeep(piece: string, script: AnswerScript, partial = false, notes = false, said = '', lead = false): boolean {
  piece = plainPunct(piece)
  const t = piece.trim()
  if (t.length > NARRATION_MAX_CHARS) return true
  const theirs = withoutTheirWords(partial ? piece : t, said, partial)
  // still coming: a bracket still open at the end may be such a name ("(인")
  // (after the last word, maybe not whole, is cut: "(서명 날인)" cut to "(서명 " is still such a bracket)
  const base = partial && !theirs.open ? theirs.text.replace(/\S+$/, '') : theirs.text
  const openName = partial && !theirs.open ? /\(([^()\n]{1,12})$/.exec(base) : null
  const named = openName && isBracketName(openName[1]!) ? base.slice(0, openName.index) : null
  const words = withoutNames(named ?? base)
  if (SCRIPT_LETTER[script].test(words)) return true
  // only ASCII text is ever a status line ("Hola equipo, ya está listo." is not one)
  if (/[^\x00-\x7F]/.test(words)) return true
  if (CONTENT.test(t) || CONTENT_WORDS.test(words)) return true
  if (t.split('\n').filter((l) => l.trim()).length > NARRATION_MAX_LINES) return true
  if ((t.match(/[.!?;:](?=\s|$)/g) ?? []).length > NARRATION_MAX_SENTENCES) return true
  if (CONTENT_LINE.test(t)) return true
  // still coming: "…, so I'll …" may be on its way, so only the whole piece decides
  // a work note (2026-11-17) only before a real call, whose arguments were checked (not on thinking, a stop or an error)
  // lead: a first line above the answer's own text (NarrationHold.dropLeadingNote) is only ever a status opening or the
  // AI thinking aloud about its tools (META), never judged by the wider work-note rules (review of #1272)
  const asWork = (x: string) => withoutNames(withoutTheirWords(x, said, false).text, 'file')
  const nowNote = (x: string) => { const w = asWork(x); return NOW_NOTE.test(w) && WORK_NOUN.test(w) }
  // ...or "Now the <work thing>." alone on that line (2026-11-22: "Now the SKILL.md." above a Korean answer)
  if (lead) return !partial && !STATUS_OPENING.test(t) && !META.test(withoutNames(withoutTheirWords(t, said, false).text)) && !nowNote(t)
  // a lead-in ("…:") right before a call leads into the call, not into text (2026-11-22, owner live: "Quick speed test on
  // a short stretch first:" under a Korean line while the run went on)
  const leadIn = notes && /:\s*$/.test(t) && !TO_PEOPLE.test(withoutNames(t))
  if (!partial && !leadIn && !STATUS_OPENING.test(t) && !STATUS_PLAN.test(t) && !(notes && (isWorkNote(withoutNames(withoutTheirWords(t, said, false).text)) || nowNote(t)))) return true
  return false
}

/** Text for "is this piece copied there": letters and digits only, lower case, single spaces (Markdown, HTML tags and
 * entities, emoji and punctuation do not count: "**Server maintenance** tonight!" holds "Server maintenance tonight."). */
const norm = (s: string) => s.replace(/<[^>\n]{0,200}>/g, ' ').replace(/&(?:#39|#x27|apos|rsquo|lsquo);/gi, "'").replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, ' ')
  .replace(/['\u2019]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Every string in a call's arguments, joined. */
function argText(input: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || out.length > 2000) return out
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
  const args = argText(input).join('\n')
  const a = norm(args.length > 1_000_000 ? args.slice(0, 1_000_000) : args)
  if (a.includes(p)) return true
  // posted with a small edit ("Price list updated (v3). Check the shared folder."): 80% of its words are there
  const words = p.split(' ').filter((w) => w.length >= 3)
  if (words.length < 3) return false
  const have = new Set(a.split(' '))
  return words.filter((w) => have.has(w)).length >= 0.8 * words.length
}

/** The piece, word for word, inside `text` (no 80%-of-words allowance): a command's heredoc that writes the piece's
 * text to a file (turn.ts deliveredArgs). */
export function includesPiece(piece: string, text: string): boolean {
  const p = norm(piece)
  return p.length >= 8 && norm(text.length > 1_000_000 ? text.slice(0, 1_000_000) : text).includes(p)
}

/** A whole piece that is a status line: it has Latin letters and nothing marks it as content. */
const isStatusLine = (piece: string, script: AnswerScript, input: unknown, message: string) =>
  /[A-Za-z]/.test(piece) && !mustKeep(piece, script, false, input !== undefined, norm(message)) && !copied(piece, input, message)

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
  /** the person's message as norm() gives it, once (the stream checks it on every piece of text) */
  private readonly said: string

  constructor(private readonly script: AnswerScript | null, private readonly message = '') { this.said = norm(message) }

  /** The part of the piece held back now. */
  get held(): string { return this.buf }

  /** Engine text: what can go out now ('' while the piece is undecided). */
  push(t: string): string {
    if (!t) return ''
    if (!this.script || this.decided) return t
    this.buf += t
    if (!mustKeep(this.buf, this.script, true, false, this.said)) return ''
    this.dropLeadingNote()
    return this.release()
  }

  /**
   * One piece may hold a note line and then the answer itself, with no call between them: "That folder is listed as
   * read-only, but I should call the tool and let the server decide.\n\n폴더에 쓸 권한이 없어서 …" (2026-11-18 TC-4865,
   * Korean answer). Once the answer's own script follows a whole first line in Latin letters, that line alone is
   * dropped when it is a status opening or the AI thinking aloud about its tools (META), never by the wider work-note
   * rules, so a report above the answer ("No files found.", "Two rows were added.") stays.
   */
  private dropLeadingNote() {
    const script = this.script!
    const m = /^(\s*)([^\n]+)\n/.exec(this.buf)
    if (!m) return
    const rest = this.buf.slice(m[0].length)
    // (a file name in the answer's script does not make the line the answer's: "Now the 견적서.pdf.")
    if (!SCRIPT_LETTER[script].test(rest) || SCRIPT_LETTER[script].test(withoutNames(m[2]!))) return
    const line = m[2]!
    if (!/[A-Za-z]/.test(line) || mustKeep(line, script, false, false, this.said, true) || copied(line, undefined, this.message)) return
    this.buf = rest.replace(/^\s+/, '')
    if (this.lead === null) this.lead = m[1]!
    this.dropped++
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

  /** The answer's script needs no Latin narration (narrationScript is set): the turn treats pieces a call follows as interim */
  get active(): boolean { return !!this.script }
  /** The piece is in the call's arguments: content shown before it is used (a message it posts, a file it writes). */
  copiedInto(piece: string, input: unknown): boolean { return copied(piece, input, '') }
  /** Is this whole piece a status line this hold would drop before a call (the turn's interim fallback skips those)? */
  wouldDrop(piece: string, input?: unknown): boolean { return !!this.script && isStatusLine(piece, this.script, input, this.message) }

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

/** Hangul, kana or CJK: a script answered in itself, never in Latin letters */
const NON_LATIN = /[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/
/** "latin", "cjk" (Hangul, kana, CJK) or null (too short or mixed to tell) */
function writtenIn(m: string): 'latin' | 'cjk' | null {
  const cjk = (m.match(/[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/g) ?? []).length
  const latin = (m.match(/[A-Za-z]{2,}/g) ?? []).length
  if (cjk >= 4 && latin < 3) return 'cjk'
  if (!NON_LATIN.test(m) && latin >= 3) return 'latin'
  return null
}
/**
 * A message in another script than the one before it (QA TC-7429, 2026-11-22: Daniel's English request in a chat begun
 * in Korean got a Korean answer, on both engines; the earlier messages and the Korean file names outweighed the
 * instructions' language line). The server says so next to the message, in its own block, only then.
 */
export function languageSwitchNote(message: string, previous: string | null | undefined): string | null {
  if (!previous) return null
  const now = writtenIn(ownWords(message)), before = writtenIn(ownWords(previous))
  if (!now || !before || now === before) return null
  return '<turn_context>\nThis message is written in another language than the messages before it: answer in the language of this message.\n</turn_context>'
}

/** The person's own words: the message without its quote lines ("> …"). A ✦ side chat puts the room message asked about
 * in front of the question as a quote, with the app's own English labels ("(thread_id … in this room)", "(file_id … in
 * this room)", web/src/components/rooms/SideChatPanel.tsx quoteLead), and its text is someone else's: neither is the
 * language the person writes in (QA TC-f1c-01: a Korean question under such a quote got an English answer). */
export const ownWords = (m: string): string => m.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n')

/** A message that quotes something ("> " lines) and has words of the person's own in a clear script: the answer follows
 * those words, never the quote (said next to the message, in its own block, like languageSwitchNote). */
export function quoteLanguageNote(message: string): string | null {
  if (!/^\s*>/m.test(message) || !writtenIn(ownWords(message))) return null
  return '<turn_context>\nThe lines that start with ">" quote a message (other people\'s words and the app\'s own labels such as "thread_id … in this room"): answer in the language of the user\'s own words, the lines without ">".\n</turn_context>'
}

/** The person's own words (quote lines left out) are mostly Latin script: more letters of Latin words than twice the
 * Hangul, kana and CJK characters (one of those carries about as much as two or three Latin letters). */
const mostlyLatin = (m: string) => {
  const own = ownWords(m)
  const latin = (own.match(/[A-Za-z]{2,}/g) ?? []).join('').length
  const cjk = (own.match(new RegExp(NON_LATIN.source, 'g')) ?? []).length
  return latin > 2 * cjk
}

/** The script whose final answers lose an English lead (finalAnswerLead), or null: the same detection as the interim
 * rule (narrationScript) on the person's own words (ownWords: a quote above them does not count), and off when those
 * words are mostly Latin letters. */
export function leadScript(locale: Locale, message: string, previous?: string | null): AnswerScript | null {
  if (mostlyLatin(message)) return null
  return narrationScript(locale, ownWords(message), previous ? ownWords(previous) : previous)
}

/** The longest paragraph (trimmed) the lead rule takes out of a final answer. */
export const LEAD_MAX_CHARS = 160
/** Markers of a paragraph that is content, by its shape: a code block or indented code, a link or address, a quote, a
 * list item, a table row, a heading (Markdown or a line in bold alone), or a file name alone. */
const LEAD_CONTENT = /```|~~~|https?:\/\/|www\.|\]\(|^\s*(?:>|[-*+•]\s|\d+[.)]\s|\||#{1,6}\s)|^ {4}|^\t/m
const BOLD_ALONE = /^\s*(?:\*\*|__)[^\n]+(?:\*\*|__)\s*$/
const FILE_ALONE = /^\s*`?[^\s`]+\.[A-Za-z0-9]{1,5}`?\s*$/

/**
 * A final answer that opens with the AI's own working notes in Latin letters, above an answer in the person's script
 * (2026-11-22, owner: "Need a venv.", "Good result. Saving it." at the top of Korean answers, after the last call).
 * Structural, no phrase list: the answer's leading paragraphs (split on blank lines) that hold no Hangul, kana or CJK
 * at all, are short (under LEAD_MAX_CHARS), have a Latin word, do not end in "," (a greeting: "Hi Tom,") and are no
 * code, link, quote, list item, table row, heading or file name alone. They are returned as `notes`, the rest as
 * `rest`; null when nothing leads, when the rest would be empty, or when the rest has none of the script (an English
 * answer stays whole). said: the person's message (a paragraph taken from it is content).
 */
export function finalAnswerLead(answer: string, script: AnswerScript | null, said = ''): { notes: string; rest: string } | null {
  if (!script) return null
  const saidNorm = norm(said)
  // (only blank lines part paragraphs: a paragraph keeps its indent, so indented code is seen as code)
  const re = /\n[ \t]*\n(?:[ \t]*\n)*/g
  let start = /^(?:[ \t]*\n)*/.exec(answer)![0].length
  let cut = -1
  const notes: string[] = []
  while (start < answer.length) {
    re.lastIndex = start
    const m = re.exec(answer)
    const end = m ? m.index : answer.length
    const para = answer.slice(start, end)
    const t = para.trim()
    if (!t || !isLeadNote(para, t, saidNorm)) break
    notes.push(t)
    cut = m ? re.lastIndex : answer.length
    if (!m) break
    start = re.lastIndex
  }
  if (cut < 0) return null
  const rest = answer.slice(cut)
  if (!rest.trim() || !SCRIPT_LETTER[script].test(rest)) return null
  return { notes: notes.join('\n\n'), rest }
}

function isLeadNote(para: string, t: string, said: string): boolean {
  if (NON_LATIN.test(t) || t.length >= LEAD_MAX_CHARS) return false
  if (!/[A-Za-z]{2,}/.test(t) || /,\s*$/.test(t)) return false
  if (LEAD_CONTENT.test(para) || BOLD_ALONE.test(t) || FILE_ALONE.test(t)) return false
  const n = norm(t)
  return !(n.length >= 8 && said.includes(n))
}
