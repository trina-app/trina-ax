// TEMPORARY (not committed): before/after screenshots of Home and the project screens.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const DIR = process.env.SHOTS_DIR ?? 'test-results/zz-shots'
const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const TEAM = ['회의록을 요약해 줘', '주간 보고서 초안 써 줘', '고객 메일 답장 써 줘', '발표 자료 목차 만들어 줘', '영어로 번역해 줘']
async function call(page: Page, method: 'POST' | 'PATCH' | 'PUT', path: string, data: unknown = {}) {
  const r = await page.request.fetch(path, { method, headers: H, data })
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}
const shot = (page: Page, name: string, full = false) => page.waitForTimeout(500).then(() => page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full }))

for (const w of [1440, 390]) {
  test.describe(`${w}`, () => {
    test.use(w === 390 ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } })
    test('home and projects', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const team = await call(page, 'POST', '/api/onboarding/welcome/team')
      await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
      const group = team.progress.teamGroup as { id: string }
      await call(page, 'PATCH', `/api/admin/groups/${group.id}`, { memberIds: ['olga', 'bob'] })
      await call(page, 'POST', '/api/onboarding/packs/general/install', { skills: ['intro-deck', 'card-news', 'promo-video'] })
      await call(page, 'POST', '/api/onboarding/packs/work/install', { skills: ['humanizer'] })
      for (const name of ['견적서.md', '2026/매출.csv']) await call(page, 'POST', '/__test/file', { path: `shared/회사 자료/${name}`, text: 'x' })
      await page.goto('/')
      await expect(page.getByTestId('composer-input')).toBeVisible()
      await shot(page, `${w}-owner-home`)
      // projects
      const r = await page.request.post('/api/projects', { headers: H, data: { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '# Launch\n\nAnswer in **short** bullet points.' } })
      const id = ((await r.json()) as { id: string }).id
      for (const title of ['Weekly numbers', 'Launch plan review']) await page.request.post('/api/chats', { headers: H, data: { projectId: id, title } })
      for (const name of ['plan.md', 'sub/notes.md']) await call(page, 'POST', '/__test/file', { path: `marketing/${name}`, text: 'x' })
      await page.goto('/projects')
      await expect(page.getByTestId('project-card').first()).toBeVisible()
      await shot(page, `${w}-projects`)
      await page.goto(`/projects/${id}`)
      await expect(page.getByTestId('project-chats').getByRole('link')).toHaveCount(2)
      await shot(page, `${w}-project`)
      await shot(page, `${w}-project-full`, true)
      if (w === 390) {
        await page.getByTestId('project-files-open').click()
        await expect(page.getByTestId('project-file').first()).toBeVisible()
        await shot(page, `${w}-project-files`)
        await page.getByTestId('project-menu').count()
        await page.goBack()
        await page.getByTestId('project-menu').click()
        await shot(page, `${w}-project-menu`)
        await page.keyboard.press('Escape')
        await page.goto('/projects')
        await page.getByTestId('project-new').click()
        await shot(page, `${w}-project-form`)
        await page.keyboard.press('Escape')
      }
      await page.context().clearCookies()
      // bob: prepared
      await signIn(page, BOB)
      await expect(page.getByTestId('team-prepared')).toBeVisible()
      await shot(page, `${w}-bob-prepared`)
      // bob with chats: often asked
      await page.request.post('/__test/often-asked', { data: { team: TEAM } })
      for (const title of ['a', 'b', 'c', 'd', 'e']) await page.request.post('/api/chats', { headers: H, data: { title } })
      await page.goto('/')
      await expect(page.getByTestId('often-asked')).toBeVisible()
      await shot(page, `${w}-bob-often`)
      await shot(page, `${w}-bob-often-full`, true)
    })
  })
}
