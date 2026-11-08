// The folder window on the team page (docs/DECISIONS.md "W6"): a picked folder is readable, never writable; a dropped
// folder that was not picked, another origin and a write get nothing; Chromium's refused roots Desktop, Documents and
// Downloads are allowed unless one is home or holds it, the home folder and everything else Chromium blocks stay
// refused, and none leaves the page waiting. Real Electron, hidden window (fixtures/folder-main.ts), in a made-up home
// folder inside a temporary folder: HOME and every app.getPath point there, nothing of this computer's home is touched.
// Run on every Electron upgrade: it pins Electron behaviour the rules rely on (a page's own requestPermission() is
// answered by the check and never reaches the request handler).
import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

/** A made-up home: Documents with a company folder (holding a link to home and one to the secret) and a folder that is
 * a link to home, Downloads, app data and a made-up secret. The fixture also moves Desktop to the home folder itself. */
function fakeHome(dir: string): string {
  const home = join(dir, 'home')
  mkdirSync(join(home, 'Documents', 'company', 'sub'), { recursive: true })
  writeFileSync(join(home, 'Documents', 'company', 'a.txt'), 'A')
  writeFileSync(join(home, 'Documents', 'company', 'sub', 'c.txt'), 'C')
  mkdirSync(join(home, 'Downloads'))
  mkdirSync(join(home, 'Library', 'Application Support'), { recursive: true })
  mkdirSync(join(home, '.aws'))
  writeFileSync(join(home, '.aws', 'credentials'), 'FAKE-SECRET-FOR-THIS-TEST')
  symlinkSync(home, join(home, 'Documents', 'home-link'))
  // links inside the folder the test picks: to home and to the made-up secret
  symlinkSync(home, join(home, 'Documents', 'company', 'to-home'))
  symlinkSync(join(home, '.aws', 'credentials'), join(home, 'Documents', 'company', 'secret-link'))
  return home
}

test('a folder picked in the window is readable by the team page, read only; never the home folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'folder-native-'))
  try {
    const home = fakeHome(dir)
    const output = join(dir, 'main.cjs')
    await exec('bun', ['build', join(import.meta.dirname, 'fixtures/folder-main.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${output}`])
    const electron = createRequire(import.meta.url)('electron') as string
    const env = { ...process.env, HOME: home, FOLDER_TEST_HOME: home, FOLDER_TEST_PROFILE: join(dir, 'profile') }
    const { stdout } = await exec(electron, [output], { env, timeout: 60_000 })
    const { out, fromChromium, restricted } = JSON.parse(stdout.split('\n').find((line) => line.startsWith('FOLDER_RESULT '))!.slice(14))
    const none = { state: 'handle', kind: 'directory', read: 'denied', write: 'denied', listError: 'NotAllowedError' }
    const refused = { state: 'error', error: 'AbortError' }
    // a handle that did not come from the folder window reads nothing
    expect(out.droppedNotPicked).toEqual(none)
    // nor can the page widen it: its own requestPermission() is answered by the check (the request handler cannot tell
    // it from a pick, so this must stay so; common/folder-access.ts)
    expect([out.askReadNotPicked, out.askWriteNotPicked]).toEqual(['denied', 'denied'])
    // the request after a pick: read, the top frame, the team origin
    expect([out.pickWritable, out.pickSubframe, out.pickOtherOrigin, out.pick]).toEqual([false, false, false, true])
    expect(out.afterPick).toEqual({ state: 'handle', kind: 'directory', read: 'granted', write: 'denied', names: ['a.txt', 'sub'] })
    expect(out.readFile).toBe('A')
    // links inside a picked folder are not listed (above) and not followed, on macOS; an upgrade that starts following
    // them fails here (Windows junctions are not measured)
    expect([out.linkToHome, out.linkToSecret]).toEqual(['NotFoundError', 'NotFoundError'])
    // after a sign-out: the File the page already had stays readable, nothing new can be read until a new pick
    expect(out.keep).toBe(1)
    expect(out.forgotKept).toBe('A')
    expect([out.forgotNew, out.forgotList, out.forgotQuery]).toEqual(['NotAllowedError', 'NotAllowedError', 'denied'])
    expect([out.pickAgain, out.readAgain]).toEqual([true, 'A'])
    expect(out.createFile).toBe('NotAllowedError')
    expect(out.askWrite).toBe('denied')
    expect(out.inside).toEqual({ state: 'handle', kind: 'directory', read: 'granted', write: 'denied', names: ['c.txt'] })
    // the home folder (also Desktop here: one of the allowed roots) and a link to it: no pick, no handle, the made-up
    // secret stays unread
    expect([out.pickHome, out.pickLinkToHome]).toEqual([false, false])
    expect(out.home).toEqual(refused)
    expect(out.homeSecret).toBe('no handle')
    // Downloads' block is lifted (a drop is still no pick); app data stays refused, with an answer
    expect(out.downloads).toEqual({ state: 'handle', kind: 'directory', read: 'denied', write: 'denied' })
    expect(out.appData).toEqual(refused)
    // another origin in the same session
    expect(out.otherOrigin).toEqual(none)
    expect(out.otherOriginDownloads).toEqual(refused)
    // Chromium asked the request handler nothing in this run: no pick happened, every page request went to the check
    expect(fromChromium).toEqual([])
    expect(restricted).toEqual([{ path: 'downloads', action: 'allow' }, { path: 'home', action: 'deny' }, { path: 'appData', action: 'deny' }, { path: 'downloads', action: 'deny' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
