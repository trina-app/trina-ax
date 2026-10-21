// Sign-in rate limits (tab 4 "로그인 시도는 IP·계정별 횟수 제한", tab 7 "계정 탈취"). Failed attempts are rows in
// login_attempts, so limits survive a restart. The IP is always the real client IP (socket peer or relay OPEN
// metadata, RequestInfo.ip), never a client header; when it is unknown only the account limit applies.
import type { Database } from 'bun:sqlite'

export interface Limits {
  /** sliding window */
  windowMs: number
  /** failed password attempts per account (lower-cased username) */
  perAccount: number
  /** failed password attempts per client IP, across accounts */
  perIp: number
  /** wrong re-entered / current passwords per signed-in person (owner-reauth, password change) */
  perReauth: number
  /** unknown invite / reset / setup tokens per client IP */
  perTokenIp: number
}

export const DEFAULT_LIMITS: Limits = { windowMs: 15 * 60_000, perAccount: 10, perIp: 30, perReauth: 5, perTokenIp: 30 }

export type LimitKind = 'account' | 'ip' | 'reauth' | 'token-ip'
export interface LimitKey { kind: LimitKind; id: string }

export const accountKey = (username: string): LimitKey => ({ kind: 'account', id: username.toLowerCase() })
/**
 * The id an IP's limit counts under: an IPv4 address as is, an IPv6 address by its /64 network. One machine on a LAN
 * can give itself any number of IPv6 addresses in its /64 (link-local fe80::/64 needs no router), so counting each
 * address apart would let it try without limit; a /64 is what one network segment gets.
 */
export function limitIp(ip: string): string {
  if (!ip.includes(':')) return ip
  const bare = ip.replace(/%.*$/, '').toLowerCase()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare)
  if (mapped) return mapped[1]!
  const [head = '', tail = ''] = bare.split('::')
  const h = head ? head.split(':') : [], t = bare.includes('::') && tail ? tail.split(':') : []
  const groups = bare.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  if (groups.length < 4) return bare
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}

export const ipKeys = (ip: string | null): LimitKey[] => (ip ? [{ kind: 'ip', id: limitIp(ip) }] : [])
export const reauthKey = (userId: string): LimitKey => ({ kind: 'reauth', id: userId })
export const tokenIpKeys = (ip: string | null): LimitKey[] => (ip ? [{ kind: 'token-ip', id: limitIp(ip) }] : [])

const keyStr = (k: LimitKey) => `${k.kind}:${k.id}`

export class RateLimiter {
  constructor(private db: Database, public limits: Limits = DEFAULT_LIMITS, public now: () => number = Date.now) {}

  private limitOf(k: LimitKey): number {
    switch (k.kind) {
      case 'account': return this.limits.perAccount
      case 'ip': return this.limits.perIp
      case 'reauth': return this.limits.perReauth
      case 'token-ip': return this.limits.perTokenIp
    }
  }

  /** Seconds to wait when any key is over its limit, else 0. */
  retryAfter(keys: LimitKey[]): number {
    const now = this.now()
    let wait = 0
    for (const k of keys) {
      const limit = this.limitOf(k)
      const rows = this.db.query('SELECT at FROM login_attempts WHERE key = ? AND at > ? ORDER BY at DESC LIMIT ?')
        .all(keyStr(k), now - this.limits.windowMs, limit) as { at: number }[]
      if (rows.length >= limit) {
        // the limit-th newest attempt must leave the window before another try is allowed
        const oldest = rows[rows.length - 1]!.at
        wait = Math.max(wait, Math.ceil((oldest + this.limits.windowMs - now) / 1000))
      }
    }
    return Math.max(wait, 0)
  }

  /**
   * Check the limits and, when under them, count this attempt right away (before the slow password check), so
   * concurrent requests cannot all pass the check before any failure is recorded. Throws nothing: returns the wait
   * in seconds (> 0 = refused, nothing recorded) or a hold whose `release()` un-counts the attempt when it succeeded.
   */
  hold(keys: LimitKey[]): { wait: number; release(): void } {
    const wait = this.retryAfter(keys)
    if (wait > 0) return { wait, release() {} }
    const at = this.now()
    const ids: number[] = []
    const q = this.db.query('INSERT INTO login_attempts (key, at) VALUES (?, ?)')
    this.db.transaction(() => { for (const k of keys) ids.push(Number(q.run(keyStr(k), at).lastInsertRowid)) })()
    return {
      wait: 0,
      release: () => {
        const del = this.db.query('DELETE FROM login_attempts WHERE id = ?')
        this.db.transaction(() => { for (const id of ids) del.run(id) })()
      },
    }
  }

  fail(keys: LimitKey[]): void {
    const at = this.now()
    const q = this.db.query('INSERT INTO login_attempts (key, at) VALUES (?, ?)')
    this.db.transaction(() => { for (const k of keys) q.run(keyStr(k), at) })()
  }

  clear(k: LimitKey): void {
    this.db.query('DELETE FROM login_attempts WHERE key = ?').run(keyStr(k))
  }

  sweep(): number {
    return this.db.query('DELETE FROM login_attempts WHERE at <= ?').run(this.now() - this.limits.windowMs).changes
  }
}
