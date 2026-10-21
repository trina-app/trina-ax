// Office mode (docs/OFFICE.md): one Mac in a clinic or small office runs Team AX for the desks on its network, as
// the signed-in macOS user, with that Mac's own Claude Code login (dev mode's engine setup: local-login, engine.sb
// sandbox, the permission function, the engine lockdown). Bundled as app/server/src/office.js by
// scripts/build-office.ts and run by app/bin/bun; `~/TeamAX/teamax <command>` is the short way to call it.
//
//   run                 the supervisor (the LaunchAgent runs this): office TLS, config/server.json, the server, the
//                       helper page; re-checks the Mac's addresses every 30 s and restarts the server with a new
//                       certificate when one appeared
//   configure [--label L] [--app-port N] [--lan-port N] [--helper-port N|0] [--run-dir D] [--claude-bin P]
//             [--codex-bin P] [--ca-constraints 0|1] [--public-host H|''] [--tunnel-token-file F]
//             [--public-allow-from CIDR,…] [--public-countries KR,…]
//                       write config/office.env (merged with what is there); --tunnel-token-file checks the
//                       Cloudflare Tunnel connector token and copies it to config/tunnel-token (600)
//   install [--no-open] write the LaunchAgent, (re)start it, wait until it answers, print the addresses and the
//                       first-run setup link (and open it on this Mac)
//   start | stop | restart | status | logs [n] | info | card | setup-link
//   check-ports                    are the app, office and certificate-page ports free? (office-install.sh)
//   reset-link [--username U]      one-time password reset link (24 h) for the owner or a member
//   backup                         a backup now (the same as the nightly one, on this Mac's disk)
//   archive --out FILE             encrypted copy of the database + team folder for an external disk (password on stdin)
//   restore-archive --in FILE [--replace]
//                                  put an archive's database and team folder in place (password on stdin); without
//                                  --replace only into an installation where nobody has set up the team yet. Every
//                                  sign-in ends (everyone signs in again) and unused invite / reset links are gone
//   public-address set HOST TOKEN-FILE | off | status
//                                  the internet address through a Cloudflare Tunnel (docs/OFFICE.md "인터넷 주소"):
//                                  the token goes to config/tunnel-token, cloudflared runs as a second LaunchAgent
//                                  (<label>.tunnel), the server answers https://HOST. The tunnel itself (DNS, ingress)
//                                  is made on the owner's Mac with scripts/office/public-address.ts
//   desktop list | add FILE [--version V] [--keep] | remove FILE
//           | add-from DIR... [--fallback DIR] [--manifest FILE] [--dry-run]
//                                  the desktop app installers members download under Settings → Apps (data/downloads,
//                                  ./desktop.ts); add-from offers the newest Team-AX-Setup-*-x64.exe / Team-AX-*-mac*.dmg
//                                  found in the folders (office-install.sh runs it; a --fallback folder only after a
//                                  yes on the terminal; with the bundle's desktop.sha256 only the files it lists).
//                                  No restart needed.
//   update [status|check|now|pause|resume|channel stable|beta|time HH:MM|run]
//                                  automatic updates (./update-cli.ts, docs/OFFICE.md "자동 업데이트"): the third
//                                  LaunchAgent (<label>.update) checks https://updates.treesoop.com every night
//   uninstall-agent                stop and remove the LaunchAgents (office-uninstall.sh)
// Every command takes --home <dir> (default: the folder above app/).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { endSessions } from '../system/backup'
import { launchAgent, plist } from '../../../scripts/dev-service'
import { REPO_ROOT } from '../app-config'
import { peerAllowed } from '../http/middleware'
import {
  addInstaller, findInstallers, listInstallers, MANIFEST, planAdd, platformOf, platformWord, readManifest, removeInstaller, sha256File, 
  sizeText, versionFromName, type AddPlan, type AddResult, type DownloadItem, type Found, type Signature,
} from './desktop'
import { deskCard, helperFetch, windowsThumbprint, type HelperState } from './helper'
import { deskOrigins, loadSettings, MAX_RUN_DIR, officePaths, parseEnvFile, publicOrigin, runDirFor, serverConfig, settingsFrom, settingsText, tunnelLabel, type OfficeSettings } from './settings'
import { ensureOfficeTls, fingerprints, lanInfo, localHostName, type LanInfo } from './tls'
import { reloadMarkedUpdateAgent, removeUpdateAgent, syncUpdateAgent, updateCommand } from './update-cli'
import { updateView } from './update'

const CHECK_MS = 30_000
const TLS_RECHECK_MS = 6 * 3600_000
const STOP_GRACE_MS = 12_000

/** the desk addresses people type: https://<IPv4>:port and https://<host>.local:port */
const SHOWN = /^https:\/\/(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+\.local):\d+$/i

const say = (s: string) => console.log(`${new Date().toISOString()} [office] ${s}`)

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/** <home> = the folder above app/ when running from a bundle (app/server/src/office.js). */
export function defaultHome(): string | null {
  const app = REPO_ROOT
  return fs.existsSync(path.join(app, 'teamax')) && path.basename(app) === 'app' ? path.dirname(app) : null
}

function mainScript(): string {
  for (const f of [path.join(import.meta.dir, 'main.js'), path.join(import.meta.dir, '..', 'main.ts')]) if (fs.existsSync(f)) return f
  throw new Error('server entry point (main.js) not found next to office.js')
}

function webDist(): string | null {
  const d = path.join(REPO_ROOT, 'web', 'dist')
  return fs.existsSync(path.join(d, 'index.html')) ? d : null
}

// ---- state shared by `run` and the commands -------------------------------------------------------------------

interface Prepared { settings: OfficeSettings; origins: string[]; helper: HelperState; peers: string[]; changed: boolean; reason: string | null; left: string[]; key: string }

/** Certificates for the addresses the Mac has now, config/server.json, ADDRESSES.txt, DESK-CARD.html. `changed` =
 * the running server must restart (a new certificate, or server.json changed: new subnet, settings). Tests pass
 * `addrs` / `subnets` instead of this Mac's interfaces. */
export function prepare(home: string, o: { addrs?: string[]; subnets?: [string, string][]; host?: string | null } = {}): Prepared {
  const s = loadSettings(home)
  const p = officePaths(home)
  for (const d of [p.data, p.team, p.tls, p.config]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700) }
  fs.mkdirSync(p.serverLogs, { recursive: true, mode: 0o750 })
  const host = o.host === undefined ? localHostName() : o.host
  const lan: LanInfo = o.addrs ? { addrs: o.addrs, subnets: o.subnets ?? [] } : lanInfo({ includeVpn: s.includeVpn })
  const t = ensureOfficeTls(p.tls, { host, addrs: lan.addrs, subnets: lan.subnets, constraints: s.caConstraints })
  const cfg = serverConfig(s, t.names, lan.subnets)
  const json = JSON.stringify(cfg, null, 2) + '\n'
  let before = ''
  try { before = fs.readFileSync(p.serverJson, 'utf8') } catch {}
  const tmp = `${p.serverJson}.tmp-${process.pid}`
  fs.writeFileSync(tmp, json, { mode: 0o600 })
  fs.renameSync(tmp, p.serverJson)
  const fp = fingerprints(t.ca)
  const origins = deskOrigins(t.names, s.lanPort, { shown: true })
  const helper: HelperState = {
    caPem: fs.readFileSync(path.join(p.tls, 'ca.crt'), 'utf8'), caDer: new Uint8Array(t.ca.raw), sha256: fp.sha256, sha1: fp.sha1,
    origins, caName: /CN=([^\n]+)/.exec(t.ca.subject)?.[1] ?? 'Team AX office CA',
  }
  fs.writeFileSync(p.info, infoText(s, helper, t.left), { mode: 0o644 })
  fs.writeFileSync(p.card, deskCard(helper, { helper: helperOrigins(s, origins)[0] ?? null, caCer: path.join(p.tls, 'ca.cer'), made: new Date().toISOString().slice(0, 16).replace('T', ' '), public: publicOrigin(s) }), { mode: 0o644 })
  const configChanged = !!before && before !== json
  return {
    settings: s, origins, helper, peers: cfg.allowedPeers, left: t.left, key: JSON.stringify([host, lan]),
    changed: t.changed || configChanged, reason: t.reason ?? (configChanged ? 'server.json changed (office subnet or settings)' : null),
  }
}

export function helperOrigins(s: OfficeSettings, origins: string[]): string[] {
  if (!s.helperPort) return []
  return origins.map((o) => { const u = new URL(o); u.protocol = 'http:'; u.port = String(s.helperPort); return u.origin })
}

export function infoText(s: OfficeSettings, h: HelperState, left: string[] = []): string {
  const helpers = helperOrigins(s, h.origins)
  const p = officePaths(s.home)
  const pub = publicOrigin(s)
  return [
    `Team AX 사무실 모드 / office mode — ${new Date().toISOString()}`,
    '',
    ...(pub ? [
      '인터넷 주소 (인증서 설치 필요 없음, 어디서나) / internet address (no certificate to install, from anywhere):',
      `  ${pub}`,
      '',
      '사무실 안 대체 경로 (사무실 인증서를 설치한 데스크) / in-office fallback (desks with the office certificate):',
    ] : ['데스크(윈도우 Edge·Chrome)에서 여는 주소 / address for the desks:']),
    ...h.origins.slice(0, 1).map((o) => `  ${o}`),
    ...(h.origins.length > 1 ? [`  (이름으로 / by name: ${h.origins.slice(1).join(', ')})`] : []),
    '',
    helpers.length ? '처음 한 번, 인증서 받는 곳 / first time: certificate page (http://)' : '인증서 페이지 꺼짐 (TEAMAX_HELPER_PORT=0): 아래 ca.cer 를 USB로 나눠 주세요',
    ...helpers.slice(0, 1).map((o) => `  ${o}`),
    `  또는 USB로 / or on a USB stick: ${path.join(p.tls, 'ca.cer')}`,
    '',
    '인증서 지문: 데스크에서 설치 전에 이 값과 비교 (인증서 → 자세히 → 지문)',
    'certificate thumbprint: the desks compare it before installing (certificate → Details → Thumbprint)',
    `  ${windowsThumbprint(h.sha1)}`,
    `  SHA-256 ${h.sha256}`,
    `인쇄용 데스크 카드 / printable desk card: ${p.card}   (${path.join(p.home, 'teamax')} card)`,
    '',
    `이 맥에서 / on this Mac: http://localhost:${s.appPort}`,
    ...(left.length ? ['', `인증서에 넣지 않은 주소 (사무실 대역 밖) / left out (outside the office subnet): ${left.join(', ')}`] : []),
    '',
  ].join('\n')
}

// ---- the supervisor --------------------------------------------------------------------------------------------

export async function run(home: string): Promise<never> {
  const p = officePaths(home)
  let st = prepare(home)
  let lastTls = Date.now()
  const s = st.settings
  say(`home ${p.home}; desks: ${st.origins.join('  ')}${st.changed ? ` (new server certificate: ${st.reason})` : ''}`)
  if (st.left.length) say(`left out of the certificate (not private addresses): ${st.left.join(', ')}`)
  if (runDirFor(s).length > MAX_RUN_DIR) say(`warning: engine socket folder ${runDirFor(s)} is long; set TEAMAX_RUN_DIR if chats fail with "bind: invalid argument"`)

  let helperState = st.helper
  let helperPeers = st.peers
  let helper: ReturnType<typeof Bun.serve> | null = null
  const startHelper = () => {
    if (!s.helperPort || helper) return
    try {
      // the same peers as the office port (the office subnet): a VPN peer gets nothing here either
      helper = Bun.serve({
        hostname: '0.0.0.0', port: s.helperPort, maxRequestBodySize: 1024,
        fetch: (req, server) => peerAllowed(server.requestIP(req)?.address, helperPeers) // IPv4 listener: plain a.b.c.d
          ? helperFetch(req, helperState)
          : new Response('Forbidden\n', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
      })
      say(`certificate page on port ${s.helperPort}`)
    } catch (e) {
      say(`certificate page not started (port ${s.helperPort}): ${(e as Error).message}; retrying in ${CHECK_MS / 1000} s`)
    }
  }
  startHelper()

  let child: ReturnType<typeof Bun.spawn> | null = null
  let stopping = false
  let restarting = false
  let failures = 0
  let startedAt = 0
  const env: Record<string, string> = { ...(process.env as Record<string, string>), MYCEL_CONFIG: p.serverJson }
  delete env.MYCEL_MODE
  const dist = webDist()
  if (dist) env.MYCEL_WEB_DIST = dist
  const spawnServer = () => {
    startedAt = Date.now()
    child = Bun.spawn([process.execPath, mainScript(), '--config', p.serverJson], { cwd: p.home, env, stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' })
    const me = child
    say(`server started (pid ${me.pid})`)
    void me.exited.then(async (code) => {
      if (stopping || restarting || child !== me) return
      failures = Date.now() - startedAt > 60_000 ? 1 : failures + 1
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))
      say(`server exited (${code}); starting it again in ${wait / 1000} s (see ${p.serverLogs})`)
      await Bun.sleep(wait)
      if (!stopping && child === me) spawnServer()
    })
  }
  const stopServer = async () => {
    const c = child
    if (!c) return
    c.kill('SIGTERM')
    const done = await Promise.race([c.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)])
    if (!done) { c.kill('SIGKILL'); await c.exited }
  }
  spawnServer()

  const check = async () => {
    if (stopping || restarting) return
    startHelper()
    try { const r = reloadMarkedUpdateAgent(s); if (r) say(r) } catch (e) { say(`update agent reload failed: ${(e as Error).message}`) }
    const host = localHostName()
    const lan = lanInfo({ includeVpn: s.includeVpn })
    const key = JSON.stringify([host, lan])
    if (key === st.key && Date.now() - lastTls < TLS_RECHECK_MS) return
    try {
      const next = prepare(home, { addrs: lan.addrs, subnets: lan.subnets, host })
      lastTls = Date.now()
      st = next
      helperState = next.helper
      helperPeers = next.peers
      if (!next.changed) return
      say(`new server certificate (${next.reason}); restarting the server. desks: ${next.origins.join('  ')}`)
      restarting = true
      try { await stopServer(); spawnServer() } finally { restarting = false }
    } catch (e) {
      say(`address check failed: ${(e as Error).message}`)
    }
  }
  const timer = setInterval(() => void check(), CHECK_MS)

  const shutdown = async (sig: string) => {
    if (stopping) return
    stopping = true
    say(`stopping (${sig})`)
    clearInterval(timer)
    helper?.stop(true)
    await stopServer()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  return await new Promise<never>(() => {})
}

// ---- commands ----------------------------------------------------------------------------------------------------

/** config/office.env merged with command-line choices (configure). */
export function configure(home: string, args: string[], env: Record<string, string | undefined> = process.env): OfficeSettings {
  const p = officePaths(home, env)
  let cur: Record<string, string> = {}
  try { cur = parseEnvFile(fs.readFileSync(p.env, 'utf8')) } catch {}
  const flags: [string, string][] = [
    ['--label', 'TEAMAX_LABEL'], ['--app-port', 'TEAMAX_APP_PORT'], ['--lan-port', 'TEAMAX_LAN_PORT'], ['--helper-port', 'TEAMAX_HELPER_PORT'],
    ['--run-dir', 'TEAMAX_RUN_DIR'], ['--claude-bin', 'TEAMAX_CLAUDE_BIN'], ['--codex-bin', 'TEAMAX_CODEX_BIN'], ['--ca-constraints', 'TEAMAX_CA_CONSTRAINTS'],
    ['--public-host', 'TEAMAX_PUBLIC_HOST'], ['--public-allow-from', 'TEAMAX_PUBLIC_ALLOW_FROM'], ['--public-countries', 'TEAMAX_PUBLIC_COUNTRIES'],
  ]
  for (const [f, k] of flags) { const v = arg(args, f); if (v !== undefined) cur[k] = v }
  // a new LAN port moves the helper page along with it unless it was chosen explicitly
  if (arg(args, '--lan-port') !== undefined && arg(args, '--helper-port') === undefined) delete cur.TEAMAX_HELPER_PORT
  const s = settingsFrom(home, cur)
  // --as-home: the folder the settings are meant for (office-install.sh --check-only writes them into a scratch one)
  const sock = path.join(runDirFor({ ...s, home: path.resolve(arg(args, '--as-home') ?? home) }), 'private', 'server.sock')
  if (Buffer.byteLength(sock) > 103) throw new Error(`the engine socket path ${sock} is longer than macOS allows (103 bytes): install into a shorter folder or pass --run-dir <short folder>`)
  const tokenFile = arg(args, '--tunnel-token-file')
  const token = tokenFile ? readTunnelToken(tokenFile) : null
  if (tokenFile && !s.publicHost) throw new Error('--tunnel-token-file needs --public-host <name> (the internet address this tunnel serves)')
  fs.mkdirSync(p.config, { recursive: true, mode: 0o700 })
  fs.writeFileSync(p.env, settingsText(s), { mode: 0o600 })
  if (token) writeSecret(p.tunnelToken, token)
  return s
}

/**
 * A Cloudflare Tunnel connector token from a file (what `public-address.ts` writes, or the dashboard's "token"): one
 * base64 line of {"a": account, "t": tunnel id, "s": secret}. Checked so a wrong file (the origin cert, a token with
 * a line break inside) fails here and not as a connector that never connects. The token is never printed.
 */
export function readTunnelToken(file: string): string {
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { throw new Error(`tunnel token file ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`) }
  const t = raw.trim()
  let ok = false
  if (/^[A-Za-z0-9+/_=-]{40,4096}$/.test(t)) {
    try {
      const j = JSON.parse(Buffer.from(t, 'base64').toString('utf8')) as Record<string, unknown>
      ok = typeof j.a === 'string' && typeof j.t === 'string' && /^[0-9a-f-]{36}$/i.test(j.t) && typeof j.s === 'string' && j.s.length >= 16
    } catch {}
  }
  if (!ok) throw new Error(`${file} is not a Cloudflare Tunnel connector token (one line, made by scripts/office/public-address.ts)`)
  return t
}

/** tunnel id inside a connector token (for status lines; the secret is never shown) */
export function tunnelIdOf(token: string): string | null {
  try { const j = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as { t?: unknown }; return typeof j.t === 'string' ? j.t : null } catch { return null }
}

/** write a secret file with mode 600 from the start (temporary file + rename) */
function writeSecret(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.rmSync(tmp, { force: true })
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, file)
  fs.chmodSync(file, 0o600)
}

async function answers(url: string, timeoutMs = 2000): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs), tls: { rejectUnauthorized: false } } as RequestInit)).ok } catch { return false }
}

function agentPath(s: OfficeSettings): string {
  const dirs = [path.join(s.home, 'app', 'bin')]
  for (const b of [s.claudeBin, s.codexBin]) if (b) dirs.push(path.dirname(b))
  dirs.push(path.join(os.homedir(), '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin')
  return [...new Set(dirs)].join(':')
}

export function agentPlist(s: OfficeSettings, bun: string): string {
  const p = officePaths(s.home)
  return plist({
    bun, root: s.home, path: agentPath(s), home: os.homedir(), log: p.officeLog, label: s.label,
    args: [path.join(s.home, 'app', 'server', 'src', 'office.js'), 'run', '--home', s.home],
    env: { TEAMAX_HOME: s.home },
  })
}

/** the cloudflared LaunchAgent: app/bin/cloudflared, the connector token read from config/tunnel-token (never on the
 * command line or in the plist), no self-update (the zip pins its version), metrics only on loopback, no remote
 * diagnostics, kept alive by launchd. */
export function tunnelPlist(s: OfficeSettings, cloudflared = path.join(s.home, 'app', 'bin', 'cloudflared')): string {
  const p = officePaths(s.home)
  return plist({
    bun: cloudflared, root: s.home, path: '/usr/bin:/bin:/usr/sbin:/sbin', home: os.homedir(), log: p.tunnelLog, label: tunnelLabel(s),
    args: ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', '--management-diagnostics=false', 'run', '--token-file', p.tunnelToken],
  })
}

function setupLinks(s: OfficeSettings, origins: string[]): { local: string; desk: string | null } | null {
  let token = ''
  try { token = fs.readFileSync(officePaths(s.home).setupToken, 'utf8').trim() } catch {}
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(token)) return null
  return { local: `http://localhost:${s.appPort}/setup?token=${token}`, desk: origins[0] ? `${origins[0]}/setup?token=${token}` : null }
}

async function waitHealthy(s: OfficeSettings, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (await answers(`http://127.0.0.1:${s.appPort}/api/health`, 1500)) return true
    await Bun.sleep(1000)
  }
  return false
}

/** accounts.js / admin.js of this bundle (or the sources in a checkout) with this installation's config */
function runTool(home: string, tool: 'accounts' | 'admin', args: string[], stdin: 'inherit' | 'ignore' = 'ignore', onJson?: (j: Record<string, unknown>) => string): number {
  const p = officePaths(home)
  const src = tool === 'accounts' ? ['accounts.js', path.join('..', 'auth', 'cli.ts')] : ['admin.js', path.join('..', 'system', 'cli.ts')]
  const file = src.map((f) => path.join(import.meta.dir, f)).find((f) => fs.existsSync(f))
  if (!file) throw new Error(`${src[0]} missing from this bundle`)
  const r = Bun.spawnSync([process.execPath, file, ...args], {
    cwd: p.home, stdin, stdout: onJson ? 'pipe' : 'inherit', stderr: 'inherit',
    env: { ...(process.env as Record<string, string>), MYCEL_CONFIG: p.serverJson, MYCEL_MODE: 'dev' },
  })
  if (onJson) {
    const out = r.stdout?.toString() ?? ''
    let j: Record<string, unknown> | null = null
    try { j = JSON.parse(out) } catch {}
    console.log(j ? onJson(j) : out.trim())
  }
  return r.exitCode ?? 1
}

const mb = (n: unknown) => typeof n === 'number' ? `${(n / 1024 / 1024).toFixed(1)} MB` : '?'

/** `teamax backup`: two lines instead of the backup's JSON */
export function backupSummary(j: Record<string, unknown>): string {
  const db = j.db as { size?: number } | undefined, team = j.team as { archiveSize?: number } | undefined
  return `백업을 만들었습니다 / backup made: ${j.id ?? '?'} (${j.createdAt ?? ''}; 데이터베이스 ${mb(db?.size)}, 팀 폴더 ${mb(team?.archiveSize)})\n` +
    '  관리자 > 시스템 > 백업에 보이고, 이 맥의 디스크에 있습니다. 외장 디스크로는 / to an external disk: teamax archive <파일 / file>'
}

/** `teamax archive`: three lines instead of the archive's JSON */
export function archiveSummary(j: Record<string, unknown>): string {
  return `보관본을 만들었습니다 / archive written: ${j.file ?? '?'} (${mb(j.size)}, 팀 파일 ${j.files ?? '?'}개, ${j.encrypted ? '암호화됨 / encrypted' : '암호 없음 / not encrypted'})\n` +
    `  SHA-256 ${j.sha256 ?? '?'}\n  암호를 잊으면 복원할 수 없습니다 / without the password it cannot be restored.`
}

/** Is something listening on 127.0.0.1:port? */
async function listening(port: number): Promise<boolean> {
  try {
    const sock = await Promise.race([
      Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } }),
      Bun.sleep(800).then(() => null),
    ])
    sock?.end()
    return !!sock
  } catch { return false }
}

/** The ports this installation needs that another program holds. office-install.sh runs this after stopping its own
 * agent, so a port held by the previous version of this installation is free again. */
export async function portProblems(s: Pick<OfficeSettings, 'appPort' | 'lanPort' | 'helperPort'>): Promise<string[]> {
  const want: [number, string, string][] = [
    [s.appPort, '127.0.0.1', '--app-port'], [s.lanPort, '0.0.0.0', '--lan-port'],
    ...(s.helperPort ? [[s.helperPort, '0.0.0.0', '--helper-port'] as [number, string, string]] : []),
  ]
  const out: string[] = []
  for (const [port, hostname, flag] of want) {
    let busy = await listening(port)
    if (!busy) {
      try { Bun.listen({ hostname, port, socket: { data() {} } }).stop(true) } catch { busy = true }
    }
    if (busy) out.push(`port ${port} is in use by another program: choose another with ${flag} <port>${flag === '--app-port' ? ' (with an internet address, the owner then runs public-address.ts set <name> --port <that port> so the tunnel points at it)' : ''}`)
  }
  return out
}

/** the newest server log (logs/server/*.log, JSON lines) */
function newestServerLog(dir: string): string | null {
  try {
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile())
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    return files[0] ?? null
  } catch { return null }
}

/** Put a restored archive (<dir>/db/app.sqlite, <dir>/team) in place of data/app.db and team/. The previous ones
 * stay next to them as *.before-restore-<time>. Every sign-in ends (the same as the admin restore, endSessions):
 * a session ended after the archive was made must not work again. The engine session stashes (data/sessions)
 * belong to the replaced database and are moved aside too, so every chat starts fresh from the restored history. */
export function swapInRestore(home: string, restored: string, stamp = new Date().toISOString().replace(/[:.]/g, '-')): { db: string; team: string; sessions: string | null } {
  const p = officePaths(home)
  const db = path.join(p.data, 'app.db')
  const oldDb = `${db}.before-restore-${stamp}`
  const oldTeam = `${p.team}.before-restore-${stamp}`
  const incoming = path.join(restored, 'db', 'app.sqlite')
  endSessions(incoming) // before it is in place: a failure here leaves the current installation untouched
  if (fs.existsSync(db)) fs.renameSync(db, oldDb)
  for (const sfx of ['-wal', '-shm']) fs.rmSync(db + sfx, { force: true })
  fs.renameSync(incoming, db)
  fs.chmodSync(db, 0o600)
  if (fs.existsSync(p.team)) fs.renameSync(p.team, oldTeam)
  fs.renameSync(path.join(restored, 'team'), p.team)
  fs.chmodSync(p.team, 0o700)
  const stashes = path.join(p.data, 'sessions')
  let oldSessions: string | null = null
  if (fs.existsSync(stashes)) {
    oldSessions = `${stashes}.before-restore-${stamp}`
    try { fs.renameSync(stashes, oldSessions) } catch { fs.rmSync(stashes, { recursive: true, force: true }); oldSessions = null }
  }
  fs.rmSync(p.setupToken, { force: true })
  fs.rmSync(restored, { recursive: true, force: true })
  return { db: oldDb, team: oldTeam, sessions: oldSessions }
}

// ---- the internet address (cloudflared LaunchAgent) ---------------------------------------------------------

const tunnelAgentOf = (s: OfficeSettings) => launchAgent(tunnelLabel(s), officePaths(s.home).plist(tunnelLabel(s)))

/** Bring the cloudflared agent in line with the settings: (re)started with a public address and a token, stopped and
 * removed without one. Returns a line for the owner ('' when there is nothing to say). */
export async function syncTunnelAgent(s: OfficeSettings): Promise<string> {
  const p = officePaths(s.home)
  const ta = tunnelAgentOf(s)
  const file = p.plist(tunnelLabel(s))
  if (!s.publicHost) {
    const was = fs.existsSync(file) || ta.loaded()
    if (ta.loaded()) { ta.stop(); await Bun.sleep(500) }
    fs.rmSync(file, { force: true })
    return was ? '인터넷 주소 꺼짐 / internet address off (cloudflared stopped)' : ''
  }
  if (!fs.existsSync(p.tunnelToken)) return `인터넷 주소 ${s.publicHost}: 연결 토큰이 없습니다 / no connector token: ${path.join(s.home, 'teamax')} public-address set ${s.publicHost} <token file>`
  const cf = path.join(s.home, 'app', 'bin', 'cloudflared')
  if (!fs.existsSync(cf)) return `cloudflared is missing from ${path.dirname(cf)}: run office-install.sh from a newer zip`
  if (ta.loaded()) { ta.stop(); await Bun.sleep(1000) }
  fs.mkdirSync(p.logs, { recursive: true, mode: 0o750 })
  // a long outage can fill the log with "origin unreachable" lines: keep one older file
  try { if (fs.statSync(p.tunnelLog).size > 10 * 1024 * 1024) fs.renameSync(p.tunnelLog, `${p.tunnelLog}.1`) } catch {}
  fs.mkdirSync(p.agentsDir, { recursive: true })
  fs.writeFileSync(file, tunnelPlist(s, cf), { mode: 0o644 })
  return `cloudflared (${tunnelLabel(s)}): ${ta.start()}`
}

/** What https://<public host>/api/health says through Cloudflare: 'ok', 'origin' (502/504: the tunnel is connected but
 * its ingress does not reach this Mac's app port, e.g. the app port was changed at install and the owner's Mac still
 * points the tunnel at 47830), 'tunnel' (530: no connector of that tunnel is running, or the token belongs to
 * another tunnel), 'none' (no answer: DNS, no internet). */
export type PublicProbe = 'ok' | 'origin' | 'tunnel' | 'none'
export function classifyPublic(status: number | null): PublicProbe {
  if (status === null) return 'none'
  if (status >= 200 && status < 400) return 'ok'
  if (status === 502 || status === 504) return 'origin'
  if (status === 530) return 'tunnel'
  return 'none'
}
async function probePublic(host: string, timeoutMs = 4000): Promise<PublicProbe> {
  try { return classifyPublic((await fetch(`https://${host}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })).status) } catch { return 'none' }
}
const probeWord = (r: PublicProbe) => r === 'ok' ? 'answers' : r === 'origin' ? '502 (the tunnel points elsewhere)' : r === 'tunnel' ? '530 (no connector)' : 'no answer'

/** wait until https://<public host>/api/health answers through Cloudflare (the connector needs a few seconds) */
async function waitPublic(host: string, seconds: number): Promise<PublicProbe> {
  let last: PublicProbe = 'none'
  for (let i = 0; i < seconds; i += 2) {
    last = await probePublic(host)
    if (last === 'ok') return last
    await Bun.sleep(2000)
  }
  return last
}

/** the owner-facing explanation of a probe that did not answer (Korean, then the command) */
export function publicProblem(s: Pick<OfficeSettings, 'publicHost' | 'appPort'>, r: PublicProbe, tunnelLog: string): string {
  const h = s.publicHost
  if (r === 'origin') return [
    `https://${h} → 502: Cloudflare 터널은 연결됐지만 이 맥의 앱 포트(127.0.0.1:${s.appPort})가 아닌 곳을 가리킵니다 / the tunnel does not point at this Mac's app port.`,
    `  원장님 맥에서 / on the owner's Mac: bun scripts/office/public-address.ts set ${h} --port ${s.appPort} --cert <cert 파일>`,
    '  (이 맥에서는 다시 할 일이 없습니다 / nothing to redo on this Mac)',
  ].join('\n')
  if (r === 'tunnel') return [
    `https://${h} → 530: 이 이름의 터널에 연결된 cloudflared가 없습니다 (토큰이 다른 터널 것이거나 cloudflared가 멈춤) / no connector for this name's tunnel.`,
    `  확인 / check: ${tunnelLog} , teamax public-address status , 원장님 맥에서 public-address.ts status ${h}`,
  ].join('\n')
  return `https://${h}: 아직 답이 없습니다 / no answer yet: 이름(DNS)과 인터넷 연결을 확인하세요 (원장님 맥에서 public-address.ts status ${h}), ${tunnelLog}`
}

async function publicAddress(home: string, args: string[]): Promise<number> {
  const [sub = 'status', ...rest] = args.filter((a, i) => !(a === '--home' || args[i - 1] === '--home'))
  const say2 = (t: string) => { if (t) console.log(t) }
  if (sub === 'set') {
    const [host, tokenFile] = rest
    if (!host || !tokenFile) { console.error('usage: teamax public-address set <app.example.com> <connector token file>'); return 2 }
    const before = loadSettings(home)
    const s = configure(home, ['--public-host', host, '--tunnel-token-file', tokenFile])
    console.log(`인터넷 주소 / internet address: https://${s.publicHost}  (토큰 / token: ${officePaths(home).tunnelToken}, 600)`)
    console.log(`이 맥의 앱 포트 / this Mac's app port: ${s.appPort} (Cloudflare 터널이 http://127.0.0.1:${s.appPort}을 가리켜야 합니다 / the tunnel must point there)`)
    return (await applyPublicChange(s, before.publicHost !== s.publicHost)) ? 0 : 1
  }
  if (sub === 'off') {
    const before = loadSettings(home)
    const s = configure(home, ['--public-host', ''])
    fs.rmSync(officePaths(home).tunnelToken, { force: true })
    say2(await syncTunnelAgent(s))
    if (before.publicHost) await restartServer(s)
    console.log('인터넷 주소를 껐습니다 / internet address off. 사무실 안 주소는 그대로입니다 / the office addresses are unchanged.')
    const name = before.publicHost ?? '<name>'
    console.log(`Cloudflare 쪽 이름·터널 지우기 (원장님 맥에서) / remove the name and tunnel at Cloudflare (on the owner's Mac): bun scripts/office/public-address.ts remove ${name} --cert <cert 파일>`)
    return 0
  }
  if (sub === 'status') {
    const s = loadSettings(home)
    const p = officePaths(home)
    if (!s.publicHost) { console.log('인터넷 주소 없음 / no internet address (teamax public-address set <name> <token file>)'); return 0 }
    const ta = tunnelAgentOf(s)
    let id: string | null = null
    try { id = tunnelIdOf(readTunnelToken(p.tunnelToken)) } catch {}
    const probe = await probePublic(s.publicHost, 6000)
    console.log(`internet address  https://${s.publicHost}  ${probeWord(probe)}`)
    console.log(`  app port        127.0.0.1:${s.appPort} (the tunnel's ingress must be http://127.0.0.1:${s.appPort})`)
    console.log(`  token           ${id ? `tunnel ${id} (${p.tunnelToken})` : 'missing or not a connector token'}`)
    console.log(`  cloudflared     ${!fs.existsSync(p.plist(tunnelLabel(s))) ? 'not installed' : ta.loaded() ? `running${ta.pid() ? ` (pid ${ta.pid()})` : ''}` : 'stopped'}`)
    if (s.publicAllowFrom.length || s.publicCountries.length) console.log(`  allow-list      ${[...s.publicAllowFrom, ...s.publicCountries].join(', ')}`)
    console.log(`  log             ${p.tunnelLog}`)
    if (probe !== 'ok') console.log(publicProblem(s, probe, p.tunnelLog))
    return 0
  }
  console.error('usage: teamax public-address set <app.example.com> <token file> | off | status')
  return 2
}

/** the server reads the public address from server.json, which the supervisor writes at its start */
async function restartServer(s: OfficeSettings) {
  const agent = launchAgent(s.label, officePaths(s.home).plist(s.label))
  if (!fs.existsSync(officePaths(s.home).plist(s.label))) return
  if (agent.loaded()) { agent.stop(); await Bun.sleep(1000) }
  console.log(`Team AX: ${agent.start()}`)
  if (!(await waitHealthy(s, 90))) console.log(`the server did not answer within 90 s; see ${officePaths(s.home).officeLog}`)
}

/** true when the internet address answers afterwards (else the reason is printed and `set` exits 1) */
async function applyPublicChange(s: OfficeSettings, serverToo: boolean): Promise<boolean> {
  if (serverToo || !launchAgent(s.label, officePaths(s.home).plist(s.label)).loaded()) await restartServer(s)
  console.log(await syncTunnelAgent(s))
  if (!fs.existsSync(officePaths(s.home).plist(tunnelLabel(s)))) return false
  console.log(`https://${s.publicHost} 확인 중 / checking ...`)
  const r = await waitPublic(s.publicHost!, 60)
  if (r === 'ok') {
    console.log(`인터넷 주소가 답합니다 / the internet address answers: https://${s.publicHost}`)
    console.log(`데스크 카드를 다시 인쇄하세요 / print the desk card again: ${path.join(s.home, 'teamax')} card`)
    return true
  }
  console.log(publicProblem(s, r, officePaths(s.home).tunnelLog))
  return false
}

// ---- desktop app installers (Settings → Apps) ---------------------------------------------------------------

export const downloadsDir = (home: string) => path.join(officePaths(home).data, 'downloads')

const DESKTOP_USAGE = [
  'usage: teamax desktop list',
  '       teamax desktop add <installer.exe|.dmg> [--version x.y.z] [--keep]   offer it under Settings → Apps',
  '       teamax desktop remove <file name>',
  '       teamax desktop add-from <folder>... [--fallback <folder>] [--manifest desktop.sha256] [--dry-run] [--keep]',
  '  --version  when the file name has no version     --keep  keep the older ones of the platform too',
].join('\n')

const what = (i: Omit<DownloadItem, 'sha256'>) =>
  `${platformWord(i.platform)}${i.arch && i.arch !== 'universal' ? ` (${i.arch === 'arm64' ? 'Apple Silicon' : 'Intel'} only)` : ''} ${i.version} (${i.file}, ${sizeText(i.size)}, ${signatureWord(i.signature, i.signed)})`

const signatureWord = (s: Signature | undefined, signed: boolean) =>
  signed || s === 'verified' ? '서명 확인됨 / signature verified' : s === 'unverified' ? '서명 있음(확인 안 됨) / signed, not verified' : '서명 없음 / unsigned'

function addedLine(r: AddResult): string {
  return (r.unchanged ? `이미 올라가 있습니다 / already offered: ${what(r.item)}` : `데스크톱 앱을 올렸습니다 / desktop app added: ${what(r.item)}`) +
    (r.removed.length ? `\n  이전 파일 지움 / older one removed: ${r.removed.join(', ')}` : '')
}

/** a yes/no question on the terminal (stderr, so office-install.sh's output filter does not hold it back); no
 * terminal = no */
export function askTerminal(q: string): boolean {
  if (!process.stdin.isTTY) return false
  process.stderr.write(`${q} [y/N] `)
  const buf = Buffer.alloc(256)
  let n = 0
  try { n = fs.readSync(0, buf, 0, buf.length, null) } catch { return false }
  return /^\s*(y|yes|예|네|ㅇ)/i.test(buf.toString('utf8', 0, n))
}

/** `teamax desktop …` (exit code) */
export function desktopCommand(home: string, argv: string[], out: (s: string) => void = console.log, o: { ask?: (q: string) => boolean } = {}): number {
  const args = argv.filter((a, i) => !(a === '--home' || argv[i - 1] === '--home'))
  const flag = (n: string) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v }
  const version = flag('--version'), fallback = flag('--fallback'), manifestFile = flag('--manifest')
  const keep = args.includes('--keep'), dry = args.includes('--dry-run')
  const [sub = 'list', ...rest] = args.filter((a) => a !== '--keep' && a !== '--dry-run')
  const dir = downloadsDir(home)
  const teamax = path.join(home, 'teamax')
  const where = '팀원은 설정 → 앱에서 내려받습니다 / members download it under Settings → Apps'
  if (sub === '--help' || sub === '-h' || sub === 'help') { out(DESKTOP_USAGE); return 0 }
  if (sub === 'list') {
    const { items, stray } = listInstallers(dir)
    if (!items.length) out(`올라간 데스크톱 앱 없음 / no desktop app offered (${dir}). 올리기 / add: ${teamax} desktop add <Team-AX-Setup-…-x64.exe | Team-AX-…-mac-universal.dmg>`)
    for (const i of items) out(`${platformWord(i.platform).padEnd(8)} ${i.version.padEnd(10)} ${sizeText(i.size).padStart(9)}  ${i.signed ? 'verified  ' : i.signature === 'unverified' ? 'unverified' : 'unsigned  '}  ${i.file}${i.arch && i.arch !== 'universal' ? ` (${i.arch} only)` : ''}${i.sha256 ? `  sha256 ${i.sha256.slice(0, 16)}…` : ''}`)
    if (stray.length) out(`목록에 없는 파일 (안 보임) / files not in the list (not shown): ${stray.join(', ')}`)
    return 0
  }
  if (sub === 'add') {
    if (rest.length !== 1) { console.error(DESKTOP_USAGE); return 2 }
    const src = path.resolve(rest[0]!)
    if (!fs.existsSync(src)) { console.error(`teamax: 파일이 없습니다 / no such file: ${src}`); return 1 }
    out(addedLine(addInstaller(dir, src, { version, keep })))
    out(where)
    return 0
  }
  if (sub === 'remove') {
    if (rest.length !== 1) { console.error(DESKTOP_USAGE); return 2 }
    if (!removeInstaller(dir, rest[0]!)) { console.error(`teamax: ${path.basename(rest[0]!)} is not offered (teamax desktop list)`); return 1 }
    out(`내렸습니다 / removed: ${path.basename(rest[0]!)}`)
    return 0
  }
  if (sub === 'add-from') {
    // Which file per platform: with the bundle's desktop.sha256 only files it lists (by name and hash), from any of the
    // folders; without one, the newest in the bundle's folders (the bundle, the folder next to it). The --fallback
    // folder (~/Downloads) is looked at only for a platform those have nothing for, and its file is added only when
    // the owner says yes on the terminal: a stray or planted file there never becomes the app everyone downloads.
    const main = rest.map((d) => path.resolve(d))
    const fb = fallback ? path.resolve(fallback) : null
    const manifest = manifestFile ? readManifest(path.resolve(manifestFile)) : null
    type Pick = Found & { ask: boolean }
    const picks: Pick[] = []
    const notes: string[] = []
    for (const platform of ['windows', 'mac'] as const) {
      if (manifest) {
        const listed = [...main, ...(fb ? [fb] : [])].flatMap((d) => findInstallers([d]).filter((f) => f.platform === platform))
        let hit: Found | undefined
        for (const d of [...main, ...(fb ? [fb] : [])]) {
          let names: string[] = []
          try { names = fs.readdirSync(d) } catch { continue }
          for (const n of names) {
            const sha = manifest.get(n)
            if (!sha || platformOf(n) !== platform) continue
            const f = path.join(d, n)
            try { if (fs.statSync(f).isFile() && sha256File(f) === sha) { hit = { file: f, platform, version: versionFromName(n) ?? '' }; break } } catch {}
          }
          if (hit) break
        }
        if (hit && hit.version) picks.push({ ...hit, ask: false })
        // another copy of a listed file (same name and hash, e.g. the exe both next to the zip and in ~/Downloads) is no news
        const isListed = (f: Found) => { try { return manifest.get(path.basename(f.file)) === sha256File(f.file) } catch { return false } }
        for (const f of listed) if ((!hit || fs.realpathSync(f.file) !== fs.realpathSync(hit.file)) && !isListed(f)) notes.push(`목록(${MANIFEST})과 다른 파일이라 건너뜀 / not in the bundle's ${MANIFEST}, skipped: ${f.file} (to offer it anyway: ${teamax} desktop add "${f.file}")`)
        continue
      }
      const near = findInstallers(main).find((f) => f.platform === platform)
      if (near) { picks.push({ ...near, ask: false }); continue }
      const far = fb ? findInstallers([fb]).find((f) => f.platform === platform) : undefined
      if (far) picks.push({ ...far, ask: true })
    }
    if (!picks.length) {
      for (const n of notes) out(n)
      out('데스크톱 앱 설치 파일 없음 / no desktop installer found (Team-AX-Setup-*-x64.exe, Team-AX-*-mac*.dmg)')
      return 0
    }
    let bad = 0, offered = 0
    for (const f of picks) {
      let plan: AddPlan
      try { plan = planAdd(dir, f.file, { keep }) } catch (e) { bad++; out(`올리지 못함 / not added: ${f.file}: ${(e as Error).message}`); continue }
      if (plan.action === 'refused') { out(`올리지 않음 / not added: ${f.file}: ${plan.reason}`); continue }
      if (plan.action === 'unchanged') { offered++; out(`이미 올라가 있습니다 / already offered: ${what(plan.item)}`); continue }
      if (f.ask) {
        const q = `${f.file} 은(는) 압축 파일 옆이 아니라 ${path.dirname(f.file)}에 있습니다. 팀원 모두가 내려받을 앱으로 올릴까요? / found in ${path.dirname(f.file)}, not next to the bundle: offer it to everyone?`
        if (dry) { out(`물어볼 파일 / would ask about: ${f.file} (${platformWord(f.platform)} ${f.version})`); continue }
        if (!(o.ask ?? askTerminal)(q)) { out(`올리지 않음 / not added: ${f.file} (${path.dirname(f.file)}의 파일은 묻고 올림 / files there are added only when you say yes; or: ${teamax} desktop add "${f.file}")`); continue }
      }
      if (dry) { out(`올릴 파일 / would add: ${f.file} (${platformWord(f.platform)} ${f.version})${plan.replaces.length ? `, replacing ${plan.replaces.join(', ')}` : ''}`); continue }
      try { out(`${addedLine(addInstaller(dir, f.file, { keep }))}\n  ← ${f.file}`); offered++ } catch (e) { bad++; out(`올리지 못함 / not added: ${f.file}: ${(e as Error).message}`) }
    }
    for (const n of notes) out(n)
    if (!dry && offered) out(where)
    if (!dry && !listInstallers(dir).items.length) out(`아직 올라간 데스크톱 앱 없음 / no desktop app is offered yet: ${teamax} desktop add <file>`)
    return bad ? 1 : 0
  }
  console.error(DESKTOP_USAGE)
  return 2
}

function teamIsSetUp(home: string): boolean {
  const db = path.join(officePaths(home).data, 'app.db')
  if (!fs.existsSync(db)) return false
  const d = new Database(db, { readonly: true })
  try { return ((d.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n ?? 0) > 0 } catch { return false } finally { d.close() }
}

export async function main(argv: string[]): Promise<number> {
  const [cmd = 'status', ...args] = argv
  const home = arg(args, '--home') ?? process.env.TEAMAX_HOME ?? defaultHome()
  if (!home) { console.error('office: pass --home <install folder>'); return 2 }
  if (cmd === 'run') return await run(path.resolve(home))
  if (cmd === 'configure') { const s = configure(home, args); console.log(settingsText(s).trim()); return 0 }
  const s = loadSettings(home)
  const p = officePaths(home)
  const agent = launchAgent(s.label, p.plist(s.label))
  const lines = (txt: string) => console.log(txt)
  switch (cmd) {
    case 'install': {
      if (process.platform !== 'darwin') throw new Error('office mode runs on macOS')
      if (agent.loaded()) { agent.stop(); await Bun.sleep(1000) }
      if (tunnelAgentOf(s).loaded()) tunnelAgentOf(s).stop()
      const st = prepare(home)
      fs.mkdirSync(p.agentsDir, { recursive: true })
      fs.mkdirSync(p.logs, { recursive: true, mode: 0o750 })
      const bun = path.join(s.home, 'app', 'bin', 'bun')
      const text = agentPlist(s, fs.existsSync(bun) ? bun : process.execPath)
      fs.writeFileSync(p.plist(s.label), text, { mode: 0o644 })
      lines(`LaunchAgent ${p.plist(s.label)}: ${agent.start()}`)
      lines('waiting for the server ...')
      if (!(await waitHealthy(s, 90))) { lines(`the server did not answer within 90 s; see ${p.officeLog} and ${p.serverLogs}`); return 1 }
      const tl = await syncTunnelAgent(s)
      if (tl) lines(tl)
      try { const ul = syncUpdateAgent(s, agentPath(s)); if (ul) lines(ul) } catch (e) { lines(`update agent not installed: ${(e as Error).message}`) }
      if (s.publicHost && fs.existsSync(p.plist(tunnelLabel(s)))) {
        const r = await waitPublic(s.publicHost, 40)
        lines(r === 'ok' ? `https://${s.publicHost} 답함 / answers (앱 포트 / app port ${s.appPort})` : publicProblem(s, r, p.tunnelLog))
      }
      lines('')
      lines(fs.readFileSync(p.info, 'utf8'))
      lines('데스크마다 인쇄해 둘 카드 (지문 포함) / print the desk card (with the thumbprint) for every desk:')
      lines(`  open ${p.card}`)
      lines('')
      const link = setupLinks(s, st.origins)
      if (link) {
        lines('첫 설정 링크 (한 번만, 소유자 계정 만들기) / first-run setup link (owner account, once):')
        lines(`  이 맥에서 / on this Mac:  ${link.local}`)
        if (link.desk) lines(`  인증서를 설치한 데스크에서 / from a desk with the certificate:  ${link.desk}`)
        if (!args.includes('--no-open')) Bun.spawnSync(['/usr/bin/open', link.local])
      } else lines('팀이 이미 설정되어 있습니다 / the team is already set up.')
      return 0
    }
    case 'start': {
      lines(agent.start())
      if (s.publicHost && fs.existsSync(p.plist(tunnelLabel(s)))) lines(`cloudflared: ${tunnelAgentOf(s).start()}`)
      return 0
    }
    case 'stop': {
      lines(agent.stop())
      if (tunnelAgentOf(s).loaded()) lines(`cloudflared: ${tunnelAgentOf(s).stop()}`)
      return 0
    }
    case 'restart': {
      agent.stop(); await Bun.sleep(1000); lines(agent.start())
      const tl = await syncTunnelAgent(s)
      if (tl) lines(tl)
      return 0
    }
    case 'public-address': return await publicAddress(home, args)
    case 'desktop': return desktopCommand(home, args)
    case 'update': return await updateCommand(home, args, agentPath(s))
    case 'uninstall-agent': {
      lines(fs.existsSync(p.plist(s.label)) || agent.loaded() ? agent.stop() : 'not installed')
      fs.rmSync(p.plist(s.label), { force: true })
      const ta = tunnelAgentOf(s)
      if (ta.loaded()) lines(`cloudflared: ${ta.stop()}`)
      fs.rmSync(p.plist(tunnelLabel(s)), { force: true })
      const ul = removeUpdateAgent(s)
      if (ul) lines(ul)
      return 0
    }
    case 'status': {
      const installed = fs.existsSync(p.plist(s.label))
      const pid = agent.loaded() ? agent.pid() : null
      lines(!installed ? 'not installed' : !agent.loaded() ? 'installed, stopped (teamax start)' : `running${pid ? ` (pid ${pid})` : ' (starting)'}`)
      lines(`  this Mac  http://127.0.0.1:${s.appPort}  ${(await answers(`http://127.0.0.1:${s.appPort}/api/health`)) ? 'answers' : 'no answer'}`)
      if (s.publicHost) {
        const r = await probePublic(s.publicHost, 6000)
        lines(`  internet  https://${s.publicHost}  ${probeWord(r)}  (cloudflared ${tunnelAgentOf(s).loaded() ? 'running' : 'stopped'}, app port ${s.appPort})`)
        if (r !== 'ok') lines(publicProblem(s, r, p.tunnelLog))
      }
      let origins: string[] = []
      try { const cfg = JSON.parse(fs.readFileSync(p.serverJson, 'utf8')); origins = (cfg.publicOrigins as string[]).filter((o) => SHOWN.test(o)) } catch {}
      for (const o of origins) lines(`  desks     ${o}  ${(await answers(`${o}/api/health`)) ? 'answers' : 'no answer'}`)
      for (const o of helperOrigins(s, origins).slice(0, 1)) lines(`  CA page   ${o}  ${(await answers(o)) ? 'answers' : 'no answer'}`)
      const uv = updateView(home)
      lines(`  updates   ${uv.current} · ${uv.channel} · ${!uv.agentInstalled ? 'no update agent (office-install.sh from a 0.2.0+ zip)' : uv.paused ? 'paused (teamax update resume)' : `every night ${uv.time}`}${uv.last ? ` · last: ${uv.last.kind}` : ''}`)
      lines(`  log       ${p.officeLog}`)
      return 0
    }
    case 'logs': {
      const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 60)
      const tail = (f: string) => { try { return fs.readFileSync(f, 'utf8').trimEnd().split('\n').slice(-n).join('\n') } catch { return '' } }
      lines(`== ${p.officeLog}`)
      lines(tail(p.officeLog) || '(no log yet)')
      // the server's own log (requests, engine turns, errors) is where a failed chat shows up
      const srv = newestServerLog(p.serverLogs)
      if (srv) { lines(`\n== ${srv}`); lines(tail(srv)) }
      if (fs.existsSync(p.tunnelLog)) { lines(`\n== ${p.tunnelLog}`); lines(tail(p.tunnelLog)) }
      const ulog = path.join(p.logs, 'update.log')
      if (fs.existsSync(ulog)) { lines(`\n== ${ulog}`); lines(tail(ulog)) }
      return 0
    }
    case 'card': {
      if (!fs.existsSync(p.card)) { lines('(not prepared yet: teamax start)'); return 1 }
      lines(p.card)
      if (process.platform === 'darwin' && !args.includes('--no-open')) Bun.spawnSync(['/usr/bin/open', p.card])
      return 0
    }
    case 'check-ports': {
      const bad = await portProblems(s)
      for (const b of bad) console.error(`teamax: ${b}`)
      return bad.length ? 1 : 0
    }
    case 'info': {
      try { lines(fs.readFileSync(p.info, 'utf8')) } catch { lines('(not prepared yet: teamax start)') }
      return 0
    }
    case 'setup-link': {
      let origins: string[] = []
      try { origins = (JSON.parse(fs.readFileSync(p.serverJson, 'utf8')).publicOrigins as string[]).filter((o) => SHOWN.test(o)) } catch {}
      const link = setupLinks(s, origins)
      lines(link ? `${link.local}\n${link.desk ?? ''}`.trim() : 'no setup pending (the team is set up)')
      return link ? 0 : 1
    }
    case 'reset-link': return runTool(home, 'accounts', ['reset-link', ...(arg(args, '--username') ? ['--username', arg(args, '--username')!] : [])])
    case 'backup': return runTool(home, 'admin', ['backup'], 'ignore', backupSummary)
    case 'archive': {
      const out = arg(args, '--out')
      if (!out) throw new Error('archive needs --out <file>')
      return runTool(home, 'admin', ['archive', '--out', path.resolve(out), '--password-stdin'], 'inherit', archiveSummary)
    }
    case 'restore-archive': {
      const src = arg(args, '--in')
      if (!src) throw new Error('restore-archive needs --in <file>')
      if (teamIsSetUp(home) && !args.includes('--replace')) throw new Error('this installation already has a team; add --replace to put the archive in its place (the current data is kept next to it)')
      const to = path.join(p.home, `restore-${process.pid}`)
      const wasRunning = agent.loaded()
      if (wasRunning) { agent.stop(); await Bun.sleep(1000) }
      try {
        const code = runTool(home, 'admin', ['restore-archive', '--in', path.resolve(src), '--to', to, ...(args.includes('--plain') ? [] : ['--password-stdin'])], 'inherit')
        if (code !== 0) return code
        const kept = swapInRestore(home, to)
        lines(`restored. previous database: ${kept.db}; previous team folder: ${kept.team}\nevery sign-in ended: everyone (desks and the owner) signs in again; unused invite and reset links are gone (make new ones)`)
      } finally {
        fs.rmSync(to, { recursive: true, force: true })
        if (wasRunning) lines(agent.start())
      }
      return 0
    }
    default:
      console.error('usage: teamax install|start|stop|restart|status|logs [n]|info|card|setup-link|reset-link [--username U]|backup|archive [--out] FILE|restore-archive [--in] FILE [--replace]|public-address set HOST TOKEN-FILE|off|status|desktop list|add FILE [--version x.y.z] [--keep]|remove FILE|update [status|check|now|pause|resume|channel stable|beta|time HH:MM]|check-ports|uninstall-agent')
      return 2
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`teamax: ${(e as Error).message}`)
    process.exit(1)
  })
}
