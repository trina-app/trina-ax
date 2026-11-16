// "Ask for access" on a chat's or a project's link (QA TC-4185, TC-4186; docs/decisions/
// 20261116-chat-project-ask-access.md): a teammate the link does not open for gets "You need access", a note and Ask for
// access, which then reads Requested (back later: the date it was asked), never the title or anyone in it; the owner's
// Activity row has Share (a project: Add) and Decline; a chat's first share asks first; after Share the link opens;
// Decline tells the asker nothing about it; where no ask is possible, one plain line without a button or a reason. SHOT_DIR keeps
// screenshots of every surface at 1440 and 390, light and dark.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { reset, signIn } from './helpers'

const SHOTS = process.env.SHOT_DIR
const t = DICTS.en
const tr = (key: keyof typeof t, params: Record<string, string | number> = {}) => translate('en', key, params)
const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const TITLE = 'Q3 budget questions'

/** every surface at 1440 and 390, light and dark (only with SHOT_DIR) */
async function shots(page: Page, name: string, o: { computer?: () => Promise<void> } = {}) {
  if (!SHOTS) return
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h })
    if (w === 1440) await o.computer?.()
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${SHOTS}/${name}-${w}-${theme}.png` })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
}
async function windowOf(browser: Browser, page: Page, who: { username: string; password: string }) {
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'en-US', viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await signIn(p, who)
  return p
}
async function chatOf(page: Page, title: string, body: Record<string, unknown> = {}) {
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: body })).json()) as { id: string }
  expect((await page.request.patch(`/api/chats/${chat.id}`, { headers: H, data: { title } })).ok()).toBeTruthy()
  return chat.id
}
const noSideScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test('chat: Bob asks with a note, the button reads Requested; Olga shares from Activity after the check; the link opens for Bob', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const chatId = await chatOf(page, TITLE)

  const bob = await windowOf(browser, page, BOB)
  await bob.goto(`/c/${chatId}`)
  const card = bob.getByTestId('link-access-ask')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-kind', 'chat')
  // nothing of the chat: no title, no name
  const text = `${await bob.title()} ${await card.innerText()}`
  for (const leak of [TITLE, 'Olga']) expect(text).not.toContain(leak)
  await expect(card).toContainText(t['linkAccess.chatBody'])
  expect(await noSideScroll(bob)).toBe(true)
  await shots(bob, 'chat-ask')
  await bob.getByTestId('link-access-note').fill('For the Monday review, please.')
  await bob.getByTestId('link-access-ask-button').click()
  await expect(bob.getByTestId('link-access-ask-button')).toHaveText(t['linkAccess.requested'])
  await expect(bob.getByTestId('link-access-ask-button')).toBeDisabled()
  await expect(bob.getByTestId('link-access-sent')).toHaveText(t['linkAccess.sent'])
  await shots(bob, 'chat-requested')
  // back later: when it was asked, still Requested
  await bob.reload()
  await expect(bob.getByTestId('link-access-waiting')).toBeVisible()
  await expect(bob.getByTestId('link-access-ask-button')).toHaveText(t['linkAccess.requested'])

  // Olga: the request in Activity, with the note, Share and Decline
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/activity')
  const req = page.getByTestId('notification-item').filter({ hasText: tr('notifications.event.access.requestedChat', { by: 'Bob', name: TITLE }) })
  await expect(req.getByTestId('access-request-note')).toContainText('For the Monday review, please.')
  await expect(req.getByTestId('access-request-share')).toHaveText(t['accessRequest.share'])
  await shots(page, 'activity-chat-request', { computer: () => page.getByTestId('activity-panel-row').first().click() })
  await page.setViewportSize({ width: 390, height: 844 })
  // a first share: the check first, then shared
  await req.getByTestId('access-request-share').click()
  await expect(page.getByTestId('dialog-confirm')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText(tr('accessRequest.confirmTitle', { by: 'Bob' }))
  await shots(page, 'activity-chat-confirm')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('dialog-confirm').click()
  await expect(req.getByTestId('access-request-done')).toHaveText(tr('accessRequest.sharedChat', { by: 'Bob' }))
  await expect(req.getByTestId('access-request-share')).toHaveCount(0)
  await shots(page, 'activity-chat-shared', { computer: () => page.getByTestId('activity-panel-row').first().click() })

  // Bob: the link opens now
  await bob.goto(`/c/${chatId}`)
  await expect(bob.getByTestId('link-access-page')).toHaveCount(0)
  await expect(bob.getByTestId('chat-not-found')).toHaveCount(0)
  await bob.context().close()
})

test('chat: Decline; Bob hears it without the chat\'s name and may ask again', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const chatId = await chatOf(page, TITLE)
  const bob = await windowOf(browser, page, BOB)
  await bob.goto(`/c/${chatId}`)
  await bob.getByTestId('link-access-ask-button').click()
  await expect(bob.getByTestId('link-access-sent')).toBeVisible()

  await page.goto('/activity')
  await page.getByTestId('activity-panel-row').filter({ hasText: TITLE }).click()
  const req = page.getByTestId('notification-item').filter({ hasText: TITLE })
  await req.getByTestId('access-request-decline').click()
  await expect(req.getByTestId('access-request-done')).toHaveText(t['accessRequest.declined'])

  await bob.goto('/activity')
  const notice = bob.getByTestId('activity-panel-row').filter({ hasText: t['notifications.event.access.answered'] })
  await expect(notice).toHaveCount(1)
  await expect(notice).not.toContainText(TITLE)
  await shots(bob, 'activity-declined', { computer: () => bob.getByTestId('activity-panel-row').first().click() })
  await bob.goto(`/c/${chatId}`)
  await expect(bob.getByTestId('link-access-ask-button')).toHaveText(t['linkAccess.ask'])
  await bob.context().close()
})

test('project: Bob asks to join; Olga adds him from Activity; the project opens for him', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const r = await page.request.post('/__test/project', { data: { name: 'Launch plan', by: 'olga', participants: [] } })
  const { id } = (await r.json()) as { id: string }

  const bob = await windowOf(browser, page, BOB)
  await bob.goto(`/projects/${id}`)
  const card = bob.getByTestId('link-access-ask')
  await expect(card).toHaveAttribute('data-kind', 'project')
  for (const leak of ['Launch plan', 'Olga']) expect(`${await bob.title()} ${await card.innerText()}`).not.toContain(leak)
  await expect(card).toContainText(t['linkAccess.projectBody'])
  await shots(bob, 'project-ask')
  await bob.getByTestId('link-access-ask-button').click()
  await expect(bob.getByTestId('link-access-ask-button')).toHaveText(t['linkAccess.requested'])
  await shots(bob, 'project-requested')

  await page.goto('/activity')
  await page.getByTestId('activity-panel-row').filter({ hasText: 'Launch plan' }).click()
  const req = page.getByTestId('notification-item').filter({ hasText: tr('notifications.event.access.requestedProject', { by: 'Bob', name: 'Launch plan' }) })
  await expect(req.getByTestId('access-request-share')).toHaveText(t['accessRequest.add'])
  await shots(page, 'activity-project-request', { computer: () => page.getByTestId('activity-panel-row').first().click() })
  await page.goto('/activity')
  await page.getByTestId('activity-panel-row').filter({ hasText: 'Launch plan' }).click()
  await req.getByTestId('access-request-share').click()
  await expect(req.getByTestId('access-request-done')).toHaveText(tr('accessRequest.addedProject', { by: 'Bob' }))

  // Bob: told, with the project's name and a link; the page opens
  await bob.goto('/activity')
  await expect(bob.getByTestId('activity-panel-row').filter({ hasText: tr('notifications.event.access.addedToProject', { name: 'Launch plan' }) })).toHaveCount(1)
  await bob.goto(`/projects/${id}`)
  await expect(bob.getByTestId('link-access-page')).toHaveCount(0)
  await expect(bob.getByTestId('project-missing')).toHaveCount(0)
  await bob.context().close()
})

test('no ask possible: one plain line, the same for a chat and a project, no button, no reason; an address that was never a chat keeps the plain page', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const r = await page.request.post('/__test/project', { data: { name: 'Diary', by: 'olga', personal: true } })
  const { id } = (await r.json()) as { id: string }
  const chatId = await chatOf(page, 'Private thoughts', { projectId: id })
  const bob = await windowOf(browser, page, BOB)
  await bob.goto(`/c/${chatId}`)
  await expect(bob.getByTestId('link-access-cant-ask-line')).toHaveText(t['linkAccess.cantAsk'])
  await expect(bob.getByTestId('link-access-ask-button')).toHaveCount(0)
  const words = await bob.getByTestId('link-access-cant-ask').innerText()
  for (const leak of ['Private thoughts', 'Diary', 'Olga', 'personal', 'shared']) expect(words).not.toContain(leak)
  await shots(bob, 'cant-ask')
  await bob.goto(`/c/${uuidv7()}`)
  await expect(bob.getByTestId('chat-not-found')).toBeVisible()
  await bob.goto(`/projects/${id}`)
  await expect(bob.getByTestId('link-access-cant-ask-line')).toHaveText(t['linkAccess.cantAsk'])
  expect(await bob.getByTestId('link-access-cant-ask').innerText()).toBe(words)
  await bob.context().close()
})
