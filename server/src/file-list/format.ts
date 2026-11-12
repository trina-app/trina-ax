// The line of one file and what is allowed in it (docs/AGENTS/plan/20261111-0630-file-list.md "Scope" 1).
//
//   relative/path — <type>; <names as written>; <date or period>; <what it is>
//
// English only. The model's answer is data from the file (it can carry anything the file says), and grep-first puts a
// line into every search for a file: every field is validated here, in code, before it is kept, and again when a line
// is rendered. One line; no control characters, `#`, `<>`, backticks, addresses, `@` or paths; `what` at most
// WHAT_MAX characters; a name of a text file must be in its text word for word. The scrubber removes amounts, ID,
// account, phone and card numbers, emails, passwords, keys and runs of 6+ digits outside the date field: a cleanup,
// not a security boundary (the reader is told the same, and only the file's own readers ever see its line). A personal
// record (checkups, reviews, payslips, discipline) keeps its type, names and date only.
import { maskSecrets } from '@mycel/shared'

export interface Fields {
  /** the document type in English ("business registration certificate", "photo", "unknown") */
  type: string
  /** proper names as the file writes them, in their own script */
  names: string[]
  /** the document's own date or period ("2025", "2025-03-14", "2025-07~2025-12", "2025 Q2"), or '' */
  date: string
  /** what it is, a short English phrase */
  what: string
  /** the main language of its text ("ko", "en", "none") */
  lang: string
}

export const TYPE_MAX = 60
export const NAME_MAX = 60
export const NAMES_MAX = 4
export const WHAT_MAX = 120

/** What a line says for a file nobody could identify. */
export const unknownFields = (what: string): Fields => ({ type: 'unknown', names: [], date: '', what, lang: 'none' })

// ---------------------------------------------------------------- the scrubber
const DATE_RE = /^(19|20)\d{2}([-./](0?[1-9]|1[0-2])([-./](0?[1-9]|[12]\d|3[01]))?)?$/
// Korean currency units, written as escapes (this is a pattern, not screen text): won, ten-thousand won, hundred
// million won, thousand won, and the bare ten-thousand / hundred million
const KRW = '(?:\\uB9CC\\s*\\uC6D0|\\uC5B5\\s*\\uC6D0|\\uCC9C\\s*\\uC6D0|\\uC6D0|\\uB9CC|\\uC5B5)'
const SENSITIVE: RegExp[] = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // email
  /\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/gi, // addresses
  /\S*[\/\\]\S*[\/\\]\S*|\S+[\/\\]\S+\.[A-Za-z0-9]{1,5}\b/g, // paths (two slashes, or a file name after one)
  /\b\d{6}\s*-\s*[1-8]\d{6}\b/g, // resident registration number
  /\b\d{3}-\d{2}-\d{5}\b/g, // business registration number
  /\b\d{3}-\d{2}-\d{4}\b/g, // social security number
  /(?:\+\d{1,3}[\s-]?)?\b0\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g, // phone
  /\+\d{1,3}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}\b/g, // international phone
  /\b(?:password|passwd|passcode|pin|pwd|pw|otp)\s*[:=]\s*\S+/gi, // a password written out
  /(?:[₩$€£¥]|\b(?:USD|KRW|EUR|JPY|IDR|Rp)\b)\s*\d[\d,.]*(?:\s*(?:k|m|bn|million|billion|thousand))?/gi, // currency first
  new RegExp(`\\d[\\d,.]*\\s*(?:${KRW}|(?:dollars?|won|yen|euros?|rupiah|USD|KRW|EUR|JPY|IDR)\\b)`, 'gi'), // currency after
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, // 1,234,567
  /\b\d+(?:\.\d+)?\s?%/g, // percentages (margins, scores)
]
// account / card / ID numbers: 6+ digits with hyphens, or three groups of digits split by spaces; dates are kept
const LONG_DIGITS = /\b\d[\d-]{4,}\d\b|\b\d{2,6}(?: \d{2,6}){2,}\b/g

/** One field as the list may hold it: one line, NFC, without sensitive values; `…` where something was removed. */
export function scrub(s: unknown): string {
  let t = String(s ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
  t = maskSecrets(t, '…')
  for (const r of SENSITIVE) t = t.replace(r, '…')
  // runs of 6+ digits (account, card, ID numbers; a date written without separators too: the date has its own field);
  // a date with separators (2025-03-14) and a span of years stay
  t = t.replace(LONG_DIGITS, (m) => {
    const keep = (DATE_RE.test(m) && /[-./]/.test(m)) || /^(19|20)\d{2}\s*[-~]\s*(19|20)\d{2}$/.test(m)
    return keep ? m : '…'
  }).replace(/\d{6,}/g, '…')
  // the line's own separators, anything a Markdown viewer would draw, and mentions
  t = t.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1').replace(/\s+—\s+/g, ' - ').replace(/[|<>`#@\\]/g, ' ')
  t = t.replace(/(?:…\s*){2,}/g, '… ')
  return t.replace(/\s+/g, ' ').trim().replace(/^[\s;:,#*>-]+/, '').replace(/[\s;:,]+$/, '')
}

/** A field cut to `max` characters at a word when it can be. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s
  const head = s.slice(0, max - 1)
  const sp = head.lastIndexOf(' ')
  return (sp > max / 2 ? head.slice(0, sp) : head).replace(/[\s,;:.-]+$/, '') + '…'
}

// ---------------------------------------------------------------- dates
const YMD = /^((?:19|20)\d{2})(?:[-./](\d{1,2}))?(?:[-./](\d{1,2}))?$/
const pad = (n: string) => n.padStart(2, '0')
function oneDate(s: string): string | null {
  const m = YMD.exec(s.trim())
  if (!m) return null
  const [, y, mo, d] = m
  if (mo && (Number(mo) < 1 || Number(mo) > 12)) return null
  if (d && (Number(d) < 1 || Number(d) > 31)) return null
  return [y, mo ? pad(mo) : null, d ? pad(d) : null].filter(Boolean).join('-')
}
/** The date field as the list writes it: a date, a range of two, a quarter or half of a year; anything else is ''. */
export function cleanDate(s: unknown): string {
  const t = String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  const one = oneDate(t)
  if (one) return one
  const range = /^(.+?)\s*(?:~|–|—|\bto\b|\s-\s)\s*(.+)$/i.exec(t)
  if (range) { const a = oneDate(range[1]!), b = oneDate(range[2]!); if (a && b) return `${a}~${b}` }
  const q = /^(?:((?:19|20)\d{2})\s*[- ]?\s*([QH][1-4])|([QH][1-4])\s*[- ]?\s*((?:19|20)\d{2}))$/i.exec(t)
  if (q) {
    const y = q[1] ?? q[4]!, p = (q[2] ?? q[3]!).toUpperCase()
    if (p[0] === 'H' && Number(p[1]) > 2) return ''
    return `${y} ${p}`
  }
  return ''
}

/**
 * true when `date` only repeats a date in the file's name (small models do it although told not to): the path is on
 * the same line already, and a scan or save date is not the document's date. A date that is in the text too stays.
 */
export function dateFromName(rel: string, date: string, text = ''): boolean {
  const m = /^((?:19|20)\d{2})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(date)
  if (!m) return false
  const [, y, mo, d] = m as unknown as [string, string, string | undefined, string | undefined]
  const forms = d ? [y + mo + d, y.slice(2) + mo + d, mo! + d] : mo ? [y + mo] : []
  if (!forms.length) return false
  const name = rel.slice(rel.lastIndexOf('/') + 1).replace(/[\s\-._]/g, '')
  if (!forms.some((f) => name.includes(f))) return false
  const flat = text.replace(/[\s\-./]/g, '')
  return !forms.slice(0, 2).some((f) => flat.includes(f))
}

// ---------------------------------------------------------------- the model's answer
/** Personal records: type, names and date only, never findings (Haiku wrote checkup findings and review results even
 * when told not to, in the prototype). Matched on the English type. */
const PERSONAL = /health|medical|diagnos|check-?up|clinic|hospital|prescription|performance review|evaluation|appraisal|self-assessment|disciplinary|warning letter|payslip|pay slip|pay stub|salary statement|payroll|withholding|grade report|transcript of records/i
export const isPersonal = (f: Pick<Fields, 'type'>) => PERSONAL.test(f.type)

const SEP = /[;]/g
/** text compared word for word: NFC, any letter case, white space as one space */
const fold = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ')
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * One file's fields from the model's answer, validated and scrubbed: only the known keys, strings of bounded length,
 * at most NAMES_MAX names, a date of an allowed form (and not one that only repeats the file name). null when the
 * answer has no usable type. `rel` and `text`: the file's path and the text the model saw (for the name-date rule).
 */
export function cleanFields(raw: unknown, rel: string, text = ''): Fields | null {
  if (!isObj(raw)) return null
  const type = cut(scrub(raw.type).replace(SEP, ',').toLowerCase(), TYPE_MAX)
  if (!type || type === '…') return null
  // a name of a text file is in its text word for word (an injected "name" is not); a picture's names cannot be
  // checked, so they keep letters, digits and a few joining marks only
  const haystack = fold(text)
  const names: string[] = []
  for (const n of Array.isArray(raw.names) ? raw.names.slice(0, 10) : []) {
    if (typeof n !== 'string') continue
    const c = cut(scrub(n).replace(/[;,]/g, ' ').replace(/\s+/g, ' ').trim(), NAME_MAX)
    if (!c || c.includes('…') || /^[\d\s.-]+$/.test(c) || names.some((x) => x.toLowerCase() === c.toLowerCase())) continue
    if (text ? !haystack.includes(fold(c)) : !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} .&'()-]*$/u.test(c)) continue
    names.push(c)
    if (names.length >= NAMES_MAX) break
  }
  let date = cleanDate(raw.date)
  if (date && dateFromName(rel, date, text)) date = ''
  const what = cut(scrub(raw.what).replace(SEP, ','), WHAT_MAX)
  const lang = typeof raw.lang === 'string' && /^[a-z]{2,3}$|^none$/.test(raw.lang.trim().toLowerCase()) ? raw.lang.trim().toLowerCase() : 'none'
  return { type, names, date, what: what || (type === 'unknown' ? 'not identified' : ''), lang }
}

/** The line of one file. `real`: the format the bytes say when the name's extension says another one. */
export function renderLine(rel: string, f: Fields, real: string | null = null): string {
  const path = rel.normalize('NFC')
  // rendered from the kept fields, scrubbed again: a stored line can never hold more than today's rules allow
  const type = scrub(f.type).replace(SEP, ',') || 'unknown'
  const names = f.names.map((n) => scrub(n).replace(/[;,]/g, ' ').trim()).filter((n) => n && n !== '…')
  let what = isPersonal({ type }) ? 'personal record, details left out' : scrub(f.what).replace(SEP, ',')
  if (real) what = `${what ? what + ' ' : ''}(actually a ${real} file despite the extension)`
  return `${path} — ${type}; ${names.length ? names.join(', ') : '-'}; ${cleanDate(f.date) || '-'}; ${what || '-'}`
}
