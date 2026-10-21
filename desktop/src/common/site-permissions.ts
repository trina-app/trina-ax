// "Allowed sites" of the in-app browser (design tab 5 "브라우저 안전장치"): before the AI acts on a site the person
// allows it for this turn ("once"), always (saved per team), or denies. Office-network (private) addresses have
// their own grants: allowing example.com as a public site doesn't allow it once its DNS points into the office.
// Site access "all" (the person's choice in the pane's settings): every public site counts as allowed, so the AI
// opens public websites without asking. It never touches the office-network scope: those addresses still ask.
// Pure: persistence is the caller's (load / toJSON). Unit-tested in tests/unit/e-desktop-common.test.ts.

export type PermissionDecision = 'once' | 'always' | 'deny'
export type SiteScope = 'site' | 'private'
/** ask: the person answers for each new site (default); all: every public website is allowed */
export type SiteAccess = 'ask' | 'all'

export interface SavedPermissions {
  /** hosts allowed always (host[:port], "www." dropped) */
  always: string[]
  /** office-network hosts allowed always */
  privateAlways: string[]
  /** absent in files written before the setting existed: 'ask' */
  siteAccess?: SiteAccess
}

export const asSiteAccess = (v: unknown): SiteAccess => (v === 'all' ? 'all' : 'ask')

/** Keep "once" grants for this many recent turns. */
const MAX_TURNS = 32

/** host[:port] without a leading "www."; '' for non-http(s) URLs. */
export function siteKey(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.host.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Second-level labels under a two-letter country code that are registries, not sites (example.co.kr, shop.com.au,
 * x.ac.id). Also any second-level label of 2 letters or fewer under a country code (conservative: a wrong guess only
 * makes a site narrower).
 */
const CC_SLD = new Set(['co', 'com', 'net', 'org', 'ac', 'go', 'or', 'ne', 're', 'pe', 'gov', 'edu', 'mil', 'sch', 'web', 'biz', 'ltd', 'plc', 'nhs', 'gob', 'gouv', 'nic', 'info', 'desa', 'ponpes', 'kep', 'busan', 'seoul', 'daegu', 'incheon', 'gwangju', 'daejeon', 'ulsan', 'gyeonggi', 'gangwon', 'chungbuk', 'chungnam', 'jeonbuk', 'jeonnam', 'gyeongbuk', 'gyeongnam', 'jeju', 'sejong'])
/**
 * Hosting suffixes where every subdomain belongs to someone else (Public Suffix List, private section; the ones a team
 * is likely to meet). Under these, a site is one label plus the suffix: alice.github.io and bob.github.io are two sites.
 */
const SHARED_SUFFIXES = [
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'now.sh', 'netlify.app', 'netlify.com', 'herokuapp.com', 'herokussl.com',
  'appspot.com', 'web.app', 'firebaseapp.com', 'blogspot.com', 'wordpress.com', 'tumblr.com', 'substack.com', 'notion.site', 'myshopify.com',
  'cloudfront.net', 'azurewebsites.net', 'azurestaticapps.net', 'amazonaws.com', 'awsapps.com', 'onrender.com', 'fly.dev', 'glitch.me',
  'repl.co', 'replit.app', 'replit.dev', 'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'trycloudflare.com', 'deno.dev', 'surge.sh', 'translate.goog',
  'googleusercontent.com', 'storage.googleapis.com', 'blob.core.windows.net', 'r2.dev', 'supabase.co', 'framer.website', 'webflow.io',
  'wixsite.com', 'carrd.co', 'neocities.org', 'readthedocs.io', 'duckdns.org', 'ddns.net', 'no-ip.org', 'ts.net', 'github.dev', 'codesandbox.io',
  'stackblitz.io', 'pythonanywhere.com', 'azureedge.net', 'akamaized.net', 'fastly.net', 'b-cdn.net', 'tistory.com', 'blog.me', 'modoo.at',
]

/**
 * The registrable domain of a hostname ("site" as browsers mean it): news.naver.com and naver.com -> naver.com,
 * media.cnn.com -> cnn.com, a.example.co.kr -> example.co.kr, alice.github.io -> alice.github.io. IP literals and
 * single-label names are their own site. An approximation of the Public Suffix List that errs narrow.
 */
export function registrableDomain(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':')) return h
  const labels = h.split('.')
  for (const suffix of SHARED_SUFFIXES) {
    if (h === suffix) return h
    if (h.endsWith(`.${suffix}`)) return labels.slice(-(suffix.split('.').length + 1)).join('.')
  }
  const tld = labels[labels.length - 1]
  const sld = labels[labels.length - 2]
  const n = tld.length === 2 && (sld.length <= 2 || CC_SLD.has(sld)) ? 3 : 2
  return labels.slice(-n).join('.')
}

/** The site of a host[:port] key: its registrable domain, same port. */
export function siteOf(key: string): string {
  const m = /^(\[[^\]]+\]|[^:]+)(:\d+)?$/.exec(key)
  if (!m) return key
  return `${registrableDomain(m[1])}${m[2] ?? ''}`
}

/** Two host[:port] keys belong to the same site (registrable domain and port). */
export function sameSite(a: string, b: string): boolean {
  return a === b || (Boolean(a) && Boolean(b) && siteOf(a) === siteOf(b))
}

export class SitePermissions {
  private always: Record<SiteScope, Set<string>>
  /** turnId -> scope -> hosts allowed for that turn */
  private once = new Map<string, Record<SiteScope, Set<string>>>()
  private access: SiteAccess

  constructor(saved?: Partial<SavedPermissions>) {
    const clean = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 300) : [])
    this.always = { site: new Set(clean(saved?.always)), private: new Set(clean(saved?.privateAlways)) }
    this.access = asSiteAccess(saved?.siteAccess)
  }

  get siteAccess(): SiteAccess {
    return this.access
  }

  /** The person's site-access choice. Returns true when it changed (caller persists). */
  setSiteAccess(v: SiteAccess): boolean {
    const next = asSiteAccess(v)
    if (next === this.access) return false
    this.access = next
    return true
  }

  /**
   * Allowed: the host itself, or (public sites only) its whole site when the person allowed the site's own domain:
   * naver.com covers news.naver.com, news.naver.com covers only itself. Office-network grants are exact.
   */
  isAllowed(scope: SiteScope, host: string, turnId?: string): boolean {
    if (!host) return false
    if (scope === 'site' && this.access === 'all') return true
    const keys = scope === 'site' && siteOf(host) !== host ? [host, siteOf(host)] : [host]
    const once = turnId ? this.once.get(turnId)?.[scope] : undefined
    return keys.some((k) => this.always[scope].has(k) || Boolean(once?.has(k)))
  }

  /** Record the person's answer. Returns true when the decision changed what is saved (caller persists). */
  grant(scope: SiteScope, host: string, decision: PermissionDecision, turnId?: string): boolean {
    if (!host || decision === 'deny') return false
    if (decision === 'always') {
      if (this.always[scope].has(host)) return false
      this.always[scope].add(host)
      return true
    }
    const key = turnId ?? '_'
    let t = this.once.get(key)
    if (!t) {
      t = { site: new Set(), private: new Set() }
      this.once.set(key, t)
      while (this.once.size > MAX_TURNS) this.once.delete(this.once.keys().next().value as string)
    }
    t[scope].add(host)
    return false
  }

  /** Remove a saved site (the pane's "allowed sites" list). */
  revoke(host: string): boolean {
    const a = this.always.site.delete(host)
    const b = this.always.private.delete(host)
    return a || b
  }

  /** Remove every saved site (the list's "clear all"). Returns true when something was removed. */
  revokeAll(): boolean {
    const had = this.always.site.size + this.always.private.size > 0
    this.always.site.clear()
    this.always.private.clear()
    return had
  }

  forgetTurn(turnId: string): void {
    this.once.delete(turnId)
  }

  list(): SavedPermissions {
    return { always: [...this.always.site].sort(), privateAlways: [...this.always.private].sort() }
  }

  toJSON(): SavedPermissions {
    return { ...this.list(), siteAccess: this.access }
  }
}
