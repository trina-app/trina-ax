// The one-time return address of a connector sign-in from the desktop app (RFC 8252 section 7.3: how an app on a
// computer signs in). Some services take only such an address, never the team's https one (Canva, Intercom, Square:
// server/src/integrations/connections/oauth.ts loopbackClient). The team page asks for one (DesktopBridge.signInReturn)
// just before it starts the sign-in; the service sends the person's browser to http://127.0.0.1:<port>/callback?…, and
// this sends the browser straight on to the team's own return page with the same query, where the server finishes the
// sign-in as for any other (the code is never read or kept here).
//
// Rules: bound to 127.0.0.1 only, on a port the system picks; one at a time (a new one closes the old one, also when
// two opens overlap); exactly one GET to /callback with a state and a code or an error (a service's answer), from the
// address it was asked at (Host 127.0.0.1:<port>), as a page the browser opens (Sec-Fetch-Mode navigate and
// Sec-Fetch-Dest document when the browser sends them: never a fetch, an image or a frame of another page), uses it up,
// then it closes. Anything else gets 404 and does not use it up, however many there are, so a page or program on this
// computer cannot spend it. It closes after SIGN_IN_RETURN_MS unused, and when the page closes it. It goes only to the team's https origin it was
// opened for, and only while that is still the team the window shows (`current`), never to an address from the request.
// The loopback checks are shared with the console's return (./loopback.ts); each has its own server and port.
// Pure apart from node:http: unit-tested in tests/unit/e-desktop-sign-in-return.test.ts.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { closeLoopback, listenLoopback, ownPageLoad } from './loopback'

export { navigation } from './loopback'

export const SIGN_IN_RETURN_PATH = '/callback'
/** the server's sign-in lifetime (server/src/integrations/connections/service.ts FLOW_TTL) */
export const SIGN_IN_RETURN_MS = 10 * 60_000
/** where the team's server finishes a connector sign-in (oauth.ts CALLBACK_PATH) */
export const TEAM_CALLBACK_PATH = '/api/integrations/oauth/callback'
/** a query longer than this is no service's answer */
const MAX_QUERY = 8192

/** The https origin a return may go to (the team's address as the app stores it), or null: plain http, a user name or
 * password, or anything that is not just an origin. */
export function returnOrigin(teamOrigin: string | null | undefined): string | null {
  if (!teamOrigin) return null
  try {
    const u = new URL(teamOrigin)
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null
    return teamOrigin.replace(/\/$/, '') === u.origin ? u.origin : null
  } catch {
    return null
  }
}

/** The query of `GET /callback?…` when it is the return: the exact path, a state with a code or an error (what a
 * service sends back, RFC 6749 section 4.1.2), printable ASCII only (a header value may carry nothing else) and not too
 * long; null otherwise. */
export function returnQuery(url: string | undefined): string | null {
  if (!url) return null
  const q = url.indexOf('?')
  const path = q < 0 ? url : url.slice(0, q)
  const query = q < 0 ? '' : url.slice(q + 1)
  if (path !== SIGN_IN_RETURN_PATH || !query || query.length > MAX_QUERY || !/^[\x21-\x7e]+$/.test(query)) return null
  const p = new URLSearchParams(query)
  if (!p.get('state') || !(p.get('code') || p.get('error'))) return null
  return query
}

interface Open { server: Server; port: number; origin: string; timer: ReturnType<typeof setTimeout>; used: boolean }

export class SignInReturn {
  private cur: Open | null = null
  /** counts opens and closes: an open that finds it moved on after its listen (a newer open, a close) closes its own */
  private generation = 0
  /** `current`: the team origin the window shows now (a switch to another team stops a return opened for this one) */
  constructor(private readonly o: { current: () => string | null | undefined; timeoutMs?: number }) {}

  /** the port of the open return address, or null */
  get port(): number | null {
    return this.cur?.port ?? null
  }

  /** A new return address for the sign-in that starts now, for the team at `teamOrigin` (it must be the one the window
   * shows, on https). Any older one closes. Resolves to its port, or null when none can be opened. */
  async open(teamOrigin: string | null | undefined): Promise<number | null> {
    this.close()
    const gen = this.generation
    const origin = returnOrigin(teamOrigin)
    if (!origin || returnOrigin(this.o.current()) !== origin) return null
    const l = await listenLoopback()
    if (!l) return null
    const { server, port } = l
    // another open (or a close) came while this one listened: that one is the only one
    if (gen !== this.generation) {
      closeLoopback(server)
      return null
    }
    const timer = setTimeout(() => this.close(port), this.o.timeoutMs ?? SIGN_IN_RETURN_MS)
    timer.unref?.()
    const open: Open = { server, port, origin, timer, used: false }
    server.on('request', (req, res) => this.answer(open, req, res))
    this.cur = open
    return port
  }

  /** Close the return address (`port`: only when it is still that one). Nothing open: nothing happens. */
  close(port?: number) {
    const c = this.cur
    if (port === undefined) this.generation++
    if (!c || (port !== undefined && c.port !== port)) return
    this.cur = null
    clearTimeout(c.timer)
    closeLoopback(c.server)
  }

  private answer(c: Open, req: IncomingMessage, res: ServerResponse) {
    const query = ownPageLoad(req, c.port) ? returnQuery(req.url) : null
    // only the return, once, while this is the open one and its team is still the window's
    if (query === null || c.used || this.cur !== c || returnOrigin(this.o.current()) !== c.origin) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
      res.end('Not found')
      // the window shows another team now: this one is over
      if (this.cur === c && returnOrigin(this.o.current()) !== c.origin) this.close(c.port)
      return
    }
    c.used = true
    res.writeHead(302, {
      Location: `${c.origin}${TEAM_CALLBACK_PATH}?${query}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Length': '0',
      Connection: 'close',
    })
    res.end(() => this.close(c.port))
  }
}
