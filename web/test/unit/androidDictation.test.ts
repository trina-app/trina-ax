// Voice input by the Android app's recognizer, the page's side (lib/mobile.ts phoneDictation with the Android check
// answer; docs/decisions/20261119-android-dictation.md): the app holds the microphone (ownMic), a recognizer that is not
// on the phone makes the readiness `shared`, the app's level reaches the wave and nothing else, and the page sends no
// sound.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { DesktopDictationEvent } from '@mycel/shared'
import { initMobile, phoneDictation } from '../../src/lib/mobile'
import { checkMac, macReadiness, ownMic, resetMacReadiness } from '../../src/lib/macDictation'
import { DICTATION_CAPABILITY, MOBILE_CAPABILITIES, type MobileConfig, type MobileMessage, type MobileReply } from '../../../mobile/src/protocol'

const config: MobileConfig = { protocol: 1, appVersion: '1.0.10', platform: 'android', nonce: 'f'.repeat(64), generation: 1, capabilities: [...MOBILE_CAPABILITIES, DICTATION_CAPABILITY] }
const win = Object.assign(new EventTarget(), { self: null as unknown, top: null as unknown, mycelMobile: { ...config } as MobileConfig, ReactNativeWebView: { postMessage: (_raw: string) => {} } })
win.self = win; win.top = win
const prior = new Map(['window', 'document', 'location'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
let messages: MobileMessage[] = []
let onDevice = true
const reply = (m: MobileMessage, over: Partial<MobileReply>) =>
  win.dispatchEvent(new CustomEvent('mycel:mobile', { detail: { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...over } }))
const event = (id: string, body: object) =>
  win.dispatchEvent(new CustomEvent('mycel:mobile-dictation', { detail: { v: 1, type: 'mobile-dictation', id, nonce: config.nonce, generation: 1, ...body } }))

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() })
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://team.example', href: 'https://team.example/' } })
  initMobile()
})
afterAll(() => { for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else Reflect.deleteProperty(globalThis, k) } })
beforeEach(() => {
  messages = []; onDevice = true; resetMacReadiness()
  // a new bridge each test (the page's bridge is per nonce)
  win.mycelMobile = { ...config, nonce: crypto.randomUUID().replace(/-/g, '').padEnd(64, '0') }
  config.nonce = win.mycelMobile.nonce
  win.ReactNativeWebView.postMessage = raw => {
    const m = JSON.parse(raw) as MobileMessage
    messages.push(m)
    if (m.type === 'dictation-check') reply(m, { dictation: 'ready', dictationMic: 'app', dictationOnDevice: onDevice })
    else if (m.type === 'dictation-start') reply(m, { started: true })
    else reply(m, {})
  }
  win.dispatchEvent(new Event('mycel:mobile-ready'))
})

test('the app holds the microphone: ownMic after the check, levels to the wave, words to the box, no sound sent', async () => {
  const b = phoneDictation()!
  // the Android app always holds the microphone, before any check too
  expect(ownMic(b)).toBe(true)
  expect(await checkMac('ko', b)).toEqual({ kind: 'ready' })
  // the page says it can take that
  expect(messages.find(m => m.type === 'dictation-check')).toMatchObject({ appMic: true })
  const levels: number[] = []
  const words: DesktopDictationEvent[] = []
  b.onLevel(l => levels.push(l))
  b.onEvent(e => words.push(e))
  const n = await b.start('ko')
  expect(n).not.toBeNull()
  const id = messages.find(m => m.type === 'dictation-start')!.id
  event(id, { event: 'level', level: 0.3 })
  event(id, { event: 'text', final: false, text: '안녕' })
  event('someone-else', { event: 'level', level: 0.9 })
  b.stop(n!)
  event(id, { event: 'text', final: true, text: '안녕하세요' })
  event(id, { event: 'done' })
  expect(levels).toEqual([0.3])
  expect(words).toEqual([{ id: n!, event: 'text', final: false, text: '안녕' }, { id: n!, event: 'text', final: true, text: '안녕하세요' }, { id: n!, event: 'done' }])
  expect(messages.filter(m => m.type === 'dictation-push')).toEqual([])
})

test('a recognizer that is not on the phone is never used: the team server, whatever the team allows', async () => {
  onDevice = false
  const b = phoneDictation()!
  expect(await b.check('ko')).toEqual({ state: 'unsupported' })
  expect(await checkMac('ko', b)).toEqual({ kind: 'server' })
  expect(macReadiness('ko')).toEqual({ kind: 'server' })
})
