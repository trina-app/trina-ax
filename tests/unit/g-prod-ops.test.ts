// Production ops gaps found by the install-guide check (fix/prod-ops):
// (a) Diagnostics no longer ends the server when launcher.sock is missing, and says "AI launcher not running" with
//     the command that starts it again;
// (b) socket paths too long for a Unix socket address are named at start, in Diagnostics and when the engine starts;
// (c) `bun run dev` names the process that holds a dev port (scripts/dev-checks.ts);
// (d) GET /api/connect-info + POST /api/connect-info/lan-failure (desktop pinning, failures in Diagnostics);
// (e) the connection change asks for the relay team name and does not offer the official relay while it is not running.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Hono } from 'hono'
import { ConnectInfo, uuidv7, type Diagnostics } from '@mycel/shared/api'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { CoreUnavailableError, createContext, startLocalCore, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import type { AppEnv } from '../../server/src/http/env'
import { silentLogger, type Logger } from '../../server/src/log'
import { checkSocketPaths, processAlive, watchSupervisor } from '../../server/src/main'
import { ROUTE_MODULES, type RouteModule } from '../../server/src/routes'
import { systemTestHooks } from '../../server/src/routes/system'
import type { AuthInfo, SessionService } from '../../server/src/services'
import { connectInfo, isPrivateV4, lanHosts, serverTeamId } from '../../server/src/system/connect-info'
import { availableModes } from '../../server/src/system/connection'
import { resolveLayout } from '../../server/src/system/layout'
import { OpsService } from '../../server/src/system/ops'
import { SocketLauncher } from '../../server/src/native'
import { engineSockets, maxSocketPathBytes, probeSocket, tooLongSockets, underSandboxDeniedTmp } from '../../server/src/system/sockets'
import { checkDataDir, checkPorts, portHolders } from '../../scripts/dev-checks'
import { WORK } from '../lib/env'
import { PRODUCT } from '@mycel/shared'

const BASE = path.join(WORK, 'g-prod-ops')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
// sockets for the probes live in a short folder: WORK can be deep enough to make them too long by itself
const SHORT = fs.mkdtempSync('/tmp/axpo-')

// every uncaught exception during these tests is a failure (the launcher probe used to throw one)
const uncaught: Error[] = []
const onUncaught = (e: Error) => { uncaught.push(e) }
process.on('uncaughtException', onUncaught)

const people: Record<string, AuthInfo> = {
  owner: { user: { id: 'olga', username: 'olga', name: 'Olga', role: 'owner', locale: 'en', mustChangePassword: false }, session: { id: uuidv7(), client: 'desktop' }, via: 'cookie' },
  ownerLaptop: { user: { id: 'olga', username: 'olga', name: 'Olga', role: 'owner', locale: 'en', mustChangePassword: false }, session: { id: uuidv7(), client: 'desktop' }, via: 'cookie' },
  member: { user: { id: 'bob', username: 'bob', name: 'Bob', role: 'member', locale: 'en', mustChangePassword: false }, session: { id: uuidv7(), client: 'desktop' }, via: 'cookie' },
}
const sessions: SessionService = {
  async resolve(req) { return people[req.headers.get('x-test-user') ?? ''] ?? null },
  async verifyPassword(_u, pw) { return pw === 'owner-pass' },
}
const sessionModule: RouteModule = { name: 'po-test-sessions', owner: 'A', init(ctx) { ctx.services.sessions = sessions }, register() {} }

function selfSignedCert(dir: string): { certFile: string; keyFile: string; fp: string } {
  fs.mkdirSync(dir, { recursive: true })
  const certFile = path.join(dir, 'lan.crt'), keyFile = path.join(dir, 'lan.key')
  const r = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=team-ax-test'], { stdout: 'ignore', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error('openssl failed: ' + r.stderr.toString())
  return { certFile, keyFile, fp: new crypto.X509Certificate(fs.readFileSync(certFile)).fingerprint256 }
}

function config(dir: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
    teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: null, ...over,
  }
}

async function makeApp(cfg: AppConfig) {
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  fs.mkdirSync(cfg.teamRoot, { recursive: true })
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  db.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner')").run()
  db.query("INSERT INTO users (id, username, name, role) VALUES ('bob', 'bob', 'Bob', 'member')").run()
  const ctx = createContext({ config: cfg, db, log: silentLogger })
  const app = await buildApp(ctx, [...ROUTE_MODULES, sessionModule])
  return { ctx, app, db }
}

const call = (app: Hono<AppEnv>, p: string, init: RequestInit & { as?: keyof typeof people } = {}) => {
  const h = new Headers(init.headers)
  if (init.as) h.set('x-test-user', init.as)
  if (init.method && init.method !== 'GET') h.set('x-mycel-csrf', '1')
  if (init.body) h.set('content-type', 'application/json')
  return app.fetch(new Request('http://team.localhost' + p, { ...init, headers: h }), { ip: '10.0.0.9', via: 'test' })
}

afterAll(() => {
  process.off('uncaughtException', onUncaught)
  fs.rmSync(SHORT, { recursive: true, force: true })
})

// ------------------------------------------------------------------------------------------------ (a) + (b)

describe('socket probe', () => {
  test('missing, stale, not a socket, too long, listening: never throws, never leaves an uncaught error', async () => {
    expect(await probeSocket(path.join(SHORT, 'nope', 'launcher.sock'))).toBe('missing')
    expect(await probeSocket(path.join(SHORT, 'missing.sock'))).toBe('missing')
    fs.writeFileSync(path.join(SHORT, 'plain'), 'x')
    expect(await probeSocket(path.join(SHORT, 'plain'))).toBe('not_socket')
    expect(await probeSocket('/' + 'x'.repeat(maxSocketPathBytes()) + '.sock')).toBe('too_long')
    // a socket file left by a launcher that was killed: connect is refused
    const stale = path.join(SHORT, 'stale.sock')
    const child = Bun.spawn(['bun', '-e', `require('node:net').createServer().listen(${JSON.stringify(stale)}, () => console.log('up'))`], { stdout: 'pipe' })
    const reader = child.stdout.getReader()
    await reader.read()
    child.kill('SIGKILL')
    await child.exited
    expect(fs.statSync(stale).isSocket()).toBe(true)
    expect(await probeSocket(stale)).toBe('refused')
    const live = path.join(SHORT, 'live.sock')
    const srv = net.createServer((c) => c.end()).listen(live)
    await new Promise((r) => srv.once('listening', r))
    expect(await probeSocket(live)).toBe('ok')
    srv.close()
    await Bun.sleep(100)
    expect(uncaught).toEqual([])
  })

  test('socket path limits and temporary folders', () => {
    expect(maxSocketPathBytes('darwin')).toBe(103)
    expect(maxSocketPathBytes('linux')).toBe(107)
    const ok = engineSockets('/Library/Application Support/mycel/run/tools', '/Library/Application Support/mycel/run-launcher/launcher.sock')
    expect(tooLongSockets(ok, 'darwin')).toEqual([])
    const long = tooLongSockets(engineSockets('/Users/someone/' + 'd'.repeat(80) + '/data/run'), 'darwin')
    expect(long.map((x) => x.name)).toEqual(['tools', 'server', 'launcher'])
    expect(long[0]!.bytes).toBeGreaterThan(103)
    expect(underSandboxDeniedTmp('/tmp/x/data/run')).toBe(true)
    expect(underSandboxDeniedTmp('/private/var/folders/ab/T/x')).toBe(true)
    expect(underSandboxDeniedTmp('/Users/me/.team-ax-dev/data/run')).toBe(false)
    expect(underSandboxDeniedTmp('/tmpfoo/x')).toBe(false)
  })
})

describe('the launcher client inside a request (Bun throws a failed Unix connect made in a handler\'s microtasks)', () => {
  test('a chat started while the launcher daemon is down ends with an error event, not a dead server', async () => {
    const missing = path.join(SHORT, 'down', 'launcher.sock')
    const srv = Bun.serve({
      hostname: '127.0.0.1', port: 0, idleTimeout: 10,
      async fetch(req) {
        const l = new SocketLauncher(missing)
        if (new URL(req.url).pathname === '/peer') return Response.json(await l.tcpPeer(1, 2))
        // synchronously in the handler, as the chat route does when it starts a turn
        const h = l.launch({ op: 'launch' } as any)
        const evs: unknown[] = []
        for await (const e of h.events) evs.push(e)
        return Response.json(evs)
      },
    })
    try {
      const evs = (await (await fetch(`http://127.0.0.1:${srv.port}/launch`)).json()) as { ev: string; message: string }[]
      expect(evs).toHaveLength(1)
      expect(evs[0]!.ev).toBe('error')
      expect(evs[0]!.message).toContain('launcher:')
      expect(await (await fetch(`http://127.0.0.1:${srv.port}/peer`)).json()).toBeNull()
      expect(await probeSocket(missing)).toBe('missing')
      await Bun.sleep(100)
      expect(uncaught).toEqual([])
    } finally {
      srv.stop(true)
    }
  })
})

describe('diagnostics in an installed layout with the launcher down', () => {
  test('over real HTTP: answers, says the launcher is not running and how to start it; the server keeps running', async () => {
    const dir = path.join(BASE, 'prod')
    const base = path.join(dir, 'base')
    for (const d of ['root', 'status', 'run', 'secrets', 'ld']) fs.mkdirSync(path.join(base, d), { recursive: true })
    fs.writeFileSync(path.join(base, 'root', 'pf.anchor'), 'x')
    // the launcher's folder exists, its socket does not (the LaunchDaemon is not running)
    const runLauncher = path.join(SHORT, 'run-launcher')
    fs.mkdirSync(runLauncher, { recursive: true })
    const sock = path.join(runLauncher, 'launcher.sock')
    const cfg = config(dir, { mode: 'prod', engine: { authMode: 'local-login', runDir: path.join(SHORT, 'run'), launcherSock: sock, agentUid: process.getuid!() }, configFile: path.join(base, 'config', 'server.json') })
    const layout = resolveLayout(cfg, { MYCEL_INSTALL_BASE: base, MYCEL_LAUNCHDAEMONS_DIR: path.join(base, 'ld'), MYCEL_LABEL: 'app.treesoop.mycel-po' })
    systemTestHooks.opsOptions = { layout: { ...layout, logDir: '/Library/Logs/mycel-po' }, engines: async () => [], tmutil: async () => true, atDir: base }
    let ctx: AppContext | null = null
    let server: ReturnType<typeof Bun.serve> | null = null
    try {
      const made = await makeApp(cfg)
      ctx = made.ctx
      const app = made.app
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req, s) => app.fetch(req, { ip: s.requestIP(req)?.address ?? null, via: 'direct', server: s }) })
      const origin = `http://127.0.0.1:${server.port}`
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${origin}/api/admin/diagnostics`, { headers: { 'x-test-user': 'owner' } })
        expect(r.status).toBe(200)
        const d = (await r.json()) as Diagnostics
        const l = d.checks.find((c) => c.id === 'launcher')!
        expect(l.status).toBe('fail')
        expect(l.detail).toContain('not running')
        expect(l.detail).toContain('sudo launchctl kickstart -k system/app.treesoop.mycel-po.launcher')
        expect(l.detail).toContain('/Library/Logs/mycel-po/crash/launcher.log')
        // a launcher job that was booted out is not reached by kickstart: the load command is named too
        expect(l.detail).toContain(`sudo launchctl bootstrap system ${path.join(base, 'ld')}/app.treesoop.mycel-po.launcher.plist`)
      }
      await Bun.sleep(200)
      expect(uncaught).toEqual([])
      expect((await fetch(`${origin}/api/health`)).status).toBe(200)
      // a stale socket file from a launcher that ended reads the same
      const child = Bun.spawn(['bun', '-e', `require('node:net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`], { stdout: 'pipe' })
      await child.stdout.getReader().read()
      child.kill('SIGKILL')
      await child.exited
      const d2 = (await (await fetch(`${origin}/api/admin/diagnostics`, { headers: { 'x-test-user': 'owner' } })).json()) as Diagnostics
      expect(d2.checks.find((c) => c.id === 'launcher')!.detail).toContain('not running')
      expect(d2.checks.find((c) => c.id === 'sockets')!.status).toBe('ok')
      expect(uncaught).toEqual([])
      // the launcher running again: exactly one launcher check, "Connected" (a running launcher used to get a
      // second "Cannot reach the engine launcher" fail next to it)
      fs.rmSync(sock, { force: true })
      const live = net.createServer((c) => c.end()).listen(sock)
      await new Promise((r) => live.once('listening', r))
      try {
        const d3 = (await (await fetch(`${origin}/api/admin/diagnostics`, { headers: { 'x-test-user': 'owner' } })).json()) as Diagnostics
        const ls = d3.checks.filter((c) => c.id === 'launcher')
        expect(ls.map((c) => [c.status, c.detail])).toEqual([['ok', 'Connected']])
      } finally {
        live.close()
      }
    } finally {
      systemTestHooks.opsOptions = null
      server?.stop(true)
      await ctx?.close()
    }
  })
})

describe('socket paths too long', () => {
  const longDir = path.join(BASE, 'L'.repeat(Math.max(10, 110 - BASE.length)))
  test('named at start, in Diagnostics, and when a chat starts the engine', async () => {
    const cfg = config(longDir)
    const { ctx, app } = await makeApp(cfg)
    try {
      const lines: string[] = []
      const log: Logger = { debug() {}, info() {}, warn: (m) => lines.push('warn ' + m), error: (m) => lines.push('error ' + m), child: () => log }
      const m = checkSocketPaths(ctx, log)
      expect(m).toContain('socket path too long')
      expect(m).toContain(path.join(cfg.dataDir, 'run', 'tools.sock'))
      expect(m).toContain('~/.team-ax-dev')
      expect(lines[0]).toStartWith('error socket path too long')
      // the engine core refuses with the same words instead of a generic gate failure
      const err = await startLocalCore(ctx).then(() => null, (e) => e)
      expect(err).toBeInstanceOf(CoreUnavailableError)
      expect(String(err.message)).toContain('socket path too long')
      const d = (await (await call(app, '/api/admin/diagnostics', { as: 'owner' })).json()) as Diagnostics
      const s = d.checks.find((c) => c.id === 'sockets')!
      expect(s.status).toBe('fail')
      expect(s.detail).toContain('Socket path too long')
      expect(s.detail).toContain('bytes')
    } finally {
      await ctx.close()
    }
  })
  test('a short data folder passes', async () => {
    const cfg = config(path.join(BASE, 's'))
    const { ctx, app } = await makeApp(cfg)
    try {
      if (!underSandboxDeniedTmp(cfg.dataDir)) expect(checkSocketPaths(ctx, silentLogger)).toBeNull()
      const d = (await (await call(app, '/api/admin/diagnostics', { as: 'owner' })).json()) as Diagnostics
      expect(d.checks.find((c) => c.id === 'sockets')!.status).not.toBe('fail')
    } finally {
      await ctx.close()
    }
  })
})

// ------------------------------------------------------------------------------------------------ (c)

describe('dev runner preflight (scripts/dev-checks.ts)', () => {
  test('a taken port names the process that holds it; a free port passes', async () => {
    // a port nobody else uses (other suites and worktrees run beside this one)
    const srv = net.createServer().listen(0, '127.0.0.1')
    await new Promise((r) => srv.once('listening', r))
    const port = (srv.address() as net.AddressInfo).port
    try {
      const holders = portHolders(port)
      if (holders.length) expect(holders.map((h) => h.pid)).toContain(process.pid)
      const p = await checkPorts([{ port, what: 'team server' }])
      expect(p.length).toBe(1)
      expect(p[0]).toContain(`port ${port} (team server) is in use by`)
      if (holders.length) expect(p[0]).toContain(`pid ${process.pid}`)
      // a dev process is recognised and the dev service named as the likely holder
      const fake = await checkPorts([{ port, what: 'team server' }], () => [{ pid: 42, command: 'bun --watch server/src/main.ts' }])
      expect(fake[0]).toContain('bun run dev:service stop')
    } finally {
      srv.close()
    }
    await Bun.sleep(50)
    expect(await checkPorts([{ port, what: 'team server' }])).toEqual([])
  })
  test('a data folder whose sockets do not fit stops the runner; /tmp warns on macOS', () => {
    expect(checkDataDir('/Users/me/.team-ax-dev/data', 'darwin')).toEqual({ errors: [], warnings: [] })
    const long = checkDataDir('/Users/me/' + 'x'.repeat(90) + '/data', 'darwin')
    expect(long.errors[0]).toContain('socket path too long')
    expect(checkDataDir('/tmp/axdev/data', 'darwin').warnings[0]).toContain('engine sandbox')
    expect(checkDataDir('/tmp/axdev/data', 'linux').warnings).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------ (d)

describe('connect-info and LAN failure reports', () => {
  let ctx: AppContext
  let app: Hono<AppEnv>
  let fp = ''
  beforeAll(async () => {
    const dir = path.join(BASE, 'ci')
    const cert = selfSignedCert(path.join(dir, 'secrets'))
    fp = cert.fp
    ;({ ctx, app } = await makeApp(config(dir, { tls: { port: 8443, certFile: cert.certFile, keyFile: cert.keyFile } })))
  })
  afterAll(async () => { await ctx.close() })

  test('signed-in users only; the pinned fingerprint, port and LAN hosts; a stable team id', async () => {
    expect((await call(app, '/api/connect-info')).status).toBe(401)
    const r = await call(app, '/api/connect-info', { as: 'member' })
    expect(r.status).toBe(200)
    const ci = ConnectInfo.parse(await r.json())
    expect(ci.lanCertSha256).toBe(fp)
    expect(ci.lanPort).toBe(8443)
    expect(ci.teamId).toBe(serverTeamId(ctx.db))
    const again = ConnectInfo.parse(await (await call(app, '/api/connect-info', { as: 'owner' })).json())
    expect(again.teamId).toBe(ci.teamId)
    for (const h of ci.lanHosts) expect(h.endsWith('.local') || isPrivateV4(h)).toBe(true)
  })

  test('LAN hosts: the Bonjour name first, then private IPv4 addresses only', () => {
    const hosts = lanHosts({
      localHostName: () => 'Acme-Mac',
      interfaces: () => ({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as any],
        en0: [{ address: '192.168.0.20', family: 'IPv4', internal: false } as any, { address: 'fe80::1', family: 'IPv6', internal: false } as any],
        en1: [{ address: '10.1.2.3', family: 'IPv4', internal: false } as any, { address: '8.8.8.8', family: 'IPv4', internal: false } as any],
        utun: [{ address: '172.16.5.5', family: 'IPv4', internal: false } as any, { address: '172.32.0.1', family: 'IPv4', internal: false } as any],
      }),
    })
    expect(hosts).toEqual(['Acme-Mac.local', '192.168.0.20', '10.1.2.3', '172.16.5.5'])
    expect(lanHosts({ localHostName: () => 'bad name;rm', interfaces: () => ({}) })).toEqual([])
  })

  test('no office connection: no fingerprint, no LAN addresses', async () => {
    const { ctx: c2 } = await makeApp(config(path.join(BASE, 'ci-off')))
    try {
      const ci = connectInfo(c2)
      expect(ci.lanCertSha256).toBeNull()
      expect(ci.lanHosts).toEqual([])
    } finally {
      await c2.close()
    }
  })

  test('a failure counts once per session per hour and shows in Diagnostics', async () => {
    const before = (await (await call(app, '/api/admin/diagnostics', { as: 'owner' })).json()) as Diagnostics
    expect(before.checks.find((c) => c.id === 'lan_direct')).toMatchObject({ status: 'ok' })
    const post = (as: keyof typeof people, code: string) => call(app, '/api/connect-info/lan-failure', { method: 'POST', as, body: JSON.stringify({ code }) })
    expect((await call(app, '/api/connect-info/lan-failure', { method: 'POST', body: JSON.stringify({ code: 'timeout' }) })).status).toBe(401)
    expect((await post('member', 'nope')).status).toBe(400)
    for (let i = 0; i < 5; i++) expect((await post('member', 'unreachable')).status).toBe(204)
    expect((await post('ownerLaptop', 'cert_mismatch')).status).toBe(204)
    const d = (await (await call(app, '/api/admin/diagnostics', { as: 'owner' })).json()) as Diagnostics
    const lan = d.checks.find((c) => c.id === 'lan_direct')!
    expect(lan.status).toBe('warn')
    expect(lan.detail).toContain('2 times')
    expect(lan.detail).toContain('1 of them saw a different certificate')
    expect(lan.detail).toContain('port 8443')
  })

  test('the counter: once per session per hour, 24 hours kept', () => {
    let now = Date.parse('2026-10-21T10:00:00Z')
    const ops = new OpsService(ctx, { now: () => new Date(now), engines: async () => [] })
    expect(ops.recordLanFailure('s1', 'timeout')).toBe(true)
    expect(ops.recordLanFailure('s1', 'unreachable')).toBe(false)
    expect(ops.recordLanFailure('s2', 'unreachable')).toBe(true)
    now += 61 * 60_000
    expect(ops.recordLanFailure('s1', 'timeout')).toBe(true)
    expect(ops.lanFailureSummary()).toEqual({ total: 3, byCode: { unreachable: 1, cert_mismatch: 0, timeout: 2 } })
    now += 24 * 3600_000
    expect(ops.lanFailureSummary().total).toBe(0)
  })
})

// ------------------------------------------------------------------------------------------------ (e)

describe('connection change: relay team name, official relay only when it runs', () => {
  let ctx: AppContext
  let app: Hono<AppEnv>
  let cfgFile = ''
  beforeAll(async () => {
    const dir = path.join(BASE, 'conn')
    fs.mkdirSync(dir, { recursive: true })
    cfgFile = path.join(dir, 'server.json')
    fs.writeFileSync(cfgFile, JSON.stringify({ listen: { port: 19765 } }))
    systemTestHooks.restart = () => {}
    ;({ ctx, app } = await makeApp(config(dir, { configFile: cfgFile })))
  })
  afterAll(async () => { systemTestHooks.restart = null; await ctx.close() })
  const put = (body: object) => call(app, '/api/admin/connection', { method: 'PUT', as: 'owner', body: JSON.stringify({ password: 'owner-pass', ...body }) })

  test('the status lists the modes on offer and the team name', async () => {
    const s = await (await call(app, '/api/admin/connection', { as: 'owner' })).json()
    expect(s.availableModes).toEqual(['self-relay', 'direct-only'])
    expect(s.teamName).toBeNull()
    expect(availableModes({ ...ctx.config, relay: { ...ctx.config.relay, officialAvailable: true } })).toEqual(['relay', 'self-relay', 'direct-only'])
  })

  test('the official relay is refused while it is not running', async () => {
    const r = await put({ mode: 'relay' })
    expect(r.status).toBe(409)
    expect(((await r.json()) as any).error.message).toContain(`${PRODUCT.displayName} relay is not running`)
    expect(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).relay).toBeUndefined()
  })

  test('your own relay needs a team name; a valid one is saved into server.json', async () => {
    const missing = await put({ mode: 'self-relay', relayUrl: 'wss://relay.example.org/connect' })
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as any).error.fields).toEqual({ 'body.teamName': 'required' })
    expect((await put({ mode: 'self-relay', relayUrl: 'wss://relay.example.org/connect', teamName: 'Bad_Name' })).status).toBe(400)
    expect((await put({ mode: 'self-relay', relayUrl: 'wss://relay.example.org/connect', teamName: '-acme' })).status).toBe(400)
    const ok = await put({ mode: 'self-relay', relayUrl: 'wss://relay.example.org/connect', teamName: 'Acme-Sales' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ mode: 'self-relay', state: 'connecting', teamName: 'acme-sales' })
    expect(JSON.parse(fs.readFileSync(cfgFile, 'utf8'))).toMatchObject({ listen: { port: 19765 }, relay: { url: 'wss://relay.example.org/connect', teamName: 'acme-sales' } })
    // the name stays when only the address changes; office-only keeps it for later
    expect((await put({ mode: 'self-relay', relayUrl: 'wss://relay2.example.org/connect' })).status).toBe(200)
    expect((await put({ mode: 'direct-only' })).status).toBe(200)
    expect(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).relay).toEqual({ url: null, teamName: 'acme-sales' })
  })
})

// UPSTREAM-CANDIDATES (medical fork) item 6: the server is in its own process group, so a bootstrap killed outright
// left it running and holding the port
describe('under mycel-bootstrap: the server ends when its supervisor is gone', () => {
  test('no supervisor variable (dev, office): nothing is watched', () => {
    expect(watchSupervisor(undefined, () => true, () => {})).toBeNull()
    expect(watchSupervisor('1', () => true, () => {})).toBeNull()
    expect(watchSupervisor('abc', () => true, () => {})).toBeNull()
  })
  test('the supervisor exits (bootstrap killed): onGone once', async () => {
    let up = true, gone = 0
    const stop = watchSupervisor('4242', () => up, () => { gone++ }, 20)!
    await Bun.sleep(80)
    expect(gone).toBe(0)
    up = false
    await Bun.sleep(80)
    expect(gone).toBe(1)
    stop()
  })
  test('processAlive: a real child that exited is gone (Bun never updates process.ppid, so the check uses kill 0)', async () => {
    const c = Bun.spawn(['sleep', '30'])
    expect(processAlive(c.pid)).toBe(true)
    c.kill('SIGKILL'); await c.exited
    expect(processAlive(c.pid)).toBe(false)
    expect(processAlive(process.pid)).toBe(true)
  })
})
