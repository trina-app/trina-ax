// Browser contract: standard folder skills keep their manifest identity and full command name.
// Parsing/authorization are verified against the real server in b-chat and skills-directories.
import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

test('folder skills and legacy skills share the picker; choosing a 64-character name sends that command', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  const name = 'weekly-' + 'a'.repeat(57)
  const description = 'Weekly report from the authorized references. '.repeat(20)
  await page.route('**/api/skills', (route) => route.fulfill({
    json: { items: [
      { path: `skills/${name}/SKILL.md`, name, description },
      { path: 'skills/legacy.md', name: '기존 스킬', description: '기존 형식' },
    ] },
  }))
  await signIn(page)
  const input = page.getByTestId('composer-input')
  await input.fill('/')
  const menu = page.getByTestId('skill-menu')
  await expect(menu.getByRole('option')).toHaveCount(2)
  await expect(menu).toContainText('/기존 스킬')
  await input.fill('/weekly-')
  await expect(menu.getByRole('option')).toHaveCount(1)
  await expect(menu).toContainText('/' + name)
  await expect(menu).toContainText(description.trim())
  await input.press('Enter')
  await expect(input).toHaveValue(`/${name} `)
  await expect(menu).toHaveCount(0)
  await input.fill(`/${name} 이번 주 정리`)
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/chats\/[^/]+\/messages$/.test(new URL(r.url()).pathname))
  await page.getByTestId('send').click()
  expect((await sent).postDataJSON().content).toBe(`/${name} 이번 주 정리`)
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  expect(realErrors(errors)).toEqual([])
})
