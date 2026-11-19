// The demo's offline fence (docs/decisions/20261119-demo-fakes.md): while a demo server has its fakes on
// (demo/fakes/index.ts), nothing in this server process reaches beyond this computer. A call a fake does not answer is
// refused before any name lookup and before any socket opens.
//
// Two layers:
//   1. the seams that make outside calls on purpose check demoOffline() first and say so in their own words
//      (connections/net.ts, tools/web-fetch.ts resolveTarget, tools/download.ts, slack/api.ts, proxy/connect.ts);
//   2. a process-wide backstop for everything else (installOfflineGuard): global fetch and WebSocket, node:dns and
//      node:dns/promises, net.connect / createConnection, tls.connect, http(s).request / get. Loopback addresses
//      (127.0.0.0/8, ::1, localhost) and unix sockets still work: the model proxy, the gate and the app's own listeners
//      are on this computer.
// The engine runs in another process and is not covered here; the host's egress rules cover it.
// A leaf module: nothing of the server imports from here except this fence.
import dns from 'node:dns'
import dnsp from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

/** what a refused call says (the AI and the logs see it; never a host or a secret beyond the name asked for) */
export const DEMO_OFFLINE_TEXT = 'Not available in the demo'

export class DemoOffline extends Error {
  name = 'DemoOffline'
  code = 'EDEMOOFFLINE'
  constructor(what?: string) { super(what ? `${DEMO_OFFLINE_TEXT} (${what.slice(0, 200)})` : DEMO_OFFLINE_TEXT) }
}

let on = false
/** true while a demo server's fakes are on: every outside call not answered by a fake is refused */
export const demoOffline = () => on

/** loopback: 127.0.0.0/8, ::1, ::ffff:127.x, localhost (and its subdomains, RFC 6761) */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  const v4 = h.startsWith('::ffff:') ? h.slice(7) : h
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

/** may this address be reached in demo mode: loopback http(s)/ws(s), or something that never leaves (data:, blob:, file:) */
function urlAllowed(raw: string): boolean {
  let u: URL
  try { u = new URL(raw) } catch { return true } // not an address: the original call fails on it by itself
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'file:') return true
  return isLoopbackHost(u.hostname)
}

const urlOfInput = (input: unknown): string => typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url ?? '')

/** a socket that fails at once with the refusal (what net.connect hands back for an address it cannot reach) */
function refusedSocket(what: string): net.Socket {
  const s = new net.Socket()
  process.nextTick(() => s.destroy(new DemoOffline(what)))
  return s
}

/** where a net.connect / tls.connect call goes: a unix path (allowed), or a host */
function connectTarget(args: unknown[]): { path: true } | { host: string } {
  const [a, b] = args
  if (a && typeof a === 'object') {
    const o = a as { path?: unknown; host?: unknown; hostname?: unknown }
    if (typeof o.path === 'string') return { path: true }
    return { host: String(o.host ?? o.hostname ?? 'localhost') }
  }
  if (typeof a === 'string' && !/^\d+$/.test(a)) return { path: true }
  return { host: typeof b === 'string' ? b : 'localhost' }
}

/** where an http(s).request call goes */
function requestHost(args: unknown[]): string | null {
  const [a, b] = args
  if (typeof a === 'string' || a instanceof URL) {
    try { return new URL(String(a)).hostname } catch { return null }
  }
  const o = (a && typeof a === 'object' ? a : b && typeof b === 'object' ? b : {}) as { socketPath?: unknown; hostname?: unknown; host?: unknown }
  if (typeof o.socketPath === 'string') return null
  return String(o.hostname ?? o.host ?? 'localhost')
}

const DNS_NAMES = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt', 'reverse'] as const
type Patch = { obj: Record<string, unknown>; key: string; orig: unknown }

/**
 * Turn the fence on (`demoOffline()` is true) and put the backstop in place. Returns the function that takes both away
 * again (a demo server's close; tests). Calling it twice keeps one fence.
 */
export function installOfflineGuard(): () => void {
  if (on) return () => {}
  on = true
  const patches: Patch[] = []
  const put = (obj: object, key: string, value: unknown) => {
    const o = obj as Record<string, unknown>
    patches.push({ obj: o, key, orig: o[key] })
    o[key] = value
  }

  const origFetch = globalThis.fetch
  const guardedFetch = Object.assign((input: unknown, init?: RequestInit & { unix?: string }) => {
    if (init?.unix || urlAllowed(urlOfInput(input))) return origFetch(input as Request, init)
    let host = ''
    try { host = new URL(urlOfInput(input)).host } catch {}
    return Promise.reject(new DemoOffline(host))
  }, origFetch)
  put(globalThis, 'fetch', guardedFetch)

  const OrigWS = globalThis.WebSocket
  if (OrigWS) {
    put(globalThis, 'WebSocket', new Proxy(OrigWS, {
      construct(target, args, newTarget) {
        if (!urlAllowed(String(args[0]))) throw new DemoOffline(String(args[0]).replace(/[?#].*$/, ''))
        return Reflect.construct(target, args, newTarget)
      },
    }))
  }

  // a name lookup of anything but this computer's own names fails before it is sent
  for (const name of DNS_NAMES) {
    const p = (dnsp as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>)[name]
    if (typeof p === 'function') put(dnsp, name, (host: unknown, ...rest: unknown[]) =>
      typeof host === 'string' && (isLoopbackHost(host) || net.isIP(host)) && name === 'lookup' ? p.call(dnsp, host, ...rest) : Promise.reject(new DemoOffline(String(host))))
    const c = (dns as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[name]
    if (typeof c === 'function') put(dns, name, (host: unknown, ...rest: unknown[]) => {
      if (typeof host === 'string' && (isLoopbackHost(host) || net.isIP(host)) && name === 'lookup') return c.call(dns, host, ...rest)
      const cb = rest.reverse().find((x) => typeof x === 'function') as ((e: Error) => void) | undefined
      if (cb) process.nextTick(() => cb(new DemoOffline(String(host))))
      return undefined
    })
  }
  for (const key of ['connect', 'createConnection'] as const) {
    const orig = (net as unknown as Record<string, (...a: unknown[]) => net.Socket>)[key]!
    put(net, key, (...args: unknown[]) => {
      const t = connectTarget(args)
      if ('path' in t || isLoopbackHost(t.host)) return orig.apply(net, args)
      return refusedSocket(t.host)
    })
  }
  const tlsConnect = tls.connect as unknown as (...a: unknown[]) => tls.TLSSocket
  put(tls, 'connect', (...args: unknown[]) => {
    const t = connectTarget(args)
    if ('path' in t || isLoopbackHost(t.host)) return tlsConnect.apply(tls, args)
    return refusedSocket(t.host)
  })
  for (const mod of [http, https]) {
    for (const key of ['request', 'get'] as const) {
      const orig = (mod as unknown as Record<string, (...a: unknown[]) => unknown>)[key]!
      put(mod, key, (...args: unknown[]) => {
        const host = requestHost(args)
        if (host === null || isLoopbackHost(host)) return orig.apply(mod, args)
        throw new DemoOffline(host)
      })
    }
  }

  return () => {
    for (const x of patches.reverse()) x.obj[x.key] = x.orig
    on = false
  }
}
