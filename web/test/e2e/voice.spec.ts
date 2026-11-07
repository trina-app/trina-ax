// Voice input in the browser (lib/useVoiceInput.ts, components/VoiceBar.tsx): the mic and a transcription job into the
// box; the chat a recording names and the confidential note; holding Space (a computer: this Chromium hovers with a fine
// pointer) in the AI chat's box and a room's, a short tap typing a space, Esc, the job's own label while it runs, a
// click in a room (with the hint to hold Space next time), no mic while "this server" lacks its tools. Words go into the
// box and are never sent by themselves.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

// Chromium's fake microphone (a beep) stands in for a real one.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone', 'clipboard-read', 'clipboard-write'] })

// on a computer the mic says how to talk without it
const MIC = '음성 입력 (Space 길게)'

test('voice input goes through a transcription job into the composer', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('group', { name: '녹음 중' })).toBeVisible()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  const log = (await (await page.request.post('/__test/log')).json()) as string[]
  expect(log).toContain('POST /api/transcribe')
})

const speech = async (page: import('@playwright/test').Page, provider: 'local' | 'openrouter', key = false) =>
  expect((await page.request.post('/__test/speech', { data: { provider, key } })).ok()).toBeTruthy()
const transcribeChats = async (page: import('@playwright/test').Page) => (await (await page.request.post('/__test/transcribe-chats')).json()) as (string | null)[]
const record = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('group', { name: '녹음 중' })).toBeVisible()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
}
const NOTE = '기밀 대화에서는 녹음을 바깥 음성 서비스(OpenRouter)로 보내지 않아서 음성 입력을 쓸 수 없어요.'

test('voice input in a chat names that chat; on the new-chat page it names none', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await record(page)
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  const chatId = page.url().split('/c/')[1]!
  await expect(page.getByRole('button', { name: MIC })).toBeEnabled()
  await record(page)
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  expect(await transcribeChats(page)).toEqual([null, chatId])
})

test('a confidential chat with voice input through OpenRouter: the composer says why instead of recording', async ({ page }) => {
  await reset(page)
  await speech(page, 'openrouter', true)
  await signIn(page)
  await page.getByTestId('composer-input').fill('confidential plan')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  // the page knows the chat is confidential (chat.updated, sent before the answer) before the mic is pressed; a click
  // before that records, and the server refuses it (the next test)
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('alert')).toContainText(NOTE)
  await expect(page.getByRole('group', { name: '녹음 중' })).toHaveCount(0)
  expect(await transcribeChats(page)).toEqual([])
})

test('the server is the gate: a recording it refuses shows its note in the composer', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('confidential plan')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  // the team moves voice input to OpenRouter after this page loaded (it still thinks it is on this server)
  await speech(page, 'openrouter', true)
  await record(page)
  await expect(page.getByRole('alert')).toContainText('기밀 대화라서 녹음을 바깥 음성 서비스(OpenRouter)로 보내지 않았어요.')
  await expect(page.getByTestId('composer-input')).toHaveValue('')
})

test('every chat confidential (Safe operations 1A): a new chat says why too; on this server the mic records', async ({ page }) => {
  await reset(page)
  expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
  await speech(page, 'openrouter', true)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('alert')).toContainText(NOTE)
  await speech(page, 'local')
  await page.reload()
  await record(page)
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  expect(await transcribeChats(page)).toEqual([null])
})

/** hold Space in the focused box until the bar shows, then let it go */
async function holdSpace(page: Page) {
  await page.keyboard.down('Space')
  const bar = page.getByTestId('voice-bar')
  await expect(bar).toBeVisible()
  await expect(bar).toHaveAttribute('data-mode', 'hold')
  await expect(bar.getByTestId('voice-hint')).toHaveText('Space를 떼면 끝나요 · Esc 취소')
  await page.waitForTimeout(500)
  await page.keyboard.up('Space')
  await expect(bar).toHaveCount(0)
}

test('hold Space in the AI chat\'s box: it records while held, the words go into the box, nothing is sent', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const box = page.getByTestId('composer-input')
  await box.click()
  // a short press does not record
  await page.keyboard.down('Space')
  await page.waitForTimeout(200)
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  await page.keyboard.up('Space')
  await expect(box).toHaveValue(' ')
  await box.fill('')
  await holdSpace(page)
  await expect(box).toHaveValue('받아쓴 문장입니다')
  await expect(box).toBeFocused()
  await expect(page.getByTestId('voice-live')).toHaveText('텍스트를 넣었어요')
  expect(await transcribeChats(page)).toEqual([null])
  // not sent: still the new-chat page, the words waiting in the box
  await page.waitForTimeout(300)
  await expect(page).not.toHaveURL(/\/c\//)
  await expect(page.getByTestId('send')).toBeEnabled()

  // in a box with text the Space typed first is taken back (the caret between "a" and "b")
  await box.fill('ab')
  await box.press('ArrowLeft')
  await holdSpace(page)
  await expect(box).toHaveValue('ab 받아쓴 문장입니다')
})

test('Space is a Space when it is not held: a tap, fast typing, Space with another key, Shift', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const box = page.getByTestId('composer-input')
  await box.click()
  await page.keyboard.press('Space')
  await expect(box).toHaveValue(' ')
  await box.fill('hello')
  await page.keyboard.press('Space')
  await expect(box).toHaveValue('hello ')
  await box.fill('')
  await page.keyboard.type('a b  c ')
  await expect(box).toHaveValue('a b  c ')
  // another key while Space is still down (fast typing): the space goes in first
  await box.fill('')
  await page.keyboard.down('Space')
  await page.keyboard.press('x')
  await page.keyboard.up('Space')
  await expect(box).toHaveValue(' x')
  await box.fill('')
  await page.keyboard.down('Shift')
  await page.keyboard.down('Space')
  await page.waitForTimeout(600)
  await page.keyboard.up('Space')
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  expect(await transcribeChats(page)).toEqual([])
})

test('Esc cancels a held recording, and a transcription on its way', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const box = page.getByTestId('composer-input')
  await box.fill('메모')
  await page.keyboard.down('Space')
  await expect(page.getByTestId('voice-bar')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  await page.keyboard.up('Space')
  // the space the hold took back stays out; the caret is back where it was
  await expect(box).toHaveValue('메모')
  await expect(box).toBeFocused()
  expect(await box.evaluate((t: HTMLTextAreaElement) => [t.selectionStart, t.selectionEnd])).toEqual([2, 2])
  expect(await transcribeChats(page)).toEqual([])

  await page.request.post('/__test/transcribe-progress', { data: { message: '받아쓰는 중', progress: null, ms: 5000 } })
  await box.fill('메모')
  await holdSpace(page)
  await expect(box).toHaveAttribute('aria-busy', 'true')
  await page.keyboard.press('Escape')
  await expect(box).not.toHaveAttribute('aria-busy', 'true')
  await expect(box).not.toHaveAttribute('readonly', '')
  await page.waitForTimeout(5500)
  await expect(box).toHaveValue('메모')
})

test('Esc for a menu opened during a clicked recording closes the menu and leaves the recording on', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  const bar = page.getByRole('group', { name: '녹음 중' })
  await expect(bar).toBeVisible()
  // the recording that ends with ✓ waits there with the focus (a keyboard start too)
  await expect(bar.getByRole('button', { name: '녹음 끝내기' })).toBeFocused()
  await page.getByTestId('attach-button').click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(bar).toBeVisible()
  // Esc aimed at the bar cancels it
  await bar.getByRole('button', { name: '녹음 끝내기' }).focus()
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
  expect(await transcribeChats(page)).toEqual([])
})

test('while the job runs its own label shows (a first recording downloads the speech model), the box read-only and focused', async ({ page }) => {
  await reset(page)
  await page.request.post('/__test/transcribe-progress', { data: { message: '음성 인식 모델 내려받는 중 (488 MB, 처음 한 번만)', progress: 0.25, ms: 2500 } })
  await signIn(page)
  const box = page.getByTestId('composer-input')
  await box.click()
  await holdSpace(page)
  await expect(box).toHaveAttribute('placeholder', '음성 인식 모델 내려받는 중 (488 MB, 처음 한 번만) · 25%')
  await expect(box).toHaveAttribute('readonly', '')
  await expect(box).toHaveAttribute('aria-busy', 'true')
  await expect(box).toBeFocused()
  await expect(page.getByRole('button', { name: MIC })).toBeDisabled()
  await expect(box).toHaveValue('받아쓴 문장입니다')
  await expect(box).not.toHaveAttribute('readonly', '')
  // a box with text: the label shows over it
  await box.fill('회의 메모')
  await holdSpace(page)
  await expect(page.getByTestId('voice-progress')).toHaveText('음성 인식 모델 내려받는 중 (488 MB, 처음 한 번만) · 25%')
  await expect(box).toHaveValue('회의 메모 받아쓴 문장입니다')
  await expect(page.getByTestId('voice-progress')).toHaveCount(0)
})

test.describe('rooms', () => {
  // the room's answers come through page.route, which does not see what the app's service worker fetches
  test.use({ serviceWorkers: 'block' })
  const ROOT = { id: '019a5f00-0000-7000-8000-000000000001', author: { id: 'sora', name: '소라님' }, body: '시안 봤어요' }

  test('hold Space in a room\'s box: the words go in as text, nothing is sent, no chat is named', async ({ page }) => {
    await reset(page)
    const room = await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [ROOT] })
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    const box = page.getByTestId('room-input')
    await box.click()
    await page.keyboard.press('Space')
    await expect(box).toHaveValue(' ')
    await box.fill('')
    await holdSpace(page)
    await expect(box).toHaveValue('받아쓴 문장입니다')
    await expect(box).toBeFocused()
    await page.waitForTimeout(300)
    expect(room.sent).toEqual([])
    expect(await transcribeChats(page)).toEqual([null])
    await page.getByTestId('room-send').click()
    await expect.poll(() => room.sent.map((m) => m.body)).toEqual(['받아쓴 문장입니다'])
  })

  test('a click in a room records until ✓, with the hint to hold Space until that was used once; a thread has the mic too', async ({ page }) => {
    await reset(page)
    await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [ROOT] })
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    const composer = page.getByTestId('room-composer')
    await composer.getByRole('button', { name: MIC }).click()
    const bar = page.getByRole('group', { name: '녹음 중' })
    await expect(bar).toHaveAttribute('data-mode', 'toggle')
    await expect(bar.getByTestId('voice-hint')).toHaveText('다음엔 입력창에서 Space를 길게 눌러 보세요')
    await page.waitForTimeout(800)
    await bar.getByRole('button', { name: '녹음 끝내기' }).click()
    await expect(page.getByTestId('room-input')).toHaveValue('받아쓴 문장입니다')
    await expect(page.getByTestId('room-input')).toBeFocused()
    // once Space was held, a click shows no hint
    await page.getByTestId('room-input').fill('')
    await holdSpace(page)
    await expect(page.getByTestId('room-input')).toHaveValue('받아쓴 문장입니다')
    await composer.getByRole('button', { name: MIC }).click()
    await expect(bar).toBeVisible()
    await expect(bar.getByTestId('voice-hint')).toHaveCount(0)
    await bar.getByRole('button', { name: '녹음 취소' }).click()
    await expect(bar).toHaveCount(0)
    await expect(page.getByTestId('room-input')).toHaveValue('받아쓴 문장입니다')

    await page.goto(`/rooms/${ROOM_ID}/t/${ROOT.id}`)
    const thread = page.getByTestId('room-thread')
    await expect(thread.getByRole('button', { name: MIC })).toBeVisible()
    await thread.getByTestId('room-input').click()
    await holdSpace(page)
    await expect(thread.getByTestId('room-input')).toHaveValue('받아쓴 문장입니다')
    // one recording at a time: while the room's box records, the thread's mic (on screen beside it) waits
    const roomBox = page.getByTestId('room-composer').first()
    await roomBox.getByRole('button', { name: MIC }).click()
    await expect(roomBox.getByTestId('voice-bar')).toBeVisible()
    await expect(thread.getByRole('button', { name: MIC })).toBeDisabled()
    await roomBox.getByTestId('voice-cancel').click()
    await expect(thread.getByRole('button', { name: MIC })).toBeEnabled()
  })

  // docs/DECISIONS.md "Voice input on a team's own server: the key turns it on": "this server" without ffmpeg (an office
  // Mac) turns voice input off, so the mic no longer shows and then fails every recording, in the AI chat and in rooms
  test('"this server" without ffmpeg: the owner gets the hint to the setting; a member has no mic and Space stays a Space', async ({ page }) => {
    await reset(page)
    await speech(page, 'local')
    expect((await page.request.post('/__test/speech-host', { data: { localMissing: ['ffmpeg'] } })).ok()).toBeTruthy()
    await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [ROOT] })
    await signIn(page)
    await expect(page.getByTestId('voice-off-hint')).toBeVisible()
    await expect(page.getByRole('button', { name: MIC })).toHaveCount(0)
    await page.goto(`/rooms/${ROOM_ID}`)
    await expect(page.getByTestId('room-composer').getByTestId('voice-off-hint')).toBeVisible()
    await page.context().clearCookies()
    await signIn(page, { username: 'bob', password: 'bob password 1' })
    for (const [where, box] of [['/', 'composer-input'], [`/rooms/${ROOM_ID}`, 'room-input']] as const) {
      if (where !== '/') await page.goto(where)
      await expect(page.getByTestId(box)).toBeVisible()
      await expect(page.getByRole('button', { name: MIC })).toHaveCount(0)
      await expect(page.getByTestId('voice-off-hint')).toHaveCount(0)
      await page.getByTestId(box).click()
      await page.keyboard.down('Space')
      await page.waitForTimeout(700)
      await page.keyboard.up('Space')
      await expect(page.getByTestId('voice-bar')).toHaveCount(0)
      await expect(page.getByTestId(box)).toHaveValue(' ')
    }
    expect(await transcribeChats(page)).toEqual([])
  })

  test('every chat confidential and voice input through OpenRouter: a room says why instead of recording', async ({ page }) => {
    await reset(page)
    expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
    await speech(page, 'openrouter', true)
    await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [ROOT] })
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    await page.getByTestId('room-composer').getByRole('button', { name: MIC }).click()
    await expect(page.getByTestId('room-voice-error')).toHaveText('모든 대화가 기밀로 다뤄지는 동안에는 녹음을 바깥 음성 서비스(OpenRouter)로 보내지 않아서 대화방에서 음성 입력을 쓸 수 없어요. 글로 입력해 주세요.')
    await expect(page.getByRole('group', { name: '녹음 중' })).toHaveCount(0)
    expect(await transcribeChats(page)).toEqual([])
  })
})

test.describe('a finger on the mic (a phone)', () => {
  test.use({ serviceWorkers: 'block', hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  // one session for the whole test: the browser keeps the touch between its events
  let cdp: import('@playwright/test').CDPSession
  const touch = async (_page: Page, type: 'touchStart' | 'touchMove' | 'touchEnd', at?: { x: number; y: number }) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] })
  }

  test('held, it records until the finger lets go; a tap records until ✓; sliding away cancels', async ({ page }) => {
    await reset(page)
    const room = await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [] })
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    cdp = await page.context().newCDPSession(page)
    // a touch screen: no Space hint in the mic's name
    const mic = page.getByTestId('room-composer').getByRole('button', { name: '음성으로 입력' })
    const input = page.getByTestId('room-input')
    const bar = page.getByTestId('voice-bar')
    const centre = async () => {
      const b = (await mic.boundingBox())!
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }

    let at = await centre()
    await touch(page, 'touchStart', at)
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute('data-mode', 'hold')
    await expect(bar.getByTestId('voice-hint')).toHaveText('손을 떼면 끝나요 · 밀어서 취소')
    await page.waitForTimeout(400)
    await touch(page, 'touchEnd')
    await expect(input).toHaveValue('받아쓴 문장입니다')
    expect(room.sent).toEqual([])

    // a tap: on until ✓ (the tap's click reaches neither ✕ nor ✓ under the finger)
    await input.fill('')
    at = await centre()
    await touch(page, 'touchStart', at)
    await touch(page, 'touchEnd')
    await expect(bar).toBeVisible()
    await page.waitForTimeout(700)
    await expect(bar).toHaveAttribute('data-mode', 'toggle')
    await bar.getByTestId('voice-done').click()
    await expect(input).toHaveValue('받아쓴 문장입니다')

    // sliding away cancels
    await input.fill('')
    at = await centre()
    await touch(page, 'touchStart', at)
    await expect(bar).toBeVisible()
    await touch(page, 'touchMove', { x: at.x + 120, y: at.y - 40 })
    await expect(bar).toHaveCount(0)
    await touch(page, 'touchEnd')
    await page.waitForTimeout(400)
    await expect(input).toHaveValue('')
    expect(await transcribeChats(page)).toEqual([null, null])
  })
})
