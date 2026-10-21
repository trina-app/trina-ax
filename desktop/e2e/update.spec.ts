// Desktop app updates on the Mac (docs/OFFICE.md "자동 업데이트", src/main/updater.ts): the app reads the team's
// /downloads/index.json with the team page's own session, announces a newer Mac app once per version ("새 버전이 있어요")
// and its button opens Settings > Apps; it does not replace itself. (Windows installs through electron-updater; its
// configuration is unit-tested in tests/unit/office-update.test.ts.)
import { expect, test } from '@playwright/test'
import { ACME, addTeam, close, launch, newUserData, teamPage } from './helpers'

const hits = () => fetch(`${ACME}/test/downloads-hits`).then((r) => r.json() as Promise<{ hits: string[] }>).then((j) => j.hits)

test('Mac: a newer Mac app in /downloads/index.json is announced once, with the team session; Download opens Settings > Apps', async () => {
  const userData = newUserData('ko')
  const before = (await hits()).length
  const env = { MYCEL_DESKTOP_UPDATE_TEST: 'notice', MYCEL_DESKTOP_UPDATE_FIRST_MS: '7000' }
  let app = await launch(userData, env)
  try {
    // record the prompt instead of showing it, and answer "Download"
    await app.evaluate(({ dialog }) => {
      ;(globalThis as any).__boxes = []
      dialog.showMessageBox = (async (...a: any[]) => { const o = a.length > 1 ? a[1] : a[0]; (globalThis as any).__boxes.push(o); return { response: 0, checkboxChecked: false } }) as any
    })
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    await page.evaluate(() => fetch('/test/login'))
    await expect.poll(() => app.evaluate(() => (globalThis as any).__boxes.length), { timeout: 20_000 }).toBe(1)
    const box = await app.evaluate(() => (globalThis as any).__boxes[0])
    expect(box.message).toContain('99.0.0')
    expect(box.title).toBe('새 버전이 있어요')
    expect(box.buttons).toEqual(['내려받기', '나중에'])
    expect((await hits()).slice(before)).toEqual(['session'])
    // Download: the team page goes to Settings > Apps (where the signed-in person downloads it)
    await expect.poll(async () => (await teamPage(app, ACME)).url()).toBe(`${ACME}/settings/apps`)
  } finally {
    await close(app)
  }
  // the same version is not announced again
  app = await launch(userData, { ...env, MYCEL_DESKTOP_UPDATE_FIRST_MS: '1500' })
  try {
    await app.evaluate(({ dialog }) => {
      ;(globalThis as any).__boxes = []
      dialog.showMessageBox = (async () => { (globalThis as any).__boxes.push(1); return { response: 1, checkboxChecked: false } }) as any
    })
    await expect.poll(async () => (await hits()).length, { timeout: 20_000 }).toBeGreaterThan(before + 1)
    await new Promise((r) => setTimeout(r, 500))
    expect(await app.evaluate(() => (globalThis as any).__boxes.length)).toBe(0)
  } finally {
    await close(app)
  }
})
