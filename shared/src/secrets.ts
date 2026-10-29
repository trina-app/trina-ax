// Text that looks like a secret: an API key, an access token, a password, a private key. For places that show again
// what a person typed or what the AI wrote (chat titles first: a pasted admin token became a chat title on screen,
// 2026-10-28). Three kinds of finds:
//  - known prefixes (sk-…, ghp_…, AKIA…, aipm_…, eyJ… JWT, -----BEGIN … KEY-----, Bearer …),
//  - a value after a key-like word ("password: hunter22", "API_KEY=…", "비밀번호: …"), only the value,
//  - long random-looking tokens: 24+ characters without spaces that mix letters and digits in short pieces (hex,
//    base62, base64). Words, camelCase names, file paths, dates, UUIDs and e-mail addresses are not random-looking.
//  - named test keys (QA SEC-16, B-W47-3, B-W5-1): one token of parts joined by "-" or "_" with a key word (KEY,
//    TOKEN, SECRET, PASSWORD, API) and a value part: a long segment, or a test marker (FAKE, DUMMY, TEST …) in a token
//    written in capitals or with a digit part ("QA-FAKE-KEY-0000-NOT-REAL"). Also a provider prefix with one generated
//    segment ("sk-FAKEKEY0000NOTREAL"). Env names (OPENAI_API_KEY), slugs and words with spaces are not test keys.
// It errs towards finding: a find only hides text, it never blocks anything the person does.

export interface SecretSpan { start: number; end: number; kind: string }

const hasDigit = (s: string) => /[0-9]/.test(s)
const hasLetter = (s: string) => /[A-Za-z]/.test(s)
const mixedCase = (s: string) => /[a-z]/.test(s) && /[A-Z]/.test(s)

interface Pattern { kind: string; re: RegExp; ok?: (m: string) => boolean; group?: number }

// `(?<![A-Za-z0-9])` instead of \b where the prefix may follow "_" or "=" in an assignment (OPENAI_API_KEY=sk-…)
const PATTERNS: Pattern[] = [
  { kind: 'private-key', re: /-----BEGIN[A-Z0-9 ]*-----[\s\S]*?(?:-----END[A-Z0-9 ]*-----|$)/g },
  { kind: 'anthropic', re: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{12,}/g },
  // OpenAI (sk-…, sk-proj-…): the body must look generated, so "sk-learn-tutorial-for-beginners" is no key
  { kind: 'openai', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, ok: (m) => hasDigit(m) && mixedCase(m) },
  { kind: 'stripe', re: /(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { kind: 'github', re: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: 'gitlab', re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{16,}/g },
  { kind: 'slack', re: /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g, ok: hasDigit },
  { kind: 'aws', re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, ok: hasDigit },
  { kind: 'google', re: /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{20,}/g },
  { kind: 'ai-pm', re: /(?<![A-Za-z0-9])aipm_[A-Za-z0-9_-]{12,}/g, ok: (m) => hasDigit(m.slice(5)) },
  { kind: 'npm', re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{30,}/g },
  { kind: 'huggingface', re: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/g },
  // a JWT, or the start of one (the header is base64 of '{"')
  { kind: 'jwt', re: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){0,2}/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, ok: (m) => hasDigit(m) && hasLetter(m.slice(6)) },
  { kind: 'basic-auth', re: /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/g, ok: hasDigit },
  // credentials inside an address: https://user:password@host
  { kind: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+:[^\s/@]+)@/gi, group: 1 },
  // the value after a word that announces a secret (the word itself stays)
  {
    kind: 'assignment',
    re: /(?:password|passwd|passphrase|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|비밀번호|비번|패스워드|암호|토큰|인증키|kata ?sandi)["']?\s*[:=]\s*["']?([\x21-\x7e]{4,})/gi,
    group: 1,
  },
]

const KEY_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'api'])
const TEST_MARKERS = new Set(['fake', 'dummy', 'test', 'mock', 'sample', 'example', 'placeholder', 'notreal'])
const NAMED = /(?<![A-Za-z0-9_-])[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+(?![A-Za-z0-9_-])/g
// a provider prefix and one segment without separators (findSecrets checks that it mixes letters and digits)
const PREFIXED = /(?<![A-Za-z0-9_-])(?:sk|gh[pousr]|glpat|xox[abposr])[-_][A-Za-z0-9]{12,}(?![A-Za-z0-9_-])/g

/** A generated value segment: 8+ characters, letters and digits in 4+ pieces ("a8f3k29dk3x"; not "gpt4turbo"). */
const longPart = (p: string) => p.length >= 8 && (p.match(/[A-Za-z]+|[0-9]+/g) ?? []).length >= 4

/**
 * Whether a token of parts joined by "-" or "_" is a named key (a test key written for a person to read): a key word
 * part and a value part. "QA-FAKE-KEY-0000-NOT-REAL", "MY_API_TOKEN_a8f3k29dk3x" are; "OPENAI_API_KEY",
 * "secret-santa-2026", "test_api_key", "API-TEST-PLAN" and "token-economy-whitepaper" are not.
 */
export function namedKey(token: string): boolean {
  const parts = token.split(/[-_]/)
  const low = parts.map((p) => p.toLowerCase())
  if (!low.some((p) => KEY_WORDS.has(p))) return false
  const values = parts.filter((_, i) => !KEY_WORDS.has(low[i]!))
  if (values.some(longPart)) return true
  // a test marker ("NOT-REAL" counts as one) in a token of 3+ parts written in capitals or with a digit part; here
  // "API" alone is not a key word ("API-TEST-PLAN")
  const marked = low.some((p) => TEST_MARKERS.has(p)) || low.join('-').includes('not-real')
  return marked && low.some((p) => p !== 'api' && KEY_WORDS.has(p)) && parts.length >= 3 && (!/[a-z]/.test(token) || parts.some((p) => /^[0-9]+$/.test(p)))
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const RUN = /[A-Za-z0-9+/=_-]{24,}/g

/**
 * Whether a run of 24+ characters without spaces looks generated rather than written: letters and digits mixed in
 * short pieces. "5c6de5a19f3b4e7d…" breaks into 5|c|6|de|5|a|19… (pieces of 1–2 characters); a path, a camelCase name or
 * "report-2026-10-28-final" breaks into words (pieces of 4+).
 */
export function looksRandom(run: string): boolean {
  const s = run.replace(UUID, 'uuid') // an id, not a secret (chat ids in attachment paths)
  const alnum = s.replace(/[^A-Za-z0-9]/g, '')
  if (alnum.length < 20 || new Set(alnum).size < 10) return false
  const pieces = s.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []
  const avg = alnum.length / Math.max(1, pieces.length)
  if (hasDigit(alnum) && hasLetter(alnum)) return avg < 3
  // letters only: random mixed case is choppier than any name
  return mixedCase(alnum) && avg < 2.2
}

/** Every secret-looking part of the text, sorted, overlaps merged. */
export function findSecrets(text: string): SecretSpan[] {
  const spans: SecretSpan[] = []
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      if (m[0].length === 0) { p.re.lastIndex++; continue }
      if (p.ok && !p.ok(m[0])) continue
      if (p.group) {
        const g = m[p.group]
        if (!g) continue
        const start = m.index + m[0].lastIndexOf(g)
        spans.push({ start, end: start + g.length, kind: p.kind })
      } else spans.push({ start: m.index, end: m.index + m[0].length, kind: p.kind })
    }
  }
  NAMED.lastIndex = 0
  for (let m = NAMED.exec(text); m; m = NAMED.exec(text)) {
    if (namedKey(m[0])) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'named-key' })
  }
  PREFIXED.lastIndex = 0
  for (let m = PREFIXED.exec(text); m; m = PREFIXED.exec(text)) {
    // letters and digits in 3+ pieces ("FAKEKEY0000NOTREAL"); "sk-learning2026" is a word and a year
    const body = m[0].slice(m[0].search(/[-_]/) + 1)
    if ((body.match(/[A-Za-z]+|[0-9]+/g) ?? []).length >= 3) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'prefixed' })
  }
  RUN.lastIndex = 0
  for (let m = RUN.exec(text); m; m = RUN.exec(text)) {
    if (looksRandom(m[0])) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'random' })
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: SecretSpan[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

export function hasSecret(text: string): boolean {
  return findSecrets(text).length > 0
}

/** The text with each secret-looking part replaced (default: removed). */
export function maskSecrets(text: string, replacement = ''): string {
  let out = text
  for (const s of findSecrets(text).reverse()) out = out.slice(0, s.start) + replacement + out.slice(s.end)
  return out
}
