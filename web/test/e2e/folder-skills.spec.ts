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

// App review 2026-11-01: the 6th skill was cut off, the arrow keys moved to rows out of sight, and the 9th skill onwards
// was never listed. Every skill is in the list, which scrolls; the chosen row stays in sight; on a phone too.
for (const [device, viewport] of [['desktop', { width: 1360, height: 860 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`a long skill list scrolls and keeps the chosen row in sight (${device})`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await reset(page)
    const errors = watchConsole(page)
    const items = Array.from({ length: 12 }, (_, i) => ({ path: `skills/s${i + 1}.md`, name: `스킬 ${String(i + 1).padStart(2, '0')}`, description: `설명 ${i + 1}` }))
    await page.route('**/api/skills', (route) => route.fulfill({ json: { items } }))
    await signIn(page)
    const input = page.getByTestId('composer-input')
    await input.fill('/')
    const list = page.getByTestId('skill-menu-list')
    const options = list.getByRole('option')
    await expect(options).toHaveCount(12)
    // the list scrolls inside itself and stays inside the window
    expect(await list.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true)
    const box = (await list.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    const inSight = (i: number) => options.nth(i).evaluate((row) => {
      const l = row.parentElement!.getBoundingClientRect(), r = row.getBoundingClientRect()
      return r.top >= l.top - 1 && r.bottom <= l.bottom + 1
    })
    for (let i = 1; i < 12; i++) {
      await input.press('ArrowDown')
      await expect(options.nth(i)).toHaveAttribute('aria-selected', 'true')
      expect({ i, inSight: await inSight(i) }).toEqual({ i, inSight: true })
    }
    // past the last row: the first one, in sight again; and back up to the last
    await input.press('ArrowDown')
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
    expect(await inSight(0)).toBe(true)
    await input.press('ArrowUp')
    await expect(options.nth(11)).toHaveAttribute('aria-selected', 'true')
    expect(await inSight(11)).toBe(true)
    await input.press('Enter')
    await expect(input).toHaveValue('/스킬 12 ')
    // a pointer or a finger reaches a row below the fold too
    await input.fill('/')
    await options.nth(9).click()
    await expect(input).toHaveValue('/스킬 10 ')
    expect(realErrors(errors)).toEqual([])
  })
}
