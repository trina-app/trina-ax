// Share in the project's title row (docs/DECISIONS.md "Share in the project's title row", QA TC-3283): who sees it
// ("Only me" or the faces) and Share at the top right (on a phone the row under the bar); no Members line at the bottom
// any more. Share opens the share dialog of a personal project and the members dialog of a team project; someone who
// cannot share sees no Share, and the faces open the read-only list. New project takes people right away (People,
// optional): picked, it makes a team project with them. At 1440 and 390, light and dark; SHOT_DIR keeps screenshots.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const SHOTS = process.env.SHOT_DIR

async function seed(page: Page) {
  for (const [id, name] of [['sora', 'Sora Kim'], ['jiwoo', 'Jiwoo Lee']] as const)
    expect((await page.request.post('/api/admin/users', { headers: H, data: { id, username: id, name, role: 'member', groupIds: [], temporaryPassword: `${id}-Password-1` } })).ok()).toBeTruthy()
}
async function as(browser: Browser, who: { username: string; password: string }, o: { width?: number; dark?: boolean } = {}) {
  const width = o.width ?? 1440
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width, height: width < 768 ? 844 : 900 }, colorScheme: o.dark ? 'dark' : 'light', serviceWorkers: 'block' })
  const p = await ctx.newPage()
  await signIn(p, who)
  return p
}
/** a chat with one answer, by the API */
async function chatOf(p: Page, title: string, projectId?: string) {
  const chat = (await (await p.request.post('/api/chats', { headers: H, data: projectId ? { projectId } : {} })).json()) as { id: string }
  expect((await p.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: 'Summarise the budget', clientMessageId: uuidv7() } })).status()).toBe(202)
  await expect.poll(async () => ((await (await p.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  expect((await p.request.patch(`/api/chats/${chat.id}`, { headers: H, data: { title } })).ok()).toBeTruthy()
  return chat.id
}
const noSideScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test('a member makes a project with a teammate in New project, then shares from the title row', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await seed(page)
  const b = await as(browser, BOB)
  await b.goto('/projects')
  await b.getByTestId('project-new').click()
  const dialog = b.getByRole('dialog')
  await expect(dialog.getByTestId('project-who')).toHaveText('Only you see it. You can add people later.')
  await dialog.getByTestId('project-name').fill('Weekly reports')
  await dialog.getByTestId('project-participants-search').fill('sora')
  await dialog.getByTestId('participant-add-user-sora').click()
  await expect(dialog.getByTestId('participant-user-sora')).toBeVisible()
  await expect(dialog.getByTestId('project-access-summary')).toHaveText('2 people')
  await expect(dialog.getByTestId('project-share-note')).toContainText("This can't go back to only you.")
  await expect(dialog.getByTestId('project-who')).toHaveCount(0)
  // Enter in the search adds nobody and makes nothing
  await dialog.getByTestId('project-participants-search').fill('jiwoo')
  await dialog.getByTestId('project-participants-search').press('Enter')
  await expect(b.getByRole('dialog')).toBeVisible()
  await dialog.getByTestId('project-participants-search').fill('')
  // (the search's results close when the focus leaves it)
  await dialog.getByTestId('project-name').click()
  await expect(dialog.getByTestId('project-participants-results')).toHaveCount(0)
  await dialog.getByTestId('project-create').click()
  await expect(b.getByRole('heading', { level: 1, name: 'Weekly reports' })).toBeVisible()
  const id = b.url().split('/').pop()!
  // a team project with Bob and Sora (the same rules as a share later)
  const access = (await (await b.request.get(`/api/projects/${id}/access`)).json()) as { participants: { subjectId: string }[] }
  expect(access.participants.map((x) => x.subjectId).sort()).toEqual(['bob', 'sora'])
  // the title row: their faces and Share; no Members line in the side column
  const row = b.getByTestId('project-share-row')
  await expect(row.getByTestId('project-header-face')).toHaveCount(2)
  await expect(row.getByTestId('project-share')).toHaveText('Share')
  await expect(b.getByTestId('project-members')).toHaveCount(0)
  // the row sits on the name's line, at its right
  const h1 = (await b.getByRole('heading', { level: 1 }).boundingBox())!
  const share = (await row.getByTestId('project-share').boundingBox())!
  expect(share.y).toBeLessThan(h1.y + h1.height)
  expect(share.x).toBeGreaterThan(h1.x + 200)
  // Share opens the members dialog; Jiwoo added
  await row.getByTestId('project-share').click()
  await expect(b.getByTestId('project-members-dialog')).toBeVisible()
  await b.getByTestId('project-participants-search').fill('jiwoo')
  await b.getByTestId('participant-add-user-jiwoo').click()
  await b.getByTestId('project-members-save').click()
  await b.getByTestId('dialog-confirm').click()
  await expect(b.getByRole('dialog')).toHaveCount(0)
  await expect(row.getByTestId('project-header-face')).toHaveCount(3)
  await b.context().close()

  // Bob in Olga's project (he did not make it): the faces, no Share; the faces open the list and who changes the members
  const theirs = ((await (await page.request.post('/api/projects', { headers: H, data: { name: 'Board deck', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })).json()) as { id: string }).id
  const c = await as(browser, BOB)
  await c.goto(`/projects/${theirs}`)
  await expect(c.getByTestId('project-share-row').getByTestId('project-header-face')).toHaveCount(2)
  await expect(c.getByTestId('project-share')).toHaveCount(0)
  await c.getByTestId('project-header-open').click()
  await expect(c.getByRole('dialog').getByTestId('project-members-locked')).toBeVisible()
  await expect(c.getByRole('dialog').getByTestId('project-participants')).toHaveCount(0)
  await c.context().close()
})

test('a personal project: "Only me" and Share, which opens the share dialog; ?members=1 still opens the members', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await seed(page)
  const b = await as(browser, BOB)
  const mine = ((await (await b.request.post('/api/projects', { headers: H, data: { name: 'My notes', scope: 'personal', participants: [], instructions: '' } })).json()) as { id: string }).id
  await b.goto(`/projects/${mine}`)
  await expect(b.getByTestId('project-who-sees')).toHaveText('Only me')
  await b.getByTestId('project-share').click()
  await expect(b.getByRole('dialog')).toContainText('Add people')
  await b.getByTestId('project-participants-search').fill('sora')
  await b.getByTestId('participant-add-user-sora').click()
  await expect(b.getByTestId('project-share-note')).toContainText("This can't go back to only you.")
  await b.getByTestId('project-share-confirm').click()
  await expect(b.getByRole('dialog')).toHaveCount(0)
  await expect(b.getByTestId('project-share-row').getByTestId('project-header-face')).toHaveCount(2)
  // the AI's link to the members still opens them
  await b.goto(`/projects/${mine}?members=1`)
  await expect(b.getByTestId('project-members-dialog')).toBeVisible()
  await b.context().close()

  // a team that lets only admins share: no Share, "Only me" and the line that says why
  expect((await page.request.patch('/api/admin/settings', { headers: H, data: { projectCreators: 'admins' } })).ok()).toBeTruthy()
  const c = await as(browser, BOB)
  const solo = ((await (await c.request.post('/api/projects', { headers: H, data: { name: 'Solo', scope: 'personal', participants: [], instructions: '' } })).json()) as { id: string }).id
  await c.goto(`/projects/${solo}`)
  await expect(c.getByTestId('project-who-sees')).toHaveText('Only me')
  await expect(c.getByTestId('project-share')).toHaveCount(0)
  await expect(c.getByTestId('project-share-admins-only')).toHaveText('In this team only the owner and admins share projects with others.')
  await c.context().close()
})

test('a chat: Share in the header, "Only me" beside it, no Share in the title menu; a shared project chat shows its people', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await seed(page)
  const b = await as(browser, BOB)
  const id = await chatOf(b, 'Budget notes')
  await b.goto(`/c/${id}`)
  await expect(b.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
  await expect(b.getByTestId('chat-who-sees')).toHaveText('Only me')
  await expect(b.getByTestId('chat-share')).toHaveText('Share')
  await b.getByTestId('chat-menu').click()
  await expect(b.getByTestId('chat-copy-link')).toBeVisible()
  await expect(b.getByRole('menu').getByText('Share', { exact: true })).toHaveCount(0)
  await b.keyboard.press('Escape')
  await b.getByTestId('chat-share').click()
  await expect(b.getByTestId('chat-share-dialog')).toBeVisible()
  await b.keyboard.press('Escape')
  await b.context().close()

  // a shared chat of Olga's team project with Bob in it: its faces; Bob may not change the members, so no Share
  const team = ((await (await page.request.post('/api/projects', { headers: H, data: { name: 'Board deck', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })).json()) as { id: string }).id
  const shared = await chatOf(page, 'Board numbers', team)
  const c = await as(browser, BOB)
  await c.goto(`/c/${shared}`)
  await expect(c.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
  await expect(c.getByTestId('chat-header-face')).toHaveCount(2)
  await expect(c.getByTestId('chat-share')).toHaveCount(0)
  await c.context().close()
  // Olga, who changes them: Share opens the project's members
  await page.goto(`/c/${shared}`)
  await page.getByTestId('chat-share').click()
  await expect(page.getByTestId('project-members-dialog')).toBeVisible()
})

for (const width of [1440, 390])
  for (const dark of [false, true])
    test(`the title row and New project at ${width}, ${dark ? 'dark' : 'light'}`, async ({ page, browser }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await seed(page)
      const tag = `${width}-${dark ? 'dark' : 'light'}`
      const b = await as(browser, BOB, { width, dark })
      const mine = ((await (await b.request.post('/api/projects', { headers: H, data: { name: 'My notes', scope: 'personal', participants: [], instructions: '' } })).json()) as { id: string }).id
      const team = ((await (await b.request.post('/api/projects', { headers: H, data: { name: 'Launch plan', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'sora' }, { subjectType: 'user', subjectId: 'jiwoo' }], instructions: '' } })).json()) as { id: string }).id
      // a personal project
      await b.goto(`/projects/${mine}`)
      await expect(b.getByTestId('project-who-sees')).toHaveText('Only me')
      const share = b.getByTestId('project-share')
      await expect(share).toBeVisible()
      // a phone: the row under the bar, the button a full tap target
      if (width < 768) expect((await share.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await noSideScroll(b)).toBe(true)
      if (SHOTS) await b.screenshot({ path: `${SHOTS}/project-personal-${tag}.png` })
      // a team project
      await b.goto(`/projects/${team}`)
      await expect(b.getByTestId('project-share-row').getByTestId('project-header-face')).toHaveCount(3)
      expect(await noSideScroll(b)).toBe(true)
      if (SHOTS) await b.screenshot({ path: `${SHOTS}/project-team-${tag}.png` })
      // New project with a teammate picked
      await b.goto('/projects?new=1')
      const dialog = b.getByRole('dialog')
      await dialog.getByTestId('project-name').fill('Q4 budget')
      if (SHOTS) await b.screenshot({ path: `${SHOTS}/new-project-${tag}.png` })
      await dialog.getByTestId('project-participants-search').fill('sora')
      await dialog.getByTestId('participant-add-user-sora').click()
      await expect(dialog.getByTestId('project-access-summary')).toHaveText('2 people')
      expect(await noSideScroll(b)).toBe(true)
      if (SHOTS) await b.screenshot({ path: `${SHOTS}/new-project-people-${tag}.png` })
      await b.keyboard.press('Escape')
      // a chat: Share top right (a phone: the icon in the top bar)
      const chat = await chatOf(b, 'Budget notes')
      await b.goto(`/c/${chat}`)
      await expect(b.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
      await expect(b.getByTestId('chat-share')).toBeVisible()
      if (width < 768) expect((await b.getByTestId('chat-share').boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await noSideScroll(b)).toBe(true)
      if (SHOTS) await b.screenshot({ path: `${SHOTS}/chat-${tag}.png` })
      const shared = await chatOf(b, 'Launch questions', team)
      await b.goto(`/c/${shared}`)
      await expect(b.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
      if (SHOTS) await b.screenshot({ path: `${SHOTS}/chat-project-${tag}.png` })
      await b.context().close()
    })
