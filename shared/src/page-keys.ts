// Keys on a web page (docs/decisions/20261124-browser-key-guard.md). What the desktop app's browser reads from a page
// (read_page, find, get_page_text, a script's output, a network body) goes into the AI's input and from there into
// records; a key a service shows on its API key page must not. The server runs every browser result through
// scanPageText before anything else sees it.
//
// Built on secrets.ts: its "almost surely a secret" finds (findLikelySecrets: provider prefixes, JWTs, Bearer, a value
// after "password:" / "API_KEY="), plus what a page shows that a message rarely does:
//  - more provider prefixes (MORE_PREFIXES),
//  - a value that looks generated shortly after a word that names a key ("REST API 키  1a2b…", "Client Secret
//    Xy3Kp9QwZe", "API key [ref_5] value=\"…\"": labels and values are apart on a page, not "label: value"),
//  - secret query values in an address (?token=…, &sig=…),
//  - a sentence that says a key is shown only once ("You won't be able to see it again", "다시 볼 수 없어요").
// A find outside an address, or such a sentence, makes the text a key screen: then every random-looking run, every
// generated-looking value and every UUID is hidden too, labelled or not (find lists a field without its label), and the
// caller stops the AI there. A find inside an address hides the value but makes no key screen (a screenshot does not
// show the address; a sign-in return address carries a code).
// It errs towards not finding on ordinary pages: words, Korean text, numbers, dates, UUIDs, hashes in links, version
// strings, token counts and documentation placeholders stay as they are (tests/unit/page-keys.test.ts).
import { findLikelySecrets, findSecrets, looksRandom, secretValue, type SecretSpan } from './secrets'

export interface PageKeyScan {
  /** the text with every key-like value replaced by the marker */
  text: string
  /** how many values were replaced */
  hidden: number
  /** the text shows a key: a value found outside an address, or a sentence that says a key is shown only once */
  keyScreen: boolean
}

/** `prev`: a character the match may not follow (checked by hand: a leading look-behind makes every regular expression
 * try every position, about 40 ms a pattern on 2 MB of text) */
interface Pattern { kind: string; re: RegExp; prev?: RegExp }
const WORD_CHAR = /[A-Za-z0-9]/

// prefixes secrets.ts does not know (it knows sk-, sk-ant-, sk_live_, gh*_, glpat-, xox*-, AKIA, AIza, npm_, hf_, ntn_,
// lin_api_, gsk_, eyJ…). Not after a letter or a digit; after "_" or "=" they still count ("API_KEY=…").
const MORE_PREFIXES: Pattern[] = [
  { kind: 'google-oauth', re: /(?:ya29\.[A-Za-z0-9_-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,})/g },
  { kind: 'sendgrid', re: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: 'shopify', re: /shp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}/g },
  // Toss Payments: test_ck_…, live_sk_…, test_gsk_…
  { kind: 'toss', re: /(?:test|live)_g?(?:ck|sk)_[A-Za-z0-9]{16,}/g },
  { kind: 'xai', re: /xai-[A-Za-z0-9]{32,}/g },
  { kind: 'perplexity', re: /pplx-[A-Za-z0-9]{32,}/g },
  { kind: 'replicate', re: /r8_[A-Za-z0-9]{30,}/g },
  { kind: 'figma', re: /figd_[A-Za-z0-9_-]{30,}/g },
  { kind: 'supabase', re: /(?:sbp_[a-f0-9]{30,}|sb_secret_[A-Za-z0-9_-]{20,})/g },
  { kind: 'digitalocean', re: /do[opr]_v1_[a-f0-9]{40,}/g },
  { kind: 'postman', re: /PMAK-[A-Za-z0-9-]{30,}/g },
  { kind: 'sentry', re: /sntr[ysu]_[A-Za-z0-9_=+/-]{30,}/g },
  { kind: 'grafana', re: /gl(?:sa|c)_[A-Za-z0-9_=+/-]{30,}/g },
  { kind: 'atlassian', re: /ATATT[A-Za-z0-9_=-]{30,}/g },
  { kind: 'doppler', re: /dp\.(?:pt|st|sa|ct|scim|audit)\.[A-Za-z0-9]{30,}/g },
  { kind: 'pypi', re: /pypi-[A-Za-z0-9_-]{50,}/g },
  { kind: 'slack-app', re: /xapp-\d-[A-Za-z0-9-]{20,}/g },
  { kind: 'stripe-webhook', re: /whsec_[A-Za-z0-9+/=]{24,}/g },
  { kind: 'mapbox', re: /[spt]k\.eyJ[A-Za-z0-9_.-]{20,}/g },
  { kind: 'airtable', re: /pat[A-Za-z0-9]{14}\.[a-f0-9]{64}/g },
  { kind: 'elevenlabs', re: /sk_[a-f0-9]{40,}/g },
  { kind: 'mailgun', re: /key-[a-f0-9]{32}(?![A-Za-z0-9])/g },
  { kind: 'new-relic', re: /NRAK-[A-Z0-9]{27}/g },
  { kind: 'square', re: /sq0(?:atp|csp)-[A-Za-z0-9_-]{22,}/g },
  { kind: 'twilio', re: /SK[0-9a-f]{32}(?![A-Za-z0-9])/g },
  // a bot token: "<8-10 digits>:AA<33>" (Telegram), "<id>.<6>.<27+>" (Discord)
  { kind: 'telegram', re: /\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g },
  { kind: 'discord', re: /[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-])/g, prev: /[A-Za-z0-9_.-]/ },
]

// Words that name a key, a token or a secret (a label on a page), not inside a longer word (checked by hand). "key"
// alone only where it is not a database's or a public one (NOT_A_KEY: "Primary key", "Public key", "Publishable key");
// "token" alone only in the singular ("max tokens" is not one).
const EN_KEY_WORD = /(?:(?:api|access|secret|private|signing|license|app|admin|master|service|encryption|client)[\s_-]?keys?(?:[\s_-]?id)?|(?:client|app|api|signing|webhook|shared|consumer)[\s_-]?secrets?|secret|(?:auth|access|refresh|bearer|bot|api|personal[\s_-]access|integration|id|session)[\s_-]?tokens?|token|password|passcode|key)(?![A-Za-z])/gi
const NOT_A_KEY = /(?:primary|foreign|sort|partition|composite|unique|public|publishable|candidate|natural|surrogate)[\s_-]$/i
// one alternation per line (tests/unit/i18n-languages.test.ts allows Korean here on these lines only)
const KO_KEY_WORD = /(?:비밀번호|비번|패스워드|암호(?!화)|인증\s?키|비밀\s?키|보안\s?키|액세스\s?키|접근\s?키|시크릿(?:\s?키)?|토큰|앱\s?키)/g
const KO_NAMED_KEY = /(?:REST API|API|JavaScript|Native|Admin|Client|Secret)\s?키/g
const OTHER_KEY_WORD = /(?:APIキー|アクセスキー|シークレット|トークン|秘密鍵|密钥|秘钥|令牌|clave(?: de API| secreta| de acceso)|kunci (?:API|rahasia|akses))/gi
/** characters after the key word where its value may be (a label and its value are apart on a page) */
const VALUE_WINDOW = 120

// "shown only once" (a page that has just made a key), with a key word near it (REVEAL_NEAR characters either side).
// Not a "Do not show this again" box or a banner that will not come back.
const EN_REVEAL = /(?:won['’]?t|will not|cannot|can['’]?t|unable to|not be able to) (?:be able to )?(?:see|view|access|retrieve|copy|recover)(?: (?:it|this|them|(?:the|your|this) (?:[a-z]+ ){0,2}(?:key|token|secret)s?))? again|(?:key|token|secret|it) (?:will not|won['’]?t) be (?:shown|displayed|visible|accessible) again|(?:shown|displayed|visible) only once|only (?:be )?(?:shown|displayed|visible) once|make sure (?:to|you) copy (?:it|this|your|the) (?:new )?(?:[a-z]+ ){0,2}(?:key|token|secret)/gi
const KO_REVEAL = /(?:다시(?:는)?\s?(?:볼|확인할|조회할|복사할)\s?수\s?없|한\s?번만\s?(?:표시|보여|확인|노출)|지금\s?복사해)/g
const OTHER_REVEAL = /(?:二度と表示されません|一度しか表示されません|(?:不会|无法|不能)再次(?:显示|查看)|仅显示一次|只(?:会)?显示一次|no (?:podrás|podrá) (?:volver a )?ver|solo se (?:mostrará|muestra) una vez|tidak (?:akan )?(?:dapat|bisa) (?:dilihat|melihatnya) lagi|hanya ditampilkan sekali)/gi
const REVEAL_NEAR = 300

/** an address in text (a link, the page's own address on read_page's first line), up to a space or a quote */
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi
/** an attribute that holds an address in read_page's outline */
const HREF = /\bhref="[^"]*"/g
/** a query or fragment value named like a key (the name ends so: access_token, client_secret, X-Amz-Signature) */
const ADDRESS_VALUE = /[?&#;](?:[A-Za-z0-9_.-]*?(?:token|secret|password|passwd|pwd|signature|sig|apikey|api_key|api-key|key|code|session|sessionid|sid|jwt|auth|authorization|credential))=([^&#\s"'<>`]+)/gi

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** a run that may be a value: starts with a letter or digit, 10+ characters of what keys are written with */
const VALUE_RUN = /[A-Za-z0-9][A-Za-z0-9_+/=%~.-]{9,}/g

const pieceAvg = (alnum: string) => alnum.length / Math.max(1, (alnum.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []).length)

/**
 * Whether a run next to a key word looks generated: random-looking (secrets.ts looksRandom: 20+ letters and digits in
 * short pieces), long hex with letters and digits, or 10+ characters with digits and letters in short pieces (a
 * 10-character client secret "Xy3Kp9QwZe", a base32 secret "JBSWY3DPEHPK3PXP7Q2M"). Not a word, a camelCase name, a path
 * of words, a number, a date, a version, a UUID (an id) or an 0x address (a wallet, a hash).
 */
export function keyish(run: string): boolean {
  const v = run.replace(/\.+$/, '')
  if (/^0x[0-9a-f]+$/i.test(v) || UUID_ONLY.test(v)) return false
  const alnum = v.replace(/[^A-Za-z0-9]/g, '')
  if (alnum.length < 10) return false
  const digit = /[0-9]/.test(alnum)
  const lower = /[a-z]/.test(alnum)
  const upper = /[A-Z]/.test(alnum)
  if (looksRandom(v)) return true
  if (!digit || !(lower || upper)) return false
  if (alnum.length >= 16 && /^[0-9a-fA-F]+$/.test(alnum)) return true
  if (alnum.length >= 16) return pieceAvg(alnum) < 2.5
  return lower && upper && pieceAvg(alnum) < 2.5
}

function patternSpans(text: string, patterns: readonly Pattern[], spans: SecretSpan[]) {
  for (const p of patterns) {
    p.re.lastIndex = 0
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      if (m.index > 0 && (p.prev ?? WORD_CHAR).test(text[m.index - 1]!)) continue
      spans.push({ start: m.index, end: m.index + m[0].length, kind: p.kind })
    }
  }
}

/** Ranges of the text, sorted and merged, for "is this inside one / does this touch one" in log time. */
class Ranges {
  private r: [number, number][] = []
  constructor(ranges: [number, number][]) {
    ranges.sort((a, b) => a[0] - b[0])
    for (const x of ranges) {
      const last = this.r[this.r.length - 1]
      if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1])
      else this.r.push([x[0], x[1]])
    }
  }
  /** the last range that starts at or before the position */
  private before(at: number): [number, number] | undefined {
    let lo = 0
    let hi = this.r.length - 1
    let found: [number, number] | undefined
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.r[mid]![0] <= at) { found = this.r[mid]; lo = mid + 1 } else hi = mid - 1
    }
    return found
  }
  inside(s: { start: number; end: number }): boolean { const r = this.before(s.start); return !!r && s.end <= r[1] }
  touches(s: { start: number; end: number }): boolean { const r = this.before(s.end - 1); return !!r && r[1] > s.start }
}
function rangesOf(text: string, ...res: RegExp[]): Ranges {
  const out: [number, number][] = []
  for (const re of res) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) out.push([m.index, m.index + m[0].length])
  }
  return new Ranges(out)
}

/** read_page's own marks between a label and its value: refs, attribute names, find's "at (x, y)" */
const MARKUP = /\[ref_\d+\]|\b(?:type|value|placeholder|href|level)=|\bat \(\d+, \d+\)/g
/** read_page's roles and states: not words of the page */
const OUTLINE_WORDS = new Set(['generic', 'textbox', 'searchbox', 'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch', 'combobox', 'slider', 'spinbutton', 'treeitem', 'heading', 'img', 'list', 'listitem', 'navigation', 'main', 'banner', 'contentinfo', 'form', 'table', 'row', 'cell', 'columnheader', 'dialog', 'region', 'complementary', 'article', 'paragraph', 'group', 'label', 'progressbar', 'status', 'alert', 'iframe', 'video', 'audio', 'hidden', 'checked', 'disabled', 'expanded', 'selected', 'required', 'text', 'password', 'true', 'false'])
/** the word right before a value that makes it an id, not a key ("commit 3f2a9c…", "Request ID …") */
const ID_WORDS = new Set(['commit', 'sha', 'hash', 'checksum', 'digest', 'revision', 'rev', 'build', 'id', 'ids', 'uuid', 'order', 'invoice', 'ticket', 'tracking', 'transaction', 'txn', 'request', 'trace', 'version', 'fingerprint'])
/** at most this many page words between a key word and its value ("API key", "Your API key is", "인증키(Encoding)") */
const GAP_WORDS = 4
const GAP_WORD = /[A-Za-z\u00C0-\u024F]{2,}|[\uAC00-\uD7A3]+|[\u3040-\u30FF\u4E00-\u9FFF]+/g

/** Whether the text between a key word and a value is a label's gap, not a sentence that goes on to something else. */
function labelGap(gap: string): boolean {
  const words = (gap.replace(MARKUP, ' ').match(GAP_WORD) ?? []).filter((w) => !OUTLINE_WORDS.has(w.toLowerCase()))
  if (words.length > GAP_WORDS) return false
  const last = words[words.length - 1]?.toLowerCase()
  return !last || !ID_WORDS.has(last)
}

/** where each key word ends: a whole word, and "key" alone not a database's or a public one */
function keyWordEnds(text: string, first = false): number[] {
  const out: number[] = []
  EN_KEY_WORD.lastIndex = 0
  for (let m = EN_KEY_WORD.exec(text); m; m = EN_KEY_WORD.exec(text)) {
    if (m.index > 0 && /[A-Za-z]/.test(text[m.index - 1]!)) continue
    if (m[0].toLowerCase() === 'key' && NOT_A_KEY.test(text.slice(Math.max(0, m.index - 16), m.index))) continue
    out.push(m.index + m[0].length)
    if (first) return out
  }
  for (const re of [KO_KEY_WORD, KO_NAMED_KEY, OTHER_KEY_WORD]) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      out.push(m.index + m[0].length)
      if (first) return out
    }
  }
  return out
}

/** generated-looking values within VALUE_WINDOW characters after a key word, outside addresses */
function labelledNearby(text: string, skip: Ranges, spans: SecretSpan[]) {
  const seen = new Set<number>()
  for (const from of keyWordEnds(text)) {
    const window = text.slice(from, from + VALUE_WINDOW)
    VALUE_RUN.lastIndex = 0
    for (let v = VALUE_RUN.exec(window); v; v = VALUE_RUN.exec(window)) {
      const start = from + v.index
      if (seen.has(start)) continue
      // a run cut by the window's end goes on in the text: take all of it
      let end = start + v[0].length
      if (v.index + v[0].length === window.length) while (end < text.length && /[A-Za-z0-9_+/=%~.-]/.test(text[end]!)) end++
      const run = text.slice(start, end).replace(/\.+$/, '')
      const span = { start, end: start + run.length, kind: 'near-key-word' }
      if (skip.touches(span) || !keyish(run) || !labelGap(window.slice(0, v.index))) continue
      seen.add(start)
      spans.push(span)
    }
  }
}

function addressValues(text: string, spans: SecretSpan[]) {
  ADDRESS_VALUE.lastIndex = 0
  for (let m = ADDRESS_VALUE.exec(text); m; m = ADDRESS_VALUE.exec(text)) {
    const value = m[1]!
    if (value.length < 8 || !secretValue(value)) continue
    const start = m.index + m[0].length - value.length
    spans.push({ start, end: start + value.length, kind: 'address' })
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

const hasKeyWord = (text: string) => keyWordEnds(text, true).length > 0
/** a sentence that says a key is shown only once, with a key word near it */
export function revealsKey(text: string): boolean {
  for (const re of [EN_REVEAL, KO_REVEAL, OTHER_REVEAL]) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (hasKeyWord(text.slice(Math.max(0, m.index - REVEAL_NEAR), m.index + m[0].length + REVEAL_NEAR))) return true
    }
  }
  return false
}

/** Every key-like part of page text (see above), sorted, overlaps merged, and whether the text is a key screen. */
export function findPageKeys(text: string): { spans: SecretSpan[]; keyScreen: boolean } {
  if (!text) return { spans: [], keyScreen: false }
  const addresses = rangesOf(text, ADDRESS, HREF)
  const spans: SecretSpan[] = [...findLikelySecrets(text)]
  patternSpans(text, MORE_PREFIXES, spans)
  labelledNearby(text, addresses, spans)
  addressValues(text, spans)
  const keyScreen = spans.some((s) => s.kind !== 'address' && !addresses.inside(s)) || revealsKey(text)
  // on a key screen a key may have no known shape and no label next to it (find lists a field without its label):
  // every random-looking run and every generated-looking value goes too
  if (keyScreen) {
    for (const s of findSecrets(text)) spans.push(s)
    anyKeyish(text, addresses, spans)
  }
  return { spans: merged(spans), keyScreen }
}

/** every generated-looking run outside addresses, UUIDs too (some services use one as the key): a key screen's values,
 * labelled or not */
function anyKeyish(text: string, skip: Ranges, spans: SecretSpan[]) {
  VALUE_RUN.lastIndex = 0
  for (let v = VALUE_RUN.exec(text); v; v = VALUE_RUN.exec(text)) {
    const run = v[0].replace(/\.+$/, '')
    const span = { start: v.index, end: v.index + run.length, kind: 'on-key-screen' }
    if (!skip.touches(span) && (keyish(run) || UUID_ONLY.test(run))) spans.push(span)
  }
}

/** The text with every key-like part replaced by `mark` (see findPageKeys). */
export function scanPageText(text: string, mark: string): PageKeyScan {
  const { spans, keyScreen } = findPageKeys(text)
  if (!spans.length) return { text, hidden: 0, keyScreen }
  const parts: string[] = []
  let at = 0
  for (const s of spans) { parts.push(text.slice(at, s.start), mark); at = s.end }
  parts.push(text.slice(at))
  return { text: parts.join(''), hidden: spans.length, keyScreen }
}
