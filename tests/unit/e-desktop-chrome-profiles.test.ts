// App-led linking of the <app> in Chrome extension, the desktop app's file side (desktop/src/common/chrome-profiles.ts,
// desktop/src/main/chrome-profiles.ts): profiles from Local State, the extension found in Preferences, the host
// manifest (our ids only, the dev id only in a dev run, nothing when no id is known), the folders it goes in, and how a
// profile is opened (argument list, the pair page with a nonce or the store page, a cold start first). Only temp
// folders: never a real browser's.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHROME_EXTENSION_IDS, CHROME_NATIVE_HOST, chromeExtensionIds } from '@mycel/shared/chrome-native'
import { browserBinary, browserDataDirs, browserLabel, installedId, listProfiles, nativeHostDirs, nativeHostManifest, openProfile, parseLocalState, writeNativeHostManifests, type ChromeEnv } from '../../desktop/src/common/chrome-profiles'
import { ChromeProfilesHost } from '../../desktop/src/main/chrome-profiles'

const DEV = CHROME_EXTENSION_IDS.dev
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chprof-')); dirs.push(d); return d }
const env = (vars: Record<string, string>, o: Partial<ChromeEnv> = {}): ChromeEnv => ({ platform: 'darwin', home: '/Users/x', env: vars, overrides: true, ...o })

function browserDir(profiles: Record<string, { name?: string; user_name?: string; ext?: string[]; secure?: boolean; state?: number }>) {
  const root = tmp()
  const info_cache: Record<string, unknown> = {}
  for (const [dir, p] of Object.entries(profiles)) {
    info_cache[dir] = { name: p.name, user_name: p.user_name ?? '' }
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    const settings = Object.fromEntries((p.ext ?? []).map((id) => [id, { state: p.state ?? 1, location: 4 }]))
    fs.writeFileSync(path.join(root, dir, p.secure ? 'Secure Preferences' : 'Preferences'), JSON.stringify({ extensions: { settings } }))
  }
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache } }))
  return root
}

describe('profiles', () => {
  test('Local State: folder, name and account; odd entries left out', () => {
    expect(parseLocalState({ profile: { info_cache: {
      Default: { name: 'Work', user_name: 'mina@acme.test' },
      'Profile 2': { name: 'Person 2', user_name: '' },
      'Profile 3': { name: 'Guest', is_ephemeral: true },
      '../evil': { name: 'x' },
      'Profile 4': 'not an object',
    } } })).toEqual([{ dir: 'Default', name: 'Work', email: 'mina@acme.test' }, { dir: 'Profile 2', name: 'Person 2' }])
    for (const bad of [null, 1, 'x', {}, { profile: {} }, { profile: { info_cache: [] } }]) expect(parseLocalState(bad)).toEqual([])
  })

  test('installed: our id in Preferences or Secure Preferences; disabled, another id or no file is not', () => {
    const root = browserDir({ Default: { ext: [DEV] }, 'Profile 2': { ext: [DEV], secure: true }, 'Profile 3': { ext: ['a'.repeat(32)] }, 'Profile 4': { ext: [DEV], state: 0 } })
    expect(installedId(path.join(root, 'Default'), [DEV])).toBe(DEV)
    expect(installedId(path.join(root, 'Profile 2'), [DEV])).toBe(DEV)
    expect(installedId(path.join(root, 'Profile 3'), [DEV])).toBeNull()
    expect(installedId(path.join(root, 'Profile 4'), [DEV])).toBeNull()
    expect(installedId(path.join(root, 'Nope'), [DEV])).toBeNull()
    // the dev id counts only where the app allows it (a dev run)
    expect(installedId(path.join(root, 'Default'), chromeExtensionIds(false))).toBeNull()
  })

  test('list: every browser listed in the override, in its own order, with installed', () => {
    const chrome = browserDir({ Default: { name: 'Person 1', user_name: 'me@acme.test', ext: [DEV] }, 'Profile 2': { name: 'Home' } })
    const brave = browserDir({ Default: { name: 'Brave one' } })
    const e = env({ MYCEL_CHROME_DATA_DIRS: `chrome=${chrome},brave=${brave}` })
    expect(listProfiles(e, [DEV])).toEqual([
      { browser: 'chrome', dir: 'Default', name: 'Person 1', email: 'me@acme.test', installed: true, id: DEV },
      { browser: 'chrome', dir: 'Profile 2', name: 'Home', installed: false },
      { browser: 'brave', dir: 'Default', name: 'Brave one', installed: false },
    ])
    // a packaged app ignores the override: the real folders (none of which exist under this made-up home)
    expect(listProfiles({ ...e, overrides: false }, [DEV])).toEqual([])
  })

  test('real folders per system; labels', () => {
    expect(browserDataDirs(env({}, { overrides: false })).dirs.chrome).toBe('/Users/x/Library/Application Support/Google/Chrome')
    expect(browserDataDirs(env({}, { platform: 'linux', home: '/home/x' })).dirs.brave).toBe('/home/x/.config/BraveSoftware/Brave-Browser')
    expect(browserDataDirs(env({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, { platform: 'win32' })).dirs.edge).toBe('C:\\Users\\x\\AppData\\Local\\Microsoft\\Edge\\User Data')
    expect(browserBinary('chrome', env({}, { overrides: false }), (p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(browserBinary('edge', env({}), () => false)).toBeNull()
    expect(browserLabel('chrome', 'darwin')).toBe('Chrome on Mac')
    expect(browserLabel('edge', 'win32')).toBe('Edge on Windows')
  })
})

describe('host manifest', () => {
  test('our ids only, no wildcard; the dev id only in a dev run; nothing while no store id is known', () => {
    const m = nativeHostManifest('/Apps/X.app/Contents/MacOS/chrome-host', true)!
    expect(m).toMatchObject({ name: CHROME_NATIVE_HOST, path: '/Apps/X.app/Contents/MacOS/chrome-host', type: 'stdio' })
    const origins = m.allowed_origins as string[]
    expect(origins).toContain(`chrome-extension://${DEV}/`)
    for (const o of origins) expect(o).toMatch(/^chrome-extension:\/\/[a-p]{32}\/$/)
    expect(JSON.stringify(m)).not.toContain('*')
    const prod = nativeHostManifest('/x', false)
    if (chromeExtensionIds(false).length) expect(prod!.allowed_origins as string[]).not.toContain(`chrome-extension://${DEV}/`)
    else expect(prod).toBeNull()
  })

  test('written into each browser folder that exists (and only temp folders here); unchanged files are left alone', () => {
    const chrome = tmp()
    const e = env({ MYCEL_CHROME_DATA_DIRS: `chrome=${chrome},edge=${path.join(chrome, 'no-edge')}` })
    const where = nativeHostDirs(e)
    expect(where).toEqual([path.join(chrome, 'NativeMessagingHosts')])
    const files = writeNativeHostManifests(where, '/opt/helper', true)
    expect(files).toEqual([path.join(chrome, 'NativeMessagingHosts', `${CHROME_NATIVE_HOST}.json`)])
    expect(JSON.parse(fs.readFileSync(files[0]!, 'utf8')).allowed_origins).toEqual([`chrome-extension://${DEV}/`])
    const before = fs.statSync(files[0]!).mtimeMs
    writeNativeHostManifests(where, '/opt/helper', true)
    expect(fs.statSync(files[0]!).mtimeMs).toBe(before)
    expect(writeNativeHostManifests(where, '/opt/helper', false)).toEqual(chromeExtensionIds(false).length ? files : [])
    // the real per-user folders on a Mac (computed, not written)
    expect(nativeHostDirs(env({}, { overrides: false }), () => true)).toEqual([
      '/Users/x/Library/Application Support/Google/Chrome/NativeMessagingHosts',
      '/Users/x/Library/Application Support/Microsoft Edge/NativeMessagingHosts',
      '/Users/x/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
      '/Users/x/Library/Application Support/Chromium/NativeMessagingHosts',
    ])
    expect(nativeHostDirs(env({}, { platform: 'win32' }), () => true)).toEqual([])
  })

  test('a dev run registers a start script that names its socket', () => {
    const chrome = tmp(), userData = tmp()
    const helper = path.join(userData, 'fake-helper')
    fs.writeFileSync(helper, '#!/bin/sh\n', { mode: 0o755 })
    const host = new ChromeProfilesHost({ userData, dataDirName: 'Team AX', dev: true, execPath: '/nowhere/Electron', team: () => null, env: env({ MYCEL_CHROME_DATA_DIRS: `chrome=${chrome}`, MYCEL_CHROME_HOST_HELPER: helper }) })
    const [f] = host.register()
    const m = JSON.parse(fs.readFileSync(f!, 'utf8'))
    expect(m.path).toBe(path.join(userData, 'chrome', 'chrome-host.sh'))
    const script = fs.readFileSync(m.path, 'utf8')
    expect(script).toContain(`MYCEL_CHROME_PAIR_SOCKET='${host.socket}'`)
    expect(script).toContain(`exec '${helper}' "$@"`)
    expect(fs.statSync(m.path).mode & 0o777).toBe(0o700)
  })
})

describe('opening a profile', () => {
  test('a running browser: one argument list with the profile and the URL (no shell)', async () => {
    const calls: string[][] = []
    const ok = await openProfile({ binary: '/b/Chrome', dataDir: '/d', passDataDir: false, dir: 'Profile 2', url: 'chrome-extension://x/pair.html#nonce=n', running: true, exec: async (f, a) => { calls.push([f, ...a]); return true } })
    expect(ok).toBe(true)
    expect(calls).toEqual([['/b/Chrome', '--profile-directory=Profile 2', 'chrome-extension://x/pair.html#nonce=n']])
    expect(await openProfile({ binary: '/b', dataDir: '/d', passDataDir: false, dir: '../x', url: 'u', running: true, exec: async () => true })).toBe(false)
  })

  test('a browser that is not running starts on the profile first; a test folder is passed as --user-data-dir', async () => {
    const d = tmp()
    const calls: string[][] = []
    const ok = await openProfile({ binary: '/b', dataDir: d, passDataDir: true, dir: 'Default', url: 'U', settleMs: 0, exec: async (_f, a) => { calls.push(a); if (calls.length === 1) fs.symlinkSync('x-1', path.join(d, 'SingletonLock')); return true } })
    expect(ok).toBe(true)
    expect(calls).toEqual([[`--user-data-dir=${d}`, '--profile-directory=Default', '--no-first-run', '--no-default-browser-check'], [`--user-data-dir=${d}`, '--profile-directory=Default', 'U']])
  })

  test('connect: the pair page with a fresh nonce bound to that profile; the store page without the extension', async () => {
    const chrome = browserDir({ Default: { name: 'Person 1', user_name: 'me@acme.test', ext: [DEV] }, 'Profile 2': { name: 'Home' } })
    fs.symlinkSync('x-1', path.join(chrome, 'SingletonLock'))
    const bin = path.join(tmp(), 'chrome')
    fs.writeFileSync(bin, '')
    const urls: string[] = []
    const page = { send: () => {}, isDestroyed: () => false }
    const host = new ChromeProfilesHost({ userData: tmp(), dataDirName: 'Team AX', dev: true, execPath: '/x', team: () => ({ origin: 'https://acme.test', name: 'Acme', page }), env: env({ MYCEL_CHROME_DATA_DIRS: `chrome=${chrome}`, MYCEL_CHROME_BINARIES: `chrome=${bin}` }), exec: async (_f, a) => { urls.push(a[a.length - 1]!); return true } })
    expect(host.list()).toEqual([{ browser: 'chrome', dir: 'Default', name: 'Person 1', email: 'me@acme.test', installed: true }, { browser: 'chrome', dir: 'Profile 2', name: 'Home', installed: false }])
    expect(await host.connect({ browser: 'chrome', dir: 'Default' })).toBe('pair')
    expect(await host.connect({ browser: 'chrome', dir: 'Profile 2' })).toBe('store')
    expect(await host.connect({ browser: 'chrome', dir: 'Profile 9' })).toBe('failed')
    expect(await host.connect({ browser: 'safari', dir: 'Default' })).toBe('failed')
    expect(urls[1]).toMatch(/^https:\/\/chromewebstore\.google\.com\//)
    const m = /^chrome-extension:\/\/([a-p]{32})\/pair\.html#nonce=([A-Za-z0-9_-]{43})$/.exec(urls[0]!)
    expect(m?.[1]).toBe(DEV)
    expect(host.nonces.take(m![2]!)).toEqual({ browser: 'chrome', dir: 'Default', label: 'Person 1', email: 'me@acme.test', browserLabel: 'Chrome on Mac', teamOrigin: 'https://acme.test' })
  })
})
