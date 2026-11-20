// Voice input written by the Android app's own recognizer (dictation-v1 with the Android check answer, lib/mobile.ts
// phoneDictation; docs/decisions/20261119-android-dictation.md), with a stand-in for the app: the words show while recording, ✓ leaves
// them final in the box, the page never opens the microphone and nothing goes to the team server; a confidential chat
// records on an on-device recognizer, while a recognizer that is not on the phone is never used, whatever the team's
// speech setting (the team server instead; in a confidential chat its note).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone'] })

const MIC = '음성 입력 (Space 길게)'
const WORDS = /^하나\.?(?: [가-힣]+\.?)*$/

/** Before the app's scripts: an Android app with dictation-v1 whose recognizer says a word every 300 ms ("하나",
 * "하나 둘" …), final every three words, the rest final after stop. */
async function fakePhone(page: Page, o: { onDevice?: boolean } = {}) {
  await page.addInitScript((opts) => {
    const W = ['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열']
    const w = window as unknown as { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; __phone: { starts: number; mics: number; types: string[] } }
    w.mycelMobile = { protocol: 1, appVersion: '1.0.10', platform: 'android', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', 'dictation-v1'] }
    w.__phone = { starts: 0, mics: 0, types: [] }
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = (c) => { w.__phone.mics++; return gum(c) }
    let run: { id: string; words: string[]; next: number; timer: ReturnType<typeof setInterval> } | null = null
    const event = (id: string, e: object) => window.dispatchEvent(new CustomEvent('mycel:mobile-dictation', { detail: { v: 1, type: 'mobile-dictation', id, nonce: w.mycelMobile.nonce, generation: w.mycelMobile.generation, ...e } }))
    w.ReactNativeWebView = { postMessage(raw) {
      const m = JSON.parse(raw) as MobileMessage
      w.__phone.types.push(m.type)
      const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true }
      if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
      if (m.type === 'dictation-check') { reply.dictation = 'ready'; reply.dictationMic = 'app'; reply.dictationOnDevice = opts.onDevice !== false }
      if (m.type === 'dictation-start') {
        reply.started = true
        w.__phone.starts++
        const r = { id: m.id, words: [] as string[], next: 0, timer: setInterval(() => {
          r.words.push(W[r.next++ % W.length]!)
          event(r.id, { event: 'level', level: 0.5 })
          event(r.id, { event: 'text', final: false, text: r.words.join(' ') })
          if (r.words.length === 3) { event(r.id, { event: 'text', final: true, text: r.words.join(' ') + '.' }); r.words = [] }
        }, 300) }
        run = r
      }
      if (m.type === 'dictation-stop' && run?.id === m.id) {
        const r = run
        clearInterval(r.timer)
        setTimeout(() => {
          if (r.words.length) event(r.id, { event: 'text', final: true, text: r.words.join(' ') + '.' })
          event(r.id, { event: 'done' })
        }, 150)
      }
      if (m.type === 'dictation-cancel' && run?.id === m.id) clearInterval(run.timer)
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
    } }
  }, o)
}
const phone = (page: Page) => page.evaluate(() => (window as unknown as { __phone: { starts: number; mics: number; types: string[] } }).__phone)
const serverLog = async (page: Page) => ((await (await page.request.post('/__test/log')).json()) as string[]).filter((l) => l.startsWith('POST /api/transcribe'))
const speech = async (page: Page, provider: 'local' | 'openrouter', key = false) =>
  expect((await page.request.post('/__test/speech', { data: { provider, key } })).ok()).toBeTruthy()

test('the phone writes the words while talking: guesses replaced, final after ✓, no page microphone, nothing to the server', async ({ page }) => {
  await fakePhone(page)
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('메모:')
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('group', { name: '녹음 중' })).toBeVisible()
  await expect(page.getByTestId('composer-text-held')).toContainText('메모: 하나 둘 셋.', { timeout: 8000 })
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveValue(/^메모: 하나 둘 셋\..*\.$/)
  expect((await page.getByTestId('composer-input').inputValue()).slice('메모: '.length)).toMatch(WORDS)
  const p = await phone(page)
  expect(p.starts).toBe(1)
  expect(p.mics).toBe(0)
  expect(p.types).not.toContain('dictation-push')
  expect(p.types).toContain('dictation-stop')
  expect(await serverLog(page)).toEqual([])
})

test('a confidential chat: an on-device recognizer takes it; one that is not on the phone never does', async ({ page }) => {
  await fakePhone(page)
  await reset(page)
  expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
  await speech(page, 'openrouter', true)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByTestId('composer-text-held')).toContainText('하나', { timeout: 8000 })
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue(WORDS)
  expect(await serverLog(page)).toEqual([])
})

test('a recognizer that is not on the phone: never in a confidential chat', async ({ page }) => {
  await fakePhone(page, { onDevice: false })
  await reset(page)
  expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
  await speech(page, 'openrouter', true)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('alert')).toContainText('기밀 대화에서는 녹음을 바깥 음성 서비스(OpenRouter)로 보내지 않아서')
  expect((await phone(page)).starts).toBe(0)
  expect(await serverLog(page)).toEqual([])
})

test('a recognizer that is not on the phone, for a team whose voice stays on its server: the team server transcribes', async ({ page }) => {
  await fakePhone(page, { onDevice: false })
  await reset(page)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('group', { name: '녹음 중' })).toBeVisible()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  expect((await phone(page)).starts).toBe(0)
  expect(await serverLog(page)).toEqual(['POST /api/transcribe'])
})

test('a recognizer that is not on the phone, for a team whose voice may go outside (OpenRouter): still the team server', async ({ page }) => {
  await fakePhone(page, { onDevice: false })
  await reset(page)
  await speech(page, 'openrouter', true)
  await signIn(page)
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByRole('group', { name: '녹음 중' })).toBeVisible()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  expect((await phone(page)).starts).toBe(0)
})

test('Esc throws the phone\'s recording away: the box is back as it was and the app hears cancel', async ({ page }) => {
  await fakePhone(page)
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('my draft')
  await page.getByRole('button', { name: MIC }).click()
  await expect(page.getByTestId('composer-text-held')).toContainText('my draft 하나', { timeout: 8000 })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveValue('my draft')
  expect((await phone(page)).types).toContain('dictation-cancel')
})
