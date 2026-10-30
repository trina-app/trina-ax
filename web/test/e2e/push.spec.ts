import { expect, test } from '@playwright/test'
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
  })
})
