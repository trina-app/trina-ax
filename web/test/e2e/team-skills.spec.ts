// Team skills (docs/DECISIONS.md "팀 스킬 관리"): the "팀 스킬 관리" toggle on Admin > 멤버 / 그룹 (with its warning, a
// subfolder scope, and the same rule on Admin > 폴더 권한), the server's card before the AI saves under skills/ (with
// the diff; the AI cannot answer it), the banner that links to the version history, and "스킬로 제안" → [등록].
import { expect, test, type Page } from '@playwright/test'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()

test('"팀 스킬 관리" per person and group: warning, subfolder scope, same rule in 폴더 권한, off again', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  await page.goto('/admin/members')
  // the owner always manages team skills
  await expect(page.getByTestId('skill-manager-user-olga')).toContainText('항상')
  const bob = page.getByTestId('skill-manager-user-bob')
  const toggle = bob.getByRole('switch', { name: 'Bob: 팀 스킬 관리' })
  await expect(toggle).not.toBeChecked()
  await toggle.click({ force: true })
  const dialog = page.getByTestId('skill-manager-dialog')
  await expect(dialog.getByTestId('skill-manager-warning')).toContainText('팀 전체 AI가 따라요')
  await dialog.getByTestId('skill-manager-scope-select').selectOption('skills/재무')
  await page.getByTestId('skill-manager-on').click()
  await expect(toggle).toBeChecked()
  await expect(bob.getByTestId('skill-manager-scope')).toHaveText('skills/재무/')
  // Admin > 폴더 권한 shows the same rule, labelled
  await page.goto('/admin/folders')
  const row = page.getByTestId('folder-list').locator('li', { hasText: 'skills/재무' })
  await expect(row).toContainText('Bob: 읽기·쓰기')
  await expect(row.getByTestId('skill-manager-badge')).toBeVisible()
  await expect(row).toContainText('팀 전체 AI가 따라요')
  // off again (confirm)
  await page.goto('/admin/members')
  await page.getByTestId('skill-manager-user-bob').getByRole("switch").click({ force: true })
  await page.getByRole('button', { name: '계속' }).click()
  await expect(page.getByTestId('skill-manager-user-bob').getByRole('switch')).not.toBeChecked()
  // a group, all of skills/
  await page.goto('/admin/groups')
  const fin = page.getByTestId('group-list').locator('li', { hasText: '재무팀' })
  await fin.getByRole("switch").click({ force: true })
  await expect(page.getByTestId('skill-manager-dialog')).toBeVisible()
  await page.getByTestId('skill-manager-on').click()
  await expect(fin.getByRole('switch')).toBeChecked()
  await expect(fin.getByTestId('skill-manager-scope')).toHaveText('skills/')
  expect(realErrors(errors)).toEqual([])
})

test('the AI saving under skills/: the server card with the diff; 저장 saves and the banner opens the version history', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  // declined: nothing saved
  await ask(page, 'skillsave this workflow')
  let card = page.getByTestId('ask-card')
  await expect(card).toHaveAttribute('data-origin', 'server')
  await expect(card).toContainText('팀 서버의 안전 확인')
  await expect(card).toContainText('팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따라요')
  await card.getByLabel('저장하지 않기').check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(lastAnswer(page)).toContainText('Not saved')
  // saved
  await page.getByTestId('composer-input').fill('skillsave again')
  await page.getByTestId('send').click()
  card = page.getByTestId('ask-card')
  const preview = card.getByTestId('skill-preview')
  await expect(preview).toContainText('skills/weekly.md')
  await expect(preview).toContainText('새 파일')
  await expect(preview.getByTestId('skill-preview-count')).toHaveText('+6 −0줄')
  await expect(preview.getByTestId('skill-preview-diff')).toContainText('+name: 주간 보고서')
  await card.getByLabel('저장', { exact: true }).check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(lastAnswer(page)).toContainText('Saved skills/weekly.md')
  // owner and admins hear about the change, with a link to the version history
  await page.getByRole('button', { name: '버전 기록 보기' }).last().click()
  await expect(page).toHaveURL(/\/files\?path=skills.*history=skills%2Fweekly\.md/)
  await expect(page.getByRole('dialog', { name: /weekly\.md/ })).toBeVisible()
  // and in 팀 스킬 > 최근 변경, marked as saved by the AI
  await page.keyboard.press('Escape')
  await page.goto('/skills')
  await page.getByRole('tab', { name: '최근 변경' }).click()
  const change = page.getByTestId('skill-change').first()
  await expect(change).toContainText('skills/weekly.md')
  await expect(change).toContainText('AI가 저장')
  expect(realErrors(errors)).toEqual([])
})

test('"스킬로 제안" from an answer → the manager reviews, edits and registers it → the suggester sees it registered', async ({ page, browser }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, BOB)
  await ask(page, 'how do we write the weekly report')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await lastAnswer(page).hover()
  await lastAnswer(page).getByTestId('suggest-skill').click()
  const dialog = page.getByTestId('suggest-dialog')
  await expect(dialog).toContainText('skills/에 바로 들어가지 않아요')
  await expect(dialog.getByTestId('suggest-content')).toHaveValue(/the answer/)
  await dialog.getByTestId('suggest-name').fill('주간/보고')
  await expect(dialog).toContainText('슬래시(/)는 쓸 수 없어요')
  await expect(page.getByTestId('suggest-send')).toBeDisabled()
  await dialog.getByTestId('suggest-name').fill('주간 보고')
  await dialog.getByTestId('suggest-description').fill('회의록으로 주간 보고서를 만든다')
  await page.getByTestId('suggest-send').click()
  await expect(page.getByText('스킬을 제안했어요. 검토가 끝나면 알려 드려요.')).toBeVisible()
  await page.getByTestId('nav-skills').click()
  // the page opens on the skills Bob can use; his suggestion is on "내 제안"
  await expect(page.getByRole('tab', { name: '쓸 수 있는 스킬' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: '내 제안' }).click()
  const mine = page.getByTestId('mine-list').getByTestId('suggestion')
  await expect(mine).toHaveAttribute('data-status', 'pending')
  await expect(mine).toContainText('주간 보고')
  await expect(page.getByRole('tab', { name: /검토 대기/ })).toHaveCount(0) // bob manages nothing

  // the owner manages skills/: a count in the sidebar, the review dialog, edit, 등록
  const ctx = await browser.newContext({ baseURL: page.url().replace(/\/skills.*$/, ''), locale: 'ko-KR' })
  const owner = await ctx.newPage()
  await signIn(owner, OWNER)
  await expect(owner.getByTestId('skills-pending')).toHaveText('1')
  await expect(owner.getByTestId('nav-skills')).toHaveAccessibleName(/검토 대기: 1/)
  await owner.getByTestId('nav-skills').click()
  await owner.getByTestId('review-list').getByTestId('review-open').click()
  const review = owner.getByTestId('review-dialog')
  await expect(review.getByTestId('review-preview')).toContainText('the answer')
  await review.getByTestId('review-name').fill('주간 보고서')
  await owner.getByTestId('review-approve').click()
  await expect(owner.getByText('스킬을 등록했어요: skills/주간-보고서.md')).toBeVisible()
  await expect(owner.getByTestId('review-list').getByTestId('suggestion')).toHaveAttribute('data-status', 'approved')
  await ctx.close()

  // the suggester hears it and sees it registered
  await expect(page.getByText('제안한 스킬이 등록됐어요')).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: '내 제안' }).click()
  await expect(page.getByTestId('mine-list').getByTestId('suggestion')).toHaveAttribute('data-status', 'approved')
  await expect(page.getByTestId('mine-list')).toContainText('skills/주간-보고서.md')
  // (the first-time folder card probes folders the member cannot see: those 404s are expected)
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})

test('[거절] with a note: the suggester sees the reason', async ({ page }) => {
  await reset(page)
  await signIn(page, OWNER)
  await ask(page, 'some workflow')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await lastAnswer(page).hover()
  await lastAnswer(page).getByTestId('suggest-skill').click()
  await page.getByTestId('suggest-name').fill('흐름')
  await page.getByTestId('suggest-send').click()
  await page.goto('/skills')
  await page.getByRole('tab', { name: /검토 대기/ }).click()
  await page.getByTestId('review-open').click()
  await page.getByTestId('review-reject').click()
  await page.getByRole('dialog', { name: '거절' }).getByRole('textbox').fill('비슷한 스킬이 이미 있어요')
  await page.getByRole('dialog', { name: '거절' }).getByRole('button', { name: '거절' }).click()
  await page.getByRole('tab', { name: '내 제안' }).click()
  const s = page.getByTestId('mine-list').getByTestId('suggestion')
  await expect(s).toHaveAttribute('data-status', 'rejected')
  await expect(s.getByTestId('review-note')).toContainText('비슷한 스킬이 이미 있어요')
})

// App review 2026-11-01: a member's Team skills page listed no skills, only their own suggestions (admins at least had
// "최근 변경"). The first tab lists what each person can use, read-only, from the same list as the "/" menu.
test('"쓸 수 있는 스킬": every person sees the skills they can use, members too, without managers\' controls', async ({ page, browser }) => {
  await reset(page)
  const errors = watchConsole(page)
  expect((await page.request.post('/__test/skills', { data: { files: [
    { path: 'skills/quote.md', name: '견적서', description: '고객 견적서 초안을 만들어요' },
    { path: 'skills/weekly/SKILL.md', name: 'weekly', description: '주간 보고서' },
    { path: 'skills/임원/board.md', name: '이사회 메모', description: '관리자만 읽는 폴더' },
    { path: 'users/bob/skills/tone.md', name: '내 말투', description: 'Bob의 메일 말투' },
  ] } })).ok()).toBeTruthy()
  await signIn(page, BOB)
  await page.getByTestId('nav-skills').click()
  await expect(page.getByRole('tab', { name: '쓸 수 있는 스킬' })).toHaveAttribute('aria-selected', 'true')
  // only "내 제안" besides it: no review, no recent changes
  await expect(page.getByRole('tab')).toHaveCount(2)
  const list = page.getByTestId('skill-list')
  await expect(list.getByTestId('skill-row')).toHaveCount(3)
  await expect(list).toContainText('견적서')
  await expect(list).toContainText('고객 견적서 초안을 만들어요')
  await expect(list).toContainText('skills/weekly/SKILL.md')
  // a skill in a folder Bob cannot read is not his to use; his own personal skill is marked
  await expect(list).not.toContainText('이사회 메모')
  await expect(list.getByTestId('skill-row').filter({ hasText: '내 말투' })).toContainText('개인')
  // read-only: use it in a chat, or open its file
  await expect(list.getByRole('button')).toHaveCount(6)
  await list.getByTestId('skill-row').filter({ hasText: '견적서' }).getByRole('button', { name: '견적서 스킬을 채팅에서 쓰기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('/견적서 ')
  await page.goto('/skills')
  await page.getByTestId('skill-row').filter({ hasText: 'weekly' }).getByRole('button', { name: 'weekly 스킬 파일 보기' }).click()
  await expect(page).toHaveURL(/\/files\?path=skills%2Fweekly&select=skills%2Fweekly%2FSKILL\.md/)

  // the owner: the admins-only folder's skill too, next to the managers' tabs
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'ko-KR' })
  const owner = await ctx.newPage()
  await signIn(owner, OWNER)
  await owner.goto('/skills')
  await expect(owner.getByRole('tab', { name: '쓸 수 있는 스킬' })).toHaveAttribute('aria-selected', 'true')
  await expect(owner.getByRole('tab', { name: '최근 변경' })).toBeVisible()
  await expect(owner.getByTestId('skill-row')).toHaveCount(3)
  await expect(owner.getByTestId('skill-list')).toContainText('이사회 메모')
  await expect(owner.getByTestId('skill-list')).not.toContainText('내 말투')
  await ctx.close()
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})

test('no skill to use yet: the tab says so and how one gets there', async ({ page }) => {
  await reset(page)
  await signIn(page, BOB)
  await page.goto('/skills')
  await expect(page.getByTestId('skill-list')).toHaveCount(0)
  await expect(page.getByText('아직 쓸 수 있는 스킬이 없어요.')).toBeVisible()
  await expect(page.getByText('"스킬로 제안"을 눌러 제안할 수 있어요')).toBeVisible()
})
