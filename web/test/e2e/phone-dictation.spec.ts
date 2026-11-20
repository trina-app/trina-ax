// Voice input written on the iPhone itself (dictation-v1, lib/mobile.ts phoneDictation; docs/decisions/
// 20261119-iphone-dictation.md), with a fake iPhone app that answers the bridge's messages the way mobile/src/dictation.ts
// and its Dictation module do: a guess every 0.4 s of the sound it is handed (16-bit base64 over postMessage), final
// every three words, the rest final after Stop. The words show while recording and nothing goes to the team server; a
// language whose model is not on the phone yet goes to the server that once while the bar says the phone is getting
// ready; an app without dictation-v1 (1.0.9 and older, Android) records the server's way as before. The app's own half
// is tests/unit/mobile-dictation.test.ts; the recognizer is measured in the PR (it cannot run in the Simulator).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TrinaAX/1.0.10'

test.use({
  serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: IPHONE_UA,
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone'],
})

type Win = { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; phone: { state: string; bytes: number; starts: number; installs: number; finishInstall?: () => void } }

async function app(page: Page, o: { dictation: boolean; state?: 'ready' | 'needs-model' }) {
  await page.addInitScript((o) => {
    const w = window as unknown as Win
    const W = ['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열']
    w.mycelMobile = { protocol: 1, appVersion: '1.0.10', platform: 'ios', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', ...(o.dictation ? ['dictation-v1'] : [])] }
    w.phone = { state: o.state ?? 'ready', bytes: 0, starts: 0, installs: 0 }
    let run: { id: string; bytes: number; words: string[]; next: number; shown: number } | null = null
    const event = (id: string, body: object) => setTimeout(() => window.dispatchEvent(new CustomEvent('mycel:mobile-dictation', { detail: { v: 1, type: 'mobile-dictation', id, nonce: w.mycelMobile.nonce, generation: w.mycelMobile.generation, ...body } })), 0)
    w.ReactNativeWebView = { postMessage(raw) {
      const m = JSON.parse(raw) as MobileMessage
      const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true }
      const send = () => setTimeout(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })), 0)
      if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
      if (!o.dictation && m.type.startsWith('dictation-')) { reply.ok = false; reply.error = 'mobile_operation_failed'; return send() }
      if (m.type === 'dictation-check') reply.dictation = w.phone.state as never
      if (m.type === 'dictation-install') {
        w.phone.installs++
        event(m.id, { event: 'progress', percent: 30 })
        w.phone.finishInstall = () => { w.phone.state = 'ready'; reply.installed = 'installed'; send() }
        return
      }
      if (m.type === 'dictation-start') {
        reply.started = w.phone.state === 'ready'
        if (reply.started) { w.phone.starts++; run = { id: m.id, bytes: 0, words: [], next: 0, shown: 0 } }
      }
      if (m.type === 'dictation-push') {
        const r = run
        if (!r || r.id !== m.id) return
        const n = atob(m.b64).length
        w.phone.bytes += n; r.bytes += n
        // a guess every 0.4 s of 16 kHz 16-bit sound
        while (Math.floor(r.bytes / 12_800) > r.shown) {
          r.shown++
          r.words.push(W[r.next++ % W.length]!)
          event(r.id, { event: 'text', final: false, text: r.words.join(' ') })
          if (r.words.length === 3) { event(r.id, { event: 'text', final: true, text: r.words.join(' ') + '.' }); r.words = [] }
        }
        return
      }
      if (m.type === 'dictation-stop' && run?.id === m.id) {
        const r = run
        run = null
        setTimeout(() => { if (r.words.length) event(r.id, { event: 'text', final: true, text: r.words.join(' ') + '.' }); event(r.id, { event: 'done' }) }, 120)
      }
      if (m.type === 'dictation-cancel' && run?.id === m.id) run = null
      send()
    } }
  }, o)
}
const phone = (page: Page) => page.evaluate(() => (window as unknown as Win).phone)
const serverLog = async (page: Page) => ((await (await page.request.post('/__test/log')).json()) as string[]).filter((l) => l.startsWith('POST /api/transcribe'))
/** the box's text: final words, then the newest guess */
const WORDS = /^하나\.?(?: [가-힣]+\.?)*$/

test('the iPhone writes the words while talking: guesses replaced, every word final after ✓, nothing sent to the server', async ({ page }) => {
  await app(page, { dictation: true })
  await reset(page)
  await signIn(page)
  const composer = page.getByTestId('composer')
  await composer.getByTestId('voice-button').click()
  await expect(composer.getByTestId('voice-bar')).toBeVisible()
  await expect(page.getByTestId('composer-text-held')).toContainText('하나', { timeout: 8000 })
  await expect(page.getByTestId('composer-text-held')).toContainText('하나 둘 셋.', { timeout: 8000 })
  await composer.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveValue(/\.$/)
  expect(await page.getByTestId('composer-input').inputValue()).toMatch(WORDS)
  const p = await phone(page)
  expect(p.starts).toBe(1)
  // at least a second of sound went to the phone, as 16-bit samples
  expect(p.bytes).toBeGreaterThan(32_000)
  expect(await serverLog(page)).toEqual([])
})

test('first use of a language: that recording goes to the server while the bar says the phone is getting ready; then the phone takes over', async ({ page }) => {
  await app(page, { dictation: true, state: 'needs-model' })
  await reset(page)
  await signIn(page)
  const composer = page.getByTestId('composer')
  await composer.getByTestId('voice-button').click()
  await expect(composer.getByTestId('voice-bar')).toBeVisible()
  await expect(page.getByTestId('voice-hint')).toHaveText('이 휴대폰에서 음성 입력을 준비하는 중: 30%')
  await page.waitForTimeout(600)
  await composer.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  expect(await serverLog(page)).toEqual(['POST /api/transcribe'])
  await page.evaluate(() => (window as unknown as Win).phone.finishInstall?.())
  await page.getByTestId('composer-input').fill('')
  await composer.getByTestId('voice-button').click()
  await expect(page.getByTestId('composer-text-held')).toContainText('하나', { timeout: 8000 })
  await composer.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue(WORDS)
  expect((await phone(page)).installs).toBe(1)
  expect(await serverLog(page)).toEqual(['POST /api/transcribe'])
})

test('an app without dictation-v1 (1.0.9, Android) records the server way, as before', async ({ page }) => {
  await app(page, { dictation: false })
  await reset(page)
  await signIn(page)
  const composer = page.getByTestId('composer')
  await composer.getByTestId('voice-button').click()
  await expect(composer.getByTestId('voice-bar')).toBeVisible()
  await page.waitForTimeout(600)
  await composer.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  expect(await serverLog(page)).toEqual(['POST /api/transcribe'])
  expect((await phone(page)).starts).toBe(0)
})
