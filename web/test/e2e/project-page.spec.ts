// A project's page, like Claude's: the name with its few actions in a menu, a box that starts a chat in the project,
// the person's chats in it, and Instructions / Files as short lines that open in place. No dev environment line, also
// on a server that has it (the team setting is in Team settings, admin-dev-env.spec.ts).
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const INSTRUCTIONS = '# Launch\n\nAnswer in **short** bullet points.\n\n- One idea per line'

async function newProject(page: Page, chats: string[] = []) {
  const post = (path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
  const r = await post('/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: INSTRUCTIONS })
  expect(r.status()).toBe(201)
  const id = ((await r.json()) as { id: string }).id
  for (const title of chats) expect((await post('/api/chats', { projectId: id, title })).ok()).toBeTruthy()
  return id
}

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('the box on a project page starts a chat in the project, which is then listed there', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const id = await newProject(page)
  await page.goto(`/projects/${id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Launch' })).toBeVisible()
  // the instructions as one quiet line under the name, without their markdown
  await expect(page.getByTestId('project-summary')).toHaveText('Answer in short bullet points.')
  await expect(page.getByTestId('project-chats')).toContainText('아직 이 프로젝트의 기록이 없어요.')
  // the draft is the project's: the same one as "/?project=<id>"
  await page.getByTestId('composer-input').fill('half a question')
  await page.goto(`/?project=${id}`)
  await expect(page.getByText('이 프로젝트의 폴더와 지침으로 대화해요')).toBeVisible()
  await expect(page.getByTestId('composer-input')).toHaveValue('half a question')
  await page.goto(`/projects/${id}`)
  await page.getByTestId('composer-input').fill('project question')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
  const chats = (await (await page.request.get(`/api/chats?projectId=${id}`)).json()) as { items: { id: string }[] }
  expect(chats.items).toHaveLength(1)
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-chats').getByRole('link')).toHaveCount(1)
  await expect(page.getByTestId('composer-input')).toHaveValue('')
})

test('instructions and files open in place; edit and delete are in the menu on the name', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const id = await newProject(page, ['Weekly numbers', 'Launch plan review'])
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-chats').getByRole('link')).toHaveCount(2)

  // closed lines: a name, a short state, an action
  const files = page.getByTestId('project-files')
  await expect(files.getByTestId('project-files-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(files.getByTestId('project-files-toggle')).toContainText(/\d+개 항목/)
  await expect(files.getByRole('button', { name: 'plan.md' })).toHaveCount(0)
  await files.getByTestId('project-files-toggle').click()
  await expect(files.getByTestId('project-files-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(files.getByRole('button', { name: 'plan.md' })).toBeVisible()
  await expect(files.getByRole('link', { name: '열기' })).toHaveAttribute('href', '/files?path=marketing')

  const instructions = page.getByTestId('project-instructions')
  await instructions.getByTestId('project-instructions-toggle').click()
  await expect(instructions.getByRole('heading', { name: 'Launch' })).toBeVisible()
  await instructions.getByRole('button', { name: '수정' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()

  // the menu on the name: Escape closes only the menu and gives focus back to the name
  const menu = page.getByTestId('project-menu')
  await menu.click()
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByTestId('project-edit')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('project-delete')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(menu).toBeFocused()
  // a click outside closes it too
  await menu.click()
  await page.getByTestId('project-summary').click()
  await expect(page.getByRole('menu')).toHaveCount(0)

  await menu.click()
  await page.getByTestId('project-edit').click()
  await page.getByTestId('project-name').fill('Launch 2')
  await page.getByTestId('project-save').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Launch 2' })).toBeVisible()
  await expect(menu).toContainText('Launch 2')

  await menu.click()
  await page.getByTestId('project-delete').click()
  await page.getByRole('dialog').getByRole('button', { name: '삭제' }).click()
  await expect(page).toHaveURL(/\/projects$/)
})

test('a person who cannot edit the project sees no menu and no edit action', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const id = await newProject(page)
  await page.route(`**/api/projects/${id}`, async (r) => {
    const res = await r.fetch()
    await r.fulfill({ response: res, json: { ...(await res.json()), canEdit: false } })
  })
  await page.goto(`/projects/${id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Launch' })).toBeVisible()
  await expect(page.getByTestId('project-menu')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '현재 위치' }).getByText('Launch')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('project-instructions').getByRole('button', { name: '수정' })).toHaveCount(0)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`a project page has no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    const id = await newProject(page, ['Weekly numbers'])
    await page.goto(`/projects/${id}`)
    await expect(page.getByTestId('project-chats').getByRole('link')).toHaveCount(1)
    await audit(page, 'project')
    await page.getByTestId('project-files-toggle').click()
    await page.getByTestId('project-instructions-toggle').click()
    await page.getByTestId('project-menu').click()
    await expect(page.getByRole('menu')).toBeVisible()
    await audit(page, 'project (lines open, menu open)')
  })
}

test('at phone width the page fits: the box first, then the lines, then the chats', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  // a server with the dev environment on: still no line for it here
  await page.request.post('/__test/dev-env', { data: { srt: true } })
  await signIn(page)
  const id = await newProject(page, ['Weekly numbers'])
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-chats').getByRole('link')).toHaveCount(1)
  await expect(page.getByTestId('project-instructions')).toBeVisible()
  await expect(page.getByTestId('dev-env')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const top = async (testId: string) => (await page.getByTestId(testId).boundingBox())!.y
  expect(await top('composer-input')).toBeLessThan(await top('project-instructions'))
  expect(await top('project-files')).toBeLessThan(await top('project-chats'))
  await audit(page, 'project (phone)')
})
