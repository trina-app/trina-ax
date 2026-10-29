import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { reset, signIn } from './helpers'

test('HWP native pages, navigation, mobile layout and original download', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/files?path=marketing')
  const fixture = path.resolve(import.meta.dirname, '../../../tests/fixtures/hwp/two-pages.hwp')
  await page.getByTestId('files-input').setInputFiles(fixture)
  await page.getByTestId('file-row').filter({hasText:'two-pages.hwp'}).getByRole('button').first().click()
  const view=page.getByTestId('hwp-view'), img=page.getByTestId('hwp-page')
  await expect(img).toBeVisible()
  await expect(view).toContainText('Page 1 of 2')
  await expect(img).toHaveJSProperty('naturalWidth',794)
  if(process.env.HWP_SHOTS) await page.screenshot({path:path.join(process.env.HWP_SHOTS,'web-page-1.png')})
  const first=await img.getAttribute('src')
  await page.getByTestId('hwp-next').click()
  await expect(view).toContainText('Page 2 of 2')
  await expect(img).not.toHaveAttribute('src',first!)
  await expect(page.getByTestId('hwp-next')).toBeDisabled()
  if(process.env.HWP_SHOTS) await page.screenshot({path:path.join(process.env.HWP_SHOTS,'web-page-2.png')})
  await page.getByTestId('hwp-previous').click()
  await expect(view).toContainText('Page 1 of 2')
  await page.setViewportSize({width:390,height:844})
  await expect(img).toBeVisible()
  if(process.env.HWP_SHOTS) await page.screenshot({path:path.join(process.env.HWP_SHOTS,'web-mobile.png')})
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByTestId('file-panel').getByRole('button',{name:'Download',exact:true}).click()])
  const sha=(b:Buffer)=>crypto.createHash('sha256').update(b).digest('hex')
  expect(sha(fs.readFileSync((await download.path())!))).toBe(sha(fs.readFileSync(fixture)))
})
