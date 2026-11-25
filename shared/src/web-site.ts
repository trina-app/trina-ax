// What a "site" is for a web allowance, one rule for the team server's address card (server/src/tools/url-gate.ts) and
// the desktop app's browser (desktop/src/common/site-permissions.ts): the registrable domain (eTLD+1) by the Public
// Suffix List with its private section (tldts), so alice.github.io, x.lovable.app or a bucket under s3.amazonaws.com is
// its own site and allowing the suffix's owner never covers it. And which site an "Always allow" may keep: not one
// whose address has a long or random-looking name before the site (the address card's rule: such a name can carry data
// to the name servers, docs/decisions/20261125-one-site-always-desktop-browser.md).
import { getDomain } from 'tldts'

/** The part of a host name before its site that always asks, also on an allowed site: this many characters or more. */
export const MAX_SITE_SUBDOMAIN = 20

/** A host without brackets, trailing dots or port, in lower case ('' for nothing usable). */
export function bareHost(host: string): string {
  let h = String(host ?? '').trim().toLowerCase()
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h)
  if (v6) return v6[1]!
  if ((h.match(/:/g) ?? []).length === 1) h = h.replace(/:\d*$/, '')
  return h.replace(/\.+$/, '')
}

/**
 * The site of a host name: its registrable domain in ASCII (news.example.co.kr -> example.co.kr, x.alice.github.io ->
 * alice.github.io, attacker.lovable.app -> attacker.lovable.app). null = nothing to allow as a site: an IP address, a
 * single-label name, a name that is itself a public suffix (co.kr, github.io, lovable.app). A port is ignored.
 */
export function siteOfHost(host: string): string | null {
  const h = bareHost(host)
  if (!h || h.includes(':') || !h.includes('.') || /^[\d.]+$/.test(h)) return null
  const d = getDomain(h, { allowPrivateDomains: true, detectIp: true, validateHostname: true, extractHostname: false })
  return d && d.includes('.') ? d : null
}

/** The name before the site when it is MAX_SITE_SUBDOMAIN characters or longer (news.example.co.kr: "news" is short). */
export function longSubdomainOf(host: string, site: string | null): string[] {
  if (!site) return []
  const h = bareHost(host)
  if (!h.endsWith('.' + site)) return []
  const sub = h.slice(0, -(site.length + 1))
  return sub.length >= MAX_SITE_SUBDOMAIN ? [sub] : []
}

/**
 * The site an "Always allow" for this host keeps for good, or null when none may be kept: no site (above), or a long
 * or random-looking name before the site (the address card offers no site Always for those either). The desktop app's
 * card names this site on its Always button; the server keeps exactly this.
 */
export function siteToKeep(host: string): string | null {
  const site = siteOfHost(host)
  if (!site || longSubdomainOf(host, site).length) return null
  return opaqueParts(bareHost(host)).length ? null : site
}

/** Long random-looking parts of a text (base32 / hex / base64 of something): an address can carry data in them. 20+
 * characters without separators that mix letters and digits (or both cases) with high character entropy, except
 * letters that read as camelCase words (camelWords: attributesToRetrieve, XMLHttpRequest). Shown highlighted on cards;
 * a hint, not a rule. */
export function opaqueParts(text: string, max = 50): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z0-9+%]{20,}/g)) {
    if (out.size >= max) break
    const s = m[0]
    const mixed = /\d/.test(s) ? /[A-Za-z]/.test(s) : /[a-z]/.test(s) && /[A-Z]/.test(s)
    if (mixed && entropy(s) >= 3 && !camelWords(s)) out.add(s)
  }
  return [...out]
}
/** Letters only, in camelCase or PascalCase words (attributesToRetrieve, getElementById, XMLHttpRequest): every piece
 * between case changes is a word ("To", "By", "Retrieve": 2 letters or more, a two-letter one with a vowel) or an
 * acronym in capitals (1 to 5 letters, at most 2 of them: "XML", the "A" of "isAValue"), 3 letters or more a piece on
 * average, and the words are at least 30% vowels (a e i o u y) as English words are. Random letters (base64 without
 * digits: "xKqWzPbNvLmTrYcHdJsF") change case about every other letter, which leaves one-letter pieces, runs of
 * capitals and few vowels: fewer than 1 in 100 random runs of 20 to 40 letters pass all of it. */
function camelWords(s: string): boolean {
  if (!/^[A-Za-z]+$/.test(s)) return false
  const pieces = s.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []
  const words = pieces.filter((p) => /[a-z]/.test(p))
  const acronyms = pieces.length - words.length
  if (acronyms > 2 || pieces.length * 3 > s.length) return false
  if (!pieces.every((p) => /[a-z]/.test(p) ? p.length > 2 || (p.length === 2 && /[aeiouy]/i.test(p)) : p.length <= 5)) return false
  const letters = words.join('')
  return (letters.match(/[aeiouy]/gi)?.length ?? 0) >= letters.length * 0.3
}
function entropy(s: string): number {
  const n = new Map<string, number>()
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1)
  let e = 0
  for (const k of n.values()) { const p = k / s.length; e -= p * Math.log2(p) }
  return e
}
