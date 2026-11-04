// Search (⌘K), like Claude's: type tabs, and with no text what needs attention, recent chats and projects, and actions.
// Arrow keys move, ← → at the ends of the text change the type, Enter opens, ⌥/Alt+Enter opens a chat's menu, Esc
// closes the menu first and then the dialog. On a phone it fills the screen and has no key hints.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })

async function seed(page: Page) {
  const p = await post(page, '/api/projects', { name: 'Launch plan', scope: 'team', folderPath: 'marketing', instructions: '' })
  expect(p.status()).toBe(201)
  expect((await post(page, '/__test/skills', { files: [{ path: 'skills/weekly-report/SKILL.md', name: 'weekly-report', description: 'Turn the week into a short report' }] })).ok()).toBeTruthy()
  expect((await post(page, '/__test/schedule-review', {})).ok()).toBeTruthy()
  const i = await post(page, '/api/integrations', { kind: 'mcp', name: 'Sample Docs', url: 'https://mcp.example.com/mcp', auth: 'oauth', writePolicy: 'ask' })
  expect(i.ok()).toBeTruthy()
  await page.getByTestId('composer-input').fill('quarterly budget notes')
  await page.getByTestId('send').click()
  await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1)
  return ((await p.json()) as { id: string }).id
}

const palette = (page: Page) => page.getByTestId('search-palette')
const input = (page: Page) => palette(page).getByRole('combobox')
async function open(page: Page) {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
  await expect(input(page)).toBeFocused()
}

test('with no text: needs attention, recents and actions; tabs and arrow keys', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await seed(page)
  await page.getByTestId('new-chat').click()
  await open(page)
  const attention = palette(page).getByTestId('search-section-attention')
  await expect(attention.getByRole('option', { name: /아침 요약/ })).toBeVisible()
  await expect(attention.getByRole('option', { name: /Sample Docs/ })).toBeVisible()
  await expect(attention.getByTestId('search-attention-dot')).toHaveCount(2)
  const recents = palette(page).getByTestId('search-section-recents')
  await expect(recents.getByRole('option', { name: /quarterly budget notes/ })).toBeVisible()
  await expect(recents.getByRole('option', { name: /Launch plan/ })).toBeVisible()
  await expect(palette(page).getByTestId('search-section-actions').getByRole('option')).toHaveCount(6) // new chat, project, schedule, MCP, files, the inbox
  // the first row is active; ↓ moves
  await expect(palette(page).getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(palette(page).getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  // → with no text changes the type, ← goes back
  await page.keyboard.press('ArrowRight')
  await expect(palette(page).getByTestId('search-tab-chats')).toHaveAttribute('aria-selected', 'true')
  await expect(palette(page).getByTestId('search-section-chats').getByRole('option')).toHaveCount(1)
  await page.keyboard.press('ArrowLeft')
  await expect(palette(page).getByTestId('search-tab-all')).toHaveAttribute('aria-selected', 'true')
  // a tab by click: only that type
  await palette(page).getByTestId('search-tab-skills').click()
  await expect(palette(page).getByRole('option', { name: /weekly-report/ })).toBeVisible()
  await expect(palette(page).getByTestId('search-section-recents')).toHaveCount(0)
  await expect(input(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)
})

test('typing: results by type with the text marked, Enter opens, files go to the file search', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const projectId = await seed(page)
  await open(page)
  await input(page).fill('launch')
  const projects = palette(page).getByTestId('search-section-projects')
  await expect(projects.getByRole('option', { name: /Launch plan/ })).toBeVisible()
  await expect(projects.locator('mark')).toHaveText('Launch')
  // the caret inside the text moves as usual: ← does not change the type
  await page.keyboard.press('ArrowLeft')
  await expect(palette(page).getByTestId('search-tab-all')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))
  await expect(palette(page)).toHaveCount(0)

  await open(page)
  await input(page).fill('budget')
  await expect(palette(page).getByTestId('search-section-chats').getByRole('option', { name: /quarterly budget notes/ })).toBeVisible()
  const files = palette(page).getByTestId('search-section-files').getByRole('option')
  await files.click()
  await expect(page).toHaveURL(/\/files\?q=budget$/)

  await open(page)
  await input(page).fill('zzzz-nothing')
  await palette(page).getByTestId('search-tab-projects').click()
  await expect(palette(page).getByTestId('search-none')).toBeVisible()
})

test('actions run the existing flows, and a chat row has its menu (Alt+Enter, Esc closes it first)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await seed(page)
  await open(page)
  await palette(page).getByTestId('search-section-actions').getByRole('option', { name: '새 프로젝트' }).click()
  await expect(page.getByTestId('project-name')).toBeVisible()
  await page.keyboard.press('Escape')

  await open(page)
  await input(page).fill('MCP')
  await palette(page).getByTestId('search-section-actions').getByRole('option').first().click()
  await expect(page).toHaveURL(/\/settings\/integrations$/)
  await expect(page.getByRole('dialog', { name: '연결 추가' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  await page.goto('/')
  await open(page)
  await page.keyboard.press('ArrowRight')
  await expect(palette(page).getByTestId('search-hints')).toContainText(/Alt|⌥/)
  await page.keyboard.press('Alt+Enter')
  const menu = palette(page).getByTestId('search-row-menu')
  await expect(menu.getByRole('menuitem')).toHaveCount(2)
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(palette(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`search passes the accessibility checks (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await seed(page)
    await open(page)
    await expect(palette(page).getByTestId('search-section-attention')).toBeVisible()
    for (const text of ['', 'launch']) {
      await input(page).fill(text)
      await expect(palette(page).getByRole('option').first()).toBeVisible()
      const r = await new AxeBuilder({ page }).include('[data-testid="search-palette"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
      const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      expect(serious.map((v) => `${scheme} "${text}": ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
    }
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true })
  test('search fills the screen, the tabs scroll sideways and there are no key hints', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.getByRole('button', { name: '메뉴 열기' }).click()
    await page.getByRole('button', { name: '검색' }).first().click()
    await expect(palette(page)).toBeVisible()
    const box = (await palette(page).boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(389)
    expect(box.height).toBeGreaterThanOrEqual(779)
    await expect(palette(page).getByTestId('search-hints')).toBeHidden()
    const tabs = palette(page).getByRole('tablist')
    expect(await tabs.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto')
    await palette(page).getByTestId('search-tab-mcp').click()
    await expect(palette(page).getByTestId('search-tab-mcp')).toHaveAttribute('aria-selected', 'true')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
