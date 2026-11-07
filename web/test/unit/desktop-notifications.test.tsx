// Settings › Notifications › 이 기기 inside the desktop app (components/settings/DesktopNotifications.tsx): no Web Push
// row (Electron has no push service: the old button always failed with "check your connection"), one row "이 컴퓨터 앱
// 알림" instead. A desktop app with testNotify adds "테스트 알림" (sent through the bridge, focused or not) and, when the
// system refused it, says where to turn the app's notifications on; an older desktop app shows the row without it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DESKTOP_BRIDGE_GLOBAL, type DesktopBridge, type DesktopNotifyTest } from '@mycel/shared'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { DesktopNotifications, desktopTestText } from '../../src/components/settings/DesktopNotifications'
import { installDom, mount, removeDom } from './dom-host'

const ko = (k: MessageKey, p?: Params) => translate('ko', k, p)
const en = (k: MessageKey, p?: Params) => translate('en', k, p)
const noop = () => {}
type Sent = { title: string; body: string }
const bridge = (o: { platform?: DesktopBridge['platform']; test?: (n: Sent) => Promise<DesktopNotifyTest> } = {}) =>
  ({
    bridgeVersion: 1,
    appVersion: '0.4.0',
    platform: o.platform ?? 'darwin',
    browser: { run: async () => ({}) as never, cancel: noop },
    pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
    connection: { get: async () => ({}) as never, onChange: () => noop },
    notify: noop,
    openTeams: noop,
    ...(o.test ? { testNotify: o.test } : {}),
  }) as DesktopBridge

describe('the row', () => {
  const locale = useLocaleStore.getState().locale
  beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'ko' }) })
  afterEach(() => { delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] })
  afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

  test('shown with what the desktop app does; "테스트 알림" sends one through the bridge and says it was sent', async () => {
    const sent: Sent[] = []
    let answer!: (o: DesktopNotifyTest) => void
    const app = bridge({ test: (n) => { sent.push(n); return new Promise((r) => { answer = r }) } })
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = app
    const page = await mount(<DesktopNotifications />)
    const row = page.get('desktop-notifications')
    expect(row.textContent).toContain('이 컴퓨터 앱 알림')
    expect(row.textContent).toContain(ko('desktopNotify.desc'))
    // no Web Push here: no "이 기기에서 알림 받기", no generic failure
    expect(row.textContent).not.toContain(ko('push.enable'))
    expect(page.find('push-notifications')).toBeNull()
    const button = page.get('desktop-notify-test')
    expect(button.textContent).toBe('테스트 알림')
    await page.click(button)
    expect(sent).toEqual([{ title: 'Trina AX 알림 테스트', body: ko('desktopNotify.testBody') }])
    // busy until the system answers: a second click sends nothing
    expect(page.get('desktop-notify-test').hasAttribute('disabled')).toBe(true)
    await page.click('desktop-notify-test')
    expect(sent).toHaveLength(1)
    answer('shown')
    const line = await page.until(() => page.find('desktop-notify-result'), 'the answer')
    expect(line.getAttribute('data-outcome')).toBe('shown')
    expect(line.textContent).toBe('테스트 알림을 보냈어요.')
    await page.unmount()
  })

  test('notifications off for the app in macOS: where to turn them on', async () => {
    const page = await mount(<DesktopNotifications bridge={bridge({ test: async () => 'off' })} />)
    await page.click('desktop-notify-test')
    const line = await page.until(() => page.find('desktop-notify-result'), 'the answer')
    expect(line.textContent).toBe('이 컴퓨터에서 Trina AX 알림이 꺼져 있어요. 시스템 설정 › 알림 › Trina AX에서 켜 주세요.')
    expect(line.className).toContain('text-danger')
    await page.unmount()
  })

  test('a desktop app from before testNotify: the row without the button', async () => {
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = bridge()
    const page = await mount(<DesktopNotifications />)
    expect(page.get('desktop-notifications').textContent).toContain('이 컴퓨터 앱 알림')
    expect(page.find('desktop-notify-test')).toBeNull()
    expect(page.container.querySelectorAll('button')).toHaveLength(0)
    await page.unmount()
  })

  test('a bridge call that throws (the app closing): it was handed over, so "sent; if it does not show, here"', async () => {
    const page = await mount(<DesktopNotifications bridge={bridge({ test: async () => { throw new Error('gone') } })} />)
    await page.click('desktop-notify-test')
    const line = await page.until(() => page.find('desktop-notify-result'), 'the answer')
    expect(line.getAttribute('data-outcome')).toBe('unknown')
    expect(line.textContent).toContain('시스템 설정 › 알림 › Trina AX')
    await page.unmount()
  })
})

test('each answer in words, with the system\'s own place on macOS, Windows and Linux', () => {
  expect(desktopTestText('shown', 'darwin', en)).toBe('Test notification sent.')
  expect(desktopTestText('off', 'darwin', en)).toBe('Notifications for Trina AX are off on this computer. Turn them on in System Settings › Notifications › Trina AX.')
  expect(desktopTestText('off', 'win32', en)).toBe('Notifications for Trina AX are off on this computer. Turn them on in Settings › System › Notifications › Trina AX.')
  expect(desktopTestText('off', 'linux', en)).toBe("Notifications for Trina AX are off on this computer. Turn them on in the system's notification settings.")
  expect(desktopTestText('unknown', 'darwin', en)).toBe('Test notification sent. If it does not show, turn notifications on in System Settings › Notifications › Trina AX.')
  expect(desktopTestText('unsupported', 'linux', en)).toBe('This computer does not support app notifications.')
  expect(desktopTestText('limited', 'darwin', en)).toBe('Too many notifications just now. Try again in a minute.')
  for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
    const t = (k: MessageKey, p?: Params) => translate(l, k, p)
    for (const o of ['shown', 'off', 'unsupported', 'limited', 'unknown'] as const) for (const p of ['darwin', 'win32', 'linux'] as const) {
      const text = desktopTestText(o, p, t)
      expect(text).not.toMatch(/[{}]|desktopNotify\./)
    }
  }
})

test('Settings › Notifications shows this row inside the desktop app and the Web Push row elsewhere', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, '../../src/components/settings/Notifications.tsx'), 'utf8')
  expect(source).toContain('{isDesktop() ? <DesktopNotifications /> : <PushNotifications />}')
})
