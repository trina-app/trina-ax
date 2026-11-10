// A phone's keyboard (docs/DECISIONS.md "Phones: the keyboard keeps the newest message in sight"): at 390 px, with the
// keyboard simulated three ways.
// - android: the viewport shrinks (interactive-widget=resizes-content; the Android app lifts its WebView alike);
// - app: the iPhone app's WebView, which shrinks the viewport too and, in the same frame, moves the list 22 px up (measured
//   in the iOS 26.5 simulator): before the fix that move read as the reader leaving the bottom;
// - safari: iOS Safari, which keeps the layout viewport and shrinks only visualViewport (mocked here).
// At the bottom, the newest message stays right above the message box (the room, the AI chat, the ✦ side chat);
// scrolled up, the first message in sight keeps its place, and closing the keyboard moves nothing. A long press while
// typing takes the keyboard down and shows the message's sheet with its reactions, the draft kept; a sheet that opens
// with the keyboard still up sits on it. The status sheet does not open the keyboard by itself, and with it up its
// buttons stay in sight; the emoji sheet's search alike. With SHOTS_DIR set, the last test saves the screens for review.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockMessage, type MockRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const W = 390, H = 844
/** what is left above the keyboard */
const KB_TOP = 420
const SORA = { id: 'sora', name: '소라님' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`
const MESSAGES: MockMessage[] = Array.from({ length: 40 }, (_, i) => ({ id: id(i), author: SORA, body: `${i + 1}번째 메시지: 오늘 회의에서 정한 일을 한 줄씩 적어 둘게요.` }))
const DRAFT = '내일 다시 볼게요'

type Kind = 'android' | 'app' | 'safari'

/** The keyboard comes up as `kind` says; `nudge`: the list the iPhone app's WebView moves 22 px up in that frame. */
async function openKeyboard(page: Page, kind: Kind, nudge?: string) {
  if (kind === 'app' && nudge) {
    await page.evaluate((sel) => {
      const vv = window.visualViewport!
      const once = () => {
        vv.removeEventListener('resize', once)
        const s = document.querySelector<HTMLElement>(sel)
        if (s) s.scrollTop -= 22
      }
      vv.addEventListener('resize', once)
    }, nudge)
  }
  if (kind === 'safari') {
    await page.evaluate((h) => {
      const vv = window.visualViewport!
      Object.defineProperty(vv, 'height', { get: () => h, configurable: true })
      vv.dispatchEvent(new Event('resize'))
    }, KB_TOP)
  } else await page.setViewportSize({ width: W, height: KB_TOP })
  // the page follows it (lib/viewport.ts)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-h'))).toBe(`${KB_TOP}px`)
}
async function closeKeyboard(page: Page, kind: Kind) {
  if (kind === 'safari') {
    await page.evaluate(() => {
      const vv = window.visualViewport!
      Reflect.deleteProperty(vv, 'height')
      vv.dispatchEvent(new Event('resize'))
    })
  } else await page.setViewportSize({ width: W, height: H })
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-h'))).toBe(`${H}px`)
}

/** px between what the list shows and its end */
const gap = (list: Locator) => list.evaluate((s) => Math.round(s.scrollHeight - s.scrollTop - s.clientHeight))
const box = async (l: Locator) => (await l.boundingBox())!

/** the list at its bottom, its last message in sight right above the message box, and the box above the keyboard */
async function newestAboveBox(list: Locator, last: Locator, input: Locator, visible: number) {
  await expect.poll(() => gap(list)).toBeLessThanOrEqual(1)
  const m = await box(last), b = await box(input), l = await box(list)
  expect(m.y + m.height).toBeLessThanOrEqual(l.y + l.height + 1)
  expect(m.y + m.height).toBeLessThanOrEqual(b.y)
  expect(m.y).toBeGreaterThanOrEqual(l.y - 1)
  expect(b.y + b.height).toBeLessThanOrEqual(visible)
}

async function openRoom(page: Page, messages = MESSAGES, kind: 'group' | 'dm' = 'group'): Promise<MockRoom> {
  await reset(page)
  const room = await routeRoom(page, { members: [SORA], messages, kind })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(messages.length)
  await expect.poll(() => gap(page.getByTestId('room-scroller'))).toBeLessThanOrEqual(1)
  return room
}

test('the room at its bottom: the keyboard keeps the newest message right above the box, each way it comes up', async ({ page }) => {
  await openRoom(page)
  const list = page.getByTestId('room-scroller'), last = page.getByTestId('room-message').last(), input = page.getByTestId('room-input')
  for (const kind of ['app', 'safari', 'android'] as const) {
    await input.tap()
    await openKeyboard(page, kind, '[data-testid="room-scroller"]')
    await newestAboveBox(list, last, input, KB_TOP)
    // and down again: still at the bottom, no jump
    await closeKeyboard(page, kind)
    await newestAboveBox(list, last, input, H)
  }
})

test('a DM and a thread at their bottom: the newest message stays right above the box (the iPhone app, iOS Safari)', async ({ page }) => {
  await openRoom(page, MESSAGES, 'dm')
  const list = page.getByTestId('room-scroller'), input = page.getByTestId('room-input')
  for (const kind of ['app', 'safari'] as const) {
    await input.tap()
    await openKeyboard(page, kind, '[data-testid="room-scroller"]')
    await newestAboveBox(list, page.getByTestId('room-message').last(), input, KB_TOP)
    await closeKeyboard(page, kind)
  }
  // a thread with 30 replies, the whole screen on a phone
  const root = MESSAGES[0]!
  const replies: MockMessage[] = Array.from({ length: 30 }, (_, i) => ({ id: `019a5f00-0000-7000-8000-0000000003${String(i).padStart(2, '0')}`, author: SORA, body: `${i + 1}번째 답장: 스레드에서 이어서 정리해 둘게요.`, threadRootId: root.id }))
  await reset(page)
  await routeRoom(page, { members: [SORA], messages: [...MESSAGES.slice(0, 3), ...replies] })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}/t/${root.id}`)
  const thread = page.getByTestId('thread-drop')
  const tlist = thread.getByTestId('thread-scroller'), tinput = thread.getByTestId('room-input'), tlast = thread.getByTestId('room-message').last()
  await expect(tlast).toContainText('30번째 답장')
  await expect.poll(() => gap(tlist)).toBeLessThanOrEqual(1)
  for (const kind of ['app', 'safari'] as const) {
    await tinput.tap()
    await openKeyboard(page, kind, '[data-testid="thread-scroller"]')
    await newestAboveBox(tlist, tlast, tinput, KB_TOP)
    await closeKeyboard(page, kind)
    await expect.poll(() => gap(tlist)).toBeLessThanOrEqual(1)
  }
})

test('the room scrolled up to read: the message in sight stays where it is as the keyboard comes up and goes down', async ({ page }) => {
  await openRoom(page)
  const list = page.getByTestId('room-scroller')
  for (const kind of ['app', 'safari', 'android'] as const) {
    // the reader scrolls up to an older message
    await list.evaluate((s) => { s.scrollTop = 600 })
    await expect.poll(() => list.evaluate((s) => s.scrollTop)).toBe(600)
    const top = (await box(list)).y
    // the first message in sight and where it starts
    const anchor = await page.evaluate((t) => [...document.querySelectorAll<HTMLElement>('[data-testid="room-message"]')].findIndex((m) => m.getBoundingClientRect().bottom > t + 1), top)
    const msg = page.getByTestId('room-message').nth(anchor)
    const before = (await box(msg)).y
    await page.getByTestId('room-input').tap()
    await openKeyboard(page, kind, '[data-testid="room-scroller"]')
    await expect.poll(async () => Math.round((await box(msg)).y - before)).toBe(0)
    expect(await gap(list)).toBeGreaterThan(80)
    await closeKeyboard(page, kind)
    await expect.poll(async () => Math.round((await box(msg)).y - before)).toBe(0)
  }
})

const post = (page: Page, p: string, data: object) => page.request.post(p, { headers: { [CSRF_HEADER]: '1' }, data })

test('the AI chat at its bottom: the newest answer stays right above the box', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const chat = (await (await post(page, '/api/chats', {})).json()) as { id: string }
  for (const q of ['첫 질문', '두 번째 질문', '세 번째 질문']) {
    expect((await post(page, `/api/chats/${chat.id}/messages`, { content: q, clientMessageId: uuidv7() })).status()).toBe(202)
    await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  }
  await page.goto(`/c/${chat.id}`)
  const list = page.getByTestId('messages'), last = page.getByTestId('assistant-message').last(), input = page.getByTestId('composer-input')
  await expect(page.getByTestId('assistant-message')).toHaveCount(3)
  await expect.poll(() => gap(list)).toBeLessThanOrEqual(1)
  for (const kind of ['app', 'safari'] as const) {
    await input.tap()
    await openKeyboard(page, kind, '[data-testid="messages"]')
    await expect.poll(() => gap(list)).toBeLessThanOrEqual(1)
    // the answer's end is in sight above the box
    const a = await box(last), b = await box(input)
    expect(a.y + a.height).toBeLessThanOrEqual(b.y)
    expect(a.y + a.height).toBeGreaterThan(b.y - 200)
    expect(b.y + b.height).toBeLessThanOrEqual(KB_TOP)
    await closeKeyboard(page, kind)
    await expect.poll(() => gap(list)).toBeLessThanOrEqual(1)
  }
})

test('the ✦ side chat at its bottom: the newest answer stays right above its box', async ({ page }) => {
  await openRoom(page, MESSAGES.slice(0, 3))
  await page.getByTestId('room-side-chat-button').click()
  const side = page.getByTestId('room-side-chat')
  const input = side.getByTestId('side-chat-input')
  for (const [i, q] of ['한 줄로 정리해 줘', '다시 정리해 줘'].entries()) {
    await input.fill(q)
    await side.getByTestId('side-chat-send').click()
    await expect(side.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(i + 1, { timeout: 20_000 })
  }
  // the box lost the keyboard after sending (a phone): it is down
  await input.evaluate((el) => (el as HTMLElement).blur())
  const list = side.getByTestId('side-chat-scroller'), last = side.getByTestId('assistant-message').last()
  await expect.poll(() => gap(list)).toBeLessThanOrEqual(1)
  for (const kind of ['app', 'safari'] as const) {
    await input.tap()
    await openKeyboard(page, kind, '[data-testid="side-chat-scroller"]')
    await expect.poll(() => gap(list)).toBeLessThanOrEqual(1)
    const a = await box(last), b = await box(input)
    expect(a.y + a.height).toBeLessThanOrEqual(b.y)
    expect(b.y + b.height).toBeLessThanOrEqual(KB_TOP)
    await closeKeyboard(page, kind)
    await expect.poll(() => gap(list)).toBeLessThanOrEqual(1)
  }
})

/** A long press with a finger on a message: its sheet. */
async function longPress(page: Page, target: Locator) {
  const b = await box(target)
  const at = { button: 0, pointerType: 'touch', isPrimary: true, clientX: b.x + 40, clientY: b.y + b.height / 2 }
  await target.dispatchEvent('pointerdown', at)
  await page.waitForTimeout(650)
  await target.dispatchEvent('pointerup', at)
  await expect(page.getByRole('menu')).toBeVisible()
  // (the finger lifting after the long press is no pick)
  await page.waitForTimeout(450)
}

test('typing, a long press on a message: the keyboard goes down, the sheet with its reactions is in sight; 😭, and the draft is still there', async ({ page }) => {
  const room = await openRoom(page)
  const input = page.getByTestId('room-input')
  await input.tap()
  await input.fill(DRAFT)
  // iOS: the keyboard is up, and a sheet that opens while it still is must sit on it
  await openKeyboard(page, 'safari')
  const msg = page.getByTestId('room-message').last()
  await longPress(page, msg)
  // the box gave up the keyboard
  await expect(input).not.toBeFocused()
  const strip = page.getByRole('menu').getByTestId('reaction-strip')
  await expect(strip).toBeVisible()
  const s = await box(strip), sheet = await box(page.getByRole('menu'))
  expect(s.y).toBeGreaterThanOrEqual(0)
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(KB_TOP + 1)
  await strip.locator('[data-emoji="😭"]').click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(msg.getByTestId('reaction-chip')).toHaveText(['😭1'])
  expect(room.reacted).toEqual([{ messageId: MESSAGES.at(-1)!.id, emoji: '😭', on: true }])
  // the draft is kept, and the keyboard does not come back by itself
  await expect(input).toHaveValue(DRAFT)
  await expect(input).not.toBeFocused()
  // the keyboard goes down (the box gave it up): the list is still at its bottom
  await closeKeyboard(page, 'safari')
  await expect.poll(() => gap(page.getByTestId('room-scroller'))).toBeLessThanOrEqual(1)
})

test('the emoji sheet: its search with the keyboard up stays in sight, and so do the results', async ({ page }) => {
  await openRoom(page)
  await longPress(page, page.getByTestId('room-message').last())
  await page.getByRole('menu').getByTestId('reaction-more').click()
  const sheet = page.getByTestId('emoji-sheet')
  await expect(sheet).toBeVisible()
  const search = sheet.getByTestId('emoji-search')
  // a phone's sheet does not open the keyboard by itself
  await expect(search).not.toBeFocused()
  await search.tap()
  await openKeyboard(page, 'safari')
  const dialog = page.getByRole('dialog', { name: '반응 추가' })
  await expect.poll(async () => { const d = await box(dialog); return Math.round(d.y + d.height) }).toBeLessThanOrEqual(KB_TOP)
  expect((await box(dialog)).y).toBeGreaterThanOrEqual(0)
  const q = await box(search)
  expect(q.y).toBeGreaterThanOrEqual(0)
  expect(q.y + q.height).toBeLessThanOrEqual(KB_TOP)
  await search.fill('cry')
  const cry = sheet.getByTestId('emoji-results').locator('[data-emoji="😭"]')
  await expect(cry).toBeVisible()
  const c = await box(cry)
  expect(c.y + c.height).toBeLessThanOrEqual(KB_TOP)
})

async function openStatus(page: Page) {
  await page.goto('/')
  await page.getByTestId('menu-open').click()
  await page.locator('[data-drawer]').getByTestId('my-status-row').click()
  await expect(page.getByTestId('status-dialog')).toBeVisible()
}

test('the status sheet: no keyboard on opening, the suggestions and Save in sight; tapping the box, Save stays above the keyboard', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await openStatus(page)
  const text = page.getByTestId('status-text'), save = page.getByTestId('status-save')
  await expect(text).not.toBeFocused()
  await expect(page.getByTestId('status-suggestions')).toBeVisible()
  const s0 = await box(save)
  expect(s0.y + s0.height).toBeLessThanOrEqual(H)
  // a suggestion fills it in without bringing the keyboard up
  await page.getByTestId('status-suggestion').first().click()
  await expect(text).not.toHaveValue('')
  await expect(text).not.toBeFocused()
  // the box, tapped: the keyboard comes up (iOS Safari: the layout viewport keeps its height)
  await text.tap()
  await expect(text).toBeFocused()
  await openKeyboard(page, 'safari')
  await expect.poll(async () => { const b = await box(save); return Math.round(b.y + b.height) }).toBeLessThanOrEqual(KB_TOP)
  const t = await box(text), c = await box(page.getByTestId('status-cancel')), d = await box(page.getByRole('dialog', { name: '상태 설정' }))
  expect(t.y).toBeGreaterThanOrEqual(0)
  expect(t.y + t.height).toBeLessThanOrEqual(KB_TOP)
  expect(c.y + c.height).toBeLessThanOrEqual(KB_TOP)
  expect(d.y).toBeGreaterThanOrEqual(0)
  // the "Clears" chips scroll into sight inside the sheet
  const clears = page.getByTestId('status-clears')
  await clears.scrollIntoViewIfNeeded()
  const k = await box(clears)
  expect(k.y + k.height).toBeLessThanOrEqual(KB_TOP)
  // closed again: the sheet back at the bottom of the screen
  await closeKeyboard(page, 'safari')
  await expect.poll(async () => { const b = await box(page.getByRole('dialog', { name: '상태 설정' })); return Math.round(b.y + b.height) }).toBe(H)
})

test.describe('a computer', () => {
  test.use({ viewport: { width: 1360, height: 860 }, hasTouch: false, isMobile: false })
  test('the status dialog still puts the keyboard in its box', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.getByTestId('account-menu').click()
    await page.getByTestId('account-status').click()
    await expect(page.getByTestId('status-text')).toBeFocused()
  })
})

// ---------------- screenshots for review (SHOTS_DIR) ----------------
/** a grey block where the keyboard would be, for the pictures */
const drawKeyboard = (page: Page) => page.evaluate((top) => {
  const k = document.createElement('div')
  k.setAttribute('style', `position:fixed;left:0;right:0;top:${top}px;bottom:0;z-index:2147483647;background:#c9ccd1;display:flex;align-items:center;justify-content:center;font:600 15px system-ui;color:#555;pointer-events:none`)
  k.textContent = 'keyboard (simulated)'
  k.dataset.fakeKeyboard = ''
  document.body.append(k)
}, KB_TOP)
const dropKeyboard = (page: Page) => page.evaluate(() => document.querySelectorAll('[data-fake-keyboard]').forEach((k) => k.remove()))

test.describe('screens for review', () => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  test('390 light: the room at its bottom, a long press while typing, the status sheet, each with the keyboard up', async ({ page }) => {
    const dir = process.env.SHOTS_DIR!
    fs.mkdirSync(dir, { recursive: true })
    const shot = (name: string) => page.screenshot({ path: path.join(dir, name) })
    // (motion as on a phone: no reduced motion)
    await page.emulateMedia({ colorScheme: 'light' })
    await openRoom(page)
    await shot('390-light-room-at-bottom.png')
    // the iPhone app's keyboard (the page 420 px high, the list nudged): what is above it, the keyboard drawn below
    await page.getByTestId('room-input').tap()
    await openKeyboard(page, 'app', '[data-testid="room-scroller"]')
    await page.waitForTimeout(300)
    const above = await page.screenshot()
    const pic = await page.context().newPage()
    await pic.setViewportSize({ width: W, height: H })
    await pic.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><img style="display:block;width:${W}px" src="data:image/png;base64,${above.toString('base64')}"><div style="height:${H - KB_TOP}px;background:#c9ccd1;display:flex;align-items:center;justify-content:center;font:600 15px system-ui;color:#555">keyboard (simulated)</div></body>`)
    await pic.screenshot({ path: path.join(dir, '390-light-room-keyboard.png') })
    await pic.close()
    await closeKeyboard(page, 'app')
    await page.getByTestId('room-input').tap()
    await page.getByTestId('room-input').fill(DRAFT)
    await openKeyboard(page, 'safari')
    await longPress(page, page.getByTestId('room-message').last())
    await drawKeyboard(page)
    await shot('390-light-long-press-keyboard.png')
    await dropKeyboard(page)
    await page.keyboard.press('Escape')
    await closeKeyboard(page, 'safari')
    // the status sheet: as it opens, then with the keyboard up
    await openStatus(page)
    await shot('390-light-status-open.png')
    await page.getByTestId('status-text').tap()
    await openKeyboard(page, 'safari')
    await page.waitForTimeout(300)
    await drawKeyboard(page)
    await shot('390-light-status-keyboard.png')
  })
  test.describe('1440', () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false })
    test('1440 light: the room and the status dialog, as before (nothing changes on a computer)', async ({ page }) => {
      const dir = process.env.SHOTS_DIR!
      fs.mkdirSync(dir, { recursive: true })
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await openRoom(page)
      await page.getByTestId('room-input').fill(DRAFT)
      await page.screenshot({ path: path.join(dir, '1440-light-room.png') })
      await page.getByTestId('account-menu').click()
      await page.getByTestId('account-status').click()
      await expect(page.getByTestId('status-text')).toBeFocused()
      await page.screenshot({ path: path.join(dir, '1440-light-status.png') })
    })
  })
})
