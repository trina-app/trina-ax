// Office mode (docs/OFFICE.md): one Mac in a clinic or small office runs Team AX for the desks on its network, as
// the signed-in macOS user, with that Mac's own Claude Code login (dev mode's engine setup: local-login, engine.sb
// sandbox, the permission function, the engine lockdown). Bundled as app/server/src/office.js by
// scripts/build-office.ts and run by app/bin/bun; `~/TeamAX/teamax <command>` is the short way to call it.
//
//   run                 the supervisor (the LaunchAgent runs this): office TLS, config/server.json, the server, the
//                       helper page; re-checks the Mac's addresses every 30 s and restarts the server with a new
//                       certificate when one appeared
//   configure [--label L] [--app-port N] [--lan-port N] [--helper-port N|0] [--run-dir D] [--claude-bin P]
//             [--codex-bin P] [--ca-constraints 0|1]
//                       write config/office.env (merged with what is there)
//   install [--no-open] write the LaunchAgent, (re)start it, wait until it answers, print the addresses and the
//                       first-run setup link (and open it on this Mac)
//   start | stop | restart | status | logs [n] | info | setup-link
//   reset-link [--username U]      one-time password reset link (24 h) for the owner or a member
//   backup                         a backup now (the same as the nightly one, on this Mac's disk)
//   archive --out FILE             encrypted copy of the database + team folder for an external disk (password on stdin)
//   restore-archive --in FILE [--replace]
//                                  put an archive's database and team folder in place (password on stdin); without
//                                  --replace only into an installation where nobody has set up the team yet
//   uninstall-agent                stop and remove the LaunchAgent (office-uninstall.sh)
// Every command takes --home <dir> (default: the folder above app/).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { launchAgent, plist } from '../../../scripts/dev-service'
import { REPO_ROOT } from '../app-config'
import { helperFetch, type HelperState } from './helper'
import { deskOrigins, loadSettings, MAX_RUN_DIR, officePaths, parseEnvFile, runDirFor, serverConfig, settingsFrom, settingsText, type OfficeSettings } from './settings'
import { ensureOfficeTls, fingerprints, lanAddresses, localHostName } from './tls'

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

interface Prepared { settings: OfficeSettings; origins: string[]; helper: HelperState; changed: boolean; reason: string | null; left: string[]; key: string }

/** Certificates for the addresses the Mac has now, config/server.json, ADDRESSES.txt. */
export function prepare(home: string, o: { addrs?: string[]; host?: string | null } = {}): Prepared {
  const s = loadSettings(home)
  const p = officePaths(home)
  for (const d of [p.data, p.team, p.tls, p.config]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700) }
  fs.mkdirSync(p.serverLogs, { recursive: true, mode: 0o750 })
  const host = o.host === undefined ? localHostName() : o.host
  const addrs = o.addrs ?? lanAddresses()
  const t = ensureOfficeTls(p.tls, { host, addrs, constraints: s.caConstraints })
  const cfg = serverConfig(s, t.names)
  const tmp = `${p.serverJson}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, p.serverJson)
  const fp = fingerprints(t.ca)
  const origins = deskOrigins(t.names, s.lanPort, { shown: true })
  const helper: HelperState = {
    caPem: fs.readFileSync(path.join(p.tls, 'ca.crt'), 'utf8'), caDer: new Uint8Array(t.ca.raw), sha256: fp.sha256, sha1: fp.sha1,
    origins, caName: /CN=([^\n]+)/.exec(t.ca.subject)?.[1] ?? 'Team AX office CA',
  }
  fs.writeFileSync(p.info, infoText(s, helper, t.left), { mode: 0o644 })
  return { settings: s, origins, helper, changed: t.changed, reason: t.reason, left: t.left, key: JSON.stringify([host, addrs]) }
}

export function helperOrigins(s: OfficeSettings, origins: string[]): string[] {
  if (!s.helperPort) return []
  return origins.map((o) => { const u = new URL(o); u.protocol = 'http:'; u.port = String(s.helperPort); return u.origin })
}

export function infoText(s: OfficeSettings, h: HelperState, left: string[] = []): string {
  const helpers = helperOrigins(s, h.origins)
  return [
    `Team AX 사무실 모드 / office mode — ${new Date().toISOString()}`,
    '',
    '데스크(윈도우 Edge·Chrome)에서 여는 주소 / address for the desks:',
    ...h.origins.map((o) => `  ${o}`),
    '',
    helpers.length ? '처음 한 번, 인증서 설치 페이지 / first time: certificate page' : '인증서 페이지 꺼짐 (TEAMAX_HELPER_PORT=0): ~/TeamAX/tls/ca.cer 를 직접 나눠 주세요',
    ...helpers.map((o) => `  ${o}`),
    '',
    `CA SHA-256: ${h.sha256}`,
    `CA SHA-1 (윈도우 지문 / Windows thumbprint): ${h.sha1}`,
    '',
    `이 맥에서 / on this Mac: http://localhost:${s.appPort}`,
    ...(left.length ? ['', `인증서에 넣지 않은 주소 (공인 주소) / left out (public): ${left.join(', ')}`] : []),
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
  let helper: ReturnType<typeof Bun.serve> | null = null
  const startHelper = () => {
    if (!s.helperPort || helper) return
    try {
      helper = Bun.serve({ hostname: '::', port: s.helperPort, fetch: (req) => helperFetch(req, helperState), maxRequestBodySize: 1024 })
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
    const host = localHostName()
    const addrs = lanAddresses()
    const key = JSON.stringify([host, addrs])
    if (key === st.key && Date.now() - lastTls < TLS_RECHECK_MS) return
    try {
      const next = prepare(home, { addrs, host })
      lastTls = Date.now()
      st = next
      helperState = next.helper
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
  ]
  for (const [f, k] of flags) { const v = arg(args, f); if (v !== undefined) cur[k] = v }
  // a new LAN port moves the helper page along with it unless it was chosen explicitly
  if (arg(args, '--lan-port') !== undefined && arg(args, '--helper-port') === undefined) delete cur.TEAMAX_HELPER_PORT
  const s = settingsFrom(home, cur)
  // --as-home: the folder the settings are meant for (office-install.sh --check-only writes them into a scratch one)
  const sock = path.join(runDirFor({ ...s, home: path.resolve(arg(args, '--as-home') ?? home) }), 'private', 'server.sock')
  if (Buffer.byteLength(sock) > 103) throw new Error(`the engine socket path ${sock} is longer than macOS allows (103 bytes): install into a shorter folder or pass --run-dir <short folder>`)
  fs.mkdirSync(p.config, { recursive: true, mode: 0o700 })
  fs.writeFileSync(p.env, settingsText(s), { mode: 0o600 })
  return s
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
function runTool(home: string, tool: 'accounts' | 'admin', args: string[], stdin: 'inherit' | 'ignore' = 'ignore'): number {
  const p = officePaths(home)
  const src = tool === 'accounts' ? ['accounts.js', path.join('..', 'auth', 'cli.ts')] : ['admin.js', path.join('..', 'system', 'cli.ts')]
  const file = src.map((f) => path.join(import.meta.dir, f)).find((f) => fs.existsSync(f))
  if (!file) throw new Error(`${src[0]} missing from this bundle`)
  const r = Bun.spawnSync([process.execPath, file, ...args], {
    cwd: p.home, stdin, stdout: 'inherit', stderr: 'inherit',
    env: { ...(process.env as Record<string, string>), MYCEL_CONFIG: p.serverJson, MYCEL_MODE: 'dev' },
  })
  return r.exitCode ?? 1
}

/** Put a restored archive (<dir>/db/app.sqlite, <dir>/team) in place of data/app.db and team/. The previous ones
 * stay next to them as *.before-restore-<time>. */
export function swapInRestore(home: string, restored: string, stamp = new Date().toISOString().replace(/[:.]/g, '-')): { db: string; team: string } {
  const p = officePaths(home)
  const db = path.join(p.data, 'app.db')
  const oldDb = `${db}.before-restore-${stamp}`
  const oldTeam = `${p.team}.before-restore-${stamp}`
  if (fs.existsSync(db)) fs.renameSync(db, oldDb)
  for (const sfx of ['-wal', '-shm']) fs.rmSync(db + sfx, { force: true })
  fs.renameSync(path.join(restored, 'db', 'app.sqlite'), db)
  fs.chmodSync(db, 0o600)
  if (fs.existsSync(p.team)) fs.renameSync(p.team, oldTeam)
  fs.renameSync(path.join(restored, 'team'), p.team)
  fs.chmodSync(p.team, 0o700)
  fs.rmSync(p.setupToken, { force: true })
  fs.rmSync(restored, { recursive: true, force: true })
  return { db: oldDb, team: oldTeam }
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
      const st = prepare(home)
      fs.mkdirSync(p.agentsDir, { recursive: true })
      fs.mkdirSync(p.logs, { recursive: true, mode: 0o750 })
      const bun = path.join(s.home, 'app', 'bin', 'bun')
      const text = agentPlist(s, fs.existsSync(bun) ? bun : process.execPath)
      fs.writeFileSync(p.plist(s.label), text, { mode: 0o644 })
      lines(`LaunchAgent ${p.plist(s.label)}: ${agent.start()}`)
      lines('waiting for the server ...')
      if (!(await waitHealthy(s, 90))) { lines(`the server did not answer within 90 s; see ${p.officeLog} and ${p.serverLogs}`); return 1 }
      lines('')
      lines(fs.readFileSync(p.info, 'utf8'))
      const link = setupLinks(s, st.origins)
      if (link) {
        lines('첫 설정 링크 (한 번만, 소유자 계정 만들기) / first-run setup link (owner account, once):')
        lines(`  이 맥에서 / on this Mac:  ${link.local}`)
        if (link.desk) lines(`  인증서를 설치한 데스크에서 / from a desk with the certificate:  ${link.desk}`)
        if (!args.includes('--no-open')) Bun.spawnSync(['/usr/bin/open', link.local])
      } else lines('팀이 이미 설정되어 있습니다 / the team is already set up.')
      return 0
    }
    case 'start': lines(agent.start()); return 0
    case 'stop': lines(agent.stop()); return 0
    case 'restart': agent.stop(); await Bun.sleep(1000); lines(agent.start()); return 0
    case 'uninstall-agent': {
      lines(fs.existsSync(p.plist(s.label)) || agent.loaded() ? agent.stop() : 'not installed')
      fs.rmSync(p.plist(s.label), { force: true })
      return 0
    }
    case 'status': {
      const installed = fs.existsSync(p.plist(s.label))
      const pid = agent.loaded() ? agent.pid() : null
      lines(!installed ? 'not installed' : !agent.loaded() ? 'installed, stopped (teamax start)' : `running${pid ? ` (pid ${pid})` : ' (starting)'}`)
      lines(`  this Mac  http://127.0.0.1:${s.appPort}  ${(await answers(`http://127.0.0.1:${s.appPort}/api/health`)) ? 'answers' : 'no answer'}`)
      let origins: string[] = []
      try { const cfg = JSON.parse(fs.readFileSync(p.serverJson, 'utf8')); origins = (cfg.publicOrigins as string[]).filter((o) => SHOWN.test(o)) } catch {}
      for (const o of origins) lines(`  desks     ${o}  ${(await answers(`${o}/api/health`)) ? 'answers' : 'no answer'}`)
      for (const o of helperOrigins(s, origins).slice(0, 1)) lines(`  CA page   ${o}  ${(await answers(o)) ? 'answers' : 'no answer'}`)
      lines(`  log       ${p.officeLog}`)
      return 0
    }
    case 'logs': {
      const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 60)
      let text = ''
      try { text = fs.readFileSync(p.officeLog, 'utf8') } catch {}
      lines(text.split('\n').slice(-n).join('\n') || '(no log yet)')
      return 0
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
    case 'backup': return runTool(home, 'admin', ['backup'])
    case 'archive': {
      const out = arg(args, '--out')
      if (!out) throw new Error('archive needs --out <file>')
      return runTool(home, 'admin', ['archive', '--out', path.resolve(out), '--password-stdin'], 'inherit')
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
        lines(`restored. previous database: ${kept.db}; previous team folder: ${kept.team}`)
      } finally {
        fs.rmSync(to, { recursive: true, force: true })
        if (wasRunning) lines(agent.start())
      }
      return 0
    }
    default:
      console.error('usage: teamax install|start|stop|restart|status|logs [n]|info|setup-link|reset-link [--username U]|backup|archive --out FILE|restore-archive --in FILE [--replace]|uninstall-agent')
      return 2
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`teamax: ${(e as Error).message}`)
    process.exit(1)
  })
}
