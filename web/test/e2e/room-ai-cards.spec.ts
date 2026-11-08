// A room's AI cards in the browser (docs/DECISIONS.md "대화방의 확인 카드는 다시 읽는다"): Bob asks @트리나 and its card
// ("확인해 주세요") comes back after a reload and in another browser of his (a phone here), and answering it from there
// works; another member gets no card; a new card comes fully into view when the room is at the bottom, also when the
// room's own jump to the bottom fires its scroll event after the card came (the race that left only the card's first
// line above the message box), and someone who scrolled up is left there; the two-button and three-button cards put
// their main button last, on the right, and on a phone the three stack with the main one on top. The server's part is
// played here (rooms-mock.ts and the mock's /__test/publish); that only the asker gets the card is tested against the
// real server in tests/unit/b-rooms-ai-cards.test.ts. SHOTS_DIR=<folder>: screenshots of the card after a reload, the
// two-button card and the three-button card at 1440 and 390, light and dark; SHOTS_BEFORE=1 names them before-*.
import { expect, test, type Page } from '@playwright/test'
import type { TurnRequest } from '@mycel/shared/api'
import { OWNER, reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockRoomAi } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const BOB = { id: 'bob', name: 'Bob' }
const ERIN = { id: 'erin', name: 'Erin' }
const BOB_LOGIN = { username: 'bob', password: 'bob password 1' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000006${String(n).padStart(2, '0')}`
const TURN = (n: number) => `019a5f00-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`
const CHAT = '019a5f00-0000-7000-8000-000000000801'
const T0 = Date.parse('2026-11-08T09:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const FOLDER = '영업/견적서'

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
/** the room's change card for a new file (three buttons), as server/src/chat/turn.ts confirmRoomChange sends it */
const roomCard = (n: number): Ask => ({
  kind: 'ask_user', origin: 'server', requestId: `room-card-${n}`, multiple: false, allowText: false, buttons: true,
  question: `트리나가 ${FOLDER}에 새 파일을 저장하려고 해요: 견적서_acme.md. 바뀐 파일은 기록에서 되돌릴 수 있어요.`,
  options: [{ label: '이번만 허용', value: 'allow' }, { label: '이 방에서는 항상 허용', value: 'always' }, { label: '허용 안 함', value: 'skip' }],
  note: '내가 부를 때, 이 폴더에 새 파일을 만들 때만 적용돼요.',
  details: [{ label: '바꿀 내용', fields: [{ name: '하는 일', value: '저장' }, { name: '파일', value: `${FOLDER}/견적서_acme.md` }], text: '# 견적서\n\n- 품목: 사무용 의자 12개\n- 단가: 180,000원\n- 합계: 2,160,000원\n', collapsedAt: 400 }],
})
/** a two-button card (the wider-audience card) */
const twoCard = (n: number): Ask => ({
  kind: 'ask_user', origin: 'server', requestId: `two-card-${n}`, multiple: false, allowText: false,
  question: `AI가 볼 수 있는 사람이 더 적은 내용(재무팀)을 읽은 뒤 ${FOLDER}/견적서_acme.md에 저장하려고 해요. 이곳은 12명이 볼 수 있어요. 저장할까요?`,
  options: [{ label: '저장하기', value: 'save' }, { label: '저장하지 않기', value: 'skip' }],
  details: roomCard(0).details,
})
const runOf = (n: number) => ({ turnId: TURN(n), roomId: ROOM_ID, questionId: id(n), state: 'running' as const, position: 0, steps: [], error: null, createdAt: at(n) })
const open = (n: number, request: Ask) => ({ turnId: TURN(n), chatId: CHAT, messageId: id(70 + n), request })
const publish = (page: Page, event: unknown) => page.request.post('/__test/publish', { data: { event } }).then((r) => expect(r.ok()).toBeTruthy())

/** Bob's room (Bob, Olga, Erin) with his question, `earlier` older messages above it, opened by `as` (Bob by default);
 * the AI's state as the server keeps it for that person (`ai`), and the answers to cards in order (an answer closes the
 * card on the "server"). `fresh: false`: another window of a test that has one open already (the mock is not reset). */
async function openRoom(page: Page, o: { as?: typeof BOB_LOGIN; ai?: MockRoomAi; earlier?: number; fresh?: boolean } = {}) {
  const ai = o.ai ?? { answering: 0, mine: [], requests: [] }
  if (o.fresh !== false) await reset(page)
  await routeRoom(page, { members: [BOB, ERIN], messages: [
    ...Array.from({ length: o.earlier ?? 0 }, (_, i) => ({ id: id(30 + i), author: i % 2 ? ERIN : BOB, body: `지난주 acme 견적 이야기 ${i + 1}\n수량과 단가를 다시 맞춰 봐요.` })),
    { id: id(90), author: ERIN, body: '내일 acme 미팅 전에 견적서 하나 부탁해요' },
    { id: id(1), author: BOB, body: '@트리나 /견적서 acme 사무용 의자 12개로 만들어줘' },
  ], ai })
  const answers: { turnId: string; body: Record<string, unknown> }[] = []
  await page.route(/\/api\/turns\/[^/]+\/answer$/, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    answers.push({ turnId: route.request().url().split('/').at(-2)!, body })
    ai.requests = ai.requests.filter((r) => (r as { request: { requestId: string } }).request.requestId !== body.requestId)
    await route.fulfill({ status: 204, body: '' })
  })
  await signIn(page, o.as ?? BOB_LOGIN)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(2 + (o.earlier ?? 0))
  return { ai, answers }
}
/** the AI starts on Bob's question n and raises its card: the events to Bob's windows, and what the server lists */
async function raise(page: Page, ai: MockRoomAi, n: number, card: Ask) {
  ai.answering = 1
  ai.mine = [runOf(n)]
  await publish(page, { type: 'room.ai.run', data: { roomId: ROOM_ID, run: runOf(n) } })
  await expect(page.getByTestId('room-ai-run')).toBeVisible()
  ai.requests = [open(n, card)]
  await publish(page, { type: 'turn.request', data: open(n, card) })
  await expect(page.getByTestId('ask-card')).toBeVisible()
}
/** the card's box inside the room's scroller (the part between the header and the message box) */
async function inView(page: Page) {
  const card = (await page.getByTestId('ask-card').boundingBox())!
  const list = (await page.getByTestId('room-scroller').boundingBox())!
  return { top: card.y >= list.y - 0.5, bottom: card.y + card.height <= list.y + list.height + 0.5, card, list }
}

test('a reload with an open card: the card is back under the question, and answering it works', async ({ page }) => {
  const { ai, answers } = await openRoom(page)
  await raise(page, ai, 1, roomCard(1))
  await page.reload()
  await expect(page.getByTestId('room-message')).toHaveCount(2)
  const card = page.getByTestId('room-ai-run').getByTestId('ask-card')
  await expect(card).toBeVisible()
  await expect(card.getByText('확인해 주세요', { exact: true })).toBeVisible()
  await expect(card.getByTestId('ask-choice')).toHaveCount(3)
  // the dots give way to the card, as when it came over the socket
  await expect(page.getByTestId('room-ai-stop')).toBeVisible()
  await card.getByRole('button', { name: '이번만 허용', exact: true }).click()
  await expect(page.getByTestId('ask-card')).toHaveCount(0)
  expect(answers).toEqual([{ turnId: TURN(1), body: { kind: 'ask_user', requestId: 'room-card-1', answer: 'allow' } }])
  // read again (a reconnect): the answered card does not come back
  await page.reload()
  await expect(page.getByTestId('room-ai-run')).toBeVisible()
  await expect(page.getByTestId('ask-card')).toHaveCount(0)
})

test('another browser of the asker (his phone) shows the card and can answer it; another member gets none', async ({ page, browser }) => {
  const { ai, answers } = await openRoom(page)
  await raise(page, ai, 1, twoCard(1))
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'ko-KR', baseURL: test.info().project.use.baseURL, serviceWorkers: 'block' })
  const olga = await browser.newContext({ locale: 'ko-KR', baseURL: test.info().project.use.baseURL, serviceWorkers: 'block' })
  try {
    // Bob's phone opens the room after the card was sent: no event brings it there, the list does
    const p = await phone.newPage()
    const onPhone = await openRoom(p, { ai, fresh: false })
    const card = p.getByTestId('ask-card')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('ask-no')).toHaveText('저장하지 않기')
    // Olga, another member: the server lists no question of hers and no card (b-rooms-ai-cards.test.ts); she sees that
    // the AI is answering someone, and nothing of the card
    const o = await olga.newPage()
    await openRoom(o, { as: OWNER, ai: { answering: 1, mine: [], requests: [] }, fresh: false })
    await expect(o.getByTestId('room-ai-answering')).toBeVisible()
    await expect(o.getByTestId('ask-card')).toHaveCount(0)
    await expect(o.getByText('재무팀')).toHaveCount(0)
    // answered on the phone: it goes there; the computer's card closes with the server's event
    await card.getByTestId('ask-yes').click()
    await expect(card).toHaveCount(0)
    expect(onPhone.answers).toEqual([{ turnId: TURN(1), body: { kind: 'ask_user', requestId: 'two-card-1', answer: 'save' } }])
    expect(answers).toEqual([])
    await publish(page, { type: 'turn.request.closed', data: { turnId: TURN(1), requestId: 'two-card-1', reason: 'answered' } })
    await expect(page.getByTestId('ask-card')).toHaveCount(0)
  } finally {
    await phone.close()
    await olga.close()
  }
})

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`at ${width}: a new card comes fully into view at the bottom, also when the room's own scroll event comes after it; scrolled up, nothing moves`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const { ai } = await openRoom(page, { earlier: 24 })
    // the room follows its bottom
    const scroller = page.getByTestId('room-scroller')
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2)
    ai.answering = 1
    ai.mine = [runOf(1)]
    await publish(page, { type: 'room.ai.run', data: { roomId: ROOM_ID, run: runOf(1) } })
    await expect(page.getByTestId('room-ai-run')).toBeVisible()
    // the race, made certain: content came after the room jumped to its bottom, and that jump's scroll event comes
    // only now (before this fix the room took it for the reader scrolling up and stopped following)
    await scroller.evaluate(async (el) => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
      const pad = document.createElement('div')
      pad.style.height = '330px'
      el.firstElementChild!.appendChild(pad)
      el.dispatchEvent(new Event('scroll'))
      await frame(); await frame()
      pad.remove()
      await frame(); await frame()
    })
    await publish(page, { type: 'turn.request', data: open(1, roomCard(1)) })
    await expect(page.getByTestId('ask-card')).toBeVisible()
    await expect.poll(async () => { const v = await inView(page); return v.top && v.bottom }, { message: 'the whole card above the message box' }).toBe(true)
    await expect(page.getByTestId('ask-card').getByRole('button', { name: '이번만 허용', exact: true })).toBeInViewport({ ratio: 1 })

    // the card answered, Bob scrolls up to read; the next question's card does not move him
    await page.getByTestId('ask-card').getByRole('button', { name: '허용 안 함', exact: true }).click()
    await expect(page.getByTestId('ask-card')).toHaveCount(0)
    await scroller.hover()
    await page.mouse.wheel(0, -900)
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(400)
    await page.waitForTimeout(200)
    const top = await scroller.evaluate((el) => el.scrollTop)
    await publish(page, { type: 'turn.request', data: open(1, { ...roomCard(2), requestId: 'room-card-2' }) })
    await expect(page.getByTestId('ask-card')).toHaveCount(1)
    await page.waitForTimeout(300)
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top)
    expect((await inView(page)).bottom).toBe(false)
  })
}

test('button order: the main button last, on the right, on the two-button and the three-button card; on a phone the three stack with the main one on top', async ({ page }) => {
  const { ai } = await openRoom(page)
  // two buttons: [저장하지 않기] [저장하기]
  await raise(page, ai, 1, twoCard(1))
  const two = page.getByTestId('ask-card')
  const no = (await two.getByTestId('ask-no').boundingBox())!
  const yes = (await two.getByTestId('ask-yes').boundingBox())!
  expect(no.x).toBeLessThan(yes.x)
  const twoRight = yes.x + yes.width
  await publish(page, { type: 'turn.request.closed', data: { turnId: TURN(1), requestId: 'two-card-1', reason: 'answered' } })
  await expect(two).toHaveCount(0)

  // three buttons: [허용 안 함] [이 방에서는 항상 허용] [이번만 허용], one row, ending where the two-button card's do
  await publish(page, { type: 'turn.request', data: open(1, roomCard(1)) })
  const three = page.getByTestId('ask-card')
  await expect(three).toHaveAttribute('data-kind', 'buttons')
  const buttons = three.getByTestId('ask-choice')
  await expect(buttons).toHaveText(['허용 안 함', '이 방에서는 항상 허용', '이번만 허용'])
  const boxes = await Promise.all([0, 1, 2].map(async (i) => (await buttons.nth(i).boundingBox())!))
  expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1)
  expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x)
  expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x)
  expect(Math.abs(boxes[2]!.x + boxes[2]!.width - twoRight)).toBeLessThan(1.5)
  await expect(buttons.nth(2)).toHaveClass(/bg-accent/)
  // keyboard order follows what is seen: "no" first, the main one last
  await buttons.nth(0).focus()
  await page.keyboard.press('Tab')
  await expect(buttons.nth(1)).toBeFocused()

  // a phone: stacked full width, the main one on top, "no" at the bottom
  await page.setViewportSize({ width: 390, height: 844 })
  const card = (await three.boundingBox())!
  const stacked = await Promise.all(['이번만 허용', '이 방에서는 항상 허용', '허용 안 함'].map(async (name) => (await three.getByRole('button', { name, exact: true }).boundingBox())!))
  expect(stacked[0]!.y).toBeLessThan(stacked[1]!.y)
  expect(stacked[1]!.y).toBeLessThan(stacked[2]!.y)
  for (const b of stacked) {
    // the card's inner width: its 1px border and 16px padding on each side
    expect(b.width).toBeGreaterThanOrEqual(card.width - 2 * 17 - 0.5)
    expect(b.height).toBeGreaterThanOrEqual(36)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('screenshots (SHOTS_DIR): the card after a reload, the two-button card, the three-button card', async ({ page }) => {
  const dir = process.env.SHOTS_DIR
  test.skip(!dir, 'only with SHOTS_DIR')
  const before = process.env.SHOTS_BEFORE === '1'
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width, height })
      const shot = async (name: string) => {
        await page.mouse.move(0, height - 1)
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${dir}/${before ? 'before-' : ''}${name}-${width}-${scheme}.png` })
      }
      const r = await openRoom(page)
      await raise(page, r.ai, 1, roomCard(1))
      await page.reload()
      await expect(page.getByTestId('room-ai-run')).toBeVisible()
      if (!before) await expect(page.getByTestId('ask-card')).toBeVisible()
      await page.waitForTimeout(500)
      await shot('reload-card')
      const two = await openRoom(page)
      await raise(page, two.ai, 1, twoCard(1))
      await page.getByTestId('ask-card').scrollIntoViewIfNeeded()
      await shot('two-button-card')
      const three = await openRoom(page)
      await raise(page, three.ai, 1, roomCard(1))
      await page.getByTestId('ask-card').scrollIntoViewIfNeeded()
      await shot('three-button-card')
    }
  }
})
