/**
 * The desktop app (component E): the team's web page in a window, plus the in-app browser pane the AI drives
 * over CDP when a browser tool call arrives through the team page's WebSocket (design tab 5).
 *
 * Environment (development and tests only; ignored in packaged builds unless noted):
 *   MYCEL_DESKTOP_USER_DATA    user data folder (teams.json, partitions); also honoured when packaged
 *   MYCEL_DESKTOP_TEAM         team address to add and open at start (dev convenience)
 *   MYCEL_DESKTOP_TEST_PUBLIC_HOSTS  comma-separated names the browser maps to 127.0.0.1 and treats as public sites
 *   MYCEL_DESKTOP_TEST_PRIVATE_HOSTS comma-separated office-style names (nas.lan) the browser maps to 127.0.0.1
 *   MYCEL_DESKTOP_TEST_DNS_HOSTS     comma-separated names the browser's resolver maps to 127.0.0.1 with no exemption:
 *                                    the checks see them as DNS names answering with this computer's address
 *   MYCEL_DESKTOP_UPDATE_TEST  auto-install | notice | off: the updater's mode in an unpacked app (./updater.ts);
 *                              MYCEL_DESKTOP_UPDATE_FIRST_MS the first check's delay
 *   MYCEL_DESKTOP_UPDATE_UNVERIFIED  1: an unpacked app installs an update without the signed-release check
 *                              (../common/update-verify.ts verificationRequired; a packaged app always checks)
 *   MYCEL_DESKTOP_TEST_FILE_CHOOSER  1: answer the team page's file input with the app's own dialog, as the Mac App
 *                              Store build does (common/file-chooser.ts)
 *   MYCEL_DESKTOP_TEST_DOWNLOADS  a folder that stands in for the computer's Downloads folder (main/downloads.ts)
 *   MYCEL_CONSOLE_ORIGIN       the hosting console the app signs in to for "Create a team for free" (http only on
 *                              127.0.0.1, else https; common/create-team.ts consoleOrigin)
 *   MYCEL_DESKTOP_TEST_STORE   1: the first-run and create screens as in the Mac App Store build (no create row, no plans)
 *   MYCEL_DESKTOP_TEST_CREATE_POLL_MS  how often the starting screen asks the console (main/create-team.ts)
 *   MYCEL_DESKTOP_TEST_OFFER_RETRY_MS  how soon an unknown "Create a team for free" answer is asked again (unpacked only)
 *   MYCEL_DESKTOP_TEST_PASSWORD_STORE  Linux: gnome-libsecret | kwallet5 | kwallet6, the keyring Chromium uses (Playwright's
 *                              Electron loader sets --password-store=basic, Electron's fixed-key fallback, which "Apps on
 *                              your computer" refuses to seal settings with)
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { app, clipboard, ClipboardItem, dialog, Menu, nativeImage, nativeTheme, net, protocol, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { APP_DOWNLOADS } from '@mycel/shared/app-downloads'
import { DESKTOP_BRIDGE_GLOBAL, DESKTOP_BRIDGE_VERSION } from '@mycel/shared/desktop-bridge'
import { PRODUCT } from '@mycel/shared/product'
import { BrowserCall } from '@mycel/shared/api/browser'
import { LocalCall, LOCAL_APPS_BRIDGE_VERSION, type LocalResult } from '@mycel/shared/api/local-apps'
import { errorResult } from '../common/browser-result'
import { asUiLocale, DEFAULT_UI_LOCALE, STRINGS, t, type UiKey, type UiLocale } from '../common/i18n'
import { isOwnUiUrl, isTrustedAppSender, UI_SCHEME } from '../common/trust'
import { LINK_SCHEME, linkFromArgv } from '../common/address'
import { dataDirName, partitionFor } from '../common/teams'
import { NO_KIT, parseKit, type Kit } from '../common/kit'
import { answersFileChoosers } from '../common/file-chooser'
import { DOCK_DOT, dockBadgeOf } from '../common/notify'
import { clipboardPng } from '../common/context-menu'
import { storeBuild } from '../common/update'
import { windowsAppUserModelId } from '../common/app-id'
import { refusesUnsandboxed, registersLinkHandler } from '../common/linux'
import { AppWindow, type AllowAllOutcome } from './app-window'
import { workFilesVersion } from './work-files'
import { scanAsk } from '../common/work-files'
import { BROWSER_BRIDGE_VERSION, GOOGLE_SIGNIN_BRIDGE_VERSION, WORK_FILES_WIDE_VERSION } from '@mycel/shared/desktop-bridge'
import { debug } from './debug'
import { HostClassifier } from './pane/classify'
import { openExternal } from './security'
import { asSiteAccess } from '../common/site-permissions'
import { TeamsStore } from './teams-store'
import { DesktopUpdater } from './updater'
import { onLaunch, takeResume } from './update-launch'
import { SignInReturn } from '../common/sign-in-return'
import { forwardLink, linkSocketPath, listenForLinks } from './link-forward'
import { handoffLog, setHandoffLogDir } from './handoff-log'
import { ConsoleSignIn } from './console-signin'
import { CreateTeam } from './create-team'
import { consoleOrigin, createLinks } from '../common/create-team'
import { APP_PRIVACY_PATH, APP_TERMS_PATH } from '@mycel/shared/cloud-protocol/owner-claim'
import { execFile } from 'node:child_process'
/** macOS's own tool that (re)registers an app bundle with LaunchServices */
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
import { LocalAppsHost } from './local-apps'
import { DictationHost } from './dictation'

// the folder of the bundled main.cjs (Bun inlines __dirname at build time, so look for it at run time):
// packaged = <app.asar>/dist, `electron .` = desktop/dist, `electron dist/main.cjs` = that file's folder
const DIST =
  [join(app.getAppPath(), 'dist'), app.getAppPath(), ...(process.argv[1] ? [dirname(join(process.cwd(), process.argv[1]))] : [])].find((d) =>
    existsSync(join(d, 'page-script.js')),
  ) ?? join(app.getAppPath(), 'dist')
const dev = !app.isPackaged
// a kit build for one team (common/kit.ts): the first-run screen's suggested address and language
const kit: Kit = (() => {
  try {
    return parseKit(JSON.parse(readFileSync(join(DIST, 'kit.json'), 'utf8')))
  } catch {
    return NO_KIT
  }
})()

app.setName(PRODUCT.displayName)
// Windows: the same AppUserModelID as the installer's shortcuts (common/app-id.ts), before any Notification exists.
// Without it Electron uses its own default id and Windows drops every notification silently (QA TC-342).
const aumid = windowsAppUserModelId({ platform: process.platform, windowsStore: process.windowsStore })
if (aumid) app.setAppUserModelId(aumid)
// the settings folder keeps its first name (PRODUCT.desktopDataDir) when the product is renamed: Electron would
// otherwise take the new name and every desk would forget its teams, window and language. A development run keeps its
// own folder next to it (common/teams.ts dataDirName): its dev teams never reach the installed app.
app.setPath('userData', process.env.MYCEL_DESKTOP_USER_DATA || join(app.getPath('appData'), dataDirName(PRODUCT.desktopDataDir, app.isPackaged)))
setHandoffLogDir(app.getPath('userData'))

// Sandboxed srcdoc frames (artifacts, previews) stay in the team page's renderer process, so the page-level
// document-start script that removes RTCPeerConnection reaches them before their own scripts run. Electron's
// debugger cannot pause a new out-of-process frame, so an isolated sandboxed frame would run first (tested).
// Trade-off recorded in docs/DECISIONS.md: origin isolation (opaque origin, CSP) stays; process isolation of
// sandboxed frames is given up.
app.commandLine.appendSwitch('disable-features', 'IsolateSandboxedIframes')
// development and tests only: a Linux keyring instead of the --password-store=basic that a test launcher may have set
const testStore = dev && process.platform === 'linux' ? process.env.MYCEL_DESKTOP_TEST_PASSWORD_STORE : undefined
if (testStore && ['gnome-libsecret', 'kwallet5', 'kwallet6'].includes(testStore)) app.commandLine.appendSwitch('password-store', testStore)

const testPublic = new Set(
  dev
    ? (process.env.MYCEL_DESKTOP_TEST_PUBLIC_HOSTS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [],
)
const testPrivate = new Set(
  dev
    ? (process.env.MYCEL_DESKTOP_TEST_PRIVATE_HOSTS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [],
)
const testDns = new Set(
  dev
    ? (process.env.MYCEL_DESKTOP_TEST_DNS_HOSTS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [],
)
const testMapped = new Set([...testPublic, ...testPrivate])
const resolverRules = [...testMapped, ...testDns].map((h) => `MAP ${h} 127.0.0.1`)
if (resolverRules.length) app.commandLine.appendSwitch('host-resolver-rules', resolverRules.join(', '))

protocol.registerSchemesAsPrivileged([{ scheme: UI_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }])

// One app at a time (audit row 38): a second start (on Windows and Linux every trina-ax:// link) hands its command line
// to the first one ('second-instance' below) and exits at once. app.quit() did not: will-quit holds the first quit back
// to write cookies, so the second app could still reach whenReady, open a window, start the updater and write
// teams.json next to the first one. app.exit skips will-quit; and the second app sets up nothing (`primary`).
// A packaged AppImage that its AppRun started without Chromium's sandbox (user namespaces blocked, Ubuntu 24.04): one
// dialog that points to the .deb, then quit, before anything else is set up (common/linux.ts refusesUnsandboxed)
const linuxStart = { platform: process.platform, packaged: app.isPackaged, env: process.env }
const unsandboxed = refusesUnsandboxed({ ...linuxStart, noSandbox: app.commandLine.hasSwitch('no-sandbox') })
if (unsandboxed) app.whenReady().then(refuseUnsandboxed)
let primary = !unsandboxed && app.requestSingleInstanceLock()
// macOS: a second start may have been given a link (LaunchServices started this copy for it): wait a moment for its
// open-url and hand the link to the running app before quitting (./link-forward.ts). Nothing else is set up here.
const linkSocket = process.platform === 'darwin' ? linkSocketPath(app.getPath('userData')) : null
if (!primary && !unsandboxed && linkSocket) {
  const quit = setTimeout(() => app.exit(0), 3000)
  app.on('open-url', (e, url) => {
    e.preventDefault()
    clearTimeout(quit)
    void forwardLink(linkSocket, url).then((ok) => { handoffLog(`second start: link handed to the running app: ${ok ? 'yes' : 'no'}`); app.exit(0) })
  })
} else if (!primary && !unsandboxed) app.exit(0)
// an update an earlier run left ready (./update-launch.ts): while ShipIt is still installing this app, this start steps
// aside at once (ShipIt drops the update when the app is open again; a waiter opens the new version when it is done)
let updateFailed: string | null = null
if (primary && (app.isPackaged || process.env.MYCEL_DESKTOP_UPDATE_TEST) && !storeBuild(process)) {
  const d = onLaunch({ userData: app.getPath('userData'), version: app.getVersion(), platform: process.platform, execPath: process.execPath })
  if (d.kind === 'wait') {
    primary = false
    app.releaseSingleInstanceLock()
    app.exit(0)
  } else if (d.kind === 'failed' && d.notice) updateFailed = d.pending.version
}

// Links from outside (`trina-ax://open?url=<team link>`, the web's "앱에서 열기"; docs/DECISIONS.md "First run, phase 2"):
// the packaged app answers the scheme (the dmg, Mac App Store and Microsoft Store builds also declare it in their
// manifests: electron-builder.config.ts protocols). A development run does not take it over unless asked.
// On Linux only the .deb registers it (its menu entry, extraMetadata.desktopName); an AppImage has no entry to name.
if (primary && registersLinkHandler(linuxStart)) app.setAsDefaultProtocolClient(LINK_SCHEME)
else if (primary && process.env.MYCEL_DESKTOP_REGISTER_SCHEME === '1' && process.argv[1]) app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, [resolve(process.argv[1])])
// macOS: LaunchServices hands a link to ONE registered copy of the app with this bundle id, and old builds, mounted
// installers or copies elsewhere on the disk may stay registered (owner's Mac 2026-11-22: 23 of them). It then starts
// that copy instead of passing the link to this one. Register this copy again at every start, so its path is the
// newest registration (best effort; ./link-forward.ts covers a newer copy that is started anyway).
if (primary && app.isPackaged && process.platform === 'darwin' && !process.mas) {
  const bundle = resolve(process.execPath, '../../..')
  if (bundle.endsWith('.app')) execFile(LSREGISTER, ['-f', bundle], { timeout: 15_000 }, (e) => handoffLog(`registered this copy for ${LINK_SCHEME}: links: ${e ? 'failed' : 'ok'}`))
}
/** a link that started the app (Windows, Linux: its command line; macOS: open-url before the window exists) */
let launchLink: string | null = linkFromArgv(process.argv)
/** Every link goes to screen ④ (AppWindow.offerLink), never straight to a team. */
function onLink(url: string) {
  if (!win || win.win.isDestroyed()) {
    linkLog('link kept until the window is up', url)
    launchLink = url
    return
  }
  win.offerLink(url)
  if (win.win.isMinimized()) win.win.restore()
  win.win.show()
  win.win.focus()
}
// macOS hands links over here, also the one that launched the app (before ready)
// the running app: links a second start was given (above)
if (primary && linkSocket) listenForLinks(linkSocket, (line) => {
  const link = linkFromArgv([line])
  linkLog('link from a second start', link)
  if (link) onLink(link)
})
if (primary) app.on('open-url', (e, url) => {
  e.preventDefault()
  linkLog('open-url', url)
  onLink(url)
})
/** which way a link came in (the sign-in hand-off's first step), always on: the kind of link only, never its address
 * or a code */
function linkLog(step: string, url: string | null) {
  handoffLog(`${step} ${url === null ? '(no link)' : url.includes('#code=') ? '(sign-in code link)' : '(link)'}`)
}

/** "install the .deb" (refusesUnsandboxed above): the language last picked in this app, else English */
async function refuseUnsandboxed() {
  console.warn('[desktop] the AppImage was started without the sandbox: not running')
  let L: UiLocale = DEFAULT_UI_LOCALE
  try { L = new TeamsStore(app.getPath('userData')).loadLocale() ?? kit.locale ?? DEFAULT_UI_LOCALE } catch {}
  const buttons = APP_DOWNLOADS.page ? [t(L, 'sandbox.download'), t(L, 'sandbox.quit')] : [t(L, 'sandbox.quit')]
  try {
    const r = await dialog.showMessageBox({ type: 'error', title: t(L, 'sandbox.title'), message: t(L, 'sandbox.message', { app: PRODUCT.displayName }), detail: t(L, 'sandbox.detail'), buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true })
    if (APP_DOWNLOADS.page && r.response === 0) await shell.openExternal(APP_DOWNLOADS.page)
  } catch (e) {
    console.warn('[desktop] sandbox dialog', (e as Error).message)
  }
  app.exit(0)
}

let win: AppWindow | undefined
/** "Create a team for free" (main/create-team.ts): made when the app is ready (its user data folder) */
let consoleSignIn: ConsoleSignIn | undefined
let createTeam: CreateTeam | undefined
/** the Mac App Store build's first-run and create screens (a development run may ask for them: MYCEL_DESKTOP_TEST_STORE) */
const storeScreens = process.mas === true || (dev && process.env.MYCEL_DESKTOP_TEST_STORE === '1')
/** a connector sign-in's one-time return address on 127.0.0.1, for the team the window shows (common/sign-in-return.ts) */
const signInReturn = new SignInReturn({ current: () => win?.team?.origin })
/** apps on this computer as connectors (main/local-apps.ts): made when the app is ready (its user data folder) */
let localApps: LocalAppsHost | undefined
// voice input transcribed on this Mac (main/dictation.ts): the page that started the recording gets its words
let dictationPage: WebContents | null = null
const dictation = new DictationHost({
  send: (ev) => { if (dictationPage && !dictationPage.isDestroyed()) dictationPage.send('bridge:dictation-event', ev) },
})
const updater = new DesktopUpdater({
  team: () => (win?.team && win.app ? { id: win.team.id, origin: win.team.origin } : null),
  window: () => win?.win ?? null,
  locale: () => locale(),
  openApps: () => {
    const origin = win?.team?.origin
    if (origin && win?.app) void win.app.webContents.loadURL(`${origin}/settings/apps`)
  },
  changed: () => buildMenu(),
  // no window (closed on a Mac, the app still running): nothing on screen to lose, and it comes back without one shown
  restartBlockers: async () => (win ? win.restartBlockers() : { pageBusy: false, browserTabs: 0, resume: { page: null, window: 'none', at: Date.now() } }),
})
// Language of the app's own screens, menus and prompts: what the team page last reported (its person's choice, else
// the team default) or what was picked on the team list; before either, a kit build's language, else English. Not the
// system language.
let store: TeamsStore | undefined
let uiLocale: UiLocale | null = null
const locale = (): UiLocale => (uiLocale ??= store?.loadLocale() ?? kit.locale ?? DEFAULT_UI_LOCALE)
function setUiLocale(next: UiLocale | null) {
  if (!next || next === locale()) return
  uiLocale = next
  try {
    store?.saveLocale(next)
  } catch {
    /* read-only user data: the language lasts until the app quits */
  }
  buildMenu()
  win?.localeChanged({ locale: next, strings: STRINGS[next] })
}

// ----------------------------------------------------------- own screens

const UI_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

function serveUi(req: Request): Response {
  const u = new URL(req.url)
  let path: string
  try {
    path = decodeURIComponent(u.pathname)
  } catch {
    return new Response('not found', { status: 404 }) // malformed %-escape
  }
  if (path.includes('\0')) return new Response('not found', { status: 404 })
  const rel = normalize(path).replace(/^[/\\]+/, '')
  const root = join(DIST, 'ui')
  const file = join(root, rel)
  if (u.host !== 'app' || !file.startsWith(root + sep) || !UI_TYPES[extname(file)]) return new Response('not found', { status: 404 })
  try {
    return new Response(readFileSync(file), { headers: { 'content-type': UI_TYPES[extname(file)], 'content-security-policy': UI_CSP, 'x-content-type-options': 'nosniff' } })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

// ------------------------------------------------------------------- IPC

const fromShell = (e: IpcMainEvent | IpcMainInvokeEvent) => Boolean(win && e.sender === win.shell.webContents && e.senderFrame && isOwnUiUrl(e.senderFrame.url))
const fromChrome = (e: IpcMainEvent | IpcMainInvokeEvent) => Boolean(win && e.sender === win.chrome.webContents && e.senderFrame && isOwnUiUrl(e.senderFrame.url))
const fromHostbar = (e: IpcMainEvent | IpcMainInvokeEvent) => Boolean(win && e.sender === win.hostbar.webContents && e.senderFrame && isOwnUiUrl(e.senderFrame.url))
const fromFindBar = (e: IpcMainEvent | IpcMainInvokeEvent) => Boolean(win && e.sender === win.findBar.view.webContents && e.senderFrame && isOwnUiUrl(e.senderFrame.url))
const fromApp = (e: IpcMainEvent | IpcMainInvokeEvent) =>
  Boolean(
    win &&
      isTrustedAppSender(
        e.senderFrame ? { url: e.senderFrame.url, origin: e.senderFrame.origin, isTop: e.senderFrame.parent === null, isAppView: e.sender === win.app?.webContents } : null,
        win.allowedOrigins(),
      ),
  )

function registerIpc() {
  ipcMain.on('ui:strings', (e) => {
    const L = locale()
    e.returnValue = fromShell(e) || fromChrome(e) || fromHostbar(e) || fromFindBar(e) ? { locale: L, strings: STRINGS[L] } : null
  })
  // welcome / team list
  ipcMain.handle('ui:welcome-state', (e) => (fromShell(e) ? win!.welcomeState() : null))
  ipcMain.handle('ui:add-team', (e, address: string, confirmed: unknown) => (fromShell(e) ? win!.addTeam(String(address), confirmed === true) : null))
  // the first-run and create screens' links: the address is the app's own (common/create-team.ts createLinks, the Free
  // plan's terms as the console sent them), the screen only names which
  ipcMain.on('ui:open-link', (e, kind: unknown) => {
    if (!fromShell(e) || !consoleSignIn) return
    const links = createLinks({ macAppStore: storeScreens, console: consoleSignIn.origin })
    const v = createTeam?.view()
    const plan = v?.screen === 'name' ? v.plan : null
    const url = kind === 'demo' ? links.demo : kind === 'pricing' ? links.pricing : kind === 'console' && !storeScreens ? links.console : kind === 'terms' ? plan?.termsUrl : kind === 'privacy' ? plan?.privacyUrl
      // the sign-in screen's terms and privacy line: the console's own pages (also in the store build: no plans there)
      : kind === 'consoleTerms' ? links.console + APP_TERMS_PATH : kind === 'consolePrivacy' ? links.console + APP_PRIVACY_PATH : null
    if (url && (url.startsWith('https://') || url === links.console || url === links.console + APP_TERMS_PATH || url === links.console + APP_PRIVACY_PATH)) openExternal(url)
  })
  // the create screens (main/create-team.ts)
  ipcMain.on('ui:create-start', (e) => fromShell(e) && !storeScreens && createTeam?.start())
  ipcMain.on('ui:create-signin', (e) => fromShell(e) && createTeam?.signInAgain())
  ipcMain.on('ui:create-google', (e) => fromShell(e) && createTeam?.google())
  ipcMain.on('ui:create-send-code', (e, email: unknown) => fromShell(e) && typeof email === 'string' && void createTeam?.sendCode(email.slice(0, 300)))
  ipcMain.on('ui:create-verify', (e, code: unknown) => fromShell(e) && typeof code === 'string' && void createTeam?.verifyCode(code.slice(0, 20)))
  ipcMain.on('ui:create-other-email', (e) => fromShell(e) && createTeam?.otherEmail())
  ipcMain.on('ui:create-cancel', (e) => fromShell(e) && createTeam?.cancel())
  ipcMain.on('ui:create-submit', (e, name: unknown, slug: unknown, agreedAt: unknown) => {
    if (fromShell(e) && typeof name === 'string' && typeof slug === 'string' && typeof agreedAt === 'number') void createTeam?.submit(name.slice(0, 200), slug.slice(0, 60), agreedAt)
  })
  ipcMain.on('ui:create-act', (e, kind: unknown) => fromShell(e) && typeof kind === 'string' && void createTeam?.act(kind))
  // the host strip above the team's sign-in pages
  ipcMain.handle('ui:hostbar-state', (e) => (fromHostbar(e) ? win!.hostbarState() : null))
  ipcMain.on('ui:hostbar-teams', (e) => fromHostbar(e) && win!.showWelcome())
  // the find bar (Cmd/Ctrl+F): its text, next / previous, close (main/find-bar.ts)
  ipcMain.handle('ui:find-state', (e) => (fromFindBar(e) ? win!.findBar.state() : null))
  ipcMain.on('ui:find-query', (e, text: unknown) => fromFindBar(e) && typeof text === 'string' && win!.findBar.query(text))
  ipcMain.on('ui:find-step', (e, forward: unknown) => fromFindBar(e) && win!.findBar.step(forward !== false))
  ipcMain.on('ui:find-close', (e) => fromFindBar(e) && win!.findBar.close(true))
  ipcMain.handle('ui:remove-team', (e, id: string) => (fromShell(e) ? win!.removeTeam(String(id)) : null))
  ipcMain.on('ui:open-team', (e, id: string) => fromShell(e) && void win!.openTeam(String(id)))
  // screen ④: the person's answer for the host it showed (AppWindow.answerLink)
  ipcMain.handle('ui:link-answer', (e, yes: unknown, host: unknown) => (fromShell(e) ? win!.answerLink(yes === true, String(host ?? '')) : null))
  // Cancel while a sleeping trial team starts (AppWindow.cancelWake)
  ipcMain.on('ui:cancel-wake', (e) => fromShell(e) && win!.cancelWake())
  ipcMain.on('ui:link-shown', (e, id: unknown) => fromShell(e) && typeof id === 'number' && win!.linkShown(id))
  ipcMain.on('ui:back', (e) => fromShell(e) && win!.back())
  ipcMain.on('ui:set-locale', (e, l: unknown) => fromShell(e) && setUiLocale(asUiLocale(l)))
  ipcMain.on('ui:retry', (e) => fromShell(e) && win!.retry())
  ipcMain.on('ui:offline-left', (e) => fromShell(e) && win!.leftOffline())
  // pane toolbar
  ipcMain.handle('ui:pane-state', (e) => (fromChrome(e) ? (win!.pane?.state() ?? null) : null))
  ipcMain.on('ui:pane-navigate', (e, url: string) => fromChrome(e) && void win!.pane?.userNavigate(String(url)))
  ipcMain.on('ui:pane-history', (e, dir: string) => fromChrome(e) && (dir === 'back' || dir === 'forward' || dir === 'reload') && win!.pane?.userHistory(dir))
  ipcMain.on('ui:pane-new-tab', (e) => fromChrome(e) && void win!.pane?.newTab())
  ipcMain.on('ui:pane-select', (e, id: string) => fromChrome(e) && win!.pane?.selectTab(String(id)))
  ipcMain.on('ui:pane-close-tab', (e, id: string) => fromChrome(e) && win!.pane?.closeTab(String(id)))
  ipcMain.on('ui:pane-close', (e) => fromChrome(e) && win!.pane?.hide())
  // ↗ in the toolbar: the page on screen in the person's own browser (security.ts openExternal: http/https only)
  ipcMain.on('ui:pane-open-external', (e) => {
    const url = fromChrome(e) ? win!.pane?.externalUrl() : null
    if (url) openExternal(url)
  })
  ipcMain.on('ui:pane-stop', (e) => fromChrome(e) && win!.pane?.stop())
  ipcMain.on('ui:pane-answer', (e, a: { id?: string; decision?: string }) => {
    if (!fromChrome(e) || !a?.id) return
    win!.pane?.answer(String(a.id), a.decision === 'always' ? 'always' : a.decision === 'once' ? 'once' : 'deny')
  })
  ipcMain.on('ui:pane-toolbar-height', (e, h: number) => {
    if (!fromChrome(e) || !Number.isFinite(h)) return
    win!.pane?.setToolbarHeight(h)
    // the toolbar rendered: the browser may be drawn under it (AppWindow.chromeUp)
    win!.chromeUp()
  })
  // the edge handle between the team page and the browser (AppWindow.paneDrag / paneKey)
  ipcMain.handle('ui:pane-width', (e) => (fromChrome(e) ? win!.paneWidth() : null))
  ipcMain.on('ui:pane-drag', (e, phase: unknown, edgeX: unknown) => {
    if (!fromChrome(e) || (phase !== 'start' && phase !== 'move' && phase !== 'end' && phase !== 'reset')) return
    win!.paneDrag(phase, typeof edgeX === 'number' && Number.isFinite(edgeX) ? edgeX : undefined)
  })
  ipcMain.on('ui:pane-resize-key', (e, key: unknown, shift: unknown) => fromChrome(e) && typeof key === 'string' && win!.paneKey(key.slice(0, 20), shift === true))
  ipcMain.handle('ui:pane-sites', (e) => (fromChrome(e) ? (win!.pane?.siteSettings() ?? { always: [], privateAlways: [], siteAccess: 'ask', teamAllowsAll: true }) : null))
  // the person's own setting, in the desktop's own screen (the pane toolbar). The team page has its own narrow channels
  // below (Settings > Browser), where "all" needs the person's click on the app's own dialog. Either way the team's
  // policy is checked here: "all" is refused while the team does not allow it (pane.setSiteAccess).
  ipcMain.on('ui:pane-site-access', (e, v: unknown) => fromChrome(e) && win!.pane?.setSiteAccess(asSiteAccess(v)))
  ipcMain.on('ui:pane-site-remove', (e, host: string) => fromChrome(e) && win!.pane?.revokeSite(String(host)))
  ipcMain.on('ui:pane-sites-clear', (e) => fromChrome(e) && win!.pane?.revokeAllSites())

  // team page bridge (shared/src/desktop-bridge.ts); store: a Mac App Store or Microsoft Store build, where Settings >
  // Apps offers no installer
  ipcMain.on('bridge:info', (e) => {
    e.returnValue = fromApp(e) ? { global: DESKTOP_BRIDGE_GLOBAL, bridgeVersion: DESKTOP_BRIDGE_VERSION, appVersion: app.getVersion(), platform: process.platform, store: storeBuild(process), workFiles: workFilesVersion({ platform: process.platform, mas: process.mas }), workFilesWide: workFilesVersion({ platform: process.platform, mas: process.mas }) ? WORK_FILES_WIDE_VERSION : 0, downloads: !process.mas, localApps: process.mas ? 0 : LOCAL_APPS_BRIDGE_VERSION, dictation: process.mas ? 0 : dictation.version(), googleSignIn: GOOGLE_SIGNIN_BRIDGE_VERSION, paneVersion: BROWSER_BRIDGE_VERSION } : null
  })
  // voice input on this Mac (main/dictation.ts): the team page's top frame only; the sound comes in as samples, the
  // words go back to that page alone, and a reload or another page ends its recording
  const dictationLanguage = (v: unknown) => (typeof v === 'string' ? v.slice(0, 8) : '')
  ipcMain.handle('bridge:dictation-check', (e, lang: unknown) => (fromApp(e) && !process.mas ? dictation.check(dictationLanguage(lang)) : { state: 'unavailable' }))
  ipcMain.handle('bridge:dictation-install', (e, lang: unknown) => {
    if (!fromApp(e) || process.mas) return 'failed'
    const language = dictationLanguage(lang)
    const page = e.sender
    return dictation.install(language, (percent) => { if (!page.isDestroyed()) page.send('bridge:dictation-progress', { language, percent }) })
  })
  ipcMain.handle('bridge:dictation-start', async (e, lang: unknown) => {
    if (!fromApp(e) || process.mas) return null
    const page = e.sender
    if (dictationPage !== page) {
      dictationPage = page
      // both go once either fires (a page reloaded ten times keeps no stale listeners)
      const end = () => {
        page.off('destroyed', end)
        page.off('did-navigate', end)
        if (dictationPage === page) { dictation.stopAll(); dictationPage = null }
      }
      page.once('destroyed', end)
      page.once('did-navigate', end)
    }
    return dictation.start(dictationLanguage(lang))
  })
  // a refused microphone is turned on again in System Settings (a fixed address; the page names nothing)
  ipcMain.on('bridge:mic-settings', (e) => { if (fromApp(e) && process.platform === 'darwin') void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone').catch(() => {}) })
  ipcMain.on('bridge:dictation-push', (e, id: unknown, samples: unknown) => fromApp(e) && e.sender === dictationPage && typeof id === 'number' && samples instanceof Float32Array && dictation.push(id, samples))
  ipcMain.on('bridge:dictation-stop', (e, id: unknown) => fromApp(e) && e.sender === dictationPage && typeof id === 'number' && dictation.stop(id))
  ipcMain.on('bridge:dictation-cancel', (e, id: unknown) => fromApp(e) && e.sender === dictationPage && typeof id === 'number' && dictation.cancel(id))
  ipcMain.handle('bridge:browser-run', async (e, raw: unknown) => {
    const call = BrowserCall.safeParse(raw)
    const callId = typeof (raw as { callId?: unknown })?.callId === 'string' ? (raw as { callId: string }).callId.slice(0, 100) : 'invalid'
    if (!fromApp(e)) return errorResult(callId, 'The browser pane is not available to this page.')
    if (!call.success) return errorResult(callId, 'Malformed browser call.')
    if (!win!.pane) return errorResult(call.data.callId, 'The browser pane is not available (no team is open).')
    const pane = win!.pane
    // the pane's data must belong to the person signed in now (common/browser-owner.ts)
    if (!(await win!.ensureBrowserOwner().catch(() => false))) return errorResult(call.data.callId, 'The browser identity could not be verified. Sign in and try again.')
    if (!fromApp(e) || win!.pane !== pane) return errorResult(call.data.callId, 'The browser pane changed while identity was checked. Try again.')
    return pane.run(call.data)
  })
  ipcMain.on('bridge:browser-cancel', (e, callId: string) => fromApp(e) && win!.pane?.cancel(String(callId)))
  // apps on this computer (main/local-apps.ts): only the open team's page, for that team; the app's own dialog asks
  // before a command runs, and the page never answers it
  ipcMain.handle('bridge:local-run', async (e, raw: unknown): Promise<LocalResult> => {
    const callId = typeof (raw as { callId?: unknown })?.callId === 'string' ? (raw as { callId: string }).callId.slice(0, 100) : 'invalid'
    const team = fromApp(e) ? win?.team?.id : undefined
    if (!team || !localApps) return { callId, ok: false, failure: 'not_desktop', error: 'no team is open in the desktop app' }
    const call = LocalCall.safeParse(raw)
    if (!call.success) return { callId, ok: false, failure: 'failed', error: 'malformed call' }
    return localApps.apps.call(team, call.data)
  })
  ipcMain.on('bridge:local-cancel', (e, callId: unknown) => fromApp(e) && typeof callId === 'string' && localApps?.apps.cancel(callId.slice(0, 100)))
  ipcMain.on('bridge:local-stop', (e, id: unknown) => {
    const team = fromApp(e) ? win?.team?.id : undefined
    if (team && typeof id === 'string') localApps?.apps.stop(team, id.slice(0, 100))
  })
  ipcMain.handle('bridge:local-running', (e) => { const team = fromApp(e) ? win?.team?.id : undefined; return team && localApps ? localApps.apps.runningIds(team) : [] })
  ipcMain.handle('bridge:local-settings', (e, id: unknown, values: unknown) => { const team = fromApp(e) ? win?.team?.id : undefined; return team && localApps ? localApps.setSettings(team, id, values) : 'unavailable' })
  ipcMain.handle('bridge:local-setting-names', (e, id: unknown) => { const team = fromApp(e) ? win?.team?.id : undefined; return team && localApps ? localApps.settingNames(team, id) : [] })
  // Settings › Connectors' "Programs connected on this computer": the ids confirmed for this team, and Remove (the next
  // call asks again); never a value or a command
  ipcMain.handle('bridge:local-connected', (e) => { const team = fromApp(e) ? win?.team?.id : undefined; return team && localApps ? localApps.connected(team) : [] })
  ipcMain.handle('bridge:local-forget', (e, id: unknown) => { const team = fromApp(e) ? win?.team?.id : undefined; return team && localApps ? localApps.forget(team, id) : false })
  ipcMain.on('bridge:pane', (e, what: string) => {
    if (!fromApp(e) || !win?.pane) return
    // the team page's Browser entry: the person's own (common/keyboard-focus.ts keyboardTaken)
    if (what === 'open' || what === 'close' || what === 'toggle') win.paneByPerson(what)
  })
  ipcMain.handle('bridge:pane-state', (e) => (fromApp(e) ? win!.paneStateForPage() : null))
  ipcMain.handle('bridge:connection', (e) => (fromApp(e) ? win!.connection() : null))
  ipcMain.on('bridge:notify', (e, n: { title?: string; body?: string; tag?: unknown; open?: unknown; read?: unknown }) => fromApp(e) && win!.notify({ title: String(n?.title ?? ''), body: String(n?.body ?? ''), tag: n?.tag, open: n?.open, read: n?.read }))
  // Settings › Notifications' "Test notification": shown while focused too, with the app's own words (the page gives
  // none), a few a minute apart from the others; the answer says whether the system took it ('off': notifications are
  // off for the app in the system's settings)
  ipcMain.handle('bridge:notify-test', (e) => (fromApp(e) ? win!.testNotify() : 'unsupported'))
  // session markers (docs/DECISIONS.md): the dock shows how many chats and rooms want the person, at 0 a dot while rooms
  // have unread messages the number does not count (macOS; Windows has no count). setBadgeCount(0) clears the dot too:
  // both set the Dock's one label.
  ipcMain.on('bridge:badge', (e, n: unknown, dot: unknown) => {
    if (!fromApp(e) || process.platform !== 'darwin') return
    const badge = dockBadgeOf(n, dot)
    if (badge === DOCK_DOT) app.dock?.setBadge(DOCK_DOT)
    else app.setBadgeCount(badge)
  })
  ipcMain.handle('bridge:focus', (e) => (fromApp(e) ? win!.teamFocused() : false))
  ipcMain.on('bridge:open-teams', (e) => fromApp(e) && win!.showWelcome())
  // the team page's "다른 팀으로 전환" from a page that still asks for the menu under the pointer (team servers before
  // 2026-11-15): the app's own team screen as well. The floating menu over the rail is gone (owner 2026-11-15); the OS
  // menu's 팀 keeps every team and ⌘1–9.
  ipcMain.on('bridge:team-menu', (e) => fromApp(e) && win!.showWelcome())
  // the team page draws the address and "Switch team" under its sign-in card: no strip above it there
  ipcMain.on('bridge:host-line', (e, drawn: unknown) => fromApp(e) && win?.setPageHostLine(drawn === true))
  ipcMain.on('bridge:set-locale', (e, l: unknown) => fromApp(e) && setUiLocale(asUiLocale(l)))
  // 이미지 복사 (the image viewer, a picture's right-click menu): the PNG the page read through its own file routes goes on
  // the computer's clipboard as a picture; nothing is fetched here. Bytes that are no PNG the system can draw: false
  ipcMain.handle('bridge:copy-image', async (e, bytes: unknown) => {
    const png = fromApp(e) ? clipboardPng(bytes) : null
    if (!png || nativeImage.createFromBuffer(Buffer.from(png.buffer, png.byteOffset, png.byteLength)).isEmpty()) return false
    try {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as BlobPart], { type: 'image/png' }) })])
      return true
    } catch {
      return false
    }
  })
  // the look chosen on the team page (Settings: light, dark or system) becomes the whole app's look (themeSource): the
  // app's own screens (the browser toolbar's ui.css) and the window's colour follow it, and so do the sites open in the
  // in-app browser: their prefers-color-scheme is now the app's theme, not the computer's. Only the team page may set it
  ipcMain.on('bridge:set-theme', (e, t: unknown) => {
    if (fromApp(e) && (t === 'light' || t === 'dark' || t === 'system') && nativeTheme.themeSource !== t) nativeTheme.themeSource = t
  })
  // the welcome steps' team files: the folder picked last gave nothing to read; 'mac-blocked' when macOS privacy kept the
  // app out of it (a word, never the error's text)
  // downloads with no save window: the page says it shows the notice, and asks for a saved file by its number only
  ipcMain.on('bridge:downloads-ready', (e) => fromApp(e) && win!.downloads.pageReady(e.sender))
  ipcMain.on('bridge:download-show', (e, id: unknown) => fromApp(e) && typeof id === 'number' && Number.isSafeInteger(id) && win!.downloads.show(id))
  ipcMain.handle('bridge:folder-problem', (e, name: unknown) => (fromApp(e) && e.senderFrame ? win!.folderProblem(e.senderFrame.origin, String(name ?? '').slice(0, 1024)) : null))

  // "Find work files on this computer" (main/work-files.ts): the page only asks; the app shows its own dialog, looks in
  // this process and hands out ids, never paths. A read takes an id of the latest look of the asking origin only.
  // part 5: the page may ask for the wide look and give the company's names (a flag and short words, never a path);
  // the app decides what it can see and lists every place in its own dialog first
  ipcMain.handle('bridge:work-files-scan', (e, ask: unknown) => (fromApp(e) && e.senderFrame ? win!.workFiles.scan(e.senderFrame.origin, scanAsk(ask)) : { state: 'unavailable' }))
  // part 5, a Mac: Full Disk Access (a probe that reads nothing), its Settings pane, a restart
  ipcMain.handle('bridge:work-files-full-disk', (e) => (fromApp(e) ? win!.workFiles.fullDisk() : 'unknown'))
  ipcMain.on('bridge:work-files-full-disk-settings', (e) => fromApp(e) && win!.workFiles.openFullDiskSettings())
  ipcMain.on('bridge:work-files-relaunch', (e) => { if (fromApp(e)) void win!.workFiles.relaunch() })
  ipcMain.on('bridge:work-files-stop', (e) => fromApp(e) && win!.workFiles.stop())
  // TC-3300: the files the person ticked, asked again in the app's own window before any is read (ids only, never a path)
  ipcMain.handle('bridge:work-files-add', (e, ids: unknown) => (fromApp(e) && e.senderFrame && Array.isArray(ids) && ids.length <= 100 && ids.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) ? win!.workFiles.add(e.senderFrame.origin, ids as string[]) : { state: 'refused' }))
  // a file coming from its cloud first: the page hears so while it waits (bridge:work-files-reading, to the asking frame)
  const readWorkFile = (frame: Electron.WebFrameMain, fileId: string) =>
    win!.workFiles.read(frame.origin, fileId, (cloud) => { try { if (!frame.isDestroyed() && !frame.detached) frame.send('bridge:work-files-reading', { id: fileId, cloud }) } catch { /* the page is gone */ } })
  ipcMain.handle('bridge:work-files-read', (e, id: unknown) => (fromApp(e) && e.senderFrame ? readWorkFile(e.senderFrame, String(id ?? '').slice(0, 100)) : { ok: false, reason: 'unknown' }))
  ipcMain.on('bridge:work-files-settings', (e) => fromApp(e) && win!.workFiles.openSettings())
  // "Choose it yourself": a folder macOS kept the app out of, picked in the system's folder window (only a root's id)
  ipcMain.handle('bridge:work-files-pick', (e, id: unknown) => (fromApp(e) && e.senderFrame && (id === 'documents' || id === 'desktop' || id === 'downloads') ? win!.workFiles.pickRoot(e.senderFrame.origin, id) : { state: 'unavailable' }))
  // "Choose a folder…" (MAN-057): any folder the person picks in the system's folder window, after a look (no path from the page)
  ipcMain.handle('bridge:work-files-pick-folder', (e) => (fromApp(e) && e.senderFrame ? win!.workFiles.pickFolder(e.senderFrame.origin) : { state: 'unavailable' }))

  // Settings > Browser on the team page (shared/src/desktop-bridge.ts DesktopBrowserSettings): read the setting, go
  // back to asking, remove one always-allowed site, clear them all. Nothing here makes the browser more open: "all" is
  // only a request, committed by the person's click on the app's own dialog (AppWindow.requestAllowAll).
  // a connector sign-in's return address: only for the team page's top frame at the team's own address (not its pinned
  // direct one), and it goes only there (common/sign-in-return.ts)
  ipcMain.handle('bridge:sign-in-return-open', (e) => (fromApp(e) && e.senderFrame && e.senderFrame.origin === win?.team?.origin ? signInReturn.open(e.senderFrame.origin) : null))
  ipcMain.on('bridge:sign-in-return-close', (e, port: unknown) => fromApp(e) && typeof port === 'number' && signInReturn.close(port))
  ipcMain.handle('bridge:browser-settings', (e) => (fromApp(e) ? (win!.browserSettings() ?? null) : null))
  ipcMain.handle('bridge:browser-access', async (e, v: unknown): Promise<AllowAllOutcome> => {
    if (!fromApp(e) || !win?.pane) return 'unavailable'
    if (v === 'ask') return win.pane.siteSettings().siteAccess === 'ask' ? 'unchanged' : (win.pane.setSiteAccess('ask'), 'changed')
    if (v === 'all') return win.requestAllowAll()
    return 'unavailable'
  })
  ipcMain.handle('bridge:browser-site-remove', (e, host: unknown) => {
    if (!fromApp(e) || !win?.pane) return null
    const s = win.pane.siteSettings()
    // only a host that is in the list (no other effect possible, but nothing unchecked reaches the store)
    if (typeof host === 'string' && host.length <= 300 && (s.always.includes(host) || s.privateAlways.includes(host))) win.pane.revokeSite(host)
    return win.pane.siteSettings()
  })
  ipcMain.handle('bridge:browser-sites-clear', (e) => {
    if (!fromApp(e) || !win?.pane) return null
    win.pane.revokeAllSites()
    return win.pane.siteSettings()
  })
}

// ------------------------------------------------------------------ menu

/** The OS menu's 팀 items: every team (⌘1–9, the open one ticked), then "팀 목록…" (add a team). */
function teamMenuItems(): MenuItemConstructorOptions[] {
  const tr = (k: UiKey) => t(locale(), k)
  const teamItems: MenuItemConstructorOptions[] = (win?.teamList() ?? []).map((x, i) => ({
    label: x.label,
    type: 'radio',
    checked: x.id === win?.team?.id,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: () => void win?.openTeam(x.id),
  }))
  return [...teamItems, ...(teamItems.length ? [{ type: 'separator' as const }] : []), { label: tr('menu.teams'), click: () => win?.showWelcome() }]
}

function buildMenu() {
  const L = locale()
  const tr = (k: UiKey) => t(L, k)
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ label: PRODUCT.displayName, submenu: [{ role: 'about' as const, label: tr('menu.about') }, { type: 'separator' as const }, { role: 'hide' as const, label: tr('menu.hide') }, { role: 'hideOthers' as const, label: tr('menu.hideOthers') }, { role: 'unhide' as const, label: tr('menu.showAll') }, { type: 'separator' as const }, { role: 'quit' as const, label: tr('menu.quit') }] }]
      : []),
    // every item carries its label from the app's own strings: a role's default label follows the OS language,
    // which would mix two languages in one menu (docs/DECISIONS.md "언어")
    { label: tr('menu.edit'), submenu: [{ role: 'undo', label: tr('menu.undo') }, { role: 'redo', label: tr('menu.redo') }, { type: 'separator' }, { role: 'cut', label: tr('menu.cut') }, { role: 'copy', label: tr('menu.copy') }, { role: 'paste', label: tr('menu.paste') }, { role: 'selectAll', label: tr('menu.selectAll') },
      // the find bar over the screen in front (main/find-bar.ts); a page that takes Cmd/Ctrl+F itself keeps it: the menu
      // only gets a key the page left (common/find-bar.ts)
      { type: 'separator' },
      { id: 'find', label: tr('menu.find'), accelerator: 'CmdOrCtrl+F', click: () => win?.find('open') },
      { id: 'find-next', label: tr('menu.findNext'), accelerator: 'CmdOrCtrl+G', click: () => win?.find('next') },
      { id: 'find-prev', label: tr('menu.findPrev'), accelerator: 'Shift+CmdOrCtrl+G', click: () => win?.find('prev') }] },
    {
      label: tr('menu.view'),
      submenu: [
        { label: tr('menu.reload'), accelerator: 'CmdOrCtrl+R', click: () => win?.app?.webContents.reload() },
        { label: tr('menu.browser'), accelerator: 'CmdOrCtrl+Shift+B', click: () => win?.paneByPerson('toggle') },
        { type: 'separator' },
        { role: 'resetZoom', label: tr('menu.actualSize') },
        { role: 'zoomIn', label: tr('menu.zoomIn') },
        { role: 'zoomOut', label: tr('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: tr('menu.fullScreen') },
        ...(dev ? [{ label: tr('menu.devtools'), accelerator: 'Alt+CmdOrCtrl+I', click: () => win?.app?.webContents.toggleDevTools() } as MenuItemConstructorOptions] : []),
      ],
    },
    // one item for the list and adding a team: both were the same screen
    { label: tr('menu.team'), submenu: teamMenuItems() },
    // a downloaded update (Windows, Mac): installs on quit or by itself when idle, or now from here
    ...(updater.ready ? [{ label: tr('update.ready.menu'), click: () => { updater.restartNow() } }] : []),
    {
      label: tr('menu.window'),
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: tr('menu.minimize') },
        ...(process.platform === 'darwin'
          ? [{ role: 'zoom' as const, label: tr('menu.zoom') }, { type: 'separator' as const }, { role: 'front' as const, label: tr('menu.front') }]
          : [{ role: 'close' as const, label: tr('menu.close') },
              // no tray: closing the last window quits, and Linux had no other way to say Quit (Windows: Alt+F4)
              ...(process.platform === 'linux' ? [{ type: 'separator' as const }, { role: 'quit' as const, label: tr('menu.quit'), accelerator: 'Ctrl+Q' }] : [])]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ------------------------------------------------------------- lifecycle

async function createWindow() {
  store = new TeamsStore(app.getPath('userData'))
  localApps ??= new LocalAppsHost({
    userData: app.getPath('userData'),
    parent: () => (win && !win.win.isDestroyed() ? win.win : null),
    locale,
    teamLabel: (team) => win?.teamList().find((x) => x.id === team)?.label ?? '',
    // Settings shows whether the program runs now: told to the open team's page
    onChange: (team, id, running) => { if (win?.team?.id === team && win.app && !win.app.webContents.isDestroyed()) win.app.webContents.send('bridge:local-running', { id, running }) },
    // Connect pressed after the check stopped waiting: the open team's page checks the connection again
    onConfirmed: (team, id) => { if (win?.team?.id === team && win.app && !win.app.webContents.isDestroyed()) win.app.webContents.send('bridge:local-confirmed', { id }) },
    // the confirm opened or closed: the open team's page says so while it waits (it can sit behind other windows)
    onAsking: (team, s) => { if (win?.team?.id === team && win.app && !win.app.webContents.isDestroyed()) win.app.webContents.send('bridge:local-asking', s) },
  })
  consoleSignIn ??= new ConsoleSignIn({
    origin: consoleOrigin({ packaged: app.isPackaged, env: process.env }),
    userData: app.getPath('userData'),
    fetch: (url, init) => net.fetch(url, init),
    openExternal,
    locale,
    donePage: () => t(locale(), 'create.browserDone'),
  })
  const signin = consoleSignIn
  createTeam ??= new CreateTeam({
    signin,
    store: storeScreens,
    userData: app.getPath('userData'),
    locale,
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    changed: () => win?.createChanged(createTeam?.view().screen !== 'off'),
    openTeam: async (origin, label, path) => { await win?.openCreatedTeam(origin, label, path) },
    pollMs: dev && Number(process.env.MYCEL_DESKTOP_TEST_CREATE_POLL_MS) > 0 ? Number(process.env.MYCEL_DESKTOP_TEST_CREATE_POLL_MS) : undefined,
  })
  const create = createTeam
  // whether the console offers "Create a team for free" (asked once without a token; asked again later while unknown)
  // An unknown answer (offline at start, a slow network, a portal's redirect) is asked again by itself until the
  // console answers, and the first screen changes when it does: before, one failed ask at start left the old
  // "Join your team" screen until the app restarted (live QA of 0.20.0). Nothing waits on it.
  const retryMs = dev && Number(process.env.MYCEL_DESKTOP_TEST_OFFER_RETRY_MS) > 0 ? [Number(process.env.MYCEL_DESKTOP_TEST_OFFER_RETRY_MS)] : [2000, 5000, 15_000, 30_000, 60_000]
  let offerTries = 0
  let offerTimer: NodeJS.Timeout | undefined
  let offerAsked = false
  // quitting: no more asks (a request started while the app writes its cookies held the quit back)
  let offerStopped = false
  app.once('before-quit', () => { offerStopped = true; clearTimeout(offerTimer) })
  const askOffer = (fresh: boolean) => {
    if (offerStopped) return
    const before = signin.knownOffer()
    void signin.probe(fresh).then((v) => {
      if (v !== before) win?.createChanged(false)
      clearTimeout(offerTimer)
      if (v !== 'unknown' || offerStopped) return
      offerTimer = setTimeout(() => askOffer(true), retryMs[Math.min(offerTries++, retryMs.length - 1)])
      offerTimer.unref?.()
    })
  }
  const offer = () => {
    if (!offerAsked) {
      offerAsked = true
      askOffer(false)
    }
    return signin.knownOffer() ?? 'checking'
  }
  // the app restarted by itself to install an update: the page and window come back as they were (once)
  const resume = takeResume(app.getPath('userData'))
  win = new AppWindow({
    store,
    locale,
    distDir: DIST,
    pageScript: readFileSync(join(DIST, 'page-script.js'), 'utf8'),
    appVersion: app.getVersion(),
    classifier: new HostClassifier(testPublic, testMapped),
    suggestedTeam: kit.team,
    answerFileChoosers: answersFileChoosers(process.mas === true, app.isPackaged, process.env.MYCEL_DESKTOP_TEST_FILE_CHOOSER),
    macAppStore: storeScreens,
    createView: () => create.view(),
    createOffer: offer,
    // the Mac App Store build may not write to Downloads without the save window: it keeps the window
    downloadsDir: () => (process.mas ? null : (!app.isPackaged && process.env.MYCEL_DESKTOP_TEST_DOWNLOADS) || app.getPath('downloads')),
    onTeamsChanged: () => buildMenu(),
    quietStart: resume?.window,
  })
  win.win.on('closed', () => {
    // quitting closes the window before will-quit: keep which team it showed (its cookies are written on quit)
    lastTeam = win?.team?.id ?? lastTeam
    win = undefined
    signInReturn.close()
  })
  buildMenu()
  const initial = dev ? process.env.MYCEL_DESKTOP_TEAM : undefined
  // set by the developer for this run: no "not run by us" question
  if (initial) await win.addTeam(initial, true)
  // a team was being made when the app closed: back to its starting screen ("You can close the app")
  else if (create.pending()) {
    win.showWelcome()
    create.start()
  } else if (await win.openLast(resume?.page ?? null, launchLink)) launchLink = null
  if (launchLink) {
    const link = launchLink
    launchLink = null
    win.offerLink(link)
  }
}

// write cookies of the open team (page and browser) to disk before quitting. The window is already closed by
// will-quit (Cmd+Q, Quit, the last window on Windows), so the team is the one it showed last (lastTeam).
let flushed = false
let lastTeam: string | undefined

// only the app that holds the lock
if (primary) {
  app.whenReady().then(async () => {
    const uiSes = session.fromPartition('mycel-ui')
    uiSes.protocol.handle(UI_SCHEME, serveUi)
    for (const s of [uiSes, session.defaultSession]) {
      s.setPermissionRequestHandler((_wc, _p, done) => done(false))
      s.setPermissionCheckHandler(() => false)
    }
    // nothing in this app may create <webview> or open windows on its own
    app.on('web-contents-created', (_e, wc) => {
      wc.on('will-attach-webview', (ev) => ev.preventDefault())
    })
    registerIpc()
    await createWindow()
    updater.start()
    // still the old version after the update was installed twice on quit: one plain line with the download page
    if (updateFailed) void updater.offerDownload(updateFailed)
  })

  app.on('second-instance', (_e, argv) => {
    if (win && !win.win.isDestroyed()) {
      if (win.win.isMinimized()) win.win.restore()
      win.win.focus()
    }
    // Windows and Linux: a link opens a second instance with the link as an argument
    const link = linkFromArgv(argv)
    linkLog('second-instance', link)
    if (link) onLink(link)
  })
  app.on('activate', () => {
    if (!win) void createWindow()
  })
  // write cookies of the open team (page and browser) to disk before quitting (lastTeam, flushed: above)
  app.on('before-quit', () => { debug('before-quit'); localApps?.apps.stopAll(); dictation.stopAll() })
  app.on('will-quit', (e) => {
    debug('will-quit', flushed)
    // every program an app on this computer started ends with the app: asked to stop first (before-quit, and here),
    // killed on the last pass, after which no timer of the app runs to finish one that ignored it
    localApps?.apps.stopAll(undefined, flushed)
    if (flushed) return
    e.preventDefault()
    const id = win?.team?.id ?? lastTeam
    const sessions = id ? [session.fromPartition(partitionFor(id, 'app')), session.fromPartition(partitionFor(id, 'browser'))] : []
    debug('flushing cookies of', id ?? 'no team')
    void Promise.race([Promise.all(sessions.map((s) => s.cookies.flushStore().catch(() => {}))), new Promise((r) => setTimeout(r, 2000))]).finally(() => {
      flushed = true
      // quit again from a new task: a quit asked while Electron still handles the one just held back is ignored (the
      // first Cmd+Q only closed the window)
      setTimeout(() => app.quit(), 0)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
