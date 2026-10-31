// Old version folders on a Linux server, in Docker (debian:13): the server account stages four versions with the real
// updater (UpdateManager.stage + switchTo) and the real bootstrap (native/cmd/mycel-bootstrap, Linux build) confirms
// each one; then `admin.js prune-versions` (dry run and real run) and the prune rule with day-old folders, as the
// server account, next to root-owned leftovers and planted links; then roll-back to `previous` and the bootstrap's
// own way back (a current version that no longer verifies) still work after the prune. server/src/system/prune.ts.
//
//   bun tests/linux/prune-versions.ts           build the Linux bootstrap (go; or native/bin/linux-<arch>), fetch the
//                                               pinned Linux bun (dist/cache), run the container, print a report; exit
//                                               1 when a check failed. CI: the linux-docker job (ci.yml). Needs
//                                               `bun install` (the container uses this checkout's node_modules) and a
//                                               checkout Docker can mount (on a Mac with Colima: under $HOME)
//   --in-container / --as-server STEP           the two halves inside the container (root, then the server account)
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64'
const BASE = '/var/lib/prune-test'
const APP = `${BASE}/app`
const SRV = 'axprune'
const PORT = 19191
const BUN = '/opt/bun/bun'
const BOOT = '/opt/boot/mycel-bootstrap'
const DAY = 86_400_000
/** app/versions/<this> is a tmpfs (docker run --tmpfs): looks like an old version folder, but is a mount point */
const MOUNTED = '0.8.0'
/** app/versions/<this> is a plain old version-named folder with a tmpfs mounted inside it (web/data): /proc/self/mountinfo
 * keeps the prune out of the whole folder, not only out of the mount */
const HOLDS = '0.7.0'

// ---------------- host ----------------
async function host(): Promise<number> {
  const { cachedDownload, downloadFor, extractMember, LINUX_DOWNLOADS } = await import('../../scripts/linux/downloads')
  // under the checkout (tests/.work, ignored): a folder Docker Desktop shares on a Mac
  fs.mkdirSync(path.join(ROOT, 'tests', '.work'), { recursive: true })
  const work = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'tests', '.work', 'prune-docker-')))
  try {
    const zipName = downloadFor('bun', ARCH)
    const zip = await cachedDownload(zipName)
    extractMember(zip, LINUX_DOWNLOADS[zipName]!.member!, path.join(work, 'bun'), path.join(work, 'scratch'))
    fs.chmodSync(path.join(work, 'bun'), 0o755)
    const prebuilt = path.join(ROOT, 'native', 'bin', `linux-${ARCH}`, 'mycel-bootstrap')
    if (fs.existsSync(prebuilt)) fs.copyFileSync(prebuilt, path.join(work, 'mycel-bootstrap'))
    else {
      const g = Bun.spawnSync(['go', 'build', '-trimpath', '-o', path.join(work, 'mycel-bootstrap'), './cmd/mycel-bootstrap'], { cwd: path.join(ROOT, 'native'), env: { ...process.env, GOOS: 'linux', GOARCH: ARCH, CGO_ENABLED: '0' }, stderr: 'pipe' })
      if (g.exitCode) { console.error(`go build failed: ${g.stderr}`); return 1 }
    }
    // a tmpfs mounted at a version-named folder: another file system, never removed (no --privileged needed for it)
    const r = Bun.spawnSync(['docker', 'run', '--rm', '-v', `${ROOT}:/src:ro`, '-v', `${work}/bun:${BUN}:ro`, '-v', `${work}/mycel-bootstrap:${BOOT}:ro`,
      '--tmpfs', `${APP}/versions/${MOUNTED}:mode=755`, '--tmpfs', `${APP}/versions/${HOLDS}/web/data:mode=755`, 'debian:13', BUN, '/src/tests/linux/prune-versions.ts', '--in-container'], { stdout: 'pipe', stderr: 'pipe' })
    const out = r.stdout.toString()
    process.stdout.write(out)
    if (r.exitCode) process.stderr.write(r.stderr.toString().slice(-3000))
    return r.exitCode === 0 && out.includes('PRUNE_RESULT ok') ? 0 : 1
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

// ---------------- container, as root ----------------
type Check = { name: string; ok: boolean; detail?: string }
const checks: Check[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  checks.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 800)}` : ''}`)
}
function run(cmd: string[], o: { user?: string; env?: Record<string, string> } = {}) {
  const full = o.user ? ['runuser', '-u', o.user, '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', `HOME=${BASE}/data`, `TMPDIR=${BASE}/data/tmp`, ...Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`), ...cmd] : cmd
  const p = Bun.spawnSync(full, { stdout: 'pipe', stderr: 'pipe', cwd: '/' })
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() }
}
/** one step of the server account's half; its JSON answer */
function asServer(step: string, arg: unknown = null): any {
  const r = run([BUN, '/src/tests/linux/prune-versions.ts', '--as-server', step, JSON.stringify(arg)], { user: SRV })
  const line = r.out.split('\n').find((l) => l.startsWith('STEP '))
  if (r.code !== 0 || !line) throw new Error(`step ${step} failed (${r.code}): ${(r.out + r.err).slice(-1500)}`)
  return JSON.parse(line.slice(5))
}
const state = () => JSON.parse(fs.readFileSync(`${APP}/state.json`, 'utf8'))
const health = async () => { try { return (await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()) as { ok: boolean; version: string } } catch { return null } }
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (ok(v) || Date.now() > end) return v; await Bun.sleep(200) }
}
const versions = () => fs.readdirSync(`${APP}/versions`).filter((n) => n !== MOUNTED && n !== HOLDS).sort()

async function container(): Promise<number> {
  const { packBundle } = await import('../../server/src/system/bundle')
  const { writeManifest } = await import('../../server/src/system/bundle')
  // accounts and folders as the Linux installer makes them: app/ and app/versions the server account's (755)
  run(['useradd', '--system', '-U', '-M', '-d', '/nonexistent', '-s', '/usr/sbin/nologin', SRV])
  for (const [d, mode] of [[BASE, 0o755], [APP, 0o755], [`${APP}/versions`, 0o755], [`${APP}/engines`, 0o750], [`${BASE}/data`, 0o700], [`${BASE}/data/tmp`, 0o700], [`${BASE}/team`, 0o700], [`${BASE}/config`, 0o755], [`${BASE}/bundles`, 0o755]] as const) {
    fs.mkdirSync(d, { recursive: true }); fs.chmodSync(d, mode)
  }
  for (const d of [APP, `${APP}/versions`, `${APP}/engines`, `${BASE}/data`, `${BASE}/data/tmp`, `${BASE}/team`]) run(['chown', `${SRV}:${SRV}`, d])
  fs.writeFileSync(`${BASE}/config/server.json`, JSON.stringify({ listen: { host: '127.0.0.1', port: PORT }, dataDir: `${BASE}/data`, teamRoot: `${BASE}/team` }))

  // four release bundles (bin/bun -> the container's bun, a server that answers /api/health with its version)
  for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) {
    const src = fs.mkdtempSync('/tmp/bundle-')
    fs.mkdirSync(`${src}/bin`); fs.mkdirSync(`${src}/server/src`, { recursive: true }); fs.mkdirSync(`${src}/web/assets`, { recursive: true })
    fs.writeFileSync(`${src}/bin/bun`, `#!/bin/sh\nexec ${BUN} "$@"\n`, { mode: 0o755 })
    fs.writeFileSync(`${src}/server/src/main.js`, `
const cfg = JSON.parse(require('fs').readFileSync(process.env.MYCEL_CONFIG, 'utf8'))
const parent = process.ppid
setInterval(() => { try { process.kill(parent, 0) } catch { process.exit(0) } }, 500)
Bun.serve({ hostname: '127.0.0.1', port: cfg.listen.port, fetch(req) {
  if (new URL(req.url).pathname === '/exit') { setTimeout(() => process.exit(0), 30); return new Response('bye') }
  return Response.json({ ok: true, version: ${JSON.stringify(v)} })
} })
process.on('SIGTERM', () => process.exit(0))
`)
    // some weight, so sizes and removal are real (2 MB per version)
    fs.writeFileSync(`${src}/web/assets/app-${v}.js`, Buffer.alloc(2 << 20, v.charCodeAt(2)))
    await writeManifest(src, v)
    await packBundle(src, `${BASE}/bundles/${v}.tar.zst`)
    fs.rmSync(src, { recursive: true, force: true })
  }

  // 1.0.0 as the installer brings it in; then the bootstrap runs, as the server account
  asServer('stage', '1.0.0')
  fs.symlinkSync('versions/1.0.0', `${APP}/current`); run(['chown', '-h', `${SRV}:${SRV}`, `${APP}/current`])
  asServer('init-state', '1.0.0')
  const boot = Bun.spawn(['runuser', '-u', SRV, '--', BOOT, '--app', APP, '--config', `${BASE}/config/server.json`, '--allow-unsigned', '--health-timeout', '8s'], { stdout: 'ignore', stderr: 'pipe', cwd: '/' })
  try {
    check('the bootstrap starts 1.0.0', (await until(health, (h) => h?.version === '1.0.0'))?.version === '1.0.0')
    // three updates the way the server makes them: stage (verify, rename), switch (pending + app/current), restart
    for (const [from, to] of [['1.0.0', '1.1.0'], ['1.1.0', '1.2.0'], ['1.2.0', '1.3.0']] as const) {
      asServer('update', { running: from, to })
      await fetch(`http://127.0.0.1:${PORT}/exit`).catch(() => {})
      await until(state, (s) => s.pending === null && s.current === to)
      check(`update ${from} -> ${to} confirmed by the bootstrap`, (await until(health, (h) => h?.version === to))?.version === to && state().previous === from, state())
    }
    check('four version folders staged', JSON.stringify(versions()) === JSON.stringify(['1.0.0', '1.1.0', '1.2.0', '1.3.0']), versions())

    // what else is found on servers: a staging folder an update left, root's copy in progress, planted links, engines
    asServer('leftovers')
    fs.mkdirSync(`${APP}/versions/1.4.0.partial/server`, { recursive: true }) // mycel-ctl update copying as root
    fs.writeFileSync(`${APP}/versions/1.4.0.partial/server/main.js`, 'x')
    fs.mkdirSync('/root-only'); fs.writeFileSync('/root-only/secret', 'root')
    fs.symlinkSync('/root-only', `${APP}/versions/0.9.0`)
    // the mount point is the server account's, so only the file-system check keeps the prune out of it
    fs.writeFileSync(`${APP}/versions/${MOUNTED}/keep`, 'mounted'); run(['chown', '-R', `${SRV}:${SRV}`, `${APP}/versions/${MOUNTED}`])
    fs.mkdirSync(`${APP}/versions/${HOLDS}/server`); fs.writeFileSync(`${APP}/versions/${HOLDS}/server/main.js`, 'old')
    fs.writeFileSync(`${APP}/versions/${HOLDS}/web/data/keep`, 'mounted'); run(['chown', '-R', `${SRV}:${SRV}`, `${APP}/versions/${HOLDS}`])

    // admin.js prune-versions with the real clock: everything was staged minutes ago, so nothing is old enough yet
    const env = { MYCEL_MODE: 'prod', MYCEL_CONFIG: `${BASE}/config/server.json`, MYCEL_INSTALL_BASE: BASE }
    const cli = (args: string[]) => { const r = run([BUN, '/src/server/src/system/cli.ts', 'prune-versions', ...args], { user: SRV, env }); try { return { code: r.code, j: JSON.parse(r.out) } } catch { return { code: r.code, j: null, raw: r.out + r.err } } }
    const dry = cli(['--dry-run'])
    check('admin.js prune-versions --dry-run answers JSON', dry.code === 0 && dry.j?.dryRun === true && dry.j?.skipped === null, dry)
    check('right after staging nothing is removed (one-day grace)', dry.j?.removed?.length === 0 && dry.j?.kept?.map((k: { version: string }) => k.version).join() === '1.0.0,1.1.0,1.2.0,1.3.0', dry.j)
    check('the dry run is not recorded', !fs.existsSync(`${BASE}/data/prune-versions.json`))
    const real = cli([])
    check('admin.js prune-versions runs and records its result', real.code === 0 && real.j?.removed?.length === 0 && fs.existsSync(`${BASE}/data/prune-versions.json`), real)

    // the rule a day later (now + 2 days), as the server account: dry run, then the real run
    const later = asServer('prune', { running: '1.3.0', dryRun: true })
    check('dry run a day later lists the old versions, the old staging folder, the old engine', JSON.stringify(later.removed.map((r: { path: string }) => r.path).sort())
      === JSON.stringify(['engines/claude/aaaaaaaaaaaa', 'versions/.staging-0123456789ab', 'versions/1.0.0', 'versions/1.1.0']), later)
    check('the dry run already says root\'s copy cannot be removed by the server account', JSON.stringify(later.errors.map((e: { path: string }) => e.path)) === JSON.stringify(['versions/1.4.0.partial'])
      && /owned by another account/.test(later.errors[0]?.error ?? ''), later.errors)
    check('the dry run removed nothing', versions().length === 7 && fs.existsSync(`${APP}/engines/claude/aaaaaaaaaaaa`), versions())
    const r = asServer('prune', { running: '1.3.0' })
    check('kept: current 1.3.0 and previous 1.2.0', JSON.stringify(r.kept.map((k: { version: string; why: string[] }) => [k.version, k.why])) === JSON.stringify([['1.2.0', ['previous']], ['1.3.0', ['current', 'running', 'state-current']]]), r.kept)
    check('removed: 1.0.0, 1.1.0, the old staging folder and engine', JSON.stringify(r.removed.map((x: { path: string }) => x.path).sort()) === JSON.stringify(['engines/claude/aaaaaaaaaaaa', 'versions/.staging-0123456789ab', 'versions/1.0.0', 'versions/1.1.0']), r.removed)
    check('removed bytes counted (2 MB per version and more)', r.removedBytes > 4 << 20, r.removedBytes)
    check('root\'s copy is reported, not removed (the server account cannot)', r.errors.length === 1 && r.errors[0].path === 'versions/1.4.0.partial' && fs.existsSync(`${APP}/versions/1.4.0.partial/server/main.js`), r.errors)
    check('a mount point named like a version is never removed', fs.readFileSync(`${APP}/versions/${MOUNTED}/keep`, 'utf8') === 'mounted'
      && r.left.some((x: { path: string; why: string }) => x.path === `versions/${MOUNTED}` && /mount point/.test(x.why)), r.left)
    check('a folder holding a mount point is left whole (mountinfo), not emptied up to the mount', fs.readFileSync(`${APP}/versions/${HOLDS}/server/main.js`, 'utf8') === 'old'
      && fs.readFileSync(`${APP}/versions/${HOLDS}/web/data/keep`, 'utf8') === 'mounted'
      && r.left.some((x: { path: string; why: string }) => x.path === `versions/${HOLDS}` && x.why === 'holds a mount point: never removed'), r.left)
    check('no .prune-* left behind by the removals', !fs.readdirSync(`${APP}/versions`).some((n) => n.startsWith('.prune-')) && !fs.readdirSync(`${APP}/engines/claude`).some((n) => n.startsWith('.prune-')))
    check('the planted link stays and its target is untouched', fs.lstatSync(`${APP}/versions/0.9.0`).isSymbolicLink() && fs.readFileSync('/root-only/secret', 'utf8') === 'root' && r.left.some((x: { path: string }) => x.path === 'versions/0.9.0'), r.left)
    check('a link inside a removed version was not followed', fs.readFileSync(`${BASE}/data/keep/file`, 'utf8') === 'keep')
    check('the current engine stays', fs.existsSync(`${APP}/engines/claude/bbbbbbbbbbbb/claude`) && fs.readlinkSync(`${APP}/engines/claude/current`) === 'bbbbbbbbbbbb')
    check('versions left: the link, 1.2.0, 1.3.0, root\'s copy', JSON.stringify(versions()) === JSON.stringify(['0.9.0', '1.2.0', '1.3.0', '1.4.0.partial']), versions())
    check('the server still answers as 1.3.0', (await health())?.version === '1.3.0')

    // roll back to previous after the prune: Admin's "Roll back" (switch + restart), confirmed by the bootstrap
    asServer('rollback', { running: '1.3.0' })
    await fetch(`http://127.0.0.1:${PORT}/exit`).catch(() => {})
    await until(state, (s) => s.pending === null && s.current === '1.2.0')
    check('roll back 1.3.0 -> 1.2.0 works after the prune', (await until(health, (h) => h?.version === '1.2.0'))?.version === '1.2.0' && state().previous === '1.3.0', state())
    const again = asServer('prune', { running: '1.2.0' })
    check('after the roll-back both stay (1.3.0 is now previous)', again.removed.length === 0 && JSON.stringify(versions()) === JSON.stringify(['0.9.0', '1.2.0', '1.3.0', '1.4.0.partial']), again)

    // the bootstrap's own way back: the current version's files changed, so it starts previous instead
    fs.appendFileSync(`${APP}/versions/1.2.0/server/src/main.js`, '\n// changed')
    await fetch(`http://127.0.0.1:${PORT}/exit`).catch(() => {})
    const back = await until(health, (h) => h?.version === '1.3.0')
    check('the bootstrap falls back to the kept previous version when current does not verify', back?.version === '1.3.0' && /verify failed/.test(state().history.at(-1)?.detail ?? ''), state().history.at(-1))
  } finally {
    boot.kill('SIGTERM')
    await Promise.race([boot.exited, Bun.sleep(5000)])
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`PRUNE_RESULT ${failed.length ? 'fail' : 'ok'} ${checks.length - failed.length}/${checks.length}`)
  return failed.length ? 1 : 0
}

// ---------------- container, as the server account ----------------
async function server(step: string, arg: any): Promise<unknown> {
  const { UpdateManager } = await import('../../server/src/system/update')
  const { pruneVersions } = await import('../../server/src/system/prune')
  const { planInstallState } = await import('../../server/src/system/install-plan')
  const { silentLogger } = await import('../../server/src/log')
  const mgr = (running: string) => new UpdateManager({ appDir: APP, dataDir: `${BASE}/data`, version: running, channel: 'stable', feedUrl: null, log: silentLogger, allowUnsigned: true })
  switch (step) {
    case 'stage': return (await mgr('0.0.0').stage(`${BASE}/bundles/${arg}.tar.zst`)).version
    case 'init-state': {
      const p = planInstallState({ current: null, version: arg, state: null })
      fs.writeFileSync(`${APP}/state.json`, JSON.stringify(p.state), { mode: 0o640 })
      return p.action
    }
    case 'update': {
      await mgr(arg.running).stage(`${BASE}/bundles/${arg.to}.tar.zst`)
      return mgr(arg.running).switchTo(arg.to)
    }
    case 'rollback': return mgr(arg.running).rollBack()
    case 'leftovers': {
      fs.mkdirSync(`${APP}/versions/.staging-0123456789ab/server`, { recursive: true })
      fs.writeFileSync(`${APP}/versions/.staging-0123456789ab/server/main.js`, 'half')
      fs.mkdirSync(`${BASE}/data/keep`); fs.writeFileSync(`${BASE}/data/keep/file`, 'keep')
      fs.symlinkSync(`${BASE}/data/keep`, `${APP}/versions/1.0.0/web/keep`)
      for (const sha of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']) {
        fs.mkdirSync(`${APP}/engines/claude/${sha}`, { recursive: true, mode: 0o750 })
        fs.writeFileSync(`${APP}/engines/claude/${sha}/claude`, `engine ${sha}`, { mode: 0o750 })
      }
      fs.symlinkSync('bbbbbbbbbbbb', `${APP}/engines/claude/current`)
      return true
    }
    case 'prune': return pruneVersions({ appDir: APP, running: arg.running, dataDir: `${BASE}/data`, dryRun: !!arg.dryRun, now: () => new Date(Date.now() + 2 * DAY) })
  }
  throw new Error(`unknown step ${step}`)
}

if (import.meta.main) {
  const a = process.argv.slice(2)
  if (a[0] === '--as-server') {
    server(a[1]!, JSON.parse(a[2] ?? 'null')).then((v) => { console.log(`STEP ${JSON.stringify(v)}`); process.exit(0) }, (e) => { console.error(e); process.exit(1) })
  } else if (a[0] === '--in-container') {
    container().then((c) => process.exit(c), (e) => { console.error(e); console.log('PRUNE_RESULT fail'); process.exit(1) })
  } else {
    host().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1) })
  }
}
