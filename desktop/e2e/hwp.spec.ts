import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { offlineServer, signInOfflineTeam } from '../../web/test/e2e/offline-server'
import { close, launch, newUserData, teamPage, welcome } from './helpers'

// Real Electron and built web assets; the mock team invokes the pinned native renderer.
test('HWP pages render in Electron and the original downloads unchanged', async () => {
  const server = await offlineServer()
  const app = await launch(newUserData('en')).catch(async e => { await server.close(); throw e })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-desktop-'))
  try {
    const shell = await welcome(app)
    await shell.locator('#address').fill(server.url)
    await shell.getByRole('button', { name: 'Connect', exact: true }).click()
    const page = await teamPage(app, server.url)
    await signInOfflineTeam(page, server.url, 'en')
    await page.goto(`${server.url}/files?path=marketing`)
    const fixture = path.resolve(import.meta.dirname, '../../tests/fixtures/hwp/two-pages.hwp')
    await page.getByTestId('files-input').setInputFiles(fixture)
    await page.getByTestId('file-row').filter({ hasText: 'two-pages.hwp' }).getByRole('button').first().click()
    const view = page.getByTestId('hwp-view'), img = page.getByTestId('hwp-page')
    await expect(img).toHaveJSProperty('naturalWidth', 794)
    await expect(view).toContainText('Page 1 of 2')
    await page.getByTestId('hwp-next').click()
    await expect(view).toContainText('Page 2 of 2')
    await expect(img).toHaveJSProperty('naturalWidth', 794)
    await page.getByTestId('hwp-previous').click()
    await expect(view).toContainText('Page 1 of 2')
    const output = path.join(dir, 'original.hwp')
    await app.evaluate(({ webContents }, { url, output }) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith(url))!
      wc.session.once('will-download', (_event, item) => { item.setSavePath(output) })
    }, { url: server.url, output })
    await page.getByTestId('file-panel').getByRole('button', { name: 'Download', exact: true }).click()
    const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
    await expect.poll(() => fs.existsSync(output) ? hash(fs.readFileSync(output)) : null).toBe(hash(fs.readFileSync(fixture)))
  } finally { await close(app); await server.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
