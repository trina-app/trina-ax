// "대화방에 보내기" (components/chat/ShareToRoom.tsx): a finished answer of my own AI chat goes to a room I am in as my
// message. Ask, get the answer, open the picker from the answer's row, find the room, add a note; the mock server (like
// the team server) first asks when people of the room cannot open what the answer used, then posts it; the toast opens
// the room, where the answer is a quote under my note, headed "트리나 답변", with no 수정 in its menu. A long answer is
// said to be cut before it goes, and arrives cut. On a phone the picker is a bottom sheet.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const TEAM = uuidv7()
const DM = uuidv7()
const base = { canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const ROOMS = [
  { ...base, id: TEAM, kind: 'team', name: '마케팅팀', groupId: uuidv7(), memberCount: 6, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(5) },
  { ...base, id: DM, kind: 'dm', name: null, groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(10) },
]

/** No serious accessibility problem (the picker's search, list and options; the confirm step; the room). */
async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

async function start(page: Page) {
  await reset(page)
  await signIn(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
}

/** A new chat with one question answered; the answer's row is in view (the newest answer's). */
async function ask(page: Page, question: string) {
  const r = await page.request.post('/api/chats', { headers: { [CSRF_HEADER]: '1' }, data: { title: 'Share' } })
  const id = ((await r.json()) as { id: string }).id
  await page.goto(`/c/${id}`)
  await page.getByTestId('composer-input').fill(question)
  await page.getByTestId('send').click()
  await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1, { timeout: 20_000 })
}

test('an answer goes to a room as my message: pick, note, the confirm, the toast, the quote in the room', async ({ page }) => {
  await start(page)
  await ask(page, 'sources 이번 분기 매출은 어디서 보면 돼?')
  const share = page.getByTestId('share-to-room')
  await expect(share).toHaveAccessibleName('대화방에 보내기')
  await share.click()
  const dialog = page.getByRole('dialog', { name: '대화방에 보내기' })
  // my rooms as the "#" list shows them; the search finds one, Esc would close it all
  await expect(dialog.getByTestId('share-room-option')).toHaveText([/마케팅팀\s*멤버 6명/, /Bob · 1:1/])
  await expect(dialog.getByTestId('share-room-send')).toBeDisabled()
  await dialog.getByTestId('share-room-search').fill('마케')
  await expect(dialog.getByTestId('share-room-option')).toHaveCount(1)
  await dialog.getByTestId('share-room-search').press('Enter')
  await expect(dialog.getByTestId('share-room-note')).toBeFocused()
  await expect(dialog.getByTestId('share-room-option')).toHaveAttribute('aria-selected', 'true')
  await audit(page, 'picker')
  await dialog.getByTestId('share-room-note').fill('회의 전에 봐 주세요')
  await expect(dialog.getByTestId('share-room-cut')).toHaveCount(0)
  await dialog.getByTestId('share-room-note').press('Enter')
  // the answer read files some people of the room cannot open: how many, and where (never who)
  await expect(dialog.getByTestId('share-room-people')).toHaveText('방 사람 중 5명은 이 답에 쓰인 파일을 열 수 없어요. 그래도 보낼까요?')
  await expect(dialog.getByTestId('share-room-place')).toHaveText(['docs/sources/', 'marketing/', '열 수 없는 다른 곳'])
  await audit(page, 'confirm')
  await dialog.getByTestId('share-room-anyway').click()
  await expect(dialog).toHaveCount(0)
  const toast = page.getByTestId('toast').filter({ hasText: '마케팅팀에 보냈어요' })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: '열기' }).click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${TEAM}$`))
  // in the room: my note, then the answer as a quote with its file links
  const msg = page.getByTestId('room-message').filter({ has: page.getByTestId('room-shared-answer') })
  await expect(msg).toHaveCount(1)
  await expect(msg).toContainText('회의 전에 봐 주세요')
  await expect(msg.getByTestId('room-shared-answer-head')).toHaveText('트리나 답변')
  await expect(msg.getByTestId('room-shared-answer').getByTestId('team-file-chip')).toHaveCount(2)
  await audit(page, 'room')
  // copy and delete stay; no 수정
  await msg.hover()
  await msg.getByTestId('message-more').click()
  await expect(page.getByTestId('message-copy')).toBeVisible()
  await expect(page.getByTestId('message-delete')).toBeVisible()
  await expect(page.getByTestId('message-edit')).toHaveCount(0)
})

test('a long answer is said to be cut before it goes, and arrives cut; Esc closes the picker', async ({ page }) => {
  await start(page)
  await ask(page, 'long list 캠페인 아이디어')
  await page.getByTestId('share-to-room').click()
  const dialog = page.getByRole('dialog', { name: '대화방에 보내기' })
  await dialog.getByTestId('share-room-search').press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByTestId('share-to-room').click()
  await dialog.getByTestId('share-room-option').filter({ hasText: 'Bob' }).click()
  await expect(dialog.getByTestId('share-room-cut')).toHaveText('답변이 길어서 앞부분만 보내요 · 나머지는 내 트리나 기록에 있어요')
  await dialog.getByTestId('share-room-send').click()
  await expect(page.getByTestId('toast').filter({ hasText: 'Bob · 1:1에 보냈어요' })).toBeVisible()
  await page.goto(`/rooms/${DM}`)
  const quote = page.getByTestId('room-shared-answer')
  await expect(quote).toContainText('아이디어 1:')
  await expect(quote).not.toContainText('아이디어 400:')
  await expect(quote).toContainText('전체는 내 트리나 기록에서')
})

test('a confidential chat (Safe operations 1A) has no 대화방에 보내기: the server would refuse it', async ({ page }) => {
  await start(page)
  // the mock makes a chat confidential when a message in it says so, as Safe operations 1A does
  await ask(page, 'confidential 이번 분기 매출 정리')
  await expect(page.getByTestId('assistant-message').getByTestId('regenerate')).toBeVisible()
  await expect(page.getByTestId('share-to-room')).toHaveCount(0)
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the picker is a bottom sheet with the note and 보내기 at its foot', async ({ page }) => {
    await start(page)
    await ask(page, 'sources 이번 분기 매출은 어디서 보면 돼?')
    await page.getByTestId('share-to-room').click()
    const dialog = page.getByRole('dialog', { name: '대화방에 보내기' })
    await expect(dialog.getByTestId('share-room-option')).toHaveCount(2)
    const box = (await dialog.boundingBox())!
    expect(Math.round(box.y + box.height)).toBe(844)
    expect(box.width).toBe(390)
    // nothing pushes the keyboard up before a tap: the search is not focused
    await expect(dialog.getByTestId('share-room-search')).not.toBeFocused()
    const send = (await dialog.getByTestId('share-room-send').boundingBox())!
    expect(send.y + send.height).toBeLessThanOrEqual(844)
    // no page-wide sideways scroll
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })
})
