// Helpers for the desktop e2e tests: launch the built app with a throw-away user data folder, find its views
// (welcome / pane toolbar / team page / browser tabs are separate web contents), and drive the fake team server.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'

export const ROOT = resolve(import.meta.dirname, '..')
export const ACME = 'http://acme.localhost:19151'
export const BETA = 'http://beta.localhost:19152'
export const LAN = 'http://lan.localhost:19156'
export const BAD = 'http://bad.localhost:19157'
export const SHOP = 'http://shop.test:19153'
/** an office-network name (mapped to 127.0.0.1 by the test build): asks the person */
export const OFFICE_SITE = 'http://nas.lan:19153'
/** a "public" server that logs every request URL (exfil.spec.ts) */
export const ATTACKER = 'http://attacker.test:19158'

/**
 * A throw-away user data folder. The app's own screens start in English (not the system language); these tests were
 * written against the Korean screens, so they set Korean explicitly, the way a team page in Korean would leave it.
 * Pass null for a fresh install (English).
 */
export function newUserData(locale: 'ko' | 'en' | 'id' | 'ja' | 'es' | null = 'ko'): string {
  const dir = mkdtempSync(join(tmpdir(), 'teamax-desktop-'))
  if (locale) writeFileSync(join(dir, 'ui-locale.json'), JSON.stringify({ locale }))
  return dir
}

export async function launch(userData: string, env: Record<string, string> = {}): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [join(ROOT, 'dist/main.cjs')],
    cwd: ROOT,
    env: {
      ...(process.env as Record<string, string>),
      MYCEL_DESKTOP_USER_DATA: userData,
      MYCEL_DESKTOP_TEST_PUBLIC_HOSTS: 'shop.test,cdn.shop.test,attacker.test',
      MYCEL_DESKTOP_TEST_PRIVATE_HOSTS: 'nas.lan',
      // resolved by the pane session's own resolver to 127.0.0.1, with no test exemption (quiet.spec.ts)
      MYCEL_DESKTOP_TEST_DNS_HOSTS: 'rebind.test',
      // a Korean system: the app's own language must not follow it (docs/DECISIONS.md "언어")
      LANG: 'ko_KR.UTF-8',
      ...env,
    },
  })
  if (process.env.MYCEL_DESKTOP_DEBUG === '1') {
    app.process().stdout?.on('data', (d) => process.stdout.write(`[app] ${d}`))
    app.process().stderr?.on('data', (d) => process.stdout.write(`[app:err] ${d}`))
  }
  return app
}

/** The page (any view) whose URL matches. */
export async function view(app: ElectronApplication, match: (url: string) => boolean, timeout = 20_000): Promise<Page> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const p = app.windows().find((w) => !w.isClosed() && match(w.url()))
    if (p) return p
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no view matching; have: ${app.windows().map((w) => w.url()).join(', ')}`)
}

export const welcome = (app: ElectronApplication) => view(app, (u) => u.endsWith('/welcome.html'))
export const chrome = (app: ElectronApplication) => view(app, (u) => u.endsWith('/pane.html'))
export const teamPage = (app: ElectronApplication, origin: string) => view(app, (u) => u.startsWith(origin))

/** windowId of the team page under test, per team origin (calls go to exactly that window). */
const windows = new Map<string, string>()

/** Wait until the team page's WebSocket is open and remember its windowId for call(). */
export async function bindWindow(p: Page, origin: string): Promise<Page> {
  await expect.poll(() => p.evaluate(() => (window as any).testState?.ws).catch(() => null)).toBe('open')
  windows.set(new URL(origin).port, await p.evaluate(() => (window as any).testState.windowId as string))
  return p
}

export async function addTeam(app: ElectronApplication, address: string, origin: string): Promise<Page> {
  const w = await welcome(app)
  await w.getByRole('textbox', { name: '초대 링크 또는 팀 주소' }).fill(address)
  await w.getByRole('button', { name: '들어가기' }).click()
  return bindWindow(await teamPage(app, origin), origin)
}

/** Sign the team page in (the fake server's session cookie). Every AI browser call checks who is signed in first
 * (app-window.ts ensureBrowserOwner): a team page without a session gets "browser identity could not be verified". */
export async function signIn(page: Page, user?: string): Promise<Page> {
  await page.evaluate((u) => fetch(u ? `/test/login?user=${encodeURIComponent(u)}` : '/test/login'), user ?? null)
  return page
}

// ---------------------------------------------------------------- fake team server control

/** A UUIDv7 (the contract's turn id format). */
export function uuid7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  const ms = Date.now()
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff
  b[6] = (b[6] & 0x0f) | 0x70
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Calls of one AI turn share a turnId ("allow once" lasts for the turn). */
let currentTurn = uuid7()
export function newTurn(): string {
  currentTurn = uuid7()
  return currentTurn
}

export async function call(origin: string, tool: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<{ callId: string; turnId: string }> {
  const port = new URL(origin).port
  const body = { tool, args, windowId: windows.get(port), turnId: currentTurn, ...extra }
  const r = await fetch(`http://127.0.0.1:${port}/test/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`call failed: ${r.status} ${await r.text()}`)
  return r.json()
}

export interface ResultEnvelope {
  result: { callId: string; ok: boolean; content: ({ type: 'text'; text: string } | { type: 'image'; mime: string; data: string; shareToChat?: boolean })[]; error?: string }
  count: number
  acks: number
}

export async function result(origin: string, callId: string, waitMs = 60_000): Promise<ResultEnvelope> {
  const port = new URL(origin).port
  const r = await fetch(`http://127.0.0.1:${port}/test/result?callId=${encodeURIComponent(callId)}&waitMs=${waitMs}`)
  if (!r.ok) throw new Error(`no result for ${callId}: ${r.status}`)
  return r.json()
}

export const text = (r: ResultEnvelope) => r.result.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')

export async function run(origin: string, tool: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const { callId } = await call(origin, tool, args, extra)
  return result(origin, callId)
}

export async function cancel(origin: string, callId: string) {
  const port = new URL(origin).port
  await fetch(`http://127.0.0.1:${port}/test/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId, windowId: windows.get(port) }) })
}

export async function skew(origin: string, ms: number) {
  const port = new URL(origin).port
  await fetch(`http://127.0.0.1:${port}/test/skew`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ms }) })
}

export async function siteHits(path: string): Promise<number> {
  const r = await fetch(`http://127.0.0.1:19153/test/hits?path=${encodeURIComponent(path)}`)
  return ((await r.json()) as { hits: number }).hits
}

/** Answer the first permission prompt in the pane toolbar. */
export async function answer(app: ElectronApplication, button: '이번만 허용' | '항상 허용' | '거부', scope?: 'site' | 'private') {
  const c = await chrome(app)
  const prompt = c.getByTestId('permission-prompt').first()
  await expect(prompt).toBeVisible()
  if (scope) await expect(prompt).toHaveAttribute('data-scope', scope)
  await prompt.getByRole('button', { name: button }).click()
}

/** The pane's activity log (opened from the toolbar when it is closed): routine events only show up here. */
export async function activityLog(app: ElectronApplication) {
  const c = await chrome(app)
  const button = c.getByTestId('activity-button')
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  return c.getByTestId('activity')
}

/** The browser tab view (web contents of the pane's active tab) whose URL matches. */
export const tabPage = (app: ElectronApplication, match: (url: string) => boolean) => view(app, match)

type Box = { x: number; y: number; width: number; height: number }
export interface PaneViews {
  /** the window's content size */
  content: { width: number; height: number }
  /** the team page's view */
  page: Box | null
  /** the browser toolbar's view (it reaches the grab strip over the team page's edge) */
  toolbar: Box | null
  /** the active tab's view, and whether it is drawn */
  tab: (Box & { visible: boolean; url: string }) | null
}

/** Where the window's views are now (main/app-window.ts layout, main/pane/pane.ts layout). */
export function paneViews(app: ElectronApplication, origin = ACME): Promise<PaneViews> {
  return app.evaluate(({ BaseWindow }, teamOrigin) => {
    const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!
    const [width, height] = win.getContentSize()
    const kids = win.contentView.children as (Electron.View & { webContents?: Electron.WebContents })[]
    const url = (v: (typeof kids)[number]) => (v.webContents && !v.webContents.isDestroyed() ? v.webContents.getURL() : '')
    const page = kids.find((v) => url(v).startsWith(teamOrigin))
    const toolbar = kids.find((v) => url(v).endsWith('/pane.html'))
    const tab = kids.find((v) => v !== page && v.webContents && !url(v).startsWith('mycel-ui:') && !url(v).startsWith(teamOrigin))
    return {
      content: { width, height },
      page: page ? page.getBounds() : null,
      toolbar: toolbar ? toolbar.getBounds() : null,
      tab: tab ? { ...tab.getBounds(), visible: tab.getVisible(), url: url(tab) } : null,
    }
  }, origin)
}

/**
 * The person drags the edge between the team page and the browser so that it ends at `edgeX` (window content
 * coordinates), as the system does it: the toolbar's view gets the keyboard on the press, then the press, the moves
 * (screen coordinates in globalX) and the release reach its page. `release: false` stops before the release.
 */
export async function dragEdge(app: ElectronApplication, edgeX: number, o: { release?: boolean; steps?: number } = {}) {
  await app.evaluate(async ({ BaseWindow }, { target, release, steps }) => {
    const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!
    const content = win.getContentBounds()
    const toolbar = (win.contentView.children as (Electron.View & { webContents?: Electron.WebContents })[]).find((v) => v.webContents?.getURL().endsWith('/pane.html'))!
    const b = toolbar.getBounds()
    const wc = toolbar.webContents!
    // the press 3 px into the 6 px grab strip, half way down: 3 px left of the edge
    const x0 = 3
    const y = Math.round(b.height / 2)
    const gy = content.y + b.y + y
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    wc.focus()
    wc.sendInputEvent({ type: 'mouseDown', x: x0, y, globalX: content.x + b.x + x0, globalY: gy, button: 'left', clickCount: 1 })
    const from = b.x + x0
    const to = target - 3
    for (let i = 1; i <= steps; i++) {
      const px = Math.round(from + ((to - from) * i) / steps)
      const now = toolbar.getBounds()
      wc.sendInputEvent({ type: 'mouseMove', x: px - now.x, y, globalX: content.x + px, globalY: gy, button: 'left', modifiers: ['leftbuttondown'] })
      await wait(40)
    }
    if (release) {
      const now = toolbar.getBounds()
      wc.sendInputEvent({ type: 'mouseUp', x: to - now.x, y, globalX: content.x + to, globalY: gy, button: 'left', clickCount: 1 })
      await wait(80)
    }
  }, { target: edgeX, release: o.release ?? true, steps: o.steps ?? 8 })
}

/**
 * A picture of the whole app window as the person sees it, saved as PNG:the window is a BaseWindow of separate views
 * (team page, browser toolbar, browser tab, ...), and Electron draws each on its own, so each view is captured and they
 * are laid over each other in their order and place, on the window's background colour. For review screenshots only.
 */
export async function windowShot(app: ElectronApplication, file: string) {
  const png = await app.evaluate(async ({ BaseWindow, BrowserWindow }) => {
    const win = BaseWindow.getAllWindows().find((w) => w.getTitle() !== 'away' && w.contentView.children.length > 0)!
    const [width, height] = win.getContentSize()
    const layers: { x: number; y: number; w: number; h: number; url: string }[] = []
    for (const v of win.contentView.children as (Electron.View & { webContents?: Electron.WebContents })[]) {
      if (!v.webContents || v.webContents.isDestroyed() || !v.getVisible()) continue
      const b = v.getBounds()
      if (b.width <= 0 || b.height <= 0) continue
      const img = await v.webContents.capturePage()
      if (!img.isEmpty()) layers.push({ x: b.x, y: b.y, w: b.width, h: b.height, url: img.toDataURL() })
    }
    const canvas = new BrowserWindow({ show: false, width: 200, height: 200 })
    try {
      await canvas.loadURL('about:blank')
      return (await canvas.webContents.executeJavaScript(`(async () => {
        const width = ${width}, height = ${height}, scale = 2, layers = ${JSON.stringify(layers)}
        const c = document.createElement('canvas')
        c.width = width * scale
        c.height = height * scale
        const g = c.getContext('2d')
        g.fillStyle = ${JSON.stringify(win.getBackgroundColor())}
        g.fillRect(0, 0, c.width, c.height)
        for (const l of layers) {
          const img = new Image()
          img.src = l.url
          await img.decode()
          g.drawImage(img, l.x * scale, l.y * scale, l.w * scale, l.h * scale)
        }
        return c.toDataURL('image/png')
      })()`)) as string
    } finally {
      canvas.destroy()
    }
  })
  writeFileSync(file, Buffer.from(png.split(',')[1]!, 'base64'))
}

/** Quit the app; kill it when quitting hangs (a stuck app must not keep talking to the fake servers). */
export async function close(app: ElectronApplication | undefined) {
  if (!app) return
  const proc = app.process()
  // A registered worker can keep Playwright's close RPC pending after Electron has already exited.
  const exited = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : once(proc, 'exit')
  const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000)
  await Promise.race([app.close().catch(() => proc.kill('SIGKILL')), exited])
  clearTimeout(timer)
}
