// What the desktop app (component E) gives the team web page (component D), and the small relay the web page
// runs to hand browser.call events from its WebSocket to the desktop app (design tab 5 "데스크톱 앱 규칙").
//
// The web page owns the WebSocket (one per window, windowId). When it runs inside the desktop app, the preload
// script exposes `window.mycelDesktop` (DESKTOP_BRIDGE_GLOBAL). The main process only answers calls from the top
// frame of the team page it opened (never iframes, artifacts or previews). Permission prompts and the "AI is using"
// indicator live in the desktop app's own pane UI, not in the web page, so a page served through the relay can
// send browser commands but cannot answer the user's site prompts.
//
// Web page usage:
//   const bridge = getDesktopBridge()
//   const relay = bridge && createBrowserRelay({ bridge, windowId, send: (f) => ws.send(JSON.stringify(f)) })
//   ws.onmessage = (m) => { const ev = ServerFrame.parse(JSON.parse(m.data)); relay?.handle(ev); ... }
import { BrowserCall, BrowserResult } from './api/browser'
import type { LocalCall, LocalResult } from './api/local-apps'
import type { ClientFrame, ServerFrame } from './api/ws'

/** window[DESKTOP_BRIDGE_GLOBAL] inside the desktop app. */
export const DESKTOP_BRIDGE_GLOBAL = 'mycelDesktop'
/** Bumped when the bridge changes incompatibly. The web page can ask for a minimum (createBrowserRelay). */
export const DESKTOP_BRIDGE_VERSION = 1

/**
 * Token at the end of the User-Agent of the desktop app's in-app browser (the pane the AI drives). The pane never
 * opens team addresses (blocked in the desktop app); as a second line the team server answers 401 to any request
 * whose User-Agent contains this token (design tab 5 "앱 안 브라우저 분리"). Owner of the server check: A.
 */
export const IN_APP_BROWSER_UA_MARK = 'MycelBrowser/1'

/** true when a User-Agent header comes from the desktop app's in-app browser. */
export function isInAppBrowserUserAgent(ua: string | null | undefined): boolean {
  return typeof ua === 'string' && ua.includes(IN_APP_BROWSER_UA_MARK)
}

export interface DesktopPaneTab {
  tabId: string
  title: string
  url: string
  active: boolean
  loading: boolean
  /** page-opened popup (sign-in window): only the user may drive it */
  popup?: boolean
}
export interface DesktopPaneState {
  open: boolean
  tabs: DesktopPaneTab[]
  activeTabId?: string
  /** the AI is running a browser tool right now */
  driving: boolean
}

/** How this window reaches the team server (tab 6 "같은 네트워크의 데스크톱 앱"). */
export interface DesktopConnection {
  /** 'direct' = office network, pinned certificate; 'remote' = the team address (relay) */
  route: 'remote' | 'direct'
  /** origin the window is showing */
  origin: string
  /** the team address the user entered */
  teamAddress: string
  /** the pinned certificate of the direct address changed: direct connection stopped until the server confirms it */
  fingerprintMismatch: boolean
}

/**
 * The in-app browser's site setting for this team on this computer, as Settings > Browser shows it. It lives only in
 * the desktop app (per team, on this computer); the pane's ⚙ panel shows the same value.
 */
export interface DesktopBrowserSettings {
  /** ask: the person answers for each new site; all: every public website (office network and this computer still ask or stay blocked) */
  siteAccess: 'ask' | 'all'
  /** public sites allowed always */
  always: string[]
  /** office-network addresses allowed always */
  privateAlways: string[]
  /** the team lets people turn on "all" (Admin > Team settings), as the desktop app last heard from the team server */
  teamAllowsAll: boolean
  /** the version of the "Allow all websites" risk sentence (WEB_ALLOW_ALL_WARNING_VERSION) that the app's own window
   * shows. Absent: an app built before the sentence existed, whose window does not show it: the page shows its own
   * confirm with the sentence before the server value goes on */
  riskVersion?: number
}

/** How a test notification went: 'shown' (the system took it: Windows, Linux), 'off' (the system refused it:
 * notifications are off for the app, or the app may not post them), 'unsupported' (this system has no notifications),
 * 'limited' (too many this minute), 'unknown' (handed over, but the system said nothing within a few seconds; on macOS
 * also when it took it: macOS takes a notification it will not show, so taking it says nothing there). */
export type DesktopNotifyTest = 'shown' | 'off' | 'unsupported' | 'limited' | 'unknown'

/** The version of DesktopBridge.workFiles this page knows. A desktop app with another (or none) gets no entry.
 * 2 (TC-3300): add(ids) first, as the person presses Add; read(id) then gives only the files added. A page of version 1
 * does not know add(), so an app of version 2 offers it nothing (its reads would all be refused); this page still
 * takes an app of version 1 (no add(): its reads are not limited to the files added). */
export const WORK_FILES_BRIDGE_VERSION = 2

/** The folders "Find work files on this computer" looks through, in this order (macOS asks for each in turn). Part 5
 * (a wide look, scan({ wide: true })) adds places with a name of their own (`place`): a cloud drive's folder (OneDrive,
 * Google Drive, Dropbox, Box), a work folder in the home folder, a messenger's downloads, files opened lately anywhere in
 * the home folder, another drive or a share (Windows). A page that never asks for a wide look never gets them. */
export type WorkRootId = WorkFolderId | WorkPlaceKind
/** The three folders of every look. */
export type WorkFolderId = 'documents' | 'desktop' | 'downloads'
export type WorkPlaceKind = 'cloud' | 'folder' | 'messenger' | 'home' | 'drive'
/** The version of the wide look (scan({ wide })) and of fullDisk a desktop app offers (workFiles.wide). */
export const WORK_FILES_WIDE_VERSION = 1
/** DesktopBridge.dictation: voice input transcribed on this Mac (0: not offered) */
export const DICTATION_BRIDGE_VERSION = 1
/** DesktopBridge.googleSignIn: the app takes the one-time code of a Google sign-in done in the system browser
 * (docs/decisions/20261122-google-login-apps.md). 0 or absent: an older app, whose sign-in page offers the password
 * only. */
export const GOOGLE_SIGNIN_BRIDGE_VERSION = 1
/** A Mac's Full Disk Access for the app: granted, not granted, or the app cannot tell (an older macOS, no probe). */
export type FullDiskState = 'granted' | 'denied' | 'unknown'

/** How one folder went: ok · blocked (macOS privacy keeps the app out: Don't Allow, or the app off in System Settings ›
 * Privacy & Security › Files & Folders) · missing (no such folder) · unreadable (another error) · home (it is the home
 * folder or holds it: never looked at) · same (the same folder as one before, looked at once) · skipped (Stop was
 * pressed, or the time for all three ran out: `cut`). `cut`: a limit stopped it before the end (a big Downloads). */
export interface WorkRootResult {
  id: WorkRootId
  /** part 5: the place's name for a place other than the three folders ("OneDrive – Acme", "Projects", "KakaoTalk",
   * "D:"; '' for the home folder's recent files); never a whole path */
  place?: string
  /** how it was looked at: the computer's index (Spotlight, Windows Search), or a walk when the index was off. Absent:
   * an older app (a walk) */
  how?: 'index' | 'walk'
  /** Windows: the folder is in OneDrive ("Documents (OneDrive)") */
  oneDrive: boolean
  state: 'ok' | 'blocked' | 'missing' | 'unreadable' | 'home' | 'same' | 'skipped'
  cut: boolean
  /** documents over 50 MB, counted, not listed */
  tooBig: number
  /** entries looked at */
  checked: number
}

/** One file the look found: never its path on the computer. `id` reads it (workFiles.read), only for this look.
 * `folder`: the folders inside the root ('' at its top, '/' between), `modified` the file's date (ms). */
export interface WorkFileMeta {
  id: string
  root: WorkRootId
  folder: string
  name: string
  ext: string
  size: number
  modified: number
  /** what the computer's index knows (absent when the folders were walked: the index was off, or an older app):
   * `used` last opened (ms), `useCount` how often, `origins` the hosts it was downloaded from, `authors` and `org` from
   * the document's own properties as the index read them. Nothing of it needs the file opened. */
  used?: number
  useCount?: number
  origins?: string[]
  authors?: string[]
  org?: string
  /** part 5: the place's name (as WorkRootResult.place), for a file outside the three folders */
  place?: string
  /** part 5: online only (its content is in the cloud; adding it downloads it then) */
  cloud?: boolean
  /** in a recent-documents list (a Mac's shared file lists, Office's; Windows' Recent folder, Office's): the person
   * opened it, even when no date of it is known */
  listed?: boolean
}

/** scan(): cancelled (the person said no in the app's own dialog) · busy (a dialog or a look is under way) · unavailable
 * (no team open, a store build) · done (the list; `stopped`: the person pressed Stop, the list is what was found so far). */
export type WorkFileScan =
  | { state: 'cancelled' | 'busy' | 'unavailable' }
  | { state: 'done'; stopped: boolean; roots: WorkRootResult[]; files: WorkFileMeta[] }

/** Where a file whose content is in the cloud only comes from while the app reads it: iCloud Drive (a Mac's Desktop and
 * Documents too), a cloud drive's folder, or 'cloud' when the app cannot tell which. */
export type WorkCloudProvider = 'icloud' | 'onedrive' | 'googleDrive' | 'dropbox' | 'box' | 'cloud'

/** read(): the bytes, or why not: unknown (not an id of this look) · expired (the look is over an hour old) · limit (100
 * files or 1 GB read from this look) · changed (replaced, a link now, another size or date) · missing (deleted or moved
 * away since the look; older apps say unreadable) · unreadable ·
 * cloudTimeout (its content was coming from `cloud` and did not arrive within the read's minute; older apps say
 * unreadable). */
export type WorkFileRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'unknown' | 'expired' | 'limit' | 'changed' | 'missing' | 'unreadable' }
  | { ok: false; reason: 'cloudTimeout'; cloud: WorkCloudProvider }

/** add(): added (these files can be read now) · refused (no key or mouse press of the person's on the page in the 2 s
 * before, an id not of this page's latest look, named twice, the look over an hour old, or over 100 files or 1 GB with
 * what was added before) · cancelled (assistive technology on and no press: the app asked in its own window and the
 * person said no) · unavailable. No window otherwise: the app takes it as the person's Add. */
export type WorkFileAdd = { state: 'added' | 'refused' | 'cancelled' | 'unavailable' }

/** How setAccess ended. 'changed' for "all" only after the person confirmed the desktop app's own dialog. */
export type DesktopAccessOutcome = 'changed' | 'unchanged' | 'cancelled' | 'not-allowed' | 'busy' | 'unavailable'

/** A download of the team page ended in the desktop app: `name` as it was saved ("report (1).pdf"), `ok` false when
 * it failed or was interrupted (nothing is left in the folder). */
export interface DesktopDownloadDone { id: number; name: string; ok: boolean }

/** Voice input on this Mac (docs/decisions/20261119-mac-dictation.md), for one language:
 * - ready: the Mac transcribes it itself; `locale` the one it uses (ko-KR, en-GB …)
 * - needs-model: it can, once Apple's model for it is on this Mac (install() fetches it, once)
 * - unsupported: no on-device model for this language (Indonesian), or unavailable: not on this Mac (Intel, macOS
 *   before 26, the helper failed). Both mean the team server transcribes. */
export type DesktopDictationCheck = { state: 'ready' | 'needs-model'; locale: string } | { state: 'unsupported' | 'unavailable' }

/** What one recording on this Mac says (DesktopBridge.dictation.onEvent), by the id start() gave:
 * - text: `final` false is a guess for the words since the last final one, replaced by the next text; final true is
 *   kept. The box shows every final text so far, then the newest guess.
 * - done: after stop(), every word is final. error: it ended without done (the helper failed or stopped answering). */
export type DesktopDictationEvent =
  | { id: number; event: 'text'; final: boolean; text: string }
  | { id: number; event: 'done' }
  | { id: number; event: 'error'; code: string }

export interface DesktopBridge {
  bridgeVersion: number
  /** desktop app (shell) version, e.g. "0.1.0" */
  appVersion: string
  platform: 'darwin' | 'win32' | 'linux'
  /** true in a Mac App Store or Microsoft Store build (Electron's process.mas / process.windowsStore): the store updates
   * it, so Settings > Apps offers no desktop installer at all (App Review Guideline 2.4.5, Microsoft Store Policy 10.2.4:
   * no installs or updates from outside the store). Optional: desktop apps before this addition do not have it, and
   * none of them came from a store. Only the Mac App Store build answers the page's file inputs itself (platform
   * 'darwin' with store: web/src/lib/desktop.ts answersFileInputs). */
  store?: boolean
  browser: {
    /** Run one browser.call. Same callId twice returns the first result (never runs twice). */
    run(call: BrowserCall): Promise<BrowserResult>
    /** browser.cancel: the turn stopped */
    cancel(callId: string): void
  }
  pane: {
    open(): void
    close(): void
    toggle(): void
    getState(): Promise<DesktopPaneState>
    onState(cb: (s: DesktopPaneState) => void): () => void
  }
  connection: {
    get(): Promise<DesktopConnection>
    onChange(cb: (c: DesktopConnection) => void): () => void
  }
  /** Native notification (a chat or a room that wants the person, admin alerts). Shown only while the window is not
   * focused, at most 10 a minute. `tag`: one notification per tag (a newer one replaces it; "chat-<id>": one per chat).
   * `open`: an address of the team page ("/c/<chatId>", "/rooms/<id>") the page goes to when the person clicks it
   * (onOpen); desktop apps before this addition only focus the window. A team switch closes them. `read`: a room
   * notification's "Mark as read" button (macOS), "<room id>@<seq>" or "<room id>/<thread root id>@<seq>", given back
   * through onRead when pressed; older desktop apps show no button. */
  notify(n: { title: string; body: string; tag?: string; open?: string; read?: string }): void
  /** Settings › Notifications' "Test notification": one notification now, even while the window is focused (the person
   * asked for it), in the desktop app's own words (the page gives none) and a small limit a minute of its own; a newer
   * test replaces the older one. Says how it went (DesktopNotifyTest). Optional: desktop apps before this addition do
   * not have it (the page shows no button). */
  testNotify?(): Promise<DesktopNotifyTest>
  /** A notification's click asks the page to go to its address (an app path, checked by the desktop app). Optional:
   * desktop apps before session markers do not have it. */
  onOpen?(cb: (path: string) => void): () => void
  /** A notification's "Mark as read" was pressed: the page marks that room (or thread) read up to seq (the token from
   * notify's `read`). Optional: older desktop apps do not have it. */
  onRead?(cb: (token: string) => void): () => void
  /** The dock badge (macOS only; Windows shows no count): how many chats and rooms want the person (docs/DECISIONS.md
   * "Session markers"); 0 clears it. `dot` with n 0: a plain dot instead, some room has unread messages n does not
   * count ("The Dock's dot for unread rooms"); desktop apps before it ignore the flag (nothing at 0). Optional: older
   * desktop apps do not have it. */
  setBadgeCount?(n: number, dot?: boolean): void
  /** Whether this window is focused, as the desktop app sees it. The page's own document.hasFocus() is false while the
   * in-app browser pane holds the keyboard (in apps before 2026-11-10's keyboard fix also after a start until a click
   * into the page), which is still the person looking at the window. Since 2026-11-10 also false while the team list
   * or the offline screen covers the page (the page still reports itself visible there). Optional (older apps). */
  focus?: {
    get(): Promise<boolean>
    onChange(cb: (focused: boolean) => void): () => void
  }
  /** The computer's own use, every 30 s (desktop/src/common/system-activity.ts): how long it has had no input and
   * whether its screen is locked. The page counts the person as at Trina while the computer is in use, even with
   * another app in front (web/src/lib/presence.ts; docs/DECISIONS.md "Phone notifications when I'm away"). Optional:
   * older desktop apps do not have it (the page counts only its own input). */
  systemActivity?: {
    onChange(cb: (a: { locked: boolean; idleMs: number }) => void): () => void
  }
  /** Open the desktop app's team list (switch team / add a team). */
  openTeams(): void
  /** Older pages' "다른 팀으로 전환": desktop apps up to 0.5.7 showed a menu of teams under the pointer; since 2026-11-15
   * the app opens its team screen here too (as openTeams). Pages call openTeams. Optional: older desktop apps. */
  teamMenu?(): void
  /** true: this team's pages draw the team address and "Switch team" under their sign-in card. The app then leaves out
   * its own strip above the page on the sign-in paths for this team until another team is opened (false undoes it), so
   * the address is not shown twice and a later sign-in page does not jump. The address the page shows is the bridge's
   * connection teamAddress, never location.host. Optional: older desktop apps keep their strip, and the page then draws
   * no line. */
  hostLine?(drawn: boolean): void
  /** The language the team page shows now (the person's choice, else the team default): the desktop app's own
   * screens, menus and prompts follow it. Optional: desktop apps before this addition do not have it. */
  setLocale?(locale: 'ko' | 'en' | 'id' | 'ja' | 'es' | 'zh'): void
  /** The look the person chose on the team page (Settings: light, dark or follow the system): the desktop app's own
   * screens (the browser pane's toolbar, the window's colour) follow it, not only the computer's look. Optional:
   * desktop apps before this addition do not have it (their screens follow the computer). */
  setTheme?(theme: 'light' | 'dark' | 'system'): void
  /** The folder the page picked last in the folder window (by its name, as the handle gives it) gave nothing to read:
   * 'mac-blocked' when macOS privacy keeps the app out of it (Don't Allow, or the app off in System Settings › Privacy &
   * Security › Files and Folders); null for anything else, an empty folder included, and always on Windows and Linux.
   * Optional: desktop apps before this addition do not have it (the page says the folder is empty). QA TC-049. */
  folderProblem?(folderName: string): Promise<'mac-blocked' | null>
  /** 이미지 복사 (the image viewer, the right-click menu of a picture): these PNG bytes, which the page read itself, go
   * on the computer's clipboard as a picture; false when they are no PNG or too large. The app fetches nothing.
   * Optional: desktop apps before this addition do not have it (the page writes the async clipboard). */
  copyImage?(png: Uint8Array): Promise<boolean>
  /** Downloads in the desktop app go straight into the computer's Downloads folder, with no save window, once the page
   * listens here: the page shows the notice ("Saved to Downloads", or that it failed). `show(id)` opens the folder with
   * that file selected; the page names the download by its number, never a path. Optional: desktop apps before this
   * addition and the Mac App Store build do not have it (the save window opens, as before). */
  downloads?: {
    onDone(cb: (d: DesktopDownloadDone) => void): () => void
    show(id: number): void
  }
  /**
   * "Find work files on this computer" (docs/DECISIONS.md "Find work files on this computer"). The page never names a
   * path: scan() first shows the app's own dialog (no web page draws it) and looks through Documents, Desktop and
   * Downloads only after the person agrees there; the look runs in the app (names, sizes and dates; links never
   * followed) and gives back a list with an opaque id per file. add(ids) names the files the person ticked, as they
   * press Add (taken only right after a real press of theirs on the page); read(id) gives one such file's bytes, only for the latest look of this page, within an
   * hour, at most 100 files and 1 GB. Optional: the Mac App Store build and desktop
   * apps before this addition do not have it; a page checks `version` against WORK_FILES_BRIDGE_VERSION.
   */
  workFiles?: {
    version: number
    /** part 5: WORK_FILES_WIDE_VERSION when the app offers the wide look and fullDisk (absent: an older app) */
    wide?: number
    /** `wide` (part 5): the places beyond the three folders too, when the app can see them without asking per folder
     * (Windows; a Mac with Full Disk Access; otherwise the app looks at the three folders as before). `words`: the
     * company's and clients' names, at most 20 of at most 60 characters, which name the home folder's work folders
     * ("Acme", "Globex"); the app's own dialog lists every place before anything is looked at. An older app ignores both. */
    scan(o?: { wide?: boolean; words?: string[] }): Promise<WorkFileScan>
    /** part 5, a Mac: whether the app has Full Disk Access (the app tries a protected place; nothing of it is read), the
     * Settings pane to turn it on, and a restart (macOS may give it only after one). Absent on Windows and older apps. */
    fullDisk?: {
      state(): Promise<FullDiskState>
      openSettings(): void
      relaunch(): void
    }
    /** the look stops; scan() answers with what was found so far (`stopped`) */
    stop(): void
    /** the look's progress, while it runs: the folder, entries checked, documents so far, and how far the look is in all
     * (0–1, the folders weighed by how they are looked at; absent from older apps) */
    onProgress(cb: (p: { root: WorkRootId; place?: string; checked: number; docs: number; done?: number }) => void): () => void
    /** "Choose it yourself": macOS kept the app out of that folder; the person picks it in the system's folder window
     * (opened at it), which counts as their permission, and the app looks at it now. The latest look's ids stay
     * readable and the new ones are added to it. 'cancelled' when the window was closed. Optional (older apps). */
    pickRoot?(root: WorkFolderId): Promise<WorkFileScan>
    /** "Choose a folder…" (MAN-057): after a look, the person points the app at any one folder in the system's folder
     * window (opened at Documents; the pick is their permission; never the home folder or the apps' data). The app walks
     * it now and adds its files to the latest look, named under its own name ('folder' with its name as `place`) or,
     * inside one of the three folders, under that folder. 'cancelled' when the window was closed or the pick refused.
     * Optional (older apps). */
    pickFolder?(): Promise<WorkFileScan>
    /** version 2: the files the person ticked, named as they press Add, before any of them is read. The app takes it only
     * within 2 s of the person's own key or mouse press on the page (no window); read() then gives these files' bytes and
     * never a file not added. Absent in version 1. */
    add?(ids: string[]): Promise<WorkFileAdd>
    /** the bytes of a file added (version 2; version 1: any file of the look). `onCloud`: the file's content is in the
     * cloud only, and the app is getting it from there first (a slow read that explains itself); called at most once,
     * before the answer. Older apps never call it. */
    read(id: string, o?: { onCloud?: (cloud: WorkCloudProvider) => void }): Promise<WorkFileRead>
    /** macOS: System Settings › Privacy & Security › Files & Folders, where the person lets the app into a folder again */
    openSettings(): void
  }
  /** A connector sign-in at a service that takes only an app on the computer as the place to come back to (Canva,
   * Intercom, Square; RFC 8252): open() gives the port of a one-time return address on 127.0.0.1 that the page passes to
   * POST /api/integrations/:id/authorize (`loopbackPort`); the service sends the browser there and the app sends it on
   * to this team's own return page, then the address closes (desktop/src/common/sign-in-return.ts). One at a time; it
   * closes by itself after 10 minutes. null when none can be opened. close(port): the sign-in did not need it, or was
   * cancelled. Optional: desktop apps before this addition do not have it (the page sends no port). */
  signInReturn?: {
    open(): Promise<number | null>
    close(port: number): void
  }
  /**
   * Sign in with Google (GOOGLE_SIGNIN_BRIDGE_VERSION; docs/decisions/20261122-google-login-apps.md): this app opens
   * Google's page in the system browser (the page's window.open) and takes `<scheme>://open?url=<team>/login/google#code=…`
   * for the team on screen, without screen ④: it opens that page in the team's window, which redeems the code with the
   * secret it kept. Absent: an app from before, whose sign-in page shows the password only.
   */
  googleSignIn?: number
  /**
   * Settings > Browser: the same setting as the pane's ⚙ panel, and nothing else. The page can read it, go back to
   * asking, remove an always-allowed site and clear them all. setAccess('all') only asks: the desktop app shows its
   * own confirmation dialog and changes the setting only when the person confirms there; it is refused while the
   * team does not allow it. Optional: desktop apps before this addition do not have it (the section stays hidden).
   */
  /**
   * Apps on this computer as connectors (docs/decisions/20261118-local-app-connectors.md; LOCAL_APPS_BRIDGE_VERSION).
   * run() takes one local.call from the team server and answers it: the app asks the person once in its own window
   * before it runs a command (and again when the command changes), starts the program from an argument list (never a
   * shell, never as root), and hides the setting values in what goes back. The page never sees the confirm, a program's
   * output beyond the answer, or a setting's value. stop(): the program of that connection ends now. setSettings():
   * values typed on this computer, kept sealed here (the server knows only their names); settingNames(): which have
   * one. Optional: browsers, the phone app and desktop apps before this addition do not have it (the page says the
   * apps work only in the desktop app, and answers calls with not_desktop or too_old).
   */
  localApps?: {
    version: number
    run(call: LocalCall): Promise<LocalResult>
    cancel(callId: string): void
    stop(connectionId: string): void
    running(): Promise<string[]>
    onRunning(cb: (s: { id: string; running: boolean }) => void): () => void
    /** Connect was pressed in the confirm after the call that asked stopped waiting (the page checks the connection
     * again by itself). Optional: desktop apps before this addition do not have it. */
    onConfirmed?(cb: (s: { id: string }) => void): () => void
    setSettings(connectionId: string, values: Record<string, string>): Promise<'saved' | 'unavailable' | 'invalid'>
    settingNames(connectionId: string): Promise<string[]>
    /** The connections confirmed (Connect pressed) for this window's team on this computer, by id. Optional: desktop
     * apps before this addition do not have it (Settings › Connectors then shows no list of them). */
    connected?(): Promise<string[]>
    /** Drop that confirm: the next call asks again on this computer, and a running program of it stops. False when
     * there was none. Optional, like connected(). */
    forget?(connectionId: string): Promise<boolean>
  }
  /**
   * Voice input transcribed on this Mac (docs/decisions/20261119-mac-dictation.md; DICTATION_BRIDGE_VERSION): Apple's
   * SpeechTranscriber in a small helper of the app, macOS 26 on Apple silicon. The page records as always and hands
   * the 16 kHz samples over (push); the words come back as events while the person talks. Nothing leaves the Mac.
   * check(language): the app language's state here. install(language): Apple's model for it, once (`onProgress`
   * 0-100); 'failed' when it could not be fetched. start(language): a recording's id, null when it cannot start (the
   * page then uses the team server). stop(id): the sound ended; the last words and `done` follow. cancel(id): nothing
   * more comes. One recording at a time: a new start() cancels the one before. Optional: Windows, the Mac App Store
   * build, an Intel Mac and desktop apps before this addition do not have it (the team server transcribes).
   */
  /** The Mac app: System Settings › Privacy & Security › Microphone, where a refused microphone is turned on again
   * (the page's "Open Settings" under its blocked-mic note). Optional: Windows and older desktop apps lack it. */
  openMicSettings?(): void
  dictation?: {
    version: number
    check(language: string): Promise<DesktopDictationCheck>
    install(language: string, onProgress?: (percent: number) => void): Promise<'installed' | 'failed' | 'unsupported'>
    start(language: string): Promise<number | null>
    push(id: number, samples: Float32Array): void
    stop(id: number): void
    cancel(id: number): void
    onEvent(cb: (e: DesktopDictationEvent) => void): () => void
  }
  browserSettings?: {
    get(): Promise<DesktopBrowserSettings | null>
    /** the setting changed (here, in the pane's ⚙ panel, by an answer "always allow", or by the team's policy) */
    onChange(cb: (s: DesktopBrowserSettings) => void): () => void
    setAccess(v: 'ask' | 'all'): Promise<DesktopAccessOutcome>
    removeSite(host: string): Promise<DesktopBrowserSettings | null>
    clearSites(): Promise<DesktopBrowserSettings | null>
  }
}

export function getDesktopBridge(): DesktopBridge | null {
  const b = (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] as DesktopBridge | undefined
  return b && typeof b === 'object' && typeof b.bridgeVersion === 'number' ? b : null
}

/**
 * Office-network direct connection info (tab 6). The team server answers GET CONNECT_INFO_PATH over the team
 * address (real TLS); the desktop app then accepts only this certificate on the LAN address (no trust on first use).
 */
export const CONNECT_INFO_PATH = '/api/connect-info'
/** the schema lives with the endpoint (shared/src/api/system.ts) */
export { ConnectInfo } from './api/system'

export interface BrowserRelayOptions {
  bridge: DesktopBridge
  /** this window's id (the one sent as x-mycel-window and on /api/ws) */
  windowId: string
  /** send a client frame on the WebSocket (or POST /api/browser/results on the long-poll path) */
  send: (frame: ClientFrame) => void
  /** refuse to run calls when the desktop app is older than this bridge version (the page shows "update the app") */
  minBridgeVersion?: number
  /** how many finished results to keep for re-sending after a reconnect (default 200) */
  keep?: number
  /** and at most this many characters of them in total (screenshots are large; default 32 MB) */
  keepChars?: number
}

export interface BrowserRelay {
  /** Feed every server frame; returns true when it was a browser frame for this window. */
  handle(frame: ServerFrame): boolean
  /** Run a call that arrived through the long-poll fallback (GET /api/browser/calls). */
  run(call: BrowserCall): void
  /** calls running in the desktop app right now */
  readonly running: number
}

/**
 * Hands browser.call to the desktop app and sends browser.ack / browser.result back. A call that arrives again
 * (replay after a reconnect) is never run twice: running → ack again; finished → result again.
 */
/** Characters a result holds (texts + base64 images): what the relay counts against keepChars. */
export function browserResultChars(r: BrowserResult): number {
  let n = r.error?.length ?? 0
  for (const c of r.content) n += c.type === 'text' ? c.text.length : c.data.length
  return n
}

export function createBrowserRelay(o: BrowserRelayOptions): BrowserRelay {
  const keep = o.keep ?? 200
  const keepChars = o.keepChars ?? 32 * 1024 * 1024
  const done = new Map<string, { r: BrowserResult; size: number }>()
  let doneChars = 0
  const inFlight = new Set<string>()
  const remember = (callId: string, r: BrowserResult) => {
    const size = browserResultChars(r)
    done.set(callId, { r, size })
    doneChars += size
    // the newest result always stays (it may be the one a reconnect asks for)
    while (done.size > 1 && (done.size > keep || doneChars > keepChars)) {
      const [oldest, e] = done.entries().next().value as [string, { size: number }]
      done.delete(oldest)
      doneChars -= e.size
    }
  }
  // a closed WebSocket throws on send: the result stays remembered and goes out again when the call is replayed
  const send = (frame: ClientFrame) => {
    try {
      o.send(frame)
    } catch {
      // ignored on purpose (see above)
    }
  }
  const fail = (callId: string, error: string): BrowserResult => ({ callId, ok: false, content: [{ type: 'text', text: error }], error })

  const run = (raw: BrowserCall) => {
    const parsed = BrowserCall.safeParse(raw)
    if (!parsed.success) return
    const call = parsed.data
    const prev = done.get(call.callId)
    if (prev) return send({ type: 'browser.result', result: prev.r })
    if (inFlight.has(call.callId)) return send({ type: 'browser.ack', callId: call.callId })
    inFlight.add(call.callId)
    send({ type: 'browser.ack', callId: call.callId })
    const finish = (r: BrowserResult) => {
      inFlight.delete(call.callId)
      const checked = BrowserResult.safeParse(r)
      const result = checked.success && r.callId === call.callId ? checked.data : fail(call.callId, 'The desktop app returned a malformed browser result.')
      remember(call.callId, result)
      send({ type: 'browser.result', result })
    }
    if (o.minBridgeVersion !== undefined && o.bridge.bridgeVersion < o.minBridgeVersion) {
      return finish(fail(call.callId, 'The desktop app is too old for browser tools. Ask the user to update the desktop app.'))
    }
    let pending: Promise<BrowserResult>
    try {
      pending = o.bridge.browser.run(call)
    } catch (e) {
      pending = Promise.reject(e)
    }
    pending.then(finish, (e: unknown) => finish(fail(call.callId, `Browser pane error: ${e instanceof Error ? e.message : String(e)}`)))
  }

  return {
    handle(frame) {
      if (frame.type === 'browser.call') {
        if (frame.data.windowId !== o.windowId) return false
        run(frame.data.call)
        return true
      }
      if (frame.type === 'browser.cancel') {
        if (frame.data.windowId !== o.windowId) return false
        if (inFlight.has(frame.data.callId)) o.bridge.browser.cancel(frame.data.callId)
        return true
      }
      return false
    },
    run,
    get running() {
      return inFlight.size
    },
  }
}
