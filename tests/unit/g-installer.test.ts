// Component G, production install path without root (the root parts are in tests/install/g-macos-install.ts):
// the installer's argument / bundle / engine checks (--check), its version plan (init / repair / switch / older)
// against the real bootstrap, the office TLS certificate (every LAN address, renewal), the account tool, the bundle
// layout (account.js, root/mycel-account), help texts, and the update screen's "no release feed" state.
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AppState } from '@mycel/shared/install'
import { runCli } from '../../server/src/auth/cli'
import { silentLogger } from '../../server/src/log'
import { writeManifest } from '../../server/src/system/bundle'
import { planInstallState } from '../../server/src/system/install-plan'
import { canonIp, certNames, ensureLanCert, LAN_CERT_DAYS, lanAddresses, missingNames, wantedNames } from '../../server/src/system/lan-cert'
import { UpdateManager } from '../../server/src/system/update'
import { hostArch, type buildBundle } from '../../scripts/build-bundle'
import { WORK } from '../lib/env'
import { OWNER_PW, testConfig } from './a-lib'

const REPO = path.resolve(import.meta.dir, '..', '..')
const W = path.join(WORK, 'g-installer')
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })
const mac = process.platform === 'darwin'
const run = (cmd: string[], o: { env?: Record<string, string>; input?: string } = {}) => {
  const p = Bun.spawnSync(cmd, { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...(o.env ?? {}) }, stdout: 'pipe', stderr: 'pipe', stdin: o.input !== undefined ? Buffer.from(o.input) : 'ignore' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe('office TLS certificate (system/lan-cert.ts)', () => {
  test('IP addresses compare in one canonical form', () => {
    expect(canonIp('::1')).toBe('0:0:0:0:0:0:0:1')
    expect(canonIp('FD00::0001')).toBe(canonIp('fd00:0:0:0:0:0:0:1'))
    expect(canonIp('fe80::1%en0')).toBe('fe80:0:0:0:0:0:0:1')
    expect(canonIp('::ffff:192.168.0.10')).toBe('0:0:0:0:0:ffff:c0a8:a')
    expect(canonIp('192.168.0.10')).toBe('192.168.0.10')
  })

  test('LAN addresses from ifconfig: every interface, no loopback / link-local / temporary / CLAT addresses', () => {
    const ifconfig = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
\tinet6 ::1 prefixlen 128
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet6 fe80::4b7:6beb:c4b7:83d1%en0 prefixlen 64 secured scopeid 0xe
\tinet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255
\tinet6 2001:db8:1::10 prefixlen 64 autoconf secured
\tinet6 2001:db8:1::99 prefixlen 64 autoconf temporary
\tinet 192.0.0.2 netmask 0xffffffff broadcast 192.0.0.2
\tinet6 2001:db8:1::46 prefixlen 64 clat46
en7: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 10.0.0.5 netmask 0xffffff00 broadcast 10.0.0.255
\tinet6 fd12:3456::5 prefixlen 64 autoconf secured
utun3: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet 100.64.1.2 --> 100.64.1.2 netmask 0xffffffff
`
    expect(lanAddresses({ ifconfig }).sort()).toEqual(['10.0.0.5', '100.64.1.2', '192.168.1.20', canonIp('2001:db8:1::10'), canonIp('fd12:3456::5')].sort())
    // without ifconfig (Linux): node's interface list, minus internal and link-local
    const interfaces = { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], eth0: [{ address: '172.16.0.4', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }] } as never
    expect(lanAddresses({ ifconfig: null, interfaces })).toEqual(['172.16.0.4'])
  })

  test.skipIf(!mac)('made with every name, kept while it covers them, renewed for a new address, a new host name, near expiry or a foreign key', () => {
    const d = path.join(W, 'cert')
    fs.mkdirSync(d, { recursive: true })
    const f = { certFile: path.join(d, 'lan-tls.crt'), keyFile: path.join(d, 'lan-tls.key'), fingerprintFile: path.join(d, 'lan-cert.sha256') }
    const want1 = wantedNames({ host: 'Office-Mac', addresses: ['192.168.1.20', '2001:db8:1::10'] })
    const r1 = ensureLanCert(f, { want: want1 })
    expect(r1).toMatchObject({ changed: true, reason: 'missing' })
    const pem = fs.readFileSync(f.certFile)
    const names = certNames(pem)
    expect(names.dns).toEqual(['office-mac.local', 'localhost'])
    expect(names.ips.sort()).toEqual(['127.0.0.1', canonIp('::1'), '192.168.1.20', canonIp('2001:db8:1::10')].sort())
    expect(names.notAfter - Date.now()).toBeGreaterThan((LAN_CERT_DAYS - 1) * 86400_000)
    expect(names.notAfter - Date.now()).toBeLessThan((LAN_CERT_DAYS + 1) * 86400_000)
    const x = new crypto.X509Certificate(pem)
    expect(x.toLegacyObject().ext_key_usage).toContain('1.3.6.1.5.5.7.3.1') // serverAuth (Apple refuses TLS certs without it)
    expect(fs.readFileSync(f.keyFile, 'utf8')).toContain('BEGIN EC PRIVATE KEY') // named curve SEC1 (Bun's BoringSSL)
    expect(fs.statSync(f.keyFile).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(f.fingerprintFile, 'utf8').trim()).toBe(x.fingerprint256)
    expect(fs.readdirSync(d).sort()).toEqual(['lan-cert.sha256', 'lan-tls.crt', 'lan-tls.key']) // no temp files left

    // an address that went away is fine (still named); same names: kept, same fingerprint
    expect(ensureLanCert(f, { want: wantedNames({ host: 'Office-Mac', addresses: ['192.168.1.20'] }) })).toMatchObject({ changed: false, fingerprint: r1.fingerprint })
    // a new Wi-Fi address: renewed
    const r2 = ensureLanCert(f, { want: wantedNames({ host: 'Office-Mac', addresses: ['10.0.0.5'] }) })
    expect(r2.changed).toBe(true)
    expect(r2.reason).toContain('10.0.0.5')
    expect(r2.fingerprint).not.toBe(r1.fingerprint)
    expect(fs.readFileSync(f.fingerprintFile, 'utf8').trim()).toBe(r2.fingerprint)
    expect(missingNames(fs.readFileSync(f.certFile), wantedNames({ host: 'Office-Mac', addresses: ['10.0.0.5'] }))).toEqual([])
    // the renewal kept the addresses of the old certificate: going back to the first network needs no new one
    // (each new certificate is a new fingerprint for the desktop apps that pinned it)
    expect(r2.names.ips).toEqual(expect.arrayContaining(['192.168.1.20', canonIp('2001:db8:1::10'), '10.0.0.5']))
    expect(ensureLanCert(f, { want: want1 })).toMatchObject({ changed: false, fingerprint: r2.fingerprint })
    expect(ensureLanCert(f, { want: wantedNames({ host: 'Office-Mac', addresses: ['10.0.0.5', '192.168.1.20'] }) }).changed).toBe(false)
    // the Mac was renamed
    expect(ensureLanCert(f, { want: wantedNames({ host: 'Studio', addresses: ['10.0.0.5'] }) }).reason).toContain('studio.local')
    // 30 days before it expires
    const want = wantedNames({ host: 'Studio', addresses: ['10.0.0.5'] })
    expect(ensureLanCert(f, { want, now: Date.now() + (LAN_CERT_DAYS - 20) * 86400_000 }).reason).toBe('expires within 30 days')
    // a key that does not belong to the certificate, or an RSA / explicit-parameter key
    fs.writeFileSync(f.keyFile, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'sec1' }))
    expect(ensureLanCert(f, { want }).reason).toBe('key does not belong to the certificate')
    fs.writeFileSync(f.keyFile, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }))
    expect(ensureLanCert(f, { want }).changed).toBe(true)
    // the certificate is usable by Bun's TLS server
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: { cert: fs.readFileSync(f.certFile, 'utf8'), key: fs.readFileSync(f.keyFile, 'utf8') }, fetch: () => new Response('ok') })
    srv.stop(true)
  })

  test.skipIf(!mac)('this Mac: the names wanted now include <LocalHostName>.local and the loopback addresses', () => {
    const w = wantedNames()
    expect(w.dns[0]).toMatch(/^[a-z0-9-]+\.local$/)
    expect(w.ips).toContain('127.0.0.1')
    expect(w.ips).toContain(canonIp('::1'))
  })
})

describe('installer version plan (system/install-plan.ts)', () => {
  const st = (o: Partial<AppState> = {}): AppState => ({ format: 1, current: '1.0.0', previous: null, pending: null, pendingSince: null, attempts: 0, history: [{ at: '2026-10-01T00:00:00Z', from: null, to: '1.0.0', result: 'ok', detail: null }], ...o })
  test('init, repair, switch to a newer bundle (pending, previous kept), older bundle left staged', () => {
    expect(planInstallState({ current: null, version: '1.0.0', state: null })).toMatchObject({ action: 'init', state: { current: '1.0.0', pending: null } })
    expect(planInstallState({ current: '1.0.0', version: '1.0.0', state: st() })).toEqual({ action: 'repair', state: st() })
    const now = new Date('2026-10-21T00:00:00Z')
    const sw = planInstallState({ current: '1.0.0', version: '1.1.0', state: st(), now })
    expect(sw).toEqual({ action: 'switch', state: st({ current: '1.0.0', previous: '1.0.0', pending: '1.1.0', pendingSince: now.toISOString() }) })
    expect(planInstallState({ current: '1.1.0', version: '1.0.0', state: st({ current: '1.1.0' }) }).action).toBe('older')
    expect(planInstallState({ current: '1.0.0', version: '1.0.0-rc.1', state: st() }).action).toBe('older')
    // a broken or planted state file is replaced by a clean one
    expect(planInstallState({ current: '1.0.0', version: '1.0.0', state: { format: 2, current: '../../etc' } }).state).toMatchObject({ format: 1, current: '1.0.0', history: [] })
    expect(planInstallState({ current: '1.0.0', version: '2.0.0', state: 'garbage' }).state).toMatchObject({ current: '1.0.0', previous: '1.0.0', pending: '2.0.0', history: [] })
  })

  // the installer stops the daemons, writes this state, points app/current at the new version and starts them again:
  // the real bootstrap must confirm a good version (previous kept for "Roll back") and roll back a crashing one
  const BOOTSTRAP = path.join(REPO, 'native', 'bin', `${mac ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`, 'mycel-bootstrap')
  const PORT = 19741
  let proc: ReturnType<typeof Bun.spawn> | null = null
  afterAll(() => { proc?.kill('SIGKILL') })
  test.skipIf(!fs.existsSync(BOOTSTRAP))('a reinstall with a newer bundle goes through the bootstrap like an update', async () => {
    const app = path.join(W, 'boot', 'app'), cfg = path.join(W, 'boot', 'server.json')
    fs.mkdirSync(path.join(app, 'versions'), { recursive: true })
    fs.writeFileSync(cfg, JSON.stringify({ listen: { host: '127.0.0.1', port: PORT } }))
    const version = async (v: string, crash = false) => {
      const dir = path.join(app, 'versions', v)
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
      fs.mkdirSync(path.join(dir, 'server', 'src'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'bin', 'bun'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
      fs.writeFileSync(path.join(dir, 'server', 'src', 'main.js'), crash ? 'process.exit(3)\n'
        : `const cfg = JSON.parse(require('fs').readFileSync(process.env.MYCEL_CONFIG, 'utf8')); Bun.serve({ hostname: '127.0.0.1', port: cfg.listen.port, fetch: () => Response.json({ ok: true, version: ${JSON.stringify(v)} }) }); process.on('SIGTERM', () => process.exit(0))\n`)
      await writeManifest(dir, v)
    }
    const health = async () => { try { return ((await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()) as { version: string }).version } catch { return null } }
    const state = () => AppState.parse(JSON.parse(fs.readFileSync(path.join(app, 'state.json'), 'utf8')))
    const until = async <T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v)}`); await Bun.sleep(100) } }
    const install = async (v: string, current: string | null) => {
      if (proc) { proc.kill('SIGTERM'); await proc.exited; proc = null }
      let old: unknown = null
      try { old = JSON.parse(fs.readFileSync(path.join(app, 'state.json'), 'utf8')) } catch {}
      const plan = planInstallState({ current, version: v, state: old })
      if (plan.action === 'init' || plan.action === 'switch') { fs.rmSync(path.join(app, 'current'), { force: true }); fs.symlinkSync(`versions/${v}`, path.join(app, 'current')) }
      fs.writeFileSync(path.join(app, 'state.json'), JSON.stringify(plan.state))
      proc = Bun.spawn([BOOTSTRAP, '--app', app, '--config', cfg, '--allow-unsigned', '--health-timeout', '4s'], { stdout: 'ignore', stderr: 'ignore' })
      return plan.action
    }
    await version('1.0.0')
    expect(await install('1.0.0', null)).toBe('init')
    await until(health, (v) => v === '1.0.0')
    await version('1.1.0')
    expect(await install('1.1.0', '1.0.0')).toBe('switch')
    await until(health, (v) => v === '1.1.0')
    await until(state, (s) => s.pending === null)
    expect(state()).toMatchObject({ current: '1.1.0', previous: '1.0.0' })
    expect(state().history.at(-1)).toMatchObject({ from: '1.0.0', to: '1.1.0', result: 'ok' })
    // the in-app "Roll back" offers the version the installer replaced
    expect(new UpdateManager({ appDir: app, dataDir: path.join(W, 'boot', 'data'), version: '1.1.0', channel: 'stable', feedUrl: null, log: silentLogger }).status().previous).toBe('1.0.0')
    // a newer bundle that crashes: the bootstrap goes back by itself (the installer then reports the other version)
    await version('1.2.0', true)
    expect(await install('1.2.0', '1.1.0')).toBe('switch')
    await until(state, (s) => s.history.at(-1)?.result === 'rolled_back')
    expect(await until(health, (v) => v === '1.1.0')).toBe('1.1.0')
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('versions/1.1.0')
    proc!.kill('SIGTERM')
    await proc!.exited
    proc = null
  }, 60_000)
})

describe('update screen without a release feed', () => {
  test('status says whether this server looks for versions online (feedUrl null: the installer brings new versions)', () => {
    const base = { appDir: path.join(W, 'nofeed'), dataDir: path.join(W, 'nofeed-data'), version: '1.0.0', channel: 'stable' as const, log: silentLogger }
    fs.mkdirSync(path.join(base.appDir, 'versions'), { recursive: true })
    expect(new UpdateManager({ ...base, feedUrl: null }).status()).toMatchObject({ feed: false, available: null, lastCheckedAt: null })
    expect(new UpdateManager({ ...base, feedUrl: 'https://releases.example/stable.json', keys: [] }).status().feed).toBe(false)
    expect(new UpdateManager({ ...base, feedUrl: 'https://releases.example/stable.json', keys: ['AAAA'] }).status().feed).toBe(true)
  })
})

describe('account tool (auth/cli.ts, bundled as account.js)', () => {
  test('list-owners, create-owner only while there is no account, reset-link for the owner', async () => {
    const cfg = testConfig('g-installer-cli', { setupToken: null })
    expect(await runCli(['list-owners'], { config: cfg })).toContain('no owner yet')
    await runCli(['create-owner', '--username', 'boss', '--name', 'The Boss', '--team', 'Acme'], { config: cfg, stdin: async () => OWNER_PW + '\n' })
    expect(await runCli(['list-owners'], { config: cfg })).toBe('boss\tThe Boss\tactive')
    expect(await runCli(['reset-link'], { config: cfg })).toMatch(/one-time password reset link for "boss".*\nhttp:\/\/localhost:19110\/reset-password\/[A-Za-z0-9_-]+$/)
    await expect(runCli(['nope'], { config: cfg })).rejects.toThrow(/usage: mycel-account status \| list-owners/)
  })
})

// ---------------- the shell scripts, without root ----------------

describe.skipIf(!mac)('installer checks (install-macos.sh --check, no root)', () => {
  // a fake bundle: the checks look at file presence and CPU types (lipo), not at what the files do
  const from = path.join(W, 'rel')
  const v = '0.9.0-check.1'
  fs.mkdirSync(path.join(from, 'app', v, 'bin'), { recursive: true })
  for (const d of ['server/src', 'native']) fs.mkdirSync(path.join(from, 'app', v, d), { recursive: true })
  fs.mkdirSync(path.join(from, 'root'), { recursive: true })
  fs.writeFileSync(path.join(from, 'VERSION'), v + '\n')
  fs.writeFileSync(path.join(from, 'app', v, 'manifest.json'), '{}')
  for (const f of ['server/src/main.js', 'server/src/admin.js', 'server/src/account.js']) fs.writeFileSync(path.join(from, 'app', v, f), '')
  for (const f of ['bin/bun', 'native/mycel-gate', 'native/mycel-bridge']) fs.symlinkSync(process.execPath, path.join(from, 'app', v, f))
  for (const f of ['mycel-bootstrap', 'mycel-launcher']) fs.symlinkSync(process.execPath, path.join(from, 'root', f))
  for (const f of ['mycel-account', 'engine.sb', 'pf-load']) fs.writeFileSync(path.join(from, 'root', f), '')
  const claude = path.join(W, 'bin', 'claude-2.1.305')
  fs.mkdirSync(path.dirname(claude), { recursive: true })
  fs.copyFileSync('/usr/bin/true', claude)
  const script = path.join(W, 'bin', 'codex.js')
  fs.writeFileSync(script, '#!/usr/bin/env node\n', { mode: 0o755 })
  const inst = (...a: string[]) => run([path.join(REPO, 'scripts', 'install-macos.sh'), '--check', '--from', from, '--allow-unsigned', ...a])

  test('engines are claude and codex, each once, a Mac executable; each goes to its own config key', () => {
    const ok = inst('--engine', `claude=${claude}`, '--engine', `codex=${process.execPath}`)
    expect(ok.code).toBe(0)
    expect(ok.out).toContain(`engine claude: ${claude} -> /Library/Application Support/mycel/app/engines/claude/<sha12>/claude (engine.claudeBin)`)
    expect(ok.out).toContain('/app/engines/codex/<sha12>/codex (engine.codexBin)')
    expect(ok.out).toContain(`check passed: bundle ${v}`)
    expect(inst('--engine', `fake=${claude}`).err).toContain('unknown engine "fake"')
    expect(inst('--engine', `Claude=${claude}`).code).toBe(1)
    expect(inst('--engine', `claude=${claude}`, '--engine', `claude=${claude}`).err).toContain('given twice')
    expect(inst('--engine', 'claude').err).toContain('NAME=FILE')
    expect(inst('--engine', `claude=${path.join(W, 'missing')}`).err).toContain('not found')
    expect(inst('--engine', `codex=${script}`).err).toContain('is not a Mac program')
    expect(inst('--engine', `codex=${path.join(from, 'VERSION')}`).err).toContain('is not executable')
    expect(inst().out).toContain('no --engine given')
  })

  test('arguments, ports and the bundle are checked before anything happens; no root without --check', () => {
    expect(inst('--engine').err).toContain('--engine needs a value')
    expect(inst('--port', '8443').err).toContain('must differ')
    expect(inst('--proxy-port', '0').err).toContain('only --tls-port may be 0')
    expect(inst('--port', '70000').err).toContain('bad port')
    expect(inst('--id', 'Bad/Id').err).toContain('bad --id')
    expect(inst('--agent-user', '_axserver').err).toContain('must differ')
    expect(inst('--bogus').err).toContain('unknown option --bogus')
    expect(run([path.join(REPO, 'scripts', 'install-macos.sh'), '--check', '--from', from, '--engine', `claude=${claude}`]).err).toContain('not signed')
    fs.renameSync(path.join(from, 'root', 'mycel-account'), path.join(from, 'root', 'x'))
    try { expect(inst().err).toContain('root/mycel-account missing') } finally { fs.renameSync(path.join(from, 'root', 'x'), path.join(from, 'root', 'mycel-account')) }
    const notRoot = run([path.join(REPO, 'scripts', 'install-macos.sh'), '--from', from, '--allow-unsigned', '--engine', `claude=${claude}`])
    expect(notRoot.code).toBe(1)
    expect(notRoot.err).toContain('run as root (sudo), or with --check')
  })

  test('CPU types are read without the developer tools (a server Mac has none: /usr/bin/lipo is only an xcrun stub)', () => {
    // DEVELOPER_DIR pointing nowhere makes every xcrun stub (lipo, cc, git) fail, like a Mac without the tools
    const noTools = (...a: string[]) => run([path.join(REPO, 'scripts', 'install-macos.sh'), '--check', '--from', from, '--allow-unsigned', ...a], { env: { DEVELOPER_DIR: '/nonexistent' } })
    expect(run(['/usr/bin/lipo', '-archs', process.execPath], { env: { DEVELOPER_DIR: '/nonexistent' } }).code).not.toBe(0)
    const ok = noTools('--engine', `claude=${claude}`)
    expect(ok.err).toBe('')
    expect(ok.code).toBe(0)
    expect(ok.out).toContain('check passed')
    const s = fs.readFileSync(path.join(REPO, 'scripts/install-macos.sh'), 'utf8')
    expect(s).not.toMatch(/^[^#\n]*\blipo\b/m)
  })

  test('a bundle for another CPU type is refused (the message says how to build a universal one)', () => {
    const other = hostArch() === 'arm64' ? 'x86_64' : 'arm64'
    const thin = path.join(W, 'bin', 'thin-bun')
    const r = run(['/usr/bin/lipo', process.execPath, '-thin', other, '-output', thin])
    if (r.code !== 0) return // a single-arch bun cannot be thinned to the other arch: nothing to check here
    const bun = path.join(from, 'app', v, 'bin', 'bun')
    fs.rmSync(bun); fs.symlinkSync(thin, bun)
    try { expect(inst('--engine', `claude=${claude}`).err).toMatch(/bin\/bun is built for .*build the bundle with --arch universal/) } finally { fs.rmSync(bun); fs.symlinkSync(process.execPath, bun) }
  })
})

describe('help texts and the other root scripts', () => {
  test('--help prints the header comment only (no shell lines), for all root scripts', () => {
    for (const s of ['scripts/install-macos.sh', 'scripts/uninstall-macos.sh', 'scripts/macos/account.sh']) {
      const r = run([path.join(REPO, s), '--help'])
      expect(r.code).toBe(0)
      expect(r.out).not.toMatch(/^set -|^export PATH|^#!/m)
      expect(r.out.length).toBeGreaterThan(200)
    }
    expect(run([path.join(REPO, 'scripts/uninstall-macos.sh'), '--help']).out).toContain('--delete-data')
    expect(run([path.join(REPO, 'scripts/install-macos.sh'), '--help']).out).toContain('--engine NAME=FILE    NAME is claude (Claude Code) or codex')
    expect(run([path.join(REPO, 'scripts/macos/account.sh')]).out).toContain('reset-link')
  })

  test('the uninstaller and the account tool refuse to run without root', () => {
    const u = run([path.join(REPO, 'scripts/uninstall-macos.sh')])
    expect(u.code).toBe(2)
    expect(u.err).toContain('run as root')
    const a = run([path.join(REPO, 'scripts/macos/account.sh'), 'reset-link'])
    expect(a.code).toBe(2)
    expect(a.err).toContain('sudo')
  })

  test('the account tool runs the bundled CLI as the server account (owner of data/), never as root', () => {
    const s = fs.readFileSync(path.join(REPO, 'scripts/macos/account.sh'), 'utf8')
    expect(s).toMatch(/SRV=\$\(stat -f %Su "\$BASE\/data"\)/)
    expect(s).toMatch(/exec \/usr\/bin\/sudo -u "\$SRV" -- \/usr\/bin\/env -i /)
    // the only program started from app/ is started by sudo -u <server account>
    expect(s.match(/"\$BUN"/g)?.length).toBe(1)
    expect(s).toMatch(/exec \/usr\/bin\/sudo -u "\$SRV" -- \/usr\/bin\/env -i [^\n]*\\\n[^\n]*"\$BUN" "\$CLI" "\$@"/)
    expect(s).not.toMatch(/PW1[^\n]*(argv|export)/)
  })

  test('root runs bun only from its own staging folder, without BUN_* / NODE_* settings (bunfig preload, .env)', () => {
    const s = fs.readFileSync(path.join(REPO, 'scripts/install-macos.sh'), 'utf8')
    const def = s.split('\n').find((l) => l.startsWith('rootbun() {'))!
    expect(def).toBeTruthy()
    // every bun the installer starts goes through rootbun
    const direct = s.split('\n').filter((l) => !l.trimStart().startsWith('#') && l.includes('"$BUN"') && l !== def && !l.startsWith('[ -x "$BUN" ]'))
    expect(direct).toEqual([])
    expect(s.match(/rootbun (-e|"\$ADMIN_JS")/g)?.length).toBeGreaterThanOrEqual(4)
    // a folder another account could write (an installer started from /tmp): its bunfig.toml preload and .env
    const hostile = path.join(W, 'hostile-cwd')
    fs.mkdirSync(hostile, { recursive: true })
    fs.writeFileSync(path.join(hostile, 'bunfig.toml'), 'preload = ["./evil.js"]\n')
    fs.writeFileSync(path.join(hostile, 'evil.js'), 'console.log("PRELOADED")\n')
    fs.writeFileSync(path.join(hostile, '.env'), 'MYCEL_EVIL=from-dotenv\n')
    const itmp = fs.mkdtempSync(path.join(W, 'itmp-'))
    const probe = 'console.log("ran", process.env.MYCEL_EVIL ?? "-", process.env.MYCEL_I_X ?? "-")'
    const sh = (body: string) => Bun.spawnSync(['/bin/bash', '-c', `set -uo pipefail; ITMP='${itmp}'; BUN='${process.execPath}'; ${def}\n${body}`],
      { cwd: hostile, env: { PATH: '/usr/bin:/bin', BUN_OPTIONS: '--preload ./evil.js', NODE_OPTIONS: '--require ./evil.js' }, stdout: 'pipe', stderr: 'pipe' })
    // (the hazard is real: plain bun in that folder runs the preload)
    expect(Bun.spawnSync([process.execPath, '-e', '1'], { cwd: hostile, env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe' }).stdout.toString()).toContain('PRELOADED')
    const r = sh(`MYCEL_I_X='a b' rootbun -e '${probe}'`)
    expect(r.stderr.toString()).toBe('')
    expect(r.stdout.toString().trim()).toBe('ran - a b')
  })

  test('root programs only move forward: an older bundle leaves newer ones (root/VERSION) in place', () => {
    const s = fs.readFileSync(path.join(REPO, 'scripts/install-macos.sh'), 'utf8')
    expect(s).toMatch(/ROOT_V=\$\(tr -d '\[:space:\]' < "\$BASE\/root\/VERSION"/)
    expect(s).toMatch(/rootbun "\$ADMIN_JS" compare-versions "\$ROOT_V" "\$VERSION"\)" = 1 \]; then\n  ROOT_KEEP=1/)
    for (const f of ['755 mycel-bootstrap', '755 mycel-launcher', '644 engine.sb', '755 pf-load', '755 mycel-account']) expect(s.split('\n')).toContain(`rootfile ${f}`)
    expect(s).not.toMatch(/^install -o root -g wheel -m [0-9]+ "\$FROM\/root\//m)
    expect(s).toContain('install -o root -g wheel -m 644 "$ITMP/root-version" "$BASE/root/VERSION"')
  })

  test('the installer gives kept data back, keeps engines by name, and plans versions with the bundle it installs', () => {
    const s = fs.readFileSync(path.join(REPO, 'scripts/install-macos.sh'), 'utf8')
    expect(s).toContain('ADMIN_JS="$BUNDLE/server/src/admin.js"')
    expect(s).not.toMatch(/\$BASE\/app\/current\/server\/src\/admin\.js/)
    expect(s).toMatch(/-type f -links 1 \\\) \\\) \\\( -user root -o -nouser \\\) -exec chown -h "\$SRV_USER:\$SRV_GRP"/)
    expect(s).toContain('put "$src" "$SRV_USER" "$AGT_GRP" 750 "$dir/$name"')
    expect(s).toContain('managed: true')
    for (const f of ['scripts/macos/account.sh', 'native/build.sh']) expect(Bun.spawnSync(['/bin/bash', '-n', path.join(REPO, f)]).exitCode).toBe(0)
  })
})

// ---------------- the real bundle ----------------

const NATIVE = path.join(REPO, 'native', 'bin', `darwin-${hostArch()}`, 'mycel-launcher')
describe.skipIf(!mac || !fs.existsSync(NATIVE))('release bundle (scripts/build-bundle.ts)', () => {
  test('has the account CLI and the root account tool; the bundled CLIs run (account status, install-state)', async () => {
    const out = path.join(W, 'bundle')
    // in a separate process: Bun.build inside the test runner cannot read the workspace packages
    const built = run([process.execPath, path.join(REPO, 'scripts', 'build-bundle.ts'), '--version', '0.9.0-unit.1', '--out', out], { env: { HOME: process.env.HOME ?? '/' } })
    expect(built.err).toBe('')
    const b = JSON.parse(built.out) as Awaited<ReturnType<typeof buildBundle>>
    expect(b.arch).toBe(hostArch())
    for (const f of ['server/src/main.js', 'server/src/admin.js', 'server/src/account.js', 'bin/bun', 'native/mycel-gate', 'native/mycel-bridge']) expect(fs.existsSync(path.join(b.dir, f))).toBe(true)
    expect(fs.readdirSync(b.root).sort()).toEqual(['engine.sb', 'mycel-account', 'mycel-bootstrap', 'mycel-launcher', 'pf-load'])
    expect(fs.statSync(path.join(b.root, 'mycel-account')).mode & 0o777).toBe(0o755)
    const manifest = JSON.parse(fs.readFileSync(path.join(b.dir, 'manifest.json'), 'utf8')) as { files: Record<string, unknown> }
    expect(Object.keys(manifest.files)).toContain('server/src/account.js')

    const bun = path.join(b.dir, 'bin', 'bun')
    const data = path.join(W, 'bundle-data')
    fs.mkdirSync(data, { recursive: true })
    const cfgFile = path.join(W, 'bundle-server.json')
    fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'prod', listen: { host: '127.0.0.1', port: 19742 }, dataDir: data, teamRoot: path.join(W, 'bundle-team'), logDir: null }))
    const env = { MYCEL_CONFIG: cfgFile, MYCEL_MODE: 'prod', MYCEL_INSTALL_BASE: W, HOME: data }
    const st = run([bun, path.join(b.dir, 'server/src/account.js'), 'status'], { env })
    expect(st.err).toBe('')
    expect(st.out).toContain('setup needed')
    const created = run([bun, path.join(b.dir, 'server/src/account.js'), 'create-owner', '--username', 'kim', '--name', 'Kim', '--team', 'T'], { env, input: OWNER_PW + '\n' })
    expect(created.out).toContain('owner "kim" created')
    expect(run([bun, path.join(b.dir, 'server/src/account.js'), 'reset-link'], { env }).out).toContain('http://localhost:19742/reset-password/')

    fs.writeFileSync(path.join(W, 'state.json'), 'null')
    const plan = run([bun, path.join(b.dir, 'server/src/admin.js'), 'install-state', '--current', '0.8.0', '--version', '0.9.0-unit.1', '--state', path.join(W, 'state.json'), '--out', path.join(W, 'state.out.json')])
    expect(plan.out.trim()).toBe('switch')
    const admin = path.join(b.dir, 'server/src/admin.js')
    const cmp = (x: string, y: string) => run([bun, admin, 'compare-versions', x, y]).out.trim()
    expect([cmp('0.9.0-test.5', '0.9.0-test.4'), cmp('1.0.0', '1.0.0'), cmp('1.0.0-rc.9', '1.0.0-rc.10')]).toEqual(['1', '0', '-1'])
    expect(JSON.parse(fs.readFileSync(path.join(W, 'state.out.json'), 'utf8'))).toMatchObject({ previous: '0.8.0', pending: '0.9.0-unit.1' })
  }, 120_000)
})
