// Install test for Linux (linux-runtime spec 3.9.2, T2; the Linux sibling of tests/install/g-macos-install.ts):
// install -> run -> plan -> update -> roll back -> back up -> uninstall (keep data) -> reinstall -> purge. Installs a
// TEST copy (--id mycel-test, accounts axtsrv / axtagt, ports 19174-19178) of kits built from this checkout with a
// FAKE engine (tests/install/linux/fake-engine, a static ELF installed as claude and codex) and checks what the
// installer promises: accounts, owners and modes (spec 3.1.1), root files, the sandbox's /etc, the systemd units and
// their hardening, the engine firewall (nftables, as the engine account), turns through the installed launcher
// (bwrap + Landlock + seccomp) as the server account, the tokens CLI, the account tool, a resource plan, updates
// through the installer and through `mycel-ctl update`, the bootstrap's roll-back, and a clean uninstall.
//
//   sudo bun tests/install/g-linux-install.ts [--keep]        (a Linux VM with systemd: GitHub ubuntu-24.04[-arm])
//   MYCEL_T2_REAL_ENGINES=1   also install the pinned Claude Code and Codex releases (downloaded, SHA-256 checked)
//                             and run each one's --version through the installed sandbox (no model is called)
//   MYCEL_T2_ENGINE=<file>    a prebuilt fake engine (default: built here with `go build`)
//   MYCEL_T2_REUSE_KIT=1      keep the first kit of an earlier run (building one takes minutes)
//   Without a VM: tests/install/linux/Dockerfile (systemd in a privileged container) + run-in-container.sh.
//
// Needs native/bin/linux-<arch>/ (bash native/build.sh) and the Linux bundle's downloads (scripts/linux/downloads.ts,
// cached in dist/cache/). Prints a report and exits 1 if any check failed.
import fs from 'node:fs'
import path from 'node:path'
import { TenantStatus } from '@mycel/shared/cloud-protocol'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { buildLinuxBundle } from '../../scripts/build-bundle'
import { writeManifest } from '../../server/src/system/bundle'
import { walkTree } from '../../server/src/system/manifest'
import { writeAtomic, zstdCompress } from '../../server/src/system/streams'
import { tarStream, type TarEntryInput } from '../../server/src/system/tar'

const REPO = path.resolve(import.meta.dir, '..', '..')
const ID = 'mycel-test', SRV = 'axtsrv', AGT = 'axtagt'
const PORT = 19174, PROXY = 19176, DECOY = 19177
const BASE = `/var/lib/${ID}`
const CTL = `${BASE}/root/mycel-ctl`
const KEEP = process.argv.includes('--keep')
// not /tmp: the units have PrivateTmp, and the server account must read the launcher probe
const W = `/var/tmp/${ID}-install-test`
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64'
const REAL = process.env.MYCEL_T2_REAL_ENGINES === '1'

type Result = { name: string; ok: boolean; skipped?: boolean; detail?: string }
const results: Result[] = []
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function skip(name: string, why: string) {
  results.push({ name, ok: true, skipped: true, detail: why })
  console.log(`SKIP ${name} — ${why}`)
}
function sh(cmd: string[], o: { input?: string; env?: Record<string, string>; user?: string; cwd?: string } = {}) {
  // as another account: runuser (root only, no PAM session), with only the given environment
  const full = o.user ? ['runuser', '-u', o.user, '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', ...Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`), ...cmd] : cmd
  const p = Bun.spawnSync(full, { stdin: o.input !== undefined ? Buffer.from(o.input) : 'ignore', stdout: 'pipe', stderr: 'pipe', env: o.user ? { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } : { ...process.env, ...(o.env ?? {}) }, cwd: o.cwd ?? '/' })
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() }
}
const tail = (r: { out: string; err: string }, n = 3) => (r.out + r.err).trim().split('\n').slice(-n).join(' | ')
const statOf = (p: string) => { const r = sh(['stat', '-c', '%U:%G %a', p]); return r.code === 0 ? r.out.trim() : 'missing' }
async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (ok(v) || Date.now() > end) return v; await Bun.sleep(500) }
}
const health = async () => { try { return (await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()) as { ok: boolean; version: string } } catch { return null } }
const healthIs = (v: string, ms = 90_000) => until(health, (h) => h?.version === v, ms)
/** the JSON object a command printed (pretty-printed over several lines, possibly after other lines) */
const lastJson = (out: string): any => { const i = out.indexOf('{'); try { return i >= 0 ? JSON.parse(out.slice(i)) : null } catch { return null } }
const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const uidOf = (u: string) => Number(sh(['id', '-u', u]).out.trim())
const BUN = `${BASE}/app/current/bin/bun`
const ADMIN_ENV = { MYCEL_MODE: 'prod', MYCEL_CONFIG: `${BASE}/config/server.json`, MYCEL_INSTALL_BASE: BASE, HOME: `${BASE}/data` }
const admin = (args: string[], input?: string) => sh([BUN, `${BASE}/app/current/server/src/admin.js`, ...args], { user: SRV, env: ADMIN_ENV, input })
const installer = (cmd: string, ...args: string[]) => sh([path.join(REPO, 'scripts', 'install-linux.sh'), cmd, '--id', ID, '--server-user', SRV, '--agent-user', AGT,
  '--port', String(PORT), '--proxy-port', String(PROXY), ...args])
const kit = (n: number) => path.join(W, `rel${n}`)
const V = (n: number) => `0.9.0-test.${n}`
const unit = (u: string) => `${ID}-${u}`
/** the install's slice: "-" is written "_" (a dash would put it inside mycel.slice; mycel-ctl sliceUnit) */
const SLICE = `${ID.replaceAll('-', '_')}.slice`

/** Another version of kit 1 without building again (a Linux build packs ~400 MB twice, minutes each): the version
 * folder copied, the version the server reports (a literal of the same length in the three entry files) replaced,
 * and the manifest written for it. crash: main.js exits at once (the bootstrap must roll back). tarball: the update
 * archive `mycel-ctl update --bundle` takes (zstd level 3 here; releases use 19). */
async function deriveKit(n: number, o: { crash?: boolean; tarball?: boolean }) {
  const src = path.join(kit(1), 'app', V(1)), out = kit(n), dir = path.join(out, 'app', V(n))
  fs.mkdirSync(path.join(out, 'app'), { recursive: true })
  if (sh(['cp', '-a', src, dir]).code !== 0) throw new Error(`copying ${src} failed`)
  fs.rmSync(path.join(dir, 'manifest.sig'), { force: true })
  for (const f of ['main.js', 'admin.js', 'account.js']) {
    const p = path.join(dir, 'server', 'src', f)
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll(V(1), V(n)))
  }
  if (o.crash) fs.writeFileSync(path.join(dir, 'server', 'src', 'main.js'), 'process.exit(3)\n')
  fs.copyFileSync(path.join(kit(1), 'product.env'), path.join(out, 'product.env'))
  fs.writeFileSync(path.join(out, 'VERSION'), V(n) + '\n')
  await writeManifest(dir, V(n))
  if (o.tarball) {
    const { files, dirs } = await walkTree(dir)
    const entries: TarEntryInput[] = [
      ...dirs.map((d) => ({ name: d.rel, type: 'dir' as const, mode: d.mode, mtimeMs: d.mtimeMs })),
      ...files.map((f) => ({ name: f.rel, type: 'file' as const, source: f.abs, mode: f.mode })),
    ]
    await writeAtomic(zstdCompress(tarStream(entries), 3), path.join(out, `${V(n)}-linux-${ARCH}.tar.zst`), 0o644)
  }
}

async function main() {
  if (process.getuid?.() !== 0) { console.error('run as root (sudo)'); process.exit(2) }
  if (process.platform !== 'linux') { console.error('Linux only'); process.exit(2) }
  if (!fs.existsSync('/run/systemd/system')) { console.error('needs systemd (a VM, or tests/install/linux/Dockerfile)'); process.exit(2) }
  // a leftover install of an earlier run
  if (fs.existsSync(BASE)) installer('uninstall', '--purge')
  const reuse = process.env.MYCEL_T2_REUSE_KIT === '1' && fs.existsSync(path.join(kit(1), 'app', V(1), 'manifest.json'))
  for (const f of fs.existsSync(W) ? fs.readdirSync(W) : []) if (!(reuse && f === 'rel1')) fs.rmSync(path.join(W, f), { recursive: true, force: true })
  fs.mkdirSync(W, { recursive: true, mode: 0o755 })

  // ---- build: kit 1 from this checkout; 2 and 4 (good) and 3 and 5 (crash at start) derived from it ----
  if (!reuse) await buildLinuxBundle({ version: V(1), out: kit(1), noWhisper: true })
  else {
    // a reused kit gets this checkout's native programs (they change more often than the rest)
    const nb = path.join(REPO, 'native', 'bin', `linux-${ARCH}`), d1 = path.join(kit(1), 'app', V(1))
    for (const f of ['mycel-bootstrap', 'mycel-launcher', 'mycel-sandbox', 'mycel-ctl']) fs.copyFileSync(path.join(nb, f), path.join(d1, 'root', f))
    for (const f of ['mycel-gate', 'mycel-bridge', 'mycel-safeops']) fs.copyFileSync(path.join(nb, f), path.join(d1, 'native', f))
    for (const f of fs.readdirSync(path.join(REPO, 'scripts', 'linux', 'systemd'))) fs.copyFileSync(path.join(REPO, 'scripts', 'linux', 'systemd', f), path.join(d1, 'root', 'systemd', f))
    for (const [src, dst] of [['account.sh', 'mycel-account'], ['set-claude-token.sh', 'set-claude-token'], ['safe-fs.sh', 'safe-fs.sh'], ['apparmor-bwrap.in', 'apparmor-bwrap.in']])
      fs.copyFileSync(path.join(REPO, 'scripts', 'linux', src!), path.join(d1, 'root', dst!))
    await writeManifest(d1, V(1))
  }
  await deriveKit(2, {})
  await deriveKit(3, { crash: true })
  await deriveKit(4, { tarball: true })
  await deriveKit(5, { crash: true, tarball: true })
  let engine = process.env.MYCEL_T2_ENGINE ?? ''
  if (!engine) {
    engine = path.join(W, 'engine-src', 'claude')
    const b = sh(['go', 'build', '-trimpath', '-o', engine, '.'], { cwd: path.join(REPO, 'tests', 'install', 'linux', 'fake-engine'), env: { CGO_ENABLED: '0', GOFLAGS: '-mod=mod', HOME: process.env.HOME ?? '/root' } })
    if (b.code !== 0) throw new Error('building the fake engine needs Go (or MYCEL_T2_ENGINE=<file>): ' + tail(b))
  }
  fs.mkdirSync(path.join(W, 'codex-src'), { recursive: true })
  const codexFake = path.join(W, 'codex-src', 'codex')
  fs.copyFileSync(engine, codexFake)
  const lp = await Bun.build({ entrypoints: [path.join(import.meta.dir, 'g-launcher-probe.ts')], target: 'bun', outdir: W, naming: 'launcher-probe.js' })
  if (!lp.success) throw new Error('bundling the launcher probe failed')
  sh(['chmod', '-R', 'a+rX', W])

  // ---- check (no root) and argument checks: nothing changes ----
  // as nobody: a copy outside the checkout (CI runners keep the checkout under a home folder nobody cannot enter)
  const installerCopy = path.join(W, 'install-linux.sh'); fs.copyFileSync(path.join(REPO, 'scripts', 'install-linux.sh'), installerCopy); fs.chmodSync(installerCopy, 0o755)
  const chk = sh([installerCopy, 'check', '--from', kit(1), '--allow-unsigned', '--id', ID, '--server-user', SRV, '--agent-user', AGT, '--engine', `claude=${engine}`], { user: 'nobody' })
  check('check runs without root and changes nothing', chk.code === 0 && /check: kit 0\.9\.0-test\.1/.test(chk.out) && !fs.existsSync(BASE), tail(chk, 4))
  const badName = installer('install', '--from', kit(1), '--allow-unsigned', '--engine', `fake=${engine}`)
  check('installer refuses an engine name other than claude / codex, before changing anything', badName.code !== 0 && /unknown engine "fake"/.test(badName.err) && !fs.existsSync(BASE), badName.err.trim())
  const script = path.join(W, 'not-elf.sh'); fs.writeFileSync(script, '#!/bin/sh\necho hi\n', { mode: 0o755 })
  const badEngine = installer('install', '--from', kit(1), '--allow-unsigned', '--engine', `claude=${script}`)
  check('installer refuses a script as an engine (ELF only)', badEngine.code !== 0 && /not a Linux/.test(badEngine.err) && !fs.existsSync(BASE), badEngine.err.trim())
  const unsigned = installer('install', '--from', kit(1), '--engine', `claude=${engine}`)
  check('installer refuses an unsigned kit without --allow-unsigned', unsigned.code !== 0 && /not signed|does not verify/.test(unsigned.err) && !fs.existsSync(BASE), unsigned.err.trim())
  // an id that is one of systemd's own slices: its slice would be system.slice, which the installer stops (review)
  const sysId = sh([path.join(REPO, 'scripts', 'install-linux.sh'), 'install', '--id', 'system', '--server-user', SRV, '--agent-user', AGT, '--port', String(PORT), '--proxy-port', String(PROXY),
    '--from', kit(1), '--allow-unsigned', '--engine', `claude=${engine}`])
  check('installer refuses an id that names one of systemd\'s own slices (system.slice is never written or stopped)', sysId.code !== 0 && /systemd's own slices/.test(sysId.err)
    && !fs.existsSync('/var/lib/system') && !fs.existsSync('/etc/systemd/system/system.slice'), sysId.err.trim())

  // ---- install ----
  const inst = installer('install', '--from', kit(1), '--allow-unsigned', '--engine', `claude=${engine}`, '--engine', `codex=${codexFake}`)
  check('install', inst.code === 0, tail(inst, 6))
  if (inst.code !== 0) return

  // ---- accounts (spec 3.1.2) ----
  for (const u of [SRV, AGT]) {
    const uid = uidOf(u)
    const pw = sh(['getent', 'passwd', u]).out.trim().split(':')
    const st = sh(['passwd', '-S', u]).out.trim().split(/\s+/)[1]
    check(`${u}: system account (uid ${uid}), nologin, locked, own group only`, uid >= 100 && uid <= 999 && /nologin$/.test(pw[6] ?? '') && /^L/.test(st ?? '') && sh(['id', '-Gn', u]).out.trim() === u, `${pw.join(':')} ${st}`)
  }
  // ---- folders (spec 3.1.1) ----
  const tree: [string, string][] = [
    ['', 'root:root 755'], ['/app', `${SRV}:${SRV} 755`], ['/app/versions', `${SRV}:${SRV} 755`], ['/app/engines', `${SRV}:${AGT} 750`],
    ['/data', `${SRV}:${SRV} 700`], ['/team', `${SRV}:${SRV} 700`], ['/config', `${SRV}:${SRV} 700`], ['/secrets', `${SRV}:${SRV} 700`],
    ['/setup', `${SRV}:root 750`], ['/status', `${SRV}:root 750`], ['/agent', `${AGT}:${AGT} 700`], ['/agent/home', 'root:root 555'],
    ['/agent/codex-auth', `${AGT}:${AGT} 700`], ['/run', 'root:root 755'], ['/run/tools', `${SRV}:${AGT} 2750`], ['/run-launcher', `${AGT}:${SRV} 2750`],
    ['/root', 'root:root 755'], ['/root/sandbox-etc', 'root:root 755'], ['/root/systemd', 'root:root 755'], ['/root/safe-ops', 'root:root 755'],
  ]
  const bad = tree.filter(([p, want]) => statOf(BASE + p) !== want).map(([p, want]) => `${p || '/'}: ${statOf(BASE + p)} (want ${want})`)
  check('folders: owners and modes (spec 3.1.1)', bad.length === 0, bad.join('; '))
  const rootFiles = ['mycel-bootstrap', 'mycel-launcher', 'mycel-sandbox', 'mycel-ctl', 'mycel-account', 'set-claude-token'].map((f) => [f, statOf(`${BASE}/root/${f}`)])
  check('root programs: root:root 755', rootFiles.every(([, s]) => s === 'root:root 755'), JSON.stringify(rootFiles))
  // safe operations 1A run only root-owned programs (QA 2026-10-30 B1): root's own copies of the app's mycel-safeops and pandoc
  const copies = [['mycel-safeops', 'native/mycel-safeops'], ['pandoc', 'bin/pandoc']].map(([n, rel]) => [n, statOf(`${BASE}/root/safe-ops/${n}`),
    sh(['cmp', '-s', `${BASE}/root/safe-ops/${n}`, `${BASE}/app/current/${rel}`]).code === 0])
  check('root/safe-ops: root:root 755 copies of mycel-safeops and pandoc, same bytes as the version folder', copies.every(([, s, same]) => s === 'root:root 755' && same), JSON.stringify(copies))
  check('root/VERSION, install.json, firewall.conf.json: root 644', ['VERSION', 'install.json', 'firewall.conf.json', 'safe-fs.sh'].every((f) => statOf(`${BASE}/root/${f}`) === 'root:root 644'))
  const sbx = (f: string) => { try { return fs.readFileSync(`${BASE}/root/sandbox-etc/${f}`, 'utf8') } catch { return 'missing' } }
  const ag = uidOf(AGT), agg = Number(sh(['id', '-g', AGT]).out.trim())
  check('sandbox-etc: two-line passwd and group, localhost hosts, files-only nsswitch, empty file and folder (spec 3.3.3)',
    sbx('passwd') === `root:x:0:0::/:/usr/sbin/nologin\n${AGT}:x:${ag}:${agg}::/nonexistent:/usr/sbin/nologin\n` && sbx('group') === `root:x:0:\n${AGT}:x:${agg}:\n`
      && sbx('hosts') === '127.0.0.1 localhost\n::1 localhost\n' && sbx('nsswitch.conf') === 'passwd: files\ngroup: files\nhosts: files\n' && sbx('empty') === ''
      && statOf(`${BASE}/root/sandbox-etc/empty.d`) === 'root:root 555', sbx('passwd') + sbx('group'))
  const fwc = readJson(`${BASE}/root/firewall.conf.json`), ij = readJson(`${BASE}/root/install.json`)
  check('firewall.conf.json and install.json name this install', fwc?.engineUid === ag && fwc?.serverUid === uidOf(SRV) && fwc?.proxyPort === PROXY && fwc?.deployment === 'self'
    && ij?.id === ID && ij?.serverUser === SRV && ij?.agentUser === AGT && ij?.allowUnsigned === true && ij?.version === V(1), JSON.stringify({ fwc, ij }))
  const engineStat = statOf(`${BASE}/app/engines/claude/current/claude`)
  check('engines: app/engines/<name>/<sha12>/<name>, server-owned, engine group may run', engineStat === `${SRV}:${AGT} 750` && statOf(`${BASE}/app/engines/codex/current/model_catalog.json`) === `${SRV}:${AGT} 640`, engineStat)
  const cfg = readJson(`${BASE}/config/server.json`)
  check('server.json: prod, subscription, journald logs, deployment self, signed feed with automatic updates', cfg?.mode === 'prod' && cfg?.engine?.authMode === 'subscription'
    && cfg?.logDir === null && cfg?.deployment === 'self' && cfg?.update?.auto === true && cfg?.update?.feedUrl === `${RELEASE_CHANNEL.feed}/server/stable.json`
    && cfg?.engine?.claudeBin === `${BASE}/app/engines/claude/current/claude` && cfg?.engine?.codexBin === `${BASE}/app/engines/codex/current/codex` && statOf(`${BASE}/config/server.json`) === `${SRV}:${SRV} 600`, JSON.stringify(cfg))
  check('setup code for root, setup token for the server', /^[A-Za-z0-9_-]{24}$/.test(fs.readFileSync(`${BASE}/setup/code`, 'utf8').trim()) && statOf(`${BASE}/setup/code`) === `${SRV}:root 640` && statOf(`${BASE}/data/setup-token`) === `${SRV}:${SRV} 600`)

  // ---- systemd units and hardening (spec 3.2) ----
  for (const u of ['firewall.timer', 'launcher.service', 'server.service', 'update.timer']) {
    const en = sh(['systemctl', 'is-enabled', unit(u)]).out.trim(), ac = sh(['systemctl', 'is-active', unit(u)]).out.trim()
    check(`${unit(u)} enabled and active`, en === 'enabled' && ac === 'active', `${en} ${ac}`)
  }
  const show = (u: string, props: string[]) => Object.fromEntries(sh(['systemctl', 'show', unit(u), ...props.map((p) => `-p${p}`)]).out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const lu = show('launcher.service', ['User', 'NoNewPrivileges', 'ProtectSystem', 'Delegate', 'DelegateControllers', 'KillMode', 'ProtectHome', 'RestrictSUIDSGID', 'CapabilityBoundingSet', 'PrivateTmp'])
  check('launcher unit: engine account, hardening, cgroup delegation (spec 3.2.2)', lu.User === AGT && lu.NoNewPrivileges === 'yes' && lu.ProtectSystem === 'strict' && lu.Delegate === 'yes'
    && /memory/.test(lu.DelegateControllers ?? '') && /pids/.test(lu.DelegateControllers ?? '') && lu.KillMode === 'control-group' && lu.ProtectHome === 'yes' && lu.RestrictSUIDSGID !== 'yes' && lu.CapabilityBoundingSet === '', JSON.stringify(lu))
  const su = show('server.service', ['User', 'NoNewPrivileges', 'ProtectSystem', 'Delegate', 'KillMode', 'Environment'])
  check('server unit: server account, hardening, bootstrap environment (spec 3.2.3)', su.User === SRV && su.NoNewPrivileges === 'yes' && su.ProtectSystem === 'strict' && su.Delegate === 'yes' && su.KillMode === 'mixed'
    && /MYCEL_SANDBOX_HELPER=\/var\/lib\/mycel-test\/root\/mycel-sandbox/.test(su.Environment ?? '') && /MYCEL_ALLOW_UNSIGNED=1/.test(su.Environment ?? ''), JSON.stringify(su))
  const slices = ['launcher.service', 'server.service'].map((u) => sh(['systemctl', 'show', unit(u), '-pSlice']).out.trim())
  check(`both units in ${SLICE} (the group 1A bounds), the server names root's 1A programs`, slices.every((x) => x === `Slice=${SLICE}`)
    && new RegExp(`MYCEL_SAFE_OPS_BIN=${BASE}/root/safe-ops`).test(su.Environment ?? '') && fs.existsSync(`/etc/systemd/system/${SLICE}`), `${slices} ${su.Environment}`)
  const execStart = sh(['systemctl', 'show', unit('launcher.service'), '-pExecStart']).out
  check('launcher runs the sandbox: --sandbox bwrap, --dedicated-account, firewall status, plan file, both engines', ['--sandbox bwrap', '--dedicated-account', `--firewall-status ${BASE}/run/firewall.json`, '--landlock required', '--cgroup auto',
    `--allow-cmd ${BASE}/app/engines/claude/current/claude`, `--allow-cmd ${BASE}/app/engines/codex/current/codex`].every((k) => execStart.includes(k)), execStart.slice(0, 400))
  fs.mkdirSync(path.join(W, 'units-again'), { recursive: true, mode: 0o700 })
  const rendered = sh([CTL, 'render-units', '--base', BASE, '--out', path.join(W, 'units-again')])
  const same = rendered.code === 0 && fs.readdirSync(path.join(W, 'units-again')).every((f) => fs.readFileSync(path.join(W, 'units-again', f), 'utf8') === fs.readFileSync(`/etc/systemd/system/${f}`, 'utf8'))
  check('mycel-ctl render-units gives the installed units byte for byte (one renderer for installer and update)', same, tail(rendered))
  const va = sh(['systemd-analyze', 'verify', ...['firewall.service', 'firewall.timer', 'launcher.service', 'server.service', 'update.service', 'update.timer'].map((u) => `/etc/systemd/system/${unit(u)}`), `/etc/systemd/system/${SLICE}`])
  check('systemd-analyze verify', va.code === 0, tail(va, 5))

  // ---- safe operations 1A: off by default; `mycel-ctl safe-ops on` bounds the slice, `off` takes the limits away ----
  const sl = (f: string) => { try { return fs.readFileSync(`/sys/fs/cgroup/${SLICE}/${f}`, 'utf8').trim() } catch { return 'missing' } }
  const st0 = lastJson(sh([CTL, 'safe-ops', 'status', '--base', BASE, '--json']).out)
  check('safe-ops status: off, programs ready, slice without limits', st0?.on === false && st0?.programs?.every((p: any) => p.ok) && sl('memory.max') === 'max', JSON.stringify(st0).slice(0, 400))
  const soOn = sh([CTL, 'safe-ops', 'on', '--base', BASE, '--json', '--max-wait', '0'])
  const st1 = lastJson(soOn.out)
  const soH1 = await healthIs(V(1))
  const memMax = Number(sl('memory.max'))
  check('safe-ops on: flag, bounded slice (<= 4 GiB, no swap, 512 tasks, <= 4 CPUs) holding both units, server back', soOn.code === 0 && st1?.on === true && st1?.ready === true
    && /^MYCEL_SAFE_OPS_1A=1$/m.test(fs.readFileSync(`/etc/default/${ID}`, 'utf8')) && memMax > 0 && memMax <= 4 * 1024 ** 3 && sl('memory.swap.max') === '0' && sl('pids.max') === '512'
    && Number(sl('cpu.max').split(' ')[0]) / Number(sl('cpu.max').split(' ')[1]) <= 4
    && fs.existsSync(`/sys/fs/cgroup/${SLICE}/${unit('server.service')}`) && fs.existsSync(`/sys/fs/cgroup/${SLICE}/${unit('launcher.service')}`) && soH1?.version === V(1),
    `${tail(soOn, 6)} ${sl('memory.max')} ${sl('pids.max')} ${sl('cpu.max')}`)
  const soOff = sh([CTL, 'safe-ops', 'off', '--base', BASE, '--json', '--max-wait', '0'])
  const soH2 = await healthIs(V(1))
  check('safe-ops off: flag gone, slice limits gone, server back', soOff.code === 0 && lastJson(soOff.out)?.on === false && !fs.existsSync(`/etc/default/${ID}`)
    && sl('memory.max') === 'max' && sl('pids.max') === 'max' && soH2?.version === V(1), `${tail(soOff, 4)} ${sl('memory.max')}`)

  // ---- firewall (spec 3.4) ----
  const nft = sh(['nft', 'list', 'table', 'inet', ID])
  check(`nft table inet ${ID}: engine uid jumps to a chain that allows only the proxy port`, nft.code === 0 && nft.out.includes(`meta skuid ${ag}`) && nft.out.includes(`tcp dport ${PROXY} accept`), tail(nft, 8))
  const fws = readJson(`${BASE}/run/firewall.json`)
  check('run/firewall.json: loaded, this uid and port, root 644', fws?.loaded === true && fws?.engineUid === ag && fws?.proxyPort === PROXY && statOf(`${BASE}/run/firewall.json`) === 'root:root 644', JSON.stringify(fws))

  // ---- server up ----
  const h1 = await healthIs(V(1))
  check('server answers with the installed version', h1?.version === V(1), JSON.stringify(h1))
  // The gate runs as SRV, whose primary group is SRV. Linux needs the parent setgid bit to give its new socket
  // AGT's group. Health alone is insufficient: core startup is asynchronous and may have failed after HTTP starts.
  const toolsSock = `${BASE}/run/tools/tools.sock`
  const toolsStat = await until(() => { try { return fs.lstatSync(toolsSock) } catch { return null } }, (st) => st?.isSocket() === true, 15_000)
  check('tools.sock: live Unix socket, server uid, engine gid, 660', !!toolsStat && toolsStat.isSocket()
    && toolsStat.uid === uidOf(SRV) && toolsStat.gid === agg && (toolsStat.mode & 0o7777) === 0o660, statOf(toolsSock))
  // Exercise the installed socket as the real engine account, with no turn token or MCP operation. This proves
  // filesystem access/readiness, not tool authorization; the normal turn tests still exercise the sandbox path.
  const toolsConnect = sh([BUN, '--no-env-file', '-e', `
const net = require('node:net')
const socket = net.createConnection(${JSON.stringify(toolsSock)})
const timer = setTimeout(() => { socket.destroy(); console.error('socket timeout'); process.exit(2) }, 3000)
socket.once('error', (error) => { clearTimeout(timer); console.error(error.code ?? 'socket error'); process.exit(1) })
socket.once('connect', () => {
  clearTimeout(timer)
  console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid() }))
  socket.destroy()
})
`], { user: AGT })
  const toolsPeer = lastJson(toolsConnect.out)
  check('engine uid can connect to the installed tools.sock', toolsConnect.code === 0 && toolsPeer?.uid === ag && toolsPeer?.gid === agg, tail(toolsConnect))
  const pf = sh([CTL, 'preflight', '--json'])
  let pj: any = null; try { pj = JSON.parse(pf.out) } catch {}
  check('mycel-ctl preflight --json', !!pj, tail(pf, 4))
  const st = sh([`/usr/local/sbin/${ID}-ctl`, 'status', '--json', '--base', BASE])
  let sj: any = null; try { sj = JSON.parse(st.out) } catch {}
  check('mycel-ctl status --json (through the /usr/local/sbin link): the hosted service\'s strict TenantStatus', st.code === 0 && TenantStatus.safeParse(sj).success, tail(st, 4))
  const sd = sh([CTL, 'status', '--detail', '--json', '--base', BASE])
  let sdj: any = null; try { sdj = JSON.parse(sd.out) } catch {}
  check('mycel-ctl status --detail --json: units, firewall, plan', sd.code === 0 && !!sdj?.units && 'firewallOk' in (sdj ?? {}), tail(sd, 4))

  // ---- the engine account's network: only the model proxy port (as the engine account, outside the sandbox) ----
  const tcpAs = (host: string, port: number) => sh(['bash', '-c', `exec 3<>/dev/tcp/${host}/${port}`], { user: AGT }).code
  const decoy = Bun.listen({ hostname: '127.0.0.1', port: DECOY, socket: { data() {}, open(s) { s.end() } } })
  try {
    check('engine account reaches the model proxy port', tcpAs('127.0.0.1', PROXY) === 0)
    check('engine account cannot reach the server API port', tcpAs('127.0.0.1', PORT) !== 0)
    check('engine account cannot reach another local service', tcpAs('127.0.0.1', DECOY) !== 0)
    check('engine account cannot reach the cloud metadata address or the internet', tcpAs('169.254.169.254', 80) !== 0 && tcpAs('1.1.1.1', 443) !== 0)
    check('the server account still reaches a local service', sh(['bash', '-c', `exec 3<>/dev/tcp/127.0.0.1/${DECOY}`], { user: SRV }).code === 0)
  } finally { decoy.stop(true) }

  // ---- turns through the installed launcher, as the server would send them ----
  const claude = `${BASE}/app/engines/claude/current/claude`
  const turn = (chat: string, ...a: string[]) => {
    const r = sh([BUN, path.join(W, 'launcher-probe.js'), `${BASE}/run-launcher/launcher.sock`, `${BASE}/agent`, claude, chat, ...a], { user: SRV })
    try { return JSON.parse(r.out.trim().split('\n').pop()!) as { code?: number; error?: string; stderr?: string } } catch { return { error: tail(r) } }
  }
  const t1 = turn('c_t2a', 'write', '{CHAT_DIR}/mine.txt')
  check('a turn runs in its chat folder through the installed launcher', t1.code === 0, JSON.stringify(t1))
  const tb = turn('c_t2a', 'stat', '{BRIDGE}')
  check('the engine reaches the team-tools bridge that mcp.json names', tb.code === 0, JSON.stringify(tb))
  const t2 = turn('c_t2a', 'read', `${BASE}/config/server.json`)
  // refusals count only when the engine itself ran and was refused (1 EACCES/EPERM, 3 ENOENT), not when the sandbox failed
  const refused = (t: { code?: number }) => t1.code === 0 && (t.code === 1 || t.code === 3)
  check('the engine cannot read the install (not in its sandbox)', refused(t2), JSON.stringify(t2))
  const t3 = turn('c_t2b', 'read', `${BASE}/agent/c_t2a/mine.txt`)
  check('the engine cannot read another chat', refused(t3), JSON.stringify(t3))
  const t4 = turn('c_t2b', 'tcp', '127.0.0.1', String(PROXY))
  const t5 = turn('c_t2b', 'tcp', '127.0.0.1', String(PORT))
  check('in a turn: model proxy yes, server API no', t4.code === 0 && (t5.code === 4 || t5.code === 1 || t5.code === 5), JSON.stringify([t4, t5]))
  const t6 = turn('c_t2b', 'exec', '/usr/bin/sh')
  check('in a turn: no shell to run', refused(t6), JSON.stringify(t6))
  // the code sandbox (docs/DECISIONS.md "Code sandbox"): a code turn's program runs in its own sandbox (bash, no
  // network); the engine of that turn still cannot run a shell itself
  const codeTurn = (chat: string, program: string, ...a: string[]) => {
    const r = sh([BUN, path.join(W, 'launcher-probe.js'), '--code', program, `${BASE}/run-launcher/launcher.sock`, `${BASE}/agent`, claude, chat, ...a], { user: SRV })
    try { return JSON.parse(r.out.trim().split('\n').pop()!) as { code?: number; error?: string; run?: any } } catch { return { error: tail(r) } }
  }
  const t6c = codeTurn('c_t2c', `echo ran-in-code; exec 3<>/dev/tcp/127.0.0.1/${PROXY} && echo NET-REACHED; true`, 'hold', '4000')
  check('code turn: the program runs through the launcher, without network', t6c.run?.ev === 'code_exit' && t6c.run.code === 0 && /ran-in-code/.test(t6c.run.stdout) && !/NET-REACHED/.test(t6c.run.stdout), JSON.stringify(t6c))
  const t6d = codeTurn('c_t2c', 'true', 'exec', '/usr/bin/sh')
  check('code turn: its engine still cannot run a shell', refused(t6d), JSON.stringify(t6d))
  const sock = sh(['stat', '-c', '%U:%G %a', `${BASE}/run-launcher/launcher.sock`]).out.trim()
  check('launcher.sock: engine account, server group, 660 (the setgid run-launcher folder gives the group)', sock === `${AGT}:${SRV} 660`, sock)
  const t7 = [turn('c_t2b', 'read', '/etc/shadow'), turn('c_t2b', 'read', '/etc/resolv.conf'), turn('c_t2b', 'read', '/etc/passwd')]
  check('in a turn: only the sandbox\'s own /etc (no shadow, no resolv.conf)', t7[0]!.code === 3 && t7[1]!.code === 3 && t7[2]!.code === 0, JSON.stringify(t7))

  // ---- tokens CLI and account tool (spec 3.5.3) ----
  const token = 'sk-ant-oat01-' + 'Ab3_dE5-fG7h'.repeat(8)
  const tk = sh([`${BASE}/root/set-claude-token`], { input: token.match(/.{1,50}/g)!.join('\n') + '\n' })
  check('set-claude-token: a wrapped paste is stored whole for the server account, mode 600', tk.code === 0 && fs.readFileSync(`${BASE}/secrets/claude-oauth-token`, 'utf8') === token + '\n'
    && statOf(`${BASE}/secrets/claude-oauth-token`) === `${SRV}:${SRV} 600` && !(tk.out + tk.err).includes(token), tail(tk))
  check('the engine account cannot read the token', sh(['cat', `${BASE}/secrets/claude-oauth-token`], { user: AGT }).code !== 0)
  const owner = sh([`${BASE}/root/mycel-account`, 'create-owner', '--username', 'kim', '--name', 'Owner', '--team', 'Install test', '--locale', 'en'], { input: 'install test owner pw 1\n' })
  check('mycel-account create-owner (password on stdin, as the server account)', owner.code === 0, tail(owner))
  const owners = sh([`${BASE}/root/mycel-account`, 'list-owners'])
  check('mycel-account list-owners', owners.code === 0 && owners.out.includes('kim'), tail(owners))

  // ---- resource plan (spec 3.8.5) ----
  const plan = path.join(W, 'plan.json')
  fs.writeFileSync(plan, JSON.stringify({ format: 1, plan: 'basic', maxConcurrency: 2, memoryMiB: 2048, cpuCores: 1, diskGiB: 20 }))
  const ap = sh([CTL, 'apply-plan', '--base', BASE], { input: fs.readFileSync(plan, 'utf8') })
  const mm = sh(['systemctl', 'show', unit('launcher.service'), '-pMemoryMax']).out.trim()
  check('mycel-ctl apply-plan: root/plan.json and the launcher unit MemoryMax (1280 MiB)', ap.code === 0 && statOf(`${BASE}/root/plan.json`) === 'root:root 644' && mm === `MemoryMax=${1280 * 1024 * 1024}`, `${tail(ap)} ${mm}`)
  // a plan file without "codeSandbox": the plan does not include it, a code turn is refused (the turn never starts)
  const t6e = codeTurn('c_t2c', 'true', 'id')
  check('a plan without the code sandbox refuses a code turn', /code_sandbox_unavailable/.test(t6e.error ?? ''), JSON.stringify(t6e))

  // ---- updates ----
  const up2 = installer('update', '--from', kit(2))
  const h2 = await healthIs(V(2))
  // the new version answers before the bootstrap records it as current: wait for state.json too
  const s2 = await until(() => readJson(`${BASE}/app/state.json`), (s) => s?.current === V(2), 60_000)
  check('installer update: switches to the newer kit, the old one stays for roll-back', up2.code === 0 && h2?.version === V(2) && s2?.current === V(2) && s2?.previous === V(1), `${tail(up2)} ${JSON.stringify(s2)}`)
  check('update keeps the engines and the plan', fs.existsSync(`${BASE}/app/engines/claude/current/claude`) && fs.existsSync(`${BASE}/root/plan.json`))
  const up3 = installer('update', '--from', kit(3))
  const h3 = await healthIs(V(2), 30_000)
  check('installer update with a crashing kit: the bootstrap goes back, the installer exits 1', up3.code !== 0 && h3?.version === V(2), `${tail(up3)} ${JSON.stringify(h3)}`)
  const cu = sh([CTL, 'update', '--base', BASE, '--bundle', path.join(kit(4), `${V(4)}-linux-${ARCH}.tar.zst`), '--json'])
  const cj = lastJson(cu.out)
  const h4 = await healthIs(V(4))
  check('mycel-ctl update --bundle: verified, switched, healthy', cu.code === 0 && cj?.result === 'ok' && h4?.version === V(4), `${tail(cu)} ${JSON.stringify(h4)}`)
  // an update switches app/current under the running launcher: the next turn must get the new version's bridge
  const tb4 = turn('c_t2d', 'stat', '{BRIDGE}')
  check('after an update the engine still reaches the bridge (the launcher resolves it per turn)', tb4.code === 0, JSON.stringify(tb4))
  const cu5 = sh([CTL, 'update', '--base', BASE, '--bundle', path.join(kit(5), `${V(5)}-linux-${ARCH}.tar.zst`), '--json'])
  const c5 = lastJson(cu5.out)
  const h5 = await healthIs(V(4), 30_000)
  check('mycel-ctl update with a crashing release: rolled_back (exit 10), the previous version answers', cu5.code === 10 && c5?.result === 'rolled_back' && h5?.version === V(4), `${tail(cu5)} ${JSON.stringify(h5)}`)
  const rep = installer('repair', '--from', kit(4))
  check('repair (arguments from root/install.json)', rep.code === 0 && (await healthIs(V(4)))?.version === V(4), tail(rep))

  // ---- public host, app connectors, Google Drive client (installer flags, kept by repair) ----
  const HOST = 'team.example.com', CB = `https://${HOST}/api/integrations/google-drive/callback`
  const cfgBefore = fs.readFileSync(`${BASE}/config/server.json`, 'utf8')
  const badHost = installer('repair', '--from', kit(4), '--public-host', 'https://team.example.com')
  const noHost = installer('repair', '--from', kit(4), '--app-connectors')
  check('bad --public-host and --app-connectors without a host are refused; server.json is unchanged', badHost.code !== 0 && /bad --public-host/.test(badHost.err)
    && noHost.code !== 0 && /need a public address/.test(noHost.err) && fs.readFileSync(`${BASE}/config/server.json`, 'utf8') === cfgBefore, `${badHost.err.trim()} | ${noHost.err.trim()}`)
  const wrongCb = path.join(W, 'drive-wrong.json'); fs.writeFileSync(wrongCb, JSON.stringify({ clientId: 'c', clientSecret: 'canary-secret-1', redirectUri: 'https://other.example.com/api/integrations/google-drive/callback' }))
  const badDrive = installer('repair', '--from', kit(4), '--public-host', HOST, '--google-drive-client', wrongCb)
  const noHostDrive = path.join(W, 'drive-nohost.json'); fs.writeFileSync(noHostDrive, JSON.stringify({ clientId: 'c', clientSecret: 'canary-secret-1', redirectUri: CB }))
  const badNoHost = installer('repair', '--from', kit(4), '--google-drive-client', noHostDrive)
  check('a Drive client for another host, or with no public host at all, is refused; nothing changed, no secret printed', badDrive.code !== 0 && /redirectUri must be/.test(badDrive.err)
    && badNoHost.code !== 0 && /needs a public address/.test(badNoHost.err) && fs.readFileSync(`${BASE}/config/server.json`, 'utf8') === cfgBefore
    && !fs.existsSync(`${BASE}/secrets/integrations/google-drive/client.json`) && !/canary-secret-1/.test(badDrive.out + badDrive.err + badNoHost.out + badNoHost.err), `${badDrive.err.trim()} | ${badNoHost.err.trim()}`)
  const google = path.join(W, 'client_secret.json')
  fs.writeFileSync(google, JSON.stringify({ web: { client_id: 'id.apps.googleusercontent.com', client_secret: 'canary-secret-2', redirect_uris: ['http://localhost:3000/cb', CB], project_id: 'p' } }))
  const pub = installer('repair', '--from', kit(4), '--public-host', HOST, '--app-connectors', '--google-drive-client', google)
  const pc = readJson(`${BASE}/config/server.json`), pij = readJson(`${BASE}/root/install.json`), dc = readJson(`${BASE}/secrets/integrations/google-drive/client.json`)
  check('--public-host, --app-connectors, --google-drive-client (Google download format): server.json, install.json, client.json 600 in 700 folders, no secret printed',
    pub.code === 0 && pc?.tunnel?.host === HOST && pc?.appConnectors === true && pij?.publicHost === HOST && pij?.appConnectors === true
      && JSON.stringify(dc) === JSON.stringify({ clientId: 'id.apps.googleusercontent.com', clientSecret: 'canary-secret-2', redirectUri: CB })
      && statOf(`${BASE}/secrets/integrations`) === `${SRV}:${SRV} 700` && statOf(`${BASE}/secrets/integrations/google-drive`) === `${SRV}:${SRV} 700`
      && statOf(`${BASE}/secrets/integrations/google-drive/client.json`) === `${SRV}:${SRV} 600` && !/canary-secret-2/.test(pub.out + pub.err)
      && !/canary-secret-2|clientSecret/.test(fs.readFileSync(`${BASE}/root/install.json`, 'utf8')) && (await healthIs(V(4)))?.version === V(4), `${tail(pub)} ${JSON.stringify({ tunnel: pc?.tunnel, app: pc?.appConnectors, pij })}`)
  // root/install.json is the source for repair: server.json without the two keys gets them back
  const sjNo = readJson(`${BASE}/config/server.json`); delete sjNo.tunnel; delete sjNo.appConnectors
  fs.writeFileSync(`${BASE}/config/server.json`, JSON.stringify(sjNo, null, 2) + '\n')
  const keep = installer('repair', '--from', kit(4))
  const kc = readJson(`${BASE}/config/server.json`), kij = readJson(`${BASE}/root/install.json`)
  check('repair without the flags restores the public host and app connectors from install.json and keeps the Drive client', keep.code === 0 && kc?.tunnel?.host === HOST
    && kc?.appConnectors === true && kij?.publicHost === HOST && kij?.appConnectors === true
    && readJson(`${BASE}/secrets/integrations/google-drive/client.json`)?.clientSecret === 'canary-secret-2', tail(keep))
  const off = installer('repair', '--from', kit(4), '--public-host', 'none', '--no-app-connectors')
  const oc = readJson(`${BASE}/config/server.json`)
  check('--public-host none --no-app-connectors: no public address, app connectors off', off.code === 0 && oc?.tunnel === null && oc?.appConnectors === false
    && readJson(`${BASE}/root/install.json`)?.publicHost === null && (await healthIs(V(4)))?.version === V(4), tail(off))

  // ---- backup ----
  const bk = admin(['backup'])
  check('backup as the server account', bk.code === 0, tail(bk))

  // ---- real engines (pinned downloads; no model is called) ----
  if (REAL) {
    const re = installer('install', '--from', kit(4), '--allow-unsigned', '--engine', 'claude', '--engine', 'codex')
    const lock = readJson(path.join(kit(4), 'app', V(4), 'engines.lock.json'))
    check('pinned Claude Code and Codex downloaded, SHA-256 checked, version matches the pin (no version warning)', re.code === 0 && !/version .* the kit pins/.test(re.err), tail(re, 6))
    for (const n of ['claude', 'codex']) {
      const r = sh([BUN, path.join(W, 'launcher-probe.js'), `${BASE}/run-launcher/launcher.sock`, `${BASE}/agent`, `${BASE}/app/engines/${n}/current/${n}`, `c_real_${n}`, '--version'], { user: SRV })
      check(`${n} ${lock?.[n]?.version}: --version runs inside the installed sandbox`, /"code":0/.test(r.out), tail(r))
    }
  } else skip('real Claude Code / Codex', 'set MYCEL_T2_REAL_ENGINES=1 (downloads ~400 MB)')

  if (KEEP) { console.log(`--keep: ${ID} stays installed`); return }
  // ---- uninstall (keep data) -> reinstall -> purge ----
  const un = installer('uninstall')
  const units = [...['firewall.service', 'firewall.timer', 'launcher.service', 'server.service', 'update.service', 'update.timer'].map(unit), SLICE].filter((u) => fs.existsSync(`/etc/systemd/system/${u}`))
  check('uninstall: units, firewall table and programs gone, data kept (root-owned), accounts locked', un.code === 0 && units.length === 0 && sh(['nft', 'list', 'table', 'inet', ID]).code !== 0
    && !fs.existsSync(`${BASE}/app`) && !fs.existsSync(`${BASE}/root`) && !fs.existsSync(`${BASE}/agent`) && statOf(`${BASE}/data`) === 'root:root 700' && fs.existsSync(`${BASE}/data/app.db`)
    && /^L/.test(sh(['passwd', '-S', SRV]).out.trim().split(/\s+/)[1] ?? ''), `${tail(un)} units ${units}`)
  const re = installer('install', '--from', kit(4), '--allow-unsigned', '--engine', `claude=${engine}`)
  check('reinstall on the kept data: the server account owns it again, the team is still there (no new setup code)', re.code === 0 && statOf(`${BASE}/data`) === `${SRV}:${SRV} 700`
    && (await healthIs(V(4)))?.version === V(4) && !fs.existsSync(`${BASE}/data/setup-token`), tail(re))
  const pu = installer('uninstall', '--purge')
  check('uninstall --purge: nothing of the install left', pu.code === 0 && !fs.existsSync(BASE) && sh(['getent', 'passwd', SRV]).code !== 0 && sh(['getent', 'passwd', AGT]).code !== 0
    && !fs.existsSync(`/etc/sysctl.d/60-${ID}.conf`) && !fs.existsSync(`/usr/local/sbin/${ID}-ctl`), tail(pu))
}

try {
  await main()
} catch (e) {
  check('test ran to the end', false, (e as Error).stack ?? String(e))
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${results.some((r) => r.skipped) ? ` (${results.filter((r) => r.skipped).length} skipped)` : ''}`)
for (const f of failed) console.log(`FAIL ${f.name}${f.detail ? ` — ${f.detail.slice(0, 300)}` : ''}`)
process.exit(failed.length ? 1 : 0)
