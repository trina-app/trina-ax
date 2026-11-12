// TEMPORARY (not committed): screenshots of Admin › Connectors.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const OUT = '/private/tmp/claude-501/-Users-potenlab-potenlab-trina-trina-ax/bf3718e9-1e4d-46b8-a23d-03a99c3b83aa/scratchpad/shots'
const TAG = process.env.SHOT_TAG ?? 'before'

async function setUp(page: Page, w: number) {
  await page.setViewportSize({ width: w, height: w > 500 ? 1000 : 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await reset(page, { teamLocale: 'en' })
  await page.request.post('/__test/drive-client', { data: { on: true } })
  await page.request.post('/__test/google-apps', { data: { client: 'app' } })
  // Gmail: Google sign-in from the hosting service
  await page.route('**/api/admin/google-apps', async (r) => {
    const res = await r.fetch(); const j = await res.json()
    j.apps = j.apps.map((a: Record<string, unknown>) => (a.id === 'gmail' ? { ...a, configured: true, source: 'service', canSetUp: false, blocked: 'hosted', redirectUri: null } : a))
    await r.fulfill({ json: j })
  })
  await signIn(page)
  const res = await page.request.post('/api/admin/integrations', { headers: { [CSRF_HEADER]: '1' }, data: { kind: 'mcp', name: 'Company PM', url: 'https://mcp.pm.example/mcp', auth: 'none', access: { everyone: true, groups: [], users: [] } } })
  expect(res.status()).toBe(201)
  return (await res.json()).id as string
}
const shot = async (page: Page, name: string) => { await page.waitForTimeout(600); await page.screenshot({ path: `${OUT}/${TAG}-admin-${name}.png`, fullPage: true }) }

for (const w of [1440, 390]) {
  test(`admin connectors ${w}`, async ({ page }) => {
    const id = await setUp(page, w)
    await page.goto('/admin/connectors')
    await expect(page.getByTestId('connectors-header')).toBeVisible()
    await shot(page, `list-${w}-dark`)
    await page.goto('/admin/connectors/google-drive')
    await page.waitForTimeout(800)
    await shot(page, `drive-${w}-dark`)
    await page.goto('/admin/connectors/gmail')
    await page.waitForTimeout(800)
    await shot(page, `gmail-broker-${w}-dark`)
    if (TAG === 'before') {
      await page.goto('/admin/connectors')
      const row = page.getByTestId('integration-row').filter({ hasText: 'Company PM' })
      await row.getByTestId('integration-toggle').click()
      await shot(page, `mcp-${w}-dark`)
    } else {
      await page.goto(`/admin/connectors/mcp/${id}`)
      await page.waitForTimeout(800)
      await shot(page, `mcp-${w}-dark`)
    }
  })
}
