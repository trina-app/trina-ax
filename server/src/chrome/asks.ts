// What a person's own MCP app (Claude Code, Codex, Claude) needs them to decide in their browser profiles
// (docs/decisions/20261128-mcp-browser-tools.md): a site nobody allowed in that profile, an address that is not plain,
// an office-network address. The person decides on one Trina page (/browser-ask/<id>, web/src/pages/BrowserAsk.tsx);
// the app never decides (an MCP client can answer its own elicitation). Asks live in memory for ASK_MS: a restart
// drops them, and the app's next call asks again. A "once" answer is kept for the connection for ONCE_MS: a plain
// address covers its host, an address that is not plain only itself.
import crypto from 'node:crypto'

export const ASK_MS = 10 * 60_000
export const ONCE_MS = 10 * 60_000
/** open asks at once, per connection and per person */
export const ASKS_OPEN_MAX = 5
/** asks made per hour, per connection and per person */
export const ASKS_HOUR_MAX = 30

export type AskKind = 'site' | 'address' | 'office'
export type AskDecision = 'once' | 'always' | 'no'

export interface BrowserAsk {
  id: string
  userId: string
  grantId: string
  /** the connection as Settings › Trina AX MCP shows it */
  client: { name: string; connectedAt: string }
  linkId: string
  profile: string
  host: string
  /** the full address the person sees */
  url: string
  kind: AskKind
  /** what an Always keeps (a site key), null: no Always on this ask */
  site: string | null
  createdAt: number
  expiresAt: number
  decision: AskDecision | null
}

/** the key a once-answer is kept under: a plain address its host, any other address itself */
export const onceKey = (linkId: string, kind: AskKind, host: string, url: string) => `${linkId}\0${kind === 'address' ? 'url\0' + url : 'host\0' + host}`

/** a client name as people see it: no control or format characters, one line, at most 30 characters */
export function cleanClientName(name: string): string {
  const s = Array.from(name.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim()).slice(0, 30).join('').trim()
  return s || 'An app'
}

export class BrowserAsks {
  private asks = new Map<string, BrowserAsk>()
  private waiters = new Map<string, Set<(d: AskDecision | null) => void>>()
  private made: { userId: string; grantId: string; at: number }[] = []
  private once = new Map<string, Map<string, number>>()
  /** told when a page decides (the MCP side ends its wait, sends elicitation/complete) */
  private listeners: ((ask: BrowserAsk) => void)[] = []

  constructor(private now: () => number = Date.now) {}

  onDecided(l: (ask: BrowserAsk) => void) { this.listeners.push(l) }

  private sweep() {
    const t = this.now()
    for (const [id, a] of this.asks) if (a.expiresAt <= t) { this.asks.delete(id); this.wake(id, null) }
    this.made = this.made.filter((m) => m.at > t - 3600_000)
    for (const [g, m] of this.once) { for (const [k, until] of m) if (until <= t) m.delete(k); if (!m.size) this.once.delete(g) }
  }

  private wake(id: string, d: AskDecision | null) {
    const w = this.waiters.get(id)
    this.waiters.delete(id)
    if (w) for (const f of w) try { f(d) } catch { /* a waiter that throws changes nothing */ }
  }

  /** A new ask, or the open one for the same connection and host (and address, for an address that is not plain).
   * A string: refused (the limits), with the sentence for the AI. */
  create(o: Omit<BrowserAsk, 'id' | 'createdAt' | 'expiresAt' | 'decision'>): BrowserAsk | string {
    this.sweep()
    const same = [...this.asks.values()].find((a) => a.decision === null && a.grantId === o.grantId && a.linkId === o.linkId && a.host === o.host && a.kind === o.kind && (o.kind !== 'address' || a.url === o.url))
    if (same) return same
    const open = [...this.asks.values()].filter((a) => a.decision === null)
    if (open.filter((a) => a.grantId === o.grantId).length >= ASKS_OPEN_MAX || open.filter((a) => a.userId === o.userId).length >= ASKS_OPEN_MAX) {
      return `Not asked: ${ASKS_OPEN_MAX} questions for the user are already waiting in Trina. Wait until the user answers them, then try again.`
    }
    if (this.made.filter((m) => m.grantId === o.grantId).length >= ASKS_HOUR_MAX || this.made.filter((m) => m.userId === o.userId).length >= ASKS_HOUR_MAX) {
      return `Not asked: this app already asked the user ${ASKS_HOUR_MAX} times in the last hour. Stop and tell the user what you need.`
    }
    const t = this.now()
    const ask: BrowserAsk = { ...o, client: { ...o.client, name: cleanClientName(o.client.name) }, id: crypto.randomBytes(16).toString('hex'), createdAt: t, expiresAt: t + ASK_MS, decision: null }
    this.asks.set(ask.id, ask)
    this.made.push({ userId: o.userId, grantId: o.grantId, at: t })
    return ask
  }

  /** The person's own open ask (another person's, a decided or an expired one: null). */
  view(id: string, userId: string): BrowserAsk | null {
    this.sweep()
    const a = typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? this.asks.get(id) : undefined
    return a && a.userId === userId && a.decision === null ? a : null
  }

  /** The person decides on the page. `keep`: what an Always or a once keeps (the caller's database writes); false: not
   * kept (the ask was gone). */
  decide(id: string, userId: string, d: AskDecision, keep: (a: BrowserAsk) => void): BrowserAsk | null {
    const a = this.view(id, userId)
    if (!a) return null
    a.decision = d
    if (d !== 'no') keep(a)
    if (d === 'once' || (d === 'always' && !a.site)) this.allowOnce(a.grantId, onceKey(a.linkId, a.kind, a.host, a.url))
    this.asks.delete(id)
    this.wake(id, d)
    for (const l of this.listeners) try { l(a) } catch { /* a listener that throws changes nothing */ }
    return a
  }

  allowOnce(grantId: string, key: string) {
    const m = this.once.get(grantId) ?? new Map<string, number>()
    m.set(key, this.now() + ONCE_MS)
    this.once.set(grantId, m)
  }

  allowedOnce(grantId: string, key: string): boolean {
    const until = this.once.get(grantId)?.get(key)
    return until !== undefined && until > this.now()
  }

  /** the hosts a once-answer opens now for this connection in this profile (what the extension is told it may use) */
  onceHosts(grantId: string, linkId: string): string[] {
    const m = this.once.get(grantId)
    if (!m) return []
    const t = this.now(), pre = `${linkId}\0host\0`
    return [...m].filter(([k, until]) => until > t && k.startsWith(pre)).map(([k]) => k.slice(pre.length))
  }

  /** Wait for the page's decision at most `ms` (null: none yet, or the ask went). */
  wait(id: string, ms: number, signal?: AbortSignal): Promise<AskDecision | null> {
    const a = this.asks.get(id)
    if (!a) return Promise.resolve(null)
    if (a.decision) return Promise.resolve(a.decision)
    return new Promise((resolve) => {
      let done = false
      const finish = (d: AskDecision | null) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.waiters.get(id)?.delete(finish); resolve(d) }
      const onAbort = () => finish(null)
      const timer = setTimeout(() => finish(null), Math.max(0, ms))
      ;(timer as { unref?: () => void }).unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      const w = this.waiters.get(id) ?? new Set()
      w.add(finish)
      this.waiters.set(id, w)
    })
  }

  /** a connection ended (Disconnect): its asks and once-answers go */
  dropGrant(grantId: string) {
    for (const [id, a] of this.asks) if (a.grantId === grantId) { this.asks.delete(id); this.wake(id, null) }
    this.once.delete(grantId)
  }
}
