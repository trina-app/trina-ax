// Group skills (docs/DECISIONS.md "Group skills"): the Team skills page shows one section per group of the person that
// has skills, titled with the group's current name (a rename follows; the folder stays), none for a group without
// skills and none to someone outside the group; the "/" menu marks a group skill with the group's name.
import { expect, test } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }

test('Team skills: a section per group with skills, its current name; the "/" menu badge; nobody else sees it', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  const H = { [CSRF_HEADER]: '1' }
  // a group of the owner's (Admin › Groups makes groups/<name>/), and a skill in its skills folder
  const made = await page.request.post('/api/admin/groups', { headers: H, data: { name: '영업팀', memberIds: ['olga'] } })
  expect(made.ok()).toBeTruthy()
  const group = (await made.json()) as { id: string }
  for (const [p, text] of [
    ['groups/영업팀/skills/offer/SKILL.md', '---\nname: offer\ndescription: 영업팀 견적 제안서를 써요\n---\n1. 견적을 읽는다\n'],
    ['skills/weekly.md', '---\nname: weekly\ndescription: 팀 주간 보고\n---\n요약\n'],
  ]) expect((await page.request.post('/__test/file', { data: { path: p, text } })).ok()).toBeTruthy()

  await page.goto('/skills')
  const list = page.getByTestId('skill-list')
  const section = list.getByTestId(`skill-group-${group.id}`)
  await expect(section.getByRole('heading')).toHaveText(/영업팀 그룹 스킬/)
  await expect(section.getByTestId('skill-row')).toHaveCount(1)
  await expect(section.getByTestId('skill-row')).toHaveAttribute('data-path', 'groups/영업팀/skills/offer/SKILL.md')
  // the team's section does not list it; the owner's other group (재무팀) has no skills: no section
  await expect(list.getByRole('region', { name: '우리 팀 스킬' }).getByTestId('skill-row')).toHaveCount(1)
  await expect(list.getByRole('region', { name: /재무팀/ })).toHaveCount(0)

  // a rename: the section follows (the folder keeps its name)
  expect((await page.request.patch(`/api/admin/groups/${group.id}`, { headers: H, data: { name: '세일즈팀' } })).ok()).toBeTruthy()
  await page.reload()
  await expect(page.getByTestId(`skill-group-${group.id}`).getByRole('heading')).toHaveText(/세일즈팀 그룹 스킬/)
  await expect(page.getByTestId(`skill-group-${group.id}`).getByTestId('skill-row')).toHaveAttribute('data-path', 'groups/영업팀/skills/offer/SKILL.md')

  // the "/" menu: the group's name beside the skill
  await page.goto('/')
  const input = page.getByTestId('composer-input')
  await input.fill('/off')
  const menu = page.getByTestId('skill-menu')
  await expect(menu.getByRole('option')).toHaveCount(1)
  await expect(menu.getByTestId('skill-group')).toHaveText('세일즈팀')
  await expect(menu.getByTestId('skill-group')).toHaveAttribute('title', /세일즈팀 그룹의 스킬/)
  expect(realErrors(errors)).toEqual([])

  // Bob is in no group: no group section, no group skill in the menu
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/skills')
  await expect(page.getByTestId('skill-list')).toBeVisible()
  await expect(page.getByTestId(`skill-group-${group.id}`)).toHaveCount(0)
  await expect(page.getByTestId('skill-list')).not.toContainText('offer')
})
