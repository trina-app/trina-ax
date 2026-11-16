// Connectors' "Get updates in a conversation" (docs/decisions/20261116-connector-card-room-apps.md, QA TC-3515), 1440
// and 390 wide: a listed service with a conversation app (Sentry; Atlassian's is Jira) has the action under its row,
// one without (Linear) has none; the picker lists only the conversations the server says the person may add apps to
// (Room.canManageApps: a member their 1:1 and group chat, an admin the team room and Everyone too); picking one opens
// it with that service's Add an app guide (nothing added before Copy; Back goes to the picker); with no such
// conversation one line says how to start one, no dialog. The rooms and their apps are answered through page.route
// (rooms-mock.ts, room-apps-mock.ts).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'
import { routeRoomApps } from './room-apps-mock'

test.use({ serviceWorkers: 'block', locale: 'en-US' })

const SIZES = [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }] as const
type Role = 'owner' | 'admin' | 'member'
const MINA = { id: 'mina', name: 'Mina' }
const JUN = { id: 'jun', name: 'Jun' }
const T0 = Date.parse('2026-11-05T09:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

/** A room of the list, as the server sends it; `can`: Room.canManageApps */
function room(id: string, kind: 'team' | 'all' | 'group' | 'dm', name: string | null, can: boolean, n: number) {
  return {
    id, kind, name, canRename: kind !== 'dm', managerId: kind === 'group' ? 'olga' : null, canManageApps: can, groupId: null,
    memberCount: kind === 'dm' ? 2 : 3, peers: kind === 'dm' ? [JUN] : [MINA, JUN], lastSeq: 0, unreadCount: 0, threadsUnread: 0,
    nextThreadId: null, mentioned: false, lastReadSeq: 0, lastMessage: null, muted: false, createdAt: at(-60), activityAt: at(n),
  }
}
const TEAM = '019a5f00-0000-7000-8000-00000000a101'
const ALL = '019a5f00-0000-7000-8000-00000000a102'
const DM = '019a5f00-0000-7000-8000-00000000a103'
/** the server's answer for each role (rooms/store.ts mayManageApps) */
const roomsFor = (role: Role, only?: 'team') => {
  const staff = role !== 'member'
  const list = [room(TEAM, 'team', 'design', staff, 4), room(ALL, 'all', null, staff, 3), room(ROOM_ID, 'group', 'Launch', true, 2), room(DM, 'dm', null, true, 1)]
  return only ? list.slice(0, 2) : list
}

async function open(page: Page, o: { size: { width: number; height: number }; role: Role; only?: 'team' }) {
  await page.setViewportSize(o.size)
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await routeRoom(page, { kind: 'group', members: [MINA, JUN], room: { name: 'Launch' } })
  const apps = await routeRoomApps(page, {})
  // the rooms list (registered after routeRoom, so it answers first); everything else goes on to routeRoom
  await page.route(/\/api\/rooms(\?|$)/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: roomsFor(o.role, o.only) }) })
  })
  if (o.role !== 'owner') {
    await page.route(/\/api\/me$/, async (route) => {
      const r = await route.fetch()
      const me = await r.json() as { user: { role: string } }
      if (me?.user) me.user.role = o.role
      await route.fulfill({ response: r, json: me })
    })
  }
  await signIn(page)
  await page.goto('/settings/connectors')
  await expect(page.getByTestId('connectors-header')).toBeVisible()
  return { apps }
}

const card = (page: Page, id: string) => page.locator(`[data-testid="connector-card"][data-id="${id}"]`)
async function find(page: Page, q: string) {
  await page.getByTestId('connector-search').fill(q)
  await expect(card(page, q.toLowerCase())).toBeVisible()
  return card(page, q.toLowerCase())
}
const picked = (page: Page) => page.getByTestId('room-app-picker-room')

for (const vp of SIZES) {
  test.describe(`connector → conversation app (${vp.name})`, () => {
    test('a member: only their 1:1 and group chat; picking one opens the Sentry guide there, nothing added', async ({ page }) => {
      const { apps } = await open(page, { size: vp.size, role: 'member' })
      const sentry = await find(page, 'Sentry')
      const action = sentry.getByTestId('connector-room-app-open')
      await expect(action).toHaveText('Get updates in a conversation')
      // a service without a conversation app has none
      await expect((await find(page, 'Linear')).getByTestId('connector-room-app')).toHaveCount(0)
      await (await find(page, 'Sentry')).getByTestId('connector-room-app-open').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByTestId('room-app-picker')).toContainText("Sentry's setup opens in the conversation you choose.")
      await expect(picked(page)).toHaveCount(2)
      await expect(picked(page).nth(0)).toHaveAttribute('data-room-id', ROOM_ID)
      await expect(picked(page).nth(1)).toHaveAttribute('data-kind', 'dm')
      await expect(picked(page).nth(1)).toContainText('Jun · 1:1')
      await picked(page).nth(0).click()
      await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
      await expect(page.getByTestId('apps-dialog')).toHaveAttribute('data-view', 'guide')
      await expect(page.getByTestId('apps-title')).toHaveText('Connect Sentry')
      expect(apps.calls).toEqual([])
      // Back: the other services
      await page.getByTestId('apps-back').click()
      await expect(page.getByTestId('apps-picker')).toBeVisible()
      expect(apps.calls).toEqual([])
    })

    test('an admin: the team room and Everyone too; Atlassian opens the Jira guide', async ({ page }) => {
      const { apps } = await open(page, { size: vp.size, role: 'admin' })
      await (await find(page, 'Atlassian')).getByTestId('connector-room-app-open').click()
      await expect(page.getByRole('dialog').getByTestId('room-app-picker')).toContainText("Jira's setup opens")
      await expect(picked(page)).toHaveCount(4)
      await expect(picked(page).nth(0)).toHaveAttribute('data-room-id', TEAM)
      await expect(picked(page).nth(1)).toHaveAttribute('data-kind', 'all')
      await picked(page).nth(2).click()
      await expect(page.getByTestId('apps-title')).toHaveText('Connect Jira')
      expect(apps.calls).toEqual([])
    })

    test('a member in team rooms only: one line on how to start a conversation, no dialog', async ({ page }) => {
      await open(page, { size: vp.size, role: 'member', only: 'team' })
      const sentry = await find(page, 'Sentry')
      await sentry.getByTestId('connector-room-app-open').click()
      await expect(sentry.getByTestId('connector-room-app-none')).toHaveText('You have no conversation for this yet. Start one with New conversation in Conversations.')
      await expect(page.getByTestId('room-app-picker')).toHaveCount(0)
    })
  })
}
