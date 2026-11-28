// App-led linking of the <app> in Chrome extension, the desktop app's side (shared/src/chrome-native.ts): the browser
// profiles of this OS user, read from each browser's own files, the native messaging host manifests that let Chrome,
// Edge and Brave start our helper for our extension ids only, and how a profile is opened on the store page or on the
// extension's pair page. No Electron here (tests/unit/e-desktop-chrome-profiles.test.ts).
//
// Environment (development and tests only: honoured when `overrides` is on, i.e. an unpacked app or a test):
//   MYCEL_CHROME_DATA_DIRS  `chrome=/tmp/a,edge=/tmp/b`: the browsers' user data folders instead of the real ones (only
//                           the listed browsers); the app then opens them with --user-data-dir
//   MYCEL_CHROME_BINARIES   `chrome=/path/to/Chromium`: the programs that open them
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHROME_NATIVE_HOST, CHROME_PAIR_PAGE, chromeExtensionIds, chromeStoreUrl } from '@mycel/shared/chrome-native'
import type { DesktopBrowserProfile } from '@mycel/shared/desktop-bridge'

export type BrowserId = DesktopBrowserProfile['browser']
export const BROWSERS: readonly BrowserId[] = ['chrome', 'edge', 'brave']
type Platform = NodeJS.Platform

export interface ChromeEnv {
  platform: Platform
  home: string
  env: NodeJS.ProcessEnv
  /** read MYCEL_CHROME_DATA_DIRS / MYCEL_CHROME_BINARIES (never in a packaged app) */
  overrides: boolean
}
export const chromeEnv = (overrides: boolean): ChromeEnv => ({ platform: process.platform, home: os.homedir(), env: process.env, overrides })

function parseMap(v: string | undefined): Partial<Record<BrowserId, string>> {
  const out: Partial<Record<BrowserId, string>> = {}
  for (const part of (v ?? '').split(',')) {
    const i = part.indexOf('=')
    const k = part.slice(0, i).trim() as BrowserId
    const p = part.slice(i + 1).trim()
    if (i > 0 && BROWSERS.includes(k) && path.isAbsolute(p)) out[k] = p
  }
  return out
}

/** each browser's user data folder for this OS user (whether or not the browser is installed) */
export function browserDataDirs(e: ChromeEnv): { dirs: Partial<Record<BrowserId, string>>; overridden: boolean } {
  const own = e.overrides ? parseMap(e.env.MYCEL_CHROME_DATA_DIRS) : {}
  if (Object.keys(own).length) return { dirs: own, overridden: true }
  if (e.platform === 'darwin') {
    const s = path.join(e.home, 'Library', 'Application Support')
    return { dirs: { chrome: path.join(s, 'Google', 'Chrome'), edge: path.join(s, 'Microsoft Edge'), brave: path.join(s, 'BraveSoftware', 'Brave-Browser') }, overridden: false }
  }
  if (e.platform === 'win32') {
    const l = e.env.LOCALAPPDATA || path.join(e.home, 'AppData', 'Local')
    return { dirs: { chrome: path.win32.join(l, 'Google', 'Chrome', 'User Data'), edge: path.win32.join(l, 'Microsoft', 'Edge', 'User Data'), brave: path.win32.join(l, 'BraveSoftware', 'Brave-Browser', 'User Data') }, overridden: false }
  }
  const c = e.env.XDG_CONFIG_HOME && path.isAbsolute(e.env.XDG_CONFIG_HOME) ? e.env.XDG_CONFIG_HOME : path.join(e.home, '.config')
  return { dirs: { chrome: path.join(c, 'google-chrome'), edge: path.join(c, 'microsoft-edge'), brave: path.join(c, 'BraveSoftware', 'Brave-Browser') }, overridden: false }
}

/** the program that opens a browser: the first that exists */
export function browserBinary(browser: BrowserId, e: ChromeEnv, exists: (p: string) => boolean = fs.existsSync): string | null {
  const own = e.overrides ? parseMap(e.env.MYCEL_CHROME_BINARIES)[browser] : undefined
  if (own) return exists(own) ? own : null
  const mac = { chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave Browser' }[browser]
  const list =
    e.platform === 'darwin'
      ? ['/Applications', path.join(e.home, 'Applications')].map((d) => path.join(d, `${mac}.app`, 'Contents', 'MacOS', mac))
      : e.platform === 'win32'
        ? [e.env.PROGRAMFILES, e.env['PROGRAMFILES(X86)'], e.env.LOCALAPPDATA].filter((d): d is string => !!d).map((d) =>
            browser === 'chrome' ? path.win32.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')
            : browser === 'edge' ? path.win32.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
            : path.win32.join(d, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
        : (browser === 'chrome' ? ['google-chrome', 'google-chrome-stable'] : browser === 'edge' ? ['microsoft-edge', 'microsoft-edge-stable'] : ['brave-browser', 'brave-browser-stable']).map((n) => path.join('/usr/bin', n))
  return list.find(exists) ?? null
}

/** "Chrome on Mac": the browser and the system, as the pair reply and the link's label name them */
export function browserLabel(browser: BrowserId, platform: Platform): string {
  const b = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave' }[browser]
  return `${b} on ${platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'Windows' : 'Linux'}`
}

const readJson = (file: string): unknown => {
  try {
    const st = fs.statSync(file)
    // Preferences of a profile with many extensions can be a few MB; anything far larger is not a browser's file
    if (!st.isFile() || st.size > 32 * 1024 * 1024) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
/** a profile folder name as Chrome makes them ("Default", "Profile 3", "Guest Profile" is not listed): no path parts */
export const isProfileDir = (d: string): boolean => /^[A-Za-z0-9 ._-]{1,64}$/.test(d) && d !== '.' && d !== '..'

/** Local State's `profile.info_cache`: folder → name and Google account, in the browser's own order */
export function parseLocalState(json: unknown): { dir: string; name: string; email?: string }[] {
  const cache = obj(obj(obj(json)?.profile)?.info_cache)
  if (!cache) return []
  const out: { dir: string; name: string; email?: string }[] = []
  for (const [dir, v] of Object.entries(cache)) {
    const p = obj(v)
    if (!p || !isProfileDir(dir) || p.is_ephemeral === true || p.is_omitted_from_profile_list === true) continue
    const email = str(p.user_name, 254)
    out.push({ dir, name: str(p.name, 200) ?? str(p.gaia_name, 200) ?? dir, ...(email && email.includes('@') ? { email } : {}) })
  }
  return out.slice(0, 100)
}

/** the first of our extension ids that this profile's Preferences or Secure Preferences list (installed, not removed) */
export function installedId(profileFolder: string, ids: string[]): string | null {
  for (const f of ['Secure Preferences', 'Preferences']) {
    const settings = obj(obj(obj(readJson(path.join(profileFolder, f)))?.extensions)?.settings)
    if (!settings) continue
    for (const id of ids) {
      const s = obj(settings[id])
      // state 0 = disabled by the person; an uninstalled extension's entry is gone. A disabled one cannot pair either.
      if (s && s.state !== 0 && !(Array.isArray(s.disable_reasons) && s.disable_reasons.length) && !(typeof s.disable_reasons === 'number' && s.disable_reasons !== 0)) return id
    }
  }
  return null
}

export interface FoundProfile extends DesktopBrowserProfile {
  /** our extension id installed there (pair page), when installed */
  id?: string
}

/** every browser profile of this OS user (Chrome, Edge, Brave), with whether our extension is in it */
export function listProfiles(e: ChromeEnv, ids: string[]): FoundProfile[] {
  const out: FoundProfile[] = []
  const { dirs } = browserDataDirs(e)
  for (const browser of BROWSERS) {
    const root = dirs[browser]
    if (!root) continue
    for (const p of parseLocalState(readJson(path.join(root, 'Local State')))) {
      const id = installedId(path.join(root, p.dir), ids)
      out.push({ browser, dir: p.dir, name: p.name, ...(p.email ? { email: p.email } : {}), installed: !!id, ...(id ? { id } : {}) })
    }
  }
  return out
}

// ---------------------------------------------------------------- native messaging host manifests

/** The manifest Chrome reads to start the helper: our ids only (the dev id only in a development run), no wildcard. */
export function nativeHostManifest(helperPath: string, dev: boolean): Record<string, unknown> | null {
  const ids = chromeExtensionIds(dev)
  if (!ids.length) return null
  return {
    name: CHROME_NATIVE_HOST,
    description: 'Links this browser profile to your team through the desktop app on this computer',
    path: helperPath,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  }
}

/** where each browser looks for per-user hosts (macOS, Linux; Windows uses the registry and is not done here). Only
 * for browsers whose user data folder exists (installed and started once). Chromium too: it reads its own folder. */
export function nativeHostDirs(e: ChromeEnv, exists: (p: string) => boolean = fs.existsSync): string[] {
  if (e.platform === 'win32') return []
  const { dirs, overridden } = browserDataDirs(e)
  const roots = Object.values(dirs)
  if (!overridden) roots.push(e.platform === 'darwin' ? path.join(e.home, 'Library', 'Application Support', 'Chromium') : path.join(e.env.XDG_CONFIG_HOME && path.isAbsolute(e.env.XDG_CONFIG_HOME) ? e.env.XDG_CONFIG_HOME : path.join(e.home, '.config'), 'chromium'))
  return roots.filter(exists).map((r) => path.join(r, 'NativeMessagingHosts'))
}

/** A dev run (or a socket elsewhere than the helper's default) starts the helper through a small script that names
 * the socket: Chrome gives a host no arguments of ours. Written into the app's own user data folder (0700 script). */
export function devHostScript(file: string, helper: string, socket: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `#!/bin/sh\nMYCEL_CHROME_PAIR_SOCKET=${q(socket)} exec ${q(helper)} "$@"\n`, { mode: 0o700 })
  fs.chmodSync(file, 0o700)
  return file
}

/** Write (or refresh) the manifest in each folder; returns the files written. Nothing when no id is allowed yet. */
export function writeNativeHostManifests(dirs: string[], helperPath: string, dev: boolean): string[] {
  const m = nativeHostManifest(helperPath, dev)
  if (!m) return []
  const text = JSON.stringify(m, null, 2) + '\n'
  const done: string[] = []
  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { recursive: true })
      const f = path.join(d, `${CHROME_NATIVE_HOST}.json`)
      if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === text) { done.push(f); continue }
      const tmp = `${f}.${process.pid}.tmp`
      fs.writeFileSync(tmp, text, { mode: 0o644 })
      fs.renameSync(tmp, f)
      done.push(f)
    } catch {
      /* a folder we may not write: that browser falls back to the in-profile Connect */
    }
  }
  return done
}

// ---------------------------------------------------------------- opening a profile

/** the page a profile opens on: the store page without the extension, else the pair page with the app's nonce */
export function pairPageUrl(id: string, nonce: string): string {
  return `chrome-extension://${id}/${CHROME_PAIR_PAGE}#nonce=${nonce}`
}
export { chromeStoreUrl }

export type Exec = (file: string, args: string[]) => Promise<boolean>
/** start a program with an argument list (no shell), detached from the app (a browser it starts outlives the app).
 * True when it exited 0 (a running browser took the URL from it) or still runs after a few seconds (it is the browser). */
export const execBrowser: Exec = (file, args) =>
  new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true })
    } catch {
      return done(false)
    }
    child.once('error', () => done(false))
    child.once('exit', (code) => done(code === 0))
    child.unref()
    setTimeout(() => done(true), 4000).unref()
  })

/** Chrome on macOS and Linux holds `SingletonLock` (a symlink) in its user data folder while it runs */
export function browserRunning(dataDir: string): boolean {
  try { fs.lstatSync(path.join(dataDir, 'SingletonLock')); return true } catch { return false }
}

/**
 * Open a profile on a URL. A browser that is not running starts on the profile first, and the URL follows once it is up:
 * on a cold start Chrome opens command-line tabs before it has loaded the profile's extensions and shows
 * ERR_BLOCKED_BY_CLIENT for an extension page (seen with Chromium 1255 on this Mac). A running browser takes the URL at
 * once (its second process hands it over and exits).
 */
export async function openProfile(o: { binary: string; dataDir: string; passDataDir: boolean; dir: string; url: string; exec?: Exec; running?: boolean; settleMs?: number; platform?: Platform }): Promise<boolean> {
  const exec = o.exec ?? execBrowser
  if (!isProfileDir(o.dir)) return false
  // the folder only when it is not the browser's default (tests): an explicit default changes nothing but is not needed
  const base = [...(o.passDataDir ? [`--user-data-dir=${o.dataDir}`] : []), `--profile-directory=${o.dir}`]
  // Windows has no SingletonLock: assume it runs (a cold start may then show the blocked page once; Reload fixes it)
  const running = o.running ?? ((o.platform ?? process.platform) === 'win32' ? true : browserRunning(o.dataDir))
  if (!running) {
    if (!(await exec(o.binary, [...base, '--no-first-run', '--no-default-browser-check']))) return false
    const end = Date.now() + 10_000
    while (!browserRunning(o.dataDir) && Date.now() < end) await new Promise((r) => setTimeout(r, 200))
    await new Promise((r) => setTimeout(r, o.settleMs ?? 2500))
  }
  return exec(o.binary, [...base, o.url])
}
