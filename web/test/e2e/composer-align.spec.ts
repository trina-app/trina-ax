// The message boxes' buttons and their text share one centre (a room's box, a thread's, the AI chat's): with one line or
// none, the clip or "+", the text (and its placeholder), the mic and send are centred on one line, within 1 px; with
// more lines the buttons stay at the bottom, centred on the last line, as in ChatGPT and Slack. Each control sits in a
// slot as tall as one text line's box (index.css --spacing-composer-line). Measured on a computer (1440 px), in a narrow
// window (700 px: the phone's text sizes with a computer's buttons) and on a phone (390 px, touch: the phone app's box),
// at the default and the largest text size, also while an answer runs (stop, "send when done"). The recording bar is as
// tall as the row it stands in for, with ✕ and ✓ on the same centre.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

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
  /** the controls beside the text, left to right */
  controls: (phone: boolean) => string[]
}

const ROOM: Box = {
  name: 'room',
  open: async (page) => {
    await page.goto(`/rooms/${ROOM_ID}`)
    return page.getByTestId('room-composer').first()
  },
  input: 'room-input',
  controls: () => ['room-attach', 'voice-button', 'room-send'],
}
const THREAD: Box = {
  name: 'thread',
  open: async (page) => {
    await page.goto(`/rooms/${ROOM_ID}/t/${ROOT.id}`)
    return page.getByTestId('room-thread').getByTestId('room-composer')
  },
  input: 'room-input',
  controls: () => ['room-attach', 'voice-button', 'room-send'],
}
const AI: Box = {
  name: 'AI chat',
  open: async (page) => {
    await page.goto('/')
    return page.getByTestId('composer')
  },
  input: 'composer-input',
  // computers: "+" is in the row under the box
  controls: (phone) => [...(phone ? ['attach-button'] : []), 'voice-button', 'send'],
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
      for (const b of [ROOM, THREAD, AI]) await expectLinedUp(page, b, v.phone, v.where)
      // the person's largest text size (lib/textSize.ts): the slots grow with the line
      await largestText(page)
      for (const b of [ROOM, AI]) await expectLinedUp(page, b, v.phone, `${v.where} (largest text)`, '22.4px')
    })

    test('while an answer runs, stop and "send when done" sit on the line too', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      const box = page.getByTestId('composer')
      const input = box.getByTestId('composer-input')
      await input.fill(SLOW)
      await box.getByTestId('send').click()
      await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
      await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'streaming')
      const ids = [...(v.phone ? ['attach-button'] : []), 'voice-button', 'send-later', 'stop']
      await input.fill('Hello')
      for (const id of ids) await expect(box.getByTestId(id)).toBeVisible()
      let m = await measure(box, 'composer-input', ids)
      expect(m.lines).toBe(1)
      for (const id of ids) expect(Math.abs(m.controls[id]! - m.first), `${v.where} running, one line: ${id}`).toBeLessThanOrEqual(1)
      await input.fill(FOUR)
      await expect.poll(async () => (await measure(box, 'composer-input', ids)).lines).toBe(4)
      m = await measure(box, 'composer-input', ids)
      for (const id of ids) expect(Math.abs(m.controls[id]! - m.last), `${v.where} running, four lines: ${id}`).toBeLessThanOrEqual(1)
      await input.fill('')
      await box.getByTestId('stop').click()
    })

    test('the recording bar is as tall as the row, ✕ and ✓ on its centre', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [ROOT] })
      await signIn(page)
      for (const b of [ROOM, AI]) await expectBarLikeRow(page, b, v.where)
    })
  })
}
