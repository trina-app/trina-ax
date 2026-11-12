// QA TC-133: a member asks an admin to add any service of the app's list (here Notion), takes it back and asks again;
// the admin sees it in Activity and in Admin › Connectors ("Asked by members"), adds it for the team from there with
// the usual "Connect for the team", and the member is told it is ready; another request is dismissed.
import { expect, test } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }

test('member asks for Notion, takes it back, asks again; the admin adds it for the team; the member is told', async ({ page }) => {
  await reset(page)
  await page.context().route('https://auth.example.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>Sign in</title><p>Synthetic sign-in page</p>' }))
  const errors = watchConsole(page)
  await signIn(page, BOB)
  await page.goto('/connectors/notion')
  const detail = page.getByTestId('connector-detail')
  // members may add their own here: Connect stays, the ask for the team's is a line under it
  await expect(detail.getByTestId('connector-connect')).toBeVisible()
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/integrations/service-requests') && r.method() === 'POST')
  await detail.getByTestId('service-ask').click()
  expect((await sent).postDataJSON()).toEqual({ service: 'notion' })
  await expect(detail.getByTestId('service-asked')).toHaveAttribute('data-state', 'sent')
  await expect(detail.getByTestId('service-asked-note')).toBeVisible()
  // taken back: the ask again; then asked again
  await detail.getByTestId('service-withdraw').click()
  await expect(detail.getByTestId('service-asked')).toHaveCount(0)
  await detail.getByTestId('service-ask').click()
  await expect(detail.getByTestId('service-asked')).toHaveAttribute('data-state', 'sent')
  await expect(detail).not.toContainText('Olga')

  // the admin: the notice opens Notion's page in Admin; the list shows who asked, with Add
  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/activity')
  const notice = page.getByTestId('notification-service-request-link')
  await expect(notice.getByTestId('notification-text')).toContainText('Notion')
  await notice.click()
  await expect(page).toHaveURL(/\/admin\/connectors\/notion$/)
  await page.goto('/admin/connectors')
  const asked = page.locator('[data-testid="member-ask"][data-service="notion"]')
  await expect(asked).toContainText('Bob')
  await asked.getByTestId('member-ask-add').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('connector-summary')).toContainText('https://mcp.notion.com/mcp')
  // who may use it: everyone (a team connection Bob may not use would leave his request open)
  await dialog.getByTestId('integration-advanced').click()
  await dialog.getByTestId('integration-access-everyone').check()
  const popup = page.waitForEvent('popup')
  await dialog.getByTestId('integration-save').click()
  // saved, it still needs its sign-in: the request waits (a broken connection never says "ready")
  await popup
  // the sign-in finishes: the team's Notion works, and the request closes
  await expect.poll(async () => ((await (await page.request.get('/api/admin/integrations')).json()).items as { url: string; status: string }[])
    .find((i) => i.url.startsWith('https://mcp.notion.com'))?.status, { timeout: 15_000 }).toBe('connected')
  await page.goto('/admin/connectors')
  await expect(page.getByTestId('connector-discover')).toBeVisible()
  await expect(page.getByTestId('member-asks')).toHaveCount(0)

  // the member: it is ready, and the page offers no ask any more
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/activity')
  const ready = page.getByTestId('notification-service-ready-link')
  await expect(ready.getByTestId('notification-text')).toContainText('Notion')
  await ready.click()
  await expect(page).toHaveURL(/\/connectors\/notion$/)
  await expect(page.getByTestId('service-ask')).toHaveCount(0)
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})

test('members may not add their own: the ask is the page\'s action; the admin dismisses it and the member may ask again', async ({ page }) => {
  await reset(page)
  await signIn(page)
  expect((await page.request.patch('/api/admin/settings', { headers: { [CSRF_HEADER]: '1' }, data: { personalIntegrations: false } })).ok()).toBeTruthy()
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/connectors/linear')
  const detail = page.getByTestId('connector-detail')
  await expect(detail.getByTestId('connector-connect')).toHaveCount(0)
  await detail.getByTestId('service-ask').click()
  await expect(detail.getByTestId('service-asked')).toHaveAttribute('data-state', 'sent')

  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/admin/connectors')
  const asked = page.locator('[data-testid="member-ask"][data-service="linear"]')
  await asked.getByTestId('member-ask-dismiss').click()
  await expect(page.getByTestId('member-asks')).toHaveCount(0)

  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/connectors/linear')
  await expect(page.getByTestId('service-ask')).toBeVisible()
})
