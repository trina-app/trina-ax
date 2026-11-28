// End to end: the real server (scripted engine) and the unpacked extension in two Chromium profiles of one person
// (docs/decisions/20261128-trina-in-chrome.md). One answer switches profiles per call (`profile`), types and clicks on
// a local test page in each, each run gets its own window there, Stop in the popup ends the run, and Disconnect in
// Settings ends that profile's link only.
// Run: bun chrome-extension/build.ts && bun test ./tests/e2e/chrome-extension.test.ts (needs Playwright's Chromium:
// `bunx playwright install chromium` in tests/).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(180_000)
const DIST = path.join(import.meta.dir, '..', '..', 'chrome-extension', 'dist')
const secret = () => crypto.randomBytes(32).toString('base64url')
const challengeOf = (v: string) => crypto.createHash('sha256').update(v).digest('base64url')
const cm = () => 'cm-' + crypto.randomUUID()
const lines = (...steps: Record<string, unknown>[]) => steps.map((x) => '@fake ' + JSON.stringify({ ...x, sayResult: true })).join('\n')

/** this computer's LAN address: the test page is served there under a made-up name (not loopback, which the extension never opens) */
function lanIp(): string {
  for (const l of Object.values(os.networkInterfaces())) for (const a of l ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  throw new Error('no LAN address')
}
let PORT_OF_SITE = 0
const PAGE = (who: string) => `<!doctype html><title>Shop ${who}</title><h1>Hello ${who}</h1>
<label>Name <input id=name></label><button id=go onclick="document.getElementById('out').textContent='ordered by '+document.getElementById('name').value">Order</button>
<p id=out>not yet</p><a id=away href="http://news.example:${PORT_OF_SITE}/news">News</a>`

let h: Harness
let win: TestSocket
let site: ReturnType<typeof Bun.serve>
const profiles: { name: string; ctx: BrowserContext; id: string; linkId: string; dir: string }[] = []
const SITE = 'shop.example'

async function openProfile(name: string, ip: string, port: number) {
  h.ctx.db.query('DELETE FROM login_attempts').run()
  const verifier = secret()
  const { code } = await h.api('alice').call(API.chromePair, { body: { challenge: challengeOf(verifier) } })
  const r = await h.req(null, API.chromeRedeem.path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'chrome-extension://e2e' }, body: JSON.stringify({ code, verifier, label: name, version: '0.1.0' }) })
  const link = await r.json() as { token: string; linkId: string; user: unknown; team: unknown; teamHosts: string[] }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-e2e-'))
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, `--host-resolver-rules=MAP ${SITE} ${ip},MAP news.example ${ip}`],
  })
  let [sw] = ctx.serviceWorkers()
  if (!sw) sw = await ctx.waitForEvent('serviceworker')
  const id = sw.url().split('/')[2]!
  // the pairing page's result, as the extension keeps it after a redeem (the page itself is QA'd on a real team)
  await sw.evaluate(async (v) => { await (globalThis as { chrome: { storage: { local: { set(x: unknown): Promise<void> } } } }).chrome.storage.local.set({ link: v }) }, { origin: h.url, token: link.token, linkId: link.linkId, user: link.user, team: link.team, teamHosts: link.teamHosts, label: name })
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${id}/popup.html`)
  profiles.push({ name, ctx, id, linkId: link.linkId, dir })
  void port
}

const online = async (n: number) => {
  for (let i = 0; i < 100; i++) {
    const l = await h.api('alice').call(API.chromeLinks, {})
    if (l.links.filter((x) => x.online).length >= n) return
    await Bun.sleep(100)
  }
  throw new Error('profiles did not come online')
}
const tabOf = async (ctx: BrowserContext, title: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const p = ctx.pages().find((x) => !x.url().startsWith('chrome-extension://') && x.url().includes(SITE))
    if (p && (await p.title()).includes(title)) return p
    await Bun.sleep(100)
  }
  throw new Error(`no tab with ${title}`)
}

beforeAll(async () => {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) throw new Error('build the extension first: bun chrome-extension/build.ts')
  h = await startHarness({ name: 'chrome-e2e', askUserTimeoutMs: 20_000 })
  site = Bun.serve({ port: 0, hostname: '0.0.0.0', fetch: (req) => new Response(PAGE(new URL(req.url).pathname.slice(1) || 'home'), { headers: { 'content-type': 'text/html' } }) })
  PORT_OF_SITE = site.port!
  const ip = lanIp()
  win = await h.ws('alice', { windowId: 'win-web-e2e01' })
  await win.next('hello')
  await openProfile('Work mail', ip, site.port!)
  await openProfile('Personal', ip, site.port!)
  await online(2)
  // the test page's name points at a LAN address: allowed as an office address for alice, and as a site in both profiles
  h.rt().grantSite('alice', SITE)
  h.rt().grantSite('alice', 'news.example')
  for (const p of profiles) h.ctx.db.query('INSERT OR IGNORE INTO chrome_link_sites (link_id, site, created_at) VALUES (?, ?, ?)').run(p.linkId, SITE, new Date().toISOString())
})
afterAll(async () => {
  for (const p of profiles) { await p.ctx.close().catch(() => {}); fs.rmSync(p.dir, { recursive: true, force: true }) }
  win?.close(); site?.stop(true)
  await h?.close()
})

test('one answer works in two profiles back to back: each gets its own window, typing and a click land there', async () => {
  const url = (p: string) => `http://${SITE}:${site.port}/${p}`
  const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
  const content = lines(
    { tool: 'navigate', args: { url: url('work'), profile: 'Work mail' } },
    { tool: 'find', args: { query: 'Name' } },
    { tool: 'navigate', args: { url: url('personal'), profile: 'Personal' } },
    { tool: 'read_page', args: { filter: 'interactive' } },
    { tool: 'computer', args: { action: 'left_click', ref: 'ref_1' } },
    { tool: 'computer', args: { action: 'type', text: 'Mina' } },
    { tool: 'computer', args: { action: 'left_click', ref: 'ref_2' } },
    { tool: 'get_page_text', args: {} },
    { tool: 'get_page_text', args: { profile: 'Work mail' } },
  )
  const r = await h.api('alice', { window: 'win-web-e2e01', client: 'web' }).call(API.sendMessage, { params: { id: chat }, body: { content: `${url('work')} ${url('personal')}\n${content}`, clientMessageId: cm(), attachmentIds: [] } })
  const done = await win.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 120_000)
  const said = done.data.message.content
  if (process.env.E2E_DEBUG) console.log(said)
  const work = await tabOf(profiles[0]!.ctx, 'Shop work')
  const pers = await tabOf(profiles[1]!.ctx, 'Shop personal')
  expect(await pers.locator('#out').innerText()).toBe('ordered by Mina')
  expect(await work.locator('#out').innerText()).toBe('not yet')
  expect(said).toContain('Hello personal')
  expect(said).toContain('Hello work')
  // the person's own first window in each profile is untouched: the AI's tab is in another window
  for (const p of profiles) expect(p.ctx.pages().filter((x) => x.url().includes(SITE)).length).toBe(1)
})

test('a site the profile does not allow yet (a link the AI followed): the card names the profile; Always keeps it there only', async () => {
  const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
  const start = `http://${SITE}:${site.port}/start`
  const r = await h.api('alice', { window: 'win-web-e2e01', client: 'web' }).call(API.sendMessage, { params: { id: chat }, body: { content: `${start}\n${lines({ tool: 'navigate', args: { url: start, profile: 'Work mail' } }, { tool: 'find', args: { query: 'News' } }, { tool: 'computer', args: { action: 'left_click', ref: 'ref_1' } }, { tool: 'get_page_text', args: {} })}`, clientMessageId: cm(), attachmentIds: [] } })
  const card = await win.next('turn.request', (f) => f.data.turnId === r.turnId && (f.data.request as { kind: string }).kind === 'browser_site', 60_000)
  const req = card.data.request as { requestId: string; chrome?: boolean; profile?: string }
  expect(req).toMatchObject({ chrome: true, profile: 'Work mail' })
  await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'browser_site', requestId: req.requestId, decision: 'always' } })
  const done = await win.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 60_000)
  // the click itself was held back (a page the AI drives may not take it to a site nobody allowed); the read after
  // the card is of that tab
  expect(done.data.message.content).toContain('which the user has not allowed for the AI; it was not loaded')
  const l = await h.api('alice').call(API.chromeLinks, {})
  expect(l.links.find((x) => x.id === profiles[0]!.linkId)!.sites).toContain('news.example')
  expect(l.links.find((x) => x.id === profiles[1]!.linkId)!.sites).not.toContain('news.example')
})

test('Stop in the popup ends that run; Disconnect ends only that profile', async () => {
  const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
  const r = await h.api('alice', { window: 'win-web-e2e01', client: 'web' }).call(API.sendMessage, { params: { id: chat }, body: { content: lines({ tool: 'navigate', args: { url: `http://${SITE}:${site.port}/slow`, profile: 'Personal' } }, { tool: 'computer', args: { action: 'wait', duration: 10 } }), clientMessageId: cm(), attachmentIds: [] } })
  const pers = profiles[1]!
  const popup = await pers.ctx.newPage()
  await popup.goto(`chrome-extension://${pers.id}/popup.html`)
  const stop = popup.getByRole('button', { name: 'Stop' }).first()
  await stop.waitFor({ timeout: 30_000 })
  await stop.click()
  const done = await win.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 60_000)
  expect(done.data.message.content).toContain('stopped')
  await h.api('alice').call(API.chromeUnlink, { params: { id: pers.linkId } })
  for (let i = 0; i < 100; i++) {
    const l = await h.api('alice').call(API.chromeLinks, {})
    if (!l.links.some((x) => x.id === pers.linkId) && l.links.find((x) => x.id === profiles[0]!.linkId)?.online) return
    await Bun.sleep(100)
  }
  throw new Error('the other profile did not stay linked and online')
})
