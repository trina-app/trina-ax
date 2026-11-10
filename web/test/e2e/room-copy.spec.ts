// Copying room messages (components/rooms/RoomMessages.tsx, lib/messageCopy.ts): a selection dragged over several
// messages and ⌘C give their words as plain text, one message per block under its author and time, a file as its name;
// never the hover bar's ✅ 👀 👍, reaction chips, "답글 N개", "수정됨" or a file's buttons. A selection inside one
// message copies just that text. A thread's panel copies the same way; the ✦ side chat copies an answer without its
// buttons and keeps its own copy button. The room is answered through page.route (rooms-mock.ts).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

// a fixed time zone: the times copied are the ones shown (the mock's messages are at 09:0n UTC)
test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Seoul' })

const SORA = { id: 'sora', name: '소라님' }
const BEN = { id: 'ben', name: '벤' }
const OLGA = { id: 'olga', name: 'Olga' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const brief = { id: id(90), name: 'acme-brief.pdf', size: 2048, mime: 'application/pdf', kind: 'pdf', thumb: false }
const MESSAGES = [
  { id: id(1), author: SORA, body: '이번 주 시안 공유드려요' },
  { id: id(2), author: SORA, body: '피드백 부탁드려요', extra: { files: [brief], reactions: [{ emoji: '✅', count: 2, mine: false, users: [SORA, BEN] }] } },
  { id: id(3), author: OLGA, body: '네네, 수요일까지 보내기로했어요', extra: { editedAt: '2026-11-05T09:10:00.000Z', thread: { replyCount: 2, repliers: [SORA, BEN], lastReplyAt: '2026-11-05T09:07:00.000Z', newReplies: false } } },
  { id: id(4), author: BEN, body: '👍' },
  // the thread of the third message
  { id: id(5), author: SORA, body: '금요일 회의 전에 볼게요', threadRootId: id(3) },
  { id: id(6), author: BEN, body: '저도요', threadRootId: id(3) },
]

async function openRoom(page: Page) {
  await reset(page)
  await signIn(page)
  const room = await routeRoom(page, { members: [SORA, BEN], messages: MESSAGES })
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(4)
  return room
}
const words = (msg: Locator) => msg.locator('p.whitespace-pre-wrap')

/** A mouse drag from the left edge of `from` to the right end of `to`, as a person selects text. */
async function drag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!
  await page.mouse.move(a.x + 1, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 4 })
  await page.mouse.up()
}
async function copied(page: Page) {
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await page.keyboard.press('ControlOrMeta+c')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('')
  return page.evaluate(() => navigator.clipboard.readText())
}

test('several messages copy as one block each: author and time once per run, a file as its name, no buttons', async ({ page }) => {
  await openRoom(page)
  const msgs = page.getByTestId('room-message')
  // the hover bar is in the page for every message, and the second one has a reaction, a file and the third a thread
  await expect(msgs.nth(1).getByTestId('reaction-chip')).toHaveCount(1)
  await expect(msgs.nth(2).getByTestId('room-thread-line')).toBeVisible()
  await drag(page, words(msgs.nth(0)), words(msgs.nth(3)))
  const text = await copied(page)
  console.log(`copied (several):\n${JSON.stringify(text)}`)
  expect(text).toBe([
    '소라님  오후 6:01',
    '이번 주 시안 공유드려요',
    '',
    '피드백 부탁드려요',
    'acme-brief.pdf',
    '',
    'Olga  오후 6:03',
    '네네, 수요일까지 보내기로했어요',
    '',
    '벤  오후 6:04',
    '👍',
  ].join('\n'))
  for (const junk of ['✅', '👀', '답글', '수정됨', '미리보기', 'KB']) expect(text).not.toContain(junk)

  // the controls cannot be selected at all; the words can
  const select = (l: Locator) => l.evaluate((e) => getComputedStyle(e).userSelect)
  expect(await select(msgs.nth(1).getByTestId('message-hover-bar'))).toBe('none')
  expect(await select(msgs.nth(1).getByTestId('reaction-chip'))).toBe('none')
  expect(await select(msgs.nth(1).getByTestId('room-file'))).toBe('none')
  expect(await select(msgs.nth(2).getByTestId('room-thread-line'))).toBe('none')
  expect(await select(words(msgs.nth(1)))).toBe('text')
})

test('a selection that starts mid-message gives the part selected, under its author line', async ({ page }) => {
  await openRoom(page)
  const msgs = page.getByTestId('room-message')
  // from inside the second message's text (after "피드백 ") to the end of the third
  await page.evaluate(() => {
    const ps = document.querySelectorAll('[data-testid="room-message"] p.whitespace-pre-wrap')
    const start = ps[1]!.firstChild!
    const end = ps[2]!
    const r = document.createRange()
    r.setStart(start, '피드백 '.length)
    r.setEnd(end, end.childNodes.length)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(r)
  })
  await expect(msgs).toHaveCount(4)
  expect(await copied(page)).toBe(['소라님  오후 6:01', '부탁드려요', 'acme-brief.pdf', '', 'Olga  오후 6:03', '네네, 수요일까지 보내기로했어요'].join('\n'))
})

test('a selection inside one message copies just that text', async ({ page }) => {
  await openRoom(page)
  const msgs = page.getByTestId('room-message')
  // the whole of the edited third message, dragged: its words, not "(수정됨)"
  await drag(page, words(msgs.nth(2)), words(msgs.nth(2)))
  const one = await copied(page)
  console.log(`copied (one message):\n${JSON.stringify(one)}`)
  expect(one).toBe('네네, 수요일까지 보내기로했어요')
  // a part of it
  await page.evaluate(() => {
    const t = document.querySelectorAll('[data-testid="room-message"] p.whitespace-pre-wrap')[2]!.firstChild!
    const r = document.createRange()
    r.setStart(t, 4)
    r.setEnd(t, 9)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(r)
  })
  expect(await copied(page)).toBe('수요일까지')
  // three clicks on the second: its text, without the reaction or the file
  await words(msgs.nth(1)).click({ clickCount: 3 })
  expect((await copied(page)).trim()).toBe('피드백 부탁드려요')
})

test("a thread's root and replies copy the same way", async ({ page }) => {
  await openRoom(page)
  await page.getByTestId('room-message').nth(2).getByTestId('room-thread-line').click()
  const thread = page.getByTestId('room-thread')
  await expect(thread.getByTestId('room-message')).toHaveCount(3)
  await drag(page, words(thread.getByTestId('room-message').first()), words(thread.getByTestId('room-message').last()))
  expect(await copied(page)).toBe([
    'Olga  오후 6:03',
    '네네, 수요일까지 보내기로했어요',
    '',
    '소라님  오후 6:05',
    '금요일 회의 전에 볼게요',
    '',
    '벤  오후 6:06',
    '저도요',
  ].join('\n'))
})

test('the side chat: a question and its answer copy without the buttons; the answer keeps its own copy button', async ({ page }) => {
  await openRoom(page)
  const msg = page.getByTestId('room-message').first()
  await msg.hover()
  await msg.getByTestId('message-ask-trina').click()
  const side = page.getByTestId('room-side-chat')
  await side.getByTestId('side-chat-input').fill('한 줄로 정리해 줘')
  await side.getByTestId('side-chat-send').click()
  const answer = side.locator('[data-testid="assistant-message"][data-status="done"]')
  await expect(answer).toHaveCount(1, { timeout: 20_000 })
  await expect(answer.getByTestId('send-here-thread')).toBeVisible()
  // from the question to the end of the answer's buttons, as a drag past the answer goes
  await drag(page, side.getByTestId('user-text').first(), answer.getByTestId('answer-actions'))
  const text = await copied(page)
  console.log(`copied (side chat):\n${JSON.stringify(text)}`)
  expect(text).toContain('한 줄로 정리해 줘')
  expect(text).toContain('로고 시안은 수요일까지')
  for (const junk of ['스레드에 보내기', '작업 1단계', 'claude-sonnet']) expect(text).not.toContain(junk)
  // its own copy button copies the answer as it was written (Markdown)
  await answer.hover()
  await answer.getByRole('button', { name: '답변 복사' }).click()
  await expect(answer.getByRole('button', { name: '복사됨' })).toBeVisible()
  const md = await page.evaluate(() => navigator.clipboard.readText())
  expect(md.length).toBeGreaterThan(0)
  expect(text).toContain(md.replace(/\*\*/g, '').split('\n')[0]!.trim())
})
