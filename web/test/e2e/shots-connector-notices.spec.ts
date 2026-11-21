// Screenshots for QA TC-2939, TC-2944, TC-2945, TC-2946 (fix/connector-notices-truth), 1440 and 390 wide, for reviewing by
// eye: a connection added by its address that answered but not as a connector, a member's own connection on Always
// allow while the team's switch is off, and the Activity rows for a connection that needs a sign-in again and a request
// an admin closed. The mock server's answers get these fake rows added (page.route). Only when CONNECTOR_NOTICES_SHOTS
// names a folder to write them to.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const dir = process.env.CONNECTOR_NOTICES_SHOTS
test.skip(!dir, 'CONNECTOR_NOTICES_SHOTS is not set')
test.use({ locale: 'en-US' })

const MEMBER = { username: 'bob', password: 'bob password 1' }
const now = new Date().toISOString()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const conn = (id: string, o: Record<string, unknown>) => ({
  id, scope: 'personal', kind: 'mcp', name: 'Acme tasks', slug: 'acme-tasks', url: 'https://tasks.acme.example/mcp', auth: 'bearer', authHeader: null,
  hasSecret: true, account: null, notes: null, writePolicy: 'ask', status: 'connected', lastError: null, lastErrorReason: null,
  tools: [{ name: 'create_task', title: 'Create task', description: 'Adds a task', readOnly: false, enabled: true }], toolsUpdatedAt: now,
  access: null, createdBy: null, createdAt: now, updatedAt: now, lastUsedAt: null, canManage: true, ...o,
})
const NOT_MCP = '019a5f00-0000-7000-8000-00000000a001'
const ALLOW = '019a5f00-0000-7000-8000-00000000a002'
const extra = [
  conn(NOT_MCP, { name: 'Acme wiki', slug: 'acme-wiki', url: 'https://wiki.acme.example/', status: 'error', lastError: 'This address did not answer like an MCP server.', lastErrorReason: 'not_mcp', tools: [], toolsUpdatedAt: null }),
  conn(ALLOW, { writePolicy: 'allow' }),
]
const notice = (n: number, code: string, minutes: number, o: Record<string, unknown>) => ({ id: `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`, eventType: code, sourceId: `src-${n}`, code, createdAt: ago(minutes), readAt: null, chatId: null, link: null, outcome: null, ...o })
const notices = [
  notice(1, 'connection.reconnect', 3, { link: 'connections', sourceId: `${ALLOW}_1`, connection: { id: ALLOW, name: 'Acme tasks', googleApp: null } }),
  notice(2, 'service.closed', 20, { serviceRequest: { service: 'notion', closed: 'dismissed' } }),
  notice(3, 'service.closed', 60, { serviceRequest: { service: 'gmail', closed: 'expired' } }),
]

/** the fake rows on top of the mock server's answers; `after`: the notices this branch sends (none before it) */
async function fakeRows(page: Page, o: { alwaysOff: boolean; after: boolean }) {
  await page.route('**/api/me', async (route) => {
    const res = await route.fetch()
    const me = await res.json()
    return route.fulfill({ response: res, json: { ...me, team: { ...me.team, ...(o.alwaysOff ? { alwaysAllowOff: true } : {}) } } })
  })
  await page.route(/\/api\/integrations(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json()
    return route.fulfill({ response: res, json: { ...body, items: [...(body.items ?? []), ...extra] } })
  })
  await page.route('**/api/notifications?*', (route) => {
    const items = o.after ? notices : []
    const only = new URL(route.request().url()).searchParams.get('only')
    return route.fulfill({ json: { items: only === 'rooms' ? [] : items, nextCursor: null, unreadCount: items.length, roomUnreadCount: 0, noticeUnreadCount: items.length } })
  })
}

for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  test(`connector notices screenshots (${vp.name})`, async ({ page }) => {
    test.setTimeout(120_000)
    const after = process.env.CONNECTOR_NOTICES_AFTER === '1'
    const tag = after ? 'after' : 'before'
    await page.setViewportSize(vp.size)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await fakeRows(page, { alwaysOff: true, after })
    await signIn(page, MEMBER)
    const shot = (name: string) => page.screenshot({ path: `${dir}/${name}-${vp.name}-${tag}.png` })
    // TC-2939: answered, but not as a connector
    await page.goto(`/settings/connectors/mcp/${NOT_MCP}`)
    await expect(page.getByTestId('integration-error')).toBeVisible()
    await shot('tc2939-not-mcp')
    // TC-2944: my own connection on Always allow, the team's switch off
    await page.goto(`/settings/connectors/mcp/${ALLOW}`)
    await expect(page.getByTestId('app-abilities')).toBeVisible()
    await page.getByTestId('app-abilities').scrollIntoViewIfNeeded()
    await shot('tc2944-always-allow-switch-off')
    // TC-2945, TC-2946: Activity
    await page.goto('/activity')
    await page.waitForTimeout(800)
    await shot('tc2945-2946-activity')
  })
}
