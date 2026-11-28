// End to end on the REAL Google Chrome of this Mac (not Playwright's Chromium): app-led linking of the <app> in Chrome
// extension through the real native helper, with the app's pair module (main/chrome-profiles.ts) in this process and a
// user data folder whose path is far longer than a Unix socket allows (the pair socket must not depend on it).
// Branded Chrome dropped --load-extension (137+), so the unpacked build is loaded over the DevTools protocol
// (Extensions.loadUnpacked, --enable-unsafe-extension-debugging) into a throwaway profile.
// Run: bun chrome-extension/build.ts && bash desktop/native/chrome-host/build.sh &&
//      bun test ./tests/e2e/chrome-app-link-real.test.ts (macOS with Google Chrome in /Applications; skipped otherwise)
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { CHROME_EXTENSION_IDS } from '@mycel/shared/chrome-native'
import { startHarness, type Harness } from '../lib/b-harness'
import { ChromeProfilesHost, type PageLike } from '../../desktop/src/main/chrome-profiles'

setDefaultTimeout(180_000)
const CHROME = process.env.MYCEL_TEST_REAL_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DIST = path.join(import.meta.dir, '..', '..', 'chrome-extension', 'dist')
const HELPER = path.join(import.meta.dir, '..', '..', 'desktop', 'native-build', 'chrome-host')
const DEV = CHROME_EXTENSION_IDS.dev
const ready = process.platform === 'darwin' && fs.existsSync(CHROME)

let h: Harness
let ud: string
let userData: string
let browser: ChildProcess | undefined
let host: ChromeProfilesHost
const linkedNotices: unknown[] = []

const until = async <T>(f: () => T | Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await Bun.sleep(200)
  }
}

/** a DevTools connection to the browser */
async function cdp(port: string, wsPath: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pend = new Map<number, (v: any) => void>()
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id) } }
  const call = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })) })
  return { call, close: () => ws.close() }
}

beforeAll(async () => {
  if (!ready) return
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) throw new Error('build the extension first: bun chrome-extension/build.ts')
  if (!fs.existsSync(HELPER)) throw new Error('build the helper first: bash desktop/native/chrome-host/build.sh')
  h = await startHarness({ name: 'chrome-app-link-real' })
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'chalr-ud-'))
  // an app user data folder whose <it>/chrome/pair.sock is far past the 104-byte socket limit
  userData = fs.mkdtempSync(path.join(os.tmpdir(), `chalr-${'long-user-data-folder-'.repeat(4)}`))
  fs.writeFileSync(path.join(ud, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Work' } } } }))
  host = new ChromeProfilesHost({
    userData, dataDirName: 'Team AX', dev: true, execPath: '/nowhere/Electron',
    env: { platform: 'darwin', home: os.homedir(), overrides: true, env: { MYCEL_CHROME_DATA_DIRS: `chrome=${ud}`, MYCEL_CHROME_BINARIES: `chrome=${CHROME}`, MYCEL_CHROME_HOST_HELPER: HELPER } },
    team: () => ({ origin: h.url, name: 'Acme', page }),
  })
  const page: PageLike = {
    isDestroyed: () => false,
    send: (channel, payload: any) => {
      if (channel === 'bridge:chrome-linked') return void linkedNotices.push(payload)
      if (channel !== 'bridge:chrome-pair-request') return
      h.ctx.db.query('DELETE FROM login_attempts').run()
      void h.api('alice').call(API.chromePair, { body: { challenge: payload.challenge } }).then((r) => host.answer(page, payload.id, { code: r.code }), () => host.answer(page, payload.id, null))
    },
  }
  // the browsers' folders are test folders: the app writes the host manifest there by itself (no MYCEL_CHROME_REGISTER_HOST)
  host.start()
  expect(host.socket!.length).toBeLessThan(104)
  expect(fs.existsSync(path.join(ud, 'NativeMessagingHosts', 'com.mycel.chrome_host.json'))).toBe(true)
  browser = spawn(CHROME, [`--user-data-dir=${ud}`, '--profile-directory=Default', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--window-position=-3000,-3000', '--window-size=500,400', 'about:blank'], { stdio: 'ignore' })
  await until(() => fs.existsSync(path.join(ud, 'DevToolsActivePort')), 'browser up')
  const [port, wsPath] = fs.readFileSync(path.join(ud, 'DevToolsActivePort'), 'utf8').split('\n')
  const c = await cdp(port!, wsPath!)
  const r = await c.call('Extensions.loadUnpacked', { path: DIST })
  c.close()
  expect(r.result?.id).toBe(DEV)
  await until(() => host.list().some((p) => p.installed), 'the extension listed in the profile\'s Preferences')
})

afterAll(async () => {
  host?.stop()
  browser?.kill()
  await h?.close()
  for (const d of [ud, userData]) if (d) fs.rmSync(d, { recursive: true, force: true })
})

test.skipIf(!ready)('real Chrome links with no click through the real helper, long user data folder', async () => {
  expect(await host.unavailable()).toBeNull()
  expect(await host.connect({ browser: 'chrome', dir: 'Default' })).toBe('pair')
  const links = await until(async () => { const l = (await h.api('alice').call(API.chromeLinks, {})).links; return l.length === 1 ? l : null }, 'the link')
  expect(links[0]!.label).toBe('Work')
  await until(() => linkedNotices.length === 1, 'the notice with Undo')
  await until(async () => (await h.api('alice').call(API.chromeLinks, {})).links.some((l) => l.online), 'online')
})

/** the text of an extension page this Chrome shows now (opened over the DevTools protocol) */
async function pageText(url: string, wait: (t: string) => boolean): Promise<string> {
  const [port, wsPath] = fs.readFileSync(path.join(ud, 'DevToolsActivePort'), 'utf8').split('\n')
  const c = await cdp(port!, wsPath!)
  try {
    const t = await c.call('Target.createTarget', { url })
    const a = await c.call('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })
    return await until(async () => { const e = await c.call('Runtime.evaluate', { expression: 'document.body.innerText' }, a.result.sessionId); const s = String(e.result?.result?.value ?? ''); return wait(s) ? s : null }, 'the pair page\'s words', 15_000)
  } finally { c.close() }
}

test.skipIf(!ready)('the pair page says the real reason: no helper registered for this browser, or an app that does not answer', async () => {
  const nonce = 'A'.repeat(43)
  // the manifest gone (the app never ran with this browser, or an old app): not "the desktop app is not running"
  const manifest = path.join(ud, 'NativeMessagingHosts', 'com.mycel.chrome_host.json')
  const kept = fs.readFileSync(manifest)
  fs.rmSync(manifest)
  const noHost = await pageText(`chrome-extension://${DEV}/pair.html#nonce=${nonce}`, (s) => s.includes('desktop app') && !s.includes('Connecting'))
  expect(noHost).toContain('cannot find the')
  expect(noHost).not.toContain('is not running')
  // the app is gone (socket closed): "not running"
  fs.writeFileSync(manifest, kept)
  host.stop()
  const gone = await pageText(`chrome-extension://${DEV}/pair.html#nonce=${nonce}`, (s) => s.includes('desktop app') && !s.includes('Connecting'))
  expect(gone).toContain('is not running')
})
