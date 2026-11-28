// The live connections of the Chromes people linked (docs/decisions/20261128-trina-in-chrome.md). Each extension holds
// one WebSocket (routes/chrome.ts) that authenticates with its link token in the first frame and then carries only
// browser calls to it and acks and results back. It is not a window of the realtime hub: it gets no chat, file or
// presence event, the person does not look online for it, and it does not count as an open window for notifications.
// To the browser relay (realtime/browser-relay.ts) a linked Chrome is one more window, `chrome:<linkId>`, of its person.
import {
  BrowserResult, CHROME_AUTH_WAIT_MS, ChromeClientFrame, ChromeWsClose, type ChromeServerFrame, type ServerEventInput,
} from '@mycel/shared/api'
import { BROWSER_BRIDGE_VERSION } from '@mycel/shared'
import type { RealtimeConn } from '../services'
import type { AppContext } from '../context'
import { getTeamSettings } from '../admin/settings'
import { CHROME_WINDOW_PREFIX, isChromeWindow, type WindowTransport } from '../realtime/call-relay'
import { linkByToken, touchLink } from './store'
import { teamHosts } from './team-hosts'

export const PING_INTERVAL_MS = 20_000
/** last_seen_at is written at most this often per link */
const TOUCH_EVERY_MS = 5 * 60_000

export const chromeWindowOf = (linkId: string) => `${CHROME_WINDOW_PREFIX}${linkId}`

interface LinkSocket { conn: RealtimeConn; userId: string; linkId: string; windowId: string; openedAt: number; touchedAt: number; closed: boolean }

type FrameListener = (userId: string, windowId: string, f: { type: 'browser.ack'; callId: string } | { type: 'browser.result'; result: BrowserResult }) => void

/** the first frame at most this long; sockets waiting for it per address at most */
const PREAUTH_MAX_CHARS = 2048
const PREAUTH_PER_IP = 20

export class ChromeLinks implements WindowTransport {
  private byLink = new Map<string, LinkSocket>()
  private waiting = new Map<string, number>()

  /** May another socket from this address wait for its first frame? */
  mayOpen(ip: string): boolean { return (this.waiting.get(ip) ?? 0) < PREAUTH_PER_IP }
  private windowListeners: ((userId: string, windowId: string, state: 'open' | 'closed') => void)[] = []
  private frameListeners: FrameListener[] = []

  constructor(private ctx: AppContext, private unlinkHook: (userId: string, linkId: string) => void = () => {}) {}

  // ---------------- the relay's side (WindowTransport) ----------------
  onWindow(l: (userId: string, windowId: string, state: 'open' | 'closed') => void) { this.windowListeners.push(l) }
  onFrame(l: FrameListener) { this.frameListeners.push(l) }

  isWindowOpen(userId: string, windowId: string): boolean {
    const s = this.byLink.get(windowId.slice(CHROME_WINDOW_PREFIX.length))
    return !!s && !s.closed && s.userId === userId && isChromeWindow(windowId)
  }

  /** a linked Chrome runs every tool of the current contract, file_upload too */
  paneOfWindow(userId: string, windowId: string): number | undefined {
    return this.isWindowOpen(userId, windowId) ? BROWSER_BRIDGE_VERSION : undefined
  }

  /** browser.call and browser.cancel as the relay frames them, in the extension's own frames; anything else is dropped */
  publishTo(userId: string, windowId: string, ev: ServerEventInput): number {
    const s = this.byLink.get(windowId.slice(CHROME_WINDOW_PREFIX.length))
    if (!s || s.closed || s.userId !== userId) return 0
    const d = ev.data as { call?: unknown; callId?: unknown }
    let f: ChromeServerFrame | null = null
    if (ev.type === 'browser.call' && d?.call) f = { type: 'browser.call', call: d.call as Extract<ChromeServerFrame, { type: 'browser.call' }>['call'] }
    else if (ev.type === 'browser.cancel' && typeof d?.callId === 'string') f = { type: 'browser.cancel', callId: d.callId }
    if (!f) return 0
    this.send(s, f)
    return 1
  }

  /** This person's browser profiles that are connected now and still linked (link id and window id), oldest first. */
  onlineLinks(userId: string): { linkId: string; windowId: string }[] {
    const out: { linkId: string; windowId: string; at: number }[] = []
    for (const s of [...this.byLink.values()]) {
      if (s.closed || s.userId !== userId) continue
      if (this.stillLinked(s)) out.push({ linkId: s.linkId, windowId: s.windowId, at: s.openedAt })
    }
    return out.sort((a, b) => a.at - b.at).map(({ linkId, windowId }) => ({ linkId, windowId }))
  }

  /** the link row is still there (ended by Disconnect, a new link or the person's sessions ending: the socket closes) */
  private stillLinked(s: LinkSocket): boolean {
    let ok = false
    try { ok = !!this.ctx.db.query('SELECT 1 FROM chrome_links WHERE id = ? AND user_id = ?').get(s.linkId, s.userId) } catch { ok = false }
    if (!ok) this.close(s, ChromeWsClose.revoked, 'link ended')
    return ok
  }

  online(linkId: string): boolean {
    const s = this.byLink.get(linkId)
    return !!s && !s.closed
  }

  /** Close a link's connection now (Disconnect, a new link, the person's sessions ended): the extension forgets its token. */
  drop(linkId: string) {
    const s = this.byLink.get(linkId)
    if (s) this.close(s, ChromeWsClose.revoked, 'link ended')
  }

  dropUser(userId: string) {
    for (const s of [...this.byLink.values()]) if (s.userId === userId) this.close(s, ChromeWsClose.revoked, 'link ended')
  }

  // ---------------- the extension's side ----------------
  /** A new WebSocket from an extension: nothing is sent or taken until its first frame names a live link. */
  attach(conn: RealtimeConn, now: () => number = Date.now, ip = 'unknown'): void {
    let s: LinkSocket | null = null
    let ended = false
    this.waiting.set(ip, (this.waiting.get(ip) ?? 0) + 1)
    let counted = true
    const uncount = () => { if (!counted) return; counted = false; const n = (this.waiting.get(ip) ?? 1) - 1; if (n > 0) this.waiting.set(ip, n); else this.waiting.delete(ip) }
    const timer = setTimeout(() => { if (!s) { ended = true; conn.close(ChromeWsClose.revoked, 'auth expected') } }, CHROME_AUTH_WAIT_MS)
    ;(timer as { unref?: () => void }).unref?.()
    conn.onClose(() => {
      ended = true
      clearTimeout(timer)
      uncount()
      if (s) this.gone(s)
    })
    conn.onMessage((raw) => {
      if (ended) return
      // the first frame is a token and a version: anything larger is not read
      if (!s && raw.length > PREAUTH_MAX_CHARS) { ended = true; conn.close(ChromeWsClose.badRequest, 'bad frame'); return }
      let parsed: ChromeClientFrame
      try {
        const r = ChromeClientFrame.safeParse(JSON.parse(raw))
        if (!r.success) throw new Error('bad frame')
        parsed = r.data
      } catch {
        // one bad frame ends the connection (the extension speaks only this contract)
        ended = true
        conn.close(ChromeWsClose.badRequest, 'bad frame')
        return
      }
      if (!s) {
        if (parsed.type !== 'auth') { ended = true; conn.close(ChromeWsClose.revoked, 'auth expected'); return }
        clearTimeout(timer)
        uncount()
        const link = linkByToken(this.ctx.db, parsed.token, now())
        if (!link) { ended = true; conn.close(ChromeWsClose.revoked, 'unknown link'); return }
        const prev = this.byLink.get(link.id)
        if (prev) this.close(prev, ChromeWsClose.replaced, 'replaced by a newer connection')
        s = { conn, userId: link.user_id, linkId: link.id, windowId: chromeWindowOf(link.id), openedAt: now(), touchedAt: now(), closed: false }
        this.byLink.set(link.id, s)
        try { touchLink(this.ctx.db, link.id, parsed.version ?? null, now()) } catch (e) { this.ctx.log.warn('chrome link touch failed', { err: e }) }
        const u = this.ctx.db.query('SELECT name, username FROM users WHERE id = ?').get(link.user_id) as { name: string | null; username: string } | null
        this.send(s, {
          type: 'hello', linkId: link.id, user: { name: u?.name ?? u?.username ?? '', username: u?.username ?? '' },
          team: { name: getTeamSettings(this.ctx.db).teamName }, teamHosts: teamHosts(this.ctx), pingIntervalMs: PING_INTERVAL_MS, serverTime: now(),
        })
        for (const l of this.windowListeners) try { l(s.userId, s.windowId, 'open') } catch (e) { this.ctx.log.error('chrome window listener failed', { err: e }) }
        return
      }
      const me = s
      switch (parsed.type) {
        case 'auth': return
        case 'ping': {
          if (!this.stillLinked(me)) return
          this.send(me, { type: 'pong', t: parsed.t })
          if (now() - me.touchedAt > TOUCH_EVERY_MS) {
            me.touchedAt = now()
            try { touchLink(this.ctx.db, me.linkId, null, now()) } catch (e) { this.ctx.log.warn('chrome link touch failed', { err: e }) }
          }
          return
        }
        case 'unlink': {
          try { this.unlinkHook(me.userId, me.linkId) } catch (e) { this.ctx.log.warn('chrome unlink failed', { err: e }) }
          this.close(me, ChromeWsClose.revoked, 'unlinked')
          return
        }
        case 'browser.ack':
        case 'browser.result':
          for (const l of this.frameListeners) try { l(me.userId, me.windowId, parsed) } catch (e) { this.ctx.log.error('chrome frame listener failed', { err: e }) }
          return
      }
    })
  }

  private send(s: LinkSocket, f: ChromeServerFrame) {
    if (s.closed) return
    try { s.conn.send(JSON.stringify(f)) } catch { this.gone(s) }
  }

  private close(s: LinkSocket, code: number, reason: string) {
    try { s.conn.close(code, reason) } catch {}
    this.gone(s)
  }

  private gone(s: LinkSocket) {
    if (s.closed) return
    s.closed = true
    if (this.byLink.get(s.linkId) === s) this.byLink.delete(s.linkId)
    for (const l of this.windowListeners) try { l(s.userId, s.windowId, 'closed') } catch (e) { this.ctx.log.error('chrome window listener failed', { err: e }) }
  }

  closeAll() {
    for (const s of [...this.byLink.values()]) this.close(s, 1001, 'server shutting down')
  }
}
