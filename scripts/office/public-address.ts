// The office internet address, Cloudflare side (docs/OFFICE.md "인터넷 주소"). Runs on the OWNER's Mac (the one with
// the Cloudflare login), not on the clinic's Mac: it makes the name answer through a Cloudflare Tunnel and writes the
// connector token that the clinic's Mac then gets (`~/TeamAX/teamax public-address set <name> <token file>`).
//
//   bun scripts/office/public-address.ts set    <name> (--cert FILE | --api-token-file FILE) [--port 47830]
//                                                [--tunnel NAME] [--token-out FILE] [--allow-apex] [--dry-run]
//   bun scripts/office/public-address.ts remove <name> (--cert FILE | --api-token-file FILE) [--keep-tunnel]
//                                                [--allow-apex] [--dry-run]
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
// remove: deletes <name>'s CNAME (only a tunnel CNAME), drops <name> from the tunnel's ingress and deletes the tunnel
// when no other name uses it (--keep-tunnel keeps it), and the local token file.
// Changing the address later: `set <new name>`, then on the clinic's Mac `teamax public-address set <new name>
// <token file>`, then `remove <old name>`.
//
// Credentials: --cert is a cloudflared origin certificate (`cloudflared tunnel login`; it carries an API token for one
// zone); --api-token-file is a Cloudflare API token with Zone:DNS:Edit and Account:Cloudflare Tunnel:Edit (one line).
// Tokens are read in code and never printed or logged. Unit tests: tests/unit/office-tunnel.test.ts (mocked API).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PUBLIC_HOST_RE } from '../../server/src/app-config'

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
  if (host === zone.name && !o.allowApex) throw new Refused(`${host} is the zone apex (usually the main website): refused. Use a name under it, e.g. app.${zone.name} (--allow-apex only if the apex is meant for Team AX)`)
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

export interface SetOptions { host: string; port?: number; tunnel?: string; tokenOut?: string; allowApex?: boolean; dryRun?: boolean }
export interface SetResult { host: string; zone: string; tunnelId: string; tunnelName: string; created: boolean; dns: 'created' | 'updated' | 'unchanged'; service: string; tokenFile: string | null; actions: string[] }

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
    const name = o.tunnel ?? defaultTunnelName(host)
    tunnel = await tunnelByName(api, zone.accountId, name)
    if (!tunnel) {
      actions.push(`create tunnel ${name}`)
      if (!o.dryRun) tunnel = await api('POST', `/accounts/${zone.accountId}/cfd_tunnel`, { name, config_src: 'cloudflare' }) as Tunnel
      else tunnel = { id: '00000000-0000-0000-0000-000000000000', name, config_src: 'cloudflare' }
      created = true
    }
  }
  if (tunnel.config_src && tunnel.config_src !== 'cloudflare') throw new Refused(`the tunnel ${tunnel.name} is managed by a local config file, not by Cloudflare: refused (use another --tunnel name)`)

  const service = `http://127.0.0.1:${port}`
  const cur = created ? { config: {}, ingress: [] } : await ingressOf(api, zone.accountId, tunnel.id)
  const ingress = ingressFor(host, port, cur.ingress)
  if (JSON.stringify(ingress) !== JSON.stringify(cur.ingress)) {
    actions.push(`tunnel ${tunnel.name}: ${host} → ${service}`)
    if (!o.dryRun) await api('PUT', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ...cur.config, ingress } })
  }

  const target = `${tunnel.id}.cfargotunnel.com`
  let dns: SetResult['dns'] = 'unchanged'
  if (!record) {
    dns = 'created'
    actions.push(`DNS: create CNAME ${host} → ${target} (proxied)`)
    if (!o.dryRun) await api('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: host, content: target, proxied: true, ttl: 1, comment: 'Team AX office internet address (scripts/office/public-address.ts)' })
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
  return { host, zone: zone.name, tunnelId: tunnel.id, tunnelName: tunnel.name, created, dns, service, tokenFile, actions }
}

export interface RemoveOptions { host: string; tunnel?: string; keepTunnel?: boolean; allowApex?: boolean; dryRun?: boolean; tokenOut?: string }

export async function removeAddress(api: Api, cred: Pick<Credential, 'zoneId' | 'accountId'>, o: RemoveOptions): Promise<{ actions: string[] }> {
  const host = normHost(o.host)
  const zone = await findZone(api, host, cred)
  const { record, tunnelId } = checkRecords(host, zone, await records(api, zone, host), o)
  const actions: string[] = []
  if (record) {
    actions.push(`DNS: delete CNAME ${host} → ${record.content}`)
    if (!o.dryRun) await api('DELETE', `/zones/${zone.id}/dns_records/${record.id}`)
  } else actions.push(`DNS: ${host} has no record`)
  let tunnel = tunnelId ? await getTunnel(api, zone.accountId, tunnelId) : null
  if (!tunnel) tunnel = await tunnelByName(api, zone.accountId, o.tunnel ?? defaultTunnelName(host))
  if (tunnel && !o.keepTunnel) {
    const cur = await ingressOf(api, zone.accountId, tunnel.id)
    const others = cur.ingress.filter((r) => r.hostname && r.hostname.toLowerCase() !== host)
    if (others.length) {
      actions.push(`tunnel ${tunnel.name}: drop ${host}, kept for ${others.map((r) => r.hostname).join(', ')}`)
      if (!o.dryRun) await api('PUT', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ...cur.config, ingress: [...others, { service: 'http_status:404' }] } })
    } else {
      actions.push(`delete tunnel ${tunnel.name} (${tunnel.id})`)
      if (!o.dryRun) {
        // a connector still running (the clinic's Mac) would keep the tunnel: its connections are closed first
        try { await api('DELETE', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/connections`) } catch {}
        await api('DELETE', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}`)
      }
    }
  } else if (tunnel) actions.push(`tunnel ${tunnel.name} kept (--keep-tunnel)`)
  const tf = path.resolve(o.tokenOut ?? defaultTokenFile(host))
  if (fs.existsSync(tf)) { actions.push(`delete ${tf}`); if (!o.dryRun) fs.rmSync(tf, { force: true }) }
  return { actions }
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
  bun scripts/office/public-address.ts set <name> (--cert FILE | --api-token-file FILE) [--port 47830] [--tunnel NAME] [--token-out FILE] [--allow-apex] [--dry-run]
  bun scripts/office/public-address.ts remove <name> (--cert FILE | --api-token-file FILE) [--keep-tunnel] [--allow-apex] [--dry-run]
  bun scripts/office/public-address.ts status <name> (--cert FILE | --api-token-file FILE)`

export async function main(argv: string[], apiFor: (c: Credential) => Api = (c) => cloudflareApi(c.apiToken)): Promise<number> {
  const [cmd, host] = argv
  if (!cmd || !host || host.startsWith('--') || !['set', 'remove', 'status'].includes(cmd)) { console.error(USAGE); return 2 }
  const certFile = arg(argv, '--cert'), tokenFile = arg(argv, '--api-token-file')
  if (!certFile === !tokenFile) { console.error('pass exactly one of --cert <cloudflared cert.pem> or --api-token-file <file>'); return 2 }
  const cred = certFile ? readCert(certFile) : readApiTokenFile(tokenFile!)
  if (arg(argv, '--account-id')) cred.accountId = arg(argv, '--account-id')
  const api = apiFor(cred)
  const flags = { allowApex: argv.includes('--allow-apex'), dryRun: argv.includes('--dry-run'), tunnel: arg(argv, '--tunnel'), tokenOut: arg(argv, '--token-out') }
  try {
    if (cmd === 'status') { for (const l of await statusOf(api, cred, host)) console.log(l); return 0 }
    if (cmd === 'remove') {
      const r = await removeAddress(api, cred, { host, ...flags, keepTunnel: argv.includes('--keep-tunnel') })
      for (const a of r.actions) console.log(`${flags.dryRun ? 'would ' : ''}${a}`)
      return 0
    }
    const port = arg(argv, '--port') ? Number(arg(argv, '--port')) : undefined
    const r = await setAddress(api, cred, { host, port, ...flags })
    for (const a of r.actions) console.log(`${flags.dryRun ? 'would ' : ''}${a}`)
    if (!r.actions.length) console.log('Cloudflare already set up (nothing changed)')
    console.log(`\nhttps://${r.host} → tunnel ${r.tunnelName} (${r.tunnelId}) → ${r.service} on the clinic's Mac`)
    if (r.tokenFile) {
      console.log(`connector token: ${r.tokenFile} (600; not shown). Copy it to the clinic's Mac (AirDrop/USB), then there:`)
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
