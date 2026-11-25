// Auto memory (docs/decisions/20261122-auto-memory.md): the checks that keep a memory the AI saves on its own to what
// the person said or what the AI learned about doing their task. Nothing here asks the person anything: a memory that
// fails a check is skipped silently (chat/tools.ts remember says so in the step and in its answer to the AI).
//
//   copiedFromOutside  a memory whose words come from tool output (mail, pages, files, rooms, connections)
//   outsideAddress     an address, number, path, #channel or room name in the memory seen only in tool output
//   secretIn           a password, key, token, card number or one-time code with its value
//   nearDuplicate      an existing memory that says nearly the same
//   OutsideText        what tool output came into each chat, in memory only (never on disk; a restart forgets it)
import type { Database } from 'bun:sqlite'
import type { UserPrefs } from '@mycel/shared/api'
import { isQuoteLine, withoutQuoteLines } from './read-rooms'

/** silent saves at most per answer and per person per 24 hours (source 'auto'); past them a save is skipped */
export const AUTO_PER_ANSWER = 2
export const AUTO_PER_DAY = 20
/** forgets per answer in a conversation that has seen outside content */
export const FORGET_PER_ANSWER = 2
/** a run of this many words of the memory found in tool output (and not in the person's own words) is a copy */
export const COPY_RUN_WORDS = 6
/** ...and for Japanese and Chinese script (no spaces between words): a run of this many characters */
export const COPY_RUN_CHARS = 12
/** word overlap at or above which a new memory is a near duplicate of an existing one */
export const NEAR_DUPLICATE = 0.7
/** what is kept of a chat's tool output, newest kept */
export const OUTSIDE_PER_CHAT = 512 * 1024
const OUTSIDE_CHATS = 500
/** the first characters of each chat's record, kept however much comes after */
const OUTSIDE_HEAD = 128 * 1024
/** a memory the AI keeps on its own: at most this many characters (review of #332, L2) */
export const AUTO_TEXT_MAX = 200

/** The person's "자동으로 기억하기" (Settings › Memory): on unless they turned it off. Read when the tool is called. */
export function autoMemoryOn(db: Database, userId: string): boolean {
  try {
    const r = db.query('SELECT prefs FROM users WHERE id = ?').get(userId) as { prefs: string | null } | null
    const p = JSON.parse(r?.prefs || '{}') as UserPrefs
    return p.autoMemory !== 'off'
  } catch { return true }
}

/** The request shapes with which a person asks to keep something, in the six app languages (QA TC-7737: with auto
 * memory off, a memory is kept only when the person's own message asks for it). Only a request counts: a negation
 * ("don't remember", "기억하지 마", "不记得", "tidak ingat", "覚えてない", "no recuerdo") or a question ("Do you remember…?",
 * "기억나?") does not (security review of #377). */
const ASKS_TO_REMEMBER: RegExp[] = [
  // ko: 기억해 줘 / 둬 / 놔 / 주세요, a bare 기억해 at the end of a sentence, 잊지 마
  /기억해\s*(?:줘|줄래|둬|놔|놓아|주세요|두세요|놓으세요|주실래요)/u, /기억해\s*[.!~]*$/u, /기억하세요/u, /잊지\s*마(?:세요|요|라)?/u,
  // en: an imperative at the start of a sentence (after "please", "also" …), "don't forget", "keep in mind"
  /^(?:(?:please|pls|also|and|so|just|now|ok|okay|hey)[\s,]+)*(?:remember|memori[sz]e|keep\s+in\s+mind)\b/iu,
  /\b(?:please|pls)\s+(?:remember|memori[sz]e|keep\s+in\s+mind)\b/iu,
  /(?<!\b(?:i|we)\s)\b(?:don['\u2019]?t|do\s+not)\s+forget\b/iu,
  // ja
  /覚えて(?:おいて|おいてください|ください|ね|て)|覚えといて|忘れないで/u,
  // zh
  /(?<![不没没有])(?:请|要)?记住|(?<![不没])記住|别忘|不要忘|请记得|要记得|记得要/u,
  // es
  /^(?:(?:por\s+favor|y|también)[\s,]+)*recuerda(?:lo|me)?\b/iu, /\bpor\s+favor\s+recuerda/iu, /\bno\s+olvides\b/iu, /\bten\s+en\s+cuenta\b/iu,
  // id
  /^(?:(?:tolong|harap|mohon|dan)\s+)*ingat(?:lah|kan)?\b/iu, /\b(?:tolong|harap|mohon)\s+ingat/iu, /\bjangan\s+lupa\b/iu,
]
/** Does the person's own message ask to keep something ("기억해 줘", "remember that …", "覚えておいて", "记住" …)? Quoted
 * lines ("> …", someone else's words) are left out by the caller; a sentence that ends in a question mark never counts. */
export function asksToRemember(message: string | null | undefined): boolean {
  if (!message) return false
  const sentences = stripInvisible(message).normalize('NFKC').split(/(?<=[.!?。！？\n])/u).map((x) => x.trim()).filter(Boolean)
  return sentences.some((s) => !/[?？]$/u.test(s) && ASKS_TO_REMEMBER.some((re) => re.test(s)))
}

/** Is this the first memory the AI keeps on its own for the person (the one-time line under its step)? Marks it seen. */
export function firstAutoMemory(db: Database, userId: string): boolean {
  try {
    const r = db.query('SELECT prefs FROM users WHERE id = ?').get(userId) as { prefs: string | null } | null
    const p = JSON.parse(r?.prefs || '{}') as Record<string, unknown>
    if (p.autoMemoryNotice === 'seen') return false
    db.query('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify({ ...p, autoMemoryNotice: 'seen' }), userId)
    return true
  } catch { return false }
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
/** characters that show nothing (format characters, default-ignorable ones such as zero-width spaces and soft hyphens,
 * tag characters U+E0000–E007F, bidi controls): deleted, never turned into a space, so "re\u200bmember" is "remember"
 * (security review of #332, H1) */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u{E0000}-\u{E007F}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu
export const stripInvisible = (s: string): string => s.replace(INVISIBLE, '')
/** letters from other scripts that look like Latin ones (a small skeleton: Cyrillic and Greek look-alikes) */
const CONFUSABLE: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ԛ: 'q', ԝ: 'w',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y',
}
const skeleton = (s: string) => s.replace(/[\u0370-\u03ff\u0400-\u052f]/g, (c) => CONFUSABLE[c] ?? c)
/** Tool output as a reader sees it: invisible characters deleted, inline HTML tags and markdown emphasis taken out
 * ("<b>al</b>ways", "al**ways" read "always") */
export function cleanOutside(s: string): string {
  // tag characters spell hidden ASCII that a model may read: decoded, so a copy of them is caught
  return stripInvisible(decodeEntities(s.replace(/[\u{E0020}-\u{E007E}]/gu, (c) => String.fromCharCode(c.codePointAt(0)! - 0xE0000))))
    .replace(/<[^<>]{0,200}>/g, '').replace(/(\*\*|__|~~|\*|_|`)/g, '')
}
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c' }
/** HTML entities ("&#114;emember", "&amp;", "&shy;") as the characters they show (review follow-up 1) */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});?/gi, (m, e: string) => {
    const cp = e[0] === '#' ? (e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : NaN
    if (!Number.isNaN(cp)) return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    return ENTITIES[e.toLowerCase()] ?? m
  })
}
/** spaces other than the plain one (no-break, thin, ideographic …) */
const ODD_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g
/** case, width, accents (NFKD, marks dropped), look-alike letters, punctuation and spaces folded: what a copy check
 * compares. `oddSpaces`: 'space' reads a no-break or thin space as a space, 'none' as nothing (a word split by one) */
export function fold(s: string, oddSpaces: 'space' | 'none' = 'space'): string {
  const t = stripInvisible(s).replace(ODD_SPACE, oddSpaces === 'none' ? '' : ' ').normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFKC').toLowerCase()
  return skeleton(t).replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim()
}
const words = (s: string) => fold(s).split(' ').filter(Boolean)
const squeeze = (s: string) => fold(s).replace(/\s+/g, '')

/**
 * Is `memory` copied from `outside` (tool output)? A run of COPY_RUN_WORDS words of it found there and not in `own`
 * (the person's own messages of this chat), or a memory shorter than that found whole; for text in Japanese or Chinese
 * script also a run of COPY_RUN_CHARS characters, spaces removed. Empty `outside`: nothing to check.
 */
export function copiedFromOutside(memory: string, outside: string, own: string): boolean {
  if (!outside) return false
  // a no-break or thin space inside a word hides it as two: the check reads the output both ways
  if (/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/.test(outside) && copiedFrom(memory, fold(cleanOutside(outside), 'none'), own)) return true
  return copiedFrom(memory, fold(cleanOutside(outside)), own)
}
function copiedFrom(memory: string, foldedOutside: string, own: string): boolean {
  const outside = foldedOutside
  memory = cleanOutside(memory)
  // the person's own words cleaned the same way as the other two (markdown marks dropped): a skill line read back with
  // "**맨 아래**에" is "맨 아래에" in the output and in the new text, and must be the same in the person's own words
  // (real-AI QA of #609: an edit of such a line was refused as copied from the skill's own read). Invisible characters
  // go first: tag characters a person pasted unseen are not their words, so they are never decoded on this side
  // (#332 H1: hidden text in a pasted snippet must not count as the person's own)
  own = cleanOutside(stripInvisible(own))
  const out = ` ${outside} `, mine = ` ${fold(own)} `
  const w = words(memory)
  if (w.length) {
    if (w.length < COPY_RUN_WORDS) {
      const whole = ` ${w.join(' ')} `
      // a whole short memory of one or two words is too common to call a copy (a name, "PDF")
      if (w.length >= 3 && out.includes(whole) && !mine.includes(whole)) return true
    } else {
      for (let i = 0; i + COPY_RUN_WORDS <= w.length; i++) {
        const run = ` ${w.slice(i, i + COPY_RUN_WORDS).join(' ')} `
        if (out.includes(run) && !mine.includes(run)) return true
      }
    }
  }
  if (CJK.test(memory)) {
    const m = squeeze(memory), o = squeeze(outside), me = squeeze(own)
    for (let i = 0; i + COPY_RUN_CHARS <= m.length; i++) {
      const run = m.slice(i, i + COPY_RUN_CHARS)
      if (!CJK.test(run)) continue
      if (o.includes(run) && !me.includes(run)) return true
    }
  }
  return false
}

const ADDRESS_PATTERNS: RegExp[] = [
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, // e-mail
  /\bhttps?:\/\/[^\s<>"')]+/gi, // web address
  /\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|app|ai|co|kr|jp|cn|dev|me|xyz|info|biz)(?:\/[^\s<>"')]*)?/gi, // bare domain
  /\+?\d[\d\s().-]{7,}\d/g, // phone or long number
  /#[\p{L}\p{N}_-]{2,}/gu, // #channel or room
  /(?:^|[\s"'(])((?:shared|users|projects|groups|skills|Projects|Shared)\/[^\s"')]+)/g, // team folder path
  /[^\s›]+(?:\s*›\s*[^\s›]+)+/g, // "A › B" place words
]

/** The addresses, numbers, team paths, #channels and room names in `s` (folded, for comparing). */
export function addressesIn(s: string): string[] {
  const found = new Set<string>()
  for (const re of ADDRESS_PATTERNS) {
    for (const m of s.matchAll(re)) {
      const v = (m[1] ?? m[0]).trim()
      // a date is not an address (a dated fact may be kept: "the launch is on 2026-12-01")
      if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(v)) continue
      const k = v.replace(/[\s().-]/g, '').toLowerCase().replace(/[.,;:!?]+$/, '')
      if (k.length >= 4) found.add(k)
    }
  }
  return [...found]
}

/** One of the memory's addresses (or numbers, paths, #channels, room names) that tool output showed and the person
 * never wrote in this chat, or null. Empty `outside`: nothing to check. */
export function outsideAddress(memory: string, outside: string, own: string): string | null {
  if (!outside) return null
  const strip = (s: string) => s.replace(/[\s().-]/g, '').toLowerCase()
  const out = strip(outside), mine = strip(own)
  for (const a of addressesIn(memory)) if (out.includes(a) && !mine.includes(a)) return a
  return null
}

/** A text with the usual disguises of an address undone: invisible characters, full-width letters, look-alikes,
 * "[at]", "(at)", " at ", "[dot]", "(dot)", " dot ", "hxxp" */
export function undisguise(s: string): string {
  return skeleton(stripInvisible(s).normalize('NFKC').toLowerCase())
    .replace(/\s*[[({<]\s*(?:at|@)\s*[\])}>]\s*/g, '@').replace(/\s+at\s+(?=[a-z0-9-]+\s*(?:[[({<]\s*dot\s*[\])}>]|\.|\s+dot\s+))/g, '@')
    .replace(/\s*[[({<]\s*(?:dot|\.)\s*[\])}>]\s*/g, '.').replace(/\s+dot\s+/g, '.')
    .replace(/\bhxxp(s?)/g, 'http$1').replace(/\bh\*\*p(s?)/g, 'http$1')
    // Korean spellings: "billing 골뱅이 evil 닷 com" (only between letters or digits, so "닷새" stays a word)
    .replace(/(?<=[a-z0-9])\s*골뱅이\s*(?=[a-z0-9])/g, '@').replace(/(?<=[a-z0-9])\s*닷\s*(?=[a-z0-9])/g, '.')
}
const CONTACT_PATTERNS: RegExp[] = [
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, // e-mail
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"')]+/gi, // any address with a scheme
  // any dotted name that ends in letters (pay.evil.shop, evil.store/pay): every top-level domain, known or not (review
  // follow-up 2; a file name such as "report.docx" counts too, and is kept only when the person wrote it)
  /(?<![\p{L}\p{N}@._-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![\p{L}\p{N}])(?:\/[^\s<>"')]*)?/giu, // a domain
  /\+?\d[\d\s().-]{7,}\d/g, // a phone or long number
  /(?:^|[^\p{L}\p{N}._%+-])(@[\p{L}\p{N}_.]{2,})/gu, // an @handle
]
/** The e-mail addresses, web addresses, domains, phone numbers and @handles in `s`, undisguised and compacted. */
export function contactsIn(s: string): string[] {
  const t = undisguise(s), found = new Set<string>()
  for (const re of CONTACT_PATTERNS) for (const m of t.matchAll(re)) {
    const v = (m[1] ?? m[0]).trim()
    if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(v)) continue // a date
    const k = v.replace(/[\s().-]/g, '').replace(/[.,;:!?]+$/, '')
    if (k.length >= 3) found.add(k)
  }
  return [...found]
}
/** A contact (e-mail, web address, domain, phone, @handle) in a memory kept on the AI's own judgement that the person
 * did not write in this chat, however tool output may have disguised it, or null (review of #332, H2) */
export function contactNotOwn(memory: string, own: string): string | null {
  const mine = undisguise(own).replace(/[\s().-]/g, '')
  for (const c of contactsIn(memory)) if (!mine.includes(c)) return c
  return null
}

const SECRET_WORD = String.raw`(?<![\p{L}\p{N}])(?:password|passwd|passphrase|passcode|pwd|pw|pin|비밀번호|비번|암호|패스워드|パスワード|暗証番号|密码|口令|contraseña|clave|kata\s*sandi|sandi)`
const VALUE = String.raw`[^\s\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{4,}`
const SECRET_PATTERNS: RegExp[] = [
  // "password: hunter2", "pw=abcd" — a colon or equals sign and a value
  new RegExp(String.raw`${SECRET_WORD}\s*[:：=]\s*${VALUE}`, 'iu'),
  // "password is x7#k2", "비밀번호는 abc123" — a word between, and the value holds a digit or a symbol
  new RegExp(String.raw`${SECRET_WORD}\s*(?:is|was|은|는|이|가|が|は|是|es|adalah)\s*(?=[^\s]*[\d!@#$%^&*_+=~?])${VALUE}`, 'iu'),
  // a keyword and right after it a token with a digit or a symbol, no separator ("pw hunter22", "PIN 4821", "비밀번호 abc123")
  new RegExp(String.raw`${SECRET_WORD}\s+(?=[^\s]*[\d!@#$%^&*_+=~?])${VALUE}`, 'iu'),
  // "password for the NAS = x7k2!", "pw of wifi is 4821abc": a keyword, a word or two it is for, then the value
  new RegExp(String.raw`${SECRET_WORD}\s+(?:for|of|to|on)\s+\S+(?:\s+\S+)?\s*(?:[:：=]|is)\s*(?=[^\s]*[\d!@#$%^&*_+=~?])${VALUE}`, 'iu'),
  // "wifi pass is x7k2!", "와이파이 비번 4821abcd"
  new RegExp(String.raw`(?<![\p{L}\p{N}])(?:wi-?fi|와이파이)\s*(?:pass(?:word)?|pw|key|비번|비밀번호|암호)?\s*(?:is|[:：=]|은|는)?\s*(?=[^\s]*[\d!@#$%^&*_+=~?])${VALUE}`, 'iu'),
  // "login: sora / x7k2!", "로그인 sora / Abc123!"
  new RegExp(String.raw`(?<![\p{L}\p{N}])(?:login|log-in|sign-?in|로그인|계정)\s*[:：=]?\s*\S+\s*\/\s*(?=[^\s]*[\d!@#$%^&*_+=~?])${VALUE}`, 'iu'),
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style keys
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/, // Stripe
  /\bxapp-[A-Za-z0-9-]{10,}/, // Slack app tokens
  /\bASIA[0-9A-Z]{16}\b/, // AWS temporary keys
  /\bglpat-[A-Za-z0-9_-]{16,}/, // GitLab
  /\bhf_[A-Za-z0-9]{20,}/, // Hugging Face
  /\bnpm_[A-Za-z0-9]{20,}/, // npm
  /\bya29\.[A-Za-z0-9_-]{20,}/, // Google OAuth access tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[0-9a-f]{32,}\b/i, // long hex
  /\b(?:api[_ -]?key|token|secret|bearer)\s*[:：=]?\s*[A-Za-z0-9_\-./+]{20,}/i,
  // one-time codes: "인증번호 482913", "OTP: 123456", "code is 4821"
  /(?:otp|인증\s*번호|인증\s*코드|verification\s*code|one[- ]time\s*code|code)\s*(?:is|은|는|:|：)?\s*\d{4,8}\b/i,
]

function luhn(digits: string): boolean {
  let sum = 0, alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

/** Does `s` hold a secret with its value (a password, a key, a token, a card number, a one-time code)? A bare keyword
 * is not one: "비밀번호는 메일로 보내지 말 것" is a preference. */
export function secretIn(s: string): boolean {
  s = stripInvisible(s).normalize('NFKC')
  if (SECRET_PATTERNS.some((re) => re.test(s))) return true
  for (const m of s.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const d = m[0].replace(/[ -]/g, '')
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return true
  }
  return false
}

/** The existing memory that says nearly the same as `text` (word overlap at or above NEAR_DUPLICATE), or null. */
export function nearDuplicate(text: string, existing: readonly { id: string; text: string }[]): { id: string; text: string; exact: boolean } | null {
  const a = new Set(words(text)), fa = fold(text)
  let best: { id: string; text: string; exact: boolean; score: number } | null = null
  for (const m of existing) {
    if (fold(m.text) === fa) return { id: m.id, text: m.text, exact: true }
    const b = new Set(words(m.text))
    if (!a.size || !b.size) continue
    let both = 0
    for (const x of a) if (b.has(x)) both++
    const score = both / (a.size + b.size - both)
    if (score >= NEAR_DUPLICATE && (!best || score > best.score)) best = { id: m.id, text: m.text, exact: false, score }
  }
  return best ? { id: best.id, text: best.text, exact: false } : null
}

/** How many saves without a card this answer and the last 24 hours have; past the caps a save is skipped. */
export function autoCapReached(db: Database, userId: string, turnId: string, now = Date.now()): 'answer' | 'day' | null {
  // every save made without a card while auto memory is on counts, new or a change, asked or not (review of #332, M1):
  // the audit lines of remember (memory.auto_create / memory.auto_update with silent: true)
  const silent = "actor_id = ? AND action IN ('memory.auto_create', 'memory.auto_update') AND json_extract(detail, '$.silent') = 1"
  const inTurn = (db.query(`SELECT count(*) n FROM audit_log WHERE ${silent} AND json_extract(detail, '$.turnId') = ?`).get(userId, turnId) as { n: number }).n
  if (inTurn >= AUTO_PER_ANSWER) return 'answer'
  const since = new Date(now - 24 * 3600_000).toISOString()
  const inDay = (db.query(`SELECT count(*) n FROM audit_log WHERE ${silent} AND at >= ?`).get(userId, since) as { n: number }).n
  return inDay >= AUTO_PER_DAY ? 'day' : null
}

/** The person's own messages in this chat (the newest 200), for "the person wrote it". Quote lines ("> …") are someone
 * else's words, whoever pasted them (chat/read-rooms.ts isQuoteLine): left out. `shared`: a chat other people write in
 * (docs/decisions/20261125-auto-memory-shared-chats.md): only messages with the person as their author count. */
export function ownWords(db: Database, chatId: string, userId: string, shared = false): string {
  // (a shared chat: a message with no author is the chat owner's, from before authors were kept, as chat/tools.ts reads it)
  const rows = (shared
    ? db.query(`SELECT m.content FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.chat_id = ? AND m.role = 'user' AND ${WRITER} = ? ORDER BY m.created_at DESC LIMIT 200`).all(chatId, userId)
    : db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'user' AND (author_id IS NULL OR author_id = ?) ORDER BY created_at DESC LIMIT 200").all(chatId, userId)) as { content: string | null }[]
  return rows.map((r) => withoutQuoteLines(r.content ?? '')).join('\n')
}
/** who wrote a user message `m` of chat `c`: its author, or with none (before authors were kept) the chat's owner */
const WRITER = 'COALESCE(m.author_id, c.user_id)'

/**
 * What other people brought into a shared chat, as the copy and address checks read tool output
 * (docs/decisions/20261125-auto-memory-shared-chats.md): every message another person wrote, the answers to their
 * turns, and the quote lines in the person's own messages. Read from the database on every call, so a restart or a new
 * session never empties it (unlike OutsideText). The newest 200 of each.
 */
export function othersWords(db: Database, chatId: string, userId: string): string {
  const theirs = db.query(`SELECT m.content FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.chat_id = ? AND m.role = 'user' AND ${WRITER} != ? ORDER BY m.created_at DESC LIMIT 200`).all(chatId, userId) as { content: string | null }[]
  const answers = db.query(`SELECT a.content FROM messages a JOIN messages m ON m.id = a.parent_id JOIN chats c ON c.id = m.chat_id
    WHERE a.chat_id = ? AND a.role = 'assistant' AND m.role = 'user' AND ${WRITER} != ? ORDER BY a.created_at DESC LIMIT 200`).all(chatId, userId) as { content: string | null }[]
  const quoted = db.query(`SELECT m.content FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.chat_id = ? AND m.role = 'user' AND ${WRITER} = ? ORDER BY m.created_at DESC LIMIT 200`).all(chatId, userId) as { content: string | null }[]
  return [
    ...theirs.map((r) => r.content ?? ''), ...answers.map((r) => r.content ?? ''),
    ...quoted.map((r) => (r.content ?? '').split('\n').filter(isQuoteLine).join('\n')),
  ].filter(Boolean).join('\n')
}

/** The person's memories a shared chat's turn may see and change: those the AI kept in this very chat (their words are
 * in its transcript), never the person's private ones (docs/decisions/20261125-auto-memory-shared-chats.md). */
export function chatMemories(db: Database, userId: string, chatId: string): { id: string; text: string; source: string }[] {
  return db.query("SELECT id, text, source FROM memories WHERE user_id = ? AND shared_chat_id = ? ORDER BY (source = 'user') DESC, created_at DESC, id DESC LIMIT 200").all(userId, chatId) as { id: string; text: string; source: string }[]
}

/**
 * The tool output that came into each chat, newest kept (OUTSIDE_PER_CHAT), in memory only. A fresh session clears its
 * chat (what the engine still holds is what counts); a restart clears everything, and then there is nothing to check.
 */
export class OutsideText {
  private chats = new Map<string, { head: string; parts: string[]; size: number; blind: boolean }>()
  add(chatId: string, text: string) {
    if (!text) return
    const c = this.entry(chatId)
    // the first part of the chat's record is kept as well as the newest (review of #332, L3): an instruction early in
    // a long read is not pushed out by what came after it
    if (c.head.length < OUTSIDE_HEAD) {
      const room = OUTSIDE_HEAD - c.head.length
      c.head += (c.head ? '\n' : '') + text.slice(0, room)
      if (text.length <= room) return
      text = text.slice(room)
    }
    const t = text.length > OUTSIDE_PER_CHAT ? text.slice(-OUTSIDE_PER_CHAT) : text
    c.parts.push(t)
    c.size += t.length
    while (c.size > OUTSIDE_PER_CHAT && c.parts.length > 1) c.size -= c.parts.shift()!.length
  }
  /** a tool result the server could not read came in (a picture, the engine's own web search, a result cut short) */
  markBlind(chatId: string) { this.entry(chatId).blind = true }
  blind(chatId: string): boolean { return !!this.chats.get(chatId)?.blind }
  of(chatId: string): string { const c = this.chats.get(chatId); return c ? [c.head, ...c.parts].filter(Boolean).join('\n') : '' }
  clear(chatId: string) { this.chats.delete(chatId) }
  private entry(chatId: string) {
    let c = this.chats.get(chatId)
    if (c) this.chats.delete(chatId) // newest last, for the cap on chats
    else c = { head: '', parts: [], size: 0, blind: false }
    this.chats.set(chatId, c)
    while (this.chats.size > OUTSIDE_CHATS) this.chats.delete(this.chats.keys().next().value!)
    return c
  }
}

/** Tools whose output is not outside content: the person's own answer (ask_user) and the AI's own bookkeeping. */
export const NOT_OUTSIDE_TOOLS: ReadonlySet<string> = new Set(['ask_user', 'remember', 'forget', 'todo_write', 'set_title', 'write', 'edit', 'edit_files'])

/** The text of a tool result's content blocks. */
export function resultText(content: readonly { type: string; text?: string }[] | undefined): string {
  return (content ?? []).map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n')
}
