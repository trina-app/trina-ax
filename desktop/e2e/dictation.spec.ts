// Voice input transcribed on this Mac (docs/decisions/20261119-mac-dictation.md) in the real app: the team page's
// bridge (dictation) asks the main process, which runs the helper (here tests/fixtures/dictation/fake-dictation.ts,
// the real one's commands and lines, through MYCEL_DICTATION_HELPER): the check per language, Apple's model fetched
// once with its progress, a recording's samples in and its words back to that page only, Stop with every word final,
// and a helper that crashes (no more recordings on this Mac until the app restarts). A team page in a frame gets no
// bridge (smoke.spec.ts); here the open team's page has it.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ACME, addTeam, close, launch, newUserData, ROOT, stopLeftoverApps } from './helpers'

stopLeftoverApps()

const FAKE = join(ROOT, '..', 'tests', 'fixtures', 'dictation', 'fake-dictation.ts')

test('the Mac transcribes: model fetched once with its progress, words while talking, every word final after Stop', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dictation-e2e-'))
  const app = await launch(newUserData(), { MYCEL_DICTATION_HELPER: FAKE, FAKE_DICTATION: 'no-model', FAKE_DICTATION_DIR: state })
  try {
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    expect(await page.evaluate(() => (window as any).mycelDesktop.dictation?.version)).toBe(1)
    expect(await page.evaluate(() => typeof (window as any).mycelDesktop.openMicSettings)).toBe(process.platform === 'darwin' ? 'function' : 'undefined')
    // the model is missing: fetched once, with its progress
    expect(await page.evaluate(() => (window as any).mycelDesktop.dictation.check('ko'))).toEqual({ state: 'needs-model', locale: 'ko-KO' })
    const install = await page.evaluate(async () => {
      const seen: number[] = []
      const r = await (window as any).mycelDesktop.dictation.install('ko', (p: number) => seen.push(p))
      return { r, seen }
    })
    expect(install.r).toBe('installed')
    expect(install.seen).toEqual([0, 40, 80, 100])
    expect(await page.evaluate(() => (window as any).mycelDesktop.dictation.check('ko'))).toEqual({ state: 'ready', locale: 'ko-KO' })
    // a language the Mac lacks: the server's
    expect(await page.evaluate(() => (window as any).mycelDesktop.dictation.check('id'))).toEqual({ state: 'unsupported' })

    // a recording: 2 s of samples in the page's ~85 ms pieces, words back while it runs, then Stop
    const run = await page.evaluate(async () => {
      const d = (window as any).mycelDesktop.dictation
      const events: any[] = []
      const off = d.onEvent((e: any) => events.push(e))
      const id = await d.start('ko')
      const wait = async (f: () => boolean) => { const end = Date.now() + 8000; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)) }
      for (let i = 0; i < 16; i++) d.push(id, new Float32Array(1365).fill(0.01))
      await wait(() => events.some((e) => e.event === 'text' && e.final))
      const whileTalking = events.length
      for (let i = 0; i < 8; i++) d.push(id, new Float32Array(1365))
      d.stop(id)
      await wait(() => events.some((e) => e.event === 'done'))
      off()
      return { id, events, whileTalking }
    })
    expect(typeof run.id).toBe('number')
    expect(run.whileTalking).toBeGreaterThanOrEqual(4)
    expect(run.events.slice(0, 4)).toEqual([
      { id: run.id, event: 'text', final: false, text: 'one' },
      { id: run.id, event: 'text', final: false, text: 'one two' },
      { id: run.id, event: 'text', final: false, text: 'one two three' },
      { id: run.id, event: 'text', final: true, text: 'One two three.' },
    ])
    expect(run.events.filter((e: any) => e.final).map((e: any) => e.text)).toEqual(['One two three.', 'Four five.'])
    expect(run.events.at(-1)).toEqual({ id: run.id, event: 'done' })
    // only the commands it needs, each with the language as a code
    const ran = readdirSync(state).filter((f) => f.startsWith('ran-')).length
    expect(ran).toBe(5)
  } finally {
    await close(app)
    rmSync(state, { recursive: true, force: true })
  }
})

test('a helper that crashes while recording: an error to the page, and the next recording does not start on this Mac', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dictation-e2e-'))
  const app = await launch(newUserData(), { MYCEL_DICTATION_HELPER: FAKE, FAKE_DICTATION: 'crash', FAKE_DICTATION_DIR: state })
  try {
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    const r = await page.evaluate(async () => {
      const d = (window as any).mycelDesktop.dictation
      const events: any[] = []
      const off = d.onEvent((e: any) => events.push(e))
      const id = await d.start('en')
      for (let i = 0; i < 8; i++) d.push(id, new Float32Array(1365))
      const end = Date.now() + 8000
      while (!events.some((e) => e.event === 'error') && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
      off()
      return { id, events, next: await d.start('en'), check: await d.check('en') }
    })
    expect(r.events.at(-1)).toEqual({ id: r.id, event: 'error', code: 'helper' })
    expect(r.next).toBeNull()
    expect(r.check).toEqual({ state: 'unavailable' })
  } finally {
    await close(app)
    rmSync(state, { recursive: true, force: true })
  }
})

test('without the helper (Windows, Intel, older macOS): no dictation on the bridge', async () => {
  const app = await launch(newUserData(), { MYCEL_DICTATION_HELPER: '/nonexistent/dictation' })
  try {
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    expect(await page.evaluate(() => (window as any).mycelDesktop.dictation)).toBeUndefined()
  } finally {
    await close(app)
  }
})
