// Documents on an office Mac (docs/decisions/20261124-office-mac-doc-kit.md): the document kit's checks, the
// documents profile's srt settings (work folder only, no network, the kit read-only), the office SrtSystem's argv and
// limits, LibreOffice's render profile, the supervisor's environment and the kit's place in the package list. The
// escape checks on a real install are QA TC-8712 to TC-8714.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { devenvPaths, runEnv, settingsProblems, srtSettings } from '../../server/src/devenv/srt/config'
import { docKit, kitPaths, resetDocKitCache } from '../../server/src/devenv/kit'
import { RUN_TAG, descendants, endRunProcesses, officeArgv, officeSystem, parseOwnPs, reaped } from '../../server/src/devenv/srt/system-office'
import { spawn } from 'node:child_process'
import { devEnvUi, documentsOnlyServer } from '../../server/src/devenv/setting'
import { OFFICE_PIPE_RE, sandboxProfile } from '../../server/src/tools/isolate'
import { officeDocKitEnv } from '../../server/src/office/cli'
import { linuxList, listProblems, readList } from '../../scripts/system/packages'

setDefaultTimeout(60_000)
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const REPO = path.join(import.meta.dir, '..', '..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dockit-')))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** a fake kit with the layout doc-kit.sh writes */
function fakeKit(root: string) {
  const k = kitPaths(root)
  for (const d of [k.app + '/Contents/MacOS', k.pythonBin, path.dirname(k.node), path.dirname(k.srtCli), k.nodeLibs, k.fonts]) fs.mkdirSync(d, { recursive: true, mode: 0o755 })
  for (const f of [k.soffice, path.join(k.pythonBin, 'python3'), k.node, k.srtCli]) fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(k.fonts, 'NotoSansCJK-VF.otf.ttc'), 'x', { mode: 0o644 })
  fs.writeFileSync(path.join(root, '.key'), 'abc\n', { mode: 0o644 })
  for (const d of [path.dirname(root), root]) fs.chmodSync(d, 0o755)
  return k
}

describe('the document kit (devenv/kit.ts)', () => {
  const prefix = path.join(tmp, 'TeamAX'), root = path.join(prefix, 'kit', 'k1')
  fakeKit(root)
  fs.symlinkSync('k1', path.join(prefix, 'kit', 'current'))
  const env = { MYCEL_DOC_KIT: path.join(prefix, 'kit', 'current') }

  test('a complete kit of this account is found through current, on a Mac only', () => {
    resetDocKitCache()
    expect(docKit(env, { platform: 'darwin', fresh: true })?.root).toBe(root)
    expect(docKit(env, { platform: 'linux', fresh: true })).toBeNull()
    expect(docKit({}, { platform: 'darwin', fresh: true })).toBeNull()
    expect(docKit({ MYCEL_DOC_KIT: 'kit/current' }, { platform: 'darwin', fresh: true })).toBeNull()
  })
  test('a kit another account could change is not used (the AI\'s code and LibreOffice run from it)', () => {
    fs.chmodSync(kitPaths(root).nodeLibs, 0o777)
    expect(docKit(env, { platform: 'darwin', fresh: true })).toBeNull()
    fs.chmodSync(kitPaths(root).nodeLibs, 0o755)
    fs.chmodSync(path.join(prefix, 'kit'), 0o775)
    expect(docKit(env, { platform: 'darwin', fresh: true })).toBeNull()
    fs.chmodSync(path.join(prefix, 'kit'), 0o755)
    expect(docKit(env, { platform: 'darwin', fresh: true, uid: 12345 })).toBeNull()
    expect(docKit(env, { platform: 'darwin', fresh: true })?.root).toBe(root)
  })
  test('an unfinished kit (no .key, no fonts) is not used', () => {
    const r2 = path.join(prefix, 'kit', 'k2'); fakeKit(r2); fs.rmSync(path.join(r2, '.key'))
    expect(docKit({ MYCEL_DOC_KIT: r2 }, { platform: 'darwin', fresh: true })).toBeNull()
  })
})

describe('the documents profile', () => {
  test('a documents-only server (the office Mac) only with the dev environment flag; it shows no full dev environment', () => {
    expect(documentsOnlyServer({ MYCEL_DEV_ENV: '1', MYCEL_DEV_ENV_DOCUMENTS_ONLY: '1' })).toBe(true)
    expect(documentsOnlyServer({ MYCEL_DEV_ENV_DOCUMENTS_ONLY: '1' })).toBe(false)
    expect(devEnvUi({ MYCEL_DEV_ENV: '1', MYCEL_DEV_ENV_DOCUMENTS_ONLY: '1' })).toBe(false)
    expect(devEnvUi({ MYCEL_DEV_ENV: '1' })).toBe(true)
  })
  // an office install: base <home>/data, team <home>/team, the kit <home>/kit/<key>
  const HOME = '/Users/owner/TeamAX', BASE = `${HOME}/data`, TEAM = `${HOME}/team`, KIT = `${HOME}/kit/0123456789abcdef`
  const work = path.join(devenvPaths(BASE).work, 'alice', 'chat1')
  const input = { base: BASE, id: 'mycel', teamRoot: TEAM, userId: 'alice', view: { read: [], write: [], denyRead: [], denyWrite: [] }, start: null, work, network: 'offline' as const,
    extraDomains: [], denyHosts: [], denyAddrs: [], platform: 'darwin' as const, kit: KIT }

  test('a run reads the kit and writes only the work folder and its home; no site, the home folder hidden', () => {
    const s = srtSettings(input)
    expect(s.filesystem.allowRead).toContain(KIT)
    expect(s.filesystem.allowWrite.sort()).toEqual([path.join(devenvPaths(BASE).home, 'alice'), work].sort())
    expect(s.filesystem.allowRead.some((r) => r.startsWith(TEAM))).toBe(false)
    expect(s.filesystem.denyRead).toContain('/Users')
    expect(s.filesystem.denyRead).toContain(BASE)
    expect(s.network.allowedDomains).toEqual([])
    expect(s.network.allowLocalBinding).toBe(false)
    expect(settingsProblems(s, input)).toEqual([])
  })
  test('a kit inside the team folder or around the base folder is never given to a run', () => {
    for (const kit of [`${TEAM}/kit`, HOME, '/']) expect(srtSettings({ ...input, kit }).filesystem.allowRead).not.toContain(kit)
  })
  test('a writable kit is refused', () => {
    const s = srtSettings(input)
    s.filesystem.allowWrite.push(KIT)
    expect(settingsProblems(s, input).join()).toContain('the document kit is writable')
  })
  test('the run\'s Python, node and Node libraries are the kit\'s, and the document skills are named', () => {
    const k = kitPaths(KIT)
    const e = runEnv({ base: BASE, userId: 'alice', teamRoot: TEAM, work, platform: 'darwin', kit: k })
    expect(e.PATH!.split(':').slice(0, 3)).toEqual([devenvPaths(BASE).bin, path.dirname(k.node), k.pythonBin])
    expect(e.NODE_PATH).toBe(k.nodeLibs)
    expect(e.TRINA_WORK).toBe(work)
  })
})

describe('the office SrtSystem (srt/system-office.ts)', () => {
  test('argv: process count, CPU time and file limits by ulimit, then the kit\'s srt with the run\'s settings', () => {
    const a = officeArgv({ node: '/k/node/bin/node', srtCli: '/k/srt/cli.js' }, { settingsFile: '/s.json', command: 'echo hi', procs: 1100, cpuSec: 150 })
    expect(a.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    for (const l of ['ulimit -u 1100', 'ulimit -t 150', 'ulimit -f 4194304', 'ulimit -c 0']) expect(a[2]).toContain(l)
    expect(a.slice(4)).toEqual(['/k/node/bin/node', '/k/srt/cli.js', '--settings', '/s.json', '-c', reaped('echo hi')])
    // the command in a subshell, then the reaper, which acts only inside srt's sandbox (SANDBOX_RUNTIME=1)
    expect(reaped('echo hi')).toBe(`trap '[ "$SANDBOX_RUNTIME" = 1 ] && kill -KILL -1 2>/dev/null; exit 143' TERM\n(\necho hi\n)\nrc=$?\n[ -n "$TRINA_RC_FILE" ] && printf '%s' "$rc" > "$TRINA_RC_FILE" 2>/dev/null\n[ "$SANDBOX_RUNTIME" = 1 ] && kill -KILL -1 2>/dev/null\nexit $rc`)
    // outside a sandbox it is inert (the tests' fake srt below runs it so): the exit code is the command's
    const r = Bun.spawnSync(['/bin/sh', '-c', reaped('(exit 7)')], { env: { PATH: '/usr/bin:/bin' } })
    expect(r.exitCode).toBe(7)
    expect(() => officeArgv({ node: 'n', srtCli: 'c' }, { settingsFile: '/s', command: 'x', procs: 0, cpuSec: 1 })).toThrow()
  })
  test('ps lines: the run tag is read from the environment of this uid\'s processes', () => {
    const ps = parseOwnPs(`  10     1    10 /bin/sleep 100 PATH=/usr/bin ${RUN_TAG}=aaaaaaaaaaaaaaaa HOME=/x\n  11    10    10 /bin/sh -c x PATH=/usr/bin\n  12     1    10 /bin/sleep 5\n`)
    expect(ps).toEqual([{ pid: 10, ppid: 1, pgid: 10, tag: 'aaaaaaaaaaaaaaaa' }, { pid: 11, ppid: 10, pgid: 10, tag: null }, { pid: 12, ppid: 1, pgid: 10, tag: null }])
    // 12 lost its parent (a setsid'd group of 10): still a descendant by its group
    expect([...descendants(ps, [10])].sort()).toEqual([10, 11, 12])
  })
  test('ending a run\'s processes: tagged, noted or working in its folder, with descendants; never the server', () => {
    const procs = [{ pid: 20, ppid: 1, tag: 'bbbbbbbbbbbbbbbb' }, { pid: 21, ppid: 20, tag: null }, { pid: 30, ppid: 1, tag: null }, { pid: 40, ppid: 1, tag: 'cccccccccccccccc' }, { pid: process.pid, ppid: 1, tag: 'bbbbbbbbbbbbbbbb' }]
    let left = [...procs]
    const killed: number[] = []
    const n = endRunProcesses({ runIds: ['bbbbbbbbbbbbbbbb'], dirs: ['/w'] }, () => left, (d) => (d === '/w' ? [30] : []), (pid, sig) => { if (sig === 'SIGKILL') { killed.push(pid); left = left.filter((p) => p.pid !== pid) } })
    expect(killed.sort()).toEqual([20, 21, 30])
    expect(n).toBe(3)
  })

  // a fake srt: runs the command with sh (the real one adds Seatbelt); the processes are this test's own
  const d = fs.mkdtempSync(path.join(tmp, 'run-'))
  const cli = path.join(d, 'cli.js')
  fs.writeFileSync(cli, 'const { spawnSync } = require("child_process"); const r = spawnSync("/bin/sh", ["-c", process.argv[process.argv.length - 1]], { stdio: "inherit" }); process.exit(r.status ?? 1)')
  const base = path.join(d, 'base'), work = path.join(devenvPaths(base).work, 'u', 'c')
  fs.mkdirSync(work, { recursive: true })
  const spec = (runId: string, command: string, o: { memoryMiB?: number; pids?: number; sec?: number } = {}) => ({ runId, id: 'mycel', cwd: work, env: { PATH: '/usr/bin:/bin', TRINA_WORK: work },
    limits: { cpus: 1, memoryMiB: o.memoryMiB ?? 512, pids: o.pids ?? 64, runtimeMaxSec: o.sec ?? 30 },
    exitFile: path.join(d, `${runId}.exit`), settingsFile: path.join(d, 's.json'), command, stdoutFile: path.join(d, `${runId}.out`), stderrFile: path.join(d, `${runId}.out`) })
  const mac = process.platform === 'darwin'

  test('the exit code is the command\'s; a run over its memory ends and is marked oom', async () => {
    if (!mac) return
    const sys = officeSystem({ ...kitPaths(d), node: process.execPath, srtCli: cli }, base)
    const ok = await sys.spawn(spec('aaaaaaaaaaaaaaaa', 'echo hi; exit 3'))
    expect((await ok.exited).code).toBe(3)
    expect(fs.readFileSync(path.join(d, 'aaaaaaaaaaaaaaaa.out'), 'utf8')).toContain('hi')
    const big = await sys.spawn(spec('bbbbbbbbbbbbbbbb', `${process.execPath} -e "const a=[];for(;;){a.push(Buffer.alloc(8<<20,1))}"`, { memoryMiB: 64 }))
    await big.exited
    expect(fs.existsSync(path.join(d, 'bbbbbbbbbbbbbbbb.exit.oom'))).toBe(true)
  })
  test('a process that leaves the run\'s group (setsid) carries the CPU limit and is ended when the run ends', async () => {
    if (!mac) return
    const sys = officeSystem({ ...kitPaths(d), node: process.execPath, srtCli: cli }, base)
    const pidFile = path.join(work, 'escapee.pid')
    // a new session (python's os.setsid) that outlives the command; it prints its own CPU limit first
    const cmd = `/usr/bin/python3 -c "import os,sys,time,resource\nif os.fork(): sys.exit(0)\nos.setsid()\nopen('${pidFile}','w').write(str(os.getpid())+' '+str(resource.getrlimit(resource.RLIMIT_CPU)[0]))\ntime.sleep(300)"; sleep 1; cat ${pidFile}`
    const r = await sys.spawn(spec('cccccccccccccccc', cmd, { sec: 40 }))
    await r.exited
    const [pid, cpu] = fs.readFileSync(pidFile, 'utf8').trim().split(' ').map(Number)
    expect(cpu).toBe(40)
    for (let i = 0; i < 20 && alive(pid!); i++) await Bun.sleep(100)
    expect(alive(pid!)).toBe(false)
  })
  test('a fork bomb stops at the run\'s process count and leaves nothing behind', async () => {
    if (!mac) return
    const sys = officeSystem({ ...kitPaths(d), node: process.execPath, srtCli: cli }, base)
    // bounded on purpose: at most 200 sleeps even without the limit; the limit allows only 16 more than this uid has now
    const r = await sys.spawn(spec('dddddddddddddddd', 'i=0; while [ $i -lt 200 ]; do sleep 30 & i=$((i+1)); done; jobs -p > started.txt', { pids: 16, sec: 20 }))
    await r.exited
    const out = fs.readFileSync(path.join(d, 'dddddddddddddddd.out'), 'utf8')
    expect(out).toMatch(/fork|Resource temporarily unavailable/i)
    // the shell gives up at the first fork the limit refuses: it never reaches its last line
    expect(fs.existsSync(path.join(work, 'started.txt'))).toBe(false)
    // every sleep it started is ended with the run (they work in its folder)
    await Bun.sleep(300)
    const left = Bun.spawnSync(['/usr/sbin/lsof', '-a', '-d', 'cwd', '-u', String(process.getuid!()), '-Fn']).stdout.toString().split('\n').filter((l) => l === 'n' + work)
    expect(left).toEqual([])
  })
  test('a server start ends what an earlier server\'s runs left (tagged, or working in devenv/)', async () => {
    if (!mac) return
    const base2 = path.join(d, 'base2'), w2 = path.join(devenvPaths(base2).work, 'u', 'c'); fs.mkdirSync(w2, { recursive: true })
    const a = spawn('/bin/sleep', ['300'], { cwd: w2, detached: true, stdio: 'ignore' }); a.unref()
    // tagged: a program that is not part of macOS (ps shows its environment), as the kit's python3 and node
    const b = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { cwd: tmp, env: { PATH: '/bin', [RUN_TAG]: 'eeeeeeeeeeeeeeee' }, detached: true, stdio: 'ignore' }); b.unref()
    await Bun.sleep(300)
    officeSystem({ ...kitPaths(d), node: process.execPath, srtCli: cli }, base2)
    await Bun.sleep(300)
    expect(alive(a.pid!)).toBe(false)
    expect(alive(b.pid!)).toBe(false)
  })
})

// with the real srt (TRINA_TEST_SRT_CLI: srt 0.0.81's dist/cli.js; skipped without it): a perl survivor that setsids,
// double-forks and leaves devenv/ at once (no tag ps can see) ends with the run, through the reaper in its sandbox
describe('the reaper with the real srt (security re-check of #509)', () => {
  const srtCli = process.env.TRINA_TEST_SRT_CLI ?? ''
  const on = process.platform === 'darwin' && !!srtCli && fs.existsSync(srtCli)
  test('a perl survivor (setsid, double fork, cd /) ends at the end of its run; a process outside the sandbox does not', async () => {
    if (!on) return
    const home = fs.realpathSync(os.homedir())
    const top = fs.mkdtempSync(path.join(home, '.trina-reaper-test-'))
    try {
      const base = path.join(top, 'data'), team = path.join(top, 'team'), work = path.join(devenvPaths(base).work, 'u1', 'c1')
      for (const dd of [work, team, path.join(devenvPaths(base).home, 'u1', 'tmp'), path.join(devenvPaths(base).logs, 'u1')]) fs.mkdirSync(dd, { recursive: true })
      const input = { base, id: 'mycel', teamRoot: team, userId: 'u1', view: { read: [], write: [], denyRead: [], denyWrite: [] }, start: null, work, network: 'offline' as const,
        extraDomains: [], denyHosts: [], denyAddrs: [], platform: 'darwin' as const }
      const st = srtSettings(input)
      expect(settingsProblems(st, input)).toEqual([])
      const sf = path.join(top, 's.json'); fs.writeFileSync(sf, JSON.stringify(st), { mode: 0o600 })
      // a process of this user outside the run: the reaper must not reach it
      const outside = spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' }); outside.unref()
      const sys = officeSystem({ ...kitPaths(top), node: process.execPath, srtCli }, base)
      const cmd = `perl -e 'use POSIX; fork and exit; POSIX::setsid(); fork and exit; open(F,">s.pid"); print F $$; close F; chdir("/"); sleep 600'; sleep 1`
      const r = await sys.spawn({ runId: 'ffffffffffffffff', id: 'mycel', cwd: work, env: { ...runEnv({ base, userId: 'u1', teamRoot: team, work, platform: 'darwin' }) }, limits: { cpus: 1, memoryMiB: 512, pids: 64, runtimeMaxSec: 30 },
        exitFile: path.join(top, 'x.exit'), settingsFile: sf, command: cmd, stdoutFile: path.join(top, 'x.out'), stderrFile: path.join(top, 'x.out') })
      await r.exited
      const survivor = Number(fs.readFileSync(path.join(work, 's.pid'), 'utf8'))
      expect(survivor).toBeGreaterThan(1)
      for (let i = 0; i < 20 && alive(survivor); i++) await Bun.sleep(100)
      expect(alive(survivor)).toBe(false)
      expect(alive(outside.pid!)).toBe(true)
      process.kill(outside.pid!, 'SIGKILL')
      // the command's own exit code and output come through the reaper
      const r2 = await sys.spawn({ runId: 'gggggggggggggggg', id: 'mycel', cwd: work, env: { ...runEnv({ base, userId: 'u1', teamRoot: team, work, platform: 'darwin' }) }, limits: { cpus: 1, memoryMiB: 512, pids: 64, runtimeMaxSec: 30 },
        exitFile: path.join(top, 'y.exit'), settingsFile: sf, command: 'echo built; exit 3', stdoutFile: path.join(top, 'y.out'), stderrFile: path.join(top, 'y.out') })
      expect((await r2.exited).code).toBe(3)
      expect(fs.readFileSync(path.join(top, 'y.out'), 'utf8')).toBe('built\n')
    } finally { fs.rmSync(top, { recursive: true, force: true }) }
  })
})

describe('the page render on an office Mac (tools/isolate.ts officePipe)', () => {
  const prof = sandboxProfile({ cmd: '/k/LibreOffice.app/Contents/MacOS/soffice', workDir: tmp, readPaths: ['/k/LibreOffice.app', '/k/fonts'], denyRead: [], helpersIn: '/k/LibreOffice.app', officePipe: true })
  test('no IP network: the one socket it may make is its own pipe, to listen on, never to connect to', () => {
    expect(prof).toContain('(deny network*)')
    expect(prof).toContain(`(allow network-bind (local unix-socket (regex #"${OFFICE_PIPE_RE}")))`)
    expect(prof).not.toContain('network-outbound')
    expect(prof).not.toMatch(/\(allow network\*/)
  })
  test('writes: its work folder and its pipe only; reads under /Users: its app, the fonts and its work folder; exec in its app', () => {
    expect(prof).toContain('(deny file-write*)')
    expect(prof).toContain(`(allow file-write* (literal "/private/var/tmp") (regex #"${OFFICE_PIPE_RE}"))`)
    expect(prof).toMatch(/\(deny file-read-data \(subpath "\/Users"\)/)
    expect(prof).toContain('(allow process-exec (subpath "/k/LibreOffice.app"))')
    for (const r of ['(deny lsopen)', '(deny appleevent-send)']) expect(prof).toContain(r)
    expect(new RegExp(OFFICE_PIPE_RE).test('/private/var/tmp/OSL_PIPE_501_SingleOfficeIPC_9f2c')).toBe(true)
    expect(new RegExp(OFFICE_PIPE_RE).test('/private/var/tmp/OSL_PIPE_501_SingleOfficeIPC_9f2c/../x')).toBe(false)
  })
})

describe('the office supervisor (office/cli.ts officeDocKitEnv)', () => {
  const home = path.join(tmp, 'sup')
  test('no kit: nothing; a kit: the kit, its fonts for the render and the documents profile', () => {
    fs.mkdirSync(path.join(home, 'kit', 'k1'), { recursive: true })
    const P = { home, data: path.join(home, 'data') }
    expect(officeDocKitEnv(P, {})).toEqual({})
    fs.writeFileSync(path.join(home, 'kit', 'k1', '.key'), 'k1\n'); fs.symlinkSync('k1', path.join(home, 'kit', 'current'))
    expect(officeDocKitEnv(P, {})).toEqual({
      MYCEL_DOC_KIT: path.join(home, 'kit', 'current'), MYCEL_KIT_FONTS_DIR: path.join(home, 'kit', 'current', 'fonts'),
      MYCEL_DEV_ENV: '1', MYCEL_DEV_ENV_DOCUMENTS_ONLY: '1', MYCEL_INSTALL_BASE: path.join(home, 'data'),
    })
    // an agent that sets the dev environment itself keeps it
    expect(officeDocKitEnv(P, { MYCEL_DEV_ENV: '0' })).toEqual({})
    // the owner's off switch (TEAMAX_DOCUMENTS_MODE=0 in office.env)
    expect(officeDocKitEnv(P, {}, false).MYCEL_DOCUMENTS_MODE).toBe('0')
  })
})

describe('the kit in the one list and the office zip', () => {
  const l = readList()
  test('group doc-kit-mac: LibreOffice, node, srt, CPython, the CJK fonts and their licence, and its Python libraries', () => {
    expect(listProblems(l)).toEqual([])
    expect(l.groups['doc-kit-mac']!.artifacts).toEqual(['libreoffice', 'node', 'srt', 'cpython', 'noto-sans-cjk', 'noto-serif-cjk', 'noto-cjk-license'])
    expect(Object.keys(l.artifacts.libreoffice!.platforms).sort()).toEqual(['darwin-amd64', 'darwin-arm64'])
    const reqs = Object.keys(l.python!['doc-kit-mac']!.requirements).map((r) => r.split('==')[0])
    for (const lib of ['python-docx', 'python-pptx', 'openpyxl', 'pandas', 'matplotlib', 'pypdf', 'pdfplumber', 'defusedxml']) expect(reqs).toContain(lib)
  })
  test('a change of the Mac kit changes no byte a Linux server reads', () => {
    const lin = JSON.parse(linuxList(fs.readFileSync(path.join(REPO, 'scripts/system/packages.json'), 'utf8')))
    expect(lin.groups['doc-kit-mac']).toBeUndefined()
    expect(lin.artifacts['noto-sans-cjk']).toBeUndefined()
    expect(lin.python['doc-kit-mac']).toBeUndefined()
  })
  test('doc-kit.sh checks the DMG\'s sha256, the signature of The Document Foundation and the notarisation; office-install.sh prepares before the stop and switches after', () => {
    const s = fs.readFileSync(path.join(REPO, 'scripts/office/doc-kit.sh'), 'utf8')
    for (const want of ['pk_fetch "$(pk_art libreoffice', 'codesign --verify --deep --strict', 'DK_TEAM_ID=7P5S3ZLCN7', 'spctl -a -t exec', '--require-hashes --only-binary=:all: --no-deps', 'npm" ci --ignore-scripts']) expect(s).toContain(want)
    const inst = fs.readFileSync(path.join(REPO, 'scripts/office/office-install.sh'), 'utf8')
    const prep = inst.indexOf('dk_prepare "$PREFIX"'), stop = inst.indexOf('launchctl bootout "gui/$(id -u)/$LABEL"'), sw = inst.indexOf('dk_switch "$PREFIX"'), move = inst.indexOf('mv "$NEW" "$PREFIX/app"')
    expect(prep).toBeGreaterThan(0)
    expect(prep).toBeLessThan(stop)
    expect(sw).toBeGreaterThan(move)
  })
})
