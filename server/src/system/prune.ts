// Old version and engine folders (component G, design tab 6 "업데이트"). Every update brings a whole version folder
// into app/versions/<v> (about 500 MB unpacked: the server's own staging, `mycel-ctl update`, the installers), and an
// installer run with a new engine adds app/engines/<name>/<sha12>; nothing removed them, so a server that updates
// daily filled its disk within months. This removes what neither roll-back nor the bootstrap can use, as the server
// account (it owns app/versions and app/engines, so there is no root step). Run by the server 10 minutes after it
// starts (the bootstrap has confirmed or rolled back the version by then) and hourly (system/ops.ts), and by
// `admin.js prune-versions [--dry-run]`.
//
//   kept      the version app/current points to, the running version, state.json's current and previous (Admin's
//             "Roll back", and the bootstrap's way back when the current one does not verify), the newest staged
//             version newer than the current one (offered as "available"), a version folder NEWER than the current
//             one changed in the last 24 hours (one another process has just brought in and is about to switch to:
//             `mycel-ctl update` between copying and `admin.js switch`, which a scheduled update may hold until the
//             team's update window; a manual `stage-update`), and a version folder OLDER than (or the same as) the
//             current one changed in the last hour (a switch back to it in progress: `admin.js switch <older>` and
//             Roll back touch it and switch within seconds; `mycel-ctl update --version <older>` copies or touches it
//             and waits at most --max-wait, 10 minutes, for running turns). Only an hour for the older ones: a server
//             that updates many times a day (the dev server: about 40) kept every version of the last day, about 22 GB
//   removed   every other folder directly under app/versions whose name is a version; .staging-* and *.partial left
//             by an update that died, once they are a day old; app/engines/<name>/<sha12> folders that
//             <name>/current does not point to, once both current and the folder are a day old (a turn started on
//             the engine before an installer run may still be using it)
//   left      links (never followed: lstat only), files, and names that are none of these
//   skipped   the whole run while state.json has a pending update (the bootstrap still has to confirm it), or when
//             app/current, state.json or app/versions are not what they should be
//
// How a folder goes: right before, app/current, state.json (and an engine's current) are read again and the folder must
// still be older than its grace (a day; an hour for a version folder not newer than the re-read current) by its ctime: a folder another process has just brought in under the same name (a fresh copy, a
// rename, `mycel-ctl update` / `admin.js switch` touching one they use again) has a ctime of now, and that is what keeps
// it; the same dev and inode as at the first look is checked too, but proves little alone (ext4 hands a freed inode
// number to the next folder made). It must also be owned by the account that owns its parent folder and hold no mount
// point (/proc/self/mountinfo on Linux; elsewhere its device must be its parent's). Then it is renamed to .prune-<hex>
// in the same folder (atomic), checked once more under that name (same dev, inode and mtime: a rename keeps the mtime
// and moves the ctime; anything else is renamed back and left, or, when its old name is taken again meanwhile, renamed
// to .prune-hold-<hex>, which no run removes and every run reports), and only that name is removed, depth first, stopping
// at another file system. So an installer or `mycel-ctl update` that brings a new folder in under the old name
// meanwhile loses nothing to this removal, and a removal cut short (the server stopped, a file that cannot go) leaves no
// half folder that still looks like a version; a .prune-* a day old is removed by a later run.
//
// Version folders are never written after staging (the bootstrap refuses one whose files changed), so a removal is
// the only thing that happens to them here. Office Macs keep app, app.previous and app.failed instead (office/update.ts).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locale } from '@mycel/shared/api'
import { AppState, BundleManifest } from '@mycel/shared/install'
import type { Logger } from '../log'
import { treeBytes } from './storage'
import { compareVersions } from './update'

/** a folder changed this recently is never removed (an update or install in progress elsewhere) */
export const PRUNE_GRACE_MS = 24 * 3600_000
/** the same for a version folder not newer than app/current (only a switch back to it can be in progress, and that
 * switches within --max-wait, 10 minutes, of its copy or touch) */
export const PRUNE_OLDER_GRACE_MS = 3600_000
/** the server's first run after it starts (system/ops.ts); hourly from then on, 10 minutes off the automatic update */
export const PRUNE_FIRST_MS = 10 * 60_000
/** the last run's result (not a dry or skipped one), for Admin > System > Diagnostics (data/, the server account's) */
export const PRUNE_RECORD = 'prune-versions.json'

export type KeepReason = 'current' | 'running' | 'state-current' | 'previous' | 'available' | 'recent'
/** trash: a .prune-* folder an earlier run renamed and could not finish removing */
export interface PruneItem { path: string; kind: 'version' | 'staging' | 'partial' | 'engine' | 'trash'; bytes: number }
export interface PruneResult {
  at: string
  dryRun: boolean
  /** why nothing was removed (null: the run went through) */
  skipped: string | null
  /** version folders that stay, oldest first */
  kept: { version: string; why: KeepReason[]; bytes: number }[]
  /** removed, or what a dry run would remove (paths relative to app/) */
  removed: PruneItem[]
  /** entries looked at and left alone, and why */
  left: { path: string; why: string }[]
  errors: { path: string; error: string }[]
  keptBytes: number
  removedBytes: number
}

export interface PruneOptions {
  appDir: string
  /** the version this process runs (SERVER_VERSION) */
  running: string
  /** write the result to <dataDir>/prune-versions.json (not for a dry run) */
  dataDir?: string | null
  dryRun?: boolean
  now?: () => Date
  log?: Logger
  /** tests: another process acting between the steps of one removal ('check': before the folder is looked at again,
   * 'renamed': after it was renamed to .prune-*, before its files go) */
  race?: (rel: string, step: 'check' | 'renamed') => void
  /** tests: the text of /proc/self/mountinfo (null: none, as on macOS) */
  mountinfo?: () => string | null
}

/** Mount points of a /proc/self/mountinfo text (field 5; the kernel writes space, tab, newline and backslash as \ooo). */
export function parseMountinfo(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const f = line.split(' ')
    if (f.length < 5 || !f[4]?.startsWith('/')) continue
    out.push(f[4].replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))))
  }
  return out
}
const readMountinfo = (): string | null => { try { return fs.readFileSync('/proc/self/mountinfo', 'utf8') } catch { return null } }

const VERSION_RE = BundleManifest.shape.version
/** a release or development version (0.2.15, 0.3.0-beta.1, 0.2.9-dev.1): a folder named "notes" or "backup" someone put
 * there is a valid folder name but no version, and stays */
const isVersion = (n: string) => VERSION_RE.safeParse(n).success && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+_-]*)?$/.test(n)
const SHA12 = /^[0-9a-f]{12}$/
const ENGINE_NAME = /^[a-z][a-z0-9_-]{0,31}$/
/** a folder this module renamed on its way out */
const TRASH = /^\.prune-[0-9a-f]{12}$/
/** a folder that changed while it was being taken out and could not get its name back: never removed by a run, reported
 * by every run (Diagnostics) until someone looks at it and renames or removes it */
const HOLD = /^\.prune-hold-[0-9a-f]{12}$/
const HELD = 'changed while a run was taking it out, and its old name was taken again: kept, never removed by a run; look at it, then rename it back or remove it'

function lstat(p: string): fs.Stats | null {
  try { return fs.lstatSync(p) } catch { return null }
}
/** when a folder or link last changed: its own mtime or ctime (a rename, chown or chmod moves ctime) */
const changedAt = (st: fs.Stats) => Math.max(st.mtimeMs, st.ctimeMs)

interface Facts { current: string; state: AppState }

/** app/current and state.json as they are now, or why the run must not go on. */
function readFacts(appDir: string): Facts | string {
  const link = path.join(appDir, 'current')
  const lst = lstat(link)
  if (!lst?.isSymbolicLink()) return 'app/current is not a link'
  const t = fs.readlinkSync(link)
  const v = path.basename(t)
  if (!isVersion(v) || (path.normalize(t) !== path.join('versions', v) && path.normalize(t) !== path.join(appDir, 'versions', v))) return `app/current points to ${JSON.stringify(t)}, not a version folder`
  if (!lstat(path.join(appDir, 'versions', v))?.isDirectory()) return `app/current points to ${v}, which is not a folder`
  let raw: string
  try { raw = fs.readFileSync(path.join(appDir, 'state.json'), 'utf8') } catch { return 'app/state.json is missing' }
  let parsed: ReturnType<typeof AppState.safeParse>
  try { parsed = AppState.safeParse(JSON.parse(raw)) } catch { return 'app/state.json is unreadable' }
  if (!parsed.success) return 'app/state.json is unreadable'
  if (parsed.data.pending) return `an update to ${parsed.data.pending} is pending`
  return { current: v, state: parsed.data }
}

/** Remove a folder without following links: depth first, lstat only (a link is unlinked itself); a folder on another
 * file system (a mount point inside) stops the removal there. */
async function removeTree(p: string, dev: number, counter: { n: number }): Promise<void> {
  const st = fs.lstatSync(p)
  if (!st.isDirectory()) { fs.unlinkSync(p); return }
  if (st.dev !== dev) throw new Error(`${path.basename(p)} is on another file system (a mount point): left alone`)
  // a folder of the bundle that is not writable for its owner (a release archive may record 0555)
  if ((st.mode & 0o700) !== 0o700 && st.uid === process.getuid?.()) fs.chmodSync(p, (st.mode & 0o7777) | 0o700)
  for (const name of fs.readdirSync(p)) {
    await removeTree(path.join(p, name), dev, counter)
    if (++counter.n % 500 === 0) await new Promise((r) => setImmediate(r))
  }
  fs.rmdirSync(p)
}

export async function pruneVersions(o: PruneOptions): Promise<PruneResult> {
  const now = (o.now ?? (() => new Date()))()
  const res: PruneResult = { at: now.toISOString(), dryRun: !!o.dryRun, skipped: null, kept: [], removed: [], left: [], errors: [], keptBytes: 0, removedBytes: 0 }
  const app = o.appDir
  const versions = path.join(app, 'versions')
  const old = (st: fs.Stats) => now.getTime() - changedAt(st) >= PRUNE_GRACE_MS
  /** a version folder newer than `current` waits a day; an older one (or the same) an hour */
  const newer = (v: string, current: string) => compareVersions(v, current) > 0
  const oldVersion = (v: string, st: fs.Stats, current: string) => now.getTime() - changedAt(st) >= (newer(v, current) ? PRUNE_GRACE_MS : PRUNE_OLDER_GRACE_MS)
  const done = () => {
    res.keptBytes = res.kept.reduce((a, k) => a + k.bytes, 0)
    res.removedBytes = res.removed.reduce((a, r) => a + r.bytes, 0)
    if (res.skipped) o.log?.info('old versions: run skipped', { why: res.skipped })
    // a skipped run leaves the last real one in place (Diagnostics shows what is kept, not that an update was pending)
    if (!res.dryRun && !res.skipped && o.dataDir) {
      try {
        const f = path.join(o.dataDir, PRUNE_RECORD)
        fs.writeFileSync(`${f}.tmp`, JSON.stringify(res), { mode: 0o600 })
        fs.renameSync(`${f}.tmp`, f)
      } catch (e) { o.log?.warn('prune record not written', { err: String(e) }) }
    }
    return res
  }
  if (!lstat(app)?.isDirectory()) { res.skipped = 'app/ is not a folder'; return done() }
  const vst = lstat(versions)
  if (!vst?.isDirectory()) { res.skipped = 'app/versions is not a folder'; return done() }
  const facts = readFacts(app)
  if (typeof facts === 'string') { res.skipped = facts; return done() }
  const MOUNT = 'on another file system (a mount point): never removed'
  const HOLDS_MOUNT = 'holds a mount point: never removed'
  // mount points at or under a folder: a bind mount of the same file system has the same device, so the device alone
  // would not stop the removal before it had emptied the mounted folder (Linux; null elsewhere: the device check only)
  let realApp = app
  try { realApp = fs.realpathSync(app) } catch {}
  const mountsNow = () => { const t = (o.mountinfo ?? readMountinfo)(); return t === null ? null : parseMountinfo(t) }
  const holdsMount = (rel: string, mounts: string[] | null) => {
    if (!mounts) return false
    const real = path.join(realApp, rel)
    return mounts.some((m) => m === real || m.startsWith(real + '/'))
  }
  const mounts = mountsNow()

  // ---- versions ----
  const names = fs.readdirSync(versions).sort()
  const isStaged = (n: string) => !!lstat(path.join(versions, n))?.isDirectory() && !!lstat(path.join(versions, n, 'manifest.json'))?.isFile()
  const keepSet = (f: Facts, list: string[]) => {
    const why = new Map<string, KeepReason[]>()
    const add = (v: string | null | undefined, r: KeepReason) => { if (v) why.set(v, [...(why.get(v) ?? []), r]) }
    add(f.current, 'current')
    add(o.running, 'running')
    add(f.state.current, 'state-current')
    add(f.state.previous, 'previous')
    add(list.filter((n) => isVersion(n) && !n.endsWith('.partial') && isStaged(n) && compareVersions(n, f.current) > 0).sort(compareVersions).at(-1), 'available')
    return why
  }
  const keep = keepSet(facts, names)
  /** what the first look found: the folder must still be this one (dev, inode) when it is removed */
  interface Candidate { rel: string; kind: PruneItem['kind']; dev: number; ino: number; owner: number; version?: string; engine?: string }
  const candidates: Candidate[] = []
  const recentWhy = (kind: PruneItem['kind'], olderVersion = false) => kind === 'engine' ? 'changed in the last 24 hours (a turn may still use it)'
    : kind === 'trash' ? 'renamed for removal in the last 24 hours (a run may still be removing it)'
    : olderVersion ? 'changed in the last hour (a switch back to it may be in progress)'
    : 'changed in the last 24 hours (an update may be using it)'
  for (const name of names) {
    const rel = `versions/${name}`
    const st = lstat(path.join(versions, name))
    if (!st) continue
    if (st.isSymbolicLink()) { res.left.push({ path: rel, why: 'a link (never followed)' }); continue }
    if (!st.isDirectory()) { res.left.push({ path: rel, why: 'not a folder' }); continue }
    if (HOLD.test(name)) { res.errors.push({ path: rel, error: HELD }); continue }
    const kind: PruneItem['kind'] | null = TRASH.test(name) ? 'trash' : name.startsWith('.staging-') ? 'staging' : name.endsWith('.partial') ? 'partial' : isVersion(name) ? 'version' : null
    if (!kind) { res.left.push({ path: rel, why: 'not a version folder' }); continue }
    if (kind === 'version' && keep.has(name)) continue
    if (st.dev !== vst.dev) { res.left.push({ path: rel, why: MOUNT }); continue }
    if (holdsMount(rel, mounts)) { res.left.push({ path: rel, why: HOLDS_MOUNT }); continue }
    if (kind === 'version' ? !oldVersion(name, st, facts.current) : !old(st)) {
      if (kind === 'version') keep.set(name, ['recent'])
      else res.left.push({ path: rel, why: recentWhy(kind) })
      continue
    }
    candidates.push({ rel, kind, dev: st.dev, ino: st.ino, owner: vst.uid, ...(kind === 'version' ? { version: name } : {}) })
  }
  for (const [v, why] of [...keep].filter(([v]) => isStaged(v)).sort(([a], [b]) => compareVersions(a, b))) {
    res.kept.push({ version: v, why, bytes: await treeBytes(path.join(versions, v)) })
  }

  // ---- engines ----
  const engines = path.join(app, 'engines')
  /** <name>/current's target and the link's own facts, or null when it names no engine folder */
  const engineCurrent = (name: string) => {
    const dir = path.join(engines, name)
    const cur = lstat(path.join(dir, 'current'))
    let target: string | null = null
    try { if (cur?.isSymbolicLink()) target = fs.readlinkSync(path.join(dir, 'current')) } catch {}
    return cur && target && SHA12.test(target) && lstat(path.join(dir, target))?.isDirectory() ? { cur, target } : null
  }
  const est = lstat(engines)
  if (est?.isDirectory()) {
    for (const name of fs.readdirSync(engines).sort()) {
      const dir = path.join(engines, name)
      const st = lstat(dir)
      if (!st?.isDirectory() || !ENGINE_NAME.test(name)) { res.left.push({ path: `engines/${name}`, why: st?.isSymbolicLink() ? 'a link (never followed)' : 'not an engine folder' }); continue }
      const ec = engineCurrent(name)
      if (!ec) { res.left.push({ path: `engines/${name}`, why: 'current names no engine folder' }); continue }
      for (const sub of fs.readdirSync(dir).sort()) {
        if (sub === 'current' || sub === ec.target) continue
        const rel = `engines/${name}/${sub}`
        const s = lstat(path.join(dir, sub))
        if (!s) continue
        if (s.isDirectory() && HOLD.test(sub)) { res.errors.push({ path: rel, error: HELD }); continue }
        const trash = TRASH.test(sub)
        if (!s.isDirectory() || !(SHA12.test(sub) || trash)) { res.left.push({ path: rel, why: s.isSymbolicLink() ? 'a link (never followed)' : 'not an engine folder' }); continue }
        if (s.dev !== st.dev) { res.left.push({ path: rel, why: MOUNT }); continue }
        if (holdsMount(rel, mounts)) { res.left.push({ path: rel, why: HOLDS_MOUNT }); continue }
        if ((!trash && !old(ec.cur)) || !old(s)) { res.left.push({ path: rel, why: recentWhy('engine') }); continue }
        candidates.push({ rel, kind: trash ? 'trash' : 'engine', dev: s.dev, ino: s.ino, owner: st.uid, engine: name })
      }
    }
  }

  // ---- remove: look again, take the folder out of its name, then remove that ----
  const counter = { n: 0 }
  const REPLACED = 'replaced since the first look (another process brought a folder in under this name)'
  /** why `c` must stay after all (null: it goes) */
  const stillGoes = (c: Candidate, st: fs.Stats | null, f: Facts): string | null => {
    if (!st || !st.isDirectory() || st.dev !== c.dev || st.ino !== c.ino) return REPLACED
    // what keeps a fresh copy under the old name (ext4 may even give it the old inode number): its ctime is now
    if (c.version !== undefined ? !oldVersion(c.version, st, f.current) : !old(st)) return recentWhy(c.kind, c.version !== undefined && !newer(c.version, f.current))
    if (holdsMount(c.rel, mountsNow())) return HOLDS_MOUNT
    if (c.version !== undefined && keepSet(f, fs.readdirSync(versions)).has(c.version)) return 'needed again (app/current or state.json changed during the run)'
    if (c.kind === 'engine') {
      const ec = engineCurrent(c.engine!)
      if (!ec || ec.target === path.basename(c.rel) || !old(ec.cur)) return 'the engine\'s current changed during the run'
    }
    return null
  }
  const ordered = [...candidates.filter((c) => c.kind === 'version').sort((a, b) => compareVersions(a.version!, b.version!)), ...candidates.filter((c) => c.kind !== 'version')]
  for (const c of ordered) {
    const abs = path.join(app, c.rel)
    o.race?.(c.rel, 'check')
    // an update may have started (pending) or switched since the first look: then this run stops here
    const f = readFacts(app)
    if (typeof f === 'string') { res.skipped = `stopped: ${f}`; break }
    const st = lstat(abs)
    const why = stillGoes(c, st, f)
    if (why) { if (st) res.left.push({ path: c.rel, why }); continue }
    // a folder of another account than its parent's (root's copy from an installer that was stopped): the server account
    // cannot remove it, and a dry run says so too
    if (st!.uid !== c.owner) {
      res.errors.push({ path: c.rel, error: `owned by another account (uid ${st!.uid}, not ${c.owner}): remove it as root` })
      continue
    }
    if (o.dryRun) { res.removed.push({ path: c.rel, kind: c.kind, bytes: await treeBytes(abs) + st!.blocks * 512 }); continue }
    let gone = abs
    if (c.kind !== 'trash') {
      gone = path.join(path.dirname(abs), `.prune-${crypto.randomBytes(6).toString('hex')}`)
      try { fs.renameSync(abs, gone) } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        // EXDEV: a file system that cannot rename this folder (an overlay's lower layer): removed under its own name
        if (code === 'EXDEV') gone = abs
        else {
          if (code !== 'ENOENT') res.errors.push({ path: c.rel, error: String((e as Error).message ?? e).slice(0, 300) })
          continue
        }
      }
      if (gone !== abs) {
        o.race?.(c.rel, 'renamed')
        // still the folder looked at, under its new name? A rename keeps dev, inode and mtime and moves the ctime forward
        const t = lstat(gone)
        if (!t || !t.isDirectory() || t.dev !== st!.dev || t.ino !== st!.ino || t.mtimeMs !== st!.mtimeMs || t.ctimeMs < st!.ctimeMs) {
          let back = false
          if (t && !lstat(abs)) { try { fs.renameSync(gone, abs); back = true } catch {} }
          if (back) res.left.push({ path: c.rel, why: REPLACED })
          else if (t) {
            // the old name is taken again: out of the clean-up's reach (a .prune-* goes a day later), and reported
            const hold = path.join(path.dirname(gone), `.prune-hold-${crypto.randomBytes(6).toString('hex')}`)
            let held = false
            try { fs.renameSync(gone, hold); held = true } catch {}
            res.errors.push(held
              ? { path: path.relative(app, hold), error: `${HELD} (it was ${c.rel})` }
              : { path: c.rel, error: `changed while it was being taken out; it is now ${path.relative(app, gone)}, which a run a day from now removes: look at it first, then rename it back` })
          }
          continue
        }
      }
    }
    const bytes = await treeBytes(gone) + st!.blocks * 512
    try { await removeTree(gone, c.dev, counter) } catch (e) {
      const where = gone === abs ? '' : ` (what is left is ${path.relative(app, gone)}, removed by a later run)`
      res.errors.push({ path: c.rel, error: `${String((e as Error).message ?? e).slice(0, 300)}${where}` })
      // what is gone is gone: count only what is no longer there
      if (lstat(gone)) continue
    }
    res.removed.push({ path: c.rel, kind: c.kind, bytes })
  }
  if (!o.dryRun && res.removed.length) o.log?.info('old versions removed', { removed: res.removed.map((r) => r.path), bytes: res.removed.reduce((a, r) => a + r.bytes, 0), errors: res.errors.length })
  if (res.errors.length) o.log?.warn('some old versions could not be removed', { errors: res.errors.slice(0, 5) })
  return done()
}

/** The last recorded run (null: none yet, or unreadable). */
export function lastPrune(dataDir: string): PruneResult | null {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, PRUNE_RECORD), 'utf8')) as PruneResult } catch { return null }
}

// ---- Admin > System > Diagnostics: one line in the update group ----
type T = Record<Locale, string>
const gb = (n: number, l: Locale) => `${new Intl.NumberFormat(l, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(n / 1024 ** 3)} GB`
export const PRUNE_TEXT = {
  label: { ko: '보관 중인 버전', en: 'Kept versions', id: 'Versi yang disimpan', ja: '保存中のバージョン', es: 'Versiones guardadas' } as T,
  ok: (list: string, bytes: number): T => ({
    ko: `${list} · ${gb(bytes, 'ko')}. 더 오래된 버전은 서버가 알아서 지워요.`,
    en: `${list} · ${gb(bytes, 'en')}. The server removes older versions by itself.`,
    id: `${list} · ${gb(bytes, 'id')}. Server menghapus versi yang lebih lama dengan sendirinya.`,
    ja: `${list}・${gb(bytes, 'ja')}。古いバージョンはサーバーが自動で削除します。`,
    es: `${list} · ${gb(bytes, 'es')}. El servidor borra solo las versiones más antiguas.`,
  }),
  failed: (list: string, bytes: number, error: string): T => ({
    ko: `${list} · ${gb(bytes, 'ko')}. 오래된 버전을 지우지 못했어요: ${error}`,
    en: `${list} · ${gb(bytes, 'en')}. Old versions could not be removed: ${error}`,
    id: `${list} · ${gb(bytes, 'id')}. Versi lama tidak dapat dihapus: ${error}`,
    ja: `${list}・${gb(bytes, 'ja')}。古いバージョンを削除できませんでした: ${error}`,
    es: `${list} · ${gb(bytes, 'es')}. No se pudieron borrar las versiones antiguas: ${error}`,
  }),
}
