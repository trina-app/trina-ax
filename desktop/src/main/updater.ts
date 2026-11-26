// Desktop app updates (docs/OFFICE.md "자동 업데이트"; pure parts in ../common/update.ts).
// Windows (packaged): electron-updater, generic provider = <open team address>/downloads/, the team's session as a
// Bearer token (the folder is for signed-in people; electron-updater uses its own session without cookies and drops
// the header on a redirect to another host). Checked 20 s after start and every 4 hours; the download runs in the
// background and installs when the app quits, by itself when the computer is idle and nothing would be lost
// (idleRestart), or at once with the menu item, but only after the downloaded installer matches the product's signed
// release (../common/update-verify.ts): until then nothing installs, and a mismatch deletes the download and tells the
// person once per version. No "Restart" question (docs/decisions/20261116-quiet-desktop-updates.md).
// macOS (the Developer ID signed dmg): the same, electron-updater's Mac updater on <team>/downloads/latest-mac.yml and
// its update zip. The download is checked against the signed release first; only then is it handed to Squirrel.Mac
// (electron-updater's local proxy, nativeUpdater.checkForUpdates), which takes only an app signed by the same team and
// installs it when the app quits, when idle (idleRestart) or with the menu item. A start while ShipIt is still
// installing steps aside (./update-launch.ts). An app that runs from the dmg or a translocated download cannot be
// updated: one line offers "Move to Applications". A team server without latest-mac.yml (older than 0.5.5):
// the old notice once per new version found in /downloads/index.json, with a button that opens Settings > Apps.
// Linux AppImage (APPIMAGE set): the same as Windows, electron-updater's AppImage updater on
// <team>/downloads/latest-linux.yml (latest-linux-arm64.yml on arm64) and the AppImage it names, checked against the
// signed release (its `linux` entry for this processor); it replaces the AppImage when the app quits. Linux .deb: no
// updater; the team's signed /downloads/<channel>.json is read and a newer `linux` version is said once, with a button
// for the download page (docs/decisions/20261119-linux-desktop-app.md).
// Store build (process.mas, process.windowsStore): off; the store updates it.
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app, autoUpdater as nativeUpdater, BaseWindow, dialog, powerMonitor, session, shell } from 'electron'
import { DEV_SESSION_COOKIE, SESSION_COOKIE } from '@mycel/shared/api/common'
import { APP_DOWNLOADS } from '@mycel/shared/app-downloads'
import { PRODUCT } from '@mycel/shared/product'
import { t, type UiLocale } from '../common/i18n'
import { partitionFor } from '../common/teams'
import { CHECK_EVERY_MS, FIRST_CHECK_MS, feedUrlFor, genericFeed, macNotice, selfUpdatingMac, storeBuild, updateMode, type UpdateMode } from '../common/update'
import { linuxNotice, manifestSources, verificationRequired, verifyInstaller } from '../common/update-verify'
import { idleRestartAllowed, readOnlyRefusal, stagedPending, type Resume } from '../common/update-guard'
import { debug } from './debug'
import { readPending, writePending, writeResume } from './update-launch'

export interface UpdaterHost {
  /** the open team (null on the welcome screen) */
  team(): { id: string; origin: string } | null
  window(): BaseWindow | null
  locale(): UiLocale
  /** show Settings > Apps of the open team */
  openApps(): void
  /** the menu shows "update ready — restart" */
  changed(): void
  /** what an idle restart could lose, or null when nothing can be lost (and the page to open again after it) */
  restartBlockers(): Promise<{ pageBusy: boolean | null; browserTabs: number; resume: Resume }>
}

/** how often a ready update looks whether the computer is idle enough to restart into it */
const IDLE_CHECK_MS = 60_000

export class DesktopUpdater {
  readonly mode: UpdateMode
  /** a downloaded update waiting for a restart (Windows) */
  ready: string | null = null
  private timer?: NodeJS.Timeout
  private busy = false
  /** versions whose download the signed release contradicted: not downloaded again in this run */
  private refused = new Set<string>()
  private noticed = new Set<string>()
  /** the installer that passed verifyInstaller: restartNow and the quit handler install only that path with that SHA-256 */
  private verified: { file: string; sha256: string } | null = null
  private verifying = false
  private quitHandler = false
  private updater: typeof import('electron-updater').autoUpdater | null = null
  private idleTimer?: NodeJS.Timeout
  private idleChecking = false
  /** Squirrel.Mac refusals per version in this run (not about where the app runs): the second one says so */
  private squirrelFailed = new Map<string, number>()

  /** Mac (Squirrel.Mac), or Windows (NSIS) and the Linux AppImage install path */
  private readonly mac: boolean
  /** Linux: the AppImage installs like Windows; a .deb only gets the notice (checkLinux) */
  private readonly linux: boolean

  /** `trust`: the release keys and product to check against, and the platform; tests only (default RELEASE_CHANNEL's,
   * process.platform) */
  constructor(private host: UpdaterHost, private trust: { keys?: readonly string[]; product?: string; platform?: NodeJS.Platform } = {}) {
    const platform = trust.platform ?? process.platform
    this.mac = platform === 'darwin'
    this.linux = platform === 'linux'
    let pkg: unknown = null
    if (this.mac && app.isPackaged) { try { pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) } catch {} }
    this.mode = updateMode(platform, app.isPackaged, process.env.MYCEL_DESKTOP_UPDATE_TEST, storeBuild(process), selfUpdatingMac(pkg), process.env.APPIMAGE)
  }

  start() {
    if (this.mode === 'off') return
    setTimeout(() => void this.check(), Number(process.env.MYCEL_DESKTOP_UPDATE_FIRST_MS) || FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.idleTimer) clearInterval(this.idleTimer)
  }

  /** the session token of the team page (the cookie the team server set), or null when signed out */
  private async token(teamId: string, origin: string): Promise<string | null> {
    const ses = session.fromPartition(partitionFor(teamId, 'app'))
    const c = (await ses.cookies.get({ url: origin })).find((x) => x.name === SESSION_COOKIE || x.name === DEV_SESSION_COOKIE)
    return c?.value ?? null
  }

  async check(): Promise<void> {
    const team = this.host.team()
    if (!team || this.busy || this.ready || this.verifying) return
    this.busy = true
    try {
      if (this.mode === 'auto-install' && this.mac) {
        // a team server that offers no Mac update feed yet (older than 0.5.5, or no Mac app in its release): the notice.
        // Only then: a download that broke off is simply tried again at the next check
        try { await this.checkWindows(team) } catch (e) {
          debug('mac update feed', (e as Error).message)
          if ((e as { code?: string }).code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') await this.checkMac(team)
        }
      } else if (this.mode === 'auto-install') await this.checkWindows(team)
      else if (this.mode === 'notice' && this.linux) await this.checkLinux(team)
      else if (this.mode === 'notice') await this.checkMac(team)
    } catch (e) {
      debug('update check failed', (e as Error).message)
    } finally {
      this.busy = false
    }
  }

  private async checkWindows(team: { id: string; origin: string }) {
    const feed = genericFeed(team.origin, await this.token(team.id, team.origin))
    if (!feed?.requestHeaders) return // signed out: /downloads/ would answer 401
    const u = await this.autoUpdater()
    u.setFeedURL({ provider: 'generic', url: feed.url })
    u.requestHeaders = feed.requestHeaders
    // downloaded only here (autoDownload off): never while a download is being checked, never a version refused before
    const r = await u.checkForUpdates()
    if (!r?.isUpdateAvailable || this.refused.has(r.updateInfo.version) || this.verifying || this.ready) return
    await u.downloadUpdate()
  }

  private async autoUpdater() {
    if (this.updater) return this.updater
    const eu = await import('electron-updater')
    // an AppImage always takes the AppImage updater: electron-updater would pick its .deb updater if a
    // resources/package-type file ever came into the AppImage (the .deb build writes one into the shared unpacked folder)
    const autoUpdater = this.linux && process.env.APPIMAGE && typeof eu.AppImageUpdater === 'function' ? new eu.AppImageUpdater() : eu.autoUpdater
    autoUpdater.autoDownload = false
    // no web installer: its package file would not be covered by the signed release
    autoUpdater.disableWebInstaller = true
    // never electron-updater's own install-on-quit: it would run a download before it is checked (verifyDownload)
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowDowngrade = false
    // the team server keeps only the newest installer, so a blockmap of the old one is not there to diff against
    autoUpdater.disableDifferentialDownload = true
    autoUpdater.logger = { info: (m: unknown) => debug('updater', String(m)), warn: (m: unknown) => debug('updater warn', String(m)), error: (m: unknown) => debug('updater error', String(m)), debug: () => {} }
    if (process.env.MYCEL_DESKTOP_UPDATE_TEST) autoUpdater.forceDevUpdateConfig = true
    autoUpdater.on('update-downloaded', (info) => void this.verifyDownload(info.version, info.downloadedFile))
    autoUpdater.on('error', (e) => debug('updater error', e?.message ?? String(e)))
    this.updater = autoUpdater
    return autoUpdater
  }

  /** Install only what the signed release names (the header): ready + install on quit, or delete + tell. The event
   * comes from downloadUpdate (checkWindows), which is not called again while this runs. */
  private async verifyDownload(version: string, file: string) {
    if (this.verifying || this.ready) return
    this.verifying = true
    try {
      let v: Verdict
      try { v = await this.verifyFile(version, file) } catch (e) { v = { ok: false, reason: (e as Error).message, unread: true } }
      if (!v.ok) {
        console.warn(`[desktop] update ${version} not installed: ${v.reason}`)
        // nothing signed could be read (team server down, no internet): keep the download and try at the next check
        if (v.unread) return
        this.refused.add(version)
        try { rmSync(file, { force: true }) } catch {}
        void this.notifyRefused(version)
        return
      }
      debug('update verified', version, v.keyId)
      this.verified = { file, sha256: v.sha256 }
      if (this.mac) {
        // Squirrel.Mac fetches the checked zip from electron-updater's local proxy and stages it; it installs on quit
        // by itself from then on (no quit handler here)
        try { await this.squirrelTakes() } catch (e) {
          const message = (e as Error).message
          console.warn(`[desktop] update ${version} not installed: ${message}`)
          this.verified = null
          // the one case the person can fix: the app runs from the dmg or a translocated download. Any other refusal is
          // tried again at the next check, quietly, and said (download page) the second time
          if (readOnlyRefusal(message) || !app.isInApplicationsFolder()) {
            this.refused.add(version) // not downloaded again in this run
            void this.offerMove(version)
          } else if ((this.squirrelFailed.get(version) ?? 0) + 1 >= 2) {
            // the same refusal twice in this run: no more downloads of it, one line with the download page
            this.refused.add(version)
            void this.offerDownload(version)
          } else this.squirrelFailed.set(version, (this.squirrelFailed.get(version) ?? 0) + 1)
          return
        }
        this.becameReady(version)
        return
      }
      this.installOnQuit()
      this.becameReady(version)
    } finally {
      this.verifying = false
    }
  }

  private async verifyFile(version: string, file: string): Promise<Verdict> {
    const installerSha256 = await sha256Of(file)
    if (!verificationRequired(app.isPackaged)) return { ok: true, keyId: 'unverified (development)', sha256: installerSha256 }
    const team = this.host.team()
    const teamFeed = team ? feedUrlFor(team.origin) : null
    const ses = team ? session.fromPartition(partitionFor(team.id, 'app')) : session.defaultSession
    let first: string | null = null
    for (const src of manifestSources(teamFeed ?? '', version)) {
      if (src.team && !teamFeed) continue
      let text: string
      try {
        const res = await ses.fetch(src.url, { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { accept: 'application/json', 'cache-control': 'no-cache' } })
        if (!res.ok) continue
        if (Number(res.headers.get('content-length') ?? 0) > MANIFEST_MAX) continue
        text = await res.text()
      } catch (e) {
        debug('update manifest', src.url, (e as Error).message)
        continue
      }
      if (text.length > MANIFEST_MAX) continue
      const v = verifyInstaller({ manifest: text, installerSha256, channel: src.channel, version, current: app.getVersion(), keys: this.trust.keys, product: this.trust.product, platform: this.mac ? 'mac' : this.linux ? 'linux' : 'windows', arch: process.arch })
      if (v.ok) return { ...v, sha256: installerSha256 }
      debug('update manifest', src.url, v.reason)
      first ??= v.reason
    }
    return first ? { ok: false, reason: first } : { ok: false, reason: 'no signed release could be read (team server and release feed)', unread: true }
  }

  /** Mac: hand the verified zip to Squirrel.Mac and wait until it has staged it (or says why not) */
  private squirrelTakes(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { done(); reject(new Error('Squirrel.Mac did not take the update within 10 minutes')) }, 10 * 60_000)
      const ok = () => { done(); resolve() }
      const bad = (e: Error) => { done(); reject(e) }
      const done = () => { clearTimeout(timer); nativeUpdater.removeListener('update-downloaded', ok); nativeUpdater.removeListener('error', bad) }
      nativeUpdater.once('update-downloaded', ok)
      nativeUpdater.once('error', bad)
      nativeUpdater.checkForUpdates()
    })
  }

  /** the app quits normally: install the verified update silently (what electron-updater's own handler did) */
  private installOnQuit() {
    if (this.quitHandler) return
    this.quitHandler = true
    app.once('quit', (_e, code) => {
      if (code !== 0 || !this.ready || !this.updater || !this.installsVerified()) return
      // BaseUpdater.install (NSIS on Windows, the AppImage replaced on Linux; the AppUpdater type does not name it)
      ;(this.updater as unknown as { install(silent: boolean, runAfter: boolean): boolean }).install(true, false)
    })
  }

  /** the file electron-updater would run is the one that was verified, with the same bytes now (hashed again right
   * before the install: nothing may have replaced it since) */
  private installsVerified(): boolean {
    const p = (this.updater as unknown as { installerPath?: string | null } | null)?.installerPath ?? null
    if (!this.verified || p !== this.verified.file) return false
    let now: string | null = null
    try { now = sha256FileSync(p) } catch {}
    if (now === this.verified.sha256) return true
    console.warn(`[desktop] update ${this.ready} not installed: the installer changed after it was checked`)
    this.ready = null
    this.verified = null
    this.host.changed()
    try { rmSync(p, { force: true }) } catch {}
    return false
  }

  /** "이 업데이트는 안전 확인을 통과하지 못해서 설치하지 않았어요" (once per version) */
  private async notifyRefused(version: string) {
    if (this.noticed.has(version)) return
    this.noticed.add(version)
    const L = this.host.locale()
    const opts = {
      type: 'warning' as const,
      title: t(L, 'update.refused.title'),
      message: t(L, 'update.refused.message'),
      detail: t(L, 'update.refused.detail'),
      buttons: [t(L, 'update.refused.ok')],
      defaultId: 0,
      noLink: true,
    }
    const w = this.host.window()
    if (w && !w.isDestroyed()) await dialog.showMessageBox(w, opts)
    else await dialog.showMessageBox(opts)
  }

  /** ready to install: nothing is asked. It installs when the app quits, or by itself when idle (idleRestart); the next
   * start checks that it did (./update-launch.ts) */
  private becameReady(version: string) {
    this.ready = version
    const userData = app.getPath('userData')
    writePending(userData, stagedPending(readPending(userData), version, Date.now()))
    this.host.changed()
    if (!this.idleTimer) this.idleTimer = setInterval(() => void this.idleRestart(), Number(process.env.MYCEL_DESKTOP_UPDATE_IDLE_MS) || IDLE_CHECK_MS)
  }

  /** restart into the ready update when nobody uses the app and nothing would be lost; the open page comes back */
  async idleRestart(): Promise<boolean> {
    if (!this.ready || this.idleChecking) return false
    this.idleChecking = true
    try {
      const quiet = () => {
        let locked = false
        try { locked = powerMonitor.getSystemIdleState(60) === 'locked' } catch {}
        return { ready: !!this.ready, focused: BaseWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()), idleSeconds: powerMonitor.getSystemIdleTime(), locked }
      }
      // cheap checks first: the page is asked only when the computer is idle, and they are read again after its answer
      if (!idleRestartAllowed({ ...quiet(), pageBusy: false, browserTabs: 0 })) return false
      const b = await this.host.restartBlockers()
      if (!idleRestartAllowed({ ...quiet(), pageBusy: b.pageBusy, browserTabs: b.browserTabs })) return false
      debug('idle restart into', this.ready)
      const userData = app.getPath('userData')
      writeResume(userData, b.resume)
      if (this.restartNow()) return true
      writeResume(userData, null)
      return false
    } catch (e) {
      debug('idle restart', (e as Error).message)
      return false
    } finally {
      this.idleChecking = false
    }
  }

  /** "<app> can't update itself from here" with "Move to Applications" (once per version) */
  private async offerMove(version: string) {
    if (this.noticed.has(version)) return
    this.noticed.add(version)
    const L = this.host.locale()
    const r = await this.ask({ message: t(L, 'update.move.message', { app: PRODUCT.displayName, version }), buttons: [t(L, 'update.move.move'), t(L, 'update.later')] })
    if (r !== 0) return
    try {
      // moves the app (out of the dmg, or the translocated copy) into /Applications and starts it from there
      if (!app.moveToApplicationsFolder()) void this.offerDownload(version, true)
    } catch (e) {
      debug('move to applications', (e as Error).message)
      void this.offerDownload(version, true)
    }
  }

  /** "<app> couldn't update to <version>" with the website's download page (once per version) */
  async offerDownload(version: string, again = false) {
    if (this.noticed.has(version) && !again) return
    this.noticed.add(version)
    const L = this.host.locale()
    const r = await this.ask({ message: t(L, 'update.failed.message', { app: PRODUCT.displayName, version }), buttons: [t(L, 'update.failed.download'), t(L, 'update.later')] })
    // an edition without its own download page: the team's Settings › Apps
    if (r === 0) { if (APP_DOWNLOADS.page) void shell.openExternal(APP_DOWNLOADS.page); else this.host.openApps() }
  }

  private async ask(o: { message: string; buttons: string[] }): Promise<number> {
    const opts = { type: 'info' as const, message: o.message, buttons: o.buttons, defaultId: 0, cancelId: 1, noLink: true }
    const w = this.host.window()
    const r = w && !w.isDestroyed() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)
    return r.response
  }

  /** install the ready update now and start the app again (the menu item, idleRestart); false when nothing installs */
  restartNow(): boolean {
    if (!this.ready || !this.updater) return false
    // Mac: Squirrel.Mac already holds the checked bytes (squirrelTakes); electron-updater's quitAndInstall restarts into them
    if (this.mac) { this.updater.quitAndInstall(); return true }
    if (!this.installsVerified()) return false
    // silent install (the one-click installer shows nothing anyway), then start the app again
    this.updater.quitAndInstall(true, true)
    return true
  }

  private dismissedFile() {
    return join(app.getPath('userData'), 'update-notice.json')
  }

  /** Linux .deb: the team's signed release names a newer Linux app: one line once per version, with the download page
   * (an edition without one: the team's Settings › Apps) */
  private async checkLinux(team: { id: string; origin: string }) {
    const base = feedUrlFor(team.origin)
    if (!base) return
    const ses = session.fromPartition(partitionFor(team.id, 'app'))
    let n: { version: string } | null = null
    for (const src of manifestSources(base, app.getVersion()).filter((x) => x.team)) {
      try {
        const res = await ses.fetch(src.url, { signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { accept: 'application/json', 'cache-control': 'no-cache' } })
        if (!res.ok || Number(res.headers.get('content-length') ?? 0) > MANIFEST_MAX) continue
        const text = await res.text()
        if (text.length > MANIFEST_MAX) continue
        n = linuxNotice(text, { channel: src.channel, current: app.getVersion(), keys: this.trust.keys, product: this.trust.product })
      } catch (e) { debug('linux update notice', src.url, (e as Error).message); continue }
      // the team server offers one channel: its manifest decides
      break
    }
    if (!n) return
    let seen: string | null = null
    try { seen = existsSync(this.dismissedFile()) ? (JSON.parse(readFileSync(this.dismissedFile(), 'utf8')) as { version?: string }).version ?? null : null } catch {}
    if (seen === n.version) return
    try { writeFileSync(this.dismissedFile(), JSON.stringify({ version: n.version })) } catch {}
    const L = this.host.locale()
    const opts = {
      type: 'info' as const,
      title: t(L, 'update.linux.title'),
      message: t(L, 'update.linux.message', { version: n.version, current: app.getVersion() }),
      detail: t(L, 'update.linux.detail'),
      buttons: [t(L, 'update.linux.download'), t(L, 'update.linux.later')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }
    const w = this.host.window()
    const r = w && !w.isDestroyed() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)
    if (r.response === 0) { if (APP_DOWNLOADS.page) void shell.openExternal(APP_DOWNLOADS.page); else this.host.openApps() }
  }

  private async checkMac(team: { id: string; origin: string }) {
    const ses = session.fromPartition(partitionFor(team.id, 'app'))
    const res = await ses.fetch(`${team.origin}/downloads/index.json`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } })
    if (!res.ok) return
    const n = macNotice(await res.json(), app.getVersion())
    if (!n) return
    let seen: string | null = null
    try { seen = existsSync(this.dismissedFile()) ? (JSON.parse(readFileSync(this.dismissedFile(), 'utf8')) as { version?: string }).version ?? null : null } catch {}
    if (seen === n.version) return
    try { writeFileSync(this.dismissedFile(), JSON.stringify({ version: n.version })) } catch {}
    const L = this.host.locale()
    const opts = {
      type: 'info' as const,
      title: t(L, 'update.mac.title'),
      message: t(L, 'update.mac.message', { version: n.version, current: app.getVersion() }),
      // with a Mac App Store listing the team server's .dmg is no longer offered: Settings > Apps shows the App Store
      detail: t(L, APP_DOWNLOADS.mac ? 'update.mac.detailStore' : 'update.mac.detail'),
      buttons: [t(L, 'update.mac.download'), t(L, 'update.mac.later')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }
    const w = this.host.window()
    const r = w && !w.isDestroyed() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)
    if (r.response === 0) this.host.openApps()
  }
}

type Verdict = { ok: true; keyId: string; sha256: string } | { ok: false; reason: string; unread?: boolean }
const MANIFEST_MAX = 400_000

/** SHA-256 (hex) of a file, read in 1 MiB pieces (the quit handler cannot wait for a promise) */
function sha256FileSync(file: string): string {
  const h = createHash('sha256')
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n))
  } finally { closeSync(fd) }
  return h.digest('hex')
}

/** SHA-256 (hex) of a file, streamed (the installer is 110–200 MB) */
function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}
