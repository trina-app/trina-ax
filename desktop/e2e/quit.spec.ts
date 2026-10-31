// Quitting (Cmd+Q, the Quit menu item): one quit ends the app, and the open team's cookies are on disk first (main.ts
// will-quit). The window closes before will-quit, so the team is the one it showed; the quit is asked again from a new
// task. On a packaged build the first Cmd+Q only closed the window (a quit asked inside the held-back will-quit was
// ignored); this harness quits on the first terminate: either way, so it guards the order and the kept sign-in.
import { once } from 'node:events'
import { expect, test } from '@playwright/test'
import { ACME, addTeam, close, launch, newUserData, signIn, teamPage } from './helpers'

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
