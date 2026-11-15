// Screenshots for QA TC-3082 (feat/old-files-key-scan), 1440 and 390 wide, light, for reviewing by eye: the Activity
// row "N files the AI made for you have a saved key of a connected service in them", with the files under it to open.
// The mock server's notifications answer is replaced with fake rows (page.route). Only when KEY_FILES_SHOTS names a
// folder to write them to.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const dir = process.env.KEY_FILES_SHOTS
test.skip(!dir, 'KEY_FILES_SHOTS is not set')
test.use({ locale: 'en-US' })

const MEMBER = { username: 'bob', password: 'bob password 1' }
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const notice = (n: number, code: string, minutes: number, o: Record<string, unknown>) => ({ id: `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`, eventType: code, sourceId: `src-${n}`, code, createdAt: ago(minutes), readAt: null, chatId: null, link: null, outcome: null, ...o })

async function fakeRows(page: Page, me: string) {
  const items = [
    notice(1, 'files.stored_key', 2, { sourceId: 'scan', keyFiles: { n: 3, files: [
      { path: `users/${me}/API setup notes.md` }, { path: `users/${me}/reports/Q3 vendor report.docx` }, { path: 'shared/sales/Partner onboarding checklist.pdf' },
    ] } }),
    notice(2, 'service.closed', 40, { serviceRequest: { service: 'notion', closed: 'dismissed' } }),
  ]
  await page.route('**/api/notifications?*', (route) => {
    const only = new URL(route.request().url()).searchParams.get('only')
    return route.fulfill({ json: { items: only === 'rooms' ? [] : items, nextCursor: null, unreadCount: items.length, roomUnreadCount: 0, noticeUnreadCount: items.length } })
  })
  // a computer opens a notice without a link of its own beside the list (pages/Activity.tsx ActivityOpened)
  await page.route(/\/api\/notifications\/[0-9a-f-]+(\/read)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    const item = items.find((x) => x.id === id)
    if (!item) return route.fallback()
    return route.fulfill({ json: route.request().method() === 'POST' ? { ...item, readAt: new Date().toISOString() } : item })
  })
}

for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  for (const lang of ['en', 'ko'] as const) {
    test(`key files notice screenshot (${vp.name}, ${lang})`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize(vp.size)
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await reset(page, { teamLocale: lang, usersFollowTeam: true })
      await signIn(page, MEMBER)
      const me = await page.evaluate(async () => (await (await fetch('/api/me')).json()).user.id as string)
      await fakeRows(page, me)
      await page.goto('/activity')
      // a computer: the row in the list beside opens it in the main area, with its files
      if (vp.name === '1440') await page.getByText(lang === 'ko' ? /AI가 만든 파일 3개/ : /3 files the AI made/).first().click()
      await expect(page.getByTestId('notification-key-files')).toBeVisible()
      await expect(page.getByTestId('notification-key-file')).toHaveCount(3)
      await page.screenshot({ path: `${dir}/key-files-notice-${vp.name}-${lang}.png` })
    })
  }
}
