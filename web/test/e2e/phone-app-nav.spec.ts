// The phone app's Back (nav-v1; QA TC-246 part 2, the owner: Back is odd in the app). Playwright cannot drive the iOS edge
// swipe, Android's Back or a notification tap, so this drives the page's side through a fake app bridge, with the same
// scripts the app injects (mobile/src/nav.ts): the page says where Back goes (`nav`), the app's Back at another tab's root
// shows the start tab, and a tapped notification opens its room with the router (no reload) with Back to where the
// person was. The app's own half (the swipe flag, Back, no pull-to-refresh) is in tests/unit/mobile-*.test.ts.
import { expect, test, type Page } from '@playwright/test'
import { uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { openScript, START_TAB_SCRIPT } from '../../../mobile/src/nav'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const ROOM = uuidv7()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const ROOMS = [{
  id: ROOM, kind: 'team', name: '마케팅팀', groupId: uuidv7(), memberCount: 6, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(5),
  canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false,
}]

type Nav = { canGoBack: boolean; home?: boolean }
type Win = { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; mobileMessages: MobileMessage[]; loads?: number }

/** The app's bridge as the page sees it: `nav` only from an app that offers nav-v1. Every load counts itself (`loads`). */
async function app(page: Page, nav: boolean) {
  await page.addInitScript((nav) => {
    const w = window as unknown as Win
    w.mycelMobile = { protocol: 1, appVersion: '1.0.5', platform: 'android', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', ...(nav ? ['nav-v1'] : [])] }
    w.mobileMessages = []
    const loads = Number(sessionStorage.getItem('e2e.loads') ?? 0) + 1
    sessionStorage.setItem('e2e.loads', String(loads))
    w.loads = loads
    w.ReactNativeWebView = { postMessage(raw) {
      const m = JSON.parse(raw) as MobileMessage
      w.mobileMessages.push(m)
      const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true }
      if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
    } }
  }, nav)
}

const navs = (page: Page) => page.evaluate(() => (window as unknown as Win).mobileMessages.filter((m) => m.type === 'nav').map((m) => ({ canGoBack: (m as Nav).canGoBack, home: (m as Nav).home })))
/** what the app heard last */
const heard = async (page: Page) => (await navs(page)).at(-1) ?? null
const loads = (page: Page) => page.evaluate(() => (window as unknown as Win).loads ?? 0)

test('nav-v1: no Back at a tab\'s root, the start tab from another tab\'s root, Back from a room and from a sheet', async ({ page }) => {
  await reset(page)
  await app(page, true)
  await signIn(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
  // the start tab's root: no swipe; Android's Back leaves the app
  await expect(page).toHaveURL(/\/$/)
  await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: true })

  // (1) the 대화 tab's root: iOS no swipe; Android's Back goes to the start tab…
  await page.getByTestId('tab-chats').click()
  await expect(page).toHaveURL(/\/rooms$/)
  await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: false })
  const before = await loads(page)
  await page.evaluate(START_TAB_SCRIPT)
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('tab-ai')).toHaveAttribute('aria-current', 'page')
  // …then leaves the app (nothing under the start tab's root)
  await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: true })
  expect(await loads(page)).toBe(before)

  // a room above the 대화 list: Back goes to the list
  await page.getByTestId('tab-chats').click()
  await page.getByTestId('rooms-row').filter({ hasText: '마케팅팀' }).click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM}$`))
  await expect.poll(() => heard(page)).toEqual({ canGoBack: true, home: false })
  await page.goBack()
  await expect(page).toHaveURL(/\/rooms$/)
  await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: false })

  // a sheet at the root: Back closes it, so the swipe is on while it is open
  await page.getByTestId('topbar-new-dm').click()
  const picker = page.getByRole('dialog')
  await expect(picker).toBeVisible()
  await expect.poll(() => heard(page)).toEqual({ canGoBack: true, home: false })
  await page.goBack()
  await expect(picker).toBeHidden()
  await expect(page).toHaveURL(/\/rooms$/)
  await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: false })
  expect(await loads(page)).toBe(before)
})

test('nav-v1: a notification tapped with the app open opens its room without a reload, and Back returns to where the person was', async ({ page }) => {
  await reset(page)
  await app(page, true)
  await signIn(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
  await page.getByTestId('tab-files').click()
  await expect(page).toHaveURL(/\/files/)
  await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: false })
  const before = await loads(page)
  // (2) the script the app injects for a tapped notification (src/nav.ts openScript)
  await page.evaluate(openScript(`/rooms/${ROOM}`))
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM}$`))
  await expect(page.getByTestId('room-input')).toBeVisible()
  expect(await loads(page)).toBe(before)
  await expect.poll(() => heard(page)).toMatchObject({ canGoBack: true })
  // Back (the app's goBack): the folder the person was in
  await page.goBack()
  await expect(page).toHaveURL(/\/files/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await loads(page)).toBe(before)
  await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: false })
  // a path the page does not open itself (not an id path): the app's script loads it, as before
  await page.evaluate(openScript('/files?path=marketing'))
  await expect(page).toHaveURL(/\/files\?path=marketing$/)
  await page.waitForLoadState()
  expect(await loads(page)).toBe(before + 1)
})

test('an app without nav-v1 hears no nav (an older store build never answers it); a tap still opens in the page', async ({ page }) => {
  await reset(page)
  await app(page, false)
  await signIn(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
  await page.getByTestId('tab-chats').click()
  await expect(page).toHaveURL(/\/rooms$/)
  const before = await loads(page)
  await page.evaluate(openScript(`/rooms/${ROOM}`))
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM}$`))
  expect(await loads(page)).toBe(before)
  expect(await navs(page)).toEqual([])
})
