// Two small flow gaps (Flows tab FL-014, FL-002), at 1440 and 390 px:
// - a DM with a person who was deleted from the team stays readable but has no message box and says they left the team;
// - a team link opened on a computer where someone else is signed in shows "You're already in <team>" with "Sign out to
//   join": it signs that person out and opens the same link's join page, so the next person can join.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { translate } from '../../src/i18n'

const DM = uuidv7()
const base = { canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const now = new Date().toISOString()
const room = (extra: object) => ({ ...base, id: DM, kind: 'dm', name: null, groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: now, activityAt: now, ...extra })

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

for (const vp of [
  { name: '1440', use: { viewport: { width: 1440, height: 900 } } },
  { name: '390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
]) {
  test.describe(`at ${vp.name}`, () => {
    test.use({ ...vp.use, locale: 'en-US' })

    test('a DM with someone who left the team: history readable, no message box, a plain line', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      // still here: the box is there, no line
      expect((await page.request.post('/__test/rooms', { data: { rooms: [room({})] } })).ok()).toBeTruthy()
      await page.goto(`/rooms/${DM}`)
      await expect(page.getByTestId('room-input')).toBeVisible()
      await expect(page.getByTestId('room-peer-gone')).toHaveCount(0)
      // deleted from the team
      expect((await page.request.post('/__test/rooms', { data: { rooms: [room({ gone: true })] } })).ok()).toBeTruthy()
      await expect(page.getByTestId('room-peer-gone')).toHaveText(translate('en', 'rooms.peerGone', { name: 'Bob' }))
      await expect(page.getByTestId('room-peer-gone')).toContainText('left the team')
      await expect(page.getByTestId('room-input')).toHaveCount(0)
      await audit(page, 'a DM with someone who left')
    })

    test('a team link opened while someone else is signed in: "Sign out to join" signs out and shows the join page', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      const made = await page.request.post('/api/admin/team-link', { headers: { [CSRF_HEADER]: '1' }, data: {} })
      const { url } = ((await made.json()) as { link: { url: string } }).link
      await page.goto(url)
      await expect(page.getByText(/You're already in/)).toBeVisible()
      await audit(page, 'the toast')
      await page.getByRole('button', { name: translate('en', 'teamLink.signOutToJoin') }).click()
      await expect(page).toHaveURL(/\/join$/)
      await expect(page.getByTestId('join-form')).toBeVisible()
      // really signed out: the session is gone
      expect((await page.request.get('/api/me')).status()).toBe(401)
    })
  })
}
