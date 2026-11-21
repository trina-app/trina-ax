// The safe write into a chat's work folder (server/src/devenv/work-write.ts writeIntoWork) on real srt: the real
// runner and srt with bwrap, no fake system. Runs INSIDE the image of tests/linux/Dockerfile.srt (tests/linux/srt-run.ts
// starts it after the sub-agent cases). Started as root it makes the server's base folder and runs itself again as the
// server account, as the team server does.
//   - a copy lands in the work folder through the box command, and the stage folder is read-only in that run;
//   - a link a command left in the work folder, at the destination's root or mid-path, to a team folder the run may not
//     write or to the server's data: the copy fails and nothing is written there; to the person's own folder (which the
//     run may write anyway): the copy may land there, and nowhere else;
//   - a folder on the way swapped for a link to the server's data, again and again while copies run: never a file there;
//   - a shared chat: what was copied in is recorded under its key and recorded again by a later command on that key.
import fs from 'node:fs'
import path from 'node:path'

const SRV = 'axserver'
const BASE = '/var/lib/mycel'
if (process.getuid?.() === 0) {
  fs.rmSync(BASE, { recursive: true, force: true })
  fs.mkdirSync(BASE, { recursive: true, mode: 0o750 })
  Bun.spawnSync(['chown', `${SRV}:${SRV}`, BASE])
  const p = Bun.spawnSync(['setpriv', `--reuid=${SRV}`, `--regid=${SRV}`, '--init-groups', '--', process.execPath, import.meta.path], {
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: `/home/${SRV}`, MYCEL_DEV_ENV: '1' }, stdout: 'inherit', stderr: 'inherit',
  })
  process.exit(p.exitCode ?? 1)
}

const { openDb } = await import('../../server/src/db')
const { createContext } = await import('../../server/src/context')
const { silentLogger } = await import('../../server/src/log')
const { seed } = await import('../lib/fixtures')
const { runCommand, setSrtSystem, spaceOf, workFolderAt } = await import('../../server/src/devenv/srt/runner')
const { directSystem } = await import('../../server/src/devenv/srt/system')
const { chatWork, devenvPaths } = await import('../../server/src/devenv/srt/config')
const { newConsent, saveTeamSetting, teamSetting } = await import('../../server/src/devenv/setting')
const { copiedInOf, writeIntoWork } = await import('../../server/src/devenv/work-write')
const { DEV_ENV_DEFAULT_LIMITS } = await import('@mycel/shared/api')
type SharedRun = import('../../server/src/devenv/srt/runner').SharedRun
type CopiedGroup = import('../../server/src/devenv/srt/copied-in').CopiedGroup

const CANARY = 'CANARY-ww-5d2c'
const TEAM = path.join(BASE, 'team'), DATA = path.join(BASE, 'data')
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
setSrtSystem(directSystem(), { base: BASE, id: 'mycel', plan: { format: 1, plan: 'team', maxRunning: 4, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'offline' } })

let failed = 0, count = 0
function report(id: string, what: string, why: string | null) { count++; if (why) failed++; console.log(`${why ? 'FAIL' : 'pass'} ${id} ${what}${why ? `\n     ${why.replace(/\n/g, ' ')}` : ''}`) }
const chat = () => `c${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
const personal = (chatId: string) => ({ userId: 'alice', chatId, project: null })
const HTML = { kind: 'file' as const, abs: path.join(TEAM, 'users/alice/proposal/proposal.html') }
const FOLDER = { kind: 'folder' as const, abs: path.join(TEAM, 'users/alice/proposal') }
/** every file under `dir` that holds the canary (what a copy wrote) */
const planted = (dir: string): string[] => {
  const out: string[] = []
  const walk = (d: string) => { let l: fs.Dirent[] = []; try { l = fs.readdirSync(d, { withFileTypes: true }) } catch { return } for (const e of l) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) try { if (fs.readFileSync(p, 'utf8').includes(CANARY)) out.push(p) } catch {} } }
  walk(dir)
  return out
}
const tryCopy = async (f: () => Promise<{ path: string }>) => { try { return { ok: true as const, path: (await f()).path } } catch (e) { return { ok: false as const, error: (e as Error).message } } }

// W1: a plain copy, file and folder
{
  const id = chat()
  const a = await tryCopy(() => writeIntoWork(ctx, personal(id), 'in/', HTML))
  const b = await tryCopy(() => writeIntoWork(ctx, personal(id), 'in/', FOLDER))
  const work = chatWork(BASE, id)
  report('W1', 'a file and a folder (HTML and its images) land in the work folder; the stage folder is gone afterwards',
    !a.ok ? a.error : !b.ok ? b.error : a.path !== 'in/proposal.html' || b.path !== 'in/proposal' ? `${a.path} ${b.path}`
      : !fs.existsSync(path.join(work, 'in/proposal/images/a.png')) ? 'the images folder is missing' : fs.readdirSync(devenvPaths(BASE).stage).length ? 'a stage folder is left' : null)
}

// W2: the stage folder is read-only in the run that gets it
{
  const id = chat()
  const space = spaceOf(ctx, personal(id))!
  const stage = path.join(devenvPaths(BASE).stage, 'stagetest0000001')
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(stage, 'item'), 'staged')
  const r = await runCommand(ctx, { space, cwd: '.', command: `cat ${stage}/item && echo; echo x > ${stage}/new 2>/dev/null && echo WROTE-STAGE; rm -f ${stage}/item 2>/dev/null && echo REMOVED-STAGE; ls ${devenvPaths(BASE).stage} 2>&1 | head -3; true`, timeoutMs: 30_000, stage })
  const out = r.ok ? r.value.stdout + r.value.stderr : r.message
  report('W2', 'the stage folder reads in the copy run and takes no write; no other stage folder shows', !r.ok ? out
    : !out.includes('staged') ? `not readable: ${out}` : /WROTE-STAGE|REMOVED-STAGE/.test(out) || fs.existsSync(path.join(stage, 'new')) || !fs.existsSync(path.join(stage, 'item')) ? `writable: ${out}` : null)
  fs.rmSync(stage, { recursive: true, force: true })
}

// W3: links a command left in the work folder
for (const [id, what, at, target, writable] of [
  ['W3a', 'a link at the destination\'s root to shared/ (read-only in the run)', 'in', path.join(TEAM, 'shared'), false],
  ['W3b', 'a link mid-path to the server\'s data folder (hidden in the run)', 'deep/mid', DATA, false],
  ['W3c', 'a link at the root to the base folder\'s devenv (hidden: the box writes into its empty mask, never the disk)', 'in', devenvPaths(BASE).root, null],
  ['W3d', 'a link to the person\'s own folder (the run may write it anyway): only there', 'in', path.join(TEAM, 'users/alice'), true],
] as const) {
  const c = chat()
  const space = spaceOf(ctx, personal(c))!
  fs.mkdirSync(path.join(space.root, path.dirname(at)), { recursive: true })
  fs.symlinkSync(target, path.join(space.root, at))
  const before = new Set(planted(target))
  let via: string | undefined
  const r = await tryCopy(async () => { const x = await writeIntoWork(ctx, personal(c), `${at}/x.html`, HTML); via = x.viaLink; return x })
  const after = planted(target).filter((p) => !before.has(p))
  const outside = [...planted(TEAM).filter((p) => !p.startsWith(path.join(TEAM, 'users/alice'))), ...planted(DATA), ...planted(path.join(BASE, 'devenv')).filter((p) => !p.startsWith(devenvPaths(BASE).work + '/'))]
  // writable null: the sandbox may let the box write into a mask (lost when the run ends); what counts is the disk
  report(id, what, outside.length || (writable !== true && after.length) ? `written outside: ${[...after, ...outside].join(' ')}`
    : writable === true && r.ok && !after.length ? 'landed nowhere though it said it did'
    : writable === false && r.ok ? `the copy said it landed (${r.path})`
    : r.ok && via !== at ? `the result does not name the link it went through (${via})` : null)
  if (r.ok && writable !== false) console.log(`     note: it went through the link '${via}'`)
  if (writable) for (const p of after) fs.rmSync(p, { force: true })
}

// W4: a folder on the way swapped for a link to the server's data, again and again while copies run
{
  const c = chat()
  const space = spaceOf(ctx, personal(c))!
  const swap = path.join(space.root, 'race')
  let stop = false
  const swapper = (async () => {
    while (!stop) {
      try { fs.rmSync(swap, { recursive: true, force: true }); fs.mkdirSync(swap) } catch {}
      await Bun.sleep(1)
      try { fs.rmSync(swap, { recursive: true, force: true }); fs.symlinkSync(DATA, swap) } catch {}
      await Bun.sleep(1)
    }
  })()
  let landed = 0
  for (let i = 0; i < 20; i++) if ((await tryCopy(() => writeIntoWork(ctx, personal(c), 'race/x.html', HTML))).ok) landed++
  stop = true; await swapper
  const leak = planted(DATA)
  report('W4', 'a folder on the way swapped for a link to the data folder during 20 copies: never a file there', leak.length ? `written to the data folder: ${leak.join(' ')}` : null)
  console.log(`     note: ${landed} of 20 copies landed in the work folder, the others failed while the folder was a link`)
}

// W5: a shared chat: recorded under its key, recorded again by a later command on the key
{
  const c = chat()
  const noted: CopiedGroup[][] = []
  const shared: SharedRun = { within: null, audience: () => ['alice', 'bob'], noteReads: () => true, noteCopied: (g) => { noted.push([...g]); return true } }
  const target = { userId: 'alice', chatId: c, project: null, shared }
  const r = await tryCopy(() => writeIntoWork(ctx, target, 'in/', FOLDER, { sources: [{ type: 'user', id: 'alice' }] }))
  const wf = workFolderAt(ctx, target)
  const firstNoted = noted.length
  noted.length = 0
  const later = wf ? await runCommand(ctx, { space: spaceOf(ctx, target)!, cwd: '.', command: 'ls in/proposal', timeoutMs: 30_000 }) : null
  report('W5', 'a shared chat\'s copy is recorded under its key and again by a later command there', !r.ok ? r.error : !wf ? 'no work folder'
    : copiedInOf(c, wf.path).length !== 1 ? 'not recorded' : firstNoted !== 1 ? 'the copy run did not record it' : !later?.ok || !later.value.stdout.includes('images') ? `the later command: ${JSON.stringify(later)}`.slice(0, 300) : noted.length !== 1 ? 'the later command did not record it again' : null)
}

console.log(failed ? `\n${failed} of ${count} work-folder write cases failed` : `\nall ${count} work-folder write cases held`)
await ctx.close()
process.exit(failed ? 1 : 0)
