// Projects live only in projects/ (docs/DECISIONS.md "Projects live only in projects/", "Project members in one
// panel"): a member makes a team project with the people they choose and reads how many see it; the creator adds
// someone later from the 멤버 line of the project page and a confirm says what they will see first; taking someone out
// saves at once; deleting it takes it to the trash with its folder. Someone who cannot change the members reads who does;
// the list card's ⋯ 멤버 and /projects/:id?members=1 open the same dialog. The team setting can keep team projects to
// admins. Members only (docs/DECISIONS.md "Project contents only for members"): every count is its members, the owner
// and admins only when they are members; other settings of its folder have × in the dialog, those inside the caller
// may not read are counted; someone who manages it without being a member reads no numbers of what is in it.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }

/** two more members (Sora, Jiwoo) and a group with Bob and Sora in it, made by the owner */
async function seed(page: Page) {
  for (const [id, name] of [['sora', '김소라'], ['jiwoo', '이지우']] as const)
    expect((await page.request.post('/api/admin/users', { headers: H, data: { id, username: id, name, role: 'member', groupIds: [], temporaryPassword: `${id}-Password-1` } })).ok()).toBeTruthy()
  const g = await page.request.post('/api/admin/groups', { headers: H, data: { name: '영업', memberIds: ['bob', 'sora'] } })
  const gid = ((await g.json()) as { id: string }).id
  for (const id of ['bob', 'sora']) expect((await page.request.patch(`/api/admin/users/${id}`, { headers: H, data: { groupIds: [gid] } })).ok()).toBeTruthy()
}
async function asBob(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1360, height: 860 }, serviceWorkers: 'block' })
  const b = await ctx.newPage()
  await signIn(b, BOB)
  return b
}

test('the owner\'s case: every count is the members, the owner and admins only when chosen; the owner sees it without being in it', async ({ page, browser }) => {
  // the owner, another admin (Eve) and Dana, who makes the project with a group of three she is in
  await reset(page, { withAdmin: true })
  await signIn(page)
  await seed(page)
  const g = await page.request.post('/api/admin/groups', { headers: H, data: { name: '리드', memberIds: ['dana', 'bob', 'sora'] } })
  const lead = ((await g.json()) as { id: string }).id
  for (const id of ['dana', 'bob', 'sora']) expect((await page.request.patch(`/api/admin/users/${id}`, { headers: H, data: { groupIds: [lead] } })).ok()).toBeTruthy()
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  const d = await ctx.newPage()
  await signIn(d, { username: 'dana', password: 'dana password 1' })
  await d.goto('/projects')
  await d.getByTestId('project-new').click()
  await d.getByTestId('project-name').fill('견적서 제작')
  // only Dana yet: nobody by role
  await expect(d.getByTestId('project-access-summary')).toHaveText('멤버 1명')
  await d.getByTestId('project-participants-search').fill('리드')
  await d.getByTestId(`participant-add-group-${lead}`).click()
  // Dana, who is in the group too, counts once: 3 members, and nothing about the owner and Eve
  await expect(d.getByTestId('project-access-summary')).toHaveText('멤버 3명')
  await d.getByTestId('project-save').click()
  await expect(d.getByRole('heading', { level: 1, name: '견적서 제작' })).toBeVisible()
  const id = d.url().split('/').pop()!
  await expect(d.getByTestId('project-members')).toContainText('멤버3명')
  await d.getByTestId('project-members-manage').click()
  await expect(d.getByTestId('project-access-summary')).toHaveText('멤버 3명')
  await expect(d.getByTestId('project-access-summary-role')).toHaveCount(0)
  await ctx.close()

  // Bob, a member in the group (not its creator): the same 3
  const b = await asBob(browser)
  await b.goto(`/projects/${id}`)
  await expect(b.getByTestId('project-members')).toContainText('3명')
  const seen = (await (await b.request.get(`/api/projects/${id}`)).json()) as Record<string, unknown>
  expect(seen.audience).toBe(3)
  expect(seen).not.toHaveProperty('audienceSplit')
  await b.context().close()

  // the owner: not in it. Without manage it is not hers to read; with it, its name and count, nothing of its contents
  expect((await page.request.get(`/api/projects/${id}`)).status()).toBe(404)
  const managed = (await (await page.request.get(`/api/projects/${id}?manage=1`)).json()) as Record<string, unknown>
  expect(managed).toMatchObject({ member: false, canManage: true, instructions: '', audience: 3, membersEditable: true })
})

test('a member makes a team project with a person, then adds one more: the confirm says what they will see', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  await seed(page)
  const b = await asBob(browser)
  await b.goto('/projects')
  await b.getByTestId('project-new').click()
  const dialog = b.getByRole('dialog')
  await b.getByTestId('project-name').fill('주간 보고')
  // a team project by default, no folder to choose; how many see it is always said
  await expect(b.getByTestId('project-kind-team')).toBeChecked()
  await expect(dialog.getByTestId('project-folder')).toHaveCount(0)
  // a new project: the count is me and the people I choose (members only)
  await expect(b.getByTestId('project-access-summary')).toHaveText('멤버 1명')
  // I am always in it (no × to take me out)
  await expect(b.getByTestId('participant-user-bob')).toContainText('나')
  await expect(b.getByTestId('participant-remove-user-bob')).toHaveCount(0)
  // the search lists everyone I can add, my own group (부서) too; typing narrows it
  await b.getByTestId('project-participants-search').click()
  await expect(b.getByTestId('project-participants-results').getByText('영업', { exact: true })).toBeVisible()
  await expect(b.getByTestId('participant-add-user-jiwoo')).toBeVisible()
  await b.getByTestId('project-participants-search').fill('소라')
  await expect(b.getByTestId('participant-add-user-jiwoo')).toHaveCount(0)
  await b.getByTestId('participant-add-user-sora').click()
  await expect(b.getByTestId('participant-user-sora')).toBeVisible()
  await expect(b.getByTestId('project-access-summary')).toHaveText('멤버 2명')
  await b.getByTestId('project-save').click()
  await expect(b.getByRole('heading', { level: 1, name: '주간 보고' })).toBeVisible()
  const id = b.url().split('/').pop()!

  // the 멤버 line says how many see it (Bob and Sora: the owner is no member); the edit dialog no longer holds the members
  await expect(b.getByTestId('project-members')).toContainText('2명')
  await b.getByTestId('project-menu').click()
  await b.getByTestId('project-edit').click()
  await expect(b.getByRole('dialog').getByTestId('project-participants')).toHaveCount(0)
  await b.getByRole('dialog').getByRole('button', { name: '취소' }).click()

  // someone else put a file there; Bob adds Jiwoo from the 멤버 line: the confirm first
  expect((await page.request.post('/__test/file', { data: { path: 'projects/주간 보고/notes.md', text: '# notes\n' } })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/file', { data: { path: 'projects/주간 보고/skills/견적서/SKILL.md', text: '---\nname: 견적서\ndescription: 견적서 초안\n---\n' } })).ok()).toBeTruthy()
  await b.getByTestId('project-members-manage').click()
  await expect(b.getByRole('dialog')).toContainText('멤버 · 주간 보고')
  await expect(b.getByTestId('participant-user-bob')).toHaveAttribute('data-state', 'fixed')
  await expect(b.getByTestId('participant-user-sora')).toHaveAttribute('data-state', 'member')
  await b.getByTestId('project-participants-search').fill('지우')
  await b.getByTestId('participant-add-user-jiwoo').click()
  await expect(b.getByTestId('participant-user-jiwoo')).toHaveAttribute('data-state', 'new')
  await b.getByTestId('project-members-save').click()
  const confirm = b.getByTestId('project-widen-confirm')
  await expect(confirm).toContainText('1명이 새로 이 프로젝트를 보게 돼요.')
  await expect(confirm).toContainText('파일 1개 (다른 사람이 올린 1개 포함)')
  // the project's skills by name: the people added use them in its chats
  await expect(confirm).toContainText('프로젝트 스킬 1개(견적서)도 1명이 더 쓰게 돼요')
  await b.getByTestId('dialog-confirm').click()
  await expect(b.getByRole('dialog')).toHaveCount(0)
  const access = await (await b.request.get(`/api/projects/${id}/access`)).json() as { participants: { subjectId: string }[] }
  expect(access.participants.map((x) => x.subjectId)).toEqual(['bob', 'sora', 'jiwoo'])
  await expect(b.getByTestId('project-members')).toContainText('3명')

  // taking someone out: struck through until the save, then saved at once (no confirm)
  await b.getByTestId('project-members-manage').click()
  await b.getByTestId('participant-remove-user-sora').click()
  await expect(b.getByTestId('participant-user-sora')).toHaveAttribute('data-state', 'removed')
  await b.getByTestId('project-members-save').click()
  await expect(b.getByRole('dialog')).toHaveCount(0)
  expect(((await (await b.request.get(`/api/projects/${id}/access`)).json()) as { participants: { subjectId: string }[] }).participants.map((x) => x.subjectId)).toEqual(['bob', 'jiwoo'])
  await expect(b.getByTestId('project-members')).toContainText('2명')

  // deleting it moves it to the trash with its folder (no box to tick); its creator does not see it there
  await b.getByTestId('project-menu').click()
  await b.getByTestId('project-delete').click()
  await expect(b.getByRole('dialog')).toContainText("'주간 보고'을(를) 휴지통으로 옮길까요?")
  await expect(b.getByRole('dialog')).toContainText('팀장이나 관리자가 되돌릴 때까지 멤버도 파일과 공유 채팅을 열 수 없어요.')
  await expect(b.getByTestId('project-delete-trash-folder')).toHaveCount(0)
  await b.getByTestId('dialog-confirm').click()
  await expect(b).toHaveURL(/\/projects$/)
  expect((await page.request.get(`/api/files/tree?path=${encodeURIComponent('projects/주간 보고')}`)).status()).toBe(404)
  await b.context().close()
})

test('who cannot change the members reads who does; the list card\'s ⋯ 멤버 and ?members=1 open the dialog', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const r = await page.request.post('/api/projects', { headers: H, data: { name: '견적', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
  const id = ((await r.json()) as { id: string }).id
  // Bob is in it but did not make it: the line opens to say who changes the members, by name; no 관리, no ⋯ 멤버
  const b = await asBob(browser)
  await b.goto(`/projects/${id}`)
  await expect(b.getByTestId('project-members')).toContainText('2명')
  await expect(b.getByTestId('project-members-manage')).toHaveCount(0)
  await b.getByTestId('project-members-toggle').click()
  await expect(b.getByTestId('project-members-hint')).toHaveText('멤버는 Olga님(만든 사람)이나 관리자가 바꿔요.')
  await b.goto(`/projects/${id}?members=1`)
  await expect(b.getByTestId('project-members')).toBeVisible()
  await expect(b.getByRole('dialog')).toHaveCount(0)
  await expect(b).toHaveURL(new RegExp(`/projects/${id}$`))
  await b.goto('/projects')
  await b.getByTestId('project-card').getByTestId('project-card-menu').click()
  await expect(b.getByTestId('project-card-members')).toHaveCount(0)
  await b.context().close()

  // the creator: ⋯ 멤버 on the list opens the members without leaving it
  await page.goto('/projects')
  await page.getByTestId('project-card').hover()
  await page.getByTestId('project-card').getByTestId('project-card-menu').click()
  await page.getByTestId('project-card-members').click()
  await expect(page.getByRole('dialog')).toContainText('멤버 · 견적')
  await expect(page.getByTestId('participant-user-bob')).toHaveAttribute('data-state', 'member')
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await expect(page).toHaveURL(/\/projects$/)
  // and /projects/:id?members=1 opens it on the page; closing it drops the parameter
  await page.goto(`/projects/${id}?members=1`)
  await expect(page.getByRole('dialog')).toContainText('멤버 · 견적')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/projects/${id}$`))
})

test('a team that lets only admins make team projects: a member makes a personal one', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  expect((await page.request.patch('/api/admin/settings', { headers: H, data: { projectCreators: 'admins' } })).ok()).toBeTruthy()
  const b = await asBob(browser)
  await b.goto('/projects?new=1')
  await expect(b.getByRole('dialog')).toContainText('이 팀에서는 팀장과 관리자만 팀 프로젝트를 만들 수 있어요.')
  await expect(b.getByTestId('project-kind-team')).toHaveCount(0)
  await expect(b.getByTestId('project-kind-personal')).toBeChecked()
  await b.context().close()
  // the switch in Team settings
  await page.goto('/admin/settings')
  await expect(page.getByTestId('team-project-creators')).toHaveAttribute('data-on', 'false')
})

test('Files: a folder that is a project opens it; no other folder becomes one there', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const r = await page.request.post('/api/projects', { headers: H, data: { name: 'Launch', participants: [], instructions: '' } })
  const id = ((await r.json()) as { id: string }).id
  await page.goto('/files?path=projects')
  await page.getByRole('row').filter({ hasText: 'Launch' }).getByTestId('file-menu').click()
  await page.getByTestId('open-project').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${id}$`))
  await page.goto('/files')
  await page.getByRole('row').filter({ hasText: 'marketing' }).getByTestId('file-menu').click()
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByTestId('make-project')).toHaveCount(0)
  await expect(page.getByTestId('open-project')).toHaveCount(0)
})

test('members only: another setting of the folder goes with ×, those inside the owner may not read are counted, and adding someone tells no numbers', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await seed(page)
  // Bob's project: Jiwoo reads by another setting of its folder; a folder inside has two settings of its own
  const made = await page.request.post('/__test/project', { data: { name: '견적', by: 'bob', files: { 'plan.md': 'plan' } } })
  const { id } = (await made.json()) as { id: string }
  expect((await page.request.post('/__test/project-rules', { data: { folder: 'projects/견적', others: [{ path: 'projects/견적', subjectType: 'user', subjectId: 'jiwoo', access: 'read' }, { path: 'projects/견적/계약', subjectType: 'user', subjectId: 'sora', access: 'write' }], hidden: 1 } })).ok()).toBeTruthy()
  await page.goto(`/projects/${id}?members=1`)
  const d = page.getByTestId('project-members-dialog')
  await expect(d).toBeVisible()
  // the one on the folder itself: × ; inside: counted only (the owner is no member), never named
  await expect(page.getByTestId('project-other-rule-user-jiwoo')).toContainText('이지우')
  await expect(page.getByTestId('project-other-rules-hidden')).toHaveText('안쪽 폴더 2개는 볼 수 있는 사람이 따로 정해져 있어요')
  await expect(d).not.toContainText('계약')
  await expect(d).not.toContainText('여기서는 바꿀 수 없어요.')
  await expect(d).not.toContainText('폴더 권한에서 보기')
  await expect(page.getByTestId('project-access-summary')).toHaveText('멤버 2명')
  await page.getByTestId('project-other-rule-remove-user-jiwoo').click()
  await expect(page.getByTestId('project-other-rule-user-jiwoo')).toHaveAttribute('data-state', 'removed')
  await expect(page.getByTestId('project-access-summary')).toHaveText('멤버 1명')
  // Sora added: what she will see is not counted for someone who does not read it
  await page.getByTestId('project-participants-search').fill('소라')
  await page.getByTestId('participant-add-user-sora').click()
  await page.getByTestId('project-members-save').click()
  const confirm = page.getByTestId('project-widen-confirm')
  await expect(confirm).toContainText('이 사람들은 파일과 채팅을 보게 돼요.')
  await expect(confirm).not.toContainText('파일 1개')
  await page.getByTestId('dialog-confirm').click()
  await expect(d).toHaveCount(0)
  const access = (await (await page.request.get(`/api/projects/${id}/access`)).json()) as { participants: { subjectId: string }[]; otherRules: { subjectId: string }[] }
  expect(access.participants.map((x) => x.subjectId)).toEqual(['bob', 'sora'])
  expect(access.otherRules.map((x) => x.subjectId)).toEqual([])
})
