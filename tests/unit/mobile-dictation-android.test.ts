// dictation-v1 on the Android app (docs/decisions/20261119-android-dictation.md): the check answer says the app holds
// the microphone and whether its recognizer is on the phone, an older page's check still reads a plain state, level
// events reach the recording (never a model download), and the bounds of a level.
import { expect, test } from 'bun:test'
import { FileTransfers, MobileReceiver, type TransferIO } from '../../mobile/src/bridge'
import { PhoneDictation, type DictationNative } from '../../mobile/src/dictation'
import { DICTATION_CAPABILITY, dictationEventBody, MOBILE_CAPABILITIES, type DictationEvent, type MobileConfig } from '../../mobile/src/protocol'

const nonce = 'b'.repeat(64)
const base = { v: 1 as const, nonce, generation: 1 }
const config: MobileConfig = { protocol: 1, appVersion: '1.0.10', platform: 'android', nonce, generation: 1, capabilities: [...MOBILE_CAPABILITIES, DICTATION_CAPABILITY] }
const io: TransferIO = { create: async () => {}, append: async () => {}, inspect: async () => ({ size: 0, sha256: '' }), share: async () => {}, remove: async () => {} }

function android(check: Record<string, unknown>) {
  let cb: ((e: Record<string, unknown>) => void) | null = null
  const native: DictationNative = {
    check: async () => check, install: async () => 'unsupported', start: async () => true,
    push() {}, stop() {}, cancel() {},
    addListener(_e, f) { cb = f; return { remove() { cb = null } } },
  }
  return { native, emit: (e: Record<string, unknown>) => cb?.(e) }
}
const receiver = (native: DictationNative, out: DictationEvent[] = []) =>
  new MobileReceiver('https://team.example', config, new FileTransfers(io), async () => {}, undefined, undefined, undefined, undefined, undefined, undefined, new PhoneDictation(native, e => out.push(e)))
const ask = (r: MobileReceiver, type: string, extra: object = {}) => r.receive(JSON.stringify({ ...base, id: 'rec-android1', type, ...extra }), 'https://team.example/chat')

test('the check answer: the app holds the microphone, and whether the recognizer is on the phone', async () => {
  const onPhone = await ask(receiver(android({ state: 'ready', locale: 'ko-KR', onDevice: true, micInApp: true }).native), 'dictation-check', { language: 'ko' })
  expect(onPhone).toMatchObject({ ok: true, dictation: 'ready', dictationMic: 'app', dictationOnDevice: true })
  const shared = await ask(receiver(android({ state: 'ready', locale: 'ko-KR', onDevice: false, micInApp: true }).native), 'dictation-check', { language: 'ko' })
  expect(shared).toMatchObject({ dictation: 'ready', dictationMic: 'app', dictationOnDevice: false })
  // the iPhone's module says neither: its answer stays as it was
  const iphone = await ask(receiver(android({ state: 'ready' }).native), 'dictation-check', { language: 'ko' })
  expect(iphone?.dictation).toBe('ready')
  expect(iphone && 'dictationMic' in iphone).toBe(false)
  // no recognizer: unsupported, nothing else
  const none = await ask(receiver(android({ state: 'unsupported', micInApp: true }).native), 'dictation-check', { language: 'ko' })
  expect(none).toMatchObject({ dictation: 'unsupported' })
  expect(none && 'dictationMic' in none).toBe(false)
  expect(await new PhoneDictation(android({ state: 'ready', micInApp: true, onDevice: false }).native, () => {}).check('ko')).toBe('ready')
})

test('level events go to the recording that started, bounded to 0-1; a bad level is dropped', async () => {
  const a = android({ state: 'ready', micInApp: true, onDevice: true })
  const out: DictationEvent[] = []
  const r = receiver(a.native, out)
  expect((await ask(r, 'dictation-start', { language: 'ko' }))?.started).toBe(true)
  a.emit({ id: 1, event: 'level', level: 0.42 })
  a.emit({ id: 1, event: 'level', level: 7 })
  a.emit({ id: 1, event: 'level', level: 'loud' })
  a.emit({ id: 2, event: 'level', level: 0.5 })
  a.emit({ id: 1, event: 'text', final: false, text: '안녕' })
  expect(out.map(e => ('level' in e ? e.level : 'text' in e ? e.text : e.event))).toEqual([0.42, 1, '안녕'])
  expect(out[0]).toMatchObject({ ...base, id: 'rec-android1', type: 'mobile-dictation', event: 'level' })
  expect(dictationEventBody({ event: 'level', level: -1 })).toEqual({ event: 'level', level: 0 })
  expect(dictationEventBody({ event: 'level', level: Number.NaN })).toBeNull()
})
