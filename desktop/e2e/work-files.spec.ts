// "Find work files on this computer" (docs/DECISIONS.md "Find work files on this computer"): the app asks in its own
// dialog first; it looks through Documents and Downloads but never the home folder (Desktop is moved there in the
// fixture); links are neither listed nor followed; the page gets no path; a read takes only an id of the latest look of
// that origin, and a folder or file swapped for a link after the look is refused. Real Electron, hidden window
// (fixtures/work-files-main.ts), in a made-up home folder inside a temporary folder: HOME and every app.getPath point
// there, nothing of this computer's home is touched. Run on a Mac by hand: `bunx playwright test -c e2e/rtc-native.config.ts`.
import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

/** A made-up home: Documents with work files, a link to home and one to the made-up secret; a big Downloads (over 5,000
 * documents: cut); app data; the secret. */
function fakeHome(dir: string): string {
  const home = join(dir, 'home')
  mkdirSync(join(home, 'Documents', 'company'), { recursive: true })
  writeFileSync(join(home, 'Documents', 'Quote template.xlsx'), 'QUOTE')
  writeFileSync(join(home, 'Documents', 'notes.txt'), 'NOTES')
  writeFileSync(join(home, 'Documents', 'company', 'proposal.pdf'), 'PROPOSAL')
  writeFileSync(join(home, 'Documents', '.hidden.pdf'), 'H')
  mkdirSync(join(home, 'Documents', 'node_modules'))
  writeFileSync(join(home, 'Documents', 'node_modules', 'readme.md'), 'R')
  mkdirSync(join(home, 'Downloads'))
  for (let i = 0; i < 5100; i++) writeFileSync(join(home, 'Downloads', `report-${i}.txt`), '')
  mkdirSync(join(home, 'Library', 'Application Support'), { recursive: true })
  mkdirSync(join(home, '.aws'))
  writeFileSync(join(home, '.aws', 'credentials'), 'FAKE-SECRET-FOR-THIS-TEST')
  mkdirSync(join(home, 'decoy'))
  symlinkSync(home, join(home, 'Documents', 'to-home'))
  symlinkSync(join(home, '.aws', 'credentials'), join(home, 'Documents', 'secret-link.pdf'))
  return home
}

test('the app asks first, looks without following links, and reads only ids of its latest look', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-files-native-'))
  try {
    const home = fakeHome(dir)
    const output = join(dir, 'main.cjs')
    await exec('bun', ['build', join(import.meta.dirname, 'fixtures/work-files-main.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${output}`])
    const electron = createRequire(import.meta.url)('electron') as string
    const env = { ...process.env, HOME: home, FOLDER_TEST_HOME: home, FOLDER_TEST_PROFILE: join(dir, 'profile') }
    const { stdout } = await exec(electron, [output], { env, timeout: 90_000 })
    const { out, asked } = JSON.parse(stdout.split('\n').find((line) => line.startsWith('WORK_RESULT '))!.slice(12))
    // no: nothing looked at; asked again at once, the app does not raise its dialog again
    expect(out.cancelled).toEqual({ state: 'cancelled' })
    expect(out.again).toEqual({ state: 'busy' })
    expect(asked).toHaveLength(2)
    expect(asked[0].message).toBe('Find work files on this computer?')
    expect(asked[0].detail).toContain("the file names may go to your team's AI")
    expect(asked[0].detail).toContain('Nothing here is moved or changed.')
    expect(asked[0].buttons).toEqual(['Look through these folders', 'Cancel'])
    // Documents, the home folder as Desktop (never looked at), a big Downloads (cut at 5,000 documents)
    expect(out.roots).toEqual([{ id: 'documents', state: 'ok', cut: false }, { id: 'desktop', state: 'home', cut: false }, { id: 'downloads', state: 'ok', cut: true }])
    expect(out.names).toEqual(['Quote template.xlsx', 'company/proposal.pdf', 'notes.txt'])
    expect(out.downloadsListed).toBe(5000)
    expect(out.leaksPath).toBe(false)
    expect(out.progress).toBe(true)
    // reads: an id of the look; never a made-up id, a path, or another origin
    expect(out.read).toBe('QUOTE')
    expect([out.foreignId, out.pathAsId, out.otherOrigin]).toEqual(['unknown', 'unknown', 'unknown'])
    // swapped for links after the look: refused, the made-up secret stays unread
    expect(out.swappedFolder).toBe('changed')
    expect(out.swappedFile).toBe('changed')
    expect(out.afterPerson).toBe('unknown')
    expect(JSON.stringify(out)).not.toContain('FAKE-SECRET')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
