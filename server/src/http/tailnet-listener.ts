// The office Tailscale listener (config.tailnet, office/tailscale.ts): TLS on the Mac's Tailscale IPv4 address with
// the tailnet's Let's Encrypt certificate. The supervisor renews the certificate files (tailscale cert); every minute
// this module reads them and starts the listener again when they changed. A pair that does not belong together (a
// new certificate read before its key is in place) or a bind that fails (Tailscale not up yet at login) keeps what
// runs now and is tried again on the next tick: the rest of the server never goes down for this listener.
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { Logger } from '../log'

export const TAILNET_RELOAD_MS = 60_000

export interface TailnetListenerConfig { host: string; port: number; bind: string | null; certFile: string; keyFile: string }
type Server = { stop(force?: boolean): void }
export type Serve = (o: { hostname: string; port: number; tls: { cert: string; key: string } }) => Server

export interface TailnetListener {
  /** read the files, start or restart the listener when needed; returns what happened */
  tick(): 'started' | 'reloaded' | 'same' | 'waiting'
  readonly up: boolean
  stop(): void
}

/** the pair to serve, or why not */
export function readPair(certFile: string, keyFile: string, read: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')): { cert: string; key: string; id: string } | { problem: string } {
  let cert: string, key: string
  try { cert = read(certFile); key = read(keyFile) } catch { return { problem: `no certificate yet (${certFile})` } }
  try {
    const x = new crypto.X509Certificate(cert)
    if (!x.checkPrivateKey(crypto.createPrivateKey(key))) return { problem: 'the key does not belong to the certificate (a renewal in progress?)' }
    return { cert, key, id: crypto.createHash('sha256').update(cert).update(key).digest('hex') }
  } catch (e) { return { problem: `unreadable certificate or key: ${(e as Error).message}` } }
}

export function tailnetListener(t: TailnetListenerConfig, serve: Serve, log: Pick<Logger, 'info' | 'warn'>, read?: (f: string) => string): TailnetListener {
  let server: Server | null = null
  let loaded: string | null = null
  let lastProblem: string | null = null
  const note = (p: string) => { if (p !== lastProblem) log.warn(`Tailscale address https://${t.host}:${t.port}: ${p}`); lastProblem = p }
  return {
    get up() { return server !== null },
    tick() {
      if (!t.bind) { note('Tailscale is not up on this Mac (no Tailscale IPv4 address yet)'); return 'waiting' }
      const pair = readPair(t.certFile, t.keyFile, read)
      if ('problem' in pair) { note(pair.problem); return 'waiting' }
      if (server && pair.id === loaded) return 'same'
      const was = server
      if (was) was.stop(false) // ongoing requests and WebSockets end on their own; new ones go to the new listener
      try {
        server = serve({ hostname: t.bind, port: t.port, tls: { cert: pair.cert, key: pair.key } })
        loaded = pair.id
        lastProblem = null
        log.info(was ? 'Tailscale address: new certificate' : 'Tailscale address listening', { origin: `https://${t.host}:${t.port}`, bind: t.bind })
        return was ? 'reloaded' : 'started'
      } catch (e) {
        server = null
        loaded = null
        note(`listener on ${t.bind}:${t.port} not started (${(e as Error).message}); trying again in a minute`)
        return 'waiting'
      }
    },
    stop() { server?.stop(true); server = null },
  }
}
