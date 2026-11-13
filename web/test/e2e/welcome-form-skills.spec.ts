// The setup's forms become team skills, in a real browser against the mock (docs/DECISIONS.md "Setup 팀 파일: forms
// become skills"; components/onboarding/FormSkills.tsx): after [이대로 정리], one question on the result screen for the
// Excel and Word forms the plan put in 양식 ("견적서 양식, 주간보고 양식을 스킬로 만들어둘까요?"), a form named for a company
// left out, a Markdown "form" too (no skill fills it); [만들기] → S's card per form → [팀에 공유] writes the skill and
// leaves one line, the card's 나중에 drops that form; the question's 나중에 drops it all and the step goes on. A phone at
// 390 px, light and dark.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const file = (name: string, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer: Buffer.from(`${name}\n`) })
const FILES = [file('견적서_양식.xlsx'), file('주간보고_양식.docx'), file('견적서_양식_㈜에이스상사.xlsx'), file('메모 양식.md', 'text/markdown'), file('10월 회의록.md', 'text/markdown')]
const tree = async (page: Page, path: string) => ((await (await page.request.get(`/api/files/tree?path=${encodeURIComponent(path)}`)).json()).entries ?? []) as { name: string; type: string }[]

/** 회사 소개 and 스킬 put off; the files up; the plan applied */
async function toResult(page: Page) {
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-team-files-input').setInputFiles(FILES)
  await expect(page.getByTestId('organize-proposal')).toBeVisible()
  await page.getByTestId('organize-apply').click()
  await expect(page.getByTestId('organize-result-title')).toBeVisible()
}
const card = (page: Page, path: string) => page.locator(`[data-testid="form-skill"][data-path="${path}"]`)

test('the question → [만들기] → a card per form → [팀에 공유] one, 나중에 the other → the next step', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toResult(page)
  // the forms the plan put in 양식: the Excel and Word ones, not the one named for a company, not Markdown
  await expect(page.getByTestId('form-skills-question')).toHaveText('견적서 양식, 주간보고 양식을 스킬로 만들어둘까요?')
  await expect(page.getByTestId('form-skills-hint')).toHaveText("팀원이 '견적서 만들어줘' 하면 각 양식대로 채워요.")
  expect((await tree(page, 'shared/양식')).map((e) => e.name).sort()).toEqual(['견적서_양식.xlsx', '견적서_양식_㈜에이스상사.xlsx', '메모 양식.md', '주간보고_양식.docx'].sort())
  await page.getByTestId('form-skills-make').click()
  // S's card for each form, from its file
  await expect(page.getByTestId('form-skill')).toHaveCount(2)
  const quote = card(page, 'shared/양식/견적서_양식.xlsx')
  await expect(quote.getByTestId('skill-share')).toHaveAttribute('data-state', 'ready')
  await expect(quote.getByTestId('skill-share-title')).toHaveText('견적서 만들기')
  await expect(quote.getByTestId('skill-share-asks')).toHaveText('팀원에게 물어볼 것:고객사 · 품목')
  await expect(quote.getByTestId('skill-share-files')).toHaveText('쓰는 자료:양식 폴더의 가장 최근 견적서 양식')
  expect((await (await page.request.get('/__test/organize')).json()).formSkills).toEqual(['shared/양식/견적서_양식.xlsx', 'shared/양식/주간보고_양식.docx'])
  // [팀에 공유]: the skill is in the team's skills; one line in its place
  await quote.getByTestId('skill-share-share').click()
  await expect(page.getByTestId('form-skills-shared')).toHaveText("'견적서 만들기' 스킬을 팀에 공유했어요")
  expect((await tree(page, 'skills/general')).map((e) => e.name)).toContain('form-1')
  // the other card's 나중에: gone
  await card(page, 'shared/양식/주간보고_양식.docx').getByTestId('skill-share-later').click()
  await expect(page.getByTestId('form-skill')).toHaveCount(0)
  await page.getByTestId('organize-next').click()
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  // back: as it was, no new draft
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('form-skills-shared')).toBeVisible()
  expect((await (await page.request.get('/__test/organize')).json()).formSkills).toHaveLength(2)
  expect(realErrors(errors)).toEqual([])
})

test('나중에: the question goes, nothing is drafted, the step goes on', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toResult(page)
  await page.getByTestId('form-skills-later').click()
  await expect(page.getByTestId('form-skills')).toHaveCount(0)
  expect((await (await page.request.get('/__test/organize')).json()).formSkills).toEqual([])
  await page.getByTestId('organize-next').click()
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

for (const scheme of ['light', 'dark'] as const) {
  test(`a phone at 390 px (${scheme}): the question and the cards fit, touch-size buttons`, async ({ page }) => {
    const errors = watchConsole(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await toResult(page)
    await expect(page.getByTestId('form-skills-question')).toBeVisible()
    expect((await page.getByTestId('form-skills-make').boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.getByTestId('form-skills-make').click()
    await expect(card(page, 'shared/양식/견적서_양식.xlsx').getByTestId('skill-share')).toHaveAttribute('data-state', 'ready')
    await expect(card(page, 'shared/양식/주간보고_양식.docx').getByTestId('skill-share')).toHaveAttribute('data-state', 'ready')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    const share = card(page, 'shared/양식/견적서_양식.xlsx').getByTestId('skill-share-share')
    expect((await share.boundingBox())!.width).toBeGreaterThan(300)
    await page.screenshot({ path: `test-results/form-skills-390-${scheme}.png`, fullPage: true })
    await share.click()
    await expect(page.getByTestId('form-skills-shared')).toBeVisible()
    expect(realErrors(errors)).toEqual([])
  })
}
