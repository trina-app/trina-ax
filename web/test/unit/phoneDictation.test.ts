// Voice input written on the iPhone itself, the page's side (lib/mobile.ts phoneDictation, dictation-v1): the same
// bridge shape as the Mac app's, so lib/macDictation.ts runs it; the samples go as signed 16-bit base64 about every
// 0.1 s, the words come back by the recording's envelope id, a stop that never hears done ends, a new bridge (a fence)
// ends the recording, and only an app that offers dictation-v1 gets it.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { DesktopDictationEvent } from '@mycel/shared'
import { initMobile, phoneDictation } from '../../src/lib/mobile'
import { macDictationBridge, OnDeviceRun, onPhone } from '../../src/lib/macDictation'
import { DICTATION_CAPABILITY, MOBILE_CAPABILITIES, type MobileConfig, type MobileMessage, type MobileReply } from '../../../mobile/src/protocol'

const config: MobileConfig = { protocol: 1, appVersion: '1.0.10', platform: 'ios', nonce: 'd'.repeat(64), generation: 1, capabilities: [...MOBILE_CAPABILITIES, DICTATION_CAPABILITY] }
const win = Object.assign(new EventTarget(), { self: null as unknown, top: null as unknown, mycelMobile: { ...config } as MobileConfig, ReactNativeWebView: { postMessage: (_raw: string) => {} } })
win.self = win; win.top = win
const prior = new Map(['window', 'document', 'location'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
let messages: MobileMessage[] = []
let answer: (m: MobileMessage) => Partial<MobileReply> | null = () => ({})
const reply = (m: MobileMessage, over: Partial<MobileReply>) =>
  win.dispatchEvent(new CustomEvent('mycel:mobile', { detail: { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...over } }))
const event = (id: string, body: object, nonce = config.nonce) =>
  win.dispatchEvent(new CustomEvent('mycel:mobile-dictation', { detail: { v: 1, type: 'mobile-dictation', id, nonce, generation: 1, ...body } }))
const tick = () => new Promise(r => setTimeout(r, 0))

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() })
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://team.example', href: 'https://team.example/' } })
  initMobile()
})
afterAll(() => { for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else Reflect.deleteProperty(globalThis, k) } })
beforeEach(() => {
  messages = []; win.mycelMobile = { ...config }
  answer = m => (m.type === 'dictation-check' ? { dictation: 'ready' } : m.type === 'dictation-start' ? { started: true } : {})
  win.ReactNativeWebView.postMessage = raw => {
    const m = JSON.parse(raw) as MobileMessage
    messages.push(m)
    if (m.type === 'dictation-push') return
    const over = answer(m)
    if (over) reply(m, over)
  }
  win.dispatchEvent(new Event('mycel:mobile-ready'))
})

test('only the iPhone app that offers dictation-v1 gets the phone bridge; the Mac app keeps its own', () => {
  expect(phoneDictation()).not.toBeNull()
  expect(macDictationBridge(null)).toBe(phoneDictation())
  expect(onPhone(null)).toBe(true)
  const mac = { dictation: { version: 1 } } as never
  expect(macDictationBridge(mac)).toBe((mac as { dictation: unknown }).dictation as never)
  expect(onPhone(mac)).toBe(false)
  win.mycelMobile = { ...config, nonce: 'e'.repeat(64), capabilities: MOBILE_CAPABILITIES }
  expect(phoneDictation()).toBeNull()
  expect(macDictationBridge(null)).toBeNull()
})

test('check answers the phone state for the language', async () => {
  const b = phoneDictation()!
  expect(await b.check('ko')).toEqual({ state: 'ready', locale: 'ko' })
  answer = () => ({ dictation: 'needs-model' })
  expect(await b.check('ko')).toEqual({ state: 'needs-model', locale: 'ko' })
  answer = () => ({ dictation: 'bogus' as never })
  expect(await b.check('id')).toEqual({ state: 'unsupported' })
  expect(messages.filter(m => m.type === 'dictation-check').map(m => 'language' in m && m.language)).toEqual(['ko', 'ko', 'id'])
})

test('a recording: 16-bit samples every 0.1 s in order, its words by id, Stop flushes the rest and waits for done', async () => {
  const b = phoneDictation()!
  const got: DesktopDictationEvent[] = []
  const off = b.onEvent(e => got.push(e))
  const n = await b.start('ko')
  expect(typeof n).toBe('number')
  const start = messages.find(m => m.type === 'dictation-start')!
  b.push(n!, new Float32Array(1000).fill(0.5))
  expect(messages.filter(m => m.type === 'dictation-push')).toHaveLength(0)
  b.push(n!, new Float32Array(1000).fill(-1))
  const pushes = () => messages.filter((m): m is Extract<MobileMessage, { type: 'dictation-push' }> => m.type === 'dictation-push')
  expect(pushes()).toHaveLength(1)
  const first = new Int16Array(Uint8Array.from(Buffer.from(pushes()[0]!.b64, 'base64')).buffer)
  expect(first.length).toBe(1600)
  expect(first[0]).toBe(Math.floor(0.5 * 0x7fff))
  expect(first[1599]).toBe(-0x8000)
  expect(pushes()[0]!.id).toBe(start.id)
  // another document's words, and another recording's, are not this one's
  event(start.id, { event: 'text', final: false, text: 'nope' }, 'f'.repeat(64))
  event('someone-else', { event: 'text', final: false, text: 'nope' })
  event(start.id, { event: 'text', final: false, text: '안녕' })
  b.stop(n!)
  expect(pushes().map(m => m.seq)).toEqual([0, 1])
  expect(Buffer.from(pushes()[1]!.b64, 'base64').length).toBe(400 * 2)
  expect(messages.at(-1)).toMatchObject({ type: 'dictation-stop', id: start.id })
  event(start.id, { event: 'text', final: true, text: '안녕하세요.' })
  event(start.id, { event: 'done' })
  event(start.id, { event: 'text', final: true, text: 'late' })
  expect(got).toEqual([{ id: n!, event: 'text', final: false, text: '안녕' }, { id: n!, event: 'text', final: true, text: '안녕하세요.' }, { id: n!, event: 'done' }])
  off()
})

test("the Mac's state machine runs on the phone bridge: words while talking, every one final after Stop", async () => {
  const shown: string[] = []
  const run = new OnDeviceRun({ bridge: phoneDictation()!, language: 'en', onText: t => shown.push(t), onFail: () => {} })
  expect(await run.start()).toBe(true)
  const id = messages.find(m => m.type === 'dictation-start')!.id
  run.push(new Float32Array(1600))
  event(id, { event: 'text', final: false, text: 'hello wor' })
  event(id, { event: 'text', final: true, text: 'Hello world.' })
  const done = run.finish()
  event(id, { event: 'text', final: true, text: 'Bye.' })
  event(id, { event: 'done' })
  expect(await done).toEqual({ text: 'Hello world. Bye.', ok: true })
  expect(shown).toEqual(['hello wor', 'Hello world.', 'Hello world. Bye.'])
})

test('a phone that cannot start, a new bridge (fence) and a done that never comes all end the recording', async () => {
  const b = phoneDictation()!
  answer = m => (m.type === 'dictation-start' ? { started: false } : {})
  expect(await b.start('ko')).toBeNull()
  answer = m => (m.type === 'dictation-start' ? { started: true } : {})
  const got: DesktopDictationEvent[] = []
  const off = b.onEvent(e => got.push(e))
  const n = await b.start('ko')
  win.dispatchEvent(new Event('mycel:mobile-ready'))
  expect(got).toEqual([{ id: n!, event: 'error', code: 'fenced' }])
  // cancel tells the app; nothing more arrives for that id
  const m2 = await phoneDictation()!.start('ko')
  phoneDictation()!.cancel(m2!)
  await tick()
  expect(messages.at(-1)).toMatchObject({ type: 'dictation-cancel' })
  off()
})

test('install: progress events for that download only, then the answer', async () => {
  const b = phoneDictation()!
  let pending: MobileMessage | null = null
  answer = m => { if (m.type === 'dictation-install') { pending = m; return null } return {} }
  const seen: number[] = []
  const installing = b.install('ko', p => seen.push(p))
  await tick()
  expect(pending).not.toBeNull()
  event(pending!.id, { event: 'progress', percent: 10 })
  event('other-download', { event: 'progress', percent: 99 })
  event(pending!.id, { event: 'progress', percent: 55.5 })
  reply(pending!, { installed: 'installed' })
  expect(await installing).toBe('installed')
  expect(seen).toEqual([10, 55])
})
