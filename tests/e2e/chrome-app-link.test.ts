// End to end: app-led linking of the <app> in Chrome extension (shared/src/chrome-native.ts). The real server, the
// unpacked extension in TWO profiles of one Chromium (a temp user data folder whose Local State names them), the real
// native helper registered in that folder's NativeMessagingHosts, and the app's pair module (main/chrome-profiles.ts)
// in this process with a fake team page that answers the pair request with the real API as a signed-in person.
// connect() opens each profile on the pair page exactly as the app does (the browser's command line, handed to the
// running browser), and both profiles end linked with no click, named from Local State.
// Run: bun chrome-extension/build.ts && bash desktop/native/chrome-host/build.sh &&
//      bun test ./tests/e2e/chrome-app-link.test.ts (macOS; needs Playwright's Chromium: `bunx playwright install
//      chromium` in tests/). Chromium runs with a window, moved off screen: a headless one does not take a second
//      start's URL (no process singleton).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { API } from '@mycel/shared/api'
import { CHROME_EXTENSION_IDS } from '@mycel/shared/chrome-native'
import { startHarness, type Harness } from '../lib/b-harness'
import { ChromeProfilesHost, type PageLike } from '../../desktop/src/main/chrome-profiles'

setDefaultTimeout(180_000)
const DIST = path.join(import.meta.dir, '..', '..', 'chrome-extension', 'dist')
const HELPER = path.join(import.meta.dir, '..', '..', 'desktop', 'native-build', 'chrome-host')
const DEV = CHROME_EXTENSION_IDS.dev

let h: Harness
let ud: string
let userData: string
let browser: ChildProcess | undefined
let host: ChromeProfilesHost
const linkedNotices: unknown[] = []
const asked: string[] = []

const until = async <T>(f: () => T | Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await Bun.sleep(200)
  }
}

beforeAll(async () => {
  if (process.platform !== 'darwin') throw new Error('macOS only (the helper is a Mac program)')
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) throw new Error('build the extension first: bun chrome-extension/build.ts')
  if (!fs.existsSync(HELPER)) throw new Error('build the helper first: bash desktop/native/chrome-host/build.sh')
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'))
  if (!manifest.key || !fs.existsSync(path.join(DIST, 'pair.html'))) throw new Error('the extension build has no dev key or pair page')
  h = await startHarness({ name: 'chrome-app-link' })
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'chal-ud-'))
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'chal-'))
  // two profiles as Chrome lists them, named by the person. (Chromium clears `user_name` of a profile that is not
  // signed in to Google, so the account-as-name case is covered by the unit tests, not here.)
  fs.writeFileSync(path.join(ud, 'Local State'), JSON.stringify({ profile: { info_cache: {
    Default: { name: 'Work' },
    'Profile 2': { name: 'Home' },
  } } }))
  const bin = chromium.executablePath()
  host = new ChromeProfilesHost({
    userData, dataDirName: 'Team AX', dev: true, execPath: '/nowhere/Electron',
    env: { platform: 'darwin', home: os.homedir(), overrides: true, env: { MYCEL_CHROME_DATA_DIRS: `chrome=${ud}`, MYCEL_CHROME_BINARIES: `chrome=${bin}`, MYCEL_CHROME_HOST_HELPER: HELPER } },
    team: () => ({ origin: h.url, name: 'Acme', page }),
  })
  // the team page on screen: answers a pair request with POST /api/chrome/pair as alice (as the web's handler does)
  const page: PageLike = {
    isDestroyed: () => false,
    send: (channel, payload: any) => {
      if (channel === 'bridge:chrome-linked') return void linkedNotices.push(payload)
      if (channel !== 'bridge:chrome-pair-request') return
      asked.push(payload.challenge)
      h.ctx.db.query('DELETE FROM login_attempts').run()
      void h.api('alice').call(API.chromePair, { body: { challenge: payload.challenge } }).then((r) => host.answer(page, payload.id, { code: r.code }), () => host.answer(page, payload.id, null))
    },
  }
  host.start()
  const files = host.register()
  expect(files).toEqual([path.join(ud, 'NativeMessagingHosts', 'com.mycel.chrome_host.json')])

  browser = spawn(bin, [`--user-data-dir=${ud}`, '--profile-directory=Default', `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--window-position=-3000,-3000', '--window-size=500,400', 'about:blank'], { stdio: 'ignore' })
  await until(() => fs.existsSync(path.join(ud, 'DevToolsActivePort')), 'browser up')
  // the second profile, opened in the running browser the way a person would; both load the extension
  await new Promise((r) => spawn(bin, [`--user-data-dir=${ud}`, '--profile-directory=Profile 2', 'about:blank'], { stdio: 'ignore' }).on('exit', r))
  await until(() => host.list().filter((p) => p.installed).length === 2, 'the extension listed in both profiles\' Preferences')
})

afterAll(async () => {
  host?.stop()
  browser?.kill()
  await h?.close()
  for (const d of [ud, userData]) if (d) fs.rmSync(d, { recursive: true, force: true })
})

test('both profiles link with no click, named from Local State', async () => {
  const profiles = host.list()
  expect(profiles).toEqual([
    { browser: 'chrome', dir: 'Default', name: 'Work', installed: true },
    { browser: 'chrome', dir: 'Profile 2', name: 'Home', installed: true },
  ])
  expect(await host.connect({ browser: 'chrome', dir: 'Default' })).toBe('pair')
  await until(async () => (await h.api('alice').call(API.chromeLinks, {})).links.length === 1, 'first link')
  expect(await host.connect({ browser: 'chrome', dir: 'Profile 2' })).toBe('pair')
  const links = await until(async () => { const l = (await h.api('alice').call(API.chromeLinks, {})).links; return l.length === 2 ? l : null }, 'second link')
  expect(links.map((l) => l.label).sort()).toEqual(['Home', 'Work'])
  await until(() => linkedNotices.length === 2, 'the notices with Undo')
  expect(linkedNotices).toEqual(expect.arrayContaining([
    { linkId: expect.any(String), label: 'Work', browser: 'Chrome on Mac' },
    { linkId: expect.any(String), label: 'Home', browser: 'Chrome on Mac' },
  ]))
  expect(asked.length).toBe(2)
  // each profile's extension went online on its own link
  await until(async () => (await h.api('alice').call(API.chromeLinks, {})).links.filter((l) => l.online).length === 2, 'both online')
  // the pair pages close themselves and the nonce is out of the address
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${fs.readFileSync(path.join(ud, 'DevToolsActivePort'), 'utf8').split('\n')[0]}`)
  try {
    await until(() => cdp.contexts().flatMap((c) => c.pages()).every((p) => !p.url().includes('nonce=')), 'no page with a nonce')
    await until(() => !cdp.contexts().flatMap((c) => c.pages()).some((p) => p.url().startsWith(`chrome-extension://${DEV}/pair.html`)), 'the pair pages closed', 10_000)
  } finally {
    await cdp.close().catch(() => {})
  }
})
