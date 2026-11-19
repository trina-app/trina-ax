// Git hooks of shared folders are never executable (QA TC-5348). Every run gets core.hooksPath=/dev/null from its
// environment (git-guard.ts gitEnv), but a command line wins over that: `git -c core.hooksPath=.git/hooks commit`,
// GIT_CONFIG_COUNT, --config-env, -c include.path, a hooks folder anywhere, `git -C` into another repository, a push into
// a bare repository. A hook that another member's run left in a project folder then ran in this person's run.
//
// git runs a hook only when the file is executable (access X_OK; else "hint: The '…' hook was ignored because it's not
// set as executable"), whatever its settings say. So the server takes the exec bits of every file that git could run as
// a hook (its name is a hook's name, any letter case, at any depth, in any folder) in the folders a run may write:
//   - before the run starts: what earlier runs (of anyone) left there; the run does not start when the folders cannot be
//     checked (fail closed);
//   - after it ends: what the run wrote, before a later run of another person (and for readers of those folders).
// A hook the run writes itself keeps its exec bit while the run lives: a person's own hooks may run in her own command.
// A link with a hook's name: its target loses the bit when it is in the team folder or a swept folder (git follows the
// link). Each file
// is opened without following a link and checked by device and inode, so a folder swapped for a link meanwhile never
// makes the server change a file outside these folders. See docs/decisions/20261119-git-hooks-bypass-shared.md.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Every hook name git knows (githooks(5), git 2.47). A file with one of these names in any folder can be a hook:
 * core.hooksPath may name any folder. */
export const GIT_HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update',
  'proc-receive', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc',
  'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist',
  'p4-post-changelist', 'p4-pre-submit', 'post-index-change',
] as const
const NAMES = new Set<string>(GIT_HOOK_NAMES)
/** Could git run a file of this name as a hook? (case-insensitive: macOS folders are) */
export const isHookName = (name: string) => NAMES.has(name.toLowerCase())

/** The sweep's limits: past them the sweep fails (a run does not start). */
export const HOOK_SWEEP_LIMITS = { timeoutMs: 30_000, maxFound: 20_000 }

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/')

/** The files and links with a hook's name under `roots` (absolute real paths): `find` (fast, no link followed), and
 * when find cannot list a folder, a walk of our own that opens it. Throws when the roots cannot be checked whole (too
 * slow, too many). A root that is not there is skipped. */
export async function findHookCandidates(roots: readonly string[], o: { timeoutMs?: number; maxFound?: number; find?: string } = {}): Promise<string[]> {
  const there = roots.filter((r) => { try { return fs.lstatSync(r).isDirectory() } catch { return false } })
  if (!there.length) return []
  const timeoutMs = o.timeoutMs ?? HOOK_SWEEP_LIMITS.timeoutMs, maxFound = o.maxFound ?? HOOK_SWEEP_LIMITS.maxFound
  const deadline = Date.now() + timeoutMs
  const viaFind = await runFind(o.find ?? '/usr/bin/find', there, timeoutMs, maxFound)
  // find could not read a folder (a member's run made one unreadable): the walk below opens it, or knows git cannot
  // reach into it either
  const found = viaFind ?? walk(there, deadline, maxFound)
  if (found.length > maxFound) throw new Error('too many git hook files to check')
  return found
}

/** find's listing, or null when find could not read everything (exit code not 0). Throws when it is too slow or lists
 * too much. */
function runFind(find: string, roots: readonly string[], timeoutMs: number, maxFound: number): Promise<string[] | null> {
  const names = GIT_HOOK_NAMES.flatMap((n, i) => (i ? ['-o', '-iname', n] : ['-iname', n]))
  // -P: no link is followed (a link's own name is listed). Every root is absolute (starts with "/"), so none reads as
  // an option (BSD find takes no `--` before its paths)
  const args = ['-P', ...roots, '(', '-type', 'f', '-o', '-type', 'l', ')', '(', ...names, ')', '-print0']
  return new Promise<string[] | null>((resolve, reject) => {
    // cwd /: the server's own folder may be one the server account cannot search (spawn would fail with EACCES)
    const p = spawn(find, args, { cwd: '/', stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let count = 0, done = false
    const fail = (why: string) => { if (done) return; done = true; clearTimeout(t); try { p.kill('SIGKILL') } catch { /* gone */ } reject(new Error(why)) }
    const t = setTimeout(() => fail('the folders took too long to check for git hooks'), timeoutMs)
    p.stdout.on('data', (b: Buffer) => {
      chunks.push(b)
      for (const x of b) if (x === 0) count++
      if (count > maxFound) fail('too many git hook files to check')
    })
    p.on('error', (e) => fail(`the folders could not be checked for git hooks: ${e.message}`))
    p.on('close', (code) => {
      if (done) return
      done = true; clearTimeout(t)
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean) : null)
    })
  })
}

/** The same listing by a walk of our own (no link followed). A folder it cannot read: when the server may search it
 * (git could reach a file in it by name), it gives itself the read bit and reads it; when no one may search it, git
 * cannot reach into it either and it is skipped. Throws past the deadline or the limit. */
function walk(roots: readonly string[], deadline: number, maxFound: number): string[] {
  const out: string[] = []
  const stack = [...roots]
  while (stack.length) {
    if (Date.now() > deadline) throw new Error('the folders took too long to check for git hooks')
    const dir = stack.pop()!
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EACCES') continue
      let st: fs.Stats
      try { st = fs.lstatSync(dir) } catch { continue }
      if (!st.isDirectory() || (st.mode & 0o111) === 0) continue
      try { fs.chmodSync(dir, st.mode | 0o500); ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { throw new Error('a folder could not be checked for git hooks') }
    }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if ((e.isFile() || e.isSymbolicLink()) && isHookName(e.name)) { out.push(p); if (out.length > maxFound) throw new Error('too many git hook files to check') }
    }
  }
  return out
}

/** Take the exec bits of one file, opened with no link followed and checked to be the same file as `abs` inside one of
 * `roots`. True when its mode changed. */
function dropExec(abs: string, roots: readonly string[]): boolean {
  let fd: number
  try {
    // O_NONBLOCK: a FIFO with a hook's name must not hang the server; O_NOFOLLOW: a link swapped in is not followed
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch { return false }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || (st.mode & 0o111) === 0) return false
    // the opened file is the one at this path now, and the path (its folders resolved) is in a swept folder: a folder of
    // the path swapped for a link between find and open would have led elsewhere
    let real: string
    try { real = fs.realpathSync(abs) } catch { return false }
    if (!roots.some((r) => inside(real, r))) return false
    const now = fs.statSync(real)
    if (now.dev !== st.dev || now.ino !== st.ino) return false
    fs.fchmodSync(fd, st.mode & 0o666)
    return true
  } catch { return false } finally { fs.closeSync(fd) }
}

/** Take the exec bits of every file that git could run as a hook under `roots` (absolute folders a run may write):
 * hook-named files, and the targets of hook-named links when the target is in one of `roots` or `o.linkRoots` (the team
 * folder: a link in a project may name a script another member left in a folder this run only reads). Returns the
 * changed paths. Throws when the folders cannot be checked whole (findHookCandidates). */
export async function sweepHooks(roots: readonly string[], o: Parameters<typeof findHookCandidates>[1] & { linkRoots?: readonly string[] } = {}): Promise<string[]> {
  // the roots by their real path: the checks below compare real paths
  const reals = (l: readonly string[]) => [...new Set(l.map((r) => { try { return fs.realpathSync(r) } catch { return '' } }).filter(Boolean))]
  const real = reals(roots)
  if (!real.length) return []
  const linkReal = [...new Set([...real, ...reals(o.linkRoots ?? [])])]
  const changed: string[] = []
  for (const f of await findHookCandidates(real, o)) {
    let st: fs.Stats
    try { st = fs.lstatSync(f) } catch { continue }
    if (st.isSymbolicLink()) {
      // git follows the link: its target is the hook. Only a target in a swept folder is changed (a system program it
      // may name is not the team's code)
      let target: string
      try { target = fs.realpathSync(f) } catch { continue }
      if (linkReal.some((r) => inside(target, r)) && dropExec(target, linkReal)) changed.push(target)
      continue
    }
    if (dropExec(f, real)) changed.push(f)
  }
  return changed
}

/** The folders of a run's settings to sweep: what it may write, without its own home and temp folder (a person's or
 * a command's own: no one else's run reads them). */
export function sweepRoots(allowWrite: readonly string[], own: readonly string[]): string[] {
  return allowWrite.filter((w) => !own.some((h) => inside(w, h)))
}
