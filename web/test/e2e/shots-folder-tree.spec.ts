// Screenshots of Admin › Folder permissions › By folder (the tree), light and dark, 1360 and 375 wide, for reviewing the
// screen by eye: only when TREE_SHOTS names a folder to write them to.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const dir = process.env.TREE_SHOTS
const call = async (page: Page, method: 'post' | 'patch', url: string, data: unknown) => {
  const r = await page.request[method](url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.ok(), url).toBeTruthy()
  return r.json()
}
const everyone = (access: 'none' | 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })

test.skip(!dir, 'TREE_SHOTS is not set')

test('folder tree screenshots', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const sales = await call(page, 'post', '/api/admin/groups', { name: '영업팀', memberIds: [] })
  for (const [id, name] of [['carol', 'Carol'], ['dan', 'Dan'], ['erin', 'Erin']] as const) await call(page, 'post', '/api/admin/users', { username: id, name, role: 'member', groupIds: id === 'carol' ? [sales.id] : [], temporaryPassword: 'tiger4271x' })
  await call(page, 'post', '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read'), { subjectType: 'role', subjectId: 'admin', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'skills/영업', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'partners/apollo', create: true, rules: [{ subjectType: 'user', subjectId: 'dan', access: 'write' }, { subjectType: 'group', subjectId: sales.id, access: 'read' }, everyone('none')] })
  await call(page, 'post', '/api/admin/folders', { path: 'partners/apollo/계약서 초안 2026년 하반기 최종본 검토용', create: true, rules: [{ subjectType: 'user', subjectId: 'erin', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'connected/nas', create: true, rules: [{ subjectType: 'group', subjectId: sales.id, access: 'read' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'old-archive', create: true, rules: [everyone('read')] })
  await page.request.post('/__test/rmdir', { data: { path: 'old-archive' } })
  await call(page, 'post', '/api/projects', { name: 'Apollo', folderPath: 'partners/apollo' })
  for (const theme of ['light', 'dark'] as const) {
    for (const size of [{ width: 1360, height: 1500 }, { width: 375, height: 1700 }]) {
      await page.setViewportSize(size)
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/admin/folders')
      await expect(page.getByTestId('folder-tree').locator('[data-path="partners/apollo"]')).toBeVisible()
      await page.getByTestId('folder-outside-toggle').click()
      // the keyboard's place in the tree: the focus ring
      await page.getByTestId('folder-tree').locator('[data-path="groups/영업팀"]').focus()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowUp')
      await page.screenshot({ path: `${dir}/tree-${size.width}-${theme}.png` })
      await page.getByTestId('folder-tree').locator('[data-path="partners/apollo"]').click()
      await expect(page.getByTestId('folder-people')).toBeVisible()
      await page.screenshot({ path: `${dir}/tree-${size.width}-${theme}-apollo.png` })
      await page.goto('/admin/folders?folder=shared')
      await expect(page.getByTestId('folder-detail')).toBeVisible()
      await page.screenshot({ path: `${dir}/tree-${size.width}-${theme}-shared.png` })
    }
  }
})
