// App-led linking of the <app> in Chrome extension, the app's side (bridge `chromeProfiles`, shared/src/desktop-bridge.ts):
// lists this OS user's browser profiles, opens one on the store page or on the extension's pair page with a nonce,
// registers the native helper with the browsers, and answers the helper over the app's socket by asking the team page
// on screen for a pair code (common/chrome-pair.ts, common/chrome-profiles.ts). No Electron import: the team page is
// anything that can receive a message (tests/e2e/chrome-app-link.test.ts drives this with a fake page).
//
// Environment (development and tests; ignored in a packaged app):
//   MYCEL_CHROME_HOST_HELPER   the helper program; a development run else takes <app>/native-build/chrome-host (what
//                              native/chrome-host/build.sh makes) when it is there
//   MYCEL_CHROME_REGISTER_HOST 1: a development run writes the host manifests too (a packaged app always does; a
//                              development run also does when MYCEL_CHROME_DATA_DIRS points the browsers at test
//                              folders: their manifests are nobody else's)
//   MYCEL_CHROME_DATA_DIRS, MYCEL_CHROME_BINARIES: common/chrome-profiles.ts
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { chromeExtensionIds, chromeProfileLabel } from '@mycel/shared/chrome-native'
import type { DesktopBrowserProfile } from '@mycel/shared/desktop-bridge'
import { chromePairSocketPath, listenForPairs, NonceStore } from '../common/chrome-pair'
import { BROWSERS, browserBinary, browserDataDirs, browserLabel, chromeStoreUrl, devHostScript, listProfiles, nativeHostDirs, openProfile, pairPageUrl, writeNativeHostManifests, type ChromeEnv, type Exec } from '../common/chrome-profiles'

/** the team page as this host needs it: Electron's WebContents fits */
export interface PageLike { send(channel: string, payload: unknown): void; isDestroyed(): boolean }

export interface ChromeProfilesDeps {
  userData: string
  /** the app's data folder name (PRODUCT.desktopDataDir): the helper's default socket is under it */
  dataDirName: string
  /** the app's own folder (app.getAppPath()): a development run's helper is <it>/native-build/chrome-host */
  appPath?: string
  /** a line for the app's log (why app-led linking is off in this run) */
  log?: (msg: string, detail?: unknown) => void
  /** this user's temp folder (tests) */
  tempDir?: () => string
  /** an unpacked app: allows the dev extension id and the environment overrides */
  dev: boolean
  execPath: string
  /** the team page on screen, signed in */
  team: () => { origin: string; name: string; page: PageLike } | null
  env?: ChromeEnv
  exec?: Exec
  /** how long the page has to answer a pair request */
  askMs?: number
}

const ASK_MS = 20_000

/** why the app cannot pair a profile now: the socket path does not fit, the socket did not open, no helper program, or
 * (a development run) the browsers were not told about the helper */
export type PairUnavailable = 'socket_path' | 'listen_failed' | 'no_helper' | 'not_registered'

export class ChromeProfilesHost {
  readonly nonces = new NonceStore()
  private server?: net.Server
  private asks = new Map<string, { page: PageLike; resolve: (r: { code: string } | null) => void }>()
  private readonly env: ChromeEnv
  readonly socket: string | null
  /** the helper finds the socket by itself (the app's default folder); else the start script names it */
  private readonly socketFixed: boolean
  private listening: 'no' | 'yes' | 'failed' = 'no'
  /** manifests written this run (a development run that does not register has none) */
  private registered = false

  constructor(private d: ChromeProfilesDeps) {
    this.env = d.env ?? { platform: process.platform, home: os.homedir(), env: process.env, overrides: d.dev }
    const s = chromePairSocketPath({ home: this.env.home, dataDirName: d.dataDirName, userData: d.userData, ...(d.tempDir ? { tempDir: d.tempDir } : {}) })
    this.socket = s?.path ?? null
    this.socketFixed = !!s?.fixed
  }

  /** the helper next to the app's program (Contents/MacOS/chrome-host); a dev run's MYCEL_CHROME_HOST_HELPER, else the
   * one native/chrome-host/build.sh made in the app's folder */
  helperPath(): string | null {
    const own = this.d.dev ? this.env.env.MYCEL_CHROME_HOST_HELPER : undefined
    const built = this.d.dev && this.d.appPath ? path.join(this.d.appPath, 'native-build', 'chrome-host') : null
    for (const p of own ? [own] : [path.join(path.dirname(this.d.execPath), 'chrome-host'), ...(built ? [built] : [])]) if (fs.existsSync(p)) return p
    return null
  }

  /** a development run writes the manifests only when told to, or when the browsers' folders are test folders */
  private mayRegister(): boolean {
    return !this.d.dev || this.env.env.MYCEL_CHROME_REGISTER_HOST === '1' || browserDataDirs(this.env).overridden
  }

  /** listen on the socket and (a packaged app, or a development run that may) write the host manifests */
  start(): void {
    if (this.server) return
    if (!this.socket) return void this.d.log?.('chrome pairing off: no socket path fits', { userData: this.d.userData })
    this.listening = 'no'
    this.server = listenForPairs(this.socket, {
      nonces: this.nonces,
      ids: () => chromeExtensionIds(this.d.dev),
      team: () => { const t = this.d.team(); return t ? { origin: t.origin, name: t.name } : null },
      askCode: (challenge) => this.ask(challenge),
      linked: (l) => { const t = this.d.team(); if (t && !t.page.isDestroyed()) t.page.send('bridge:chrome-linked', l) },
    }, (state, err) => {
      this.listening = state === 'listening' ? 'yes' : 'failed'
      if (state === 'failed') this.d.log?.('chrome pairing off: the pair socket did not open', { socket: this.socket, err: String((err as Error)?.message ?? err) })
    })
    if (this.mayRegister()) this.register()
  }

  stop(): void {
    this.server?.close()
    this.server = undefined
    this.listening = 'no'
    for (const a of this.asks.values()) a.resolve(null)
    this.asks.clear()
  }

  /** Why a profile cannot pair now, or null when it can (what Connect answers, `unavailable`, instead of a pair page that
   * would say "not running"). The socket file gone while the app runs (a temp folder cleaned): listened again. */
  async unavailable(): Promise<PairUnavailable | null> {
    if (!this.socket) return 'socket_path'
    if (this.listening === 'yes' && !fs.existsSync(this.socket)) { this.stop(); this.start() }
    if (!this.server) this.start()
    for (let i = 0; i < 20 && this.listening === 'no'; i++) await new Promise((r) => setTimeout(r, 50))
    if (this.listening !== 'yes') return 'listen_failed'
    if (!this.helperPath()) return 'no_helper'
    if (!this.registered) return 'not_registered'
    return null
  }

  /** the manifests for each browser on this computer; the files written */
  register(dirs = nativeHostDirs(this.env)): string[] {
    const helper = this.helperPath()
    if (!helper || !this.socket) { if (!helper) this.d.log?.('chrome pairing off: no helper program', { dev: this.d.dev }); return [] }
    // an app run from the disk image or moved by macOS's App Translocation: its path goes away, so a manifest would
    // name a helper that is gone (written again at the next start from the installed copy)
    if (!this.d.dev && /^\/Volumes\/|\/AppTranslocation\//.test(helper)) return []
    // the helper finds the default folder's socket by itself; any other (a dev run, another user data folder) is named
    // by a start script in the app's own folder
    const target = this.socketFixed ? helper : devHostScript(path.join(this.d.userData, 'chrome', 'chrome-host.sh'), helper, this.socket)
    const files = writeNativeHostManifests(dirs, target, this.d.dev)
    if (files.length) this.registered = true
    return files
  }

  list(): DesktopBrowserProfile[] {
    return listProfiles(this.env, chromeExtensionIds(this.d.dev)).map(({ id: _id, ...p }) => p)
  }

  /** open a profile: the store page without the extension, the pair page with a fresh nonce with it */
  async connect(p: { browser: unknown; dir: unknown }): Promise<'store' | 'pair' | 'failed' | 'unavailable'> {
    if (typeof p?.browser !== 'string' || typeof p.dir !== 'string' || !BROWSERS.includes(p.browser as never)) return 'failed'
    const browser = p.browser as DesktopBrowserProfile['browser']
    const found = listProfiles(this.env, chromeExtensionIds(this.d.dev)).find((x) => x.browser === browser && x.dir === p.dir)
    const { dirs, overridden } = browserDataDirs(this.env)
    const binary = browserBinary(browser, this.env)
    const dataDir = dirs[browser]
    if (!found || !binary || !dataDir) return 'failed'
    const bl = browserLabel(browser, this.env.platform)
    let url: string
    let nonce: string | null = null
    if (found.id) {
      // the browser may have made its folder (or lost the manifest) since the app started: write the manifests again
      if (this.mayRegister()) try { this.register() } catch { /* the pair page falls back */ }
      // nothing would answer the pair page: the app says why (Settings › Browser), not a page that says "not running"
      const why = await this.unavailable()
      if (why) { this.d.log?.('chrome pairing unavailable', { why }); return 'unavailable' }
      // the team on screen now: the code must come from it (no team: the pair page says to open one)
      const team = this.d.team()
      if (!team) return 'failed'
      nonce = this.nonces.mint({ browser, dir: found.dir, label: chromeProfileLabel(found.name, bl), ...(found.email ? { email: found.email } : {}), browserLabel: bl, teamOrigin: team.origin })
      // the nonce goes only into this argument list (the browser's second process shows it in `ps` while it runs)
      url = pairPageUrl(found.id, nonce)
    } else url = chromeStoreUrl(browser)
    const ok = await openProfile({ binary, dataDir, passDataDir: overridden, dir: found.dir, url, ...(this.d.exec ? { exec: this.d.exec } : {}) })
    if (!ok && nonce) this.nonces.drop(nonce)
    return ok ? (found.id ? 'pair' : 'store') : 'failed'
  }

  /** ask the team page on screen for a code (bridge:chrome-pair-request → bridge:chrome-pair-answer) */
  private ask(challenge: string): Promise<{ code: string } | null> {
    const t = this.d.team()
    if (!t || t.page.isDestroyed()) return Promise.resolve(null)
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.asks.delete(id); resolve(null) }, this.d.askMs ?? ASK_MS)
      timer.unref?.()
      this.asks.set(id, { page: t.page, resolve: (r) => { clearTimeout(timer); this.asks.delete(id); resolve(r) } })
      t.page.send('bridge:chrome-pair-request', { id, challenge })
    })
  }

  /** the page's answer: only from the page that was asked, once */
  answer(from: PageLike, id: unknown, r: unknown): void {
    const a = typeof id === 'string' ? this.asks.get(id) : undefined
    if (!a || a.page !== from) return
    const code = r && typeof r === 'object' && typeof (r as { code?: unknown }).code === 'string' ? (r as { code: string }).code : null
    a.resolve(code ? { code } : null)
  }
}
