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

/** silent saves at most per answer and per person per 24 hours (source 'auto'); past them a save is skipped */
export const AUTO_PER_ANSWER = 2
export const AUTO_PER_DAY = 20
/** a run of this many words of the memory found in tool output (and not in the person's own words) is a copy */
export const COPY_RUN_WORDS = 6
/** ...and for Japanese and Chinese script (no spaces between words): a run of this many characters */
export const COPY_RUN_CHARS = 12
/** word overlap at or above which a new memory is a near duplicate of an existing one */
export const NEAR_DUPLICATE = 0.7
/** what is kept of a chat's tool output, newest kept */
export const OUTSIDE_PER_CHAT = 512 * 1024
const OUTSIDE_CHATS = 500

/** The person's "자동으로 기억하기" (Settings › Memory): on unless they turned it off. Read when the tool is called. */
export function autoMemoryOn(db: Database, userId: string): boolean {
  try {
    const r = db.query('SELECT prefs FROM users WHERE id = ?').get(userId) as { prefs: string | null } | null
    const p = JSON.parse(r?.prefs || '{}') as UserPrefs
    return p.autoMemory !== 'off'
  } catch { return true }
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
/** case, width, punctuation and spaces folded: what a copy check compares */
export function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim()
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
  const out = ` ${fold(outside)} `, mine = ` ${fold(own)} `
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

const SECRET_WORD = String.raw`(?:password|passwd|passcode|pwd|pw|pin|비밀번호|비번|암호|패스워드|パスワード|暗証番号|密码|口令|contraseña|clave|kata\s*sandi|sandi)`
const VALUE = String.raw`[^\s\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{4,}`
const SECRET_PATTERNS: RegExp[] = [
  // "password: hunter2", "pw=abcd" — a colon or equals sign and a value
  new RegExp(String.raw`${SECRET_WORD}\s*[:：=]\s*${VALUE}`, 'iu'),
  // "password is x7#k2", "비밀번호는 abc123" — a word between, and the value holds a digit or a symbol
  new RegExp(String.raw`${SECRET_WORD}\s*(?:is|was|은|는|이|가|が|は|是|es|adalah)\s*(?=[^\s]*[\d!@#$%^&*_+=~?])${VALUE}`, 'iu'),
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style keys
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

/** How many silent saves (source 'auto') this answer and the last 24 hours have; past the caps a save is skipped. */
export function autoCapReached(db: Database, userId: string, turnId: string, now = Date.now()): 'answer' | 'day' | null {
  const inTurn = (db.query("SELECT count(*) n FROM memories WHERE user_id = ? AND source = 'auto' AND created_turn_id = ?").get(userId, turnId) as { n: number }).n
  if (inTurn >= AUTO_PER_ANSWER) return 'answer'
  const since = new Date(now - 24 * 3600_000).toISOString()
  const inDay = (db.query("SELECT count(*) n FROM audit_log WHERE actor_id = ? AND action = 'memory.auto_create' AND json_extract(detail, '$.source') = 'auto' AND at >= ?").get(userId, since) as { n: number }).n
  return inDay >= AUTO_PER_DAY ? 'day' : null
}

/** The person's own messages in this chat (the newest 200), for "the person wrote it". */
export function ownWords(db: Database, chatId: string, userId: string): string {
  const rows = db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'user' AND (author_id IS NULL OR author_id = ?) ORDER BY created_at DESC LIMIT 200").all(chatId, userId) as { content: string | null }[]
  return rows.map((r) => r.content ?? '').join('\n')
}

/**
 * The tool output that came into each chat, newest kept (OUTSIDE_PER_CHAT), in memory only. A fresh session clears its
 * chat (what the engine still holds is what counts); a restart clears everything, and then there is nothing to check.
 */
export class OutsideText {
  private chats = new Map<string, { parts: string[]; size: number }>()
  add(chatId: string, text: string) {
    if (!text) return
    let c = this.chats.get(chatId)
    if (c) this.chats.delete(chatId) // newest last, for the cap on chats
    else c = { parts: [], size: 0 }
    const t = text.length > OUTSIDE_PER_CHAT ? text.slice(-OUTSIDE_PER_CHAT) : text
    c.parts.push(t)
    c.size += t.length
    while (c.size > OUTSIDE_PER_CHAT && c.parts.length > 1) c.size -= c.parts.shift()!.length
    this.chats.set(chatId, c)
    while (this.chats.size > OUTSIDE_CHATS) this.chats.delete(this.chats.keys().next().value!)
  }
  of(chatId: string): string { return this.chats.get(chatId)?.parts.join('\n') ?? '' }
  clear(chatId: string) { this.chats.delete(chatId) }
}

/** Tools whose output is not outside content: the person's own answer (ask_user) and the AI's own bookkeeping. */
export const NOT_OUTSIDE_TOOLS: ReadonlySet<string> = new Set(['ask_user', 'remember', 'forget', 'todo_write', 'set_title', 'write', 'edit', 'edit_files'])

/** The text of a tool result's content blocks. */
export function resultText(content: readonly { type: string; text?: string }[] | undefined): string {
  return (content ?? []).map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n')
}
