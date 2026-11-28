// The desktop app's return address for a sign-in's one-time code (docs/decisions/20261127-desktop-sign-in-code-loopback.md).
// A sign-in the app starts (Google Drive, a Google app, an app connection, Slack) finishes in the system browser, which
// has no session of the app; the team server then holds the result for the app on this computer and gives its page a
// one-time code (server/src/integrations/google-drive/app-return.ts). That page used to hand the code over only through
// the app link `<scheme>://open?url=<team>/#code=…`, and a browser that opens no apps (ego lite: ERR_UNKNOWN_URL_SCHEME)
// lost it: the app waited until its 5-minute limit. Now the page sends the browser here, to
// `http://127.0.0.1:<port>/sign-in-code?code=<code>&team=<team>` (RFC 8252 section 7.3: how a browser reaches an app on the
// computer), and the app redeems the code with its own session, as it does one from the app link.
//
// The page knows the port because the team page tells its server on every API call (APP_RETURN_HEADER); the server
// keeps it for that session only (a phone app's never).
//
// Rules (shared with the other return addresses, ./loopback.ts): 127.0.0.1 only, a port the system picks, open while the
// app runs; only `GET /sign-in-code?code=<43 base64url characters>` from its own Host as a page the browser opens. A
// code is handed on once (a reload of the page does nothing more); anything else gets 404 and hands nothing on. A
// program on this computer that finds the port can only hand on codes it already has: the server redeems a code only
// for the session that started the sign-in, exactly as with the app link that any program here can open too.
//
// The app's key (docs/decisions/20261128-held-sign-in-app-key.md): a random secret for this run of the app, one per team
// (an HMAC of the team's origin, so no team server learns another's). The page sends its sha256 (key()) with every API
// call; the server seals it into a result it holds for this app's code, and the claim must carry the secret itself
// (proof(), sent only by the main process: the page and whoever got the code or the sign-in link never have it). A
// copied sign-in link opened by someone else ends, at most, in a held result no one but this app can redeem.
// Pure apart from node:http and node:crypto: unit-tested in tests/unit/c-sign-in-code-loopback.test.ts.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { APP_CODE_RETURN_PATH } from '@mycel/shared/desktop-bridge'
import { closeLoopback, DONE_PAGE_HEADERS, donePage, listenLoopback, ownPageLoad } from './loopback'

const CODE = /^[A-Za-z0-9_-]{43}$/
/** codes remembered as handed on (a reload never hands one on twice) */
const SEEN_MAX = 64
/** at most this many codes handed on a minute (a sign-in is one; a flood is no person) */
const PER_MINUTE = 20

/** The code and team of `GET /sign-in-code?code=…&team=<team origin>`: exactly that path, one `code` of the token's
 * shape and one `team` that is an http(s) origin; null otherwise. */
export function returnedCode(url: string | undefined): { code: string; team: string } | null {
  if (!url) return null
  const q = url.indexOf('?')
  if (q < 0 || url.slice(0, q) !== APP_CODE_RETURN_PATH) return null
  const p = new URLSearchParams(url.slice(q + 1))
  const code = p.getAll('code'), team = p.getAll('team')
  if (code.length !== 1 || team.length !== 1 || [...new Set(p.keys())].length !== 2 || !CODE.test(code[0]!)) return null
  let origin: string
  try { origin = new URL(team[0]!).origin } catch { return null }
  // exactly an origin; the app compares it with the team on screen (an office team may be http on its own network)
  return origin === team[0] && /^https?:\/\//.test(origin) ? { code: code[0]!, team: origin } : null
}

export class CodeReturn {
  private cur: { server: Server; port: number } | null = null
  private opening: Promise<number | null> | null = null
  private readonly seen: string[] = []
  private handed: number[] = []
  /** this run's secret: never written anywhere, never sent but as a team's proof on that team's claim */
  private readonly secret = randomBytes(32)
  /** `deliver`: hand the code to `team` when that team is on screen (main/app-window.ts claimReturnedCode); true when it
   * was. `page`: the words the browser shows then ("Back in the app…"), in the app's language. */
  constructor(private readonly o: { deliver: (code: string, team: string) => boolean; page: () => string; now?: () => number }) {}

  /** The port, opening the address the first time (and again after it was closed); null when none can be opened. */
  port(): Promise<number | null> {
    if (this.cur) return Promise.resolve(this.cur.port)
    if (!this.opening) {
      this.opening = listenLoopback().then((l) => {
        this.opening = null
        if (!l) return null
        l.server.on('request', (req, res) => this.answer(l.port, req, res))
        this.cur = l
        return l.port
      })
    }
    return this.opening
  }

  /** The secret for `team` (an http(s) origin): 43 base64url characters, sent only on that team's claim
   * (APP_RETURN_PROOF_HEADER). null for anything that is not an origin. */
  proof(team: string): string | null {
    let origin: string
    try { origin = new URL(team).origin } catch { return null }
    if (origin !== team || !/^https?:\/\//.test(origin)) return null
    return createHmac('sha256', this.secret).update(`sign-in-code:${origin}`).digest('base64url')
  }

  /** What the page of `team` sends with its calls (APP_RETURN_KEY_HEADER): the proof's sha256 in hex; null as proof(). */
  key(team: string): string | null {
    const p = this.proof(team)
    return p ? createHash('sha256').update(p).digest('hex') : null
  }

  close() {
    const c = this.cur
    this.cur = null
    if (c) closeLoopback(c.server)
  }

  private answer(port: number, req: IncomingMessage, res: ServerResponse) {
    const r = ownPageLoad(req, port) ? returnedCode(req.url) : null
    const now = (this.o.now ?? Date.now)()
    this.handed = this.handed.filter((t) => now - t < 60_000)
    // another team on screen: nothing handed on and nothing remembered (back on that team, a reload hands it on)
    if (r === null || this.seen.includes(r.code) || this.handed.length >= PER_MINUTE || !this.o.deliver(r.code, r.team)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
      res.end('Not found')
      return
    }
    const code = r.code
    this.seen.push(code)
    if (this.seen.length > SEEN_MAX) this.seen.shift()
    this.handed.push(now)
    const body = donePage(this.o.page())
    res.writeHead(200, { ...DONE_PAGE_HEADERS, 'Content-Length': String(Buffer.byteLength(body)) })
    res.end(body)
  }
}
