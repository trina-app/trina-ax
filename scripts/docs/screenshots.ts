// Captures the screenshots the docs site uses (docs/site/images/<page>/<name>.webp) from a running Trina AX server
// with made-up data, such as a development server seeded by `bun run demo:seed`. `bun run docs:screenshots`.
//
//   DOCS_SHOT_USER=dion DOCS_SHOT_PASSWORD=… bun scripts/docs/screenshots.ts --url https://team.example.com [--only scheduled]
//
// Signs in as an admin (the owner sees every screen), uses the light theme at 1280×800 with deviceScaleFactor 2, hides
// the development-mode banner, crops each shot to the part a step talks about, and writes WebP (encoded by the same
// Chromium, so no image tool is needed). The URL and password are arguments, never stored here. Use made-up data only:
// the shots are committed to a public repository. Playwright comes from the web workspace (web/node_modules).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT } from './site'

type Locator = { fill(v: string): Promise<void>; first(): Locator; screenshot(o: Record<string, unknown>): Promise<Buffer>; click(o?: Record<string, unknown>): Promise<void>; waitFor(o?: Record<string, unknown>): Promise<void>; boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }
type Page = {
  goto(url: string): Promise<unknown>; locator(s: string): Locator; getByRole(r: string, o?: Record<string, unknown>): Locator; getByText(t: string | RegExp, o?: Record<string, unknown>): Locator
  screenshot(o: Record<string, unknown>): Promise<Buffer>; waitForTimeout(ms: number): Promise<void>; waitForLoadState(s: string): Promise<void>
  keyboard: { press(k: string): Promise<void> }; evaluate<T>(fn: (arg: string) => T, arg: string): Promise<T>; setViewportSize(s: { width: number; height: number }): Promise<void>
  addStyleTag(o: { content: string }): Promise<unknown>; close(): Promise<void>
}
type Context = { newPage(): Promise<Page>; close(): Promise<void> }
type Browser = { newContext(o: Record<string, unknown>): Promise<Context>; close(): Promise<void> }

const OUT = path.join(ROOT, 'docs/site/images')
const HIDE = '[data-testid="dev-banner"]{display:none!important} *{caret-color:transparent!important} ::-webkit-scrollbar{display:none}'

interface Shot {
  /** docs/site/images/<file>.webp */
  file: string
  path: string
  phone?: boolean
  signedOut?: boolean
  /** clicks and waits after the page loads */
  prepare?: (p: Page) => Promise<void>
  /** what to capture: a selector, or the whole viewport when absent */
  crop?: string
  /** extra space around the cropped element, in CSS pixels */
  pad?: number
}

const click = (sel: string) => async (p: Page) => { await p.locator(sel).first().click(); await p.waitForTimeout(400) }
const SHOTS: Shot[] = [
  { file: 'quickstart/sign-in', path: '/login', signedOut: true, crop: 'form >> xpath=..', pad: 24 },
  { file: 'quickstart/files-glossary', path: '/files', prepare: async (p) => {
    await p.getByText('shared', { exact: true }).first().click(); await p.waitForTimeout(500)
    await p.getByText(/용어집/).first().click(); await p.waitForTimeout(800)
  } },
  { file: 'chats/home', path: '/', crop: 'main' },
  { file: 'chats/project', path: '/projects', prepare: async (p) => { await p.locator('main a[href^="/projects/"]').first().click(); await p.waitForTimeout(800) }, crop: 'main' },
  { file: 'files/files', path: '/files', crop: 'main' },
  { file: 'files/folder-permissions', path: '/admin/folders', crop: 'main' },
  { file: 'skills/team-skills', path: '/skills', crop: 'main' },
  { file: 'mcp/connected', path: '/settings/integrations', crop: '[data-testid="settings-dialog"]' },
  { file: 'mcp/discover', path: '/settings/integrations', prepare: async (p) => { await p.getByRole('tab', { name: /Discover/ }).first().click(); await p.waitForTimeout(600) }, crop: '[data-testid="settings-dialog"]' },
  { file: 'mcp/add', path: '/settings/integrations', prepare: async (p) => {
    await p.getByRole('tab', { name: /Discover/ }).first().click(); await p.waitForTimeout(600)
    await p.locator('[data-testid="connector-add"]').first().click(); await p.waitForTimeout(700)
  }, crop: '[role="dialog"]:not([data-testid="settings-dialog"]) >> nth=-1' },
  { file: 'scheduled/list', path: '/scheduled' },
  { file: 'scheduled/task', path: '/scheduled', prepare: async (p) => { await p.locator('main a[href^="/scheduled/"]').first().click(); await p.waitForTimeout(800) }, crop: 'main' },
  { file: 'scheduled/new-task', path: '/scheduled', prepare: async (p) => { await p.getByRole('button', { name: /New task/ }).first().click(); await p.waitForTimeout(400) }, crop: 'main', },
  { file: 'scheduled/list-phone', path: '/scheduled', phone: true },
  { file: 'usage/mine', path: '/settings/usage', crop: '[data-testid="settings-dialog"]' },
  { file: 'usage/team', path: '/admin/usage', crop: 'main' },
  { file: 'admin/home', path: '/admin' },
  { file: 'admin/engines', path: '/admin/engines', crop: 'main' },
  { file: 'admin/engines-open', path: '/admin/engines', prepare: click('[data-testid="engine-open"]'), crop: '[data-testid="engine-card"]', pad: 16 },
  { file: 'admin/activity-log', path: '/admin/audit', crop: 'main' },
  { file: 'settings/account-menu', path: '/', prepare: click('[data-testid="account-menu"]'), crop: '[data-testid="account-dropdown"]', pad: 24 },
  { file: 'settings/settings', path: '/settings/profile', crop: '[data-testid="settings-dialog"]' },
  { file: 'settings/settings-phone', path: '/settings/profile', phone: true },
  { file: 'search/palette', path: '/', prepare: async (p) => { await p.keyboard.press('Meta+k'); await p.waitForTimeout(600) }, crop: '[data-testid="search-palette"]' },
]

function args() {
  const a = process.argv.slice(2)
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined }
  const url = get('--url')?.replace(/\/+$/, '')
  if (!url) throw new Error('Usage: DOCS_SHOT_USER=… DOCS_SHOT_PASSWORD=… bun scripts/docs/screenshots.ts --url https://team.example.com [--only <file prefix>]')
  return { url, only: get('--only'), user: process.env.DOCS_SHOT_USER ?? 'dion', password: process.env.DOCS_SHOT_PASSWORD ?? '' }
}

async function webp(page: Page, png: Buffer): Promise<Buffer> {
  const dataUrl = await page.evaluate(async (b64: string) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    c.getContext('2d')!.drawImage(img, 0, 0)
    return c.toDataURL('image/webp', 0.84)
  }, png.toString('base64'))
  return Buffer.from((dataUrl as string).split(',')[1]!, 'base64')
}

async function main() {
  const o = args()
  if (!o.password) throw new Error('Set DOCS_SHOT_PASSWORD (and DOCS_SHOT_USER if not dion).')
  const { chromium } = createRequire(path.join(ROOT, 'web/package.json'))('@playwright/test') as { chromium: { launch(): Promise<Browser> } }
  const browser = await chromium.launch()
  const contexts = new Map<string, Context>()
  const contextFor = async (phone: boolean, signedOut: boolean) => {
    const key = `${phone}-${signedOut}`
    if (contexts.has(key)) return contexts.get(key)!
    const ctx = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, deviceScaleFactor: 2,
      colorScheme: 'light', locale: 'en-US', timezoneId: 'Asia/Seoul', isMobile: phone, hasTouch: phone,
    })
    if (!signedOut) {
      // sign in through the form, as a person would (the API refuses requests without the browser's own headers)
      const p = await ctx.newPage()
      await p.goto(`${o.url}/login`)
      await p.locator('input[type="text"], input[autocomplete="username"], input[name="username"]').first().fill(o.user)
      await p.locator('input[type="password"]').first().fill(o.password)
      await p.keyboard.press('Enter')
      await p.waitForTimeout(2000)
      if ((await p.evaluate(() => location.pathname, '')) === '/login') throw new Error('sign-in failed')
      await p.close()
    }
    contexts.set(key, ctx)
    return ctx
  }
  const encoder = await (await contextFor(false, true)).newPage()
  const failed: string[] = []
  for (const s of SHOTS.filter((x) => !o.only || x.file.startsWith(o.only))) {
    const page = await (await contextFor(!!s.phone, !!s.signedOut)).newPage()
    try {
      await page.goto(o.url + s.path)
      await page.waitForLoadState('networkidle')
      await page.addStyleTag({ content: HIDE })
      await page.waitForTimeout(500)
      if (s.prepare) await s.prepare(page)
      let png: Buffer
      if (s.crop) {
        const el = page.locator(s.crop).first()
        await el.waitFor({ timeout: 5000 })
        const box = await el.boundingBox()
        if (!box) throw new Error(`nothing to crop at ${s.crop}`)
        const pad = s.pad ?? 0
        png = await page.screenshot({ clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: Math.min(box.height + pad * 2, 1600) } })
      } else png = await page.screenshot({})
      const out = path.join(OUT, `${s.file}.webp`)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, await webp(encoder, png))
      console.log(`${s.file}.webp  ${Math.round(fs.statSync(out).size / 1024)} KB`)
    } catch (e) {
      failed.push(`${s.file}: ${(e as Error).message.split('\n')[0]}`)
    } finally {
      await page.close()
    }
  }
  for (const c of contexts.values()) await c.close()
  await browser.close()
  if (failed.length) { console.error(`Failed:\n${failed.join('\n')}`); process.exitCode = 1 }
}

if (import.meta.main) await main()
