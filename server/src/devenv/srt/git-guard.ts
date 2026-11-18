// Git in a run (QA TC-4939). A project folder is writable by every member's runs, and srt write-protects .git/hooks and
// .git/config only when .git is there as a run starts: a run that makes a repository (git init, git clone, a bare
// repository, in any sub-folder) can write its hooks and config, and a later git command of another member there ran
// them (a pre-commit hook, a filter or diff driver), with that member's access and home. Three parts:
//   - gitEnv (in every run's environment, srt/config.ts runEnv): git never runs a repository's hooks
//     (core.hooksPath=/dev/null), its fsmonitor, a credential helper, a pager, an editor or an askpass program, uses no
//     bare repository it was not pointed at (safe.bareRepository=explicit), and reads no global config from the run's
//     home; npm, pip and Python read nothing from the home either. Command-line config (GIT_CONFIG_COUNT) wins over a
//     repository's own config. These hold for every git, also one called by its full path.
//   - the git wrapper (gitWrapperSource, first on the run's PATH as <base>/devenv/bin/git, server-owned and read-only in
//     the run): on EVERY call it asks the real git for the repository's own config (local and worktree scope, includes
//     followed, through .git links, gitdir: files and bare repositories: git's own parser) and the config of its
//     submodules, and refuses the call when a setting names a program (dangerousGitSetting). So a setting written by
//     another member's job after a run started is seen too.
//   - Limits refuse: a submodule tree too deep or too wide stops the call.
// Not covered: a command that calls git by its full path (/usr/bin/git) skips the wrapper (the environment's settings
// still hold); git's own sub-processes (a recursing checkout) read the submodules' config without the wrapper, which
// checked them before. See docs/decisions/20261118-devenv-git-hooks.md.

/** git, npm and Python settings of every run: nothing from a repository or the home runs by itself. */
export function gitEnv(): Record<string, string> {
  const cfg: [string, string][] = [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    // an empty value resets the list: a repository's own helpers are not used
    ['credential.helper', ''],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
    ['protocol.ext.allow', 'never'],
    // a bare repository planted in a folder is used only when a command names it (--git-dir)
    ['safe.bareRepository', 'explicit'],
  ]
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(cfg.length) }
  cfg.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = v })
  return {
    ...out,
    // the home's ~/.gitconfig and ~/.config/git/config are never read (a run's home is written by runs)
    GIT_CONFIG_GLOBAL: '/dev/null',
    // these win over core.pager, core.editor, sequence.editor and core.askPass of a repository
    GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_ASKPASS: '/bin/false', GIT_TERMINAL_PROMPT: '0',
    // npm's ~/.npmrc, pip's config and Python's user site-packages (usercustomize, .pth files) in the home
    NPM_CONFIG_USERCONFIG: '/dev/null', PIP_CONFIG_FILE: '/dev/null', PYTHONNOUSERSITE: '1',
  }
}

/**
 * Does a setting of a repository's own config (key as git prints it, lower case except subsections) name a program
 * that git would run? The name of the rule, or null. The settings the environment wins over (core.hooksPath,
 * core.pager, core.editor, sequence.editor, core.askPass) are not counted; a non-boolean core.fsmonitor is.
 */
export function dangerousGitSetting(key: string, value: string): string | null {
  const k = key.toLowerCase()
  const parts = k.split('.')
  const section = parts[0]!, last = parts[parts.length - 1]!
  const sub = parts.length > 2
  const bang = /^\s*!/.test(value)
  if (section === 'filter') return 'filter'
  if (section === 'diff' && sub && (last === 'textconv' || last === 'command')) return `diff.${last}`
  if (k === 'diff.external') return 'diff.external'
  if (section === 'merge' && sub && last === 'driver') return 'merge.driver'
  if ((section === 'difftool' || section === 'mergetool') && sub && last === 'cmd') return `${section}.cmd`
  if (k === 'core.sshcommand' || k === 'core.gitproxy' || k === 'core.alternaterefscommand') return k
  if (k === 'core.fsmonitor' && !/^(true|false|yes|no|on|off|1|0)?$/i.test(value.trim())) return k
  if (section === 'remote' && sub && (last === 'uploadpack' || last === 'receivepack')) return `remote.${last}`
  if (section === 'gpg') return 'gpg'
  if (section === 'credential' && last === 'helper' && value.trim() !== '') return 'credential.helper'
  if (section === 'alias' && bang) return 'alias'
  if (section === 'submodule' && sub && last === 'update' && bang) return 'submodule.update'
  if (section === 'pager' && !/^(true|false|yes|no|on|off|1|0)?$/i.test(value.trim())) return 'pager'
  if (k === 'interactive.difffilter') return k
  if (section === 'trailer' && sub && (last === 'command' || last === 'cmd')) return 'trailer.command'
  if (section === 'sendemail' && /smtpserver$/.test(last)) return 'sendemail.smtpserver'
  if ((section === 'browser' || section === 'man') && sub && (last === 'cmd' || last === 'path')) return `${section}.cmd`
  if (k === 'web.browser' || k === 'help.browser' || k === 'instaweb.httpd') return k
  return null
}

/** The wrapper's limits: past them the call is refused (fail closed). */
export const GIT_WRAPPER_LIMITS = { submodules: 200, depth: 8 }

/**
 * The source of the git wrapper: a script for `node` (its absolute path, first line) that checks the repository of
 * this call and then runs `realGit` with the same arguments, or refuses (exit 128, a line on stderr). The setting rules
 * are dangerousGitSetting's, copied in as source.
 */
export function gitWrapperSource(o: { node: string; realGit: string; maxListBytes?: number }): string {
  return `#!${o.node}
// the dev environment's git guard (server/src/devenv/srt/git-guard.ts, generated): refuses a call when the repository's own config
// names a program that git would run. Do not edit: the server writes this file again.
'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const REAL = ${JSON.stringify(o.realGit)}
const LIMITS = ${JSON.stringify(GIT_WRAPPER_LIMITS)}
const MAX_LIST = ${o.maxListBytes ?? 64 << 20}
const dangerous = ${dangerousGitSetting.toString()}
const args = process.argv.slice(2)
// the global options before the command that say which repository this call is about
const WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree', '--namespace'])
const where = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (!a.startsWith('-')) break
  if (WITH_VALUE.has(a)) { where.push(a, args[i + 1] ?? ''); i++; continue }
  if (/^--(git-dir|work-tree|namespace)=/.test(a) || a === '--bare') { where.push(a); continue }
  if (a === '-c' || a === '--config-env') { i++; continue }
}
const run = (extra) => spawnSync(REAL, [...where, ...extra], { encoding: 'utf8', maxBuffer: MAX_LIST })
// a listing cut at maxBuffer comes back with status 0 and an error (ENOBUFS): not a whole listing
const ok = (r) => r.status === 0 && !r.error
const refuse = (why) => { process.stderr.write('git was refused: ' + why + '. The repository\\'s settings would run a program by themselves. Tell the person: someone who can open the folder must remove them from its .git/config in Files.\\n'); process.exit(128) }
/** settings of one config listing (--null: [scope NUL] key LF value NUL) */
const check = (out, scoped, at) => {
  const f = out.split('\\0')
  for (let i = 0; i < f.length; i++) {
    let scope = 'local', kv = f[i]
    if (scoped) { scope = f[i]; kv = f[++i] ?? '' }
    if (!kv) continue
    if (scope !== 'local' && scope !== 'worktree') continue
    const nl = kv.indexOf('\\n')
    const key = nl < 0 ? kv : kv.slice(0, nl), value = nl < 0 ? '' : kv.slice(nl + 1)
    const d = dangerous(key, value)
    if (d) refuse(d + ' (' + key + ')' + (at ? ' in ' + at : ''))
  }
}
const listed = run(['config', '--list', '--show-scope', '--null', '--includes'])
// the settings could not be listed (too large, unreadable, a failed start) while there is a repository here: refused
// (fail closed); no repository at all: git goes on (and says so itself)
if (!ok(listed) && ok(run(['rev-parse', '--git-dir']))) refuse('the repository settings could not be read')
if (ok(listed)) {
  check(listed.stdout, true, '')
  // submodules: their own config, absorbed ones in <common dir>/modules, the others in their folders
  const common = run(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  let seen = 0
  const walk = (dir, depth) => {
    if (depth > LIMITS.depth) refuse('submodules nested too deep to check')
    let names = []
    try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (names.some((e) => e.name === 'config' && e.isFile()) && names.some((e) => e.name === 'HEAD')) {
      if (++seen > LIMITS.submodules) refuse('too many submodules to check')
      const r = spawnSync(REAL, ['config', '--file', path.join(dir, 'config'), '--list', '--null'], { encoding: 'utf8', maxBuffer: MAX_LIST })
      if (ok(r)) check(r.stdout, false, 'a submodule')
      else refuse('a submodule\\'s config could not be read')
    }
    for (const e of names) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== 'objects' && e.name !== 'refs' && e.name !== 'logs') walk(path.join(dir, e.name), depth + 1)
  }
  if (ok(common)) walk(path.join(common.stdout.trim(), 'modules'), 0)
  const top = run(['rev-parse', '--show-toplevel'])
  if (ok(top) && fs.existsSync(path.join(top.stdout.trim(), '.gitmodules'))) {
    const ls = run(['ls-files', '--stage', '-z'])
    if (!ok(ls)) refuse('the submodules could not be listed')
    for (const line of (ls.stdout || '').split('\\0')) {
      if (!line.startsWith('160000 ')) continue
      const p = path.join(top.stdout.trim(), line.slice(line.indexOf('\\t') + 1))
      if (!fs.existsSync(path.join(p, '.git'))) continue
      if (++seen > LIMITS.submodules) refuse('too many submodules to check')
      const r = spawnSync(REAL, ['-C', p, 'config', '--list', '--show-scope', '--null', '--includes'], { encoding: 'utf8', maxBuffer: MAX_LIST })
      if (ok(r)) check(r.stdout, true, 'a submodule')
      else refuse('a submodule\\'s settings could not be read')
    }
  }
}
const r = spawnSync(REAL, args, { stdio: 'inherit' })
if (r.error) { process.stderr.write('git: ' + r.error.message + '\\n'); process.exit(127) }
process.exit(r.status ?? (r.signal ? 128 + 1 : 1))
`
}
