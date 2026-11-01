// The Windows desktop app on a Linux team server (docs/INSTALL-LINUX.md "Windows app"). Component G.
//
// The Windows app updates only from its own team: electron-updater reads <team address>/downloads/latest.yml and the
// installer it names (desktop/src/common/update.ts), with the person's session. An office Mac fills that folder after
// each of its updates (office/update.ts step 6); a Linux server had nothing that did, so its Windows apps never
// updated. Here the Linux server does the same, from the same signed office manifest:
//
//   1. GET <feed>/<officeDir>/<channel>.json (the feed of server.json update.feedUrl, the server's own channel) and verify
//      it like an office does (Ed25519 with a key baked into this build, the channel, every file on the feed)
//   2. its Windows app is offered only when it is not newer than the version this server runs: the desks follow the
//      server, so a server that has not taken a release yet does not hand out that release's app
//   3. office/update.ts offerWindows: size and SHA-256 against the manifest, latest.yml naming exactly that installer,
//      the checks of `teamax desktop add`, every older Windows installer removed, latest.yml last; not when the disk would
//      fall under the team folder's write reserve
//
// The server does this 15 minutes after it starts (an update restarts it, and by then the bootstrap has kept or rolled
// back the new version) and every 6 hours, and the owner can run it at once: `admin.js desktop-refresh`, also with
// `--from <folder>` for a server without internet (the manifest and the two files copied there; checked the same way).
// Existing Windows apps need nothing new: they already ask /downloads/latest.yml every 4 hours.
// Not here: office mode (its own updater), the hosted service (the control plane owns its servers), development, a
// Mac role-account install (no feed), and a server whose server.json names no feed.
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import type { AppConfig } from '../app-config'
import { DEFAULT_FEED, OFFICE_RELEASE_KEYS, ReleaseError, type Channel } from '../office/release'
import { fetchManifest, NotPublished, offerWindows, UpdateFailure, type FetchLike, type StatfsLike } from '../office/update'
import { isHosted } from './deployment'
import { compareVersions } from './update'

export const WINDOWS_FIRST_MS = 15 * 60_000
export const WINDOWS_EVERY_MS = 6 * 3600_000
/** a version whose files did not match (size, hash, latest.yml, the installer checks) is tried again after this long
 * (or with --force); a download that only broke off is tried again at the next run */
export const WINDOWS_HOLD_MS = 24 * 3600_000
/** a lock older than this is taken over even when its pid is alive (a reused pid; a run takes at most two downloads of
 * at most an hour each) */
export const WINDOWS_LOCK_STALE_MS = 3 * 3600_000

/** the folder /downloads/* serves (routes/web.ts); MYCEL_DOWNLOADS_DIR wins (tests) */
export const downloadsDirOf = (dataDir: string, env: Record<string, string | undefined> = process.env) => env[PRODUCT.envPrefix + 'DOWNLOADS_DIR'] ?? path.join(dataDir, 'downloads')

/** The feed's root from server.json update.feedUrl (<root>/server/<channel>.json): https, or http on this machine
 * (tests). null for anything else. */
export function feedRootOf(feedUrl: string | null | undefined): string | null {
  if (!feedUrl) return null
  const m = /^(.+)\/server\/[A-Za-z0-9._-]+\.json$/.exec(feedUrl)
  if (!m) return null
  let u: URL
  try { u = new URL(m[1]!) } catch { return null }
  if (u.username || u.password || u.search || u.hash) return null
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))) return null
  return m[1]!
}

type WindowsCfg = Pick<AppConfig, 'mode' | 'office' | 'update'> & { deployment?: AppConfig['deployment'] }

/** Where a Linux server's Windows app comes from (GET /api/me server.windowsApp, the owner's hint in Settings > Apps):
 * 'feed' = by itself from the release feed, 'folder' = a server whose server.json names no feed (the owner copies the
 * release's files in: desktop-refresh --from), null = not a Linux server of its own (office Mac, hosted, dev). */
export function windowsAppSourceOf(cfg: WindowsCfg, platform: NodeJS.Platform = process.platform): 'feed' | 'folder' | null {
  if (platform !== 'linux' || cfg.mode !== 'prod' || cfg.office || isHosted(cfg as Record<string, unknown>)) return null
  return feedRootOf(cfg.update.feedUrl) ? 'feed' : 'folder'
}

/** This server puts the Windows app into its downloads folder by itself: the feed it uses, else null (see the header). */
export function windowsAppFeedOf(cfg: WindowsCfg, platform: NodeJS.Platform = process.platform): string | null {
  return windowsAppSourceOf(cfg, platform) === 'feed' ? feedRootOf(cfg.update.feedUrl) : null
}

export type WindowsAppKind =
  | 'offered' // put there now
  | 'current' // already offered
  | 'newer' // a newer Windows app is offered (by hand): left as it is
  | 'ahead' // the feed's app is newer than this server: offered after the server takes that release
  | 'none' // the release has no Windows app, or the channel has no release
  | 'held' // its files failed less than a day ago
  | 'no-room' // not enough disk space
  | 'busy' // another run (the admin command, the timer) is at it
  | 'failed'
export interface WindowsAppResult { kind: WindowsAppKind; version: string | null; message: string | null }

interface WindowsState {
  lastCheckAt: string | null
  last: (WindowsAppResult & { at: string }) | null
  /** the version whose files failed last (held for WINDOWS_HOLD_MS) */
  failed: { version: string; at: string; message: string } | null
}

export interface WindowsAppOptions {
  dataDir: string
  /** default downloadsDirOf(dataDir) */
  downloadsDir?: string
  /** the version this server runs */
  version: string
  channel: Channel
  /** the feed's root (windowsAppFeedOf): RELEASE_CHANNEL.feed on a normal install */
  feed: string
  fetch?: FetchLike
  keys?: readonly string[]
  log?: (line: string) => void
  now?: () => Date
  statfs?: StatfsLike
  /** try a held version again (the admin command) */
  force?: boolean
}

export const windowsStateFile = (dataDir: string) => path.join(dataDir, 'desktop-windows.json')

export function readWindowsState(dataDir: string): WindowsState {
  let raw: Partial<WindowsState> | null = null
  try { raw = JSON.parse(fs.readFileSync(windowsStateFile(dataDir), 'utf8')) } catch {}
  return { lastCheckAt: raw?.lastCheckAt ?? null, last: raw?.last ?? null, failed: raw?.failed ?? null }
}

function writeWindowsState(dataDir: string, s: WindowsState) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const f = windowsStateFile(dataDir)
  const tmp = `${f}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, f)
}

const pidAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** One run (see the header). Never throws: the outcome is returned and kept in data/desktop-windows.json. */
export async function refreshWindowsApp(o: WindowsAppOptions): Promise<WindowsAppResult> {
  const now = () => o.now?.() ?? new Date()
  const log = o.log ?? (() => {})
  const work = path.join(o.dataDir, 'updates')
  const lock = path.join(work, 'windows.lock')
  // one run at a time: the server's timer and the admin command are two processes
  try {
    fs.mkdirSync(work, { recursive: true, mode: 0o700 })
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
    } catch {
      const pid = Number((() => { try { return fs.readFileSync(lock, 'utf8') } catch { return '' } })())
      const age = (() => { try { return now().getTime() - fs.statSync(lock).mtimeMs } catch { return Infinity } })()
      if (pidAlive(pid) && age < WINDOWS_LOCK_STALE_MS) return { kind: 'busy', version: null, message: `another run is at it (pid ${pid})` }
      fs.rmSync(lock, { force: true })
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
    }
  } catch (e) {
    return { kind: 'busy', version: null, message: `cannot take ${lock}: ${(e as Error).message}` }
  }
  const st = readWindowsState(o.dataDir)
  const done = (r: WindowsAppResult): WindowsAppResult => {
    st.last = { ...r, at: now().toISOString() }
    try { writeWindowsState(o.dataDir, st) } catch {}
    log(`Windows app: ${r.kind}${r.version ? ` ${r.version}` : ''}${r.message ? `: ${r.message}` : ''}`)
    return r
  }
  try {
    let r
    try {
      r = await fetchManifest(o.feed, o.channel, { fetch: o.fetch ?? ((u, i) => fetch(u, i)) }, o.keys ?? OFFICE_RELEASE_KEYS)
    } catch (e) {
      st.lastCheckAt = now().toISOString()
      if (e instanceof NotPublished) return done({ kind: 'none', version: null, message: e.message })
      return done({ kind: 'failed', version: null, message: e instanceof ReleaseError || e instanceof UpdateFailure ? e.message : String(e) })
    }
    st.lastCheckAt = now().toISOString()
    const w = r.windows
    if (!w) return done({ kind: 'none', version: r.version, message: `release ${r.version} has no Windows app` })
    if (compareVersions(w.version, o.version) > 0) return done({ kind: 'ahead', version: w.version, message: `this server runs ${o.version}; the Windows app ${w.version} follows when the server has it` })
    const f = st.failed
    if (!o.force && f && f.version === w.version && now().getTime() - Date.parse(f.at) < WINDOWS_HOLD_MS) return done({ kind: 'held', version: w.version, message: `failed at ${f.at} (${f.message}); tried again a day later` })
    try {
      const res = await offerWindows(o.downloadsDir ?? downloadsDirOf(o.dataDir), path.join(work, 'windows'), w, { fetch: o.fetch ?? ((u, i) => fetch(u, i)), log }, { statfs: o.statfs })
      if (res.kind === 'no-room') return done({ kind: 'no-room', version: w.version, message: res.message })
      if (res.kind === 'offered') st.failed = null
      return done({ kind: res.kind, version: res.version, message: res.kind === 'newer' ? `newer than the release's ${w.version}` : null })
    } catch (e) {
      const msg = (e as Error).message
      // office/update.ts download(): "download <file>: …" is the connection; anything else is what came (or the folder)
      if (!/^download [^:\s]+: /.test(msg)) st.failed = { version: w.version, at: now().toISOString(), message: msg.slice(0, 500) }
      return done({ kind: 'failed', version: w.version, message: msg })
    }
  } finally {
    fs.rmSync(lock, { force: true })
  }
}

/** A fetch that answers the feed's URLs from files copied into `dir` (`admin.js desktop-refresh --from`): <channel>.json
 * and each file by its name. Anything else is 404; nothing goes on the network. */
export function folderFetch(dir: string, feed: string = DEFAULT_FEED): FetchLike {
  const root = path.resolve(dir)
  return async (url) => {
    const u = url.split('?')[0]!
    if (!u.startsWith(feed.replace(/\/+$/, '') + '/')) return new Response('not found', { status: 404 })
    const name = decodeURIComponent(u.split('/').pop() ?? '')
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}$/.test(name)) return new Response('not found', { status: 404 })
    const file = path.join(root, name)
    try {
      const st = fs.statSync(file)
      if (!st.isFile()) return new Response('not found', { status: 404 })
    } catch { return new Response('not found', { status: 404 }) }
    return new Response(Bun.file(file))
  }
}
