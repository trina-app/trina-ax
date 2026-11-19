// QA TC-264: inside the phone app (a WebView with the app's bridge, lib/mobile.ts) a blocked mic points to the phone's
// Settings with a link that opens them (in the calm notice, never red), never to "the browser's settings"; a browser
// keeps the browser words. A folder's ⋯ menu starts "a chat with this folder", not "this file". On a computer (1440)
// and a phone (390×844).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'
import { DICTS, type MessageKey } from '../../src/i18n'
import { aiName } from '../../src/lib/tabs'

const ko = DICTS.ko
/** a file's "ask about this file": the AI called by its name (트리나 in the Trina edition) */
const ASK_FILE = ko['files.askAi'].replace('{name}', aiName((k: MessageKey) => ko[k]))

const BROWSER_NOTE = '마이크 사용이 막혀 있어요. 브라우저 설정에서 마이크를 허용해 주세요.'
const IOS_NOTE = /^마이크 사용이 막혀 있어요\. iPhone의 설정 › .+에서 마이크를 켜 주세요\./

/** the microphone was refused (as by the browser or by the phone's Settings), and the browser says it is blocked
 * (`denied`) or would still ask (`prompt`: the question was closed) */
const micRefused = (page: Page, state: PermissionState = 'denied') => page.addInitScript((state) => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
  const query = navigator.permissions.query.bind(navigator.permissions)
  navigator.permissions.query = (d) => d.name === ('microphone' as PermissionName) ? Promise.resolve({ state, addEventListener() {}, removeEventListener() {} } as unknown as PermissionStatus) : query(d)
}, state)
/** the microphone is allowed but does not open: the Android app 1.0.8, whose WebView lacked a permission (QA TC-4740) */
const micFails = (page: Page, name: string) => page.addInitScript((name) => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Could not start audio source', name))
}, name)
/** the phone app's bridge, as the iPhone app installs it before the page's own scripts */
const phoneApp = (page: Page, platform: 'ios' | 'android' = 'ios') => page.addInitScript((platform) => {
  const w = window as unknown as { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; mobileMessages: MobileMessage[] }
  w.mycelMobile = { protocol: 1, appVersion: '0.3.0', platform, generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', 'push-permission-v1'] }
  w.mobileMessages = []
  w.ReactNativeWebView = { postMessage(raw) {
    const m = JSON.parse(raw) as MobileMessage
    w.mobileMessages.push(m)
    const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
    if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
  } }
}, platform)
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
      // a blocked mic is a setting to change: the calm notice, never red
      await expect(page.getByTestId('composer-mic-blocked')).toHaveText(BROWSER_NOTE)
      await expect(page.getByRole('alert').filter({ hasText: '마이크' })).toHaveCount(0)
      await expect(page.getByTestId('voice-open-settings')).toHaveCount(0)
      await page.screenshot({ path: `../../shots/mic-browser-${size.width}.png` })
    })

    test('a browser: a question closed without an answer says to tap the mic again, not "blocked"', async ({ page }) => {
      await reset(page)
      await micRefused(page, 'prompt')
      await signIn(page)
      await mic(page).click()
      await expect(page.getByRole('alert').filter({ hasText: '마이크' })).toHaveText(ko['voice.notAllowed'])
      await expect(page.getByTestId('voice-open-settings')).toHaveCount(0)
    })

    test('a browser: a microphone that is missing or busy is said as such, never "blocked"', async ({ page }) => {
      await reset(page)
      await micFails(page, 'NotReadableError')
      await signIn(page)
      await mic(page).click()
      await expect(page.getByRole('alert').filter({ hasText: '마이크' })).toHaveText(ko['voice.micFailed'])
    })

    test('the Android app: the microphone allowed but not opening says it could not start, with no Settings button (TC-4740)', async ({ page }) => {
      await reset(page)
      await phoneApp(page, 'android')
      await micFails(page, 'NotFoundError')
      await signIn(page)
      await mic(page).click()
      const note = page.getByRole('alert').filter({ hasText: '마이크' })
      await expect(note).toHaveText(ko['voice.micFailedApp'])
      await expect(page.getByTestId('voice-open-settings')).toHaveCount(0)
      await page.screenshot({ path: `../../shots/mic-app-failed-${size.width}.png` })
    })

    test("the phone app: a blocked mic points to the phone's Settings, and the button opens them", async ({ page }) => {
      await reset(page)
      await phoneApp(page)
      await micRefused(page)
      await signIn(page)
      await mic(page).click()
      // the calm notice (never red), the way to Settings on its own line under the words, never an outlined button
      const note = page.getByTestId('composer-mic-blocked')
      await expect(note).toContainText(IOS_NOTE)
      await expect(note).toHaveAttribute('role', 'status')
      await expect(note).not.toContainText('브라우저')
      await page.screenshot({ path: `../../shots/mic-app-${size.width}.png` })
      await note.getByTestId('voice-open-settings').click()
      await expect.poll(() => sentToApp(page)).toContain('open-settings')
    })

    test("a folder's ⋯ menu starts a chat with this folder; a file's asks about the file", async ({ page }) => {
      await reset(page)
      await signIn(page)
      // the team folder's top: `/files` on a computer; a phone's `/files` is 파일's places, its top `/files?team=1`
      await page.goto(size.width < 768 ? '/files?team=1' : '/files')
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
      await expect(page.getByTestId('chat-with-file')).toHaveText(ASK_FILE)
    })
  })
}

// Settings › Notifications inside the phone app when the phone's Settings turned its notifications off: this device's
// row ends with the way to the phone's Settings (a link with ›, as a phone's settings show it), never a computer's
// outlined button under the line.
test.describe('390×844 notifications off in the phone\'s Settings', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test("this device's row ends with the way to Settings, which opens them", async ({ page }) => {
    await reset(page)
    await page.addInitScript(() => {
      const w = window as unknown as { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; mobileMessages: MobileMessage[] }
      w.mycelMobile = { protocol: 1, appVersion: '1.0.9', platform: 'ios', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', 'push-token-v1', 'push-permission-v1'] }
      w.mobileMessages = []
      w.ReactNativeWebView = { postMessage(raw) {
        const m = JSON.parse(raw) as MobileMessage
        w.mobileMessages.push(m)
        const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
        if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
        // the phone's Settings turned this app's notifications off
        if (m.type === 'push-permission') reply.permission = 'denied'
        queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
      } }
    })
    await page.route('**/api/push', (r) => r.request().method() === 'GET'
      ? r.fulfill({ json: { configured: true, enabled: false, publicKey: null, subscriptionId: null, native: { available: true, deviceId: null } } })
      : r.continue())
    await signIn(page)
    await page.goto('/settings/notifications')
    const row = page.getByTestId('push-notifications')
    await expect(row).toHaveAttribute('data-phone', '')
    await expect(row).toContainText(ko['push.deniedPhone'])
    const link = row.getByTestId('phone-push-settings')
    await expect(link).toHaveText(ko['push.openSettings'])
    // a link at the row's end, on the line's right: not a framed button under it
    const [linkBox, rowBox] = [await link.boundingBox(), await row.boundingBox()]
    expect(linkBox!.x + linkBox!.width).toBeGreaterThan(rowBox!.x + rowBox!.width - 8)
    expect(await link.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
    expect(linkBox!.height).toBeGreaterThanOrEqual(44)
    await link.click()
    await expect.poll(() => sentToApp(page)).toContain('open-settings')
  })
})
