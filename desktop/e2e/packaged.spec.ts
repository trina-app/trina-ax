// The packaged macOS app (bun run dist:mac) starts, shows the welcome screen and reaches a team. Skipped when
// release/ has no build (the regular suite tests the unpackaged dist/).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { ACME, bindWindow, close, newUserData, ROOT, teamPage, welcome } from './helpers'

const exe = join(ROOT, 'release/mac-arm64/Team AX.app/Contents/MacOS/Team AX')

test('packaged app starts and reaches a team', async () => {
  test.skip(process.platform !== 'darwin' || !existsSync(exe), 'no packaged build in release/')
  const app = await electron.launch({ executablePath: exe, env: { ...(process.env as Record<string, string>), MYCEL_DESKTOP_USER_DATA: newUserData() } })
  try {
    expect(await app.evaluate(({ app }) => [app.getName(), app.isPackaged])).toEqual(['Team AX', true])
    const w = await welcome(app)
    await w.getByRole('textbox', { name: /팀 주소|Team address|Alamat tim/ }).fill('acme.localhost:19151')
    await w.getByRole('button', { name: /연결|Connect|Hubungkan/ }).click()
    const page = await bindWindow(await teamPage(app, ACME), ACME)
    await expect(page.locator('#bridge')).toHaveText('desktop')
  } finally {
    await close(app)
  }
})
