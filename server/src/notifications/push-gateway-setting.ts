// Where phone notifications go, as an owner or admin chose it in Settings › Notifications (docs/DECISIONS.md "Owners
// and admins choose where phone notifications go"): the edition's gateway (Trina: push.trina.app), off, or an address
// of the team's own (a gateway for their own build of the phone app). The operator's config wins: when
// MYCEL_PUSH_GATEWAY or server.json push.gatewayUrl is set (an address or off), the choice is locked to it and nothing
// stored here is read. The choice lives in the settings table (key `push.gateway`) and is read on every use
// (readNativePushConfig below), so a change applies without a restart.
import dns from 'node:dns/promises'
import net from 'node:net'
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import type { PushGatewayChoice, PushGatewayProblem, PushGatewaySetting } from '@mycel/shared/api'
import type { AppConfig } from '../app-config'
import type { AppContext } from '../context'
import { getSetting, setSetting } from '../admin/settings'
import { checkHostName, isLocalAddress, isPublicAddress } from '../tools/web-fetch'
import { validGatewayUrl, type NativePushConfig } from './push-native'

export const PUSH_GATEWAY_SETTING = 'push.gateway'
type Stored = { choice: 'off' } | { choice: 'custom'; url: string }

/** the gateway's origin (push-native.ts validGatewayUrl: https://<host>, or http://127.0.0.1:<port> for a gateway on
 * this machine, the same rule as app-config.ts), spaces around it ignored */
const gatewayOrigin = (raw: unknown): string | null => validGatewayUrl(typeof raw === 'string' ? raw.trim() : raw)

function stored(db: Database): Stored | null {
  const v = getSetting<Stored>(db, PUSH_GATEWAY_SETTING)
  if (v?.choice === 'off') return { choice: 'off' }
  if (v?.choice === 'custom') { const url = gatewayOrigin(v.url); return url ? { choice: 'custom', url } : null }
  return null
}

/** The gateway address in use now: the operator's (env or server.json) when set, else the stored choice, else the
 * edition default as app-config resolved it (none on a developer's server). null = no phone push. */
export function effectiveGatewayUrl(config: Pick<AppConfig, 'push'>, db: Database): string | null {
  const p = config.push
  if (p?.setBy) return p.gatewayUrl ?? null
  const s = stored(db)
  if (s?.choice === 'off') return null
  if (s?.choice === 'custom') return s.url
  return p?.gatewayUrl ?? null
}

/** what push-service.ts sends through, read on every use (a saved choice applies at once) */
export function readNativePushConfig(ctx: AppContext): NativePushConfig | null {
  const url = effectiveGatewayUrl(ctx.config, ctx.db)
  return url ? { url } : null
}

/** the edition's gateway host (push.trina.app in the Trina edition); null in the neutral core: no "default" choice */
export const defaultGatewayHost = (): string | null => { const u = gatewayOrigin(SERVICE_HOSTS.pushGatewayUrl); return u ? new URL(u).host : null }

/** What Settings › Notifications shows an owner or admin. */
export function pushGatewaySetting(config: Pick<AppConfig, 'push'>, db: Database): PushGatewaySetting {
  const defaultHost = defaultGatewayHost()
  const p = config.push
  if (p?.setBy) {
    const url = gatewayOrigin(p.gatewayUrl)
    const lockedBy = p.setBy === 'env' ? `${PRODUCT.envPrefix}PUSH_GATEWAY` : 'server.json push.gatewayUrl'
    if (!url) return { choice: 'off', url: null, defaultHost, lockedBy }
    if (url === gatewayOrigin(SERVICE_HOSTS.pushGatewayUrl)) return { choice: 'default', url: null, defaultHost, lockedBy }
    return { choice: 'custom', url, defaultHost, lockedBy }
  }
  const s = stored(db)
  if (s?.choice === 'custom') return { choice: 'custom', url: s.url, defaultHost, lockedBy: null }
  if (s?.choice === 'off' || !defaultHost) return { choice: 'off', url: null, defaultHost, lockedBy: null }
  return { choice: 'default', url: null, defaultHost, lockedBy: null }
}

/** Store a choice ('default' removes the stored one: the edition default again, and any later change of it). */
export function writePushGateway(db: Database, choice: PushGatewayChoice, url?: string): void {
  if (choice === 'default') db.query('DELETE FROM settings WHERE key = ?').run(PUSH_GATEWAY_SETTING)
  else setSetting(db, PUSH_GATEWAY_SETTING, choice === 'off' ? { choice } : { choice, url })
}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>
export const HEALTH_TIMEOUT_MS = 5000
const sysLookup: Lookup = (h) => dns.lookup(h, { all: true, verbatim: true })

/**
 * Before a custom address is saved: does `<address>/health` answer `{"ok":true}` (push-gateway/src/server.ts)? A GET to
 * an address an admin typed, so: the address rule above (on a hosted server, https only), every address the name
 * resolves to must be public (as web_fetch: no private, loopback, link-local or own-network address), no redirect is
 * followed, at most 512 bytes are read, 5 s in all. Only "it is a gateway" or why not comes back, never the answer.
 */
export async function checkGatewayHealth(raw: string, o: { hosted?: boolean; lookup?: Lookup; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ ok: true; url: string } | { ok: false; problem: PushGatewayProblem }> {
  const url = gatewayOrigin(raw)
  if (!url) return { ok: false, problem: 'address' }
  const u = new URL(url)
  if (u.protocol === 'http:' && o.hosted) return { ok: false, problem: 'address' }
  if (u.protocol === 'https:') {
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (!net.isIP(host) && checkHostName(host)) return { ok: false, problem: 'private' }
    let addrs: { address: string }[]
    try { addrs = net.isIP(host) ? [{ address: host }] : await (o.lookup ?? sysLookup)(host) } catch { return { ok: false, problem: 'unreachable' } }
    if (!addrs.length) return { ok: false, problem: 'unreachable' }
    if (addrs.some((a) => !isPublicAddress(a.address) || isLocalAddress(a.address))) return { ok: false, problem: 'private' }
  }
  const signal = AbortSignal.timeout(o.timeoutMs ?? HEALTH_TIMEOUT_MS)
  let res: Response
  try { res = await (o.fetch ?? fetch)(url + '/health', { redirect: 'manual', signal, headers: { accept: 'application/json' } }) } catch { return { ok: false, problem: 'unreachable' } }
  if (res.status !== 200 || !res.body) { void res.body?.cancel().catch(() => {}); return { ok: false, problem: 'not_gateway' } }
  let text = ''
  try {
    const reader = res.body.getReader(), decoder = new TextDecoder()
    while (text.length <= 512) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    void reader.cancel().catch(() => {})
  } catch { return { ok: false, problem: 'unreachable' } }
  try { if (text.length <= 512 && (JSON.parse(text) as { ok?: unknown })?.ok === true) return { ok: true, url } } catch {}
  return { ok: false, problem: 'not_gateway' }
}
