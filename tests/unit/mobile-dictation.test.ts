// dictation-v1 on the app's side (mobile/src/dictation.ts, the bridge's messages, the event script): voice input
// written on the iPhone itself (docs/decisions/20261119-iphone-dictation.md).
import { expect, test } from 'bun:test'
import { dictationEventScript, FileTransfers, MobileReceiver, type TransferIO } from '../../mobile/src/bridge'
import { PhoneDictation, type DictationNative } from '../../mobile/src/dictation'
import { DICTATION_CAPABILITY, dictationEventBody, MAX_DICTATION_BYTES, MAX_DICTATION_TEXT, MOBILE_CAPABILITIES, parseMessage, type DictationEvent, type MobileConfig } from '../../mobile/src/protocol'

const nonce = 'a'.repeat(64)
const base = { v: 1 as const, nonce, generation: 1 }
const owner = (id: string, generation = 1) => ({ id, nonce, generation })

function fakeNative(o: { start?: (n: number) => Promise<boolean>; state?: string; install?: string } = {}) {
  const calls: string[] = []
  let cb: ((e: Record<string, unknown>) => void) | null = null
  const native: DictationNative = {
    async check(language) { calls.push(`check ${language}`); return { state: o.state ?? 'ready' } },
    async install(n, language) { calls.push(`install ${n} ${language}`); cb?.({ id: n, event: 'progress', percent: 42.7 }); return o.install ?? 'installed' },
    start(n, language) { calls.push(`start ${n} ${language}`); return o.start ? o.start(n) : Promise.resolve(true) },
    push(n, b64) { calls.push(`push ${n} ${b64}`) },
    stop(n) { calls.push(`stop ${n}`) },
    cancel(n) { calls.push(`cancel ${n}`) },
    addListener(_e, f) { cb = f; return { remove() { cb = null } } },
  }
  return { native, calls, emit: (e: Record<string, unknown>) => cb?.(e) }
}

test('dictation messages are bounded: a language code, in-order base64 sound of whole samples at most 1.5 s', () => {
  const b64 = (n: number) => Buffer.alloc(n).toString('base64')
  for (const type of ['dictation-check', 'dictation-install', 'dictation-start']) {
    expect(parseMessage(JSON.stringify({ ...base, id: 'rec-00001', type, language: 'ko' }))).not.toBeNull()
    for (const language of ['KO', 'ko-KR', 'k', '', 3, '../x']) expect(parseMessage(JSON.stringify({ ...base, id: 'rec-00001', type, language }))).toBeNull()
  }
  expect(parseMessage(JSON.stringify({ ...base, id: 'rec-00001', type: 'dictation-push', seq: 0, b64: b64(3200) }))).not.toBeNull()
  expect(parseMessage(JSON.stringify({ ...base, id: 'rec-00001', type: 'dictation-push', seq: 0, b64: b64(MAX_DICTATION_BYTES) }))).not.toBeNull()
  // more than 1.5 s, half a sample, no sequence, not base64
  for (const m of [{ seq: 0, b64: b64(MAX_DICTATION_BYTES + 2) }, { seq: 0, b64: b64(3) }, { b64: b64(2) }, { seq: -1, b64: b64(2) }, { seq: 0, b64: '**' }])
    expect(parseMessage(JSON.stringify({ ...base, id: 'rec-00001', type: 'dictation-push', ...m }))).toBeNull()
  for (const type of ['dictation-stop', 'dictation-cancel']) expect(parseMessage(JSON.stringify({ ...base, id: 'rec-00001', type }))).not.toBeNull()
})

test('native events reach the page only in the known shapes', () => {
  expect(dictationEventBody({ event: 'text', final: false, text: '안녕' })).toEqual({ event: 'text', final: false, text: '안녕' })
  expect(dictationEventBody({ event: 'text', final: 'yes', text: 'x' })).toBeNull()
  expect(dictationEventBody({ event: 'text', final: true, text: 'x'.repeat(MAX_DICTATION_TEXT + 1) })).toBeNull()
  expect(dictationEventBody({ event: 'error', code: '<script>' })).toEqual({ event: 'error', code: 'failed' })
  expect(dictationEventBody({ event: 'progress', percent: 140 })).toEqual({ event: 'progress', percent: 100 })
  expect(dictationEventBody({ event: 'eval', code: 'x' })).toBeNull()
})

test('the event script runs only in the document whose bridge started the recording', () => {
  const e: DictationEvent = { ...base, id: 'rec-00001', type: 'mobile-dictation', event: 'text', final: false, text: "it's </script>" }
  const got: unknown[] = []
  const run = (bridgeNonce: string | null) => {
    const w = { top: null as unknown, self: null as unknown, mycelMobile: bridgeNonce ? { nonce: bridgeNonce } : undefined, dispatchEvent: (ev: CustomEvent) => got.push(ev.detail) }
    w.top = w; w.self = w
    new Function('window', 'CustomEvent', dictationEventScript(e))(w, class { constructor(readonly type: string, readonly init: { detail: unknown }) {} get detail() { return this.init.detail } })
  }
  run('b'.repeat(64)); run(null)
  expect(got).toEqual([])
  run(nonce)
  expect(got).toEqual([e])
})

test('one recording: its sound in order, its words to the document that started it, done ends it', async () => {
  const f = fakeNative(), out: DictationEvent[] = []
  const d = new PhoneDictation(f.native, e => out.push(e))
  expect(await d.start(owner('rec-00001'), 'ko')).toBe(true)
  d.push(owner('rec-00001'), 0, 'AAAA')
  d.push(owner('rec-00001'), 2, 'BBBB') // a gap: dropped
  d.push(owner('rec-00001'), 1, 'CCCC')
  d.push(owner('rec-00002'), 2, 'DDDD') // another recording's id: dropped
  d.push(owner('rec-00001', 2), 2, 'EEEE') // another generation: dropped
  expect(f.calls).toEqual(['start 1 ko', 'push 1 AAAA', 'push 1 CCCC'])
  f.emit({ id: 1, event: 'text', final: false, text: '안녕' })
  f.emit({ id: 9, event: 'text', final: false, text: 'other' })
  d.stop(owner('rec-00001'))
  // after Stop the last words and done still come
  f.emit({ id: 1, event: 'text', final: true, text: '안녕하세요.' })
  f.emit({ id: 1, event: 'done' })
  f.emit({ id: 1, event: 'text', final: true, text: 'late' })
  expect(out.map(e => [e.id, e.event, 'text' in e ? e.text : ''])).toEqual([['rec-00001', 'text', '안녕'], ['rec-00001', 'text', '안녕하세요.'], ['rec-00001', 'done', '']])
  expect(out[0]).toMatchObject({ v: 1, type: 'mobile-dictation', nonce, generation: 1 })
  expect(f.calls.at(-1)).toBe('stop 1')
})

test('a new recording cancels the one before; a fence cancels everything and delivers nothing more', async () => {
  const f = fakeNative(), out: DictationEvent[] = []
  const d = new PhoneDictation(f.native, e => out.push(e))
  await d.start(owner('rec-00001'), 'en')
  await d.start(owner('rec-00002'), 'en')
  expect(f.calls).toEqual(['start 1 en', 'cancel 1', 'start 2 en'])
  f.emit({ id: 1, event: 'text', final: false, text: 'old' })
  d.clear()
  expect(f.calls.at(-1)).toBe('cancel 2')
  f.emit({ id: 2, event: 'text', final: false, text: 'after the fence' })
  expect(out).toEqual([])
})

test('a recording fenced while the recognizer got ready is cancelled once it is', async () => {
  let release: (ok: boolean) => void = () => {}
  const f = fakeNative({ start: () => new Promise(r => { release = r }) })
  const d = new PhoneDictation(f.native, () => {})
  const starting = d.start(owner('rec-00001'), 'ko')
  d.clear()
  release(true)
  expect(await starting).toBe(false)
  expect(f.calls).toEqual(['start 1 ko', 'cancel 1'])
})

test('check and install answer only the known states; progress goes to the download only', async () => {
  const out: DictationEvent[] = []
  expect(await new PhoneDictation(fakeNative({ state: 'needs-model' }).native, () => {}).check('ko')).toBe('needs-model')
  expect(await new PhoneDictation(fakeNative({ state: 'bogus' }).native, () => {}).check('ko')).toBe('unsupported')
  const f = fakeNative({ install: 'installed' })
  expect(await new PhoneDictation(f.native, e => out.push(e)).install(owner('dl-000001'), 'ko')).toBe('installed')
  expect(out).toEqual([{ ...base, id: 'dl-000001', type: 'mobile-dictation', event: 'progress', percent: 42 }])
  expect(await new PhoneDictation(fakeNative({ install: 'whatever' }).native, () => {}).install(owner('dl-000002'), 'ko')).toBe('failed')
})

const noFiles: TransferIO = { async create() {}, async append() {}, async inspect() { return { size: 0, sha256: '' } }, async share() {}, async remove() {} }
test('the bridge answers dictation only with the capability; the sound itself is never answered', async () => {
  const f = fakeNative()
  const config: MobileConfig = { protocol: 1, appVersion: '1.0.10', platform: 'ios', nonce, generation: 1, capabilities: [...MOBILE_CAPABILITIES, DICTATION_CAPABILITY] }
  const origin = 'https://team.example'
  const make = (c: MobileConfig) => new MobileReceiver(origin, c, new FileTransfers(noFiles), async () => {}, undefined, undefined, undefined, undefined, undefined, undefined, new PhoneDictation(f.native, () => {}))
  const r = make(config)
  const send = (m: object) => r.receive(JSON.stringify({ ...base, ...m }), `${origin}/chat`)
  expect(await send({ id: 'chk-000001', type: 'dictation-check', language: 'ko' })).toMatchObject({ ok: true, dictation: 'ready' })
  expect(await send({ id: 'rec-000001', type: 'dictation-start', language: 'ko' })).toMatchObject({ ok: true, started: true })
  expect(await send({ id: 'rec-000001', type: 'dictation-push', seq: 0, b64: 'AAAAAA==' })).toBeNull()
  expect(await send({ id: 'rec-000001', type: 'dictation-stop' })).toMatchObject({ ok: true })
  expect(f.calls).toEqual(['check ko', 'start 1 ko', 'push 1 AAAAAA==', 'stop 1'])
  // from another origin: nothing
  expect(await r.receive(JSON.stringify({ ...base, id: 'chk-000002', type: 'dictation-check', language: 'ko' }), 'https://evil.example/')).toBeNull()
  // a session reset fences the recording
  await send({ id: 'rec-000002', type: 'dictation-start', language: 'ko' })
  await send({ id: 'reset-00001', type: 'session-reset' })
  expect(f.calls.at(-1)).toBe('cancel 2')
  // an app without the capability refuses
  const without = make({ ...config, capabilities: MOBILE_CAPABILITIES })
  expect(await without.receive(JSON.stringify({ ...base, id: 'chk-000003', type: 'dictation-check', language: 'ko' }), `${origin}/`)).toMatchObject({ ok: false })
})
