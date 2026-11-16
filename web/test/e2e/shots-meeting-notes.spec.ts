// Screenshots of meeting notes (components/MeetingNotes.tsx) for reviewing by eye, with a stand-in for the desktop app's
// meeting bridge: the My files button, the card while listening (words, folded, "can't hear the call"), and after Stop;
// at 1440 and 390, light and dark, in English and Korean, with the font sizes of the card measured into fonts.json.
// Only when MEETING_SHOTS names a folder to write them to.
import fs from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const dir = process.env.MEETING_SHOTS
test.skip(!dir, 'MEETING_SHOTS is not set')

const BOB = { username: 'bob', password: 'bob password 1' }

/** a desktop bridge whose meeting answers like the app: start() goes listening, __emit() pushes lines and state */
async function fakeMeetingApp(page: Page) {
  await page.addInitScript(() => {
    const noop = () => {}
    const subs: { lines: ((l: unknown) => void)[]; state: ((s: unknown) => void)[] } = { lines: [], state: [] }
    let state: Record<string, unknown> = { state: 'idle' }
    let lines: unknown[] = []
    const w = window as unknown as Record<string, unknown>
    w.__emit = (s: Record<string, unknown> | null, l: unknown[] | null) => {
      if (l) { lines = [...lines, ...l]; for (const f of subs.lines) f(l) }
      if (s) { state = { ...state, ...s }; for (const f of subs.state) f(state) }
    }
    w.mycelDesktop = {
      bridgeVersion: 1, appVersion: '0.5.12', platform: 'darwin',
      browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
      notify: noop, openTeams: noop,
      meeting: {
        version: 1,
        state: async () => state,
        lines: async () => lines,
        start: async () => { (w.__emit as (s: unknown, l: unknown) => void)({ state: 'listening', startedAt: Date.now() - 754_000, microphone: true, callSound: true, callApps: ['us.zoom.xos'] }, null); return 'started' },
        stop: async () => { (w.__emit as (s: unknown, l: unknown) => void)({ state: 'idle' }, null); return lines },
        onLines: (f: (l: unknown) => void) => { subs.lines.push(f); return noop },
        onState: (f: (s: unknown) => void) => { subs.state.push(f); return noop },
        openSoundSettings: noop, unsaved: async () => null, saved: noop,
      },
    }
  })
  await page.route('**/api/meetings/status', (r) => r.fulfill({ json: { state: 'ready' } }))
}

const LINES = {
  en: [
    { track: 'me', startMs: 5_000, endMs: 8_000, text: "Let's start with the launch date for the new price list." },
    { track: 'others', startMs: 9_000, endMs: 13_000, text: 'We said the 24th, but the design team needs two more days for the brochure.' },
    { track: 'me', startMs: 14_000, endMs: 16_000, text: 'Then the 26th. I will tell the sales team today.' },
    { track: 'others', startMs: 17_000, endMs: 19_000, text: 'Sounds good. Can you send the final numbers by Friday?' },
  ],
  ko: [
    { track: 'me', startMs: 5_000, endMs: 8_000, text: '새 가격표 출시 날짜부터 정할게요.' },
    { track: 'others', startMs: 9_000, endMs: 13_000, text: '24일로 했는데 디자인팀이 브로슈어 때문에 이틀 더 필요하대요.' },
    { track: 'me', startMs: 14_000, endMs: 16_000, text: '그럼 26일로 해요. 영업팀에는 오늘 알릴게요.' },
    { track: 'others', startMs: 17_000, endMs: 19_000, text: '좋아요. 최종 숫자는 금요일까지 보내 주실 수 있어요?' },
  ],
}

for (const lang of ['en', 'ko'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1440, 390] as const) {
      test(`meeting notes · ${lang} · ${width} · ${scheme}`, async ({ page }) => {
        const shot = (name: string) => page.screenshot({ path: `${dir}/${lang}-${width}-${scheme}-${name}.png` })
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: scheme })
        await fakeMeetingApp(page)
        await reset(page, { teamLocale: lang, usersFollowTeam: true })
        await signIn(page, BOB)
        await page.request.post('/__test/file', { data: { path: 'users/bob/memo.md', text: 'memo' } })
        await page.goto('/files?path=users%2Fbob')
        const entry = page.getByTestId('meeting-entry')
        if (width === 1440) {
          await expect(entry).toBeVisible()
          await shot('1-entry')
          await entry.click()
        } else {
          // the phone width of a narrow desktop window: the header keeps its buttons
          await page.evaluate(() => (window as unknown as { mycelDesktop: { meeting: { start(): Promise<unknown> } } }).mycelDesktop.meeting.start())
        }
        const card = page.getByTestId('meeting-card')
        await expect(card).toBeVisible()
        await shot('2-listening-empty')
        await page.evaluate((l) => (window as unknown as { __emit: (s: unknown, l: unknown) => void }).__emit(null, l), LINES[lang])
        await expect(page.getByTestId('meeting-lines').locator('li')).toHaveCount(4)
        await shot('3-listening-words')
        await page.evaluate(() => (window as unknown as { __emit: (s: unknown, l: unknown) => void }).__emit({ problem: 'no_call_sound' }, null))
        await shot('4-cant-hear')
        if (width === 1440 && scheme === 'light') {
          const fonts = await page.evaluate(() => {
            const c = document.querySelector('[data-testid=meeting-card]')!
            const size = (sel: string) => { const e = c.querySelector(sel); return e ? getComputedStyle(e).fontSize : null }
            return { headline: size('header [role=status]'), time: size('[data-testid=meeting-time]'), stop: size('[data-testid=meeting-stop]'), consent: size('p span'), line: size('[data-testid=meeting-lines] li span.min-w-0'), lineTime: size('[data-testid=meeting-lines] li span') }
          })
          fs.writeFileSync(`${dir}/${lang}-fonts.json`, JSON.stringify(fonts, null, 2))
        }
        await page.getByRole('button', { name: lang === 'ko' ? '글 숨기기' : 'Hide the words' }).click()
        await shot('5-folded')
        await page.getByRole('button', { name: lang === 'ko' ? '글 보기' : 'Show the words' }).click()
        await page.getByTestId('meeting-stop').click()
        await expect(card).toContainText(lang === 'ko' ? '내 파일 › 회의에 저장했어요' : 'Saved to My files › Meetings')
        await shot('6-saved')
      })
    }
  }
}
