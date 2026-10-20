// Passwords: argon2id via Bun.password, the password policy, temporary passwords, opaque tokens.
import crypto from 'node:crypto'
import { fail } from '../http/errors'

/** argon2id, 64 MiB, 2 passes (Bun's defaults; OWASP minimum is 19 MiB / 2). */
const ARGON = { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 } as const

// At most HASH_SLOTS argon2id runs at a time (64 MiB each) and at most HASH_QUEUE waiting: a flood of sign-in
// requests (many IPs, made-up usernames) queues or gets 429 instead of exhausting memory and CPU.
export const HASH_SLOTS = 4
export const HASH_QUEUE = 200
let active = 0
const waiting: (() => void)[] = []
export const hashLoad = () => ({ active, waiting: waiting.length })

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < HASH_SLOTS) active++
  else {
    if (waiting.length >= HASH_QUEUE) fail('rate_limited', undefined, { retryAfter: 2 })
    await new Promise<void>((r) => waiting.push(r)) // the finishing run hands its slot over
  }
  try { return await fn() } finally {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
}

export const hashPassword = (pw: string): Promise<string> => slot(() => Bun.password.hash(pw, ARGON))

/** Verify; a malformed stored hash is a mismatch. Throws only rate_limited when the server is saturated. */
export async function verifyPassword(pw: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) { const d = await dummyHash(); await slot(() => Bun.password.verify(pw, d).catch(() => false)); return false }
  return slot(() => Bun.password.verify(pw, hash).catch(() => false))
}

let dummy: Promise<string> | null = null
/** A real argon2id hash used when the account does not exist, so the response time does not reveal that. */
export function dummyHash(): Promise<string> {
  dummy ??= Bun.password.hash(crypto.randomBytes(16).toString('hex'), ARGON)
  return dummy
}

// The most common passwords of at least 10 characters (breach corpora), lower-cased. Short ones are already
// refused by the length rule.
const COMMON = new Set([
  '1234567890', '0123456789', '12345678910', '123456789a', 'a123456789', '1q2w3e4r5t', '1q2w3e4r5t6y', 'qwertyuiop',
  'qwerty1234', 'qwerty12345', 'qwerty123456', '1qaz2wsx3edc', 'zaq12wsxcde3', 'asdfghjkl1', 'asdfghjkl;', 'password12',
  'password123', 'password1234', 'password!', 'password1!', 'passw0rd123', 'p@ssw0rd123', 'p@ssword123', 'iloveyou12',
  'iloveyou123', 'football123', 'baseball123', 'welcome123', 'welcome1234', 'letmein123', 'admin12345', 'admin123456',
  'administrator', 'changeme123', 'trustno1234', 'sunshine123', 'princess123', 'monkey12345', 'dragon12345',
  'superman123', 'starwars123', 'computer123', 'whatever123', 'abcdefghij', 'abcd123456', 'abc1234567', 'aaaaaaaaaa',
  '1111111111', '0000000000', '1234512345', '1212121212', '9876543210', '1029384756', 'qwer1234!@', 'qwer1234!@#$',
  'q1w2e3r4t5', 'q1w2e3r4t5y6', 'asdf1234!@', 'zxcvbnm123', 'zxcvbnm,./', 'samsung123', 'naver12345', 'kakao12345',
  'sarang1234', 'saranghae1', 'saranghae12', 'indonesia1', 'indonesia123', 'bismillah1', 'bismillah123', 'jakarta123',
  'teamax1234', 'teamax12345', 'mycel12345', 'treesoop123', 'company123', 'secret1234', 'default123', 'test123456',
])

export interface PolicyContext { username?: string | null; name?: string | null }

/** null when acceptable; otherwise a short English reason (shown in `fields`, the message is localized). */
export function passwordProblem(pw: string, ctx: PolicyContext = {}): string | null {
  if (pw.length < 10) return 'at least 10 characters'
  if (pw.length > 256) return 'at most 256 characters'
  const lower = pw.toLowerCase()
  if (COMMON.has(lower)) return 'this password is too common'
  if (new Set(pw).size < 4) return 'use more different characters'
  if (/^(.{1,4})\1+$/.test(pw)) return 'avoid repeated patterns'
  const u = ctx.username?.toLowerCase()
  if (u && u.length >= 3 && lower.includes(u)) return 'must not contain the username'
  return null
}

// No 0/O, 1/l/I: readable when handed over by voice or on paper.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** e.g. "Hk7q-mW3x-Pz9a-T4cb" (4 x 4 characters, ~22 bits each group). */
export function temporaryPassword(): string {
  const groups: string[] = []
  for (let g = 0; g < 4; g++) {
    let s = ''
    for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)]
    groups.push(s)
  }
  return groups.join('-')
}

/** Opaque bearer secret (session, invite, reset): 32 random bytes, base64url. Only its hash is stored. */
export const newToken = (): string => crypto.randomBytes(32).toString('base64url')
export const hashToken = (t: string): string => crypto.createHash('sha256').update(t).digest('hex')

/** Constant-time string comparison (via fixed-length digests). */
export function safeEqual(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest()
  const y = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(x, y) && a.length === b.length
}
