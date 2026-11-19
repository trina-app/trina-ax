// Voice input transcribed on this Mac, inside the desktop app (lib/macDictation.ts, docs/decisions/
// 20261119-mac-dictation.md), with a stand-in for the app's bridge: the words show while recording (each guess
// replaced by the next), ✓ leaves every word final in the box and nothing goes to the team server; a confidential chat
// with voice input through OpenRouter records here too; the first tap fetches Apple's model (the bar says how far,
// that recording goes to the server), then the Mac takes the next one; Esc puts the box back; a helper that fails
// keeps the words and the next recording goes to the server; a blocked microphone says where on the Mac to allow it,
// with Open Settings.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone'] })

const MIC = '음성 입력 (Space 길게)'

/** Before the app's scripts: a desktop bridge whose dictation answers like the app's main process with its helper:
 * a guess every 400 ms of sound ("하나", "하나 둘" …), final every three words, the rest final after Stop. */
async function fakeMac(page: Page, o: { state?: 'ready' | 'needs-model'; failAfter?: number; denied?: boolean } = {}) {
  await page.addInitScript((opts) => {
    const noop = () => {}
    const W = ['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열']
    const d = { state: opts.state ?? 'ready', starts: 0, pushed: 0, installs: 0, settings: 0, gate: null as null | ((r: string) => void), progress: null as null | ((p: number) => void) }
    const cbs = new Set<(e: unknown) => void>()
    const emit = (e: unknown) => cbs.forEach((cb) => cb(e))
    let run: { id: number; samples: number; words: string[]; next: number; shown: number; ended: boolean } | null = null
    ;(window as any).__mac = d
    ;(window as any).__macInstall = (r: string) => { d.progress?.(100); d.state = r === 'installed' ? 'ready' : d.state; d.gate?.(r) }
    ;(window as any).__macProgress = (p: number) => d.progress?.(p)
    if (opts.denied) {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    }
    ;(window as any).mycelDesktop = {
      bridgeVersion: 1,
      appVersion: '0.5.19',
      platform: 'darwin',
      browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
      notify: noop,
      openTeams: noop,
      openMicSettings: () => { d.settings++ },
      dictation: {
        version: 1,
        check: async (language: string) => (language === 'id' ? { state: 'unsupported' } : { state: d.state, locale: 'ko-KR' }),
        install: (_language: string, onProgress?: (p: number) => void) => {
          d.installs++
          d.progress = onProgress ?? null
          onProgress?.(0)
          return new Promise((r) => { d.gate = r })
        },
        start: async () => {
          if (d.state !== 'ready') return null
          d.starts++
          run = { id: d.starts, samples: 0, words: [], next: 0, shown: 0, ended: false }
          return run.id
        },
        push: (id: number, s: Float32Array) => {
          const r = run
          if (!r || r.id !== id || r.ended) return
          d.pushed += s.length
          r.samples += s.length
          while (Math.floor(r.samples / 6400) > r.shown) {
            r.shown++
            r.words.push(W[r.next++ % W.length]!)
            emit({ id, event: 'text', final: false, text: r.words.join(' ') })
            if (opts.failAfter && r.shown >= opts.failAfter) {
              r.ended = true
              emit({ id, event: 'error', code: 'helper' })
              return
            }
            if (r.words.length === 3) {
              emit({ id, event: 'text', final: true, text: r.words.join(' ') + '.' })
              r.words = []
            }
          }
        },
        stop: (id: number) => {
          const r = run
          if (!r || r.id !== id || r.ended) return
          r.ended = true
          setTimeout(() => {
            if (r.words.length) emit({ id, event: 'text', final: true, text: r.words.join(' ') + '.' })
            emit({ id, event: 'done' })
          }, 150)
        },
        cancel: (id: number) => { if (run?.id === id) run.ended = true },
        onEvent: (cb: (e: unknown) => void) => { cbs.add(cb); return () => cbs.delete(cb) },
      },
    }
  }, o)
}
const mac = (page: Page) => page.evaluate(() => { const d = (window as any).__mac; return { starts: d.starts, pushed: d.pushed, installs: d.installs, settings: d.settings } })
const serverLog = async (page: Page) => ((await (await page.request.post('/__test/log')).json()) as string[]).filter((l) => l.startsWith('POST /api/transcribe'))
const speech = async (page: Page, provider: 'local' | 'openrouter', key = false) =>
  expect((await page.request.post('/__test/speech', { data: { provider, key } })).ok()).toBeTruthy()
/** the box's text: final words, then the newest guess */
const WORDS = /^하나\.?(?: [가-힣]+\.?)*$/

test('the Mac transcribes while talking: guesses replaced, every word final after ✓, nothing sent to the server', async ({ page }) => {
  await fakeMac(page)
  await reset(page)
  await speech(page, 'openrouter', true)
  await signIn(page)
  await page.getByTestId('composer-input').fill('메모:')
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('group', { name: '녹음 중' })).toBeVisible()
  // the words show above the bar while it still records, a guess first
  await expect(page.getByTestId('composer-text-held')).toContainText('메모: 하나', { timeout: 8000 })
  await expect(page.getByTestId('composer-text-held')).toContainText('하나 둘 셋.', { timeout: 8000 })
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  // every word final: the box ends on a final piece, never a bare guess
  await expect(page.getByTestId('composer-input')).toHaveValue(/\.$/)
  const value = await page.getByTestId('composer-input').inputValue()
  expect(value.startsWith('메모: 하나 둘 셋.')).toBe(true)
  expect(value.slice('메모: '.length)).toMatch(WORDS)
  expect((await mac(page)).pushed).toBeGreaterThan(16_000)
  expect(await serverLog(page)).toEqual([])
})

test('a confidential chat with voice input through OpenRouter records on this Mac: the sound never leaves it', async ({ page }) => {
  await fakeMac(page)
  await reset(page)
  expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
  await speech(page, 'openrouter', true)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('group', { name: '녹음 중' })).toBeVisible()
  await expect(page.getByTestId('composer-text-held')).toContainText('하나', { timeout: 8000 })
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue(WORDS)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await serverLog(page)).toEqual([])
})

test('first use: the tap fetches Apple\'s model (the bar says how far) and that recording goes to the server; then the Mac takes over', async ({ page }) => {
  await fakeMac(page, { state: 'needs-model' })
  await reset(page)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('group', { name: '녹음 중' })).toBeVisible()
  await expect(page.getByTestId('voice-hint')).toHaveText('이 Mac에서 음성 입력을 준비하는 중: 0%')
  await page.evaluate(() => (window as any).__macProgress(40))
  await expect(page.getByTestId('voice-hint')).toHaveText('이 Mac에서 음성 입력을 준비하는 중: 40%')
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  // this one: the team server's job
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  expect(await serverLog(page)).toEqual(['POST /api/transcribe'])
  await page.evaluate(() => (window as any).__macInstall('installed'))
  // the next: this Mac
  await page.getByTestId('composer-input').fill('')
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByTestId('composer-text-held')).toContainText('하나', { timeout: 8000 })
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue(WORDS)
  expect((await mac(page)).installs).toBe(1)
  expect(await serverLog(page)).toEqual(['POST /api/transcribe'])
})

test('a confidential chat while the model is still coming: the note says so with its progress, then the mic records here', async ({ page }) => {
  await fakeMac(page, { state: 'needs-model' })
  await reset(page)
  expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
  await speech(page, 'openrouter', true)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('alert')).toContainText('이 Mac에서 음성 입력을 준비하고 있어요(0%)')
  await page.evaluate(() => (window as any).__macProgress(55))
  await expect(page.getByRole('alert')).toContainText('이 Mac에서 음성 입력을 준비하고 있어요(55%)')
  await expect(page.getByRole('group', { name: '녹음 중' })).toHaveCount(0)
  await page.evaluate(() => (window as any).__macInstall('installed'))
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByTestId('composer-text-held')).toContainText('하나', { timeout: 8000 })
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue(WORDS)
  expect(await serverLog(page)).toEqual([])
})

test('Esc throws the Mac\'s recording away: the box is back as it was', async ({ page }) => {
  await fakeMac(page)
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('my draft')
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByTestId('composer-text-held')).toContainText('my draft 하나', { timeout: 8000 })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveValue('my draft')
})

test('a helper that stops on the way: the words so far stay, the note says so, and the next recording goes to the server', async ({ page }) => {
  await fakeMac(page, { failAfter: 2 })
  await reset(page)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('alert')).toContainText('이 Mac의 음성 입력이 멈췄어요. 지금까지 받아쓴 말은 그대로 있어요.', { timeout: 8000 })
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveValue('하나 둘')
  await page.getByTestId('composer-input').fill('')
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('group', { name: '녹음 중' })).toBeVisible()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  expect((await mac(page)).starts).toBe(1)
  expect(await serverLog(page)).toEqual(['POST /api/transcribe'])
})

test('a microphone the Mac refused: the calm note says where to allow it, and Open Settings opens it', async ({ page }) => {
  await fakeMac(page, { denied: true })
  await reset(page)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByText('마이크 사용이 막혀 있어요. Mac의 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서')).toBeVisible()
  await page.getByTestId('voice-open-settings').click()
  expect((await mac(page)).settings).toBe(1)
  await expect(page.getByRole('group', { name: '녹음 중' })).toHaveCount(0)
})
