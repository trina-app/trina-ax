// Google sign-in words and apps that cannot be connected yet in Settings › Connectors (QA TC-2957, TC-2958, TC-2979,
// TC-2932, TC-3034): the "unverified app" line before Google opens only with Trina's shared Google app (components/integrations/
// GoogleUnverifiedNote.tsx), "cancelled" for a sign-in cancelled at Google (lib/googleApps.ts signInFailedKey), a Google
// app Google has not approved yet still in Discover and search with its short line, and a member whose team turned own
// connections off: the line always, and a listed service found by search with "Ask admin to add it".
// (A member's page has unrelated 404s in the mock, /api/demo and a file tree, so no console check here.)
// Screenshots: SHOTS=<dir> writes them at 1440 and 390 (en and ko).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
const control = (page: Page, path: string, body: object) => page.request.post(path, { data: body })
const card = (page: Page, id: string) => page.locator(`[data-testid="connector-card"][data-id="${id}"]`)
const expiresAt = '2099-01-01T00:00:00.000Z'
const SHOTS = process.env.SHOTS

async function shoot(page: Page, name: string) {
  if (!SHOTS) return
  for (const w of [1440, 390]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 })
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${SHOTS}/${name}-${w}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}
async function lang(page: Page, l: 'ko' | 'en') {
  expect((await page.request.patch('/api/me', { headers: { [CSRF_HEADER]: '1' }, data: { locale: l } })).ok()).toBeTruthy()
  await page.reload()
}

test('Trina\'s shared Google app: one line before Google opens; a company\'s own app: none (QA TC-2957)', async ({ page }) => {
  await reset(page)
  await control(page, '/__test/google-own-app', { hosted: true })
  await signIn(page, BOB)
  await page.goto('/connectors/gmail')
  const gmail = page.getByTestId('gapp-detail')
  await expect(gmail.getByTestId('gapp-connect')).toBeEnabled()
  await expect(gmail.getByTestId('google-unverified')).toContainText('고급')
  await page.goto('/connectors/google-drive')
  await expect(page.getByTestId('drive-detail').getByTestId('google-unverified')).toBeVisible()
  await shoot(page, 'TC-2957-drive-ko')
  await page.goto('/connectors/gmail')
  await shoot(page, 'TC-2957-gmail-ko')
  await lang(page, 'en')
  await expect(gmail.getByTestId('google-unverified')).toHaveText('Google may say “Google hasn\'t verified this app”. Press Advanced, then “Go to Trina AX”.')
  await shoot(page, 'TC-2957-gmail-en')
  // the company's own Google app signs in instead: no line
  await control(page, '/__test/google-own-app', { hosted: true, active: true })
  await page.reload()
  await expect(gmail.getByTestId('gapp-connect')).toBeVisible()
  await expect(page.getByTestId('google-unverified')).toHaveCount(0)
  await page.goto('/connectors/google-drive')
  await expect(page.getByTestId('drive-detail')).toBeVisible()
  await expect(page.getByTestId('google-unverified')).toHaveCount(0)
})

test('cancelled at Google: the page says it was cancelled and shows Connect again (QA TC-2979)', async ({ page }) => {
  await reset(page)
  await control(page, '/__test/google-apps', { client: 'app' })
  await page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
  await page.route('**/api/integrations/google-apps/gmail/flows/**', (r) => r.request().method() === 'DELETE'
    ? r.fulfill({ status: 204 })
    : r.fulfill({ json: { flowId: 'fixture-flow', state: 'failed', account: null, expiresAt, reason: 'consent_denied' } }))
  await signIn(page)
  await page.goto('/connectors/gmail')
  const gmail = page.getByTestId('gapp-detail')
  const popup = page.waitForEvent('popup')
  await gmail.getByTestId('gapp-connect').click()
  await popup
  await expect(gmail.getByTestId('gapp-error')).toHaveText('Google 로그인을 취소해서 연결하지 않았어요. 다시 하려면 연결을 누르세요.')
  await expect(gmail.getByTestId('gapp-connect')).toBeVisible()
  await shoot(page, 'TC-2979-gmail-cancelled-ko')
  await lang(page, 'en')
  await gmail.getByTestId('gapp-connect').click()
  await expect(gmail.getByTestId('gapp-error')).toHaveText('Google sign-in was cancelled, so nothing was connected. Press Connect to try again.')
  await shoot(page, 'TC-2979-gmail-cancelled-en')
})

test('a Google app Google has not approved yet stays in Discover and search with its short line (QA TC-2958)', async ({ page }) => {
  await reset(page)
  await control(page, '/__test/google-apps', { client: 'app' })
  await control(page, '/__test/google-apps', { app: 'gmail', reason: 'service_limited' })
  await control(page, '/__test/google-apps', { app: 'docs', reason: 'unsupported' })
  await signIn(page, BOB)
  await page.goto('/connectors')
  await expect(card(page, 'gmail').getByTestId('connector-off')).toHaveText('아직 사용할 수 없음')
  await expect(card(page, 'docs').getByTestId('connector-off')).toHaveText('이 팀 서버에서는 아직 못 써요')
  await expect(card(page, 'gmail').getByTestId('connector-add')).toHaveCount(0)
  await expect(card(page, 'calendar').getByTestId('connector-add')).toBeVisible()
  await shoot(page, 'TC-2958-discover-ko')
  await page.getByTestId('connector-search').fill('gmail')
  await expect(card(page, 'gmail')).toBeVisible()
  await expect(page.getByText('"gmail"에 맞는 항목이 없어요.')).toHaveCount(0)
  await shoot(page, 'TC-2958-search-ko')
  // its page says why
  await card(page, 'gmail').getByTestId('connector-open').click()
  await expect(page.getByTestId('gapp-unavailable')).toHaveAttribute('data-reason', 'service_limited')
  await lang(page, 'en')
  await page.goto('/connectors')
  await expect(card(page, 'gmail').getByTestId('connector-off')).toHaveText('Not available yet')
  await page.getByTestId('connector-search').fill('gmail')
  await shoot(page, 'TC-2958-search-en')
})

test('own connections off: a member is told so, and a listed service found by search offers Ask admin (QA TC-2932)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  expect((await page.request.patch('/api/admin/settings', { headers: { [CSRF_HEADER]: '1' }, data: { personalIntegrations: false } })).ok()).toBeTruthy()
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/connectors')
  await expect(page.getByTestId('integrations-personal-off')).toContainText('팀에서 개인 연결을 꺼 두었어요')
  // not in Discover without a search
  await expect(card(page, 'notion')).toHaveCount(0)
  await shoot(page, 'TC-2932-list-ko')
  await page.getByTestId('connector-search').fill('Notion')
  await expect(card(page, 'notion').getByTestId('connector-off')).toHaveText('관리자에게 추가 요청하기')
  await expect(card(page, 'notion').getByTestId('connector-add')).toHaveCount(0)
  await expect(page.getByText('"Notion"에 맞는 항목이 없어요.')).toHaveCount(0)
  await expect(page.getByTestId('connector-not-listed')).toBeVisible()
  await shoot(page, 'TC-2932-search-ko')
  // its page asks the admins
  await card(page, 'notion').getByTestId('connector-open').click()
  await expect(page).toHaveURL(/\/connectors\/notion$/)
  await page.getByRole('button', { name: '관리자에게 추가 요청하기' }).first().click()
  await page.goto('/connectors')
  await page.getByTestId('connector-search').fill('Notion')
  await expect(card(page, 'notion').getByTestId('connector-off')).toHaveText('요청 보냄')
  // a search that matches nothing still says where to go next
  await page.getByTestId('connector-search').fill('nothing-like-this')
  await expect(page.getByTestId('connector-ask-admin')).toBeVisible()
  await lang(page, 'en')
  await page.getByTestId('connector-search').fill('Notion')
  await expect(page.getByTestId('integrations-personal-off')).toBeVisible()
  await shoot(page, 'TC-2932-search-en')
})

test('20 sign-ins started in an hour: the page says to try again in about an hour (QA TC-3034)', async ({ page }) => {
  await reset(page)
  await control(page, '/__test/google-apps', { client: 'app' })
  await page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
  // the server's answer at its limit (server/src/routes/google-apps.ts safe(): the reason code in the message)
  await page.route('**/api/integrations/google-apps/gmail/authorize', (r) => r.fulfill({ status: 429, json: { error: { code: 'rate_limited', message: 'google_app_rate_limited', params: { reason: 'rate_limited' } } } }))
  await signIn(page)
  await page.goto('/connectors/gmail')
  const gmail = page.getByTestId('gapp-detail')
  await gmail.getByTestId('gapp-connect').click()
  await expect(gmail.getByTestId('gapp-error')).toHaveText('로그인을 너무 많이 시작했어요. 1시간쯤 뒤에 다시 해 주세요.')
  await shoot(page, 'TC-3034-gmail-limit-ko')
  await lang(page, 'en')
  await gmail.getByTestId('gapp-connect').click()
  await expect(gmail.getByTestId('gapp-error')).toHaveText('Too many sign-ins were started. Try again in about an hour.')
  await shoot(page, 'TC-3034-gmail-limit-en')
})
