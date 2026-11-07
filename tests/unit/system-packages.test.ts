// The one list of system packages and downloaded programs (scripts/system/packages.json, docs/DECISIONS.md "One list of
// system packages"): the hosted image, a self-hosted Linux server, the dev environment and an office Mac all install from
// it. This is the CI check that fails when they disagree: the list is well formed, every artifact has a version and a
// sha256 for every platform, the two readers of packages.sh (bun, jq) read the same thing, no install or image script
// keeps a list or a pinned download of its own, and the image installs the installer's default groups.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { flatLines, groupsFor, listProblems, packagesFor, readList, REQUIRED_PLATFORMS, type PackageList } from '../../scripts/system/packages'
import { LINUX_ROOT_SCRIPTS, linuxBundleFiles } from '../../scripts/build-bundle'
import { bundleManifest } from '../../scripts/build-office'
import { rootManaged } from '../../scripts/release/publish-server'
import { SRT_VERSION } from '../../server/src/devenv/srt/config'
import { officeBrowserEnv } from '../../server/src/office/cli'
import { officePaths } from '../../server/src/office/settings'

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
    ]
    for (const [name, change, want] of cases) {
      const l = clone()
      change(l)
      expect(`${name}: ${listProblems(l).join('; ')}`).toMatch(want)
    }
  })

  test('the always groups are what every install needs; the image and the dev environment groups are on request', () => {
    expect(groupsFor(LIST, ['minimal'])).toEqual(['core', 'documents', 'media'])
    expect(groupsFor(LIST, ['default'])).toEqual(['core', 'documents', 'media', 'fonts', 'devenv', 'browser'])
    for (const g of ['image', 'srt', 'boxes']) expect(LIST.groups[g]!.install).toBe('on-request')
    expect(LIST.groups.browser!.artifacts).toEqual(['chrome-headless-shell'])
    expect(LIST.groups.srt!.artifacts).toEqual(['node', 'srt'])
    // no SSH server on a team VM (D15)
    expect(LIST.groups.image!.remove).toEqual(['openssh-server', 'openssh-sftp-server'])
  })
})

describe('packages.sh reads the list', () => {
  test('syntax', () => {
    for (const f of ['scripts/system/packages.sh', ...INSTALLERS, ...STAGERS, 'scripts/image/ami-chroot.sh', 'scripts/office/office-uninstall.sh']) {
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
    const sets = [['minimal'], ['default'], ['image'], ['srt'], ['boxes'], ['core', 'media', 'fonts', 'devenv']]
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
    expect(sh(['packages', ...bun, '--distro', 'debian-13', '--arch', 'arm64', 'minimal']).out.trim().split('\n')).toEqual(packagesFor(LIST, 'debian-13', 'arm64', ['minimal']))
    // apparmor only where the kernel restricts user namespaces (Ubuntu 24.04), t64 names only where the release has them
    expect(packagesFor(LIST, 'ubuntu-24.04', 'amd64', ['minimal'], { usernsRestricted: true })).toContain('apparmor')
    expect(packagesFor(LIST, 'debian-13', 'amd64', ['minimal'])).not.toContain('apparmor')
    expect(packagesFor(LIST, 'debian-12', 'arm64', ['browser'])).toContain('libasound2')
    expect(packagesFor(LIST, 'debian-13', 'arm64', ['browser'])).toContain('libasound2t64')
    expect(packagesFor(LIST, 'ubuntu-24.04', 'amd64', ['devenv'])).not.toContain('chromium') // a snap there
    expect(sh(['groups', ...bun, 'nosuch']).err).toContain('no group or profile "nosuch"')
  })

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

  test('the browser: switches to the pinned version it has, removes the others, downloads nothing then', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-browser-'))
    const dest = path.join(d, 'chrome-headless-shell')
    const a = LIST.artifacts['chrome-headless-shell']!, f = a.platforms['linux-amd64']!
    fs.mkdirSync(path.join(dest, a.version, f.dir!), { recursive: true })
    fs.writeFileSync(path.join(dest, a.version, f.dir!, 'chrome-headless-shell'), '#!/bin/sh\necho "Google Chrome for Testing 1.2.3"\n', { mode: 0o755 })
    fs.writeFileSync(path.join(dest, a.version, '.sha256'), f.sha256 + '\n')
    fs.mkdirSync(path.join(dest, '150.0.1.2', 'x'), { recursive: true })
    fs.mkdirSync(path.join(dest, '.new.abc123'))
    fs.symlinkSync('150.0.1.2/x', path.join(dest, 'current'))
    // a curl that must not run
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\necho "curl ran" >&2\nexit 9\n', { mode: 0o755 })
    const r = lib(`pk_load; p=$(PK_UNAME_S=Linux pk_browser_install "${dest}" linux-amd64); echo "$p"; pk_browser_check "$p" && echo runs`, { PK_BUN: process.execPath, PATH: `${bin}:${PATH}` })
    expect(r.err).toBe('')
    expect(r.out.trim().split('\n')).toEqual([path.join(dest, 'current', 'chrome-headless-shell'), 'runs'])
    expect(fs.readlinkSync(path.join(dest, 'current'))).toBe(`${a.version}/${f.dir}`)
    expect(fs.readdirSync(dest).sort()).toEqual([a.version, 'current'].sort())
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('the browser: a download with another sha256 leaves nothing; only https; no hash, no download', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-fetch-'))
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin)
    // a curl that "downloads" other bytes (a mirror or a person in the middle)
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { echo other > "$2"; shift; }; shift; done\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'unzip'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const dest = path.join(d, 'chrome-headless-shell')
    const r = lib(`pk_load; PK_UNAME_S=Linux pk_browser_install "${dest}" linux-arm64 || echo failed
pk_fetch http://example.com/x "${'a'.repeat(64)}" "" "${d}/x" || echo http-refused
pk_fetch https://example.com/x "" "" "${d}/x" || echo no-hash-refused`, { PK_BUN: process.execPath, PATH: `${bin}:${PATH}` })
    expect(r.out.trim().split('\n')).toEqual(['failed', 'http-refused', 'no-hash-refused'])
    expect(r.err).toContain('the list pins')
    expect(fs.readdirSync(dest)).toEqual([]) // no .new.* left, no version, no current
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('/etc/default/<id>: one line of ours, every other line kept, an empty file removed', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-env-'))
    const f = path.join(d, 'mycel')
    fs.writeFileSync(f, 'MYCEL_TEAM_TZ=Asia/Seoul\nMYCEL_HTML_PDF_BROWSER=/old\nMYCEL_SAFE_OPS_1A=1\n')
    expect(lib(`pk_set_env "${f}" MYCEL_HTML_PDF_BROWSER /opt/trina/chrome-headless-shell/current/chrome-headless-shell`).code).toBe(0)
    expect(fs.readFileSync(f, 'utf8')).toBe('MYCEL_TEAM_TZ=Asia/Seoul\nMYCEL_SAFE_OPS_1A=1\nMYCEL_HTML_PDF_BROWSER=/opt/trina/chrome-headless-shell/current/chrome-headless-shell\n')
    expect(lib(`pk_set_env "${f}" MYCEL_HTML_PDF_BROWSER ""`).code).toBe(0)
    expect(fs.readFileSync(f, 'utf8')).toBe('MYCEL_TEAM_TZ=Asia/Seoul\nMYCEL_SAFE_OPS_1A=1\n')
    fs.writeFileSync(f, 'MYCEL_HTML_PDF_BROWSER=/x\n')
    expect(lib(`pk_set_env "${f}" MYCEL_HTML_PDF_BROWSER ""`).code).toBe(0)
    expect(fs.existsSync(f)).toBe(false)
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('sync (mycel-ctl update) needs an id and a base', () => {
    expect(sh(['sync']).code).toBe(2)
    expect(sh(['sync', '--id', 'Bad Id', '--base', '/x']).code).toBe(2)
  })
})

describe('every install path reads the list', () => {
  const names = new Set(Object.values(LIST.groups).flatMap((g) => [...Object.keys(g.packages ?? {}), ...(g.remove ?? [])]))
  const word = (n: string) => new RegExp(`(?<![A-Za-z0-9.+_/-])${n.replace(/[.+]/g, '\\$&')}(?![A-Za-z0-9.+_/-])`)

  test('no install or image script keeps a package list of its own', () => {
    const found: string[] = []
    for (const f of [...INSTALLERS, ...STAGERS, 'scripts/image/ami-chroot.sh']) {
      for (const [n, l] of codeLines(f)) {
        const hits = [...names].filter((p) => word(p).test(l))
        if (hits.length >= 3) found.push(`${f}:${n}: ${hits.join(' ')}`)
        // apt-get install / apt install: every package argument comes from a variable (the list), never a name
        for (const m of l.matchAll(/\bapt(?:-get)? install\b/g)) {
          if ((l.slice(0, m.index).match(/"/g) ?? []).length % 2) continue // inside a message
          const args = l.slice(m.index! + m[0].length).split(/\s*(?:>|\|\||&&|;|\))/)[0]!.trim().split(/\s+/).filter(Boolean)
          for (let i = 0; i < args.length; i++) {
            const a = args[i]!
            if (a === '-o') { i++; continue }
            if (a.startsWith('-') || a.startsWith('$') || a.startsWith('"$') || a.startsWith('${') || a === '\\') continue
            found.push(`${f}:${n}: apt installs "${a}" by name`)
          }
        }
      }
    }
    expect(found).toEqual([])
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
    for (const f of STAGERS) expect(`${f}: ${/scripts\/system\/packages\.sh"? "?\$?[A-Za-z_{}/.]*packages\.json/.test(read(f)) || read(f).includes('$HERE/../system/packages.sh')}`).toBe(`${f}: true`)
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
    expect(files).not.toContain('deps.txt')
    // publish-server.ts compares root-managed files with the channel heads' manifests (needsRoot, rootSince)
    expect(rootManaged('root/packages.json')).toBe(true)
    expect(rootManaged('root/packages.sh')).toBe(true)
    // mycel-ctl update runs packages.sh sync once the root files are in place (native/cmd/mycel-ctl/syncsystem_test.go)
    expect(read('native/cmd/mycel-ctl/update.go')).toContain('u.syncSystem(dir)')
  })

  test('the office zip carries it, and its installer puts the browser outside app/', () => {
    const m = bundleManifest({ pandoc: true, desktop: false })
    expect(m).toContain('app/scripts/system/packages.json')
    expect(m).toContain('app/scripts/system/packages.sh')
    const s = read('scripts/office/office-install.sh')
    expect(s).toMatch(/for p in server scripts /) // app/scripts (with system/) is copied into the installed app
    expect(s).toContain('pk_browser_install "$PREFIX/browser/chrome-headless-shell" "$plat"')
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
})

describe('the rule', () => {
  test('repository rules and the agents\' instructions name the list', () => {
    for (const f of ['docs/REPOSITORY-RULES.md', 'CLAUDE.md']) expect(`${f}: ${read(f).includes('scripts/system/packages.json')}`).toBe(`${f}: true`)
  })
})
