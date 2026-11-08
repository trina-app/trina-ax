// What a person puts in the apps' one box on the first-run screen (docs/DECISIONS.md "First run: one box"): an invite
// link (/invite/<token>), a team link (/join#t=<token>), a full address, a bare team name ("acme" ->
// https://acme.<teamDomain>), or a whole pasted message with a link in it (a KakaoTalk bubble copies all its text).
// Also what a team server's relay answered when the app checked the address (/api/health).
//
// Used by the desktop app (desktop/src/common/address.ts) and the phone app. The phone app cannot import shared/ (its
// own npm project), so mobile/src/team-link.ts is a byte-identical copy: tests/unit/team-link.test.ts runs one table
// against both and fails when the copies differ. Pure: no imports, no platform APIs beyond URL.

export interface TeamInputOptions {
  /** hosted team addresses are https://<name>.<teamDomain>; null: bare names are not addresses here */
  teamDomain: string | null
  /** plain http to this machine (localhost, *.localhost, 127.x, [::1]) is allowed: the desktop app, for development */
  loopbackHttp: boolean
}

/**
 * empty: nothing typed. hangul: Korean letters or jamo (`acme` typed in 한글 mode is `ㅁ츼`). email: an email address.
 * link: an invite or team link that is cut off (its token is missing or broken). insecure: http to a real host.
 * credentials: user:password@ in the address. unsupported_scheme: not http(s). invalid: anything else.
 */
export type TeamInputError = 'empty' | 'hangul' | 'email' | 'link' | 'invalid' | 'insecure' | 'credentials' | 'unsupported_scheme'

export interface TeamInputOk {
  ok: true
  /** https://acme.trina.app (punycode, no path) */
  origin: string
  /** acme.trina.app, with a port when it has one: what the apps show (never Unicode) */
  host: string
  /** the page to open first: '/', '/invite/<token>' or '/join#t=<token>' */
  entryPath: string
  /** the team name of a hosted address (acme of acme.trina.app), for "'acme' 팀을 찾지 못했어요" */
  name: string | null
  /** under the team domain: run by the hosted service (no "not run by us" question) */
  hosted: boolean
  /** this machine (development) */
  loopback: boolean
}
export type TeamInput = TeamInputOk | { ok: false; error: TeamInputError }

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
/** Hangul syllables, jamo, compatibility jamo and the extended jamo blocks */
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7a3\ud7b0-\ud7ff]/
const EMAIL = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/
/** invite and team link tokens are 32 random bytes in base64url, 43 characters (server/src/auth/passwords.ts
 * newToken); a shorter one is a link cut off on the way */
const TOKEN = /^[A-Za-z0-9_-]{43,200}$/
const JOIN_TOKEN = TOKEN
/** an http(s) address inside text: ASCII address characters only, so it ends at a space, a quote, a parenthesis or the
 * Korean word glued to it ("https://…/join#t=abc입니다") */
const URL_IN_TEXT = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%[\]]+/gi
/** punctuation a sentence puts right after a link ("링크: https://…/join#t=abc." or "(https://…)") */
const TRAILING = '.,;:!?\'"\u2019\u201d\u300d\u300f\uff09)]}>\u2026\u3002\u3001'
/** the text without the punctuation at its end (a loop, not a regex: linear on any input) */
function trimTrailing(s: string): string {
  let end = s.length
  while (end > 0 && TRAILING.includes(s[end - 1]!)) end--
  return s.slice(0, end)
}

/** Hosts that only exist on this machine (development): plain http is allowed only for these. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

const isIpHost = (h: string) => h.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)

/** The address part of what was typed: the first invite or team link in a text, else its first http(s) address, else
 * the text itself (one word). null: a text with spaces and no address in it. */
export function linkInText(raw: string): string | null {
  const s = raw.trim()
  // one word that is not an address with something glued in front ("링크:https://…")
  if (!/\s/.test(s) && !/.https?:\/\//i.test(s)) return s
  const found = (s.match(URL_IN_TEXT) ?? []).map(trimTrailing)
  const isLink = (u: string) => /^https?:\/\/[^/]+\/(?:invite\/[A-Za-z0-9_-]|join#)/i.test(u)
  return found.find(isLink) ?? found[0] ?? null
}

/** The team's own name in a host under the team domain ("acme" of acme.trina.app), else null. One label only. */
export function hostedName(hostname: string, teamDomain: string | null): string | null {
  if (!teamDomain) return null
  const h = hostname.toLowerCase().replace(/\.$/, '')
  const d = teamDomain.toLowerCase()
  if (!h.endsWith(`.${d}`)) return null
  const label = h.slice(0, -(d.length + 1))
  return label && LABEL.test(label) ? label : null
}

/** Read what was typed or pasted. Nothing is fetched here: the apps check the address (/api/health) only when the
 * person presses the button, and never try another domain. */
export function parseTeamInput(raw: string, o: TeamInputOptions): TeamInput {
  if (raw.length > 8192) return { ok: false, error: 'invalid' }
  const typed = raw.trim()
  if (!typed) return { ok: false, error: 'empty' }
  const word = linkInText(typed)
  if (word === null) return { ok: false, error: HANGUL.test(typed) ? 'hangul' : 'invalid' }
  if (word.length > 2048) return { ok: false, error: 'invalid' }
  const schemed = /^[a-z][a-z0-9+.-]*:/i.test(word) && !/^[^:/]+:\d/.test(word)
  if (!schemed && EMAIL.test(word)) return { ok: false, error: 'email' }
  if (HANGUL.test(word)) return { ok: false, error: 'hangul' }
  let text = word
  if (!schemed) {
    if (LABEL.test(word) && word.toLowerCase() !== 'localhost') {
      if (!o.teamDomain) return { ok: false, error: 'invalid' }
      text = `https://${word.toLowerCase()}.${o.teamDomain}`
    } else {
      const host = word.split(/[/?#]/)[0] ?? ''
      const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? ''
      text = `${o.loopbackHttp && isLoopbackHost(hostname) ? 'http' : 'https'}://${word}`
    }
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return { ok: false, error: /^https?:/i.test(word) ? 'invalid' : 'unsupported_scheme' }
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return { ok: false, error: 'invalid' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'unsupported_scheme' }
  if (u.username || u.password) return { ok: false, error: 'credentials' }
  const hostname = u.hostname
  // ASCII only (the URL parser makes an internationalized name punycode; a parser that cannot is refused)
  if (!hostname || hostname.endsWith('.') || hostname.includes('..') || !/^[a-z0-9.\-[\]:]+$/i.test(hostname)) return { ok: false, error: 'invalid' }
  const loopback = isLoopbackHost(hostname)
  if (u.protocol === 'http:' && !(loopback && o.loopbackHttp)) return { ok: false, error: 'insecure' }
  const hostedLabel = isIpHost(hostname) ? null : hostedName(hostname, o.teamDomain)
  // a development relay's team (acme.localhost) has a name too, for "'acme' 팀을 찾지 못했어요"; it is not hosted
  const name = hostedLabel ?? (loopback ? hostedName(hostname, 'localhost') : null)
  const base = { ok: true as const, origin: u.origin, host: u.host, name, hosted: hostedLabel !== null && u.protocol === 'https:', loopback }
  const path = u.pathname
  if (/^\/invite(?:\/|$)/.test(path)) {
    const token = path.slice('/invite/'.length)
    return TOKEN.test(token) && !u.search && !u.hash ? { ...base, entryPath: `/invite/${token}` } : { ok: false, error: 'link' }
  }
  if (path === '/join' || path === '/join/') {
    const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
    const token = frag.get('t') ?? ''
    return JOIN_TOKEN.test(token) && !u.search ? { ...base, entryPath: `/join#t=${token}` } : { ok: false, error: 'link' }
  }
  // any other page (an address copied from a browser's address bar): the team opens at its start
  return { ...base, entryPath: '/' }
}

/** What the team's relay answered instead of the team server (the `x-relay-error` header; relay/src/relay.ts). */
export type RelayAnswer = 'unknown' | 'suspended' | 'offline' | null
export function relayAnswer(status: number, relayError: string | null | undefined): RelayAnswer {
  const kind = relayError ?? ''
  if (status === 404 && kind === 'team_unknown') return 'unknown'
  if (status === 403 && (kind === 'team_suspended' || kind === 'team_suspended_billing')) return 'suspended'
  if (status >= 500 && /^team_(offline|offline_cloud|busy|maintenance|timeout|connection_lost)$|^bad_gateway$/.test(kind)) return 'offline'
  return null
}

/**
 * A renamed team (the relay answers 308 with the new address, control-plane D40): the new origin, only when it is
 * another `<name>.<teamDomain>` (or `<name>.localhost` for development) with the same scheme and port as the address
 * asked, so a redirect can never take the app to another server. null: not followed.
 */
export function relayRename(fromOrigin: string, location: string | null | undefined, o: TeamInputOptions): string | null {
  if (!location) return null
  try {
    const from = new URL(fromOrigin)
    const to = new URL(location, fromOrigin)
    if (to.protocol !== from.protocol || to.port !== from.port || to.username || to.password || to.origin === from.origin || to.hostname.endsWith('.')) return null
    const domains = [o.teamDomain, ...(o.loopbackHttp ? ['localhost'] : [])].filter((d): d is string => !!d)
    for (const d of domains) if (hostedName(from.hostname, d) && hostedName(to.hostname, d)) return to.origin
    return null
  } catch {
    return null
  }
}

/**
 * A link that opens the app from outside (docs/DECISIONS.md "First run, phase 2"): `<scheme>://open?url=<encoded team
 * link>` (the web's "앱에서 열기", the desktop's protocol handler, the phone's scheme) and, where `universal` is set
 * (the phone), the team's own invite or team link at `https://<name>.<teamDomain>` (a universal link / app link). The
 * address inside goes through parseTeamInput's rules, so no `javascript:`, `file:`, plain http to another machine,
 * user:password or text around it; a numeric host is shown as the URL parser writes it (`https://0x7f.1` is
 * 127.0.0.1). null: not a link for the app. Whatever comes back, the app asks first (screen ④, LinkGate).
 */
export function readAppLink(raw: string, o: TeamInputOptions & { scheme: string; universal: boolean }): TeamInput | null {
  if (typeof raw !== 'string' || raw.length > 4096 || /\s/.test(raw)) return null
  const prefix = `${o.scheme.toLowerCase()}:`
  if (raw.toLowerCase().startsWith(prefix)) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return null
    }
    if (u.protocol !== prefix || u.hostname !== 'open' || u.username || u.password || u.port || (u.pathname !== '' && u.pathname !== '/') || u.hash) return null
    const keys = [...u.searchParams.keys()]
    const inner = u.searchParams.get('url') ?? ''
    if (keys.length !== 1 || keys[0] !== 'url' || !/^https?:\/\/[^\s]+$/i.test(inner)) return null
    return parseTeamInput(inner, o)
  }
  if (o.universal && /^https:\/\//i.test(raw)) {
    const p = parseTeamInput(raw, o)
    // only a hosted team's invite or team link opens the app this way (the domains the app declares)
    return p.ok && p.hosted && p.entryPath !== '/' ? p : null
  }
  return null
}

/** What screen ④ shows for a link: the host the app would connect to (punycode, with its port) and whether the hosted
 * service runs it. */
export interface LinkOffer { origin: string; host: string; entryPath: string; hosted: boolean; name: string | null }

/**
 * Screen ④'s gate: a link from outside is only remembered here; nothing is fetched or loaded until the person said yes
 * on ④. The yes counts only for the host ④ showed (a second link that arrived meanwhile is not confirmed by a click
 * meant for the first) and only after ④ was on screen for `minMs` (no yes right under a click that opened it); the
 * offer is used once.
 */
export class LinkGate {
  private offer: (LinkOffer & { at: number }) | null = null
  constructor(private minMs = 600) {}
  /** a new link replaces the one waiting */
  put(link: TeamInputOk, now: number): LinkOffer {
    const offer = { origin: link.origin, host: link.host, entryPath: link.entryPath, hosted: link.hosted, name: link.name }
    this.offer = { ...offer, at: now }
    return offer
  }
  pending(): LinkOffer | null {
    if (!this.offer) return null
    const { at: _at, ...offer } = this.offer
    return offer
  }
  /** the person's answer on ④: the link to connect to, or null (no, another host, too soon, nothing waiting) */
  answer(yes: boolean, host: string, now: number): LinkOffer | null {
    const o = this.offer
    if (!o) return null
    if (!yes) {
      this.offer = null
      return null
    }
    if (o.host !== host || now - o.at < this.minMs) return null
    this.offer = null
    const { at: _at, ...offer } = o
    return offer
  }
}
