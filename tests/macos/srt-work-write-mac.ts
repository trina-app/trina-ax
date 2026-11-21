// The safe write into a chat's work folder (server/src/devenv/work-write.ts) on macOS with the real srt Seatbelt
// profile: writeIntoWork, the real runner and the darwin settings (srtSettings), and srt's CLI run directly as this
// account (no dev slot account: that part is tests/macos/srt-attack-mac.ts on a test install). It checks what the
// sandbox decides for the copy: the stage folder is read-only, and a link a command left in the work folder cannot lead
// the copy into a folder the run may not write. Needs srt 0.0.81 (scripts/dev-env/srt/package-lock.json) installed in
// a folder of its own and node 22.12 or later:
//   (cd <dir> && cp <repo>/scripts/dev-env/srt/package*.json . && npm ci --ignore-scripts --omit=dev)
//   WW_TMP=/private/tmp MYCEL_DEV_ENV=1 SRT_CLI=<dir>/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js bun tests/macos/srt-work-write-mac.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SrtSystem } from '../../server/src/devenv/srt/system'

if (process.platform !== 'darwin') { console.error('macOS only'); process.exit(2) }
const CLI = process.env.SRT_CLI ?? ''
const NODE = process.env.SRT_NODE ?? 'node'
if (!CLI || !fs.existsSync(CLI)) { console.error('set SRT_CLI to srt\'s dist/cli.js'); process.exit(2) }

const { openDb } = await import('../../server/src/db')
const { createContext } = await import('../../server/src/context')
const { silentLogger } = await import('../../server/src/log')
const { seed } = await import('../lib/fixtures')
const { runCommand, setSrtSystem, spaceOf } = await import('../../server/src/devenv/srt/runner')
const { devenvPaths } = await import('../../server/src/devenv/srt/config')
const { newConsent, saveTeamSetting, teamSetting } = await import('../../server/src/devenv/setting')
const { writeIntoWork } = await import('../../server/src/devenv/work-write')
const { DEV_ENV_DEFAULT_LIMITS } = await import('@mycel/shared/api')

// a short folder (WW_TMP=/private/tmp): srt makes unix sockets in the run's TMPDIR, and macOS's temp folder is too long
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(process.env.WW_TMP ?? os.tmpdir(), 'wwm-')))
const CANARY = 'CANARY-wwmac-71b0'
const TEAM = path.join(BASE, 'team'), DATA = path.join(BASE, 'data')
fs.mkdirSync(DATA, { recursive: true })
const cfg = {
  mode: 'prod' as const, configFile: path.join(BASE, 'config', 'server.json'), listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
  teamRoot: TEAM, dataDir: DATA, logDir: null, logLevel: 'error' as const,
  engine: { authMode: 'managed' as const, runDir: path.join(BASE, 'run') }, relay: { url: null, teamName: null }, update: { channel: 'stable' as const, feedUrl: null },
  validateResponses: false, setupToken: null,
}
fs.mkdirSync(path.join(BASE, 'config'), { recursive: true })
fs.writeFileSync(cfg.configFile, '{}')
const ctx = createContext({ config: cfg as never, db: openDb(path.join(DATA, 'app.db')), log: silentLogger })
seed(ctx.db)
const w = (rel: string, text: string) => { const f = path.join(TEAM, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
w('users/alice/proposal/proposal.html', `<img src="images/a.png"> ${CANARY}`)
w('users/alice/proposal/images/a.png', 'PNG')
w('shared/s.md', 'shared text\n')
fs.writeFileSync(path.join(DATA, 'secret.key'), 'data secret')
saveTeamSetting(ctx.db, { ...teamSetting(ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'offline', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })

// srt's CLI as this account, with the run's settings file, cwd and environment (what run-wrap-mac does as a slot)
const live = new Map<string, number>()
const direct: SrtSystem = {
  spawn(s) {
    const out = fs.openSync(s.stdoutFile, 'a'), err = s.stderrFile === s.stdoutFile ? out : fs.openSync(s.stderrFile, 'a')
    try {
      const p = Bun.spawn([NODE, CLI, '--settings', s.settingsFile, '-c', s.command], { cwd: s.cwd, env: { ...s.env, PATH: `${path.dirname(Bun.which(NODE) ?? '/usr/bin/node')}:/usr/bin:/bin` }, stdin: 'ignore', stdout: out, stderr: err })
      live.set(s.runId, p.pid)
      return { pid: p.pid, exited: p.exited.then((code) => { live.delete(s.runId); fs.writeFileSync(s.exitFile, `${code}\n`); return { code, signal: null } }) }
    } finally { fs.closeSync(out); if (err !== out) fs.closeSync(err) }
  },
  async stop(runId) { const p = live.get(runId); if (p) try { process.kill(p, 'SIGKILL') } catch {} },
  async unit(runId) { return live.has(runId) ? { state: 'active', result: '', memoryBytes: null } : { state: '', result: '', memoryBytes: null } },
  async units() { return [] }, async forget() {}, oomKills() { return null }, cpuUsec() { return null }, procs() { return [] }, async selfTest() { return '' },
}
setSrtSystem(direct, { base: BASE, id: 'mycel', plan: { format: 1, plan: 'team', maxRunning: 4, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'offline' }, platform: 'darwin' })

let failed = 0, count = 0
function report(id: string, what: string, why: string | null) { count++; if (why) failed++; console.log(`${why ? 'FAIL' : 'pass'} ${id} ${what}${why ? `\n     ${why.replace(/\n/g, ' ')}` : ''}`) }
const chat = () => `c${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
const personal = (chatId: string) => ({ userId: 'alice', chatId, project: null })
const HTML = { kind: 'file' as const, abs: path.join(TEAM, 'users/alice/proposal/proposal.html') }
const FOLDER = { kind: 'folder' as const, abs: path.join(TEAM, 'users/alice/proposal') }
const planted = (dir: string): string[] => {
  const out: string[] = []
  const walk = (d: string) => { let l: fs.Dirent[] = []; try { l = fs.readdirSync(d, { withFileTypes: true }) } catch { return } for (const e of l) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) try { if (fs.readFileSync(p, 'utf8').includes(CANARY)) out.push(p) } catch {} } }
  walk(dir)
  return out
}
const tryCopy = async (f: () => Promise<{ path: string }>) => { try { return { ok: true as const, path: (await f()).path } } catch (e) { return { ok: false as const, error: (e as Error).message } } }

try {
  {
    const id = chat()
    const a = await tryCopy(() => writeIntoWork(ctx, personal(id), 'in/', HTML))
    const b = await tryCopy(() => writeIntoWork(ctx, personal(id), 'in/', FOLDER))
    report('M1', 'a file and a folder land in the work folder through srt', !a.ok ? a.error : !b.ok ? b.error : a.path !== 'in/proposal.html' || b.path !== 'in/proposal' ? `${a.path} ${b.path}` : null)
  }
  {
    const space = spaceOf(ctx, personal(chat()))!
    const stage = path.join(devenvPaths(BASE).stage, 'stagetest0000001')
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(stage, 'item'), 'staged')
    const r = await runCommand(ctx, { space, cwd: '.', command: `cat ${stage}/item && echo; echo x > ${stage}/new 2>/dev/null && echo WROTE-STAGE; rm -f ${stage}/item 2>/dev/null && echo REMOVED-STAGE; true`, timeoutMs: 30_000, stage })
    const out = r.ok ? r.value.stdout + r.value.stderr : r.message
    report('M2', 'the stage folder reads in the copy run and takes no write', !r.ok ? out : !out.includes('staged') ? `not readable: ${out}` : /WROTE-STAGE|REMOVED-STAGE/.test(out) || !fs.existsSync(path.join(stage, 'item')) ? `writable: ${out}` : null)
    fs.rmSync(stage, { recursive: true, force: true })
  }
  for (const [id, what, at, target] of [
    ['M3a', 'a link at the destination\'s root to shared/ (not writable in the run)', 'in', path.join(TEAM, 'shared')],
    ['M3b', 'a link mid-path to the server\'s data folder (hidden)', 'deep/mid', DATA],
  ] as const) {
    const c = chat()
    const space = spaceOf(ctx, personal(c))!
    fs.mkdirSync(path.join(space.root, path.dirname(at)), { recursive: true })
    fs.symlinkSync(target, path.join(space.root, at))
    const r = await tryCopy(() => writeIntoWork(ctx, personal(c), `${at}/x.html`, HTML))
    const leak = planted(target)
    report(id, what, r.ok ? `the copy said it landed (${r.path})` : leak.length ? `written there: ${leak.join(' ')}` : null)
    if (!r.ok) console.log(`     note: ${r.error.slice(0, 200)}`)
  }
} finally {
  console.log(failed ? `\n${failed} of ${count} macOS work-folder write cases failed` : `\nall ${count} macOS work-folder write cases held`)
  await ctx.close()
  fs.rmSync(BASE, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
