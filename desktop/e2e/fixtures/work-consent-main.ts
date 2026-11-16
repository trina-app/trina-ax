// The app's own "Find work files" consent window in the real Electron (src/main/work-consent-window.ts), with the
// built page (dist/ui/consent.html, `bun run build` first) served from the app's own scheme as main.ts serves it. Only
// the window is exercised: no folder is looked at, nothing of this computer is read. work-consent.spec.ts builds and
// starts this file; CONSENT_SHOTS=<folder> also saves what the window shows, light and dark.
import { app, BrowserWindow, nativeTheme, protocol, session } from 'electron'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { UI_SCHEME } from '../../src/common/trust'
import { consentView } from '../../src/common/work-consent'
import type { WorkRoot } from '../../src/common/work-files'
import { askConsent } from '../../src/main/work-consent-window'

const DIST = process.env.CONSENT_DIST!
protocol.registerSchemesAsPrivileged([{ scheme: UI_SCHEME, privileges: { standard: true, secure: true } }])
app.dock?.hide()
app.setPath('userData', mkdtempSync(join(tmpdir(), 'work-consent-profile-')))

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const roots: WorkRoot[] = [
  { id: 'documents', path: '/made-up/Documents', oneDrive: false },
  { id: 'desktop', path: '/made-up/Desktop', oneDrive: false },
  { id: 'downloads', path: '/made-up/Downloads', oneDrive: false },
]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** the consent window opened last (one seen before may still be closing) */
const seen = new Set<number>()
const consentWindow = async () => {
  for (let i = 0; i < 100; i++) {
    const w = BrowserWindow.getAllWindows().find((x) => !seen.has(x.id) && !x.isDestroyed() && x.webContents.getURL().endsWith('/consent.html') && x.isVisible())
    if (w) {
      seen.add(w.id)
      return w
    }
    await sleep(50)
  }
  throw new Error('no consent window')
}
const settled = (p: Promise<boolean>, ms = 300) => Promise.race([p, sleep(ms).then(() => 'open' as const)])
const key = (w: BrowserWindow, keyCode: string) => {
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  w.webContents.sendInputEvent({ type: 'char', keyCode })
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode })
}

void (async () => {
  await app.whenReady()
  session.fromPartition('mycel-ui').protocol.handle(UI_SCHEME, (req) => {
    const root = join(DIST, 'ui')
    const file = join(root, normalize(new URL(req.url).pathname).replace(/^[/\\]+/, ''))
    if (!file.startsWith(root + sep) || !TYPES[extname(file)]) return new Response('not found', { status: 404 })
    return new Response(readFileSync(file), { headers: { 'content-type': TYPES[extname(file)]! } })
  })
  const parent = new BrowserWindow({ width: 900, height: 1000, show: true })
  await parent.loadURL('data:text/html,<body style="background:%23888">team page stand-in</body>')
  const preload = join(DIST, 'preload-consent.cjs')
  const out: Record<string, unknown> = {}

  // 1. what it shows; a click on yes at once does not count; typing holds it back; then Enter (focus is on yes) counts
  {
    const ask = askConsent({ parent, preload, view: consentView('en', 'darwin', roots, null) })
    const w = await consentWindow()
    out.modal = w.isModal() && w.getParentWindow() === parent
    out.text = await w.webContents.executeJavaScript(`({ title: document.querySelector('h1').textContent, places: [...document.querySelectorAll('[data-testid=consent-place]')].map((e) => e.textContent), yes: document.querySelector('[data-testid=consent-yes]').textContent, focused: document.activeElement?.dataset.testid, lang: document.documentElement.lang, bridge: typeof window.mycelDesktop, keys: Object.keys(window.trinaConsent) })`)
    await w.webContents.executeJavaScript(`document.querySelector('[data-testid=consent-yes]').click()`)
    out.earlyClick = await settled(ask.result)
    await sleep(900)
    key(w, 'a')
    key(w, 'Enter')
    out.enterAfterTyping = await settled(ask.result)
    await sleep(900)
    key(w, 'Enter')
    out.enterLater = await settled(ask.result)
    await sleep(500)
    out.closedAfterYes = w.isDestroyed()
  }
  // 1b. Tab goes only between the two buttons, even when the list is long enough to scroll (TC-3490)
  {
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'folder' as const, path: `/m/p${i}`, label: `Project ${i}` }))
    const ask = askConsent({ parent, preload, view: consentView('en', 'darwin', roots, many) })
    const w = await consentWindow()
    const focused = () => w.webContents.executeJavaScript('document.activeElement?.dataset?.testid ?? document.activeElement?.className ?? null')
    out.overflows = await w.webContents.executeJavaScript('(() => { const s = document.querySelector(".consent-body-scroll"); return s.scrollHeight > s.clientHeight })()')
    const tabs: unknown[] = [await focused()]
    for (let i = 0; i < 3; i++) {
      key(w, 'Tab')
      await sleep(100)
      tabs.push(await focused())
    }
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] })
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] })
    await sleep(100)
    tabs.push(await focused())
    // a click on the content, then Tab: a button again
    await w.webContents.executeJavaScript('document.querySelector(".consent-body-scroll").focus(); document.activeElement === document.body || document.querySelector(".consent-places").click(); 1')
    key(w, 'Tab')
    await sleep(100)
    tabs.push(await focused())
    out.tabs = tabs
    ask.close()
    await ask.result
  }
  // 2. Escape: no, at once
  {
    const ask = askConsent({ parent, preload, view: consentView('en', 'darwin', roots, null) })
    const w = await consentWindow()
    key(w, 'Escape')
    out.escape = await settled(ask.result, 1000)
  }
  // 3. another page of the app (as the team page) sends a yes on the window's channel: ignored; closing it is a no
  {
    const ask = askConsent({ parent, preload, view: consentView('en', 'darwin', roots, null) })
    const w = await consentWindow()
    await sleep(900)
    const dir = mkdtempSync(join(tmpdir(), 'work-consent-forger-'))
    const forgerPreload = join(dir, 'forger.cjs')
    writeFileSync(forgerPreload, "const { ipcRenderer } = require('electron'); ipcRenderer.send('consent:answer', true); window.addEventListener('DOMContentLoaded', () => { document.title = JSON.stringify(ipcRenderer.sendSync('consent:view')) })")
    const forger = new BrowserWindow({ show: false, webPreferences: { preload: forgerPreload, sandbox: true, contextIsolation: true } })
    await forger.loadURL('data:text/html,<title>x</title>forger')
    await sleep(300)
    out.forgedView = forger.getTitle()
    out.forgedYes = await settled(ask.result)
    forger.destroy()
    if (!w.isDestroyed()) w.close()
    out.windowStillOpen = !w.isDestroyed()
    out.closed = await settled(ask.result, 1500)
  }
  // 4. the controller closes it (another person or team): no
  {
    const ask = askConsent({ parent, preload, view: consentView('en', 'darwin', roots, null) })
    await consentWindow()
    ask.close()
    out.forgotten = await settled(ask.result)
  }
  // 5. pictures, light and dark, a few languages and the wide look
  const shots = process.env.CONSENT_SHOTS
  if (shots) {
    mkdirSync(shots, { recursive: true })
    const places = [{ kind: 'messenger' as const, path: '/m/k', label: 'KakaoTalk' }, { kind: 'folder' as const, path: '/m/a', label: 'Acme' }, { kind: 'cloud' as const, path: '/m/o', label: 'OneDrive – Acme' }]
    for (const theme of ['light', 'dark'] as const) {
      nativeTheme.themeSource = theme
      for (const [name, view] of [['en', consentView('en', 'darwin', roots, null)], ['en-wide', consentView('en', 'darwin', roots, places)], ['ko', consentView('ko', 'darwin', roots, null)], ['es-wide', consentView('es', 'darwin', roots, places)]] as const) {
        const ask = askConsent({ parent, preload, view })
        const w = await consentWindow()
        await sleep(300)
        writeFileSync(join(shots, `window-${name}-${theme}.png`), (await w.webContents.capturePage()).toPNG())
        ask.close()
        await ask.result
      }
    }
  }
  console.log('CONSENT_RESULT ' + JSON.stringify(out))
  app.exit(0)
})().catch((e) => {
  console.error(e)
  app.exit(1)
})
