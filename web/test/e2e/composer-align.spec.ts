// The message boxes' buttons and their text share one centre (a room's box, a thread's, the AI chat's): with one line or
// none, the clip or "+", the text (and its placeholder), the mic and send are centred on one line, within 1 px; with
// more lines the buttons stay at the bottom, centred on the last line, as in ChatGPT and Slack. Each control sits in a
// slot as tall as one text line's box (index.css --spacing-composer-line). Measured on a computer (1440 px), in a narrow
// window (700 px: the phone's text sizes with a computer's buttons) and on a phone (390 px, touch: the phone app's box),
// at the default and the largest text size, also while an answer runs (stop, "send when done"). The recording bar is as
// tall as the row it stands in for, with ✕ and ✓ on the same centre. A box with its row under the text (QA TC-391,
// TC-1400: every box on a computer; Home's card and a box with the engine picker below 768px) has the text alone on its
// line and its buttons on one centre in a row under it, inside the frame, the box as tall while recording, ✕ and ✓ on
// that row's centre.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'
import { isPhone } from './nav'

// Chromium's fake microphone, for the recording bar
test.use({ serviceWorkers: 'block', launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone', 'clipboard-read', 'clipboard-write'] })

const ROOT = { id: '019a5f00-0000-7000-8000-000000000001', author: { id: 'sora', name: '소라님' }, body: '시안 봤어요' }
const FOUR = 'one\ntwo\nthree\nfour'
// the mock answers this slowly (send-queue.spec.ts)
const SLOW = 'slow answer please, slow slow slow slow slow slow slow slow slow slow'

interface Box {
  name: string
  /** goes there and gives the box */
  open: (page: Page) => Promise<Locator>
  input: string
  /** the controls beside the text, left to right (a box in one line) */
  controls: (phone: boolean) => string[]
  /** the text on top and the buttons in a row under it (ComposerToolbar), with these buttons */
  row?: (phone: boolean) => string[] | null
}

const ROOM: Box = {
  name: 'room',
  open: async (page) => {
    await page.goto(`/rooms/${ROOM_ID}`)
    return page.getByTestId('room-composer').first()
  },
  input: 'room-input',
  controls: () => ['room-attach', 'voice-button', 'room-send'],
  // a computer: the row under the text; a phone: one line
  row: (phone) => (phone ? null : ['room-attach', 'voice-button', 'room-send']),
}
const THREAD: Box = {
  name: 'thread',
  open: async (page) => {
    await page.goto(`/rooms/${ROOM_ID}/t/${ROOT.id}`)
    return page.getByTestId('room-thread').getByTestId('room-composer')
  },
  input: 'room-input',
  controls: () => ['room-attach', 'voice-button', 'room-send'],
  row: (phone) => (phone ? null : ['room-attach', 'voice-button', 'room-send']),
}
/** an AI chat's page (a chat made for it): its box keeps the text and the buttons on one line on a phone too */
const AI: Box = {
  name: 'AI chat',
  open: async (page) => {
    const r = await page.request.post('/api/chats', { headers: { [CSRF_HEADER]: '1' }, data: {} })
    expect(r.ok()).toBeTruthy()
    await page.goto(`/c/${(await r.json()).id}`)
    return page.getByTestId('composer')
  },
  input: 'composer-input',
  controls: () => ['attach-button', 'voice-button', 'send'],
  // the owner may pick the engine: its box has the row under the text on every screen size
  row: () => CARD_ROW,
}
/** Home's box: a computer's is the chat's; below 768px it is the card (expectCard) */
const HOME: Box = {
  name: 'Home',
  open: async (page) => {
    // a phone's new-chat box is its own page (`/` is 트리나's list there, nav rail #673)
    await page.goto(isPhone(page) ? '/new' : '/')
    return page.getByTestId('composer')
  },
  input: 'composer-input',
  controls: () => ['voice-button', 'send'],
  row: () => CARD_ROW,
}
const CARD_ROW = ['attach-button', 'engine-picker', 'voice-button', 'send']

/** A box with its row under the text: the text alone on its line(s), the row's buttons on one centre under it and inside
 * the box's frame, empty, with one line and with four */
async function expectRow(page: Page, b: Box, phone: boolean, where: string) {
  const ids = b.row!(phone)!
  const box = await b.open(page)
  const input = box.getByTestId(b.input)
  await expect(input).toBeVisible()
  for (const id of ids) await expect(box.getByTestId(id), `${where} ${b.name}: ${id}`).toBeVisible()
  for (const text of ['', 'Hello', FOUR]) {
    await input.fill(text)
    if (text === FOUR) await expect.poll(async () => (await measure(box, b.input, [])).lines).toBe(4)
    const m = await measure(box, b.input, ids)
    const centres = ids.map((id) => m.controls[id]!)
    expect(Math.max(...centres) - Math.min(...centres), `${where} ${b.name} "${text.slice(0, 5)}": one centre ${centres.join(', ')}`).toBeLessThanOrEqual(1)
    const field = (await input.boundingBox())!
    const frame = (await box.boundingBox())!
    for (const id of ids) {
      const c = (await box.getByTestId(id).boundingBox())!
      expect(c.y, `${where} ${b.name}: ${id} under the text`).toBeGreaterThanOrEqual(field.y + field.height - 1)
      expect(c.y + c.height / 2, `${where} ${b.name}: ${id} inside the frame`).toBeLessThan(frame.y + frame.height)
    }
  }
  await input.fill('')
}

/** Recording in a box with its row under the text: the box as tall as before, ✕ and ✓ on the row's centre */
async function expectRowBar(page: Page, b: Box, where: string) {
  const box = await b.open(page)
  await box.getByTestId(b.input).fill('')
  const before = (await box.boundingBox())!
  const send = b.input === 'room-input' ? 'room-send' : 'send'
  const row = (await measure(box, b.input, [send])).controls[send]!
  await box.getByTestId('voice-button').click()
  const bar = box.getByTestId('voice-bar')
  await expect(bar).toBeVisible()
  const during = (await box.boundingBox())!
  expect(Math.abs(during.height - before.height), `${where} ${b.name}: ${before.height} → ${during.height} px while recording`).toBeLessThanOrEqual(0.5)
  for (const id of ['voice-cancel', 'voice-done']) {
    const c = (await bar.getByTestId(id).boundingBox())!
    expect(Math.abs(c.y + c.height / 2 - row), `${where} ${b.name} recording: ${id}`).toBeLessThanOrEqual(1)
  }
  await bar.getByTestId('voice-cancel').click()
  await expect(bar).toHaveCount(0)
}

/** The text's first and last line (their centres, from the text box's own padding and line height) and each control's
 * centre, in px from the top of the page. */
function measure(box: Locator, input: string, ids: string[]) {
  return box.evaluate(
    (el, { input, ids }) => {
      const ta = el.querySelector<HTMLTextAreaElement>(`[data-testid="${input}"]`)!
      const r = ta.getBoundingClientRect()
      const cs = getComputedStyle(ta)
      const px = (v: string) => parseFloat(v) || 0
      const line = px(cs.lineHeight)
      const top = r.top + px(cs.borderTopWidth) + px(cs.paddingTop)
      const bottom = r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom)
      const centre = (id: string) => {
        const c = el.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()
        return c && c.height > 0 ? c.top + c.height / 2 : null
      }
      return { lines: Math.round((bottom - top) / line), first: top + line / 2, last: bottom - line / 2, controls: Object.fromEntries(ids.map((id) => [id, centre(id)])) as Record<string, number | null> }
    },
    { input, ids },
  )
}

/** The page's root font size, the person's text size (lib/textSize.ts): 16px by default, 22.4px at the largest. */
const rootSize = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)

async function expectLinedUp(page: Page, b: Box, phone: boolean, where: string, root = '16px') {
  const box = await b.open(page)
  await expect.poll(() => rootSize(page), `${where}: the text size`).toBe(root)
  const input = box.getByTestId(b.input)
  await expect(input).toBeVisible()
  const ids = b.controls(phone)
  for (const id of ids) await expect(box.getByTestId(id), `${where} ${b.name}: ${id}`).toBeVisible()

  // empty (the placeholder's one line)
  await input.fill('')
  let m = await measure(box, b.input, ids)
  expect(m.lines, `${where} ${b.name}: one line when empty`).toBe(1)
  for (const id of ids) expect(Math.abs(m.controls[id]! - m.first), `${where} ${b.name} empty: ${id} ${m.controls[id]} vs the line ${m.first}`).toBeLessThanOrEqual(1)

  // one line of text
  await input.fill('Hello')
  m = await measure(box, b.input, ids)
  expect(m.lines).toBe(1)
  for (const id of ids) expect(Math.abs(m.controls[id]! - m.first), `${where} ${b.name} one line: ${id}`).toBeLessThanOrEqual(1)

  // four lines: the buttons stay at the bottom, on the last line
  await input.fill(FOUR)
  await expect.poll(async () => (await measure(box, b.input, ids)).lines, `${where} ${b.name}: four lines`).toBe(4)
  m = await measure(box, b.input, ids)
  for (const id of ids) expect(Math.abs(m.controls[id]! - m.last), `${where} ${b.name} four lines: ${id} ${m.controls[id]} vs the last line ${m.last}`).toBeLessThanOrEqual(1)
  await input.fill('')
}

/** Recording: the bar is as tall as the row it replaces, ✕ and ✓ on the row's centre. */
async function expectBarLikeRow(page: Page, b: Box, where: string) {
  const box = await b.open(page)
  const input = box.getByTestId(b.input)
  await input.fill('')
  const before = (await box.boundingBox())!
  const line = (await measure(box, b.input, [])).first
  await box.getByTestId('voice-button').click()
  const bar = box.getByTestId('voice-bar')
  await expect(bar).toBeVisible()
  const during = (await box.boundingBox())!
  expect(Math.abs(during.height - before.height), `${where} ${b.name}: the box ${before.height} → ${during.height} px while recording`).toBeLessThanOrEqual(0.5)
  for (const id of ['voice-cancel', 'voice-done']) {
    const c = (await bar.getByTestId(id).boundingBox())!
    expect(Math.abs(c.y + c.height / 2 - line), `${where} ${b.name} recording: ${id}`).toBeLessThanOrEqual(1)
  }
  await bar.getByTestId('voice-cancel').click()
  await expect(bar).toHaveCount(0)
}

async function largestText(page: Page) {
  const r = await page.request.patch('/api/me', { headers: { [CSRF_HEADER]: '1' }, data: { prefs: { textSize: 'largest' } } })
  expect(r.ok()).toBeTruthy()
}

for (const v of [
  { where: 'computer', viewport: { width: 1440, height: 900 }, phone: false },
  { where: 'narrow window', viewport: { width: 700, height: 900 }, phone: true },
  { where: 'phone', viewport: { width: 390, height: 844 }, phone: true, touch: true },
]) {
  test.describe(v.where, () => {
    test.use({ viewport: v.viewport, ...(v.touch ? { hasTouch: true, isMobile: true } : {}) })

    test('the buttons and the text share one centre; with more lines the buttons stay on the last line', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [ROOT] })
      await signIn(page)
      const check = (b: Box, where: string, root?: string) => (b.row?.(v.phone) ? expectRow(page, b, v.phone, where) : expectLinedUp(page, b, v.phone, where, root))
      for (const b of [ROOM, THREAD, AI, HOME]) await check(b, v.where)
      // the person's largest text size (lib/textSize.ts): the slots grow with the line
      await largestText(page)
      for (const b of [ROOM, AI, HOME]) await check(b, `${v.where} (largest text)`, '22.4px')
    })

    test('while an answer runs, stop and "send when done" sit in the row too', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      const box = page.getByTestId('composer')
      const input = box.getByTestId('composer-input')
      await input.fill(SLOW)
      await box.getByTestId('send').click()
      await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
      await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'streaming')
      // the box's row under the text (the owner may pick the engine): one centre, under the text
      const ids = ['attach-button', 'engine-picker', 'voice-button', 'send-later', 'stop']
      for (const text of ['Hello', FOUR]) {
        await input.fill(text)
        for (const id of ids) await expect(box.getByTestId(id)).toBeVisible()
        if (text === FOUR) await expect.poll(async () => (await measure(box, 'composer-input', [])).lines).toBe(4)
        const m = await measure(box, 'composer-input', ids)
        const centres = ids.map((id) => m.controls[id]!)
        expect(Math.max(...centres) - Math.min(...centres), `${v.where} running "${text.slice(0, 5)}": one centre ${centres.join(', ')}`).toBeLessThanOrEqual(1)
        const field = (await input.boundingBox())!
        for (const id of ids) expect((await box.getByTestId(id).boundingBox())!.y, `${v.where} running: ${id} under the text`).toBeGreaterThanOrEqual(field.y + field.height - 1)
      }
      await input.fill('')
      await box.getByTestId('stop').click()
    })

    test('the recording bar is as tall as the row, ✕ and ✓ on its centre', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [ROOT] })
      await signIn(page)
      for (const b of [ROOM, AI, HOME]) await (b.row?.(v.phone) ? expectRowBar(page, b, v.where) : expectBarLikeRow(page, b, v.where))
    })
  })
}
