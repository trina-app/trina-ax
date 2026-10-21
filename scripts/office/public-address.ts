// The office internet address, Cloudflare side (docs/OFFICE.md "인터넷 주소"). Runs on the OWNER's Mac (the one with
// the Cloudflare login), not on the office's Mac: it makes the name answer through a Cloudflare Tunnel and writes the
// connector token that the office's Mac then gets (`~/TeamAX/teamax public-address set <name> <token file>`).
//
//   bun scripts/office/public-address.ts set    <name> (--cert FILE | --api-token-file FILE) [--port 47830]
//                                                [--tunnel NAME [--share-tunnel]] [--token-out FILE] [--allow-apex]
//                                                [--dry-run]
//   bun scripts/office/public-address.ts remove <name> (--cert FILE | --api-token-file FILE) [--keep-tunnel]
//                                                [--no-rotate] [--allow-apex] [--dry-run]
//   bun scripts/office/public-address.ts rotate <name> (--cert FILE | --api-token-file FILE) [--tunnel NAME]
//                                                [--token-out FILE] [--dry-run]
//   bun scripts/office/public-address.ts status <name> (--cert FILE | --api-token-file FILE)
//
// set: finds the zone of <name>; refuses the zone apex (usually the main website) unless --allow-apex, and refuses a
// name that already has any record other than a CNAME to a Cloudflare Tunnel (<id>.cfargotunnel.com): an existing
// website or mail record is never replaced. Reuses the tunnel that CNAME points to, else the tunnel called --tunnel
// (default teamax-<name with dashes>), else creates it (remotely managed: its settings live at Cloudflare). Sets the
// tunnel's ingress for <name> to http://127.0.0.1:<port> (the office app port, Host header <name>) with a final
// http_status:404, keeping rules for other names. Creates or corrects ONLY <name>'s proxied CNAME. Writes the
// connector token to --token-out (default ~/.config/teamax-office/<name>.tunnel-token, 600). No other record, the
// apex or another name is touched.
// Also drops <name>'s rule from every other remotely managed tunnel of the account (a name that moved to another tunnel,
// or one an older remove left behind), so a name is served by one tunnel only; those tunnels are never deleted.
// A tunnel's connector token (account, tunnel id, secret) is the same for every name the tunnel serves, and Cloudflare
// spreads every name's visitors over all of the tunnel's connectors. So set refuses a tunnel that already serves
// another name (one office's Mac would get the other office's token and traffic) unless --share-tunnel says one Mac
// serves all of those names.
// remove: deletes <name>'s CNAME (only a tunnel CNAME), drops <name> from the ingress of every remotely managed tunnel of
// the account and deletes the tunnel the CNAME pointed to (or the default-named one, only when it has <name>'s rule)
// when no other name uses it, and the local token file. A locally managed tunnel (config_src not "cloudflare") is never
// touched. When the tunnel stays (--keep-tunnel, or other names on it) its secret is rotated, so the token handed out
// for <name> stops connecting: the remaining names' Mac needs the new token (written and named in the output);
// --no-rotate skips that when the same Mac serves every name.
// rotate: a new secret for the tunnel <name> points to (or --tunnel), its live connections closed, the new token
// written; every copy of the old token stops connecting.
// Changing the address later: `set <new name>`, then on the office's Mac `teamax public-address set <new name>
// <token file>`, then `remove <old name>`.
//
// Credentials: --cert is a cloudflared origin certificate (`cloudflared tunnel login`; it carries an API token for one
// zone); --api-token-file is a Cloudflare API token with Zone:DNS:Edit and Account:Cloudflare Tunnel:Edit (one line).
// Tokens are read in code and never printed or logged. Unit tests: tests/unit/office-tunnel.test.ts (mocked API).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PUBLIC_HOST_RE } from '../../server/src/app-config'
import { PRODUCT } from '../../shared/src/product'

export const API_BASE = 'https://api.cloudflare.com/client/v4'
export const DEFAULT_APP_PORT = 47830
const TUNNEL_CNAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.cfargotunnel\.com\.?$/i

/** one Cloudflare API call: the `result` of a successful answer; throws with Cloudflare's error messages otherwise */
export type Api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', p: string, body?: unknown) => Promise<any>

export class Refused extends Error { name = 'Refused' }

export interface Credential { apiToken: string; zoneId?: string; accountId?: string }

/** cloudflared's cert.pem: base64 JSON {zoneID, accountID, apiToken} between ARGO TUNNEL TOKEN lines */
export function readCert(file: string): Credential {
  const text = fs.readFileSync(file, 'utf8')
  const m = /-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/.exec(text)
  if (!m) throw new Error(`${file} is not a cloudflared origin certificate (no ARGO TUNNEL TOKEN block)`)
  let j: Record<string, unknown>
  try { j = JSON.parse(Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64').toString('utf8')) } catch { throw new Error(`${file}: the certificate's token block is not readable`) }
  if (typeof j.apiToken !== 'string' || typeof j.zoneID !== 'string' || typeof j.accountID !== 'string') throw new Error(`${file}: the certificate has no zoneID / accountID / apiToken`)
  return { apiToken: j.apiToken, zoneId: j.zoneID, accountId: j.accountID }
}

export function readApiTokenFile(file: string): Credential {
  const t = fs.readFileSync(file, 'utf8').trim()
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(t)) throw new Error(`${file} is not a Cloudflare API token (one line)`)
  return { apiToken: t }
}

/** the real API with a bearer token (never part of an error message) */
export function cloudflareApi(token: string, base = API_BASE): Api {
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    let j: { success?: boolean; result?: unknown; errors?: { code?: number; message?: string }[] } = {}
    try { j = await res.json() as typeof j } catch {}
    if (!res.ok || j.success === false) {
      const why = (j.errors ?? []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') || `HTTP ${res.status}`
      throw new Error(`Cloudflare ${method} ${p.split('?')[0]}: ${why}`)
    }
    return j.result
  }
}

export function normHost(h: string): string {
  const t = h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\.$/, '')
  if (!PUBLIC_HOST_RE.test(t)) throw new Refused(`${h} is not an internet name such as app.example.com`)
  return t
}

export function defaultTunnelName(host: string): string {
  const base = host.replace(/\./g, '-')
  return (base.startsWith('teamax-') ? base : `teamax-${base}`).slice(0, 63)
}
export const defaultTokenFile = (host: string) => path.join(os.homedir(), '.config', 'teamax-office', `${host}.tunnel-token`)

interface Zone { id: string; name: string; accountId: string }
interface DnsRecord { id: string; type: string; name: string; content: string; proxied?: boolean }
interface Tunnel { id: string; name: string; config_src?: string; deleted_at?: string | null; status?: string; connections?: unknown[] }
interface IngressRule { hostname?: string; service: string; path?: string; originRequest?: Record<string, unknown> }

/** the zone <host> belongs to: the certificate's zone, or the longest matching zone the token can see */
export async function findZone(api: Api, host: string, cred: Pick<Credential, 'zoneId' | 'accountId'>): Promise<Zone> {
  if (cred.zoneId) {
    const z = await api('GET', `/zones/${cred.zoneId}`)
    const name = String(z.name).toLowerCase()
    if (host !== name && !host.endsWith(`.${name}`)) throw new Refused(`${host} is not in ${name}, the zone of this certificate: use the certificate (or an API token) of the zone ${host} belongs to`)
    return { id: z.id, name, accountId: cred.accountId ?? z.account?.id }
  }
  const labels = host.split('.')
  for (let i = 0; i <= labels.length - 2; i++) {
    const cand = labels.slice(i).join('.')
    const zs = await api('GET', `/zones?name=${encodeURIComponent(cand)}`) as { id: string; name: string; account?: { id: string } }[]
    const z = zs?.[0]
    if (z) return { id: z.id, name: z.name.toLowerCase(), accountId: cred.accountId ?? z.account?.id ?? '' }
  }
  throw new Refused(`no Cloudflare zone for ${host} is visible to this credential`)
}

async function records(api: Api, zone: Zone, host: string): Promise<DnsRecord[]> {
  const r = await api('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`) as DnsRecord[]
  return (r ?? []).filter((x) => x.name.toLowerCase() === host)
}

/** The refusal rules for a name, before anything is changed. Returns the tunnel id an existing CNAME points to. */
export function checkRecords(host: string, zone: Pick<Zone, 'name'>, recs: DnsRecord[], o: { allowApex?: boolean }): { record: DnsRecord | null; tunnelId: string | null } {
  if (host === zone.name && !o.allowApex) throw new Refused(`${host} is the zone apex (usually the main website): refused. Use a name under it, e.g. app.${zone.name} (--allow-apex only if the apex is meant for ${PRODUCT.displayName})`)
  const other = recs.filter((r) => !(r.type === 'CNAME' && TUNNEL_CNAME.test(r.content)))
  if (other.length) throw new Refused(`${host} already has ${other.map((r) => `${r.type} ${r.content}`).join(', ')}: refused, nothing changed. Pick a name that is free (or remove that record yourself if it is really unused)`)
  const rec = recs[0] ?? null
  return { record: rec, tunnelId: rec ? TUNNEL_CNAME.exec(rec.content)![1]!.toLowerCase() : null }
}

async function getTunnel(api: Api, accountId: string, id: string): Promise<Tunnel | null> {
  try {
    const t = await api('GET', `/accounts/${accountId}/cfd_tunnel/${id}`) as Tunnel
    return t && !t.deleted_at ? t : null
  } catch { return null }
}

/** a tunnel whose rules live in a local config.yml (config_src not "cloudflare"): this script never changes it */
const isLocal = (t: Pick<Tunnel, 'config_src'>) => !!t.config_src && t.config_src !== 'cloudflare'
/** live connectors of a tunnel (Cloudflare lists them as an array) */
const connectorCount = (t: Tunnel) => Array.isArray(t.connections) ? t.connections.length : typeof t.connections === 'number' ? t.connections : 0

async function tunnelByName(api: Api, accountId: string, name: string): Promise<Tunnel | null> {
  const ts = await api('GET', `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`) as Tunnel[]
  return (ts ?? []).find((t) => t.name === name && !t.deleted_at) ?? null
}

async function ingressOf(api: Api, accountId: string, id: string): Promise<{ config: Record<string, unknown>; ingress: IngressRule[] }> {
  const r = await api('GET', `/accounts/${accountId}/cfd_tunnel/${id}/configurations`) as { config?: Record<string, unknown> | null } | null
  const config = (r?.config ?? {}) as Record<string, unknown>
  return { config, ingress: Array.isArray(config.ingress) ? config.ingress as IngressRule[] : [] }
}

/** ingress with <host> → the office app port first, other names' rules kept, one catch-all 404 last */
export function ingressFor(host: string, port: number, current: IngressRule[]): IngressRule[] {
  const others = current.filter((r) => r.hostname && r.hostname.toLowerCase() !== host)
  return [
    { hostname: host, service: `http://127.0.0.1:${port}`, originRequest: { httpHostHeader: host } },
    ...others,
    { service: 'http_status:404' },
  ]
}

/** the rules without <host>'s, one catch-all 404 last */
export function ingressWithout(host: string, current: IngressRule[]): IngressRule[] {
  return [...current.filter((r) => r.hostname && r.hostname.toLowerCase() !== host), { service: 'http_status:404' }]
}

const hasRule = (host: string, ingress: IngressRule[]) => ingress.some((r) => r.hostname?.toLowerCase() === host)

/** the account's remotely managed tunnels whose ingress has a rule for <host> (one config read per tunnel) */
async function tunnelsWithRule(api: Api, accountId: string, host: string): Promise<{ tunnel: Tunnel; config: Record<string, unknown>; ingress: IngressRule[] }[]> {
  const all: Tunnel[] = []
  for (let page = 1; page <= 20; page++) {
    const ts = (await api('GET', `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=100&page=${page}`) ?? []) as Tunnel[]
    all.push(...ts)
    if (ts.length < 100) break
  }
  const out: { tunnel: Tunnel; config: Record<string, unknown>; ingress: IngressRule[] }[] = []
  for (const t of all) {
    if (t.deleted_at || (t.config_src && t.config_src !== 'cloudflare')) continue
    let cur: Awaited<ReturnType<typeof ingressOf>>
    try { cur = await ingressOf(api, accountId, t.id) } catch { continue }
    if (hasRule(host, cur.ingress)) out.push({ tunnel: t, ...cur })
  }
  return out
}

/** drops <host>'s rule from those tunnels (never deletes them) */
async function dropStaleRules(api: Api, accountId: string, host: string, except: string | null, why: string, actions: string[], dryRun?: boolean) {
  for (const s of await tunnelsWithRule(api, accountId, host)) {
    if (s.tunnel.id === except) continue
    actions.push(`tunnel ${s.tunnel.name}: drop ${host} (${why})`)
    if (!dryRun) await api('PUT', `/accounts/${accountId}/cfd_tunnel/${s.tunnel.id}/configurations`, { config: { ...s.config, ingress: ingressWithout(host, s.ingress) } })
  }
}

/** equal as JSON regardless of key order (Cloudflare returns the ingress rules with their keys reordered) */
export function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

export interface SetOptions { host: string; port?: number; tunnel?: string; shareTunnel?: boolean; tokenOut?: string; allowApex?: boolean; dryRun?: boolean }
export interface SetResult { host: string; zone: string; tunnelId: string; tunnelName: string; created: boolean; dns: 'created' | 'updated' | 'unchanged'; service: string; tokenFile: string | null; actions: string[]; sharedWith: string[]; connectors: number }

/** the names a tunnel's rules serve, other than <host> */
const otherNames = (host: string, ingress: IngressRule[]) => [...new Set(ingress.filter((r) => r.hostname && r.hostname.toLowerCase() !== host).map((r) => r.hostname!.toLowerCase()))]

/**
 * A new random secret for a remotely managed tunnel, its live connections closed, and the new connector token. Every
 * copy of the old token stops connecting (the token is account + tunnel id + secret), including the connectors that
 * were running: the Mac that should serve the tunnel's names needs the new token.
 */
export async function rotateSecret(api: Api, accountId: string, tunnel: Pick<Tunnel, 'id'>): Promise<string> {
  await api('PATCH', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}`, { tunnel_secret: crypto.randomBytes(32).toString('base64') })
  try { await api('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/connections`) } catch {}
  const token = await api('GET', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`)
  if (typeof token !== 'string' || token.length < 40) throw new Error('Cloudflare returned no connector token')
  return token
}

export async function setAddress(api: Api, cred: Pick<Credential, 'zoneId' | 'accountId'>, o: SetOptions): Promise<SetResult> {
  const host = normHost(o.host)
  const port = o.port ?? DEFAULT_APP_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Refused(`--port ${port} is not a port`)
  const zone = await findZone(api, host, cred)
  if (!zone.accountId) throw new Refused('the account of the zone is unknown: pass --account-id')
  const { record, tunnelId: pointed } = checkRecords(host, zone, await records(api, zone, host), o)
  const actions: string[] = []

  let tunnel: Tunnel | null = null
  let created = false
  if (pointed) {
    tunnel = await getTunnel(api, zone.accountId, pointed)
    if (tunnel && o.tunnel && tunnel.name !== o.tunnel) throw new Refused(`${host} already points to the tunnel ${tunnel.name} (${tunnel.id}), not ${o.tunnel}: refused (remove ${host} first to move it)`)
  }
  if (!tunnel) {
    const name = o.tunnel || defaultTunnelName(host)
    tunnel = await tunnelByName(api, zone.accountId, name)
    if (!tunnel) {
      actions.push(`create tunnel ${name}`)
      if (!o.dryRun) tunnel = await api('POST', `/accounts/${zone.accountId}/cfd_tunnel`, { name, config_src: 'cloudflare' }) as Tunnel
      else tunnel = { id: '00000000-0000-0000-0000-000000000000', name, config_src: 'cloudflare' }
      created = true
    }
  }
  if (isLocal(tunnel)) throw new Refused(`the tunnel ${tunnel.name} is managed by a local config file, not by Cloudflare: refused (use another --tunnel name)`)

  const service = `http://127.0.0.1:${port}`
  const cur = created ? { config: {}, ingress: [] } : await ingressOf(api, zone.accountId, tunnel.id)
  // one tunnel = one connector token for all its names: another office's Mac must never get this one's token
  const sharedWith = otherNames(host, cur.ingress)
  if (sharedWith.length && !o.shareTunnel) throw new Refused(`the tunnel ${tunnel.name} already serves ${sharedWith.join(', ')}; its connector token is the same for every name it serves, so the Mac given the token for ${host} could serve those names (and get their visitors) too: refused, nothing changed. Leave out --tunnel so ${host} gets a tunnel of its own (if ${host} already points to ${tunnel.name}, remove ${host} first), or add --share-tunnel when one Mac serves all of these names`)
  const ingress = ingressFor(host, port, cur.ingress)
  if (!sameJson(ingress, cur.ingress)) {
    actions.push(`tunnel ${tunnel.name}: ${host} → ${service}`)
    if (!o.dryRun) await api('PUT', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ...cur.config, ingress } })
  }

  // the name may still have a rule in another tunnel (it moved, or an older remove kept it): one tunnel per name
  await dropStaleRules(api, zone.accountId, host, tunnel.id, `now served by ${tunnel.name}`, actions, o.dryRun)

  const target = `${tunnel.id}.cfargotunnel.com`
  let dns: SetResult['dns'] = 'unchanged'
  if (!record) {
    dns = 'created'
    actions.push(`DNS: create CNAME ${host} → ${target} (proxied)`)
    if (!o.dryRun) await api('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: host, content: target, proxied: true, ttl: 1, comment: `${PRODUCT.displayName} office internet address (scripts/office/public-address.ts)` })
  } else if (record.content.toLowerCase().replace(/\.$/, '') !== target || record.proxied !== true) {
    dns = 'updated'
    actions.push(`DNS: CNAME ${host} → ${target} (proxied; was ${record.content}${record.proxied ? '' : ', not proxied'})`)
    if (!o.dryRun) await api('PATCH', `/zones/${zone.id}/dns_records/${record.id}`, { type: 'CNAME', name: host, content: target, proxied: true, ttl: 1 })
  }

  let tokenFile: string | null = null
  if (!o.dryRun) {
    const token = await api('GET', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/token`)
    if (typeof token !== 'string' || token.length < 40) throw new Error('Cloudflare returned no connector token')
    tokenFile = path.resolve(o.tokenOut ?? defaultTokenFile(host))
    writeSecret(tokenFile, token)
  }
  // a reused tunnel may already have connectors: the token written is the one they run with (same Mac, or a copy)
  const connectors = created ? 0 : connectorCount(tunnel)
  return { host, zone: zone.name, tunnelId: tunnel.id, tunnelName: tunnel.name, created, dns, service, tokenFile, actions, sharedWith, connectors }
}

export interface RemoveOptions { host: string; tunnel?: string; keepTunnel?: boolean; rotate?: boolean; allowApex?: boolean; dryRun?: boolean; tokenOut?: string; newTokenOut?: string }
/** a kept tunnel whose secret was rotated: the Mac serving `names` needs the token in `tokenFile` */
export interface Rotated { tunnelName: string; names: string[]; tokenFile: string | null }

export async function removeAddress(api: Api, cred: Pick<Credential, 'zoneId' | 'accountId'>, o: RemoveOptions): Promise<{ actions: string[]; rotated: Rotated | null }> {
  const host = normHost(o.host)
  const zone = await findZone(api, host, cred)
  const { record, tunnelId } = checkRecords(host, zone, await records(api, zone, host), o)
  const actions: string[] = []
  // the tunnel is looked up before anything changes: a locally managed tunnel keeps its rules in someone's config.yml,
  // the API shows no names for it, so it would look unused. Never touched (the same rule as set). A CNAME pointing at
  // one was not made by this script (set refuses those tunnels): the whole remove is refused, nothing changed.
  const pointed = tunnelId ? await getTunnel(api, zone.accountId, tunnelId) : null
  if (pointed && isLocal(pointed)) throw new Refused(`${host} points to the tunnel ${pointed.name}, which is managed by a local config file: refused, nothing changed (that tunnel and its CNAME are not this server's)`)
  let tunnel = pointed ?? await tunnelByName(api, zone.accountId, o.tunnel || defaultTunnelName(host))
  if (record) {
    actions.push(`DNS: delete CNAME ${host} → ${record.content}`)
    if (!o.dryRun) await api('DELETE', `/zones/${zone.id}/dns_records/${record.id}`)
  } else actions.push(`DNS: ${host} has no record`)
  if (tunnel && isLocal(tunnel)) {
    actions.push(`tunnel ${tunnel.name} is managed by a local config file: not touched`)
    tunnel = null
  }
  let rotated: Rotated | null = null
  if (tunnel) {
    const cur = await ingressOf(api, zone.accountId, tunnel.id)
    const others = otherNames(host, cur.ingress)
    // only a tunnel tied to this name is deleted or rotated: the one its CNAME pointed to, or one found by name that
    // has its rule. An empty tunnel reached only through --tunnel or the default name belongs to something else.
    const tied = !!pointed || hasRule(host, cur.ingress)
    const kept = o.keepTunnel ? ' (--keep-tunnel)' : ''
    if (!tied) actions.push(`tunnel ${tunnel.name} kept, it has no rule for ${host} and ${host} does not point to it`)
    else if (!others.length && !o.keepTunnel) {
      actions.push(`delete tunnel ${tunnel.name} (${tunnel.id})`)
      if (!o.dryRun) {
        // a connector still running (the office's Mac) would keep the tunnel: its connections are closed first
        try { await api('DELETE', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/connections`) } catch {}
        await api('DELETE', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}`)
      }
    } else {
      // --keep-tunnel or other names on it: the tunnel stays, without this name's rule
      if (hasRule(host, cur.ingress)) {
        actions.push(`tunnel ${tunnel.name}: drop ${host}, kept${kept}${others.length ? ` for ${others.join(', ')}` : ''}`)
        if (!o.dryRun) await api('PUT', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ...cur.config, ingress: ingressWithout(host, cur.ingress) } })
      } else actions.push(`tunnel ${tunnel.name} kept${kept}, it has no rule for ${host}`)
      // the token handed out for this name is the tunnel's token: it would keep connecting (and serving the other
      // names) until the secret changes
      if (o.rotate === false) actions.push(`tunnel ${tunnel.name}: secret NOT rotated (--no-rotate): the token given out for ${host} still connects`)
      else {
        const file = others.length ? path.resolve(o.newTokenOut ?? defaultTokenFile(others[0]!)) : null
        actions.push(`tunnel ${tunnel.name}: new secret (the token given out for ${host} stops connecting; live connections closed)${file ? `; new token for ${others.join(', ')}: ${file}` : ''}`)
        if (!o.dryRun) {
          const token = await rotateSecret(api, zone.accountId, tunnel)
          if (file) writeSecret(file, token)
        }
        rotated = { tunnelName: tunnel.name, names: others, tokenFile: file }
      }
    }
  }
  // a rule for this name in any other tunnel (moved earlier, or left by an older --keep-tunnel remove)
  await dropStaleRules(api, zone.accountId, host, tunnel?.id ?? null, 'removed', actions, o.dryRun)
  const tf = path.resolve(o.tokenOut ?? defaultTokenFile(host))
  if (fs.existsSync(tf) && tf !== rotated?.tokenFile) { actions.push(`delete ${tf}`); if (!o.dryRun) fs.rmSync(tf, { force: true }) }
  return { actions, rotated }
}

export interface RotateOptions { host: string; tunnel?: string; tokenOut?: string; dryRun?: boolean }

/** `rotate <name>`: a new secret for the tunnel serving <name>; the new token goes to --token-out or the default file. */
export async function rotateAddress(api: Api, cred: Pick<Credential, 'zoneId' | 'accountId'>, o: RotateOptions): Promise<{ actions: string[]; rotated: Rotated }> {
  const host = normHost(o.host)
  const zone = await findZone(api, host, cred)
  if (!zone.accountId) throw new Refused('the account of the zone is unknown: pass --account-id')
  const { tunnelId } = checkRecords(host, zone, await records(api, zone, host), { allowApex: true })
  const tunnel = (tunnelId ? await getTunnel(api, zone.accountId, tunnelId) : null) ?? await tunnelByName(api, zone.accountId, o.tunnel || defaultTunnelName(host))
  if (!tunnel) throw new Refused(`no tunnel serves ${host} (no tunnel CNAME, no tunnel called ${o.tunnel || defaultTunnelName(host)})`)
  if (isLocal(tunnel)) throw new Refused(`the tunnel ${tunnel.name} is managed by a local config file: refused`)
  if (o.tunnel && tunnel.name !== o.tunnel) throw new Refused(`${host} points to the tunnel ${tunnel.name}, not ${o.tunnel}: refused`)
  const names = [...new Set((await ingressOf(api, zone.accountId, tunnel.id)).ingress.filter((r) => r.hostname).map((r) => r.hostname!.toLowerCase()))]
  const file = path.resolve(o.tokenOut ?? defaultTokenFile(host))
  const actions = [`tunnel ${tunnel.name} (${tunnel.id}): new secret, live connections closed, new token: ${file}`]
  if (!o.dryRun) writeSecret(file, await rotateSecret(api, zone.accountId, tunnel))
  return { actions, rotated: { tunnelName: tunnel.name, names, tokenFile: file } }
}

export async function statusOf(api: Api, cred: Pick<Credential, 'zoneId' | 'accountId'>, host0: string): Promise<string[]> {
  const host = normHost(host0)
  const zone = await findZone(api, host, cred)
  const recs = await records(api, zone, host)
  const out = [`${host} (zone ${zone.name})`]
  if (!recs.length) out.push('  DNS: no record')
  for (const r of recs) out.push(`  DNS: ${r.type} → ${r.content}${r.proxied ? ' (proxied)' : ''}`)
  const id = recs.map((r) => TUNNEL_CNAME.exec(r.content)?.[1]).find(Boolean)
  const t = id ? await getTunnel(api, zone.accountId, id) : await tunnelByName(api, zone.accountId, defaultTunnelName(host))
  if (!t) { out.push('  tunnel: none'); return out }
  const conns = Array.isArray(t.connections) ? t.connections.length : 0
  out.push(`  tunnel: ${t.name} (${t.id}) ${t.status ?? ''}, ${conns} connection(s)`)
  for (const r of (await ingressOf(api, zone.accountId, t.id)).ingress) out.push(`    ${r.hostname ?? '*'} → ${r.service}`)
  return out
}

function writeSecret(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  fs.rmSync(tmp, { force: true })
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, file)
  fs.chmodSync(file, 0o600)
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const USAGE = `usage:
  bun scripts/office/public-address.ts set <name> (--cert FILE | --api-token-file FILE) [--port 47830] [--tunnel NAME [--share-tunnel]] [--token-out FILE] [--allow-apex] [--dry-run]
  bun scripts/office/public-address.ts remove <name> (--cert FILE | --api-token-file FILE) [--keep-tunnel] [--no-rotate] [--new-token-out FILE] [--allow-apex] [--dry-run]
  bun scripts/office/public-address.ts rotate <name> (--cert FILE | --api-token-file FILE) [--tunnel NAME] [--token-out FILE] [--dry-run]
  bun scripts/office/public-address.ts status <name> (--cert FILE | --api-token-file FILE)`

function printRotated(r: Rotated | null) {
  if (!r?.names.length || !r.tokenFile) return
  console.log(`\nthe Mac that serves ${r.names.join(', ')} (tunnel ${r.tunnelName}) is disconnected until it gets the new token: ${r.tokenFile} (600; not shown)`)
  console.log(`  copy it there (AirDrop/USB), then: ~/TeamAX/teamax public-address set ${r.names[0]} <the copied token file>`)
}

export async function main(argv: string[], apiFor: (c: Credential) => Api = (c) => cloudflareApi(c.apiToken)): Promise<number> {
  const [cmd, host] = argv
  if (!cmd || !host || host.startsWith('--') || !['set', 'remove', 'rotate', 'status'].includes(cmd)) { console.error(USAGE); return 2 }
  const certFile = arg(argv, '--cert'), tokenFile = arg(argv, '--api-token-file')
  if (!certFile === !tokenFile) { console.error('pass exactly one of --cert <cloudflared cert.pem> or --api-token-file <file>'); return 2 }
  const cred = certFile ? readCert(certFile) : readApiTokenFile(tokenFile!)
  if (arg(argv, '--account-id')) cred.accountId = arg(argv, '--account-id')
  const api = apiFor(cred)
  const flags = { allowApex: argv.includes('--allow-apex'), dryRun: argv.includes('--dry-run'), tunnel: arg(argv, '--tunnel') || undefined, tokenOut: arg(argv, '--token-out') }
  try {
    if (cmd === 'status') { for (const l of await statusOf(api, cred, host)) console.log(l); return 0 }
    if (cmd === 'remove') {
      const r = await removeAddress(api, cred, { host, ...flags, keepTunnel: argv.includes('--keep-tunnel'), rotate: !argv.includes('--no-rotate'), newTokenOut: arg(argv, '--new-token-out') })
      for (const a of r.actions) console.log(`${flags.dryRun ? 'would ' : ''}${a}`)
      if (!flags.dryRun) printRotated(r.rotated)
      return 0
    }
    if (cmd === 'rotate') {
      const r = await rotateAddress(api, cred, { host, tunnel: flags.tunnel, tokenOut: flags.tokenOut, dryRun: flags.dryRun })
      for (const a of r.actions) console.log(`${flags.dryRun ? 'would ' : ''}${a}`)
      if (!flags.dryRun) printRotated(r.rotated)
      return 0
    }
    const port = arg(argv, '--port') ? Number(arg(argv, '--port')) : undefined
    const r = await setAddress(api, cred, { host, port, ...flags, shareTunnel: argv.includes('--share-tunnel') })
    for (const a of r.actions) console.log(`${flags.dryRun ? 'would ' : ''}${a}`)
    if (!r.actions.length) console.log('Cloudflare already set up (nothing changed)')
    console.log(`\nhttps://${r.host} → tunnel ${r.tunnelName} (${r.tunnelId}) → ${r.service} on the office's Mac`)
    if (r.tokenFile) {
      console.log(`connector token: ${r.tokenFile} (600; not shown). Copy it to the office's Mac (AirDrop/USB), then there:`)
      if (r.connectors) console.log(`  NOTE: this token is the one already running on ${r.connectors} connector(s) of ${r.tunnelName}; give it only to the Mac that already serves ${r.host}`)
      if (r.sharedWith.length) console.log(`  NOTE (--share-tunnel): this token also serves ${r.sharedWith.join(', ')}; give it only to the one Mac that serves all of them`)
      console.log(`  ~/TeamAX/teamax public-address set ${r.host} <the copied token file>`)
      console.log('  (or at install: bash office-install.sh --public-host ' + r.host + ' --tunnel-token-file <file>)')
    }
    return 0
  } catch (e) {
    console.error(`public-address: ${(e as Error).message}`)
    return e instanceof Refused ? 3 : 1
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
