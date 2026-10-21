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

/** CF-Connecting-IP when it is one valid IP address (IPv4-mapped IPv6 written as IPv4), else null */
export function cfClientIp(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  if (!t || t.length > 64 || net.isIP(t) === 0) return null
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(t)
  return m ? m[1]! : t.toLowerCase()
}

export interface TunnelRequest { req: Request; ip: string }

/**
 * The request as the app should see it when it came through the office public address, else null (handle it as it
 * is). `peer` is the socket peer (already through peerIp), `port` the listener's port.
 */
export function tunnelRequest(cfg: Pick<AppConfig, 'tunnel' | 'listen'>, req: Request, peer: string | null, port: number | null | undefined): TunnelRequest | null {
  const host = cfg.tunnel?.host
  if (!host || port == null || port !== cfg.listen.port || !isLoopback(peer)) return null
  if ((req.headers.get('host') ?? '').toLowerCase() !== host) return null
  const u = new URL(req.url)
  // the body stays a stream (chunked uploads); Bun keeps every header, Host included
  const rewritten = new Request(`https://${host}${u.pathname}${u.search}`, req)
  // without a valid CF-Connecting-IP (only a local program would send that) every such request shares the
  // loopback address's limits instead of getting none
  return { req: rewritten, ip: cfClientIp(req.headers.get('cf-connecting-ip')) ?? peer! }
}

/** Bun.serve's fetch for a direct listener: the socket peer and listener port, the tunnel rewrite (above). */
export function directFetch(
  cfg: Pick<AppConfig, 'tunnel' | 'listen'>,
  fetch: (req: Request, env: { ip: string | null; via: 'direct'; port: number; server: unknown; tunnel?: boolean; upgradeReq?: Request }) => Response | Promise<Response>,
  peerIp: (addr: string | null | undefined) => string | null,
) {
  return (req: Request, server: { requestIP(r: Request): { address: string } | null; port: number | undefined }) => {
    const peer = peerIp(server.requestIP(req)?.address)
    const port = server.port ?? 0
    const t = tunnelRequest(cfg, req, peer, port)
    if (t) return fetch(t.req, { ip: t.ip, via: 'direct', port, server, tunnel: true, upgradeReq: req })
    return fetch(req, { ip: peer, via: 'direct', port, server })
  }
}
