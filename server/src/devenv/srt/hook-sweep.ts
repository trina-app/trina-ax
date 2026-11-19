// Git hooks of shared folders are never executable (QA TC-5348). Every run gets core.hooksPath=/dev/null from its
// environment (git-guard.ts gitEnv), but a command line wins over that: `git -c core.hooksPath=.git/hooks commit`,
// GIT_CONFIG_COUNT, --config-env, -c include.path, a hooks folder anywhere, `git -C` into another repository, a push into
// a bare repository. A hook that another member's run left in a project folder then ran in this person's run.
//
// git runs a hook only when the file is executable (access X_OK and execve), whatever its settings say. So the server
// (outside the sandbox) takes the exec bits of every file that git could run as a hook:
//   - a file is a hook candidate when it is executable and git would find it by a hook's name: the name itself in any
//     letter case, and on macOS any other name the file system resolves a hook's name to (APFS folds case and Unicode:
//     `pre-puſh` is opened as `pre-push`), checked by looking the hook's names up in its folder as git does;
//   - a link with a hook's name: its target loses the bit when the target is a file the run may read (git follows the
//     link); a target the run cannot see (another person's folder, a hidden sub-folder) is left alone;
//   - a file with more than one name (a hard link): the hook's name gets a copy of its own without the exec bit, so the
//     other name (possibly outside the team folder) is never changed;
//   - the mode is changed through the file itself (Linux: an O_PATH descriptor, so an exec-only 0111 file is changed
//     too; macOS: the descriptor, else lchmod), checked by device and inode first; a file that cannot be changed fails
//     the sweep (fail closed).
// When: before a run starts (its writable folders, and the folders other people's live runs may write that it may
// read), after it ends (its writable folders), when the server starts (the whole team folder), and when Files moves,
// copies or restores something (that entry). See docs/decisions/20261119-git-hooks-bypass-shared.md.
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
/** A hook's name in any ASCII letter case (what a case-insensitive folder resolves for an ASCII name). */
export const isHookName = (name: string) => NAMES.has(name.toLowerCase())
const ASCII = /^[\x20-\x7e]*$/

/** The sweep's limit: past it the sweep fails (a run does not start). */
export const HOOK_SWEEP_LIMITS = { timeoutMs: 30_000 }

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/')

/** Which files a link's target may be: inside one of `read` and not inside one of `deny` (the run's view). */
export interface Visible { read: readonly string[]; deny?: readonly string[] }
const depth = (list: readonly string[], p: string) => Math.max(-1, ...list.filter((e) => inside(p, e)).map((e) => e.split('/').length))
/** srt's rule: the deepest entry at or above a path decides, a read entry wins a tie */
const visibleIn = (v: Visible, p: string) => { const r = depth(v.read, p); return r >= 0 && r >= depth(v.deny ?? [], p) }

export interface SweepOptions {
  timeoutMs?: number
  find?: string
  /** what the run may read: a hook-named link's target is changed only there (default: nowhere, links are left) */
  visible?: Visible
  /** and the person may read this file (Files: the mover's folder rules); a link target is changed only when both say so */
  mayRead?: (abs: string) => boolean
  /** the platform's rules (tests) */
  platform?: NodeJS.Platform
}

/** Executable files and links that git could take for a hook under `roots` (absolute real paths): `find -P` (fast; on
 * macOS also every executable file with a name that is not plain ASCII, checked below), and when find cannot list a
 * folder, a walk of our own. Throws past the time limit. A root that is not there is skipped. */
export async function findHookCandidates(roots: readonly string[], o: SweepOptions = {}): Promise<string[]> {
  const there = roots.filter((r) => { try { return fs.lstatSync(r).isDirectory() } catch { return false } })
  if (!there.length) return []
  const timeoutMs = o.timeoutMs ?? HOOK_SWEEP_LIMITS.timeoutMs
  const mac = (o.platform ?? process.platform) === 'darwin'
  const deadline = Date.now() + timeoutMs
  const viaFind = await runFind(o.find ?? '/usr/bin/find', there, timeoutMs, mac)
  return viaFind ?? walk(there, deadline, mac)
}

function runFind(find: string, roots: readonly string[], timeoutMs: number, mac: boolean): Promise<string[] | null> {
  const names = ['(', ...GIT_HOOK_NAMES.flatMap((n, i) => (i ? ['-o', '-iname', n] : ['-iname', n])), ')']
  // only executable files count (a run cannot make the sweep fail with many empty `update` files); links always
  // (their target decides). BSD find spells "any of these bits" +, GNU find /
  const exec = ['-type', 'f', '-perm', mac ? '+0111' : '/0111']
  // macOS: a name that is not plain ASCII may be a hook's name to the file system (case and Unicode folding)
  const expr = mac
    ? ['(', '(', ...exec, ')', '-o', '-type', 'l', ')', '(', ...names, '-o', '-name', '*[! -~]*', ')']
    : ['(', '(', ...exec, ')', '-o', '-type', 'l', ')', ...names]
  // -P: no link is followed. Every root is absolute (starts with "/"), so none reads as an option (BSD find takes no
  // `--` before its paths). LC_ALL=C: the bracket above matches bytes
  const args = ['-P', ...roots, ...expr, '-print0']
  return new Promise<string[] | null>((resolve, reject) => {
    // cwd /: the server's own folder may be one the server account cannot search (spawn would fail with EACCES)
    const p = spawn(find, args, { cwd: '/', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })
    const chunks: Buffer[] = []
    let done = false
    const fail = (why: string) => { if (done) return; done = true; clearTimeout(t); try { p.kill('SIGKILL') } catch { /* gone */ } reject(new Error(why)) }
    const t = setTimeout(() => fail('the folders took too long to check for git hooks'), timeoutMs)
    p.stdout.on('data', (b: Buffer) => { chunks.push(b) })
    p.on('error', (e) => fail(`the folders could not be checked for git hooks: ${e.message}`))
    p.on('close', (code) => {
      if (done) return
      done = true; clearTimeout(t)
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean) : null)
    })
  })
}

/** The same listing by a walk of our own (no link followed). A folder it cannot list but may search (git can reach a
 * file in it by name): each hook name is looked up in it as git does, and it is listed with a read bit given for that
 * moment only (through the folder itself, then put back). A folder no one may search is skipped: git cannot reach into
 * it either. Throws past the deadline. */
function walk(roots: readonly string[], deadline: number, mac: boolean): string[] {
  const out: string[] = []
  const stack = [...roots]
  while (stack.length) {
    if (Date.now() > deadline) throw new Error('the folders took too long to check for git hooks')
    const dir = stack.pop()!
    let ents: fs.Dirent[] | null = null
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EACCES') continue
      let st: fs.Stats
      try { st = fs.lstatSync(dir) } catch { continue }
      if (!st.isDirectory() || (st.mode & 0o111) === 0) continue
      for (const n of GIT_HOOK_NAMES) { const p = path.join(dir, n); try { fs.lstatSync(p); out.push(p) } catch { /* not there */ } }
      ents = withModeFor(dir, st, st.mode | 0o500, () => fs.readdirSync(dir, { withFileTypes: true }))
      if (!ents) throw new Error('a folder could not be checked for git hooks')
    }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if ((e.isFile() || e.isSymbolicLink()) && (isHookName(e.name) || (mac && !ASCII.test(e.name)))) out.push(p)
    }
  }
  return out
}

// ---------------- changing a mode through the file itself ----------------

/** Linux's O_PATH (not in node's constants): a descriptor of the file itself, with no read or write access needed. */
const O_PATH = 0o10000000

/** Change the mode of the file at `abs` (not following a link) to `mode`, when it is still the file `want` (device and
 * inode). True when changed. Linux: an O_PATH descriptor and chmod through /proc/self/fd (no read access needed: an
 * exec-only file too). macOS: a read descriptor, else lchmod (which never follows a link). */
function setMode(abs: string, want: fs.Stats, mode: number, linux: boolean): boolean {
  if (linux) {
    let fd: number
    try { fd = fs.openSync(abs, O_PATH | fs.constants.O_NOFOLLOW) } catch { return false }
    try {
      const st = fs.fstatSync(fd)
      if (st.dev !== want.dev || st.ino !== want.ino || (!st.isFile() && !st.isDirectory())) return false
      fs.chmodSync(`/proc/self/fd/${fd}`, mode)
      return true
    } catch { return false } finally { fs.closeSync(fd) }
  }
  try {
    const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const st = fs.fstatSync(fd)
      if (st.dev !== want.dev || st.ino !== want.ino) return false
      fs.fchmodSync(fd, mode)
      return true
    } finally { fs.closeSync(fd) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EACCES') return false
  }
  // no read access (an exec-only file): lchmod changes the entry itself, never a link's target
  // (its folder checked by device, inode and real path before and after: a folder swapped for a link meanwhile is seen)
  try {
    const dir = path.dirname(abs), d0 = fs.lstatSync(dir)
    const st = fs.lstatSync(abs)
    if (st.dev !== want.dev || st.ino !== want.ino || st.isSymbolicLink() || realOfEntry(dir) !== dir) return false
    fs.lchmodSync(abs, mode)
    const d1 = fs.lstatSync(dir), st1 = fs.lstatSync(abs)
    return d1.dev === d0.dev && d1.ino === d0.ino && st1.ino === want.ino && (st1.mode & 0o7777) === (mode & 0o7777)
  } catch { return false }
}

/** Run `fn` while the folder has `mode`, then put its mode back. Null when the mode could not be changed. */
function withModeFor<T>(dir: string, st: fs.Stats, mode: number, fn: () => T): T | null {
  const linux = process.platform === 'linux'
  if (!setMode(dir, st, mode, linux)) return null
  try { return fn() } catch { return null } finally { setMode(dir, st, st.mode & 0o7777, linux) }
}

/** The hook's name of a file with more than one name gets a copy of its own without the exec bit (the other name, maybe
 * outside the team folder, keeps its mode); a file it cannot read loses that name. True when done. */
function splitLink(abs: string, st: fs.Stats): boolean {
  const dir = path.dirname(abs)
  const tmp = path.join(dir, `.trina-hook-${process.pid}-${Date.now().toString(36)}`)
  // the folder is checked by device and inode before and after the copy is made: a folder swapped for a link meanwhile
  // (the copy would land elsewhere) stops it and the copy is removed
  let d0: fs.Stats
  try { d0 = fs.lstatSync(dir); if (!d0.isDirectory()) return false } catch { return false }
  const sameDir = () => { try { const d = fs.lstatSync(dir); return d.isDirectory() && d.dev === d0.dev && d.ino === d0.ino && realOfEntry(dir) === dir } catch { return false } }
  try {
    let bytes: Buffer | null = null
    try {
      const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      try { if (fs.fstatSync(fd).ino !== st.ino) return false; bytes = fs.readFileSync(fd) } finally { fs.closeSync(fd) }
    } catch { bytes = null }
    const now = fs.lstatSync(abs)
    if (now.ino !== st.ino || now.dev !== st.dev || !sameDir()) return false
    if (bytes === null) { fs.unlinkSync(abs); return true }
    fs.writeFileSync(tmp, bytes, { mode: st.mode & 0o666, flag: 'wx' })
    const t = fs.lstatSync(tmp)
    if (!sameDir() || t.dev !== d0.dev) { fs.rmSync(tmp, { force: true }); return false }
    fs.renameSync(tmp, abs)
    return true
  } catch { try { fs.rmSync(tmp, { force: true }) } catch { /* gone */ } return false }
}

// ---------------- the sweep ----------------

interface Ctx { roots: string[]; visible: Visible; mayRead?: (abs: string) => boolean; linux: boolean; mac: boolean; changed: string[]; failed: string[] }

/** Is this entry a file git could open by a hook's name? An ASCII name: one of the names in any case. Another name
 * (macOS): one of the hook names, looked up in its folder, is this very entry. */
function hookByName(abs: string, st: fs.Stats, mac: boolean): boolean {
  const name = path.basename(abs)
  if (isHookName(name)) return true
  if (!mac || ASCII.test(name)) return false
  const dir = path.dirname(abs)
  return GIT_HOOK_NAMES.some((n) => { try { const s = fs.lstatSync(path.join(dir, n)); return s.dev === st.dev && s.ino === st.ino } catch { return false } })
}

/** The real path of an entry, every link followed by hand with lstat and readlink: nothing is opened (realpath opens
 * the path on some runtimes, which an exec-only file or a folder with no read bit refuses). */
function realOfEntry(p: string): string {
  let todo = path.resolve(p).split('/').filter(Boolean)
  let cur = '/', links = 0
  while (todo.length) {
    const part = todo.shift()!
    if (part === '.') continue
    if (part === '..') { cur = path.dirname(cur); continue }
    const next = path.join(cur, part)
    const st = fs.lstatSync(next)
    if (st.isSymbolicLink()) {
      if (++links > 40) throw new Error('too many links')
      const t = fs.readlinkSync(next)
      todo = [...t.split('/').filter(Boolean), ...todo]
      if (t.startsWith('/')) cur = '/'
      continue
    }
    cur = next
  }
  return cur
}

/** Take the exec bits of one file the sweep must make safe (`abs`, with no link followed). */
function makeSafe(c: Ctx, abs: string, st: fs.Stats, within: readonly string[]) {
  if (!st.isFile() || (st.mode & 0o111) === 0) return
  // the path, its folders resolved, is still where it was found (a folder swapped for a link meanwhile is not followed)
  let real: string
  try { real = realOfEntry(abs) } catch { return }
  if (!within.some((r) => inside(real, r))) return
  const ok = st.nlink > 1 ? splitLink(real, st) : setMode(real, st, st.mode & 0o666, c.linux)
  if (ok) c.changed.push(real)
  else {
    // gone or changed meanwhile is no failure; an executable hook that is still there is
    try { const now = fs.lstatSync(real); if (now.isFile() && now.ino === st.ino && now.mode & 0o111) c.failed.push(real) } catch { /* gone */ }
  }
}

function handle(c: Ctx, f: string) {
  let st: fs.Stats
  try { st = fs.lstatSync(f) } catch { return }
  if (st.isSymbolicLink()) {
    if (!hookByName(f, st, c.mac)) return
    // git follows the link: its target is the hook. Only a target the run may read is changed (another person's folder
    // or a system program is not the team's code that this run could run)
    let target: string
    try { target = realOfEntry(f) } catch { return }
    if (!visibleIn(c.visible, target) || (c.mayRead && !c.mayRead(target))) return
    let ts: fs.Stats
    try { ts = fs.lstatSync(target) } catch { return }
    makeSafe(c, target, ts, c.visible.read)
    return
  }
  if (!st.isFile() || (st.mode & 0o111) === 0 || !hookByName(f, st, c.mac)) return
  makeSafe(c, f, st, c.roots)
}

const realOf = (l: readonly string[]) => [...new Set(l.map((r) => { try { return realOfEntry(r) } catch { return '' } }).filter(Boolean))]
function ctxOf(roots: readonly string[], o: SweepOptions): Ctx | null {
  const real = realOf(roots)
  if (!real.length) return null
  const platform = o.platform ?? process.platform
  // no view given: a link is not followed (its target might be a file its maker may not open)
  const visible = o.visible ? { read: realOf(o.visible.read), deny: realOf(o.visible.deny ?? []) } : { read: [] }
  return { roots: real, visible, mayRead: o.mayRead, linux: platform === 'linux', mac: platform === 'darwin', changed: [], failed: [] }
}
function finish(c: Ctx): string[] {
  if (c.failed.length) throw new Error(`a git hook file could not be made safe (${c.failed.length})`)
  return c.changed
}

/** Take the exec bits of every file that git could run as a hook under `roots` (absolute folders a run may write).
 * Returns the changed paths. Throws when the folders cannot be checked in time or a hook cannot be made safe. */
export async function sweepHooks(roots: readonly string[], o: SweepOptions = {}): Promise<string[]> {
  const c = ctxOf(roots, o)
  if (!c) return []
  for (const f of await findHookCandidates(c.roots, o)) handle(c, f)
  return finish(c)
}

/** The same for one entry that just appeared (Files moved, copied or restored it): a file, or a folder and all in it
 * (listed by find, off the event loop). */
export async function sweepEntry(abs: string, o: SweepOptions = {}): Promise<string[]> {
  const c = ctxOf([abs], o)
  if (!c) return []
  let st: fs.Stats
  try { st = fs.lstatSync(abs) } catch { return [] }
  if (st.isDirectory()) for (const f of await findHookCandidates(c.roots, o)) handle(c, f)
  else handle(c, c.roots[0]!)
  return finish(c)
}

/** The folders of a run's settings to sweep: what it may write, without its own home and temp folder (a person's or
 * a command's own: no one else's run reads them). */
export function sweepRoots(allowWrite: readonly string[], own: readonly string[]): string[] {
  return allowWrite.filter((w) => !own.some((h) => inside(w, h)))
}

/** What a run may read in the team folder (its settings): a hook-named link's target is changed only there. Personal
 * folders are left out (a link to her own file runs her own code). */
export function visibleOf(fsSettings: { allowRead: readonly string[]; allowWrite: readonly string[]; denyRead: readonly string[] }, teamRoot: string): Visible {
  const users = path.join(teamRoot, 'users')
  const read = [...fsSettings.allowRead, ...fsSettings.allowWrite].filter((p) => inside(p, teamRoot) && !inside(p, users))
  return { read, deny: fsSettings.denyRead.filter((p) => inside(p, teamRoot)) }
}

/** Of the folders other people's live runs may write, the ones this run may read (they may hold a hook written after
 * that run's last sweep). */
export function othersLive(live: Iterable<{ userId: string; roots: readonly string[] }>, userId: string, v: Visible): string[] {
  const out = new Set<string>()
  for (const l of live) {
    if (l.userId === userId) continue
    for (const r of l.roots) {
      if (visibleIn(v, r)) out.add(r)
      // a part of it this run may read
      for (const g of v.read) if (g !== r && inside(g, r) && visibleIn(v, g)) out.add(g)
    }
  }
  return [...out]
}
