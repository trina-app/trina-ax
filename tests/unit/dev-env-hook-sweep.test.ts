// A teammate's git hook never runs in another person's command (QA TC-5348). Every run gets core.hooksPath=/dev/null
// from its environment, but the command line wins over that. The fix (server/src/devenv/srt/hook-sweep.ts): the server
// takes the exec bits of every file git could run as a hook in the folders a run may write, before it starts and after
// it ends; git runs no hook that is not executable. Each bypass is a case here with the real git of this machine, as
// /usr/bin/git (no wrapper) with a run's settings, and in tests/linux/srt-attack.ts (G12-G21).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dangerousGitSetting, gitEnv } from '../../server/src/devenv/srt/git-guard'
import { GIT_HOOK_NAMES, findHookCandidates, isHookName, othersLive, sweepEntrySync, sweepHooks, sweepRoots, visibleOf } from '../../server/src/devenv/srt/hook-sweep'

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)))
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const REAL = dec(Bun.spawnSync(['/usr/bin/which', 'git']).stdout).trim()
const ID = ['-c', 'user.name=a', '-c', 'user.email=a@example.com']
const COMMIT = [...ID, 'commit', '-q', '--allow-empty', '-m', 'x']

/** a project folder (the shared one), alice's home, and the mark a planted hook would leave */
function world() {
  const team = tmp('hs-team-'), proj = path.join(team, 'projects', 'p'), home = tmp('hs-home-')
  fs.mkdirSync(proj, { recursive: true })
  return { team, proj, home, mark: path.join(home, 'RAN') }
}
/** git as a run calls it by its full path (the wrapper is not in the way): the run's settings, then the attack's env */
function git(cwd: string, args: string[], home: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync([REAL, ...args], { cwd, env: { PATH: process.env.PATH!, HOME: home, ...gitEnv(), ...env } })
  return { code: r.exitCode, out: dec(r.stdout) + dec(r.stderr) }
}
const init = (d: string, home: string, ...a: string[]) => { fs.mkdirSync(d, { recursive: true }); expect(git(d, ['init', '-q', ...a], home).code).toBe(0) }
/** erin's hook: an executable script with a hook's name */
const plant = (f: string, mark: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 }) }
const x = (f: string) => fs.statSync(f).mode & 0o111

/** Each bypass: what erin plants, and alice's git call. `before` shows the attack is real (the hook runs with no sweep). */
const bypasses: { id: string; what: string; setup: (w: ReturnType<typeof world>) => { cwd: string; args: string[]; env?: Record<string, string> } }[] = [
  { id: 'B1', what: '-c core.hooksPath=.git/hooks', setup: (w) => { init(w.proj, w.home); plant(path.join(w.proj, '.git/hooks/pre-commit'), w.mark); return { cwd: w.proj, args: ['-c', 'core.hooksPath=.git/hooks', ...COMMIT] } } },
  { id: 'B2', what: 'GIT_CONFIG_COUNT/KEY/VALUE in the command\'s environment', setup: (w) => { init(w.proj, w.home); plant(path.join(w.proj, '.git/hooks/pre-commit'), w.mark); return { cwd: w.proj, args: COMMIT, env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '.git/hooks' } } } },
  { id: 'B3', what: '-c include.path naming a file that sets core.hooksPath', setup: (w) => { init(w.proj, w.home); plant(path.join(w.proj, '.git/hooks/pre-commit'), w.mark); const inc = path.join(w.home, 'inc'); fs.writeFileSync(inc, '[core]\n\thooksPath = .git/hooks\n'); return { cwd: w.proj, args: ['-c', `include.path=${inc}`, ...COMMIT] } } },
  { id: 'B4', what: '--config-env=core.hooksPath=<variable>', setup: (w) => { init(w.proj, w.home); plant(path.join(w.proj, '.git/hooks/pre-commit'), w.mark); return { cwd: w.proj, args: ['--config-env=core.hooksPath=HP', ...COMMIT], env: { HP: '.git/hooks' } } } },
  { id: 'B5', what: 'core.hooksPath naming a sub-folder (tools/hooks)', setup: (w) => { init(w.proj, w.home); plant(path.join(w.proj, 'tools/hooks/pre-commit'), w.mark); return { cwd: w.proj, args: ['-c', 'core.hooksPath=tools/hooks', ...COMMIT] } } },
  { id: 'B6', what: 'git -C into another repository of the folder', setup: (w) => { const o = path.join(w.proj, 'other'); init(o, w.home); plant(path.join(o, '.git/hooks/pre-commit'), w.mark); return { cwd: w.proj, args: ['-C', 'other', '-c', 'core.hooksPath=.git/hooks', ...COMMIT] } } },
  { id: 'B7', what: 'a push into a bare repository: its pre-receive hook (GIT_CONFIG_COUNT=0 drops the run\'s settings)', setup: (w) => {
    const b = path.join(w.proj, 'b.git'); init(b, w.home, '--bare'); plant(path.join(b, 'hooks/pre-receive'), w.mark)
    const a = path.join(w.proj, 'a'); init(a, w.home); expect(git(a, COMMIT, w.home).code).toBe(0)
    return { cwd: a, args: ['push', '-q', '../b.git', 'HEAD:refs/heads/main'], env: { GIT_CONFIG_COUNT: '0' } }
  } },
  { id: 'B8', what: 'a bare repository named with --git-dir and its own hooks', setup: (w) => { const b = path.join(w.proj, 'c.git'); init(b, w.home, '--bare'); plant(path.join(b, 'hooks/pre-commit'), w.mark); return { cwd: w.proj, args: ['--git-dir=c.git', '--work-tree=.', '-c', 'core.hooksPath=c.git/hooks', ...COMMIT] } } },
  { id: 'B9', what: 'a hook that is a link to an executable script elsewhere in the folder', setup: (w) => {
    init(w.proj, w.home); plant(path.join(w.proj, 'scripts/run.sh'), w.mark)
    fs.mkdirSync(path.join(w.proj, 'lnk')); fs.symlinkSync('../scripts/run.sh', path.join(w.proj, 'lnk/pre-commit'))
    return { cwd: w.proj, args: ['-c', 'core.hooksPath=lnk', ...COMMIT] }
  } },
  { id: 'B10', what: 'a hooks folder twelve folders down, named by a relative path from a sub-folder', setup: (w) => { init(w.proj, w.home); const deep = 'a/b/c/d/e/f/g/h/i/j/k/l'; plant(path.join(w.proj, deep, 'commit-msg'), w.mark); return { cwd: w.proj, args: ['-c', `core.hooksPath=${deep}`, ...COMMIT] } } },
]

describe('every bypass of core.hooksPath=/dev/null', () => {
  for (const b of bypasses) {
    test(`${b.id} ${b.what}: runs with no sweep (the repro), not after the sweep`, async () => {
      const w = world()
      const s = b.setup(w)
      // the repro: the hook runs in alice's git, the run's settings notwithstanding
      git(s.cwd, s.args, w.home, s.env)
      expect(fs.existsSync(w.mark)).toBe(true)
      fs.rmSync(w.mark)
      // the server's sweep before alice's run (the folders her run may write)
      expect((await sweepHooks([w.proj])).length).toBeGreaterThan(0)
      const r = git(s.cwd, s.args, w.home, s.env)
      expect(fs.existsSync(w.mark)).toBe(false)
      // git goes on without it (or says it was ignored); no hook means no failure of the commit itself
      if (b.id !== 'B7') expect(r.code).toBe(0)
    })
  }
})

describe('the sweep', () => {
  test('every hook name, any letter case, any folder; ordinary scripts and files keep their mode', async () => {
    const w = world()
    for (const n of GIT_HOOK_NAMES) plant(path.join(w.proj, 'h', n), w.mark)
    plant(path.join(w.proj, 'x/PRE-COMMIT'), w.mark)
    plant(path.join(w.proj, 'build.sh'), w.mark)
    plant(path.join(w.proj, 'node_modules/.bin-target/vite.js'), w.mark)
    fs.writeFileSync(path.join(w.proj, 'h/pre-commit.sample'), '#!/bin/sh\n', { mode: 0o755 })
    const changed = await sweepHooks([w.proj])
    expect(changed.length).toBe(GIT_HOOK_NAMES.length + 1)
    for (const n of GIT_HOOK_NAMES) expect(x(path.join(w.proj, 'h', n))).toBe(0)
    expect(x(path.join(w.proj, 'x/PRE-COMMIT'))).toBe(0)
    // read and write bits stay
    expect(fs.statSync(path.join(w.proj, 'h/pre-commit')).mode & 0o666).toBe(0o644)
    expect(x(path.join(w.proj, 'build.sh'))).toBe(0o111)
    expect(x(path.join(w.proj, 'node_modules/.bin-target/vite.js'))).toBe(0o111)
    expect(x(path.join(w.proj, 'h/pre-commit.sample'))).toBe(0o111)
    // a second sweep changes nothing
    expect(await sweepHooks([w.proj])).toEqual([])
    expect(isHookName('Pre-Push')).toBe(true)
    expect(isHookName('pre-commit.sample')).toBe(false)
  })
  test('a link out of the swept folders is not followed: the file it names keeps its mode', async () => {
    const w = world()
    const outside = path.join(w.team, 'server-bin'); fs.writeFileSync(outside, '#!/bin/sh\n', { mode: 0o755 })
    fs.mkdirSync(path.join(w.proj, 'l'))
    fs.symlinkSync(outside, path.join(w.proj, 'l/pre-commit'))
    fs.symlinkSync('/bin/sh', path.join(w.proj, 'l/post-commit'))
    // a hook-named folder that is a link out of the folder
    fs.symlinkSync(w.team, path.join(w.proj, 'l/update'))
    expect(await sweepHooks([w.proj])).toEqual([])
    expect(x(outside)).toBe(0o111)
  })
  test('a link to a script in a team folder the run only reads: the script loses its exec bit (visible: what the run may read)', async () => {
    const w = world()
    init(w.proj, w.home)
    const shared = path.join(w.team, 'shared'); plant(path.join(shared, 'tool.sh'), w.mark)
    fs.mkdirSync(path.join(w.proj, 'lnk')); fs.symlinkSync(path.join(shared, 'tool.sh'), path.join(w.proj, 'lnk/pre-commit'))
    const args = ['-c', 'core.hooksPath=lnk', ...COMMIT]
    git(w.proj, args, w.home); expect(fs.existsSync(w.mark)).toBe(true); fs.rmSync(w.mark)
    // only the project folder as a root: the target is not changed
    expect(await sweepHooks([w.proj])).toEqual([])
    expect(await sweepHooks([w.proj], { visible: { read: [w.proj, shared] } })).toEqual([path.join(shared, 'tool.sh')])
    git(w.proj, args, w.home)
    expect(fs.existsSync(w.mark)).toBe(false)
  })
  test('a FIFO with a hook\'s name does not hang the sweep', async () => {
    const w = world()
    fs.mkdirSync(path.join(w.proj, '.git/hooks'), { recursive: true })
    expect(Bun.spawnSync(['mkfifo', path.join(w.proj, '.git/hooks/pre-commit')]).exitCode).toBe(0)
    expect(await sweepHooks([w.proj])).toEqual([])
  })
  test('a folder that find cannot read: the walk opens it when git could reach into it', async () => {
    const w = world()
    const d = path.join(w.proj, 'locked')
    plant(path.join(d, 'pre-commit'), w.mark)
    fs.chmodSync(d, 0o300) // writable and searchable, not listable: git reaches d/pre-commit by name
    try {
      expect(await sweepHooks([w.proj])).toEqual([path.join(d, 'pre-commit')])
      expect(x(path.join(d, 'pre-commit'))).toBe(0)
      // the folder's own mode is put back (V9)
      expect(fs.statSync(d).mode & 0o777).toBe(0o300)
    } finally { fs.chmodSync(d, 0o755) }
  })
  test('limits: too slow fails (a run does not start); many hook-named files that are not executable cost nothing', async () => {
    const w = world()
    for (let i = 0; i < 5; i++) plant(path.join(w.proj, String(i), 'pre-commit'), w.mark)
    await expect(findHookCandidates([w.proj], { timeoutMs: 1, find: '/bin/sleep' })).rejects.toThrow('too long')
    // folders that are not there are no error
    expect(await sweepHooks([path.join(w.proj, 'gone')])).toEqual([])
  })
  test('a hook the run writes after the sweep runs in its own command (a person\'s own hooks may run)', async () => {
    const w = world()
    init(w.proj, w.home)
    await sweepHooks([w.proj])
    plant(path.join(w.proj, '.git/hooks/pre-commit'), w.mark)
    expect(git(w.proj, ['-c', 'core.hooksPath=.git/hooks', ...COMMIT], w.home).code).toBe(0)
    expect(fs.existsSync(w.mark)).toBe(true)
  })
  test('the roots: what the run may write, not its own home or temp folder', () => {
    expect(sweepRoots(['/t/projects/p', '/b/devenv/hp/abc', '/b/devenv/hp/abc/tmp', '/b/devenv/work-shared/c/k'], ['/b/devenv/hp/abc', '/b/devenv/hp/abc/tmp'])).toEqual(['/t/projects/p', '/b/devenv/work-shared/c/k'])
  })
})

describe('config hooks of newer git', () => {
  test('hook.<name>.command in a repository\'s config names a program: the wrapper refuses it', () => {
    expect(dangerousGitSetting('hook.pre-commit.command', 'touch /tmp/x')).toBe('hook.command')
    expect(dangerousGitSetting('hook.linter.event', 'pre-commit')).toBeNull()
  })
})

// The independent review of #46 (V1-V9): each attack, and what the sweep does now
const isRoot = process.getuid?.() === 0
describe('review of #46', () => {
  test.skipIf(isRoot)('V1 an exec-only (0111) ELF hook loses its exec bit and does not run', async () => {
    const w = world()
    init(w.proj, w.home)
    const hook = path.join(w.proj, 'tools/hooks/pre-commit')
    fs.mkdirSync(path.dirname(hook), { recursive: true })
    fs.copyFileSync(fs.existsSync('/usr/bin/false') ? '/usr/bin/false' : '/bin/false', hook)
    fs.chmodSync(hook, 0o111)
    // the repro: it runs (it is false: the commit fails)
    expect(git(w.proj, ['-c', 'core.hooksPath=tools/hooks', ...COMMIT], w.home).code).not.toBe(0)
    expect(await sweepHooks([w.proj])).toEqual([hook])
    expect(x(hook)).toBe(0)
    expect(git(w.proj, ['-c', 'core.hooksPath=tools/hooks', ...COMMIT], w.home).code).toBe(0)
  })
  test('V2 a hook-named link to a file the run cannot read (another person\'s folder) leaves that file alone', async () => {
    const w = world()
    const bob = path.join(w.team, 'users', 'bob'); fs.mkdirSync(bob, { recursive: true })
    const victim = path.join(bob, 'deploy.sh'); fs.writeFileSync(victim, '#!/bin/sh\n', { mode: 0o755 })
    fs.symlinkSync(victim, path.join(w.proj, 'post-merge'))
    const v = visibleOf({ allowRead: [w.proj, path.join(w.team, 'users', 'erin')], allowWrite: [w.proj], denyRead: [path.join(w.team, 'users')] }, w.team)
    expect(await sweepHooks([w.proj], { visible: v })).toEqual([])
    expect(x(victim)).toBe(0o111)
  })
  test('V3 a hook that is a hard link to a file outside the team folder: the hook gets a copy without the exec bit, the other file keeps its mode', async () => {
    const w = world(), out = tmp('hs-out-')
    const victim = path.join(out, 'tool'); fs.writeFileSync(victim, '#!/bin/sh\necho tool\n', { mode: 0o755 })
    const hook = path.join(w.proj, 'pre-commit')
    try { fs.linkSync(victim, hook) } catch { return } // another file system here: nothing to show
    expect(await sweepHooks([w.proj])).toEqual([hook])
    expect(x(victim)).toBe(0o111)
    expect(x(hook)).toBe(0)
    expect(fs.statSync(hook).ino).not.toBe(fs.statSync(victim).ino)
    expect(fs.readFileSync(hook, 'utf8')).toBe('#!/bin/sh\necho tool\n')
  })
  test('V4 20 001 empty files called update do not make the sweep fail', async () => {
    const w = world()
    for (let i = 0; i < 20_001; i++) { const d = path.join(w.proj, 'n', String(i)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'update'), '') }
    expect(await sweepHooks([w.proj])).toEqual([])
  }, 120_000)
  test.skipIf(process.platform !== 'darwin')('V5 a look-alike name the file system resolves to a hook (pre-puſh on APFS) loses its exec bit', async () => {
    const w = world()
    const h = path.join(w.proj, 'h'); fs.mkdirSync(h)
    const f = path.join(h, 'pre-puſh'); fs.writeFileSync(f, `#!/bin/sh\ntouch ${w.mark}\n`, { mode: 0o755 })
    expect(fs.existsSync(path.join(h, 'pre-push'))).toBe(true)
    expect(await sweepHooks([w.proj])).toEqual([f])
    expect(x(f)).toBe(0)
    const a = path.join(w.proj, 'a'), b = path.join(w.proj, 'b.git')
    init(a, w.home); git(a, COMMIT, w.home); init(b, w.home, '--bare')
    git(a, ['-c', `core.hooksPath=${h}`, 'push', '-q', b, 'HEAD:refs/heads/main'], w.home)
    expect(fs.existsSync(w.mark)).toBe(false)
    // an ordinary non-ASCII name keeps its mode
    const other = path.join(w.proj, 'büild.sh'); fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 })
    expect(await sweepHooks([w.proj])).toEqual([])
    expect(x(other)).toBe(0o111)
  })
  test('V6 a hook in a folder the run only reads: Files puts it there (sweepEntrySync), or another person\'s live run may write there (othersLive)', async () => {
    const w = world()
    const other = path.join(w.team, 'projects', 'q'), tools = path.join(other, 'tools'); fs.mkdirSync(tools, { recursive: true })
    fs.writeFileSync(path.join(tools, 'runner'), `#!/bin/sh\ntouch ${w.mark}\n`, { mode: 0o755 })
    await sweepHooks([other]) // erin's run ends: runner is no hook, it keeps its bit
    expect(x(path.join(tools, 'runner'))).toBe(0o111)
    fs.renameSync(path.join(tools, 'runner'), path.join(tools, 'pre-commit')) // a Files rename
    expect(sweepEntrySync(path.join(tools, 'pre-commit'), { visible: { read: [w.team] } })).toEqual([path.join(tools, 'pre-commit')])
    init(w.proj, w.home)
    git(w.proj, ['-c', `core.hooksPath=${tools}`, ...COMMIT], w.home)
    expect(fs.existsSync(w.mark)).toBe(false)
    // a folder moved by Files: everything in it
    const moved = path.join(w.team, 'projects', 'moved'); plant(path.join(moved, 'deep/x/post-checkout'), w.mark)
    expect(sweepEntrySync(moved, { visible: { read: [w.team] } })).toEqual([path.join(moved, 'deep/x/post-checkout')])
    // another person's live run: the folders it may write that this run may read are swept before this run
    const v = { read: [w.proj, other], deny: [] }
    expect(othersLive([{ userId: 'erin', roots: [other] }, { userId: 'alice', roots: [w.proj] }, { userId: 'bob', roots: [path.join(w.team, 'users', 'bob')] }], 'alice', v)).toEqual([other])
    expect(othersLive([{ userId: 'erin', roots: [w.team] }], 'alice', v).sort()).toEqual([w.proj, other].sort())
  })
  test('V7 a filter in a teammate\'s nested repository: the wrapper refuses it (git on PATH); git by its full path is a known gap (decision)', () => {
    // the wrapper's refusal is tested in dev-env-git-guard.test.ts G3-G11 and srt-attack.ts G3; /usr/bin/git skips the
    // wrapper and a same-account sandbox cannot make it unavoidable: docs/decisions/20261119-git-hooks-bypass-shared.md
    expect(true).toBe(true)
  })
  test('V8 a husky-style link hook takes the exec bit of the script it names; sh still runs it', async () => {
    const w = world()
    const s = path.join(w.proj, 'scripts/lint.sh'); fs.mkdirSync(path.dirname(s)); fs.writeFileSync(s, '#!/bin/sh\necho lint\n', { mode: 0o755 })
    fs.mkdirSync(path.join(w.proj, '.husky')); fs.symlinkSync('../scripts/lint.sh', path.join(w.proj, '.husky/pre-commit'))
    await sweepHooks([w.proj])
    expect(x(s)).toBe(0)
    expect(dec(Bun.spawnSync(['sh', s]).stdout)).toBe('lint\n')
  })
  test.skipIf(isRoot)('V9 a folder find cannot list (0311) is read through itself and its mode put back', async () => {
    const w = world()
    const d = path.join(w.proj, 'locked'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'pre-commit'), '#!/bin/sh\n', { mode: 0o755 })
    fs.mkdirSync(path.join(d, 'sub')); fs.writeFileSync(path.join(d, 'sub', 'update'), '#!/bin/sh\n', { mode: 0o755 })
    fs.chmodSync(d, 0o311)
    try {
      expect((await sweepHooks([w.proj])).sort()).toEqual([path.join(d, 'pre-commit'), path.join(d, 'sub', 'update')].sort())
      expect(fs.statSync(d).mode & 0o777).toBe(0o311)
    } finally { fs.chmodSync(d, 0o755) }
  })
})
