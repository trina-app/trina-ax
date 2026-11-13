// Who is in a team project, by face (docs/DECISIONS.md "Who is in a project, by face"): the faces under its name and on
// its 멤버 line (4 and "+N", on a phone too), the faces open the members dialog, whose group rows open to their people
// and whose list names everyone once, the creator and "나" marked. A member who does not manage it reads the list only;
// a personal project shows no faces.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }

/** Sora and Jiwoo, a group 리드 (Dana, Bob, Sora, Jiwoo) and a group 영업 (Bob, Sora), and the owner's project shared
 * with both groups: five people, Bob and Sora in two groups */
async function seed(page: Page): Promise<{ id: string; lead: string }> {
  for (const [id, name] of [['sora', '김소라'], ['jiwoo', '이지우']] as const)
    expect((await page.request.post('/api/admin/users', { headers: H, data: { id, username: id, name, role: 'member', groupIds: [], temporaryPassword: `${id}-Password-1` } })).ok()).toBeTruthy()
  const lead = ((await (await page.request.post('/api/admin/groups', { headers: H, data: { name: '리드', memberIds: ['dana', 'bob', 'sora', 'jiwoo'] } })).json()) as { id: string }).id
  const sales = ((await (await page.request.post('/api/admin/groups', { headers: H, data: { name: '영업', memberIds: ['bob', 'sora'] } })).json()) as { id: string }).id
  for (const [id, gs] of [['dana', [lead]], ['bob', [lead, sales]], ['sora', [lead, sales]], ['jiwoo', [lead]]] as const)
    expect((await page.request.patch(`/api/admin/users/${id}`, { headers: H, data: { groupIds: gs } })).ok()).toBeTruthy()
  const r = await page.request.post('/api/projects', { headers: H, data: { name: '견적서 제작', participants: [{ subjectType: 'group', subjectId: lead }, { subjectType: 'group', subjectId: sales }], instructions: '' } })
  expect(r.ok()).toBeTruthy()
  return { id: ((await r.json()) as { id: string }).id, lead }
}
async function as(browser: Browser, who: { username: string; password: string }, width = 1360) {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width, height: width < 768 ? 844 : 860 }, serviceWorkers: 'block' })
  const p = await ctx.newPage()
  await signIn(p, who)
  return p
}

test('the owner: faces under the name and on the 멤버 line; the dialog lists everyone once, groups open to their people', async ({ page }) => {
  await reset(page, { withAdmin: true })
  await signIn(page)
  const { id, lead } = await seed(page)
  await page.goto(`/projects/${id}`)
  const header = page.getByTestId('project-people-header')
  await expect(header.getByTestId('project-header-face')).toHaveCount(4)
  await expect(header.getByTestId('project-header-more')).toHaveText('+1')
  await expect(header.getByTestId('project-header-open')).toHaveAccessibleName(/^멤버: Olga, /)
  // the 멤버 line keeps its number, the faces after it
  await expect(page.getByTestId('project-members')).toContainText('멤버5명')
  await expect(page.getByTestId('project-members').getByTestId('project-members-row-people')).toBeVisible()

  await header.getByTestId('project-header-open').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('project-people-count')).toHaveText('이 프로젝트에 있는 사람 5명')
  await expect(dialog.locator('[data-testid^="project-person-tag-"]')).toHaveCount(1)
  await expect(dialog.getByTestId('project-person-tag-olga')).toHaveText('만든 사람 · 나')
  // Bob and Sora, in both groups, once each
  await expect(dialog.getByTestId('project-person-bob')).toHaveCount(1)
  await expect(dialog.getByTestId('project-person-sora')).toHaveCount(1)
  const toggle = dialog.getByTestId(`participant-group-toggle-${lead}`)
  await expect(toggle).toContainText('4명')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(dialog.getByTestId(`participant-group-people-${lead}`).getByRole('listitem')).toHaveText([/Bob$/, /Dana$/, /김소라$/, /이지우$/])
})

test('a member: the faces open the list only, with "나"; a phone shows the faces under the bar', async ({ page, browser }) => {
  await reset(page, { withAdmin: true })
  await signIn(page)
  const { id } = await seed(page)
  const b = await as(browser, { username: 'bob', password: 'bob password 1' })
  await b.goto(`/projects/${id}`)
  await b.getByTestId('project-header-open').click()
  const dialog = b.getByRole('dialog')
  await expect(dialog.getByTestId('project-people-count')).toHaveText('이 프로젝트에 있는 사람 5명')
  await expect(dialog.getByTestId('project-person-tag-bob')).toHaveText('나')
  await expect(dialog.getByTestId('project-person-tag-olga')).toHaveText('만든 사람')
  // no picker, no groups: who changes them, and 닫기
  await expect(dialog.getByTestId('project-participants')).toHaveCount(0)
  await expect(dialog.getByTestId('project-members-locked')).toBeVisible()
  await dialog.getByRole('button', { name: '닫기' }).first().click()
  await expect(b.getByRole('dialog')).toHaveCount(0)
  // the server never gives a member the groups
  expect(((await (await b.request.get(`/api/projects/${id}/people`)).json()) as { groups?: unknown }).groups).toBeUndefined()
  await b.context().close()

  const phone = await as(browser, { username: 'bob', password: 'bob password 1' }, 390)
  await phone.goto(`/projects/${id}`)
  await expect(phone.getByTestId('project-people-header').getByTestId('project-header-face')).toHaveCount(4)
  await expect(phone.getByTestId('project-header-more')).toHaveText('+1')
  await phone.context().close()
})

test('a personal project shows no faces', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const r = await page.request.post('/api/projects', { headers: H, data: { name: '내 메모', scope: 'personal', participants: [], instructions: '' } })
  await page.goto(`/projects/${((await r.json()) as { id: string }).id}`)
  await expect(page.getByTestId('project-chats')).toBeVisible()
  await expect(page.getByTestId('project-people-header')).toHaveCount(0)
})
