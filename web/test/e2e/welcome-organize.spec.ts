// 팀 파일's folder plan in a real browser against the mock (docs/DECISIONS.md "Setup 팀 파일: the AI proposes folders";
// components/onboarding/OrganizeFiles.tsx): the start says the AI reads the files; after the upload "읽고 정리하는 중…
// n/N", the proposal grouped by folder under 전사 공유; a row changed, a row taken out, a new folder renamed inline;
// [이대로 정리] moves them; the result asks once about a project ("나중에" drops it, [프로젝트로 묶기] makes a team project
// with the team group as participant and moves its files there) and goes on to the next step. Without AI: the name rules'
// list with its line; nothing to sort: the run's own end screen. A phone at 390 px, light and dark.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const doc = (name: string) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(`# ${name}\n`) })
const FILES = ['견적서_양식.md', '주간보고_양식.md', '10월 회의록.md', 'A사 제안서.md', 'A사 견적.md', '메모.md'].map(doc)
const tree = async (page: Page, path: string) => ((await (await page.request.get(`/api/files/tree?path=${encodeURIComponent(path)}`)).json()).entries ?? []) as { name: string; type: string }[]
const names = async (page: Page, path: string) => (await tree(page, path)).map((e) => e.name).sort()

/** 회사 소개 and 스킬 put off: the 팀 파일 step */
async function toFiles(page: Page) {
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
}
const row = (page: Page, name: string) => page.getByTestId('organize-row').filter({ hasText: name })
const group = (page: Page, folder: string) => page.locator(`[data-testid="organize-group"][data-folder="${folder}"]`)

test('propose → change a row → remove a row → rename a new folder → [이대로 정리] → the project question → 나중에 → the next step', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await page.request.post('/__test/organize', { data: { project: { name: 'A사 리뉴얼', match: 'A사' } } })
  await toFiles(page)
  // the start says where they go and that the AI reads them
  await expect(page.getByTestId('welcome-team-files-organize-line')).toHaveText('팀 전체가 보는 전사 공유에 정리해 드려요 · AI가 파일 내용을 읽고 정리해요')
  await page.getByTestId('welcome-team-files-input').setInputFiles(FILES)
  // reading, with the count of files read
  await expect(page.getByTestId('organize-reading-title')).toContainText('읽고 정리하는 중…')
  await expect(page.getByTestId('organize-reading-title')).toContainText('/6')
  // the proposal: grouped by folder under 전사 공유; the files with no kind are not listed
  const proposal = page.getByTestId('organize-proposal')
  await expect(proposal.getByRole('heading', { name: '이렇게 정리할까요?' })).toBeVisible()
  await expect(page.getByTestId('organize-desc')).toHaveText('전사 공유에 폴더 3개로 4개를 정리해요. 정리하기 전에 폴더를 바꾸거나 빼도 돼요.')
  await expect(page.getByTestId('organize-group')).toHaveCount(3)
  await expect(group(page, '양식')).toContainText('전사 공유')
  await expect(group(page, '양식').getByTestId('organize-group-count')).toHaveText('(2)')
  await expect(group(page, '회의록').getByTestId('organize-group-name')).toHaveText('회의록')
  await expect(group(page, '제안서').getByTestId('organize-group-new')).toHaveText('새로 만들어요')
  await expect(page.getByTestId('organize-row').filter({ hasText: '메모.md' })).toHaveCount(0)
  await expect(page.getByTestId('organize-no-ai')).toHaveCount(0)
  expect((await (await page.request.get('/__test/organize')).json()).calls[0].paths).toHaveLength(6)
  // change a row's folder
  await row(page, '주간보고_양식.md').getByTestId('organize-row-folder').selectOption('회의록')
  await expect(group(page, '양식').getByTestId('organize-group-count')).toHaveText('(1)')
  await expect(group(page, '회의록').getByTestId('organize-group-count')).toHaveText('(2)')
  // take a row out: it stays where it went up
  await row(page, '10월 회의록.md').getByTestId('organize-row-remove').click()
  await expect(page.getByTestId('organize-removed')).toHaveText('1개는 올린 자리에 그대로 둬요')
  await expect(row(page, '10월 회의록.md')).toHaveCount(0)
  // a name no folder can have: said, and the old name back
  await group(page, '제안서').getByTestId('organize-group-rename').fill('..')
  await group(page, '제안서').getByTestId('organize-group-rename').press('Enter')
  await expect(page.getByTestId('organize-group-rename-bad')).toHaveText('폴더 이름으로 쓸 수 없어요 · 원래 이름으로 뒀어요')
  await expect(group(page, '제안서').getByTestId('organize-group-rename')).toHaveValue('제안서')
  // a new folder's name, typed in place
  await group(page, '제안서').getByTestId('organize-group-rename').fill('제안서 모음')
  await group(page, '제안서').getByTestId('organize-group-rename').press('Enter')
  await expect(group(page, '제안서 모음')).toBeVisible()
  // [이대로 정리]: the moves on the server; the result
  await page.getByTestId('organize-apply').click()
  await expect(page.getByTestId('organize-result-title')).toHaveText('3개를 폴더 3개로 정리했어요')
  await expect(page.getByTestId('organize-result-folders')).toHaveText('전사 공유 › 양식, 회의록, 제안서 모음')
  expect(await names(page, 'shared/양식')).toEqual(['견적서_양식.md'])
  expect(await names(page, 'shared/회의록')).toContain('주간보고_양식.md')
  expect(await names(page, 'shared/제안서 모음')).toEqual(['A사 제안서.md'])
  expect((await tree(page, 'shared')).filter((e) => e.type === 'file').map((e) => e.name).sort()).toEqual(['10월 회의록.md', 'A사 견적.md', '메모.md'].sort())
  expect((await (await page.request.get('/__test/organize')).json()).organized).toBe(true)
  // the project question once; 나중에 drops it, and the step goes on
  await expect(page.getByTestId('organize-project-question')).toHaveText("이 2개는 'A사 리뉴얼' 프로젝트로 묶을까요?")
  await page.getByTestId('organize-project-later').click()
  await expect(page.getByTestId('organize-project')).toHaveCount(0)
  await expect(page.getByTestId('organize-next')).toHaveText('다음: 도구 연결')
  await page.getByTestId('organize-next').click()
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  // apply is bound to a plan of the caller: an unknown one is not found (the same plan twice: the unit tests)
  const again = await page.request.post('/api/onboarding/files/organize/apply', { headers: { 'x-mycel-csrf': '1' }, data: { id: 'nope', moves: [{ from: 'shared/메모.md', folder: 'x' }] } })
  expect(again.status()).toBe(404)
  // back: the result as it was, no second plan
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('organize-result')).toBeVisible()
  expect((await (await page.request.get('/__test/organize')).json()).calls).toHaveLength(1)
  expect(realErrors(errors)).toEqual([])
})

test('[프로젝트로 묶기]: a team project with the team group as participant, its files moved into its folder (dark)', async ({ page }) => {
  const errors = watchConsole(page)
  await page.emulateMedia({ colorScheme: 'dark' })
  await reset(page)
  await signIn(page)
  await page.request.post('/__test/organize', { data: { project: { name: 'A사 리뉴얼', match: 'A사' } } })
  await toFiles(page)
  const team = (await (await page.request.get('/api/onboarding/welcome')).json()).progress.teamGroup.id as string
  const made: unknown[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/projects')) made.push(r.postDataJSON()) })
  await page.getByTestId('welcome-team-files-input').setInputFiles(FILES)
  await page.getByTestId('organize-apply').click()
  await expect(page.getByTestId('organize-result-folders')).toHaveText('전사 공유 › 양식, 회의록, 제안서')
  await page.getByTestId('organize-project-yes').click()
  await expect(page.getByTestId('organize-project-done')).toContainText("'A사 리뉴얼' 프로젝트를 만들었어요")
  await expect(page.getByTestId('organize-project-failed')).toHaveCount(0)
  // the folder the plan made for the project's file is empty now: gone, and the result line no longer names it
  await expect(page.getByTestId('organize-result-folders')).toHaveText('전사 공유 › 양식, 회의록')
  await expect(page.getByTestId('organize-result-title')).toHaveText('3개를 폴더 2개로 정리했어요')
  expect((await tree(page, 'shared')).map((e) => e.name)).not.toContain('제안서')
  expect(made).toEqual([{ name: 'A사 리뉴얼', scope: 'team', participants: [{ subjectType: 'group', subjectId: team }], instructions: '' }])
  expect(await names(page, 'projects/A사 리뉴얼')).toEqual(['A사 견적.md', 'A사 제안서.md'])
  expect(realErrors(errors)).toEqual([])
})

test('no AI: the name rules\' list with its line', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await page.request.post('/__test/organize', { data: { ai: 'none' } })
  await toFiles(page)
  await page.getByTestId('welcome-team-files-input').setInputFiles([doc('휴가 규정.md'), doc('견적서_양식.md')])
  await expect(page.getByTestId('organize-no-ai')).toHaveText('AI 없이 파일 이름으로 정리했어요')
  await expect(page.getByTestId('organize-proposal')).toHaveAttribute('data-ai', 'none')
  await expect(page.getByTestId('organize-group')).toHaveCount(2)
  await page.getByTestId('organize-apply').click()
  await expect(page.getByTestId('organize-result-title')).toHaveText('2개를 폴더 2개로 정리했어요')
  await expect(page.getByTestId('organize-project')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('nothing to sort (no file name tells its kind): no list, the run\'s own end screen as before', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toFiles(page)
  await page.getByTestId('welcome-team-files-input').setInputFiles([doc('메모.md')])
  await expect(page.getByTestId('welcome-team-files-run-title')).toHaveText('전사 공유 폴더에 1개를 올렸어요')
  await expect(page.getByTestId('organize-proposal')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

for (const scheme of ['light', 'dark'] as const) {
  test(`a phone at 390 px (${scheme}): the plan fits, rows wrap, [이대로 정리] → the result → the next step`, async ({ page }) => {
    const errors = watchConsole(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await page.request.post('/__test/organize', { data: { project: { name: 'A사 리뉴얼', match: 'A사' } } })
    await toFiles(page)
    await expect(page.getByTestId('welcome-team-files-organize-line')).toBeVisible()
    await page.getByTestId('welcome-team-files-input').setInputFiles(FILES)
    await expect(page.getByTestId('organize-proposal')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    // the folder picker and ✕ are full-height touch targets under the name
    const select = row(page, '견적서_양식.md').getByTestId('organize-row-folder')
    expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(36)
    await select.selectOption({ label: '새 폴더' })
    await expect(group(page, '새 폴더')).toBeVisible()
    await page.getByTestId('organize-apply').click()
    await expect(page.getByTestId('organize-result-title')).toBeVisible()
    await expect(page.getByTestId('organize-project-question')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.getByTestId('organize-next').click()
    await expect(page.getByTestId('invite-step')).toBeVisible()
    expect(realErrors(errors)).toEqual([])
  })
}
