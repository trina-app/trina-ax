// A connection row with a chip keeps its name readable on a phone (QA TC-1549), and a room's message box has the same
// bordered frame on a phone as every other box (QA TC-1550). SHOTS_DIR=<folder> (and SHOTS_TAG) saves 390 and 1440 shots,
// light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ locale: 'en-US', serviceWorkers: 'block' })

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `${process.env.SHOTS_TAG ?? 'after'}-${name}.png`) })
}

const VIEWPORTS = [{ name: '390', size: { width: 390, height: 844 } }, { name: '1440', size: { width: 1440, height: 900 } }]

for (const vp of VIEWPORTS) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`a connection row with a chip keeps its name (${vp.name}, ${scheme})`, async ({ page }) => {
      await page.setViewportSize(vp.size)
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      const make = (name: string, host: string, users: string[]) => page.request.post('/api/admin/integrations', { headers: { [CSRF_HEADER]: '1' }, data: { kind: 'mcp', name, url: `https://mcp.${host}.example/mcp`, auth: 'none', access: { everyone: false, groups: [], users } } })
      expect((await make('QA-Fake Team3 only', 'qafake', ['nobody-here'])).status()).toBe(201)
      expect((await make('Sales MCP', 'sales', [])).status()).toBe(201)
      await page.goto('/admin/connectors')
      const line = page.getByTestId('team-connection').filter({ hasText: 'QA-Fake Team3 only' })
      await expect(line).toBeVisible()
      await shot(page, `connected-apps-${vp.name}-${scheme}`)
      // the whole name shows: not cut (no ellipsis) on any width
      const name = line.getByText('QA-Fake Team3 only', { exact: true })
      expect(await name.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
      await expect(line.getByTestId('integration-access-warning')).toBeVisible()
    })
  }
}

for (const vp of VIEWPORTS) {
  test(`a connected row's full name shows beside a status (${vp.name}) (QA TC-1549)`, async ({ page }) => {
    await page.setViewportSize(vp.size)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const long = 'QA-Fake Team3 Long Workspace Name'
    expect((await page.request.post('/api/admin/integrations', { headers: { [CSRF_HEADER]: '1' }, data: { kind: 'mcp', name: long, url: 'https://mcp.longname.example/mcp', auth: 'oauth', access: { everyone: false, groups: [], users: ['nobody-here'] } } })).status()).toBe(201)
    await page.goto('/admin/connectors')
    const row = page.getByTestId('team-connection').filter({ hasText: long })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('connector-row-status')).toBeVisible()
    await shot(page, `connected-status-${vp.name}`)
    const name = row.getByText(long, { exact: true })
    expect(await name.evaluate((e) => e.scrollWidth <= e.clientWidth && e.scrollHeight <= e.clientHeight)).toBe(true)
  })
}

for (const vp of VIEWPORTS) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`a room's message box is a frame (${vp.name}, ${scheme})`, async ({ page }) => {
      await page.setViewportSize(vp.size)
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await reset(page, { teamLocale: 'en' })
      await signIn(page)
      const sora = { id: 'sora', name: 'Sora' }
      await routeRoom(page, { members: [sora], messages: [{ id: '019a5f00-0000-7000-8000-000000000401', author: sora, body: 'Good morning.' }] })
      await page.goto(`/rooms/${ROOM_ID}`)
      const box = page.getByTestId('room-composer')
      await expect(box).toBeVisible()
      await shot(page, `room-box-${vp.name}-${scheme}`)
      expect(await box.evaluate((e) => parseFloat(getComputedStyle(e).borderTopWidth))).toBe(1)
      expect(await box.evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius))).toBeGreaterThan(8)
      // the AI chat's corner (24px) and side space (16px) (QA TC-1641)
      expect(await box.evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius))).toBe(24)
      if (vp.name === '390') expect(Math.round((await box.boundingBox())!.x)).toBe(16)
      // one line when only + and send: the plain box stays one row high
      if (vp.name === '390') expect((await box.boundingBox())!.height).toBeLessThanOrEqual(64)
    })
  }
}
