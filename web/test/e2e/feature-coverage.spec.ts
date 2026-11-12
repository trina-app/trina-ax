// The feature map (docs/FEATURES.md) counts an endpoint a spec answers in the browser (page.route, rooms-mock.ts) like
// one the mock server answered: test/e2e/coverage-report.ts reports it to POST /__test/coverage.
import { expect, test } from '@playwright/test'
import { reset } from './helpers'

const count = async (page: import('@playwright/test').Page, name: string) => ((await (await page.request.post('/__test/coverage')).json()) as Record<string, number>)[name] ?? 0

test('an endpoint answered by page.route counts once; one the mock server answered is not counted twice', async ({ page }) => {
  await reset(page)
  await page.route('**/api/rooms/r9/messages/m9/thread', (r) => r.fulfill({ json: { items: [] } }))
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  const thread = await count(page, 'listRoomThread')
  const health = await count(page, 'health')
  await page.evaluate(async () => { await fetch('/api/rooms/r9/messages/m9/thread'); await fetch('/api/health') })
  await expect.poll(() => count(page, 'listRoomThread')).toBe(thread + 1)
  await expect.poll(() => count(page, 'health')).toBe(health + 1)
})
