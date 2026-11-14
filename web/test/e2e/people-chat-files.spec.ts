// A file from the computer in a chat shared with people and groups (docs/DECISIONS.md "Files from the computer in a chat
// shared with people", QA TC-1413): the box offers the computer, the chip goes on as usual with one line under it
// ("이 채팅을 보는 사람은 모두 열 수 있어요"), ✕ before sending removes it on the server, and once sent the question carries the
// file kept with the chat (no team path): a document opens in the side panel through the chat, a picture shows its
// thumbnail. At 1440 and 390 px wide, with axe on each screen. The mock (test/mock/server.ts): POST /__test/people-chat
// makes a chat one shared with people; its uploads come back as Attachment source 'chat' and open through GET
// /api/chats/:id/files/:fileId.
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const SHOTS = process.env.SHOTS_DIR
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
const LINE = '이 채팅을 보는 사람은 모두 열 수 있어요'
const post = (page: Page, p: string, data: object) => page.request.post(p, { headers: { [CSRF_HEADER]: '1' }, data })

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }) }

/** Olga's chat with one question answered, then shared with people (the mock's control) */
async function peopleChat(page: Page) {
  const chat = (await (await post(page, '/api/chats', {})).json()) as { id: string }
  expect((await post(page, `/api/chats/${chat.id}/messages`, { content: '분기 예산 정리해 줘', clientMessageId: uuidv7() })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  expect((await post(page, '/__test/people-chat', { chatId: chat.id })).ok()).toBeTruthy()
  return chat.id
}

for (const [label, viewport] of [['1440', { width: 1440, height: 900 }], ['390', { width: 390, height: 844 }]] as const) {
  test.describe(`at ${label}`, () => {
    test.use({ viewport })

    test('attach from the computer: one line under the chips, ✕ removes it, sent it opens through the chat', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const chatId = await peopleChat(page)
      await page.goto(`/c/${chatId}`)
      // the chat's own box, once its messages are in (the box is that chat's from then on)
      await expect(page.getByTestId('user-message')).toHaveCount(1)
      await expect(page.getByTestId('composer-input')).toBeVisible()
      const chip = page.getByTestId('attachment-chip')
      const line = page.getByTestId('shared-upload-line')
      const memo = { name: '예산 메모.txt', mimeType: 'text/plain', buffer: Buffer.from('Q3 budget: 41% over plan') }

      // ✕ before sending: the chip and the line go, and the box asks the server to remove it
      await page.getByTestId('file-input').setInputFiles(memo)
      await expect(chip).toHaveAttribute('data-status', 'done')
      await expect(line).toHaveText(LINE)
      await audit(page, `box with a file (${label})`)
      const removed = page.waitForRequest((r) => r.method() === 'DELETE' && /\/api\/attachments\//.test(r.url()))
      await page.getByRole('button', { name: '예산 메모.txt 빼기' }).click()
      await removed
      await expect(chip).toHaveCount(0)
      await expect(line).toHaveCount(0)

      // a document and a picture, then sent
      await page.getByTestId('file-input').setInputFiles([memo, { name: '영수증.png', mimeType: 'image/png', buffer: PNG }])
      await expect(chip).toHaveCount(2)
      for (const c of await chip.all()) await expect(c).toHaveAttribute('data-status', 'done')
      await expect(line).toHaveText(LINE)
      await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0)
      // (axe is not run here: a picture tile's ✕ is the composer's own, outside this change)
      await shot(page, `${label}-composer.png`)
      await page.getByTestId('composer-input').fill('이 메모와 영수증 확인해 줘')
      await page.getByTestId('send').click()

      const q = page.getByTestId('user-message').last()
      const card = q.locator('[data-source="chat"]')
      await expect(card).toContainText('예산 메모.txt')
      await expect(q.getByTestId('attachment-image').locator('img')).toHaveJSProperty('complete', true)
      await expect.poll(() => q.getByTestId('attachment-image').locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0)
      await expect(line).toHaveCount(0)
      await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chatId}`)).json()) as { runState: string }).runState).toBe('idle')
      await q.scrollIntoViewIfNeeded()
      await shot(page, `${label}-sent.png`)
      await audit(page, `sent (${label})`)

      // the document opens in the side panel (a sheet on a phone), read through the chat
      const read = page.waitForResponse((r) => new RegExp(`/api/chats/${chatId}/files/`).test(r.url()))
      await card.click()
      expect((await read).status()).toBe(200)
      await expect(page.getByText('Q3 budget: 41% over plan')).toBeVisible()
      await shot(page, `${label}-preview.png`)
      await audit(page, `file preview (${label})`)
    })
  })
}
