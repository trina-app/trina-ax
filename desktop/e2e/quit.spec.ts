// Quitting (Cmd+Q, the Quit menu item): one quit ends the app, and the open team's cookies are on disk first (main.ts
// will-quit). The window closes before will-quit, so the team is the one it showed; the quit is asked again from a new
// task. On a packaged build the first Cmd+Q only closed the window (a quit asked inside the held-back will-quit was
// ignored); this harness quits on the first terminate: either way, so it guards the order and the kept sign-in.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import electronPath from 'electron'
import { ACME, addTeam, close, launch, newUserData, ROOT, signIn, teamPage } from './helpers'

test('one quit ends the app, and the sign-in is written to disk first', async () => {
  const userData = newUserData()
  let app = await launch(userData)
  try {
    const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    expect(await page.evaluate(() => fetch('/api/me').then((r) => r.status))).toBe(200)
    const proc = app.process()
    const exited = once(proc, 'exit')
    // Cmd+Q on macOS sends terminate: to the app (a plain app.quit() from a test takes another path that hid the bug)
    await app.evaluate(({ app: electronApp, Menu }) => (process.platform === 'darwin' ? Menu.sendActionToFirstResponder('terminate:') : electronApp.quit())).catch(() => {})
    const quit = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8_000))])
    expect(quit, 'the app was still running 8 s after one quit').toBe(true)

    // the next start opens the team signed in: the session cookie was flushed before the app ended
    app = await launch(userData)
    const again = await teamPage(app, ACME)
    await expect.poll(() => again.evaluate(() => fetch('/api/me').then((r) => r.status)).catch(() => 0)).toBe(200)
  } finally {
    await close(app)
  }
})

// audit row 38: a second start (on Windows and Linux every trina-ax:// link) hands its command line to the running app
// and exits at once (app.exit), setting nothing up. (The audit's concern was app.quit(), which will-quit holds back to
// write cookies; on macOS the old code also ended before ready, so this guards the outcome on every platform it runs.)
test('a second start exits at once and leaves the running app and its files alone', async () => {
  const userData = newUserData()
  const app = await launch(userData)
  try {
    await addTeam(app, 'acme.localhost:19151', ACME)
    const teams = join(userData, 'teams.json')
    await expect.poll(() => existsSync(teams)).toBe(true)
    const before = { text: readFileSync(teams, 'utf8'), mtime: statSync(teams).mtimeMs }
    const second = spawn(electronPath as unknown as string, [join(ROOT, 'dist/main.cjs')], {
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), MYCEL_DESKTOP_USER_DATA: userData, MYCEL_DESKTOP_DEBUG: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    second.stdout.on('data', (d) => { out += d })
    const code = await Promise.race([once(second, 'exit').then(([c]) => c as number | null), new Promise<'running'>((r) => setTimeout(() => r('running'), 8_000))])
    if (code === 'running') second.kill()
    expect(code, 'the second app was still running 8 s after it started').toBe(0)
    // app.exit: no will-quit (no cookie flush of its own), no window, no ready
    expect(out).not.toContain('will-quit')
    expect(readFileSync(teams, 'utf8')).toBe(before.text)
    expect(statSync(teams).mtimeMs).toBe(before.mtime)
    // the first app still runs
    expect(await app.evaluate(() => 1)).toBe(1)
  } finally {
    await close(app)
  }
})
