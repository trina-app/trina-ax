// Passwords: argon2id via Bun.password, the password policy, temporary passwords, opaque tokens.
import crypto from 'node:crypto'
import { memorablePassword } from '@mycel/shared'
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

// Password rule (owner decision 2026-10-21, first office pilot): at least 8 and at most 128 characters, not the username,
// not one of the most common passwords. No character-class or "different characters" rules: they made passwords hard
// to choose and remember at the desks. The same rule everywhere (setup, invite, forced and settings change, reset
// link, a temporary password an admin types, the server CLI).
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

// The most common passwords of at least 8 characters (breach corpora; ko / en / id favourites), lower-cased. Shorter
// ones are already refused by the length rule; one character repeated and plain digit runs are refused below.
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'password!', 'password1!', 'passw0rd', 'p@ssw0rd',
  'p@ssword', 'passw0rd1', 'passw0rd123', 'p@ssw0rd123', 'p@ssword123', 'qwertyui', 'qwertyuiop', 'qwerty12', 'qwerty123',
  'qwerty1234', 'qwerty12345', 'qwerty123456', 'qwer1234', 'qwer1234!', 'qwer1234!@', 'qwer1234!@#$', 'q1w2e3r4', 'q1w2e3r4t5',
  'q1w2e3r4t5y6', '1q2w3e4r', '1q2w3e4r!', '1q2w3e4r5t', '1q2w3e4r5t6y', '1qaz2wsx', '1qaz2wsx3edc', 'zaq12wsx', 'zaq12wsxcde3',
  'asdfghjk', 'asdfghjkl', 'asdfghjkl1', 'asdfghjkl;', 'asdf1234', 'asdf1234!', 'asdf1234!@', 'zxcvbnm1', 'zxcvbnm123',
  'zxcvbnm,./', 'abcd1234', 'abcd12345', 'abcd123456', 'abc12345', 'abc123456', 'abc1234567', 'abcdefgh', 'abcdefghi',
  'abcdefghij', 'a1234567', 'a12345678', 'a123456789', '1234567a', '12345678a', '123456789a', '1234qwer', '1234asdf',
  'iloveyou', 'iloveyou1', 'iloveyou12', 'iloveyou123', 'sunshine', 'sunshine1', 'sunshine123', 'princess', 'princess1',
  'princess123', 'football', 'football1', 'football123', 'baseball', 'baseball1', 'baseball123', 'welcome1', 'welcome12',
  'welcome123', 'welcome1234', 'letmein1', 'letmein12', 'letmein123', 'admin123', 'admin1234', 'admin12345', 'admin123456',
  'administrator', 'changeme', 'changeme1', 'changeme123', 'trustno1', 'trustno1234', 'monkey123', 'monkey12345',
  'dragon123', 'dragon12345', 'superman', 'superman1', 'superman123', 'starwars', 'starwars1', 'starwars123', 'computer',
  'computer1', 'computer123', 'whatever', 'whatever1', 'whatever123', 'michael1', 'jennifer', 'charlie1', 'internet',
  'samsung1', 'samsung123', 'naver123', 'naver1234', 'naver12345', 'kakao123', 'kakao1234', 'kakao12345', 'sarang12',
  'sarang123', 'sarang1234', 'saranghae', 'saranghae1', 'saranghae12', 'indonesia', 'indonesia1', 'indonesia123',
  'bismillah', 'bismillah1', 'bismillah123', 'jakarta1', 'jakarta123', 'teamax12', 'teamax123', 'teamax1234',
  'teamax12345', 'mycel123', 'mycel12345', 'treesoop', 'treesoop1', 'treesoop123', 'trinaax', 'trinaax1', 'trinaax123', 'trina123', 'trina1234', 'company1', 'company123', 'secret12',
  'secret123', 'secret1234', 'default1', 'default123', 'test1234', 'test12345', 'test123456', 'dentist1', 'dentist123',
  'clinic123', 'exampleteam123', 'exampleteam1234', '12341234', '11223344', '12121212', '1212121212', '1234512345', '1029384756',
  '147258369', '159753456', '123123123', '123321123', '12344321', '123qweasd', 'qweasdzxc', 'qweasd123', 'q1w2e3r4!',
])

/** Digits counting up or down (12345678, 98765432, 23456789, 0123456789...). */
function digitRun(pw: string): boolean {
  if (!/^\d+$/.test(pw)) return false
  let up = true
  let down = true
  for (let i = 1; i < pw.length; i++) {
    const d = (Number(pw[i]) - Number(pw[i - 1]) + 10) % 10
    if (d !== 1) up = false
    if (d !== 9) down = false
  }
  return up || down
}

export interface PolicyContext { username?: string | null; name?: string | null }

/** null when acceptable; otherwise a short English reason (shown in `fields`, the message is localized). */
export function passwordProblem(pw: string, ctx: PolicyContext = {}): string | null {
  if ([...pw].length < PASSWORD_MIN) return 'at least 8 characters'
  if (pw.length > PASSWORD_MAX) return 'at most 128 characters'
  const lower = pw.toLowerCase()
  if (COMMON.has(lower) || new Set(pw).size === 1 || digitRun(pw)) return 'this password is too common'
  const u = ctx.username?.trim().toLowerCase()
  if (u && lower === u) return 'must not be the username'
  return null
}

/** A memorable temporary password, e.g. "tiger4271" (shared/src/temp-password.ts: word + 4 digits, ~23 bits). */
export const temporaryPassword = (): string => memorablePassword(crypto.randomInt)

/** Opaque bearer secret (session, invite, reset): 32 random bytes, base64url. Only its hash is stored. */
export const newToken = (): string => crypto.randomBytes(32).toString('base64url')
export const hashToken = (t: string): string => crypto.createHash('sha256').update(t).digest('hex')

/** Constant-time string comparison (via fixed-length digests). */
export function safeEqual(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest()
  const y = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(x, y) && a.length === b.length
}
