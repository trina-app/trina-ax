// Team skills › 검토 대기 shows only what waits, and the navigation's 팀 스킬 row counts it
// (docs/decisions/20261116-skills-review-tab.md): a decided suggestion leaves the list and folds under "검토한 제안";
// the row's count (the rooms' unread pill: components/CountPill.tsx) shows when a suggestion comes, without a reload,
// on the computer's panel and in the phone's drawer, and goes when it is reviewed.
import { expect, test, type Page } from '@playwright/test'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'
import { openPhoneDrawer, openTrinaRow } from './nav'

const BOB = { username: 'bob', password: 'bob password 1' }
const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()

/** Bob suggests a skill from an answer in his chat. */
async function suggest(page: Page, question: string, name: string) {
  await page.goto('/')
  await page.getByTestId('composer-input').fill(question)
  await page.getByTestId('send').click()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await lastAnswer(page).hover()
  await lastAnswer(page).getByTestId('suggest-skill').click()
  await page.getByTestId('suggest-name').fill(name)
  await page.getByTestId('suggest-send').click()
  await expect(page.getByText('스킬을 제안했어요. 검토가 끝나면 알려 드려요.')).toBeVisible()
}

test('the 팀 스킬 row counts what waits for my review: it comes with a suggestion and goes when I review it', async ({ page, browser }) => {
  await reset(page)
  await signIn(page, BOB)
  const ctx = await browser.newContext({ baseURL: page.url().replace(/^(https?:\/\/[^/]+).*$/, '$1'), locale: 'ko-KR', viewport: { width: 1360, height: 860 } })
  const owner = await ctx.newPage()
  const errors = watchConsole(owner)
  await signIn(owner, OWNER)
  await owner.goto('/scheduled')
  const row = owner.getByTestId('trina-panel').getByTestId('nav-skills')
  await expect(row).toBeVisible()
  // nothing waits: no count
  await expect(owner.getByTestId('nav-skills-count')).toHaveCount(0)

  // a suggestion comes while the owner is elsewhere: the count shows without a reload
  await suggest(page, 'how do we write the weekly report', '주간 보고')
  // the live notice says the place in words, not "skills/"
  await expect(owner.getByTestId('toast').filter({ hasText: '주간 보고' })).toContainText('→ 팀 스킬')
  await expect(owner.getByTestId('toast').filter({ hasText: '주간 보고' })).not.toContainText('skills/')
  const count = row.getByTestId('nav-skills-count')
  await expect(count).toHaveText(/^1/)
  await expect(count).toContainText('검토를 기다리는 제안 1개')
  // the suggester reviews nothing: no count for him
  await openTrinaRow(page, 'skills')
  await expect(page.getByTestId('nav-skills-count')).toHaveCount(0)

  // a second one: 2; the review tab says the same number
  await suggest(page, 'how do we answer a quote', '견적 답장')
  await expect(count).toHaveText(/^2/)
  await row.click()
  await expect(owner.getByRole('tab', { name: '검토 대기 (2)' })).toHaveAttribute('aria-selected', 'true')
  // the tab starts with its list: no settings sentences above it (who can edit is on the skills' own tab)
  await expect(owner.getByTestId('review-list')).toBeVisible()
  await expect(owner.getByTestId('skill-editors')).toHaveCount(0)
  await expect(owner.getByText('내가 관리하는 폴더')).toHaveCount(0)
  // two of one person: one heading for them; the folder in words, not a path
  await expect(owner.getByTestId('review-group-head')).toHaveCount(1)
  await expect(owner.getByTestId('review-list').getByTestId('suggestion').first()).toContainText('팀 스킬')
  await expect(owner.getByTestId('review-list').getByTestId('suggestion-meta').first()).toContainText('팀 스킬에 제안 · ')
  await expect(owner.getByTestId('review-list')).not.toContainText('skills/')

  // the phone's drawer shows the same count
  await owner.setViewportSize({ width: 390, height: 844 })
  await owner.goto('/')
  const drawer = await openPhoneDrawer(owner)
  await expect(drawer.getByTestId('nav-skills').getByTestId('nav-skills-count')).toHaveText(/^2/)
  // the row opens Team skills from the drawer (the drawer closes itself: no step back left to race the next page)
  await drawer.getByTestId('nav-skills').click()
  await expect(owner).toHaveURL(/\/skills/)
  await expect(owner.getByTestId('review-list')).toBeVisible()
  await owner.setViewportSize({ width: 1360, height: 860 })

  // registered: it leaves the list, the count drops
  await owner.getByRole('tab', { name: '검토 대기 (2)' }).click()
  await owner.getByTestId('review-open').first().click()
  await owner.getByTestId('review-approve').click()
  await expect(owner.getByRole('tab', { name: '검토 대기 (1)' })).toBeVisible()
  await expect(count).toHaveText(/^1/)
  await expect(owner.getByTestId('review-list').getByTestId('suggestion')).toHaveCount(1)
  await expect(owner.getByTestId('review-list').getByTestId('suggestion')).toHaveAttribute('data-status', 'pending')
  // one row left: no person heading, the row names its person
  await expect(owner.getByTestId('review-group-head')).toHaveCount(0)

  // turned down with a note: nothing waits, the plain empty state, no count anywhere
  await owner.getByTestId('review-open').click()
  await owner.getByTestId('review-reject').click()
  await owner.getByRole('dialog', { name: '거절' }).getByRole('textbox').fill('비슷한 스킬이 이미 있어요')
  await owner.getByRole('dialog', { name: '거절' }).getByRole('button', { name: '거절' }).click()
  await expect(owner.getByText('검토할 제안이 없어요.')).toBeVisible()
  await expect(owner.getByTestId('nav-skills-count')).toHaveCount(0)
  await expect(owner.getByRole('tab', { name: '검토 대기', exact: true })).toBeVisible()
  await expect(owner.getByTestId('review-open')).toHaveCount(0)

  // what was decided is not lost: folded under "검토한 제안", with its state, the note and where it was registered
  const reviewed = owner.getByTestId('reviewed-section')
  await expect(reviewed.getByTestId('reviewed-head')).toContainText('검토한 제안')
  await expect(reviewed.getByTestId('suggestion')).toHaveCount(0)
  await reviewed.getByTestId('panel-section-fold').click()
  await expect(reviewed.getByTestId('suggestion')).toHaveCount(2)
  // a decided row says only the place: no "제안" / "넣기" left to read as something to do
  for (const line of await reviewed.getByTestId('suggestion-meta').allTextContents()) {
    expect(line).toMatch(/^팀 스킬 · /)
    expect(line).not.toMatch(/제안|넣기/)
  }
  await expect(reviewed.locator('[data-testid="suggestion"][data-status="rejected"]').getByTestId('review-note')).toContainText('비슷한 스킬이 이미 있어요')
  const result = reviewed.locator('[data-testid="suggestion"][data-status="approved"]').getByTestId('suggestion-result')
  await expect(result).toContainText('팀 스킬 ›')
  // "등록됨: …" in the line's grey, as its meta line: not the accent colour, which read as an error
  const meta = reviewed.locator('[data-testid="suggestion"][data-status="approved"]').getByTestId('review-note').or(reviewed.locator('[data-testid="suggestion"][data-status="rejected"]').getByTestId('review-note')).first()
  expect(await result.evaluate((el) => getComputedStyle(el).color)).toBe(await meta.evaluate((el) => getComputedStyle(el).color))

  // after a reload too: decided ones stay out of the list
  await owner.reload()
  await owner.getByRole('tab', { name: '검토 대기', exact: true }).click()
  await expect(owner.getByText('검토할 제안이 없어요.')).toBeVisible()
  await expect(owner.getByTestId('nav-skills-count')).toHaveCount(0)
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
  await ctx.close()
})
