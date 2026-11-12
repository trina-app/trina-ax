// Home: what my group often asks (docs/DECISIONS.md "Home: what my group often asks"): under the box a small heading and
// 3 plain lines, no frame and no counts; Show more opens up to 10 in place; a line fills the box and sends nothing. No
// skills card and no "My frequent questions" any more. A group's list goes to its members (the heading names the group),
// the team's to the others; under 3 items nothing shows. Admin › Team settings turns it off for everyone.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const TEAM = ['회의록을 요약해 줘', '주간 보고서 초안 써 줘', '고객 메일 답장 써 줘', '발표 자료 목차 만들어 줘', '영어로 번역해 줘']

const setLists = (page: Page, data: { team?: string[]; groups?: Record<string, string[]> }) => page.request.post('/__test/often-asked', { data })
const list = (page: Page) => page.getByTestId('often-asked')
/** someone with a chat: "팀에 준비된 것" (the newcomer block, which goes first) has nothing for them, so the list shows */
async function withAChat(page: Page) {
  expect((await page.request.post('/api/chats', { headers: H, data: { title: 'Earlier chat' } })).ok()).toBeTruthy()
  await page.goto('/')
  await expect(page.getByTestId('composer-input')).toBeVisible()
}

async function asBob(browser: Browser, width = 1440): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width, height: width < 768 ? 844 : 900 }, serviceWorkers: 'block' })
  const b = await ctx.newPage()
  await signIn(b, BOB)
  await withAChat(b)
  return b
}

test('three lines under the box, Show more opens the rest, a line fills the box and sends nothing', async ({ page }) => {
  await reset(page)
  let sent = 0
  page.on('request', (r) => { if (r.method() === 'POST' && /\/messages$/.test(new URL(r.url()).pathname)) sent++ })
  await setLists(page, { team: TEAM })
  await signIn(page)
  await withAChat(page)
  await expect(list(page)).toBeVisible()
  await expect(list(page).getByRole('heading')).toHaveText('우리 팀에서 자주 묻는 질문')
  await expect(list(page).getByTestId('often-asked-item')).toHaveCount(3)
  // no card: no frame around it, no counts, and the two old sections are gone
  await expect(list(page)).not.toHaveClass(/border/)
  await expect(list(page)).not.toContainText(/\d/)
  await expect(page.getByTestId('popular-skills')).toHaveCount(0)
  await expect(page.getByTestId('frequent-questions')).toHaveCount(0)
  const more = list(page).getByTestId('often-asked-more')
  await expect(more).toHaveText('더 보기')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await more.click()
  await expect(list(page).getByTestId('often-asked-item')).toHaveCount(5)
  await expect(more).toHaveText('접기')
  await list(page).getByTestId('often-asked-item').nth(3).click()
  const input = page.getByTestId('composer-input')
  await expect(input).toHaveValue('발표 자료 목차 만들어 줘')
  await expect(input).toBeFocused()
  await page.waitForTimeout(300)
  expect(sent).toBe(0)
  await expect(page.getByTestId('assistant-message')).toHaveCount(0)
})

test('a group\'s list for its members, named in the heading; the team\'s for the others; under 3 items nothing', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const g = await page.request.post('/api/admin/groups', { headers: H, data: { name: '영업', memberIds: ['bob'] } })
  const gid = ((await g.json()) as { id: string }).id
  expect((await page.request.patch('/api/admin/users/bob', { headers: H, data: { groupIds: [gid] } })).ok()).toBeTruthy()
  await setLists(page, { team: TEAM, groups: { [gid]: ['견적서 양식 채워 줘', '거래처 메일 답장 써 줘', '영업 보고서 정리해 줘'] } })
  const b = await asBob(browser)
  await expect(list(b).getByRole('heading')).toHaveText('영업에서 자주 묻는 질문')
  await expect(list(b).getByTestId('often-asked-item').first()).toHaveText('견적서 양식 채워 줘')
  await expect(list(b).getByTestId('often-asked-more')).toHaveCount(0)
  await b.context().close()
  // the owner is in no group: the team's list
  await withAChat(page)
  await expect(list(page).getByRole('heading')).toHaveText('우리 팀에서 자주 묻는 질문')
  // too little data: nothing at all, not even the heading
  await setLists(page, { team: TEAM.slice(0, 2) })
  await page.reload()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await page.waitForTimeout(300)
  await expect(list(page)).toHaveCount(0)
})

test('Admin › Team settings turns it off for everyone', async ({ page, browser }) => {
  await reset(page)
  await setLists(page, { team: TEAM })
  await signIn(page)
  await withAChat(page)
  await expect(list(page)).toBeVisible()
  await page.goto('/admin/settings')
  const row = page.getByTestId('team-often-asked')
  await expect(row).toHaveAttribute('data-on', 'true')
  await expect(page.getByText('팀이 자주 묻는 질문 보여 주기')).toBeVisible()
  await row.locator('label').first().click()
  await page.getByTestId('team-settings-savebar').getByRole('button', { name: '저장' }).click()
  await expect(page.getByTestId('team-settings-savebar')).toHaveCount(0)
  await expect(row).toHaveAttribute('data-on', 'false')
  const b = await asBob(browser)
  await expect(b.getByTestId('composer-input')).toBeVisible()
  await b.waitForTimeout(300)
  await expect(list(b)).toHaveCount(0)
  await b.context().close()
})

test('phones: the lines are 44px rows under the box, no frame', async ({ browser, page }) => {
  await reset(page)
  await setLists(page, { team: TEAM })
  const b = await asBob(browser, 390)
  await expect(list(b)).toBeVisible()
  const first = list(b).getByTestId('often-asked-item').first()
  const box = (await first.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  const composer = (await b.getByTestId('composer-input').boundingBox())!
  expect(box.y).toBeGreaterThan(composer.y)
  await b.context().close()
})
