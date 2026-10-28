// WCAG 2.2 AA checks with axe-core on the main screens (tab 5 "접근성"), in light and dark themes.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { makePng, SVG } from '../../../tests/lib/images'

// Keyboard order needs real key presses: axe cannot detect autofocus skipping the skip link.
for (const address of ['/', '/?prompt=Draft%20from%20a%20link']) {
  test(`home keyboard entry starts at the skip link (${address})`, async ({ page }) => {
    await reset(page)
    await signIn(page, { username: 'bob', password: 'bob password 1' })
    await page.goto(address)
    const input = page.getByTestId('composer-input')
    await expect(page.getByTestId('first-time-folders')).toBeVisible()
    await expect(input).not.toBeFocused()
    if (address.includes('prompt')) await expect(input).toHaveValue('Draft from a link')
    await page.keyboard.press('Tab')
    const skip = page.locator('a[href="#main"]')
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('main')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(input).toBeFocused()
    await page.keyboard.type('Keyboard draft')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('Second line')
    await expect(input).toHaveValue(/Keyboard draft\nSecond line/)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('user-message').last()).toContainText('Second line')
  })
}

test('new chat navigation focuses the composer but reloading does not', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files')
  const newChat = page.getByTestId('new-chat')
  const input = page.getByTestId('composer-input')
  await newChat.click()
  await expect(input).toBeFocused()
  await input.fill('Keep this draft')
  await page.goto('/files')
  await expect(page.getByTestId('file-table')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+o')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Keep this draft')
  // A reload after an in-app navigation must not replay its focus request.
  await page.reload()
  await expect(input).toBeVisible()
  await expect(input).not.toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.locator('a[href="#main"]')).toBeFocused()
})

test('choosing examples and frequent questions focuses the filled composer', async ({ page }) => {
  await reset(page)
  await page.route('**/api/questions/frequent', r => r.fulfill({ json: { days: 30, sampled: false, items: [
    { question: 'Summarize my weekly report', count: 3, lastUsedAt: '2026-10-20T00:00:00.000Z' },
  ] } }))
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/')
  const input = page.getByTestId('composer-input')
  const example = page.getByTestId('example').first()
  const text = await example.innerText()
  await example.focus()
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue(text)
  await expect(input).toBeFocused()
  const question = page.getByTestId('frequent-questions').getByRole('button')
  await question.focus()
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('Summarize my weekly report')
  await expect(input).toBeFocused()
})

test('Escape from the file trash confirmation returns focus to its opener', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await page.getByTestId('file-check').first().check()
  const opener = page.getByTestId('bulk-delete')
  await opener.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test.describe('home focus on touch devices', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('loading home, choosing a preset and starting a chat do not force input focus', async ({ page }) => {
    await reset(page)
    await signIn(page, { username: 'bob', password: 'bob password 1' })
    await page.goto('/')
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    const input = page.getByTestId('composer-input')
    await expect(page.getByTestId('first-time-folders')).toBeVisible()
    await expect(input).not.toBeFocused()
    const example = page.getByTestId('example').first()
    const text = await example.innerText()
    await example.tap()
    await expect(input).toHaveValue(text)
    await expect(input).not.toBeFocused()
    await page.getByRole('main').getByRole('button', { name: '새 채팅', exact: true }).tap()
    await expect(input).not.toBeFocused()
  })
})

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

for (const scheme of ['light', 'dark'] as const) {
  test(`no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await page.goto('/login')
    await expect(page.getByTestId('login-username')).toBeVisible()
    await audit(page, 'login')
    await signIn(page)
    await audit(page, 'home')
    await page.getByTestId('composer-input').fill('files and search please')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
    await audit(page, 'chat')
    await page.goto('/files?path=marketing')
    await expect(page.getByTestId('file-table')).toBeVisible()
    await audit(page, 'files')
    // checked rows and the selection bar
    await page.getByTestId('file-check').first().click()
    await expect(page.getByTestId('bulk-bar')).toBeVisible()
    await audit(page, 'files (selection)')
    await page.goto('/admin/members')
    await expect(page.getByTestId('members-table')).toBeVisible()
    await audit(page, 'admin')
    await page.goto('/settings/profile')
    await audit(page, 'settings')
  })
}

// Phone width (PWA): labels that collapse to icons must keep their accessible names, dimmed rows their contrast.
test('no serious accessibility problems at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await audit(page, 'home (phone)')
  await page.goto('/files')
  await expect(page.getByTestId('file-table')).toBeVisible()
  await expect(page.getByRole('button', { name: '새 폴더' })).toBeVisible()
  await audit(page, 'files (phone)')
  await page.getByTestId('select-all').click()
  await expect(page.getByTestId('bulk-bar')).toBeVisible()
  await audit(page, 'files selection (phone)')
  await page.goto('/admin/members')
  await expect(page.getByTestId('members-table')).toBeVisible()
  await audit(page, 'admin (phone)')
})

// Every admin section, the other settings tabs, projects, trash, an ask card and the file preview panel, in both
// themes: the screens an owner configures the team on are as readable as the chat.
for (const scheme of ['light', 'dark'] as const) {
  test(`the remaining screens have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    for (const s of ['groups', 'folders', 'engines', 'usage', 'audit', 'settings', 'system']) {
      await page.goto(`/admin/${s}`)
      await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible()
      await page.waitForTimeout(300)
      await audit(page, `admin/${s}`)
    }
    for (const s of ['security', 'memory', 'apps']) {
      await page.goto(`/settings/${s}`)
      await page.waitForTimeout(300)
      await audit(page, `settings/${s}`)
    }
    await page.goto('/projects')
    await page.waitForTimeout(300)
    await audit(page, 'projects')
    await page.goto('/trash')
    await page.waitForTimeout(300)
    await audit(page, 'trash')
    await page.goto('/files?path=marketing')
    await page.getByTestId('file-row').filter({ hasText: 'plan.md' }).first().getByRole('button').first().click()
    await page.waitForTimeout(500)
    await audit(page, 'file preview')
    await page.goto('/')
    await page.getByTestId('composer-input').fill('please ask me something')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('ask-card')).toBeVisible()
    await audit(page, 'ask card')
  })
}

// External services (Settings and Admin): the lists with an error, a sign-in to do, tools opened, the add dialog for
// both kinds with the "run without asking" warning, an edit with a saved key, and the admin's dialog with who may use it.
async function seedIntegrations(page: Page) {
  const post = (path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
  expect((await post('/api/integrations', { kind: 'http', name: 'AI PM', url: 'https://pm.example.com/api', auth: 'bearer', secret: 'pm-key-1234567890', notes: 'GET /projects' })).status()).toBe(201)
  expect((await post('/api/integrations', { kind: 'mcp', name: 'Linear', url: 'https://mcp.linear.example/mcp', auth: 'none', writePolicy: 'allow' })).status()).toBe(201)
  expect((await post('/api/integrations', { kind: 'mcp', name: 'Notion', url: 'https://mcp.notion.example/mcp', auth: 'oauth' })).status()).toBe(201)
  expect((await post('/api/integrations', { kind: 'http', name: 'Old API', url: 'https://down.example.com/api', auth: 'none' })).status()).toBe(201)
  expect((await post('/api/admin/integrations', { kind: 'http', name: 'Company PM', url: 'https://pm.example.com/api', auth: 'none', writePolicy: 'deny', access: { everyone: true, groups: [], users: [] } })).status()).toBe(201)
  expect((await post('/api/admin/integrations', { kind: 'mcp', name: 'Sales MCP', url: 'https://mcp.sales.example/mcp', auth: 'none', access: { everyone: false, groups: [], users: [] } })).status()).toBe(201)
}

async function auditIntegrations(page: Page, where: string) {
  await page.goto('/settings/integrations')
  await expect(page.getByTestId('integrations-mine')).toBeVisible()
  await page.getByTestId('integration-row').filter({ hasText: 'Linear' }).getByTestId('integration-tools-toggle').click()
  await audit(page, `settings/integrations${where}`)
  await page.getByTestId('integration-add').click()
  await page.getByTestId('integration-write-allow').check()
  await page.getByTestId('integration-save').click() // shows the field errors
  await audit(page, `integration add (MCP)${where}`)
  await page.getByTestId('integration-kind-http').check()
  await page.getByTestId('integration-header-custom').check()
  await audit(page, `integration add (API)${where}`)
  await page.keyboard.press('Escape')
  await page.getByTestId('integration-row').filter({ hasText: 'AI PM' }).getByTestId('integration-edit').click()
  await expect(page.getByTestId('integration-key-saved')).toBeVisible()
  await audit(page, `integration edit${where}`)
  await page.keyboard.press('Escape')
  await page.goto('/admin/integrations')
  await expect(page.getByTestId('team-integrations')).toBeVisible()
  await audit(page, `admin/integrations${where}`)
  await page.getByTestId('integration-add').click()
  await page.getByTestId('integration-access').getByRole('checkbox', { name: /Olga/ }).uncheck()
  await page.getByTestId('integration-access').getByRole('checkbox', { name: 'Bob' }).check()
  await expect(page.getByTestId('integration-access-not-me')).toBeVisible()
  await audit(page, `admin integration add${where}`)
  await page.keyboard.press('Escape')
}

for (const scheme of ['light', 'dark'] as const) {
  test(`external services have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await seedIntegrations(page)
    await auditIntegrations(page, ` (${scheme})`)
  })
}

test('external services have no serious accessibility problems at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await seedIntegrations(page)
  await auditIntegrations(page, ' (phone)')
})

// The team logo (Admin › Team settings): a refused file's message, then a logo with its previews on light and dark
// backgrounds and the remove button, in both themes and at phone width.
async function auditTeamIcon(page: Page, where: string) {
  await page.goto('/admin/settings')
  await expect(page.getByTestId('team-icon')).toBeVisible()
  await audit(page, `team logo (default)${where}`)
  await page.getByTestId('team-icon-input').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) })
  await expect(page.getByTestId('team-icon-error')).toBeVisible()
  await audit(page, `team logo (refused)${where}`)
  await page.getByTestId('team-icon-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng(256, 256)) })
  await expect(page.getByTestId('team-icon-remove')).toBeVisible()
  await audit(page, `team logo (set)${where}`)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`the team logo section has no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await auditTeamIcon(page, ` (${scheme})`)
  })
}

test('the team logo section has no serious accessibility problems at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await auditTeamIcon(page, ' (phone)')
})
