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

function patternSpans(text: string, patterns: readonly Pattern[], spans: SecretSpan[]) {
  for (const p of patterns) {
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
}

function merged(spans: SecretSpan[]): SecretSpan[] {
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: SecretSpan[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Every secret-looking part of the text, sorted, overlaps merged. */
export function findSecrets(text: string): SecretSpan[] {
  const spans: SecretSpan[] = []
  patternSpans(text, PATTERNS, spans)
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
  return merged(spans)
}

export function hasSecret(text: string): boolean {
  return findSecrets(text).length > 0
}

// Only what is almost surely a secret, for a warning that holds back what a person sends (the message box and the
// other boxes whose text reaches the AI): a known key or token prefix, a private key block, a JWT, "Bearer <token>",
// "Authorization: Basic <base64>", a password inside an address, and a value after a word that names one
// ("password: …", "API_KEY=…", "비밀번호: …"). Not random-looking runs, named test keys or a provider prefix alone: a
// commit hash, a Google Docs link or a folder with a generated name is ordinary text there. A labelled value counts
// only when it looks like a secret (secretValue), so code and settings ("apiKey = process.env.API_KEY",
// "token: 4096 max", "Password: required") go out as they are. findSecrets (titles) stays as it is: it errs towards
// finding, since a find only hides text.
const LIKELY_KINDS = new Set(['private-key', 'anthropic', 'openai', 'stripe', 'github', 'gitlab', 'slack', 'aws', 'google', 'ai-pm', 'npm', 'huggingface', 'jwt', 'bearer', 'url-credentials'])
/** letters and digits change often, as in a generated value ("9f8e7d6c…"; not "learning2026tutorial") */
const choppy = (s: string, pieces: number) => (s.match(/[A-Za-z]+|[0-9]+/g) ?? []).length >= pieces
const LIKELY: Pattern[] = [
  ...PATTERNS.filter((p) => LIKELY_KINDS.has(p.kind)),
  // sk- keys in lower case or hex (OpenRouter sk-or-v1-…, DeepSeek sk-<32 hex>), which the OpenAI pattern leaves out
  { kind: 'sk-key', re: /(?<![A-Za-z0-9])sk-(?:[a-z0-9]{1,10}-){0,3}[A-Za-z0-9]{24,}(?![A-Za-z0-9_-])/g, ok: (m) => choppy(m.slice(m.lastIndexOf('-') + 1), 6) },
  // Notion (ntn_…, and the older secret_ + 43), Linear (lin_api_…, lin_oauth_…), Groq (gsk_…)
  { kind: 'notion', re: /(?<![A-Za-z0-9])(?:ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{40,})(?![A-Za-z0-9_-])/g, ok: (m) => hasDigit(m) && hasLetter(m.slice(4)) },
  { kind: 'linear', re: /(?<![A-Za-z0-9])lin_(?:api|oauth)_[A-Za-z0-9]{30,}/g, ok: (m) => hasDigit(m) },
  { kind: 'groq', re: /(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{30,}/g, ok: (m) => hasDigit(m) },
  // a user name and password in base64, after the header that sends them
  { kind: 'basic-auth', re: /\bAuthorization["']?\s*[:=]\s*["']?Basic\s+([A-Za-z0-9+/]{8,}={0,2})/gi, group: 1, ok: (m) => { const v = m.slice(m.search(/Basic\s/i) + 6).trim(); return hasDigit(v) || mixedCase(v) || v.endsWith('=') } },
]

// A labelled value: a label that is a whole word naming a secret, ":" or "=", then the value. The label may be an
// identifier ("DB_PASSWORD", "apiKey", "x-api-key", "spring.datasource.password"); it names a secret when its last
// part does ("…password", "…token", "…secret", "…api key"), so "token_url", "max_tokens" and "tokenizer" do not. A
// Korean label may end a longer word ("새비밀번호").
const LABEL_RE = /(?<![A-Za-z0-9_$.-])((?:api|access|private|secret|auth)\s+key|kata\s?sandi|비밀번호|비번|패스워드|암호|토큰|인증키|[A-Za-z][A-Za-z0-9_.-]*)["'`]?\s*[:=]\s*["'`]?([^\s"'`]+)/giu
const LABEL_LAST = new Set(['password', 'passwd', 'passphrase', 'pwd', 'secret', 'token', 'apikey', 'accesskey', 'privatekey', 'secretkey', 'authkey'])
const LABEL_PAIR = new Set(['apikey', 'accesskey', 'privatekey', 'secretkey', 'authkey', 'katasandi'])
// one alternation, the form tests/unit/i18n-languages.test.ts allows here (these are words to find, not screen text)
const KOREAN_LABEL = /^(?:비밀번호|비번|패스워드|암호|토큰|인증키)$/u
const labelParts = (label: string) => label.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_.-]+/).filter(Boolean)

/** Whether a label names a secret: its last part ("DB_PASSWORD", "accessToken", "x-api-key"), or a Korean word. */
export function secretLabel(label: string): boolean {
  if (KOREAN_LABEL.test(label)) return true
  const parts = labelParts(label)
  const last = parts[parts.length - 1] ?? ''
  return LABEL_LAST.has(last) || LABEL_PAIR.has(parts.slice(-2).join(''))
}

/**
 * Whether the value after a label looks like a secret: 6+ characters without spaces, letters mixed with digits or
 * symbols (not a plain word, an identifier or digits only), and not an expression: no "(", not a variable or a
 * placeholder ($X, %X%, {x}, <x>), not process.env / os.environ / env. / import.meta.env, not a dotted path
 * ("config.auth.token"), not an address.
 */
export function secretValue(raw: string): boolean {
  // the sentence goes on after it ("password: hunter22.")
  const v = raw.replace(/[.,;:)\]}>]+$/, '')
  if (v.length < 6 || /\s/.test(v) || v.includes('(')) return false
  if (/^[$%{<[]/.test(v)) return false
  if (/^(?:process\.env|os\.environ|os\.getenv|env\.|import\.meta\.env|ENV\[)/i.test(v)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false
  return hasLetter(v) && (hasDigit(v) || /[^A-Za-z0-9_.-]/.test(v))
}

function labelledSpans(text: string, spans: SecretSpan[]) {
  LABEL_RE.lastIndex = 0
  for (let m = LABEL_RE.exec(text); m; m = LABEL_RE.exec(text)) {
    const value = m[2]!
    if (!secretLabel(m[1]!) || !secretValue(value)) continue
    const start = m.index + m[0].length - value.length
    spans.push({ start, end: start + value.length, kind: 'labelled' })
  }
}

/** The parts of the text that are almost surely a secret (see LIKELY above), sorted, overlaps merged. */
export function findLikelySecrets(text: string): SecretSpan[] {
  const spans: SecretSpan[] = []
  patternSpans(text, LIKELY, spans)
  labelledSpans(text, spans)
  return merged(spans)
}

/**
 * Whether a service's address holds a key: a known key prefix anywhere in it, a password in it, or a query value
 * named like a key ("?api_key=…", "?token=…", "?key=…") that looks like one (secretValue). Not a generated instance
 * id in the path or a plain query ("?instance=a8F3k29dK3x", "?key=public"): MCP servers are often reached that way.
 */
export function addressHasSecret(url: string): boolean {
  if (hasLikelySecret(url)) return true
  let u: URL
  try { u = new URL(url) } catch { return false }
  const params = [...u.searchParams, ...new URLSearchParams(u.hash.replace(/^#/, ''))]
  return params.some(([name, value]) => (secretLabel(name) || name.toLowerCase() === 'key') && secretValue(value))
}

/** A path segment or host label that may be a key itself: an id (hosted MCP servers often take a UUID as the key), a
 * generated-looking run, a long mixed value or long hex. */
const keyPart = (part: string): boolean =>
  /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i.test(part) || looksRandom(part) || (part.length >= 16 && secretValue(part)) || /[0-9a-f]{24,}/i.test(part)

/** The labels of a host that someone other than the domain's owner names: all but the last two ("<key>.mcp" of
 * "<key>.mcp.example.com"); the registrable domain itself was bought, not generated per person. */
const subLabels = (host: string): string[] => {
  if (host.startsWith('[')) return [] // an IPv6 address has no labels
  return host.replace(/\.$/, '').split('.').slice(0, -2)
}

/**
 * Whether a service's address may carry a key outside its query: a path segment (Zapier-style "/api/mcp/s/<key>/mcp")
 * or a host label ("https://<key>.mcp.example.com/mcp") that is an id, a generated-looking run, a long mixed value or
 * long hex. Stricter than addressHasSecret, which lets an instance id through: for an address that goes to every
 * member as a connection template (내 스킬 가져오기; the server's share check and the browser's Codex reader both use it).
 * The host's labels are read from the address as written as well as from the parsed one, which is in lower case: a key
 * of letters only looks generated only in its mixed case. An address that cannot be read counts as one with a key.
 */
export function keyInAddress(raw: string): boolean {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return true }
  const decoded = (part: string): string | null => { try { return decodeURIComponent(part) } catch { return null } }
  for (const seg of u.pathname.split('/')) {
    if (!seg) continue
    const d = decoded(seg)
    if (d === null || keyPart(d)) return true
  }
  // the host as written: after "//", before any user, port, path, query or fragment ("\" ends it too, as in URL)
  const authority = /^\s*[a-z][a-z0-9+.-]*:[\\/]{2}([^/\\?#]*)/i.exec(raw)?.[1] ?? ''
  const written = authority.slice(authority.lastIndexOf('@') + 1).replace(/:[0-9]*$/, '')
  for (const label of [...subLabels(written), ...subLabels(u.hostname)]) {
    if (!label) continue
    const d = decoded(label)
    if (d === null || keyPart(d)) return true
  }
  return false
}

export function hasLikelySecret(text: string): boolean {
  return findLikelySecrets(text).length > 0
}

/** The text with each secret-looking part replaced (default: removed). */
export function maskSecrets(text: string, replacement = ''): string {
  let out = text
  for (const s of findSecrets(text).reverse()) out = out.slice(0, s.start) + replacement + out.slice(s.end)
  return out
}
