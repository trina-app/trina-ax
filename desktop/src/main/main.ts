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
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { app, Menu, protocol, session, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, type MenuItemConstructorOptions } from 'electron'
import { DESKTOP_BRIDGE_GLOBAL, DESKTOP_BRIDGE_VERSION, PRODUCT } from '@mycel/shared'
import { BrowserCall } from '@mycel/shared/api'
import { errorResult } from '../common/browser-result'
import { asUiLocale, DEFAULT_UI_LOCALE, STRINGS, t, type UiKey, type UiLocale } from '../common/i18n'
import { isOwnUiUrl, isTrustedAppSender, UI_SCHEME } from '../common/trust'
import { partitionFor } from '../common/teams'
import { NO_KIT, parseKit, type Kit } from '../common/kit'
import { AppWindow, type AllowAllOutcome } from './app-window'
import { debug } from './debug'
import { HostClassifier } from './pane/classify'
import { asSiteAccess } from '../common/site-permissions'
import { TeamsStore } from './teams-store'
import { DesktopUpdater } from './updater'

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
// the settings folder keeps its first name (PRODUCT.desktopDataDir) when the product is renamed: Electron would
// otherwise take the new name and every desk would forget its teams, window and language
app.setPath('userData', process.env.MYCEL_DESKTOP_USER_DATA || join(app.getPath('appData'), PRODUCT.desktopDataDir))

// Sandboxed srcdoc frames (artifacts, previews) stay in the team page's renderer process, so the page-level
// document-start script that removes RTCPeerConnection reaches them before their own scripts run. Electron's
// debugger cannot pause a new out-of-process frame, so an isolated sandboxed frame would run first (tested).
// Trade-off recorded in docs/DECISIONS.md: origin isolation (opaque origin, CSP) stays; process isolation of
// sandboxed frames is given up.
app.commandLine.appendSwitch('disable-features', 'IsolateSandboxedIframes')

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

if (!app.requestSingleInstanceLock()) app.quit()

let win: AppWindow | undefined
const updater = new DesktopUpdater({
  team: () => (win?.team && win.app ? { id: win.team.id, origin: win.team.origin } : null),
  window: () => win?.win ?? null,
  locale: () => locale(),
  openApps: () => {
    const origin = win?.team?.origin
    if (origin && win?.app) void win.app.webContents.loadURL(`${origin}/settings/apps`)
  },
  changed: () => buildMenu(),
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
const fromApp = (e: IpcMainEvent | IpcMainInvokeEvent) =>
  Boolean(
    win &&
      isTrustedAppSender(
        e.senderFrame ? { url: e.senderFrame.url, isTop: e.senderFrame.parent === null, isAppView: e.sender === win.app?.webContents } : null,
        win.allowedOrigins(),
      ),
  )

function registerIpc() {
  ipcMain.on('ui:strings', (e) => {
    const L = locale()
    e.returnValue = fromShell(e) || fromChrome(e) ? { locale: L, strings: STRINGS[L] } : null
  })
  // welcome / team list
  ipcMain.handle('ui:welcome-state', (e) => (fromShell(e) ? win!.welcomeState() : null))
  ipcMain.handle('ui:add-team', (e, address: string) => (fromShell(e) ? win!.addTeam(String(address)) : null))
  ipcMain.handle('ui:remove-team', (e, id: string) => (fromShell(e) ? win!.removeTeam(String(id)) : null))
  ipcMain.on('ui:open-team', (e, id: string) => fromShell(e) && void win!.openTeam(String(id)))
  ipcMain.on('ui:back', (e) => fromShell(e) && win!.back())
  ipcMain.on('ui:set-locale', (e, l: unknown) => fromShell(e) && setUiLocale(asUiLocale(l)))
  ipcMain.on('ui:retry', (e) => fromShell(e) && win!.retry())
  // pane toolbar
  ipcMain.handle('ui:pane-state', (e) => (fromChrome(e) ? (win!.pane?.state() ?? null) : null))
  ipcMain.on('ui:pane-navigate', (e, url: string) => fromChrome(e) && void win!.pane?.userNavigate(String(url)))
  ipcMain.on('ui:pane-history', (e, dir: string) => fromChrome(e) && (dir === 'back' || dir === 'forward' || dir === 'reload') && win!.pane?.userHistory(dir))
  ipcMain.on('ui:pane-new-tab', (e) => fromChrome(e) && void win!.pane?.newTab())
  ipcMain.on('ui:pane-select', (e, id: string) => fromChrome(e) && win!.pane?.selectTab(String(id)))
  ipcMain.on('ui:pane-close-tab', (e, id: string) => fromChrome(e) && win!.pane?.closeTab(String(id)))
  ipcMain.on('ui:pane-close', (e) => fromChrome(e) && win!.pane?.hide())
  ipcMain.on('ui:pane-stop', (e) => fromChrome(e) && win!.pane?.stop())
  ipcMain.on('ui:pane-answer', (e, a: { id?: string; decision?: string }) => {
    if (!fromChrome(e) || !a?.id) return
    win!.pane?.answer(String(a.id), a.decision === 'always' ? 'always' : a.decision === 'once' ? 'once' : 'deny')
  })
  ipcMain.on('ui:pane-toolbar-height', (e, h: number) => fromChrome(e) && Number.isFinite(h) && win!.pane?.setToolbarHeight(h))
  ipcMain.on('ui:pane-resize', (e, screenX: number) => fromChrome(e) && Number.isFinite(screenX) && win!.setPaneFromScreenX(screenX))
  ipcMain.handle('ui:pane-sites', (e) => (fromChrome(e) ? (win!.pane?.siteSettings() ?? { always: [], privateAlways: [], siteAccess: 'ask', teamAllowsAll: true }) : null))
  // the person's own setting, in the desktop's own screen (the pane toolbar). The team page has its own narrow channels
  // below (Settings > Browser), where "all" needs the person's click on the app's own dialog. Either way the team's
  // policy is checked here: "all" is refused while the team does not allow it (pane.setSiteAccess).
  ipcMain.on('ui:pane-site-access', (e, v: unknown) => fromChrome(e) && win!.pane?.setSiteAccess(asSiteAccess(v)))
  ipcMain.on('ui:pane-site-remove', (e, host: string) => fromChrome(e) && win!.pane?.revokeSite(String(host)))
  ipcMain.on('ui:pane-sites-clear', (e) => fromChrome(e) && win!.pane?.revokeAllSites())

  // team page bridge (shared/src/desktop-bridge.ts); store: a Mac App Store build, where Settings > Apps offers no installer
  ipcMain.on('bridge:info', (e) => {
    e.returnValue = fromApp(e) ? { global: DESKTOP_BRIDGE_GLOBAL, bridgeVersion: DESKTOP_BRIDGE_VERSION, appVersion: app.getVersion(), platform: process.platform, store: process.mas === true } : null
  })
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
  ipcMain.on('bridge:pane', (e, what: string) => {
    if (!fromApp(e) || !win?.pane) return
    if (what === 'open') win.pane.show()
    else if (what === 'close') win.pane.hide()
    else if (what === 'toggle') win.pane.toggle()
  })
  ipcMain.handle('bridge:pane-state', (e) => (fromApp(e) ? (win!.pane?.state() ?? null) : null))
  ipcMain.handle('bridge:connection', (e) => (fromApp(e) ? win!.connection() : null))
  ipcMain.on('bridge:notify', (e, n: { title?: string; body?: string }) => fromApp(e) && win!.notify({ title: String(n?.title ?? ''), body: String(n?.body ?? '') }))
  ipcMain.on('bridge:open-teams', (e) => fromApp(e) && win!.showWelcome())
  ipcMain.on('bridge:set-locale', (e, l: unknown) => fromApp(e) && setUiLocale(asUiLocale(l)))

  // Settings > Browser on the team page (shared/src/desktop-bridge.ts DesktopBrowserSettings): read the setting, go
  // back to asking, remove one always-allowed site, clear them all. Nothing here makes the browser more open: "all" is
  // only a request, committed by the person's click on the app's own dialog (AppWindow.requestAllowAll).
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

function buildMenu() {
  const L = locale()
  const tr = (k: UiKey) => t(L, k)
  const teams = win?.teamList() ?? []
  const teamItems: MenuItemConstructorOptions[] = teams.map((x, i) => ({
    label: x.label,
    type: 'radio',
    checked: x.id === win?.team?.id,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: () => void win?.openTeam(x.id),
  }))
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ label: PRODUCT.displayName, submenu: [{ role: 'about' as const, label: tr('menu.about') }, { type: 'separator' as const }, { role: 'hide' as const, label: tr('menu.hide') }, { role: 'hideOthers' as const, label: tr('menu.hideOthers') }, { role: 'unhide' as const, label: tr('menu.showAll') }, { type: 'separator' as const }, { role: 'quit' as const, label: tr('menu.quit') }] }]
      : []),
    // every item carries its label from the app's own strings: a role's default label follows the OS language,
    // which would mix two languages in one menu (docs/DECISIONS.md "언어")
    { label: tr('menu.edit'), submenu: [{ role: 'undo', label: tr('menu.undo') }, { role: 'redo', label: tr('menu.redo') }, { type: 'separator' }, { role: 'cut', label: tr('menu.cut') }, { role: 'copy', label: tr('menu.copy') }, { role: 'paste', label: tr('menu.paste') }, { role: 'selectAll', label: tr('menu.selectAll') }] },
    {
      label: tr('menu.view'),
      submenu: [
        { label: tr('menu.reload'), accelerator: 'CmdOrCtrl+R', click: () => win?.app?.webContents.reload() },
        { label: tr('menu.browser'), accelerator: 'CmdOrCtrl+Shift+B', click: () => win?.pane?.toggle() },
        { type: 'separator' },
        { role: 'resetZoom', label: tr('menu.actualSize') },
        { role: 'zoomIn', label: tr('menu.zoomIn') },
        { role: 'zoomOut', label: tr('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: tr('menu.fullScreen') },
        ...(dev ? [{ label: tr('menu.devtools'), accelerator: 'Alt+CmdOrCtrl+I', click: () => win?.app?.webContents.toggleDevTools() } as MenuItemConstructorOptions] : []),
      ],
    },
    { label: tr('menu.team'), submenu: [...teamItems, ...(teamItems.length ? [{ type: 'separator' as const }] : []), { label: tr('menu.addTeam'), click: () => win?.showWelcome() }, { label: tr('menu.teams'), click: () => win?.showWelcome() }] },
    // a downloaded update (Windows): installs on quit, or now from here
    ...(updater.ready ? [{ label: tr('update.ready.menu'), click: () => updater.restartNow() }] : []),
    {
      label: tr('menu.window'),
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: tr('menu.minimize') },
        ...(process.platform === 'darwin'
          ? [{ role: 'zoom' as const, label: tr('menu.zoom') }, { type: 'separator' as const }, { role: 'front' as const, label: tr('menu.front') }]
          : [{ role: 'close' as const, label: tr('menu.close') }]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ------------------------------------------------------------- lifecycle

async function createWindow() {
  store = new TeamsStore(app.getPath('userData'))
  win = new AppWindow({
    store,
    locale,
    distDir: DIST,
    pageScript: readFileSync(join(DIST, 'page-script.js'), 'utf8'),
    appVersion: app.getVersion(),
    classifier: new HostClassifier(testPublic, testMapped),
    suggestedTeam: kit.team,
    onTeamsChanged: () => buildMenu(),
  })
  win.win.on('closed', () => {
    win = undefined
  })
  buildMenu()
  const initial = dev ? process.env.MYCEL_DESKTOP_TEAM : undefined
  if (initial) await win.addTeam(initial)
  else await win.openLast()
}

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
})

app.on('second-instance', () => {
  if (win && !win.win.isDestroyed()) {
    if (win.win.isMinimized()) win.win.restore()
    win.win.focus()
  }
})
app.on('activate', () => {
  if (!win) void createWindow()
})
// write cookies of the open team (page and browser) to disk before quitting
let flushed = false
app.on('before-quit', () => debug('before-quit'))
app.on('will-quit', (e) => {
  debug('will-quit', flushed)
  if (flushed) return
  e.preventDefault()
  const id = win?.team?.id
  const sessions = id ? [session.fromPartition(partitionFor(id, 'app')), session.fromPartition(partitionFor(id, 'browser'))] : []
  void Promise.race([Promise.all(sessions.map((s) => s.cookies.flushStore().catch(() => {}))), new Promise((r) => setTimeout(r, 2000))]).finally(() => {
    flushed = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
