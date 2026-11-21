// Office mode's public address (docs/OFFICE.md "인터넷 주소"): cloudflared on the office Mac (a Cloudflare Tunnel,
// outbound only) delivers https://<config.tunnel.host> to the loopback app port as plain http from 127.0.0.1.
//
// A request is "through the tunnel" only when all of these hold: a public address is configured, it came in on the
// app port (cfg.listen.port, bound to 127.0.0.1), its socket peer is loopback, and its Host header is the public host
// (cloudflared is told to send exactly that, scripts/office/public-address.ts sets originRequest.httpHostHeader).
// Then, and only then:
//   - the request is handled as https://<host><path> (the session cookie is the Secure __Host- one, the CSRF and
//     WebSocket Origin is https://<host>, links point there): Cloudflare ends TLS at its edge;
//   - the client IP (rate limits, audit) is CF-Connecting-IP, which Cloudflare sets on every request it forwards;
//     anywhere else (LAN port, localhost Host, no public address) a client-sent CF-Connecting-IP is ignored.
// The office LAN port and http://localhost on the Mac are unchanged. Every other process on this Mac can reach the
// app port too, so a local program could claim to be the tunnel: it gains nothing (it can use http://localhost, which
// may do more, e.g. the first-run setup) except choosing the IP its sign-in attempts are counted under; the per-account
// limit still applies.
import net from 'node:net'
import type { AppConfig } from '../app-config'

/** 127.0.0.0/8 or ::1 (IPv4-mapped forms are already plain IPv4 here: main.ts peerIp) */
export function isLoopback(ip: string | null | undefined): boolean {
  if (!ip) return false
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) || ip === '::1'
}

/** Did the request come from outside the office: through the office public address (Cloudflare Tunnel) or on the
 * Tailscale listener? Such a request never makes the owner account (first-run setup), gets the signed-out health
 * answer, and its sign-in failures use the internet limits. The relay is outside too; callers check via 'relay'. */
export function fromOutside(info: { tunnel?: boolean; tailnet?: boolean }): boolean {
  return !!(info.tunnel || info.tailnet)
}

/** CF-Connecting-IP when it is one valid IP address (IPv4-mapped IPv6 written as IPv4), else null */
export function cfClientIp(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  if (!t || t.length > 64 || net.isIP(t) === 0) return null
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(t)
  return m ? m[1]! : t.toLowerCase()
}

export interface TunnelRequest { url: string; ip: string }

/**
 * The public URL and client IP of a request that came through the office public address, else null (handle it as it
 * is). `peer` is the socket peer (already through peerIp), `port` the listener's port. No Request is built here:
 * see withPublicUrl.
 */
export function tunnelRequest(cfg: Pick<AppConfig, 'tunnel' | 'listen'>, req: Request, peer: string | null, port: number | null | undefined): TunnelRequest | null {
  const host = cfg.tunnel?.host
  if (!host || port == null || port !== cfg.listen.port || !isLoopback(peer)) return null
  if ((req.headers.get('host') ?? '').toLowerCase() !== host) return null
  const u = new URL(req.url)
  // without a valid CF-Connecting-IP (only a local program would send that) every such request shares the
  // loopback address's limits instead of getting none
  return { url: `https://${host}${u.pathname}${u.search}`, ip: cfClientIp(req.headers.get('cf-connecting-ip')) ?? peer! }
}

let wrapWarned = false

/**
 * The request Bun.serve handed over, with `url` reading the public https URL (an own property over Request's getter,
 * fixed once set). Every reader of the URL (Hono's routing and c.req.url, the cookie name, CSRF and WebSocket Origin
 * checks, links, redirects) then sees https://<host>/... as before, and the body stays Bun's own.
 * Never `new Request(url, req)`: under Bun 1.3.12 the copy's body is a JavaScript stream in which every socket read
 * becomes its own buffer that garbage collection does not count. cloudflared forwards a chunked upload in small pieces,
 * so a 3 MB upload kept about 550 MB, and a few 100 MB uploads took a 4 GB server down
 * (docs/decisions/20261116-tunnel-request-body-memory.md). Only if a Bun ever refuses the property does the copy come
 * back (correct, but memory-heavy), with a warning.
 */
export function withPublicUrl(req: Request, url: string): Request {
  try { Object.defineProperty(req, 'url', { value: url, enumerable: true, writable: false, configurable: false }) } catch { /* checked below */ }
  if (req.url === url) return req
  if (!wrapWarned) {
    wrapWarned = true
    process.emitWarning('this Bun does not let a request carry its public URL; requests through the public address are copied (more memory per upload)')
  }
  return new Request(url, req)
}

/** Requests refused before their body was read to its end (http/route.ts): their connection ends with the answer. */
const endAfterAnswer = new WeakSet<Request>()

/**
 * End this request's connection soon after its answer. Bun 1.3.12 ignores `Connection: close` on a response: it keeps
 * the socket, reads and throws away whatever the client still sends (measured: 227 MB in 8 s after a 413) and then
 * serves the next request on it. directFetch asks Bun to time the socket out instead (server.timeout(req, 1): closed
 * about 4 s after the answer on 1.3.12). Only for short error answers: the timeout also cuts a response still being
 * sent.
 */
export function endConnectionAfter(req: Request): void { endAfterAnswer.add(req) }

type DirectEnv = { ip: string | null; via: 'direct'; port: number; server: unknown; tunnel?: boolean; tailnet?: boolean; upgradeReq?: Request }
type DirectServer = { requestIP(r: Request): { address: string } | null; port: number | undefined; timeout?(r: Request, seconds: number): void }

/** Bun.serve's fetch for a direct listener: the socket peer and listener port, the tunnel URL (above), and the end of
 * the connection after an early refusal (endConnectionAfter).
 * `o.tailnet`: this is the office Tailscale listener (main.ts): every request on it is marked tailnet, none is a
 * tunnel request (the tunnel arrives on the loopback app port only). */
export function directFetch(
  cfg: Pick<AppConfig, 'tunnel' | 'listen'>,
  fetch: (req: Request, env: DirectEnv) => Response | Promise<Response>,
  peerIp: (addr: string | null | undefined) => string | null,
  o: { tailnet?: boolean } = {},
) {
  return async (req: Request, server: DirectServer): Promise<Response> => {
    const peer = peerIp(server.requestIP(req)?.address)
    const port = server.port ?? 0
    let seen = req
    let res: Response
    if (o.tailnet) res = await fetch(req, { ip: peer, via: 'direct', port, server, tailnet: true })
    else {
      const t = tunnelRequest(cfg, req, peer, port)
      if (t) {
        seen = withPublicUrl(req, t.url)
        // Bun upgrades only the object it handed over: the copy (fallback only) names it
        res = await fetch(seen, { ip: t.ip, via: 'direct', port, server, tunnel: true, ...(seen !== req ? { upgradeReq: req } : {}) })
      } else res = await fetch(req, { ip: peer, via: 'direct', port, server })
    }
    if (endAfterAnswer.has(seen) || endAfterAnswer.has(req)) server.timeout?.(req, 1)
    return res
  }
}
