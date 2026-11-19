// Voice input transcribed on this Mac, the desktop app's side (desktop/src/main/dictation.ts): where the helper is
// found (Apple silicon, macOS 26, not the store build), a check per language, Apple's model fetched once with its
// progress, a recording's samples as 16-bit sound to the helper and its words back as events, Stop with every word
// final, Cancel, and a helper that fails (the team server takes over). The helper is tests/fixtures/dictation/
// fake-dictation.ts (the real one's commands and lines, no Speech framework).
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DesktopDictationEvent } from '@mycel/shared'
import { DictationHost, dictationHelperPath, pcm16 } from '../../desktop/src/main/dictation'

const FAKE = path.join(import.meta.dir, '../fixtures/dictation/fake-dictation.ts')
const dirs: string[] = []
const hosts: DictationHost[] = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.stopAll()
  delete process.env.FAKE_DICTATION
  delete process.env.FAKE_DICTATION_DIR
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function host(mode = '', o: { readyTimeoutMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-'))
  dirs.push(dir)
  process.env.FAKE_DICTATION = mode
  process.env.FAKE_DICTATION_DIR = dir
  const events: DesktopDictationEvent[] = []
  const h = new DictationHost({ helper: () => FAKE, send: (e) => events.push(e), ...o })
  hosts.push(h)
  const ran = () => fs.readdirSync(dir).filter((f) => f.startsWith('ran-')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as string[])
  return { h, events, dir, ran }
}

async function until(f: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(10)
  }
}
/** seconds of quiet 16 kHz sound, in the page's ~85 ms pieces */
function feed(h: DictationHost, id: number, seconds: number) {
  for (let i = 0; i < Math.round(seconds * 16_000 / 1365); i++) h.push(id, new Float32Array(1365))
}

describe('where the helper is', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-app-'))
  const exe = path.join(app, 'Trina AX')
  fs.writeFileSync(path.join(app, 'dictation'), '')
  test('next to the app on Apple silicon with macOS 26 (Darwin 25) or later; nowhere else', () => {
    expect(dictationHelperPath({}, exe, 'darwin', 'arm64', '25.6.0', false)).toBe(path.join(app, 'dictation'))
    expect(dictationHelperPath({}, exe, 'darwin', 'arm64', '26.1.0', false)).toBe(path.join(app, 'dictation'))
    // macOS 15, an Intel Mac, the Mac App Store build, Windows, Linux
    expect(dictationHelperPath({}, exe, 'darwin', 'arm64', '24.6.0', false)).toBeNull()
    expect(dictationHelperPath({}, exe, 'darwin', 'x64', '25.6.0', false)).toBeNull()
    expect(dictationHelperPath({}, exe, 'darwin', 'arm64', '25.6.0', true)).toBeNull()
    expect(dictationHelperPath({}, exe, 'win32', 'x64', '10.0.22631', false)).toBeNull()
    expect(dictationHelperPath({}, exe, 'linux', 'arm64', '6.8.0', false)).toBeNull()
    // a build without the file
    expect(dictationHelperPath({}, path.join(os.tmpdir(), 'nowhere', 'Trina AX'), 'darwin', 'arm64', '25.6.0', false)).toBeNull()
  })
  test('MYCEL_DICTATION_HELPER (tests, a dev build) when that file is there', () => {
    expect(dictationHelperPath({ MYCEL_DICTATION_HELPER: FAKE }, exe, 'win32', 'x64', '1', false)).toBe(FAKE)
    expect(dictationHelperPath({ MYCEL_DICTATION_HELPER: '/nonexistent/dictation' }, exe, 'darwin', 'arm64', '25.6.0', false)).toBeNull()
  })
  test('no helper: version 0, every check unavailable, no recording', async () => {
    const h = new DictationHost({ helper: () => null, send: () => {} })
    expect(h.version()).toBe(0)
    expect(await h.check('ko')).toEqual({ state: 'unavailable' })
    expect(await h.start('ko')).toBeNull()
    expect(await h.install('ko')).toBe('failed')
  })
})

test('16-bit sound from the page\'s samples: clipped, rounded, little-endian', () => {
  const b = pcm16(new Float32Array([0, 1, -1, 0.5, 2, -2, NaN]))
  expect([...new Int16Array(b.buffer, b.byteOffset, b.length / 2)]).toEqual([0, 32767, -32768, 16384, 32767, -32768, 0])
})

describe('a check per language', () => {
  test('ready with the locale it uses; asked once', async () => {
    const { h, ran } = host()
    expect(await h.check('en')).toEqual({ state: 'ready', locale: 'en-US' })
    expect(await h.check('en')).toEqual({ state: 'ready', locale: 'en-US' })
    expect(ran().filter((a) => a[0] === 'probe')).toHaveLength(1)
    expect(ran()[0]).toEqual(['probe', '--language', 'en'])
  })
  test('a language the Mac lacks (Indonesian), an unavailable Mac, a language that is not a code', async () => {
    expect(await host().h.check('id')).toEqual({ state: 'unsupported' })
    expect(await host('unavailable').h.check('ko')).toEqual({ state: 'unavailable' })
    const { h, ran } = host()
    expect(await h.check('ko; rm -rf /')).toEqual({ state: 'unavailable' })
    expect(await h.check('KO')).toEqual({ state: 'unavailable' })
    expect(ran()).toEqual([])
  })
  test('the model fetched once: its progress, then ready; a second install joins the first', async () => {
    const { h, ran } = host('no-model')
    expect(await h.check('ko')).toEqual({ state: 'needs-model', locale: 'ko-KO' })
    const a: number[] = []
    const b: number[] = []
    const [r1, r2] = await Promise.all([h.install('ko', (p) => a.push(p)), h.install('ko', (p) => b.push(p))])
    expect([r1, r2]).toEqual(['installed', 'installed'])
    expect(a).toEqual([0, 40, 80, 100])
    expect(b.at(-1)).toBe(100)
    expect(ran().filter((x) => x[0] === 'install')).toHaveLength(1)
    // the check is asked again after the download
    expect(await h.check('ko')).toEqual({ state: 'ready', locale: 'ko-KO' })
  })
  test('a download that fails says so; the model stays missing', async () => {
    const { h } = host('no-model,install-fail')
    expect(await h.install('ko')).toBe('failed')
    expect(await h.check('ko')).toEqual({ state: 'needs-model', locale: 'ko-KO' })
  })
})

describe('a recording', () => {
  test('samples in, guesses and final words out, done after Stop', async () => {
    const { h, events } = host()
    const id = await h.start('en')
    expect(typeof id).toBe('number')
    feed(h, id!, 1.3)
    await until(() => events.some((e) => e.event === 'text' && e.final))
    expect(events.slice(0, 4)).toEqual([
      { id: id!, event: 'text', final: false, text: 'one' },
      { id: id!, event: 'text', final: false, text: 'one two' },
      { id: id!, event: 'text', final: false, text: 'one two three' },
      { id: id!, event: 'text', final: true, text: 'One two three.' },
    ])
    feed(h, id!, 0.5)
    h.stop(id!)
    await until(() => events.some((e) => e.event === 'done'))
    const finals = events.filter((e) => e.event === 'text' && e.final).map((e) => (e as { text: string }).text)
    expect(finals).toEqual(['One two three.', 'Four.'])
    expect(events.at(-1)).toEqual({ id: id!, event: 'done' })
  })
  test('cancel: nothing more comes, the helper goes', async () => {
    const { h, events } = host()
    const id = (await h.start('en'))!
    feed(h, id, 0.5)
    await until(() => events.length > 0)
    h.cancel(id)
    const n = events.length
    feed(h, id, 2)
    h.stop(id)
    await Bun.sleep(300)
    expect(events.length).toBe(n)
    expect(events.some((e) => e.event === 'done')).toBe(false)
  })
  test('a second recording ends the first; samples for an old id are dropped', async () => {
    const { h, events } = host()
    const a = (await h.start('en'))!
    const b = (await h.start('en'))!
    expect(b).not.toBe(a)
    feed(h, a, 1)
    feed(h, b, 0.5)
    h.stop(b)
    await until(() => events.some((e) => e.event === 'done'))
    expect(events.every((e) => e.id === b)).toBe(true)
  })
  test('a helper that crashes: an error, and the server transcribes from then on', async () => {
    const { h, events } = host('crash')
    const id = (await h.start('en'))!
    feed(h, id, 0.5)
    await until(() => events.some((e) => e.event === 'error'))
    expect(events.at(-1)).toEqual({ id, event: 'error', code: 'helper' })
    expect(await h.start('en')).toBeNull()
    expect(await h.check('en')).toEqual({ state: 'unavailable' })
  })
  test('a helper that never says ready: start answers null after the wait (the page uses the server)', async () => {
    const { h } = host('no-ready', { readyTimeoutMs: 300 })
    const t = Date.now()
    expect(await h.start('en')).toBeNull()
    expect(Date.now() - t).toBeLessThan(3000)
  })
  test('cancel, a second start or the page going while a start waits: the waiting start answers null', async () => {
    const { h } = host('slow-ready')
    const first = h.start('en')
    const second = h.start('en')
    expect(await first).toBeNull()
    expect(typeof (await second)).toBe('number')
    const third = h.start('en')
    h.stopAll()
    expect(await third).toBeNull()
  })
  test('the last words and done are read even when the helper exits right after them', async () => {
    for (let i = 0; i < 5; i++) {
      const { h, events } = host()
      const id = (await h.start('en'))!
      feed(h, id, 0.5)
      h.stop(id)
      await until(() => events.some((e) => e.event !== 'text'))
      expect(events.at(-1)).toEqual({ id, event: 'done' })
      expect(events.filter((e) => e.event === 'text' && e.final).map((e) => (e as { text: string }).text)).toEqual(['One.'])
    }
  })
  test('a model that went missing: the recording does not start (the page uses the server)', async () => {
    const { h } = host('no-model')
    expect(await h.start('ko')).toBeNull()
  })
  test('the helper is told the language only as a code', async () => {
    const { h, ran } = host()
    expect(await h.start('en --x')).toBeNull()
    const id = (await h.start('ja'))!
    h.cancel(id)
    expect(ran().map((a) => a.join(' '))).toEqual(['listen --language ja'])
  })
})
