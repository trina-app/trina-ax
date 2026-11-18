// Git in a run (QA TC-4939). A project folder is writable by every member's runs, and srt write-protects .git/hooks and
// .git/config only when .git is there as a run starts: a run that makes the repository (git init, git clone, also in a
// sub-folder) can write its hooks and config, and a later run of another member that runs git there ran them (a
// pre-commit hook, a filter driver), with that member's access and home. Two parts:
//   - gitEnv (in every run's environment, srt/config.ts runEnv): git never runs a repository's hooks
//     (core.hooksPath=/dev/null), its fsmonitor, a credential helper, a pager, an editor or an askpass program, and
//     reads no global config from the run's home; npm and Python read nothing from the home either. Command-line
//     config (GIT_CONFIG_COUNT) wins over a repository's own config.
//   - gitConfigProblems (before every run, srt/runner.ts settingsFor): what the environment cannot switch off is a
//     repository config that names a program by its own name (a filter, diff or merge driver, an include, a remote's
//     upload-pack, core.sshCommand, gpg, a "!" alias). A run does not start while a repository in or above its folder
//     has one; the person is told to remove it (fail closed). Ancestors count too: git looks for a repository upward.
// Left as they are (a command runs the project's own code on purpose): package.json scripts, a project .npmrc, a
// Makefile, a Python file. See docs/decisions/20261118-devenv-git-hooks.md.
import fs from 'node:fs'
import path from 'node:path'

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

/** Does this git config text name a program the environment cannot switch off? The names of what it found. */
export function dangerousGitConfig(text: string): string[] {
  const found = new Set<string>()
  let section = '', sub: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line)
    if (head) {
      const parts = head[1]!.toLowerCase().split('.')
      section = parts[0]!
      sub = head[2] ?? (parts.length > 1 ? parts.slice(1).join('.') : null)
      if (section === 'include' || section === 'includeif') found.add(section)
      if (section === 'filter') found.add('filter')
      if (section === 'gpg') found.add('gpg')
      continue
    }
    const key = (/^([A-Za-z][A-Za-z0-9-]*)\s*(=|$)/.exec(line)?.[1] ?? '').toLowerCase()
    const value = line.includes('=') ? line.slice(line.indexOf('=') + 1).trim() : ''
    if (!key) continue
    if (section === 'diff' && sub !== null && (key === 'command' || key === 'textconv')) found.add(`diff.${key}`)
    if (section === 'diff' && sub === null && key === 'external') found.add('diff.external')
    if (section === 'merge' && sub !== null && key === 'driver') found.add('merge.driver')
    if (section === 'core' && (key === 'sshcommand' || key === 'gitproxy')) found.add(`core.${key}`)
    if (section === 'remote' && (key === 'uploadpack' || key === 'receivepack')) found.add(`remote.${key}`)
    if (section === 'alias' && /^"?!/.test(value)) found.add('alias')
  }
  return [...found]
}

const MAX_DEPTH = 8, MAX_ENTRIES = 50_000
const SKIP = new Set(['node_modules', '.venv', 'venv', '__pycache__'])

/** The config files of the repository that `dotGit` (a .git folder, or a .git file with "gitdir: …") stands for. */
function configsOf(dotGit: string): string[] {
  let dir = dotGit
  try {
    const st = fs.lstatSync(dotGit)
    if (st.isSymbolicLink()) return []
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8').slice(0, 4096))
      if (!m) return []
      dir = path.resolve(path.dirname(dotGit), m[1]!.trim())
    }
  } catch { return [] }
  const out = [path.join(dir, 'config'), path.join(dir, 'config.worktree')]
  // a worktree's own folder names the repository's folder in commondir
  try { out.push(path.join(path.resolve(dir, fs.readFileSync(path.join(dir, 'commondir'), 'utf8').trim()), 'config')) } catch {}
  return out
}

/**
 * The repositories in `root` (to MAX_DEPTH, not in node_modules or a virtualenv) and above it up to `top` whose config
 * names a program (dangerousGitConfig), as paths relative to `top` (or to `root` outside it) with what was found.
 */
export function gitConfigProblems(root: string, top: string): { repo: string; found: string[] }[] {
  const out: { repo: string; found: string[] }[] = []
  const rel = (p: string) => { const r = path.relative(p.startsWith(top + path.sep) || p === top ? top : root, p); return r === '' ? '.' : r }
  const check = (dotGit: string) => {
    const found = new Set<string>()
    for (const f of configsOf(dotGit)) {
      let text = ''
      try { const st = fs.statSync(f); if (!st.isFile() || st.size > 1 << 20) { if (st.size > 1 << 20) found.add('too large'); continue } text = fs.readFileSync(f, 'utf8') } catch { continue }
      for (const x of dangerousGitConfig(text)) found.add(x)
    }
    if (found.size) out.push({ repo: rel(path.dirname(dotGit)), found: [...found] })
  }
  // above the run's folder, up to the team folder (git looks upward for a repository)
  for (let d = path.dirname(root); d.startsWith(top) && d !== path.dirname(top); d = path.dirname(d)) {
    check(path.join(d, '.git'))
    if (d === top) break
  }
  let seen = 0
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return
      const p = path.join(dir, e.name)
      if (e.name === '.git') { check(p); continue }
      if (e.isDirectory() && !e.isSymbolicLink() && depth < MAX_DEPTH && !SKIP.has(e.name)) walk(p, depth + 1)
    }
  }
  walk(root, 0)
  return out
}
