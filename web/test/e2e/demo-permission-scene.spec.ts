// The promo film's permission scene in the free-roam demo, the real product's way (docs/decisions/
// 20261122-demo-permission-scene.md): Home's fourth chip "Show me the management folder" asks for a folder Mina cannot
// open; the answer says it can't find one among her folders (never that it exists) and the card under it,
// "Folders your AI can see", lists only the folders she can open with their access, each a link to Files. At 1440 and
// 390, it fits the screen. The mock answers like a free-roam instance (as demo-free-roam.spec.ts) and scripts the turn
// ("management folder": web/test/mock/server.ts). SHOTS_DIR=<folder> saves each state; "… before" is the answer as it
// was before this card.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { DemoInfo } from '@mycel/shared/api'
import { reset } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
const INFO: DemoInfo = {
  company: 'Steepling', sameQuestion: null, current: 'newHire', network: false, kind: 'freeRoam', used: 0, cap: 300_000, signupUrl: 'https://example.com/pricing',
  personas: [{ key: 'newHire', name: 'Mina', team: 'Marketing', intro: 'Your first day at Steepling.', questions: [] }],
  // scripts/demo/steepling/strings/en.ts suggestions
  freeRoam: { suggestions: [
    { label: 'Draft next week\'s posts', prompt: 'Draft the two empty slots in next week\'s social calendar' },
    { label: 'Summarize customer reviews', prompt: 'Summarize the latest customer reviews' },
    { label: 'Did Chris reply?', prompt: 'Did Chris reply to my email? Check my Gmail' },
    { label: 'Show me the management folder', prompt: 'Show me the management folder' },
  ] },
}
const FEATURES_OFF = { connectionChange: false, selfUpdate: false, officeUpdate: false, connectedFolders: false, apiEngineAnyUrl: false, hostDiagnostics: false, pluginFileInstall: false }

async function freeRoam(page: Page) {
  await page.route('**/api/demo', (r) => r.fulfill({ json: INFO }))
  await page.route('**/api/me', async (r) => {
    const res = await r.fetch()
    if (!res.ok()) return r.fulfill({ response: res })
    const me = await res.json()
    me.server = { ...me.server, dev: false, deployment: 'self', features: FEATURES_OFF }
    me.user = { ...me.user, username: 'mina', name: 'Mina', email: 'mina@steepling.example' }
    me.team = { ...me.team, name: 'Steepling' }
    await r.fulfill({ response: res, json: me })
  })
  const login = await page.request.post('/api/auth/login', { headers: { 'x-mycel-csrf': '1' }, data: { ...BOB, tokenMode: 'cookie' } })
  expect(login.ok()).toBeTruthy()
}
async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `${name}-${page.viewportSize()!.width}.png`) })
}

for (const width of [1440, 390] as const) {
  test.describe(`${width}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await freeRoam(page)
    })

    test('the chip, the "can\'t find" answer and the card of the folders her AI can see', async ({ page }) => {
      await page.goto('/')
      const chip = page.getByTestId('free-roam-chip').filter({ hasText: 'Show me the management folder' })
      await expect(page.getByTestId('free-roam-chip')).toHaveCount(4)
      await shot(page, 'after-home')
      await chip.click()
      const answer = page.getByTestId('assistant-message').last()
      await expect(answer).toContainText('I can\'t find a "management" folder among the folders open to you')
      const card = answer.getByTestId('my-folders-card')
      await expect(card.getByTestId('action-card-title')).toHaveText('Folders your AI can see')
      await expect(card.getByTestId('my-folders-card-folder')).toHaveCount(4)
      await expect(card.getByTestId('my-folders-card-access')).toHaveText(['Can edit', 'Can edit', 'Read only', 'Can edit'])
      // nothing about the folder she asked for: no lock, no "not open to you"
      await expect(card).not.toContainText(/management|not open/i)
      const box = (await card.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await card.scrollIntoViewIfNeeded()
      await shot(page, 'after-answer')
      // a row opens the folder in Files
      await card.getByTestId('my-folders-card-folder').nth(1).click()
      await expect(page).toHaveURL(/\/files\?path=groups%2FMarketing/)
    })

    test('before: the same question answered with one line and no card', async ({ page }) => {
      await page.goto('/')
      await page.getByTestId('composer-input').fill('Show me the management folder (before)')
      await page.getByTestId('send').click()
      const answer = page.getByTestId('assistant-message').last()
      await expect(answer).toContainText('I couldn\'t find a "management" folder')
      await expect(answer.getByTestId('my-folders-card')).toHaveCount(0)
      await shot(page, 'before-answer')
    })
  })
}
