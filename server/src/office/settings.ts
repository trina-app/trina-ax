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
//     logs/                    office.log (supervisor + launchd), server/ (the server's JSON logs, 14 days)
//     status/                  status.json of the running server
//     teamax                   the control command (link to app/teamax)
import fs from 'node:fs'
import path from 'node:path'
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
}

export interface OfficePaths {
  home: string; app: string; data: string; team: string; tls: string; config: string; env: string; serverJson: string
  logs: string; serverLogs: string; officeLog: string; info: string; setupToken: string; agentsDir: string; plist: (label: string) => string
}

export function officePaths(home: string, env: Record<string, string | undefined> = process.env): OfficePaths {
  const h = path.resolve(home)
  const agentsDir = env.TEAMAX_AGENTS_DIR ?? path.join(env.HOME ?? '', 'Library', 'LaunchAgents')
  return {
    home: h, app: path.join(h, 'app'), data: path.join(h, 'data'), team: path.join(h, 'team'), tls: path.join(h, 'tls'),
    config: path.join(h, 'config'), env: path.join(h, 'config', 'office.env'), serverJson: path.join(h, 'config', 'server.json'),
    logs: path.join(h, 'logs'), serverLogs: path.join(h, 'logs', 'server'), officeLog: path.join(h, 'logs', 'office.log'),
    info: path.join(h, 'ADDRESSES.txt'), setupToken: path.join(h, 'data', 'setup-token'),
    agentsDir, plist: (label) => path.join(agentsDir, `${label}.plist`),
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
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,100}$/.test(s.label)) throw new Error(`TEAMAX_LABEL ${s.label} is not a launchd label`)
  const ports = [s.appPort, s.lanPort, ...(s.helperPort ? [s.helperPort] : [])]
  if (new Set(ports).size !== ports.length) throw new Error('TEAMAX_APP_PORT, TEAMAX_LAN_PORT and TEAMAX_HELPER_PORT must differ')
  return s
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
    '',
  ].join('\n')
}

/** The engine socket folder: <home>/data/run unless that is too long for a unix socket path. */
export function runDirFor(s: OfficeSettings): string {
  return s.runDir ?? path.join(officePaths(s.home).data, 'run')
}

/** Every https origin of the certificate, best first: IPv4 addresses (the clinic sets a DHCP reservation),
 * <host>.local, the bare host name, IPv6. `shown` keeps what a desk can normally type and reach (IPv4, .local). */
export function deskOrigins(names: OfficeNames, lanPort: number, o: { shown?: boolean } = {}): string[] {
  const v4 = names.ips.filter((i) => !i.includes(':'))
  const v6 = names.ips.filter((i) => i.includes(':'))
  const local = names.dns.filter((d) => d.endsWith('.local'))
  const bare = names.dns.filter((d) => !d.endsWith('.local'))
  const all = [...v4, ...local, ...bare, ...v6].map((n) => `https://${hostPort(n, lanPort)}`)
  if (!o.shown) return all
  const shown = [...v4, ...local].map((n) => `https://${hostPort(n, lanPort)}`)
  return shown.length ? shown : all
}

/** Host headers the server answers: every certificate name on the office port, localhost names on the app port. */
export function allowedHosts(names: OfficeNames, s: Pick<OfficeSettings, 'lanPort' | 'appPort'>): string[] {
  const lan = [...names.dns, ...names.ips].map((n) => hostPort(n, s.lanPort))
  const local = ['localhost', '127.0.0.1'].map((n) => hostPort(n, s.appPort))
  return [...new Set([...lan, ...local])]
}

/** config/server.json for this installation: dev mode's engine setup (local-login, engine.sb, lockdown) with
 * office: true, plain HTTP on 127.0.0.1 only, TLS on every interface (IPv4 and IPv6) for the desks. */
export function serverConfig(s: OfficeSettings, names: OfficeNames) {
  const p = officePaths(s.home)
  const origins = deskOrigins(names, s.lanPort)
  return {
    mode: 'dev' as const,
    office: true,
    listen: { host: '127.0.0.1', port: s.appPort },
    tls: { host: '::', port: s.lanPort, certFile: path.join(p.tls, 'server.crt'), keyFile: path.join(p.tls, 'server.key') },
    publicOrigins: [...origins, `http://localhost:${s.appPort}`, `http://127.0.0.1:${s.appPort}`],
    allowedHosts: allowedHosts(names, s),
    teamRoot: p.team,
    dataDir: p.data,
    logDir: p.serverLogs,
    logLevel: 'info' as const,
    validateResponses: false,
    engine: {
      authMode: 'local-login' as const,
      ...(s.claudeBin ? { claudeBin: s.claudeBin } : {}),
      ...(s.codexBin ? { codexBin: s.codexBin } : {}),
      runDir: runDirFor(s),
    },
    relay: { url: null, teamName: null },
  }
}
