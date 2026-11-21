// A thread and the ✦ side chat open together (pages/Room.tsx, lib/roomColumns.ts;
// docs/decisions/20261117-thread-plus-trina.md): room, thread, side chat as three columns where the page's row holds
// them (the conversation list folds away for it below 1448 px); the thread and the side chat half and half over the room
// in a narrower row; the side chat over the thread on a phone, with ‹ back to the thread. The side chat's box says
// "Looking at this thread": with the chip on a question goes with a thread line (the thread's id, no message text), its
// bubble shows a "Thread" mark, its answer offers Send to thread; ✕ takes the chip off and the next question is about
// the room; the thread opened again brings it back. Esc closes one panel a press where they cover the room, and the thread beside it (QA TC-6923). The room
// through page.route (rooms-mock.ts), the chats and answers by the mock server.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

// the room's answers come through page.route, which does not see what the app's service worker fetches
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const SORA = { id: 'sora', name: '소라님' }
const BEN = { id: 'ben', name: '벤' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`
const ROOT = id(1)
const OTHER = id(5)

/** `reply`: one more reply in the first thread (a link to a team file, say) */
async function open(page: Page, o: { thread?: string | null; reply?: string } = {}) {
  await reset(page)
  const room = await routeRoom(page, {
    members: [SORA, BEN],
    messages: [
      { id: ROOT, author: SORA, body: '이번 주 시안 검토 일정 공유드려요. 금요일까지 피드백 부탁드립니다.', extra: { thread: { replyCount: 2, lastReplyAt: '2026-11-05T09:03:00.000Z', repliers: [SORA, BEN], newReplies: false } } },
      { id: id(2), author: SORA, body: '로고 버전 두 개 중에 어느 쪽이 나은지 의견 주세요.', threadRootId: ROOT },
      { id: id(3), author: BEN, body: '두 번째 안이 좋아 보여요. 색 대비가 더 분명해요.', threadRootId: ROOT },
      ...(o.reply ? [{ id: id(4), author: SORA, body: o.reply, threadRootId: ROOT }] : []),
      { id: OTHER, author: BEN, body: '다음 주 회의는 화요일 오전으로 옮길게요.', extra: { thread: { replyCount: 1, lastReplyAt: '2026-11-05T09:05:00.000Z', repliers: [SORA], newReplies: false } } },
      { id: id(6), author: SORA, body: '화요일 좋아요.', threadRootId: OTHER },
    ],
  })
  await signIn(page)
  const thread = o.thread === undefined ? ROOT : o.thread
  await page.goto(thread ? `/rooms/${ROOM_ID}/t/${thread}` : `/rooms/${ROOM_ID}`)
  if (thread) await expect(page.getByTestId('room-thread').getByTestId('room-message').first()).toBeVisible()
  else await expect(page.getByTestId('room-message').first()).toBeVisible()
  return room
}

const box = async (l: Locator) => (await l.boundingBox())!
const question = (page: Page) => page.waitForRequest((r) => r.method() === 'POST' && /^\/api\/chats\/[^/]+\/messages$/.test(new URL(r.url()).pathname))
/** type a question in the side chat and send it: what went to the server */
async function ask(page: Page, text: string): Promise<string> {
  const side = page.getByTestId('room-side-chat')
  const answers = await side.locator('[data-testid="assistant-message"][data-status="done"]').count()
  await side.getByTestId('side-chat-input').fill(text)
  const [q] = await Promise.all([question(page), side.getByTestId('side-chat-send').click()])
  await expect(side.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(answers + 1, { timeout: 20_000 })
  return (q.postDataJSON() as { content: string }).content
}

/** No serious accessibility problem on the page as it stands. */
async function audit(page: Page, where: string) {
  // a tooltip under the resting pointer fades in over 100 ms; axe caught mid-fade reads its half-clear text as low
  // contrast. Reduced motion drops the fade (Tooltip's motion-reduce:transition-none): it is either hidden or fully drawn
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const r =await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('1440: ✦ on a thread keeps the thread: three columns, the list folds; the chip, what a send carries, Send to thread; ✕ and back', async ({ page }) => {
  await open(page)
  const pageEl = page.getByTestId('room-page')
  const thread = page.getByTestId('room-thread')
  const side = page.getByTestId('room-side-chat')
  // a thread alone: the list shows, the thread has its divider
  await expect(page.getByTestId('chats-panel')).toBeVisible()
  await expect(page.getByTestId('thread-divider')).toBeVisible()

  await page.getByTestId('room-side-chat-button').click()
  await expect(side).toBeVisible()
  await expect(thread).toBeVisible()
  await expect(pageEl).toHaveAttribute('data-columns', 'three')
  // the side chat, not the thread, is marked as mine: ✦, "나만 봐요" and its own tint (QA TC-5675)
  await expect(side.getByTestId('side-chat-mark').locator('svg')).toBeVisible()
  await expect(side.getByTestId('side-chat-only-you')).toHaveText('·나만 봐요')
  await expect(thread.getByTestId('side-chat-only-you')).toHaveCount(0)
  const fill = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor)
  expect(await fill(side.getByTestId('side-chat-panel'))).not.toBe(await fill(thread))
  // the list folded away for the three columns; the rail stays
  await expect(page.getByTestId('chats-panel')).toHaveCount(0)
  await expect(page.getByTestId('rail')).toBeVisible()
  // room | thread | side chat, left to right, each at its minimum or more, the two panels the same width, no divider
  const [r, th, s] = [await box(page.getByTestId('room')), await box(thread), await box(side)]
  expect(r.x + r.width).toBeLessThanOrEqual(th.x + 1)
  expect(th.x + th.width).toBeLessThanOrEqual(s.x + 1)
  expect(Math.round(s.x + s.width)).toBe(1440)
  expect(r.width).toBeGreaterThanOrEqual(420)
  expect(Math.round(th.width)).toBe(Math.round(s.width))
  expect(th.width).toBeGreaterThanOrEqual(320)
  expect(th.width).toBeLessThanOrEqual(440)
  await expect(page.getByTestId('thread-divider')).toHaveCount(0)
  await expect(page.getByTestId('side-chat-divider')).toHaveCount(0)
  // the room is in reach (columns, not a cover) and ✦ is pressed
  await expect(page.getByTestId('room')).not.toHaveAttribute('inert', /.*/)
  await expect(page.getByTestId('room-side-chat-button')).toHaveAttribute('aria-pressed', 'true')

  // the box says what it looks at; the empty chat offers the thread's one starter, not the room's three
  const chip = side.getByTestId('side-chat-thread-chip')
  await expect(chip).toHaveText('이 스레드를 보는 중')
  await expect(side.getByTestId('side-chat-thread-chip-off')).toHaveAccessibleName('대화 전체에 대해 묻기')
  await expect(side.getByTestId('side-chat-context')).toHaveCount(0)
  await expect(side.getByTestId('side-chat-starter-thread')).toHaveText('이 스레드 요약')
  await expect(side.getByTestId('side-chat-intro')).toHaveText(/^이 스레드에 대해 .+에게 물어보세요/)
  await expect(side.getByTestId('side-chat-starter-catchUp')).toHaveCount(0)
  await expect(side.getByTestId('side-chat-input')).toHaveAttribute('placeholder', /이 스레드에 대해/)
  await expect(side.getByTestId('side-chat-input')).toBeFocused()
  await audit(page, 'three columns')

  // a question with the chip on: one line on top names the thread (its id, who started it, when), no message text
  const content = await ask(page, '한 줄로 정리해 줘')
  const [head, blank, asked, ...more] = content.split('\n')
  expect(head).toMatch(new RegExp(`^> 🧵 소라님 · .+ \\(thread_id ${ROOT} in this room\\)$`))
  expect([blank, asked, more]).toEqual(['', '한 줄로 정리해 줘', []])
  // its bubble: a "Thread" mark, never the line or the id
  const bubble = side.getByTestId('user-text').first()
  await expect(bubble.getByTestId('user-quote-thread')).toContainText('스레드 · 소라님')
  await expect(bubble).toContainText('한 줄로 정리해 줘')
  await expect(bubble).not.toContainText('thread_id')
  await expect(bubble).not.toContainText('🧵')
  // the answer goes to that thread with one click
  const first = side.locator('[data-testid="assistant-message"]').first()
  await expect(first.getByTestId('send-here-thread')).toHaveText('스레드에 보내기')
  // the chip stays on for the next question
  await expect(chip).toBeVisible()

  // ✕: the chip goes, the box is about the conversation again, and the next question carries no thread
  await side.getByTestId('side-chat-thread-chip-off').click()
  await expect(chip).toHaveCount(0)
  await expect(side.getByTestId('side-chat-input')).toBeFocused()
  await expect(side.getByTestId('side-chat-input')).toHaveAttribute('placeholder', /이 대화에 대해/)
  const plain = await ask(page, '한 줄로 다시')
  expect(plain).toBe('한 줄로 다시')
  // ...and its answer goes to the conversation: the thread line counted for its own question only
  const second = side.locator('[data-testid="assistant-message"]').nth(1)
  await expect(second.getByTestId('send-here-room')).toHaveText('대화에 보내기')
  await expect(second.getByTestId('send-here-thread')).toHaveCount(0)
  await expect(first.getByTestId('send-here-thread')).toBeVisible()

  // the thread closed: the side chat stays (beside the room, with its divider), the list is back, no chip
  await thread.getByTestId('thread-close').click()
  await expect(thread).toHaveCount(0)
  await expect(side).toBeVisible()
  await expect(page.getByTestId('chats-panel')).toBeVisible()
  await expect(page.getByTestId('side-chat-divider')).toBeVisible()
  await expect(chip).toHaveCount(0)
  // another thread opened from the room: both show (three columns fit) and the chip is on again, for that thread
  await page.getByTestId('room-thread-line').nth(1).click()
  await expect(thread).toBeVisible()
  await expect(side).toBeVisible()
  await expect(pageEl).toHaveAttribute('data-columns', 'three')
  await expect(chip).toBeVisible()
  const about = await ask(page, '한 줄로 세 번째')
  expect(about.split('\n')[0]).toMatch(new RegExp(`^> 🧵 벤 · .+ \\(thread_id ${OTHER} in this room\\)$`))
  // ✦ again closes the side chat; the thread stays with its divider
  await page.getByTestId('room-side-chat-button').click()
  await expect(side).toHaveCount(0)
  await expect(thread).toBeVisible()
  await expect(page.getByTestId('thread-divider')).toBeVisible()
})

test('1280: the list folds away for the three columns and comes back when one closes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await open(page)
  await expect(page.getByTestId('chats-panel')).toBeVisible()
  await page.getByTestId('room-side-chat-button').click()
  await expect(page.getByTestId('room-page')).toHaveAttribute('data-columns', 'three')
  await expect(page.getByTestId('chats-panel')).toHaveCount(0)
  const [r, th, s] = [await box(page.getByTestId('room')), await box(page.getByTestId('room-thread')), await box(page.getByTestId('room-side-chat'))]
  expect(r.width).toBeGreaterThanOrEqual(420)
  expect(Math.round(th.width)).toBe(Math.round(s.width))
  expect(th.width).toBeGreaterThanOrEqual(320)
  // nothing runs off the window
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)
  await page.getByTestId('room-side-chat').getByTestId('side-chat-close').click()
  await expect(page.getByTestId('room-side-chat')).toHaveCount(0)
  await expect(page.getByTestId('chats-panel')).toBeVisible()
  await expect(page.getByTestId('room-thread')).toBeVisible()
  // the other way round: the side chat open, a thread opened from the room. The list folds, both show, and the
  // keyboard is not taken into the side chat (the two were never drawn over the room on the way)
  await page.getByTestId('room-thread').getByTestId('thread-close').click()
  await page.getByTestId('room-side-chat-button').click()
  await expect(page.getByTestId('room-side-chat').getByTestId('side-chat-input')).toBeFocused()
  await page.getByTestId('room').locator('textarea').first().focus()
  await page.evaluate(() => {
    const w = window as unknown as { __modes: (string | null)[] }
    w.__modes = []
    const el = document.querySelector('[data-testid="room-page"]')!
    new MutationObserver(() => w.__modes.push(el.getAttribute('data-columns'))).observe(el, { attributes: true, attributeFilter: ['data-columns'] })
  })
  await page.getByTestId('room-thread-line').first().click()
  await expect(page.getByTestId('room-page')).toHaveAttribute('data-columns', 'three')
  await expect(page.getByTestId('room-side-chat')).toBeVisible()
  await expect(page.getByTestId('chats-panel')).toHaveCount(0)
  await expect(page.getByTestId('room-side-chat').getByTestId('side-chat-input')).not.toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { __modes: (string | null)[] }).__modes)).toEqual(['three'])
})

test('1024: the thread and the side chat share the row over the room; Esc closes one a press; a thread opened from the room takes the side chat\'s place', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await open(page)
  const pageEl = page.getByTestId('room-page')
  const thread = page.getByTestId('room-thread')
  const side = page.getByTestId('room-side-chat')
  const roomEl = page.getByTestId('room')
  await page.getByTestId('room-side-chat-button').click()
  await expect(pageEl).toHaveAttribute('data-columns', 'pair')
  // half and half across the whole row; the room waits under them, out of reach
  const [row, th, s] = [await box(pageEl), await box(thread), await box(side)]
  expect(Math.round(th.x)).toBe(Math.round(row.x))
  expect(Math.round(th.width)).toBe(Math.round(row.width / 2))
  expect(Math.round(s.x + s.width)).toBe(Math.round(row.x + row.width))
  expect(th.width).toBeGreaterThanOrEqual(320)
  await expect(roomEl).toHaveAttribute('inert', /.*/)
  await expect(side.getByTestId('side-chat-thread-chip')).toBeVisible()
  await expect(side.getByTestId('side-chat-input')).toBeFocused()
  // two regions with their names, not two modal dialogs
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '스레드' })).toBeVisible()
  await audit(page, 'thread and side chat')

  // Esc while an input method composes (Korean, Japanese) cancels the composition: no panel closes
  await page.evaluate(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })))
  await page.evaluate(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true })))
  await expect(side).toBeVisible()
  await expect(thread).toBeVisible()
  // Esc with the keyboard in the side chat: it closes; the thread stays beside the room, which is in reach again
  await page.keyboard.press('Escape')
  await expect(side).toHaveCount(0)
  await expect(thread).toBeVisible()
  await expect(roomEl).not.toHaveAttribute('inert', /.*/)
  // Esc beside the room, the keyboard back in the thread's box: it closes the thread too (QA TC-6923; it closed nothing)
  await expect(thread.locator('textarea').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(thread).toHaveCount(0)

  // again, the keyboard in the thread's box: Esc closes the thread, the side chat stays beside the room
  await page.goto(`/rooms/${ROOM_ID}/t/${ROOT}`)
  await expect(thread.getByTestId('room-message').first()).toBeVisible()
  await page.getByTestId('room-side-chat-button').click()
  await expect(pageEl).toHaveAttribute('data-columns', 'pair')
  await thread.locator('textarea').first().focus()
  await page.keyboard.press('Escape')
  await expect(thread).toHaveCount(0)
  await expect(side).toBeVisible()
  await expect(roomEl).not.toHaveAttribute('inert', /.*/)

  // a thread opened from the room, the side chat open, no room for three: the thread takes the side chat's place (the
  // room does not give way to a click in it); ✦ then puts the two side by side, the same chat
  await side.getByTestId('side-chat-input').fill('나중에 물어볼 것')
  await page.getByTestId('room-thread-line').first().click()
  await expect(thread).toBeVisible()
  await expect(side).toHaveCount(0)
  await expect(roomEl).not.toHaveAttribute('inert', /.*/)
  await page.getByTestId('room-side-chat-button').click()
  await expect(pageEl).toHaveAttribute('data-columns', 'pair')
  await expect(side.getByTestId('side-chat-input')).toHaveValue('나중에 물어볼 것')
})

test('a phone: asking about a message of a thread opens the side chat over the thread; ‹ goes back to the thread, then to the room', async ({ page }) => {
  await open(page)
  const thread = page.getByTestId('room-thread')
  const side = page.getByTestId('room-side-chat')
  // "Ask about this" on a reply (a computer's hover bar; a phone's long press opens the same ask)
  const reply = thread.getByTestId('room-message').nth(2)
  await reply.hover()
  await reply.getByTestId('message-ask-trina').click()
  await expect(side).toBeVisible()
  await expect(thread).toBeVisible()
  // the quoted message stands in the chip's place (it names its own thread)
  await expect(side.getByTestId('side-chat-quote')).toBeVisible()
  await expect(side.getByTestId('side-chat-thread-chip')).toHaveCount(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('room-page')).toHaveAttribute('data-columns', 'one')
  // one panel: the side chat fills the screen, the thread waits under it, out of reach
  const s = await box(side)
  expect([Math.round(s.x), Math.round(s.width)]).toEqual([0, 390])
  await expect(thread).toHaveAttribute('inert', /.*/)
  await expect(page.getByTestId('room')).toBeHidden()
  // the quote taken off: the chip shows for the thread under it
  await side.getByTestId('side-chat-quote-remove').click()
  await expect(side.getByTestId('side-chat-thread-chip')).toBeVisible()
  const content = await ask(page, '한 줄로 정리해 줘')
  expect(content.split('\n')[0]).toMatch(new RegExp(`\\(thread_id ${ROOT} in this room\\)$`))
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  // ‹: back to the thread, as it was; ‹ again: the room
  await side.getByTestId('side-chat-back').click()
  await expect(side).toHaveCount(0)
  await expect(thread).toBeVisible()
  await expect(thread).not.toHaveAttribute('inert', /.*/)
  await expect(thread.getByTestId('room-message')).toHaveCount(3)
  await thread.getByTestId('thread-back').click()
  await expect(thread).toHaveCount(0)
  await expect(page.getByTestId('room')).toBeVisible()
})

/** the share endpoint as the server answers it: the answer goes into the room or the thread */
async function routeShare(page: Page, room: Awaited<ReturnType<typeof routeRoom>>) {
  await page.route(/\/api\/chats\/[^/]+\/messages\/[^/]+\/share-to-room$/, async (route) => {
    const b = route.request().postDataJSON() as { threadRootId?: string }
    const m = room.add({ author: { id: 'olga', name: 'Olga' }, body: '정리: 수요일까지 시안 2개.', ...(b.threadRootId ? { threadRootId: b.threadRootId } : {}), extra: { sharedAnswer: { at: 0, cut: false } } })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'sent', message: m, cut: false }) })
  })
}

test('"View" under an answer sent to the open thread keeps one step back to the room', async ({ page }) => {
  const room = await open(page)
  await routeShare(page, room)
  // opened from the room, so the thread is one step from it
  await page.goto(`/rooms/${ROOM_ID}`)
  await page.getByTestId('room-thread-line').first().click()
  const thread = page.getByTestId('room-thread')
  const side = page.getByTestId('room-side-chat')
  await expect(thread).toBeVisible()
  await page.getByTestId('room-side-chat-button').click()
  await ask(page, '한 줄로 정리해 줘')
  const answer = side.locator('[data-testid="assistant-message"]').first()
  await answer.getByTestId('send-here-thread').click()
  await expect(answer.getByTestId('send-here-sent')).toBeVisible()
  await answer.getByTestId('send-here-view').click()
  // the same thread, at the reply; both panels still there
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/t/${ROOT}\\?m=`))
  await expect(thread).toBeVisible()
  await expect(side).toBeVisible()
  await expect(thread.getByTestId('room-message')).toHaveCount(4)
  // the thread's ✕: the room, not the same thread once more
  await thread.getByTestId('thread-close').click()
  await expect(thread).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
  await expect(side).toBeVisible()
})

test('a phone: "View" under an answer sent to the thread under the side chat shows that thread; ‹ is the room; ✦ brings the same chat back', async ({ page }) => {
  const room = await open(page, { thread: null })
  await routeShare(page, room)
  // (opened from the room: the thread is one step from it)
  await page.getByTestId('room-thread-line').first().click()
  const thread = page.getByTestId('room-thread')
  const side = page.getByTestId('room-side-chat')
  await expect(thread.getByTestId('room-message')).toHaveCount(3)
  await page.getByTestId('room-side-chat-button').click()
  await expect(side.getByTestId('side-chat-thread-chip')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('room-page')).toHaveAttribute('data-columns', 'one')
  await ask(page, '한 줄로 정리해 줘')
  const answer = side.locator('[data-testid="assistant-message"]').first()
  await answer.getByTestId('send-here-thread').click()
  await expect(answer.getByTestId('send-here-sent')).toBeVisible()
  await answer.getByTestId('send-here-view').click()
  // the side chat steps aside: the thread with the reply, in reach
  await expect(side).toHaveCount(0)
  await expect(thread).toBeVisible()
  await expect(thread).not.toHaveAttribute('inert', /.*/)
  await expect(thread.getByTestId('room-message')).toHaveCount(4)
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/t/${ROOT}\\?m=`))
  // ‹: the room (one step); its ✦: the same chat, still saying it was sent
  await thread.getByTestId('thread-back').click()
  await expect(thread).toHaveCount(0)
  await expect(page.getByTestId('room')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
  await page.getByTestId('room-side-chat-button').click()
  await expect(side.getByTestId('user-text')).toHaveCount(1)
  await expect(side.locator('[data-testid="assistant-message"]').first().getByTestId('send-here-sent')).toBeVisible()
})

test('a file preview beside both: the page shows thread and side chat; Esc closes the preview first; in a small window one panel at a time', async ({ page }) => {
  const origin = new URL(test.info().project.use.baseURL!).origin
  await open(page, { reply: `보고서 여기 있어요: ${origin}/files/view?path=marketing%2Fplan.md` })
  const pageEl = page.getByTestId('room-page')
  const thread = page.getByTestId('room-thread')
  const side = page.getByTestId('room-side-chat')
  await page.getByTestId('room-side-chat-button').click()
  await expect(pageEl).toHaveAttribute('data-columns', 'three')
  await thread.getByTestId('app-link-chip').click()
  await expect(page.getByTestId('file-panel')).toContainText('launch')
  // the preview takes its width first (the page keeps 740 px): thread and side chat share the page, each 320 or more
  await expect(pageEl).toHaveAttribute('data-columns', 'pair')
  const [th, s, p] = [await box(thread), await box(side), await box(page.getByTestId('side-panel'))]
  expect(th.width).toBeGreaterThanOrEqual(320)
  expect(s.width).toBeGreaterThanOrEqual(320)
  expect(Math.round(s.x + s.width)).toBeLessThanOrEqual(Math.round(p.x) + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440)
  // Esc: the preview first, and only it; the three columns are back, where Esc closes nothing
  await side.getByTestId('side-chat-input').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('side-panel')).toHaveCount(0)
  await expect(side).toBeVisible()
  await expect(thread).toBeVisible()
  await expect(pageEl).toHaveAttribute('data-columns', 'three')
  await page.keyboard.press('Escape')
  await expect(side).toBeVisible()
  await expect(thread).toBeVisible()

  // the desktop app's smallest window with a preview: no room for two panels, the side chat is over the thread
  await thread.getByTestId('app-link-chip').click()
  await expect(page.getByTestId('file-panel')).toBeVisible()
  await page.setViewportSize({ width: 900, height: 700 })
  await expect(pageEl).toHaveAttribute('data-columns', 'one')
  await expect(thread).toHaveAttribute('inert', /.*/)
  const [row, over] = [await box(pageEl), await box(side)]
  expect([Math.round(over.x), Math.round(over.width)]).toEqual([Math.round(row.x), Math.round(row.width)])
  // Esc: the preview, then the side chat; the thread is in reach again
  await side.getByTestId('side-chat-input').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('side-panel')).toHaveCount(0)
  await expect(side).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
})
