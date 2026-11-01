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
// back the new version) and, while its automatic updates are on, every 6 hours; the owner can run it at once:
// `admin.js desktop-refresh`, also with `--from /full/path` for a server without internet (the manifest and the two files
// copied there; checked the same way). Admin › System › Diagnostics shows the last result ("Windows app").
// Existing Windows apps need nothing new: they already ask /downloads/latest.yml every 4 hours.
// The hosted service: its control plane updates a tenant by running `mycel-ctl update` in it (the tenant fetches the
// bundle from the same feed itself; its firewall lets https out), and every update restarts the server, so a tenant
// does only the run after a start: never the 6-hourly one, never a release newer than itself, its own channel.
// Not here: office mode (its own updater), development, a Mac role-account install (no feed), and a server whose
// server.json names no feed.
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import type { AppConfig } from '../app-config'
import { DEFAULT_FEED, OFFICE_RELEASE_KEYS, ReleaseError, type Channel } from '../office/release'
import { fetchManifest, NotPublished, offerWindows, readIndex, UpdateFailure, type FetchLike, type StatfsLike } from '../office/update'
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
 * 'feed' = by itself from the release feed (a self-installed server, or a hosted tenant), 'folder' = a self-installed
 * server whose server.json names no feed (the owner copies the release's files in: desktop-refresh --from), null = none
 * (office Mac, dev, a Mac role-account install, a hosted tenant without a feed: its owner has no shell). */
export function windowsAppSourceOf(cfg: WindowsCfg, platform: NodeJS.Platform = process.platform): 'feed' | 'folder' | null {
  if (platform !== 'linux' || cfg.mode !== 'prod' || cfg.office) return null
  if (feedRootOf(cfg.update.feedUrl)) return 'feed'
  return isHosted(cfg as Record<string, unknown>) ? null : 'folder'
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
  // one run at a time: the server's timer and the admin command are two processes. The lock appears with its pid and a
  // random token in it (a link to a file written first), so nobody reads it empty. A dead pid's lock, or one older than
  // any run, is taken over by moving it aside and checking that what was moved is the lock that was read (its inode and
  // its text): a second taker that moved the first taker's fresh lock puts it back and stops. A run removes the lock only
  // while it is its own, by inode and text: Linux file systems hand a removed file's inode number to the next new file.
  let myLock: { ino: number; text: string }
  const readText = (p: string) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
  try {
    fs.mkdirSync(work, { recursive: true, mode: 0o700 })
    const token = Math.random().toString(36).slice(2, 10)
    const mine = `${lock}.${process.pid}-${token}`
    const text = `${process.pid} ${token}`
    fs.writeFileSync(mine, text, { mode: 0o600 })
    try {
      myLock = { ino: fs.statSync(mine).ino, text }
      try { fs.linkSync(mine, lock) } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        let seen: fs.Stats
        try { seen = fs.statSync(lock) } catch { return { kind: 'busy', version: null, message: 'another run took the lock' } }
        const seenText = readText(lock)
        const pid = Number(seenText.split(' ')[0])
        if (pidAlive(pid) && now().getTime() - seen.mtimeMs < WINDOWS_LOCK_STALE_MS) return { kind: 'busy', version: null, message: `another run is at it (pid ${pid})` }
        const aside = `${mine}.stale`
        try { fs.renameSync(lock, aside) } catch { return { kind: 'busy', version: null, message: 'another run took the lock' } }
        if (fs.statSync(aside).ino !== seen.ino || readText(aside) !== seenText) {
          try { fs.linkSync(aside, lock) } catch {}
          fs.rmSync(aside, { force: true })
          return { kind: 'busy', version: null, message: 'another run took the lock' }
        }
        fs.rmSync(aside, { force: true })
        try { fs.linkSync(mine, lock) } catch { return { kind: 'busy', version: null, message: 'another run took the lock' } }
      }
    } finally { fs.rmSync(mine, { force: true }) }
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
      // held only for what came from the feed (size, hash, latest.yml, the installer checks): office/update.ts download()
      // says "download <file>: …" for the connection, and a file-system error (a full disk, permissions) has a code
      const local = typeof (e as NodeJS.ErrnoException).code === 'string'
      if (!local && !/^download [^:\s]+: /.test(msg)) st.failed = { version: w.version, at: now().toISOString(), message: msg.slice(0, 500) }
      return done({ kind: 'failed', version: w.version, message: msg })
    }
  } finally {
    try { if (fs.statSync(lock).ino === myLock.ino && readText(lock) === myLock.text) fs.rmSync(lock, { force: true }) } catch {}
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

type T = Record<Locale, string>
const cmd = '`trina_admin desktop-refresh`'
const cmdForce = '`trina_admin desktop-refresh --force`'
/** Admin › System › Diagnostics, "Windows app" (ops.ts): what the last run did, so the owner sees why no installer is
 * offered (Settings › Apps points here). */
export const WINDOWS_TEXT = {
  label: { ko: 'Windows 앱', en: 'Windows app', id: 'Aplikasi Windows', ja: 'Windowsアプリ', es: 'Aplicación de Windows' } as T,
  offered: (v: string): T => ({
    ko: `Windows 앱 ${v}을(를) 이 서버에서 받을 수 있고, 팀원의 Windows 앱은 여기서 스스로 업데이트해요.`,
    en: `The Windows app ${v} is offered by this server; the desks' Windows apps update from it by themselves.`,
    id: `Aplikasi Windows ${v} tersedia dari server ini; aplikasi Windows di meja tim memperbarui dirinya dari sini.`,
    ja: `Windowsアプリ${v}をこのサーバーから配布しています。各端末のWindowsアプリはここから自動で更新されます。`,
    es: `Este servidor ofrece la aplicación de Windows ${v}; las aplicaciones de Windows de los puestos se actualizan solas desde aquí.`,
  }),
  newer: (v: string): T => ({
    ko: `직접 올린 더 새 Windows 앱 ${v}을(를) 그대로 둬요.`,
    en: `A newer Windows app put here by hand (${v}) stays as it is.`,
    id: `Aplikasi Windows yang lebih baru yang ditaruh manual (${v}) dibiarkan.`,
    ja: `手動で置いた新しいWindowsアプリ（${v}）はそのままにします。`,
    es: `Se mantiene la aplicación de Windows más reciente puesta a mano (${v}).`,
  }),
  ahead: (v: string, server: string): T => ({
    ko: `Windows 앱 ${v}은(는) 이 서버가 ${v}로 업데이트되면 들어와요(지금 ${server}).`,
    en: `The Windows app ${v} comes once this server runs ${v} (it runs ${server}).`,
    id: `Aplikasi Windows ${v} hadir setelah server ini menjalankan ${v} (sekarang ${server}).`,
    ja: `Windowsアプリ${v}は、このサーバーが${v}になると配布されます（現在${server}）。`,
    es: `La aplicación de Windows ${v} llegará cuando este servidor ejecute ${v} (ahora ${server}).`,
  }),
  none: { ko: '릴리스 피드에 이 릴리스의 Windows 앱이 없어요.', en: 'The release feed has no Windows app for this release.', id: 'Feed rilis tidak punya aplikasi Windows untuk rilis ini.', ja: 'リリースフィードにこのリリースのWindowsアプリがありません。', es: 'El canal de versiones no tiene aplicación de Windows para esta versión.' } as T,
  failed: (why: string, force = false): T => {
    const c = force ? cmdForce : cmd
    return {
      ko: `Windows 앱을 올리지 못했어요: ${why}. 고친 뒤 서버에서 ${c}를 실행해 주세요(docs/INSTALL-LINUX.md 8a).`,
      en: `The Windows app is not offered: ${why}. After fixing it, run ${c} on the server (docs/INSTALL-LINUX.en.md, "Windows app").`,
      id: `Aplikasi Windows tidak tersedia: ${why}. Setelah diperbaiki, jalankan ${c} di server (docs/INSTALL-LINUX.en.md, "Windows app").`,
      ja: `Windowsアプリを配布できませんでした：${why}。修正後、サーバーで${c}を実行してください（docs/INSTALL-LINUX.en.md「Windows app」）。`,
      es: `La aplicación de Windows no se ofrece: ${why}. Después de corregirlo, ejecute ${c} en el servidor (docs/INSTALL-LINUX.en.md, «Windows app»).`,
    }
  },
  /** a hosted tenant: its owner has no shell, the run after the next update tries again */
  failedHosted: (why: string): T => ({
    ko: `Windows 앱을 올리지 못했어요: ${why}. 팀 서버가 다음에 업데이트되면 다시 시도해요. 계속되면 지원팀에 알려 주세요.`,
    en: `The Windows app is not offered: ${why}. It is tried again after the team server's next update; if this stays, contact support.`,
    id: `Aplikasi Windows tidak tersedia: ${why}. Dicoba lagi setelah pembaruan server tim berikutnya; jika tetap begini, hubungi dukungan.`,
    ja: `Windowsアプリを配布できませんでした：${why}。チームサーバーの次回の更新後に再試行します。解決しない場合はサポートにお問い合わせください。`,
    es: `La aplicación de Windows no se ofrece: ${why}. Se volverá a intentar después de la próxima actualización del servidor del equipo; si sigue así, contacte con soporte.`,
  }),
  /** the folder still offers an app; only the last look at the feed failed */
  checkFailed: (v: string, why: string): T => ({
    ko: `Windows 앱 ${v}을(를) 이 서버에서 받을 수 있어요. 마지막 릴리스 피드 확인은 실패했어요: ${why}`,
    en: `The Windows app ${v} is offered by this server. The last look at the release feed failed: ${why}`,
    id: `Aplikasi Windows ${v} tersedia dari server ini. Pemeriksaan feed rilis terakhir gagal: ${why}`,
    ja: `Windowsアプリ${v}をこのサーバーから配布しています。前回のリリースフィードの確認は失敗しました：${why}`,
    es: `Este servidor ofrece la aplicación de Windows ${v}. La última consulta del canal de versiones falló: ${why}`,
  }),
}

/** The diagnostics line for the last run: null before the first one (15 minutes after start), and while a result from
 * before this server's own update would only confuse ("comes once this server runs 0.2.19" on 0.2.19) */
export function windowsDiagnostic(dataDir: string, serverVersion: string, downloadsDir = downloadsDirOf(dataDir), hosted = false): { status: 'ok' | 'warn'; text: T } | null {
  const st = readWindowsState(dataDir)
  const last = st.last
  if (!last) return null
  const v = last.version ?? ''
  const why = (last.message ?? last.kind).slice(0, 300)
  switch (last.kind) {
    case 'offered': case 'current': return { status: 'ok', text: WINDOWS_TEXT.offered(v) }
    case 'newer': return { status: 'ok', text: WINDOWS_TEXT.newer(v) }
    case 'ahead': return compareVersions(v, serverVersion) > 0 ? { status: 'ok', text: WINDOWS_TEXT.ahead(v, serverVersion) } : null
    case 'none': return { status: 'ok', text: WINDOWS_TEXT.none }
    case 'busy': return null
    case 'failed': {
      // the feed could not be read (no version): the folder may well still offer the app
      const offered = last.version === null ? readIndex(downloadsDir).find((i) => i.platform === 'windows') : undefined
      if (offered) return { status: 'ok', text: WINDOWS_TEXT.checkFailed(offered.version, why) }
      return { status: 'warn', text: hosted ? WINDOWS_TEXT.failedHosted(why) : WINDOWS_TEXT.failed(why, st.failed?.version === last.version) }
    }
    case 'held': return { status: 'warn', text: hosted ? WINDOWS_TEXT.failedHosted(why) : WINDOWS_TEXT.failed(why, true) }
    default: return { status: 'warn', text: hosted ? WINDOWS_TEXT.failedHosted(why) : WINDOWS_TEXT.failed(why) }
  }
}
