// Diagnostics on a Linux install (L16): nftables status file, the launcher (systemd) and its sandbox report over the
// launcher protocol, kernel isolation, cron/at, the disk by its levels; the Linux and Team AX Cloud wording never
// talks about a Mac, and the Mac wording stays byte for byte what it was.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { LauncherStatus } from '@mycel/shared'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { resolveLayout } from '../../server/src/system/layout'
import { M } from '../../server/src/system/messages'
import { engineStatusMessages, hostMessages } from '../../server/src/system/messages-linux'
import { OpsService } from '../../server/src/system/ops'
import { launcherStatus } from '../../server/src/native'
import { T as ENGINE_T } from '../../server/src/admin/engines'

const MAC_WORDS = /맥|\bMac\b|pbpaste|launchctl|\/Library|menubar|메뉴바|Time Machine|\/var\/at|LaunchDaemon|Finder/

/** every entry of a message table rendered with sample arguments */
function render(table: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(table)) {
    const t = typeof v === 'function' ? (v as (...a: unknown[]) => unknown)('label', 'logs', '/dir', 3) : v
    if (t && typeof t === 'object') for (const [l, s] of Object.entries(t as Record<string, string>)) out[`${k}.${l}`] = String(s)
  }
  return out
}

describe('wording', () => {
  test('the Mac keeps its own messages untouched', () => {
    expect(hostMessages('mac', { id: 'mycel', base: '/Library/Application Support/mycel' })).toBe(M)
    expect(engineStatusMessages('mac', '/x')).toEqual({})
    // a few lines a Mac owner knows, byte for byte
    expect(M.firewall.ko).toBe('AI 엔진 방화벽(pf)')
    expect(M.launcherNotRunning('app.treesoop.mycel', '/Library/Logs/mycel').en).toContain('sudo launchctl kickstart -k system/app.treesoop.mycel.launcher')
    expect(ENGINE_T.notInstalled!.ko).toBe('서버 맥에 설치되어 있지 않습니다.')
  })
  // the entries a Linux install's diagnostics and engine status can show
  const USED = ['relay', 'relayOff', 'relayConnecting', 'relayOffline', 'relayReplaced', 'diskTeam', 'diskData', 'diskLow', 'diskReadOnly', 'diskOk',
    'engineOk', 'engineNotInstalled', 'engineNotLoggedIn', 'engineSetupToken', 'engineSetupTokenExpired', 'engineSetupTokenInvalid', 'engineSetupTokenExpiring',
    'subscriptionRejected', 'modelProxy', 'modelProxyOk', 'modelProxyPortInUse', 'modelProxyNotStarted', 'engineCodexLogin', 'engineCheckFailed', 'queue', 'queueDetail', 'queueLong',
    'firewall', 'firewallOk', 'firewallMissing', 'firewallStale', 'firewallOff', 'sandbox', 'sandboxOk', 'sandboxMissing', 'cronDeny', 'cronDenyOk', 'cronDenyMissing',
    'launcher', 'launcherOk', 'launcherDown', 'launcherNotRunning', 'launcherDenied', 'launcherTimeout', 'sockets', 'socketsOk', 'socketsTooLong', 'lan', 'lanOk', 'lanFailed',
    'backups', 'backupNone', 'backupOld', 'backupOk', 'backupFailed', 'backupNoSpace', 'restoreFailed', 'update', 'updateOk', 'updateRolledBack', 'releaseSig', 'releaseUnsigned', 'releaseSigned']
  for (const host of ['linux', 'hosted'] as const) {
    test(`${host}: no Mac, launchctl, pbpaste or /Library in what it can show`, () => {
      const m = hostMessages(host, { id: 'mycel', base: '/var/lib/mycel' }) as unknown as Record<string, unknown>
      const used = render(Object.fromEntries(USED.map((k) => [k, m[k]])))
      for (const [k, s] of Object.entries(used)) expect(MAC_WORDS.test(s), `${host} ${k}: ${s}`).toBe(false)
      const eng = { ...ENGINE_T, ...engineStatusMessages(host, '/var/lib/mycel') }
      for (const [k, s] of Object.entries(render(eng))) expect(MAC_WORDS.test(s), `${host} engine ${k}: ${s}`).toBe(false)
    })
  }
  test('Linux names its commands; Team AX Cloud points at the admin screens or support, never at a server shell', () => {
    const lin = hostMessages('linux', { id: 'mycel-a', base: '/var/lib/mycel-a' })
    expect(lin.launcherNotRunning(null, null).ko).toContain('sudo systemctl restart mycel-a-launcher')
    expect(lin.launcherNotRunning(null, null).en).toContain('journalctl -u mycel-a-launcher -n 100')
    expect(lin.firewallStale.en).toContain('systemctl status mycel-a-firewall.timer')
    expect(lin.engineSetupToken.en).toContain('sudo /var/lib/mycel-a/root/set-claude-token < token-file')
    const hosted = render(hostMessages('hosted', { id: 'mycel', base: '/var/lib/mycel' }) as unknown as Record<string, unknown>)
    for (const k of ['launcherNotRunning.ko', 'firewallMissing.en', 'engineSetupToken.en', 'engineCodexLogin.ko']) expect(hosted[k]).not.toMatch(/sudo|systemctl|journalctl|mycel-ctl/)
    expect(hosted['engineSetupToken.en']).toContain('Admin > AI engines')
    expect(hosted['launcherDown.ko']).toContain('호스팅 지원팀')
  })
})

describe('diagnostics of an installed Linux server', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-ld-')))
  const base = path.join(root, 'b')
  const sock = path.join(root, 'l.sock')
  let ctx: AppContext
  let server: net.Server
  let status: LauncherStatus | null
  const fw = (o: object) => fs.writeFileSync(path.join(base, 'run', 'firewall.json'), JSON.stringify({ format: 1, at: new Date().toISOString(), backend: 'nftables', table: 'inet mycel', loaded: true, rules: 7, engineUid: 990, proxyPort: 47821, sha256: 'x', error: null, ...o }))
  const procSys = path.join(root, 'proc-sys')
  const ops = (o: { hosted?: boolean } = {}) => {
    ctx.config.deployment = o.hosted ? 'hosted' : undefined
    const layout = resolveLayout(ctx.config, { MYCEL_INSTALL_BASE: base, MYCEL_LABEL: 'mycel' }, 'linux')
    return new OpsService(ctx, { layout, platform: 'linux', engines: async () => [], launcherStatus: async () => status, procSysDir: procSys, atDir: path.join(root, 'etc') })
  }
  const check = async (o: { hosted?: boolean } = {}, id = 'sandbox') => (await ops(o).diagnostics('en')).checks.find((c) => c.id === id)
  beforeAll(async () => {
    for (const d of ['run', 'root', 'config', 'data', 'team', 'secrets', 'status']) fs.mkdirSync(path.join(base, d), { recursive: true })
    fs.mkdirSync(path.join(procSys, 'kernel', 'yama'), { recursive: true })
    fs.mkdirSync(path.join(procSys, 'user'), { recursive: true })
    fs.writeFileSync(path.join(procSys, 'kernel', 'yama', 'ptrace_scope'), '1\n')
    fs.writeFileSync(path.join(procSys, 'user', 'max_user_namespaces'), '15000\n')
    fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
    server = net.createServer((c) => c.end()).listen(sock)
    await new Promise((r) => server.once('listening', r))
    const cfg: AppConfig = {
      mode: 'prod', configFile: path.join(base, 'config', 'server.json'), listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
      teamRoot: path.join(base, 'team'), dataDir: path.join(base, 'data'), logDir: null, logLevel: 'error',
      engine: { authMode: 'managed', launcherSock: sock, agentUid: 990, runDir: path.join(root, 'r') }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
      validateResponses: false, setupToken: null,
    }
    ctx = createContext({ config: cfg, db: openDb(path.join(cfg.dataDir, 'app.db')), log: silentLogger })
    status = { ev: 'status', os: 'linux', sandbox: 'bwrap', bwrapVersion: '0.12.0', landlockAbi: 6, landlockMode: 'required-scoped', scoped: true, seccomp: true, cgroup: 'delegated', liveTurns: 0, maxLiveTurns: 4, firewall: { loaded: true, at: null } }
  })
  afterAll(async () => { server.close(); await ctx.close(); fs.rmSync(root, { recursive: true, force: true }) })

  test('firewall: missing, stale, not loaded, ok', async () => {
    expect((await check({}, 'pf_anchor'))).toMatchObject({ status: 'fail', label: 'AI engine firewall (nftables)' })
    expect((await check({}, 'pf_anchor'))!.detail).toContain('sudo mycel-ctl firewall apply')
    fw({ at: new Date(Date.now() - 20 * 60_000).toISOString() })
    expect((await check({}, 'pf_anchor'))!.detail).toContain('mycel-firewall.timer')
    fw({ loaded: false, error: 'nft: table busy' })
    expect((await check({}, 'pf_anchor'))!.detail).toContain('nft: table busy')
    fw({})
    expect(await check({}, 'pf_anchor')).toMatchObject({ status: 'ok', detail: '7 nftables rules (the engine account reaches 127.0.0.1:47821 only)' })
  })
  test('launcher and its sandbox report', async () => {
    expect(await check({}, 'launcher')).toMatchObject({ status: 'ok' })
    expect(await check()).toMatchObject({ status: 'ok', detail: 'Applied to every engine run (bwrap 0.12.0, Landlock ABI 6, seccomp)' })
    status = { ...status!, scoped: false, landlockAbi: 4 }
    expect((await check())!.status).toBe('warn')
    expect((await check({ hosted: true }))!.status).toBe('fail')
    status = { ...status!, landlockAbi: 0 }
    expect((await check())!.detail).toContain('Landlock')
    status = { ...status!, sandbox: 'none' }
    expect((await check())!.status).toBe('fail')
    const keep = status
    status = null
    expect((await check())!.status).toBe('unknown')
    status = { ...keep!, sandbox: 'bwrap', landlockAbi: 6, scoped: true }
  })
  test('kernel isolation: ptrace_scope, cgroup delegation, user namespaces', async () => {
    expect((await check({}, 'kernel_isolation'))!.status).toBe('ok')
    fs.writeFileSync(path.join(procSys, 'kernel', 'yama', 'ptrace_scope'), '0\n')
    status = { ...status!, cgroup: 'none' }
    const k = await check({}, 'kernel_isolation')
    expect(k!.status).toBe('warn')
    expect(k!.detail).toContain('ptrace_scope')
    expect(k!.detail).toContain('cgroup')
    expect((await check({ hosted: true }, 'kernel_isolation'))!.status).toBe('fail')
    fs.writeFileSync(path.join(procSys, 'kernel', 'yama', 'ptrace_scope'), '1\n')
    status = { ...status!, cgroup: 'delegated' }
  })
  test('cron / at: absent is fine; present without the engine account warns', async () => {
    expect(await check({}, 'cron_deny')).toMatchObject({ status: 'ok' })
    fs.writeFileSync(path.join(root, 'etc', 'cron.deny'), 'someone\n')
    expect(await check({}, 'cron_deny')).toMatchObject({ status: 'warn' })
    fs.rmSync(path.join(root, 'etc', 'cron.deny'))
  })
  test('no Mac-only checks; the disk by levels; hosted wording', async () => {
    fw({})
    const d = await ops().diagnostics('ko')
    expect(d.checks.find((c) => c.id === 'time_machine')).toBeUndefined()
    expect(d.checks.find((c) => c.id === 'disk.team')!.label).toBe('저장 공간')
    for (const c of d.checks) expect(MAC_WORDS.test(`${c.label} ${c.detail ?? ''}`), `${c.id}: ${c.detail}`).toBe(false)
    const hd = await ops({ hosted: true }).diagnostics('en')
    expect(hd.checks.find((c) => c.id === 'sockets')).toBeUndefined()
    expect(hd.checks.find((c) => c.id === 'update')!.detail).toContain('the hosting provider installs updates')
    for (const c of hd.checks) expect(`${c.detail ?? ''}`).not.toMatch(/sudo |systemctl|journalctl/)
  })
  test('the launcher protocol: {"op":"status"} -> one status line (an older launcher\'s error = null)', async () => {
    const s2 = path.join(root, 's2.sock')
    const srv = net.createServer((c) => c.on('data', (b) => {
      const req = JSON.parse(b.toString().split('\n')[0]!)
      c.end(req.op === 'status' ? JSON.stringify({ ev: 'status', os: 'linux', sandbox: 'bwrap', landlockAbi: 6, scoped: true, seccomp: true, cgroup: 'delegated', extra: 1 }) + '\n' : '')
    })).listen(s2)
    await new Promise((r) => srv.once('listening', r))
    expect(await launcherStatus(s2)).toMatchObject({ ev: 'status', sandbox: 'bwrap', landlockAbi: 6 })
    srv.close()
    const s3 = path.join(root, 's3.sock')
    const old = net.createServer((c) => c.on('data', () => c.end(JSON.stringify({ ev: 'error', message: 'unknown op' }) + '\n'))).listen(s3)
    await new Promise((r) => old.once('listening', r))
    expect(await launcherStatus(s3)).toBeNull()
    old.close()
    expect(await launcherStatus(path.join(root, 'none.sock'), 500)).toBeNull()
  })
})
