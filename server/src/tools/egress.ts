// The office's public exit address (design tab 7 "내부망 공격", tab 3 web_fetch SSRF). web_fetch runs on the server,
// outside the engine firewall. A public page can link to the address the office's own requests come from (the page
// sees it when we fetch it) and a fetch of that address loops back through the office router: its admin page, a NAS
// or camera with a port forward. The relay tells the server the address each control connection came from
// (AuthOk.seenIp); web_fetch refuses those addresses. While no address is known (no relay, or not connected yet since
// the server started), every web_fetch URL needs the person's confirmation.
import { normIp } from './web-fetch'

/** addresses kept per server (an office's address can change; refusing an old one costs nothing) */
export const MAX_EGRESS_IPS = 8

interface Egress { ips: string[] }
const byCtx = new WeakMap<object, Egress>()

/** `ctx`: the server's AppContext (any object identifying one server instance) */
export function noteEgressIp(ctx: object, ip: string): void {
  const e = byCtx.get(ctx) ?? { ips: [] }
  const n = normIp(ip)
  e.ips = [n, ...e.ips.filter((x) => x !== n)].slice(0, MAX_EGRESS_IPS)
  byCtx.set(ctx, e)
}

/** known = the relay has told us at least one address since this server started */
export function egressOf(ctx: object): { known: boolean; ips: string[] } {
  const e = byCtx.get(ctx)
  return { known: !!e?.ips.length, ips: e?.ips ?? [] }
}
