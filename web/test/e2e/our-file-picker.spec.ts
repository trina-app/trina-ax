// Adding a file always starts from our sheet (docs/decisions/20261118-our-file-picker-everywhere.md). The owner on an
// iPhone: Files › 내 파일 › ⊕ › 올리기 opened iOS's raw "Photo Library / Take Photo or Video / Choose Files" menu, in
// English, from a file input that named no type. On a phone (390, touch) every add opens our localized sheet first and
// no file chooser; a row of it (components/DevicePick.tsx: 사진 보관함, 사진 찍기, 파일) then opens the phone's picker.
// A computer (1440) keeps its buttons: Upload opens the computer's file window at once. Shots: QA_SHOTS=<dir>.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { makePng } from '../../../tests/lib/images'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const H = { [CSRF_HEADER]: '1' }
const SHOTS = process.env.QA_SHOTS

async function file(page: Page, path: string, text = 'x') {
  expect((await page.request.post('/__test/file', { headers: H, data: { path, text } })).ok()).toBeTruthy()
}
/** counts the file choosers the page opens */
function choosers(page: Page) {
  const seen = { n: 0 }
  page.on('filechooser', () => { seen.n++ })
  return seen
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
const sheetRows = (page: Page) => page.getByRole('menu').getByRole('menuitem')
const DEVICE = [t['composer.photos'], t['composer.camera'], t['composer.files']]

test.describe('a phone (390)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('Files ⊕: our sheet (새 폴더 and the device rows), no file chooser; 파일 then opens one and uploads', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await file(page, 'groups/leads/a.txt')
    await page.goto('/files?path=groups%2Fleads')
    const seen = choosers(page)
    await page.getByTestId('files-add').click()
    await expect(sheetRows(page)).toHaveText([t['files.newFolder'], ...DEVICE])
    // the sheet is the app's: across the screen, on its bottom, 44 px rows at least
    const box = (await page.getByRole('menu').boundingBox())!
    expect(Math.round(box.width)).toBe(390)
    expect(Math.round(box.y + box.height)).toBe(844)
    for (const item of await sheetRows(page).all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await page.waitForTimeout(300)
    expect(seen.n).toBe(0)
    await shot(page, 'files-add-390')
    // the rows' inputs: several photos and videos, the camera, several files (any type off iOS)
    await expect(page.getByTestId('files-add-photos-input')).toHaveAttribute('accept', 'image/*,video/*')
    await expect(page.getByTestId('files-add-photos-input')).toHaveAttribute('multiple', '')
    await expect(page.getByTestId('files-add-camera-input')).toHaveAttribute('capture', 'environment')
    await expect(page.getByTestId('files-add-files-input')).toHaveAttribute('multiple', '')
    await expect(page.getByTestId('files-add-files-input')).not.toHaveAttribute('accept')
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId('files-add-files').click()
    const c = await chooser
    expect(c.isMultiple()).toBe(true)
    await c.setFiles([{ name: '견적-1.txt', mimeType: 'text/plain', buffer: Buffer.from('quote') }])
    await expect(page.getByTestId('file-row').filter({ hasText: '견적-1.txt' })).toBeVisible()
  })

  test('an empty folder\'s 올리기: the same sheet, without 새 폴더', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await file(page, 'groups/leads/a.txt')
    expect((await page.request.post('/api/files/mkdir', { headers: H, data: { path: 'groups/leads/empty' } })).ok()).toBeTruthy()
    await page.goto('/files?path=groups%2Fleads%2Fempty')
    const seen = choosers(page)
    await page.getByTestId('files-empty-upload').click()
    await expect(sheetRows(page)).toHaveText(DEVICE)
    await page.waitForTimeout(300)
    expect(seen.n).toBe(0)
    await shot(page, 'files-empty-upload-390')
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('menu').getByTestId('files-add-photos').click()
    await (await chooser).setFiles([{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(makePng(32, 32)) }])
    await expect(page.getByTestId('file-row').filter({ hasText: 'photo.png' })).toBeVisible()
  })

  test('profile photo: our sheet first; 사진 보관함 then the picker, one picture', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/settings/profile')
    const seen = choosers(page)
    await page.getByTestId('profile-photo-pick').click()
    await expect(sheetRows(page)).toHaveText(DEVICE)
    await page.waitForTimeout(300)
    expect(seen.n).toBe(0)
    await shot(page, 'profile-photo-390')
    await expect(page.getByTestId('profile-photo-photos-input')).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp')
    await expect(page.getByTestId('profile-photo-photos-input')).not.toHaveAttribute('multiple')
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('menu').getByTestId('profile-photo-photos').click()
    const c = await chooser
    expect(c.isMultiple()).toBe(false)
    await c.setFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(makePng(256, 256)) })
    await expect(page.getByTestId('profile-photo-preview')).toBeVisible()
  })

  test('team logo: the upload row opens our sheet (사진 보관함, 파일; no camera), then the picker', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/admin/settings/general')
    const upload = page.getByTestId('team-icon-upload')
    await upload.scrollIntoViewIfNeeded()
    const seen = choosers(page)
    await upload.click()
    await expect(sheetRows(page)).toHaveText([t['composer.photos'], t['composer.files']])
    await page.waitForTimeout(300)
    expect(seen.n).toBe(0)
    await shot(page, 'team-logo-390')
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('menu').getByTestId('team-icon-files').click()
    await (await chooser).setFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng(256, 256)) })
    await expect(page.getByText(t['teamIcon.saved'])).toBeVisible()
  })
})

test.describe('a computer (1440)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('Files: Upload opens the computer\'s file window at once, as before', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await file(page, 'groups/leads/a.txt')
    await page.goto('/files?path=groups%2Fleads')
    await shot(page, 'files-1440')
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId('upload-button').click()
    const c = await chooser
    expect(c.isMultiple()).toBe(true)
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('profile photo and team logo: their buttons open the file window at once', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/settings/profile')
    await shot(page, 'profile-photo-1440')
    let chooser = page.waitForEvent('filechooser')
    await page.getByTestId('profile-photo-pick').click()
    await chooser
    await page.goto('/admin/settings')
    await shot(page, 'team-logo-1440')
    chooser = page.waitForEvent('filechooser')
    await page.getByTestId('team-icon-upload').click()
    await chooser
  })
})
