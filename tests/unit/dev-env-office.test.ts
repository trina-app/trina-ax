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
import { officeArgv, officeSystem } from '../../server/src/devenv/srt/system-office'
import { devEnvUi, documentsProfile } from '../../server/src/devenv/setting'
import { OFFICE_PIPE_RE, sandboxProfile } from '../../server/src/tools/isolate'
import { officeDocKitEnv } from '../../server/src/office/cli'
import { linuxList, listProblems, readList } from '../../scripts/system/packages'

setDefaultTimeout(30_000)
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
  test('only with the dev environment flag; Settings and the API show no dev environment then', () => {
    expect(documentsProfile({ MYCEL_DEV_ENV: '1', MYCEL_DEV_ENV_PROFILE: 'documents' })).toBe(true)
    expect(documentsProfile({ MYCEL_DEV_ENV_PROFILE: 'documents' })).toBe(false)
    expect(devEnvUi({ MYCEL_DEV_ENV: '1', MYCEL_DEV_ENV_PROFILE: 'documents' })).toBe(false)
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
  test('argv: limits by ulimit, then the kit\'s srt with the run\'s settings', () => {
    const a = officeArgv({ node: '/k/node/bin/node', srtCli: '/k/srt/cli.js' }, { settingsFile: '/s.json', command: 'echo hi' })
    expect(a.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(a[2]).toContain('ulimit -f')
    expect(a.slice(4)).toEqual(['/k/node/bin/node', '/k/srt/cli.js', '--settings', '/s.json', '-c', 'echo hi'])
  })
  test('a run over its memory is ended with its whole process group and marked oom; the exit code is the command\'s', async () => {
    if (process.platform !== 'darwin') return
    const d = fs.mkdtempSync(path.join(tmp, 'run-'))
    // a fake srt: runs the command with sh (the real one adds Seatbelt)
    const cli = path.join(d, 'cli.js'); fs.writeFileSync(cli, 'const { spawnSync } = require("child_process"); const r = spawnSync("/bin/sh", ["-c", process.argv[process.argv.length - 1]], { stdio: "inherit" }); process.exit(r.status ?? 1)')
    const sys = officeSystem({ ...kitPaths(d), node: process.execPath, srtCli: cli })
    const spec = (runId: string, command: string, memoryMiB = 512) => ({ runId, id: 'mycel', cwd: d, env: { PATH: '/usr/bin:/bin' }, limits: { cpus: 1, memoryMiB, pids: 64, runtimeMaxSec: 30 },
      exitFile: path.join(d, `${runId}.exit`), settingsFile: path.join(d, 's.json'), command, stdoutFile: path.join(d, `${runId}.out`), stderrFile: path.join(d, `${runId}.out`) })
    const ok = await sys.spawn(spec('aaaaaaaaaaaaaaaa', 'echo hi; exit 3'))
    expect((await ok.exited).code).toBe(3)
    expect(fs.readFileSync(path.join(d, 'aaaaaaaaaaaaaaaa.out'), 'utf8')).toContain('hi')
    const big = await sys.spawn(spec('bbbbbbbbbbbbbbbb', `${process.execPath} -e "const a=[];for(;;){a.push(Buffer.alloc(8<<20,1))}"`, 64))
    let oom = false
    const w = setInterval(() => { if ((sys.oomKills('bbbbbbbbbbbbbbbb') ?? 0) > 0) oom = true }, 200)
    await big.exited
    clearInterval(w)
    expect(oom || fs.existsSync(path.join(d, 'bbbbbbbbbbbbbbbb.exit.oom'))).toBe(true)
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
    expect(officeDocKitEnv({ home, data: path.join(home, 'data') }, {})).toEqual({})
    fs.writeFileSync(path.join(home, 'kit', 'k1', '.key'), 'k1\n'); fs.symlinkSync('k1', path.join(home, 'kit', 'current'))
    expect(officeDocKitEnv({ home, data: path.join(home, 'data') }, {})).toEqual({
      MYCEL_DOC_KIT: path.join(home, 'kit', 'current'), MYCEL_KIT_FONTS_DIR: path.join(home, 'kit', 'current', 'fonts'),
      MYCEL_DEV_ENV: '1', MYCEL_DEV_ENV_PROFILE: 'documents', MYCEL_INSTALL_BASE: path.join(home, 'data'),
    })
    // an agent that sets the dev environment itself keeps it
    expect(officeDocKitEnv({ home, data: path.join(home, 'data') }, { MYCEL_DEV_ENV: '0' })).toEqual({})
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
