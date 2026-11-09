// Projects live only in projects/ (docs/DECISIONS.md "Projects live only in projects/"): a member makes a team project
// with the people they choose and always reads who sees it; the creator adds someone later and a confirm says what they
// will see first; narrowing saves at once; deleting it may take its folder to the trash. The team setting can keep team
// projects to admins.
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

test('a member makes a team project with a person, then adds one more: the confirm says what they will see', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  await seed(page)
  const b = await asBob(browser)
  await b.goto('/projects')
  await b.getByTestId('project-new').click()
  const dialog = b.getByRole('dialog')
  await b.getByTestId('project-name').fill('주간 보고')
  // a team project by default, no folder to choose; who sees it is always said
  await expect(b.getByTestId('project-kind-team')).toBeChecked()
  await expect(dialog.getByTestId('project-folder')).toHaveCount(0)
  await expect(b.getByTestId('project-access-summary')).toHaveText('볼 수 있는 사람 나 · 팀장·관리자 (2명)')
  // my own group is offered (부서); I am always in it
  await expect(dialog.getByText('영업', { exact: true })).toBeVisible()
  await expect(b.getByTestId('participant-user-bob')).toBeDisabled()
  await b.getByTestId('project-participants-search').fill('소라')
  await b.getByTestId('participant-user-sora').check()
  await expect(b.getByTestId('project-access-summary')).toHaveText('볼 수 있는 사람 나 · 김소라 · 팀장·관리자 (3명)')
  await b.getByTestId('project-save').click()
  await expect(b.getByRole('heading', { level: 1, name: '주간 보고' })).toBeVisible()
  const id = b.url().split('/').pop()!

  // someone else put a file there; Bob adds Jiwoo: the confirm first
  expect((await page.request.post('/__test/file', { data: { path: 'projects/주간 보고/notes.md', text: '# notes\n' } })).ok()).toBeTruthy()
  await b.getByTestId('project-menu').click()
  await b.getByTestId('project-edit').click()
  await expect(b.getByTestId('participant-user-sora')).toBeChecked()
  await b.getByTestId('participant-user-jiwoo').check()
  await b.getByTestId('project-save').click()
  const confirm = b.getByTestId('project-widen-confirm')
  await expect(confirm).toContainText('1명이 새로 이 프로젝트를 보게 돼요.')
  await expect(confirm).toContainText('파일 1개 (다른 사람이 올린 1개 포함)')
  await b.getByTestId('dialog-confirm').click()
  await expect(b.getByRole('dialog')).toHaveCount(0)
  const access = await (await b.request.get(`/api/projects/${id}/access`)).json() as { participants: { subjectId: string }[] }
  expect(access.participants.map((x) => x.subjectId)).toEqual(['bob', 'sora', 'jiwoo'])

  // narrowing: no confirm, saved at once
  await b.getByTestId('project-menu').click()
  await b.getByTestId('project-edit').click()
  await b.getByTestId('participant-user-sora').uncheck()
  await b.getByTestId('project-save').click()
  await expect(b.getByRole('dialog')).toHaveCount(0)
  expect(((await (await b.request.get(`/api/projects/${id}/access`)).json()) as { participants: { subjectId: string }[] }).participants.map((x) => x.subjectId)).toEqual(['bob', 'jiwoo'])

  // deleting it offers to put its folder in the trash
  await b.getByTestId('project-menu').click()
  await b.getByTestId('project-delete').click()
  await b.getByTestId('project-delete-trash-folder').check()
  await b.getByTestId('dialog-confirm').click()
  await expect(b).toHaveURL(/\/projects$/)
  expect((await page.request.get(`/api/files/tree?path=${encodeURIComponent('projects/주간 보고')}`)).status()).toBe(404)
  await b.context().close()
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
