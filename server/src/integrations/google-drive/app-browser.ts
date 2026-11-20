// A Google Drive sign-in started in the desktop app finishes in the system browser, which has no session of the app
// (QA 2026-11-20: the browser landed on "This browser is not signed in to <app>" and the app waited forever). The
// return (callback) still needs proof that the browser is the person's own, or a leaked sign-in address would let its
// creator take somebody else's Google consent (oauth.ts callback). This is that proof for the desktop app:
//
//  1. The app's own session starts the flow (begin). The answer carries `openPath`, a one-time address on this server
//     with a ticket (32 random bytes; only its hash is kept, in memory) that the app opens in the system browser at once.
//  2. That address (GET OPEN_PATH, routes/drive.ts) checks the ticket (once, within TICKET_MS, the flow still waiting),
//     gives the browser a cookie with a new random value (only its hash kept), limited to the return path, HttpOnly,
//     SameSite=Lax, and sends it on to the sign-in page the flow made (the hosting service's page or Google's).
//  3. Google's return to this server (through the hosting service) brings the cookie back: the browser that the app
//     opened finishes the flow, without a session. A browser signed in as the same person still finishes it as before.
//
// What it does not open: the ticket is never shown, works once and only for TICKET_MS (the app opens it within a
// second), so a forwarded address is dead by the time someone else could open it; the cookie names one flow and goes
// only to the return path of this server; the person still confirms the Google account in the app (complete), and the
// flow keeps every other check (pending, its session alive, PKCE, the hosting service's handoff). Kept in memory: a
// restart forgets it, and the return then asks for a signed-in browser as before (the app says Try again).
//
// Which app started a flow is kept too (`client`), so the return page tells a person in an app to go back to it
// instead of sending them on to the web app (callback-page.ts).
import crypto from 'node:crypto'

/** where the app sends the system browser first (routes/drive.ts) */
export const OPEN_PATH = '/api/integrations/google-drive/open'
/** the cookie that names the flow this browser was handed (only on the return path) */
export const BIND_COOKIE = 'mycel_drive_signin'
/** the app opens the address within a second; nobody else gets it in time */
export const TICKET_MS = 2 * 60_000
/** the flow's own lifetime (oauth.ts TTL): nothing is kept longer */
const KEEP_MS = 10 * 60_000

export type AppClient = 'desktop' | 'mobile'
interface Entry { client: AppClient; ticketHash: string | null; ticketUntil: number; url: string | null; bindHash: string | null; until: number }

const sha = (s: string) => crypto.createHash('sha256').update(s).digest()
const same = (a: Buffer, hex: string) => { const b = Buffer.from(hex, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b) }
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export class AppSignIns {
  private m = new Map<string, Entry>()
  constructor(private readonly now: () => number = Date.now) {}

  /** A flow started from an app's session. The desktop app gets a ticket for OPEN_PATH (it can open an address on this
   * server in the system browser); the phone app does not (its browser hand-off takes Google's address only). `url`:
   * where the browser goes after OPEN_PATH. Returns the ticket, or null. */
  start(flowId: string, client: AppClient, url: string): string | null {
    this.sweep()
    const ticket = client === 'desktop' ? crypto.randomBytes(32).toString('base64url') : null
    const now = this.now()
    this.m.set(flowId, { client, ticketHash: ticket ? sha(ticket).toString('hex') : null, ticketUntil: now + TICKET_MS, url: ticket ? url : null, bindHash: null, until: now + KEEP_MS })
    return ticket
  }

  /** OPEN_PATH: the ticket of this flow, once, in time. Returns where to send the browser and the cookie's value. */
  open(flowId: string, ticket: string | undefined): { url: string; bind: string } | null {
    this.sweep()
    const e = this.m.get(flowId)
    if (!e || !e.ticketHash || !e.url || !ticket || !TOKEN.test(ticket) || this.now() > e.ticketUntil || !same(sha(ticket), e.ticketHash)) return null
    const bind = crypto.randomBytes(32).toString('base64url'), url = e.url
    e.ticketHash = null; e.url = null; e.bindHash = sha(bind).toString('hex')
    return { url, bind }
  }

  /** The browser at the return carries the cookie this flow's OPEN_PATH gave. */
  bound(flowId: string, bind: string | undefined): boolean {
    const e = this.m.get(flowId)
    return !!e?.bindHash && !!bind && TOKEN.test(bind) && this.now() <= e.until && same(sha(bind), e.bindHash)
  }

  /** the app that started this flow, or null (a browser, or forgotten) */
  client(flowId: string): AppClient | null {
    const e = this.m.get(flowId)
    return e && this.now() <= e.until ? e.client : null
  }

  end(flowId: string) { this.m.delete(flowId) }

  private sweep() {
    const now = this.now()
    for (const [k, e] of this.m) if (now > e.until) this.m.delete(k)
  }
}

/** The value of one cookie in a Cookie header, or undefined. */
export function cookieValue(header: string | undefined | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

/** The Set-Cookie value for the browser the app handed a flow (`value` empty and maxAge 0: gone). Only on the return
 * path of this server; Secure on https (a hosted team always is). */
export function bindCookie(reqUrl: string, callbackPath: string, value: string, maxAgeSec: number): string {
  const secure = reqUrl.startsWith('https:')
  return `${BIND_COOKIE}=${value}; Path=${callbackPath}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`
}
