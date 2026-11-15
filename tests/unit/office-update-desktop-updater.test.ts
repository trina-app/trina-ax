// The Windows updater's wiring (desktop/src/main/updater.ts) with Electron and electron-updater replaced by fakes:
// nothing is ready to install before the signed release names the download; a contradicted download is deleted,
// announced once and not downloaded again; an unreadable manifest keeps the download; no new download while one is
// being checked; a file replaced after its check is never installed (restart or quit). The pure check is in
// office-update-desktop.test.ts. The Mac updater (Squirrel.Mac): the checked zip is handed to Squirrel only after the
// signed release names it, and a Squirrel error leaves nothing ready.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileUrl, OFFICE_PRODUCT, publicKeyOf, signRelease, type OfficeRelease } from '../../server/src/office/release'
import { WORK } from '../lib/env'

const DIR = path.join(WORK, 'office-update-desktop-updater')
fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })
const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
const KEYS = [publicKeyOf(pem)]
const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')
const TEAM = 'https://acme.example.test'

function signed(exe: Uint8Array, version = '0.3.0'): string {
  const name = `Team-AX-Setup-${version}-win-x64.exe`
  const r: OfficeRelease = {
    format: 1, product: OFFICE_PRODUCT, channel: 'stable', version, minFrom: '0.2.0-0', publishedAt: new Date().toISOString(), notes: '',
    office: [{ arch: 'universal', file: 'x.zip', url: fileUrl('https://f.example.test', version, 'x.zip'), sha256: sha('z'), size: 1 }],
    windows: {
      version,
      installer: { file: name, url: fileUrl('https://f.example.test', version, name), sha256: sha(exe), size: exe.byteLength },
      latestYml: { file: 'latest.yml', url: fileUrl('https://f.example.test', version, 'latest.yml'), sha256: sha('y'), size: 1 },
    },
  }
  return signRelease(r, pem)
}

// --- fakes ---
let served = new Map<string, string>()
const fetched: string[] = []
let quitHandlers: ((e: unknown, code: number) => void)[] = []
const dialogs: string[] = []
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  disableDifferentialDownload = false
  disableWebInstaller = false
  forceDevUpdateConfig = false
  requestHeaders: Record<string, string> | null = null
  logger: unknown = null
  installerPath: string | null = null
  available: { version: string } | null = null
  /** what the next downloadUpdate puts on disk */
  next: { file: string; bytes: Uint8Array } | null = null
  downloads = 0
  installs: string[] = []
  setFeedURL() {}
  async checkForUpdates() { return this.available ? { isUpdateAvailable: true, updateInfo: this.available } : { isUpdateAvailable: false, updateInfo: { version: '0.2.5' } } }
  async downloadUpdate() {
    this.downloads++
    const n = this.next!
    fs.writeFileSync(n.file, n.bytes)
    this.installerPath = n.file
    this.emit('update-downloaded', { version: this.available!.version, downloadedFile: n.file })
    return [n.file]
  }
  quitAndInstall() { this.installs.push(`restart ${this.installerPath}`) }
  install() { this.installs.push(`quit ${this.installerPath}`); return true }
}
const fake = new FakeUpdater()
/** Electron's autoUpdater (Squirrel.Mac): checkForUpdates stages what electron-updater's proxy serves */
class FakeNative extends EventEmitter {
  checks = 0
  fail: string | null = null
  checkForUpdates() { this.checks++; setTimeout(() => (this.fail ? this.emit('error', new Error(this.fail)) : this.emit('update-downloaded')), 1) }
}
const native = new FakeNative()
const ses = {
  cookies: { get: async () => [{ name: 'mycel_session', value: 'a'.repeat(32) }] },
  fetch: async (url: string) => {
    fetched.push(url)
    const b = served.get(url)
    return b === undefined ? new Response('nf', { status: 404 }) : new Response(b)
  },
}
mock.module('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.2.5', getPath: () => DIR, once: (ev: string, h: (e: unknown, code: number) => void) => { if (ev === 'quit') quitHandlers.push(h) } },
  dialog: { showMessageBox: async (o: { message: string }) => { dialogs.push(o.message); return { response: 1 } } },
  session: { fromPartition: () => ses, defaultSession: ses },
  autoUpdater: native,
}))
mock.module('electron-updater', () => ({ autoUpdater: fake }))
const { DesktopUpdater } = await import('../../desktop/src/main/updater')
const { SESSION_COOKIE } = await import('@mycel/shared/api')
ses.cookies.get = async () => [{ name: SESSION_COOKIE, value: 'a'.repeat(32) }]

let changed = 0
function updater(platform: NodeJS.Platform = 'win32') {
  const u = new DesktopUpdater({ team: () => ({ id: 't1', origin: TEAM }), window: () => null, locale: () => 'en', openApps: () => {}, changed: () => { changed++ } }, { keys: KEYS, product: OFFICE_PRODUCT, platform })
  ;(u as unknown as { mode: string }).mode = 'auto-install'
  return u
}
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 5)) }

beforeEach(() => {
  served = new Map()
  fetched.length = 0
  quitHandlers = []
  dialogs.length = 0
  changed = 0
  fake.removeAllListeners()
  native.removeAllListeners()
  Object.assign(native, { checks: 0, fail: null })
  Object.assign(fake, { installerPath: null, available: { version: '0.3.0' }, next: null, downloads: 0, installs: [] })
})
afterAll(() => { mock.restore() })

describe('the Windows updater installs only a download the signed release names', () => {
  test('a matching download: ready, restart and quit install that file; electron-updater installs nothing by itself', async () => {
    const exe = crypto.randomBytes(3000)
    const file = path.join(DIR, 'good.exe')
    served.set(`${TEAM}/downloads/stable.json`, signed(exe))
    fake.next = { file, bytes: exe }
    const u = updater()
    await u.check()
    await settle()
    expect(fake.autoInstallOnAppQuit).toBe(false)
    expect(fake.autoDownload).toBe(false)
    expect(fake.disableWebInstaller).toBe(true)
    expect(u.ready).toBe('0.3.0')
    expect(fetched[0]).toBe(`${TEAM}/downloads/stable.json`)
    u.restartNow()
    expect(fake.installs).toEqual([`restart ${file}`])
    quitHandlers.forEach((h) => h({}, 0))
    expect(fake.installs).toEqual([`restart ${file}`, `quit ${file}`])
  })

  test('another program than the signed release names: deleted, said once, never ready, not downloaded again', async () => {
    const file = path.join(DIR, 'evil.exe')
    served.set(`${TEAM}/downloads/stable.json`, signed(crypto.randomBytes(3000)))
    fake.next = { file, bytes: crypto.randomBytes(3000) }
    const u = updater()
    await u.check()
    await settle()
    expect(u.ready).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
    expect(dialogs).toEqual(["This update couldn't be checked, so it wasn't installed."])
    expect(quitHandlers).toEqual([])
    u.restartNow()
    expect(fake.installs).toEqual([])
    await u.check()
    await settle()
    expect(fake.downloads).toBe(1)
    expect(dialogs.length).toBe(1)
  })

  test('nothing signed can be read (server down, no internet): the download stays, no notice, checked again next time', async () => {
    const exe = crypto.randomBytes(3000)
    const file = path.join(DIR, 'unread.exe')
    fake.next = { file, bytes: exe }
    const u = updater()
    await u.check()
    await settle()
    expect(u.ready).toBeNull()
    expect(fs.existsSync(file)).toBe(true)
    expect(dialogs).toEqual([])
    // the team server is back: the next check verifies the same download
    served.set(`${TEAM}/downloads/stable.json`, signed(exe))
    await u.check()
    await settle()
    expect(u.ready).toBe('0.3.0')
  })

  test('a file replaced after its check is not installed, by restart or on quit', async () => {
    const exe = crypto.randomBytes(3000)
    const file = path.join(DIR, 'swapped.exe')
    served.set(`${TEAM}/downloads/stable.json`, signed(exe))
    fake.next = { file, bytes: exe }
    const u = updater()
    await u.check()
    await settle()
    expect(u.ready).toBe('0.3.0')
    fs.writeFileSync(file, crypto.randomBytes(3000))
    quitHandlers.forEach((h) => h({}, 0))
    u.restartNow()
    expect(fake.installs).toEqual([])
    expect(u.ready).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
  })

  test('no new check or download while a download is being checked', async () => {
    const exe = crypto.randomBytes(3000)
    const file = path.join(DIR, 'slow.exe')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const realFetch = ses.fetch
    ses.fetch = async (url: string) => { await gate; return realFetch(url) }
    try {
      served.set(`${TEAM}/downloads/stable.json`, signed(exe))
      fake.next = { file, bytes: exe }
      const u = updater()
      await u.check()
      expect(fake.downloads).toBe(1)
      // a timer check while the manifest is still on its way: nothing is downloaded over the file being checked
      await u.check()
      expect(fake.downloads).toBe(1)
      release()
      await settle()
      expect(u.ready).toBe('0.3.0')
    } finally { ses.fetch = realFetch }
  })
})

function signedMac(zip: Uint8Array, version = '0.3.0'): string {
  const f = (file: string, sha256: string, size: number) => ({ file, url: fileUrl('https://f.example.test', version, file), sha256, size })
  const r: OfficeRelease = {
    format: 1, product: OFFICE_PRODUCT, channel: 'stable', version, minFrom: '0.2.0-0', publishedAt: new Date().toISOString(), notes: '',
    office: [{ arch: 'universal', ...f('x.zip', sha('z'), 1) }], windows: null,
    mac: { version, dmg: f(`Trina-AX-${version}-mac-universal.dmg`, sha('d'), 1), zip: f(`Trina-AX-${version}-mac-universal.zip`, sha(zip), zip.byteLength), latestYml: f('latest-mac.yml', sha('y'), 1) },
  }
  return signRelease(r, pem)
}

describe('the Mac updater hands Squirrel.Mac only a zip the signed release names', () => {
  test('a matching zip: Squirrel stages it, then ready; restart goes through electron-updater; no quit handler', async () => {
    const zip = crypto.randomBytes(3000)
    served.set(`${TEAM}/downloads/stable.json`, signedMac(zip))
    fake.next = { file: path.join(DIR, 'good.zip'), bytes: zip }
    const u = updater('darwin')
    await u.check()
    await settle()
    expect(native.checks).toBe(1)
    expect(u.ready).toBe('0.3.0')
    expect(quitHandlers).toEqual([])
    u.restartNow()
    expect(fake.installs.length).toBe(1)
  })

  test('a zip the signed release does not name (or a Windows-only release): never given to Squirrel', async () => {
    served.set(`${TEAM}/downloads/stable.json`, signedMac(crypto.randomBytes(3000)))
    fake.next = { file: path.join(DIR, 'evil.zip'), bytes: crypto.randomBytes(3000) }
    const u = updater('darwin')
    await u.check()
    await settle()
    expect(native.checks).toBe(0)
    expect(u.ready).toBeNull()
    expect(fs.existsSync(path.join(DIR, 'evil.zip'))).toBe(false)
    const zip = crypto.randomBytes(3000)
    served.set(`${TEAM}/downloads/stable.json`, signed(zip))
    fake.next = { file: path.join(DIR, 'win.zip'), bytes: zip }
    const v = updater('darwin')
    await v.check()
    await settle()
    expect(native.checks).toBe(0)
    expect(v.ready).toBeNull()
  })

  test('Squirrel refuses (an app run from the dmg): nothing ready, not downloaded again in this run', async () => {
    const zip = crypto.randomBytes(3000)
    served.set(`${TEAM}/downloads/stable.json`, signedMac(zip))
    fake.next = { file: path.join(DIR, 'ro.zip'), bytes: zip }
    native.fail = 'Cannot update while running on a read-only volume'
    const u = updater('darwin')
    await u.check()
    await settle()
    expect(native.checks).toBe(1)
    expect(u.ready).toBeNull()
    await u.check()
    await settle()
    expect(fake.downloads).toBe(1)
  })
})
