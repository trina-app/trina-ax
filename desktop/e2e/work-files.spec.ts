// "Find work files on this computer" (docs/DECISIONS.md "Find work files on this computer"): the app asks in its own
// dialog first; it looks through Documents and Downloads but never the home folder (Desktop is moved there in the
// fixture); links are neither listed nor followed; the page gets no path; a read takes only an id of the latest look of
// that origin, and a folder or file swapped for a link after the look is refused. Real Electron, hidden window
// (fixtures/work-files-main.ts), in a made-up home folder inside a temporary folder: HOME and every app.getPath point
// there, nothing of this computer's home is touched. Run on a Mac by hand: `bunx playwright test -c e2e/rtc-native.config.ts`.
import { expect, test } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

const QUOTE = 'QUOTE'.padEnd(4096, '.')

/** Run the fixture until it prints its WORK_RESULT line (then stop it), or fail after `ms`. */
function resultOf(cmd: string, args: string[], env: NodeJS.ProcessEnv, ms: number): Promise<string> {
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { env })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); fail(new Error(`no WORK_RESULT within ${ms} ms\n${err.slice(-2000)}`)) }, ms)
    p.stdout.on('data', (b) => {
      out += String(b)
      const line = out.split('\n').find((l) => l.startsWith('WORK_RESULT '))
      if (line && out.slice(out.indexOf(line)).includes('\n')) { clearTimeout(timer); p.kill('SIGKILL'); done(out) }
    })
    p.stderr.on('data', (b) => { err += String(b) })
    p.on('exit', (code) => { clearTimeout(timer); if (!out.includes('WORK_RESULT ')) fail(new Error(`fixture exited ${code} without WORK_RESULT\n${err.slice(-2000)}`)) })
  })
}

/** A made-up home: Documents with work files, a link to home and one to the made-up secret; a big Downloads (over 5,000
 * documents: cut); app data; the secret. */
function fakeHome(dir: string): string {
  const home = join(dir, 'home')
  mkdirSync(join(home, 'Documents', 'company'), { recursive: true })
  // real sizes: the look skips documents under 1 KB and text files under 2 KB (no work document is that small)
  writeFileSync(join(home, 'Documents', 'Quote template.xlsx'), QUOTE)
  writeFileSync(join(home, 'Documents', 'notes.txt'), 'NOTES'.padEnd(4096, '.'))
  writeFileSync(join(home, 'Documents', 'company', 'proposal.pdf'), 'PROPOSAL'.padEnd(8192, '.'))
  writeFileSync(join(home, 'Documents', '.hidden.pdf'), 'H')
  mkdirSync(join(home, 'Documents', 'node_modules'))
  writeFileSync(join(home, 'Documents', 'node_modules', 'readme.md'), 'R')
  mkdirSync(join(home, 'Downloads'))
  const report = 'R'.repeat(3000)
  for (let i = 0; i < 5100; i++) writeFileSync(join(home, 'Downloads', `report-${i}.txt`), report)
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
    // the result line is enough: the app is stopped once it is printed (on a busy Mac, Electron's own exit can take
    // minutes, which said nothing about the look)
    const stdout = await resultOf(electron, [output], env, 90_000)
    const { out, asked } = JSON.parse(stdout.split('\n').find((line) => line.startsWith('WORK_RESULT '))!.slice(12))
    // no: nothing looked at; asked again at once, the app does not raise its dialog again
    expect(out.cancelled).toEqual({ state: 'cancelled' })
    expect(out.again).toEqual({ state: 'busy' })
    // the look's window twice (no, then yes); the Add window twice more below (VoiceOver: No, then Add)
    expect(asked.filter((a: { kind?: string }) => a.kind !== 'add')).toHaveLength(2)
    expect(asked.filter((a: { kind?: string }) => a.kind === 'add')).toHaveLength(2)
    expect(asked[0].title).toMatch(/^Bring your work files into /)
    expect(asked[0].places.map((p: { name: string }) => p.name)).toEqual(['Documents', 'Desktop', 'Downloads'])
    expect(asked[0].promises.map((p: { text: string }) => p.text)).toContain("To help you pick, file names may go to your team's AI")
    expect(asked[0].fine).toContain('Nothing here is moved or changed.')
    expect([asked[0].yes, asked[0].no]).toEqual(['Find work files', 'Not now'])
    // Documents, the home folder as Desktop (never looked at), a big Downloads (cut at 5,000 documents)
    expect(out.roots).toEqual([{ id: 'documents', state: 'ok', cut: false }, { id: 'desktop', state: 'home', cut: false }, { id: 'downloads', state: 'ok', cut: true }])
    expect(out.names).toEqual(['Quote template.xlsx', 'company/proposal.pdf', 'notes.txt'])
    expect(out.downloadsListed).toBe(5000)
    expect(out.leaksPath).toBe(false)
    expect(out.progress).toBe(true)
    // reads: an id of the look; never a made-up id, a path, or another origin
    // TC-3300: nothing read before the add; an add without the person's press, or from another origin, is refused;
    // after the add only what was added is read; the strip counted the reads down to 0
    expect([out.beforeAdd, out.addNoPress, out.added, out.addOtherOrigin]).toEqual(['unknown', 'refused', 'added', 'refused'])
    expect(out.notAdded).toBe('unknown')
    // VoiceOver / Voice Control on (forced): the app's own window instead of a refusal; No adds nothing, Add adds them
    expect([out.a11yOff, out.a11yOn, out.a11yNo, out.a11yNoRead, out.a11yAtOnce, out.a11yYes, out.a11yYesRead]).toEqual(['refused', true, 'cancelled', 'unknown', 'refused', 'added', true])
    expect(out.a11yWindow).toEqual({ kind: 'add', places: [expect.stringMatching(/^report-\d+\.txt$/)], yes: 'Add 1 file' })
    // a new look clears the strip first (0); the add then shows the three files waiting
    expect(out.reading.find((n: number) => n > 0)).toBe(3)
    expect(out.reading.at(-1)).toBe(0)
    // asked once: remembered for this team and person, the next look goes without the window
    expect(out.remembered).toEqual(['http://127.0.0.1:9 u-alex'])
    expect([out.secondLook, out.askedAgain]).toEqual(['done', 0])
    expect(out.read).toBe(QUOTE)
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
