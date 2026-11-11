// Screenshots of "Project contents only for members" (docs/DECISIONS.md), light, 1440 and 390 wide, for reviewing by
// eye: the page of a team project the owner is not in, its "Add me" confirm, and Admin › Folder permissions with the
// project's folder as "Members only". Only when MEMBERS_ONLY_SHOTS names a folder to write them to.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const dir = process.env.MEMBERS_ONLY_SHOTS
test.skip(!dir, 'MEMBERS_ONLY_SHOTS is not set')

async function setUp(page: Page) {
  await reset(page)
  await signIn(page)
  const g = await page.request.post('/api/admin/groups', { headers: { [CSRF_HEADER]: '1' }, data: { name: '법무팀', memberIds: [] } })
  const legal = ((await g.json()) as { id: string }).id
  await page.request.patch('/api/admin/users/bob', { headers: { [CSRF_HEADER]: '1' }, data: { groupIds: [legal] } })
  // Bob's project with his group; the owner has an old chat there from before
  const made = await page.request.post('/__test/project', { data: { name: '계약서 검토', by: 'bob', participants: [{ subjectType: 'group', subjectId: legal }], instructions: '# 계약서\n\n검토 의견은 짧게.', files: { '표준계약서.docx': 'x', '검토 메모.md': '# 메모' }, chats: [['olga', '지난달 계약서 요약']] } })
  return ((await made.json()) as { id: string }).id
}

for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  test(`members only screenshots (${vp.name}, light)`, async ({ page }) => {
    await page.setViewportSize(vp.size)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    const id = await setUp(page)
    // (a) the page of a project the owner is not in
    await page.goto(`/projects/${id}`)
    await expect(page.getByTestId('project-members-only')).toBeVisible()
    await expect(page.getByTestId('project-chats').getByRole('link')).toHaveCount(1)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/a-not-a-member-page-${vp.name}-light.png`, fullPage: true })
    // (b) the "Add me" confirm
    await page.getByTestId('project-add-me').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/b-add-me-confirm-${vp.name}-light.png` })
    await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
    // (c) Admin › Folder permissions: the project's folder chosen ("멤버만", "멤버 관리"); the tree row on a computer
    await page.goto(`/admin/folders?folder=${encodeURIComponent('projects/계약서 검토')}`)
    await expect(page.getByTestId('folder-detail-members-only')).toBeVisible()
    if (vp.name === '1440') await expect(page.getByTestId('folder-tree').locator('[data-path="projects/계약서 검토"]')).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/c-admin-members-only-${vp.name}-light.png`, fullPage: vp.name === '1440' })
  })
}
