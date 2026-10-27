import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { reset, signIn } from './helpers'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'

test('mobile login, file picker upload and CSV save use the existing app with a versioned native bridge', async ({ page }) => {
  await reset(page)
  await page.addInitScript(() => {
    const w = window as unknown as { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; mobileMessages: MobileMessage[] }
    w.mycelMobile = { protocol: 1, appVersion: '0.2.2', platform: 'ios', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1'] }
    w.mobileMessages = []
    w.ReactNativeWebView = { postMessage(raw) {
      const m = JSON.parse(raw) as MobileMessage
      w.mobileMessages.push(m)
      const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
      if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
    } }
  })
  const login = page.waitForRequest(r => r.url().endsWith('/api/auth/login') && r.method() === 'POST')
  await signIn(page)
  expect((await login).postDataJSON()).toMatchObject({ client: 'mobile' })
  await page.goto('/files?path=marketing')
  await page.getByTestId('files-input').setInputFiles({ name: 'mobile-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('mobile synthetic fixture') })
  await expect(page.getByTestId('file-row').filter({ hasText: 'mobile-upload.txt' })).toBeVisible()
  await page.goto('/admin/usage')
  await expect(page.getByTestId('usage-table')).toContainText('Olga')
  const downloads: string[] = []
  page.on('download', d => downloads.push(d.suggestedFilename()))
  await page.getByTestId('usage-csv').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { mobileMessages: MobileMessage[] }).mobileMessages.some(m => m.type === 'file-end'))).toBe(true)
  const messages = await page.evaluate(() => (window as unknown as { mobileMessages: MobileMessage[] }).mobileMessages)
  const begin = messages.find((m): m is Extract<MobileMessage, { type: 'file-begin' }> => m.type === 'file-begin')!
  const chunks = messages.filter((m): m is Extract<MobileMessage, { type: 'file-chunk' }> => m.type === 'file-chunk')
  const bytes = Buffer.concat(chunks.map(m => Buffer.from(m.b64, 'base64')))
  expect(begin.name).toMatch(/^usage-user-.*\.csv$/)
  expect(begin.size).toBe(bytes.length)
  expect(begin.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(bytes.toString('utf8')).toContain('Olga')
  expect(chunks.map(m => m.seq)).toEqual(chunks.map((_, i) => i))
  expect(messages.at(-1)).toMatchObject({ type: 'file-end', seq: chunks.length, id: begin.id, generation: begin.generation })
  expect(downloads).toEqual([])
})
