// The Move picker's "추천" and "최근" (docs/DECISIONS.md "Move picker: suggested and recent folders"): a loose file's
// Move shows a suggested folder on top; picking it and "여기로 옮기기" moves the file there; ✕ hides it for good; the
// folder moved into comes back as "최근" next time. On a computer and a phone (390), light and dark, by keyboard.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name })
const post = async (page: Page, path: string, data: object) => expect((await page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })).ok()).toBeTruthy()

async function setup(page: Page) {
  await reset(page)
  await post(page, '/__test/file', { path: 'docs/quotes/quotes-lg.txt', text: 'lg' })
  await post(page, '/__test/file', { path: 'docs/quotes-samsung.txt', text: 'samsung' })
  await post(page, '/__test/file', { path: 'docs/quotes-hanwha.txt', text: 'hanwha' })
  await signIn(page)
  await page.goto('/files?path=docs')
}

async function openMove(page: Page, name: string) {
  const r = row(page, name)
  await r.hover()
  await r.getByTestId('file-menu').click()
  await page.getByRole('menuitem', { name: t['files.move'] }).click()
  const picker = page.getByRole('dialog', { name: t['files.moveTitle'].replace('{name}', name) })
  await expect(picker).toBeVisible()
  return picker
}

for (const scheme of ['light', 'dark'] as const) {
  test(`a loose file: the suggested folder first, pick it, moved; the folder is "최근" next time (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await setup(page)
    const picker = await openMove(page, 'quotes-samsung.txt')
    const suggested = picker.getByTestId('move-suggested')
    await expect(suggested.getByRole('heading', { name: t['files.suggestedFolders'] })).toBeVisible()
    await expect(suggested.getByTestId('move-hint')).toHaveText(['docs › quotes'])
    // keyboard: the suggestion is a button that picks the folder
    await suggested.getByTestId('move-hint').focus()
    await page.keyboard.press('Enter')
    await expect(suggested.getByTestId('move-hint')).toHaveAttribute('aria-pressed', 'true')
    await picker.getByTestId('folder-pick').click()
    await expect(picker).toHaveCount(0)
    await expect(row(page, 'quotes-samsung.txt')).toHaveCount(0)
    await page.goto('/files?path=docs/quotes')
    await expect(row(page, 'quotes-samsung.txt')).toBeVisible()
    // the next file: the folder is suggested again (no "최근" twice); another file without a fitting name: "최근" only
    await post(page, '/__test/file', { path: 'docs/notes-1.txt', text: 'n' })
    await page.goto('/files?path=docs')
    const next = await openMove(page, 'notes-1.txt')
    await expect(next.getByTestId('move-suggested')).toHaveCount(0)
    await expect(next.getByTestId('move-recent').getByTestId('move-hint')).toHaveText(['docs › quotes'])
    await expect(next.getByTestId('move-recent').getByTestId('move-hint-dismiss')).toHaveCount(0)
  })
}

test('✕ hides the suggestion, and it stays hidden for that file', async ({ page }) => {
  await setup(page)
  let picker = await openMove(page, 'quotes-hanwha.txt')
  const dismiss = picker.getByTestId('move-suggested').getByTestId('move-hint-dismiss')
  await expect(dismiss).toHaveAccessibleName(t['files.dismissSuggestion'].replace('{folder}', 'docs › quotes'))
  await dismiss.focus()
  await page.keyboard.press('Enter')
  await expect(picker.getByTestId('move-suggested')).toHaveCount(0)
  // the focus stays in the picker: nothing else on top, so the path above the folder list
  await expect(picker.getByRole('navigation', { name: t['files.breadcrumb'] })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  picker = await openMove(page, 'quotes-hanwha.txt')
  await expect(picker.getByRole('button', { name: t['files.newFolder'] })).toBeVisible()
  await expect(picker.getByTestId('move-suggested')).toHaveCount(0)
  // another file still gets it
  await page.keyboard.press('Escape')
  picker = await openMove(page, 'quotes-samsung.txt')
  await expect(picker.getByTestId('move-suggested').getByTestId('move-hint')).toHaveText(['docs › quotes'])
})

test('no fitting folder: the picker as before, no empty sections', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  const picker = await openMove(page, 'notes.txt')
  await expect(picker.getByRole('button', { name: t['files.newFolder'] })).toBeVisible()
  await expect(picker.getByTestId('move-hints')).toHaveCount(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  for (const scheme of ['light', 'dark'] as const) {
    test(`390: the suggestion fits, ✕ is a full touch target, picking it moves the file (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await setup(page)
      const more = row(page, 'quotes-samsung.txt').getByTestId('file-menu')
      await more.click()
      await page.getByRole('menuitem', { name: t['files.move'] }).click()
      const picker = page.getByRole('dialog', { name: t['files.moveTitle'].replace('{name}', 'quotes-samsung.txt') })
      const hint = picker.getByTestId('move-suggested').getByTestId('move-hint')
      await expect(hint).toBeVisible()
      const x = picker.getByTestId('move-hint-dismiss')
      const box = (await x.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
      const dialogBox = (await picker.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
      await hint.click()
      await picker.getByTestId('folder-pick').click()
      await expect(picker).toHaveCount(0)
      await expect(row(page, 'quotes-samsung.txt')).toHaveCount(0)
    })
  }
})
