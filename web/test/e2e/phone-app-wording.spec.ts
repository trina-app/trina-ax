// QA TC-264: inside the phone app (a WebView with the app's bridge, lib/mobile.ts) a blocked mic points to the phone's
// Settings with a button that opens them, never to "the browser's settings"; a browser keeps the browser words. A
// folder's ⋯ menu starts "a chat with this folder", not "this file". On a computer (1440) and a phone (390×844).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'

const BROWSER_NOTE = '마이크 사용이 막혀 있어요. 브라우저 설정에서 마이크를 허용해 주세요.'
const IOS_NOTE = /^마이크 사용이 막혀 있어요\. iPhone의 설정 › .+에서 마이크를 켜 주세요\./

/** the microphone was refused (as by the browser or by the phone's Settings) */
const micRefused = (page: Page) => page.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
})
/** the phone app's bridge, as the iPhone app installs it before the page's own scripts */
const phoneApp = (page: Page) => page.addInitScript(() => {
  const w = window as unknown as { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; mobileMessages: MobileMessage[] }
  w.mycelMobile = { protocol: 1, appVersion: '0.3.0', platform: 'ios', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', 'push-permission-v1'] }
  w.mobileMessages = []
  w.ReactNativeWebView = { postMessage(raw) {
    const m = JSON.parse(raw) as MobileMessage
    w.mobileMessages.push(m)
    const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
    if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
  } }
})
const sentToApp = (page: Page) => page.evaluate(() => (window as unknown as { mobileMessages: { type: string }[] }).mobileMessages.map((m) => m.type))
const mic = (page: Page) => page.getByRole('button', { name: /^음성/ })

for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${size.width}×${size.height}`, () => {
    test.use({ viewport: size })

    test('a browser: a blocked mic says to allow it in the browser settings, with no Settings button', async ({ page }) => {
      await reset(page)
      await micRefused(page)
      await signIn(page)
      await mic(page).click()
      await expect(page.getByRole('alert').filter({ hasText: '마이크' })).toHaveText(BROWSER_NOTE)
      await expect(page.getByTestId('voice-open-settings')).toHaveCount(0)
      await page.screenshot({ path: `../../shots/mic-browser-${size.width}.png` })
    })

    test("the phone app: a blocked mic points to the phone's Settings, and the button opens them", async ({ page }) => {
      await reset(page)
      await phoneApp(page)
      await micRefused(page)
      await signIn(page)
      await mic(page).click()
      const note = page.getByRole('alert').filter({ hasText: '마이크' })
      await expect(note).toContainText(IOS_NOTE)
      await expect(note).not.toContainText('브라우저')
      await page.screenshot({ path: `../../shots/mic-app-${size.width}.png` })
      await note.getByTestId('voice-open-settings').click()
      await expect.poll(() => sentToApp(page)).toContain('open-settings')
    })

    test("a folder's ⋯ menu starts a chat with this folder; a file's asks about the file", async ({ page }) => {
      await reset(page)
      await signIn(page)
      await page.goto('/files')
      const folder = page.getByTestId('file-row').filter({ hasText: 'marketing' }).first()
      await folder.hover()
      await folder.getByTestId('file-menu').click()
      await expect(page.getByTestId('chat-with-file')).toHaveText('이 폴더로 채팅 시작')
      await page.screenshot({ path: `../../shots/folder-menu-${size.width}.png` })
      await page.keyboard.press('Escape')
      await page.goto('/files?path=marketing')
      const file = page.getByTestId('file-row').filter({ hasText: 'notes.txt' }).first()
      await file.hover()
      await file.getByTestId('file-menu').click()
      await expect(page.getByTestId('chat-with-file')).toHaveText('AI에게 이 파일 물어보기')
    })
  })
}
