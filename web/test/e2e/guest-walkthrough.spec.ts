// Guest walkthrough A (docs/DECISIONS.md "Guest walkthrough A"): what guests see (no Suggest as skill, no rename, no
// empty Send to a chat room), the cap counting open links (M4) and the full invite page (M3), the link's message (S7),
// Admin's list naming the room (S8), the guest's invite page on a phone and in their browser's language (S9, S10), the
// guest's own screen when their account ended (S5, S6) and a line when their AI is switched off (N7).
// SHOT_DIR=<folder> also saves the changed screens (1440 and 390, light and dark, ko and en).
import path from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7, type GuestAiChoice } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { reset, signIn } from './helpers'

const GROUP = uuidv7()
const base = { canRename: true, managerId: 'olga', unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const at = new Date(Date.now() - 3600_000).toISOString()
const ROOMS = [{ ...base, id: GROUP, kind: 'group', name: '견적 준비', groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at }]
const TEAM_AI: GuestAiChoice = { mode: 'team', credentialId: 'c1', limitUsd: 20 }
const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const shot = async (p: Page, name: string) => {
  if (process.env.SHOT_DIR) await p.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`) })
}
const post = async (page: Page, url: string, data: unknown) => {
  const r = await page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.status(), url).toBeLessThan(300)
  return r.json()
}

async function start(page: Page) {
  await reset(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
}
async function guestIn(page: Page, place: { kind: 'room'; id: string } | { kind: 'project'; name: string }, ai: GuestAiChoice = { mode: 'none' }) {
  await start(page)
  if (place.kind === 'project') expect((await page.request.post('/__test/project', { data: { name: place.name, by: 'bob' } })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place, ai } })).ok()).toBeTruthy()
  await page.goto('/login')
  await page.getByTestId('login-username').fill('gina')
  await page.getByTestId('login-password').fill('gina password 1')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-submit')).toHaveCount(0)
}
/** A guest link into the group chat, made by the owner (signed in on `page`). */
async function guestLink(page: Page, name?: string): Promise<string> {
  const r = await post(page, '/api/guest-invites', { place: { kind: 'room', id: GROUP }, ai: { mode: 'none' }, ...(name ? { name } : {}) })
  return new URL(String(r.url), 'http://x').pathname
}
async function signedOutPage(browser: Browser, o: { locale?: string; phone?: boolean; dark?: boolean } = {}) {
  const ctx = await browser.newContext({ locale: o.locale ?? 'ko-KR', colorScheme: o.dark ? 'dark' : 'light', ...(o.phone ? { userAgent: IPHONE, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } }) })
  return { ctx, page: await ctx.newPage() }
}

test.describe('what a guest sees', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('M1, S1: a project guest with AI gets an answer without Suggest as skill or an empty Send to a chat room', async ({ page }) => {
    await guestIn(page, { kind: 'project', name: '견적 준비' }, TEAM_AI)
    await page.goto('/')
    await page.getByTestId('composer-input').fill('summarise the quote')
    await page.getByTestId('send').click()
    const answer = page.getByTestId('assistant-message').last()
    await expect(answer).toHaveAttribute('data-status', 'done')
    await answer.hover()
    await expect(answer.getByTestId('regenerate').or(answer.getByTestId('answered-by')).first()).toBeAttached()
    await expect(answer.getByTestId('suggest-skill')).toHaveCount(0)
    await expect(answer.getByTestId('share-to-room')).toHaveCount(0)
  })

  test('M2: a guest in a group chat sees its name without the rename pencil', async ({ page }) => {
    await guestIn(page, { kind: 'room', id: GROUP })
    await page.goto(`/rooms/${GROUP}`)
    await page.getByTestId('room-members-button').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByTestId('room-name')).toHaveCount(0)
  })

  test("N7: a guest whose AI is switched off while signed in is told in one line", async ({ page }) => {
    await guestIn(page, { kind: 'room', id: GROUP }, TEAM_AI)
    await expect(page.getByTestId('rail-ai')).toBeVisible()
    // the admin's change: /api/me now says No AI, and the server tells their windows to read it again
    await page.route('**/api/me', async (route) => {
      const r = await route.fetch()
      const me = await r.json()
      await route.fulfill({ response: r, json: { ...me, guest: { ...me.guest, ai: { mode: 'none' } } } })
    })
    expect((await page.request.post('/__test/publish', { data: { event: { type: 'notice', data: { level: 'info', code: 'my_profile_changed', message: '' } } } })).ok()).toBeTruthy()
    await expect(page.getByText(ko('guest.aiTurnedOff'))).toBeVisible()
    await expect(page.getByTestId('rail-ai')).toHaveCount(0)
    await shot(page, 'n7-ai-off-toast-1440-light-ko')
  })
})

test.describe('the cap and the link', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('M4: an open link holds the last place: the dialog says full before the form, with the link counted', async ({ page }) => {
    await start(page)
    await signIn(page)
    expect((await page.request.post('/__test/guest-limit', { data: { guests: 1 } })).ok()).toBeTruthy()
    await guestLink(page)
    await page.goto(`/rooms/${GROUP}`)
    await page.getByTestId('room-members-button').click()
    await page.getByTestId('room-invite').click()
    await page.getByTestId('invite-guest-row').click()
    await expect(page.getByTestId('guest-invite-full')).toContainText(ko('guest.fullLinks', { n: 1 }))
    await expect(page.getByTestId('guest-invite-full-pending')).toHaveText(ko('guest.fullPending', { n: 1 }))
    await expect(page.getByTestId('guest-invite-full-next')).toContainText('관리자 › 멤버·초대에서 필요 없는 링크를 취소')
    await expect(page.getByTestId('guest-invite-name')).toHaveCount(0)
    await shot(page, 'm4-full-pending-1440-light-ko')
    // a refused Create link (the place was taken meanwhile) says the same
    expect((await page.request.post('/__test/guest-limit', { data: { guests: 2 } })).ok()).toBeTruthy()
    await page.getByTestId('guest-invite-full-close').click()
    await page.getByTestId('invite-guest-row').click()
    await expect(page.getByTestId('guest-invite-name')).toBeVisible()
    await guestLink(page)
    await page.getByTestId('guest-invite-create').click()
    await expect(page.getByTestId('guest-invite-full-pending')).toHaveText(ko('guest.fullPending', { n: 2 }))
  })

  test('S7, S8, N3: the link comes with a message to paste; Admin names the room', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await start(page)
    await signIn(page)
    await page.goto(`/rooms/${GROUP}`)
    await page.getByTestId('room-members-button').click()
    await page.getByTestId('room-invite').click()
    await page.getByTestId('invite-guest-row').click()
    await page.getByTestId('guest-invite-name').fill('Alex')
    await page.getByTestId('guest-invite-create').click()
    const msg = page.getByTestId('guest-invite-message')
    await expect(msg).toContainText("안녕하세요, Olga입니다.")
    await expect(msg).toContainText("'견적 준비' 그룹 대화에 초대할게요. 이 그룹 대화만 보여요.")
    await expect(page.getByTestId('guest-invite-url')).toContainText('/invite/')
    // Copy message is the main action, Copy link beside it, Done in the footer
    await expect(page.getByTestId('guest-invite-copy-message')).toHaveClass(/bg-accent/)
    await expect(page.getByTestId('guest-invite-copy')).not.toHaveClass(/bg-accent/)
    await page.getByTestId('guest-invite-copy-message').click()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain("'견적 준비' 그룹 대화에 초대할게요")
    expect(copied).toMatch(/\/invite\/\S+$/)
    // N3: the this-computer note (the mock runs on 127.0.0.1) says "to someone", not "to a team member"
    await expect(page.getByTestId('local-link-note')).toContainText('다른 사람에게 보내려면')
    await shot(page, 's7-link-ready-1440-light-ko')
    await page.getByTestId('guest-invite-done').click()
    // S8: Admin's invite list names the room
    await page.goto('/admin/members')
    await expect(page.getByTestId('invite-list')).toContainText('견적 준비')
    await expect(page.getByTestId('invite-list')).not.toContainText(ko('guest.admin.inviteRoom'))
  })
})

test.describe("the guest's invite page", () => {
  test('M3: guests full: who invited them and one line, no form', async ({ page, browser }) => {
    await start(page)
    await signIn(page)
    const link = await guestLink(page, 'Alex')
    expect((await page.request.post('/__test/guest-limit', { data: { guests: 0 } })).ok()).toBeTruthy()
    const { ctx, page: g } = await signedOutPage(browser)
    await g.goto(link)
    await expect(g.getByRole('heading', { level: 1 })).toContainText('Olga')
    await expect(g.getByTestId('invite-guest-full')).toHaveText(ko('invite.guestFull'))
    await expect(g.getByTestId('join-form')).toHaveCount(0)
    await shot(g, 'm3-invite-full-1440-light-ko')
    await ctx.close()
  })

  test('M3: guests filled up while the form was filled in: the same page, not an error under the form', async ({ page, browser }) => {
    await start(page)
    await signIn(page)
    const link = await guestLink(page)
    const { ctx, page: g } = await signedOutPage(browser)
    await g.goto(link)
    await g.getByTestId('invite-name').fill('Alex')
    await g.getByTestId('invite-username').fill('alex')
    await g.getByTestId('invite-password').fill('river stone lamp 8')
    expect((await page.request.post('/__test/guest-limit', { data: { guests: 0 } })).ok()).toBeTruthy()
    await g.getByTestId('invite-submit').click()
    await expect(g.getByTestId('invite-guest-full')).toBeVisible()
    await expect(g.getByRole('heading', { level: 1 })).toContainText('Olga')
    await ctx.close()
  })

  test('S9: on a phone a guest leads with Continue in the browser; the app is a link', async ({ page, browser }) => {
    await start(page)
    await signIn(page)
    const link = await guestLink(page)
    const { ctx, page: g } = await signedOutPage(browser, { phone: true })
    await g.goto(link)
    await expect(g.getByTestId('get-app')).toHaveAttribute('data-guest', 'true')
    const web = g.getByTestId('get-app-web')
    await expect(web).toHaveText(ko('auth.continueInBrowser'))
    await expect(web).toHaveClass(/bg-accent/)
    await expect(g.getByTestId('get-app-store')).not.toHaveClass(/bg-accent/)
    // the browser button comes first
    expect((await web.boundingBox())!.y).toBeLessThan((await g.getByTestId('get-app-store').boundingBox())!.y)
    await shot(g, 's9-phone-invite-390-light-ko')
    await web.click()
    await expect(g.getByTestId('join-form')).toBeVisible()
    await ctx.close()
  })

  test('S10: a guest page follows the browser language, and the switcher still changes it', async ({ page, browser }) => {
    await start(page)
    await signIn(page)
    const link = await guestLink(page)
    const { ctx, page: g } = await signedOutPage(browser, { locale: 'en-US' })
    await g.goto(link)
    await expect(g.getByRole('heading', { level: 1 })).toContainText('invited you')
    await expect(g.getByTestId('invite-guest-place')).toContainText("You'll join only the '견적 준비' group chat")
    await g.getByTestId('auth-locale').selectOption('ko')
    await expect(g.getByTestId('invite-guest-place')).toContainText("'견적 준비' 그룹 대화에만 들어가요")
    await ctx.close()
    // a member invite stays in the team's language (with its offer line)
    const member = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
    const m = await signedOutPage(browser, { locale: 'en-US' })
    await m.page.goto(`/invite/${member.token}`)
    await expect(m.page.getByTestId('invite-browser-language')).toBeVisible()
    await m.ctx.close()
  })
})

test.describe('a guest whose account ended', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('S5: a guest who left is told they left', async ({ page }) => {
    await guestIn(page, { kind: 'room', id: GROUP })
    await page.route('**/api/me', (r) => r.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'Please sign in.', params: { reason: 'account_removed', guest: 'left', team: 'Acme' } } } }))
    expect((await page.request.post('/__test/publish', { data: { event: { type: 'session.ended', data: { reason: 'disabled' } } } })).ok()).toBeTruthy()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ko('auth.guestLeftTitle', { team: 'Acme' }))
    await expect(page.getByTestId('login-removed')).toHaveText(ko('auth.guestLeft'))
    await shot(page, 's5-left-1440-light-ko')
    // a later visit from this browser still says they left
    await page.reload()
    await expect(page.getByTestId('login-removed')).toHaveAttribute('data-left', 'true')
  })

  test('S6: a guest taken out while away sees why as soon as the app opens, before any password', async ({ browser }) => {
    const { ctx, page } = await signedOutPage(browser)
    await page.route('**/api/me', (r) => r.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'Please sign in.', params: { reason: 'account_removed', guest: 'removed', team: 'Acme' } } } }))
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ko('auth.guestRemovedTitle', { team: 'Acme' }))
    await expect(page.getByTestId('login-removed')).toHaveText(ko('auth.guestRemoved'))
    await ctx.close()
  })
})
