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
import { GIT_HOOK_NAMES, findHookCandidates, isHookName, sweepHooks, sweepRoots } from '../../server/src/devenv/srt/hook-sweep'

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
  test('a link to a script in a team folder the run only reads: the script loses its exec bit (with the team folder as linkRoots)', async () => {
    const w = world()
    init(w.proj, w.home)
    const shared = path.join(w.team, 'shared'); plant(path.join(shared, 'tool.sh'), w.mark)
    fs.mkdirSync(path.join(w.proj, 'lnk')); fs.symlinkSync(path.join(shared, 'tool.sh'), path.join(w.proj, 'lnk/pre-commit'))
    const args = ['-c', 'core.hooksPath=lnk', ...COMMIT]
    git(w.proj, args, w.home); expect(fs.existsSync(w.mark)).toBe(true); fs.rmSync(w.mark)
    // only the project folder as a root: the target is not changed
    expect(await sweepHooks([w.proj])).toEqual([])
    expect(await sweepHooks([w.proj], { linkRoots: [w.team] })).toEqual([path.join(shared, 'tool.sh')])
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
    } finally { fs.chmodSync(d, 0o755) }
  })
  test('limits: too many hook files or too slow fails (a run does not start)', async () => {
    const w = world()
    for (let i = 0; i < 5; i++) plant(path.join(w.proj, String(i), 'pre-commit'), w.mark)
    await expect(sweepHooks([w.proj], { maxFound: 3 })).rejects.toThrow('too many git hook files')
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
