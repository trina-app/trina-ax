// The Google Workspace library as a supervised child (server/src/integrations/google-apps/library.ts): started on
// 127.0.0.1 with a short environment, ready on /health, restarted when it ends or stops answering, stopped on want(null)
// and close; 'unsupported' without a program; the address override for the other tests. A small bun script stands for
// the Python program.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BIN_ENV, createWorkspaceLibrary, LIBRARY_ARGS, LIBRARY_CHILD_ENV, libraryEnv, overrideEndpoint, redactLine, URL_ENV, type WorkspaceLibrary } from '../../server/src/integrations/google-apps/library'
import { silentLogger, type Logger } from '../../server/src/log'

// the start of a bun child is slow on a loaded machine
setDefaultTimeout(30_000)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gal-test-'))
const FAKE = path.join(root, 'fake-library.ts')
// what it saw goes to <ctl>/seen-<pid>.json; <ctl>/mode says how it behaves: ok | crash | slow | sick
fs.writeFileSync(FAKE, `import fs from 'node:fs'
const ctl = process.argv[2]
const mode = fs.readFileSync(ctl + '/mode', 'utf8').trim()
fs.writeFileSync(ctl + '/seen-' + process.pid + '.json', JSON.stringify({ pid: process.pid, env: process.env, args: process.argv.slice(3), cwd: process.cwd() }))
if (mode === 'crash') process.exit(3)
if (mode !== 'slow') {
  let n = 0
  Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT), fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/health') return (mode === 'sick' && n++ > 0) ? new Response('no', { status: 500 }) : Response.json({ status: 'healthy', service: 'workspace-mcp' })
    return new Response('nf', { status: 404 })
  } })
}
setInterval(() => {}, 1000)
`)

const pids = new Set<number>()
const libs: WorkspaceLibrary[] = []
afterAll(async () => {
  for (const l of libs) await l.close()
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  fs.rmSync(root, { recursive: true, force: true })
})

/** a control folder with a mode, and the processes it saw */
function ctl(mode: string) {
  const d = fs.mkdtempSync(path.join(root, 'ctl-'))
  fs.writeFileSync(path.join(d, 'mode'), mode)
  const seen = () => fs.readdirSync(d).filter((f) => f.startsWith('seen-')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as { pid: number; env: Record<string, string>; args: string[]; cwd: string })
    .sort((a, b) => a.pid - b.pid)
  return { d, seen, mode: (m: string) => fs.writeFileSync(path.join(d, 'mode'), m) }
}
const PARENT = {
  PATH: process.env.PATH!, LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://proxy.example:3128',
  // none of these may reach it
  MYCEL_MASTER_KEY: 'parent-secret-1', ANTHROPIC_API_KEY: 'parent-secret-2', GOOGLE_OAUTH_CLIENT_SECRET: 'parent-secret-3',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example', WORKSPACE_MCP_TOKEN_VALIDATION_CACHE_TTL: '300', HOME: '/home/server',
}
const logs: string[] = []
/** a library of the fake program; its log lines go to its own list (and to logs) */
function lib(c: { d: string }, o: Partial<Parameters<typeof createWorkspaceLibrary>[0]> = {}) {
  const own: string[] = []
  const put = (x: string) => { own.push(x); logs.push(x) }
  const log: Logger = { debug() {}, info: (m) => put(m), warn: (m, f) => put(`${m} ${JSON.stringify(f ?? {})}`), error() {}, child: () => log }
  const l = Object.assign(createWorkspaceLibrary({ log, env: PARENT, command: [process.execPath, FAKE, c.d], tmpRoot: root, readyMs: 10_000, healthMs: 100, healthMisses: 2, firstBackoffMs: 50, maxBackoffMs: 200, ...o }), { logs: own })
  libs.push(l)
  return l
}
async function until(f: () => boolean, ms = 10_000) {
  const t0 = Date.now()
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await Bun.sleep(25) }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const CLIENT = '1234-abc.apps.googleusercontent.com'

describe("the library child", () => {
  test('unsupported without a program: not Linux, or no venv, or a development path that is not there', async () => {
    const mac = createWorkspaceLibrary({ log: silentLogger, env: {}, platform: 'darwin' })
    expect(mac.state()).toBe('unsupported')
    mac.want(CLIENT)
    expect(mac.state()).toBe('unsupported')
    expect(mac.endpoint()).toBeNull()
    expect(await mac.whenReady(1_000)).toBe(false)
    // Linux without /opt/trina/python/workspace-mcp (this machine has none)
    if (!fs.existsSync('/opt/trina/python/workspace-mcp/current/bin/workspace-mcp')) {
      expect(createWorkspaceLibrary({ log: silentLogger, env: {}, platform: 'linux' }).state()).toBe('unsupported')
    }
    expect(createWorkspaceLibrary({ log: silentLogger, env: { [BIN_ENV]: path.join(root, 'none') }, platform: 'linux' }).state()).toBe('unsupported')
    await mac.close()
  })

  test('the address override: only http://127.0.0.1:<port>/mcp, ready without a process', async () => {
    const l = createWorkspaceLibrary({ log: silentLogger, env: { [URL_ENV]: 'http://127.0.0.1:4567/mcp' }, platform: 'darwin' })
    expect(l.state()).toBe('ready')
    expect(l.endpoint()).toBe('http://127.0.0.1:4567/mcp')
    expect(await l.whenReady(0)).toBe(true)
    l.want(null)
    expect(l.endpoint()).toBe('http://127.0.0.1:4567/mcp')
    for (const bad of ['http://localhost:4567/mcp', 'https://127.0.0.1:4567/mcp', 'http://127.0.0.1:4567/other', 'http://127.0.0.1/mcp', 'http://a:b@127.0.0.1:1/mcp', 'http://127.0.0.1:1/mcp?x=1', 'http://10.0.0.1:1/mcp']) {
      expect(`${bad}: ${overrideEndpoint(bad)}`).toBe(`${bad}: null`)
      expect(createWorkspaceLibrary({ log: silentLogger, env: { [URL_ENV]: bad }, platform: 'darwin' }).endpoint()).toBeNull()
    }
  })

  test('starts on want(clientId): 127.0.0.1, the arguments, the environment without the server\'s secrets, private folders', async () => {
    const c = ctl('ok')
    const l = lib(c)
    expect(l.state()).toBe('off')
    expect(l.endpoint()).toBeNull()
    l.want(CLIENT)
    l.want(CLIENT) // twice: one process
    expect(['starting', 'ready']).toContain(l.state())
    expect(await l.whenReady(10_000)).toBe(true)
    expect(l.state()).toBe('ready')
    const [s, ...more] = c.seen()
    expect(more).toEqual([])
    pids.add(s!.pid)
    expect(l.endpoint()).toBe(`http://127.0.0.1:${s!.env.PORT}/mcp`)
    expect(s!.args).toEqual([...LIBRARY_ARGS])
    expect(s!.env).toMatchObject({
      WORKSPACE_MCP_HOST: '127.0.0.1', WORKSPACE_MCP_BASE_URI: 'http://127.0.0.1', MCP_ENABLE_OAUTH21: 'true', EXTERNAL_OAUTH21_PROVIDER: 'true',
      WORKSPACE_MCP_STATELESS_MODE: 'true', WORKSPACE_MCP_DISABLE_LOCAL_FILES: 'true', GOOGLE_OAUTH_CLIENT_ID: CLIENT, WORKSPACE_MCP_TOKEN_VALIDATION_WORKERS: '8',
      HTTPS_PROXY: 'http://proxy.example:3128', LANG: 'en_US.UTF-8',
    })
    expect(s!.env.FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY!.length).toBeGreaterThanOrEqual(40)
    // nothing of the parent's beyond the allowed few (Bun adds a few of its own to a child's env)
    const text = JSON.stringify(s!.env)
    for (const v of ['parent-secret-1', 'parent-secret-2', 'parent-secret-3', 'collector.example', '/home/server']) expect(text).not.toContain(v)
    for (const k of Object.keys(s!.env)) if (k.startsWith('OTEL_') || k === 'WORKSPACE_MCP_TOKEN_VALIDATION_CACHE_TTL' || k === 'GOOGLE_OAUTH_CLIENT_SECRET') throw new Error(`${k} reached the library`)
    // its HOME and attachment folder: private, inside a folder of this start, which is its working folder
    for (const d of [s!.env.HOME!, s!.env.WORKSPACE_ATTACHMENT_DIR!, s!.cwd]) expect((fs.statSync(d).mode & 0o777).toString(8)).toBe('700')
    // both after realpath: a temp folder on macOS sits under /private (/var -> /private/var)
    expect(fs.realpathSync(path.dirname(s!.env.HOME!))).toBe(fs.realpathSync(s!.cwd))
    expect(fs.readdirSync(s!.env.WORKSPACE_ATTACHMENT_DIR!)).toEqual([])
    // want(null) stops it and removes its folder
    l.want(null)
    await until(() => !alive(s!.pid))
    expect(l.state()).toBe('off')
    expect(l.endpoint()).toBeNull()
    await until(() => !fs.existsSync(s!.cwd))
  })

  test('a new key per start; another client id starts it again with that id', async () => {
    const c = ctl('ok')
    const l = lib(c)
    l.want(CLIENT)
    expect(await l.whenReady(10_000)).toBe(true)
    l.want('999-other.apps.googleusercontent.com')
    await until(() => c.seen().length === 2 && l.state() === 'ready')
    const [a, b] = c.seen()
    for (const x of [a!, b!]) pids.add(x.pid)
    expect(b!.env.GOOGLE_OAUTH_CLIENT_ID).toBe('999-other.apps.googleusercontent.com')
    expect(a!.env.FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY).not.toBe(b!.env.FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY)
    await until(() => !alive(a!.pid))
    expect(l.endpoint()).toBe(`http://127.0.0.1:${b!.env.PORT}/mcp`)
    // not a client id: nothing runs
    l.want('bad id; rm -rf /')
    await until(() => !alive(b!.pid))
    expect(l.state()).toBe('off')
    await l.close()
  })

  test('restarted when it ends by itself, and when it stops answering /health', async () => {
    const c = ctl('ok')
    const l = lib(c)
    l.want(CLIENT)
    expect(await l.whenReady(10_000)).toBe(true)
    const first = c.seen()[0]!
    pids.add(first.pid)
    process.kill(first.pid, 'SIGKILL')
    await until(() => l.state() !== 'ready' || l.endpoint() !== `http://127.0.0.1:${first.env.PORT}/mcp`)
    await until(() => c.seen().length === 2 && l.state() === 'ready')
    const second = c.seen()[1]!
    pids.add(second.pid)
    expect(l.logs.some((x) => x.includes('google apps library down') && x.includes('ended'))).toBe(true)
    // it answers /health once, then 500: down after two misses, stopped and started again
    c.mode('sick')
    process.kill(second.pid, 'SIGKILL')
    await until(() => c.seen().length >= 4, 15_000)
    for (const s of c.seen()) pids.add(s.pid)
    expect(l.logs.some((x) => x.includes('health checks missed'))).toBe(true)
    await l.close()
    for (const s of c.seen()) await until(() => !alive(s.pid))
    expect(l.state()).toBe('off')
  }, 30_000)

  // every try starts a bun child (slow on a loaded machine): the waits are long, the pauses and limits checked stay short
  test('a start that crashes or never answers: down, tried again with a growing pause, until want(null)', async () => {
    const c = ctl('crash')
    const l = lib(c, { firstBackoffMs: 50, maxBackoffMs: 400 })
    l.want(CLIENT)
    await until(() => c.seen().length >= 3, 40_000)
    expect(l.state()).toBe('down')
    expect(l.endpoint()).toBeNull()
    expect(await l.whenReady(100)).toBe(false)
    // the pause grows (50, 100, 200, 400 ms ...)
    const pauses = l.logs.filter((x) => x.includes('google apps library down')).map((x) => JSON.parse(x.slice(x.indexOf('{'))).retryInMs as number)
    expect(pauses.length).toBeGreaterThanOrEqual(3)
    expect(pauses.slice(0, 4)).toEqual([50, 100, 200, 400].slice(0, Math.min(4, pauses.length)))
    // it comes back once it starts
    c.mode('ok')
    expect(await l.whenReady(20_000)).toBe(true)
    for (const s of c.seen()) pids.add(s.pid)
    l.want(null)
    expect(l.state()).toBe('off')
    // never answers: stopped after readyMs, tried again
    const slow = ctl('slow')
    const l2 = lib(slow, { readyMs: 300 })
    l2.want(CLIENT)
    await until(() => slow.seen().length >= 2, 40_000)
    for (const s of slow.seen()) pids.add(s.pid)
    expect(l2.logs.some((x) => x.includes('no answer in'))).toBe(true)
    await l2.close()
    for (const s of slow.seen()) await until(() => !alive(s.pid), 20_000)
    // after close nothing starts again
    l2.want(CLIENT)
    expect(l2.state()).not.toBe('starting')
    expect(await l2.whenReady(100)).toBe(false)
  }, 120_000)
})

describe('pieces', () => {
  test('libraryEnv: the allowed few, its own settings, no token cache, no telemetry', () => {
    const e = libraryEnv({ parent: { ...PARENT, SSL_CERT_FILE: '/etc/ssl/x.pem' }, port: 4321, clientId: CLIENT, dir: '/tmp/x' })
    for (const k of Object.keys(e)) {
      const own = ['HOME', 'TMPDIR', 'PORT'].includes(k) || /^(WORKSPACE_|MCP_|EXTERNAL_|GOOGLE_OAUTH_CLIENT_ID$|FASTMCP_|PYTHON|NO_COLOR$)/.test(k)
      expect(`${k}: ${own || (LIBRARY_CHILD_ENV as readonly string[]).includes(k)}`).toBe(`${k}: true`)
    }
    expect(e.PORT).toBe('4321')
    expect(e.SSL_CERT_FILE).toBe('/etc/ssl/x.pem')
    expect(e.WORKSPACE_MCP_TOKEN_VALIDATION_CACHE_TTL).toBeUndefined()
    expect(e.GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined()
    expect(Object.keys(e).some((k) => k.startsWith('OTEL_'))).toBe(false)
    expect(libraryEnv({ parent: {}, port: 1, clientId: CLIENT, dir: '/tmp/x' }).PATH).toBe('/usr/bin:/bin')
  })

  test('a line of its output in the log has no Google token', () => {
    expect(redactLine('401 for ya29.a0AfB_byC-xyz.123 Authorization: Bearer abc.def\n')).toBe('401 for ya29.… Authorization: Bearer …')
  })
})
