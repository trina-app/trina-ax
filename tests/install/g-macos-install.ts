// Install test for macOS (component G, design tab 7 "설치": install -> run -> update -> roll back -> back up / restore
// -> uninstall). Installs a TEST copy (id mycel-test, accounts _axtsrv / _axtagt, ports 19174-19177) with a FAKE engine
// (tests/lib/g-sbprobe.c): running the real engine as the role account needs the owner's `claude setup-token`.
//
//   bun run build:native            (as yourself)
//   sudo bun tests/install/g-macos-install.ts [--keep]
//
// Verifies accounts, owners and modes, LaunchDaemons, the pf firewall (as the engine account), the sandbox through the
// installed launcher, update swap / bootstrap roll-back / manual roll-back, backup + encrypted archive + restore, and
// that the uninstaller removes everything. Prints a report and exits 1 if any check failed. Never asks for or stores
// a password: run it with sudo.
import fs from 'node:fs'
import path from 'node:path'
import { buildBundle } from '../../scripts/build-bundle'
import { packBundle, writeManifest } from '../../server/src/system/bundle'

const REPO = path.resolve(import.meta.dir, '..', '..')
// account names can be overridden (MYCEL_TEST_SRV / MYCEL_TEST_AGT) when a record from an earlier run cannot be
// deleted unattended (macOS asks the logged-in administrator to approve user deletions)
const ID = 'mycel-test', SRV = process.env.MYCEL_TEST_SRV ?? '_axtsrv', AGT = process.env.MYCEL_TEST_AGT ?? '_axtagt'
const PORT = 19174, TLS = 19175, PROXY = 19176, DECOY = 19177
const BASE = `/Library/Application Support/${ID}`
const LABEL = `app.treesoop.${ID}`
const KEEP = process.argv.includes('--keep')
const W = `/private/tmp/${ID}-install-test`

type Result = { name: string; ok: boolean; blocked?: boolean; detail?: string }
const results: Result[] = []
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
/** a step that needs the owner (not a failure of the product) */
function blocked(name: string, detail: string) {
  results.push({ name, ok: true, blocked: true, detail })
  console.log(`BLOCKED ${name} — ${detail}`)
}
function sh(cmd: string[], o: { input?: string; env?: Record<string, string>; user?: string } = {}) {
  const full = o.user ? ['/usr/bin/sudo', '-n', '-u', o.user, ...(o.env ? ['/usr/bin/env', ...Object.entries(o.env).map(([k, v]) => `${k}=${v}`)] : []), ...cmd] : cmd
  const p = Bun.spawnSync(full, { stdin: o.input !== undefined ? Buffer.from(o.input) : 'ignore', stdout: 'pipe', stderr: 'pipe', env: o.user ? { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } : { ...process.env, ...(o.env ?? {}) }, cwd: '/' })
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() }
}
const statOf = (p: string) => { const r = sh(['/usr/bin/stat', '-f', '%Su:%Sg %OLp', p]); return r.code === 0 ? r.out.trim() : 'missing' }
async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (ok(v) || Date.now() > end) return v; await Bun.sleep(250) }
}
const health = async () => { try { return (await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()) as { ok: boolean; version: string } } catch { return null } }
const BUN = `${BASE}/app/current/bin/bun`
const ADMIN_ENV = { MYCEL_MODE: 'prod', MYCEL_CONFIG: `${BASE}/config/server.json`, MYCEL_INSTALL_BASE: BASE, HOME: `${BASE}/data` }
const admin = (args: string[], input?: string) => sh([BUN, `${BASE}/app/current/server/src/admin.js`, ...args], { user: SRV, env: ADMIN_ENV, input })
const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

async function main() {
  if (process.getuid?.() !== 0) { console.error('run with sudo'); process.exit(2) }
  if (process.platform !== 'darwin') { console.error('macOS only'); process.exit(2) }
  fs.rmSync(W, { recursive: true, force: true })
  fs.mkdirSync(W, { recursive: true, mode: 0o755 })

  // ---- build: three versions (good, good, crashing) + fake engine + launcher probe ----
  const v1 = await buildBundle({ version: '0.9.0-test.1', out: path.join(W, 'rel1') })
  const v2 = await buildBundle({ version: '0.9.0-test.2', out: path.join(W, 'rel2') })
  const v3 = await buildBundle({ version: '0.9.0-test.3', out: path.join(W, 'rel3') })
  fs.writeFileSync(path.join(v3.dir, 'server', 'src', 'main.js'), 'process.exit(3)\n')
  await writeManifest(v3.dir, '0.9.0-test.3')
  await packBundle(v3.dir, v3.archive)
  const probe = path.join(W, 'fake-engine')
  if (sh(['cc', '-O2', '-o', probe, path.join(REPO, 'tests', 'lib', 'g-sbprobe.c')]).code !== 0) throw new Error('cc failed')
  const lp = await Bun.build({ entrypoints: [path.join(import.meta.dir, 'g-launcher-probe.ts')], target: 'bun', outdir: W, naming: 'launcher-probe.js' })
  if (!lp.success) throw new Error('bundling the launcher probe failed')
  for (const f of fs.readdirSync(W)) fs.chmodSync(path.join(W, f), fs.statSync(path.join(W, f)).isDirectory() ? 0o755 : 0o755)
  sh(['/bin/chmod', '-R', 'a+rX', W])
  fs.writeFileSync('/private/tmp/mycel-test-secret', 'left in /tmp by a person\n', { mode: 0o644 })

  // ---- install ----
  const inst = sh([path.join(REPO, 'scripts', 'install-macos.sh'), '--from', path.join(W, 'rel1'), '--id', ID, '--server-user', SRV, '--agent-user', AGT,
    '--port', String(PORT), '--tls-port', String(TLS), '--proxy-port', String(PROXY), '--engine', `fake=${probe}`, '--allow-unsigned', '--no-power'])
  check('install script', inst.code === 0, (inst.out + inst.err).trim().split('\n').slice(-3).join(' | '))
  if (inst.code !== 0) return

  // ---- accounts ----
  for (const u of [SRV, AGT]) {
    const uid = Number(sh(['/usr/bin/id', '-u', u]).out.trim())
    check(`${u}: role account UID 450-499`, uid >= 450 && uid <= 499, String(uid))
    const rec = sh(['/usr/bin/dscl', '.', '-read', `/Users/${u}`, 'UserShell', 'IsHidden', 'NFSHomeDirectory']).out
    check(`${u}: shell /usr/bin/false, hidden`, /UserShell: \/usr\/bin\/false/.test(rec) && /IsHidden: 1/.test(rec), rec.replace(/\n/g, ' '))
    const gm = sh(['/usr/bin/dscl', '.', '-read', `/Groups/${u}`, 'GroupMembership']).out.trim()
    check(`${u}: same-name group with only this account`, gm === `GroupMembership: ${u}`, gm)
  }
  check('engine account home is root-owned 555', statOf(`${BASE}/agent/home`) === 'root:wheel 555', statOf(`${BASE}/agent/home`))

  // ---- owners and modes (tab 6 table) ----
  const want: [string, string][] = [
    [BASE, 'root:wheel 755'], [`${BASE}/app`, `${SRV}:${SRV} 755`], [`${BASE}/app/engines`, `${SRV}:${AGT} 750`],
    [`${BASE}/data`, `${SRV}:${SRV} 700`], [`${BASE}/team`, `${SRV}:${SRV} 700`], [`${BASE}/config`, `${SRV}:${SRV} 700`],
    [`${BASE}/config/server.json`, `${SRV}:${SRV} 600`], [`${BASE}/secrets`, `${SRV}:${SRV} 700`], [`${BASE}/secrets/lan-tls.key`, `${SRV}:${SRV} 600`],
    [`${BASE}/setup`, `${SRV}:admin 750`], [`${BASE}/setup/code`, `${SRV}:admin 640`], [`${BASE}/setup/lan-cert.sha256`, `${SRV}:admin 640`],
    [`${BASE}/status`, `${SRV}:admin 750`], [`${BASE}/agent`, `${AGT}:${AGT} 700`], [`${BASE}/run`, 'root:wheel 755'],
    [`${BASE}/run/tools`, `${SRV}:${AGT} 750`], [`${BASE}/run-launcher`, `${AGT}:${SRV} 750`], [`${BASE}/root`, 'root:wheel 755'],
    [`${BASE}/root/mycel-bootstrap`, 'root:wheel 755'], [`${BASE}/root/mycel-launcher`, 'root:wheel 755'], [`${BASE}/root/engine.sb`, 'root:wheel 644'],
    [`${BASE}/root/pf.anchor`, 'root:wheel 644'], [`${BASE}/root/pf-load`, 'root:wheel 755'], [`/Library/Logs/${ID}`, 'root:wheel 755'],
    [`/Library/Logs/${ID}/crash`, 'root:wheel 755'], [`/Library/Logs/${ID}/server`, `${SRV}:admin 750`], [`${BASE}/app/state.json`, `${SRV}:${SRV} 640`],
    [`/Library/LaunchDaemons/${LABEL}.server.plist`, 'root:wheel 644'], [`/Library/LaunchDaemons/${LABEL}.launcher.plist`, 'root:wheel 644'],
    [`/Library/LaunchDaemons/${LABEL}.pf.plist`, 'root:wheel 644'], [`/etc/newsyslog.d/${ID}.conf`, 'root:wheel 644'],
  ]
  for (const [p, w] of want) check(`owner/mode ${p.replace(BASE, '<base>')}`, statOf(p) === w, `${statOf(p)} (want ${w})`)

  // ---- daemons and server ----
  for (const d of ['server', 'launcher']) {
    const pr = sh(['/bin/launchctl', 'print', `system/${LABEL}.${d}`]).out
    check(`launchd ${d}: running, KeepAlive`, /state = running/.test(pr), pr.match(/state = \w+/)?.[0])
  }
  check('launchd pf job loaded', sh(['/bin/launchctl', 'print', `system/${LABEL}.pf`]).code === 0)
  const h1 = await until(health, (h) => !!h?.ok, 30_000)
  check('server answers /api/health with the installed version', h1?.version === '0.9.0-test.1', JSON.stringify(h1))
  const st = await until(() => readJson(`${BASE}/status/status.json`), (s) => !!s, 40_000)
  check('status.json written by the server', !!st, st ? `overall=${st.overall} firewall=${st.firewall} sandbox=${st.sandbox}` : undefined)
  if (st) {
    const user = sh(['/bin/ps', '-o', 'user=', '-p', String(st.pid)]).out.trim()
    check('server runs as the server account', user === SRV, user)
    check('status.json is server:admin 640', statOf(`${BASE}/status/status.json`) === `${SRV}:admin 640`, statOf(`${BASE}/status/status.json`))
    check('menubar status: firewall ok, sandbox ok', st.firewall === 'ok' && st.sandbox === 'ok', JSON.stringify(st.problems))
  }
  const lpid = sh(['/usr/bin/pgrep', '-u', AGT, '-f', 'mycel-launcher']).out.trim()
  check('launcher runs as the engine account', !!lpid, lpid)
  const fda = /needs Full Disk Access/
  if (fda.test(inst.err) && /cron\.deny|at\.deny/.test(inst.err)) blocked('cron.deny / at.deny entry for the engine account', 'writing /var/at needs Full Disk Access, which the setup .pkg postinstall has and this terminal session does not; the installer warned and the sandbox profile still blocks crontab/at')
  else check('cron.deny and at.deny list the engine account', ['/var/at/cron.deny', '/var/at/at.deny'].every((f) => fs.readFileSync(f, 'utf8').split('\n').includes(AGT)))
  const tm = sh(['/usr/bin/tmutil', 'isexcluded', `${BASE}/secrets`, `${BASE}/agent`]).out
  if (fda.test(inst.err) && /Time Machine/.test(inst.err)) blocked('Time Machine exclusions', 'tmutil addexclusion -p needs Full Disk Access (setup .pkg has it); the installer warned')
  else check('Time Machine excludes secrets/ and agent/', (tm.match(/\[Excluded\]/g) ?? []).length === 2, tm.replace(/\s+/g, ' ').trim())
  check('newsyslog config parses', sh(['/usr/sbin/newsyslog', '-n', '-f', `/etc/newsyslog.d/${ID}.conf`]).code === 0)

  // ---- pf ----
  const pf = readJson(`${BASE}/run/pf.json`)
  check('pf.json is written by root into the root-owned run/ folder', statOf(`${BASE}/run/pf.json`) === 'root:wheel 644', statOf(`${BASE}/run/pf.json`))
  check('pf-load: enabled, anchor referenced, rules loaded', !!pf && pf.enabled && pf.referenced && pf.rules >= 2, JSON.stringify(pf))
  const rules = sh(['/sbin/pfctl', '-a', `com.apple/250.${ID}`, '-s', 'rules']).out.trim()
  check('pf anchor rules', rules.includes(`user = `) && rules.includes('block drop out quick'), rules.replace(/\n/g, ' | '))
  // echo servers: "talk" checks that data flows, not just connect() (IPv6 loopback: pf drops the engine account's
  // packets once the connection exists, so a bare connect can succeed while nothing gets through)
  // in a separate process: sh() is spawnSync, which would block echo servers living in this one
  const echoes = Bun.spawn([process.execPath, '-e', `const n = require('net'); const e = (c) => c.on('data', (d) => c.write(d)).on('error', () => {});
for (const [h, p] of [['127.0.0.1', ${PROXY}], ['127.0.0.1', ${DECOY}], ['::1', ${DECOY}]]) n.createServer(e).listen(p, h);
console.log('ready')`], { stdout: 'pipe', stderr: 'inherit' })
  { const r = echoes.stdout.getReader(); await r.read(); r.releaseLock() }
  const asAgent = (...a: string[]) => sh([probe, ...a], { user: AGT }).code === 0
  check('pf: engine account reaches the model proxy port', asAgent('talk', '127.0.0.1', String(PROXY)))
  check('pf: engine account cannot reach another localhost port (decoy)', !asAgent('talk', '127.0.0.1', String(DECOY)))
  check('pf: engine account cannot reach the server API port', !asAgent('talk', '127.0.0.1', String(PORT)))
  check('pf: engine account cannot reach ::1', !asAgent('talk', '::1', String(DECOY)))
  check('pf: engine account cannot reach the internet (1.1.1.1:443)', !asAgent('talk', '1.1.1.1', '443'))
  const gw = sh(['/sbin/route', '-n', 'get', 'default']).out.match(/gateway: (\S+)/)?.[1]
  if (gw && /^\d+\.\d+\.\d+\.\d+$/.test(gw)) check(`pf: engine account cannot reach the office gateway (${gw}:80)`, !asAgent('talk', gw, '80'))
  check('pf control: the server account still reaches the decoy (rules only match the engine account)', sh([probe, 'talk', '127.0.0.1', String(DECOY)], { user: SRV }).code === 0)
  check('pf control: the server account still reaches ::1', sh([probe, 'talk', '::1', String(DECOY)], { user: SRV }).code === 0)
  check('files: engine account cannot list the team folder / data / secrets', !asAgent('list', `${BASE}/team`) && !asAgent('list', `${BASE}/data`) && !asAgent('read', `${BASE}/secrets/lan-tls.key`))

  // ---- sandbox through the installed launcher ----
  const engine = `${BASE}/app/engines/fake/current/fake-engine`
  const turn = (chat: string, ...a: string[]) => {
    const r = sh([BUN, path.join(W, 'launcher-probe.js'), `${BASE}/run-launcher/launcher.sock`, `${BASE}/agent`, engine, chat, ...a], { user: SRV })
    try { return JSON.parse(r.out.trim().split('\n').at(-1)!) as { code?: number; error?: string } } catch { return { error: r.err || r.out } }
  }
  check('launcher: a turn writes and reads its own chat folder', turn('c1', 'write', '{CHAT_DIR}/note.txt').code === 0)
  check('launcher+sandbox: /tmp files of people are not readable', turn('c1', 'read', '/private/tmp/mycel-test-secret').code !== 0)
  check('launcher+sandbox: /Users is not listable', turn('c1', 'list', '/Users').code !== 0)
  check('launcher+sandbox: another chat folder is not readable', (turn('c2', 'write', '{CHAT_DIR}/x').code === 0) && turn('c1', 'list', `${BASE}/agent/c2`).code !== 0)
  check('launcher+sandbox+pf: no internet', turn('c1', 'talk', '1.1.1.1', '443').code !== 0)
  check('launcher+sandbox+pf: no other localhost port', turn('c1', 'talk', '127.0.0.1', String(DECOY)).code !== 0 && turn('c1', 'talk', '::1', String(DECOY)).code !== 0)
  check('launcher+sandbox+pf: model proxy port reachable', turn('c1', 'talk', '127.0.0.1', String(PROXY)).code === 0)
  check('launcher+sandbox: no shell', turn('c1', 'exec', '/bin/sh').code !== 0)
  // nc, not the bun client: the launcher answers a refused peer and closes at once, which bun can report as
  // ECONNREFUSED before it reads the answer
  const ask = (user?: string) => sh(['/usr/bin/nc', '-U', `${BASE}/run-launcher/launcher.sock`], { input: '{"op":"run"}\n', user })
  const foreign = ask(AGT)
  check('the launcher refuses the engine account', /only the server may use the launcher/.test(foreign.out), (foreign.out + foreign.err).trim().slice(0, 160))
  const asRoot = ask()
  check('the launcher refuses root (only the server uid)', /only the server may use the launcher/.test(asRoot.out), (asRoot.out + asRoot.err).trim().slice(0, 160))
  echoes.kill()

  // ---- updates: switch, bootstrap roll-back of a crashing version, manual roll-back ----
  const stg = admin(['stage-update', v2.archive])
  check('admin stage-update (verified unpack into app/versions)', stg.code === 0, stg.err.trim().slice(0, 200))
  const sw = admin(['switch', '0.9.0-test.2', '--restart'])
  check('admin switch --restart', sw.code === 0, sw.err.trim().slice(0, 200))
  const h2 = await until(health, (h) => h?.version === '0.9.0-test.2', 30_000)
  check('update: new version answers /api/health', h2?.version === '0.9.0-test.2', JSON.stringify(h2))
  const s2 = await until(() => readJson(`${BASE}/app/state.json`), (s) => s?.pending === null && s?.current === '0.9.0-test.2', 10_000)
  check('update: state.json current=test.2 previous=test.1', s2?.current === '0.9.0-test.2' && s2?.previous === '0.9.0-test.1', JSON.stringify({ c: s2?.current, p: s2?.previous }))
  const rb = admin(['rollback', '--restart'])
  check('admin rollback --restart', rb.code === 0, rb.err.trim().slice(0, 200))
  check('manual roll-back: test.1 answers again', (await until(health, (h) => h?.version === '0.9.0-test.1', 30_000))?.version === '0.9.0-test.1')
  admin(['switch', '0.9.0-test.2', '--restart'])
  await until(health, (h) => h?.version === '0.9.0-test.2', 30_000)
  await until(() => readJson(`${BASE}/app/state.json`), (s) => s?.pending === null, 10_000)
  check('admin stage-update of a crashing version', admin(['stage-update', v3.archive]).code === 0)
  admin(['switch', '0.9.0-test.3', '--restart'])
  const s3 = await until(() => readJson(`${BASE}/app/state.json`), (s) => s?.history?.at(-1)?.result === 'rolled_back', 40_000)
  check('bootstrap rolls a crashing version back', s3?.history?.at(-1)?.result === 'rolled_back' && s3?.current === '0.9.0-test.2', JSON.stringify(s3?.history?.at(-1)))
  check('after the roll-back test.2 answers', (await until(health, (h) => h?.version === '0.9.0-test.2', 30_000))?.version === '0.9.0-test.2')
  const ulog = `/Library/Logs/${ID}/server/update.log`
  check('update log records the roll-back', fs.existsSync(ulog) && fs.readFileSync(ulog, 'utf8').includes('rolled_back'))

  // ---- repair run against a hostile server account: root must not follow its links or chown its hard links ----
  const victim = '/private/tmp/mycel-test-victim'
  fs.writeFileSync(victim, 'root file\n', { mode: 0o644 })
  fs.rmSync(`${victim}-new`, { force: true })
  // the hard link goes into the version folder the installer copies (test.1); the old code chowned it recursively
  sh(['/bin/sh', '-c', `ln '${victim}' '${BASE}/app/versions/0.9.0-test.1/hardlink' ; rm -f '${BASE}/app/state.json' && ln -s '${victim}-new' '${BASE}/app/state.json'`], { user: SRV })
  const rep1 = sh([path.join(REPO, 'scripts', 'install-macos.sh'), '--from', path.join(W, 'rel1'), '--id', ID, '--server-user', SRV, '--agent-user', AGT,
    '--port', String(PORT), '--tls-port', String(TLS), '--proxy-port', String(PROXY), '--engine', `fake=${probe}`, '--allow-unsigned', '--no-power', '--skip-tmutil'])
  check('repair run with planted links and hard links', rep1.code === 0, (rep1.out + rep1.err).trim().split('\n').slice(-2).join(' | '))
  check('repair: a hard link the server made is not chowned by root', statOf(victim) === 'root:wheel 644', statOf(victim))
  check('repair: a planted state.json link is replaced, not followed', !fs.existsSync(`${victim}-new`) && statOf(`${BASE}/app/state.json`) === `${SRV}:${SRV} 640`, statOf(`${BASE}/app/state.json`))
  sh(['/bin/sh', '-c', `rm -rf '${BASE}/app/engines/fake' && ln -s /private/tmp '${BASE}/app/engines/fake'`], { user: SRV })
  const rep2 = sh([path.join(REPO, 'scripts', 'install-macos.sh'), '--from', path.join(W, 'rel1'), '--id', ID, '--server-user', SRV, '--agent-user', AGT,
    '--port', String(PORT), '--tls-port', String(TLS), '--proxy-port', String(PROXY), '--engine', `fake=${probe}`, '--allow-unsigned', '--no-power', '--skip-tmutil'])
  check('repair refuses a symbolic link on the way to a folder it chowns', rep2.code !== 0 && /symbolic link/.test(rep2.err) && statOf('/private/tmp') === 'root:wheel 1777', (rep2.err.trim().split('\n').at(-1) ?? '') + ' /tmp=' + statOf('/private/tmp'))
  sh(['/bin/rm', '-f', `${BASE}/app/engines/fake`])
  const rep3 = sh([path.join(REPO, 'scripts', 'install-macos.sh'), '--from', path.join(W, 'rel1'), '--id', ID, '--server-user', SRV, '--agent-user', AGT,
    '--port', String(PORT), '--tls-port', String(TLS), '--proxy-port', String(PROXY), '--engine', `fake=${probe}`, '--allow-unsigned', '--no-power', '--skip-tmutil'])
  check('repair run after the link is gone', rep3.code === 0, (rep3.out + rep3.err).trim().split('\n').slice(-2).join(' | '))
  fs.rmSync(victim, { force: true })
  await until(health, (h) => !!h?.ok, 30_000)

  // ---- backups and restore ----
  sh(['/bin/sh', '-c', `mkdir -p '${BASE}/team/shared/한글 폴더' && printf 'plan v1\\n' > '${BASE}/team/shared/한글 폴더/plan.md' && head -c 3000000 /dev/urandom > '${BASE}/team/shared/big.bin'`], { user: SRV })
  const b1 = admin(['backup', '--scope', 'full'])
  const bm = (() => { try { return JSON.parse(b1.out) } catch { return null } })()
  check('backup (VACUUM INTO + team archive) as the server account', b1.code === 0 && bm?.scope === 'full' && bm?.team?.files === 2, b1.err.trim().slice(0, 200) || `${bm?.id} files=${bm?.team?.files}`)
  check('team archive is in team/.system/backups, server-only', statOf(`${BASE}/team/.system/backups`) === `${SRV}:${SRV} 700`, statOf(`${BASE}/team/.system/backups`))
  sh(['/bin/sh', '-c', `printf 'plan v2\\n' > '${BASE}/team/shared/한글 폴더/plan.md' && touch -t 203001010000 '${BASE}/team/shared/한글 폴더/plan.md' && rm '${BASE}/team/shared/big.bin'`], { user: SRV })
  const b2 = admin(['backup', '--scope', 'full'])
  const bm2 = (() => { try { return JSON.parse(b2.out) } catch { return null } })()
  check('incremental backup (manifest diff)', bm2?.scope === 'incremental' && bm2?.team?.files === 1 && bm2?.team?.deleted === 1, JSON.stringify(bm2?.team))
  const rt = admin(['restore-team', '--backup', bm?.id, '--to', `${BASE}/data/restore-test-team`])
  check('restore-team rebuilds the folder of the first backup', rt.code === 0 && sh(['/bin/cat', `${BASE}/data/restore-test-team/shared/한글 폴더/plan.md`], { user: SRV }).out === 'plan v1\n', rt.err.trim().slice(0, 200))
  const arc = admin(['archive', '--out', `${BASE}/data/test-archive.tar.zst.age`, '--password-stdin'], 'archive-pass-123\n')
  check('encrypted archive (DB + team folder, age)', arc.code === 0 && sh(['/usr/bin/head', '-c', '21', `${BASE}/data/test-archive.tar.zst.age`]).out === 'age-encryption.org/v1', arc.err.trim().slice(0, 200))
  const bad = admin(['restore-archive', '--in', `${BASE}/data/test-archive.tar.zst.age`, '--to', `${BASE}/data/restored-bad`, '--password-stdin'], 'wrong-password\n')
  check('restore-archive with a wrong password fails and leaves nothing', bad.code !== 0 && !fs.existsSync(`${BASE}/data/restored-bad`) && !fs.readdirSync(`${BASE}/data`).some((n) => n.startsWith('restored-bad')), bad.err.trim().slice(0, 120))
  const tampered = `${BASE}/data/tampered.age`
  const buf = fs.readFileSync(`${BASE}/data/test-archive.tar.zst.age`)
  buf[Math.floor(buf.length / 2)]! ^= 0xff
  fs.writeFileSync(tampered, buf); sh(['/usr/sbin/chown', `${SRV}:${SRV}`, tampered])
  const tam = admin(['restore-archive', '--in', tampered, '--to', `${BASE}/data/restored-tampered`, '--password-stdin'], 'archive-pass-123\n')
  check('restore-archive of a tampered file fails and leaves nothing', tam.code !== 0 && !fs.readdirSync(`${BASE}/data`).some((n) => n.startsWith('restored-tampered')), tam.err.trim().slice(0, 120))
  const good = admin(['restore-archive', '--in', `${BASE}/data/test-archive.tar.zst.age`, '--to', `${BASE}/data/restored`, '--password-stdin'], 'archive-pass-123\n')
  check('restore-archive with the password: DB + team folder', good.code === 0 && fs.readFileSync(`${BASE}/data/restored/team/shared/한글 폴더/plan.md`, 'utf8') === 'plan v2\n' && fs.existsSync(`${BASE}/data/restored/db/app.sqlite`), good.err.trim().slice(0, 200))
  const sr = admin(['stage-restore', '--backup', bm?.id])
  check('stage-restore (DB) as the server account', sr.code === 0, sr.err.trim().slice(0, 200))
  const pid = readJson(`${BASE}/status/status.json`)?.pid
  if (pid) sh(['/bin/kill', '-TERM', String(pid)])
  const rr = await until(() => readJson(`${BASE}/data/restore-result.json`), (r) => !!r, 30_000)
  check('DB restore applied at the next start', rr?.ok === true, JSON.stringify(rr))
  check('server healthy after the restore', !!(await until(health, (h) => !!h?.ok, 30_000))?.ok)
}

async function uninstall() {
  const env = { MYCEL_DELETE_TIMEOUT: '20' }
  const u1 = sh([path.join(REPO, 'scripts', 'uninstall-macos.sh'), '--id', ID, '--server-user', SRV, '--agent-user', AGT], { env })
  const onlyAccounts = (r: { code: number; out: string }) => r.code === 0 || (r.out.split('\n').filter((l) => /^\s{2}\S/.test(l)).every((l) => /^\s+user _/.test(l)))
  check('uninstall (keeping data) removes everything but the accounts', onlyAccounts(u1), (u1.out + u1.err).trim().replace(/\n/g, ' | '))
  check('kept data is now root-owned (no orphaned uid)', statOf(`${BASE}/team`).startsWith('root:wheel'), statOf(`${BASE}/team`))
  const u2 = sh([path.join(REPO, 'scripts', 'uninstall-macos.sh'), '--id', ID, '--server-user', SRV, '--agent-user', AGT, '--delete-data'], { env })
  check('uninstall --delete-data removes the data too', onlyAccounts(u2) && !fs.existsSync(BASE), (u2.out + u2.err).trim().replace(/\n/g, ' | '))
  // independent leftover scan
  const left: string[] = []
  for (const u of [SRV, AGT]) {
    if (sh(['/usr/bin/dscl', '.', '-read', `/Users/${u}`]).code === 0) {
      const rec = sh(['/usr/bin/dscl', '.', '-read', `/Users/${u}`, 'AuthenticationAuthority', 'UserShell']).out
      if (/DisabledUser/.test(rec) && /\/usr\/bin\/false/.test(rec)) blocked(`delete account ${u}`, 'macOS needs the logged-in administrator to approve deleting a user; the account is locked (no login, no shell). Delete while logged in: sudo dscl . -delete /Users/' + u)
      else left.push(`user ${u} (not locked)`)
    }
    if (sh(['/usr/bin/dscl', '.', '-read', `/Groups/${u}`]).code === 0) left.push(`group ${u}`)
  }
  for (const p of [BASE, `/Library/Logs/${ID}`, `/etc/newsyslog.d/${ID}.conf`, ...['server', 'launcher', 'pf'].map((d) => `/Library/LaunchDaemons/${LABEL}.${d}.plist`)]) if (fs.existsSync(p)) left.push(p)
  for (const d of ['server', 'launcher', 'pf']) if (sh(['/bin/launchctl', 'print', `system/${LABEL}.${d}`]).code === 0) left.push(`launchd ${LABEL}.${d}`)
  if (sh(['/sbin/pfctl', '-a', `com.apple/250.${ID}`, '-s', 'rules']).out.trim()) left.push('pf anchor rules')
  for (const f of ['/var/at/cron.deny', '/var/at/at.deny']) if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').split('\n').includes(AGT)) left.push(`${f}: ${AGT}`)
  check('leftover scan after uninstall', left.length === 0, left.join(', ') || 'nothing left')
}

const pfState = () => sh(['/sbin/pfctl', '-s', 'info']).out.match(/Status: (\w+)/)?.[1] ?? 'unknown'
// start clean (an earlier run kept with --keep, or aborted) before noting the pf state the uninstall must restore
if (process.getuid?.() === 0 && (fs.existsSync(BASE) || fs.existsSync(`/Library/LaunchDaemons/${LABEL}.server.plist`))) {
  sh([path.join(REPO, 'scripts', 'uninstall-macos.sh'), '--id', ID, '--server-user', SRV, '--agent-user', AGT, '--delete-data', '--keep-accounts'])
}
const pfBefore = process.getuid?.() === 0 ? pfState() : 'unknown'
let fatal: unknown = null
try { await main() } catch (e) { fatal = e; check('test run', false, (e as Error).stack) }
if (!KEEP) {
  try { await uninstall() } catch (e) { check('uninstall', false, (e as Error).message) }
  const pfAfter = pfState()
  check('pf is back to its state before the test (our reference released)', pfAfter === pfBefore, `before=${pfBefore} after=${pfAfter}`)
  fs.rmSync('/private/tmp/mycel-test-secret', { force: true })
  fs.rmSync(W, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.ok)
fs.writeFileSync(path.join('/private/tmp', `${ID}-install-report.json`), JSON.stringify({ at: new Date().toISOString(), results }, null, 1), { mode: 0o644 })
const blockedN = results.filter((r) => r.blocked).length
console.log(`\n${results.length - failed.length}/${results.length} checks passed (${blockedN} blocked on the owner)${failed.length ? `; failed: ${failed.map((f) => f.name).join('; ')}` : ''}`)
process.exit(failed.length || fatal ? 1 : 0)
