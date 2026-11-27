// The desktop app's return address for a sign-in's one-time code (docs/decisions/20261127-desktop-sign-in-code-loopback.md).
// A sign-in the app starts (Google Drive, a Google app, an app connection, Slack) finishes in the system browser, which
// has no session of the app; the team server then holds the result for the app on this computer and gives its page a
// one-time code (server/src/integrations/google-drive/app-return.ts). That page used to hand the code over only through
// the app link `<scheme>://open?url=<team>/#code=…`, and a browser that opens no apps (ego lite: ERR_UNKNOWN_URL_SCHEME)
// lost it: the app waited until its 5-minute limit. Now the page sends the browser here, to
// `http://127.0.0.1:<port>/sign-in-code?code=<code>` (RFC 8252 section 7.3: how a browser reaches an app on the
// computer), and the app redeems the code with its own session, as it does one from the app link.
//
// The page knows the port because the team page tells its server on every API call (APP_RETURN_HEADER); the server
// keeps it for that desktop session only.
//
// Rules (shared with the other return addresses, ./loopback.ts): 127.0.0.1 only, a port the system picks, open while the
// app runs; only `GET /sign-in-code?code=<43 base64url characters>` from its own Host as a page the browser opens. A
// code is handed on once (a reload of the page does nothing more); anything else gets 404 and hands nothing on. A
// program on this computer that finds the port can only hand on codes it already has: the server redeems a code only
// for the session that started the sign-in, exactly as with the app link that any program here can open too.
// Pure apart from node:http: unit-tested in tests/unit/e-desktop-code-return.test.ts.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { APP_CODE_RETURN_PATH } from '@mycel/shared/desktop-bridge'
import { closeLoopback, DONE_PAGE_HEADERS, donePage, listenLoopback, ownPageLoad } from './loopback'

const CODE = /^[A-Za-z0-9_-]{43}$/
/** codes remembered as handed on (a reload never hands one on twice) */
const SEEN_MAX = 64
/** at most this many codes handed on a minute (a sign-in is one; a flood is no person) */
const PER_MINUTE = 20

/** The code of `GET /sign-in-code?code=…`: exactly that path and one `code` of the token's shape; null otherwise. */
export function returnedCode(url: string | undefined): string | null {
  if (!url) return null
  const q = url.indexOf('?')
  if (q < 0 || url.slice(0, q) !== APP_CODE_RETURN_PATH) return null
  const p = new URLSearchParams(url.slice(q + 1))
  const all = p.getAll('code')
  if (all.length !== 1 || [...p.keys()].length !== 1) return null
  return CODE.test(all[0]!) ? all[0]! : null
}

export class CodeReturn {
  private cur: { server: Server; port: number } | null = null
  private opening: Promise<number | null> | null = null
  private readonly seen: string[] = []
  private handed: number[] = []
  /** `deliver`: hand the code to the team on screen (main/app-window.ts claimReturnedCode); true when there was a team
   * page to take it. `page`: the words the browser shows then ("Back in the app…"), in the app's language. */
  constructor(private readonly o: { deliver: (code: string) => boolean; page: () => string; now?: () => number }) {}

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

  close() {
    const c = this.cur
    this.cur = null
    if (c) closeLoopback(c.server)
  }

  private answer(port: number, req: IncomingMessage, res: ServerResponse) {
    const code = ownPageLoad(req, port) ? returnedCode(req.url) : null
    const now = (this.o.now ?? Date.now)()
    this.handed = this.handed.filter((t) => now - t < 60_000)
    if (code === null || this.seen.includes(code) || this.handed.length >= PER_MINUTE || !this.o.deliver(code)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
      res.end('Not found')
      return
    }
    this.seen.push(code)
    if (this.seen.length > SEEN_MAX) this.seen.shift()
    this.handed.push(now)
    const body = donePage(this.o.page())
    res.writeHead(200, { ...DONE_PAGE_HEADERS, 'Content-Length': String(Buffer.byteLength(body)) })
    res.end(body)
  }
}
