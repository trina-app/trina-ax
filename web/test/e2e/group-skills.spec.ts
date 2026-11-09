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

test('Team skills: a team skill replaced by a group or personal skill of the same name stays listed with a note; names are what people type; no path in rows', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  const H = { [CSRF_HEADER]: '1' }
  const made = await page.request.post('/api/admin/groups', { headers: H, data: { name: 'Sales', memberIds: ['olga'] } })
  expect(made.ok()).toBeTruthy()
  const group = (await made.json()) as { id: string }
  const md = (name: string, description: string, title?: string) => `---\nname: ${name}\n${title ? `metadata:\n  title: ${title}\n` : ''}description: ${description}\n---\n1. step\n`
  for (const [p, text] of [
    // the replaced team skill has a form: its row must still offer no run button
    ['skills/estimate/SKILL.md', '---\nname: estimate\nmetadata:\n  inputs: |\n    [{"name":"customer","label":"고객사"}]\ndescription: team estimate steps\n---\n1. step\n'],
    ['skills/meeting-notes/SKILL.md', md('meeting-notes', 'summarise a meeting')],
    ['skills/quote/SKILL.md', md('quote', 'team quote steps')],
    ['skills/marketing/ad-copy/SKILL.md', md('ad-copy', 'write ad copy', 'Ad copy')],
    ['groups/Sales/skills/estimate/SKILL.md', md('estimate', 'sales estimate steps')],
    ['users/olga/skills/quote.md', md('quote', 'my own quote')],
  ]) expect((await page.request.post('/__test/file', { data: { path: p, text } })).ok()).toBeTruthy()

  await page.goto('/skills')
  const list = page.getByTestId('skill-list')
  await expect(list).toBeVisible()
  const team = list.getByRole('region', { name: '우리 팀 스킬' })
  // the team section keeps to the skills that run: the replaced ones are not in it, and not in its count
  await expect(team.getByTestId('skill-row')).toHaveCount(2)
  await expect(team.getByTestId('skill-count')).toHaveText('2')
  // they are in their own section, muted, with the note, and counted there
  const lost = page.getByTestId('skill-shadowed')
  await expect(lost.getByTestId('skill-row')).toHaveCount(2)
  await expect(lost.getByTestId('skill-count')).toHaveText('2')
  const est = lost.locator('[data-path="skills/estimate/SKILL.md"]')
  await expect(est.getByTestId('skill-shadow-note')).toHaveText('Sales 그룹의 같은 이름 스킬이 대신 쓰여요')
  await expect(est).toHaveAttribute('data-shadowed', 'group')
  const listed = (await (await page.request.get('/api/skills?shadowed=1')).json()) as { items: { path: string; inputs?: unknown[] }[] }
  expect(listed.items.find((x) => x.path === 'skills/estimate/SKILL.md')?.inputs).toHaveLength(1)
  // a replaced skill is not run from here: no run button, no "use" in its menu, only the file (details and path)
  await expect(lost.getByTestId('skill-run')).toHaveCount(0)
  await est.getByTestId('skill-more').click()
  await expect(est.getByRole('menuitem', { name: '채팅에서 쓰기' })).toHaveCount(0)
  await expect(est.getByTestId('skill-file')).toBeVisible()
  await expect(est.getByTestId('skill-path')).toHaveText('skills/estimate/SKILL.md')
  await page.keyboard.press('Escape')
  await expect(lost.locator('[data-path="skills/quote/SKILL.md"]').getByTestId('skill-shadow-note')).toHaveText('내 개인 스킬이 대신 쓰여요')
  // the one that runs is in its own group's section
  await expect(page.getByTestId(`skill-group-${group.id}`).locator('[data-path="groups/Sales/skills/estimate/SKILL.md"]')).toHaveCount(1)

  // one name everywhere: what people type, hyphens kept; a title comes first with the command beside it
  await expect(team.locator('[data-path="skills/meeting-notes/SKILL.md"]').getByTestId('skill-name')).toHaveText('/meeting-notes')
  // the same type as the "/" menu's name: the page's sans font at medium weight, not monospace
  const nameStyle = await team.locator('[data-path="skills/meeting-notes/SKILL.md"]').getByTestId('skill-name').evaluate((el) => { const c = getComputedStyle(el); return { family: c.fontFamily, weight: c.fontWeight } })
  expect(nameStyle.family).not.toMatch(/mono|menlo|courier/i)
  expect(nameStyle.weight).toBe('500')
  const ad = team.locator('[data-path="skills/marketing/ad-copy/SKILL.md"]')
  await expect(ad.getByTestId('skill-name')).toHaveText('Ad copy')
  await expect(ad.getByTestId('skill-command')).toHaveText('/ad-copy')
  await expect(list).not.toContainText('meeting notes')

  // no path before the description; a subfolder stays as a short hint (owners and admins), the full path is in "…"
  for (const row of await list.getByTestId('skill-row').all()) await expect(row).not.toContainText(/skills\//)
  await expect(ad).toContainText('marketing · write ad copy')
  await ad.getByTestId('skill-more').click()
  await expect(ad.getByTestId('skill-path')).toHaveText('skills/marketing/ad-copy/SKILL.md')

  // the "/" menu shows only the one that runs, with the same names, and says what it replaced
  await page.goto('/')
  const input = page.getByTestId('composer-input')
  await input.fill('/estimate')
  const menu = page.getByTestId('skill-menu')
  await expect(menu.getByRole('option')).toHaveCount(1)
  await expect(menu.getByTestId('skill-group')).toHaveText('Sales')
  await expect(menu.getByTestId('skill-replaces')).toHaveText('팀 스킬 대신')
  await input.fill('/meeting')
  await expect(menu.getByRole('option')).toContainText('/meeting-notes')
  expect(realErrors(errors)).toEqual([])
})
