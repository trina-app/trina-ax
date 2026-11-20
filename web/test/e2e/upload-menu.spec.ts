// Files on a computer: one 올리기 for files and folders (owner 11-20, docs/decisions/20261118-our-file-picker-everywhere.md
// note of 11-20). Where the folder can be written and the browser picks folders, 올리기 opens a small menu (파일 올리기 /
// 폴더 올리기); a browser with no folder picker gets the plain button, straight to the file window; a read-only folder
// the plain button, off. (The keyboard after the computer's own window closes is the browser's, not tested here.)
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const SHOTS = process.env.UPLOAD_SHOTS

test.use({ viewport: { width: 1440, height: 900 } })

const items = (page: Page) => page.getByRole('menu').getByRole('menuitem')

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('올리기 opens a menu of 파일 올리기 and 폴더 올리기; the keyboard moves in it and Esc gives it back to the button', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  const button = page.getByTestId('upload-button')
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute('aria-haspopup', 'menu')
  await expect(page.getByTestId('upload-button-caret')).toBeVisible()
  // the old toolbar button is gone: 폴더 올리기 is only in the menu
  await expect(page.getByTestId('folder-upload-button')).toHaveCount(0)
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(items(page)).toHaveText([t['files.uploadFiles'], t['files.uploadFolder']])
  await expect(page.getByTestId('upload-files')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('folder-upload-button')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(button).toBeFocused()
  await page.keyboard.press(' ')
  await expect(items(page)).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(button).toBeFocused()

  // 폴더 올리기: the computer's folder window
  await button.click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('folder-upload-button').click()
  const c = await chooser
  expect(await c.element().getAttribute('data-testid')).toBe('folder-input')
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('a browser that picks no folders: 올리기 is the plain button, straight to the file window', async ({ page }) => {
  await page.addInitScript(() => {
    delete (HTMLInputElement.prototype as { webkitdirectory?: boolean }).webkitdirectory
  })
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  const button = page.getByTestId('upload-button')
  await expect(button).toBeEnabled()
  await expect(button).not.toHaveAttribute('aria-haspopup', 'menu')
  await expect(page.getByTestId('upload-button-caret')).toHaveCount(0)
  const chooser = page.waitForEvent('filechooser')
  await button.click()
  const c = await chooser
  expect(c.isMultiple()).toBe(true)
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('a read-only folder: 올리기 is off, with no menu', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=finance')
  await expect(page.getByText('읽기 전용 폴더')).toBeVisible()
  const button = page.getByTestId('upload-button')
  await expect(button).toBeDisabled()
  await expect(button).not.toHaveAttribute('aria-haspopup', 'menu')
  await expect(page.getByTestId('upload-button-caret')).toHaveCount(0)
  await expect(page.getByRole('menu')).toHaveCount(0)
})

// screenshots for review (UPLOAD_SHOTS=<dir>): the toolbar and the open menu at 1440 and 390, light and dark
test('screenshots', async ({ page }) => {
  test.skip(!SHOTS, 'only with UPLOAD_SHOTS')
  await reset(page)
  await signIn(page)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width > 400 ? 900 : 844 })
    await page.goto('/files?path=marketing')
    await expect(page.getByTestId('file-table').or(page.getByText(t['files.emptyDrop']))).toBeVisible()
    await shot(page, `toolbar-${width}`)
    // the menu: 올리기's on a computer; a phone's is its ⊕ sheet (unchanged)
    const open = width > 400 ? page.getByTestId('upload-button') : page.getByTestId('files-add')
    if (width > 400 && (await open.getAttribute('aria-haspopup')) !== 'menu') continue
    await open.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await shot(page, `menu-${width}`)
    await page.keyboard.press('Escape')
  }
})
