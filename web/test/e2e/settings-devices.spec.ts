// Settings › Security & devices (pages/Settings.tsx Security): the device list follows what the server ended. A password
// change signs out every other device, so the list is read again and shows only this one; a row whose device was
// already signed out elsewhere (Sign out answers 404) disappears instead of showing "Not found".
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { OWNER, reset, signIn } from './helpers'

const t = DICTS.en
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const at = new Date().toISOString()
const session = (n: number, current = false) => ({ id: `0192f0a0-0000-7000-8000-00000000000${n}`, client: 'web', userAgent: UA, createdAt: at, lastSeenAt: at, expiresAt: at, current })

/** the server's sessions of this person: this device and two others, until a password change ends the others */
async function sessions(page: Page) {
  let list = [session(0, true), session(1), session(2)]
  await page.route(/\/api\/me\/sessions$/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: list }) }))
  await page.route(/\/api\/me\/sessions\/[^/]+$/, (r) => {
    const id = r.request().url().split('/').pop()
    if (!list.some((s) => s.id === id)) return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'Not found or no access.' } }) })
    list = list.filter((s) => s.id !== id)
    return r.fulfill({ status: 204, body: '' })
  })
  return { endOthers: () => { list = list.filter((s) => s.current) } }
}

test('a password change reads the devices again: only this device is left', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const s = await sessions(page)
  // the server ends the other sessions when the password changes (routes/auth.ts changePassword)
  await page.route(/\/api\/auth\/password$/, async (r) => { const res = await r.fetch(); if (res.ok()) s.endOthers(); await r.fulfill({ response: res }) })
  await page.goto('/settings/security')
  const rows = page.getByTestId('device-name')
  await expect(rows).toHaveCount(3)
  await page.getByLabel(t['auth.currentPassword']).fill(OWNER.password)
  await page.getByLabel(t['auth.newPassword'], { exact: true }).fill('another horse battery')
  await page.getByLabel(t['auth.passwordAgain']).fill('another horse battery')
  await page.getByRole('button', { name: t['auth.changePassword'] }).click()
  await expect(page.getByText(t['settings.passwordChanged'])).toBeVisible()
  await expect(rows).toHaveCount(1)
  await expect(page.getByTestId('device-sign-out')).toHaveCount(0)
})

test('signing out a device that is already gone removes its row without an error', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const s = await sessions(page)
  await page.goto('/settings/security')
  await expect(page.getByTestId('device-name')).toHaveCount(3)
  s.endOthers() // ended on another device meanwhile; this page still shows them
  await page.getByTestId('device-sign-out').first().click()
  await expect(page.getByTestId('device-name')).toHaveCount(1)
  await expect(page.getByText('Not found or no access.')).toHaveCount(0)
})
