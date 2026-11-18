// Disk clean-up of the dev environment (docs/DECISIONS.md "Disk: what is kept and what goes"). The AI's commands run
// with a home per person (devenv/home/<user>: npm, pip and bun caches, tmp) and a work folder per chat with no project
// (devenv/work/<chat>); neither shrank by itself, so a small team disk filled with caches and node_modules. Hourly
// (system/ops.ts), as the server account (it owns devenv/):
//
//   caches   per person: devenv/home/<user>/.npm/_cacache, .npm/_logs, .cache/pip, .bun/install/cache. A cache folder
//            is removed whole when nothing in it changed for CACHE_IDLE_DAYS, or when it is over CACHE_MAX_BYTES (it
//            fills again from the network). tmp/: entries older than TMP_KEEP_DAYS. Never while the person has a run.
//            Not the browser downloads (the network allows no download of them: a removed Chromium would not come back).
//   work     per chat: ONLY the folders a tool makes again (system/regenerable.ts: node_modules, .next, .venv ...) and
//            only when the whole chat has been idle for WORK_IDLE_DAYS (no run of it, no turn or chat change in the
//            database, no file outside those folders changed). Everything else in a work folder is the person's and
//            stays: no work folder is ever removed here (that happens when the chat is purged, chat/forget.ts).
//   never    project folders (they are team folders: shared, recorded, backed up), links (lstat only, never followed),
//            dist / build / out (they can be the result the person asked for).
//
// The safer of "show the admin and clear on a click" and "clear by itself" is clearing by itself, restricted to what a
// command brings back (`npm install`); user files are never touched, so there is nothing to confirm.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { devenvPaths, SAFE_ID_RE } from '../devenv/srt/config'
import type { Logger } from '../log'
import { isRegenerableDir } from './regenerable'

const DAY = 86_400_000
export const CACHE_IDLE_DAYS = 14
export const CACHE_MAX_BYTES = 1024 ** 3
export const TMP_KEEP_DAYS = 7
export const WORK_IDLE_DAYS = 14
/** a tree with more entries than this counts as over the size cap (and is not walked further) */
const SCAN_LIMIT = 400_000

/** cache folders under a person's home, relative to it */
export const CACHE_ROOTS = ['.npm/_cacache', '.npm/_logs', '.cache/pip', '.bun/install/cache'] as const

export interface CleanItem { path: string; kind: 'cache' | 'tmp' | 'build'; bytes: number }
export interface CleanResult { removed: CleanItem[]; keptBusy: number; errors: { path: string; error: string }[]; removedBytes: number }

export interface CleanOptions {
  /** the base folder (devenv/ is under it) */
  base: string
  now: () => number
  log?: Pick<Logger, 'info' | 'warn'>
  /** people and chats with a run now */
  busy: () => { users: ReadonlySet<string>; chats: ReadonlySet<string> }
  /** the last activity of a chat in the database (ms), or null when there is no such chat */
  chatActivity: (chatId: string) => number | null
  dryRun?: boolean
  /** tests: the size cap of one cache folder */
  cacheMaxBytes?: number
}

interface Scan { bytes: number; newest: number; truncated: boolean }

/** Size on disk and newest mtime of a tree; links are not followed; `into` decides which folders are entered. */
async function scan(dir: string, into: (name: string, abs: string) => boolean = () => true): Promise<Scan> {
  const r: Scan = { bytes: 0, newest: 0, truncated: false }
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let st: fs.Stats
    try { st = await fsp.lstat(d) } catch { continue }
    r.newest = Math.max(r.newest, st.mtimeMs)
    let names: string[]
    try { names = await fsp.readdir(d) } catch { continue }
    for (const name of names) {
      const abs = path.join(d, name)
      let s: fs.Stats
      try { s = await fsp.lstat(abs) } catch { continue }
      r.bytes += s.blocks !== undefined ? s.blocks * 512 : s.size
      r.newest = Math.max(r.newest, s.mtimeMs)
      if (s.isDirectory() && into(name, abs)) stack.push(abs)
      if (++n >= SCAN_LIMIT) { r.truncated = true; return r }
      if (n % 1000 === 0) await new Promise((res) => setImmediate(res))
    }
  }
  return r
}

async function ls(dir: string): Promise<fs.Dirent[]> {
  try { return await fsp.readdir(dir, { withFileTypes: true }) } catch { return [] }
}

/** The regenerable folders of a work folder, and the newest change of everything else (the folders themselves count as
 * changed when their own mtime says so: an install that ended an hour ago keeps the chat young). */
async function scanWork(root: string): Promise<{ build: { abs: string; bytes: number }[]; newest: number }> {
  const build: { abs: string; bytes: number }[] = []
  let newest = 0
  const stack = [root]
  let n = 0
  while (stack.length) {
    const d = stack.pop()!
    try { newest = Math.max(newest, (await fsp.lstat(d)).mtimeMs) } catch { continue }
    for (const e of await ls(d)) {
      const abs = path.join(d, e.name)
      if (e.isDirectory()) {
        if (isRegenerableDir(e.name, abs)) { build.push({ abs, bytes: 0 }); continue }
        stack.push(abs)
      } else {
        try { const s = await fsp.lstat(abs); newest = Math.max(newest, s.mtimeMs) } catch {}
      }
      if (++n % 1000 === 0) await new Promise((res) => setImmediate(res))
      if (n >= SCAN_LIMIT) return { build, newest: Date.now() } // too big to judge in one pass: counts as in use
    }
  }
  return { build, newest }
}

/** One pass over devenv/home and devenv/work. Never throws. */
export async function cleanDevenv(o: CleanOptions): Promise<CleanResult> {
  const res: CleanResult = { removed: [], keptBusy: 0, errors: [], removedBytes: 0 }
  const p = devenvPaths(o.base)
  const now = o.now()
  const busy = o.busy()
  const devRoot = (() => { try { return fs.realpathSync(p.root) } catch { return null } })()
  /** every part of `abs` below `top` is a real folder (a person's run may write in its home and make a link of any of
   * them), and what is removed really is inside devenv/ */
  const plain = async (top: string, abs: string): Promise<boolean> => {
    const rel = path.relative(top, abs)
    let cur = top
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part)
      try { if (!(await fsp.lstat(cur)).isDirectory()) return false } catch { return false }
    }
    try { const r = await fsp.realpath(abs); return !!devRoot && r.startsWith(devRoot + path.sep) && r === path.join(await fsp.realpath(top), rel) } catch { return false }
  }
  const drop = async (abs: string, kind: CleanItem['kind'], bytes: number, who: { user?: string; chat?: string }) => {
    if (!o.dryRun) {
      // a run may have started during the pass
      const b = o.busy()
      if ((who.user && b.users.has(who.user)) || (who.chat && b.chats.has(who.chat))) { res.keptBusy++; return }
      try { await fsp.rm(abs, { recursive: true, force: true }) } catch (e) { res.errors.push({ path: path.relative(o.base, abs), error: (e as Error).message }); return }
    }
    res.removed.push({ path: path.relative(o.base, abs), kind, bytes })
    res.removedBytes += bytes
  }

  // a shared chat's runs have a home and logs per command (srt/config.ts runHome), removed when the command ends: one
  // left by a crash goes after TMP_KEEP_DAYS, never while the chat has a run
  for (const top of [p.chatHome, p.chatLogs]) {
    for (const c of await ls(top)) {
      if (!c.isDirectory() || !SAFE_ID_RE.test(c.name)) continue
      if (busy.chats.has(c.name)) { res.keptBusy++; continue }
      const dir = path.join(top, c.name)
      for (const r of await ls(dir)) {
        const abs = path.join(dir, r.name)
        if (!await plain(dir, abs)) continue
        const s = await scan(abs)
        if (now - s.newest >= TMP_KEEP_DAYS * DAY) await drop(abs, 'tmp', s.bytes, { chat: c.name })
      }
    }
  }

  // a shared chat's command's TMPDIR (devenv/rt/<run>, srt/config.ts runTmp), removed when it ends: one a crash left
  // goes after TMP_KEEP_DAYS (a command runs at most 30 minutes, and a live one has new files)
  for (const r of await ls(p.runTmp)) {
    const abs = path.join(p.runTmp, r.name)
    if (!r.isDirectory() || !await plain(p.runTmp, abs)) continue
    const s = await scan(abs)
    if (now - s.newest >= TMP_KEEP_DAYS * DAY) await drop(abs, 'tmp', s.bytes, {})
  }

  // the homes of a person's runs in a project folder (devenv/hp/<hash>, srt/config.ts projectHome): their names say
  // nobody's runs, so only caches idle for CACHE_IDLE_DAYS go (a cache in use has new files)
  for (const u of await ls(p.homeProject)) {
    if (!u.isDirectory() || !/^[0-9a-f]{24}$/.test(u.name)) continue
    const home = path.join(p.homeProject, u.name)
    for (const rel of CACHE_ROOTS) {
      const abs = path.join(home, rel)
      if (!await plain(home, abs)) continue
      const s = await scan(abs)
      if (!s.truncated && now - s.newest >= CACHE_IDLE_DAYS * DAY) await drop(abs, 'cache', s.bytes, {})
    }
  }

  // caches and tmp of every person
  for (const u of await ls(p.home)) {
    if (!u.isDirectory() || !SAFE_ID_RE.test(u.name)) continue
    if (busy.users.has(u.name)) { res.keptBusy++; continue }
    const who = { user: u.name }
    const home = path.join(p.home, u.name)
    for (const rel of CACHE_ROOTS) {
      const abs = path.join(home, rel)
      if (!await plain(home, abs)) continue // a link on the way (.npm, .cache, .bun ...) or a file: not a cache folder of ours
      const s = await scan(abs)
      if (s.truncated || s.bytes > (o.cacheMaxBytes ?? CACHE_MAX_BYTES) || now - s.newest >= CACHE_IDLE_DAYS * DAY) await drop(abs, 'cache', s.bytes, who)
    }
    const tmp = path.join(home, 'tmp')
    if (!await plain(home, tmp)) continue
    for (const e of await ls(tmp)) {
      const abs = path.join(tmp, e.name)
      let s: fs.Stats
      try { s = await fsp.lstat(abs) } catch { continue }
      if (now - s.mtimeMs < TMP_KEEP_DAYS * DAY) continue
      // a folder is judged by its newest file: a dev server's socket or log in it may still be live
      const inner = s.isDirectory() ? await scan(abs) : { bytes: s.size, newest: s.mtimeMs, truncated: false }
      if (now - inner.newest >= TMP_KEEP_DAYS * DAY) await drop(abs, 'tmp', inner.bytes, who)
    }
  }

  // the regenerable folders of chats that have been idle (a shared chat's work folders too: work-shared/<chat>/<people>)
  const works: { name: string; root: string }[] = []
  for (const c of await ls(p.work)) if (c.isDirectory() && SAFE_ID_RE.test(c.name)) works.push({ name: c.name, root: path.join(p.work, c.name) })
  for (const c of await ls(p.workShared)) {
    if (!c.isDirectory() || !SAFE_ID_RE.test(c.name)) continue
    for (const k of await ls(path.join(p.workShared, c.name))) if (k.isDirectory() && SAFE_ID_RE.test(k.name)) works.push({ name: c.name, root: path.join(p.workShared, c.name, k.name) })
  }
  for (const c of works) {
    if (busy.chats.has(c.name)) { res.keptBusy++; continue }
    const act = o.chatActivity(c.name)
    if (act === null || now - act < WORK_IDLE_DAYS * DAY) continue // no chat row: not ours to judge; young: in use
    const root = c.root
    const w = await scanWork(root)
    if (w.build.length === 0 || now - w.newest < WORK_IDLE_DAYS * DAY) continue
    // the build folders' own newest change counts too (an install or a build that ended recently)
    for (const b of w.build) {
      const s = await scan(b.abs)
      // a tree too large to finish is judged by the folder and its first level (an install changes both)
      let newest = s.truncated ? 0 : s.newest
      try { newest = Math.max(newest, (await fsp.lstat(b.abs)).mtimeMs); for (const e of await ls(b.abs)) newest = Math.max(newest, (await fsp.lstat(path.join(b.abs, e.name))).mtimeMs) } catch {}
      if (now - newest < WORK_IDLE_DAYS * DAY) continue
      if (!await plain(root, b.abs)) continue
      await drop(b.abs, 'build', s.bytes, { chat: c.name })
    }
  }

  if (res.removed.length || res.errors.length) {
    o.log?.info('dev environment clean-up', { removed: res.removed.length, bytes: res.removedBytes, errors: res.errors.length, dryRun: !!o.dryRun })
    for (const e of res.errors.slice(0, 5)) o.log?.warn('dev environment clean-up: not removed', e)
  }
  return res
}
