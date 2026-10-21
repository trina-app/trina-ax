// `bun run dev`: the whole product on this machine in DEV mode.
//
//   server  http://localhost:19100        team server (bun --watch), engines run as you with your own Claude Code /
//                                         Codex logins (engine.authMode local-login, no model proxy), and it serves
//                                         the built web app (web/dist) at the same address
//   relay   http://demo.localhost:19161   the relay on Node 25 (*.localhost routing); the server registers the team
//                                         "demo" there and keeps its control connections, like a real remote address
//   vite    http://localhost:19140        only with --vite: hot-reloading web dev server (proxies /api to 19100)
//
// Data lives in ~/.team-ax-dev (team folder, data, relay registry); delete it to start over. Override with
// TEAM_AX_DEV_DIR. Flags: --vite, --no-relay, --team <name> (default demo), --rebuild-web, --no-web-build.
// Output is prefixed per process; Ctrl-C stops everything. A relay that dies is restarted (like its service manager
// would); any other process ending stops the rest.
//
//   bun run dev admin <command>   the account CLI (server/src/auth/cli.ts: status, create-owner, reset-link) on THIS
//                                 data folder; plain `bun run admin` uses the dev:server folder <repo>/.dev instead
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const flag = (f: string) => args.includes(f)
const opt = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1]! : d }

const DEV_HOME = process.env.TEAM_AX_DEV_DIR ? path.resolve(process.env.TEAM_AX_DEV_DIR) : path.join(os.homedir(), '.team-ax-dev')
const TEAM = opt('--team', 'demo').toLowerCase()
const SERVER_PORT = 19100
const RELAY_PORT = 19161
const RELAY_MIN_NODE = 25

/** plain tags when NO_COLOR is set (the background service of `bun run dev:service` writes to a log file) */
const COLOR = !process.env.NO_COLOR
const say = (s: string) => console.log(COLOR ? `\x1b[1m[dev]\x1b[0m ${s}` : `[dev] ${s}`)

/** where `bun run dev` keeps the server's data (the account CLI must look at the same database) */
const dataEnv = (): Record<string, string> => ({
  MYCEL_MODE: 'dev',
  MYCEL_DATA_DIR: process.env.MYCEL_DATA_DIR ?? path.join(DEV_HOME, 'data'),
  MYCEL_TEAM_ROOT: process.env.MYCEL_TEAM_ROOT ?? path.join(DEV_HOME, 'team'),
})

if (args[0] === 'admin') {
  const p = Bun.spawnSync(['bun', path.join(ROOT, 'server', 'src', 'auth', 'cli.ts'), ...args.slice(1)], {
    cwd: ROOT, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: { ...(process.env as Record<string, string>), ...dataEnv() },
  })
  process.exit(p.exitCode ?? 1)
}

function run(cmd: string[], cwd = ROOT): boolean {
  say(cmd.join(' '))
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit', env: process.env })
  return r.exitCode === 0
}

/** newest mtime of the files under `p` (skipping node_modules / dist) */
function newest(p: string): number {
  let st: fs.Stats
  try { st = fs.statSync(p) } catch { return 0 }
  if (!st.isDirectory()) return st.mtimeMs
  let m = 0
  for (const e of fs.readdirSync(p)) {
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue
    m = Math.max(m, newest(path.join(p, e)))
  }
  return m
}

// 1. native helpers (tool gate, bridge, launcher): needed for every engine turn
const platform = `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`
if (!fs.existsSync(path.join(ROOT, 'native', 'bin', platform, 'mycel-launcher'))) {
  if (!Bun.which('go')) say('native helpers are not built and Go is missing: chats will answer "engine unavailable" until `bun run build:native` runs')
  else if (!run(['bash', 'native/build.sh'])) process.exit(1)
}

// 2. the web app the server serves (rebuilt when web/ or shared/ changed since the last build)
const distIndex = path.join(ROOT, 'web', 'dist', 'index.html')
if (!flag('--no-web-build')) {
  const built = newest(distIndex)
  const src = Math.max(newest(path.join(ROOT, 'web', 'src')), newest(path.join(ROOT, 'web', 'index.html')), newest(path.join(ROOT, 'web', 'public')), newest(path.join(ROOT, 'web', 'scripts')), newest(path.join(ROOT, 'shared', 'src')))
  if (flag('--rebuild-web') || !built || src > built) {
    if (!run(['bun', 'run', '--cwd', 'web', 'build'])) process.exit(1)
  }
}

// 3. relay on Node 25 (Bun.serve has no streaming backpressure, see relay/README.md)
let relay = !flag('--no-relay')
if (relay) {
  const node = Bun.which('node')
  const v = node ? Bun.spawnSync([node, '--version']).stdout.toString().trim() : ''
  const major = Number(/^v(\d+)/.exec(v)?.[1] ?? 0)
  if (major < RELAY_MIN_NODE) {
    say(`relay skipped: it needs Node ${RELAY_MIN_NODE}+ (found ${v || 'no node'}). Direct access still works on http://localhost:${SERVER_PORT}`)
    relay = false
  }
}

fs.mkdirSync(path.join(DEV_HOME, 'data'), { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(DEV_HOME, 'team'), { recursive: true })
fs.mkdirSync(path.join(DEV_HOME, 'relay'), { recursive: true })

const P = 'MYCEL_'
const serverEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ...dataEnv(),
  [P + 'PORT']: String(SERVER_PORT),
  [P + 'PUBLIC_ORIGINS']: process.env[P + 'PUBLIC_ORIGINS'] ?? [`http://localhost:${SERVER_PORT}`, `http://127.0.0.1:${SERVER_PORT}`, `http://${TEAM}.localhost:${RELAY_PORT}`].join(','),
  [P + 'RELAY_URL']: relay ? `ws://127.0.0.1:${RELAY_PORT}/connect` : '',
  [P + 'RELAY_TEAM']: TEAM,
}

const procs: { name: string; cmd: string[]; cwd: string; env: Record<string, string> }[] = [
  { name: 'server', cmd: ['bun', '--watch', 'server/src/main.ts'], cwd: ROOT, env: serverEnv },
]
if (relay) {
  procs.push({
    name: 'relay',
    cmd: ['node', '--disable-warning=ExperimentalWarning', 'relay/src/main.ts', '--dev', '--port', String(RELAY_PORT), '--data', path.join(DEV_HOME, 'relay')],
    cwd: ROOT, env: process.env as Record<string, string>,
  })
}
if (flag('--vite')) procs.push({ name: 'vite', cmd: ['bun', 'run', 'dev'], cwd: path.join(ROOT, 'web'), env: process.env as Record<string, string> })

const colors = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m']
type Running = (typeof procs)[number] & { child: ReturnType<typeof Bun.spawn>; tag: string }

function pipe(stream: ReadableStream<Uint8Array>, tag: string) {
  ;(async () => {
    let buf = ''
    const td = new TextDecoder()
    for await (const ch of stream) {
      buf += td.decode(ch, { stream: true })
      let n
      while ((n = buf.indexOf('\n')) >= 0) { process.stdout.write(tag + buf.slice(0, n) + '\n'); buf = buf.slice(n + 1) }
    }
    if (buf) process.stdout.write(tag + buf + '\n')
  })()
}

function spawn(p: (typeof procs)[number], tag: string): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn(p.cmd, { cwd: p.cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'inherit', env: p.env })
  pipe(child.stdout as ReadableStream<Uint8Array>, tag)
  pipe(child.stderr as ReadableStream<Uint8Array>, tag)
  return child
}

const running: Running[] = procs.map((p, i) => {
  const tag = COLOR ? `${colors[i % colors.length]}[${p.name}]\x1b[0m ` : `[${p.name}] `
  return { ...p, tag, child: spawn(p, tag) }
})

// The relay is restarted when it dies (in production its service manager does that): the team server keeps
// reconnecting, and open browser tabs resume their WebSocket. Kill it (e.g. `kill $(lsof -ti tcp:19161
// -sTCP:LISTEN)`) to try the reconnect path; it comes back after RELAY_RESTART_MS.
const RELAY_RESTART_MS = 1500
say(`data: ${DEV_HOME}`)
say(`direct: http://localhost:${SERVER_PORT}`)
if (relay) say(`relay:  http://${TEAM}.localhost:${RELAY_PORT}  (the team registers itself a few seconds after start)`)
if (flag('--vite')) say('vite:   http://localhost:19140')
say(`engines run as ${os.userInfo().username} with your own Claude Code / Codex logins (local-login). Ctrl-C stops everything.`)

let stopping = false
const stop = () => { if (stopping) return; stopping = true; for (const p of running) p.child.kill('SIGTERM') }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

/** Resolves when a process that is not restarted ends (a crash of the server, or vite). */
function watch(r: Running): Promise<{ name: string; code: number | null }> {
  return r.child.exited.then(async (code) => {
    if (r.name !== 'relay' || stopping) return { name: r.name, code }
    say(`relay exited (${code}); restarting in ${RELAY_RESTART_MS} ms`)
    await Bun.sleep(RELAY_RESTART_MS)
    if (stopping) return { name: r.name, code }
    r.child = spawn(r, r.tag)
    return watch(r)
  })
}
// one process ending (crash) stops the others, so a half-running dev setup never lingers
const first = await Promise.race(running.map(watch))
const byUser = stopping
if (!byUser) say(`${first.name} exited (${first.code}); stopping the rest`)
stop()
await Promise.all(running.map((p) => p.child.exited))
process.exit(byUser ? 0 : first.code || 1)
