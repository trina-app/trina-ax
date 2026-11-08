// "이 방에서는 항상 허용" in the browser (docs/DECISIONS.md "대화방에서 새 파일은 미리 허용"): the room's change card with its
// three buttons and the line under them, each button's answer, a granted folder taking the next new file without a card
// (the server's part played here: this spec answers the room through page.route, rooms-mock.ts, and sends the events
// through the mock's /__test/publish), the wider-audience card that stands in for both, Settings › 트리나에게 허용한 것
// (rows, delete, the empty line) and the admin switch. SHOTS_DIR=<folder>: screenshots of each at 1440 and 390, light and
// dark; SHOTS_BEFORE=1 with it: the card as the server sent it before (two buttons, the old words).
import fs from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import type { AiAllowance, TurnRequest } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const JIN = { id: 'jin', name: '박진' }
const OLGA = { id: 'olga', name: 'Olga' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`
const TURN = (n: number) => `019a5f00-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`
const CHAT = '019a5f00-0000-7000-8000-000000000401'
const T0 = Date.parse('2026-11-08T09:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const FOLDER = '영업/견적서'

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
/** the room card for a new file, as server/src/chat/turn.ts confirmRoomChange sends it (Korean) */
const roomCard = (n: number, file = '견적서_A사.md'): Ask => ({
  kind: 'ask_user', origin: 'server', requestId: `room-card-${n}`, multiple: false, allowText: false, buttons: true,
  question: `트리나가 ${FOLDER}에 새 파일을 저장하려고 해요: ${file}. 바뀐 파일은 기록에서 되돌릴 수 있어요.`,
  options: [{ label: '이번만 허용', value: 'allow' }, { label: '이 방에서는 항상 허용', value: 'always' }, { label: '허용 안 함', value: 'skip' }],
  note: '내가 부를 때, 이 폴더에 새 파일을 만들 때만 적용돼요.',
  details: [{ label: '바꿀 내용', fields: [{ name: '하는 일', value: '저장' }, { name: '파일', value: `${FOLDER}/${file}` }], text: '# 견적서\n\n- 품목: 사무용 의자 12개\n- 단가: 180,000원\n- 합계: 2,160,000원\n', collapsedAt: 400 }],
})
/** the card before this change: two buttons and the old words */
const oldCard = (): Ask => ({
  kind: 'ask_user', origin: 'server', requestId: 'room-card-old', multiple: false, allowText: false,
  question: '대화방에서 받은 질문으로 트리나가 이 작업을 하려고 해요: \'견적서_A사.md\' 저장. 대화방에는 다른 사람의 메시지도 있어요. 하게 할까요?',
  options: [{ label: '하게 하기', value: 'allow' }, { label: '하지 않기', value: 'skip' }],
  details: roomCard(0).details,
})
/** one card for a call that needs both: the wider-audience card with what the call writes, no "always" */
const widenCard = (): Ask => ({
  kind: 'ask_user', origin: 'server', requestId: 'widen-card', multiple: false, allowText: false,
  question: `AI가 볼 수 있는 사람이 더 적은 내용(재무팀)을 읽은 뒤 ${FOLDER}/견적서_A사.md에 저장하려고 해요. 이곳은 12명이 볼 수 있어요. 저장할까요?`,
  options: [{ label: '저장하기', value: 'save' }, { label: '저장하지 않기', value: 'skip' }],
  details: roomCard(0).details,
})
const grantRow = (n: number, room: AiAllowance['room']): AiAllowance => ({ kind: 'room_files', id: `019a5f00-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`, room, folder: n === 1 ? FOLDER : '마케팅/캠페인/2026', createdAt: '2026-11-08T03:00:00.000Z', expiresAt: '2026-12-08T03:00:00.000Z' })
const ROOM_VIEW = { id: ROOM_ID, kind: 'group' as const, name: '디자인 리뷰', peers: [SORA, JIN], memberCount: 3 }
const DM_VIEW = { id: '019a5f00-0000-7000-8000-000000000a09', kind: 'dm' as const, name: null, peers: [SORA], memberCount: 2 }

const publish = (page: Page, event: unknown) => page.request.post('/__test/publish', { data: { event } }).then((r) => expect(r.ok()).toBeTruthy())
const run = (n: number, state: 'running' | 'done') => ({ type: 'room.ai.run', data: { roomId: ROOM_ID, run: { turnId: TURN(n), roomId: ROOM_ID, questionId: id(n), state, position: 0, steps: [], error: null, createdAt: at(n) } } })
const aiAnswer = (n: number, body: string, openable: string[] = []) => ({
  type: 'room.message', data: { roomId: ROOM_ID, message: { id: id(50 + n), roomId: ROOM_ID, seq: 50 + n, authorKind: 'ai', author: null, askedBy: OLGA, visibility: 'room', body, replyTo: { id: id(n), author: OLGA, excerpt: '@트리나 견적서', fileCount: 0, deleted: false }, mentions: [], files: [], createdAt: at(n + 1), editedAt: null, deletedAt: null, ...(openable.length ? { openable } : {}) } },
})

/** The room with my question in it, the AI answering it, and its card on the way (when `card` is given). The answers to
 * cards are kept in order. */
async function openRoom(page: Page, card?: Ask) {
  await reset(page)
  await routeRoom(page, { members: [SORA, JIN], messages: [
    { id: id(90), author: SORA, body: '내일 A사 미팅 전에 견적서 하나 부탁해요' },
    { id: id(1), author: OLGA, body: '@트리나 /견적서 A사 사무용 의자 12개로 만들어줘' },
  ] })
  const answers: { turnId: string; body: Record<string, unknown> }[] = []
  await page.route(/\/api\/turns\/[^/]+\/answer$/, async (route) => {
    answers.push({ turnId: route.request().url().split('/').at(-2)!, body: route.request().postDataJSON() as Record<string, unknown> })
    await route.fulfill({ status: 204, body: '' })
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(2)
  if (card) await raise(page, 1, card)
  return answers
}
async function raise(page: Page, n: number, card: Ask) {
  await publish(page, run(n, 'running'))
  await publish(page, { type: 'turn.request', data: { turnId: TURN(n), chatId: CHAT, messageId: id(70 + n), request: card } })
  await expect(page.getByTestId('ask-card')).toBeVisible()
}

test('the room card: three buttons in a row and the line under them; each sends its own answer', async ({ page }) => {
  for (const [label, value] of [['이번만 허용', 'allow'], ['이 방에서는 항상 허용', 'always'], ['허용 안 함', 'skip']] as const) {
    const answers = await openRoom(page, roomCard(1))
    const card = page.getByTestId('ask-card')
    await expect(card).toHaveAttribute('data-kind', 'buttons')
    await expect(card.getByText('확인해 주세요', { exact: true })).toBeVisible()
    await expect(card.getByRole('radio')).toHaveCount(0)
    await expect(card.getByTestId('ask-send')).toHaveCount(0)
    await expect(card.getByTestId('ask-note')).toHaveText('내가 부를 때, 이 폴더에 새 파일을 만들 때만 적용돼요.')
    const buttons = card.getByTestId('ask-choice')
    // in the page the main one first (the phone's order, stacked); on a computer one row, the main one last (as on the
    // two-button card; room-ai-cards.spec.ts)
    await expect(buttons).toHaveText(['이번만 허용', '이 방에서는 항상 허용', '허용 안 함'])
    const boxes = await Promise.all([0, 1, 2].map((i) => buttons.nth(i).boundingBox()))
    expect(new Set(boxes.map((b) => Math.round(b!.y))).size).toBe(1)
    await card.getByRole('button', { name: label, exact: true }).click()
    await expect(page.getByTestId('ask-card')).toHaveCount(0)
    expect(answers).toEqual([{ turnId: TURN(1), body: { kind: 'ask_user', requestId: 'room-card-1', answer: value } }])
  }
})

test('on a phone the three buttons fit the card without widening the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openRoom(page, roomCard(1))
  const card = page.getByTestId('ask-card')
  const box = (await card.boundingBox())!
  for (const b of await card.getByTestId('ask-choice').all()) {
    const r = (await b.boundingBox())!
    expect(r.x).toBeGreaterThanOrEqual(box.x)
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 0.5)
    expect(r.height).toBeGreaterThanOrEqual(32)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('"항상" allows the folder: the next new file there comes without a card, and the room sees what was saved; deleted in Settings, the card is back', async ({ page }) => {
  const answers = await openRoom(page, roomCard(1))
  await page.getByTestId('ask-card').getByRole('button', { name: '이 방에서는 항상 허용' }).click()
  expect(answers.map((a) => a.body.answer)).toEqual(['always'])
  // the server saved the grant and answered
  await page.request.post('/__test/ai-allowances', { data: { items: [grantRow(1, ROOM_VIEW)] } })
  await publish(page, aiAnswer(1, `견적서를 만들었어요.`))
  await publish(page, run(1, 'done'))
  // the next question: the folder is allowed, so no card; the answer names the file it saved
  await publish(page, run(2, 'running'))
  const path = `${FOLDER}/견적서_B사.md`
  await publish(page, aiAnswer(2, `B사 견적서도 만들었어요.\n\n미리 허용한 폴더에 저장한 파일: [견적서_B사.md](/files/view?path=${encodeURIComponent(path)})`, [path]))
  await publish(page, run(2, 'done'))
  await expect(page.getByText('B사 견적서도 만들었어요.')).toBeVisible()
  await expect(page.getByText('미리 허용한 폴더에 저장한 파일:')).toBeVisible()
  await expect(page.getByTestId('ask-card')).toHaveCount(0)
  expect(answers).toHaveLength(1)

  // Settings › 트리나에게 허용한 것: the row, and [지우기]
  await page.goto('/settings/allowances')
  const list = page.getByTestId('allowance-list')
  await expect(list.getByTestId('allowance-row')).toHaveCount(1)
  await expect(list.getByTestId('allowance-row')).toContainText('디자인 리뷰')
  await expect(list.getByTestId('allowance-row')).toContainText(FOLDER)
  await expect(list.getByTestId('allowance-row')).toContainText('새 파일 저장')
  await expect(list.getByTestId('allowance-row')).toContainText('11월 8일')
  await list.getByRole('button', { name: '지우기' }).click()
  await expect(page.getByTestId('allowance-row')).toHaveCount(0)
  await expect(page.getByTestId('allowances-empty')).toBeVisible()
  expect((await (await page.request.get('/api/ai-allowances')).json()).items).toEqual([])
  // back in the room: the next new file asks again
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  await raise(page, 3, roomCard(3, '견적서_C사.md'))
  await expect(page.getByTestId('ask-card').getByTestId('ask-choice')).toHaveCount(3)
})

test('a call that also needs the wider-audience card: that one card, with what it writes, and no "항상"', async ({ page }) => {
  const answers = await openRoom(page, widenCard())
  const card = page.getByTestId('ask-card')
  await expect(card).toHaveAttribute('data-kind', 'confirm')
  await expect(card.getByText('확인해 주세요', { exact: true })).toBeVisible()
  await expect(card.getByTestId('ask-detail-fields')).toContainText(`${FOLDER}/견적서_A사.md`)
  await expect(card.getByRole('button', { name: '이 방에서는 항상 허용' })).toHaveCount(0)
  await card.getByTestId('ask-yes').click()
  expect(answers.map((a) => a.body.answer)).toEqual(['save'])
})

test('Settings › 트리나에게 허용한 것: one row per grant, the room as I see it (a 1:1 by the other person); empty, one line', async ({ page }) => {
  await reset(page)
  await page.request.post('/__test/ai-allowances', { data: { items: [grantRow(1, ROOM_VIEW), grantRow(2, DM_VIEW)] } })
  await signIn(page)
  await page.goto('/settings/allowances')
  const rows = page.getByTestId('allowance-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('디자인 리뷰')
  await expect(rows.nth(1)).toContainText('소라님')
  await expect(rows.nth(1)).toContainText('마케팅/캠페인/2026')
  await rows.nth(1).getByRole('button', { name: '지우기' }).click()
  await expect(rows).toHaveCount(1)
  await rows.nth(0).getByRole('button', { name: '지우기' }).click()
  await expect(page.getByTestId('allowances-empty')).toHaveText('아직 허용한 것이 없어요.')
})

test("Admin › Team settings: the switch for \"항상 허용\" in rooms, on by default, saved with the form", async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  const row = page.getByTestId('team-room-always')
  await expect(row).toHaveAttribute('data-on', 'true')
  await expect(row).toContainText("대화방에서 '항상 허용' 쓰기")
  await expect(row.locator('#ts-room-always-desc')).toHaveText('켜 두면 대화방의 확인 카드에서 폴더에 새 파일 저장을 미리 허용할 수 있어요. 끄면 매번 물어봐요.')
  const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
  await row.getByText("대화방에서 '항상 허용' 쓰기").click()
  await expect(row).toHaveAttribute('data-on', 'false')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  expect((await saved).postDataJSON()).toEqual({ roomAlwaysAllow: false })
  await page.reload()
  await expect(page.getByTestId('team-room-always')).toHaveAttribute('data-on', 'false')
})

test('screenshots (SHOTS_DIR): the room card, the merged card, the settings list with rows and empty, the admin switch', async ({ page }) => {
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
      if (before) {
        await openRoom(page, oldCard())
        await shot('room-card')
        // the new card's three choices as an older app would show them
        await openRoom(page, roomCard(1))
        await shot('room-card-3-choices')
        continue
      }
      await openRoom(page, roomCard(1))
      await page.getByTestId('ask-card').scrollIntoViewIfNeeded()
      await shot('room-card')
      // the measured type sizes and button heights (ui-polish: measure, do not guess)
      if (scheme === 'light') {
        const sizes = await page.evaluate(() => {
          const px = (el: Element | null) => (el ? { font: getComputedStyle(el).fontSize, height: Math.round(el.getBoundingClientRect().height) } : null)
          const card = document.querySelector('[data-testid="ask-card"]')!
          return {
            title: px(card.querySelector('p')), question: px(card.querySelector('p[id]')), choices: [...card.querySelectorAll('[data-testid="ask-choice"]')].map(px),
            note: px(card.querySelector('[data-testid="ask-note"]')), detailField: px(card.querySelector('[data-testid="ask-detail-fields"] dd')), detailText: px(card.querySelector('[data-testid="ask-detail-text"]')),
          }
        })
        fs.writeFileSync(`${dir}/fonts-room-card-${width}.json`, JSON.stringify(sizes, null, 2))
      }
      await openRoom(page, widenCard())
      await page.getByTestId('ask-card').scrollIntoViewIfNeeded()
      await shot('merged-card')
      await reset(page)
      await page.request.post('/__test/ai-allowances', { data: { items: [grantRow(1, ROOM_VIEW), grantRow(2, DM_VIEW)] } })
      await signIn(page)
      await page.goto('/settings/allowances')
      await expect(page.getByTestId('allowance-row')).toHaveCount(2)
      await shot('settings-allowances')
      if (scheme === 'light') {
        const sizes = await page.evaluate(() => {
          const px = (el: Element | null) => (el ? { font: getComputedStyle(el).fontSize, height: Math.round(el.getBoundingClientRect().height) } : null)
          const row = document.querySelector('[data-testid="allowance-row"]')!
          return { title: px(document.querySelector('[data-testid="ai-allowances"] h2')), desc: px(document.querySelector('[data-testid="ai-allowances"] h2 + p')), place: px(row.querySelector('p')), meta: px(row.querySelectorAll('p')[1] ?? null), delete: px(row.querySelector('button')), row: px(row) }
        })
        fs.writeFileSync(`${dir}/fonts-settings-${width}.json`, JSON.stringify(sizes, null, 2))
      }
      await page.request.post('/__test/ai-allowances', { data: { items: [] } })
      await page.reload()
      await expect(page.getByTestId('allowances-empty')).toBeVisible()
      await shot('settings-allowances-empty')
      await page.goto('/admin/settings')
      const sw = page.getByTestId('team-room-always')
      await sw.scrollIntoViewIfNeeded()
      await page.evaluate(() => window.scrollBy(0, -120))
      await shot('admin-switch')
    }
  }
})
