// Guest states (docs/DECISIONS.md "Guest states: true reasons, a reset AI, and coming back with a restored place"): a
// dead invite link says its true reason, also when it stops while the form is filled in (QA TC-2219, 2225, 2226, 2297,
// 2298); the invite dialog and the link say it works once, for 7 days, until when (TC-2222, 2223); Admin › Guests reads
// "N of M guests", in the warning colour with one line when a lowered plan has fewer places than guests (TC-2192,
// 2256); a removed guest is switched back on only while their place is there, the row says why not otherwise, and a
// refused switch-on says why with Make team member (TC-2233, 2295, 2307, 2308); a Team AI whose account was deleted reads
// so in Admin and "AI can't answer" for the guest (TC-2255); the limit says when it resets (TC-2201).
// SHOTS=<dir> also saves each screen at 1440 and 390, light and dark.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7, type GuestAiChoice } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

test.use({ timezoneId: 'Asia/Seoul' })

const ROOM = uuidv7()
const base = { canRename: true, managerId: 'olga', unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const at = new Date(Date.now() - 3600_000).toISOString()
const ROOMS = [{ ...base, id: ROOM, kind: 'group', name: 'Quote prep', groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at }]
const SHOTS = process.env.SHOTS

/** Each screen at 1440 and 390, light and dark (only with SHOTS set). `open` puts the screen up again after a resize. */
async function shoot(page: Page, name: string, open?: () => Promise<void>) {
  if (!SHOTS) return
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: w, height: h })
      await page.emulateMedia({ colorScheme: scheme })
      if (open) await open()
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${SHOTS}/${name}-${w}-${scheme}.png` })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  // the screen as the test left it, at the computer's width again
  if (open) await open()
}

async function start(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
}
const guest = (page: Page, data: Record<string, unknown>) => page.request.post('/__test/guest', { data: { place: { kind: 'room', id: ROOM }, ...data } }).then((r) => expect(r.ok()).toBeTruthy())
const menu = (page: Page, username: string) => page.getByTestId(`guest-row-${username}`).getByTestId('member-more')

test.describe('computer', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the invite dialog and its link say it works once, for 7 days, until when', async ({ page }) => {
    await start(page)
    await signIn(page)
    const open = async () => {
      await page.goto(`/rooms/${ROOM}`)
      await page.getByTestId('room-members-button').click()
      await page.getByTestId('room-invite').click()
      await page.getByTestId('invite-guest-row').click()
      await expect(page.getByTestId('guest-invite-dialog')).toBeVisible()
    }
    await open()
    const until = new Date(Date.now() + 7 * 86_400_000)
    const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' }).format(until)
    await expect(page.getByTestId('guest-invite-expiry')).toContainText('The link works once, for 7 days (until ')
    await expect(page.getByTestId('guest-invite-expiry')).toContainText(day)
    await shoot(page, 'invite-dialog', open)
    await page.getByTestId('guest-invite-name').fill('Alex at Acme')
    await page.getByTestId('guest-invite-create').click()
    await expect(page.getByTestId('guest-invite-once')).toContainText('It works once, for 7 days (until ')
    await expect(page.getByTestId('guest-invite-once')).toContainText(day)
    await shoot(page, 'invite-link')
  })

  test('a dead link says its true reason; one that stops while the form is filled in says it too', async ({ page, browser }) => {
    await start(page)
    await signIn(page)
    const token = async () => {
      const r = await page.request.post('/api/guest-invites', { data: { place: { kind: 'room', id: ROOM } }, headers: { [CSRF_HEADER]: '1' } })
      expect(r.ok()).toBeTruthy()
      return String(((await r.json()) as { url: string }).url).split('/invite/')[1]!
    }
    const cases: [string, string][] = [
      ['expired', 'This invite link has expired. Ask the person who invited you for a new one.'],
      ['revoked', 'This invite link was turned off. Ask the person who invited you for a new one.'],
      ['inviter_gone', 'The person who made this link can no longer invite you. Ask them or someone else on the team for a new link.'],
      ['place_gone', 'The room or project this link was for is no longer there. Ask the person who invited you.'],
    ]
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Seoul' })
    const g = await ctx.newPage()
    for (const [reason, words] of cases) {
      const t = await token()
      expect((await page.request.post('/__test/invite-reason', { data: { token: t, reason } })).ok()).toBeTruthy()
      await g.goto(`/invite/${t}`)
      await expect(g.getByTestId('invite-invalid')).toHaveText(words)
      // only the reason: no place, no form
      await expect(g.getByTestId('invite-guest-place')).toHaveCount(0)
      await expect(g.getByTestId('invite-submit')).toHaveCount(0)
      if (reason === 'inviter_gone') await shoot(g, 'invite-page-inviter-gone', () => g.goto(`/invite/${t}`).then(() => expect(g.getByTestId('invite-invalid')).toBeVisible()))
    }
    // the maker loses access while the form is filled in: the page then says why, no account made
    const late = await token()
    expect((await page.request.post('/__test/invite-reason', { data: { token: late, reason: 'inviter_gone', late: true } })).ok()).toBeTruthy()
    await g.goto(`/invite/${late}`)
    await g.getByTestId('invite-name').fill('Alex')
    await g.getByTestId('invite-username').fill('alex')
    await g.getByTestId('invite-password').fill('alex password 1')
    await g.getByTestId('invite-submit').click()
    await expect(g.getByTestId('invite-invalid')).toHaveText(cases[2]![1])
    await expect(g.getByTestId('invite-invalid')).toHaveAttribute('data-reason', 'inviter_gone')
    await ctx.close()
  })

  test('Admin › Guests: N of M guests; more than a lowered plan allows in the warning colour, with one line; nobody removed', async ({ page }) => {
    await start(page)
    await guest(page, { id: 'gina', name: 'Gina' })
    await guest(page, { id: 'rhea', name: 'Rhea' })
    await signIn(page)
    // no cap (self-hosted): "2 guests"
    await page.goto('/admin/members')
    await expect(page.getByTestId('guests-count')).toHaveText('2 guests')
    expect((await page.request.post('/__test/guest-limit', { data: { guests: 10 } })).ok()).toBeTruthy()
    await page.reload()
    await expect(page.getByTestId('guests-count')).toHaveText('2 of 10 guests')
    await expect(page.getByTestId('guests-over')).toHaveCount(0)
    // the plan lowered to one guest: both stay, the count in the warning colour, one plain line
    expect((await page.request.post('/__test/guest-limit', { data: { guests: 1 } })).ok()).toBeTruthy()
    await page.reload()
    await expect(page.getByTestId('guests-count')).toHaveText('2 of 1 guest')
    await expect(page.getByTestId('guests-count')).toHaveAttribute('data-over', 'true')
    await expect(page.getByTestId('guests-over')).toHaveText("This plan allows 1 guest. Everyone here keeps working, but you can't invite more until you remove guests or change the plan.")
    await expect(page.getByTestId('guest-row-gina')).toBeVisible()
    await expect(page.getByTestId('guest-row-rhea')).toBeVisible()
    await shoot(page, 'admin-guests-over', async () => { await page.goto('/admin/members#guests'); await expect(page.getByTestId('guests-over')).toBeVisible(); await page.getByTestId('guests-section').scrollIntoViewIfNeeded() })
  })

  test('removed guests: switched back on while their place is there; the row says why not otherwise; a refused switch-on says why, with Make team member', async ({ page }) => {
    await start(page)
    const proj = (await (await page.request.post('/__test/project', { data: { name: 'Launch plan', by: 'olga' } })).json()) as { id: string }
    await guest(page, { id: 'gina', name: 'Gina', status: 'disabled' })
    await guest(page, { id: 'lena', name: 'Lena', status: 'disabled', out: 'left' })
    await guest(page, { id: 'tara', name: 'Tara', status: 'disabled', out: 'trashed', place: { kind: 'project', id: proj.id } })
    await guest(page, { id: 'gwen', name: 'Gwen', status: 'disabled', out: 'gone' })
    const team: GuestAiChoice = { mode: 'team', credentialId: 'c1', limitUsd: 20 }
    await guest(page, { id: 'abel', name: 'Abel', ai: team, teamAiGone: true })
    await signIn(page)
    await page.goto('/admin/members')
    await page.getByTestId('guests-show-removed').click()
    await expect(page.getByTestId('guest-row-lena')).toContainText("No longer in 'Quote prep'")
    await expect(page.getByTestId('guest-row-tara')).toContainText('Project · Launch plan · in the trash')
    await expect(page.getByTestId('guest-row-gwen')).toContainText('Their room or project is gone')
    // a Team AI whose account was deleted: said, with Change AI in its menu
    await expect(page.getByTestId('guest-row-abel')).toContainText('Team AI · account removed')
    await shoot(page, 'admin-guests-removed', async () => { await page.goto('/admin/members'); await page.getByTestId('guests-show-removed').click(); await page.getByTestId('guests-section').scrollIntoViewIfNeeded() })
    // nothing to bring back to: no Switch back on, only Make team member and Delete
    await menu(page, 'gwen').click()
    await expect(page.getByTestId('guest-on-gwen')).toHaveCount(0)
    await expect(page.getByTestId('guest-convert-gwen')).toBeVisible()
    await expect(page.getByTestId('guest-delete-gwen')).toBeVisible()
    await page.keyboard.press('Escape')
    // their place is there: back on
    await menu(page, 'gina').click()
    await page.getByTestId('guest-on-gina').click()
    await expect(page.getByText('Gina can sign in again.')).toBeVisible()
    // a switch-on the server refuses (the place went meanwhile): why, and Make team member
    await page.route('**/api/admin/users/*', async (r) => {
      if (r.request().method() !== 'PATCH') return r.fallback()
      await r.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'x', params: { reason: 'guest_no_place', placeOut: 'gone' } } } })
    })
    await page.request.post('/__test/guest', { data: { id: 'mona', name: 'Mona', status: 'disabled', place: { kind: 'room', id: ROOM } } })
    await page.reload()
    await page.getByTestId('guests-show-removed').click()
    const openRefused = async () => {
      await menu(page, 'mona').click()
      await page.getByTestId('guest-on-mona').click()
      await expect(page.getByTestId('guest-no-place')).toHaveText("Their room or project is gone, so there's nothing to bring them back to. Invite them again or make them a team member.")
    }
    await openRefused()
    await shoot(page, 'admin-guest-no-place', async () => { await page.goto('/admin/members'); await page.getByTestId('guests-show-removed').click(); await openRefused() })
    await page.getByTestId('guest-no-place-convert').click()
    // Make team member on a removed guest: switched on with it, said so
    await expect(page.getByTestId('guest-convert-dialog')).toContainText('They take one seat and can sign in again, as a team member.')
    await shoot(page, 'admin-guest-convert-removed', async () => {
      await page.goto('/admin/members'); await page.getByTestId('guests-show-removed').click()
      await menu(page, 'mona').click(); await page.getByTestId('guest-convert-mona').click()
      await expect(page.getByTestId('guest-convert-dialog')).toContainText('can sign in again')
    })
    await page.unroute('**/api/admin/users/*')
    await page.getByTestId('guest-convert-confirm').click()
    await expect(page.getByText('Mona is now a team member.')).toBeVisible()
  })
})

test.describe('guest', () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  const TEAM_AI: GuestAiChoice = { mode: 'team', credentialId: 'c1', limitUsd: 20 }
  async function signInGuest(page: Page, id: string) {
    await page.goto('/login')
    await page.getByTestId('login-username').fill(id)
    await page.getByTestId('login-password').fill(`${id} password 1`)
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-submit')).toHaveCount(0)
  }

  test('a Team AI guest at the limit is told when it resets', async ({ page }) => {
    await start(page)
    await guest(page, { id: 'tina', name: 'Tina', ai: TEAM_AI })
    await signInGuest(page, 'tina')
    await page.goto('/')
    await page.getByTestId('composer-input').fill('error:budget\nhello')
    await page.getByTestId('composer-input').press('Enter')
    const line = page.getByText("You've used this month's AI limit. It resets on Dec 1. Ask the person who invited you if you need more.")
    await expect(line).toBeVisible()
    const url = page.url()
    await shoot(page, 'guest-ai-limit', async () => { await page.goto(url); await expect(line).toBeVisible() })
  })

  test("a Team AI guest whose team AI account was deleted keeps Trina and reads that AI can't answer", async ({ page }) => {
    await start(page)
    await guest(page, { id: 'abel', name: 'Abel', ai: TEAM_AI, teamAiGone: true })
    await page.route('**/api/me/ai-access', (r) => r.fulfill({ json: { usable: false, action: 'ask_owner', requested: false } }))
    await signInGuest(page, 'abel')
    await page.goto('/')
    await expect(page.getByTestId('rail-ai')).toBeVisible()
    await expect(page.getByTestId('guest-no-ai')).toContainText("AI can't answer you here yet. Ask the person who invited you.")
    await shoot(page, 'guest-team-ai-gone', async () => { await page.goto('/'); await expect(page.getByTestId('guest-no-ai')).toBeVisible() })
  })
})
