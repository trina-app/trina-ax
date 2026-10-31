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
import { EXIT_ADDRESS_URL, learnExitAddresses, noteEgressIp } from '../../server/src/tools/egress'
import { publicAddress } from '../../server/src/system/connection'
import { SERVICE_HOSTS } from '../../shared/src/service-hosts'

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
  const USED = ['relay', 'relayOff', 'relayPublic', 'relayConnecting', 'relayOffline', 'relayReplaced', 'diskTeam', 'diskData', 'diskLow', 'diskReadOnly', 'diskOk',
    'engineOk', 'engineNotInstalled', 'engineNotLoggedIn', 'engineSetupToken', 'engineSetupTokenExpired', 'engineSetupTokenInvalid', 'engineSetupTokenExpiring',
    'subscriptionRejected', 'modelProxy', 'modelProxyOk', 'modelProxyPortInUse', 'modelProxyNotStarted', 'engineCodexLogin', 'engineCheckFailed', 'queue', 'queueDetail', 'queueLong',
    'firewall', 'firewallOk', 'firewallMissing', 'firewallStale', 'firewallOff', 'sandbox', 'sandboxOk', 'sandboxMissing', 'cronDeny', 'cronDenyOk', 'cronDenyMissing',
    'launcher', 'launcherOk', 'launcherDown', 'launcherNotRunning', 'launcherDenied', 'launcherTimeout', 'sockets', 'socketsOk', 'socketsTooLong', 'lan', 'lanOk', 'lanFailed',
    'backups', 'backupNone', 'backupOld', 'backupOk', 'backupFailed', 'backupNoSpace', 'restoreFailed', 'update', 'updateOk', 'updateRolledBack', 'releaseSig', 'releaseUnsigned', 'releaseSigned',
    'exitAddress', 'exitAddressKnown', 'exitAddressKnownRelay', 'exitAddressUnknown', 'exitAddressOff']
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
  // QA: a Linux server reached through a Cloudflare tunnel (or its own domain) said the team could only connect from
  // the office network. The line now says what the server knows: relay connected, a public address set up, or neither.
  test('the relay line: office network only, a public address set up (tunnel.host or an origin), relay connected', async () => {
    const relay = async (o: { hosted?: boolean } = {}, locale: 'en' | 'ko' = 'en') => (await ops(o).diagnostics(locale)).checks.find((c) => c.id === 'relay')!
    const { tunnel, publicOrigins } = ctx.config
    const relayService = ctx.services.relay
    try {
      // neither: office network only, and how to change that on this server
      const off = await relay()
      expect(off).toMatchObject({ label: 'Remote access (relay)', status: 'warn' })
      expect(off.detail).toContain('No relay or public address is set up, so the team can connect only from the office network.')
      expect(off.detail).toContain('Admin > System > Connection')
      expect(off.detail).toContain('--public-host <HOST>')
      expect((await relay({}, 'ko')).detail).toStartWith('중계 서버도 공개 주소도 설정되어 있지 않아서 사무실 네트워크에서만 접속할 수 있어요.')
      // the hosted cloud keeps pointing at support, never at a shell
      expect((await relay({ hosted: true })).detail).toContain('Contact the hosting support team')
      // origins that are not a public address: plain http, localhost, an IP address, a local name, another port
      ctx.config.publicOrigins = ['http://team.example.com', 'https://localhost', 'https://203.0.113.9', 'https://nas.local', 'https://team.example.com:8443']
      expect((await relay()).status).toBe('warn')
      // the Linux installer's --public-host (tunnel.host): no relay needed, from outside too
      ctx.config.tunnel = { host: 'team.example.com', allowFrom: [], countries: [] }
      expect(await relay()).toMatchObject({ status: 'ok', detail: 'A public address is set up (https://team.example.com), so the team can connect from outside without the relay.' })
      expect((await relay({}, 'ko')).detail).toBe('공개 주소(https://team.example.com)가 설정되어 있어요. 중계 서버 없이도 밖에서 이 주소로 접속할 수 있어요.')
      expect((await relay({ hosted: true })).status).toBe('ok')
      // the server's own domain in publicOrigins (MYCEL_PUBLIC_ORIGINS) counts too
      ctx.config.tunnel = null
      ctx.config.publicOrigins = ['http://localhost:47820', 'https://ax.example.org']
      expect((await relay()).detail).toContain('(https://ax.example.org)')
      // a hosted team address in publicOrigins (the control plane lists it there) is the relay's: a hosted server whose
      // relay is not registered yet still says so and points at support, not "connect from outside without the relay"
      ctx.config.publicOrigins = [`https://acme.${SERVICE_HOSTS.teamDomain}`]
      expect(await relay({ hosted: true })).toMatchObject({ status: 'warn', detail: expect.stringContaining('Contact the hosting support team') })
      expect((await relay()).status).toBe('warn')
      // this server's address at its own relay is not a way around the relay either
      ctx.config.publicOrigins = ['https://acme.relay.example.org', 'https://ax.example.org']
      ctx.services.relay = { status: () => ({ mode: 'self-relay', address: 'https://acme.relay.example.org', state: 'not_registered', detail: null, connectedSince: null, direct: { enabled: false, port: 8443, fingerprintSha256: null } }) }
      expect((await relay()).detail).toContain('(https://ax.example.org)')
      // a connected relay shows its address, as before
      ctx.services.relay = { status: () => ({ mode: 'self-relay', address: 'https://acme.relay.example', state: 'connected', detail: null, connectedSince: new Date().toISOString(), direct: { enabled: false, port: 8443, fingerprintSha256: null } }) }
      expect(await relay()).toMatchObject({ status: 'ok', detail: 'https://acme.relay.example' })
    } finally {
      ctx.config.tunnel = tunnel
      ctx.config.publicOrigins = publicOrigins
      ctx.services.relay = relayService
    }
  })
  test('publicAddress: tunnel.host first, else the first https origin with an internet name on the standard port', () => {
    expect(publicAddress({ tunnel: null, publicOrigins: [] })).toBeNull()
    expect(publicAddress({ tunnel: { host: 'a.example.com', allowFrom: [], countries: [] }, publicOrigins: ['https://b.example.com'] })).toBe('a.example.com')
    expect(publicAddress({ tunnel: null, publicOrigins: ['https://mini.local:8443', 'https://192.168.1.5:8443', 'http://acme.localhost:19100', 'https://acme.localhost', 'https://[2001:db8::1]', 'not a url', 'https://B.Example.com/'] })).toBe('b.example.com')
    for (const o of ['https://server.lan', 'https://box.home.arpa', 'https://srv.internal', 'https://team.example.com:443x', 'https://ci.test', 'https://nas.localdomain', 'https://ax.example', 'https://x.invalid', 'https://srv.private'])
      expect(publicAddress({ tunnel: null, publicOrigins: [o] }), o).toBeNull()
    // the standard port written out, a trailing dot, an internationalized name (punycode, as tunnel.host is kept)
    expect(publicAddress({ tunnel: null, publicOrigins: ['https://team.example.com:443'] })).toBe('team.example.com')
    expect(publicAddress({ tunnel: null, publicOrigins: ['https://team.example.com.'] })).toBe('team.example.com')
    expect(publicAddress({ tunnel: null, publicOrigins: ['https://팀.예시.한국'] })).toMatch(/^xn--[a-z0-9-]+\.xn--[a-z0-9-]+\.xn--[a-z0-9-]+$/)
    // a relay's team address: the hosted service's (<team>.trina.app) and this server's at its own relay
    expect(publicAddress({ tunnel: null, publicOrigins: [`https://acme.${SERVICE_HOSTS.teamDomain}`, `https://${SERVICE_HOSTS.teamDomain}`, 'https://ax.example.org'] })).toBe('ax.example.org')
    expect(publicAddress({ tunnel: null, publicOrigins: ['https://acme.relay.example.org'] }, 'https://acme.relay.example.org')).toBeNull()
    expect(publicAddress({ tunnel: null, publicOrigins: ['https://acme.relay.example.org'] }, 'not a url')).toBe('acme.relay.example.org')
    // credentials or a path in an origin never come out: the host only
    expect(publicAddress({ tunnel: null, publicOrigins: ['https://user:secret@ax.example.org/path?q=1'] })).toBe('ax.example.org')
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
  test('the public exit address (QA 0.2.12 N5): unknown, turned off, known by family or by the relay; never the address itself', async () => {
    const env = 'MYCEL_EXIT_ADDRESS_CHECK'
    const before = process.env[env]
    const exit = async (o: { hosted?: boolean } = {}, locale: 'en' | 'ko' = 'en') => (await ops(o).diagnostics(locale)).checks.find((c) => c.id === 'exit_address')!
    try {
      delete process.env[env]
      const unknown = await exit()
      expect(unknown).toMatchObject({ group: 'connection', label: 'Public address of the server', status: 'warn' })
      // what "unknown" means for the team, and what the server does about it
      expect(unknown.detail).toContain('every web address the AI opens asks a person, and scheduled tasks open none')
      expect(unknown.detail).toContain(EXIT_ADDRESS_URL)
      expect((await exit({}, 'ko')).detail).toContain('예약 작업은 웹 주소를 하나도 열지 않아요')
      // the hosted cloud: nothing to check on a server the customer cannot reach, so support instead
      const hosted = await exit({ hosted: true })
      expect(hosted.detail).not.toContain(EXIT_ADDRESS_URL)
      expect(hosted.detail).toContain('Contact the hosting support team')
      process.env[env] = 'off'
      const off = await exit()
      expect(off.status).toBe('warn')
      expect(off.detail).toContain('MYCEL_EXIT_ADDRESS_CHECK=off')
      expect(off.detail).toContain('scheduled tasks open none')
      // learned from the feed: which families, never the address
      learnExitAddresses(ctx, { v4: { ip: '203.0.113.7', family: 4 }, v6: { error: 'no route' } })
      const known = await exit()
      expect(known).toMatchObject({ status: 'ok', detail: 'Known (IPv4). Web addresses the AI opens follow the normal rules; addresses that lead back to this server are refused.' })
      learnExitAddresses(ctx, { v4: { ip: '203.0.113.7', family: 4 }, v6: { ip: '2001:db8::7', family: 6 } })
      const both = await exit({}, 'ko')
      expect(both.detail).toContain('알고 있어요(IPv4, IPv6)')
      const d = JSON.stringify(await ops().diagnostics('en'))
      expect(d).not.toContain('203.0.113.7')
      expect(d).not.toContain('2001:db8::7')
    } finally {
      if (before === undefined) delete process.env[env]; else process.env[env] = before
    }
  })
  test('the exit address the relay reported counts as known', async () => {
    const other = createContext({ config: { ...ctx.config, dataDir: path.join(root, 'relay-data') }, db: openDb(':memory:'), log: silentLogger })
    try {
      const layout = resolveLayout(other.config, { MYCEL_INSTALL_BASE: base, MYCEL_LABEL: 'mycel' }, 'linux')
      const diag = async () => (await new OpsService(other, { layout, platform: 'linux', engines: async () => [], launcherStatus: async () => status, procSysDir: procSys, atDir: path.join(root, 'etc') }).diagnostics('en')).checks.find((c) => c.id === 'exit_address')!
      expect((await diag()).status).toBe('warn')
      noteEgressIp(other, '198.51.100.9')
      expect(await diag()).toMatchObject({ status: 'ok', detail: expect.stringContaining('Known (reported by the relay)') })
      expect((await diag()).detail).not.toContain('198.51.100.9')
      // an IPv6 answer of the feed while IPv4 failed for another reason than no route does not make it known: still
      // the relay's, not "Known (IPv6)"
      learnExitAddresses(other, { v4: { error: 'timeout' }, v6: { ip: '2001:db8::9', family: 6 } })
      expect((await diag()).detail).toContain('Known (reported by the relay)')
      // without an IPv4 route it is the IPv6 one that counts
      learnExitAddresses(other, { v4: { noRoute: 'ENETUNREACH' }, v6: { ip: '2001:db8::9', family: 6 } })
      expect((await diag()).detail).toContain('Known (IPv6)')
    } finally { await other.close() }
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
