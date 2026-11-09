// Project skills (docs/DECISIONS.md "Project skills"): projects/<name>/skills/<skill>/SKILL.md of a team project, used
// only in that project's chats. The Team skills page has a section per project with skills ("{project} 프로젝트 스킬",
// "이 프로젝트 채팅에서만"), a small "같은 이름" chip where a wider skill of the name runs instead; the "/" menu marks them
// inside that project only; asking a project chat to move a group's skills shows the move card (who loses it, every
// file), and after yes the skill is under the project; "옮기기…" shows who gains and loses at each level and the whole
// text when more people would get it; the save card offers another name when the name is taken; sharing a personal
// project whose skills/ holds skills names them first.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const md = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n1. 요청서를 읽어요\n2. 단가표로 계산해요\n`

async function seed(page: Page) {
  const made = await page.request.post('/api/admin/groups', { headers: H, data: { name: '리드', memberIds: ['olga', 'bob', 'dana'] } })
  expect(made.ok()).toBeTruthy()
  const group = (await made.json()) as { id: string }
  for (const [p, text] of [
    ['skills/quote/SKILL.md', md('quote', '팀 공통 견적 절차')],
    ['groups/리드/skills/quote-check/SKILL.md', md('quote-check', '리드가 견적서를 보내기 전에 점검해요')],
    ['projects/quotation/skills/estimate/SKILL.md', md('estimate', '견적 프로젝트의 견적서 초안')],
    ['projects/quotation/skills/quote/SKILL.md', md('quote', '견적 프로젝트용 견적 절차')],
    ['projects/quotation/skills/README.md', '# 이 폴더의 스킬\n'],
  ]) expect((await page.request.post('/__test/file', { data: { path: p, text } })).ok()).toBeTruthy()
  // the project's folder: olga and bob only (its participants)
  expect((await page.request.post('/__test/restrict', { data: { path: 'projects/quotation', users: ['olga', 'bob'] } })).ok()).toBeTruthy()
  const pr = await page.request.post('/api/projects', { headers: H, data: { name: '견적', folderPath: 'projects/quotation', instructions: '', participants: [] } })
  expect(pr.ok()).toBeTruthy()
  return { group: group.id, project: ((await pr.json()) as { id: string }).id }
}

test('Team skills: a section per project with its line; the same-name chip; the "/" badge only in that project', async ({ page }) => {
  await reset(page, { withAdmin: true })
  const errors = watchConsole(page)
  await signIn(page)
  const { project } = await seed(page)
  await page.goto('/skills')
  const section = page.getByTestId(`skill-project-${project}`)
  await expect(section.getByRole('heading')).toHaveText(/견적 프로젝트 스킬/)
  await expect(section.getByTestId('skill-section-hint')).toHaveText('이 프로젝트 채팅에서만 · 새 이름만 더할 수 있어요')
  // SKILL.md folders only: no README
  await expect(section.getByTestId('skill-row')).toHaveCount(2)
  // "quote" is the team's too: that one runs, the project's row says so
  const quote = section.locator('[data-testid="skill-row"][data-path="projects/quotation/skills/quote/SKILL.md"]')
  await expect(quote.getByTestId('skill-same-name')).toHaveText('같은 이름: 팀 전체')
  await expect(section.locator('[data-testid="skill-row"][data-path="projects/quotation/skills/estimate/SKILL.md"]').getByTestId('skill-same-name')).toHaveCount(0)
  // not in the team's own section
  await expect(page.getByRole('region', { name: '우리 팀 스킬' }).locator('[data-path^="projects/"]')).toHaveCount(0)

  // the "/" menu: the badge inside the project, nothing of it outside
  await page.goto(`/projects/${project}`)
  const input = page.getByTestId('composer-input')
  await input.fill('/est')
  await expect(page.getByTestId('skill-menu').getByTestId('skill-project')).toHaveText('견적')
  await page.goto('/')
  await page.getByTestId('composer-input').fill('/est')
  await expect(page.getByTestId('skill-menu')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('a project chat asked to move the files and the skills: the move card, then the skill is a project skill', async ({ page }) => {
  await reset(page, { withAdmin: true })
  const errors = watchConsole(page)
  await signIn(page)
  const { project } = await seed(page)
  await page.goto(`/projects/${project}`)
  await page.getByTestId('composer-input').fill('리드 부서의 견적 파일과 스킬을 이 프로젝트로 옮겨 줘 moveskill quote-check')
  await page.getByTestId('send').click()
  const card = page.getByTestId('ask-card').last()
  await expect(card).toBeVisible()
  await expect(card).toContainText('"quote-check" 스킬을 옮길까요?')
  await expect(card).toContainText('리드 부서 3명 → 견적 프로젝트 채팅 2명')
  await expect(card).toContainText('1명은 이 스킬을 더 쓰지 않아요.')
  // and who may change it there
  await expect(card).toContainText('옮기면 2명이 고칠 수 있어요.')
  // every file it holds
  await expect(card.getByTestId('ask-details')).toContainText('groups/리드/skills/quote-check/SKILL.md')
  await card.getByTestId('ask-yes').click()
  await expect(page.getByTestId('ask-card')).toHaveCount(0)
  await page.goto('/skills')
  const section = page.getByTestId(`skill-project-${project}`)
  await expect(section.locator('[data-testid="skill-row"][data-path="projects/quotation/skills/quote-check/SKILL.md"]')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('옮기기… on the Skills page: each level with who gains and loses; more people means the whole text first', async ({ page }) => {
  await reset(page, { withAdmin: true })
  const errors = watchConsole(page)
  await signIn(page)
  const { project } = await seed(page)
  await page.goto('/skills')
  const row = page.getByTestId(`skill-project-${project}`).locator('[data-testid="skill-row"][data-path="projects/quotation/skills/estimate/SKILL.md"]')
  await row.getByTestId('skill-more').click()
  await page.getByTestId('skill-move-open').click()
  const dialog = page.getByTestId('skill-move')
  await expect(dialog.getByTestId('skill-move-now')).toHaveText('지금: 견적 프로젝트 채팅 · 2명')
  // to the whole team: more people, so the whole text is there before the button
  await dialog.locator('[data-testid="skill-move-target"][data-level="team"]').click()
  await expect(dialog.getByTestId('skill-move-widen')).toBeVisible()
  await expect(dialog.getByTestId('skill-move-text')).toContainText('name: estimate')
  // each level says who may change it there
  await expect(dialog.locator('[data-testid="skill-move-target"][data-level="personal"]').getByTestId('skill-move-effect')).toContainText('1명이 고칠 수 있어요')
  // only me: nobody new, no text
  await dialog.locator('[data-testid="skill-move-target"][data-level="personal"]').click()
  await expect(dialog.getByTestId('skill-move-widen')).toHaveCount(0)
  await dialog.locator('[data-testid="skill-move-target"][data-level="team"]').click()
  await page.getByTestId('skill-move-do').click()
  await expect(page.getByTestId('skill-move')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '우리 팀 스킬' }).locator('[data-path="skills/estimate/SKILL.md"]')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('the save card: a project skill under a name the team has is offered another name, not saved dead', async ({ page }) => {
  await reset(page, { withAdmin: true })
  await signIn(page)
  const { project } = await seed(page)
  await page.goto(`/projects/${project}`)
  await page.getByTestId('composer-input').fill('projectskillsave quote')
  await page.getByTestId('send').click()
  const card = page.getByTestId('ask-card').last()
  await expect(card.getByTestId('skill-preview-same-name')).toHaveText('"quote" 스킬이 팀 전체에 있어 이 프로젝트에선 그게 쓰여요. 이 이름으로는 저장하지 않아요.')
  await expect(card.getByTestId('ask-choice')).toHaveText(['이름 바꿔 저장', '팀 것 고치기', '저장하지 않기'])
  await card.getByTestId('ask-choice').first().click()
  await expect(page.getByTestId('ask-card')).toHaveCount(0)
})

test('sharing a personal project whose skills/ holds a skill: asked first by name, then shared with it', async ({ page }) => {
  await reset(page, { withAdmin: true })
  const errors = watchConsole(page)
  await signIn(page)
  const pr = await page.request.post('/api/projects', { headers: H, data: { name: '메모', scope: 'personal', instructions: '', participants: [] } })
  expect(pr.ok()).toBeTruthy()
  const mine = (await pr.json()) as { id: string; folderPath: string }
  expect((await page.request.post('/__test/file', { data: { path: `${mine.folderPath}/skills/jot/SKILL.md`, text: md('jot', '메모를 정리해요') } })).ok()).toBeTruthy()
  await page.goto(`/projects/${mine.id}`)
  await page.getByTestId('project-menu').click()
  await page.getByTestId('project-share').click()
  await page.getByTestId('project-share-confirm').click()
  // the skills that would switch on, by name, before anything is made
  const ask = page.getByRole('dialog').filter({ hasText: '프로젝트 스킬이 켜져요' })
  await expect(ask).toContainText('이 폴더의 스킬 1개가 이 프로젝트 채팅에서 AI가 따르는 스킬이 돼요: jot')
  await ask.getByTestId('dialog-confirm').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const after = await (await page.request.get(`/api/projects/${mine.id}`)).json() as { folderPath: string }
  expect(after.folderPath).toMatch(/^projects\//)
  // the first try is the 409 that asks
  expect(realErrors(errors).filter((e) => !/status of 409/.test(e))).toEqual([])
})
