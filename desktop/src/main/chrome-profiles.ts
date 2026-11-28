// App-led linking of the <app> in Chrome extension, the app's side (bridge `chromeProfiles`, shared/src/desktop-bridge.ts):
// lists this OS user's browser profiles, opens one on the store page or on the extension's pair page with a nonce,
// registers the native helper with the browsers, and answers the helper over the app's socket by asking the team page
// on screen for a pair code (common/chrome-pair.ts, common/chrome-profiles.ts). No Electron import: the team page is
// anything that can receive a message (tests/e2e/chrome-app-link.test.ts drives this with a fake page).
//
// Environment (development and tests; ignored in a packaged app):
//   MYCEL_CHROME_HOST_HELPER   the helper program (desktop/native-build/chrome-host after native/chrome-host/build.sh)
//   MYCEL_CHROME_REGISTER_HOST 1: a development run writes the host manifests too (a packaged app always does)
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

export class ChromeProfilesHost {
  readonly nonces = new NonceStore()
  private server?: net.Server
  private asks = new Map<string, { page: PageLike; resolve: (r: { code: string } | null) => void }>()
  private readonly env: ChromeEnv
  readonly socket: string | null

  constructor(private d: ChromeProfilesDeps) {
    this.env = d.env ?? { platform: process.platform, home: os.homedir(), env: process.env, overrides: d.dev }
    this.socket = chromePairSocketPath(d.userData)
  }

  /** the helper next to the app's program (Contents/MacOS/chrome-host); a dev run's MYCEL_CHROME_HOST_HELPER */
  helperPath(): string | null {
    const own = this.d.dev ? this.env.env.MYCEL_CHROME_HOST_HELPER : undefined
    const p = own || path.join(path.dirname(this.d.execPath), 'chrome-host')
    return fs.existsSync(p) ? p : null
  }

  /** listen on the socket and (a packaged app, or MYCEL_CHROME_REGISTER_HOST=1) write the host manifests */
  start(): void {
    if (this.server || !this.socket) return
    this.server = listenForPairs(this.socket, {
      nonces: this.nonces,
      ids: () => chromeExtensionIds(this.d.dev),
      team: () => { const t = this.d.team(); return t ? { origin: t.origin, name: t.name } : null },
      askCode: (challenge) => this.ask(challenge),
      linked: (l) => { const t = this.d.team(); if (t && !t.page.isDestroyed()) t.page.send('bridge:chrome-linked', l) },
    })
    if (!this.d.dev || this.env.env.MYCEL_CHROME_REGISTER_HOST === '1') this.register()
  }

  stop(): void {
    this.server?.close()
    this.server = undefined
    for (const a of this.asks.values()) a.resolve(null)
    this.asks.clear()
  }

  /** the manifests for each browser on this computer; the files written */
  register(dirs = nativeHostDirs(this.env)): string[] {
    const helper = this.helperPath()
    if (!helper || !this.socket) return []
    // an app run from the disk image or moved by macOS's App Translocation: its path goes away, so a manifest would
    // name a helper that is gone (written again at the next start from the installed copy)
    if (!this.d.dev && /^\/Volumes\/|\/AppTranslocation\//.test(helper)) return []
    const fixed = path.join(this.env.home, 'Library', 'Application Support', this.d.dataDirName, 'chrome', 'pair.sock')
    // the helper finds the packaged app's socket by itself; any other (a dev run, another user data folder) is named by
    // a start script in the app's own folder
    const target = this.socket === fixed ? helper : devHostScript(path.join(this.d.userData, 'chrome', 'chrome-host.sh'), helper, this.socket)
    return writeNativeHostManifests(dirs, target, this.d.dev)
  }

  list(): DesktopBrowserProfile[] {
    return listProfiles(this.env, chromeExtensionIds(this.d.dev)).map(({ id: _id, ...p }) => p)
  }

  /** open a profile: the store page without the extension, the pair page with a fresh nonce with it */
  async connect(p: { browser: unknown; dir: unknown }): Promise<'store' | 'pair' | 'failed'> {
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
      if (!this.d.dev || this.env.env.MYCEL_CHROME_REGISTER_HOST === '1') try { this.register() } catch { /* the pair page falls back */ }
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
