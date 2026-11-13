// Captures the screenshots the docs site uses (docs/site/images/<page>/<name>.webp) from a running Trina AX server
// with made-up data, such as a development server seeded by `bun run demo:seed`. `bun run docs:screenshots`.
//
//   DOCS_SHOT_USER=dion DOCS_SHOT_PASSWORD=… bun scripts/docs/screenshots.ts --url https://team.example.com [--only scheduled]
//
// Signs in as an admin (the owner sees every screen), uses the light theme at 1280×800 with deviceScaleFactor 2, hides
// the development-mode banner, crops each shot to the part a step talks about, and writes WebP (encoded by the same
// Chromium, so no image tool is needed). The URL and password are arguments, never stored here. Use made-up data only:
// the shots are committed to a public repository. Playwright comes from the web workspace (web/node_modules).
//
// Shots with `mock` show states a development server cannot reach, such as Slack added through the hosting service:
// they run against the web e2e mock server instead (made-up team "Acme", owner olga), which sets each state through
// its test control, and only with --mock. Shots with `mockToo` run with --mock too, on the made-up files and scheduled
// tasks MOCK_SEED adds (the navigation's own shots: the rail and its lists look the same on either server); the others
// need the demo seed's data and are left out then:
//
//   bun run build:web && bun web/test/mock/serve.ts      (in another terminal; port 19143, another with MOCK_PORT=…)
//   DOCS_SHOT_PASSWORD=… bun scripts/docs/screenshots.ts --url http://127.0.0.1:19143 --mock [--only slack]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT } from './site'

type Locator = { fill(v: string): Promise<void>; first(): Locator; getByText(t: string | RegExp, o?: Record<string, unknown>): Locator; screenshot(o: Record<string, unknown>): Promise<Buffer>; click(o?: Record<string, unknown>): Promise<void>; waitFor(o?: Record<string, unknown>): Promise<void>; boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }
type Page = {
  goto(url: string): Promise<unknown>; locator(s: string): Locator; getByRole(r: string, o?: Record<string, unknown>): Locator; getByText(t: string | RegExp, o?: Record<string, unknown>): Locator
  screenshot(o: Record<string, unknown>): Promise<Buffer>; waitForTimeout(ms: number): Promise<void>; waitForLoadState(s: string): Promise<void>
  keyboard: { press(k: string): Promise<void> }; evaluate<T>(fn: (arg: string) => T, arg: string): Promise<T>; setViewportSize(s: { width: number; height: number }): Promise<void>
  addStyleTag(o: { content: string }): Promise<unknown>; close(): Promise<void>
}
type Context = { newPage(): Promise<Page>; close(): Promise<void>; request: { post(url: string, o: { data: unknown }): Promise<{ ok(): boolean; status(): number }> } }
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
  /** the web e2e mock server's Slack state for this shot (POST /__test/slack: SlackAdmin and MySlack fields over a
   * connected own app); such a shot runs only with --mock */
  mock?: { admin?: Record<string, unknown>; mine?: Record<string, unknown> }
  /** also taken with --mock, on MOCK_SEED's data */
  mockToo?: boolean
}

const click = (sel: string) => async (p: Page) => { await p.locator(sel).first().click(); await p.waitForTimeout(400) }
/** Slack, not added yet, where the hosting service serves the server (Add to Slack offered) */
const SLACK_NEW = { mode: 'own', official: true, enabled: false, tokens: false, workspace: null, botName: null, appId: null, state: 'off', lastError: null, linkOrigin: null, linked: 0 }
/** Slack added through the hosting service, connected (no own app's links or https line) */
const SLACK_ADDED = { ...SLACK_NEW, mode: 'official', enabled: true, tokens: true, workspace: { teamId: 'T0ACME', name: 'Acme', url: null }, botName: 'trina-ax', state: 'connected', signIn: true }
/** What --mock adds after its reset, in English, for the `mockToo` shots: a team glossary in shared/ and two scheduled
 * tasks (the mock's test controls /__test/file and /__test/schedule) */
const MOCK_SEED: [string, Record<string, unknown>][] = [
  ['file', { path: 'shared/team-glossary.md', text: '# Team glossary\n\n| Term | Meaning |\n|---|---|\n| Lead | One request from the website, phone or email |\n| Contract | Signed. A quote alone is not a contract |\n| Asset | One image, video or line of copy for an ad |\n| Conversion | Ad clicks that became a lead |\n| Q4 | October 1 to December 31 |\n' }],
  ['file', { path: 'shared/meeting-notes/2026-11-10.md', text: '# Weekly meeting\n' }],
  ['schedule', { title: 'Weekly summary', prompt: 'Every Monday, read last week\'s notes in shared/meeting-notes and write a summary to my files.', repeat: 'weekly' }],
  ['schedule', { title: 'Daily file index', prompt: 'Every morning, list the new files in shared and suggest where they belong.', repeat: 'daily' }],
]
const SHOTS: Shot[] = [
  { file: 'quickstart/sign-in', path: '/login', signedOut: true, crop: 'form >> xpath=..', pad: 24 },
  // the shared folder, its glossary open beside it (the 파일 list's 팀 폴더 has shared too)
  { file: 'quickstart/files-glossary', path: '/files?path=shared', mockToo: true, prepare: async (p) => {
    await p.locator('main').getByText(/용어집|glossary/i).first().click(); await p.waitForTimeout(800)
  } },
  { file: 'chats/home', path: '/', crop: 'main' },
  { file: 'chats/project', path: '/projects', prepare: async (p) => { await p.locator('main a[href^="/projects/"]').first().click(); await p.waitForTimeout(800) }, crop: 'main' },
  { file: 'files/files', path: '/files', crop: 'main' },
  { file: 'files/folder-permissions', path: '/admin/folders', crop: 'main' },
  { file: 'skills/team-skills', path: '/skills', crop: 'main' },
  { file: 'mcp/connected', path: '/settings/integrations', crop: '[data-testid="settings-dialog"]' },
  // Discover is on the same page, under the connections
  { file: 'mcp/discover', path: '/settings/integrations', prepare: async (p) => { await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), '[data-testid="connector-discover-title"]'); await p.waitForTimeout(600) }, crop: '[data-testid="settings-dialog"]' },
  { file: 'mcp/add', path: '/settings/integrations', prepare: async (p) => {
    await p.locator('[data-testid="connector-add"]').first().click(); await p.waitForTimeout(700)
  }, crop: '[role="dialog"]:not([data-testid="settings-dialog"]) >> nth=-1' },
  { file: 'scheduled/list', path: '/scheduled', mockToo: true },
  { file: 'scheduled/task', path: '/scheduled', prepare: async (p) => { await p.locator('main a[href^="/scheduled/"]').first().click(); await p.waitForTimeout(800) }, crop: 'main' },
  { file: 'scheduled/new-task', path: '/scheduled', prepare: async (p) => { await p.getByRole('button', { name: /New task/ }).first().click(); await p.waitForTimeout(400) }, crop: 'main', },
  { file: 'scheduled/list-phone', path: '/scheduled', phone: true, mockToo: true },
  { file: 'usage/mine', path: '/settings/usage', crop: '[data-testid="settings-dialog"]' },
  { file: 'usage/team', path: '/admin/usage', crop: 'main' },
  { file: 'admin/home', path: '/admin', mockToo: true },
  { file: 'admin/engines', path: '/admin/engines', crop: 'main' },
  { file: 'admin/engines-open', path: '/admin/engines', prepare: click('[data-testid="engine-open"]'), crop: '[data-testid="engine-card"]', pad: 16 },
  { file: 'admin/activity-log', path: '/admin/audit', crop: 'main' },
  { file: 'settings/account-menu', path: '/', mockToo: true, prepare: click('[data-testid="account-menu"]'), crop: '[data-testid="account-dropdown"]', pad: 24 },
  { file: 'settings/settings', path: '/settings/profile', crop: '[data-testid="settings-dialog"]' },
  { file: 'settings/settings-phone', path: '/settings/profile', phone: true },
  { file: 'search/palette', path: '/', mockToo: true, prepare: async (p) => { await p.keyboard.press('Meta+k'); await p.waitForTimeout(600) }, crop: '[data-testid="search-palette"]' },
  // Slack (docs/site/use/slack.md), from the mock server (--mock): the hosting service serves it, workspace "Acme"
  { file: 'slack/connected-apps', path: '/admin/connectors', mock: { admin: SLACK_NEW }, prepare: async (p) => {
    await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), '[data-testid="connector-card"][data-id="slack"]'); await p.waitForTimeout(400)
  }, crop: 'main' },
  { file: 'slack/add-to-slack', path: '/admin/connectors/slack', mock: { admin: SLACK_NEW }, crop: 'main' },
  { file: 'slack/connected', path: '/admin/connectors/slack?slack=installed', mock: { admin: SLACK_ADDED }, crop: 'main' },
  { file: 'slack/removed', path: '/admin/connectors/slack', mock: { admin: { ...SLACK_ADDED, tokens: false, botName: null, state: 'off', lastError: 'removed', linked: 3 } }, crop: 'main' },
  { file: 'slack/linked', path: '/settings/connectors?slack=linked', crop: '[data-testid="settings-dialog"]', prepare: async (p) => {
    // the dialog focuses its close button, which then shows a focus ring and its tooltip in the shot
    await p.evaluate((s) => { (document.activeElement as HTMLElement | null)?.blur(); document.querySelector(s)?.scrollIntoView({ block: 'center' }) }, '[data-testid="slack-account"]'); await p.waitForTimeout(400)
  }, mock: { mine: { available: true, workspace: 'Acme', signIn: true, link: { slackUserId: 'U0OLGA', slackName: 'Olga', linkedAt: '2026-11-12T01:30:00.000Z' } } } },
]

function args() {
  const a = process.argv.slice(2)
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined }
  const url = get('--url')?.replace(/\/+$/, '')
  if (!url) throw new Error('Usage: DOCS_SHOT_USER=… DOCS_SHOT_PASSWORD=… bun scripts/docs/screenshots.ts --url https://team.example.com [--only <file prefix>] [--mock]')
  const mock = a.includes('--mock')
  // the mock server's seeded owner is olga (web/test/mock/serve.ts)
  return { url, only: get('--only'), mock, user: process.env.DOCS_SHOT_USER ?? (mock ? 'olga' : 'dion'), password: process.env.DOCS_SHOT_PASSWORD ?? '' }
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
  const control = async (ctx: Context, what: string, data: unknown) => {
    const r = await ctx.request.post(`${o.url}/__test/${what}`, { data })
    if (!r.ok()) throw new Error(`the mock server refused /__test/${what} (${r.status()}): is --url the web e2e mock server?`)
  }
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
  const signedOut = await contextFor(false, true)
  // the mock server: its seeded team in English, before anyone signs in (a reset ends every session)
  if (o.mock) {
    await control(signedOut, 'reset', { teamLocale: 'en', usersFollowTeam: true })
    for (const [what, data] of MOCK_SEED) await control(signedOut, what, data)
  }
  const encoder = await signedOut.newPage()
  const failed: string[] = []
  const todo = SHOTS.filter((x) => (!o.only || x.file.startsWith(o.only)) && (!!x.mock === o.mock || (o.mock && !!x.mockToo)))
  // the --only of a mock shot without --mock (or the other way round) takes nothing: say so
  if (!todo.length) console.error(`No shot to take${o.only ? ` for --only ${o.only}` : ''}${SHOTS.some((x) => (!o.only || x.file.startsWith(o.only)) && !!x.mock !== o.mock) ? (o.mock ? ': these shots need a development server, without --mock' : ': these shots need --mock and the web e2e mock server') : ''}`)
  for (const s of todo) {
    const ctx = await contextFor(!!s.phone, !!s.signedOut)
    const page = await ctx.newPage()
    try {
      if (s.mock) await control(ctx, 'slack', s.mock)
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
