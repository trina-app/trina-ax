// Screenshots of Admin › Folder permissions › the edit panel (stage 5), light and dark, 1360 and 375 wide, for reviewing
// the screen by eye: only when EDIT_SHOTS names a folder to write them to. The basic access, people rows, a loss
// warning, another admin's change (409).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const dir = process.env.EDIT_SHOTS
const call = async (page: Page, method: 'post' | 'patch' | 'put', url: string, data: unknown) => {
  const r = await page.request[method](url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.ok(), url).toBeTruthy()
  return r.json()
}
const everyone = (access: 'none' | 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })

test.skip(!dir, 'EDIT_SHOTS is not set')

test('edit panel screenshots', async ({ page }) => {
  test.setTimeout(240_000)
  // leaving a page with changes not saved asks (beforeunload): go on
  page.on('dialog', (d) => void d.accept())
  await reset(page)
  await signIn(page)
  const sales = await call(page, 'post', '/api/admin/groups', { name: '영업팀', memberIds: [] })
  for (const [id, name] of [['carol', 'Carol'], ['dan', 'Dan'], ['erin', 'Erin']] as const) await call(page, 'post', '/api/admin/users', { username: id, name, role: 'member', groupIds: id === 'carol' ? [sales.id] : [], temporaryPassword: 'tiger4271x' })
  await call(page, 'patch', '/api/admin/users/erin', { status: 'disabled' })
  await call(page, 'post', '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read'), { subjectType: 'role', subjectId: 'admin', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'partners/apollo', create: true, rules: [{ subjectType: 'user', subjectId: 'dan', access: 'write' }, { subjectType: 'group', subjectId: sales.id, access: 'read' }, { subjectType: 'user', subjectId: 'erin', access: 'read' }, everyone('none')] })
  await call(page, 'post', '/api/admin/folders', { path: 'partners/apollo/drafts', create: true, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'partners/zeus', create: true, rules: [{ subjectType: 'user', subjectId: 'dan', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'partners/zeus/archive', create: true, rules: [{ subjectType: 'group', subjectId: sales.id, access: 'write' }] })
  await call(page, 'post', '/api/projects', { name: 'Apollo', folderPath: 'partners/apollo' })
  const panel = page.getByTestId('edit-panel')
  /** the answer for what is on the screen has come, and the Save button has finished fading in */
  const settled = async () => {
    await expect(panel.getByTestId('edit-result')).toHaveAttribute('data-ready', 'true')
    await page.waitForTimeout(250)
  }
  for (const theme of ['light', 'dark'] as const) {
    for (const size of [{ width: 1360, height: 1100 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(size)
      await page.emulateMedia({ colorScheme: theme })
      const at = `${size.width}-${theme}`
      // the basic access and the people named (a disabled person among them)
      await page.goto(`/admin/folders?folder=${encodeURIComponent('partners/apollo')}`)
      await page.getByTestId('folder-detail-edit').click()
      await settled()
      await page.screenshot({ path: `${dir}/edit-${at}-apollo.png`, fullPage: size.width > 400 })
      // add a person, open the list
      await panel.getByTestId('edit-add').fill('o')
      await page.screenshot({ path: `${dir}/edit-${at}-add.png` })
      await page.keyboard.press('Escape')
      // a loss with a warning: shared to "only the people named"
      await page.goto('/admin/folders?folder=shared')
      await page.getByTestId('folder-detail-edit').click()
      await panel.getByTestId('edit-basic-named').click()
      await expect(panel.getByTestId('edit-warning')).toBeVisible()
      await settled()
      await page.screenshot({ path: `${dir}/edit-${at}-shared-loss.png`, fullPage: size.width > 400 })
      if (size.width < 400) {
        await panel.getByTestId('edit-result').scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${dir}/edit-${at}-shared-loss-result.png` })
      }
      // skills: the old role rows, said in one line
      await page.goto('/admin/folders?folder=skills')
      await page.getByTestId('folder-detail-edit').click()
      await expect(panel.getByTestId('edit-converted')).toBeVisible()
      await settled()
      await page.screenshot({ path: `${dir}/edit-${at}-skills.png` })
      // partners for everyone: the rule folders below that change with it (zeus and zeus/archive for those they do not name)
      await page.goto('/admin/folders?folder=partners')
      await page.getByTestId('folder-detail-edit').click()
      await panel.getByTestId('edit-basic-read').click()
      await panel.getByTestId('edit-show-people').click()
      await expect(panel.getByTestId('edit-below')).toBeVisible()
      await settled()
      await panel.getByTestId('edit-result').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${dir}/edit-${at}-below.png` })
      // another admin changes shared while the panel is open, then Save
      await page.goto('/admin/folders?folder=shared')
      await page.getByTestId('folder-detail-edit').click()
      await panel.getByTestId('edit-basic-read').click()
      await expect(panel.getByTestId('edit-result')).toHaveAttribute('data-ready', 'true')
      const shared = ((await (await page.request.get('/api/admin/folders')).json()).items as { id: string; path: string }[]).find((f) => f.path === 'shared')!
      await call(page, 'put', `/api/admin/folders/${shared.id}/rules`, { rules: [everyone('write'), { subjectType: 'user', subjectId: 'dan', access: 'none' }] })
      await panel.getByTestId('edit-save').click()
      await expect(panel.getByTestId('edit-stale')).toBeVisible()
      await settled()
      await page.screenshot({ path: `${dir}/edit-${at}-stale.png`, fullPage: size.width > 400 })
      await call(page, 'put', `/api/admin/folders/${shared.id}/rules`, { rules: [everyone('write')] })
    }
  }
})
