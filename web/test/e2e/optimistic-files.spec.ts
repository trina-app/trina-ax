// A file's rename and move show at once (store/fileChanges.ts; docs/DECISIONS.md "Optimistic projects and files"): the
// row has its new name, or is gone from the folder, while the server has not answered yet (the test holds the request),
// and a refusal puts it back with one error toast. A computer and a phone.
import { expect, test, type Page, type Route } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name })
async function rowMenu(page: Page, name: string, item: string) {
  const r = row(page, name).first()
  await r.hover()
  await r.getByTestId('file-menu').click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

/** Hold POST /api/files/move until `release` (or answer it with a refusal). */
async function holdMove(page: Page, o: { refuse?: boolean } = {}) {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  let seen = false
  await page.route('**/api/files/move', async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    seen = true
    await gate
    if (o.refuse) await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'conflict', message: 'Acme refused the move.' } }) })
    else await route.continue()
  })
  return { release, seen: () => seen }
}

const errorToasts = (page: Page) => page.getByTestId('toast').filter({ hasText: 'Acme refused the move.' })

for (const vp of [{ name: '1440', use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`optimistic file changes at ${vp.name}`, () => {
    test.use(vp.use)

    test('rename: the row has the new name before the server answers, and keeps it after a reload', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await page.goto('/files?path=marketing')
      await expect(row(page, 'notes.txt')).toBeVisible()
      const held = await holdMove(page)
      await rowMenu(page, 'notes.txt', t['files.rename'])
      await page.getByTestId('dialog-input').fill('acme-notes.txt')
      await page.getByTestId('dialog-confirm').click()
      await expect.poll(held.seen).toBe(true)
      await expect(row(page, 'acme-notes.txt')).toBeVisible()
      await expect(page.getByTestId('file-row').filter({ hasText: /^notes\.txt/ })).toHaveCount(0)
      held.release()
      await page.waitForTimeout(300)
      await page.reload()
      await expect(row(page, 'acme-notes.txt')).toBeVisible()
    })

    test('rename refused: the old name comes back with one error toast', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await page.goto('/files?path=marketing')
      await expect(row(page, 'notes.txt')).toBeVisible()
      const held = await holdMove(page, { refuse: true })
      await rowMenu(page, 'notes.txt', t['files.rename'])
      await page.getByTestId('dialog-input').fill('acme-notes.txt')
      await page.getByTestId('dialog-confirm').click()
      await expect.poll(held.seen).toBe(true)
      await expect(row(page, 'acme-notes.txt')).toBeVisible()
      held.release()
      await expect(row(page, 'notes.txt')).toBeVisible()
      await expect(row(page, 'acme-notes.txt')).toHaveCount(0)
      await expect(errorToasts(page)).toHaveCount(1)
    })

    for (const refuse of [false, true]) {
      test(`move${refuse ? ' refused' : ''}: the row leaves the folder before the server answers${refuse ? ', and comes back with one error toast' : ''}`, async ({ page }) => {
        await reset(page)
        await signIn(page)
        expect((await page.request.post('/api/files/mkdir', { headers: { [CSRF_HEADER]: '1' }, data: { path: 'marketing/archive' } })).ok()).toBe(true)
        await page.goto('/files?path=marketing')
        await expect(row(page, 'notes.txt')).toBeVisible()
        const held = await holdMove(page, { refuse })
        await rowMenu(page, 'notes.txt', t['files.move'])
        const picker = page.getByRole('dialog')
        await picker.getByRole('button', { name: 'archive' }).click()
        await picker.getByTestId('folder-pick').click()
        await expect.poll(held.seen).toBe(true)
        await expect(row(page, 'notes.txt')).toHaveCount(0)
        held.release()
        if (refuse) {
          await expect(row(page, 'notes.txt')).toBeVisible()
          await expect(errorToasts(page)).toHaveCount(1)
        } else {
          await page.waitForTimeout(300)
          await page.reload()
          await expect(row(page, 'data.csv')).toBeVisible()
          await expect(row(page, 'notes.txt')).toHaveCount(0)
          await page.goto('/files?path=marketing%2Farchive')
          await expect(row(page, 'notes.txt')).toBeVisible()
        }
      })
    }
  })
}
