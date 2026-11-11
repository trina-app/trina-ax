// The one list of system packages and downloaded programs (scripts/system/packages.json, docs/DECISIONS.md "One list of
// system packages"): the hosted image, a self-hosted Linux server, the dev environment and an office Mac all install from
// it. This is the CI check that fails when they disagree: the list is well formed, every artifact has a version and a
// sha256 for every platform, the two readers of packages.sh (bun, jq) read the same thing, no install or image script
// keeps a list or a pinned download of its own, and the image installs the installer's default groups.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { flatFile, flatLines, groupsFor, linuxList, listProblems, packagesFor, pythonRequirements, pythonsFor, readList, REQUIRED_PLATFORMS, type PackageList } from '../../scripts/system/packages'
import { cmpVersion, markerTrue, wheelFits } from '../../scripts/system/python-lock'
import { LINUX_ROOT_SCRIPTS, linuxBundleFiles } from '../../scripts/build-bundle'
import { bundleManifest } from '../../scripts/build-office'
import { rootManaged } from '../../scripts/release/publish-server'
import { SRT_VERSION } from '../../server/src/devenv/srt/config'
import { officeBrowserEnv } from '../../server/src/office/cli'
import { officePaths } from '../../server/src/office/settings'
import { osIdentity, SYSTEM_PACKAGES_TEXT, systemPackagesDiagnostic, type SyncBy } from '../../server/src/system/system-packages'

// several tests start bash and bun many times: generous under a loaded CI machine
setDefaultTimeout(30_000)
const REPO = path.resolve(import.meta.dir, '../..')
const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8')
const SH = path.join(REPO, 'scripts', 'system', 'packages.sh')
const LIST = readList()
const clone = (): PackageList => JSON.parse(JSON.stringify(LIST)) as PackageList
const JQ = Bun.which('jq')
const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', ...(JQ ? [path.dirname(JQ)] : [])].join(':')
function sh(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(['/bin/bash', SH, ...args], { env: { PATH, ...env }, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
/** bash with packages.sh sourced, then SNIPPET */
function lib(snippet: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(['/bin/bash', '-c', `set -euo pipefail\n. "${SH}"\n${snippet}`], { env: { PATH, ...env }, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const systems = Object.keys(LIST.distros).flatMap((d) => LIST.arches.map((a) => [d, a] as const))

/** the scripts that install system packages or programs: each reads the list (packages.sh) */
const INSTALLERS = ['scripts/install-linux.sh', 'scripts/image/customize.sh', 'scripts/dev-env/srt/install-srt.sh', 'scripts/dev-env/install-trial.sh', 'scripts/office/office-install.sh']
/** the scripts that stage the image's files: each copies the list next to customize.sh */
const STAGERS = ['scripts/image/build.sh', 'scripts/image/build-ami.sh', 'scripts/image/test-customize.sh']
/** code lines (full-line comments out), with their numbers */
const codeLines = (f: string) => read(f).split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => !l.trimStart().startsWith('#'))

describe('the list (scripts/system/packages.json)', () => {
  test('is well formed', () => {
    expect(listProblems(LIST)).toEqual([])
  })

  test('every artifact has a version, and a url, sha256 and size for every platform it must have', () => {
    for (const [name, need] of Object.entries(REQUIRED_PLATFORMS)) {
      const a = LIST.artifacts[name]!
      expect(`${name} ${a.version}`).toMatch(/^[a-z-]+ [0-9][0-9A-Za-z.+-]*$/)
      for (const p of need) {
        const f = a.platforms[p]!
        expect(`${name} ${p} ${f.sha256}`).toMatch(/ [0-9a-f]{64}$/)
        expect(f.url.startsWith('https://') && f.url.includes(a.version)).toBe(true)
        expect(f.size).toBeGreaterThan(0)
      }
    }
    // the browser: every Linux server and every office Mac; its folder name inside the zip, for the stable path
    for (const p of REQUIRED_PLATFORMS['chrome-headless-shell']!) expect(LIST.artifacts['chrome-headless-shell']!.platforms[p]!.dir).toMatch(/^chrome-headless-shell-/)
  })

  test('the checker finds a missing hash, a missing platform, a bad floor, a moved version and an unknown system', () => {
    const cases: [string, (l: PackageList) => void, RegExp][] = [
      ['no sha256', (l) => { l.artifacts['chrome-headless-shell']!.platforms['darwin-arm64']!.sha256 = '' }, /darwin-arm64: no sha256/],
      ['no platform', (l) => { delete l.artifacts.node!.platforms['linux-arm64'] }, /artifact node: no linux-arm64/],
      ['no version', (l) => { (l.artifacts.srt as { version?: string }).version = undefined }, /artifact srt: no version/],
      ['exact pin', (l) => { l.groups.core!.packages!.curl = '=7.88.1-10' }, /curl: the floor must be/],
      ['version moved', (l) => { l.artifacts['chrome-headless-shell']!.version = '999.0.0.1' }, /does not name version 999/],
      ['unknown system', (l) => { l.groups.browser!.packages!.unzip = { on: ['debian-11'] } }, /unzip: "on" names a distro/],
      ['unknown group install', (l) => { (l.groups.fonts as { install: string }).install = 'maybe' }, /group fonts: install must be/],
      ['a profile name', (l) => { l.groups.minimal = { install: 'default', for: 'x', packages: { jq: '' } } }, /group minimal: bad name/],
      ['an artifact nobody has', (l) => { l.groups.browser!.artifacts = ['chromium-snap'] }, /no artifact chromium-snap/],
      ['a TAB', (l) => { l.groups.core!.for = 'a\tb' }, /a TAB or line break/],
      // Python programs: exact pins with their sha256, the program's own pin, the interpreter in the same group
      ['a range', (l) => { l.python!['workspace-mcp']!.requirements['fastmcp>=4'] = 'a'.repeat(64) }, /fastmcp>=4: a requirement is "name==version"/],
      ['no wheel hash', (l) => { l.python!['workspace-mcp']!.requirements['fastmcp==4.1.4'] = '' }, /fastmcp==4.1.4: the sha256 of its wheels/],
      ['python version moved', (l) => { l.python!['workspace-mcp']!.version = '9.9.9' }, /do not pin workspace-mcp==9.9.9 itself/],
      ['no venv module', (l) => { delete l.groups['google-apps']!.packages!['python3-venv'] }, /needs the package python3-venv in the group/],
      ['a program nobody has', (l) => { l.groups['google-apps']!.python = ['nosuch'] }, /no python program nosuch/],
      ['a python floor', (l) => { l.python!['workspace-mcp']!.python = '3.11' }, /python must be ">=3.N"/],
    ]
    for (const [name, change, want] of cases) {
      const l = clone()
      change(l)
      expect(`${name}: ${listProblems(l).join('; ')}`).toMatch(want)
    }
  })

  test('the always groups are what every install needs; the image and the dev environment groups are on request', () => {
    expect(groupsFor(LIST, ['minimal'])).toEqual(['core', 'documents', 'media'])
    expect(groupsFor(LIST, ['default'])).toEqual(['core', 'documents', 'media', 'fonts', 'devenv', 'browser', 'google-apps'])
    // Gmail, Calendar, Docs and Sheets (the Google Workspace library): every default install, never --minimal
    expect(pythonsFor(LIST, ['default'])).toEqual(['workspace-mcp'])
    expect(pythonsFor(LIST, ['minimal'])).toEqual([])
    for (const g of ['image', 'srt', 'boxes']) expect(LIST.groups[g]!.install).toBe('on-request')
    expect(LIST.groups.browser!.artifacts).toEqual(['chrome-headless-shell'])
    expect(LIST.groups.srt!.artifacts).toEqual(['node', 'srt'])
    // no SSH server on a team VM (D15)
    expect(LIST.groups.image!.remove).toEqual(['openssh-server', 'openssh-sftp-server'])
  })
})

describe('packages.sh reads the list', () => {
  test('syntax', () => {
    for (const f of ['scripts/system/packages.sh', ...INSTALLERS, ...STAGERS, 'scripts/image/ami-chroot.sh', 'scripts/office/office-uninstall.sh', 'scripts/dev-env/vm-setup.sh']) {
      const p = Bun.spawnSync(['/bin/bash', '-n', path.join(REPO, f)], { stderr: 'pipe' })
      expect(`${f}: ${p.exitCode} ${p.stderr.toString()}`).toBe(`${f}: 0 `)
    }
  })

  test('with bun and with jq, the same flat lines as this reader', () => {
    const want = flatLines(LIST)
    const bun = sh(['flat', '--bun', process.execPath])
    expect(bun.err).toBe('')
    expect(bun.out.trimEnd()).toBe(want)
    if (JQ) {
      const jq = sh(['flat'])
      expect(jq.err).toBe('')
      expect(jq.out.trimEnd()).toBe(want)
    }
  })

  test('the same groups and packages for every system, profile and group', () => {
    const bun = ['--bun', process.execPath]
    const sets = [['minimal'], ['default'], ['image'], ['srt'], ['boxes'], ['core', 'media', 'fonts', 'devenv'], ['google-apps'], ['minimal', 'docker', 'google-apps']]
    // one shell reads the list once and prints every case (a bun start per case is slow)
    const lines: string[] = [], want: string[] = []
    for (const names of sets) {
      lines.push(`echo "groups ${names}: $(pk_groups ${names.join(' ')} | tr '\\n' ' ')"`)
      want.push(`groups ${names}: ${groupsFor(LIST, names).map((g) => g + ' ').join('')}`)
      for (const [d, a] of systems) for (const r of [0, 1]) {
        lines.push(`echo "${d} ${a} ${r} ${names}: $(PK_USERNS_RESTRICTED=${r} pk_packages ${d} ${a} ${names.join(' ')} | tr '\\n' ' ')"`)
        want.push(`${d} ${a} ${r} ${names}: ${packagesFor(LIST, d, a, names, { usernsRestricted: r === 1 }).map((p) => p + ' ').join('')}`)
      }
    }
    const r = lib(`pk_load\n${lines.join('\n')}`, { PK_BUN: process.execPath })
    expect(r.err).toBe('')
    expect(r.out.trimEnd().split('\n').map((l) => l.trimEnd())).toEqual(want.map((w) => w.trimEnd()))
    // the command line too, with the condition set: without PK_USERNS_RESTRICTED it reads this machine's kernel (1 on
    // an Ubuntu CI runner), so the answer would depend on where the test runs
    for (const r of [0, 1]) {
      expect(sh(['packages', ...bun, '--distro', 'debian-13', '--arch', 'arm64', 'minimal'], { PK_USERNS_RESTRICTED: String(r) }).out.trim().split('\n'))
        .toEqual(packagesFor(LIST, 'debian-13', 'arm64', ['minimal'], { usernsRestricted: r === 1 }))
    }
    // apparmor only where the kernel restricts user namespaces (Ubuntu 24.04), t64 names only where the release has them
    expect(packagesFor(LIST, 'ubuntu-24.04', 'amd64', ['minimal'], { usernsRestricted: true })).toContain('apparmor')
    expect(packagesFor(LIST, 'debian-13', 'amd64', ['minimal'])).not.toContain('apparmor')
    expect(packagesFor(LIST, 'debian-12', 'arm64', ['browser'])).toContain('libasound2')
    expect(packagesFor(LIST, 'debian-13', 'arm64', ['browser'])).toContain('libasound2t64')
    expect(packagesFor(LIST, 'ubuntu-24.04', 'amd64', ['devenv'])).not.toContain('chromium') // a snap there
    expect(sh(['groups', ...bun, 'nosuch']).err).toContain('no group or profile "nosuch"')
  }, 30_000)

  test('artifacts and platforms', () => {
    const r = lib(`pk_load; for p in linux-amd64 linux-arm64 darwin-arm64 darwin-amd64; do echo "$p $(pk_art chrome-headless-shell $p version) $(pk_art chrome-headless-shell $p dir)"; done
pk_art chrome-headless-shell linux-ppc64 version || echo none
PK_UNAME_S=Darwin PK_UNAME_M=arm64 pk_platform; PK_UNAME_S=Linux PK_UNAME_M=x86_64 pk_platform; PK_UNAME_S=Linux PK_UNAME_M=aarch64 pk_platform
pk_artifacts default; pk_artifacts minimal; pk_artifacts srt`, { PK_BUN: process.execPath })
    expect(r.err).toBe('')
    const v = LIST.artifacts['chrome-headless-shell']!.version
    expect(r.out.trim().split('\n')).toEqual([
      `linux-amd64 ${v} chrome-headless-shell-linux64`, `linux-arm64 ${v} chrome-headless-shell-linux-arm64`,
      `darwin-arm64 ${v} chrome-headless-shell-mac-arm64`, `darwin-amd64 ${v} chrome-headless-shell-mac-x64`,
      'none', 'darwin-arm64', 'linux-amd64', 'linux-arm64', 'chrome-headless-shell', 'node', 'srt',
    ])
    // the list's systems by /etc/os-release names; another release is refused
    expect(lib('pk_load; pk_distro debian 13; pk_distro ubuntu 24.04; pk_distro debian 11 || echo refused', { PK_BUN: process.execPath }).out.trim().split('\n')).toEqual(['debian-13', 'ubuntu-24.04', 'refused'])
  })

  // a fake browser folder: versions with a program that runs (or does not), current -> one of them
  const fakeBrowser = (runs = true) => `#!/bin/sh\n${runs ? 'echo "Google Chrome for Testing 1.2.3"' : 'echo "error while loading shared libraries" >&2; exit 127'}\n`
  const PIN = LIST.artifacts['chrome-headless-shell']!.version
  function browserDir(versions: Record<string, boolean>, current?: string) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-browser-'))
    const dest = path.join(d, 'chrome-headless-shell')
    const f = LIST.artifacts['chrome-headless-shell']!.platforms['linux-amd64']!
    for (const [v, runs] of Object.entries(versions)) {
      fs.mkdirSync(path.join(dest, v, f.dir!), { recursive: true })
      fs.writeFileSync(path.join(dest, v, f.dir!, 'chrome-headless-shell'), fakeBrowser(runs), { mode: 0o755 })
      fs.writeFileSync(path.join(dest, v, '.sha256'), (v === PIN ? f.sha256 : 'old') + '\n')
    }
    if (current) fs.symlinkSync(`${current}/${f.dir}`, path.join(dest, 'current'))
    // a curl that must not run
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\necho "curl ran" >&2\nexit 9\n', { mode: 0o755 })
    return { d, dest, dir: f.dir!, sha: f.sha256, env: { PK_BUN: process.execPath, PATH: `${bin}:${PATH}`, PK_UNAME_S: 'Linux' } }
  }
  const names_ = (dest: string) => fs.readdirSync(dest).filter((n) => n !== '.lock').sort()

  test('the browser: switch to the prepared version that runs; the one before stays until the next switch; no download', () => {
    const b = browserDir({ [PIN]: true, '150.0.1.2': true, '149.0.0.1': true }, '150.0.1.2')
    fs.mkdirSync(path.join(b.dest, '.new.abc123'))
    let r = lib(`pk_load; p=$(pk_browser_install "${b.dest}" linux-amd64); echo "$p"; pk_browser_check "$p" && echo runs`, b.env)
    expect(r.err).toBe('')
    expect(r.out.trim().split('\n')).toEqual([path.join(b.dest, 'current', 'chrome-headless-shell'), 'runs'])
    expect(fs.readlinkSync(path.join(b.dest, 'current'))).toBe(`${PIN}/${b.dir}`)
    // 150 (current before) stays for a print that may still run; 149 and the leftover go; the swap left no temp link
    expect(names_(b.dest)).toEqual(['.previous', '150.0.1.2', 'current', PIN].sort())
    // another sync with nothing to switch (another install id's, say): the previous version stays
    r = lib(`pk_load; pk_browser_install "${b.dest}" linux-amd64 >/dev/null`, b.env)
    expect(r.code).toBe(0)
    expect(names_(b.dest)).toEqual(['.previous', '150.0.1.2', 'current', PIN].sort())
    // the next switch (a list that pins a newer version): the version it replaces is the previous one now, 150 goes
    const next = '158.0.0.1'
    fs.mkdirSync(path.join(b.dest, next, b.dir), { recursive: true })
    fs.writeFileSync(path.join(b.dest, next, b.dir, 'chrome-headless-shell'), fakeBrowser(true), { mode: 0o755 })
    const l = clone(); l.artifacts['chrome-headless-shell']!.version = next
    fs.writeFileSync(path.join(b.d, 'next.json'), JSON.stringify(l))
    r = lib(`pk_load "${b.d}/next.json"; pk_browser_switch "${b.dest}" linux-amd64 >/dev/null`, b.env)
    expect(r.code).toBe(0)
    expect(fs.readlinkSync(path.join(b.dest, 'current'))).toBe(`${next}/${b.dir}`)
    expect(names_(b.dest)).toEqual(['.previous', 'current', next, PIN].sort())
    expect(fs.readFileSync(path.join(b.dest, '.previous'), 'utf8').trim()).toBe(PIN)
    fs.rmSync(b.d, { recursive: true, force: true })
  })

  test('the browser: a new version that does not start is never switched to; the old one stays current', () => {
    const b = browserDir({ '150.0.1.2': true }, '150.0.1.2')
    // a verified download that does not run here (a library missing): kept untested, tested again next time
    const un = path.join(b.dest, `.untested-${PIN}`)
    fs.mkdirSync(path.join(un, b.dir), { recursive: true })
    fs.writeFileSync(path.join(un, b.dir, 'chrome-headless-shell'), fakeBrowser(false), { mode: 0o755 })
    fs.writeFileSync(path.join(un, '.sha256'), b.sha + '\n')
    const r = lib(`pk_load; pk_browser_prepare "${b.dest}" linux-amd64 || echo not-prepared; pk_browser_switch "${b.dest}" linux-amd64`, b.env)
    expect(r.out.trim().split('\n')).toEqual(['not-prepared', path.join(b.dest, 'current', 'chrome-headless-shell')])
    expect(r.err).toContain('does not start here')
    expect(r.err).not.toContain('curl ran') // the untested copy was tested again, not downloaded again
    expect(fs.readlinkSync(path.join(b.dest, 'current'))).toBe(`150.0.1.2/${b.dir}`)
    expect(fs.existsSync(path.join(b.dest, PIN))).toBe(false)
    expect(fs.existsSync(un)).toBe(true)
    // once it runs (the library came), the next prepare takes it without a download, and the switch moves current
    fs.writeFileSync(path.join(un, b.dir, 'chrome-headless-shell'), fakeBrowser(true), { mode: 0o755 })
    const r2 = lib(`pk_load; pk_browser_install "${b.dest}" linux-amd64`, b.env)
    expect(r2.err).toBe('')
    expect(fs.readlinkSync(path.join(b.dest, 'current'))).toBe(`${PIN}/${b.dir}`)
    // nothing runs at all: current goes, so nothing names a broken program
    const c = browserDir({ '150.0.1.2': false }, '150.0.1.2')
    const r3 = lib(`pk_load; pk_browser_switch "${c.dest}" linux-amd64 || echo none-runs`, c.env)
    expect(r3.out.trim()).toBe('none-runs')
    expect(fs.existsSync(path.join(c.dest, 'current'))).toBe(false)
    fs.rmSync(b.d, { recursive: true, force: true }); fs.rmSync(c.d, { recursive: true, force: true })
  })

  test('the browser: a repair from an older kit keeps a newer browser another install put there', () => {
    const b = browserDir({ '999.0.0.1': true }, '999.0.0.1')
    const r = lib(`pk_load; pk_browser_install "${b.dest}" linux-amd64`, b.env)
    expect(r.out.trim()).toBe(path.join(b.dest, 'current', 'chrome-headless-shell'))
    expect(r.err).toContain('999.0.0.1 stays: it is newer than this list')
    expect(r.err).not.toContain('curl ran')
    expect(fs.readlinkSync(path.join(b.dest, 'current'))).toBe(`999.0.0.1/${b.dir}`)
    expect(names_(b.dest)).toEqual(['999.0.0.1', 'current'])
    fs.rmSync(b.d, { recursive: true, force: true })
  })

  test('the browser: a revoked version goes back to the pin even when newer (a bad pin rolled back), and is not kept', () => {
    // a list that pins PIN and revokes 999.0.0.1 (the bad pin a release had); 999 is current, PIN is ready
    const b = browserDir({ [PIN]: true, '999.0.0.1': true, '150.0.1.2': true }, '999.0.0.1')
    fs.writeFileSync(path.join(b.dest, '.previous'), '150.0.1.2\n')
    const l = clone(); l.artifacts['chrome-headless-shell']!.revoked = ['999.0.0.1']
    expect(listProblems(l)).toEqual([])
    const list = path.join(b.d, 'packages.json'); fs.writeFileSync(list, JSON.stringify(l))
    const r = lib(`pk_load "${list}"; pk_browser_install "${b.dest}" linux-amd64`, b.env)
    expect(r.out.trim()).toBe(path.join(b.dest, 'current', 'chrome-headless-shell'))
    expect(r.err).not.toContain('stays: it is newer')
    expect(fs.readlinkSync(path.join(b.dest, 'current'))).toBe(`${PIN}/${b.dir}`)
    // 999 is not the "previous" one (a revoked version never stays); 150 is no longer kept either
    expect(names_(b.dest)).toEqual(['current', PIN].sort())
    // revoked and the pin not ready: current goes, HTML to PDF is off rather than on a revoked browser
    const c = browserDir({ '999.0.0.1': true }, '999.0.0.1')
    fs.writeFileSync(path.join(c.d, 'packages.json'), JSON.stringify(l))
    const r2 = lib(`pk_load "${path.join(c.d, 'packages.json')}"; pk_browser_switch "${c.dest}" linux-amd64 || echo none`, c.env)
    expect(r2.out.trim()).toBe('none')
    expect(r2.err).toContain('999.0.0.1 is revoked by the list')
    expect(fs.existsSync(path.join(c.dest, 'current'))).toBe(false)
    // the readers agree on the X lines; a list that revokes its own pin, or a non-version, is refused
    expect(sh(['flat', '--list', list, '--bun', process.execPath]).out.trimEnd()).toBe(flatLines(l))
    if (JQ) expect(sh(['flat', '--list', list]).out.trimEnd()).toBe(flatLines(l))
    expect(flatLines(l)).toContain('X\tchrome-headless-shell\t999.0.0.1')
    const own = clone(); own.artifacts['chrome-headless-shell']!.revoked = [PIN]
    expect(listProblems(own).join()).toContain('revoked names the pinned version')
    const bad = clone(); bad.artifacts['chrome-headless-shell']!.revoked = ['latest']
    expect(listProblems(bad).join()).toContain('revoked must be a list of versions')
    fs.rmSync(b.d, { recursive: true, force: true }); fs.rmSync(c.d, { recursive: true, force: true })
  })

  test('the browser folder and its parent are 755 whatever the umask; a dir with .. in the list is refused', () => {
    const b = browserDir({})
    const r = lib(`umask 077; pk_load; pk_browser_switch "${b.dest}" linux-amd64 || true`, b.env)
    expect(r.code).toBe(0)
    for (const p of [b.d, b.dest]) expect((fs.statSync(p).mode & 0o777).toString(8)).toBe('755')
    // a list whose dir climbs out
    const bad = path.join(b.d, 'packages.json')
    const l = clone(); l.artifacts['chrome-headless-shell']!.platforms['linux-amd64']!.dir = '..'
    fs.writeFileSync(bad, JSON.stringify(l))
    expect(listProblems(l).join()).toContain('bad dir')
    const r2 = lib(`pk_load "${bad}"; pk_browser_prepare "${b.dest}" linux-amd64 || echo refused`, b.env)
    expect(r2.out.trim()).toBe('refused')
    expect(r2.err).toContain('bad version or dir')
    fs.rmSync(b.d, { recursive: true, force: true })
  })

  test('the browser: a download with another sha256 leaves nothing; only https; no hash, no download', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-fetch-'))
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin)
    // a curl that "downloads" other bytes (a mirror or a person in the middle)
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { echo other > "$2"; shift; }; shift; done\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'unzip'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const dest = path.join(d, 'chrome-headless-shell')
    const r = lib(`pk_load; PK_UNAME_S=Linux pk_browser_prepare "${dest}" linux-arm64 || echo failed
pk_fetch http://example.com/x "${'a'.repeat(64)}" "" "${d}/x" || echo http-refused
pk_fetch https://example.com/x "" "" "${d}/x" || echo no-hash-refused`, { PK_BUN: process.execPath, PATH: `${bin}:${PATH}` })
    expect(r.out.trim().split('\n')).toEqual(['failed', 'http-refused', 'no-hash-refused'])
    expect(r.err).toContain('the list pins')
    expect(names_(dest)).toEqual([]) // no .new.* left, no version, no current
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('a download that stalls is stopped at its budget, with curl told to give up on its own too', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-stall-'))
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin)
    // a curl that hangs whatever it is told (a dead mirror that keeps the connection open)
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\necho "$@" >> "${d}/args"\nexec sleep 60\n`, { mode: 0o755 })
    const start = Date.now()
    const r = lib(`PK_FETCH_BUDGET=6 pk_fetch https://example.com/x "${'a'.repeat(64)}" "" "${d}/x" || echo stopped`, { PATH: `${bin}:${PATH}` })
    const took = Date.now() - start
    expect(r.out.trim()).toBe('stopped')
    expect(r.err).toContain('stopped after 6 s (PK_FETCH_BUDGET)')
    expect(took).toBeLessThan(20_000)
    const args = fs.readFileSync(path.join(d, 'args'), 'utf8')
    for (const a of ['--connect-timeout 20', '--speed-limit 10240', '--speed-time 60', '--max-time ', '--proto =https']) expect(args).toContain(a)
    expect(fs.existsSync(path.join(d, 'x'))).toBe(false)
    // no curl is left running
    expect(Bun.spawnSync(['pgrep', '-f', `${d}/args`]).exitCode).not.toBe(0)
    fs.rmSync(d, { recursive: true, force: true })
  }, 30_000)

  test('/etc/default/<id>: one line of ours, every other line kept, an empty file removed, renamed into place', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-env-'))
    const f = path.join(d, 'mycel')
    fs.writeFileSync(f, 'MYCEL_TEAM_TZ=Asia/Seoul\nMYCEL_HTML_PDF_BROWSER=/old\nMYCEL_SAFE_OPS_1A=1\n')
    const ino = fs.statSync(f).ino
    expect(lib(`pk_set_env "${f}" MYCEL_HTML_PDF_BROWSER /opt/trina/chrome-headless-shell/current/chrome-headless-shell`).code).toBe(0)
    expect(fs.readFileSync(f, 'utf8')).toBe('MYCEL_TEAM_TZ=Asia/Seoul\nMYCEL_SAFE_OPS_1A=1\nMYCEL_HTML_PDF_BROWSER=/opt/trina/chrome-headless-shell/current/chrome-headless-shell\n')
    expect(fs.statSync(f).ino).not.toBe(ino) // a new file renamed over the old one: a reader never sees half of it
    expect((fs.statSync(f).mode & 0o777).toString(8)).toBe('644')
    expect(lib(`pk_set_env "${f}" MYCEL_HTML_PDF_BROWSER ""`).code).toBe(0)
    expect(fs.readFileSync(f, 'utf8')).toBe('MYCEL_TEAM_TZ=Asia/Seoul\nMYCEL_SAFE_OPS_1A=1\n')
    fs.writeFileSync(f, 'MYCEL_HTML_PDF_BROWSER=/x\n')
    expect(lib(`pk_set_env "${f}" MYCEL_HTML_PDF_BROWSER ""`).code).toBe(0)
    expect(fs.existsSync(f)).toBe(false)
    expect(fs.readdirSync(d)).toEqual([]) // no temporary file left
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('root reads a bundle\'s flat copy with awk alone; a copy that is not of this list is not used', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-flat-'))
    const text = read('scripts/system/packages.json')
    fs.writeFileSync(path.join(d, 'packages.json'), text)
    fs.writeFileSync(path.join(d, 'packages.flat'), flatFile(text))
    // no bun, and no jq: /usr/bin has one on some systems, so it is shadowed by one that fails
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'jq'), '#!/bin/sh\necho "jq ran" >&2\nexit 9\n', { mode: 0o755 })
    const env = { PATH: `${bin}:/usr/bin:/bin`, PK_BUN: '' }
    const r = lib(`pk_load "${d}/packages.json" && pk_art chrome-headless-shell linux-amd64 version`, env)
    expect(r.err).toBe('')
    expect(r.out.trim()).toBe(PIN)
    fs.writeFileSync(path.join(d, 'packages.flat'), flatFile(text.replace(PIN, '1.0.0.0')).replace(/^#sha256 [0-9a-f]+/, '#sha256 ' + '0'.repeat(64)))
    const r2 = lib(`pk_load "${d}/packages.json" || echo not-read`, env)
    expect(r2.out.trim()).toBe('not-read')
    expect(r2.err).toContain('jq ran')
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('sync runs apt unattended where the install said skipApt false or is hosted (not a self-hosted one from before the list, not --skip-apt)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-apt-'))
    const cases: [string, boolean][] = [['{"format":1,"skipApt":false}', true], ['{"format":1,"skipApt":true}', false], ['{"format":1,"systemd":true}', false],
      // a hosted install from before the list (no skipApt): the hosting service owns the machine, apt is allowed
      ['{"format":1,"hosted": true,"systemd":true}', true], ['{"format":1,"hosted":true,"skipApt":true}', false], ['{"format":1,"hosted":false}', false]]
    for (const [json, allowed] of cases) {
      fs.writeFileSync(path.join(d, 'install.json'), json)
      expect(`${json}: ${lib(`pk__apt_allowed "${d}/install.json" && echo yes || echo no`).out.trim()}`).toBe(`${json}: ${allowed ? 'yes' : 'no'}`)
    }
    // apt checks free space first; the browser's libraries go first, in a transaction of their own
    const s = read('scripts/system/packages.sh')
    expect(s).toContain('if ! why=$(pk_apt_space')
    expect(s).toContain('case " ${browser_pkgs[*]:-} " in *" $p "*) first+=("$p") ;; *) rest+=("$p") ;; esac')
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('during a sync apt is a transient unit of its own (systemd-run), waits for dpkg\'s lock, logs to a file', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-unit-'))
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin)
    fs.mkdirSync(path.join(d, 'systemd'))
    // systemd-run records how it is called; apt-get answers the free-space check with nothing to download
    fs.writeFileSync(path.join(bin, 'systemd-run'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${d}/calls"; echo --- >> "${d}/calls"\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'apt-get'), `#!/bin/sh\necho "apt-get $*" >> "${d}/direct"\n`, { mode: 0o755 })
    const env = { PATH: `${bin}:${PATH}`, PK_SYSTEMD_DIR: path.join(d, 'systemd'), PK_APT_LOG: path.join(d, 'apt.log'), https_proxy: 'http://proxy:3128' }
    expect(lib('PK_APT_UNIT=1 pk_apt_install -- unzip libnss3', env).code).toBe(0)
    const calls = fs.readFileSync(path.join(d, 'calls'), 'utf8').split('---\n').filter(Boolean).map((c) => c.trim().split('\n'))
    expect(calls.length).toBe(2) // apt-get update, apt-get install
    for (const c of calls) {
      for (const a of ['--wait', '--collect', '--quiet', `StandardOutput=append:${d}/apt.log`, `StandardError=append:${d}/apt.log`, 'DEBIAN_FRONTEND=noninteractive', 'https_proxy=http://proxy:3128', '-o', 'DPkg::Lock::Timeout=300'])
        expect(`${c.join(' ')}: ${c.includes(a)}`).toBe(`${c.join(' ')}: true`)
      expect(c.find((a) => a.startsWith('--unit='))).toMatch(/^--unit=trina-packages-apt-\d+-\d+$/)
    }
    expect(calls[0]!.slice(calls[0]!.indexOf('apt-get'))).toEqual(['apt-get', 'update', '-qq', '-o', 'DPkg::Lock::Timeout=300'])
    expect(calls[1]!.slice(calls[1]!.indexOf('apt-get'))).toEqual(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', '-o', 'DPkg::Lock::Timeout=300', 'unzip', 'libnss3'])
    // only the free-space check (no transaction) ran apt-get directly
    expect(fs.readFileSync(path.join(d, 'direct'), 'utf8').trim().split('\n').every((l) => l.includes('--assume-no'))).toBe(true)
    // the sync sets it; an installer an administrator runs does not (a chroot build would reach the host's systemd)
    expect(read('scripts/system/packages.sh')).toMatch(/pk__sync\(\) \{[\s\S]*?\n {2}PK_APT_UNIT=1\n/)
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('results: a full disk and an administrator\'s step are blocked, a failed download incomplete, the worse wins', () => {
    const r = lib(['ok ok', 'ok incomplete', 'incomplete ok', 'incomplete blocked', 'blocked incomplete', 'blocked ok'].map((x) => `pk_worse ${x}`).join('\n'))
    expect(r.out.trim().split('\n')).toEqual(['ok', 'incomplete', 'incomplete', 'blocked', 'blocked', 'blocked'])
    const s = read('scripts/system/packages.sh'), inst = read('scripts/install-linux.sh')
    expect(s).toContain('if [ "$rc" = 3 ]; then res=$(pk_worse "$res" blocked); else res=$(pk_worse "$res" incomplete); fi')
    expect(inst).not.toMatch(/\bSYNC_RESULT=(incomplete|blocked)\b/) // every change goes through pk_worse
  })

  test('the sync record is always JSON: control characters, quotes and backslashes are taken out', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-rec-'))
    const r = lib(`pk_write_synced "${d}/packages.synced" abc incomplete "$(printf 'line one\\nline\\ttwo \\001\\033[31m "quoted" back\\\\slash')" "157.0.8103.38;rm"`,
      { PK_OS_RELEASE: path.join(d, 'none'), PK_MACHINE_ID: path.join(d, 'none') })
    expect(r.code).toBe(0)
    const j = JSON.parse(fs.readFileSync(path.join(d, 'packages.synced'), 'utf8'))
    expect(j).toMatchObject({ format: 1, list: 'abc', result: 'incomplete', browser: '157.0.8103.38rm', os: '' })
    expect(j.detail).toBe('line one line two [31m quoted backslash')
    expect(fs.readdirSync(d)).toEqual(['packages.synced'])
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('the sync record names the system (os-release and machine-id), the same string as mycel-ctl and the server read', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-os-'))
    // the fixture of native/cmd/mycel-ctl TestSyncRecordNamesTheSystem
    fs.writeFileSync(path.join(d, 'os-release'), 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_ID="13"\n')
    fs.writeFileSync(path.join(d, 'machine-id'), '0123456789abcdef0123456789abcdef\n')
    const env = { PK_OS_RELEASE: path.join(d, 'os-release'), PK_MACHINE_ID: path.join(d, 'machine-id') }
    const want = 'debian-13/0123456789abcdef0123456789abcdef'
    expect(lib('pk_os_identity', env).out).toBe(want)
    expect(lib(`pk_write_synced "${d}/packages.synced" abc ok "" ""`, env).code).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(d, 'packages.synced'), 'utf8')).os).toBe(want)
    expect(osIdentity({ osRelease: env.PK_OS_RELEASE, machineId: env.PK_MACHINE_ID })).toBe(want)
    expect(osIdentity({ osRelease: path.join(d, 'none'), machineId: path.join(d, 'none') })).toBe('')
    // the server's diagnostics: a record of another system (a reimage keeps the data disk) is pending, not ok
    const root = path.join(d, 'root'); fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'packages.json'), '{"format":1}')
    const sum = new Bun.CryptoHasher('sha256').update('{"format":1}').digest('hex')
    const diag = (osName: string) => {
      fs.writeFileSync(path.join(root, 'packages.synced'), JSON.stringify({ format: 1, list: sum, result: 'ok', at: '2026-11-07T00:00:00Z', os: osName }))
      return systemPackagesDiagnostic(root, { by: 'hosted', when: (x) => x, os: { osRelease: env.PK_OS_RELEASE, machineId: env.PK_MACHINE_ID } })?.status
    }
    expect(diag(want)).toBe('ok')
    expect(diag('debian-13/ffffffffffffffffffffffffffffffff')).toBe('warn')
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('a name in the list that is not a package name stops pk_packages (no option, no glob reaches apt)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-name-'))
    for (const bad of ['-oAPT::Get::Hack=1', 'lib*', 'a b']) {
      const l = clone(); (l.groups.core!.packages as Record<string, string>)[bad] = ''
      fs.writeFileSync(path.join(d, 'l.json'), JSON.stringify(l))
      const r = lib(`pk_load "${d}/l.json"; pk_packages debian-13 amd64 minimal >/dev/null || echo refused`, { PK_BUN: process.execPath })
      expect(`${bad}: ${r.out.trim()}`).toBe(`${bad}: refused`)
      expect(r.err).toContain('not a package name in the list')
    }
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('the office installer downloads the browser before it stops the server, bounded, and only warns', () => {
    const s = read('scripts/office/office-install.sh')
    const prepare = s.indexOf('pk_browser_prepare "$BROWSER_DIR"'), stop = s.indexOf('launchctl bootout "gui/$(id -u)/$LABEL"'), sw = s.indexOf('pk_browser_switch "$BROWSER_DIR"')
    expect(prepare).toBeGreaterThan(0)
    expect(prepare).toBeLessThan(stop)
    expect(sw).toBeGreaterThan(s.indexOf('mv "$NEW" "$PREFIX/app"'))
    expect(s).toContain('if [ "$UPDATE" = 1 ]; then PK_FETCH_BUDGET=240; else PK_FETCH_BUDGET=480; fi')
    // neither step can end the installer: both are in an if or after ||
    expect(s).toMatch(/pk_browser_prepare "\$BROWSER_DIR" "\$BROWSER_PLAT" \\\n\s+\|\| say "warning:/)
    expect(s).toMatch(/if pk_browser_switch "\$BROWSER_DIR"/)
  })

  test('python programs: the readers, the requirements pip gets, the pin', () => {
    const r = lib('pk_load; pk_pythons default; pk_pythons minimal; pk_py workspace-mcp version; pk_py workspace-mcp python; pk_py workspace-mcp program; pk_py nosuch version || echo none', { PK_BUN: process.execPath })
    expect(r.err).toBe('')
    const y = LIST.python!['workspace-mcp']!
    expect(r.out.trim().split('\n')).toEqual(['workspace-mcp', y.version, y.python.slice(2), y.program, 'none'])
    const req = lib('pk_load; pk_python_requirements workspace-mcp', { PK_BUN: process.execPath })
    expect(req.err).toBe('')
    expect(req.out).toBe(pythonRequirements(LIST, 'workspace-mcp'))
    // every line an exact pin with at least one sha256; the program's own wheel among them
    for (const l of req.out.trim().split('\n')) expect(l).toMatch(/^[a-z0-9-]+==[0-9][0-9A-Za-z.!+]* --hash=sha256:[0-9a-f]{64}( --hash=sha256:[0-9a-f]{64})*$/)
    expect(req.out).toContain(`workspace-mcp==${y.version} --hash=sha256:`)
    // a name in the list that is not a pin stops it (no option reaches pip)
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-py-'))
    const l = clone(); l.python!['workspace-mcp']!.requirements = { '--index-url=http://evil/x==1': 'a'.repeat(64) }
    fs.writeFileSync(path.join(d, 'l.json'), JSON.stringify(l))
    const bad = lib(`pk_load "${d}/l.json"; pk_python_requirements workspace-mcp >/dev/null || echo refused`, { PK_BUN: process.execPath })
    expect(bad.out.trim()).toBe('refused')
    expect(bad.err).toContain('not a pinned requirement')
    fs.rmSync(d, { recursive: true, force: true })
  })

  // a fake python3: -c answers the version check (too old while <d>/old exists); -m venv DIR makes a venv whose python
  // stands for pip: it records its arguments and the requirements it got, and puts a program that starts (unless
  // <d>/broken exists; it fails while <d>/pip-fails exists)
  function fakePython() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-venv-'))
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(d, 'pip.sh'), [
      '#!/bin/bash', `R="${d}"`, 'v=$(cd "$(dirname "$0")/.." && pwd)',
      'printf \'%s\\n\' "$*" >> "$R/pip-calls"', '[ ! -e "$R/pip-fails" ] || exit 1',
      'while [ $# -gt 0 ]; do [ "$1" = -r ] && cp "$2" "$v/got-requirements"; shift; done',
      'printf \'#!/bin/sh\\n[ ! -e "%s/broken" ]\\n\' "$R" > "$v/bin/workspace-mcp"; chmod 755 "$v/bin/workspace-mcp"', '',
    ].join('\n'))
    fs.writeFileSync(path.join(bin, 'python3'), [
      '#!/bin/bash', `R="${d}"`,
      'if [ "$1" = -c ]; then case "$2" in *version_info*) [ ! -e "$R/old" ] ;; *) echo 3.9.0 ;; esac; exit; fi',
      '[ "$1 $2" = "-m venv" ] || exit 2',
      'mkdir -p "$3/bin" && cp "$R/pip.sh" "$3/bin/python" && chmod 755 "$3/bin/python"', '',
    ].join('\n'), { mode: 0o755 })
    const dest = path.join(d, 'python', 'workspace-mcp')
    const calls = () => fs.existsSync(path.join(d, 'pip-calls')) ? fs.readFileSync(path.join(d, 'pip-calls'), 'utf8').trim().split('\n') : []
    return { d, dest, calls, env: { PK_BUN: process.execPath, PATH: `${bin}:${PATH}` } }
  }
  const reqSha = (l: PackageList) => new Bun.CryptoHasher('sha256').update(pythonRequirements(l, 'workspace-mcp')).digest('hex')
  const pyKey = (l: PackageList) => `${l.python!['workspace-mcp']!.version}-${reqSha(l).slice(0, 12)}`
  const withWheel = (name: string, h: string) => { const l = clone(); l.python!['workspace-mcp']!.requirements[name] = h.repeat(64); return l }

  test('python programs: a venv in its pinned folder, pip with only the list\'s wheels, current -> it once it starts', () => {
    const p = fakePython()
    const key = pyKey(LIST)
    let r = lib(`umask 077; pk_load; pk_python_install "${p.dest}" workspace-mcp`, p.env)
    expect(r.err).toBe('')
    expect(r.out.trim()).toBe(path.join(p.dest, 'current', 'bin', 'workspace-mcp'))
    expect(fs.readlinkSync(path.join(p.dest, 'current'))).toBe(key)
    expect(fs.readFileSync(path.join(p.dest, key, 'got-requirements'), 'utf8')).toBe(pythonRequirements(LIST, 'workspace-mcp'))
    expect(fs.readFileSync(path.join(p.dest, key, '.sha256'), 'utf8').trim()).toBe(reqSha(LIST))
    // readable by the server's account whatever the umask
    for (const x of [p.dest, path.join(p.dest, key), path.join(p.dest, key, 'bin')]) expect((fs.statSync(x).mode & 0o755).toString(8)).toBe('755')
    expect(p.calls().length).toBe(1)
    const args = p.calls()[0]!.split(' ')
    expect(args.slice(0, 4)).toEqual(['-I', '-m', 'pip', 'install'])
    for (const a of ['--isolated', '--no-cache-dir', '--require-hashes', '--only-binary=:all:', '--no-deps', '--index-url=https://pypi.org/simple', '-r']) expect(args).toContain(a)
    // again: it is there, no pip
    r = lib(`pk_load; pk_python_install "${p.dest}" workspace-mcp`, p.env)
    expect(r.code).toBe(0)
    expect(p.calls().length).toBe(1)
    // an unfinished folder (no .sha256: stopped mid-way) is built again
    fs.rmSync(path.join(p.dest, key, '.sha256'))
    expect(lib(`pk_load; pk_python_install "${p.dest}" workspace-mcp >/dev/null`, p.env).code).toBe(0)
    expect(p.calls().length).toBe(2)
    // a new pin (another wheel): a new folder, current moves, the one before stays until the next switch
    const l2 = withWheel('extra-wheel==1.0', 'b'), l3 = withWheel('extra-wheel==2.0', 'c')
    fs.writeFileSync(path.join(p.d, 'l2.json'), JSON.stringify(l2))
    fs.writeFileSync(path.join(p.d, 'l3.json'), JSON.stringify(l3))
    expect(lib(`pk_load "${p.d}/l2.json"; pk_python_install "${p.dest}" workspace-mcp >/dev/null`, p.env).code).toBe(0)
    expect(fs.readlinkSync(path.join(p.dest, 'current'))).toBe(pyKey(l2))
    expect(fs.readFileSync(path.join(p.dest, '.previous'), 'utf8').trim()).toBe(key)
    const names = () => fs.readdirSync(p.dest).filter((n) => n !== '.lock').sort()
    expect(names()).toEqual(['.previous', 'current', key, pyKey(l2)].sort())
    expect(lib(`pk_load "${p.d}/l3.json"; pk_python_install "${p.dest}" workspace-mcp >/dev/null`, p.env).code).toBe(0)
    expect(names()).toEqual(['.previous', 'current', pyKey(l2), pyKey(l3)].sort())
    fs.rmSync(p.d, { recursive: true, force: true })
   }, 120_000)

  test('python programs: pip fails, the program does not start, Python is too old: nothing new, current stays', () => {
    const p = fakePython()
    expect(lib(`pk_load; pk_python_install "${p.dest}" workspace-mcp >/dev/null`, p.env).code).toBe(0)
    const key = pyKey(LIST), l2 = withWheel('extra-wheel==1.0', 'b')
    fs.writeFileSync(path.join(p.d, 'l2.json'), JSON.stringify(l2))
    const cases: [string, string][] = [['pip-fails', 'pip install failed'], ['broken', 'does not start here'], ['old', 'needs Python 3.11 or later; this system has 3.9.0']]
    for (const [flag, err] of cases) {
      fs.writeFileSync(path.join(p.d, flag), '')
      const r = lib(`pk_load "${p.d}/l2.json"; pk_python_install "${p.dest}" workspace-mcp || echo failed`, p.env)
      expect(`${flag}: ${r.out.trim()}`).toBe(`${flag}: failed`)
      expect(r.err).toContain(err)
      expect(fs.readlinkSync(path.join(p.dest, 'current'))).toBe(key)
      expect(fs.existsSync(path.join(p.dest, pyKey(l2)))).toBe(false)
      fs.rmSync(path.join(p.d, flag))
    }
    fs.rmSync(p.d, { recursive: true, force: true })
   }, 120_000)

  test('python-lock.ts reads markers, wheel tags and versions as pip does', () => {
    const env = { python_full_version: '3.11.2', python_version: '3.11', sys_platform: 'linux', platform_system: 'Linux', platform_machine: 'x86_64', platform_python_implementation: 'CPython', implementation_name: 'cpython', os_name: 'posix', extra: '' }
    expect(markerTrue("python_full_version < '3.11'", env)).toBe(false)
    expect(markerTrue("python_full_version == '3.11.*' or (python_full_version == '3.12.*' and sys_platform != 'emscripten')", env)).toBe(true)
    expect(markerTrue("sys_platform == 'win32'", env)).toBe(false)
    expect(markerTrue("platform_machine != 'ppc64le' and platform_machine != 's390x'", env)).toBe(true)
    expect(markerTrue("extra == 'dev'", env)).toBe(false)
    expect(wheelFits('cffi-2.0.0-cp311-cp311-manylinux2014_x86_64.manylinux_2_17_x86_64.whl', '3.11.2', 'x86_64', 36)).toBe(true)
    expect(wheelFits('cffi-2.0.0-cp311-cp311-manylinux2014_x86_64.manylinux_2_17_x86_64.whl', '3.12.3', 'x86_64', 39)).toBe(false)
    expect(wheelFits('cryptography-50.0.0-cp311-abi3-manylinux_2_34_aarch64.whl', '3.13.5', 'aarch64', 41)).toBe(true)
    expect(wheelFits('cryptography-50.0.0-cp311-abi3-manylinux_2_38_aarch64.whl', '3.11.2', 'aarch64', 36)).toBe(false)
    expect(wheelFits('x-1.0-cp313-cp313t-manylinux_2_17_x86_64.whl', '3.13.5', 'x86_64', 41)).toBe(false)
    expect(wheelFits('x-1.0-cp313-cp313-musllinux_1_2_x86_64.whl', '3.13.5', 'x86_64', 41)).toBe(false)
    expect(wheelFits('x-1.0-py3-none-any.whl', '3.11.2', 'aarch64', 36)).toBe(true)
    expect(cmpVersion('2026.1.post1', '2026.1')).toBe(1)
    expect(cmpVersion('4.1.4', '4.1.2')).toBe(1)
    expect(cmpVersion('1.0rc1', '1.0')).toBe(-1)
  })

  test('sync (mycel-ctl update) needs an id and a base', () => {
    expect(sh(['sync']).code).toBe(2)
    expect(sh(['sync', '--id', 'Bad Id', '--base', '/x']).code).toBe(2)
  })
})

describe('every install path reads the list', () => {
  const names = new Set(Object.values(LIST.groups).flatMap((g) => [...Object.keys(g.packages ?? {}), ...(g.remove ?? [])]))
  const word = (n: string) => new RegExp(`(?<![A-Za-z0-9.+_/-])${n.replace(/[.+]/g, '\\$&')}(?![A-Za-z0-9.+_/-])`)

  // Every shell script under scripts/ and docker/, and every Containerfile/Dockerfile of the repository, is scanned. These
  // commands may name packages, each for a reason (none of them installs the product's system). The allowlist is per
  // command, not per file (PR #164 review, M5): a command is allowed when it holds one of its file's fragments, every
  // other command of the file is checked like any file's, and a fragment no command holds any more is a stale entry.
  type Allow = { why: string; lines: string[] }
  const ALLOWED: Record<string, Allow> = {
    'scripts/linux/build-whisper.sh': { why: 'the build machine\'s compiler for whisper-cli, not a server', lines: ['apt-get install -y --no-install-recommends build-essential cmake'] },
    'scripts/dev-env/srt/vm-check.sh': { why: 'a throwaway test VM of the srt spike', lines: ['apt-get install -y -q jq curl', 'apt-get install -y -q --no-install-recommends pandoc'] },
    'scripts/dev-env/srt/spike-vm.sh': { why: 'the srt design spike\'s VM', lines: ['apt-get install -y -q unzip curl jq'] },
    'scripts/dev-env/Containerfile': { why: 'the inside of a dev environment box (podman image), not the server', lines: ['apt-get install -y --no-install-recommends nodejs npm'] },
    'tests/linux/Dockerfile': { why: 'the Linux test container', lines: ['apt-get install -y --no-install-recommends ripgrep poppler-utils'] },
    'tests/linux/Dockerfile.srt': { why: 'the srt attack test container', lines: ['apt-get install -y --no-install-recommends bubblewrap socat'] },
    'tests/linux/Dockerfile.safe-ops': { why: 'the safe operations test container', lines: ['apt-get install -y --no-install-recommends libheif-examples'] },
    'tests/linux/Dockerfile.html-pdf': { why: 'the HTML to PDF test container', lines: ['apt-get install -y --no-install-recommends bubblewrap chromium'] },
    'tests/install/linux/Dockerfile': { why: 'the install test\'s systemd container (what an installer fetches, cached)', lines: ['apt-get install -y --no-install-recommends systemd systemd-sysv'] },
  }
  // and these commands may carry a sha256 or a download address of their own, each for a reason
  const PINS_ALLOWED: Record<string, Allow> = {
    'tests/linux/Dockerfile': { why: 'the Linux test container (its pandoc and typst for the tests)', lines: ['typst-$T-unknown-linux-musl.tar.xz'] },
    'tests/linux/Dockerfile.srt': { why: 'the srt attack test container: its node is the list\'s (checked below)', lines: ['no node pin for $TARGETARCH'] },
    'scripts/vm/macos-vm.sh': { why: 'the digest of the macOS test VM image', lines: ['ghcr.io/cirruslabs/macos-tahoe-base@sha256:'] },
  }
  /** is this command of file f allowed by the list (a command that holds one of the file's fragments)? */
  const allowedBy = (list: Record<string, Allow>, f: string, l: string) => !!list[f]?.lines.some((x) => l.includes(x))
  // and these may install a few named packages, each for a reason
  const NAMES_ALLOWED: Record<string, { names: string[]; why: string }> = {
    'docker/Dockerfile': { names: ['ca-certificates', 'curl'], why: 'the stage that downloads the kit, before the list exists; not part of the image' },
  }
  const scanned = () => {
    const out: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) { if (!['node_modules', '.work', 'kit-local'].includes(e.name)) walk(rel) }
        else if ((!dir.startsWith('tests') && e.name.endsWith('.sh')) || /^(Containerfile|Dockerfile)/.test(e.name)) out.push(rel)
      }
    }
    walk('scripts'); walk('docker'); walk('tests')
    return out.sort()
  }
  /** a file's commands: comments out, continuation lines joined, each with the number of its first line */
  const commands = (text: string) => {
    const out: [number, string][] = []
    let cur = '', first = 0
    text.split('\n').forEach((l, i) => {
      if (!cur && l.trimStart().startsWith('#')) return
      if (!cur) first = i + 1
      if (/\\$/.test(l)) { cur += l.replace(/\\$/, ' '); return }
      out.push([first, cur + l]); cur = ''
    })
    return out
  }
  /** where the quoted string that holds index i opens (-1: i is not inside quotes) */
  const openQuote = (line: string, i: number) => {
    let q = '', at = -1
    for (let k = 0; k < i; k++) {
      const c = line[k]!
      if (q) { if (c === q && (q === "'" || line[k - 1] !== '\\')) q = '' }
      else if (c === '"' || c === "'") { q = c; at = k }
    }
    return q ? at : -1
  }
  // a quoted string that is only a message (`die "… apt-get install jq …"`); `sh -c "apt-get install …"` is not
  const MESSAGE = /(?:^|[;&|({]\s*|\s)(?:echo|printf|die|warn|say|pk_err|note|err)(?:\s+-\S+)*\s+$/
  // package managers, with options before the command too (`apt-get -y -o X=Y install`, `$APT install`, `python3 -m pip install`)
  const INSTALL = /(?:\bapt(?:-get)?|\$\{?APT\}?|\b(?:dnf|yum|microdnf|zypper))((?:\s+(?:-o\s+\S+|-\S+))*)\s+install\b|\bapk((?:\s+-\S+)*)\s+add\b|\bbrew((?:\s+-\S+)*)\s+install\b|\b(?:pip3?|python3?\s+-m\s+pip)((?:\s+-\S+)*)\s+install\b/g
  const installsByName = (line: string): string[] => {
    const bad: string[] = []
    for (const m of line.matchAll(INSTALL)) {
      const q = openQuote(line, m.index!)
      if (q >= 0 && MESSAGE.test(line.slice(0, q))) continue
      const args = line.slice(m.index! + m[0].length).split(/\s*(?:\d?>|\|\||&&|;|\)|\|)/)[0]!.trim().split(/\s+/).filter(Boolean)
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (a === '-o') { i++; continue }
        if (a.startsWith('-') || a.startsWith('$') || a.startsWith('"$') || a.startsWith('${')) continue
        const n = a.replace(/["']/g, '')
        if (n) bad.push(n)
      }
    }
    return bad
  }

  test('the scanner sees through options, continuation lines, other package managers and commands in quotes', () => {
    expect(installsByName('apt-get -y -q -o Dpkg::Options::=--force-confold install podman crun')).toEqual(['podman', 'crun'])
    expect(installsByName('DEBIAN_FRONTEND=noninteractive apt install -y --no-install-recommends "$@" jq')).toEqual(['jq'])
    expect(installsByName('pk_apt_install -- "${PKGS[@]}" || apt-get install -y "${X[@]}"')).toEqual([])
    expect(installsByName('apt-get install --assume-no -o DPkg::Lock::Timeout=300 "$@" 2>/dev/null')).toEqual([])
    // messages may name a package; a command handed to another program may not
    expect(installsByName('die "jq is missing: apt-get install jq, then run this again"')).toEqual([])
    expect(installsByName('say "missing $t (apt-get install libguestfs-tools qemu-utils curl)"')).toEqual([])
    expect(installsByName('sh -c "apt-get install -y podman"')).toEqual(['podman'])
    expect(installsByName("virt-customize -a disk --run-command 'apt-get update && apt-get install -y jq'")).toEqual(['jq'])
    // other package managers and an apt in a variable
    expect(installsByName('$APT install curl')).toEqual(['curl'])
    expect(installsByName('${APT} -y install curl')).toEqual(['curl'])
    expect(installsByName('dnf -y install chromium')).toEqual(['chromium'])
    expect(installsByName('apk add --no-cache bash')).toEqual(['bash'])
    expect(installsByName('brew install jq')).toEqual(['jq'])
    expect(installsByName('python3 -m pip install --user httpie')).toEqual(['httpie'])
    expect(installsByName('pip3 install -r requirements.txt')).toEqual(['requirements.txt'])
    const c = commands('# apt-get install nothing\nRUN apt-get update && apt-get install -y \\\n    podman \\\n    crun\necho done\n')
    expect(c.map(([n, l]) => [n, installsByName(l)])).toEqual([[2, ['podman', 'crun']], [5, []], [6, []]])
  })

  test('no script or container file keeps a package list of its own (except the allowed few, with a reason)', () => {
    const files = scanned()
    for (const f of [...INSTALLERS, ...STAGERS, 'scripts/dev-env/vm-setup.sh', 'scripts/dev-env/Containerfile', 'docker/Dockerfile', 'docker/entrypoint.sh']) expect(files).toContain(f)
    for (const f of [...Object.keys(ALLOWED), ...Object.keys(PINS_ALLOWED)]) expect(`${f}: ${files.includes(f)}`).toBe(`${f}: true`) // no stale entry
    // no stale fragment: each names a command its file still has
    for (const [f, a] of [...Object.entries(ALLOWED), ...Object.entries(PINS_ALLOWED)]) {
      for (const x of a.lines) expect(`${f}: "${x}": ${commands(read(f)).some(([, l]) => l.includes(x))}`).toBe(`${f}: "${x}": true`)
    }
    // an allowed file is not a free pass: another command in it that installs by name is found
    expect(allowedBy(ALLOWED, 'tests/linux/Dockerfile', 'RUN apt-get install -y ripgrep poppler-utils')).toBe(false)
    expect(allowedBy(ALLOWED, 'tests/linux/Dockerfile', 'RUN apt-get update && apt-get install -y --no-install-recommends ripgrep poppler-utils procps')).toBe(true)
    const found: string[] = []
    for (const f of files) {
      for (const [n, l] of commands(read(f))) {
        if (allowedBy(ALLOWED, f, l)) continue
        const hits = [...names].filter((p) => word(p).test(l))
        if (hits.length >= 3) found.push(`${f}:${n}: ${hits.join(' ')}`)
        for (const a of installsByName(l)) if (!NAMES_ALLOWED[f]?.names.includes(a)) found.push(`${f}:${n}: installs "${a}" by name`)
      }
    }
    expect(found).toEqual([])
  })


  test('the Docker image: the list read in bash; the always and docker groups by default; fonts and the browser only by build argument', () => {
    const d = read('docker/Dockerfile')
    const shell = d.indexOf('SHELL ["/bin/bash", "-c"]'), source = d.indexOf('. "$root/packages.sh"')
    expect(shell).toBeGreaterThan(0)
    expect(shell).toBeLessThan(source) // sh (dash) cannot source packages.sh
    expect(d).toContain('ARG TRINA_AX_PACKAGE_GROUPS=""')
    expect(d).toContain('groups="minimal docker"; \\')
    expect(d).toContain('case "$g" in fonts|browser) groups="$groups $g" ;; *) echo "TRINA_AX_PACKAGE_GROUPS: $g is not an optional group here')
    expect(d).toContain('pk_browser_install /opt/trina/chrome-headless-shell "linux-$(pk_arch)"')
    // the Google Workspace library is in the default image (when the kit's list has its group)
    expect(d).toContain('if pk_groups google-apps >/dev/null 2>&1; then groups="$groups google-apps"; fi')
    expect(d).toContain('for p in $(pk_pythons $groups); do pk_python_install "/opt/trina/python/$p" "$p" >/dev/null; done')
    expect(pythonsFor(LIST, ['minimal', 'docker', 'google-apps'])).toEqual(['workspace-mcp'])
    expect(read('docker/entrypoint.sh')).toContain('--skip-apt --no-auto-update --minimal')
    // by default no browser group: what the always and docker groups install has no browser library of its own
    expect(groupsFor(LIST, ['minimal', 'docker'])).not.toContain('browser')
  })

  test('a test container that pins node pins the list\'s', () => {
    const t = read('tests/linux/Dockerfile.srt'), node = LIST.artifacts.node!
    for (const p of ['linux-amd64', 'linux-arm64']) expect(t).toContain(node.platforms[p]!.sha256)
    expect(t).toContain(`v${node.version}`)
  })

  test('no script or container file pins a download of its own (except the allowed few, with a reason)', () => {
    const found: string[] = []
    for (const f of scanned()) {
      for (const [n, l] of commands(read(f))) {
        if (allowedBy(PINS_ALLOWED, f, l)) continue
        const h = l.match(/(?<![0-9A-Za-z])[0-9a-f]{64}(?![0-9A-Za-z])/)
        if (h) found.push(`${f}:${n}: sha256 ${h[0].slice(0, 12)}…`)
        for (const u of ['nodejs.org/dist', 'chrome-for-testing', 'registry.npmjs.org']) if (l.includes(u)) found.push(`${f}:${n}: ${u}`)
        if (/\b(NODE|SRT|BROWSER|CHROME)_VERSION=[0-9]/.test(l)) found.push(`${f}:${n}: a version of its own`)
      }
    }
    expect(found).toEqual([])
  })

  test('both readers are compared in CI: jq must be there', () => {
    if (process.env.CI) expect(`jq on PATH: ${!!JQ}`).toBe('jq on PATH: true')
  })

  test('no pinned download of their own: versions, urls and hashes come from the list', () => {
    for (const f of INSTALLERS) {
      const code = codeLines(f).map(([, l]) => l).join('\n')
      expect(`${f}: ${code.match(/\b[0-9a-f]{64}\b/)?.[0] ?? 'none'}`).toBe(`${f}: none`)
      for (const u of ['nodejs.org/dist', 'chrome-for-testing', 'registry.npmjs.org']) expect(`${f}: ${code.includes(u)}`).toBe(`${f}: false`)
      expect(code).not.toMatch(/\b(NODE|SRT|BROWSER|CHROME)_VERSION=[0-9]/)
    }
  })

  test('each installer sources packages.sh and reads the list; each stager copies it', () => {
    for (const f of INSTALLERS) {
      const s = read(f)
      expect(`${f}: ${/^\s*\. "\$[A-Za-z_{}/.]*packages\.sh"$/m.test(s)}`).toBe(`${f}: true`)
      expect(`${f}: ${s.includes('pk_load ')}`).toBe(`${f}: true`)
    }
    // the stagers copy the list: test-customize.sh the checkout's, build.sh and build-ami.sh the kit's (the same bytes as
    // the checkout's, or the build stops)
    for (const f of STAGERS) expect(`${f}: ${/scripts\/system\/packages\.sh"? "?\$?[A-Za-z_{}/.]*packages\.json/.test(read(f)) || read(f).includes('$HERE/../system/packages.sh')
      || read(f).includes('cp -p "$SYS_SRC/packages.sh" "$SYS_SRC/packages.json" "$STAGE/system/"')}`).toBe(`${f}: true`)
    // build-ami.sh and test-customize.sh also give the staged dev-env-srt folder its copy (install-srt.sh --image-mode, --boot)
    for (const f of ['scripts/image/build-ami.sh', 'scripts/image/test-customize.sh']) expect(read(f)).toContain('dev-env-srt/system')
  })

  test('the image installs the default groups of a self-hosted install, plus its own groups', () => {
    const custom = read('scripts/image/customize.sh')
    // the kit's installer, as a self-hosted install without --minimal (and with apt)
    const kitRun = custom.split('\n').find((l) => l.includes('./install-linux.sh install'))!
    expect(kitRun).toBeDefined()
    expect(kitRun).not.toMatch(/--minimal|--skip-apt/)
    // customize.sh's own packages are the image group, nothing else
    expect([...custom.matchAll(/pk_packages [^\n|)]*/g)].map((m) => m[0].trim())).toEqual(['pk_packages "$DISTRO" "$ARCH" image'])
    expect(custom).toContain('pk_removals image')
    const inst = read('scripts/install-linux.sh')
    expect(inst).toContain('LIST_OK=0 PROFILE=default DISTRO=""\n[ "$MINIMAL" = 0 ] || PROFILE=minimal')
    expect(inst).toContain('pk_packages "$DISTRO" "$ARCH" "$PROFILE"')
    expect(inst).toContain('pk_artifacts "$PROFILE" | grep -qx chrome-headless-shell')
    expect(inst).toContain('for PY in $(pk_pythons "$PROFILE"); do')
    expect(inst).toContain('if PYPATH=$(pk_python_install "$PK_OPT/python/$PY" "$PY"); then')
    expect(read('scripts/system/packages.sh')).toContain('if path=$(pk_python_install "$PK_OPT/python/$p" "$p"); then')
    // install-srt.sh (the image with --srt, and a server that turns the dev environment on) installs default groups only
    const srtGroups = /^PKG_GROUPS="([^"]*)"$/m.exec(read('scripts/dev-env/srt/install-srt.sh'))![1]!.split(' ')
    for (const g of srtGroups) expect(groupsFor(LIST, ['default'])).toContain(g)
    // so on the image's system the only packages a self-hosted default install lacks are the image group's
    expect(LIST.distros['debian-13']).toBeDefined()
    for (const a of LIST.arches) {
      const selfHosted = packagesFor(LIST, 'debian-13', a, ['default'])
      const image = new Set([...packagesFor(LIST, 'debian-13', a, ['image']), ...selfHosted, ...packagesFor(LIST, 'debian-13', a, srtGroups)])
      expect(selfHosted.filter((p) => !image.has(p))).toEqual([])
      expect([...image].filter((p) => !selfHosted.includes(p) && !packagesFor(LIST, 'debian-13', a, ['image']).includes(p))).toEqual([])
    }
  })

  test('install-linux.sh accepts exactly the list\'s systems', () => {
    const m = /case "\$OSID:\$OSVER" in ([^)]*)\) OS_OK=1/.exec(read('scripts/install-linux.sh'))
    expect(m).not.toBeNull()
    expect(m![1]!.split('|').sort()).toEqual(Object.values(LIST.distros).map((d) => `${d.id}:${d.version}`).sort())
    expect(read('scripts/install-linux.sh')).toContain('DISTRO=$(pk_distro "$OSID" "$OSVER") || die')
  })

  test('srt: one version in the list, the server, package.json and the lockfile', () => {
    const srt = LIST.artifacts.srt!
    expect(srt.version).toBe(SRT_VERSION)
    expect(JSON.parse(read('scripts/dev-env/srt/package.json')).dependencies['@anthropic-ai/sandbox-runtime']).toBe(srt.version)
    const lock = JSON.parse(read('scripts/dev-env/srt/package-lock.json')).packages['node_modules/@anthropic-ai/sandbox-runtime']
    expect(lock.version).toBe(srt.version)
    expect(lock.resolved).toBe(srt.platforms.any!.url)
  })
})

describe('updates carry the list', () => {
  test('a root file of every Linux bundle, so a changed list (a new browser too) is a root change', () => {
    expect(LINUX_ROOT_SCRIPTS).toContainEqual(['scripts/system/packages.json', 'packages.json'])
    expect(LINUX_ROOT_SCRIPTS).toContainEqual(['scripts/system/packages.sh', 'packages.sh'])
    const files = linuxBundleFiles({ arch: 'amd64', codexVersion: '0.163.0', whisper: false, systemd: [] })
    expect(files).toContain('root/packages.json')
    expect(files).toContain('root/packages.sh')
    expect(files).toContain('root/packages.flat')
    expect(files).not.toContain('deps.txt')
    // publish-server.ts compares root-managed files with the channel heads' manifests (needsRoot, rootSince)
    for (const f of ['root/packages.json', 'root/packages.sh', 'root/packages.flat']) expect(rootManaged(f)).toBe(true)
    // mycel-ctl update syncs after the root files and the app, and whenever root/packages.synced is not of the list in
    // root/ (native/cmd/mycel-ctl/sync.go, syncsystem_test.go); install-linux.sh writes the record and the root files
    expect(read('native/cmd/mycel-ctl/update.go')).toContain('defer u.syncAfter()')
    const inst = read('scripts/install-linux.sh')
    expect(inst).toContain('for f in packages.json packages.flat packages.sh; do [ ! -f "$KROOT/$f" ] || rootfile 644 "$f"; done')
    expect(inst).toContain('pk_write_synced "$BASE/root/packages.synced"')
  })

  test('root/packages.json is the Linux copy: a Mac-only change of the list changes no root byte (PR #164 question 7)', () => {
    const text = read('scripts/system/packages.json')
    const lin = linuxList(text)
    const l = JSON.parse(lin) as PackageList
    expect(lin).not.toContain('darwin-')
    expect(listProblems(l, { linux: true })).toEqual([])
    expect(listProblems(l).join()).toContain('no darwin-arm64')
    // what a Linux server reads is the list's: groups, distros, arches, the linux and "any" downloads
    expect(l.groups).toEqual(LIST.groups)
    expect(l.distros).toEqual(LIST.distros)
    for (const [n, a] of Object.entries(LIST.artifacts)) {
      expect(l.artifacts[n]!.version).toBe(a.version)
      for (const [p, f] of Object.entries(a.platforms)) if (!p.startsWith('darwin-')) expect(l.artifacts[n]!.platforms[p]).toEqual(f)
    }
    for (const lnx of ['linux-amd64', 'linux-arm64']) expect(packagesFor(l, 'debian-13', lnx.slice(6), ['default'])).toEqual(packagesFor(LIST, 'debian-13', lnx.slice(6), ['default']))
    // an office Mac's download changes (and the notes): the Linux copy and its flat file stay byte for byte the same
    const mac = JSON.parse(text) as PackageList
    const b = mac.artifacts['chrome-headless-shell']!
    b.platforms['darwin-arm64'] = { ...b.platforms['darwin-arm64']!, sha256: 'a'.repeat(64), size: 1 }
    b.platforms['darwin-amd64'] = { ...b.platforms['darwin-amd64']!, sha256: 'b'.repeat(64), url: b.platforms['darwin-amd64']!.url.replace('.zip', '-2.zip') }
    mac._about = ['changed']
    const macText = JSON.stringify(mac, null, 2)
    expect(macText).not.toBe(text)
    expect(linuxList(macText)).toBe(lin)
    expect(flatFile(linuxList(macText))).toBe(flatFile(lin))
    // a Linux change is a root change
    const linux = JSON.parse(text) as PackageList
    linux.artifacts['chrome-headless-shell']!.platforms['linux-amd64']!.sha256 = 'c'.repeat(64)
    expect(linuxList(JSON.stringify(linux))).not.toBe(lin)
    const pkg = JSON.parse(text) as PackageList
    pkg.groups.media!.packages!.ffmpeg = '>=7:5.2'
    expect(linuxList(JSON.stringify(pkg))).not.toBe(lin)
    // build-bundle.ts writes it (and the flat copy of it); the CLI prints the same bytes for the image builds' check
    const bb = read('scripts/build-bundle.ts')
    expect(bb).toContain("fs.writeFileSync(path.join(root, 'packages.json'), linuxList(fs.readFileSync(path.join(REPO, 'scripts', 'system', 'packages.json'), 'utf8')))")
    expect(bb.indexOf("linuxList(fs.readFileSync")).toBeLessThan(bb.indexOf("path.join(root, 'packages.flat')"))
    const cli = Bun.spawnSync([process.execPath, path.join(REPO, 'scripts/system/packages.ts'), 'linux'], { stdout: 'pipe', stderr: 'pipe' })
    expect(cli.exitCode).toBe(0)
    expect(cli.stdout.toString()).toBe(lin)
  })

  test('a bundle\'s flat copy is the list\'s: its first line names the list\'s sha256', () => {
    const text = read('scripts/system/packages.json')
    const f = flatFile(text)
    expect(f.split('\n')[0]).toBe(`#sha256 ${new Bun.CryptoHasher('sha256').update(text).digest('hex')}`)
    expect(f.split('\n').slice(1).join('\n').trimEnd()).toBe(flatLines(LIST))
  })

  test('the office zip carries it, and its installer puts the browser outside app/', () => {
    const m = bundleManifest({ pandoc: true, desktop: false })
    expect(m).toContain('app/scripts/system/packages.json')
    expect(m).toContain('app/scripts/system/packages.sh')
    const s = read('scripts/office/office-install.sh')
    expect(s).toMatch(/for p in server scripts /) // app/scripts (with system/) is copied into the installed app
    expect(s).toContain('BROWSER_DIR="$PREFIX/browser/chrome-headless-shell"')
    expect(read('scripts/office/office-uninstall.sh')).toContain('"$PREFIX/browser"')
  })

  test('the office server gets MYCEL_HTML_PDF_BROWSER when the browser is there, unless the environment names one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-office-'))
    const p = officePaths(home)
    expect(p.browser).toBe(path.join(home, 'browser', 'chrome-headless-shell', 'current', 'chrome-headless-shell'))
    expect(officeBrowserEnv(p, {})).toBeNull()
    fs.mkdirSync(path.dirname(p.browser), { recursive: true })
    fs.writeFileSync(p.browser, '', { mode: 0o755 })
    expect(officeBrowserEnv(p, {})).toBe(p.browser)
    expect(officeBrowserEnv(p, { MYCEL_HTML_PDF_BROWSER: 'none' })).toBeNull()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('Admin › System › Diagnostics says where the sync of the list in root/ stands, and who does it next', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-diag-'))
    const when = (iso: string) => `[${iso}]`
    // no system files: the records below carry no "os", as on this test's machine (the os check has its own test)
    const noOs = { osRelease: path.join(root, 'no-os-release'), machineId: path.join(root, 'no-machine-id') }
    const o = { by: 'timer' as const, when, os: noOs }
    expect(systemPackagesDiagnostic(null, o)).toBeNull()
    expect(systemPackagesDiagnostic(root, o)).toBeNull() // a server from before the list
    const list = '{"format":1}'
    fs.writeFileSync(path.join(root, 'packages.json'), list)
    const sum = new Bun.CryptoHasher('sha256').update(list).digest('hex')
    const at = (r: Record<string, string>, by: SyncBy = 'timer') => { fs.writeFileSync(path.join(root, 'packages.synced'), JSON.stringify({ format: 1, list: sum, at: '2026-11-07T03:12:00Z', ...r })); return systemPackagesDiagnostic(root, { by, when, os: noOs })! }
    expect(systemPackagesDiagnostic(root, o)).toEqual({ status: 'warn', text: SYSTEM_PACKAGES_TEXT.pending('timer') }) // never synced
    expect(at({ result: 'ok', browser: '157.0.8103.38' })).toEqual({ status: 'ok', text: SYSTEM_PACKAGES_TEXT.ok('[2026-11-07T03:12:00Z]', '157.0.8103.38') })
    expect(at({ result: 'ok', list: 'other' }).text).toEqual(SYSTEM_PACKAGES_TEXT.pending('timer'))
    expect(at({ result: 'blocked', detail: 'missing: socat' })).toEqual({ status: 'warn', text: SYSTEM_PACKAGES_TEXT.blocked('missing: socat') })
    expect(at({ result: 'incomplete', detail: 'download' }).text.en).toBe('The try at [2026-11-07T03:12:00Z] did not finish: download. The update timer tries again after some hours; now: sudo mycel-ctl update')
    // no "the update timer does it" where there is no timer: automatic updates off, a hosted team VM
    expect(at({ result: 'ok', list: 'other' }, 'admin').text.en).toBe('Not yet brought to this version\'s list. Automatic updates are off, so nothing does it by itself: sudo mycel-ctl update')
    expect(at({ result: 'ok', list: 'other' }, 'hosted').text.en).toBe('Not yet brought to this version\'s list. The hosting service\'s next update does it.')
    expect(at({ result: 'incomplete', detail: 'download' }, 'hosted').text.en).not.toContain('timer')
    for (const by of ['timer', 'admin', 'hosted'] as const) for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      expect(SYSTEM_PACKAGES_TEXT.pending(by)[l].length).toBeGreaterThan(10)
      expect(SYSTEM_PACKAGES_TEXT.ok('t', 'v')[l]).toContain('v')
    }
    // ops.ts formats the record's time in the team's zone, never the raw ISO
    expect(read('server/src/system/ops.ts')).toContain('const sp = systemPackagesDiagnostic(this.layout.rootDir, { by, when })')
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('the rule', () => {
  test('repository rules and the agents\' instructions name the list', () => {
    for (const f of ['docs/REPOSITORY-RULES.md', 'CLAUDE.md']) expect(`${f}: ${read(f).includes('scripts/system/packages.json')}`).toBe(`${f}: true`)
  })
})
