// Desktop app updates (docs/OFFICE.md "자동 업데이트"; pure parts in ../common/update.ts).
// Windows (packaged): electron-updater, generic provider = <open team address>/downloads/, the team's session as a
// Bearer token (the folder is for signed-in people; electron-updater uses its own session without cookies and drops
// the header on a redirect to another host). Checked 20 s after start and every 4 hours; the download runs in the
// background and installs when the app quits, or at once with the "다시 시작" prompt / menu item.
// macOS: a notice once per new version found in /downloads/index.json (read with the team page's own cookies) with a
// button that opens Settings > Apps; the app is not replaced (that needs an Apple-signed build).
// Mac App Store build (process.mas): off; the store updates it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, session, type BaseWindow } from 'electron'
import { DEV_SESSION_COOKIE, SESSION_COOKIE } from '@mycel/shared/api'
import { t, type UiLocale } from '../common/i18n'
import { partitionFor } from '../common/teams'
import { CHECK_EVERY_MS, FIRST_CHECK_MS, genericFeed, macNotice, updateMode, type UpdateMode } from '../common/update'
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
  private updater: typeof import('electron-updater').autoUpdater | null = null

  constructor(private host: UpdaterHost) {
    this.mode = updateMode(process.platform, app.isPackaged, process.env.MYCEL_DESKTOP_UPDATE_TEST, process.mas === true)
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
    if (!team || this.busy || this.ready) return
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
    await u.checkForUpdates()
  }

  private async autoUpdater() {
    if (this.updater) return this.updater
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowDowngrade = false
    // the office's Mac keeps only the newest installer, so a blockmap of the old one is not there to diff against
    autoUpdater.disableDifferentialDownload = true
    autoUpdater.logger = { info: (m: unknown) => debug('updater', String(m)), warn: (m: unknown) => debug('updater warn', String(m)), error: (m: unknown) => debug('updater error', String(m)), debug: () => {} }
    if (process.env.MYCEL_DESKTOP_UPDATE_TEST) autoUpdater.forceDevUpdateConfig = true
    autoUpdater.on('update-downloaded', (info) => {
      this.ready = info.version
      this.host.changed()
      void this.promptRestart(info.version)
    })
    autoUpdater.on('error', (e) => debug('updater error', e?.message ?? String(e)))
    this.updater = autoUpdater
    return autoUpdater
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
    if (!this.ready || !this.updater) return
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
      detail: t(L, 'update.mac.detail'),
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
