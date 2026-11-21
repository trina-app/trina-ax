// Settings › Notifications › "File sharing" (docs/decisions/20261116-file-share-push-gaps.md): one switch, on by default,
// for the push of a file shared with me by name and of a request to open my file. Turning it off saves fileShares=false
// and stays off after a reload; the words in English and Korean; at 1440 and 390 the row and its caption fit (light and
// dark pictures with SHOTS=1). A phone notification's tap on a request opens /activity/<notice id>, which opens that
// notice by itself.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { en } from '../../src/i18n/en'
import { ko } from '../../src/i18n/ko'

const SIZES = [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const
const dir = process.env.SHOTS_DIR ?? 'test-results/file-share-push-setting'

for (const [name, viewport, mobile] of SIZES) {
  test(`${name}: "File sharing" is on by default, turns off, and stays off after a reload`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport, locale: 'en-US', ...(mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) })
    const page = await ctx.newPage()
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const patches: Record<string, unknown>[] = []
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith('/api/notification-preferences')) patches.push(r.postDataJSON()) })
    await page.goto('/settings/notifications')
    const pane = page.getByTestId('notifications')
    const pref = pane.getByTestId('notification-pref-fileShares')
    await expect(pref).toBeChecked()
    await expect(pane).toContainText(en['notifications.fileShares'])
    await expect(pane).toContainText(en['notifications.fileSharesDesc'])
    // the row sits right under "Chats shared with me"
    const chats = await pane.getByTestId('notification-pref-chatShares').boundingBox()
    const mine = (await pref.boundingBox())!
    expect(chats && chats.y < mine.y).toBe(true)
    // nothing runs off the page at this width
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await pref.scrollIntoViewIfNeeded()
    if (process.env.SHOTS) for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/file-sharing-${name}-${scheme}.png` })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await pref.uncheck({ force: true })
    await expect(pref).not.toBeChecked()
    await expect.poll(() => patches.length).toBe(1)
    expect(patches[0]).toEqual({ fileShares: false })
    await page.reload()
    await expect(page.getByTestId('notifications').getByTestId('notification-pref-fileShares')).not.toBeChecked()
    await ctx.close()
  })
}

test('Korean: "파일 공유" with its caption', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings/notifications')
  const pane = page.getByTestId('notifications')
  await expect(pane.getByTestId('notification-pref-fileShares')).toBeChecked()
  await expect(pane).toContainText(ko['notifications.fileShares'])
  await expect(pane).toContainText(ko['notifications.fileSharesDesc'])
})

test('a request notification\'s tap: /activity/<notice id> opens that notice by itself', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/activity/notice-from-push')
  await expect(page).toHaveURL(/\/activity\?n=notice-from-push$/)
})
