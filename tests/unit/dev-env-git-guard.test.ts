// Git in a run (QA TC-4939): a member's run that made a repository in the project folder could plant a hook or a
// config program there, and another member's later git command ran it with that member's access and home. The fix
// (server/src/devenv/srt/git-guard.ts): every run's environment switches off repository hooks and what git takes from
// config where it can, and a git wrapper first on the run's PATH asks the real git for the repository's settings on
// every call and refuses one that names a program. Each bypass of the first version (review of #1297) is a case here
// and in tests/linux/srt-attack.ts (G5-G11). Real git of this machine; the wrapper runs under node (or bun).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dangerousGitSetting, gitEnv, gitWrapperSource } from '../../server/src/devenv/srt/git-guard'
import { personHome, projectHome, runEnv } from '../../server/src/devenv/srt/config'

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)))
const which = (b: string) => new TextDecoder().decode(Bun.spawnSync(['/usr/bin/which', b]).stdout).trim()
const REAL = which('git'), NODE = which('node') || process.execPath
const BIN = tmp('gg-bin-')
fs.writeFileSync(path.join(BIN, 'git'), gitWrapperSource({ node: NODE, realGit: REAL }), { mode: 0o755 })
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
/** git as a run calls it: the wrapper first on PATH, the run's git settings */
function runGit(cwd: string, args: string[], home: string) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { PATH: `${BIN}:${process.env.PATH}`, HOME: home, ...gitEnv() } })
  return { code: r.exitCode, out: dec(r.stdout) + dec(r.stderr) }
}
/** the real git with no settings of ours: shows that a planted case really runs */
const plainGit = (cwd: string, args: string[], home: string) => Bun.spawnSync([REAL, ...args], { cwd, env: { PATH: process.env.PATH!, HOME: home } })
const COMMIT = ['-c', 'user.name=a', '-c', 'user.email=a@example.com', 'commit', '-q', '--allow-empty', '-m', 'x']
function repo() {
  const d = tmp('gg-repo-'), home = tmp('gg-home-')
  plainGit(d, ['init', '-q'], home)
  return { d, home, mark: path.join(home, 'RAN') }
}
const evil = (mark: string) => { const f = path.join(path.dirname(mark), 'evil.sh'); fs.writeFileSync(f, `#!/bin/sh\ntouch ${mark}\ncat\n`, { mode: 0o755 }); return f }

describe('the environment of every run', () => {
  test('a planted pre-commit hook: plain git runs it, a run\'s git does not (the repro)', () => {
    const { d, home, mark } = repo()
    fs.writeFileSync(path.join(d, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 })
    plainGit(d, COMMIT, home)
    expect(fs.existsSync(mark)).toBe(true)
    fs.rmSync(mark)
    expect(runGit(d, COMMIT, home).code).toBe(0)
    expect(fs.existsSync(mark)).toBe(false)
  })
  test('a ~/.gitconfig in the run\'s home is not read; npm, pip and Python read nothing from it; no bare repository by itself', () => {
    const { d, home } = repo()
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = PLANTED\n')
    expect(dec(plainGit(d, ['config', 'user.name'], home).stdout)).toContain('PLANTED')
    expect(runGit(d, ['config', 'user.name'], home).out).not.toContain('PLANTED')
    expect(gitEnv()).toMatchObject({ NPM_CONFIG_USERCONFIG: '/dev/null', PIP_CONFIG_FILE: '/dev/null', PYTHONNOUSERSITE: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
    const e = gitEnv()
    const pairs = Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => `${e[`GIT_CONFIG_KEY_${i}`]}=${e[`GIT_CONFIG_VALUE_${i}`]}`)
    expect(pairs).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', 'safe.bareRepository=explicit', 'credential.helper=']))
  })
  test('the wrapper is first on a run\'s PATH', () => {
    const env = runEnv({ base: '/var/lib/mycel', userId: 'alice', teamRoot: '/var/lib/mycel/team', work: null, platform: 'linux' })
    expect(env.PATH.split(':')[0]).toBe('/var/lib/mycel/devenv/bin')
  })
})

describe('the git wrapper refuses a repository whose settings name a program (review of #1297)', () => {
  const refused = (r: { code: number | null; out: string }, what: string) => {
    expect(r.code).toBe(128)
    expect(r.out).toContain('git was refused')
    expect(r.out).toContain(what)
  }
  test('G5: a section header and its setting on one line', () => {
    const { d, home, mark } = repo()
    fs.appendFileSync(path.join(d, '.git/config'), `[diff "x"] textconv = ${evil(mark)}\n`)
    fs.writeFileSync(path.join(d, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(d, '.gitattributes'), '*.txt diff=x\n')
    plainGit(d, ['add', '.'], home); plainGit(d, COMMIT, home); fs.writeFileSync(path.join(d, 'a.txt'), 'two\n')
    plainGit(d, ['diff'], home)
    expect(fs.existsSync(mark)).toBe(true) // git reads it: the case is real
    fs.rmSync(mark)
    refused(runGit(d, ['diff'], home), 'diff.textconv')
    expect(fs.existsSync(mark)).toBe(false)
  })
  test('G6: .git is a link to a repository elsewhere', () => {
    const { d: real, home, mark } = repo()
    fs.appendFileSync(path.join(real, '.git/config'), `[filter "f"]\n\tclean = ${evil(mark)}\n`)
    const d = tmp('gg-link-'); fs.symlinkSync(path.join(real, '.git'), path.join(d, '.git'))
    refused(runGit(d, ['status'], home), 'filter')
  })
  test('G7: a bare repository folder: not used by itself, and refused when named', () => {
    const d = tmp('gg-bare-'), home = tmp('gg-home-')
    plainGit(d, ['init', '-q', '--bare', 'b.git'], home)
    fs.appendFileSync(path.join(d, 'b.git/config'), '[core]\n\talternateRefsCommand = /bin/true\n')
    const inside = runGit(path.join(d, 'b.git'), ['log'], home)
    expect(inside.code).not.toBe(0)
    refused(runGit(d, ['--git-dir=b.git', 'log'], home), 'core.alternaterefscommand')
  })
  test('G8: submodule.<name>.update = !command', () => {
    const { d, home } = repo()
    fs.appendFileSync(path.join(d, '.git/config'), '[submodule "s"]\n\tupdate = !touch /tmp/x\n')
    refused(runGit(d, ['status'], home), 'submodule.update')
  })
  test('G9: core.alternateRefsCommand, a "!" alias, a credential helper, an include that brings a filter', () => {
    for (const [cfg, what] of [['[core]\n\talternateRefsCommand = /bin/true\n', 'core.alternaterefscommand'], ['[alias]\n\tst = !touch /tmp/x\n', 'alias'], ['[credential]\n\thelper = !touch /tmp/x\n', 'credential.helper']] as const) {
      const { d, home } = repo()
      fs.appendFileSync(path.join(d, '.git/config'), cfg)
      refused(runGit(d, ['status'], home), what)
    }
    const { d, home } = repo()
    fs.writeFileSync(path.join(d, 'inc.cfg'), '[filter "f"]\n\tsmudge = /bin/true\n')
    fs.appendFileSync(path.join(d, '.git/config'), '[include]\n\tpath = ../inc.cfg\n')
    refused(runGit(d, ['status'], home), 'filter')
  })
  test('G10: no depth limit: a repository planted twelve folders down is checked when git is used there; an absorbed submodule\'s config too', () => {
    const top = tmp('gg-deep-'), home = tmp('gg-home-')
    const deep = path.join(top, ...Array.from({ length: 12 }, (_, i) => `d${i}`))
    fs.mkdirSync(deep, { recursive: true })
    plainGit(deep, ['init', '-q'], home)
    fs.appendFileSync(path.join(deep, '.git/config'), '[filter "f"]\n\tclean = /bin/true\n')
    refused(runGit(deep, ['status'], home), 'filter')
    const { d } = repo()
    fs.mkdirSync(path.join(d, '.git/modules/sub'), { recursive: true })
    fs.writeFileSync(path.join(d, '.git/modules/sub/HEAD'), 'ref: refs/heads/main\n')
    fs.writeFileSync(path.join(d, '.git/modules/sub/config'), '[filter "f"]\n\tclean = /bin/true\n')
    refused(runGit(d, ['status'], home), 'a submodule')
  })
  test('G11: a setting written after the run started is seen at the next call', () => {
    const { d, home } = repo()
    expect(runGit(d, ['status'], home).code).toBe(0)
    fs.appendFileSync(path.join(d, '.git/config'), '[filter "f"]\n\tclean = /bin/true\n')
    refused(runGit(d, ['status'], home), 'filter')
  })
  test('the settings cannot be listed while there is a repository: refused (fail closed)', () => {
    // a wrapper that can take at most 1 KiB of settings, and a repository with more (harmless ones)
    const bin = tmp('gg-bin-small-')
    fs.writeFileSync(path.join(bin, 'git'), gitWrapperSource({ node: NODE, realGit: REAL, maxListBytes: 1024 }), { mode: 0o755 })
    const { d, home } = repo()
    fs.appendFileSync(path.join(d, '.git/config'), '[branch "b"]\n' + Array.from({ length: 100 }, (_, i) => `\tdescription${i} = ${'x'.repeat(30)}\n`).join(''))
    const r = Bun.spawnSync(['git', 'status'], { cwd: d, env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...gitEnv() } })
    expect(r.exitCode).toBe(128)
    expect(dec(r.stderr)).toContain('the repository settings could not be read')
    // no repository at all: git goes on and says so itself
    const none = Bun.spawnSync(['git', 'status'], { cwd: tmp('gg-none2-'), env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...gitEnv() } })
    expect(dec(none.stderr)).not.toContain('git was refused')
  })
  test('an ordinary repository and no repository at all: git runs as usual, with its exit code', () => {
    const { d, home } = repo()
    plainGit(d, ['remote', 'add', 'origin', 'https://github.com/a/b'], home)
    expect(runGit(d, ['status', '--short'], home).code).toBe(0)
    expect(runGit(d, COMMIT, home).code).toBe(0)
    expect(runGit(tmp('gg-none-'), ['status'], home).code).toBe(128)
    expect(runGit(d, ['no-such-command'], home).code).toBe(1)
  })
})

describe('what counts', () => {
  test('dangerousGitSetting', () => {
    const yes: [string, string][] = [['filter.x.clean', 'a'], ['diff.x.textconv', 'a'], ['diff.x.command', 'a'], ['diff.external', 'a'], ['merge.x.driver', 'a'],
      ['difftool.x.cmd', 'a'], ['core.sshcommand', 'a'], ['core.gitproxy', 'a'], ['core.alternaterefscommand', 'a'], ['core.fsmonitor', '/x'], ['remote.o.uploadpack', 'a'],
      ['gpg.program', 'a'], ['credential.https://x.helper', 'store'], ['alias.st', '!x'], ['submodule.s.update', '!x'], ['pager.log', 'less -R'], ['interactive.difffilter', 'a'], ['trailer.x.command', 'a']]
    for (const [k, v] of yes) expect({ k, d: !!dangerousGitSetting(k, v) }).toEqual({ k, d: true })
    const no: [string, string][] = [['core.hookspath', 'x'], ['core.editor', 'vim'], ['core.fsmonitor', 'true'], ['alias.co', 'checkout'], ['submodule.s.update', 'rebase'], ['pager.log', 'false'],
      ['remote.origin.url', 'https://github.com/a/b'], ['credential.helper', ''], ['diff.renames', 'true'], ['user.name', 'a']]
    for (const [k, v] of no) expect({ k, d: dangerousGitSetting(k, v) }).toEqual({ k, d: null })
  })
})

describe('a project folder\'s runs have a home of their own (review of #1297)', () => {
  test('per person and folder, never the home of the person\'s own chats', () => {
    const base = '/var/lib/mycel', o = { base, userId: 'alice', teamRoot: `${base}/team`, work: null, platform: 'linux' as const }
    const proj = runEnv({ ...o, projectFolder: 'projects/one' }).HOME
    expect(proj).toBe(projectHome(base, 'alice', 'projects/one'))
    expect(proj).not.toBe(personHome(base, 'alice'))
    expect(proj.startsWith(personHome(base, 'alice'))).toBe(false)
    expect(projectHome(base, 'alice', 'projects/two')).not.toBe(proj)
    expect(projectHome(base, 'bob', 'projects/one')).not.toBe(proj)
    expect(runEnv(o).HOME).toBe(personHome(base, 'alice'))
  })
})
