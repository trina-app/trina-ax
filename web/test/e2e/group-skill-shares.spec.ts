// Sharing to a group (docs/DECISIONS.md "Group skills"): on the share page the proposer chooses where a share goes, the
// team or one of their groups (a share to a group carries its skills only: no team rule, no tools; its primary names
// the group); the group's members find it under Team skills › 검토, read whose it is and apply it into the group's
// skills, which then show in the group's section.
import { expect, test } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }

test('the share page: the proposer picks a group; a member of the group reviews and applies it', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  const H = { [CSRF_HEADER]: '1' }
  const made = await page.request.post('/api/admin/groups', { headers: H, data: { name: '영업팀', memberIds: ['olga', 'bob'] } })
  expect(made.ok()).toBeTruthy()
  const group = (await made.json()) as { id: string }
  const created = await page.request.post('/api/skill-shares', { headers: H, data: { source: 'browser', where: '.claude', skills: [] } })
  expect(created.ok()).toBeTruthy()
  const share = (await created.json()) as { id: string }

  await page.goto(`/skills/share/${share.id}`)
  const review = page.getByTestId('skill-review')
  await expect(review).toHaveAttribute('data-status', 'ready', { timeout: 15_000 })
  await expect(review).toHaveAttribute('data-target', 'team')
  // the team by default; the owner's group with a folder of its own is the other choice
  const pick = page.getByTestId('skill-share-target')
  await expect(pick.locator('option')).toHaveText(['팀 전체 (Acme)', '영업팀 그룹만'])
  // the title and its line say the team until a group is chosen
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('팀에 공유할 스킬')
  await expect(page.getByTestId('skills-rule')).toBeVisible()
  await pick.selectOption(group.id)
  await expect(review).toHaveAttribute('data-target', group.id)
  // a share to a group: no team rule; its primary and the who line name the group
  await expect(page.getByTestId('skills-rule')).toHaveCount(0)
  await expect(page.getByTestId('skills-share')).toContainText('영업팀에 공유')
  await expect(page.getByTestId('skills-who')).toContainText("'영업팀' 그룹 멤버의 AI만")
  // and the page's title and subline follow the target, as the button does
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('영업팀 그룹에 공유할 스킬')
  await expect(page.getByTestId('skill-share-page')).toContainText('고른 것만 영업팀 그룹에 올라가요')
  await expect(page.getByTestId('skill-share-page')).not.toContainText('고른 것만 팀에 올라가요')
  await pick.selectOption('')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('팀에 공유할 스킬')
  await pick.selectOption(group.id)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('영업팀 그룹에 공유할 스킬')
  // the choice is kept (the server stores it): a reload shows it
  await page.reload()
  await expect(page.getByTestId('skill-review')).toHaveAttribute('data-target', group.id, { timeout: 15_000 })
  expect(realErrors(errors)).toEqual([])

  // Bob, a member of 영업팀: Team skills › 검토 lists it; he reads whose it is, applies it
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/skills')
  const row = page.getByTestId('share-review-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Olga님 → 영업팀')
  await row.click()
  await expect(page.getByTestId('skill-review')).toHaveAttribute('data-status', 'ready')
  await expect(page.getByTestId('skill-share-target-line')).toHaveText("Olga님이 '영업팀' 그룹에 공유하자고 했어요")
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('영업팀 그룹에 공유할 스킬')
  await expect(page.getByTestId('skill-share-target')).toHaveCount(0)
  await page.getByTestId('skills-share').click()
  await expect(page.getByTestId('skill-review')).toHaveAttribute('data-status', 'applied')
  await expect(page.getByTestId('skills-done-who')).toContainText('영업팀')
  // the group's section has the skill now
  await page.goto('/skills')
  await page.getByRole('tab', { name: '쓸 수 있는 스킬' }).click()
  await expect(page.getByTestId(`skill-group-${group.id}`).getByTestId('skill-row').first()).toHaveAttribute('data-path', /^groups\/영업팀\/skills\//)
})
