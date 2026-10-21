// Install test for macOS (component G, design tab 7 "설치": install -> run -> update -> roll back -> back up / restore
// -> uninstall). Installs a TEST copy (id mycel-test, accounts _axtsrv / _axtagt, ports 19174-19178) with a FAKE engine
// (tests/lib/g-sbprobe.c) and, when this Mac has Claude Code, the real `claude` binary as the server's engine.
// Codex in production uses a fake Codex CLI (tests/lib/g-fake-codex.c) installed as --engine codex=...: the
// codex-login admin command (device auth through the launcher and the model proxy), a Codex chat turn as the engine
// account (login copy, CONNECT tunnel allow-list, no direct internet, login folder and config.toml out of reach,
// refreshed login written back), the admin engine status (beta) and codex-logout.
//
//   bun run build:native            (as yourself)
//   sudo bun tests/install/g-macos-install.ts [--keep]      (MYCEL_TEST_CLAUDE=<path> picks the claude binary)
//
// Verifies accounts, owners and modes, LaunchDaemons, the pf firewall (as the engine account), the sandbox through the
// installed launcher, engine names (claude -> engine.claudeBin, codex -> engine.codexBin), the office TLS certificate
// (every LAN address, served on the TLS port), the account tool (root/mycel-account: create-owner, list-owners, a
// reset link that works), subscription mode (engine.authMode "subscription" in server.json, root/set-claude-token
// stores the owner token for the server account only, the model proxy as the server account, and one real Claude Code
// turn as the engine account through sandbox + pf + proxy against a FAKE model service on 127.0.0.1:19178 that checks
// the owner token arrives and the per-turn token never leaves; no request goes to Anthropic), Codex as the engine
// account (fake Codex CLI), update swap / bootstrap roll-back / manual roll-back, re-running the installer with a
// newer bundle (switch, previous kept) and with a crashing one (rolled back, installer exits 1), backup + encrypted
// archive + restore, an uninstall that keeps the data followed by a reinstall on it, and that the uninstaller removes
// everything. Prints a report and exits 1 if any check failed. Never asks for or stores a password: run it with sudo.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { API, ApiClient } from '@mycel/shared/api'
import { buildBundle } from '../../scripts/build-bundle'
import { packBundle, writeManifest } from '../../server/src/system/bundle'
import { certNames, missingNames, wantedNames } from '../../server/src/system/lan-cert'

const REPO = path.resolve(import.meta.dir, '..', '..')
// account names can be overridden (MYCEL_TEST_SRV / MYCEL_TEST_AGT) when a record from an earlier run cannot be
// deleted unattended (macOS asks the logged-in administrator to approve user deletions)
const ID = 'mycel-test', SRV = process.env.MYCEL_TEST_SRV ?? '_axtsrv', AGT = process.env.MYCEL_TEST_AGT ?? '_axtagt'
const PORT = 19174, TLS = 19175, PROXY = 19176, DECOY = 19177, UPSTREAM = 19178
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
function sh(cmd: string[], o: { input?: string; env?: Record<string, string>; user?: string; cwd?: string } = {}) {
  const full = o.user ? ['/usr/bin/sudo', '-n', '-u', o.user, ...(o.env ? ['/usr/bin/env', ...Object.entries(o.env).map(([k, v]) => `${k}=${v}`)] : []), ...cmd] : cmd
  const p = Bun.spawnSync(full, { stdin: o.input !== undefined ? Buffer.from(o.input) : 'ignore', stdout: 'pipe', stderr: 'pipe', env: o.user ? { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } : { ...process.env, ...(o.env ?? {}) }, cwd: o.cwd ?? '/' })
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
/** the real Claude Code binary of the person running sudo (copied into the test install as its engine) */
function findClaude(): string | null {
  const cands = [process.env.MYCEL_TEST_CLAUDE, process.env.SUDO_USER ? `/Users/${process.env.SUDO_USER}/.local/bin/claude` : undefined]
  for (const c of cands) { if (!c) continue; try { const r = fs.realpathSync(c); if (fs.statSync(r).isFile()) return r } catch {} }
  return null
}
const CLAUDE = findClaude()
/** the account tool as the Mac administrator (root): it drops to the server account itself */
const account = (args: string[], input?: string) => sh([`${BASE}/root/mycel-account`, ...args], { input })
const installerIn = (o: { cwd?: string; env?: Record<string, string> }, rel: string, ...extra: string[]) => sh([path.join(REPO, 'scripts', 'install-macos.sh'), '--from', path.join(W, rel), '--id', ID, '--server-user', SRV, '--agent-user', AGT,
  '--port', String(PORT), '--tls-port', String(TLS), '--proxy-port', String(PROXY), '--allow-unsigned', '--no-power', '--skip-tmutil', ...extra], o)
const installer = (rel: string, ...extra: string[]) => installerIn({}, rel, ...extra)
const OWNER_PW = 'install test owner pw 1'
/** the team owner the API checks sign in as: the subscription and Codex checks run after the account tool made "kim"
 * and reset that password with a one-time link */
const OWNER = { username: 'kim', password: 'recovered by the admin 1' }
async function ownerApi(base: string) {
  const anon = new ApiClient({ baseUrl: base })
  if ((await anon.call(API.setupStatus)).needed) {
    const code = fs.readFileSync(`${BASE}/setup/code`, 'utf8').trim()
    await anon.call(API.setup, { body: { setupToken: code, teamName: 'Install test', locale: 'en', owner: { username: OWNER.username, name: 'Owner', password: OWNER.password } } })
  }
  const login = await anon.call(API.login, { body: { username: OWNER.username, password: OWNER.password, client: 'web', tokenMode: 'bearer' } })
  return new ApiClient({ baseUrl: base, token: login.token! })
}

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
  // for re-running the installer itself with newer bundles: a good one and one that crashes at start
  await buildBundle({ version: '0.9.0-test.4', out: path.join(W, 'rel4') })
  const v5 = await buildBundle({ version: '0.9.0-test.5', out: path.join(W, 'rel5') })
  fs.writeFileSync(path.join(v5.dir, 'server', 'src', 'main.js'), 'process.exit(3)\n')
  await writeManifest(v5.dir, '0.9.0-test.5')
  // fake engines (the probe) under both engine names; the real CLIs need the owner's subscription login
  const probe = path.join(W, 'fake-engine')
  if (sh(['cc', '-O2', '-o', probe, path.join(REPO, 'tests', 'lib', 'g-sbprobe.c')]).code !== 0) throw new Error('cc failed')
  fs.mkdirSync(path.join(W, 'codex-bin'), { recursive: true })
  const fakeCodex = path.join(W, 'codex-bin', 'codex')
  if (sh(['cc', '-O2', '-o', fakeCodex, path.join(REPO, 'tests', 'lib', 'g-fake-codex.c')]).code !== 0) throw new Error('cc g-fake-codex failed')
  // a models cache like the one Codex fetches: the installer locks it into model_catalog.json (no shell for any model)
  const modelsCache = path.join(W, 'models_cache.json')
  fs.writeFileSync(modelsCache, JSON.stringify({ fetched_at: 'test', models: [{ slug: 'gpt-test', display_name: 'GPT Test', shell_type: 'unified_exec', tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform', visibility: 'list' }] }))
  const lp = await Bun.build({ entrypoints: [path.join(import.meta.dir, 'g-launcher-probe.ts')], target: 'bun', outdir: W, naming: 'launcher-probe.js' })
  if (!lp.success) throw new Error('bundling the launcher probe failed')
  for (const f of fs.readdirSync(W)) fs.chmodSync(path.join(W, f), fs.statSync(path.join(W, f)).isDirectory() ? 0o755 : 0o755)
  sh(['/bin/chmod', '-R', 'a+rX', W])
  fs.writeFileSync('/private/tmp/mycel-test-secret', 'left in /tmp by a person\n', { mode: 0o644 })

  // ---- install ----
  const badName = installer('rel1', '--engine', `fake=${probe}`)
  check('installer refuses an engine name other than claude / codex, before changing anything', badName.code !== 0 && /unknown engine "fake"/.test(badName.err) && !fs.existsSync(BASE), badName.err.trim())
  const inst = sh([path.join(REPO, 'scripts', 'install-macos.sh'), '--from', path.join(W, 'rel1'), '--id', ID, '--server-user', SRV, '--agent-user', AGT,
    '--port', String(PORT), '--tls-port', String(TLS), '--proxy-port', String(PROXY), '--engine', `claude=${probe}`, '--engine', `codex=${fakeCodex}`, '--codex-models', modelsCache, '--allow-unsigned', '--no-power'])
  check('install script', inst.code === 0, (inst.out + inst.err).trim().split('\n').slice(-3).join(' | '))
  if (inst.code !== 0) return
  check('root/VERSION names the bundle the root programs came from', fs.readFileSync(`${BASE}/root/VERSION`, 'utf8').trim() === '0.9.0-test.1' && statOf(`${BASE}/root/VERSION`) === 'root:wheel 644', statOf(`${BASE}/root/VERSION`))

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
    [`${BASE}/root/set-claude-token`, 'root:wheel 755'], [`${BASE}/root/safe-fs.sh`, 'root:wheel 644'],
    [`/Library/Logs/${ID}/crash`, 'root:wheel 755'], [`/Library/Logs/${ID}/server`, `${SRV}:admin 750`], [`${BASE}/app/state.json`, `${SRV}:${SRV} 640`],
    [`/Library/LaunchDaemons/${LABEL}.server.plist`, 'root:wheel 644'], [`/Library/LaunchDaemons/${LABEL}.launcher.plist`, 'root:wheel 644'],
    [`/Library/LaunchDaemons/${LABEL}.pf.plist`, 'root:wheel 644'], [`/etc/newsyslog.d/${ID}.conf`, 'root:wheel 644'],
    [`${BASE}/agent/codex-auth`, `${AGT}:${AGT} 700`],
    [`${BASE}/root/mycel-account`, 'root:wheel 755'], [`${BASE}/secrets/lan-tls.crt`, `${SRV}:${SRV} 644`],
    [`${BASE}/app/engines/claude/current/claude`, `${SRV}:${AGT} 750`], [`${BASE}/app/engines/codex/current/codex`, `${SRV}:${AGT} 750`],
  ]
  for (const [p, w] of want) check(`owner/mode ${p.replace(BASE, '<base>')}`, statOf(p) === w, `${statOf(p)} (want ${w})`)

  // ---- engines: each name to its own key, files named after the engine, both allowed by the launcher ----
  const cfg0 = readJson(`${BASE}/config/server.json`)
  check('config: engine.claudeBin and engine.codexBin are the installed engines', cfg0?.engine?.claudeBin === `${BASE}/app/engines/claude/current/claude` && cfg0?.engine?.codexBin === `${BASE}/app/engines/codex/current/codex`, JSON.stringify(cfg0?.engine))
  const lplist = fs.readFileSync(`/Library/LaunchDaemons/${LABEL}.launcher.plist`, 'utf8')
  check('launcher allows exactly the two installed engines', lplist.includes(`${BASE}/app/engines/claude/current/claude`) && lplist.includes(`${BASE}/app/engines/codex/current/codex`) && (lplist.match(/--allow-cmd/g) ?? []).length === 2)
  check('config: the office TLS certificate is managed by the server', cfg0?.tls?.managed === true && cfg0?.tls?.port === TLS, JSON.stringify(cfg0?.tls))

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
  // packets once the connection exists, so a bare connect can succeed while nothing gets through). The model proxy
  // port is the server's real proxy (started with the engine core at boot): it answers "ping" with 400, which is data.
  await until(() => new Promise<boolean>((res) => { const c = net.connect(PROXY, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(true) }); c.on('error', () => res(false)) }), (v) => v, 30_000)
  // in a separate process: sh() is spawnSync, which would block echo servers living in this one
  const echoes = Bun.spawn([process.execPath, '-e', `const n = require('net'); const e = (c) => c.on('data', (d) => c.write(d)).on('error', () => {});
for (const [h, p] of [['127.0.0.1', ${DECOY}], ['::1', ${DECOY}]]) n.createServer(e).listen(p, h);
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
  const engine = `${BASE}/app/engines/claude/current/claude`
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
  // a Codex login copy left in a chat folder (launcher crashed mid Codex turn) is removed before another engine's turn
  sh(['/bin/sh', '-c', `mkdir -p '${BASE}/agent/c3/.codex' && echo '{"tokens":{"account_id":"a","refresh_token":"left-over"}}' > '${BASE}/agent/c3/.codex/auth.json'`], { user: AGT })
  check('launcher: a left-over Codex login copy is gone before a non-Codex turn in that chat', turn('c3', 'read', '{CHAT_DIR}/.codex/auth.json').code !== 0 && sh(['/bin/test', '-e', `${BASE}/agent/c3/.codex`], { user: AGT }).code !== 0)
  // nc, not the bun client: the launcher answers a refused peer and closes at once, which bun can report as
  // ECONNREFUSED before it reads the answer
  const ask = (user?: string) => sh(['/usr/bin/nc', '-U', `${BASE}/run-launcher/launcher.sock`], { input: '{"op":"run"}\n', user })
  const foreign = ask(AGT)
  check('the launcher refuses the engine account', /only the server may use the launcher/.test(foreign.out), (foreign.out + foreign.err).trim().slice(0, 160))
  const asRoot = ask()
  check('the launcher refuses root (only the server uid)', /only the server may use the launcher/.test(asRoot.out), (asRoot.out + asRoot.err).trim().slice(0, 160))
  echoes.kill()

  // ---- office TLS certificate: every LAN address + <LocalHostName>.local, the fingerprint the admin can read ----
  const crt = fs.readFileSync(`${BASE}/secrets/lan-tls.crt`)
  const miss = missingNames(crt, wantedNames())
  check('TLS certificate names <LocalHostName>.local, localhost, 127.0.0.1, ::1 and every LAN address of this Mac', miss.length === 0, miss.length ? `missing ${miss.join(', ')}` : certNames(crt).ips.join(' '))
  const fpFile = fs.readFileSync(`${BASE}/setup/lan-cert.sha256`, 'utf8').trim()
  check('setup/lan-cert.sha256 is the certificate\'s fingerprint', fpFile === certNames(crt).fingerprint, fpFile)
  const served = sh(['/bin/sh', '-c', `/usr/bin/openssl s_client -connect 127.0.0.1:${TLS} -servername localhost </dev/null 2>/dev/null | /usr/bin/openssl x509 -noout -fingerprint -sha256`]).out.replace(/.*=/, '').trim()
  check('the TLS port serves that certificate', served === fpFile, served)
  // a repair run keeps a certificate that still names everything (desktop apps pinned its fingerprint)
  const keepCert = installer('rel1')
  check('repair run without --engine keeps the installed engines and the certificate', keepCert.code === 0 && /keeping the one installed earlier/.test(keepCert.out) && fs.readFileSync(`${BASE}/setup/lan-cert.sha256`, 'utf8').trim() === fpFile, (keepCert.out + keepCert.err).trim().split('\n').slice(-2).join(' | '))
  await until(health, (h) => !!h?.ok, 30_000)

  // ---- account tool (root/mycel-account): what a Mac administrator runs to recover the owner, no email ----
  check('account tool: status before setup', /setup needed/.test(account(['status']).out))
  check('account tool: list-owners with no owner', /no owner yet/.test(account(['list-owners']).out))
  const co = account(['create-owner', '--username', 'kim', '--name', 'Kim', '--team', 'Install Test', '--locale', 'en'], OWNER_PW + '\n')
  check('account tool: create-owner (password on stdin)', co.code === 0 && /owner "kim" created/.test(co.out), (co.out + co.err).trim())
  check('account tool: create-owner refused once the team exists', /already set up/.test(account(['create-owner', '--username', 'lee', '--name', 'Lee', '--team', 'X'], OWNER_PW + '\n').err))
  check('account tool: list-owners', account(['list-owners']).out.trim() === 'kim\tKim\tactive', account(['list-owners']).out.trim())
  check('account tool ran as the server account (the database is still the server\'s)', ['app.db', 'app.db-wal'].filter((f) => fs.existsSync(`${BASE}/data/${f}`)).every((f) => statOf(`${BASE}/data/${f}`).startsWith(`${SRV}:`)), statOf(`${BASE}/data/app.db`))
  const rl = account(['reset-link'])
  const tok = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(rl.out)?.[1]
  check('account tool: reset-link prints a one-time link on this Mac', !!tok && rl.out.includes(`http://localhost:${PORT}/reset-password/`), rl.out.trim() || rl.err.trim())
  const api = (p: string, body: unknown) => fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1', origin: `http://127.0.0.1:${PORT}` }, body: JSON.stringify(body) })
  const reset = tok ? await api(`/api/password-resets/${tok}`, { newPassword: 'recovered by the admin 1' }) : null
  check('the reset link sets a new owner password', reset?.status === 200, String(reset?.status))
  check('the owner signs in with it', (await api('/api/auth/login', { username: 'kim', password: 'recovered by the admin 1' })).status === 200)
  check('the link works once', tok ? (await api(`/api/password-resets/${tok}`, { newPassword: 'another password 22' })).status !== 200 : false)
  const nobody = sh([`${BASE}/root/mycel-account`, 'reset-link'], { user: AGT })
  check('account tool refuses anyone but root (sudo)', nobody.code !== 0 && !/reset-password/.test(nobody.out), (nobody.out + nobody.err).trim().slice(0, 120))

  // ---- production chats (subscription mode, real Claude Code if this Mac has it) and Codex as the engine account ----
  await subscription(asAgent)
  await codexChecks()

  // ---- ops: connect-info, office-connection failure reports, Diagnostics while the launcher daemon is stopped ----
  await opsChecks()

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
    '--port', String(PORT), '--tls-port', String(TLS), '--proxy-port', String(PROXY), '--engine', `claude=${probe}`, '--allow-unsigned', '--no-power', '--skip-tmutil'])
  check('repair run with planted links and hard links', rep1.code === 0, (rep1.out + rep1.err).trim().split('\n').slice(-2).join(' | '))
  check('repair: a hard link the server made is not chowned by root', statOf(victim) === 'root:wheel 644', statOf(victim))
  check('repair: a planted state.json link is replaced, not followed', !fs.existsSync(`${victim}-new`) && statOf(`${BASE}/app/state.json`) === `${SRV}:${SRV} 640`, statOf(`${BASE}/app/state.json`))
  sh(['/bin/sh', '-c', `rm -rf '${BASE}/app/engines/claude' && ln -s /private/tmp '${BASE}/app/engines/claude'`], { user: SRV })
  const rep2 = sh([path.join(REPO, 'scripts', 'install-macos.sh'), '--from', path.join(W, 'rel1'), '--id', ID, '--server-user', SRV, '--agent-user', AGT,
    '--port', String(PORT), '--tls-port', String(TLS), '--proxy-port', String(PROXY), '--engine', `claude=${probe}`, '--allow-unsigned', '--no-power', '--skip-tmutil'])
  check('repair refuses a symbolic link on the way to a folder it chowns', rep2.code !== 0 && /symbolic link/.test(rep2.err) && statOf('/private/tmp') === 'root:wheel 1777', (rep2.err.trim().split('\n').at(-1) ?? '') + ' /tmp=' + statOf('/private/tmp'))
  sh(['/bin/rm', '-f', `${BASE}/app/engines/claude`])
  const rep3 = sh([path.join(REPO, 'scripts', 'install-macos.sh'), '--from', path.join(W, 'rel1'), '--id', ID, '--server-user', SRV, '--agent-user', AGT,
    '--port', String(PORT), '--tls-port', String(TLS), '--proxy-port', String(PROXY), '--engine', `claude=${probe}`, '--allow-unsigned', '--no-power', '--skip-tmutil'])
  check('repair run after the link is gone', rep3.code === 0, (rep3.out + rep3.err).trim().split('\n').slice(-2).join(' | '))
  fs.rmSync(victim, { force: true })
  await until(health, (h) => !!h?.ok, 30_000)
  check('repair with an OLDER bundle keeps the running version and says so', /older than the installed 0\.9\.0-test\.2/.test(rep3.err) && fs.readlinkSync(`${BASE}/app/current`) === 'versions/0.9.0-test.2', rep3.err.trim().split('\n').at(-1))

  // ---- re-running the installer with a newer bundle switches app/current; the previous version stays ----
  const up = installer('rel4')
  check('installer with a newer bundle: switches and waits for it', up.code === 0 && /switching 0\.9\.0-test\.2 -> 0\.9\.0-test\.4/.test(up.out) && /installed mycel-test 0\.9\.0-test\.4/.test(up.out), (up.out + up.err).trim().split('\n').slice(-2).join(' | '))
  check('newer bundle answers /api/health', (await until(health, (h) => h?.version === '0.9.0-test.4', 30_000))?.version === '0.9.0-test.4')
  const s4 = await until(() => readJson(`${BASE}/app/state.json`), (s) => s?.pending === null, 20_000)
  check('state.json after the installer switch: current test.4, previous test.2 (kept for Roll back)', s4?.current === '0.9.0-test.4' && s4?.previous === '0.9.0-test.2' && fs.existsSync(`${BASE}/app/versions/0.9.0-test.2/manifest.json`) && s4?.history?.at(-1)?.result === 'ok', JSON.stringify({ c: s4?.current, p: s4?.previous, h: s4?.history?.at(-1) }))
  const down = installer('rel5')
  check('installer with a newer bundle that crashes: the bootstrap goes back, the installer exits 1 and says so', down.code !== 0 && /0\.9\.0-test\.5 did not become healthy, so the server went back to 0\.9\.0-test\.4/.test(down.err), down.err.trim().split('\n').at(-1))
  check('after the failed switch test.4 answers and app/current points to it', (await until(health, (h) => h?.version === '0.9.0-test.4', 30_000))?.version === '0.9.0-test.4' && fs.readlinkSync(`${BASE}/app/current`) === 'versions/0.9.0-test.4')
  // run from a folder another account could write: bun must not read its bunfig.toml (preload) / .env, nor BUN_OPTIONS
  const hostile = path.join(W, 'hostile-cwd'), marker = '/private/tmp/mycel-test-preload-ran'
  fs.mkdirSync(hostile, { recursive: true, mode: 0o777 })
  fs.writeFileSync(path.join(hostile, 'bunfig.toml'), 'preload = ["./evil.js"]\n')
  fs.writeFileSync(path.join(hostile, 'evil.js'), `require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.getuid()))\n`)
  fs.rmSync(marker, { force: true })
  const same = installerIn({ cwd: hostile, env: { BUN_OPTIONS: `--preload ${path.join(hostile, 'evil.js')}` } }, 'rel4')
  check('installer with the same bundle again: repair, no switch', same.code === 0 && !/switching/.test(same.out), (same.out + same.err).trim().split('\n').slice(-1).join(''))
  check('installer run from a folder with a bunfig.toml preload and BUN_OPTIONS: root never runs it', !fs.existsSync(marker), fs.existsSync(marker) ? `preload ran as uid ${fs.readFileSync(marker, 'utf8')}` : '')
  fs.rmSync(marker, { force: true })
  // root programs only move forward: test.5 (the failed switch) installed them, so test.4 leaves them
  check('an older bundle leaves newer root programs (root/VERSION) in place and says so', fs.readFileSync(`${BASE}/root/VERSION`, 'utf8').trim() === '0.9.0-test.5' && /root programs .* stay at 0\.9\.0-test\.5/.test(same.err), fs.readFileSync(`${BASE}/root/VERSION`, 'utf8').trim() + ' | ' + same.err.trim().split('\n').at(-1))
  await until(health, (h) => h?.version === '0.9.0-test.4', 30_000)

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

// ---- subscription mode (production chats): owner token, model proxy, one real Claude Code turn as the engine account ----
async function subscription(asAgent: (...a: string[]) => boolean) {
  const cfgFile = `${BASE}/config/server.json`
  const cfg = readJson(cfgFile)
  check('server.json: engine.authMode "subscription" with the proxy port', cfg?.engine?.authMode === 'subscription' && cfg?.engine?.proxyPort === PROXY, JSON.stringify({ authMode: cfg?.engine?.authMode, proxyPort: cfg?.engine?.proxyPort }))
  const tokenPath = `${BASE}/secrets/claude-oauth-token`
  const OWNER_TOKEN = 'sk-ant-oat01-' + 'installtest'.repeat(6)
  const setTok = (input: string, ...a: string[]) => sh([`${BASE}/root/set-claude-token`, ...a], { input })
  const bad = setTok('not a token\n')
  check('set-claude-token refuses what is not a setup-token, changes nothing', bad.code !== 0 && !fs.existsSync(tokenPath), bad.err.trim().slice(0, 160))
  check('set-claude-token refuses a token on the command line', setTok('', OWNER_TOKEN).code !== 0)
  // a hostile server account plants a link where the token goes: root must replace it, not write through it
  const victim = '/private/tmp/mycel-test-token-victim'
  fs.rmSync(victim, { force: true })
  sh(['/bin/ln', '-s', victim, tokenPath], { user: SRV })
  const ok = setTok(OWNER_TOKEN + '\n')
  check('set-claude-token stores the token for the server account (600)', ok.code === 0 && statOf(tokenPath) === `${SRV}:${SRV} 600`, (ok.out + ok.err).trim().slice(0, 160) + ' ' + statOf(tokenPath))
  check('set-claude-token replaced a planted link instead of writing through it', !fs.existsSync(victim) && !fs.lstatSync(tokenPath).isSymbolicLink())
  check('the engine account cannot read the owner token', !asAgent('read', tokenPath))
  if (!CLAUDE) { blocked('real Claude Code turn as the engine account', 'no claude binary found (set MYCEL_TEST_CLAUDE=<path to claude>)'); return }
  // the real Claude Code replaces the sandbox probe as engine.claudeBin (a same-version repair run; Codex stays)
  const swap = installer('rel1', '--engine', `claude=${CLAUDE}`)
  check('repair run with --engine claude=<real Claude Code>: installed, Codex kept', swap.code === 0 && /engine codex: keeping/.test(swap.out), (swap.out + swap.err).trim().split('\n').slice(-2).join(' | '))
  await until(health, (h) => !!h?.ok, 40_000)
  const cfgNow = readJson(cfgFile)

  // the fake model service (as root; pf only limits the engine account) and the server pointed at it
  const seen: { auth: string; leak: boolean; path: string }[] = []
  const enc = new TextEncoder()
  const ev = (type: string, o: Record<string, unknown>) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
  const upstream = Bun.serve({
    port: UPSTREAM, hostname: '127.0.0.1', idleTimeout: 0,
    async fetch(req) {
      const body = await req.text()
      const u = new URL(req.url)
      seen.push({ auth: req.headers.get('authorization') ?? '', leak: /mpx_/.test(JSON.stringify([...req.headers]) + body), path: u.pathname })
      if (req.headers.get('authorization') !== 'Bearer ' + OWNER_TOKEN) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'OAuth token has been revoked' } }, { status: 401 })
      if (u.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 42 })
      let j: { stream?: boolean; model?: string } = {}
      try { j = JSON.parse(body) } catch {}
      const model = j.model ?? 'claude-sonnet-4-5', text = 'Hello from the install test model.'
      const usage = { input_tokens: 200, output_tokens: 9 }
      if (!j.stream) return Response.json({ id: 'msg_t', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage })
      return new Response(new ReadableStream({ start(ctl) {
        ctl.enqueue(ev('message_start', { message: { id: 'msg_t', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
        ctl.enqueue(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
        ctl.enqueue(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }))
        ctl.enqueue(ev('content_block_stop', { index: 0 }))
        ctl.enqueue(ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }))
        ctl.enqueue(ev('message_stop', {}))
        ctl.close()
      } }), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfgNow, engine: { ...cfgNow.engine, modelUpstream: `http://127.0.0.1:${UPSTREAM}` } }, null, 2) + '\n')
    sh(['/usr/sbin/chown', `${SRV}:${SRV}`, cfgFile]); sh(['/bin/chmod', '600', cfgFile])
    const pid = readJson(`${BASE}/status/status.json`)?.pid
    if (pid) sh(['/bin/kill', '-TERM', String(pid)])
    await Bun.sleep(1500)
    check('server back after pointing it at the fake model service', !!(await until(health, (h) => !!h?.ok, 40_000))?.ok)

    const base = `http://127.0.0.1:${PORT}`
    const me = await ownerApi(base)
    const turnAnswer = async (content: string) => {
      const chat = await me.call(API.createChat, { body: {} })
      const r = await me.call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
      return until(async () => (await me.call(API.listMessages, { params: { id: chat.id } })).items.find((m) => m.id === r.assistantMessage.id), (m) => !!m && m.status !== 'streaming', 180_000)
    }
    const a = await turnAnswer('Say hello.')
    check('a real Claude Code turn as the engine account answers through the model proxy', a?.status === 'done' && a.content.includes('Hello from the install test model.'), JSON.stringify({ status: a?.status, content: a?.content?.slice(0, 80), error: a?.error }))
    check('the model service saw only the owner token (Bearer), never a per-turn token', seen.length > 0 && seen.every((x) => x.auth === 'Bearer ' + OWNER_TOKEN && !x.leak), JSON.stringify(seen.map((x) => [x.path, x.auth.slice(0, 18), x.leak])))
    const lsof = sh(['/usr/sbin/lsof', '-nP', `-iTCP@127.0.0.1:${PROXY}`, '-sTCP:LISTEN']).out
    check('the model proxy listens on 127.0.0.1 as the server account', lsof.split('\n').some((l) => l.includes(SRV.slice(0, 8))), lsof.trim().split('\n').slice(1).join(' | '))
    const diag = await me.call(API.diagnostics)
    const byId = (id: string) => diag.checks.find((c) => c.id === id)
    check('diagnostics: Claude Code signed in (setup-token), model proxy listening', byId('engine.claude-code')?.status === 'ok' && byId('model_proxy')?.status === 'ok', JSON.stringify([byId('engine.claude-code'), byId('model_proxy')]))

    // a finished turn's proxy token is revoked; a valid-looking token used by an engine-account process that is not
    // that turn's engine gets nothing upstream (the launcher's peer check, as the role account)
    const sql = (q: string) => sh([BUN, '-e', `const { Database } = require('bun:sqlite'); const db = new Database(${JSON.stringify(`${BASE}/data/app.db`)}); console.log(JSON.stringify(db.query(${JSON.stringify(q)}).all()))`], { user: SRV })
    const live = sql("SELECT COUNT(*) AS n FROM proxy_tokens p JOIN turns t ON t.id = p.turn_id WHERE p.revoked_at IS NULL AND t.status != 'running'")
    check('proxy tokens of finished turns are revoked', live.code === 0 && JSON.parse(live.out)[0]?.n === 0, (live.out + live.err).trim().slice(0, 160))
    const fake = 'mpx_' + crypto.randomBytes(32).toString('base64url')
    const fakeHash = crypto.createHash('sha256').update(fake).digest('hex')
    const ins = sql(`INSERT INTO proxy_tokens (token_hash, turn_id, user_id, expires_at) SELECT '${fakeHash}', id, user_id, '2999-01-01T00:00:00.000Z' FROM turns ORDER BY started_at DESC LIMIT 1 RETURNING turn_id`)
    const before = seen.length
    const stolenUse = sh(['/usr/bin/curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', `http://127.0.0.1:${PROXY}/v1/messages`, '-H', `authorization: Bearer ${fake}`, '-H', 'content-type: application/json',
      '-d', JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })], { user: AGT })
    check('engine account outside the turn: a turn token gets 403, nothing reaches the model service', ins.code === 0 && stolenUse.out.trim() === '403' && seen.length === before, JSON.stringify({ ins: (ins.out + ins.err).trim().slice(0, 80), status: stolenUse.out.trim(), err: stolenUse.err.trim().slice(0, 80), upstream: seen.length - before }))
    sql(`DELETE FROM proxy_tokens WHERE token_hash = '${fakeHash}'`)

    // a token the model service refuses (revoked): the answer says so and diagnostics turn red; the old one back
    const WRONG = 'sk-ant-oat01-' + 'revokedtoken'.repeat(5)
    setTok(WRONG + '\n')
    const b = await turnAnswer('Again.')
    check('a refused owner token ends the turn with the AI-connection error', b?.status === 'error' && b.error?.code === 'engine_unavailable', JSON.stringify({ status: b?.status, error: b?.error }))
    const diag2 = await me.call(API.diagnostics)
    check('diagnostics: the refused token shows as a failure', diag2.checks.find((c) => c.id === 'engine.claude-code')?.status === 'fail', JSON.stringify(diag2.checks.find((c) => c.id === 'engine.claude-code')))
    setTok(OWNER_TOKEN + '\n')
    const c = await turnAnswer('Once more.')
    check('storing a good token again works without a restart', c?.status === 'done', JSON.stringify({ status: c?.status, error: c?.error }))
  } finally {
    upstream.stop(true)
  }
}

// ---- Codex as the engine account (design tab 2 "Codex 네트워크", tab 3 codex_login) ----
async function codexChecks() {
  const cfgJson = readJson(`${BASE}/config/server.json`)
  const codexBin = `${BASE}/app/engines/codex/current/codex`
  check('server.json: engine.codexBin is the installed Codex and engine.proxyPort the pf port', cfgJson?.engine?.codexBin === codexBin && cfgJson?.engine?.proxyPort === PROXY, JSON.stringify({ codexBin: cfgJson?.engine?.codexBin, proxyPort: cfgJson?.engine?.proxyPort }))
  const real = sh(['/usr/bin/readlink', `${BASE}/app/engines/codex/current`]).out.trim()
  const catalog = `${BASE}/app/engines/codex/${real}/model_catalog.json`
  check('locked Codex catalog next to the engine (server-owned, engine group can read)', statOf(catalog) === `${SRV}:${AGT} 640`, statOf(catalog))
  const cat = readJson(catalog)
  check('catalog: every model has the shell off, direct tools, no apply_patch', !!cat && cat.models.every((m: any) => m.shell_type === 'disabled' && m.tool_mode === 'direct' && m.apply_patch_tool_type === null), JSON.stringify(cat?.models?.map((m: any) => [m.slug, m.shell_type, m.tool_mode])))
  const plist = fs.readFileSync(`/Library/LaunchDaemons/${LABEL}.launcher.plist`, 'utf8')
  check('launcher: --allow-cmd the installed Codex, --codex-auth-dir agent/codex-auth', plist.includes(`<string>${codexBin}</string>`) && plist.includes(`<string>${BASE}/agent/codex-auth</string>`))

  const st0 = admin(['codex-status'])
  check('admin codex-status before the login: not signed in (exit 3)', st0.code === 3 && JSON.parse(st0.out || '{}').loggedIn === false, (st0.out + st0.err).trim().slice(0, 200))
  const login = admin(['codex-login'])
  check('admin codex-login: prints the URL and the one-time code, ends signed in', login.code === 0 && login.out.includes('https://auth.openai.com/codex/device') && login.out.includes('TEST-INST1') && login.out.includes('signed in'), (login.out + login.err).trim().split('\n').slice(-4).join(' | '))
  check('the engine account\'s Codex login is agent/codex-auth/auth.json, engine account 600', statOf(`${BASE}/agent/codex-auth/auth.json`) === `${AGT}:${AGT} 600`, statOf(`${BASE}/agent/codex-auth/auth.json`))
  check('the server account cannot read the Codex login', sh(['/bin/cat', `${BASE}/agent/codex-auth/auth.json`], { user: SRV }).code !== 0)
  const st1 = admin(['codex-status'])
  check('admin codex-status after the login: signed in, no token in the output', st1.code === 0 && JSON.parse(st1.out || '{}').accountId === 'acc-install' && !/r-0|access/.test(st1.out), st1.out.trim())

  // a Codex chat turn as the engine account, through the API (the owner: Codex is beta in production)
  const base = `http://127.0.0.1:${PORT}`
  try {
    const api = await ownerApi(base)
    const eng = await api.call(API.engines)
    const cx = eng.engines.find((e) => e.id === 'codex')
    check('admin engines: Codex ok (engine account signed in), labelled beta, models from the locked catalog', cx?.status === 'ok' && cx?.beta === true && cx?.models.some((m) => m.id === 'gpt-test'), JSON.stringify({ status: cx?.status, beta: cx?.beta, detail: cx?.detail, models: cx?.models }))
    const chat = await api.call(API.createChat, { body: { engine: 'codex' } })
    const sent = await api.call(API.sendMessage, { params: { id: chat.id }, body: { content: 'hello codex', clientMessageId: 'cm-install-codex', attachmentIds: [] } })
    const done = await until(async () => (await api.call(API.listMessages, { params: { id: chat.id } })).items.find((m) => m.id === sent.assistantMessage.id), (m) => !!m && m.status !== 'streaming', 60_000)
    const text = done?.content ?? ''
    check('Codex turn as the engine account answers', done?.status === 'done' && text.startsWith('fakecodex'), JSON.stringify({ status: done?.status, error: done?.error, text }))
    check('Codex turn: the login copy was in its CODEX_HOME', text.includes('auth=ok'), text)
    check('Codex turn: tunnel to chatgpt.com:443 through the model proxy (200)', text.includes('tunnel=200'), text)
    check('Codex turn: tunnel to another host refused (403)', text.includes('other=403'), text)
    check('Codex turn: no direct internet (sandbox + pf)', text.includes('direct=blocked'), text)
    check('Codex turn: the login folder itself is out of reach', text.includes('authdir=blocked'), text)
    check('Codex turn: CODEX_HOME/config.toml cannot be written', text.includes('config=blocked'), text)
    const after = sh(['/bin/cat', `${BASE}/agent/codex-auth/auth.json`]).out
    check('Codex turn: the refreshed login (same account) was written back by the launcher', /"refresh_token":"r-\d{6,}"/.test(after) && after.includes('acc-install'), after.replace(/"(id|access)_token":"[^"]*"/g, '').slice(0, 160))
    check('Codex turn: nothing of the login stays in the chat folder', sh(['/bin/test', '-e', `${BASE}/agent/${chat.id}/.codex`], { user: AGT }).code !== 0)
  } catch (e) {
    check('Codex turn through the API', false, (e as Error).stack?.slice(0, 400))
  }
  const out = admin(['codex-logout'])
  check('admin codex-logout removes the login', out.code === 0 && !fs.existsSync(`${BASE}/agent/codex-auth/auth.json`) && admin(['codex-status']).code === 3, out.out.trim())
}

/** fp "AA:BB:..." / "aabb..." -> "AABB..." */
const normFp = (s: string | null | undefined) => (s ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()

async function opsChecks() {
  // the team exists by now (the account tool made the owner); sign in as that owner (web session cookie)
  const si = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1', origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ username: OWNER.username, password: OWNER.password }),
  }).catch(() => null)
  const cookie = (si?.headers.get('set-cookie') ?? '').split(';')[0]!
  check('ops checks: the owner signs in (web session)', si?.status === 200 && !!cookie, String(si?.status))
  const api = (p: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...init, headers: { cookie, 'x-mycel-csrf': '1', 'content-type': 'application/json' } })
  const getJson = async (p: string) => { try { const r = await api(p); return { status: r.status, body: (await r.json()) as any } } catch (e) { return { status: 0, body: String(e) } } }

  // connect-info: what the desktop app pins is the certificate the office port really serves
  const ci = await getJson('/api/connect-info')
  const fpFile = (() => { try { return fs.readFileSync(`${BASE}/setup/lan-cert.sha256`, 'utf8').trim() } catch { return '' } })()
  check('connect-info: fingerprint = the installed office certificate, port = the TLS port', ci.status === 200 && normFp(ci.body.lanCertSha256) === normFp(fpFile) && ci.body.lanPort === TLS, JSON.stringify(ci.body).slice(0, 300))
  const served = sh(['/bin/sh', '-c', `echo | /usr/bin/openssl s_client -connect 127.0.0.1:${TLS} 2>/dev/null | /usr/bin/openssl x509 -noout -fingerprint -sha256`]).out
  check('connect-info: the TLS port serves the announced certificate', !!ci.body?.lanCertSha256 && normFp(served.replace(/^.*=/, '')) === normFp(ci.body.lanCertSha256), served.trim())
  check('connect-info: LAN hosts are the Bonjour name and private IPv4 addresses', Array.isArray(ci.body?.lanHosts) && ci.body.lanHosts.every((h: string) => /\.local$|^(10|172|192)\./.test(h)), JSON.stringify(ci.body?.lanHosts))
  const lf = await api('/api/connect-info/lan-failure', { method: 'POST', body: JSON.stringify({ code: 'unreachable' }) }).catch(() => null)
  const d0 = await getJson('/api/admin/diagnostics')
  check('lan-failure report shows in Diagnostics', lf?.status === 204 && d0.body?.checks?.find((c: any) => c.id === 'lan_direct')?.status === 'warn', JSON.stringify(d0.body?.checks?.find((c: any) => c.id === 'lan_direct')))
  // exactly one launcher check (a running launcher used to get a second, failing one beside "Connected")
  const launcherChecks = (d: { body?: any }) => (d.body?.checks ?? []).filter((c: any) => c.id === 'launcher') as { status: string; detail: string }[]
  check('Diagnostics: launcher connected (one check), socket paths fit', launcherChecks(d0).map((c) => c.status).join() === 'ok' && d0.body?.checks?.find((c: any) => c.id === 'sockets')?.status === 'ok', JSON.stringify(d0.body?.checks?.filter((c: any) => ['launcher', 'sockets'].includes(c.id))))

  // the launcher daemon stopped: Diagnostics must answer "not running" and the server must keep running
  const before = await health()
  const up0 = ((await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()) as { uptimeSec: number }).uptimeSec
  const stop = sh(['/bin/launchctl', 'bootout', `system/${LABEL}.launcher`])
  check('launcher daemon stopped for the test', stop.code === 0 || /No such process/.test(stop.err), stop.err.trim())
  await Bun.sleep(1500)
  for (let i = 0; i < 3; i++) {
    const d = await getJson('/api/admin/diagnostics')
    const l = d.body?.checks?.find((c: any) => c.id === 'launcher')
    if (i === 0) check('Diagnostics with the launcher stopped: "not running" and the command that starts it', d.status === 200 && l?.status === 'fail' && String(l?.detail).includes(`launchctl kickstart -k system/${LABEL}.launcher`) && String(l?.detail).includes(`launchctl bootstrap system /Library/LaunchDaemons/${LABEL}.launcher.plist`) && String(l?.detail).includes(`/Library/Logs/${ID}/crash/launcher.log`), JSON.stringify(l))
  }
  // a chat turn would connect to the launcher too: the server must survive that as well (SocketLauncher)
  await Bun.sleep(1000)
  const h = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json() as Promise<{ uptimeSec: number; version: string }>).catch(() => null)
  check('the server kept running (no restart: uptime grew)', !!before && !!h && h.uptimeSec >= up0, `before=${up0}s after=${h?.uptimeSec}s`)
  const start = sh(['/bin/launchctl', 'bootstrap', 'system', `/Library/LaunchDaemons/${LABEL}.launcher.plist`])
  check('launcher daemon started again', start.code === 0, start.err.trim())
  const back = await until(() => getJson('/api/admin/diagnostics'), (d) => launcherChecks(d).map((c) => c.status).join() === 'ok', 30_000)
  check('Diagnostics: launcher connected again (one check)', launcherChecks(back).map((c) => c.status).join() === 'ok', JSON.stringify(launcherChecks(back)))
}

async function uninstall() {
  const env = { MYCEL_DELETE_TIMEOUT: '20' }
  const u1 = sh([path.join(REPO, 'scripts', 'uninstall-macos.sh'), '--id', ID, '--server-user', SRV, '--agent-user', AGT], { env })
  const onlyAccounts = (r: { code: number; out: string }) => r.code === 0 || (r.out.split('\n').filter((l) => /^\s{2}\S/.test(l)).every((l) => /^\s+user _/.test(l)))
  check('uninstall (keeping data) removes everything but the accounts', onlyAccounts(u1), (u1.out + u1.err).trim().replace(/\n/g, ' | '))
  check('kept data is now root-owned (no orphaned uid)', statOf(`${BASE}/team`).startsWith('root:wheel'), statOf(`${BASE}/team`))
  // ---- reinstall on the kept data: the server account gets it back and the team is still there ----
  const re = installer('rel4', '--engine', `claude=${path.join(W, 'fake-engine')}`)
  check('reinstall on data kept by the uninstaller', re.code === 0 && /gave the kept data\/ folder back/.test(re.out), (re.out + re.err).trim().split('\n').slice(-2).join(' | '))
  check('kept database and team folder belong to the server account again', statOf(`${BASE}/data/app.db`).startsWith(`${SRV}:`) && statOf(`${BASE}/team/shared`).startsWith(`${SRV}:`), `${statOf(`${BASE}/data/app.db`)} ${statOf(`${BASE}/team/shared`)}`)
  check('the reinstalled server answers', (await until(health, (h) => h?.version === '0.9.0-test.4', 60_000))?.ok === true)
  check('the team survived (the owner made with the account tool is there)', /^kim\t/.test(account(['list-owners']).out), account(['list-owners']).out.trim() || account(['list-owners']).err.trim())
  check('no new setup code for a team that is already set up', !fs.existsSync(`${BASE}/setup/code`))
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
