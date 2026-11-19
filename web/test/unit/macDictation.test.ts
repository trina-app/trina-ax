// Voice input transcribed on this Mac, the page's side (lib/macDictation.ts): the text the box shows (final words,
// then the newest guess, which the next text replaces), Stop waiting for every word to be final, Cancel, a helper that
// stops on the way (its words stay), and the readiness per language: asked once, Apple's model fetched on the first
// tap with its progress, a failed download tried again, the server where the Mac cannot. The Mac's blocked-mic words.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { DesktopDictationCheck, DesktopDictationEvent } from '@mycel/shared'
import { checkMac, macFailed, macReadiness, OnDeviceRun, prepareMac, resetMacReadiness, shownText, watchMacReadiness, type MacDictationBridge } from '../../src/lib/macDictation'
import { micBlocked, micErrorKey } from '../../src/lib/appWording'

type Fake = MacDictationBridge & { emit(e: DesktopDictationEvent): void; pushed: number; stops: number[]; cancels: number[]; checks: string[]; installs: string[]; finishInstall(r: 'installed' | 'failed' | 'unsupported'): void; progress(p: number): void }

function fakeBridge(o: { check?: DesktopDictationCheck; start?: number | null } = {}): Fake {
  const cbs = new Set<(e: DesktopDictationEvent) => void>()
  let installDone: ((r: 'installed' | 'failed' | 'unsupported') => void) | null = null
  let onProgress: ((p: number) => void) | undefined
  const f: Fake = {
    version: 1,
    pushed: 0,
    stops: [],
    cancels: [],
    checks: [],
    installs: [],
    check: async (l) => { f.checks.push(l); return o.check ?? { state: 'ready', locale: 'en-US' } },
    install: (l, p) => { f.installs.push(l); onProgress = p; return new Promise((r) => { installDone = r }) },
    start: async () => (o.start === undefined ? 7 : o.start),
    push: (_id, s) => { f.pushed += s.length },
    stop: (id) => { f.stops.push(id) },
    cancel: (id) => { f.cancels.push(id) },
    onEvent: (cb) => { cbs.add(cb); return () => void cbs.delete(cb) },
    emit: (e) => cbs.forEach((cb) => cb(e)),
    finishInstall: (r) => installDone?.(r),
    progress: (p) => onProgress?.(p),
  }
  return f
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('the text the box shows', () => {
  test('final words, then the newest guess; languages written without spaces join as they are', () => {
    expect(shownText(['One two three.', ' Four.'], 'five si', 'en')).toBe('One two three. Four. five si')
    expect(shownText([], '', 'en')).toBe('')
    expect(shownText(['이번 주 금요일까지'], '견적서를', 'ko')).toBe('이번 주 금요일까지 견적서를')
    expect(shownText(['今日は'], '晴れです', 'ja')).toBe('今日は晴れです')
    expect(shownText(['  a  ', ''], '  b  c ', 'en')).toBe('a b c')
  })
})

describe('one recording on this Mac', () => {
  test('a guess is replaced by the next one, a final one stays; Stop waits for done', async () => {
    const b = fakeBridge()
    const shown: string[] = []
    const r = new OnDeviceRun({ bridge: b, language: 'en', onText: (t) => shown.push(t), onFail: () => { throw new Error('no fail') } })
    expect(await r.start()).toBe(true)
    r.push(new Float32Array(1365))
    expect(b.pushed).toBe(1365)
    b.emit({ id: 7, event: 'text', final: false, text: 'one' })
    b.emit({ id: 7, event: 'text', final: false, text: 'one two' })
    b.emit({ id: 99, event: 'text', final: false, text: 'another recording' })
    b.emit({ id: 7, event: 'text', final: true, text: 'One two.' })
    b.emit({ id: 7, event: 'text', final: false, text: 'three' })
    expect(shown).toEqual(['one', 'one two', 'One two.', 'One two. three'])
    expect(r.heard).toBe(true)
    const done = r.finish()
    expect(b.stops).toEqual([7])
    b.emit({ id: 7, event: 'text', final: true, text: 'Three.' })
    b.emit({ id: 7, event: 'done' })
    expect(await done).toEqual({ text: 'One two. Three.', ok: true })
    // nothing after the end
    b.emit({ id: 7, event: 'text', final: true, text: 'late' })
    expect(shown.at(-1)).toBe('One two. Three.')
  })
  test('the helper did not start: false (the team server then), and nothing is listened to', async () => {
    const b = fakeBridge({ start: null })
    const r = new OnDeviceRun({ bridge: b, language: 'en', onText: () => {}, onFail: () => {} })
    expect(await r.start()).toBe(false)
    r.push(new Float32Array(100))
    expect(b.pushed).toBe(0)
  })
  test('cancel: the helper is told, nothing more is shown, finish gives what was there', async () => {
    const b = fakeBridge()
    const shown: string[] = []
    const r = new OnDeviceRun({ bridge: b, language: 'en', onText: (t) => shown.push(t), onFail: () => {} })
    await r.start()
    b.emit({ id: 7, event: 'text', final: false, text: 'one' })
    r.cancel()
    b.emit({ id: 7, event: 'text', final: false, text: 'one two' })
    expect(b.cancels).toEqual([7])
    expect(shown).toEqual(['one'])
  })
  test('cancelled while it starts: the new recording is cancelled at once', async () => {
    const b = fakeBridge()
    const r = new OnDeviceRun({ bridge: b, language: 'en', onText: () => {}, onFail: () => {} })
    const started = r.start()
    r.cancel()
    expect(await started).toBe(false)
    expect(b.cancels).toEqual([7])
  })
  test('the helper stops while recording: onFail, and the words so far (the guess too) stay', async () => {
    const b = fakeBridge()
    const fails: string[] = []
    const r = new OnDeviceRun({ bridge: b, language: 'en', onText: () => {}, onFail: (c) => fails.push(c) })
    await r.start()
    b.emit({ id: 7, event: 'text', final: true, text: 'One.' })
    b.emit({ id: 7, event: 'text', final: false, text: 'two' })
    b.emit({ id: 7, event: 'error', code: 'helper' })
    expect(fails).toEqual(['helper'])
    expect(await r.finish()).toEqual({ text: 'One. two', ok: false })
  })
  test('an error after Stop ends finish with ok false, without onFail', async () => {
    const b = fakeBridge()
    const fails: string[] = []
    const r = new OnDeviceRun({ bridge: b, language: 'en', onText: () => {}, onFail: (c) => fails.push(c) })
    await r.start()
    b.emit({ id: 7, event: 'text', final: false, text: 'one' })
    const done = r.finish()
    b.emit({ id: 7, event: 'error', code: 'timeout' })
    expect(await done).toEqual({ text: 'one', ok: false })
    expect(fails).toEqual([])
  })
})

describe('readiness per language', () => {
  beforeEach(() => resetMacReadiness())
  test('no bridge (a browser, Windows): the server', async () => {
    expect(await checkMac('ko', null)).toEqual({ kind: 'server' })
  })
  test('asked once; the answer is kept and watchers hear it', async () => {
    const b = fakeBridge()
    let heard = 0
    const off = watchMacReadiness(() => heard++)
    expect(macReadiness('en')).toEqual({ kind: 'unknown' })
    const [x, y] = await Promise.all([checkMac('en', b), checkMac('en', b)])
    expect(x).toEqual({ kind: 'ready' })
    expect(y).toEqual({ kind: 'ready' })
    await tick()
    expect(await checkMac('en', b)).toEqual({ kind: 'ready' })
    expect(b.checks).toEqual(['en'])
    expect(heard).toBeGreaterThan(0)
    off()
  })
  test('a missing model: fetched on the first tap with its progress, then ready', async () => {
    const b = fakeBridge({ check: { state: 'needs-model', locale: 'ko-KR' } })
    expect(await checkMac('ko', b)).toEqual({ kind: 'model' })
    await tick()
    prepareMac('ko', b)
    prepareMac('ko', b)
    expect(b.installs).toEqual(['ko'])
    expect(macReadiness('ko')).toEqual({ kind: 'preparing', percent: 0 })
    b.progress(42.7)
    expect(macReadiness('ko')).toEqual({ kind: 'preparing', percent: 42 })
    b.finishInstall('installed')
    await tick()
    expect(macReadiness('ko')).toEqual({ kind: 'ready' })
  })
  test('a failed download goes back to "model": the next tap tries again', async () => {
    const b = fakeBridge({ check: { state: 'needs-model', locale: 'ko-KR' } })
    await checkMac('ko', b)
    await tick()
    prepareMac('ko', b)
    b.finishInstall('failed')
    await tick()
    expect(macReadiness('ko')).toEqual({ kind: 'model' })
    prepareMac('ko', b)
    expect(b.installs).toEqual(['ko', 'ko'])
  })
  test('a language the Mac lacks, an unavailable Mac, a failing check: the server', async () => {
    expect(await checkMac('id', fakeBridge({ check: { state: 'unsupported' } }))).toEqual({ kind: 'server' })
    expect(await checkMac('ko', fakeBridge({ check: { state: 'unavailable' } }))).toEqual({ kind: 'server' })
    const broken = fakeBridge()
    broken.check = () => Promise.reject(new Error('ipc'))
    expect(await checkMac('ja', broken)).toEqual({ kind: 'server' })
  })
  test('a helper that failed in a recording: the server from then on', async () => {
    const b = fakeBridge()
    await checkMac('en', b)
    await tick()
    macFailed('en')
    expect(await checkMac('en', b)).toEqual({ kind: 'server' })
    expect(b.checks).toEqual(['en'])
  })
})

describe('a blocked microphone in the Mac app', () => {
  test('said as the Mac\'s System Settings, even while Chromium says it would ask; it is "blocked"', () => {
    expect(micErrorKey('denied', { app: null, mac: true, permission: 'prompt' })).toBe('voice.deniedMac')
    expect(micErrorKey('denied', { app: null, mac: true, permission: 'denied' })).toBe('voice.deniedMac')
    expect(micBlocked('voice.deniedMac')).toBe(true)
    // a browser keeps its own words
    expect(micErrorKey('denied', { app: null, permission: 'denied' })).toBe('voice.denied')
    expect(micErrorKey('missing', { app: null, mac: true, permission: null })).toBe('voice.noMic')
  })
})
