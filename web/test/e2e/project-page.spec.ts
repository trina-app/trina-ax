// A project's page, like Claude's: the name with its few actions in a menu, a box that starts a chat in the project,
// the person's chats in it, and Instructions / Files as short lines that open in place. No dev environment line, also
// on a server that has it (the team setting is in Team settings, admin-dev-env.spec.ts). The owner or an admin on a
// team project they are not in (docs/DECISIONS.md "Project contents only for members"): one quiet block with Add me, its
// members, their own chats; after Add me the page is a member's, and taking themselves out closes it again.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const INSTRUCTIONS = '# Launch\n\nAnswer in **short** bullet points.\n\n- One idea per line'

async function newProject(page: Page, chats: string[] = []) {
  const post = (path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
  const r = await post('/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: INSTRUCTIONS })
  expect(r.status()).toBe(201)
  const id = ((await r.json()) as { id: string }).id
  for (const title of chats) expect((await post('/api/chats', { projectId: id, title })).ok()).toBeTruthy()
  return id
}

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('the box on a project page starts a chat in the project, which is then listed there', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const id = await newProject(page)
  await page.goto(`/projects/${id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Launch' })).toBeVisible()
  // the instructions as one quiet line under the name, without their markdown
  await expect(page.getByTestId('project-summary')).toHaveText('Answer in short bullet points.')
  await expect(page.getByTestId('project-chats')).toContainText('아직 이 프로젝트의 기록이 없어요.')
  // the draft is the project's: the same one as "/?project=<id>"
  await page.getByTestId('composer-input').fill('half a question')
  await page.goto(`/?project=${id}`)
  await expect(page.getByText('이 프로젝트의 폴더와 지침으로 대화해요')).toBeVisible()
  await expect(page.getByTestId('composer-input')).toHaveValue('half a question')
  await page.goto(`/projects/${id}`)
  await page.getByTestId('composer-input').fill('project question')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
  const chats = (await (await page.request.get(`/api/chats?projectId=${id}`)).json()) as { items: { id: string }[] }
  expect(chats.items).toHaveLength(1)
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-chats').getByRole('link')).toHaveCount(1)
  await expect(page.getByTestId('composer-input')).toHaveValue('')
})

test('instructions and files open in place; edit and delete are in the menu on the name', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const id = await newProject(page, ['Weekly numbers', 'Launch plan review'])
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-chats').getByRole('link')).toHaveCount(2)

  // closed lines: a name, a short state, an action
  const files = page.getByTestId('project-files')
  await expect(files.getByTestId('project-files-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(files.getByTestId('project-files-toggle')).toContainText(/\d+개 항목/)
  await expect(files.getByRole('button', { name: 'plan.md' })).toHaveCount(0)
  await files.getByTestId('project-files-toggle').click()
  await expect(files.getByTestId('project-files-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(files.getByRole('button', { name: 'plan.md' })).toBeVisible()
  await expect(files.getByRole('link', { name: '열기' })).toHaveAttribute('href', '/files?path=marketing')

  const instructions = page.getByTestId('project-instructions')
  await instructions.getByTestId('project-instructions-toggle').click()
  await expect(instructions.getByRole('heading', { name: 'Launch' })).toBeVisible()
  await instructions.getByRole('button', { name: '수정' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()

  // the menu on the name: Escape closes only the menu and gives focus back to the name
  const menu = page.getByTestId('project-menu')
  await menu.click()
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByTestId('project-edit')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('project-delete')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(menu).toBeFocused()
  // a click outside closes it too
  await menu.click()
  await page.getByTestId('project-summary').click()
  await expect(page.getByRole('menu')).toHaveCount(0)

  await menu.click()
  await page.getByTestId('project-edit').click()
  await page.getByTestId('project-name').fill('Launch 2')
  await page.getByTestId('project-save').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Launch 2' })).toBeVisible()
  await expect(menu).toContainText('Launch 2')

  await menu.click()
  await page.getByTestId('project-delete').click()
  await page.getByRole('dialog').getByRole('button', { name: '삭제' }).click()
  await expect(page).toHaveURL(/\/projects$/)
})

test('a person who cannot edit the project sees no menu and no edit action', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const id = await newProject(page)
  await page.route((u) => u.pathname === `/api/projects/${id}`, async (r) => {
    const res = await r.fetch()
    await r.fulfill({ response: res, json: { ...(await res.json()), canEdit: false } })
  })
  await page.goto(`/projects/${id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Launch' })).toBeVisible()
  await expect(page.getByTestId('project-menu')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '현재 위치' }).getByText('Launch')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('project-instructions').getByRole('button', { name: '수정' })).toHaveCount(0)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`a project page has no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    const id = await newProject(page, ['Weekly numbers'])
    await page.goto(`/projects/${id}`)
    await expect(page.getByTestId('project-chats').getByRole('link')).toHaveCount(1)
    await audit(page, 'project')
    await page.getByTestId('project-files-toggle').click()
    await page.getByTestId('project-instructions-toggle').click()
    await page.getByTestId('project-menu').click()
    await expect(page.getByRole('menu')).toBeVisible()
    await audit(page, 'project (lines open, menu open)')
  })
}

test('at phone width the page fits: the box first, then the lines, then the chats', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  // a server with the dev environment on: still no line for it here
  await page.request.post('/__test/dev-env', { data: { srt: true } })
  await signIn(page)
  const id = await newProject(page, ['Weekly numbers'])
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-chats').getByRole('link')).toHaveCount(1)
  await expect(page.getByTestId('project-instructions')).toBeVisible()
  await expect(page.getByTestId('dev-env')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const top = async (testId: string) => (await page.getByTestId(testId).boundingBox())!.y
  expect(await top('composer-input')).toBeLessThan(await top('project-instructions'))
  expect(await top('project-files')).toBeLessThan(await top('project-chats'))
  await audit(page, 'project (phone)')
})

for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  test(`the owner on a team project she is not in: the block, Add me, its files after; taking herself out closes it again (${vp.name})`, async ({ page }) => {
    await page.setViewportSize(vp.size)
    await reset(page)
    await signIn(page)
    // Bob's project, with a file and a chat of the owner from before (her own chats stay hers)
    const made = await page.request.post('/__test/project', { data: { name: 'Falcon', by: 'bob', instructions: '# Falcon\n\nContracts only.', files: { 'plan.md': 'plan' }, chats: [['olga', 'My old notes']] } })
    const { id } = (await made.json()) as { id: string }
    // the list: her card, no "not a member" tag
    await page.goto('/projects')
    await expect(page.getByTestId('project-card').filter({ hasText: 'Falcon' })).toBeVisible()
    await page.getByTestId('project-card').filter({ hasText: 'Falcon' }).getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}$`))
    const block = page.getByTestId('project-members-only')
    await expect(block).toContainText('멤버만 이 프로젝트를 열 수 있어요. 나를 멤버로 추가하면 파일을 볼 수 있어요.')
    for (const testId of ['composer-input', 'project-instructions', 'project-files', 'project-summary']) await expect(page.getByTestId(testId)).toHaveCount(0)
    await expect(page.getByTestId('project-members')).toContainText('1명')
    await expect(page.getByTestId('project-chats')).toContainText('My old notes')
    await expect(page.getByText('plan.md')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await audit(page, `not a member (${vp.name})`)
    // Add me: the app's confirm first
    await page.getByTestId('project-add-me').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading')).toHaveText("'Falcon'에 나를 추가할까요?")
    await expect(dialog).toContainText('멤버들에게 내가 들어왔다고 알려요.')
    await expect(dialog.getByTestId('dialog-confirm')).toHaveText('나를 멤버로 추가')
    await audit(page, `Add me confirm (${vp.name})`)
    await dialog.getByTestId('dialog-confirm').click()
    // a member's page now: the box, the instructions, the files
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await expect(block).toHaveCount(0)
    await expect(page.getByTestId('project-summary')).toHaveText('Contracts only.')
    await page.getByTestId('project-files-toggle').click()
    await expect(page.getByTestId('project-files').getByRole('button', { name: 'plan.md' })).toBeVisible()
    await expect(page.getByTestId('project-members')).toContainText('2명')
    // in its members now, as anyone added is
    const bob = await page.request.get(`/api/projects/${id}/access`)
    expect(((await bob.json()) as { participants: { subjectId: string }[] }).participants.map((x) => x.subjectId)).toEqual(['bob', 'olga'])
    // taking herself out in the members dialog: the page closes again
    await page.getByTestId('project-members-manage').click()
    await page.getByTestId('participant-remove-user-olga').click()
    await page.getByTestId('project-members-save').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(block).toBeVisible()
    await expect(page.getByTestId('composer-input')).toHaveCount(0)
    await expect(page.getByTestId('project-files')).toHaveCount(0)
  })
}

test('a project in the trash: its note with Restore and Delete for good, no name menu; a shared chat link of a project I am not in tells an owner she can add herself, with the way to Projects', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const made = await page.request.post('/__test/project', { data: { name: 'Falcon', by: 'bob', files: { 'plan.md': 'plan' } } })
  const { id } = (await made.json()) as { id: string }
  await page.goto(`/projects/${id}`)
  await page.getByTestId('project-menu').click()
  await expect(page.getByRole('menuitem')).toHaveText(['이름 바꾸기', '삭제'])
  await page.getByTestId('project-delete').click()
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText("'Falcon'을(를) 휴지통으로 옮길까요?")
  // only what happens: no "its files and chats go with it" (her own chats there stay hers)
  await expect(page.getByRole('dialog')).toContainText('팀장이나 관리자가 되돌릴 때까지 멤버도 파일과 공유 채팅을 열 수 없어요.')
  await page.getByTestId('dialog-confirm').click()
  // still here, in the trash; the note has Restore and Delete for good, and there is no name menu beside them
  await expect(page.getByTestId('project-in-trash')).toContainText('이 프로젝트는 휴지통에 있어요.')
  await expect(page.getByTestId('project-members-only')).toHaveCount(0)
  await expect(page.getByTestId('project-menu')).toHaveCount(0)
  await expect(page.getByTestId('project-topline')).toContainText('Falcon')
  await page.getByTestId('project-restore').click()
  await expect(page.getByTestId('project-in-trash')).toHaveCount(0)
  await expect(page.getByTestId('project-members-only')).toBeVisible()
  // again to the trash, then its folder purged: Restore says why it cannot, Delete for good ends it
  await page.getByTestId('project-menu').click()
  await page.getByTestId('project-delete').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByTestId('project-in-trash')).toBeVisible()
  await page.request.post('/__test/project-purge', { data: { id } })
  await page.getByTestId('project-restore').click()
  await expect(page.getByText('이 프로젝트의 폴더는 완전히 지워져서 되돌릴 수 없어요. 프로젝트를 삭제할 수 있어요.')).toBeVisible()
  // Restore goes (it would only say the same again); Delete for good stays
  await expect(page.getByTestId('project-restore')).toHaveCount(0)
  await page.getByTestId('project-delete-for-good').click()
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText("'Falcon'을(를) 완전히 삭제할까요?")
  await expect(page.getByRole('dialog')).toContainText('파일도 함께 지워지고 되돌릴 수 없어요.')
  await page.getByTestId('dialog-confirm').click()
  await expect(page).toHaveURL(/\/projects$/)
  expect((await page.request.get(`/api/projects/${id}?manage=1`)).status()).toBe(404)
  // a chat that is not there: the owner's extra line (the same for every missing chat)
  await page.goto('/c/01900000-0000-7000-8000-00000000dead')
  await expect(page.getByTestId('chat-not-found')).toBeVisible()
  await expect(page.getByTestId('chat-not-found-manage')).toHaveText('내가 멤버가 아닌 프로젝트의 채팅이면 프로젝트에서 열고 나를 멤버로 추가할 수 있어요.')
  // "프로젝트" is the way there (a phone has no back button on this page)
  await page.getByTestId('chat-not-found-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
})
