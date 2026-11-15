// A scheduled task's on/off and my status show at once (lib/optimistic.ts; docs/DECISIONS.md "Optimistic changes:
// the screen first, the server after"): the switch is flipped, and the status dialog is closed with my status shown,
// while the server has not answered yet (the test holds the request); a refusal puts the old value back with one toast.
// A computer and a phone.
import { expect, test, type Page, type Route } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { accountButton, isPhone, myStatusRow, openStatusDialog } from './nav'
import { DICTS } from '../../src/i18n'

test.use({ serviceWorkers: 'block' })

const t = DICTS.ko
const REFUSAL = JSON.stringify({ error: { code: 'internal', message: 'Acme server hiccup.' } })

/** Hold the requests to `url` with `method` until `release` (or answer them with a refusal). */
async function hold(page: Page, url: string, method: string, o: { refuse?: boolean } = {}) {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  let seen = false
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method) return route.fallback()
    seen = true
    await gate
    if (o.refuse) await route.fulfill({ status: 500, contentType: 'application/json', body: REFUSAL })
    else await route.continue()
  })
  return { release, seen: () => seen }
}

/** a scheduled task (the mock's owner, who signs in), and its id */
async function task(page: Page, enabled: boolean): Promise<string> {
  expect((await page.request.post('/__test/schedule', { data: { title: 'Acme weekly summary', enabled } })).ok()).toBeTruthy()
  const r = await page.request.get('/api/schedules')
  expect(r.ok()).toBeTruthy()
  const items = ((await r.json()) as { items: { id: string; title: string }[] }).items
  return items.find((x) => x.title === 'Acme weekly summary')!.id
}

async function enabledOnServer(page: Page, id: string) {
  const items = ((await (await page.request.get('/api/schedules')).json()) as { items: { id: string; enabled: boolean }[] }).items
  return items.find((x) => x.id === id)!.enabled
}

/** my status as the screen shows it: the emoji on my photo (a computer), the 나 tab's row (a phone) */
async function expectMyStatus(page: Page, emoji: string | null, words?: string) {
  if (!isPhone(page)) {
    const mine = accountButton(page).getByTestId('status-emoji')
    if (emoji) await expect(mine).toHaveText(emoji)
    else await expect(mine).toHaveCount(0)
    return
  }
  const row = await myStatusRow(page)
  if (emoji) await expect(row).toContainText(`${emoji}${words ?? ''}`)
  else await expect(row).toHaveText(t['status.set'])
}

async function saveFocusing(page: Page) {
  await openStatusDialog(page)
  // the footer's buttons are outside the form (status-dialog): the dialog by its name
  const dialog = page.getByRole('dialog', { name: t['status.title'] })
  await expect(page.getByTestId('status-dialog')).toBeVisible()
  await dialog.getByTestId('status-suggestion').filter({ hasText: '집중하는 중' }).click()
  await dialog.getByTestId('status-save').click()
  // the dialog closes at once, before the server answers
  await expect(dialog).toHaveCount(0)
}

async function clearStatus(page: Page) {
  await openStatusDialog(page)
  // the footer's buttons are outside the form (status-dialog): the dialog by its name
  const dialog = page.getByRole('dialog', { name: t['status.title'] })
  await expect(page.getByTestId('status-dialog')).toBeVisible()
  await dialog.getByTestId('status-clear').click()
  await expect(dialog).toHaveCount(0)
}

/** my status set on the server before the page loads */
async function presetStatus(page: Page) {
  const r = await page.request.put('/api/me/status', { headers: { [CSRF_HEADER]: '1' }, data: { emoji: '📅', text: 'Acme review', clear: 'never' } })
  expect(r.ok()).toBeTruthy()
}

for (const vp of [{ name: '1440', use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`optimistic settings at ${vp.name}`, () => {
    test.use(vp.use)

    test('a scheduled task off: the switch is off before the server answers, and stays off', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const id = await task(page, true)
      await page.goto(`/scheduled/${id}`)
      const toggle = page.getByTestId('schedule-toggle')
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      const held = await hold(page, `**/api/schedules/${id}`, 'PATCH')
      await toggle.click()
      await expect.poll(held.seen).toBe(true)
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      held.release()
      await expect.poll(() => enabledOnServer(page, id)).toBe(false)
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await page.reload()
      await expect(page.getByTestId('schedule-toggle')).toHaveAttribute('aria-checked', 'false')
    })

    test('a scheduled task on, refused: the switch is off again, with one error toast', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const id = await task(page, false)
      await page.goto(`/scheduled/${id}`)
      const toggle = page.getByTestId('schedule-toggle')
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      const held = await hold(page, `**/api/schedules/${id}`, 'PATCH', { refuse: true })
      await toggle.click()
      await expect.poll(held.seen).toBe(true)
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      held.release()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByText('Acme server hiccup.')).toHaveCount(1)
      expect(await enabledOnServer(page, id)).toBe(false)
    })

    test('my status saved: the dialog closes and my status shows before the server answers', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await expectMyStatus(page, null)
      const held = await hold(page, '**/api/me/status', 'PUT')
      await saveFocusing(page)
      await expect.poll(held.seen).toBe(true)
      await expectMyStatus(page, '🎧', '집중하는 중')
      held.release()
      await expect.poll(async () => ((await (await page.request.get('/api/me')).json()) as { user: { statusMessage?: { text: string } } }).user.statusMessage?.text).toBe('집중하는 중')
      await expectMyStatus(page, '🎧', '집중하는 중')
    })

    test('my status saved, refused: no status again, with one error toast', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const held = await hold(page, '**/api/me/status', 'PUT', { refuse: true })
      await saveFocusing(page)
      await expect.poll(held.seen).toBe(true)
      await expectMyStatus(page, '🎧', '집중하는 중')
      held.release()
      await expect(page.getByText('Acme server hiccup.')).toHaveCount(1)
      await expectMyStatus(page, null)
      await expect(page.getByText('Acme server hiccup.')).toHaveCount(1)
    })

    test('my status cleared: gone before the server answers, and stays gone', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await presetStatus(page)
      await page.reload()
      await expectMyStatus(page, '📅', 'Acme review')
      const held = await hold(page, '**/api/me/status', 'DELETE')
      await clearStatus(page)
      await expect.poll(held.seen).toBe(true)
      await expectMyStatus(page, null)
      held.release()
      await expect.poll(async () => ((await (await page.request.get('/api/me')).json()) as { user: { statusMessage?: unknown } }).user.statusMessage ?? null).toBeNull()
      await expectMyStatus(page, null)
    })

    test('my status cleared, refused: it comes back, with one error toast', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await presetStatus(page)
      await page.reload()
      await expectMyStatus(page, '📅', 'Acme review')
      const held = await hold(page, '**/api/me/status', 'DELETE', { refuse: true })
      await clearStatus(page)
      await expect.poll(held.seen).toBe(true)
      await expectMyStatus(page, null)
      held.release()
      await expect(page.getByText('Acme server hiccup.')).toHaveCount(1)
      await expectMyStatus(page, '📅', 'Acme review')
      await expect(page.getByText('Acme server hiccup.')).toHaveCount(1)
    })
  })
}
