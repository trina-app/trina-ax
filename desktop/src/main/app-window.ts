// The app window: the desktop's own welcome / team list screen, or a team's page with the browser pane beside it.
//
//   ┌──────────────── BaseWindow ─────────────────┐
//   │ app view (team page, team partition)  │pane │  pane = toolbar UI (pane.html) + the active tab view
//   │                                       │     │
//   └───────────────────────────────────────┴─────┘
//   shell view (welcome.html) covers everything when no team is open, the team list is shown, or the team
//   server cannot be reached.
import { BaseWindow, dialog, Notification, session, WebContentsView, type Session } from 'electron'
import { join } from 'node:path'
import { PRODUCT, type DesktopConnection, type DesktopPaneState } from '@mycel/shared'
import { Health, Me } from '@mycel/shared/api'
import { isGatewayDown, originOf, parseTeamAddress, teamLabel, type AddressError } from '../common/address'
import { t, type UiKey, type UiLocale } from '../common/i18n'
import { teamHostnames } from '../common/browser-block'
import { SitePermissions, type SiteSettings } from '../common/site-permissions'
import { browserOwnerChange, type MeResult } from '../common/browser-owner'
import { addTeam, findTeam, partitionFor, removeTeam, sortedTeams, touchTeam, updateTeam, type DirectInfo, type TeamEntry, type TeamsFile } from '../common/teams'
import { isTrustedAppSender, UI_ORIGIN } from '../common/trust'
import { openDialogChoice } from '../common/file-chooser'
import { directFromConnectInfo, fetchConnectInfo, lanFailureCode, lanFailureToReport, mirrorSessionCookie, pinCertificates, probeDirect, reportLanFailure, type ProbeResult } from './direct'
import { BrowserPane, type PaneActivity, type PanePrompt } from './pane/pane'
import { HostClassifier, sessionResolver } from './pane/classify'
import { APP_WEB_PREFERENCES, guardAppView, guardUiView, hardenAppSession } from './security'
import type { TeamsStore } from './teams-store'
import { debug } from './debug'

export type Mode = 'welcome' | 'team' | 'offline'

export interface WelcomeState {
  mode: Mode
  teams: { id: string; label: string; origin: string; current: boolean }[]
  /** a team is open behind the welcome screen (the back button returns to it) */
  canGoBack: boolean
  offline: { address: string } | null
  /** a kit build's team address, filled in on the first-run screen while no team is remembered (common/kit.ts) */
  suggested: string | null
}

/**
 * How a request from the team page's Settings > Browser to turn on "Allow all websites" ended (bridge
 * browserSettings.setAccess('all')): changed only after the person confirmed the app's own dialog.
 */
export type AllowAllOutcome = 'changed' | 'unchanged' | 'cancelled' | 'not-allowed' | 'busy' | 'unavailable'

export interface AppWindowOptions {
  store: TeamsStore
  /** language of the app's own screens right now (it can change while the window is open) */
  locale: () => UiLocale
  distDir: string
  pageScript: string
  appVersion: string
  classifier: HostClassifier
  /** a kit build's team address (common/kit.ts), or null */
  suggestedTeam?: string | null
  /** the app answers the team page's file input with its own dialog (common/file-chooser.ts answersFileChoosers) */
  answerFileChoosers?: boolean
  /** the team list changed (the menu is rebuilt) */
  onTeamsChanged(): void
}

const MIN_PANE = 360
const MIN_APP = 420
const RECHECK_MS = 60_000
/** a settings read from the team page re-reads the team's policy at most this often */
const POLICY_READ_MS = 5_000
/** after the "Allow all websites" dialog closes, another request is refused this long (no dialog right under a click) */
const ALLOW_ALL_COOLDOWN_MS = 2_000

export class AppWindow {
  readonly win: BaseWindow
  readonly shell: WebContentsView
  readonly chrome: WebContentsView
  app?: WebContentsView
  pane?: BrowserPane
  team?: TeamEntry
  mode: Mode = 'welcome'
  private teams: TeamsFile
  private paneFraction: number
  /** origin the app view shows: the team address or its direct LAN address */
  private currentOrigin = ''
  private directOrigin: string | null = null
  private fingerprintMismatch = false
  private recheckTimer?: NodeJS.Timeout
  private lastCheck = 0
  private configuredSessions = new WeakSet<Session>()
  private notifyTimes: number[] = []
  /** team id + code -> last LAN failure report (at most one an hour; the server counts once per session per hour) */
  private lanReported = new Map<string, number>()
  /** GET /api/me in flight (team name and browser policy), and when the last one started */
  private teamInfo?: { p: Promise<boolean>; pane?: BrowserPane }
  private teamInfoAt = 0
  /** the "Allow all websites" dialog is open, or closed less than ALLOW_ALL_COOLDOWN_MS ago */
  private allowAllOpen = false
  private allowAllUntil = 0
  /** the open dialog for the team page's file input is showing (one at a time) */
  private choosingFiles = false

  constructor(private o: AppWindowOptions) {
    this.teams = o.store.load()
    const saved = o.store.loadWindow()
    this.paneFraction = typeof saved.paneFraction === 'number' && saved.paneFraction > 0.15 && saved.paneFraction < 0.85 ? saved.paneFraction : 0.45
    this.win = new BaseWindow({
      width: clamp(saved.width ?? 1440, 900, 4000),
      height: clamp(saved.height ?? 900, 600, 3000),
      minWidth: 900,
      minHeight: 600,
      title: PRODUCT.displayName,
      backgroundColor: '#F7F6F3',
      show: false,
    })
    const uiPrefs = { preload: join(o.distDir, 'preload-ui.cjs'), ...APP_WEB_PREFERENCES, partition: 'mycel-ui' }
    this.shell = new WebContentsView({ webPreferences: uiPrefs })
    this.chrome = new WebContentsView({ webPreferences: uiPrefs })
    for (const v of [this.shell, this.chrome]) guardUiView(v.webContents)
    this.chrome.setBackgroundColor('#ECEAE4')
    void this.shell.webContents.loadURL(`${UI_ORIGIN}/welcome.html`)
    void this.chrome.webContents.loadURL(`${UI_ORIGIN}/pane.html`)
    this.win.on('resize', () => this.layout())
    this.win.on('focus', () => void this.recheck(false))
    this.win.on('close', () => {
      const [width, height] = this.win.getSize()
      o.store.saveWindow({ width, height, paneFraction: this.paneFraction })
      // close the views while the window still exists (WebContentsView contents are not closed with it)
      this.disposeTeam()
      for (const v of [this.shell, this.chrome]) if (!v.webContents.isDestroyed()) v.webContents.close()
      debug('window closed, team disposed')
    })
    this.layout()
    this.shell.webContents.once('did-finish-load', () => this.win.show())
  }

  // ------------------------------------------------------------------ teams

  teamList(): TeamEntry[] {
    return sortedTeams(this.teams)
  }

  private saveTeams(f: TeamsFile) {
    this.teams = f
    this.o.store.save(f)
    this.o.onTeamsChanged()
    this.sendWelcome()
  }

  welcomeState(): WelcomeState {
    return {
      mode: this.mode,
      teams: this.teamList().map((x) => ({ id: x.id, label: x.label, origin: x.origin, current: x.id === this.team?.id })),
      canGoBack: Boolean(this.team && this.app),
      offline: this.mode === 'offline' && this.team ? { address: this.team.origin } : null,
      suggested: this.teamList().length ? null : (this.o.suggestedTeam ?? null),
    }
  }

  private sendWelcome() {
    if (!this.shell.webContents.isDestroyed()) this.shell.webContents.send('ui:welcome-state', this.welcomeState())
  }

  /** Check an address, remember it, open it. */
  async addTeam(address: string): Promise<{ ok: true; teamId: string } | { ok: false; error: AddressError | 'unreachable' | 'notTeamServer'; message: string }> {
    const p = parseTeamAddress(address)
    const L = this.o.locale()
    if (!p.ok) return { ok: false, error: p.error, message: t(L, `err.${p.error}` as UiKey) }
    let health: Response
    try {
      health = await session.fromPartition('mycel-ui').fetch(`${p.origin}/api/health`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } })
    } catch {
      return { ok: false, error: 'unreachable', message: t(L, 'err.unreachable') }
    }
    // a tunnel / relay error page (e.g. Cloudflare 530 while the office's Mac is off) is "cannot reach", not "not a team server"
    if (isGatewayDown(health.status)) return { ok: false, error: 'unreachable', message: t(L, 'err.unreachable') }
    let body: unknown = null
    try {
      body = await health.json()
    } catch {
      body = null
    }
    if (!health.ok || !Health.safeParse(body).success) return { ok: false, error: 'notTeamServer', message: t(L, 'err.notTeamServer') }
    const r = addTeam(this.teams, p.origin, teamLabel(p.origin), this.o.store.newTeamId(), new Date().toISOString())
    if (!r.existed) this.saveTeams(r.file)
    await this.openTeam(r.team.id)
    return { ok: true, teamId: r.team.id }
  }

  async removeTeam(id: string): Promise<void> {
    const team = findTeam(this.teams, id)
    if (!team) return
    if (this.team?.id === id) {
      this.disposeTeam()
      this.team = undefined
      this.mode = 'welcome'
      this.layout()
    }
    // forget everything this team left in the app: cookies, storage, cache, allowed sites
    for (const kind of ['app', 'browser'] as const) {
      const ses = session.fromPartition(partitionFor(id, kind))
      await ses.clearStorageData().catch(() => {})
      await ses.clearCache().catch(() => {})
    }
    this.o.store.removeTeamFiles(id)
    this.saveTeams(removeTeam(this.teams, id))
  }

  showWelcome() {
    this.mode = 'welcome'
    this.layout()
    this.sendWelcome()
    this.shell.webContents.focus()
  }

  back() {
    if (this.team && this.app) {
      this.mode = 'team'
      this.layout()
    }
  }

  async openLast() {
    const last = findTeam(this.teams, this.teams.lastTeamId) ?? this.teamList()[0]
    if (last) await this.openTeam(last.id)
    else this.showWelcome()
  }

  async openTeam(id: string) {
    const team = findTeam(this.teams, id)
    if (!team) return
    if (this.team?.id === id && this.app && this.mode !== 'offline') return this.back()
    debug('open team', id)
    this.disposeTeam()
    this.team = team
    this.saveTeams(touchTeam(this.teams, id, new Date().toISOString()))
    this.team = findTeam(this.teams, id)!
    this.fingerprintMismatch = false
    this.directOrigin = null

    const appSes = session.fromPartition(partitionFor(id, 'app'))
    this.configureAppSession(appSes)
    const app = new WebContentsView({ webPreferences: { ...APP_WEB_PREFERENCES, session: appSes, preload: join(this.o.distDir, 'preload-app.cjs') } })
    app.setBackgroundColor('#FFFFFF')
    this.app = app
    const failedNavigation = (url: string) => {
      if (this.app !== app || !this.team) return
      // the office address stopped answering (left the office, Wi-Fi changed): straight to the team address
      if (this.directOrigin && originOf(url) === this.directOrigin) {
        let path = '/'
        try {
          const u = new URL(url)
          path = u.pathname + u.search + u.hash
        } catch {
          path = '/'
        }
        this.directOrigin = null
        void this.loadOrigin(this.team.origin, path)
        return
      }
      this.mode = 'offline'
      this.layout()
      this.sendWelcome()
      this.shell.webContents.focus()
    }
    let navigationFailed = false
    app.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3: aborted (a new navigation replaced it)
      debug('team page failed to load', code, url)
      navigationFailed = true
      failedNavigation(url)
    })
    let navigation = 0
    app.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        navigation++
        navigationFailed = false
      }
    })
    app.webContents.on('did-finish-load', async () => {
      // Chromium also finishes its error document after did-fail-load, while getURL() can still
      // report the team URL. That completion must not detach recovery and reveal the blank error page.
      if (this.app !== app || navigationFailed) return
      const loaded = navigation
      const url = app.webContents.getURL()
      // A service-worker navigation fallback loads successfully (HTTP 503), so did-fail-load never runs.
      // Only our explicit document marker opens native recovery; ordinary application/server errors stay visible.
      const offline = await app.webContents.executeJavaScript(
        `document.querySelector('meta[name="mycel-offline"]')?.content === 'navigation-v1'`,
      ).catch(() => false)
      if (this.app !== app || app.webContents.isDestroyed() || navigation !== loaded || navigationFailed) return
      if (offline === true) { failedNavigation(url); return }
      if (this.mode === 'offline' && originOf(app.webContents.getURL())) this.mode = 'team'
      this.layout()
      // A request started before navigation may still carry the signed-out/previous session.
      void this.ensureBrowserOwner()
      void this.measureClock()
    })
    app.webContents.on('render-process-gone', (_e, d) => {
      debug('team page renderer gone', d.reason)
      if (this.app === app) void this.reload()
    })
    app.webContents.on('page-title-updated', () => this.updateTitle())
    // the team page is one app: signing in or out changes the route without a new page load
    app.webContents.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
      if (isMainFrame && this.app === app) void this.ensureBrowserOwner()
    })

    const browserSes = session.fromPartition(partitionFor(id, 'browser'))
    this.pane = new BrowserPane(
      {
        win: this.win,
        chrome: this.chrome,
        onOpenChange: () => this.layout(),
        onState: (s) => this.sendPaneState(s),
        onPrompts: (p) => this.send(this.chrome, 'ui:pane-prompts', p),
        onActivity: (a) => this.send(this.chrome, 'ui:pane-activity', a),
        onSavePermissions: (p) => {
          this.o.store.savePermissions(id, p)
          // the pane's ⚙ panel and the team page's Settings > Browser show the same value: both hear every change
          if (this.pane) this.sendSiteSettings(this.pane.siteSettings())
        },
        teamHosts: () => teamHostnames(this.teams.teams),
      },
      browserSes,
      this.o.pageScript,
      this.o.store.loadPermissions(id),
      // the pane resolves names through its own session: the same resolver and cache Chromium connects with
      this.o.classifier.withResolver(sessionResolver(browserSes)),
    )
    this.send(this.chrome, 'ui:pane-prompts', [])
    // this team's settings and a fresh activity log in the toolbar
    this.sendSiteSettings(this.pane.siteSettings())
    this.send(this.chrome, 'ui:pane-activity-reset', null)
    this.sendPaneState(this.pane.state())

    this.mode = 'team'
    this.layout()
    // CDP (subframe script) needs a renderer: start blank, install the guards, then load the team
    await app.webContents.loadURL('about:blank').catch(() => {})
    await guardAppView(app.webContents, () => this.allowedOrigins())
    if (this.app !== app) return
    if (this.o.answerFileChoosers) await this.answerFileChoosers(app)
    if (this.app !== app) return
    // office network first when it answers with the pinned certificate within 1 s
    const origin = await this.pickOrigin()
    if (this.app !== app) return
    await this.loadOrigin(origin, '/')
    this.scheduleRecheck()
    void this.learnDirect()
  }

  async reload() {
    if (!this.team) return
    const id = this.team.id
    this.team = undefined
    await this.openTeam(id)
  }

  retry() {
    void this.reload()
  }

  /**
   * Upload / Attach in the Mac App Store (sandboxed) build: there the team page's <input type=file> opened no chooser
   * at all in a smoke test (Electron 44.7.2). The cause is not confirmed: outside the sandbox Electron opens its own
   * dialog for a page in a WebContentsView (electron/electron#42013, fixed in Electron 30), so the direct-download Mac
   * app and Windows keep it. In the store build the chooser is intercepted over the debugger guardAppView attached, the
   * app's own open dialog asks (one at a time; several files, a folder or the accept filter as the input says,
   * common/file-chooser.ts), and the picked files are set on the input. Only the top frame of the team page at the team
   * address or its office address is answered, as for the bridge (common/trust.ts); an artifact or a preview frame
   * gets nothing. The setting belongs to this debugger session: the renderer's DevTools page agent holds it and gets it
   * back when the view changes renderer (team address <-> office address); a team switch makes a new view and sets it
   * again.
   */
  private async answerFileChoosers(app: WebContentsView) {
    const dbg = app.webContents.debugger
    if (!dbg.isAttached()) return
    // main-frame documents so far: files picked for one document are not set on the next one (events come in order)
    let documents = 0
    dbg.on('message', (_e, method, params: any, sessionId?: string) => {
      // the page's own session only (frames attached through auto-attach have a sessionId)
      if (sessionId) return
      if (method === 'Page.frameNavigated' && !params?.frame?.parentId) documents++
      if (method !== 'Page.fileChooserOpened' || typeof params?.backendNodeId !== 'number') return
      const opened = documents
      void this.chooseFiles(app, String(params.frameId), params.backendNodeId, params.mode === 'selectMultiple', () => documents === opened)
    })
    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {})
  }

  private async chooseFiles(app: WebContentsView, frameId: string, backendNodeId: number, multiple: boolean, sameDocument: () => boolean) {
    if (this.choosingFiles || this.app !== app || this.win.isDestroyed()) return
    const dbg = app.webContents.debugger
    this.choosingFiles = true
    try {
      const { frameTree } = await dbg.sendCommand('Page.getFrameTree')
      const top = frameTree.frame as { id: string; url: string }
      if (top.id !== frameId || !isTrustedAppSender({ url: top.url, isTop: true, isAppView: this.app === app }, this.allowedOrigins())) return
      const { node } = await dbg.sendCommand('DOM.describeNode', { backendNodeId })
      const r = await dialog.showOpenDialog(this.win, openDialogChoice({ multiple, attributes: node?.attributes }))
      // cancelled: the input keeps what it had
      if (r.canceled || !r.filePaths.length || this.app !== app) return
      // the page loaded again meanwhile (a recheck moved it to the office address, a reload): backendNodeId now points
      // at nothing, or at another node
      if (!sameDocument()) return debug('file chooser: the page changed while the dialog was open, nothing set')
      await dbg.sendCommand('DOM.setFileInputFiles', { backendNodeId, files: r.filePaths })
    } catch (e) {
      debug('file chooser', e instanceof Error ? e.message : String(e)) // the view closed or navigated meanwhile
    } finally {
      this.choosingFiles = false
    }
  }

  private disposeTeam() {
    clearInterval(this.recheckTimer)
    this.pane?.dispose()
    this.pane = undefined
    if (this.app) {
      const wc = this.app.webContents
      if (!this.win.isDestroyed() && this.win.contentView.children.includes(this.app)) this.win.contentView.removeChildView(this.app)
      if (!wc.isDestroyed()) wc.close()
      this.app = undefined
    }
    this.currentOrigin = ''
  }

  private configureAppSession(ses: Session) {
    if (this.configuredSessions.has(ses)) return
    this.configuredSessions.add(ses)
    hardenAppSession(ses, () => this.allowedOrigins())
    pinCertificates(
      ses,
      () => (this.team ? this.team.direct : null),
      (host) => this.onFingerprintMismatch(host),
    )
  }

  /** Origins the bridge and navigation accept: the team address and, when in use, its pinned LAN address. */
  allowedOrigins(): string[] {
    if (!this.team) return []
    return this.directOrigin ? [this.team.origin, this.directOrigin] : [this.team.origin]
  }

  /** Call deadlines are server time: learn how far this computer's clock is off (from /api/health time). */
  private async measureClock() {
    const app = this.app
    if (!app || !this.pane || !this.currentOrigin) return
    try {
      const t0 = Date.now()
      const res = await app.webContents.session.fetch(`${this.currentOrigin}/api/health`, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
      const t1 = Date.now()
      const h = Health.safeParse(await res.json())
      const server = h.success ? Date.parse(h.data.time) : NaN
      if (!Number.isFinite(server) || this.app !== app) return
      const offset = server - (t0 + t1) / 2
      // a second or two is network noise; past that the clocks really differ
      this.pane?.setClockOffset(Math.abs(offset) < 2000 ? 0 : offset)
      debug('clock offset', Math.round(offset))
    } catch {
      // keep the previous offset
    }
  }

  /**
   * GET /api/me with the team page's own session (the authenticated path this app already reads the team name from):
   * the team's name, and its browser policy (Admin > Team settings "members can turn on 'Allow all websites'"), which
   * the pane enforces here in the main process: off refuses "all" and turns a saved "all" back to "ask". Read when the
   * team page loads, every RECHECK_MS, when the team page reads Settings > Browser, and right before the "Allow all
   * websites" dialog. One request at a time. Signed out, offline or an older server (no field): the last policy stays.
   */
  refreshTeamInfo(): Promise<boolean> {
    // a read still running for the team that was open before does not count for this one
    if (!this.teamInfo || this.teamInfo.pane !== this.pane) {
      this.teamInfoAt = Date.now()
      const p: Promise<boolean> = this.fetchTeamInfo().finally(() => {
        if (this.teamInfo?.p === p) this.teamInfo = undefined
      })
      this.teamInfo = { p, pane: this.pane }
    }
    return this.teamInfo.p
  }

  private async fetchTeamInfo() {
    const team = this.team
    const pane = this.pane
    if (!team || !this.app || !this.currentOrigin) return false
    try {
      const res = await this.app.webContents.session.fetch(`${this.currentOrigin}/api/me`, { signal: AbortSignal.timeout(5000) })
      if (res.status === 401) {
        if (this.team?.id === team.id) await this.checkBrowserOwner(team.id, pane, { signedIn: false })
        return false
      }
      if (!res.ok) return false
      const me = Me.safeParse(await res.json())
      if (!me.success || this.team?.id !== team.id || this.pane !== pane) return false
      await this.checkBrowserOwner(team.id, pane, { signedIn: true, userId: me.data.user.id })
      const allowAll = me.data.team.browserAllowAll
      if (typeof allowAll === 'boolean' && pane && this.pane === pane) pane.setTeamPolicy(allowAll)
      if (me.data.team.name && me.data.team.name !== team.label) {
        this.saveTeams(updateTeam(this.teams, team.id, { label: me.data.team.name.slice(0, 200) }))
        this.team = findTeam(this.teams, team.id)
        this.updateTitle()
      }
      return true
    } catch {
      // Keep the label offline, but a browser call must not use an unverified identity.
      return false
    }
  }

  /**
   * The in-app browser's data belongs to one person (common/browser-owner.ts): when someone else signs in to this
   * team, or the person signs out, clear the pane before anyone uses it.
   */
  private async checkBrowserOwner(teamId: string, pane: BrowserPane | undefined, me: MeResult) {
    const change = browserOwnerChange(this.o.store.loadBrowserOwner(teamId), me)
    if (change.clear) {
      debug('in-app browser: another person or signed out, clearing', teamId)
      if (pane && this.pane === pane) {
        await pane.resetForNewPerson()
        this.send(this.chrome, 'ui:pane-prompts', [])
        this.send(this.chrome, 'ui:pane-activity-reset', null)
        this.sendSiteSettings(pane.siteSettings())
        this.sendPaneState(pane.state())
      } else {
        // the pane is not open for this team: clear its stored data directly
        const ses = session.fromPartition(partitionFor(teamId, 'browser'))
        await Promise.all([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()])
        const saved = new SitePermissions(this.o.store.loadPermissions(teamId))
        if (saved.resetForNewPerson()) this.o.store.savePermissions(teamId, saved.toJSON())
      }
    }
    if (change.clear || this.o.store.loadBrowserOwner(teamId) !== change.owner) this.o.store.saveBrowserOwner(teamId, change.owner)
  }

  /** A fresh identity check after navigation and for every AI browser call, including a session switch.
   * A read that began earlier may carry the old session, so finish it before starting this one. */
  async ensureBrowserOwner(): Promise<boolean> {
    if (this.teamInfo) await this.teamInfo.p
    return this.refreshTeamInfo()
  }

  // ------------------------------------------------------------- connection

  private async pickOrigin(): Promise<string> {
    const d = this.team?.direct
    if (!d) return this.team!.origin
    const r = await probeDirect(d)
    void this.reportLan(r.result, d)
    if (r.result === 'ok' && r.origin) {
      this.directOrigin = r.origin
      return r.origin
    }
    if (r.result === 'mismatch') this.onFingerprintMismatch(d.hosts[0])
    return this.team!.origin
  }

  private async loadOrigin(origin: string, path: string) {
    if (!this.app || !this.team) return
    const prev = this.currentOrigin
    if (prev && prev !== origin) await mirrorSessionCookie(this.app.webContents.session, prev, origin).catch(() => false)
    else if (origin !== this.team.origin) await mirrorSessionCookie(this.app.webContents.session, this.team.origin, origin).catch(() => false)
    this.currentOrigin = origin
    this.updateTitle()
    this.sendConnection()
    await this.app.webContents.loadURL(origin + path).catch(() => {})
  }

  connection(): DesktopConnection | null {
    if (!this.team) return null
    return {
      route: this.directOrigin && this.currentOrigin === this.directOrigin ? 'direct' : 'remote',
      origin: this.currentOrigin,
      teamAddress: this.team.origin,
      fingerprintMismatch: this.fingerprintMismatch,
    }
  }

  private sendConnection() {
    const c = this.connection()
    if (c && this.app) this.send(this.app, 'bridge:connection', c)
  }

  /** Ask the team address for the LAN details and remember them (pinned for the next checks). */
  private async learnDirect() {
    const team = this.team
    if (!team || !this.app) return
    const ci = await fetchConnectInfo(this.app.webContents.session, team.origin)
    debug('connect-info', ci ? `${ci.lanHosts.join(',')}:${ci.lanPort}` : 'none')
    if (!ci || this.team?.id !== team.id) return
    const d = directFromConnectInfo(ci, new Date().toISOString())
    const before = team.direct
    if (JSON.stringify(stripTime(before)) === JSON.stringify(stripTime(d))) return
    if (before && d && before.fingerprint !== d.fingerprint) this.fingerprintMismatch = false // the server announced a new certificate
    this.saveTeams(updateTeam(this.teams, team.id, { direct: d }))
    this.team = findTeam(this.teams, team.id)
    await this.recheck(true)
  }

  private scheduleRecheck() {
    clearInterval(this.recheckTimer)
    this.recheckTimer = setInterval(() => {
      void this.recheck(true)
      void this.refreshTeamInfo()
    }, RECHECK_MS)
  }

  // ------------------------------------------------- Settings > Browser (team page)

  /** What Settings > Browser shows; also re-reads the team's policy now and then (a change arrives as an event). */
  browserSettings(): SiteSettings | null {
    if (!this.pane) return null
    if (Date.now() - this.teamInfoAt > POLICY_READ_MS) void this.refreshTeamInfo()
    return this.pane.siteSettings()
  }

  /**
   * The team page asked to turn on "Allow all websites". The page can only ask: the app shows its own dialog (not
   * drawn by any web page) and only the person's click on "Allow all websites" there changes the setting. One dialog
   * at a time, none right after another one closed, and the team's policy is read from the team server first.
   */
  async requestAllowAll(): Promise<AllowAllOutcome> {
    const pane = this.pane
    if (!pane || !this.team || this.mode !== 'team' || this.win.isDestroyed()) return 'unavailable'
    if (this.allowAllOpen || Date.now() < this.allowAllUntil) return 'busy'
    this.allowAllOpen = true
    let shown = false
    try {
      await this.refreshTeamInfo()
      if (this.pane !== pane) return 'unavailable'
      const before = pane.siteSettings()
      if (!before.teamAllowsAll) return 'not-allowed'
      if (before.siteAccess === 'all') return 'unchanged'
      const L = this.o.locale()
      shown = true
      const r = await dialog.showMessageBox(this.win, {
        type: 'warning',
        title: t(L, 'allowAll.title'),
        message: t(L, 'allowAll.message', { team: this.team.label }),
        detail: t(L, 'allowAll.detail'),
        buttons: [t(L, 'allowAll.cancel'), t(L, 'allowAll.confirm')],
        // Enter / Escape / closing the dialog keep asking
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (r.response !== 1 || this.pane !== pane || this.win.isDestroyed()) return 'cancelled'
      return pane.setSiteAccess('all') ? 'changed' : 'not-allowed'
    } finally {
      this.allowAllOpen = false
      if (shown) this.allowAllUntil = Date.now() + ALLOW_ALL_COOLDOWN_MS
    }
  }

  private sendSiteSettings(s: SiteSettings) {
    this.send(this.chrome, 'ui:pane-sites', s)
    this.send(this.app, 'bridge:browser-settings', s)
  }

  /** Network may have changed: switch to the office address when it answers, back to the team address when not. */
  async recheck(force: boolean) {
    if (!this.team || !this.app || this.mode !== 'team') return
    if (!force && Date.now() - this.lastCheck < 30_000) return
    this.lastCheck = Date.now()
    const d = this.team.direct
    const onDirect = this.directOrigin !== null && this.currentOrigin === this.directOrigin
    if (!d || this.fingerprintMismatch) {
      if (onDirect) await this.switchTo(this.team.origin, null)
      return
    }
    const r = await probeDirect(d)
    debug('direct probe', r.result, r.origin ?? '')
    void this.reportLan(r.result, d)
    if (r.result === 'mismatch') return this.onFingerprintMismatch(d.hosts[0]) // also leaves the direct address
    if (r.result === 'ok' && r.origin && !onDirect) await this.switchTo(r.origin, r.origin)
    else if (r.result !== 'ok' && onDirect) await this.switchTo(this.team.origin, null)
  }

  private async switchTo(origin: string, direct: string | null) {
    if (!this.app) return
    let path = '/'
    try {
      const u = new URL(this.app.webContents.getURL())
      path = u.pathname + u.search + u.hash
    } catch {
      path = '/'
    }
    if (direct) this.directOrigin = direct
    await this.loadOrigin(origin, path)
    if (!direct) this.directOrigin = null
    this.sendConnection()
  }

  /**
   * Report a failed office connection to the team server through the team address (design tab 4 / 6: Diagnostics
   * shows "office direct connection failed"), only when the server Mac's Bonjour name answers on this network
   * (otherwise the person is simply not in the office, and a different certificate there is another device).
   */
  private async reportLan(result: ProbeResult, d: DirectInfo) {
    const team = this.team
    if (!team || !this.app) return
    const key = `${team.id}:${lanFailureCode(result)}`
    if (!lanFailureCode(result) || Date.now() - (this.lanReported.get(key) ?? 0) < 3600_000) return
    const code = await lanFailureToReport(result, d.hosts)
    if (!code) return
    this.lanReported.set(key, Date.now())
    const ok = await reportLanFailure(this.app.webContents.session, team.origin, code)
    debug('lan failure report', code, ok ? 'sent' : 'not sent')
  }

  private onFingerprintMismatch(_host: string) {
    if (this.fingerprintMismatch) return
    this.fingerprintMismatch = true
    const L = this.o.locale()
    if (Notification.isSupported()) new Notification({ title: t(L, 'cert.changed.title'), body: t(L, 'cert.changed.body') }).show()
    this.sendConnection()
    if (this.directOrigin && this.currentOrigin === this.directOrigin && this.team) void this.switchTo(this.team.origin, null)
  }

  // ----------------------------------------------------------------- layout

  setPaneFromScreenX(screenX: number) {
    const b = this.win.getContentBounds()
    const w = b.width
    const pw = clamp(b.x + w - screenX, MIN_PANE, Math.max(MIN_PANE, w - MIN_APP))
    this.paneFraction = clamp(pw / w, 0.15, 0.85)
    this.layout()
  }

  layout() {
    if (this.win.isDestroyed()) return
    const [w, h] = this.win.getContentSize()
    const views = this.win.contentView
    const show = (v: WebContentsView, rect: Electron.Rectangle) => {
      if (!views.children.includes(v)) views.addChildView(v)
      v.setBounds(rect)
    }
    const hide = (v?: WebContentsView) => {
      if (v && views.children.includes(v)) views.removeChildView(v)
    }
    if (this.mode !== 'team' || !this.app) {
      hide(this.app)
      this.pane?.setBounds(null)
      show(this.shell, { x: 0, y: 0, width: w, height: h })
      return
    }
    hide(this.shell)
    const paneOpen = Boolean(this.pane?.open)
    let pw = 0
    if (paneOpen) pw = w < MIN_PANE + MIN_APP ? w : clamp(Math.round(w * this.paneFraction), MIN_PANE, w - MIN_APP)
    show(this.app, { x: 0, y: 0, width: Math.max(0, w - pw), height: h })
    this.pane?.setBounds(paneOpen ? { x: w - pw, y: 0, width: pw, height: h } : null)
  }

  private updateTitle() {
    if (this.win.isDestroyed()) return
    if (!this.team) return this.win.setTitle(PRODUCT.displayName)
    const c = this.connection()
    const route = c?.route === 'direct' ? ` · ${t(this.o.locale(), 'conn.direct')}` : ''
    this.win.setTitle(`${this.team.label} — ${PRODUCT.displayName}${route}`)
  }

  /** The language changed: the welcome screen and the pane toolbar redraw with the new strings (no reload, so a
   * typed address or an open site prompt stays), and the window title follows. */
  localeChanged(payload: { locale: UiLocale; strings: Record<UiKey, string> }) {
    this.send(this.shell, 'ui:locale', payload)
    this.send(this.chrome, 'ui:locale', payload)
    this.updateTitle()
  }

  // ----------------------------------------------------------- messaging

  private send(v: WebContentsView | undefined, channel: string, payload: unknown) {
    if (v && !v.webContents.isDestroyed()) v.webContents.send(channel, payload)
  }

  private sendPaneState(s: DesktopPaneState) {
    this.send(this.chrome, 'ui:pane-state', s)
    this.send(this.app, 'bridge:pane-state', s)
    this.layout()
  }

  notify(n: { title: string; body: string }) {
    if (this.win.isDestroyed() || this.win.isFocused() || !Notification.isSupported()) return
    const now = Date.now()
    this.notifyTimes = this.notifyTimes.filter((x) => x > now - 60_000)
    if (this.notifyTimes.length >= 10) return
    this.notifyTimes.push(now)
    const note = new Notification({ title: n.title.slice(0, 200), body: n.body.slice(0, 1000) })
    note.on('click', () => {
      this.win.show()
      this.win.focus()
    })
    note.show()
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function stripTime(d: DirectInfo | null | undefined) {
  return d ? { ...d, checkedAt: '' } : null
}

export type { PaneActivity, PanePrompt }
