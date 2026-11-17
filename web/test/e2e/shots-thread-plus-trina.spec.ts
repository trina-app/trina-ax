// Screenshots of a thread and the ✦ side chat together (pages/Room.tsx; docs/decisions/20261117-thread-plus-trina.md)
// for reviewing by eye: every state at 1440, 1280, 1024 and 390, light and dark, in Korean, and in English at 1440 and
// 390; the font sizes of the new parts measured into fonts-<lang>-<width>.json. Only when THREAD_TRINA_SHOTS names a
// folder to write them to.
import fs from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

const dir = process.env.THREAD_TRINA_SHOTS
test.skip(!dir, 'THREAD_TRINA_SHOTS is not set')
test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const BEN = { id: 'ben', name: '벤' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`
const ROOT = id(1)
const TEXT = {
  ko: { root: '이번 주 시안 검토 일정 공유드려요. 금요일까지 피드백 부탁드립니다.', r1: '로고 버전 두 개 중에 어느 쪽이 나은지 의견 주세요.', r2: '두 번째 안이 좋아 보여요. 색 대비가 더 분명해요.', other: '다음 주 회의는 화요일 오전으로 옮길게요.', ask: '한 줄로 정리해 줘', again: '한 줄로 다시' },
  en: { root: 'Sharing the design review schedule for this week. Please send feedback by Friday.', r1: 'Which of the two logo versions do you prefer?', r2: 'The second one looks better. The contrast is clearer.', other: 'Moving next week\'s meeting to Tuesday morning.', ask: 'Sum this up 한 줄로', again: 'Again, 한 줄로' },
}

/** a desktop bridge whose meeting is listening (shots-meeting-notes.spec.ts has the full one) */
async function fakeMeetingApp(page: Page) {
  await page.addInitScript(() => {
    const noop = () => {}
    const state = { state: 'listening', startedAt: Date.now() - 754_000, microphone: true, callSound: true, callApps: ['us.zoom.xos'] }
    ;(window as unknown as Record<string, unknown>).mycelDesktop = {
      bridgeVersion: 1, appVersion: '0.5.12', platform: 'darwin',
      browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
      notify: noop, openTeams: noop,
      meeting: { version: 1, state: async () => state, lines: async () => [], start: async () => state, stop: async () => [], onLines: () => noop, onState: () => noop, openSoundSettings: noop, unsaved: async () => null, saved: noop },
    }
  })
  await page.route('**/api/meetings/status', (r) => r.fulfill({ json: { state: 'ready' } }))
}

for (const lang of ['ko', 'en'] as const) {
  for (const width of [1440, 1280, 1024, 390] as const) {
    if (lang === 'en' && width !== 1440 && width !== 390) continue
    test(`thread + side chat · ${lang} · ${width}`, async ({ page }) => {
      test.setTimeout(120_000)
      const phone = width === 390
      const T = TEXT[lang]
      const shot = async (name: string) => {
        // the pointer away from anything that would look hovered
        await page.mouse.move(2, 2)
        for (const scheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: scheme })
          await page.waitForTimeout(250)
          await page.screenshot({ path: `${dir}/${lang}-${width}-${scheme}-${name}.png` })
        }
        await page.emulateMedia({ colorScheme: 'light' })
      }
      // a phone reaches the side chat on a thread through "Ask about this" (a computer's hover bar here), then narrows
      await page.setViewportSize({ width: phone ? 1440 : width, height: phone ? 900 : width === 1024 ? 768 : width === 1280 ? 800 : 900 })
      await reset(page, { teamLocale: lang, usersFollowTeam: true })
      await routeRoom(page, {
        members: [SORA, BEN],
        room: { name: lang === 'ko' ? '디자인' : 'design' },
        messages: [
          { id: ROOT, author: SORA, body: T.root, extra: { thread: { replyCount: 2, lastReplyAt: '2026-11-05T09:03:00.000Z', repliers: [SORA, BEN], newReplies: false } } },
          { id: id(2), author: SORA, body: T.r1, threadRootId: ROOT },
          { id: id(3), author: BEN, body: T.r2, threadRootId: ROOT },
          { id: id(5), author: BEN, body: T.other },
        ],
      })
      await signIn(page)
      await page.goto(`/rooms/${ROOM_ID}/t/${ROOT}`)
      const thread = page.getByTestId('room-thread')
      const side = page.getByTestId('room-side-chat')
      await expect(thread.getByTestId('room-message')).toHaveCount(3)
      if (!phone) await shot('0-thread-alone')

      if (phone) {
        const reply = thread.getByTestId('room-message').nth(2)
        await reply.hover()
        await reply.getByTestId('message-ask-trina').click()
        await expect(side.getByTestId('side-chat-quote')).toBeVisible()
        await page.setViewportSize({ width: 390, height: 844 })
        await shot('1-quote-in-place-of-chip')
        await side.getByTestId('side-chat-quote-remove').click()
      } else await page.getByTestId('room-side-chat-button').click()
      await expect(side.getByTestId('side-chat-thread-chip')).toBeVisible()
      await shot('2-both-chip-on-empty')

      const send = async (text: string, n: number) => {
        await side.getByTestId('side-chat-input').fill(text)
        await side.getByTestId('side-chat-send').click()
        await expect(side.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(n, { timeout: 20_000 })
      }
      await side.getByTestId('side-chat-input').fill(T.ask)
      await shot('3-typing-with-chip')
      await send(T.ask, 1)
      await shot('4-answer-send-to-thread')

      const size = (sel: string) => page.evaluate((s) => { const e = document.querySelector(s); return e ? `${getComputedStyle(e).fontSize} / ${getComputedStyle(e).lineHeight}` : null }, sel)
      fs.writeFileSync(`${dir}/fonts-${lang}-${width}.json`, JSON.stringify({
        chip: await size('[data-testid=side-chat-thread-chip]'),
        bubbleMark: await size('[data-testid=user-quote-thread]'),
        bubbleText: await size('[data-testid=room-side-chat] [data-testid=user-text]'),
        input: await size('[data-testid=side-chat-input]'),
        sendHere: await size('[data-testid=send-here-thread]'),
        sideTitle: await size('[data-testid=room-side-chat] h2 span'),
        threadMessage: await size('[data-testid=room-thread] [data-testid=room-message]'),
        disclaimer: await size('[data-testid=side-chat-disclaimer]'),
      }, null, 2))

      await side.getByTestId('side-chat-thread-chip-off').click()
      await send(T.again, 2)
      await shot('5-chip-off-answer-to-conversation')

      if (!phone) {
        // "Ask about this" on a reply: its quote card in the chip's place
        const reply = thread.getByTestId('room-message').nth(2)
        await reply.hover()
        await reply.getByTestId('message-ask-trina').click()
        await expect(side.getByTestId('side-chat-quote')).toBeVisible()
        await shot('6-quote-in-place-of-chip')
        // the side chat closed: the thread alone again (the list back)
        await side.getByTestId('side-chat-close').click()
        await expect(side).toHaveCount(0)
        await shot('7-side-chat-closed')
      } else {
        await side.getByTestId('side-chat-back').click()
        await expect(side).toHaveCount(0)
        await shot('7-back-to-thread')
      }
    })
  }
}

test('thread + side chat · the meeting-notes card sits above the box · 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fakeMeetingApp(page)
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await routeRoom(page, { members: [SORA, BEN], room: { name: 'design' }, messages: [
    { id: ROOT, author: SORA, body: TEXT.en.root, extra: { thread: { replyCount: 1, lastReplyAt: '2026-11-05T09:03:00.000Z', repliers: [BEN], newReplies: false } } },
    { id: id(3), author: BEN, body: TEXT.en.r2, threadRootId: ROOT },
  ] })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('meeting-card')).toBeVisible()
  await page.screenshot({ path: `${dir}/meeting-1-room-alone.png` })
  await page.getByTestId('room-thread-line').first().click()
  await page.getByTestId('room-side-chat-button').click()
  await expect(page.getByTestId('room-side-chat').getByTestId('side-chat-thread-chip')).toBeVisible()
  await expect(page.getByTestId('meeting-card')).toHaveAttribute('data-raised', 'true')
  await page.mouse.move(2, 2)
  await page.screenshot({ path: `${dir}/meeting-2-three-columns.png` })
  // the card clears the side chat's box, its chip included
  const [card, chip] = [(await page.getByTestId('meeting-card').boundingBox())!, (await page.getByTestId('side-chat-thread-chip').boundingBox())!]
  expect(card.y + card.height).toBeLessThanOrEqual(chip.y)
})
