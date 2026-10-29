// Where the server process itself may connect on the hosted cloud (docs/DECISIONS.md "클라우드 리눅스 서버", review SEC-01).
// The team's API engine (engine/api-agent.ts) calls an address the owner types; on a shared host that address could be
// the hypervisor, another team's port, the host agent or the cloud metadata service (169.254.169.254). In the cloud the
// address must be https and resolve only to public internet addresses (the same address rules as web_fetch,
// tools/web-fetch.ts: no private, loopback, link-local, CGNAT, reserved or own-network address). It is checked when the
// owner saves it and again before every call (a name can be re-pointed later); the tenant's nftables rules for the
// server account (docs/INSTALL-LINUX.md) are the second wall against DNS tricks between the check and the connection.
// Self-hosted and office installs keep "any http(s) address" (a local Ollama is a normal choice there).
import dns from 'node:dns/promises'
import net from 'node:net'
import type { Locale } from '@mycel/shared/api'
import type { AppConfig } from '../app-config'
import { feature } from './deployment'
import { fail } from '../http/errors'
import { PRODUCT } from '@mycel/shared'
import { checkHostName, isLocalAddress, isPublicAddress } from '../tools/web-fetch'

export class EgressError extends Error { name = 'EgressError' }

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>
const sysLookup: Lookup = (h) => dns.lookup(h, { all: true, verbatim: true })

/** Throws EgressError unless `raw` is an https URL whose host resolves only to public internet addresses. */
export async function assertPublicHttps(raw: string, o: { lookup?: Lookup } = {}): Promise<URL> {
  let u: URL
  try { u = new URL(raw) } catch { throw new EgressError('not a valid address') }
  if (u.protocol !== 'https:') throw new EgressError('only https addresses are allowed')
  if (u.username || u.password) throw new EgressError('addresses with a user name or password are not allowed')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  let addrs: { address: string; family: number }[]
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }]
  else {
    const bad = checkHostName(host)
    if (bad) throw new EgressError(`${bad}: ${host}`)
    try { addrs = await (o.lookup ?? sysLookup)(host) } catch { throw new EgressError(`could not resolve ${host}`) }
  }
  if (!addrs.length) throw new EgressError(`could not resolve ${host}`)
  for (const a of addrs) {
    if (!isPublicAddress(a.address) || isLocalAddress(a.address)) throw new EgressError(`${host} points to a private, local or reserved address`)
  }
  return u
}

const T = {
  ko: (why: string) => `${PRODUCT.displayName} Cloud에서는 인터넷의 공개 https 주소만 쓸 수 있습니다(${why}).`,
  en: (why: string) => `On ${PRODUCT.displayName} Cloud only public https addresses on the internet can be used (${why}).`,
  id: (why: string) => `Di ${PRODUCT.displayName} Cloud hanya alamat https publik di internet yang bisa dipakai (${why}).`, ja: (why: string) => `${PRODUCT.displayName} Cloudではインターネット上の公開httpsアドレスのみ使用できます（${why}）。`, es: (why: string) => `En ${PRODUCT.displayName} Cloud solo se pueden usar direcciones https públicas de internet (${why}).`,
}

/** PUT /api/admin/engines/api-config: in the cloud, refuse an address that is not public https (400). */
export async function checkApiEngineUrl(cfg: Pick<AppConfig, 'mode'> & Partial<Pick<AppConfig, 'office' | 'deployment'>>, url: string, locale: Locale, o: { lookup?: Lookup } = {}): Promise<void> {
  if (feature(cfg, 'apiEngineAnyUrl')) return
  try { await assertPublicHttps(url, o) } catch (e) {
    if (!(e instanceof EgressError)) throw e
    fail('validation', (T[locale] ?? T.en)(e.message), { fields: { 'body.baseUrl': 'not_public_https' } })
  }
}

// One server process serves one team, so the rule for the API engine's calls is a process setting: set at start from
// the deployment (routes/system.ts init), read by every call (engine/api-agent.ts, admin/engines.ts check).
let publicOnly = false
let lookupOverride: Lookup | undefined
export function setApiEnginePublicOnly(v: boolean, o: { lookup?: Lookup } = {}) { publicOnly = v; lookupOverride = o.lookup }
export function apiEnginePublicOnly() { return publicOnly }

/** fetch for the API engine: in the cloud every call's address is checked first (the check's error is the failure). */
export function apiEngineFetch(base: typeof fetch = fetch): typeof fetch {
  if (!publicOnly) return base
  const guarded = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    await assertPublicHttps(url, { lookup: lookupOverride })
    // no redirect to somewhere else: a public address could answer 307 to http://169.254.169.254/
    return base(input, { ...init, redirect: 'error' })
  }
  return guarded as typeof fetch
}
