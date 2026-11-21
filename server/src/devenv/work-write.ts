// A safe write into a chat's work folder ($TRINA_WORK, chat:work/…) by the server: a file or a whole folder (an HTML
// file and its images folder) copied in for the AI (docs/AGENTS/plan/20261121-0648-work-safe-write.md; the hard
// prerequisite of P2 in 20261121-0615-chat-places-as-paths.md, review must-fix 3 and 5).
//
// The work folder is written by sandboxed commands at any time, and Node/Bun has no openat: a write by path looks up
// every folder on the way again, and a command can swap one for a link to a server folder in between, so the server
// (which may write much more than the box) would write outside. safe-ops/broker.ts would avoid it with openat2, but it
// is Linux only. So the server never writes into the work folder itself:
//   1. it STAGES the source in a new server folder <base>/devenv/stage/<id>/item: every file from one checked
//      descriptor (O_NOFOLLOW, a regular file with one link, the kernel's path of the open file exactly the one the
//      walk expected: a folder swapped for a link refuses the whole copy), links, devices, pipes and hard links never
//      copied, names checked, the quarantine hash checked, the limits checked before anything reaches the work folder;
//   2. a BOX COMMAND copies it in (runner.ts runCommand, in the space spaceOf gives: it makes the folder, and a shared
//      chat's run records what it may read): the stage folder is read-only in that run (config.ts srtSettings stage),
//      and `cp -R -P` runs with the box's own rights, so a link a command left in the work folder can lead the copy only
//      where the sandbox lets that box write anyway. Never an overwrite: a name taken gets "name (2).ext";
//   3. a shared chat: the copy's read group joins the record of its workspace key first (srt/copied-in.ts), so every
//      later run or read on that key records it again.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AppContext } from '../context'
import type { ReadSource } from '../chat/read-scope'
import { Denied, ToolError } from '../policy/errors'
import { openToRead } from '../files/store'
import { openFilePath } from './snapshot'
import type { WorkFolder } from './work-files'
import { devenvPaths } from './srt/config'
import { addCopiedIn, readCopiedIn, type CopiedGroup } from './srt/copied-in'
import { newRunId, noteCopiedIn as noteCopiedInRun, runCommand, spaceOf, srtConfig, workFolderAt, type SharedRun } from './srt/runner'

/** one call at most (the plan's copy limits, section 6) */
export const WORK_COPY_MAX_BYTES = 1024 ** 3
export const WORK_COPY_MAX_FILES = 2000
/** how long the box command may take (1 GB on a slow disk) */
const COPY_TIMEOUT_MS = 10 * 60_000
/** a stage folder left by a server that stopped mid-copy goes at the next copy after this */
const STAGE_STALE_MS = 3600_000

const C = fs.constants
const CONTROL = /[\u0000-\u001f\u007f]/

/** What to copy. Every `abs` is a real path (no folder on the way a link; one that is refuses the copy). A team file:
 * `abs` and `seen`, the lstat of its permission check (policy/authorize.ts), as every team read. A folder: walked
 * here; `include` is the caller's permission check for each entry (its path in the folder, '/'-separated): false leaves
 * it out (and a folder's whole content). Server-owned files (a chat file's copy) without `seen`. */
export type WorkSource =
  | { kind: 'file'; abs: string; seen?: fs.Stats; name?: string }
  | { kind: 'folder'; abs: string; include?: (rel: string, kind: 'file' | 'folder') => boolean }

/** Where the copy goes: the chat and person of the turn, as box_shell's commands see them. `expect`: the work folder the
 * caller resolved (and showed the person); another one now (the people of the chat changed) refuses the copy. */
export interface WorkTarget {
  userId: string
  chatId: string
  project: { id: string; folderPath: string } | null
  shared?: SharedRun
  expect?: WorkFolder | null
}

export interface WorkWriteOptions {
  /** what the copy was read from (the read card's sources, with every boundary folder under a copied folder): required
   * in a shared chat, recorded under its workspace key */
  sources?: readonly ReadSource[]
  /** each file at most (the plan's read limit); default WORK_COPY_MAX_BYTES */
  maxFileBytes?: number
  /** what the turn may still write (turnWriteLimits): the copy counts against it */
  turnLeft?: { bytes: number; files: number }
  signal?: AbortSignal
}

export interface WorkWriteResult {
  /** where it landed in the work folder ('/'-separated, relative to it): `dest`, or "name (2).ext" when taken */
  path: string
  files: number
  bytes: number
  /** entries of a folder that were not copied, and why */
  skipped: { path: string; why: 'link' | 'not a regular file' | 'hard link' | 'name' }[]
  /** a folder on the way in the work folder is a link a command made (the first one): the copy went where it points,
   * as far as the sandbox let the box write there. The caller tells the AI (the file is not in the work folder itself) */
  viaLink?: string
}

/** One name in a path: no empty part, no "." or "..", no "/" or "\", no control character, at most 255 bytes. */
export function validName(seg: string): boolean {
  return seg !== '' && seg !== '.' && seg !== '..' && !seg.includes('/') && !seg.includes('\\') && !CONTROL.test(seg) && Buffer.byteLength(seg) <= 255
}

/** The relative path in the work folder that `dest` names ('' for the folder itself), NFC, '/'-separated. Throws
 * ToolError with plain words for anything that would leave the folder or is not a plain name. */
export function validWorkRel(dest: string): string {
  if (typeof dest !== 'string') throw new ToolError('name a path in the work folder', 'bad_path')
  const p = dest.normalize('NFC').trim()
  if (p.startsWith('/') || p.startsWith('~')) throw new ToolError('a path in the work folder is relative to it (no "/" or "~" at the start)', 'bad_path')
  const segs = p.split('/').filter((s, i, a) => !(s === '.' && a.length > 1) && !(s === '' && i === a.length - 1))
  if (segs.length === 1 && (segs[0] === '' || segs[0] === '.')) return ''
  if (segs.length > 32 || Buffer.byteLength(p) > 1024) throw new ToolError('that path in the work folder is too long', 'bad_path')
  for (const s of segs) if (!validName(s)) throw new ToolError(`'${s.slice(0, 80)}' is not a name a file in the work folder can have (no "..", empty parts or control characters)`, 'bad_path')
  return segs.join('/')
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const mb = (n: number) => `${(n / 1024 ** 2).toFixed(0)} MB`

interface Plan { files: number; bytes: number }

/** The limits of one copy, as words for the AI when one is passed. */
function limits(o: WorkWriteOptions) {
  const maxFile = Math.min(o.maxFileBytes ?? WORK_COPY_MAX_BYTES, WORK_COPY_MAX_BYTES)
  const maxBytes = Math.min(WORK_COPY_MAX_BYTES, o.turnLeft?.bytes ?? Infinity)
  const maxFiles = Math.min(WORK_COPY_MAX_FILES, o.turnLeft?.files ?? Infinity)
  return {
    maxFile,
    check(p: Plan, size: number, name: string) {
      if (size > maxFile) throw new ToolError(`'${name}' is too large to copy into the work folder (${mb(size)}; at most ${mb(maxFile)} a file). Nothing was copied.`, 'too_large')
      if (p.files + 1 > maxFiles) throw new ToolError(maxFiles < WORK_COPY_MAX_FILES ? `this copy has more files than this answer may still write (${maxFiles}). Nothing was copied.` : `this copy has more than ${WORK_COPY_MAX_FILES} files, the most one copy may have. Nothing was copied.`, 'too_large')
      if (p.bytes + size > maxBytes) throw new ToolError(maxBytes < WORK_COPY_MAX_BYTES ? `this copy is larger than this answer may still write (${mb(maxBytes)}). Nothing was copied.` : `this copy is larger than ${mb(WORK_COPY_MAX_BYTES)}, the most one copy may be. Nothing was copied.`, 'too_large')
      p.files++; p.bytes += size
    },
  }
}

/** Stream the open file `fd` (of `size` bytes) into the new stage file `dest`; its sha256. */
async function streamInto(fd: number, size: number, dest: string, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
  const out = fs.openSync(dest, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
  try {
    const h = crypto.createHash('sha256')
    const buf = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, Math.max(1, size)))
    const read = (pos: number, len: number) => new Promise<number>((ok, no) => fs.read(fd, buf, 0, len, pos, (e, n) => (e ? no(e) : ok(n))))
    const write = (at: number, from: number, len: number) => new Promise<number>((ok, no) => fs.write(out, buf, from, len, at, (e, n) => (e ? no(e) : ok(n))))
    let pos = 0
    // up to the size fstat gave: a file that grows meanwhile is copied as it was when it was checked
    while (pos < size) {
      signal?.throwIfAborted()
      const n = await read(pos, Math.min(buf.length, size - pos))
      if (n <= 0) break
      h.update(buf.subarray(0, n))
      for (let w = 0; w < n;) w += await write(pos + w, w, n - w)
      pos += n
    }
    return { size: pos, sha256: h.digest('hex') }
  } finally { fs.closeSync(out) }
}

/** Open a file of a walked folder: O_NOFOLLOW, regular, one link, and the kernel's path of the open file exactly
 * `expected` (a folder on the way swapped for a link since the listing refuses). */
function openExact(abs: string, expected: string): { fd: number; st: fs.Stats } | { skip: WorkWriteResult['skipped'][number]['why'] } {
  let fd: number
  try { fd = fs.openSync(abs, C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)) } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EMLINK') return { skip: 'link' }
    throw new Denied('the folder changed while it was copied; nothing was copied')
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) { fs.closeSync(fd); return { skip: 'not a regular file' } }
    if (st.nlink > 1) { fs.closeSync(fd); return { skip: 'hard link' } }
    let real: string | null = null
    try { real = openFilePath(fd) } catch { real = null }
    if (real !== expected) throw new Denied('the folder changed while it was copied (a folder on the way became a link); nothing was copied')
    return { fd, st }
  } catch (e) { try { fs.closeSync(fd) } catch {} throw e }
}

/** `real` (fs.realpathSync of `given`) must be `given` itself: no folder on the way is a link. (macOS: one file for
 * every Unicode form of its name, and the system's path has the form on disk: a Korean name made in Finder is NFD, a
 * path typed is NFC.) */
function realOrRefuse(real: string, given: string, name: string) {
  const want = path.resolve(given)
  if (process.platform === 'darwin' ? real.normalize('NFC') === want.normalize('NFC') : real === want) return
  throw new Denied(`a folder on the way to '${name}' is a link (or it changed while it was copied); links are not followed, and nothing was copied`)
}

/** Stage the source in `item` (a new path in the stage folder). Every limit and check is done here, before the box
 * command runs. */
async function stage(ctx: AppContext, source: WorkSource, item: string, o: WorkWriteOptions): Promise<{ plan: Plan; skipped: WorkWriteResult['skipped'] }> {
  const lim = limits(o)
  const plan: Plan = { files: 0, bytes: 0 }
  const skipped: WorkWriteResult['skipped'] = []
  const q = ctx.files.quarantine
  if (source.kind === 'file') {
    const name = source.name ?? path.basename(source.abs)
    let opened: { fd: number; st: fs.Stats }
    if (source.seen) opened = openToRead(source.abs, source.seen)
    else {
      let realDir: string
      try { realDir = fs.realpathSync(path.dirname(source.abs)) } catch { throw new ToolError(`'${name}' was not found`, 'not_found') }
      // the same rule as a folder's (realOrRefuse): a folder on the way that is a link (a work folder's, which every
      // command may make) would lead the open where it points; the caller passes the real path
      realOrRefuse(realDir, path.dirname(source.abs), name)
      const r = openExact(source.abs, path.join(realDir, path.basename(source.abs)))
      if ('skip' in r) throw new Denied(`'${name}' is ${r.skip === 'link' ? 'a link; links are not copied' : r.skip === 'hard link' ? 'a hard-linked file; those are refused' : 'not a regular file'}`)
      opened = r
    }
    try {
      lim.check(plan, opened.st.size, name)
      const got = await streamInto(opened.fd, opened.st.size, item, o.signal)
      q.assertHash(got.sha256)
    } finally { fs.closeSync(opened.fd) }
    return { plan, skipped }
  }
  // a folder: its own last name is no link, and the walk is checked against its real path
  let st: fs.Stats
  try { st = fs.lstatSync(source.abs) } catch { throw new ToolError(`'${path.basename(source.abs)}' was not found`, 'not_found') }
  if (st.isSymbolicLink()) throw new Denied(`'${path.basename(source.abs)}' is a link; links are not copied`)
  if (!st.isDirectory()) throw new ToolError(`'${path.basename(source.abs)}' is not a folder`, 'not_folder')
  // the caller's path is the real one (a team path: the team folder's real path plus the names on disk, as every
  // team read; policy/authorize.ts). A folder on the way that is a link (made by a command of the person, before or after
  // the caller's check) would lead the whole walk where it points, and every file there would pass its check below
  const realRoot = fs.realpathSync(source.abs)
  realOrRefuse(realRoot, source.abs, path.basename(source.abs))
  // first the plan: every entry and the limits by lstat, so a copy over a limit stages nothing at all
  type E = { rel: string; kind: 'file' | 'folder' }
  const entries: E[] = []
  const walk = (rel: string) => {
    let list: fs.Dirent[]
    try { list = fs.readdirSync(rel ? path.join(realRoot, rel) : realRoot, { withFileTypes: true }) } catch { throw new Denied('the folder changed while it was copied; nothing was copied') }
    for (const e of list.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (!validName(e.name)) { skipped.push({ path: r, why: 'name' }); continue }
      let s: fs.Stats
      try { s = fs.lstatSync(path.join(realRoot, r)) } catch { continue }
      if (s.isSymbolicLink()) { skipped.push({ path: r, why: 'link' }); continue }
      if (s.isDirectory()) {
        if (source.include && !source.include(r, 'folder')) continue
        entries.push({ rel: r, kind: 'folder' }); walk(r); continue
      }
      if (!s.isFile()) { skipped.push({ path: r, why: 'not a regular file' }); continue }
      if (s.nlink > 1) { skipped.push({ path: r, why: 'hard link' }); continue }
      if (source.include && !source.include(r, 'file')) continue
      lim.check(plan, s.size, r)
      entries.push({ rel: r, kind: 'file' })
    }
  }
  walk('')
  // then the copy, each file from its checked descriptor (its size counted again from fstat)
  const done: Plan = { files: 0, bytes: 0 }
  fs.mkdirSync(item, { mode: 0o700 })
  for (const e of entries) {
    o.signal?.throwIfAborted()
    const to = path.join(item, ...e.rel.split('/'))
    if (e.kind === 'folder') { fs.mkdirSync(to, { mode: 0o700 }); continue }
    const r = openExact(path.join(realRoot, e.rel), path.join(realRoot, ...e.rel.split('/')))
    if ('skip' in r) { skipped.push({ path: e.rel, why: r.skip }); continue }
    try {
      lim.check(done, r.st.size, e.rel)
      const got = await streamInto(r.fd, r.st.size, to, o.signal)
      q.assertHash(got.sha256)
    } finally { fs.closeSync(r.fd) }
  }
  return { plan: done, skipped }
}

/** The first folder of `rel` in `root` that is a link now (lstat, nothing followed), or null. Only for the note: the
 * copy is done, and nothing is opened through it. */
function firstLink(root: string, rel: string): string | null {
  const segs = rel.split('/')
  for (let i = 1; i < segs.length; i++) {
    const r = segs.slice(0, i).join('/')
    try { if (fs.lstatSync(path.join(root, r)).isSymbolicLink()) return r } catch { return null }
  }
  return null
}

/** Stage folders of copies that ended long ago (a server stopped mid-copy) go. */
function dropStaleStages(dir: string) {
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return }
  for (const n of names) {
    const p = path.join(dir, n)
    try { if (Date.now() - fs.lstatSync(p).mtimeMs > STAGE_STALE_MS) fs.rmSync(p, { recursive: true, force: true }) } catch {}
  }
}

/** The box command: make the parent, find a free name, copy the staged item with the box's rights, say where it went.
 * Every value is quoted; names are checked already. */
export function copyInScript(stageItem: string, parent: string, leaf: string, isFolder: boolean): string {
  const dot = isFolder ? -1 : leaf.lastIndexOf('.')
  const base = dot > 0 ? leaf.slice(0, dot) : leaf, ext = dot > 0 ? leaf.slice(dot) : ''
  return [
    'set -u',
    `S=${shellQuote(stageItem)}`,
    `P=${shellQuote(parent ? `./${parent}` : '.')}`,
    `B=${shellQuote(base)}`,
    `E=${shellQuote(ext)}`,
    'mkdir -p -- "$P" 2>/dev/null; [ -d "$P" ] || { echo "TRINA-COPY:parent" >&2; exit 21; }',
    'T="$P/$B$E"; i=2',
    'while [ -e "$T" ] || [ -L "$T" ]; do [ "$i" -gt 999 ] && { echo "TRINA-COPY:names" >&2; exit 22; }; T="$P/$B ($i)$E"; i=$((i+1)); done',
    'cp -R -P -- "$S" "$T" || { rm -rf -- "$T"; echo "TRINA-COPY:cp" >&2; exit 23; }',
    'printf "TRINA-WROTE:%s\\n" "$T"',
  ].join('\n')
}

/**
 * Copy `source` into the chat's work folder at `dest` (relative to it; '' or a trailing "/" means "into that folder,
 * with the source's own name"). Never an overwrite: a name taken gets "name (2).ext". Limits: each file at most
 * `maxFileBytes`, one call at most 1 GB and 2,000 files and what the turn may still write; over a limit nothing is
 * copied. ToolError/Denied with plain words for the AI.
 */
export async function writeIntoWork(ctx: AppContext, target: WorkTarget, dest: string, source: WorkSource, o: WorkWriteOptions = {}): Promise<WorkWriteResult> {
  const c = srtConfig()
  let rel = validWorkRel(dest)
  const own = source.kind === 'file' ? (source.name ?? path.basename(source.abs)) : path.basename(source.abs)
  if (rel === '' || dest.trim().endsWith('/')) {
    const name = own.normalize('NFC')
    if (!validName(name)) throw new ToolError(`'${name.slice(0, 80)}' is not a name a file in the work folder can have`, 'bad_path')
    rel = rel ? `${rel}/${name}` : name
  }
  if (target.shared && !o.sources) throw new Error('a copy into a shared chat\'s work folder needs its sources')
  const where = { userId: target.userId, chatId: target.chatId, project: target.project, ...(target.shared ? { shared: target.shared } : {}) }
  // the folder the caller resolved must still be this chat's for its people now (looked up without making one)
  const changed = "the people in this chat changed, so its commands now start in a new, empty work folder; nothing was copied. Look at the work folder again and copy into it"
  if (target.expect && workFolderAt(ctx, where)?.path !== target.expect.path) throw new ToolError(changed, 'work_changed')
  // the space box_shell's commands use now: it makes the work folder (the one place that may create it)
  const space = spaceOf(ctx, where)
  const p = devenvPaths(c.base)
  const inWork = !!space && [p.work, p.workShared].some((d) => space.root.startsWith(d + path.sep))
  if (!space || !inWork) throw new ToolError("this chat has no work folder here (its commands run in the project folder, or the dev environment is not available to this person now)", 'no_work')
  if (target.expect && target.expect.path !== space.root) throw new ToolError(changed, 'work_changed')
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  const leaf = rel.slice(rel.lastIndexOf('/') + 1)

  fs.mkdirSync(p.stage, { recursive: true, mode: 0o700 })
  dropStaleStages(p.stage)
  const dir = path.join(p.stage, newRunId())
  fs.mkdirSync(dir, { mode: 0o700 })
  try {
    const item = path.join(dir, 'item')
    const { plan, skipped } = await stage(ctx, source, item, o)
    // a shared chat: the copy's read group joins its key's record before anything reaches the folder (a stop mid-copy
    // records more, never less); the copy's own run records it into this answer (runner.ts noteSharedRun)
    if (target.shared && o.sources!.length) {
      try { addCopiedIn(c.base, target.chatId, space.root, { c: [...target.shared.audience()], s: [...o.sources!] }) } catch (e) {
        throw new ToolError(`what this copy was read from could not be recorded (${(e as Error).message}); nothing was copied`, 'record_failed')
      }
    }
    const r = await runCommand(ctx, { space, cwd: '.', command: copyInScript(item, parent, leaf, source.kind === 'folder'), shown: `copy into the work folder: ${rel}`, timeoutMs: COPY_TIMEOUT_MS, ...(o.signal ? { signal: o.signal } : {}), stage: dir })
    if (!r.ok) throw new ToolError(`the copy into the work folder did not run: ${r.message}`, 'copy_failed')
    const v = r.value
    const wrote = /(?:^|\n)TRINA-WROTE:\.\/(.+)\n?$/.exec(v.stdout)
    if (v.code !== 0 || !wrote) {
      const why = v.signal ? `it was stopped (${v.signal})` : /TRINA-COPY:parent/.test(v.stderr) ? `'${parent}' is not a folder the work folder's commands may make` : /TRINA-COPY:names/.test(v.stderr) ? 'every free name like it is taken' : 'the box could not write it there (a folder on the way may be a link to a place commands may not write, or a name such as .git/hooks or a shell start file that the dev environment keeps commands from writing); the half-made copy was removed'
      throw new ToolError(`the copy into the work folder failed: ${why}`, 'copy_failed')
    }
    const landed = wrote[1]!
    const link = firstLink(space.root, landed)
    return { path: landed, files: plan.files, bytes: plan.bytes, skipped, ...(link ? { viaLink: link } : {}) }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/** What was copied into this work folder for a shared chat's people now (srt/copied-in.ts), for a listing. */
export function copiedInOf(chatId: string, workRoot: string): CopiedGroup[] {
  try { return readCopiedIn(srtConfig().base, chatId, workRoot) } catch { return [] }
}

/** A `read`/`list`/`grep` of a shared chat's work folder (P1/P2): what was copied into it joins this answer's record
 * again, before anything of it is given. False: not recorded, so nothing may be given (fails closed). A personal chat
 * (no `shared`): true. */
export function noteCopiedIn(ctx: AppContext, o: { chatId: string; shared?: SharedRun; workRoot: string }): boolean {
  void ctx
  return noteCopiedInRun(o.shared, o.chatId, o.workRoot)
}
