// "Allowed sites" of the in-app browser (design tab 5 "브라우저 안전장치"): before the AI acts on a site the person
// allows it for this turn ("once"), always (saved per team), or denies. Office-network (private) addresses have
// their own grants: allowing example.com as a public site doesn't allow it once its DNS points into the office.
// Pure: persistence is the caller's (load / toJSON). Unit-tested in tests/unit/e-site-permissions.test.ts.

export type PermissionDecision = 'once' | 'always' | 'deny'
export type SiteScope = 'site' | 'private'

export interface SavedPermissions {
  /** hosts allowed always (host[:port], "www." dropped) */
  always: string[]
  /** office-network hosts allowed always */
  privateAlways: string[]
}

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

export class SitePermissions {
  private always: Record<SiteScope, Set<string>>
  /** turnId -> scope -> hosts allowed for that turn */
  private once = new Map<string, Record<SiteScope, Set<string>>>()

  constructor(saved?: Partial<SavedPermissions>) {
    const clean = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 300) : [])
    this.always = { site: new Set(clean(saved?.always)), private: new Set(clean(saved?.privateAlways)) }
  }

  isAllowed(scope: SiteScope, host: string, turnId?: string): boolean {
    if (!host) return false
    if (this.always[scope].has(host)) return true
    return Boolean(turnId && this.once.get(turnId)?.[scope].has(host))
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
    return this.list()
  }
}
