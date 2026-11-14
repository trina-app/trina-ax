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
// Shots with `mock` show states a development server cannot reach, such as Slack added through the hosting service or
// the company's own Google app on a hosted team: they run against the web e2e mock server instead (made-up team "Acme",
// owner olga, member bob), which sets each state through its test controls, and only with --mock. Shots with `mockToo` run with --mock too, on the made-up files and scheduled
// tasks MOCK_SEED adds (the navigation's own shots: the rail and its lists look the same on either server); the others
// need the demo seed's data and are left out then:
//
//   bun run build:web && bun web/test/mock/serve.ts      (in another terminal; port 19143, another with MOCK_PORT=…)
//   DOCS_SHOT_PASSWORD=… bun scripts/docs/screenshots.ts --url http://127.0.0.1:19143 --mock [--only slack]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT } from './site'

type Locator = { fill(v: string): Promise<void>; first(): Locator; locator(s: string): Locator; filter(o: { hasText: string | RegExp }): Locator; getByText(t: string | RegExp, o?: Record<string, unknown>): Locator; screenshot(o: Record<string, unknown>): Promise<Buffer>; click(o?: Record<string, unknown>): Promise<void>; waitFor(o?: Record<string, unknown>): Promise<void>; boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }
type Page = {
  goto(url: string): Promise<unknown>; locator(s: string): Locator; getByRole(r: string, o?: Record<string, unknown>): Locator; getByText(t: string | RegExp, o?: Record<string, unknown>): Locator
  screenshot(o: Record<string, unknown>): Promise<Buffer>; waitForTimeout(ms: number): Promise<void>; waitForLoadState(s: string): Promise<void>
  keyboard: { press(k: string): Promise<void>; type(t: string): Promise<void> }; mouse: { move(x: number, y: number): Promise<void> }; evaluate<T>(fn: (arg: string) => T, arg: string): Promise<T>; setViewportSize(s: { width: number; height: number }): Promise<void>
  addStyleTag(o: { content: string }): Promise<unknown>; close(): Promise<void>
  route(url: string | RegExp, handler: (route: { fulfill(o: { status?: number; contentType?: string; body: string }): Promise<void> }) => Promise<void>): Promise<void>
}
type Context = { newPage(): Promise<Page>; close(): Promise<void>; request: { post(url: string, o: { data: unknown }): Promise<{ ok(): boolean; status(): number }> } }
type Browser = { newContext(o: Record<string, unknown>): Promise<Context>; close(): Promise<void> }

const OUT = path.join(ROOT, 'docs/site/images')
const HIDE = '[data-testid="dev-banner"],[data-testid="demo-bar"]{display:none!important} *{caret-color:transparent!important} ::-webkit-scrollbar{display:none}'

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
  /** the web e2e mock server's state for this shot; such a shot runs only with --mock. `slack`: POST /__test/slack
   * (SlackAdmin and MySlack fields over a connected own app); `googleOwnApp`: POST /__test/google-own-app (the company's
   * own Google app); `googleApps`: POST /__test/google-apps, in order (a person's Google app connection) */
  mock?: { slack?: { admin?: Record<string, unknown>; mine?: Record<string, unknown> }; googleOwnApp?: Record<string, unknown>; googleApps?: Record<string, unknown>[] }
  /** signed in as this person instead (the mock's member bob) */
  as?: { user: string; password: string }
  /** also taken with --mock, on MOCK_SEED's data */
  mockToo?: boolean
  /** taken only with --acme, on the Acme demo company that scripts/docs/acme-scene.ts filled */
  acme?: boolean
  /** a fixed part of the page in CSS pixels, instead of `crop` */
  clip?: { x: number; y: number; width: number; height: number }
  /** a guests shot (docs/site/use/guests.md), with --mock: GUEST_SEED's room, project and guests are made first */
  guests?: boolean
  /** before the page loads (answers given in the browser) */
  before?: (p: Page) => Promise<void>
  /** the page's address when it is known only after an earlier shot (the guest link) */
  pathFn?: () => string
}

/** the settings dialog focuses its close button, which then shows a focus ring in the shot */
const blur = async (p: Page) => { await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur(), ''); await p.waitForTimeout(300) }
const click = (sel: string) => async (p: Page) => { await p.locator(sel).first().click(); await p.waitForTimeout(400) }
/** Slack, not added yet, where the hosting service serves the server (Add to Slack offered) */
const SLACK_NEW = { mode: 'own', official: true, enabled: false, tokens: false, workspace: null, botName: null, appId: null, state: 'off', lastError: null, linkOrigin: null, linked: 0 }
/** Slack added through the hosting service, connected (no own app's links or https line) */
const SLACK_ADDED = { ...SLACK_NEW, mode: 'official', enabled: true, tokens: true, workspace: { teamId: 'T0ACME', name: 'Acme', url: null }, botName: 'trina-ax', state: 'connected', signIn: true }
/** Acme on the hosting service, Google sign-in through Trina's app (Google sign-in row with Use your company's app) */
const GOOGLE_HOSTED = { hosted: true, active: false, canGoBack: true, by: null, at: null, people: 14, shared: 2 }
/** after Save: the company's app, set by the owner */
const GOOGLE_OWN = { ...GOOGLE_HOSTED, active: true, by: { id: 'olga', name: 'Olga' }, at: '2026-11-13T02:00:00.000Z' }
const BOB = { user: 'bob', password: 'bob password 1' }
/** Acme's Marketing member, the person the --acme shots follow (scripts/docs/acme-scene.ts) */
const JORDAN = { user: 'jordan', password: 'teamax-demo-1' }
/** Acme's Priya Nair, whom Jordan shared the brand-voice chat with (scripts/docs/acme-scene.ts) */
const PRIYA = { user: 'priya', password: 'teamax-demo-1' }
/** opens a chat of the Trina list by its title, then its title menu's Share… */
const openShare = (title: RegExp) => async (p: Page) => {
  await p.locator('[data-testid="trina-list"] a').filter({ hasText: title }).first().click(); await p.waitForTimeout(1200)
  await p.locator('[data-testid="chat-menu"]').first().click(); await p.waitForTimeout(300)
  await p.locator('[data-testid="chat-share"]').first().click(); await p.waitForTimeout(800)
}
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
const ownAppRow = async (p: Page) => {
  await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), '[data-testid="gsign-row"]'); await p.waitForTimeout(400)
}
const DIALOG = '[role="dialog"] >> nth=-1'
/** What --mock adds after its reset, in English, for the `mockToo` shots: a team glossary in shared/ and two scheduled
 * tasks (the mock's test controls /__test/file and /__test/schedule) */
const MOCK_SEED: [string, Record<string, unknown>][] = [
  ['file', { path: 'shared/team-glossary.md', text: '# Team glossary\n\n| Term | Meaning |\n|---|---|\n| Lead | One request from the website, phone or email |\n| Contract | Signed. A quote alone is not a contract |\n| Asset | One image, video or line of copy for an ad |\n| Conversion | Ad clicks that became a lead |\n| Q4 | October 1 to December 31 |\n' }],
  ['file', { path: 'shared/meeting-notes/2026-11-10.md', text: '# Weekly meeting\n' }],
  ['schedule', { title: 'Weekly summary', prompt: 'Every Monday, read last week\'s notes in shared/meeting-notes and write a summary to my files.', repeat: 'weekly' }],
  ['schedule', { title: 'Daily file index', prompt: 'Every morning, list the new files in shared and suggest where they belong.', repeat: 'daily' }],
]
/** Guests (docs/site/use/guests.md), with --mock: the group chat "Quote prep" (Olga, Bob and the guest Alex Rivera),
 * a project "Launch plan" with the guest Sam Park in it (Team AI), and a team AI account. Made-up people only. */
const QUOTE_ROOM = '019a5f00-0000-7000-8000-0000000c0001'
const ALEX = { id: 'alex', name: 'Alex Rivera' }
const ALEX_SIGN_IN = { user: 'alex', password: 'alex password 1' }
const GUEST_ROOM = { canRename: true, managerId: 'olga', unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 3, lastSeq: 3, lastMessage: null, muted: false, groupId: null }
const GUEST_SEED = async (control: (what: string, data: unknown) => Promise<void>) => {
  await control('team-credential', { label: 'Team Claude' })
  await control('project', { name: 'Launch plan', by: 'olga' })
  const at = new Date(Date.now() - 3 * 3600_000).toISOString()
  await control('rooms', { rooms: [{ ...GUEST_ROOM, id: QUOTE_ROOM, kind: 'group', name: 'Quote prep', memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }, ALEX], createdAt: at, activityAt: at }] })
  await control('guest', { id: ALEX.id, name: ALEX.name, place: { kind: 'room', id: QUOTE_ROOM } })
  await control('guest', { id: 'sam', name: 'Sam Park', place: { kind: 'project', name: 'Launch plan' }, ai: { mode: 'team', credentialId: 'c1', limitUsd: 20 } })
}
/** the room's messages (the mock server keeps none it did not share from a chat): answered in the browser */
const quoteMessages = async (p: Page) => {
  // a fixed morning (10:00 in Seoul), so the three never fall on two days
  const t0 = Date.parse('2026-11-12T01:00:00.000Z')
  const msg = (n: number, author: { id: string; name: string }, body: string) => ({ id: `019a5f00-0000-7000-8000-0000000c010${n}`, roomId: QUOTE_ROOM, seq: n, authorKind: 'user', author, askedBy: null, visibility: 'room', body, replyTo: null, mentions: [], files: [], createdAt: new Date(t0 + n * 6 * 60_000).toISOString(), editedAt: null, deletedAt: null })
  const items = [
    msg(1, { id: 'bob', name: 'Bob' }, 'Welcome, Alex! The draft quote for the spring order is ready. Could you check the delivery dates?'),
    msg(2, ALEX, 'Thanks, Bob. Two of the dates are tight for us. I will send our dates by Friday.'),
    msg(3, { id: 'olga', name: 'Olga' }, 'Great, thank you. We can move the second delivery a week if that helps.'),
  ]
  await p.route(new RegExp(`/api/rooms/${QUOTE_ROOM}/messages(\\?|$)`), (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items, nextCursor: null }) }))
  // its three people, whoever looks (the mock server lists the viewer and the room's peers)
  const people = [{ id: 'olga', name: 'Olga' }, { id: 'bob', name: 'Bob' }, ALEX].map((user) => ({ user, joinedAt: new Date(t0 - 86400_000).toISOString() }))
  await p.route(new RegExp(`/api/rooms/${QUOTE_ROOM}/members(\\?|$)`), (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: people }) }))
}
/** the room's add list: the room's title (its people) › Add people */
const roomAddList = async (p: Page) => {
  await p.locator('[data-testid="room-members-button"]').click(); await p.waitForTimeout(500)
  await p.locator('[data-testid="room-invite"]').click(); await p.waitForTimeout(600)
}
/** the guest link the invite dialog made, for the invite page's shot */
let guestLink = ''
const inviteDialog = async (p: Page) => {
  await roomAddList(p)
  await p.locator('[data-testid="invite-guest-row"]').click(); await p.waitForTimeout(500)
  await p.locator('[data-testid="guest-invite-name"]').fill('Dana Cole'); await blur(p)
}
const SHOTS: Shot[] = [
  { file: 'quickstart/sign-in', path: '/login', signedOut: true, crop: 'form >> xpath=..', pad: 24 },
  // the shared folder, its glossary open beside it (the 파일 list's 팀 폴더 has shared too)
  { file: 'quickstart/files-glossary', path: '/files?path=shared', mockToo: true, prepare: async (p) => {
    await p.locator('main').getByText(/용어집|glossary/i).first().click(); await p.waitForTimeout(800)
  } },
  // Acme (--acme): `bun run demo:company` filled by scripts/docs/acme-scene.ts. Shots as Jordan Lee, a Marketing member
  // (the demo's three personas get a demo-only Home); admin screens as the owner acme-admin.
  // Overview and the bar on the left
  { file: 'overview/app', path: '/', acme: true, as: JORDAN },
  { file: 'concepts/rail', path: '/', acme: true, as: JORDAN, clip: { x: 0, y: 0, width: 380, height: 420 } },
  // Chats and projects
  { file: 'chats/home', path: '/', acme: true, as: JORDAN, crop: 'main' },
  { file: 'chats/trina-list', path: '/', acme: true, as: JORDAN, clip: { x: 0, y: 0, width: 328, height: 480 } },
  { file: 'chats/steps', path: '/', acme: true, as: JORDAN, prepare: async (p) => {
    // the brand-voice chat: a short answer with plain steps (the campaign summary's steps are search patterns)
    await p.locator('[data-testid="trina-list"] a').filter({ hasText: /brand voice/i }).first().click(); await p.waitForTimeout(1200)
    await p.getByText(/^\d+ steps?$/).first().click(); await p.waitForTimeout(600)
    // the chat is shared with Priya, whose question follows: the shot starts at Jordan's question
    await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), '[data-testid="user-message"]'); await p.waitForTimeout(400)
  }, crop: 'main' },
  { file: 'chats/trina-drawer-phone', path: '/', phone: true, acme: true, as: JORDAN, prepare: click('[data-testid="menu-open"]') },
  { file: 'chats/rooms-list', path: '/rooms', acme: true, as: JORDAN, clip: { x: 0, y: 0, width: 328, height: 330 } },
  { file: 'chats/room', path: '/rooms', acme: true, as: JORDAN, prepare: async (p) => {
    await p.locator('#rail-panel').getByText('Marketing', { exact: true }).first().click(); await p.waitForTimeout(1200)
  }, crop: 'main' },
  { file: 'chats/thread', path: '/rooms', acme: true, as: JORDAN, prepare: async (p) => {
    await p.locator('#rail-panel').getByText('Marketing', { exact: true }).first().click(); await p.waitForTimeout(1200)
    await p.getByText(/^\d+ replies$/).first().click(); await p.waitForTimeout(900)
    // the message's hover bar stays out of the shot
    await p.mouse.move(640, 790); await p.waitForTimeout(300)
  }, crop: 'main' },
  { file: 'chats/rooms-phone', path: '/rooms', phone: true, acme: true, as: JORDAN },
  { file: 'chats/projects-panel', path: '/projects', acme: true, as: JORDAN },
  { file: 'chats/project', path: '/projects', acme: true, as: JORDAN, prepare: async (p) => { await p.locator('[data-testid="project-card"]').first().click(); await p.waitForTimeout(1000) }, crop: 'main' },
  // Share… (the brand-voice chat is shared with Priya; the campaign summary is not, and adding Priya shows the check)
  { file: 'chats/share-dialog', path: '/', acme: true, as: JORDAN, prepare: async (p) => { await openShare(/brand voice/i)(p); await blur(p) }, crop: DIALOG },
  { file: 'chats/share-warning', path: '/', acme: true, as: JORDAN, prepare: async (p) => {
    await openShare(/Summarize November/i)(p)
    await p.locator('[data-testid="chat-share-picker-search"]').fill('Priya'); await p.waitForTimeout(600)
    await p.locator('[data-testid="participant-add-user-priya"]').click(); await p.waitForTimeout(300)
    await p.locator('[data-testid="chat-share-save"]').click(); await p.waitForTimeout(1500)
    await blur(p)
  }, crop: DIALOG },
  { file: 'chats/shared-activity', path: '/activity', acme: true, as: PRIYA, clip: { x: 72, y: 0, width: 256, height: 220 } },
  // Files
  { file: 'files/files', path: '/files', acme: true, as: JORDAN, crop: 'main' },
  { file: 'files/files-phone', path: '/files', phone: true, acme: true, as: JORDAN },
  { file: 'files/folder-permissions', path: '/admin/folders', acme: true, crop: 'main' },
  { file: 'files/by-person', path: '/admin/folders', acme: true, prepare: async (p) => {
    await p.getByText('By person', { exact: true }).first().click(); await p.waitForTimeout(800)
    await p.locator('main').getByText('Jordan Lee', { exact: true }).first().click(); await p.waitForTimeout(900)
  }, crop: 'main' },
  // Team skills and connections
  { file: 'skills/team-skills', path: '/skills', acme: true, as: JORDAN, crop: 'main' },
  { file: 'skills/slash-menu', path: '/', acme: true, as: JORDAN, prepare: async (p) => {
    await p.locator('[data-testid="composer"] textarea, [data-testid="composer"] [contenteditable]').first().click(); await p.keyboard.press('/'); await p.waitForTimeout(700)
  }, crop: 'main' },
  { file: 'mcp/connected', path: '/settings/integrations', acme: true, as: JORDAN, prepare: blur, crop: '[data-testid="settings-dialog"]' },
  { file: 'mcp/add', path: '/settings/integrations', acme: true, as: JORDAN, prepare: async (p) => {
    await p.locator('[data-testid="connector-add"]').first().click(); await p.waitForTimeout(700)
  }, crop: '[role="dialog"]:not([data-testid="settings-dialog"]) >> nth=-1' },
  // Scheduled tasks
  { file: 'scheduled/list', path: '/scheduled', acme: true, as: JORDAN },
  { file: 'scheduled/task', path: '/scheduled', acme: true, as: JORDAN, prepare: async (p) => { await p.locator('main a[href^="/scheduled/"]').first().click(); await p.waitForTimeout(800) }, crop: 'main' },
  { file: 'scheduled/new-task', path: '/scheduled', acme: true, as: JORDAN, prepare: async (p) => { await p.getByRole('button', { name: /New task/ }).first().click(); await p.waitForTimeout(400) }, crop: 'main', },
  { file: 'scheduled/list-phone', path: '/scheduled', phone: true, acme: true, as: JORDAN },
  // Usage
  { file: 'usage/mine', path: '/settings/usage', acme: true, as: JORDAN, prepare: blur, crop: '[data-testid="settings-dialog"]' },
  { file: 'usage/team', path: '/admin/usage', acme: true, crop: 'main' },
  // Admin (the owner)
  { file: 'admin/team-menu', path: '/', acme: true, prepare: click('[data-testid="sidebar-team"]'), crop: '[data-testid="team-dropdown"]', pad: 8 },
  { file: 'admin/home', path: '/admin', acme: true },
  { file: 'admin/admin-phone', path: '/admin', phone: true, acme: true },
  { file: 'admin/ai-settings', path: '/admin/settings', acme: true, crop: 'main' },
  { file: 'admin/engines', path: '/admin/engines', acme: true, crop: 'main' },
  { file: 'admin/engines-open', path: '/admin/engines', acme: true, prepare: click('[data-testid="engine-open"]'), crop: '[data-testid="engine-card"]', pad: 16 },
  { file: 'admin/activity-log', path: '/admin/audit', acme: true, crop: 'main' },
  // Your account and search
  { file: 'settings/account-menu', path: '/', acme: true, as: JORDAN, prepare: click('[data-testid="account-menu"]'), crop: '[data-testid="account-dropdown"]', pad: 24 },
  { file: 'settings/settings', path: '/settings/profile', acme: true, as: JORDAN, prepare: blur, crop: '[data-testid="settings-dialog"]' },
  { file: 'settings/settings-phone', path: '/settings/profile', phone: true, acme: true, as: JORDAN },
  { file: 'settings/me-phone', path: '/settings', phone: true, acme: true, as: JORDAN },
  { file: 'search/palette', path: '/', acme: true, as: JORDAN, prepare: async (p) => { await p.keyboard.press('Meta+k'); await p.waitForTimeout(600) }, crop: '[data-testid="search-palette"]' },
  { file: 'search/messages', path: '/', acme: true, as: JORDAN, prepare: async (p) => { await p.keyboard.press('Meta+k'); await p.waitForTimeout(500); await p.keyboard.type('banner'); await p.waitForTimeout(1200) }, crop: '[data-testid="search-palette"]' },
  // Slack (docs/site/use/slack.md), from the mock server (--mock): the hosting service serves it, workspace "Acme"
  { file: 'slack/connected-apps', path: '/admin/connectors', mock: { slack: { admin: SLACK_NEW } }, prepare: async (p) => {
    await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), '[data-testid="connector-card"][data-id="slack"]'); await p.waitForTimeout(400)
  }, crop: 'main' },
  { file: 'slack/add-to-slack', path: '/admin/connectors/slack', mock: { slack: { admin: SLACK_NEW } }, crop: 'main' },
  { file: 'slack/connected', path: '/admin/connectors/slack?slack=installed', mock: { slack: { admin: SLACK_ADDED } }, crop: 'main' },
  { file: 'slack/removed', path: '/admin/connectors/slack', mock: { slack: { admin: { ...SLACK_ADDED, tokens: false, botName: null, state: 'off', lastError: 'removed', linked: 3 } } }, crop: 'main' },
  { file: 'slack/linked', path: '/settings/connectors?slack=linked', crop: '[data-testid="settings-dialog"]', prepare: async (p) => {
    // the dialog focuses its close button, which then shows a focus ring and its tooltip in the shot
    await p.evaluate((s) => { (document.activeElement as HTMLElement | null)?.blur(); document.querySelector(s)?.scrollIntoView({ block: 'center' }) }, '[data-testid="slack-account"]'); await p.waitForTimeout(400)
  }, mock: { slack: { mine: { available: true, workspace: 'Acme', signIn: true, link: { slackUserId: 'U0OLGA', slackName: 'Olga', linkedAt: '2026-11-12T01:30:00.000Z' } } } } },
  // the company's own Google app (docs/site/use/google-own-app.md), from the mock server (--mock): Acme on the hosting
  // service, Gmail's page in Admin › Connected apps
  { file: 'google-own-app/row-trina', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_HOSTED }, prepare: ownAppRow, crop: '[data-testid="team-settings"]' },
  { file: 'google-own-app/dialog-start', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_HOSTED }, prepare: ownAppDialog(0), crop: DIALOG },
  { file: 'google-own-app/dialog-cloud', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_HOSTED }, prepare: ownAppDialog(1), crop: DIALOG },
  { file: 'google-own-app/dialog-upload', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_HOSTED }, prepare: ownAppDialog(2), crop: DIALOG },
  { file: 'google-own-app/dialog-confirm', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_HOSTED }, prepare: ownAppDialog(3), crop: DIALOG },
  { file: 'google-own-app/row-company', path: '/admin/connectors/gmail', mock: { googleOwnApp: GOOGLE_OWN }, prepare: async (p) => {
    await ownAppRow(p); await p.locator('[data-testid="gsign-menu"]').click(); await p.waitForTimeout(300)
  }, crop: '[data-testid="team-settings"]' },
  { file: 'google-own-app/member-reconnect', path: '/settings/connectors/gmail', as: BOB, crop: '[data-testid="settings-dialog"]', prepare: async (p) => {
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur(), ''); await p.waitForTimeout(300)
  }, mock: { googleOwnApp: GOOGLE_OWN, googleApps: [{ app: 'gmail', connect: { userId: 'bob', name: 'Bob', email: 'bob@acme.example.com', status: 'needs_reconnect' } }] } },
  { file: 'google-own-app/row-company-phone', path: '/admin/connectors/gmail', phone: true, mock: { googleOwnApp: GOOGLE_OWN }, prepare: ownAppRow, crop: '[data-testid="gsign-row"]' },
  // Guests (docs/site/use/guests.md), from the mock server (--mock): the owner Olga, the member Bob, the guests Alex
  // Rivera (the room "Quote prep") and Sam Park (the project "Launch plan")
  { file: 'guests/add-people', path: `/rooms/${QUOTE_ROOM}`, mock: {}, guests: true, before: quoteMessages, prepare: roomAddList, crop: DIALOG },
  { file: 'guests/invite-dialog', path: `/rooms/${QUOTE_ROOM}`, mock: {}, guests: true, prepare: inviteDialog, crop: DIALOG },
  { file: 'guests/invite-link', path: `/rooms/${QUOTE_ROOM}`, mock: {}, guests: true, prepare: async (p) => {
    await inviteDialog(p)
    await p.locator('[data-testid="guest-invite-create"]').click(); await p.waitForTimeout(800)
    guestLink = new URL(((await p.evaluate((s) => document.querySelector(s)?.textContent ?? '', '[data-testid="guest-invite-url"]')) as string).trim()).pathname
    // the mock server is at 127.0.0.1, so the link would carry the "this computer only" note: shown as a team's own
    // address instead, as people see it
    await p.evaluate((path) => {
      const el = document.querySelector('[data-testid="guest-invite-url"]')
      if (el) el.textContent = `https://acme.example.com${path}`
      document.querySelector('[data-testid="local-link-note"]')?.remove()
    }, guestLink)
    await blur(p)
  }, crop: DIALOG },
  { file: 'guests/invite-page', path: '/', pathFn: () => guestLink, signedOut: true, mock: {}, guests: true, crop: 'form >> xpath=..', pad: 24 },
  { file: 'guests/guest-room', path: `/rooms/${QUOTE_ROOM}`, mock: {}, guests: true, as: ALEX_SIGN_IN, before: quoteMessages },
  { file: 'guests/guest-tag', path: `/rooms/${QUOTE_ROOM}`, mock: {}, guests: true, before: quoteMessages, clip: { x: 328, y: 0, width: 952, height: 350 } },
  { file: 'guests/admin-guests', path: '/admin/members', mock: {}, guests: true, prepare: async (p) => {
    await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), '[data-testid="guests-section"]'); await p.waitForTimeout(400)
  }, crop: '[data-testid="guests-section"]', pad: 16 },
  { file: 'guests/one-place', path: '/rooms?new=1', mock: {}, guests: true, as: BOB, prepare: async (p) => {
    await p.locator('[data-testid="people-row"]').filter({ hasText: 'Alex Rivera' }).locator('[data-testid="picker-tick"]').click(); await p.waitForTimeout(300)
    await p.locator('[data-testid="people-row"]').filter({ hasText: 'Olga' }).locator('[data-testid="picker-tick"]').click(); await p.waitForTimeout(500)
  }, crop: DIALOG },
]

/** The website's guides (trina-ax-website src/content/guides*.ts, public/images/guide/<name>.webp): one whole window per
 * guide at 1440×900, as a member or the owner. `--guides <folder> --member <user>:<password>` writes them there; the
 * owner is --url's DOCS_SHOT_USER. Korean guides come from `bun run demo --locale ko`, English ones from Acme (--acme). */
const guideShots = (member: { user: string; password: string }): Shot[] => {
  const typeSlash = async (p: Page) => { await p.locator('[data-testid="composer"] textarea, [data-testid="composer"] [contenteditable]').first().click(); await p.keyboard.press('/'); await p.waitForTimeout(700) }
  return [
    { file: 'first-question', path: '/', as: member },
    { file: 'team-files', path: '/files', as: member },
    { file: 'use-skills', path: '/', as: member, prepare: typeSlash },
    { file: 'schedules', path: '/scheduled', as: member, prepare: async (p) => { await p.locator('main button').filter({ hasText: /New task|새 작업/ }).first().click(); await p.waitForTimeout(500) } },
    { file: 'integrations', path: '/settings/integrations', as: member, prepare: blur },
    { file: 'apps', path: '/settings/apps', as: member, prepare: blur },
    { file: 'skills', path: '/skills' },
    { file: 'folder-permissions', path: '/admin/folders' },
    { file: 'invite', path: '/', prepare: async (p) => { await p.locator('[data-testid="sidebar-team"]').click(); await p.waitForTimeout(400); await p.locator('[data-testid="team-dropdown"]').getByText(/Invite people|초대/).first().click(); await p.waitForTimeout(900) } },
    { file: 'ai-connection', path: '/admin/engines' },
    { file: 'usage-limits', path: '/admin/usage' },
    { file: 'backup', path: '/admin/system' },
  ]
}

function args() {
  const a = process.argv.slice(2)
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined }
  const url = get('--url')?.replace(/\/+$/, '')
  if (!url) throw new Error('Usage: DOCS_SHOT_USER=… DOCS_SHOT_PASSWORD=… bun scripts/docs/screenshots.ts --url https://team.example.com [--only <file prefix>] [--mock]')
  const mock = a.includes('--mock')
  const acme = a.includes('--acme')
  // the mock server's seeded owner is olga (web/test/mock/serve.ts); Acme's owner is acme-admin (its password is in the
  // demo's data folder, owner-password)
  const member = get('--member')?.split(':')
  const guides = get('--guides')
  if (guides && !member?.[1]) throw new Error('--guides needs --member <user>:<password>')
  return { url, only: get('--only'), mock, acme, guides, member: member ? { user: member[0]!, password: member.slice(1).join(':') } : undefined, user: process.env.DOCS_SHOT_USER ?? (mock ? 'olga' : acme ? 'acme-admin' : 'dion'), password: process.env.DOCS_SHOT_PASSWORD ?? '' }
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
  const contextFor = async (phone: boolean, signedOut: boolean, as?: { user: string; password: string }) => {
    const key = `${phone}-${signedOut}-${as?.user ?? ''}`
    if (contexts.has(key)) return contexts.get(key)!
    const ctx = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : o.guides ? { width: 1440, height: 900 } : { width: 1280, height: 800 }, deviceScaleFactor: 2,
      colorScheme: 'light', locale: 'en-US', timezoneId: 'Asia/Seoul', isMobile: phone, hasTouch: phone,
    })
    if (!signedOut) {
      // sign in through the form, as a person would (the API refuses requests without the browser's own headers)
      const p = await ctx.newPage()
      await p.goto(`${o.url}/login`)
      const username = p.locator('input[type="text"], input[autocomplete="username"], input[name="username"]').first()
      // a demo company's sign-in page starts with its persona; the form is behind "Sign in with another account"
      if (o.acme) { await p.waitForTimeout(1500); await p.getByText(/Sign in with another account/).first().click().catch(() => undefined) }
      await username.fill(as?.user ?? o.user)
      await p.locator('input[type="password"]').first().fill(as?.password ?? o.password)
      await p.keyboard.press('Enter')
      // a busy server can take several seconds to sign in: wait up to 20 s for the page to leave /login
      for (let i = 0; i < 40 && (await p.evaluate(() => location.pathname, '')) === '/login'; i++) await p.waitForTimeout(500)
      await p.waitForTimeout(1000)
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
  const todo = o.guides ? guideShots(o.member!).filter((x) => !o.only || x.file.startsWith(o.only)) : SHOTS.filter((x) => (!o.only || x.file.startsWith(o.only)) && (o.acme ? !!x.acme : !x.acme && (!!x.mock === o.mock || (o.mock && !!x.mockToo))))
  // the --only of a mock shot without --mock (or the other way round) takes nothing: say so
  const only = (x: Shot) => !o.only || x.file.startsWith(o.only)
  const why = o.acme ? ': these shots are not Acme ones (leave out --acme)'
    : SHOTS.some((x) => only(x) && x.acme) ? ': these shots need --acme and the Acme demo company'
    : SHOTS.some((x) => only(x) && !!x.mock !== o.mock) ? (o.mock ? ': these shots need a development server, without --mock' : ': these shots need --mock and the web e2e mock server') : ''
  // the guests' room, project and people, once, before anyone signs in
  if (o.mock && todo.some((x) => x.guests)) await GUEST_SEED((what, data) => control(signedOut, what, data))
  if (!todo.length) console.error(`No shot to take${o.only ? ` for --only ${o.only}` : ''}${why}`)
  for (const s of todo) {
    const ctx = await contextFor(!!s.phone, !!s.signedOut, s.as)
    const page = await ctx.newPage()
    try {
      if (s.mock?.slack) await control(ctx, 'slack', s.mock.slack)
      if (s.mock?.googleOwnApp) await control(ctx, 'google-own-app', s.mock.googleOwnApp)
      for (const g of s.mock?.googleApps ?? []) await control(ctx, 'google-apps', g)
      if (s.before) await s.before(page)
      await page.goto(o.url + (s.pathFn?.() ?? s.path))
      // a page that keeps a request open (the apps page's downloads) never goes quiet: take it after the wait
      await page.waitForLoadState('networkidle').catch(() => undefined)
      await page.addStyleTag({ content: HIDE })
      await page.waitForTimeout(500)
      if (s.prepare) await s.prepare(page)
      let png: Buffer
      if (s.clip) png = await page.screenshot({ clip: s.clip })
      else if (s.crop) {
        const el = page.locator(s.crop).first()
        await el.waitFor({ timeout: 5000 })
        const box = await el.boundingBox()
        if (!box) throw new Error(`nothing to crop at ${s.crop}`)
        const pad = s.pad ?? 0
        png = await page.screenshot({ clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: Math.min(box.height + pad * 2, 1600) } })
      } else png = await page.screenshot({})
      const out = path.join(o.guides ?? OUT, `${s.file}.webp`)
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
