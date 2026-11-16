// "Find work files on this computer": the app's own consent window (src/main/work-consent-window.ts) in the real
// Electron, with the built page. It is a modal child of the app window; a yes clicked at once or Enter right after typing
// does not count, Enter later does; Escape and closing are a no; another page of the app can neither read the window's
// words nor answer it. Nothing of this computer is read (fixtures/work-consent-main.ts). `bun run build` first; run on
// a Mac by hand: `bunx playwright test -c e2e/rtc-native.config.ts work-consent`.
import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fixtureResult } from './fixture-run'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

test('the consent window: only the person, only from the window, only when they could mean it', async () => {
  test.skip(process.platform === 'linux', 'not offered on Linux')
  const dir = mkdtempSync(join(tmpdir(), 'work-consent-'))
  try {
    const output = join(dir, 'main.cjs')
    await exec('bun', ['build', join(import.meta.dirname, 'fixtures/work-consent-main.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${output}`])
    const electron = createRequire(import.meta.url)('electron') as string
    const env = { ...process.env, CONSENT_DIST: join(import.meta.dirname, '..', 'dist') }
    const out = await fixtureResult(electron, [output], env, 'CONSENT_RESULT', 60_000)
    expect(out.modal).toBe(true)
    expect(out.text).toEqual({ title: expect.stringMatching(/^Bring your work files into /), places: ['Documents', 'Desktop', 'Downloads'], yes: 'Find work files', focused: 'consent-yes', lang: 'en', bridge: 'undefined', keys: ['view', 'answer'] })
    expect(out.earlyClick).toBe('open')
    expect(out.enterAfterTyping).toBe('open')
    expect(out.enterLater).toBe(true)
    expect(out.closedAfterYes).toBe(true)
    expect(out.escape).toBe(false)
    // TC-3490: Tab only between the two buttons (Not now, Find work files), also with a list that scrolls
    expect(out.overflows).toBe(true)
    expect(out.tabs).toEqual(['consent-yes', 'consent-no', 'consent-yes', 'consent-no', 'consent-yes', 'consent-no'])
    expect(out.forgedView).toBe('null')
    expect(out.forgedYes).toBe('open')
    expect(out.windowStillOpen).toBe(true)
    expect(out.closed).toBe(false)
    expect(out.forgotten).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
