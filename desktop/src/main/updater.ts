// Desktop app updates (docs/OFFICE.md "자동 업데이트"; pure parts in ../common/update.ts).
// Windows (packaged): electron-updater, generic provider = <open team address>/downloads/, the team's session as a
// Bearer token (the folder is for signed-in people; electron-updater uses its own session without cookies and drops
// the header on a redirect to another host). Checked 20 s after start and every 4 hours; the download runs in the
// background and installs when the app quits, or at once with the "다시 시작" prompt / menu item, but only after the
// downloaded installer matches the product's signed release (../common/update-verify.ts): until then nothing installs,
// and a mismatch deletes the download and tells the person once per version.
// macOS: a notice once per new version found in /downloads/index.json (read with the team page's own cookies) with a
// button that opens Settings > Apps; the app is not replaced (that needs an Apple-signed build).
// Store build (process.mas, process.windowsStore): off; the store updates it.
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app, dialog, session, type BaseWindow } from 'electron'
import { DEV_SESSION_COOKIE, SESSION_COOKIE } from '@mycel/shared/api'
import { APP_DOWNLOADS } from '@mycel/shared'
import { t, type UiLocale } from '../common/i18n'
import { partitionFor } from '../common/teams'
import { CHECK_EVERY_MS, FIRST_CHECK_MS, feedUrlFor, genericFeed, macNotice, storeBuild, updateMode, type UpdateMode } from '../common/update'
import { manifestSources, verificationRequired, verifyInstaller } from '../common/update-verify'
import { debug } from './debug'

export interface UpdaterHost {
  /** the open team (null on the welcome screen) */
  team(): { id: string; origin: string } | null
  window(): BaseWindow | null
  locale(): UiLocale
  /** show Settings > Apps of the open team */
  openApps(): void
  /** the menu shows "update ready — restart" */
  changed(): void
}

export class DesktopUpdater {
  readonly mode: UpdateMode
  /** a downloaded update waiting for a restart (Windows) */
  ready: string | null = null
  private timer?: NodeJS.Timeout
  private busy = false
  private prompted = new Set<string>()
  /** versions whose download the signed release contradicted: not downloaded again in this run */
  private refused = new Set<string>()
  private noticed = new Set<string>()
  /** the installer that passed verifyInstaller: restartNow and the quit handler install only that path with that SHA-256 */
  private verified: { file: string; sha256: string } | null = null
  private verifying = false
  private quitHandler = false
  private updater: typeof import('electron-updater').autoUpdater | null = null

  /** `trust`: the release keys and product to check against; tests only (default RELEASE_CHANNEL's) */
  constructor(private host: UpdaterHost, private trust: { keys?: readonly string[]; product?: string } = {}) {
    this.mode = updateMode(process.platform, app.isPackaged, process.env.MYCEL_DESKTOP_UPDATE_TEST, storeBuild(process))
  }

  start() {
    if (this.mode === 'off') return
    setTimeout(() => void this.check(), Number(process.env.MYCEL_DESKTOP_UPDATE_FIRST_MS) || FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
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
      if (this.mode === 'auto-install') await this.checkWindows(team)
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
    const { autoUpdater } = await import('electron-updater')
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
      this.ready = version
      this.installOnQuit()
      this.host.changed()
      void this.promptRestart(version)
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
      const v = verifyInstaller({ manifest: text, installerSha256, channel: src.channel, version, current: app.getVersion(), ...this.trust })
      if (v.ok) return { ...v, sha256: installerSha256 }
      debug('update manifest', src.url, v.reason)
      first ??= v.reason
    }
    return first ? { ok: false, reason: first } : { ok: false, reason: 'no signed release could be read (team server and release feed)', unread: true }
  }

  /** the app quits normally: install the verified update silently (what electron-updater's own handler did) */
  private installOnQuit() {
    if (this.quitHandler) return
    this.quitHandler = true
    app.once('quit', (_e, code) => {
      if (code !== 0 || !this.ready || !this.updater || !this.installsVerified()) return
      // BaseUpdater.install (NSIS on Windows; the AppUpdater type does not name it)
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

  /** "이 업데이트는 확인할 수 없어서 설치하지 않았어요" (once per version) */
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

  /** "업데이트 준비됨 — 다시 시작" (once per version; the menu item stays) */
  async promptRestart(version: string) {
    if (this.prompted.has(version)) return
    this.prompted.add(version)
    const L = this.host.locale()
    const opts = {
      type: 'info' as const,
      title: t(L, 'update.ready.title'),
      message: t(L, 'update.ready.message', { version }),
      detail: t(L, 'update.ready.detail'),
      buttons: [t(L, 'update.ready.restart'), t(L, 'update.ready.later')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }
    const w = this.host.window()
    const r = w && !w.isDestroyed() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)
    if (r.response === 0) this.restartNow()
  }

  restartNow() {
    if (!this.ready || !this.updater || !this.installsVerified()) return
    // silent install (the one-click installer shows nothing anyway), then start the app again
    this.updater.quitAndInstall(true, true)
  }

  private dismissedFile() {
    return join(app.getPath('userData'), 'update-notice.json')
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
