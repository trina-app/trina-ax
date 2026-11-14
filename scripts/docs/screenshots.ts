// Captures the screenshots the docs site uses (docs/site/images/<page>/<name>.webp; the Chinese pages' own in
// docs/site/images/zh/<page>/<name>.webp) from a running Trina AX server with made-up data. `bun run docs:screenshots`.
//
// The usual way is one command that starts everything itself, shoots every set in English and in Chinese, and stops
// what it started (scripts/docs/reshoot.ts):
//
//   bun run docs:reshoot [--only chats] [--lang en|zh]
//
// By hand, against a server you started:
//
//   bun scripts/docs/screenshots.ts --url <url> --acme [--lang zh] [--only scheduled]       the Acme demo company
//   bun scripts/docs/screenshots.ts --url <url> --quickstart [--lang zh]                      `bun run demo` (alice)
//   DOCS_SHOT_PASSWORD=… bun scripts/docs/screenshots.ts --url <url> --mock [--only slack]   the web e2e mock server
//
// Three sets of shots:
// - `acme`: the Acme demo company (`bun run demo:company`, filled by scripts/docs/acme-scene.ts). Shots as Jordan Lee,
//   a Marketing member; admin screens as the owner acme-admin (password in the demo's data folder, owner-password).
// - `quickstart`: the quickstart's own demo (`bun run demo`, fictional accounts alice … dion, AI off), as alice.
// - `mock`: states a development server cannot reach, such as Slack added through the hosting service or the company's
//   own Google app on a hosted team: the web e2e mock server (made-up team "Acme", owner olga, member bob) sets each
//   state through its test controls. English only.
//
//   bun run build:web && bun web/test/mock/serve.ts      (in another terminal; port 19143, another with MOCK_PORT=…)
//
// Every shot: the light theme at 1440×900 (a phone: 390×844) with deviceScaleFactor 2, the development-mode banner
// hidden, cropped to the part a step talks about, written as WebP (encoded by the same Chromium, so no image tool is
// needed). --lang zh signs in, switches each account's language to 简体中文 (Settings › Profile › Language) and writes
// under images/zh/; --lang en switches it back to the team's language. The URL and passwords are arguments, never
// stored here. Made-up data only: the shots are committed to a public repository. Playwright comes from the web
// workspace (web/node_modules).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT } from './site'
import { en } from '../../web/src/i18n/en'
import { zh } from '../../web/src/i18n/zh'
import type { MessageKey } from '../../web/src/i18n/ko'

type Locator = { fill(v: string): Promise<void>; first(): Locator; last(): Locator; nth(i: number): Locator; filter(o: { hasText: string | RegExp }): Locator; locator(s: string): Locator; getByText(t: string | RegExp, o?: Record<string, unknown>): Locator; screenshot(o: Record<string, unknown>): Promise<Buffer>; click(o?: Record<string, unknown>): Promise<void>; hover(o?: Record<string, unknown>): Promise<void>; waitFor(o?: Record<string, unknown>): Promise<void>; scrollIntoViewIfNeeded(): Promise<void>; count(): Promise<number>; boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }
type Page = {
  goto(url: string): Promise<unknown>; locator(s: string): Locator; getByRole(r: string, o?: Record<string, unknown>): Locator; getByText(t: string | RegExp, o?: Record<string, unknown>): Locator
  screenshot(o: Record<string, unknown>): Promise<Buffer>; waitForTimeout(ms: number): Promise<void>; waitForLoadState(s: string): Promise<void>
  keyboard: { press(k: string): Promise<void>; type(t: string): Promise<void> }; mouse: { move(x: number, y: number): Promise<void> }; evaluate<T>(fn: (arg: string) => T, arg: string): Promise<T>; setViewportSize(s: { width: number; height: number }): Promise<void>
  addStyleTag(o: { content: string }): Promise<unknown>; close(): Promise<void>
}
type Context = { newPage(): Promise<Page>; close(): Promise<void>; request: { post(url: string, o: { data: unknown }): Promise<{ ok(): boolean; status(): number }> } }
type Browser = { newContext(o: Record<string, unknown>): Promise<Context>; close(): Promise<void> }

export type Lang = 'en' | 'zh'
export type ShotSet = 'acme' | 'quickstart' | 'mock'
const OUT = path.join(ROOT, 'docs/site/images')
const HIDE = '[data-testid="dev-banner"],[data-testid="demo-bar"]{display:none!important} *{caret-color:transparent!important} ::-webkit-scrollbar{display:none}'
const DICT: Record<Lang, Record<MessageKey, string>> = { en, zh }
let LANG: Lang = 'en'
/** the app's own words in the language being shot (web/src/i18n), for clicks by text */
const T = (k: MessageKey) => DICT[LANG][k]
/** an ICU plural message as a pattern for its numbers ("{n, plural, one {# reply} other {# replies}}" → /^\d+ repl(y|ies)$/) */
const plural = (k: MessageKey) => {
  const forms = [...T(k).matchAll(/(?:one|other) \{([^}]*)\}/g)].map((m) => m[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('#', '\\d+'))
  return new RegExp(`^(${[...new Set(forms)].join('|')})$`)
}

interface Shot {
  /** docs/site/images/<file>.webp (zh: docs/site/images/zh/<file>.webp) */
  file: string
  set: ShotSet
  path: string
  phone?: boolean
  signedOut?: boolean
  /** clicks and waits after the page loads */
  prepare?: (p: Page) => Promise<void>
  /** what to capture: a selector, or the whole viewport when absent */
  crop?: string
  /** extra space around the cropped element, in CSS pixels */
  pad?: number
  /** keep only this much of the crop's top, in CSS pixels (a page whose bottom is empty) */
  maxHeight?: number
  /** the web e2e mock server's state for this shot. `slack`: POST /__test/slack (SlackAdmin and MySlack fields over a
   * connected own app); `googleOwnApp`: POST /__test/google-own-app (the company's own Google app); `googleApps`: POST
   * /__test/google-apps, in order (a person's Google app connection) */
  mock?: { slack?: { admin?: Record<string, unknown>; mine?: Record<string, unknown> }; googleOwnApp?: Record<string, unknown>; googleApps?: Record<string, unknown>[] }
  /** signed in as this person instead of the set's default */
  as?: { user: string; password: string }
  /** a fixed part of the page in CSS pixels, instead of `crop` */
  clip?: { x: number; y: number; width: number; height: number }
}

/** the settings dialog focuses its close button, which then shows a focus ring in the shot */
const blur = async (p: Page) => { await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur(), ''); await p.waitForTimeout(300) }
const click = (sel: string) => async (p: Page) => { await p.locator(sel).first().click(); await p.waitForTimeout(500) }
/** Slack, not added yet, where the hosting service serves the server (Add to Slack offered) */
const SLACK_NEW = { mode: 'own', official: true, enabled: false, tokens: false, workspace: null, botName: null, appId: null, state: 'off', lastError: null, linkOrigin: null, linked: 0 }
/** Slack added through the hosting service, connected (no own app's links or https line) */
const SLACK_ADDED = { ...SLACK_NEW, mode: 'official', enabled: true, tokens: true, workspace: { teamId: 'T0ACME', name: 'Acme', url: null }, botName: 'trina-ax', state: 'connected', signIn: true }
/** Acme on the hosting service, Google sign-in through Trina's app (Google sign-in row with Use your company's app) */
const GOOGLE_HOSTED = { hosted: true, active: false, canGoBack: true, by: null, at: null, people: 14, shared: 2 }
/** after Save: the company's app, set by the owner */
const GOOGLE_OWN = { ...GOOGLE_HOSTED, active: true, by: { id: 'olga', name: 'Olga' }, at: '2026-11-13T02:00:00.000Z' }
const BOB = { user: 'bob', password: 'bob password 1' }
/** Acme's Marketing member, the person the acme shots follow (scripts/docs/acme-scene.ts) */
const JORDAN = { user: 'jordan', password: 'teamax-demo-1' }
/** the dialog opened from Gmail's Team settings, then Next `n` times (step 3 with the ID and secret, so step 4 opens) */
const ownAppDialog = (n: number) => async (p: Page) => {
  await p.locator('[data-testid="gsign-use"]').click(); await p.waitForTimeout(400)
  for (let i = 0; i < n; i++) {
    if (i === 2) {
      await p.locator('[data-testid="drive-setup-manual"]').click()
      await p.locator('[data-testid="drive-setup-id"]').fill('123456789-acme.apps.googleusercontent.com')
      await p.locator('[data-testid="drive-setup-secret"]').fill('made-up-secret')
    }
    await p.locator('[data-testid="gsign-next"]').click(); await p.waitForTimeout(300)
  }
  // focus rings and tooltips stay out of the shot
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur(), ''); await p.waitForTimeout(200)
}
const scrollTo = (sel: string, block: 'center' | 'start' = 'center') => async (p: Page) => {
  await p.evaluate((a) => { const [s, b] = a.split('|'); document.querySelector(s!)?.scrollIntoView({ block: b as ScrollLogicalPosition }) }, `${sel}|${block}`); await p.waitForTimeout(400)
}
const ownAppRow = scrollTo('[data-testid="gsign-row"]')
const DIALOG = '[role="dialog"] >> nth=-1'
/** the last dialog that is not the Settings window */
const INNER_DIALOG = '[role="dialog"]:not([data-testid="settings-dialog"]) >> nth=-1'
/** a conversation in the Chats list beside the bar on the left */
const openRoom = (name: string) => async (p: Page) => { await p.locator('#rail-panel').getByText(name, { exact: true }).first().click(); await p.waitForTimeout(1300) }
/** one of Jordan's chats in the Trina list */
const openChat = (title: RegExp) => async (p: Page) => { await p.locator('[data-testid="trina-list"] a').filter({ hasText: title }).first().click(); await p.waitForTimeout(1300) }
const composer = '[data-testid="composer"] textarea, [data-testid="composer"] [contenteditable]'
/** the message's hover bar and tooltips stay out of the shot */
const restMouse = async (p: Page) => { await p.mouse.move(1430, 890); await p.waitForTimeout(300) }

const SHOTS: Shot[] = [
  // Quickstart: `bun run demo`, as alice (the page's own steps)
  { file: 'quickstart/sign-in', set: 'quickstart', path: '/login', signedOut: true, crop: 'form >> xpath=..', pad: 8 },
  { file: 'quickstart/files-glossary', set: 'quickstart', path: '/files?path=shared', prepare: async (p) => {
    await p.locator('main').getByText(/팀-용어집/).first().click(); await p.waitForTimeout(1000)
  } },
  // Overview and the bar on the left
  { file: 'overview/app', set: 'acme', path: '/', as: JORDAN },
  { file: 'concepts/rail', set: 'acme', path: '/', as: JORDAN, clip: { x: 0, y: 0, width: 360, height: 460 } },
  // Chats and projects
  { file: 'chats/home', set: 'acme', path: '/', as: JORDAN, crop: 'main' },
  { file: 'chats/trina-list', set: 'acme', path: '/', as: JORDAN, clip: { x: 0, y: 0, width: 360, height: 400 } },
  { file: 'chats/steps', set: 'acme', path: '/', as: JORDAN, prepare: async (p) => {
    // the brand-voice chat: a short answer with plain steps (the campaign summary's steps are search patterns)
    await openChat(/brand voice/i)(p)
    await p.getByText(plural('steps.summary')).first().click(); await p.waitForTimeout(700)
    await restMouse(p)
  }, crop: 'main' },
  // Share… on the brand-voice chat, shared with Alex and Sam (acme-scene.ts sharing)
  { file: 'chats/share-chat', set: 'acme', path: '/', as: JORDAN, prepare: async (p) => {
    await openChat(/brand voice/i)(p)
    await p.locator('[data-testid="chat-menu"]').first().click(); await p.waitForTimeout(400)
    await p.locator('[data-testid="chat-share"]').first().click(); await p.waitForTimeout(1000)
    await blur(p)
  }, crop: DIALOG },
  { file: 'chats/trina-drawer-phone', set: 'acme', path: '/', phone: true, as: JORDAN, prepare: click('[data-testid="menu-open"]') },
  { file: 'chats/rooms-list', set: 'acme', path: '/rooms', as: JORDAN, clip: { x: 0, y: 0, width: 360, height: 520 } },
  { file: 'chats/room', set: 'acme', path: '/rooms', as: JORDAN, prepare: async (p) => { await openRoom('Marketing')(p); await restMouse(p) }, crop: 'main' },
  { file: 'chats/thread', set: 'acme', path: '/rooms', as: JORDAN, prepare: async (p) => {
    await openRoom('Marketing')(p)
    await p.getByText(plural('rooms.threadReplies')).first().click(); await p.waitForTimeout(900)
    await restMouse(p)
  }, crop: 'main' },
  // the group chat with the guest from the agency (acme-scene.ts sharing)
  { file: 'chats/guest-room', set: 'acme', path: '/rooms', as: JORDAN, prepare: async (p) => { await openRoom('Launch email')(p); await restMouse(p) }, crop: 'main' },
  { file: 'chats/invite-guest', set: 'acme', path: '/rooms', as: JORDAN, prepare: async (p) => {
    await openRoom('Launch email')(p)
    await p.locator('[data-testid="room-members-button"]').first().click(); await p.waitForTimeout(600)
    await p.locator('[data-testid="room-invite"]').first().click(); await p.waitForTimeout(700)
    await p.locator('[data-testid="invite-guest-row"]').first().click(); await p.waitForTimeout(700)
    await blur(p)
  }, crop: DIALOG },
  { file: 'chats/rooms-phone', set: 'acme', path: '/rooms', phone: true, as: JORDAN },
  { file: 'chats/projects-panel', set: 'acme', path: '/projects', as: JORDAN },
  { file: 'chats/project', set: 'acme', path: '/projects', as: JORDAN, prepare: async (p) => { await p.locator('[data-testid="project-card"]').first().click(); await p.waitForTimeout(1200); await restMouse(p) }, crop: 'main', maxHeight: 440 },
  // Files
  { file: 'files/files', set: 'acme', path: '/files', as: JORDAN, crop: 'main', maxHeight: 360 },
  { file: 'files/files-phone', set: 'acme', path: '/files', phone: true, as: JORDAN },
  { file: 'files/folder-permissions', set: 'acme', path: '/admin/folders', crop: 'main' },
  { file: 'files/share-dialog', set: 'acme', path: '/admin/folders', prepare: async (p) => {
    // the third row: the Marketing budget folder, shared with Sam by name inside the limited budget folder
    await p.locator('[data-testid="folders-share"]').nth(2).click(); await p.waitForTimeout(1500)
    await blur(p)
  }, crop: DIALOG },
  { file: 'files/by-person', set: 'acme', path: '/admin/folders', prepare: async (p) => {
    await p.getByText(T('folders.tabPerson'), { exact: true }).first().click(); await p.waitForTimeout(800)
    await p.locator('main').getByText('Jordan Lee', { exact: true }).first().click(); await p.waitForTimeout(1000)
  }, crop: 'main' },
  // Team skills
  { file: 'skills/team-skills', set: 'acme', path: '/skills', as: JORDAN, crop: 'main', maxHeight: 280 },
  { file: 'skills/slash-menu', set: 'acme', path: '/', as: JORDAN, prepare: async (p) => {
    await p.locator(composer).first().click(); await p.keyboard.press('/'); await p.waitForTimeout(800)
  }, crop: '[data-testid="composer"]', pad: 16 },
  // MCP connections (docs/site/use/mcp.md): English only
  { file: 'mcp/connected', set: 'acme', path: '/settings/integrations', as: JORDAN, prepare: blur, crop: '[data-testid="settings-dialog"]' },
  { file: 'mcp/add', set: 'acme', path: '/settings/integrations', as: JORDAN, prepare: async (p) => {
    await p.locator('[data-testid="connector-add"]').first().click(); await p.waitForTimeout(700)
  }, crop: INNER_DIALOG },
  // Scheduled tasks
  { file: 'scheduled/list', set: 'acme', path: '/scheduled', as: JORDAN },
  { file: 'scheduled/task', set: 'acme', path: '/scheduled', as: JORDAN, prepare: async (p) => { await p.locator('main a[href^="/scheduled/"]').first().click(); await p.waitForTimeout(1000) }, crop: 'main', maxHeight: 560 },
  { file: 'scheduled/new-task', set: 'acme', path: '/scheduled', as: JORDAN, prepare: async (p) => { await p.getByRole('button', { name: new RegExp(T('scheduled.newTask')) }).first().click(); await p.waitForTimeout(500) }, crop: 'main', maxHeight: 260 },
  { file: 'scheduled/list-phone', set: 'acme', path: '/scheduled', phone: true, as: JORDAN },
  // Usage
  { file: 'usage/mine', set: 'acme', path: '/settings/usage', as: JORDAN, prepare: blur, crop: '[data-testid="settings-dialog"]' },
  { file: 'usage/team', set: 'acme', path: '/admin/usage', crop: 'main' },
  // Admin (the owner)
  { file: 'admin/team-menu', set: 'acme', path: '/', prepare: click('[data-testid="sidebar-team"]'), crop: '[data-testid="team-dropdown"]' },
  { file: 'admin/home', set: 'acme', path: '/admin' },
  { file: 'admin/admin-phone', set: 'acme', path: '/admin', phone: true },
  { file: 'admin/ai-settings', set: 'acme', path: '/admin/settings', crop: 'main' },
  { file: 'admin/engines', set: 'acme', path: '/admin/engines', crop: 'main' },
  { file: 'admin/engines-open', set: 'acme', path: '/admin/engines', prepare: click('[data-testid="engine-open"]'), crop: '[data-testid="engine-card"]', pad: 16 },
  { file: 'admin/activity-log', set: 'acme', path: '/admin/audit', crop: 'main' },
  { file: 'admin/guests', set: 'acme', path: '/admin/members', prepare: scrollTo('[data-testid="guests-section"]'), crop: '[data-testid="guests-section"]', pad: 16 },
  // Your account and search
  { file: 'settings/account-menu', set: 'acme', path: '/', as: JORDAN, prepare: click('[data-testid="account-menu"]'), crop: '[data-testid="account-dropdown"]' },
  { file: 'settings/settings', set: 'acme', path: '/settings/profile', as: JORDAN, prepare: blur, crop: '[data-testid="settings-dialog"]' },
  // the owner: the Phone section has where the team's phone notifications go
  { file: 'settings/notifications', set: 'acme', path: '/settings/notifications', prepare: async (p) => { await blur(p); await scrollTo('[data-testid="notifications-phone"]', 'start')(p) }, crop: '[data-testid="settings-dialog"]' },
  { file: 'settings/delete-account', set: 'acme', path: '/settings/account/delete', as: JORDAN, prepare: blur, crop: '[data-testid="settings-dialog"]' },
  { file: 'settings/settings-phone', set: 'acme', path: '/settings/profile', phone: true, as: JORDAN },
  { file: 'settings/me-phone', set: 'acme', path: '/settings', phone: true, as: JORDAN },
  { file: 'search/palette', set: 'acme', path: '/', as: JORDAN, prepare: async (p) => { await p.keyboard.press('Meta+k'); await p.waitForTimeout(700) }, crop: '[data-testid="search-palette"]' },
  { file: 'search/messages', set: 'acme', path: '/', as: JORDAN, prepare: async (p) => { await p.keyboard.press('Meta+k'); await p.waitForTimeout(500); await p.keyboard.type('banner'); await p.waitForTimeout(1400) }, crop: '[data-testid="search-palette"]' },
  // Slack (docs/site/use/slack.md), from the mock server: the hosting service serves it, workspace "Acme"
  { file: 'slack/connected-apps', set: 'mock', path: '/admin/connectors', mock: { slack: { admin: SLACK_NEW } }, prepare: scrollTo('[data-testid="connector-card"][data-id="slack"]'), crop: 'main' },
  { file: 'slack/add-to-slack', set: 'mock', path: '/admin/connectors/slack', mock: { slack: { admin: SLACK_NEW } }, crop: 'main' },
  { file: 'slack/connected', set: 'mock', path: '/admin/connectors/slack?slack=installed', mock: { slack: { admin: SLACK_ADDED } }, crop: 'main' },
  { file: 'slack/removed', set: 'mock', path: '/admin/connectors/slack', mock: { slack: { admin: { ...SLACK_ADDED, tokens: false, botName: null, state: 'off', lastError: 'removed', linked: 3 } } }, crop: 'main' },
  { file: 'slack/linked', set: 'mock', path: '/settings/connectors?slack=linked', crop: '[data-testid="settings-dialog"]', prepare: async (p) => {
    // the dialog focuses its close button, which then shows a focus ring and its tooltip in the shot
    await p.evaluate((s) => { (document.activeElement as HTMLElement | null)?.blur(); document.querySelector(s)?.scrollIntoView({ block: 'center' }) }, '[data-testid="slack-account"]'); await p.waitForTimeout(400)
  }, mock: { slack: { mine: { available: true, workspace: 'Acme', signIn: true, link: { slackUserId: 'U0OLGA', slackName: 'Olga', linkedAt: '2026-11-12T01:30:00.000Z' } } } } },
  // the company's own Google app (docs/site/use/google-own-app.md), from the mock server: Acme on the hosting service,
  // Gmail's page in Admin › Connected apps
  { file: 'google-own-app/row-trina', set: 'mock', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_HOSTED }, prepare: ownAppRow, crop: '[data-testid="team-settings"]' },
  { file: 'google-own-app/dialog-start', set: 'mock', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_HOSTED }, prepare: ownAppDialog(0), crop: DIALOG },
  { file: 'google-own-app/dialog-cloud', set: 'mock', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_HOSTED }, prepare: ownAppDialog(1), crop: DIALOG },
  { file: 'google-own-app/dialog-upload', set: 'mock', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_HOSTED }, prepare: ownAppDialog(2), crop: DIALOG },
  { file: 'google-own-app/dialog-confirm', set: 'mock', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_HOSTED }, prepare: ownAppDialog(3), crop: DIALOG },
  { file: 'google-own-app/row-company', set: 'mock', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_OWN }, prepare: async (p) => {
    await ownAppRow(p); await p.locator('[data-testid="gsign-menu"]').click(); await p.waitForTimeout(300)
  }, crop: '[data-testid="team-settings"]' },
  { file: 'google-own-app/member-reconnect', set: 'mock', path: '/settings/connectors/gmail', as: BOB, crop: '[data-testid="settings-dialog"]', prepare: blur, mock: { googleOwnApp: GOOGLE_OWN, googleApps: [{ app: 'gmail', connect: { userId: 'bob', name: 'Bob', email: 'bob@acme.example.com', status: 'needs_reconnect' } }] } },
  { file: 'google-own-app/row-company-phone', set: 'mock', path: '/admin/connectors/gmail', phone: true, mock: { googleOwnApp: GOOGLE_OWN }, prepare: ownAppRow, crop: '[data-testid="gsign-row"]' },
]

/** Shots the Chinese pages show from images/zh/. The connection pages (MCP, Slack, the company's own Google app) keep
 * the English pictures for now. */
export const ZH_SHOTS = SHOTS.filter((s) => s.set !== 'mock' && !s.file.startsWith('mcp/')).map((s) => s.file)

/** The website's guides (trina-ax-website src/content/guides*.ts, public/images/guide/<name>.webp): one whole window per
 * guide at 1440×900, as a member or the owner. `--guides <folder> --member <user>:<password>` writes them there; the
 * owner is --url's DOCS_SHOT_USER. Korean guides come from `bun run demo --locale ko`, English ones from Acme (--acme). */
const guideShots = (member: { user: string; password: string }): Shot[] => {
  const typeSlash = async (p: Page) => { await p.locator(composer).first().click(); await p.keyboard.press('/'); await p.waitForTimeout(700) }
  return [
    { file: 'first-question', set: 'acme', path: '/', as: member },
    { file: 'team-files', set: 'acme', path: '/files', as: member },
    { file: 'use-skills', set: 'acme', path: '/', as: member, prepare: typeSlash },
    { file: 'schedules', set: 'acme', path: '/scheduled', as: member, prepare: async (p) => { await p.locator('main button').filter({ hasText: /New task|새 작업/ }).first().click(); await p.waitForTimeout(500) } },
    { file: 'integrations', set: 'acme', path: '/settings/integrations', as: member, prepare: blur },
    { file: 'apps', set: 'acme', path: '/settings/apps', as: member, prepare: blur },
    { file: 'skills', set: 'acme', path: '/skills' },
    { file: 'folder-permissions', set: 'acme', path: '/admin/folders' },
    { file: 'invite', set: 'acme', path: '/', prepare: async (p) => { await p.locator('[data-testid="sidebar-team"]').click(); await p.waitForTimeout(400); await p.locator('[data-testid="team-dropdown"]').getByText(/Invite people|초대/).first().click(); await p.waitForTimeout(900) } },
    { file: 'ai-connection', set: 'acme', path: '/admin/engines' },
    { file: 'usage-limits', set: 'acme', path: '/admin/usage' },
    { file: 'backup', set: 'acme', path: '/admin/system' },
  ]
}

export interface ShootOptions {
  url: string
  set: ShotSet
  lang: Lang
  /** only shots whose file starts with this */
  only?: string
  /** the set's default account (acme: acme-admin; quickstart: alice; mock: olga) */
  user: string
  password: string
  /** --guides <folder>: the website's guides instead */
  guides?: string
  member?: { user: string; password: string }
  log?: (s: string) => void
}

function args(): ShootOptions {
  const a = process.argv.slice(2)
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined }
  const url = get('--url')?.replace(/\/+$/, '')
  if (!url) throw new Error('Usage: bun scripts/docs/screenshots.ts --url <url> --acme|--quickstart|--mock [--lang en|zh] [--only <file prefix>] (or bun run docs:reshoot)')
  const set: ShotSet | undefined = a.includes('--mock') ? 'mock' : a.includes('--acme') ? 'acme' : a.includes('--quickstart') ? 'quickstart' : undefined
  if (!set) throw new Error('Pick the set of shots: --acme (bun run demo:company), --quickstart (bun run demo) or --mock (the web e2e mock server)')
  const lang = (get('--lang') ?? 'en') as Lang
  if (!['en', 'zh'].includes(lang)) throw new Error('--lang is en or zh')
  if (lang === 'zh' && set === 'mock') throw new Error('the mock shots are English only')
  const member = get('--member')?.split(':')
  const guides = get('--guides')
  if (guides && !member?.[1]) throw new Error('--guides needs --member <user>:<password>')
  // the quickstart's accounts share the public demo password; Acme's owner's is in the demo's data folder
  const user = process.env.DOCS_SHOT_USER ?? (set === 'mock' ? 'olga' : set === 'acme' ? 'acme-admin' : 'alice')
  const password = process.env.DOCS_SHOT_PASSWORD ?? (set === 'quickstart' ? 'teamax-demo-1' : '')
  return { url, set, lang, only: get('--only'), user, password, guides, member: member ? { user: member[0]!, password: member.slice(1).join(':') } : undefined }
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

/** Takes one set of shots in one language. Returns the files it could not take, with why. */
export async function shoot(o: ShootOptions): Promise<string[]> {
  const log = o.log ?? console.log
  if (!o.password) throw new Error('Set DOCS_SHOT_PASSWORD (and DOCS_SHOT_USER if needed).')
  LANG = o.lang
  const { chromium } = createRequire(path.join(ROOT, 'web/package.json'))('@playwright/test') as { chromium: { launch(): Promise<Browser> } }
  const browser = await chromium.launch()
  const contexts = new Map<string, Context>()
  const control = async (ctx: Context, what: string, data: unknown) => {
    const r = await ctx.request.post(`${o.url}/__test/${what}`, { data })
    if (!r.ok()) throw new Error(`the mock server refused /__test/${what} (${r.status()}): is --url the web e2e mock server?`)
  }
  const contextFor = async (phone: boolean, signedOut: boolean, as?: { user: string; password: string }) => {
    const key = `${phone}-${signedOut}-${as?.user ?? ''}`
    if (contexts.has(key)) return contexts.get(key)!
    const ctx = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 2,
      colorScheme: 'light', locale: o.lang === 'zh' ? 'zh-CN' : 'en-US', timezoneId: 'Asia/Seoul', isMobile: phone, hasTouch: phone,
    })
    if (!signedOut) {
      // sign in through the form, as a person would (the API refuses requests without the browser's own headers)
      const p = await ctx.newPage()
      await p.goto(`${o.url}/login`)
      await p.waitForTimeout(1500)
      // a demo company's sign-in page starts with its persona; the form is behind "Sign in with another account"
      const other = p.getByText(new RegExp([en['demo.otherAccount'], zh['demo.otherAccount'], en['auth.otherAccount'], zh['auth.otherAccount']].join('|'))).first()
      if (await other.count()) await other.click().catch(() => undefined)
      await p.locator('input[type="text"], input[autocomplete="username"], input[name="username"]').first().fill(as?.user ?? o.user)
      await p.locator('input[type="password"]').first().fill(as?.password ?? o.password)
      await p.keyboard.press('Enter')
      // a busy server can take a few seconds to sign in
      for (let i = 0; i < 30 && (await p.evaluate(() => location.pathname, '')) === '/login'; i++) await p.waitForTimeout(500)
      await p.waitForTimeout(800)
      if ((await p.evaluate(() => location.pathname, '')) === '/login') throw new Error(`sign-in failed for ${as?.user ?? o.user}`)
      // the account's language: 简体中文 for the Chinese pages, the team's for the English ones (Settings › Profile)
      if (o.set !== 'mock') {
        const status = await p.evaluate(async (locale) => (await fetch('/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: JSON.stringify({ locale: locale || null }) })).status, o.lang === 'zh' ? 'zh' : '')
        if (status >= 300) throw new Error(`could not set the language of ${as?.user ?? o.user} (${status})`)
      }
      await p.close()
    }
    contexts.set(key, ctx)
    return ctx
  }
  const signedOut = await contextFor(false, true)
  // the mock server: its seeded team in English, before anyone signs in (a reset ends every session)
  if (o.set === 'mock' && !o.guides) await control(signedOut, 'reset', { teamLocale: 'en', usersFollowTeam: true })
  const encoder = await signedOut.newPage()
  const failed: string[] = []
  const only = (x: Shot) => !o.only || x.file.startsWith(o.only)
  const todo = o.guides ? guideShots(o.member!).filter(only)
    : SHOTS.filter((x) => only(x) && x.set === o.set && (o.lang === 'en' || ZH_SHOTS.includes(x.file)))
  if (!todo.length) log(`No ${o.set} shot to take${o.only ? ` for --only ${o.only}` : ''}${o.lang === 'zh' ? ' in Chinese' : ''}`)
  const outDir = o.guides ?? (o.lang === 'zh' ? path.join(OUT, 'zh') : OUT)
  for (const s of todo) {
    const ctx = await contextFor(!!s.phone, !!s.signedOut, s.as)
    const page = await ctx.newPage()
    try {
      if (s.mock?.slack) await control(ctx, 'slack', s.mock.slack)
      if (s.mock?.googleOwnApp) await control(ctx, 'google-own-app', s.mock.googleOwnApp)
      for (const g of s.mock?.googleApps ?? []) await control(ctx, 'google-apps', g)
      await page.goto(o.url + s.path)
      // a page that keeps a request open (the apps page's downloads) never goes quiet: take it after the wait
      await page.waitForLoadState('networkidle').catch(() => undefined)
      await page.addStyleTag({ content: HIDE })
      await page.waitForTimeout(700)
      if (s.prepare) await s.prepare(page)
      let png: Buffer
      if (s.clip) png = await page.screenshot({ clip: s.clip })
      else if (s.crop) {
        const el = page.locator(s.crop).first()
        await el.waitFor({ timeout: 5000 })
        const box = await el.boundingBox()
        if (!box) throw new Error(`nothing to crop at ${s.crop}`)
        const pad = s.pad ?? 0
        png = await page.screenshot({ clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: Math.min(box.height + pad * 2, s.maxHeight ?? 1600) } })
      } else png = await page.screenshot({})
      const out = path.join(outDir, `${s.file}.webp`)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, await webp(encoder, png))
      log(`${o.lang === 'zh' ? 'zh/' : ''}${s.file}.webp  ${Math.round(fs.statSync(out).size / 1024)} KB`)
    } catch (e) {
      failed.push(`${o.lang === 'zh' ? 'zh/' : ''}${s.file}: ${(e as Error).message.split('\n')[0]}`)
    } finally {
      await page.close()
    }
  }
  for (const c of contexts.values()) await c.close()
  await browser.close()
  return failed
}

if (import.meta.main) {
  const failed = await shoot(args())
  if (failed.length) { console.error(`Failed:\n${failed.join('\n')}`); process.exitCode = 1 }
}
