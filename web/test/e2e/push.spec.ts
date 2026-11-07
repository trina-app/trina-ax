import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

test('push stays off until an explicit click and can be revoked across devices without provider traffic', async ({ page }) => {
  await reset(page)
  const publicKey = Buffer.from([4, ...new Uint8Array(64).fill(2)]).toString('base64url')
  let enabled = false, id: string | null = null, subscribed = 0
  await page.addInitScript(() => {
    const calls = { permissions: 0, subscriptions: 0, unsubscribe: 0 }
    ;(window as any).__pushCalls = calls
    let permission: NotificationPermission = 'default', subscription: any = null
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission })
    Notification.requestPermission = async () => { calls.permissions++; permission = 'granted'; return permission }
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function () {} })
    const registration = { active: { postMessage() {} }, pushManager: {
      getSubscription: async () => subscription,
      subscribe: async (options: PushSubscriptionOptionsInit) => {
        calls.subscriptions++
        subscription = { options, toJSON: () => ({ endpoint: 'https://push.example.test/synthetic', keys: { auth: 'test-auth', p256dh: 'test-p256dh' } }), unsubscribe: async () => { calls.unsubscribe++; subscription = null; return true } }
        return subscription
      },
    } }
    Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: async () => registration })
    Object.defineProperty(navigator.serviceWorker, 'getRegistration', { configurable: true, value: async () => registration })
    Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, value: Promise.resolve(registration) })
  })
  await page.route('**/api/push', route => {
    if (route.request().method() === 'PATCH') { enabled = route.request().postDataJSON().enabled; if (!enabled) id = null }
    return route.fulfill({ json: { configured: true, enabled, publicKey, subscriptionId: id } })
  })
  await page.route('**/api/push/subscriptions', route => {
    expect(route.request().postDataJSON()).toMatchObject({ consent: true, endpoint: 'https://push.example.test/synthetic' })
    subscribed++; enabled = true; id = 'own-session-subscription'
    return route.fulfill({ json: { id } })
  })
  await signIn(page); await page.goto('/settings/notifications')
  const pane = page.getByTestId('push-notifications')
  await expect(pane.getByRole('button', { name: '이 기기에서 알림 받기' })).toBeEnabled()
  expect(await page.evaluate(() => (window as any).__pushCalls.permissions)).toBe(0)
  expect(subscribed).toBe(0)
  await pane.getByRole('button', { name: '이 기기에서 알림 받기' }).click()
  await expect(pane).toContainText('이 기기에서 받고 있어요')
  expect(subscribed).toBe(1)
  expect(await page.evaluate(() => (window as any).__pushCalls)).toMatchObject({ permissions: 1, subscriptions: 1 })
  await pane.getByRole('button', { name: '모든 기기 푸시 끄기' }).click()
  await expect(pane).toContainText('이 기기에서는 꺼져 있어요')
  expect(enabled).toBe(false)
  expect(await page.evaluate(() => (window as any).__pushCalls.unsubscribe)).toBe(1)
})

/** A browser whose push works like Chrome's, without a push service: the question answers `answer`, subscribe gives a
 * synthetic subscription or fails with `subscribeError` (a DOMException name). */
async function fakeBrowserPush(page: import('@playwright/test').Page, o: { answer?: NotificationPermission; subscribeError?: string } = {}) {
  await page.addInitScript((o: { answer?: NotificationPermission; subscribeError?: string }) => {
    const calls = { permissions: 0, subscriptions: 0 }
    ;(window as any).__pushCalls = calls
    // the browser's answer outlives a reload, as a real one does
    let permission = (sessionStorage.getItem('__permission') ?? 'default') as NotificationPermission, subscription: any = null
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission })
    Notification.requestPermission = async () => { calls.permissions++; permission = o.answer ?? 'granted'; sessionStorage.setItem('__permission', permission); return permission }
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function () {} })
    const registration = { active: { postMessage() {} }, pushManager: {
      getSubscription: async () => subscription,
      subscribe: async (options: PushSubscriptionOptionsInit) => {
        calls.subscriptions++
        if (o.subscribeError) throw new DOMException('Registration failed - push service error', o.subscribeError)
        subscription = { options, toJSON: () => ({ endpoint: 'https://push.example.test/synthetic', keys: { auth: 'test-auth', p256dh: 'test-p256dh' } }), unsubscribe: async () => { subscription = null; return true } }
        return subscription
      },
    } }
    Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: async () => registration })
    Object.defineProperty(navigator.serviceWorker, 'getRegistration', { configurable: true, value: async () => registration })
    Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, value: Promise.resolve(registration) })
  }, o)
}

/** Move to another page inside the app (the router follows popstate), as the sidebar or the tab bar would. */
const go = (page: Page, path: string) => page.evaluate((p) => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')) }, path)
/** The ask shows from the page after the one where it became ready: move between two pages until it is there. */
async function reveal(page: Page, line: Locator) {
  await expect(async () => {
    await go(page, '/files'); await go(page, '/')
    await expect(line).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 10_000 })
}

test.describe('the web ask', () => {
  const publicKey = Buffer.from([4, ...new Uint8Array(64).fill(2)]).toString('base64url')
  test('not on the page where it became ready (nothing moves there); one line at the top from the next page: 알림 켜기 asks the browser and turns push on', async ({ page }) => {
    await reset(page)
    let subscribed = 0
    await fakeBrowserPush(page)
    const ready = page.waitForResponse('**/api/push')
    await page.route('**/api/push', route => route.fulfill({ json: { configured: true, enabled: subscribed > 0, publicKey, subscriptionId: subscribed ? 'own' : null } }))
    await page.route('**/api/push/subscriptions', route => { subscribed++; return route.fulfill({ json: { id: 'own' } }) })
    await signIn(page)
    const line = page.getByTestId('web-push-ask-top')
    // ready while Home is on screen: the composer does not move
    const composer = page.getByTestId('composer-input')
    const y = (await composer.boundingBox())!.y
    await ready
    await page.waitForTimeout(800)
    await expect(line).toHaveCount(0)
    expect((await composer.boundingBox())!.y).toBe(y)
    await reveal(page, line)
    await expect(line).toContainText('새 메시지 알림을 받으려면')
    // one line with a hairline: no box, and the page still starts right under it
    expect(await line.evaluate(e => { const s = getComputedStyle(e); return [s.borderTopWidth, s.borderBottomWidth, s.borderRadius, s.boxShadow] })).toEqual(['0px', '1px', '0px', 'none'])
    expect((await line.boundingBox())!.height).toBeLessThan(50)
    await expect(page.getByTestId('web-push-ask-bottom')).toBeHidden()
    expect(await page.evaluate(() => (window as any).__pushCalls.permissions)).toBe(0)
    await line.getByRole('button', { name: '알림 켜기' }).click()
    await expect(page.getByText('이 브라우저에서 알림을 켰어요.')).toBeVisible()
    await expect(line).toHaveCount(0)
    expect(subscribed).toBe(1)
    expect(await page.evaluate(() => (window as any).__pushCalls)).toMatchObject({ permissions: 1, subscriptions: 1 })
  })

  test('나중에: gone, and not back on the next visit of this device for 7 days', async ({ page }) => {
    await reset(page)
    await fakeBrowserPush(page)
    await page.route('**/api/push', route => route.fulfill({ json: { configured: true, enabled: false, publicKey, subscriptionId: null } }))
    await signIn(page)
    const line = page.getByTestId('web-push-ask-top')
    await reveal(page, line)
    await line.getByRole('button', { name: '나중에' }).click()
    await expect(line).toHaveCount(0)
    // the focus is not lost with the line: it goes to the page
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main')
    expect(await page.evaluate(() => (window as any).__pushCalls.permissions)).toBe(0)
    await page.reload()
    await expect(page.getByTestId('composer-input')).toBeVisible()
    for (const path of ['/files', '/', '/files']) { await go(page, path); await page.waitForTimeout(300) }
    await expect(line).toHaveCount(0)
  })

  test('a failure says why in the line, with the way to Settings › 알림 (Brave without Google push)', async ({ page }) => {
    await reset(page)
    await fakeBrowserPush(page, { subscribeError: 'AbortError' })
    await page.route('**/api/push', route => route.fulfill({ json: { configured: true, enabled: false, publicKey, subscriptionId: null } }))
    await signIn(page)
    const line = page.getByTestId('web-push-ask-top')
    await reveal(page, line)
    await line.getByRole('button', { name: '알림 켜기' }).click()
    await expect(line.getByRole('status')).toContainText('브라우저의 푸시 서비스가 꺼져 있거나 연결되지 않아요')
    await line.getByRole('link', { name: '설정 › 알림' }).click()
    await expect(page).toHaveURL(/\/settings\/notifications$/)
  })

  test('the browser\'s block: gone for good; Settings says it is blocked and how to undo it', async ({ page }) => {
    await reset(page)
    await fakeBrowserPush(page, { answer: 'denied' })
    await page.route('**/api/push', route => route.fulfill({ json: { configured: true, enabled: false, publicKey, subscriptionId: null } }))
    await signIn(page)
    const line = page.getByTestId('web-push-ask-top')
    await reveal(page, line)
    await line.getByRole('button', { name: '알림 켜기' }).click()
    await expect(line).toHaveCount(0)
    await page.goto('/settings/notifications')
    await expect(page.getByTestId('push-status')).toHaveText(DICTS.ko['push.denied'])
    await expect(page.getByTestId('push-status')).toContainText('시크릿 창')
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`the line and its reason have no serious accessibility problems (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await reset(page)
      await fakeBrowserPush(page, { subscribeError: 'AbortError' })
      await page.route('**/api/push', route => route.fulfill({ json: { configured: true, enabled: false, publicKey, subscriptionId: null } }))
      await signIn(page)
      const line = page.getByTestId('web-push-ask-top')
      await reveal(page, line)
      const audit = async () => {
        const r = await new AxeBuilder({ page }).include('[data-testid="web-push-ask-top"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
        return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
      }
      await expect(line).toBeVisible()
      expect(await audit()).toEqual([])
      await line.getByRole('button', { name: '알림 켜기' }).click()
      await expect(line.getByTestId('web-push-ask-text')).toHaveAttribute('data-reason', 'service')
      expect(await audit()).toEqual([])
    })
  }

  test.describe('in Microsoft Edge', () => {
    test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0' })
    test('no line (the team server refuses its push service); Settings still says why when someone tries', async ({ page }) => {
      await reset(page)
      await fakeBrowserPush(page)
      let asked = 0
      await page.route('**/api/push', route => { asked++; return route.fulfill({ json: { configured: true, enabled: false, publicKey, subscriptionId: null } }) })
      await page.route('**/api/push/subscriptions', route => route.fulfill({ status: 400, json: { error: { code: 'validation', message: '입력값을 확인해 주세요.' } } }))
      await signIn(page)
      for (const path of ['/files', '/', '/files']) { await go(page, path); await page.waitForTimeout(300) }
      await expect(page.getByTestId('web-push-ask-top')).toHaveCount(0)
      expect(asked).toBe(0)
      await page.goto('/settings/notifications')
      await page.getByTestId('push-notifications').getByRole('button', { name: '이 기기에서 알림 받기' }).click()
      await expect(page.getByTestId('push-failure')).toHaveAttribute('data-kind', 'browserService')
      await expect(page.getByTestId('push-failure')).toContainText('이 브라우저의 푸시 서비스는 팀 서버가 지원하지 않아요')
    })
  })

  test.describe('on a phone browser', () => {
    test.use({ viewport: { width: 390, height: 844 } })
    test('above the tab bar, the page as wide as the screen', async ({ page }) => {
      await reset(page)
      await fakeBrowserPush(page)
      await page.route('**/api/push', route => route.fulfill({ json: { configured: true, enabled: false, publicKey, subscriptionId: null } }))
      await signIn(page)
      const line = page.getByTestId('web-push-ask-bottom')
      await reveal(page, line)
      await expect(page.getByTestId('web-push-ask-top')).toBeHidden()
      const [ask, tabs] = [await line.boundingBox(), await page.getByTestId('bottom-tabs').boundingBox()]
      expect(Math.round(ask!.y + ask!.height)).toBeLessThanOrEqual(Math.round(tabs!.y) + 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    })
  })
})

test('Settings says why push could not be turned on: the push service is off, no "다시 시도"', async ({ page }) => {
  await reset(page)
  const publicKey = Buffer.from([4, ...new Uint8Array(64).fill(2)]).toString('base64url')
  await fakeBrowserPush(page, { subscribeError: 'AbortError' })
  await page.route('**/api/push', route => route.fulfill({ json: { configured: true, enabled: false, publicKey, subscriptionId: null } }))
  await signIn(page); await page.goto('/settings/notifications')
  const pane = page.getByTestId('push-notifications')
  await pane.getByRole('button', { name: '이 기기에서 알림 받기' }).click()
  const note = page.getByTestId('push-failure')
  await expect(note).toHaveAttribute('data-kind', 'service')
  await expect(note).toContainText('브라우저의 푸시 서비스가 꺼져 있거나 연결되지 않아요')
  await expect(note).not.toContainText('푸시 설정을 저장하지 못했어요')
  await expect(note.getByRole('button', { name: '다시 시도' })).toHaveCount(0)
})

test.describe('iPhone in a browser tab', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' })
  test('push says the Home Screen app is needed and links the install guide with the iPhone steps first', async ({ page }) => {
    await reset(page)
    const publicKey = Buffer.from([4, ...new Uint8Array(64).fill(2)]).toString('base64url')
    await page.route('**/api/push', route => route.fulfill({ json: { configured: true, enabled: false, publicKey, subscriptionId: null } }))
    await signIn(page); await page.goto('/settings/notifications')
    const pane = page.getByTestId('push-notifications')
    await expect(pane).toContainText('iOS 16.4')
    await expect(pane.getByRole('button', { name: '이 기기에서 알림 받기' })).toHaveCount(0)
    await pane.getByRole('link', { name: '홈 화면에 추가하는 방법' }).click()
    await expect(page).toHaveURL(/\/settings\/apps$/)
    const guide = page.getByTestId('install-guide')
    await expect(guide.locator('[data-testid^="install-guide-"]').first()).toHaveAttribute('data-testid', 'install-guide-ios')
    await expect(guide.getByTestId('install-guide-ios')).toContainText('이 기기')
    await expect(guide.getByTestId('install-guide-ios')).toContainText('홈 화면에 추가')
    await expect(guide.getByRole('link', { name: '푸시 알림 켜기' })).toHaveAttribute('href', '/settings/notifications')
    // the other devices' steps are one line away, folded
    await expect(guide.getByTestId('install-guide-android')).toHaveCount(0)
    await guide.getByTestId('install-guide-others').locator('summary').click()
    // each step of a phone has a picture with the place to tap; the words are in the caption, for every reader
    for (const g of ['ios', 'android']) {
      const steps = guide.getByTestId(`install-steps-${g}`).getByRole('listitem')
      await expect(steps).toHaveCount(4)
      for (const step of await steps.all()) await expect(step.locator('[aria-hidden="true"]').first()).toBeVisible()
    }
    await expect(guide.getByTestId('install-steps-ios')).toContainText('주소창 옆 ⋯')
    await expect(guide.getByTestId('install-steps-android')).toContainText('"앱 설치" 또는 "홈 화면에 추가"')
    // a computer, seen from a phone: Chrome's and Edge's three steps, with pictures too
    await expect(guide.getByTestId('install-guide-desktop')).toHaveAttribute('data-flow', 'chromium')
    await expect(guide.getByTestId('install-steps-chromium').getByRole('listitem')).toHaveCount(3)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
})
