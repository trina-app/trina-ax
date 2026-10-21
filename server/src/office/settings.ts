// Office mode (docs/OFFICE.md): where an installation keeps its parts, its settings file, and the server.json the
// supervisor derives from them. Pure apart from reading / writing files; unit-tested in tests/unit/office.test.ts.
//
//   <home>/                    ~/TeamAX by default (office-install.sh --prefix)
//     app/                     the program: replaced on every update (bin/bun, server/, native/, web/, scripts/)
//     data/                    server data (app.db, backups, sessions ...): never inside app/, kept by updates
//     team/                    the team folder
//     tls/                     the office CA and the server certificate (server/src/office/tls.ts)
//     config/office.env        settings written by the installer (below)
//     config/server.json       written by the supervisor at every start (do not edit: change office.env)
//     config/tunnel-token      the Cloudflare Tunnel connector token of the public address (600; `teamax public-address`)
//     logs/                    office.log (supervisor + launchd), tunnel.log (cloudflared), server/ (the server's JSON
//                              logs, 14 days)
//     status/                  status.json of the running server
//     teamax                   the control command (link to app/teamax)
//     ADDRESSES.txt            desk address, certificate page, CA fingerprints (`teamax info`)
//     DESK-CARD.html           the printable desk card with the fingerprint to compare (`teamax card`)
import fs from 'node:fs'
import path from 'node:path'
import { PUBLIC_HOST_RE } from '../app-config'
import { hostPort, type OfficeNames } from './tls'

export const DEFAULT_LABEL = 'app.team-ax.office'
export const DEFAULT_APP_PORT = 47830
export const DEFAULT_LAN_PORT = 8443
/** plain-HTTP helper page with the CA certificate: lanPort - 1 by default, 0 = off */
export const helperDefault = (lanPort: number) => lanPort - 1
/** unix socket paths are limited to 104 bytes on macOS; <runDir>/private/server.sock must fit */
export const MAX_RUN_DIR = 80

export interface OfficeSettings {
  home: string
  label: string
  appPort: number
  lanPort: number
  helperPort: number
  /** engine sockets (default <home>/data/run); only set when the home path is too long for a socket path */
  runDir: string | null
  claudeBin: string | null
  codexBin: string | null
  /** name constraints on a CA made from now on (an existing CA keeps what it has) */
  caConstraints: boolean
  /** VPN / tunnel interfaces and 100.64/10 in the certificate and the desk addresses (off: the office network only) */
  includeVpn: boolean
  /** who may connect to the office port: 'subnet' (the Mac's own office subnets, the default), 'any', or CIDRs */
  allowFrom: 'subnet' | 'any' | string[]
  /** the internet address through a Cloudflare Tunnel (app.example.com), null = none (docs/OFFICE.md "인터넷 주소") */
  publicHost: string | null
  /** optional allow-list for the public address: IPv4 CIDRs of the visitors (empty = anyone) */
  publicAllowFrom: string[]
  /** optional allow-list for the public address: countries (CF-IPCountry, e.g. KR; empty = anywhere) */
  publicCountries: string[]
}

export interface OfficePaths {
  home: string; app: string; data: string; team: string; tls: string; config: string; env: string; serverJson: string
  logs: string; serverLogs: string; officeLog: string; info: string; card: string; setupToken: string; agentsDir: string; plist: (label: string) => string
  /** the connector token of the public address (600) and cloudflared's log */
  tunnelToken: string; tunnelLog: string
}

export function officePaths(home: string, env: Record<string, string | undefined> = process.env): OfficePaths {
  const h = path.resolve(home)
  const agentsDir = env.TEAMAX_AGENTS_DIR ?? path.join(env.HOME ?? '', 'Library', 'LaunchAgents')
  return {
    home: h, app: path.join(h, 'app'), data: path.join(h, 'data'), team: path.join(h, 'team'), tls: path.join(h, 'tls'),
    config: path.join(h, 'config'), env: path.join(h, 'config', 'office.env'), serverJson: path.join(h, 'config', 'server.json'),
    logs: path.join(h, 'logs'), serverLogs: path.join(h, 'logs', 'server'), officeLog: path.join(h, 'logs', 'office.log'),
    info: path.join(h, 'ADDRESSES.txt'), card: path.join(h, 'DESK-CARD.html'), setupToken: path.join(h, 'data', 'setup-token'),
    agentsDir, plist: (label) => path.join(agentsDir, `${label}.plist`),
    tunnelToken: path.join(h, 'config', 'tunnel-token'), tunnelLog: path.join(h, 'logs', 'tunnel.log'),
  }
}

const KEY = /^TEAMAX_[A-Z_]+$/

/** KEY=VALUE lines (no quotes, no expansion); comments and blank lines skipped, other keys ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const i = line.indexOf('=')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    if (KEY.test(k)) out[k] = line.slice(i + 1)
  }
  return out
}

function port(v: string | undefined, def: number, name: string, allowZero = false): number {
  if (v === undefined || v === '') return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 65535) throw new Error(`${name} must be a port number (got ${v})`)
  return n
}

export function settingsFrom(home: string, e: Record<string, string>): OfficeSettings {
  const lanPort = port(e.TEAMAX_LAN_PORT, DEFAULT_LAN_PORT, 'TEAMAX_LAN_PORT')
  const s: OfficeSettings = {
    home: path.resolve(home),
    label: e.TEAMAX_LABEL || DEFAULT_LABEL,
    appPort: port(e.TEAMAX_APP_PORT, DEFAULT_APP_PORT, 'TEAMAX_APP_PORT'),
    lanPort,
    helperPort: port(e.TEAMAX_HELPER_PORT, helperDefault(lanPort), 'TEAMAX_HELPER_PORT', true),
    runDir: e.TEAMAX_RUN_DIR ? path.resolve(e.TEAMAX_RUN_DIR) : null,
    claudeBin: e.TEAMAX_CLAUDE_BIN || null,
    codexBin: e.TEAMAX_CODEX_BIN || null,
    caConstraints: e.TEAMAX_CA_CONSTRAINTS !== '0',
    includeVpn: e.TEAMAX_INCLUDE_VPN === '1',
    allowFrom: parseAllowFrom(e.TEAMAX_ALLOW_FROM),
    publicHost: parsePublicHost(e.TEAMAX_PUBLIC_HOST),
    publicAllowFrom: (() => { const a = parseAllowFrom(e.TEAMAX_PUBLIC_ALLOW_FROM); return Array.isArray(a) ? a : [] })(),
    publicCountries: parseCountries(e.TEAMAX_PUBLIC_COUNTRIES),
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,100}$/.test(s.label)) throw new Error(`TEAMAX_LABEL ${s.label} is not a launchd label`)
  const ports = [s.appPort, s.lanPort, ...(s.helperPort ? [s.helperPort] : [])]
  if (new Set(ports).size !== ports.length) throw new Error('TEAMAX_APP_PORT, TEAMAX_LAN_PORT and TEAMAX_HELPER_PORT must differ')
  return s
}

const CIDR = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/

/** TEAMAX_PUBLIC_HOST: '' = none, else a DNS name (lower-cased; a pasted https://…/ is reduced to the name). */
export function parsePublicHost(v: string | undefined): string | null {
  let t = (v ?? '').trim().toLowerCase()
  if (!t) return null
  t = t.replace(/^https:\/\//, '').replace(/\/+$/, '').replace(/\.$/, '')
  if (!PUBLIC_HOST_RE.test(t)) throw new Error(`TEAMAX_PUBLIC_HOST: ${v} is not an internet name such as app.example.com`)
  return t
}

/** TEAMAX_PUBLIC_COUNTRIES: '' = anywhere, else comma-separated two-letter codes (KR,JP). */
export function parseCountries(v: string | undefined): string[] {
  const list = (v ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
  for (const c of list) if (!/^[A-Z]{2}$/.test(c)) throw new Error(`TEAMAX_PUBLIC_COUNTRIES: ${c} is not a two-letter country code (KR)`)
  return list
}

/** TEAMAX_ALLOW_FROM: '' / 'subnet', 'any', or comma-separated IPv4 CIDRs (192.168.1.0/24,10.20.0.0/16). */
export function parseAllowFrom(v: string | undefined): OfficeSettings['allowFrom'] {
  const t = (v ?? '').trim()
  if (!t || t === 'subnet') return 'subnet'
  if (t === 'any') return 'any'
  const list = t.split(',').map((x) => x.trim()).filter(Boolean)
  for (const c of list) {
    const m = CIDR.exec(c)
    if (!m || m[1]!.split('.').some((o) => Number(o) > 255) || Number(m[2]) > 32) throw new Error(`TEAMAX_ALLOW_FROM: ${c} is not an IPv4 CIDR (a.b.c.d/n)`)
  }
  return list
}

/** [network, mask] → a.b.c.d/n */
export function cidr([base, mask]: [string, string]): string {
  const bits = mask.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0)
  return `${base}/${bits}`
}

export function loadSettings(home: string): OfficeSettings {
  const p = officePaths(home)
  let text = ''
  try { text = fs.readFileSync(p.env, 'utf8') } catch {}
  return settingsFrom(home, parseEnvFile(text))
}

export function settingsText(s: OfficeSettings): string {
  const line = (k: string, v: string | number | null) => `${k}=${v ?? ''}`
  return [
    '# Team AX office mode settings (docs/OFFICE.md). Written by office-install.sh; edit, then `teamax restart`.',
    line('TEAMAX_LABEL', s.label),
    line('TEAMAX_APP_PORT', s.appPort),
    line('TEAMAX_LAN_PORT', s.lanPort),
    line('TEAMAX_HELPER_PORT', s.helperPort),
    line('TEAMAX_RUN_DIR', s.runDir),
    line('TEAMAX_CLAUDE_BIN', s.claudeBin),
    line('TEAMAX_CODEX_BIN', s.codexBin),
    line('TEAMAX_CA_CONSTRAINTS', s.caConstraints ? 1 : 0),
    line('TEAMAX_INCLUDE_VPN', s.includeVpn ? 1 : 0),
    line('TEAMAX_ALLOW_FROM', Array.isArray(s.allowFrom) ? s.allowFrom.join(',') : s.allowFrom),
    '# internet address through a Cloudflare Tunnel (teamax public-address set|off); empty = none',
    line('TEAMAX_PUBLIC_HOST', s.publicHost),
    '# optional: who may use the internet address (IPv4 CIDRs, two-letter countries); empty = anyone',
    line('TEAMAX_PUBLIC_ALLOW_FROM', s.publicAllowFrom.join(',')),
    line('TEAMAX_PUBLIC_COUNTRIES', s.publicCountries.join(',')),
    '',
  ].join('\n')
}

/** the second LaunchAgent (cloudflared) of an installation */
export const tunnelLabel = (s: Pick<OfficeSettings, 'label'>) => `${s.label}.tunnel`

/** https://<public host>, or null */
export const publicOrigin = (s: Pick<OfficeSettings, 'publicHost'>) => s.publicHost ? `https://${s.publicHost}` : null

/** The engine socket folder: <home>/data/run unless that is too long for a unix socket path. */
export function runDirFor(s: OfficeSettings): string {
  return s.runDir ?? path.join(officePaths(s.home).data, 'run')
}

/** Every https origin of the certificate, best first: IPv4 addresses (the clinic sets a DHCP reservation), then
 * <host>.local (the certificate carries no bare host name, tls.ts). `shown` keeps what the desks are told: the main
 * IPv4 address and <host>.local. */
export function deskOrigins(names: OfficeNames, lanPort: number, o: { shown?: boolean } = {}): string[] {
  const v4 = names.ips.filter((i) => !i.includes(':'))
  const local = names.dns.filter((d) => d.endsWith('.local'))
  const all = [...v4, ...local].map((n) => `https://${hostPort(n, lanPort)}`)
  if (!o.shown) return all
  const shown = [...v4.slice(0, 1), ...local].map((n) => `https://${hostPort(n, lanPort)}`)
  return shown.length ? shown : all
}

/** Host headers the server answers: every certificate name on the office port, localhost names on the app port.
 * The server also checks that a Host's port is the port of the listener it came in on (http/middleware.ts). */
export function allowedHosts(names: OfficeNames, s: Pick<OfficeSettings, 'lanPort' | 'appPort'>): string[] {
  const lan = [...names.dns, ...names.ips].map((n) => hostPort(n, s.lanPort))
  const local = ['localhost', '127.0.0.1'].map((n) => hostPort(n, s.appPort))
  return [...new Set([...lan, ...local])]
}

/** Socket peers the office port answers (allowedPeers): the Mac's office subnets by default (a VPN peer, e.g. on
 * Tailscale, reaches the listener on 0.0.0.0 but gets 403), every address with 'any', or the listed CIDRs. */
export function allowedPeers(s: Pick<OfficeSettings, 'allowFrom'>, subnets: [string, string][]): string[] {
  if (s.allowFrom === 'any') return []
  if (Array.isArray(s.allowFrom)) return s.allowFrom
  // no office subnet known (not connected): the private ranges, never "any"
  return (subnets.length ? subnets : [['10.0.0.0', '255.0.0.0'], ['172.16.0.0', '255.240.0.0'], ['192.168.0.0', '255.255.0.0']] as [string, string][]).map(cidr)
}

/** config/server.json for this installation: dev mode's engine setup (local-login, engine.sb, lockdown) with
 * office: true, plain HTTP on 127.0.0.1 only, TLS on 0.0.0.0 (IPv4) for the desks of the office subnet, and the
 * internet address (tunnel) when one is set: cloudflared delivers it to the loopback app port. Codex is
 * off (codexBin ''): the clinic's data goes to one AI provider, Anthropic, as the guide says. */
export function serverConfig(s: OfficeSettings, names: OfficeNames, subnets: [string, string][] = []) {
  const p = officePaths(s.home)
  const origins = deskOrigins(names, s.lanPort)
  return {
    mode: 'dev' as const,
    office: true,
    listen: { host: '127.0.0.1', port: s.appPort },
    tls: { host: '0.0.0.0', port: s.lanPort, certFile: path.join(p.tls, 'server.crt'), keyFile: path.join(p.tls, 'server.key') },
    // the internet address first: invite and reset links made on the Mac point there (no certificate to install)
    publicOrigins: [...(s.publicHost ? [`https://${s.publicHost}`] : []), ...origins, `http://localhost:${s.appPort}`, `http://127.0.0.1:${s.appPort}`],
    tunnel: s.publicHost ? { host: s.publicHost, allowFrom: s.publicAllowFrom, countries: s.publicCountries } : null,
    allowedHosts: allowedHosts(names, s),
    allowedPeers: allowedPeers(s, subnets),
    teamRoot: p.team,
    dataDir: p.data,
    logDir: p.serverLogs,
    logLevel: 'info' as const,
    validateResponses: false,
    engine: {
      authMode: 'local-login' as const,
      ...(s.claudeBin ? { claudeBin: s.claudeBin } : {}),
      codexBin: s.codexBin ?? '',
      runDir: runDirFor(s),
    },
    relay: { url: null, teamName: null },
  }
}
