// The app window: the desktop's own welcome / team list screen, or a team's page with the browser pane beside it.
//
//   ┌──────────────── BaseWindow ─────────────────┐
//   │ app view (team page, team partition)  │pane │  pane = toolbar UI (pane.html) + the active tab view
//   │                                       │     │
//   └───────────────────────────────────────┴─────┘
//   shell view (welcome.html) covers everything when no team is open, the team list is shown, or the team
//   server cannot be reached.
import { app as electronApp, BaseWindow, dialog, nativeTheme, net, Notification, powerMonitor, session, WebContentsView, type Session } from 'electron'
import { COMPUTER_REPORT_PATH, ComputerReporter, readSystemActivity, SYSTEM_ACTIVITY_EVERY_MS, type SystemActivity } from '../common/system-activity'
import { join } from 'node:path'
import { applyMePolicy } from '../common/me-policy'
import { PRODUCT, WEB_ALLOW_ALL_RISK, type DesktopConnection, type DesktopPaneState } from '@mycel/shared'
import { API, CSRF_HEADER, GOOGLE_APP_RETURN_PATH, Health, Me } from '@mycel/shared/api'
import { answersAgain, asksOutside, certTrouble, checkTeam, desktopPagePath, firstRunLinks, googleSignInCode, hostLineNow, hostOf, isShownTeamStart, isSignInPath, signInCode, officeCertPage, offlineRetryDelay, onThisComputer, originOf, parseTeamAddress, readDesktopLink, retypablePath, startupLinkTarget, teamLabel, type AddressError, type CertTrouble, type HealthAnswer } from '../common/address'
import { LinkGate, type WakeAnswer } from '@mycel/shared/team-link'
import { t, type UiKey, type UiLocale } from '../common/i18n'
import { teamHostnames } from '../common/browser-block'
import { SitePermissions, type SiteSettings } from '../common/site-permissions'
import { browserOwnerChange, type MeResult } from '../common/browser-owner'
import { addTeam, findTeam, partitionFor, removeTeam, sortedTeams, touchTeam, updateTeam, type DirectInfo, type TeamEntry, type TeamsFile } from '../common/teams'
import { isTrustedAppSender, UI_ORIGIN } from '../common/trust'
import { askConsent, consentMemoryFile } from './work-consent-window'
import { openDialogChoice } from '../common/file-chooser'
import { makeNotifier, platformNotifyDeps, type NotifyInput } from '../common/notify'
import { directFromConnectInfo, fetchConnectInfo, lanFailureCode, lanFailureToReport, mirrorSessionCookie, pinCertificates, probeDirect, reportLanFailure, type ProbeResult } from './direct'
import { BrowserPane, type PaneActivity, type PanePrompt } from './pane/pane'
import { HostClassifier, sessionResolver } from './pane/classify'
import { APP_WEB_PREFERENCES, guardAppView, guardUiView, hardenAppSession } from './security'
import { attachContextMenu, contextMenuOpen } from './context-menu'
import { keyboardBack, keyboardTaken, keyboardTarget } from '../common/keyboard-focus'
import { CHROME_RELOAD_DELAY_MS, CHROME_RELOAD_WINDOW_MS, CHROME_RELOADS, chromeRecovery } from '../common/pane-chrome'
import { paneFromEdge, paneGrab, paneKeyWidth, paneLimits, paneWidthFor, readPaneFraction, settlePane } from '../common/pane-width'
import type { FolderGrants } from '../common/folder-access'
import { WorkFilesController } from './work-files'
import type { TeamsStore } from './teams-store'
import { clearFailed, clearSessionData, type ClearResult } from './clear-session'
import { debug } from './debug'
import { deliverSignInCode } from '../common/sign-in-handoff'
import { handoffLog } from './handoff-log'
import { DirectDownloads } from './downloads'
import { PAGE_BUSY_GLOBAL, resumePage, type Resume, type ResumeWindow } from '../common/update-guard'
import { findTarget } from '../common/find-bar'
import { FindBar } from './find-bar'

export type Mode = 'welcome' | 'team' | 'offline'

export interface WelcomeState {
  mode: Mode
  teams: { id: string; label: string; origin: string; current: boolean }[]
  /** a team is open behind the welcome screen (the back button returns to it) */
  canGoBack: boolean
  /** `auto`: the app looks again by itself and opens the team when it answers (watchOffline) */
  offline: { address: string; auto: boolean } | null
  /** a kit build's team address, filled in on the first-run screen while no team is remembered (common/kit.ts) */
  suggested: string | null
  /** the "no team yet" screen offers [팀 만들기] (not in the Mac App Store build: App Review 3.1.1) */
  signup: boolean
  /** screen ④: a link from outside waits for the person's yes (the host it would connect to; hosted: run by the hosted
   * service). Nothing is fetched before the yes. */
  link: { id: number; host: string; hosted: boolean } | null
  /** a link from outside that cannot open a team: said once on ① */
  linkError: string | null
  /** the team being added is a sleeping free trial that is starting (about a minute): the screen says so with a
   * spinner and the add goes on by itself when it answers (QA wake gap 1) */
  waking: boolean
}

/** What adding a team from the first-run screen came to. `confirmOutside`: the address answered but is not run by the
 * hosted service and not remembered yet: the screen asks once, then calls again with `confirmed`. */
export type AddTeamResult =
  | { ok: true; teamId: string }
  | { ok: false; error: AddressError | 'unreachable' | 'certUntrusted' | 'certInvalid' | 'notTeamServer' | 'teamUnknown' | 'suspended' | 'wakeTimeout' | 'confirmOutside' | 'renamed' | 'cancelled'; message: string; host?: string; next?: string }

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
  /** the app restarted by itself to install an update: the window as it was then, without taking the focus */
  quietStart?: ResumeWindow
  appVersion: string
  classifier: HostClassifier
  /** a kit build's team address (common/kit.ts), or null */
  suggestedTeam?: string | null
  /** the app answers the team page's file input with its own dialog (common/file-chooser.ts answersFileChoosers) */
  answerFileChoosers?: boolean
  /** the Mac App Store build: no signup link on the first-run screen (common/address.ts firstRunLinks) */
  macAppStore?: boolean
  /** the computer's Downloads folder, where the team page's downloads go with no save window (main/downloads.ts);
   * null keeps the save window (the Mac App Store build) */
  downloadsDir?: () => string | null
  /** the team list changed (the menu is rebuilt) */
  onTeamsChanged(): void
}

/** the host strip above the team's sign-in pages (hostbar.html) */
const HOSTBAR_HEIGHT = 36
/** how long the strip waits for /api/me after a team page loaded before it takes space anyway */
const HOSTBAR_WAIT_MS = 300
const RECHECK_MS = 60_000
/** a settings read from the team page re-reads the team's policy at most this often */
const POLICY_READ_MS = 5_000
/** after the "Allow all websites" dialog closes, another request is refused this long (no dialog right under a click) */
const ALLOW_ALL_COOLDOWN_MS = 2_000


export class AppWindow {
  readonly win: BaseWindow
  readonly shell: WebContentsView
  readonly chrome: WebContentsView
  /** the team address above the team's sign-in pages, drawn by the app (hostbar.html): a page cannot fake it */
  readonly hostbar: WebContentsView
  /** Cmd/Ctrl+F: the find bar over the view it searches (main/find-bar.ts) */
  readonly findBar: FindBar
  app?: WebContentsView
  pane?: BrowserPane
  team?: TeamEntry
  mode: Mode = 'welcome'
  private teams: TeamsFile
  /** the in-app browser's share of the window's width (common/pane-width.ts); null: the default */
  private paneFraction: number | null
  /** what the browser toolbar's edge was last told (its aria values and grab strip) */
  private paneWidthTold = ''
  /** a drag of the browser's edge: where the keyboard was before the press that started it (keysAfterDrag) */
  private drag?: { press?: ToolbarPress }
  /** the keyboard before the browser toolbar's view took it, and when (a press there takes it first: watchKeys) */
  private beforeToolbarFocus?: { keys?: { view: WebContentsView; inPane: boolean }; at: number }
  /** the keyboard and personInPane just before the latest mouse press in the browser toolbar's view */
  private toolbarPress?: ToolbarPress
  /** window.json is written a moment after the edge's keys stop */
  private saveTimer?: NodeJS.Timeout
  /** origin the app view shows: the team address or its direct LAN address */
  private currentOrigin = ''
  private directOrigin: string | null = null
  private fingerprintMismatch = false
  private recheckTimer?: NodeJS.Timeout
  private lastCheck = 0
  private configuredSessions = new WeakSet<Session>()
  /** the team page's downloads: straight into Downloads, the page shows the notice (main/downloads.ts) */
  readonly downloads = new DirectDownloads({ dir: () => this.o.downloadsDir?.() ?? null })
  /** each team page session's folder window picks (common/folder-access.ts), forgotten when the person changes */
  private folderGrants = new WeakMap<Session, FolderGrants>()
  /** "Find work files on this computer" (./work-files.ts): the app's own consent dialog, the look, the reads by id */
  readonly workFiles = new WorkFilesController({
    win: () => (this.win.isDestroyed() ? null : this.win),
    locale: () => this.o.locale(),
    progress: (p) => this.send(this.app, 'bridge:work-files-progress', p),
    consent: (parent, view) => askConsent({ parent, preload: join(this.o.distDir, 'preload-consent.cjs'), view }),
    lastInput: () => this.appInputAt,
    assistive: () => electronApp.accessibilitySupportEnabled,
    memory: consentMemoryFile(join(electronApp.getPath('userData'), 'work-files-consent.json')),
    reading: (n) => {
      if (n === this.reading) return
      this.reading = n
      this.layout()
      this.sendHostbar()
    },
  })
  /** when the person last pressed a key or the mouse on the team page (Electron's input events: no page script makes
   * them); Find work files reads it (WorkFilesController.add, a remembered yes) */
  private appInputAt = 0
  /** files added by Find work files and still being read: the strip above the page says so while there are any */
  private reading = 0
  /** system notifications for the team page (common/notify.ts): unfocused only, one per tag, a click opens its
   * address; a team switch closes them all */
  private notifier = makeNotifier({
    create: (n) => new Notification(n),
    supported: () => Notification.isSupported(),
    focused: () => this.win.isDestroyed() || this.win.isFocused(),
    reveal: () => {
      if (this.win.isDestroyed()) return
      // the notification opens something in the team page: the keyboard goes there, also if the person left the window
      // from the in-app browser
      if (this.app) this.keysWanted = this.app
      this.win.show()
      this.win.focus()
      // the window had the focus already: no focus event comes
      if (this.keysWanted && this.keysReady()) this.keysBack()
    },
    open: (path) => this.send(this.app, 'bridge:open', path),
    // "Mark as read" on a room notification: macOS only (Electron's buttons); the page calls the read API
    markReadLabel: () => process.platform === 'darwin' ? t(this.o.locale(), 'notify.markRead') : null,
    read: (token) => this.send(this.app, 'bridge:read', token),
    // macOS asks about notifications once, when Electron first touches them: touching them is the question, while the
    // window is in front (common/notify.ts ask); and it takes a notification it will not show (off, or not answered yet)
    ...platformNotifyDeps(process.platform, () => Notification.isSupported()),
  })
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
  /** the path of the team page on screen ('' before it loads): its sign-in pages get the host strip */
  private pagePath = ''
  /** the team answered GET /api/me for a signed-in person (fetchTeamInfo); until then the host strip is on, on every
   * page (a page can look like a sign-in page at any address) */
  private signedIn = false
  /** the browser toolbar's page is not drawn (still loading, failed, or its renderer ended): the browser is not shown
   * (a page with no toolbar above it has no ✕), and the toolbar loads again (common/pane-chrome.ts) */
  private chromeDown = true
  private chromeFailures: number[] = []
  private chromeRetry?: ReturnType<typeof setTimeout>
  /** the toolbar's current document: loaded, failed, and which one (a check that answers late is for an older one) */
  private chromeLoaded = false
  private chromeLoadFailed = false
  private chromeNav = 0
  /** the computer's own use to the open team's server, while signed in (common/system-activity.ts ComputerReporter) */
  private readonly computerReporter = new ComputerReporter({
    team: () => (this.app && this.team && this.currentOrigin ? { origin: this.currentOrigin, signedIn: this.signedIn } : null),
    post: async (origin, body) => {
      const app = this.app
      if (!app || app.webContents.isDestroyed()) return 0
      const res = await app.webContents.session.fetch(origin + COMPUTER_REPORT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
      return res.status
    },
    signedOut: () => { void this.refreshTeamInfo() },
  })
  /** this team's pages draw the address and "Switch team" under their sign-in card (DesktopBridge.hostLine): no strip
   * above them on the sign-in paths. Kept until another team is opened, so a sign-out or reload does not jump. */
  private pageHostLine = false
  /** the team openLast opened at start when its address is on this computer (common/address.ts onThisComputer): until
   * its page loads, a failed load goes to the first-run screen with the team list, not to the offline card */
  private startupLocal: string | null = null
  /** /api/me answered for this team page (either way), and the short wait after the page loaded is over: until one of
   * them, a page that is not a sign-in page gets no strip yet, so a signed-in open does not jump (shared hostLineNow) */
  private meAnswered = false
  private stripWaited = false
  private stripTimer?: NodeJS.Timeout
  /** screen ④: the link from outside that waits for a yes (shared/src/team-link.ts LinkGate) */
  private linkGate = new LinkGate()
  private linkError: string | null = null
  /** the "isn't answering" line (offline.localStart) and the team it names: the line goes when that team leaves the list */
  private localStart: { team: string; line: string } | null = null
  /** addTeam is waiting for a sleeping trial team to start (WelcomeState.waking) */
  private waking = false
  /** the "cannot reach the team server" card looks again by itself (watchOffline): its timer, how many looks so far
   * (the waits grow, common/address.ts offlineRetryDelay), and a number that changes whenever the watch stops, so a
   * look still under way does nothing afterwards */
  private offlineTimer?: NodeJS.Timeout
  private offlineTries = 0
  private offlineWatch = 0
  /** the watch is on (a wait or a look under way): the card says the app keeps trying only then */
  private offlineWatching = false
  /** the app itself opened the team again after a look that answered: if that load fails too (the server answers but
   * its page does not load), the looks end there, so the page does not open and fail over and over */
  private offlineReopened = false
  /** that wait, which Cancel stops (cancelWake, or No on ④) */
  private wakeRun: { stopped: boolean } | null = null
  /** the view that had the keyboard last (its own focus event; the pane reports its tabs) and whether it is the in-app
   * browser's: the window gives the keyboard back there (settleKeys) */
  private keys?: { view: WebContentsView; inPane: boolean }
  /** `keys` when the window lost the focus (the system may hand the keyboard to another view before it is back) */
  private keysAtBlur?: { view: WebContentsView; inPane: boolean }
  /** a notification's click asks for the team page when the window is back */
  private keysWanted?: WebContentsView
  /** the person's last key or mouse press (or opening the in-app browser) was in the in-app browser: a page load there
   * may take the keyboard (keyboardTaken) */
  private personInPane = false
  /** the view the app is giving the keyboard to right now (keysTo) */
  private giving?: WebContentsView
  private settleQueued = false

  constructor(private o: AppWindowOptions) {
    this.teams = o.store.load()
    const saved = o.store.loadWindow()
    this.paneFraction = readPaneFraction(saved.paneFraction)
    this.win = new BaseWindow({
      width: clamp(saved.width ?? 1440, 900, 4000),
      height: clamp(saved.height ?? 900, 600, 3000),
      minWidth: 900,
      minHeight: 600,
      title: PRODUCT.displayName,
      backgroundColor: windowBackground(),
      show: false,
    })
    const uiPrefs = { preload: join(o.distDir, 'preload-ui.cjs'), ...APP_WEB_PREFERENCES, partition: 'mycel-ui' }
    this.shell = new WebContentsView({ webPreferences: uiPrefs })
    this.chrome = new WebContentsView({ webPreferences: uiPrefs })
    this.hostbar = new WebContentsView({ webPreferences: uiPrefs })
    for (const v of [this.shell, this.chrome, this.hostbar]) {
      guardUiView(v.webContents)
      // a right-click in the app's own text fields (the invite link box, the browser's address): the edit items
      attachContextMenu(v.webContents, { window: this.win, locale: o.locale, allowedOrigins: () => [] })
      this.watchKeys(v, v === this.chrome)
    }
    this.findBar = new FindBar({
      win: this.win,
      distDir: o.distDir,
      locale: o.locale,
      focusBar: () => this.keysTo(this.findBar.view, 'find bar'),
      focusTarget: (v) => {
        if (this.shownViews().includes(v)) this.keysTo(v, 'find bar closed')
      },
    })
    this.watchKeys(this.findBar.view, false)
    // the browser toolbar's view: transparent where it reaches over the team page's edge (the edge's grab strip,
    // common/pane-width.ts); its page paints the toolbar and the area under it in the theme's own colours
    this.chrome.setBackgroundColor('#00000000')
    // the window's own colour (behind the views before they draw) follows the system's light or dark look
    const themed = () => {
      if (!this.win.isDestroyed()) this.win.setBackgroundColor(windowBackground())
    }
    nativeTheme.on('updated', themed)
    this.win.on('closed', () => nativeTheme.off('updated', themed))
    // the computer's own use for the team page's "in use" (common/system-activity.ts): another app in front or the
    // in-app browser is still the person at the computer; a locked screen is not. Told to the page and, from here (a
    // window in the back is throttled: its page may say nothing for minutes), to the open team's server while signed in
    // (docs/decisions/20261116-away-os-idle.md: no phone push while the computer is in use)
    const tellSystem = (a: SystemActivity | null) => {
      if (a && this.app && !this.win.isDestroyed()) this.send(this.app, 'bridge:system-activity', a)
      void this.computerReporter.report(a)
    }
    const systemActivity = setInterval(() => tellSystem(readSystemActivity(powerMonitor)), SYSTEM_ACTIVITY_EVERY_MS)
    // a lock or an unlock is told at once, not at the next poll (macOS and Windows send these; elsewhere the poll sees it)
    const onLock = () => tellSystem({ locked: true, idleMs: 0 })
    const onUnlock = () => tellSystem(readSystemActivity(powerMonitor) ?? { locked: false, idleMs: 0 })
    powerMonitor.on('lock-screen', onLock)
    powerMonitor.on('unlock-screen', onUnlock)
    // going to sleep without a lock: nobody at it either (the phone must not wait for the report to go stale)
    powerMonitor.on('suspend', onLock)
    powerMonitor.on('resume', onUnlock)
    this.win.on('closed', () => {
      clearInterval(systemActivity)
      powerMonitor.off('lock-screen', onLock)
      powerMonitor.off('unlock-screen', onUnlock)
      powerMonitor.off('suspend', onLock)
      powerMonitor.off('resume', onUnlock)
    })
    void this.shell.webContents.loadURL(`${UI_ORIGIN}/welcome.html`)
    this.loadChrome()
    // a (re)loaded toolbar page knows nothing yet: tell it the edge again, also when the width has not changed since a
    // message it may have missed while loading (else its edge could stay hidden until the width changes). The browser
    // is drawn again only once the toolbar has drawn its ✕ (chromeUp), not when its page merely finished loading.
    this.chrome.webContents.on('did-finish-load', () => {
      // Chromium also finishes the error document after did-fail-load: that is not the toolbar
      if (this.chromeLoadFailed || this.chrome.webContents.getURL() !== `${UI_ORIGIN}/pane.html`) return
      this.chromeLoaded = true
      this.paneWidthTold = ''
      this.sendPaneWidth()
      this.checkChromeDrawn()
    })
    // a new toolbar document committed (a load again, or any other reload of it): the browser waits for it to draw.
    // On commit, not on start: a navigation away from the toolbar that is stopped (security.ts guardUiView, a drop on
    // it) never replaces the document and must not hide the browser
    this.chrome.webContents.on('did-navigate', () => {
      this.chromeNav++
      this.chromeLoadFailed = false
      this.chromeLoaded = false
      if (!this.chromeDown) {
        this.chromeDown = true
        this.tellPageOpen()
        this.layout()
      }
    })
    // the toolbar's page did not load or its renderer ended: load it again (common/pane-chrome.ts)
    this.chrome.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      this.chromeLoadFailed = true
      this.chromeFailed(`load ${code}`)
    })
    this.chrome.webContents.on('render-process-gone', (_e, d) => {
      this.chromeLoaded = false
      if (d.reason !== 'clean-exit') this.chromeFailed(d.reason)
    })
    this.win.on('closed', () => clearTimeout(this.chromeRetry))
    void this.hostbar.webContents.loadURL(`${UI_ORIGIN}/hostbar.html`)
    this.win.on('resize', () => this.layout())
    this.win.on('focus', () => {
      void this.recheck(false)
      // "looked at" for the team page (its session markers, room sound and reading) is this window's focus while the
      // page is shown (the in-app browser or the address strip may hold the keys): teamFocused
      this.sendFocus(true)
      // a team opened while the window was in the back: the system's question now, while the person looks
      if (this.app) this.notifier.ask()
    })
    this.win.on('blur', () => this.sendFocus(false))
    this.win.on('close', () => {
      this.saveWindow()
      // close the views while the window still exists (WebContentsView contents are not closed with it)
      this.disposeTeam()
      for (const v of [this.shell, this.chrome, this.hostbar]) if (!v.webContents.isDestroyed()) v.webContents.close()
      this.findBar.dispose()
      debug('window closed, team disposed')
    })
    // back to the window (Cmd-Tab, the dock, a notification's click): the keyboard goes back where it was
    this.win.on('blur', () => {
      this.keysAtBlur = this.keys
    })
    this.win.on('focus', () => this.keysBack())
    this.layout()
    // after an update restart by itself the window comes back as it was and never takes the focus (quietStart)
    this.shell.webContents.once('did-finish-load', () => {
      const q = this.o.quietStart
      if (!q) return this.win.show()
      this.win.showInactive()
      if (q !== 'shown') this.win.minimize()
    })
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
      offline: this.mode === 'offline' && this.team ? { address: this.team.origin, auto: this.offlineWatching } : null,
      suggested: this.teamList().length ? null : (this.o.suggestedTeam ?? null),
      signup: firstRunLinks({ macAppStore: this.o.macAppStore === true, korean: false }).signup !== null,
      link: (() => { const l = this.linkGate.pending(); return l ? { id: l.id, host: l.host, hosted: l.hosted } : null })(),
      linkError: this.linkError,
      waking: this.waking,
    }
  }

  /** POST a sign-in's one-time code (Drive, a team Drive share, a Google app, an app connection: the server's claim
   * address tries each) to the team on screen with this app's own session (server google-drive/app-return.ts); the
   * server finishes only a flow this session started. The answer is read and a lost one is sent again
   * (common/sign-in-handoff.ts); every step is logged, never the code. Nothing else is sent, nothing is kept. */
  private async claimSignIn(code: string) {
    const app = this.app, origin = this.team?.origin, teamId = this.team?.id
    if (!app || app.webContents.isDestroyed() || !origin) return void handoffLog('sign-in hand-off: no team page to finish it in')
    const ses = app.webContents.session
    await deliverSignInCode({
      origin,
      code,
      log: handoffLog,
      post: async (o, c) => {
        // the team was closed or switched meanwhile: its session is not the one that started the sign-in any more
        if (this.team?.id !== teamId || app.webContents.isDestroyed()) return 409
        const res = await ses.fetch(o + API.claimDriveFlow.path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
          body: JSON.stringify({ code: c }),
          signal: AbortSignal.timeout(10_000),
          // the claim address never redirects: a redirect (a captive portal, a proxy) is not followed with the code,
          // and counts as a refusal (3xx), never as a lost answer to send again
          redirect: 'manual',
        })
        return res.type === 'opaqueredirect' ? 302 : res.status
      },
    })
  }

  /**
   * A link from outside (`trina-ax://open?url=…`, main.ts: open-url, a second instance's or this one's command line):
   * screen ④ asks "{host}에 연결할까요?" first. Nothing is fetched or loaded until the person's yes (answerLink); a
   * link that cannot open a team says so on ①. A chat, room or project page of a team this app already has (the same
   * origin, exactly) opens there at once (common/address.ts desktopPagePath): no new server is connected, so ④ has
   * nothing to ask; the team's own sign-in and access checks still apply to the page.
   */
  offerLink(raw: string) {
    if (this.openLinkedPage(raw)) return
    // a Google sign-in's one-time code for the team on screen (its address, or the office address the window shows): that
    // team's window opens its return page, which redeems it with the secret it kept (web pages/Auth.tsx GoogleReturn).
    // No screen ④: no new team is connected, and only that window's own page sees the code
    const google = this.app ? googleSignInCode(raw, [this.team?.origin, this.currentOrigin]) : null
    if (google) return void this.openGoogleReturn(google)
    const p = readDesktopLink(raw)
    // a Google Drive sign-in's one-time code for the team on screen: this app's own session finishes it (the page's
    // wait then shows the account to confirm); the window comes forward (main.ts onLink)
    // (not only while the page answers: an offline blip is what the claim's next tries are for)
    const code = this.app ? signInCode(raw, this.team?.origin) : null
    if (code) {
      handoffLog(`sign-in hand-off: link for the team on screen (${this.team?.origin}, ${this.mode})`)
      return void this.claimSignIn(code)
    }
    if (raw.includes('#code=')) handoffLog(`sign-in hand-off: link not for the team on screen (${this.team?.origin ?? 'none'}, ${this.app ? this.mode : 'no team page'})`)
    // the team on screen, its start: only the window comes forward (main.ts onLink), the page stays as it is
    if (this.app && this.mode !== 'offline' && isShownTeamStart(raw, this.team?.origin)) return
    if (p?.ok) {
      this.linkGate.put(p)
      this.linkError = null
    } else if (!this.linkGate.pending()) this.linkError = t(this.o.locale(), 'link.bad') // a bad link never covers ④
    this.showWelcome()
  }

  /** ④ is on screen for this offer: the yes counts only some time after this (shared LinkGate) */
  linkShown(id: number) {
    this.linkGate.shown(id, Date.now())
  }

  /** The person's answer on ④ for the host it showed: yes connects (the phase-1 path, the outside question answered by
   * ④ itself); no goes back to the open team, if any. null: nothing to do (no link waiting, too soon, another host). */
  async answerLink(yes: boolean, host: string): Promise<AddTeamResult | null> {
    this.linkError = null
    const offer = this.linkGate.answer(yes, host, Date.now())
    if (!yes) {
      this.cancelWake()
      this.sendWelcome()
      if (this.team && this.app) this.back()
      return null
    }
    if (!offer) return null
    this.sendWelcome()
    // the page goes along as it was read from the link (readDesktopLink): the address alone goes through the box's
    // rules again, which refuse a one-time sign-in link's page (`/app-signin#c=…`)
    return this.addTeam(offer.origin, true, offer.entryPath)
  }

  /**
   * A chat, room or project page inside a link from outside (common/address.ts desktopPagePath), on a team this app
   * already has, by exact origin: opened there at once. true: done; false: the link goes to ④ as any other.
   */
  private openLinkedPage(raw: string): boolean {
    const page = desktopPagePath(raw)
    const known = page ? this.teams.teams.find((x) => x.origin === page.origin) : undefined
    if (!page || !known) return false
    // the team is on screen already: its router opens the page, as a notification's click does (no reload); a room
    // message (`?m=`) loads the address, which the router's open does not take
    if (this.team?.id === known.id && this.app && this.mode !== 'offline' && !page.path.includes('?')) {
      this.linkGate.clear()
      this.linkError = null
      this.send(this.app, 'bridge:open', page.path)
      this.back()
    } else void this.openTeam(known.id, page.path)
    return true
  }

  /** The "no team yet" screen's buttons: the address is chosen here, never taken from the screen. */
  firstRunLink(kind: 'signup' | 'docs'): string | null {
    const links = firstRunLinks({ macAppStore: this.o.macAppStore === true, korean: this.o.locale() === 'ko' })
    return kind === 'signup' ? links.signup : links.docs
  }

  /** Sign in with Google's return (docs/decisions/20261122-google-login-apps.md): the team's window, at the address it
   * shows, loads /login/google with the code in the fragment (its partition gets the cookie; sessionStorage there has the
   * secret). The office address keeps the session as for any sign-in: loadOrigin copies the cookie when the window
   * switches. Logged without the code. */
  private openGoogleReturn(code: string) {
    const app = this.app, origin = this.currentOrigin || this.team?.origin
    if (!app || app.webContents.isDestroyed() || !origin) return void handoffLog('google sign-in: no team page to finish it in')
    handoffLog(`google sign-in: link for the team on screen (${hostOf(origin)}, ${this.mode})`)
    this.linkGate.clear()
    this.linkError = null
    if (this.mode !== 'team') this.back()
    void app.webContents.loadURL(`${origin}${GOOGLE_APP_RETURN_PATH}#code=${code}`).catch(() => {})
  }

  /** The host strip's state: the team address the app connected to (punycode), never the office-network address. */
  hostbarState(): { host: string; reading?: number } | null {
    if (!this.team) return null
    // the strip is the team address on the sign-in pages; else, while Find work files reads added files, that
    return this.hostLine() || !this.reading ? { host: hostOf(this.team.origin) } : { host: hostOf(this.team.origin), reading: this.reading }
  }
  private hostLine() {
    // A sign-in page that draws the address and "Switch team" under its card itself (hostLine) gets no strip: the
    // address once, next to the form (owner 2026-11-15). Off the sign-in paths the strip stays until /api/me answers.
    const pageLine = this.pageHostLine && isSignInPath(this.pagePath)
    return !pageLine && hostLineNow({ path: this.pagePath, signedIn: this.signedIn, answered: this.meAnswered, waited: this.stripWaited })
  }

  private sendWelcome() {
    if (!this.shell.webContents.isDestroyed()) this.shell.webContents.send('ui:welcome-state', this.welcomeState())
  }

  /**
   * Check what was put in the first-run box, remember the team, open it on the link's page (an invite or team link opens
   * its join page in the app). The address answers GET /api/health first; the relay's own answers (an unknown name, a
   * suspended team, a rename) are told apart. The first connect to an address the hosted service does not run asks once
   * (`confirmed` is the person's yes).
   */
  /** Cancel while a sleeping trial team starts (up to 3 minutes): the wait stops and nothing is added. */
  cancelWake() {
    if (this.wakeRun) this.wakeRun.stopped = true
  }

  /** `linkPath`: the page of a link screen ④ confirmed (answerLink), already read by readDesktopLink; else the page of
   * what was typed. */
  async addTeam(address: string, confirmed = false, linkPath?: string): Promise<AddTeamResult> {
    this.linkError = null
    const parsed = parseTeamAddress(address)
    const L = this.o.locale()
    if (!parsed.ok) return { ok: false, error: parsed.error, message: t(L, `err.${parsed.error}` as UiKey) }
    const p = linkPath ? { ...parsed, entryPath: linkPath } : parsed
    const fail = (error: 'unreachable' | 'notTeamServer' | 'teamUnknown' | 'suspended' | 'wakeTimeout'): AddTeamResult => ({ ok: false, error, message: t(L, `err.${error}` as UiKey, { name: p.name ?? p.host }) })
    // the server's certificate is not one this computer trusts (an office server whose certificate is not installed
    // here yet): said as that, with where to get it, never as "check your internet connection" (QA TC-3452). Nothing is
    // connected: the certificate check itself is untouched.
    const failCert = (trouble: CertTrouble): AddTeamResult => {
      const page = trouble === 'untrusted' ? officeCertPage(p.origin) : null
      const key: UiKey = trouble === 'invalid' ? 'err.certInvalid' : page ? 'err.certUntrusted' : 'err.certUntrustedNoPage'
      return { ok: false, error: trouble === 'invalid' ? 'certInvalid' : 'certUntrusted', message: t(L, key, { page: page ?? '' }) }
    }
    let c
    const run = { stopped: false }
    this.wakeRun = run
    try {
      c = await checkTeam(p.origin, {
        health: fetchHealth,
        wake: fetchWake,
        onWaking: () => {
          this.waking = true
          this.sendWelcome()
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
        stopped: () => run.stopped,
      })
    } catch (e) {
      const trouble = certTrouble(e)
      return trouble ? failCert(trouble) : fail('unreachable')
    } finally {
      if (this.wakeRun === run) this.wakeRun = null
      if (this.waking) {
        this.waking = false
        this.sendWelcome()
      }
    }
    // cancelled while the team started: nothing added, nothing said
    if (run.stopped) return { ok: false, error: 'cancelled', message: '' }
    if (!c.ok) return fail(c.error)
    const origin = c.origin
    const known = this.teams.teams.find((x) => x.origin === origin)
    // the person sees the new address before it is remembered
    if (origin !== p.origin && !known) return { ok: false, error: 'renamed', message: t(L, 'err.renamed', { host: hostOf(origin) }), host: hostOf(origin), next: origin + retypablePath(p.entryPath) }
    if (asksOutside({ hosted: p.hosted, dev: p.dev, known: Boolean(known), confirmed })) return { ok: false, error: 'confirmOutside', message: t(L, 'outside.body'), host: hostOf(origin) }
    const r = addTeam(this.teams, origin, teamLabel(origin), this.o.store.newTeamId(), new Date().toISOString())
    if (!r.existed) this.saveTeams(r.file)
    await this.openTeam(r.team.id, p.entryPath)
    return { ok: true, teamId: r.team.id }
  }

  async removeTeam(id: string): Promise<void> {
    const team = findTeam(this.teams, id)
    if (!team) return
    // the "isn't answering" line named this team: it goes with it (QA of #990: it stayed after the last team was removed)
    if (this.localStart?.team === id) {
      // only while that line is still the one shown (a refused link may have replaced it)
      if (this.linkError === this.localStart.line) this.linkError = null
      this.localStart = null
    }
    if (this.team?.id === id) {
      this.disposeTeam()
      this.team = undefined
      this.mode = 'welcome'
      this.layout()
    }
    // the team leaves the list at once (it cannot be opened while its data goes), then everything it left in the app
    // goes: cookies, storage, cache, HTTP logins (both partitions side by side, each clear with a time limit), then its
    // files (allowed sites, the in-app browser's owner ...)
    this.saveTeams(removeTeam(this.teams, id))
    await Promise.all((['app', 'browser'] as const).map((kind) => clearSessionData(session.fromPartition(partitionFor(id, kind)), `team ${id} ${kind}`)))
    this.o.store.removeTeamFiles(id)
  }

  showWelcome() {
    this.stopOfflineWatch()
    this.offlineTries = 0
    this.offlineReopened = false
    this.mode = 'welcome'
    this.layout()
    this.sendWelcome()
    // only in a focused window: on macOS focusing a view brings the window in front of the app the person is in (a
    // window in the back gets it with its focus: keysBack, settleKeys)
    if (this.win.isFocused()) this.shell.webContents.focus()
  }

  back() {
    this.linkGate.clear()
    if (this.team && this.app) {
      this.mode = 'team'
      this.layout()
    }
  }

  /** `resume`: the page the app showed before it restarted by itself to update (./update-launch.ts takeResume) */
  async openLast(resume: Resume['page'] = null, link: string | null = null): Promise<boolean> {
    // a chat link that started the app opens its page at the first load (a message sent to a page still loading is lost)
    const target = startupLinkTarget(link, this.teams.teams)
    if (target) {
      await this.openTeam(target.id, target.path, { startup: true })
      return true
    }
    if (resume && findTeam(this.teams, resume.teamId)) {
      await this.openTeam(resume.teamId, resume.path, { startup: true })
      return false
    }
    const last = findTeam(this.teams, this.teams.lastTeamId) ?? this.teamList()[0]
    if (last) await this.openTeam(last.id, '/', { startup: true })
    else this.showWelcome()
    return false
  }

  /** What an update restart would lose now (DesktopUpdater.idleRestart): whether the team page says a reload would lose
   * something (web/src/lib/reload-guard.ts; null when it cannot say or does not answer within 5 s), pages in the in-app
   * browser; and the page and window state to come back to afterwards. */
  async restartBlockers(): Promise<{ pageBusy: boolean | null; browserTabs: number; resume: Resume }> {
    const browserTabs = this.pane?.state().tabs.length ?? 0
    const window = this.win.isDestroyed() || !this.win.isVisible() ? 'none' : this.win.isMinimized() ? 'minimized' : 'shown'
    const app = this.app
    if (!app || app.webContents.isDestroyed() || !this.team) return { pageBusy: false, browserTabs, resume: { page: null, window, at: Date.now() } }
    const wc = app.webContents
    let pageBusy: boolean | null = null
    try {
      const ask = wc.executeJavaScript(`(() => { const f = window.${PAGE_BUSY_GLOBAL}; return typeof f === 'function' ? !!f() : null })()`)
      const r: unknown = await Promise.race([ask, new Promise((r) => setTimeout(() => r(null), 5000))])
      pageBusy = typeof r === 'boolean' ? r : null
    } catch {}
    return { pageBusy, browserTabs, resume: { page: resumePage(this.team.id, wc.getURL(), [this.currentOrigin]), window, at: Date.now() } }
  }

  /** Open a remembered team; `entryPath` is the page a pasted link leads to ('/invite/<t>', '/join#t=<t>'), else '/'.
   * `startup`: the app opens it by itself at start (openLast), nobody picked it. */
  async openTeam(id: string, entryPath = '/', o: { startup?: boolean } = {}) {
    const team = findTeam(this.teams, id)
    if (!team) return
    this.startupLocal = o.startup && onThisComputer(team.origin) ? id : null
    // a team view takes over: a link that waited on ④ waits no more (it would come back confirmable later)
    this.linkGate.clear()
    this.linkError = null
    if (this.team?.id === id && this.app && this.mode !== 'offline') {
      // the team is open already: a link opens its page there (the address it shows now, office network or not)
      if (entryPath !== '/' && this.currentOrigin) await this.app.webContents.loadURL(this.currentOrigin + entryPath).catch(() => {})
      return this.back()
    }
    debug('open team', id)
    this.disposeTeam()
    this.team = team
    this.saveTeams(touchTeam(this.teams, id, new Date().toISOString()))
    this.team = findTeam(this.teams, id)!
    this.fingerprintMismatch = false
    this.directOrigin = null
    this.pagePath = ''
    this.signedIn = false
    this.meAnswered = false
    this.stripWaited = false
    clearTimeout(this.stripTimer)
    // a server updated since the last open may have the computer report now (common/system-activity.ts)
    this.computerReporter.reset()
    this.stripTimer = undefined
    this.pageHostLine = false
    this.sendHostbar()

    const appSes = session.fromPartition(partitionFor(id, 'app'))
    this.configureAppSession(appSes)
    const app = new WebContentsView({ webPreferences: { ...APP_WEB_PREFERENCES, session: appSes, preload: join(this.o.distDir, 'preload-app.cjs') } })
    app.setBackgroundColor('#FFFFFF')
    this.app = app
    // a press on another team's page never counts for this one (Find work files: WorkFilesController.add)
    this.appInputAt = 0
    this.watchKeys(app, false)
    // a right-click: copy a photo, a link or text (Electron shows no menu of its own)
    attachContextMenu(app.webContents, { window: this.win, locale: this.o.locale, allowedOrigins: () => this.allowedOrigins() })
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
      // the app opened a team on this computer by itself at start (a developer's server, often not running, e.g. data
      // a dev build left in the same settings folder): the first-run screen with the team list and a line, not the
      // offline card. The team stays in the list; opening it from there shows the card with [다시 시도].
      if (this.startupLocal === this.team.id) {
        const address = hostOf(this.team.origin)
        this.startupLocal = null
        const line = t(this.o.locale(), 'offline.localStart', { address })
        this.localStart = { team: this.team.id, line }
        this.disposeTeam()
        this.team = undefined
        this.linkError = line
        this.showWelcome()
        return
      }
      this.mode = 'offline'
      if (this.offlineReopened) this.offlineReopened = false
      else this.watchOffline()
      this.layout()
      this.sendWelcome()
      // not in front of another app when the network drops while the person is there (as in showWelcome)
      if (this.win.isFocused()) this.shell.webContents.focus()
    }
    let navigationFailed = false
    app.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3: aborted (a new navigation replaced it)
      // without the fragment: a one-time sign-in link carries its code there (/app-signin#c=…)
      debug('team page failed to load', code, url.split('#')[0])
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
      // the team answered: a later failure is the offline card, as for any team
      if (originOf(url)) this.startupLocal = null
      if (this.mode === 'offline' && originOf(app.webContents.getURL())) this.mode = 'team'
      // the team page is back: the next time it cannot be reached, the looks start from the short wait again
      if (originOf(url)) { this.stopOfflineWatch(); this.offlineTries = 0; this.offlineReopened = false }
      this.layout()
      // A request started before navigation may still carry the signed-out/previous session.
      void this.ensureBrowserOwner()
      void this.measureClock()
      // the strip waits a moment for /api/me before it takes space (a signed-in open then never shows it)
      if (originOf(url) && !this.meAnswered && !this.stripWaited && !this.stripTimer) {
        this.stripTimer = setTimeout(() => {
          this.stripTimer = undefined
          if (this.app !== app) return
          this.stripWaited = true
          this.layout()
        }, HOSTBAR_WAIT_MS)
      }
    })
    app.webContents.on('render-process-gone', (_e, d) => {
      debug('team page renderer gone', d.reason)
      if (this.app === app) void this.reload()
    })
    app.webContents.on('page-title-updated', () => this.updateTitle())
    // the team page is one app: signing in or out changes the route without a new page load
    app.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame && this.app === app) {
        void this.ensureBrowserOwner()
        this.pageAt(url)
      }
    })
    app.webContents.on('did-navigate', (_e, url) => {
      if (this.app === app) this.pageAt(url)
    })

    const browserSes = session.fromPartition(partitionFor(id, 'browser'))
    this.pane = new BrowserPane(
      {
        win: this.win,
        chrome: this.chrome,
        onOpenChange: () => {
          this.chromeOnOpen(false)
          this.layout()
        },
        onState: (s) => this.sendPaneState(s),
        onPrompts: (p) => this.send(this.chrome, 'ui:pane-prompts', p),
        onActivity: (a) => this.send(this.chrome, 'ui:pane-activity', a),
        onSavePermissions: (p) => {
          this.o.store.savePermissions(id, p)
          // the pane's ⚙ panel and the team page's Settings > Browser show the same value: both hear every change
          if (this.pane) this.sendSiteSettings(this.pane.siteSettings())
        },
        teamHosts: () => teamHostnames(this.teams.teams),
        onKeys: (view) => this.tabKeys(view),
        onPersonActed: (view) => this.personActed(true, view),
        overlays: () => (this.findBar.open ? [this.findBar.view] : []),
        onLayout: () => this.placeFind(),
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
    await this.loadOrigin(origin, entryPath)
    // the team page is on screen: macOS's one question about notifications comes now, not with the first notification
    // (that one only comes while the window is in the back, when nobody sees the question)
    if (this.app === app) this.notifier.ask()
    // the team went back to the list meanwhile (a dev team on this computer that did not answer at start)
    if (this.app !== app) return
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
    // the person's own Try again: the app's own look, if one is under way, does nothing more
    this.stopOfflineWatch()
    this.offlineTries = 0
    this.offlineReopened = false
    void this.reload()
  }

  /**
   * The full-page "cannot reach the team server" card looks again by itself (QA TC-3453: it stayed until someone
   * pressed Try again, although the server was back): one GET /api/health of the team's address after 5, 10, 20 and
   * then every 30 seconds (common/address.ts offlineRetryDelay), and the team opens again as soon as it answers, as
   * Try again does. It stops when the card is left: Other teams (leftOffline), the team list, another team, the team
   * removed, the window closed, or the page back. One reopening that fails although the server answered ends the looks
   * too (offlineReopened): Try again is the person's then.
   */
  private watchOffline() {
    if (this.offlineTimer || !this.team) return
    this.offlineWatching = true
    const id = this.team.id, origin = this.team.origin
    const watch = this.offlineWatch
    const still = () => watch === this.offlineWatch && !this.win.isDestroyed() && this.mode === 'offline' && this.team?.id === id
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = undefined
      if (!still()) return
      void fetchHealth(origin).then((r) => answersAgain(origin, r), () => false).then((back) => {
        if (!still()) return
        if (back) { this.offlineReopened = true; void this.reload() }
        else this.watchOffline()
      })
    }, offlineRetryDelay(this.offlineTries++))
  }
  private stopOfflineWatch() {
    clearTimeout(this.offlineTimer)
    this.offlineTimer = undefined
    this.offlineWatching = false
    this.offlineWatch++
  }
  /** "Other teams" on the cannot-reach card: the person left it, so the team does not open under them later. */
  leftOffline() {
    this.stopOfflineWatch()
    this.offlineTries = 0
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
      const top = frameTree.frame as { id: string; url: string; securityOrigin?: string }
      if (top.id !== frameId || !isTrustedAppSender({ url: top.url, origin: top.securityOrigin ?? '', isTop: true, isAppView: this.app === app }, this.allowedOrigins())) return
      const { node } = await dbg.sendCommand('DOM.describeNode', { backendNodeId })
      const L = this.o.locale()
      const r = await dialog.showOpenDialog(this.win, openDialogChoice({ multiple, attributes: node?.attributes, home: electronApp.getPath('home'), claude: { message: t(L, 'files.claudeMessage'), button: t(L, 'files.claudeButton') } }))
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
    this.stopOfflineWatch()
    // a look of this team page: its ids read nothing any more, one still running gives nothing
    this.workFiles.forget()
    // the team's notifications name its chats and open its addresses: none outlives the team page (session markers),
    // and the dock's count was this team's (the next team page sets its own)
    this.notifier.closeAll()
    if (process.platform === 'darwin') electronApp.setBadgeCount(0)
    this.pane?.dispose()
    this.pane = undefined
    // this computer leaves the team: its server hears it at once, not after the last report goes stale (phone rule)
    this.computerReporter.farewell()
    if (this.app) {
      const wc = this.app.webContents
      if (!this.win.isDestroyed() && this.win.contentView.children.includes(this.app)) this.win.contentView.removeChildView(this.app)
      if (!wc.isDestroyed()) wc.close()
      this.app = undefined
    }
    // the team page and the pane's tabs are gone: nothing of theirs to give the keyboard back to
    const own = [this.shell, this.chrome, this.hostbar]
    if (this.keys && !own.includes(this.keys.view)) this.keys = undefined
    if (this.keysAtBlur && !own.includes(this.keysAtBlur.view)) this.keysAtBlur = undefined
    this.keysWanted = undefined
    this.currentOrigin = ''
  }

  private configureAppSession(ses: Session) {
    if (this.configuredSessions.has(ses)) return
    this.configuredSessions.add(ses)
    this.downloads.attach(ses)
    this.folderGrants.set(ses, hardenAppSession(ses, () => this.allowedOrigins(), (why) => this.folderRefused(why)))
    pinCertificates(
      ses,
      () => (this.team ? this.team.direct : null),
      (host) => this.onFingerprintMismatch(host),
    )
  }

  /**
   * A folder the team page asked for was refused (common/folder-access.ts refusedFolderReason): say why, in the app's
   * language, and offer to pick another folder (the folder window opens again) or to stop (the page hears Cancel).
   * Before, the refusal read as Cancel and nothing was shown (QA TC-219).
   */
  private async folderRefused(why: 'home' | 'blocked'): Promise<'tryAgain' | 'deny'> {
    if (this.win.isDestroyed()) return 'deny'
    const L = this.o.locale()
    const r = await dialog.showMessageBox(this.win, {
      type: 'info',
      message: t(L, why === 'home' ? 'folderPick.homeTitle' : 'folderPick.blockedTitle'),
      detail: t(L, why === 'home' ? 'folderPick.homeDetail' : 'folderPick.blockedDetail'),
      buttons: [t(L, 'folderPick.again'), t(L, 'folderPick.cancel')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    return r.response === 0 && !this.win.isDestroyed() ? 'tryAgain' : 'deny'
  }

  /** The team page found nothing to read in the folder it picked last (shared/src/desktop-bridge.ts folderProblem): why,
   * when macOS kept the app out of it (common/folder-access.ts FolderGrants.problem); null otherwise. QA TC-049. */
  async folderProblem(origin: string, name: string): Promise<'mac-blocked' | null> {
    const app = this.app
    if (!app || app.webContents.isDestroyed()) return null
    return (await this.folderGrants.get(app.webContents.session)?.problem(origin, name, this.allowedOrigins())) ?? null
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
        if (this.team?.id === team.id) {
          this.setSignedIn(false)
          this.folderPerson({ signedIn: false })
          await this.checkBrowserOwner(team.id, pane, { signedIn: false })
        }
        return false
      }
      if (!res.ok) {
        if (this.team?.id === team.id) this.setSignedIn(false)
        return false
      }
      const me = Me.safeParse(await res.json())
      if (this.team?.id === team.id) this.setSignedIn(me.success)
      if (!me.success || this.team?.id !== team.id || this.pane !== pane) return false
      this.folderPerson({ signedIn: true, userId: me.data.user.id })
      await this.checkBrowserOwner(team.id, pane, { signedIn: true, userId: me.data.user.id })
      // the team's policy and the person's "Allow all websites" for the AI's web reads (followed both ways):
      // common/me-policy.ts
      if (pane && this.pane === pane) applyMePolicy(pane, me.data)
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

  /** The folders picked in the team page's folder window belong to the person who picked them (docs/DECISIONS.md
   * "W6"): a sign-out or another person signing in on this team forgets them. */
  private folderPerson(me: MeResult) {
    if (this.app && !this.app.webContents.isDestroyed()) this.folderGrants.get(this.app.webContents.session)?.person(me)
    this.workFiles.person(me)
  }

  /**
   * The in-app browser's data belongs to one person (common/browser-owner.ts): when someone else signs in to this
   * team, or the person signs out, clear the pane before anyone uses it.
   */
  private async checkBrowserOwner(teamId: string, pane: BrowserPane | undefined, me: MeResult) {
    const change = browserOwnerChange(this.o.store.loadBrowserOwner(teamId), me)
    if (change.clear) {
      debug('in-app browser: another person or signed out, clearing', teamId)
      let cleared: ClearResult
      if (pane && this.pane === pane) {
        cleared = await pane.resetForNewPerson()
        this.send(this.chrome, 'ui:pane-prompts', [])
        this.send(this.chrome, 'ui:pane-activity-reset', null)
        this.sendSiteSettings(pane.siteSettings())
        this.sendPaneState(pane.state())
      } else {
        // the pane is not open for this team: clear its stored data directly
        cleared = await clearSessionData(session.fromPartition(partitionFor(teamId, 'browser')), `team ${teamId} browser`)
        const saved = new SitePermissions(this.o.store.loadPermissions(teamId))
        if (saved.resetForNewPerson()) this.o.store.savePermissions(teamId, saved.toJSON())
      }
      // a clear that failed (not one that ran out of time): the new person is not recorded, so the next check clears
      // again, and this check (and the AI call waiting for it) fails, as before the time limit
      if (clearFailed(cleared)) throw new Error('the in-app browser data could not be cleared')
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
        // the one risk sentence every place that turns it on shows (shared/src/web-allow-all.ts)
        detail: `${t(L, 'allowAll.detail')}\n\n${WEB_ALLOW_ALL_RISK[L] ?? WEB_ALLOW_ALL_RISK.en}`,
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

  // ------------------------------------------------- the browser toolbar's own page

  private loadChrome() {
    if (this.win.isDestroyed() || this.chrome.webContents.isDestroyed()) return
    this.chrome.webContents.loadURL(`${UI_ORIGIN}/pane.html`).catch(() => {})
  }

  /**
   * The toolbar's page is gone (common/pane-chrome.ts): the browser is not drawn until it is back. It loads again a few
   * times; past that the browser closes (the AI's tabs keep running, as after ✕) and the next time it is opened, by the
   * person or the AI's next step, the toolbar is tried again.
   */
  private chromeFailed(why: string) {
    if (this.win.isDestroyed() || this.chrome.webContents.isDestroyed()) return
    debug('browser toolbar failed', why)
    if (!this.chromeDown) {
      this.chromeDown = true
      this.tellPageOpen()
    }
    this.layout()
    if (this.chromeRetry) return
    const r = chromeRecovery(this.chromeFailures, Date.now())
    this.chromeFailures = r.failures
    if (r.action === 'close') {
      this.pane?.hide()
      return
    }
    this.chromeRetry = setTimeout(() => {
      this.chromeRetry = undefined
      this.loadChrome()
    }, CHROME_RELOAD_DELAY_MS)
  }

  /**
   * The toolbar's page drew its controls (its ✕ is there; also told by every toolbar height it reports, main.ts): the
   * browser is drawn from now on, and the questions waiting for the person are told again (they are told only when they
   * change, so a toolbar loaded again would not have them).
   */
  chromeUp() {
    if (!this.chromeDown || !this.chromeLoaded || this.chromeLoadFailed || this.win.isDestroyed()) return
    this.chromeDown = false
    this.paneWidthTold = ''
    this.pane?.resendPrompts()
    this.tellPageOpen()
    this.layout()
  }

  /** The browser opened while its toolbar is down and no load again is waiting: try it now. */
  private chromeOnOpen(byPerson: boolean) {
    if (!this.chromeDown || this.chromeRetry || !this.pane?.open || this.chrome.webContents.isLoading()) return
    // the AI's steps open the browser again and again: they wait for the budget; the person's 🌐 always tries
    if (!byPerson && this.chromeFailures.filter((t) => Date.now() - t < CHROME_RELOAD_WINDOW_MS).length >= CHROME_RELOADS) return
    this.loadChrome()
  }

  /** Did the toolbar's page draw its ✕? Yes: the browser is drawn (chromeUp); no, or no answer: as a failed load. */
  private checkChromeDrawn() {
    const nav = this.chromeNav
    const failed = (why: string) => nav === this.chromeNav && this.chromeFailed(why)
    this.chrome.webContents
      .executeJavaScript(`!!document.querySelector('#toolbar [data-testid="pane-close"]')`)
      .then((drawn) => {
        if (nav !== this.chromeNav) return
        if (drawn === true) this.chromeUp()
        else failed('not drawn')
      })
      .catch(() => failed('check failed'))
  }

  /** The pane's state for the team page: open only while it is drawn (its 🌐 shows what the person sees). */
  paneStateForPage(): DesktopPaneState | null {
    const s = this.pane?.state()
    return s ? { ...s, open: s.open && !this.chromeDown } : null
  }

  private tellPageOpen() {
    const s = this.paneStateForPage()
    if (s) this.send(this.app, 'bridge:pane-state', s)
  }

  /** the browser is drawn: it is open and its toolbar is there */
  private paneShown(): boolean {
    return this.mode === 'team' && !!this.app && !!this.pane?.open && !this.chromeDown
  }

  // ------------------------------------------------- the in-app browser's width

  /** The browser's width now (0: closed) and its limits, in this window. */
  paneWidth(): { now: number; min: number; max: number; grab: number } {
    const [w] = this.win.isDestroyed() ? [0] : this.win.getContentSize()
    const now = this.paneShown() ? paneWidthFor(this.paneFraction, w) : 0
    return { now, ...paneLimits(w), grab: now ? paneGrab(w - now) : 0 }
  }

  /**
   * The browser toolbar's edge handle (ui/pane.ts, docs/DECISIONS.md "브라우저 너비는 끌어서"). start: a drag begins (the
   * press that started it is the latest in the toolbar view); move: the edge is at `edgeX` (screen coordinates: the
   * views move under the pointer while it drags); end: the width is remembered and the keyboard goes back where it was
   * before the press (keysAfterDrag); reset (double-click): the default width again.
   */
  paneDrag(phase: 'start' | 'move' | 'end' | 'reset', edgeX?: number) {
    if (this.win.isDestroyed() || !this.pane?.open || this.mode !== 'team') return
    if (phase === 'start') {
      const press = this.toolbarPress && Date.now() - this.toolbarPress.at < 2000 ? this.toolbarPress : undefined
      this.drag = { press }
      // a press on the edge is not the person acting in the in-app browser: a page load there during the drag (the AI
      // at work) must not keep the keyboard (common/keyboard-focus.ts keyboardTaken)
      if (press) this.personInPane = press.personInPane
      return
    }
    if (phase === 'move') {
      if (typeof edgeX !== 'number' || !Number.isFinite(edgeX)) return
      const b = this.win.getContentBounds()
      this.setPaneFraction(settlePane(paneFromEdge(edgeX, b.x, b.width), b.width, this.paneFraction))
      return
    }
    if (phase === 'reset') this.setPaneFraction(null)
    this.saveWindow()
    const press = this.drag?.press ?? (this.toolbarPress && Date.now() - this.toolbarPress.at < 2000 ? this.toolbarPress : undefined)
    this.drag = undefined
    this.keysAfterDrag(press)
  }

  /** An arrow key, Home or End on the focused edge handle: Left widens the browser, Right narrows it (Shift: a bigger
   * step). The keyboard stays on the handle. */
  paneKey(key: string, shift: boolean) {
    const { now, min, max } = this.paneWidth()
    if (!now) return
    const next = paneKeyWidth(key, shift, now, { min, max })
    if (next === null) return
    const [w] = this.win.getContentSize()
    this.setPaneFraction(settlePane(next, w, this.paneFraction))
    // a held arrow key repeats: written once it stops
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveWindow(), 400)
  }

  private setPaneFraction(f: number | null) {
    if (f === this.paneFraction) return
    this.paneFraction = f
    this.layout()
  }

  /** window.json: the window's size and the browser's width, kept across restarts (also written when the window closes) */
  private saveWindow() {
    clearTimeout(this.saveTimer)
    if (this.win.isDestroyed()) return
    const [width, height] = this.win.getSize()
    this.o.store.saveWindow({ width, height, ...(this.paneFraction === null ? {} : { paneFraction: this.paneFraction }) })
  }

  /**
   * A press on the edge handle gave the keyboard to the browser toolbar's view (the system focuses the view a press
   * lands in). When the drag ends it goes back to the view that had it before the press, if the toolbar still has it
   * and that view is still on screen, and the press does not count as the person acting in the in-app browser (a page
   * load there would otherwise keep the keyboard: common/keyboard-focus.ts keyboardTaken). Focusing the view keeps
   * the page's own element (the team page's message box and its draft).
   */
  private keysAfterDrag(press?: ToolbarPress) {
    if (!press) return
    this.personInPane = press.personInPane
    const back = press.keys?.view
    if (!back || back === this.chrome || back.webContents.isDestroyed()) return
    if (!this.chrome.webContents.isFocused() || !this.keysReady() || !this.shownViews().includes(back)) return
    this.keysTo(back, 'after resizing the browser')
  }

  /** Tell the toolbar's edge handle its width and limits (aria values) and its grab strip, when they change. */
  private sendPaneWidth() {
    const s = this.paneWidth()
    const told = JSON.stringify(s)
    if (told === this.paneWidthTold) return
    this.paneWidthTold = told
    this.send(this.chrome, 'ui:pane-width', s)
  }

  // ----------------------------------------------------------------- layout

  layout() {
    if (this.win.isDestroyed()) return
    // the views change: the one with the keyboard may leave the window (the team list, the pane closed)
    this.settleKeysSoon()
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
      hide(this.hostbar)
      this.pane?.setBounds(null)
      show(this.shell, { x: 0, y: 0, width: w, height: h })
      this.placeFind()
      this.sendPaneWidth()
      this.sendFocus()
      return
    }
    hide(this.shell)
    // the browser's remembered share of the window, within its limits (common/pane-width.ts)
    const pw = this.paneShown() ? paneWidthFor(this.paneFraction, w) : 0
    // the team address above the page (drawn by the app): on the sign-in pages, and on every page until the team said
    // who is signed in
    // or, while Find work files reads the files the person added, "Trina is reading N files from this computer"
    const top = this.hostLine() || this.reading ? HOSTBAR_HEIGHT : 0
    if (top) show(this.hostbar, { x: 0, y: 0, width: Math.max(0, w - pw), height: top })
    else hide(this.hostbar)
    show(this.app, { x: 0, y: top, width: Math.max(0, w - pw), height: Math.max(0, h - top) })
    this.pane?.setBounds(pw ? { x: w - pw, y: 0, width: pw, height: h } : null)
    this.placeFind()
    this.sendPaneWidth()
    this.sendFocus()
  }

  // ------------------------------------------------------------------- find

  /** Edit › Find… (Cmd/Ctrl+F), Find Next (Cmd/Ctrl+G), Find Previous (Shift+Cmd/Ctrl+G): the find bar over the view
   * the person is in (common/find-bar.ts findTarget). Next / previous with the bar closed open it, as Find does. */
  find(what: 'open' | 'next' | 'prev') {
    if (this.win.isDestroyed()) return
    const bar = this.findBar
    if (what !== 'open' && bar.open) return bar.step(what === 'next')
    const target = findTarget({
      shown: this.shownViews(),
      last: this.keys?.view,
      bar: bar.view,
      searching: bar.target,
      toolbar: this.chrome,
      paneTab: this.pane?.shownTab(),
      strip: this.hostbar,
      page: this.mode === 'team' && this.app ? this.app : undefined,
      screen: this.shell,
    })
    if (target) void bar.show(target)
  }

  /** On every layout: the find bar over its view's corner, or closed when that view left the window (the team list over
   * the team page, the browser closed, another tab, another team). */
  private placeFind() {
    const bar = this.findBar
    const t = bar.target
    if (!t) return
    if (t.webContents.isDestroyed() || !this.win.contentView.children.includes(t)) return bar.close(false)
    bar.place()
  }

  /** Is the person looking at the team page (DesktopBridge.focus, docs/DECISIONS.md "화면에 연 대화는 울리지 않는다")?
   * This window focused and the team page shown in it: not under the team list or the offline screen, where its view
   * is only taken out of the window and the page still reports itself visible. `windowFocused`: the focus event's own
   * word (else the window's). */
  teamFocused(windowFocused?: boolean): boolean {
    if (this.win.isDestroyed() || !this.app || this.mode !== 'team') return false
    return windowFocused ?? this.win.isFocused()
  }

  /** the word last told to which team page (each page asks once itself as it starts) */
  private focusTold?: { app: WebContentsView; focused: boolean }
  /** Tell the team page when teamFocused changes (the window's focus, the team list or the offline screen over it). */
  private sendFocus(windowFocused?: boolean) {
    const app = this.app
    if (!app) return
    const focused = this.teamFocused(windowFocused)
    if (this.focusTold?.app === app && this.focusTold.focused === focused) return
    this.focusTold = { app, focused }
    this.send(app, 'bridge:focus', focused)
  }

  // ---------------------------------------------------------------- keyboard

  private watchKeys(view: WebContentsView, inPane: boolean) {
    const wc = view.webContents
    wc.on('focus', () => {
      // the find bar's page outside the window (closed) never holds the keyboard
      if (view === this.findBar.view && !this.findBar.open) return
      // a press in the browser toolbar (its edge handle) takes the keyboard first: remember where it was (keysAfterDrag)
      if (view === this.chrome) this.beforeToolbarFocus = { keys: this.keys, at: Date.now() }
      this.keysAt(view, inPane)
    })
    // where the person acts: a key or a mouse press in this view
    wc.on('before-input-event', (_e, i) => {
      if (i.type !== 'keyUp') this.personActed(inPane)
      if (i.type === 'keyDown' && view === this.app) this.appInputAt = Date.now()
    })
    wc.on('before-mouse-event', (_e, m) => {
      if (m.type !== 'mouseDown') return
      if (view === this.app) this.appInputAt = Date.now()
      if (view === this.chrome) {
        // the view took the keyboard for this very press (its focus event came just before, and no other press in it
        // since), or had it already
        const f = this.beforeToolbarFocus
        const keys = f && this.keys?.view === this.chrome && Date.now() - f.at < 500 ? f.keys : this.keys
        this.beforeToolbarFocus = undefined
        this.toolbarPress = { keys, personInPane: this.personInPane, at: Date.now() }
      }
      this.personActed(inPane)
    })
  }

  /** The person pressed a key or the mouse in a view (`tab`: a tab of the in-app browser), or opened the in-app browser.
   * A mouse press in a tab whose page load gave the keyboard back (keyboardTaken) gives it to the tab after all. */
  private personActed(inPane: boolean, tab?: WebContentsView) {
    this.personInPane = inPane
    if (tab && !tab.webContents.isDestroyed() && !tab.webContents.isFocused() && this.keysReady() && this.shownViews().includes(tab)) this.keysTo(tab, 'click')
  }

  /** The person opens, closes or toggles the in-app browser (the team page's Browser entry, the menu): opening it is an
   * action in it, as a click there is. */
  paneByPerson(what: 'open' | 'close' | 'toggle') {
    const pane = this.pane
    if (!pane) return
    if (what === 'open' || (what === 'toggle' && !pane.open)) this.personActed(true)
    // open but not drawn (its toolbar is loading again): the person asks to see it, so try the toolbar now rather
    // than close a browser they cannot see (the team page shows it closed, paneStateForPage)
    if (what !== 'close' && pane.open && this.chromeDown) this.chromeOnOpen(true)
    else if (what === 'open') pane.show()
    else if (what === 'close') pane.hide()
    else pane.toggle()
    // the person opened it: the toolbar is tried now even after the few loads again (an AI step waits for those)
    if (what !== 'close' && pane.open) this.chromeOnOpen(true)
  }

  /** A tab of the in-app browser got the keyboard: a page load there does not take it from where the person is
   * (common/keyboard-focus.ts keyboardTaken). */
  private tabKeys(view: WebContentsView) {
    const taken = keyboardTaken({
      took: view,
      loading: !view.webContents.isDestroyed() && view.webContents.isLoading(),
      personInPane: this.personInPane,
      given: this.giving === view,
      ready: this.keysReady(),
      shown: this.shownViews(),
      last: this.keys?.view,
      page: this.mode === 'team' && this.app ? this.app : undefined,
    })
    if (taken.keep) return this.keysAt(view, true)
    if (taken.back) this.keysTo(taken.back, 'kept from a page load')
  }

  private keysAt(view: WebContentsView, inPane: boolean) {
    this.keys = { view, inPane }
  }

  /** the window's views on screen that could have the keyboard */
  private shownViews(): WebContentsView[] {
    const children = this.win.contentView.children
    return [this.shell, this.chrome, this.hostbar, this.app, this.pane?.shownTab(), this.findBar.view].filter((v): v is WebContentsView => !!v && !v.webContents.isDestroyed() && children.includes(v))
  }

  /** the window has the focus and no dialog or right-click menu of the app is open over it */
  private keysReady(): boolean {
    return !this.win.isDestroyed() && this.win.isFocused() && !this.allowAllOpen && !this.choosingFiles && !contextMenuOpen()
  }

  private keysTo(view: WebContentsView, why: string) {
    const name = view === this.app ? 'team page' : view === this.chrome ? 'browser toolbar' : view === this.shell ? 'app screen' : view === this.hostbar ? 'host strip' : view === this.findBar.view ? 'find bar' : 'browser tab'
    debug('keyboard to', name, why)
    this.giving = view
    try {
      view.webContents.focus()
    } finally {
      this.giving = undefined
    }
  }

  /** The window got the focus back: on macOS the view that had the keyboard when it lost it gets it again, at once
   * (common/keyboard-focus.ts keyboardBack; Windows and Linux keep it themselves); the team page after a notification's
   * click; nothing had it: settleKeys. Not ready (a dialog of the app on its way): kept for the next return. */
  private keysBack() {
    if (this.win.isDestroyed()) return
    const ready = this.keysReady()
    if (ready) {
      const wanted = this.keysWanted
      const atBlur = wanted ? { view: wanted } : process.platform === 'darwin' ? this.keysAtBlur : undefined
      this.keysAtBlur = undefined
      this.keysWanted = undefined
      const back = keyboardBack({ ready, shown: this.shownViews(), atBlur })
      if (back) this.keysTo(back, wanted ? 'notification' : 'back')
    }
    this.settleKeysSoon()
  }

  /** settleKeys a turn later: the views settle first, and a click that gave a view the keyboard meanwhile wins */
  private settleKeysSoon() {
    if (this.settleQueued) return
    this.settleQueued = true
    setImmediate(() => {
      this.settleQueued = false
      this.settleKeys()
    })
  }

  /**
   * The window has the focus and no view in it has the keyboard (after a start, a minimize, the team list, the pane
   * closed): give it to the view in front (common/keyboard-focus.ts, docs/DECISIONS.md "창으로 돌아오면 키보드는 보던
   * 곳으로"). Never while the window is in the back (focusing a view brings it forward on macOS), and never over the
   * app's own dialogs or right-click menus.
   */
  private settleKeys() {
    if (this.win.isDestroyed()) return
    const target = keyboardTarget({
      ready: this.keysReady(),
      shown: this.shownViews(),
      hasKeys: (v) => v.webContents.isFocused(),
      last: this.keys,
      paneTab: this.pane?.shownTab(),
      page: this.mode === 'team' && this.app ? this.app : this.shell,
    })
    if (target) this.keysTo(target, 'settle')
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
    this.send(this.hostbar, 'ui:locale', payload)
    this.findBar.localeChanged(payload)
    this.updateTitle()
  }

  /** This team's pages draw (true) or no longer draw (false) their own address line under the sign-in card
   * (DesktopBridge.hostLine). */
  setPageHostLine(drawn: boolean) {
    if (!this.app || drawn === this.pageHostLine) return
    this.pageHostLine = drawn
    this.layout()
  }

  /** The team page moved: the host strip shows on its sign-in pages, and on every page until /api/me answered. */
  private pageAt(url: string) {
    let path = ''
    try {
      path = new URL(url).pathname
    } catch {
      path = ''
    }
    const page = originOf(url) ? path : ''
    if (page === this.pagePath) return
    this.pagePath = page
    this.sendHostbar()
    this.layout()
  }

  private setSignedIn(signedIn: boolean) {
    if (signedIn === this.signedIn && this.meAnswered) return
    this.signedIn = signedIn
    this.meAnswered = true
    this.layout()
    // signed in to the open team: its server hears about this computer now, not at the next 30 s tick
    if (signedIn) void this.computerReporter.report(readSystemActivity(powerMonitor))
  }

  private sendHostbar() {
    this.send(this.hostbar, 'ui:hostbar', this.hostbarState())
  }

  // ----------------------------------------------------------- messaging

  private send(v: WebContentsView | undefined, channel: string, payload: unknown) {
    if (v && !v.webContents.isDestroyed()) v.webContents.send(channel, payload)
  }

  private sendPaneState(s: DesktopPaneState) {
    this.send(this.chrome, 'ui:pane-state', s)
    this.send(this.app, 'bridge:pane-state', { ...s, open: s.open && !this.chromeDown })
    this.layout()
  }

  /** The team page's notification: only while the window is not focused; a click shows the window and opens the
   * address it named (a chat, a room), one per tag (common/notify.ts). */
  notify(n: NotifyInput) {
    this.notifier.notify(n)
  }

  /** Settings › Notifications' test notification: shown even while the window is focused (the person asked for it), in
   * the app's own words (never the page's); says whether the system took it (common/notify.ts test). */
  testNotify() {
    const L = this.o.locale()
    return this.notifier.test({ title: t(L, 'notify.test.title'), body: t(L, 'notify.test.body') })
  }
}

/**
 * GET <origin>/api/health without following a redirect (net.fetch has no usable 'manual': it throws), through the
 * app's own session, with an 8 s limit and at most 64 KB read. A 3xx comes back with its Location for healthVerdict.
 */
function fetchHealth(origin: string): Promise<HealthAnswer> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url: `${origin}/api/health`, method: 'GET', session: session.fromPartition('mycel-ui'), redirect: 'manual', useSessionCookies: false })
    req.setHeader('accept', 'application/json')
    const timer = setTimeout(() => {
      req.abort()
      reject(new Error('timeout'))
    }, 8000)
    req.on('redirect', (status, _method, location) => {
      clearTimeout(timer)
      req.abort()
      resolve({ status, location, relayError: null, bodyOk: false })
    })
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size <= 65_536) chunks.push(c)
      })
      res.on('end', () => {
        clearTimeout(timer)
        const header = res.headers['x-relay-error']
        let bodyOk = false
        try {
          bodyOk = size <= 65_536 && Health.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).success
        } catch {
          bodyOk = false
        }
        resolve({ status: res.statusCode, location: null, relayError: (Array.isArray(header) ? header[0] : header) ?? null, bodyOk })
      })
      res.on('error', (e: Error) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    req.end()
  })
}

/**
 * Wake a sleeping free trial team (QA wake gap 1): GET <origin>/ as the page load a browser makes when the person opens
 * the team (Sec-Fetch-Mode: navigate), the request the relay lets wake a team (relay/src/relay.ts mayWake); the health
 * check never does. Nothing is followed or kept: only the status, the relay's x-relay-error and its Retry-After. The
 * relay holds a page load a few seconds; 25 s limit. null: the request failed.
 */
function fetchWake(origin: string): Promise<WakeAnswer> {
  return new Promise((resolve) => {
    const req = net.request({ url: `${origin}/`, method: 'GET', session: session.fromPartition('mycel-ui'), redirect: 'manual', useSessionCookies: false })
    req.setHeader('accept', 'text/html')
    req.setHeader('sec-fetch-mode', 'navigate')
    const done = (a: WakeAnswer) => {
      clearTimeout(timer)
      resolve(a)
    }
    const timer = setTimeout(() => {
      req.abort()
      resolve(null)
    }, 25_000)
    req.on('redirect', (status) => {
      req.abort()
      done({ status, relayError: null, retryAfter: null })
    })
    req.on('response', (res) => {
      const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null
      const after = Number(one(res.headers['retry-after']))
      // the body is not read: the page is not shown here
      res.on('data', () => {})
      res.on('error', () => {})
      done({ status: res.statusCode, relayError: one(res.headers['x-relay-error']), retryAfter: Number.isFinite(after) && after > 0 ? after : null })
      req.abort()
    })
    req.on('error', () => done(null))
    req.end()
  })
}

/** where the keyboard was, and whether the person's last action was in the in-app browser, before a press in the
 * browser toolbar's view (AppWindow.keysAfterDrag) */
interface ToolbarPress {
  keys?: { view: WebContentsView; inPane: boolean }
  personInPane: boolean
  at: number
}

/** The window's own colour behind its views: the app's canvas in the system's light or dark look (ui.css --bg). */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0E0C0B' : '#FCFBF8'
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function stripTime(d: DirectInfo | null | undefined) {
  return d ? { ...d, checkedAt: '' } : null
}

export type { PaneActivity, PanePrompt }
