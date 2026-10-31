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
//             version newer than the current one (offered as "available"), and any version folder changed in the
//             last 24 hours (one another process has just brought in and is about to switch to: `mycel-ctl update`
//             between copying and `admin.js switch`, the installer's "older" bundle, a manual `stage-update`)
//   removed   every other folder directly under app/versions whose name is a version; .staging-* and *.partial left
//             by an update that died, once they are a day old; app/engines/<name>/<sha12> folders that
//             <name>/current does not point to, once both current and the folder are a day old (a turn started on
//             the engine before an installer run may still be using it)
//   left      links (never followed: lstat only), files, and names that are none of these
//   skipped   the whole run while state.json has a pending update (the bootstrap still has to confirm it), or when
//             app/current, state.json or app/versions are not what they should be
//
// Version folders are never written after staging (the bootstrap refuses one whose files changed), so a removal is
// the only thing that happens to them here. Office Macs keep app, app.previous and app.failed instead (office/update.ts).
import fs from 'node:fs'
import path from 'node:path'
import type { Locale } from '@mycel/shared/api'
import { AppState, BundleManifest } from '@mycel/shared/install'
import type { Logger } from '../log'
import { treeBytes } from './storage'
import { compareVersions } from './update'

/** a folder changed this recently is never removed (an update or install in progress elsewhere) */
export const PRUNE_GRACE_MS = 24 * 3600_000
/** the last run's result (not a dry or skipped one), for Admin > System > Diagnostics (data/, the server account's) */
export const PRUNE_RECORD = 'prune-versions.json'

export type KeepReason = 'current' | 'running' | 'state-current' | 'previous' | 'available' | 'recent'
export interface PruneItem { path: string; kind: 'version' | 'staging' | 'partial' | 'engine'; bytes: number }
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
}

const VERSION_RE = BundleManifest.shape.version
/** a release or development version (0.2.15, 0.3.0-beta.1, 0.2.9-dev.1): a folder named "notes" or "backup" someone put
 * there is a valid folder name but no version, and stays */
const isVersion = (n: string) => VERSION_RE.safeParse(n).success && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+_-]*)?$/.test(n)
const SHA12 = /^[0-9a-f]{12}$/
const ENGINE_NAME = /^[a-z][a-z0-9_-]{0,31}$/

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

/** Remove a folder without following links: depth first, lstat only (a link is unlinked itself). */
async function removeTree(p: string, counter: { n: number }): Promise<void> {
  const st = fs.lstatSync(p)
  if (!st.isDirectory()) { fs.unlinkSync(p); return }
  // a folder of the bundle that is not writable for its owner (a release archive may record 0555)
  if ((st.mode & 0o700) !== 0o700 && st.uid === process.getuid?.()) fs.chmodSync(p, (st.mode & 0o7777) | 0o700)
  for (const name of fs.readdirSync(p)) {
    await removeTree(path.join(p, name), counter)
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
  if (!lstat(versions)?.isDirectory()) { res.skipped = 'app/versions is not a folder'; return done() }
  const facts = readFacts(app)
  if (typeof facts === 'string') { res.skipped = facts; return done() }

  // ---- versions ----
  const names = fs.readdirSync(versions).sort()
  const isStaged = (n: string) => !!lstat(path.join(versions, n))?.isDirectory() && !!lstat(path.join(versions, n, 'manifest.json'))?.isFile()
  const keepSet = (f: Facts) => {
    const why = new Map<string, KeepReason[]>()
    const add = (v: string | null | undefined, r: KeepReason) => { if (v) why.set(v, [...(why.get(v) ?? []), r]) }
    add(f.current, 'current')
    add(o.running, 'running')
    add(f.state.current, 'state-current')
    add(f.state.previous, 'previous')
    add(names.filter((n) => isVersion(n) && !n.endsWith('.partial') && isStaged(n) && compareVersions(n, f.current) > 0).sort(compareVersions).at(-1), 'available')
    return why
  }
  const keep = keepSet(facts)
  const candidates: { name: string; kind: PruneItem['kind'] }[] = []
  for (const name of names) {
    const rel = `versions/${name}`
    const st = lstat(path.join(versions, name))
    if (!st) continue
    if (st.isSymbolicLink()) { res.left.push({ path: rel, why: 'a link (never followed)' }); continue }
    if (!st.isDirectory()) { res.left.push({ path: rel, why: 'not a folder' }); continue }
    const kind: PruneItem['kind'] | null = name.startsWith('.staging-') ? 'staging' : name.endsWith('.partial') ? 'partial' : isVersion(name) ? 'version' : null
    if (!kind) { res.left.push({ path: rel, why: 'not a version folder' }); continue }
    if (kind === 'version' && keep.has(name)) continue
    if (!old(st)) {
      if (kind === 'version') keep.set(name, ['recent'])
      else res.left.push({ path: rel, why: 'changed in the last 24 hours (an update may be using it)' })
      continue
    }
    candidates.push({ name, kind })
  }
  for (const [v, why] of [...keep].filter(([v]) => isStaged(v)).sort(([a], [b]) => compareVersions(a, b))) {
    res.kept.push({ version: v, why, bytes: await treeBytes(path.join(versions, v)) })
  }

  // ---- engines ----
  const engineCandidates: string[] = []
  const engines = path.join(app, 'engines')
  const est = lstat(engines)
  if (est?.isDirectory()) {
    for (const name of fs.readdirSync(engines).sort()) {
      const dir = path.join(engines, name)
      const st = lstat(dir)
      if (!st?.isDirectory() || !ENGINE_NAME.test(name)) { res.left.push({ path: `engines/${name}`, why: st?.isSymbolicLink() ? 'a link (never followed)' : 'not an engine folder' }); continue }
      const cur = lstat(path.join(dir, 'current'))
      const target = cur?.isSymbolicLink() ? fs.readlinkSync(path.join(dir, 'current')) : null
      if (!cur || !target || !SHA12.test(target) || !lstat(path.join(dir, target))?.isDirectory()) {
        res.left.push({ path: `engines/${name}`, why: 'current names no engine folder' })
        continue
      }
      for (const sub of fs.readdirSync(dir).sort()) {
        if (sub === 'current' || sub === target) continue
        const rel = `engines/${name}/${sub}`
        const s = lstat(path.join(dir, sub))
        if (!s) continue
        if (!s.isDirectory() || !SHA12.test(sub)) { res.left.push({ path: rel, why: s.isSymbolicLink() ? 'a link (never followed)' : 'not an engine folder' }); continue }
        if (!old(cur) || !old(s)) { res.left.push({ path: rel, why: 'changed in the last 24 hours (a turn may still use it)' }); continue }
        engineCandidates.push(rel)
      }
    }
  }

  // ---- remove ----
  const counter = { n: 0 }
  const remove = async (rel: string, kind: PruneItem['kind']) => {
    const abs = path.join(app, rel)
    const bytes = await treeBytes(abs) + (lstat(abs)?.blocks ?? 0) * 512
    if (!o.dryRun) {
      try { await removeTree(abs, counter) } catch (e) {
        res.errors.push({ path: rel, error: String((e as Error).message ?? e).slice(0, 300) })
        // what is gone is gone: count only what is no longer there
        if (lstat(abs)) return
      }
    }
    res.removed.push({ path: rel, kind, bytes })
  }
  const ordered = [...candidates.filter((c) => c.kind === 'version').sort((a, b) => compareVersions(a.name, b.name)), ...candidates.filter((c) => c.kind !== 'version')]
  for (const c of ordered) {
    if (c.kind === 'version' && !o.dryRun) {
      // look again right before: an update may have started (pending) or switched since the first look
      const f = readFacts(app)
      if (typeof f === 'string') { res.skipped = `stopped: ${f}`; break }
      if (keepSet(f).has(c.name)) continue
    }
    await remove(`versions/${c.name}`, c.kind)
  }
  if (!res.skipped) for (const rel of engineCandidates) await remove(rel, 'engine')
  if (!o.dryRun && res.removed.length) o.log?.info('old versions removed', { removed: res.removed.map((r) => r.path), bytes: res.removedBytes, errors: res.errors.length })
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
