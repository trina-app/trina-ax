// "문제 신고" (docs/decisions/20261126-problem-reports.md): Settings › About's button and 👎 under an answer open the same
// sheet; Send posts the words (and from 👎 the answer, with the tick its question and answer) and says "받았어요". At 1440
// and 390 px. The mock server stands in for a server that can send reports (Me.team/server.problemReports).
import { expect, test, type Page } from '@playwright/test'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

async function reportsOn(page: Page, where: 'hosted' | 'self') {
  const sent: any[] = []
  await page.route('**/api/me', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const r = await route.fetch()
    const me = await r.json()
    await route.fulfill({ response: r, json: { ...me, team: { ...me.team, problemReports: true }, server: { ...me.server, problemReports: where } } })
  })
  await page.route('**/api/problem-reports', async (route) => {
    sent.push(route.request().postDataJSON())
    await route.fulfill({ status: 202, json: { id: '0190a000-0000-7000-8000-000000000001' } })
  })
  return sent
}

for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`at ${size.width}px`, () => {
    test.use({ viewport: size })

    test('Settings › About: "문제 신고" → one box, who reads it, Send → 받았어요', async ({ page }) => {
      await reset(page)
      const errors = watchConsole(page)
      const sent = await reportsOn(page, 'self')
      await signIn(page, OWNER)
      await page.goto('/settings/about')
      await page.getByTestId('about-problem-report-open').click()
      const sheet = page.getByTestId('problem-report-sheet')
      await expect(sheet).toBeVisible()
      // who reads it, and on a self-installed server that it leaves the server; no tick outside 👎
      await expect(page.getByTestId('problem-report-who')).toContainText(/포텐랩|Potenlab/)
      await expect(page.getByTestId('problem-report-who')).toContainText(/서버 밖|leaves this server/)
      await expect(page.getByTestId('problem-report-attach')).toHaveCount(0)
      await expect(page.getByTestId('problem-report-send')).toBeDisabled()
      await page.getByTestId('problem-report-text').fill('파일 목록이 안 떠요')
      await page.screenshot({ path: `test-results/problem-report-about-${size.width}.png` })
      await page.getByTestId('problem-report-send').click()
      await expect(sheet).toHaveCount(0)
      await expect(page.getByText(/받았어요|Got it/)).toBeVisible()
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ text: '파일 목록이 안 떠요', screen: 'settings' })
      expect(sent[0].answer).toBeUndefined()
      expect(Object.keys(sent[0].client).sort()).toEqual(['kind', 'os', 'version'])
      expect(realErrors(errors)).toEqual([])
    })

    test('👎 under an answer: the tick previews my question and the answer and sends them', async ({ page }) => {
      await reset(page)
      const errors = watchConsole(page)
      const sent = await reportsOn(page, 'hosted')
      await signIn(page, OWNER)
      // the sign-in answer carries Me itself: read it again through the mock above
      await page.reload()
      await expect(page.getByTestId('composer-input')).toBeVisible()
      await page.getByTestId('composer-input').fill('주간 보고서 써 줘')
      await page.getByTestId('send').click()
      const answer = page.getByTestId('assistant-message').last()
      await expect(answer).toHaveAttribute('data-status', 'done')
      await answer.hover()
      await answer.getByTestId('report-answer').click()
      await expect(page.getByTestId('problem-report-sheet')).toBeVisible()
      // a hosted team: only who reads it
      await expect(page.getByTestId('problem-report-who')).not.toContainText(/서버 밖|leaves this server/)
      await page.getByTestId('problem-report-attach').check()
      await expect(page.getByTestId('problem-report-preview')).toContainText('주간 보고서 써 줘')
      await page.getByTestId('problem-report-text').fill('답이 틀렸어요')
      await page.screenshot({ path: `test-results/problem-report-answer-${size.width}.png` })
      await page.getByTestId('problem-report-send').click()
      await expect(page.getByText(/받았어요|Got it/)).toBeVisible()
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ text: '답이 틀렸어요', screen: 'chat', answer: { withConversation: true } })
      expect(typeof sent[0].answer.messageId).toBe('string')
      expect(realErrors(errors)).toEqual([])
    })
  })
}

test('no entry points where the server sends no reports', async ({ page }) => {
  await reset(page)
  await signIn(page, OWNER)
  await page.goto('/settings/about')
  await expect(page.getByTestId('about-version')).toBeVisible()
  await expect(page.getByTestId('about-problem-report-open')).toHaveCount(0)
})
