// The folder window on the team page (docs/DECISIONS.md "W6"): a picked folder is readable, never writable; a dropped
// folder that was not picked, another origin and a write get nothing; Chromium's refused roots (home, Desktop,
// Documents, Downloads) are allowed, everything else it blocks stays refused, and neither leaves the page waiting.
// Real Electron, hidden window (fixtures/folder-main.ts).
import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

test('a folder picked in the window is readable by the team page, read only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'folder-native-'))
  try {
    const output = join(dir, 'main.cjs')
    await exec('bun', ['build', join(import.meta.dirname, 'fixtures/folder-main.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${output}`])
    const electron = createRequire(import.meta.url)('electron') as string
    const { stdout } = await exec(electron, [output], { env: { ...process.env, FOLDER_TEST_PROFILE: join(dir, 'profile') }, timeout: 60_000 })
    const { out, fromChromium, restricted } = JSON.parse(stdout.split('\n').find((line) => line.startsWith('FOLDER_RESULT '))!.slice(14))
    const none = { state: 'handle', kind: 'directory', read: 'denied', write: 'denied', listError: 'NotAllowedError' }
    // a handle that did not come from the folder window reads nothing
    expect(out.droppedNotPicked).toEqual(none)
    // nor can the page widen it: its own requestPermission() is answered by the check (the request handler cannot tell
    // it from a pick, so this must stay so; common/folder-access.ts)
    expect([out.askReadNotPicked, out.askWriteNotPicked]).toEqual(['denied', 'denied'])
    // the request after a pick: read, the top frame, the team origin
    expect([out.pickWritable, out.pickSubframe, out.pickOtherOrigin, out.pick]).toEqual([false, false, false, true])
    expect(out.afterPick).toEqual({ state: 'handle', kind: 'directory', read: 'granted', write: 'denied', names: ['a.txt', 'sub'] })
    expect(out.readFile).toBe('A')
    expect(out.createFile).toBe('NotAllowedError')
    expect(out.askWrite).toBe('denied')
    expect(out.inside).toEqual({ state: 'handle', kind: 'directory', read: 'granted', write: 'denied', names: ['c.txt'] })
    // Chromium's refused roots: the block is lifted (a drop is still no pick); other blocked folders stay refused
    expect(out.home).toEqual({ state: 'handle', kind: 'directory', read: 'denied', write: 'denied' })
    expect(out.appData).toEqual({ state: 'error', error: 'AbortError' })
    // another origin in the same session
    expect(out.otherOrigin).toEqual(none)
    expect(out.otherOriginHome).toEqual({ state: 'error', error: 'AbortError' })
    // Chromium asked the request handler nothing in this run: no pick happened, every page request went to the check
    expect(fromChromium).toEqual([])
    expect(restricted).toEqual([{ path: 'home', action: 'allow' }, { path: 'appData', action: 'deny' }, { path: 'home', action: 'deny' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
