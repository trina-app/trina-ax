// Git in a run (QA TC-4939): a member's run that made a repository in the project folder could plant a hook or a
// config program there, and another member's later git command ran it with that member's access and home. The fix
// (server/src/devenv/srt/git-guard.ts): every run's environment switches off repository hooks and the programs git
// takes from config where it can; a repository whose config names a program by its own name stops the run. The real
// srt case is G1-G3 in tests/linux/srt-attack.ts.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dangerousGitConfig, gitConfigProblems, gitEnv } from '../../server/src/devenv/srt/git-guard'
import { runEnv } from '../../server/src/devenv/srt/config'

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const git = (cwd: string, args: string[], env: Record<string, string>) => Bun.spawnSync(['git', ...args], { cwd, env: { PATH: process.env.PATH!, HOME: env.HOME ?? cwd, ...env } })

describe('a repository hook never runs in a run', () => {
  test('a planted pre-commit hook: plain git runs it, a run\'s environment does not', () => {
    const d = tmp('gg-hook-'), home = tmp('gg-home-')
    expect(git(d, ['init', '-q'], { HOME: home }).exitCode).toBe(0)
    fs.writeFileSync(path.join(d, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch "${home}/HOOK-RAN"\n`, { mode: 0o755 })
    const commit = ['-c', 'user.name=a', '-c', 'user.email=a@example.com', 'commit', '-q', '--allow-empty', '-m', 'x']
    // the hook works (so the test means something) ...
    git(d, commit, { HOME: home })
    expect(fs.existsSync(path.join(home, 'HOOK-RAN'))).toBe(true)
    fs.rmSync(path.join(home, 'HOOK-RAN'))
    // ... and not with a run's environment
    const env = runEnv({ base: '/var/lib/mycel', userId: 'alice', teamRoot: '/var/lib/mycel/team', work: null, platform: 'linux' })
    const r = git(d, commit, { ...gitEnv(), HOME: home, GIT_CONFIG_PARAMETERS: "'http.proxyAuthMethod=basic'" })
    expect(r.exitCode).toBe(0)
    expect(fs.existsSync(path.join(home, 'HOOK-RAN'))).toBe(false)
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    expect(env.GIT_CONFIG_VALUE_0).toBe('/dev/null')
  })
  test('a ~/.gitconfig in the run\'s home is not read', () => {
    const d = tmp('gg-glob-'), home = tmp('gg-home2-')
    git(d, ['init', '-q'], { HOME: home })
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = PLANTED\n')
    expect(new TextDecoder().decode(git(d, ['config', 'user.name'], { HOME: home }).stdout)).toContain('PLANTED')
    expect(new TextDecoder().decode(git(d, ['config', 'user.name'], { ...gitEnv(), HOME: home }).stdout)).not.toContain('PLANTED')
  })
  test('npm, pip and Python read nothing from the home', () => {
    expect(gitEnv()).toMatchObject({ NPM_CONFIG_USERCONFIG: '/dev/null', PIP_CONFIG_FILE: '/dev/null', PYTHONNOUSERSITE: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  })
})

describe('a repository config that names a program stops the run', () => {
  test('what counts', () => {
    expect(dangerousGitConfig('[filter "x"]\n\tclean = evil\n')).toEqual(['filter'])
    expect(dangerousGitConfig('[diff "x"]\n\ttextconv = evil\n[diff]\n\texternal = evil\n').sort()).toEqual(['diff.external', 'diff.textconv'])
    expect(dangerousGitConfig('[merge "x"]\n\tdriver = evil %A\n')).toEqual(['merge.driver'])
    expect(dangerousGitConfig('[include]\n\tpath = ../../x\n[includeIf "gitdir:/"]\n\tpath = y\n').sort()).toEqual(['include', 'includeif'])
    expect(dangerousGitConfig('[core]\n\tsshCommand = evil\n')).toEqual(['core.sshcommand'])
    expect(dangerousGitConfig('[remote "o"]\n\turl = x\n\tuploadpack = evil\n')).toEqual(['remote.uploadpack'])
    expect(dangerousGitConfig('[alias]\n\tst = !evil\n\tco = checkout\n')).toEqual(['alias'])
    expect(dangerousGitConfig('[gpg]\n\tprogram = evil\n')).toEqual(['gpg'])
    // an ordinary repository: nothing (the switches the environment wins over are not counted)
    expect(dangerousGitConfig('[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\thooksPath = x\n\teditor = vim\n[remote "origin"]\n\turl = https://github.com/a/b\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n')).toEqual([])
  })
  test('found in the folder, in a sub-folder, through a .git file and above the folder; not in node_modules', () => {
    const top = tmp('gg-team-'), root = path.join(top, 'projects/one')
    const repo = (dir: string, cfg: string) => { fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); fs.writeFileSync(path.join(dir, '.git/config'), cfg) }
    fs.mkdirSync(root, { recursive: true })
    expect(gitConfigProblems(root, top)).toEqual([])
    repo(root, '[core]\n\tbare = false\n')
    expect(gitConfigProblems(root, top)).toEqual([])
    repo(path.join(root, 'a/b'), '[filter "x"]\n\tsmudge = evil\n')
    // a worktree-style .git file pointing at a repository elsewhere in the folder
    fs.mkdirSync(path.join(root, 'w'), { recursive: true }); repo(path.join(root, 'hidden-repo'), '[diff "d"]\n\tcommand = evil\n')
    fs.renameSync(path.join(root, 'hidden-repo/.git'), path.join(root, 'hidden-repo/gitdir')); fs.writeFileSync(path.join(root, 'w/.git'), 'gitdir: ../hidden-repo/gitdir\n')
    repo(path.join(top, 'projects'), '[include]\n\tpath = x\n')
    repo(path.join(root, 'node_modules/pkg'), '[filter "x"]\n\tclean = evil\n')
    const got = gitConfigProblems(root, top).map((g) => g.repo).sort()
    expect(got).toEqual(['projects', 'projects/one/a/b', 'projects/one/w'])
  })
})
