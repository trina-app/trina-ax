// The hosting console's return to the desktop app after the person signed in there (RFC 8252: the system browser, a
// loopback redirect, PKCE S256; docs/decisions/20261126-desktop-create-team.md). The contract is
// shared/src/cloud-protocol/owner-claim.ts: the console sends the browser to
// `http://127.0.0.1:<port>/console-callback?code&state` (or `?error&state`).
//
// A listener of its own, never the connector sign-in's (./sign-in-return.ts, which forwards to the team and keeps one
// listener at a time): opening or closing this one never closes that one, and the other way round. Rules (./loopback.ts
// and here): 127.0.0.1 only, a port the system picks; only `GET /console-callback` from its own Host as a page load,
// with exactly `state` and `code` (or `error`) once each; the state compared in constant time. The code is read here
// and handed to the caller, never forwarded anywhere. Anything else is 404 and does not use it up. It closes after one
// good answer, after APP_CONNECT_TTL_MS, or when the caller closes it. Pure apart from node:http and node:crypto:
// unit-tested in tests/unit/e-desktop-console-return.test.ts.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { APP_CALLBACK_PATH, APP_CONNECT_ERRORS, APP_CONNECT_TTL_MS, type AppConnectError } from '@mycel/shared/cloud-protocol/owner-claim'
import { closeLoopback, listenLoopback, ownPageLoad } from './loopback'

const B64URL43 = /^[A-Za-z0-9_-]{43}$/
const MAX_QUERY = 4096

/** 32 random bytes in base64url (43 characters): a `state` */
export const newState = (): string => randomBytes(32).toString('base64url')

/** A PKCE pair (RFC 7636, S256): the verifier stays in the app, the challenge goes in the connect address. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: pkceChallenge(verifier) }
}
export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier, 'ascii').digest('base64url')

/** two states, compared in constant time (a different length is a mismatch at once: the length is no secret) */
export function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** What the console's return said: the one-time code, or why there is none. `timeout`: nothing came in time;
 * `closed`: the app closed the listener (Cancel). */
export type ConsoleAnswer = { code: string } | { error: AppConnectError | 'timeout' | 'closed' }

/** The query of `GET /console-callback?…` read strictly: exactly `state` and one of `code` (43 base64url) or `error`
 * (one the contract names), each once; null otherwise. */
export function callbackQuery(url: string | undefined): { state: string; code: string } | { state: string; error: AppConnectError } | null {
  if (!url) return null
  const q = url.indexOf('?')
  const path = q < 0 ? url : url.slice(0, q)
  const query = q < 0 ? '' : url.slice(q + 1)
  if (path !== APP_CALLBACK_PATH || !query || query.length > MAX_QUERY || !/^[\x21-\x7e]+$/.test(query)) return null
  const p = new URLSearchParams(query)
  const keys = [...p.keys()]
  if (new Set(keys).size !== keys.length || keys.length !== 2 || !keys.includes('state')) return null
  const state = p.get('state') ?? ''
  if (!B64URL43.test(state)) return null
  const code = p.get('code'), error = p.get('error')
  if (code !== null) return B64URL43.test(code) ? { state, code } : null
  if (error !== null) return (APP_CONNECT_ERRORS as readonly string[]).includes(error) ? { state, error: error as AppConnectError } : null
  return null
}

/** the small page the browser shows after the return: the words come from the app (its language) */
function donePage(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;min-height:90vh;align-items:center;justify-content:center;color:#14110f;background:#fcfbf8}@media (prefers-color-scheme:dark){body{color:#f2ede6;background:#171411}}</style></head><body><p>${esc}</p></body></html>`
}

interface Open { server: Server; port: number; state: string; timer: ReturnType<typeof setTimeout>; used: boolean; settle: (a: ConsoleAnswer) => void }

export class ConsoleReturn {
  private cur: Open | null = null
  /** counts opens and closes: an open that finds it moved on after its listen closes its own */
  private generation = 0
  /** `page`: the words of the page the browser shows after a good return ("You can close this tab.") */
  constructor(private readonly o: { page: () => string; timeoutMs?: number }) {}

  get port(): number | null {
    return this.cur?.port ?? null
  }

  /** A new return address for the sign-in that starts now, waiting for this `state`. An older one of this listener
   * closes (its answer is `closed`). null when none can be opened. */
  async open(state: string): Promise<{ port: number; answer: Promise<ConsoleAnswer> } | null> {
    this.close()
    const gen = this.generation
    if (!B64URL43.test(state)) return null
    const l = await listenLoopback()
    if (!l) return null
    // another open (or a close) came while this one listened: that one is the one
    if (gen !== this.generation) {
      closeLoopback(l.server)
      return null
    }
    let settle!: (a: ConsoleAnswer) => void
    const answer = new Promise<ConsoleAnswer>((r) => (settle = r))
    const timer = setTimeout(() => this.finish(open, { error: 'timeout' }), this.o.timeoutMs ?? APP_CONNECT_TTL_MS)
    timer.unref?.()
    const open: Open = { server: l.server, port: l.port, state, timer, used: false, settle }
    l.server.on('request', (req, res) => this.answer(open, req, res))
    this.cur = open
    return { port: l.port, answer }
  }

  /** Close this listener (its answer is `closed`); never any other. */
  close() {
    this.generation++
    if (this.cur) this.finish(this.cur, { error: 'closed' })
  }

  private finish(c: Open, a: ConsoleAnswer) {
    if (this.cur === c) this.cur = null
    clearTimeout(c.timer)
    closeLoopback(c.server)
    c.settle(a)
  }

  private answer(c: Open, req: IncomingMessage, res: ServerResponse) {
    const q = ownPageLoad(req, c.port) ? callbackQuery(req.url) : null
    if (q === null || c.used || this.cur !== c || !sameState(q.state, c.state)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
      res.end('Not found')
      return
    }
    c.used = true
    const body = donePage(this.o.page())
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close',
    })
    res.end(body, () => this.finish(c, 'code' in q ? { code: q.code } : { error: q.error }))
  }
}
