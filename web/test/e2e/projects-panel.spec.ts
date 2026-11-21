// 프로젝트, a place of its own (docs/DECISIONS.md "Projects: a place of their own…", "Making a project…"): the rail's
// 프로젝트 opens its list beside the rail, 팀 프로젝트 and 내 프로젝트; "+ 새 프로젝트" asks the name only and opens the new
// project's page; a phone's 프로젝트 tab shows the same list.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { openRail, reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.ko
const H = { [CSRF_HEADER]: '1' }

/** a team project with Bob in it (one only I see goes under 내 프로젝트, docs/DECISIONS.md "Projects: a place of their
 * own"), or a personal one */
async function project(page: Page, name: string, scope: 'team' | 'personal'): Promise<string> {
  const participants = scope === 'team' ? [{ subjectType: 'user', subjectId: 'bob' }] : []
  const r = await page.request.post('/api/projects', { headers: H, data: { name, scope, instructions: '', participants } })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}

test('a computer: the rail\'s 프로젝트 opens the list with 팀 and 내 sections; a row opens its page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  const team = await project(page, 'Acme launch', 'team')
  await project(page, 'Acme notes', 'personal')
  // made over the API: a reload reads the list again
  await page.reload()
  await openRail(page, 'projects')
  await expect(page).toHaveURL(/\/projects$/)
  const panel = page.getByTestId('projects-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('projects-panel-new')).toContainText(t['projects.new'])
  await expect(panel.getByTestId('projects-team').getByTestId('projects-panel-label')).toContainText(t['projectsPanel.team'])
  await expect(panel.getByTestId('projects-mine').getByTestId('projects-panel-label')).toContainText(t['projectsPanel.mine'])
  await expect(panel.getByTestId('projects-team').getByTestId('projects-panel-name')).toContainText(['Acme launch'])
  await expect(panel.getByTestId('projects-mine').getByTestId('projects-panel-name')).toContainText(['Acme notes'])
  await expect(panel.getByTestId('projects-panel-row').first().getByTestId('projects-panel-meta')).not.toBeEmpty()
  // the 트리나 list holds no projects
  await expect(page.getByTestId('trina-panel')).toHaveCount(0)
  await panel.getByTestId('projects-panel-row').filter({ hasText: 'Acme launch' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${team}$`))
  await expect(page.getByTestId('rail-projects')).toHaveAttribute('aria-current', 'page')
  await expect(panel.getByTestId('projects-panel-row').filter({ hasText: 'Acme launch' })).toHaveAttribute('aria-current', 'page')
})

// QA TC-1089: the mock's GET /api/chats/groups had no projectActivity, so every row said "No chats yet"; the server
// counts my chats and the project's shared ones (also those of others I never wrote in), never another person's private one
test('each row counts the chats I can open there: mine and the shared ones, never someone else\'s private one', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  const team = await project(page, 'Acme launch', 'team')
  await project(page, 'Acme quiet', 'team')
  for (const title of ['Launch email', 'Launch plan']) expect((await page.request.post('/api/chats', { headers: H, data: { title, projectId: team } })).ok()).toBeTruthy()
  expect((await page.request.post('/api/chats', { headers: H, data: { title: 'Pricing notes', projectId: team, private: true } })).ok()).toBeTruthy()
  // Bob, who never wrote there: Olga's two shared chats count for him, her private one does not
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 900 } })
  const bob = await ctx.newPage()
  try {
    await signIn(bob, { username: 'bob', password: 'bob password 1' })
    await bob.goto('/projects')
    const row = bob.getByTestId('projects-panel-row').filter({ hasText: 'Acme launch' })
    await expect(row.getByTestId('projects-panel-meta')).toContainText(translate('ko', 'projectsPanel.chats', { n: 2 }))
  } finally { await ctx.close() }
  await page.goto('/projects')
  const panel = page.getByTestId('projects-panel')
  await expect(panel.getByTestId('projects-panel-row').filter({ hasText: 'Acme launch' }).getByTestId('projects-panel-meta')).toContainText(translate('ko', 'projectsPanel.chats', { n: 3 }))
  await expect(panel.getByTestId('projects-panel-row').filter({ hasText: 'Acme quiet' }).getByTestId('projects-panel-meta')).toContainText(t['projectsPanel.noChats'])
})

test('a computer: + 새 프로젝트 makes a project by its name and opens its page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  await openRail(page, 'projects')
  const panel = page.getByTestId('projects-panel')
  await panel.getByTestId('projects-panel-new').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('project-who')).toBeVisible()
  await expect(dialog.getByTestId('project-create')).toBeDisabled()
  await dialog.getByTestId('project-name').fill('Acme kickoff')
  await dialog.getByTestId('project-create').click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/projects\/[^/?]+$/)
  await expect(page.getByRole('heading', { name: 'Acme kickoff' }).first()).toBeVisible()
  await expect(panel.getByTestId('projects-panel-name').filter({ hasText: 'Acme kickoff' })).toHaveCount(1)
})

test('a phone: the 프로젝트 tab shows the list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await project(page, 'Acme launch', 'team')
  await page.reload()
  await page.getByTestId('tab-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByTestId('tab-projects')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('topbar-title')).toHaveText(t['projects.title'])
  const list = page.getByTestId('phone-projects-list')
  await expect(list.getByTestId('projects-panel-new')).toBeVisible()
  await expect(list.getByTestId('projects-team').getByTestId('projects-panel-name')).toContainText(['Acme launch'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

// docs/decisions/20261121-projects-trash-out-of-list.md (the owner, 2026-11-21: "지운 게 저렇게 보여야해?"): a project in
// the trash is no row of any group nor a card on the page; one quiet 휴지통 row at the bottom of the list, for whoever can
// restore one, opens a list of them with who moved each there and 되돌리기
const BOB = { username: 'bob', password: 'bob password 1' }
const DANA = { username: 'dana', password: 'dana password 1' }
/** the Projects list on screen: the panel beside the rail on a computer, the 프로젝트 tab on a phone */
async function projectsList(page: Page, width: number) {
  if (width < 768) {
    await page.getByTestId('tab-projects').click()
    return page.getByTestId('phone-projects-list')
  }
  await openRail(page, 'projects')
  return page.getByTestId('projects-panel')
}

test('a project in the trash leaves the list and the page\'s cards; 휴지통 at the bottom restores it, at 390 and 1440', async ({ page }) => {
  for (const [width, height] of [[390, 844], [1440, 900]] as const) {
    await page.setViewportSize({ width, height })
    await reset(page)
    await signIn(page)
    await project(page, 'Acme live', 'team')
    const id = await project(page, 'Acme binned', 'team')
    expect((await page.request.delete(`/api/projects/${id}`, { headers: H })).status()).toBe(204)
    await page.reload()
    const list = await projectsList(page, width)
    await expect(list.getByTestId('projects-panel-name').filter({ hasText: 'Acme live' })).toHaveCount(1)
    // not a row of any group (she made it and is one of its members: before, it stayed under 팀 프로젝트, QA TC-1060)
    await expect(list.getByTestId('projects-panel-row').filter({ hasText: 'Acme binned' })).toHaveCount(0)
    await expect(list.getByTestId('projects-panel-meta').filter({ hasText: t['chat.project.inTrash'] })).toHaveCount(0)
    // nor a card on the page beside it
    if (width >= 768) {
      await expect(page.getByTestId('project-card').filter({ hasText: 'Acme live' })).toHaveCount(1)
      await expect(page.getByTestId('project-card').filter({ hasText: 'Acme binned' })).toHaveCount(0)
    }
    // one quiet 휴지통 row with the count, at the bottom
    const row = list.getByTestId('projects-trash-row')
    await expect(row).toContainText(t['projectsPanel.trash'])
    await expect(row.getByTestId('projects-trash-count')).toHaveText('1')
    // a screen reader hears the count with its noun ("휴지통, 프로젝트 1개"); the number alone is hidden from it
    await expect(row).toHaveAccessibleName(new RegExp(`^${t['projectsPanel.trash']}\\s?, ${translate('ko', 'projectsPanel.trashCount', { n: 1 })}$`))
    await row.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(t['projectsPanel.trashTitle'])
    const item = dialog.getByTestId('projects-trash-item')
    await expect(item.getByTestId('projects-trash-name')).toHaveText('Acme binned')
    await expect(item.getByTestId('projects-trash-moved')).toContainText('Olga')
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/trash-dialog-${width}.png` })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await item.getByTestId('projects-trash-restore').click()
    // back at once: the dialog says the trash is empty, the row goes, the project is in its group again
    await expect(dialog.getByTestId('projects-trash-empty')).toHaveText(t['projectsPanel.trashEmpty'])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(list.getByTestId('projects-trash-row')).toHaveCount(0)
    await expect(list.getByTestId('projects-team').getByTestId('projects-panel-name').filter({ hasText: 'Acme binned' })).toHaveCount(1)
    const r = await page.request.get(`/api/projects/${id}`)
    expect(r.ok()).toBeTruthy()
    expect(((await r.json()) as { inTrash?: boolean }).inTrash ?? false).toBe(false)
  }
})

test('the 휴지통 row by role: the owner, an admin and a member who made it see it; any other member does not, and their link still opens the note', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page, { withAdmin: true })
  await signIn(page)
  // Olga's project with Bob in it, and Bob's own one (Olga moves both to the trash)
  const olgas = await project(page, 'Olga binned', 'team')
  const ctxB = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 900 } })
  const bob = await ctxB.newPage()
  try {
    await signIn(bob, BOB)
    const r = await bob.request.post('/api/projects', { headers: H, data: { name: 'Bob binned', scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'olga' }] } })
    expect(r.status()).toBe(201)
    const bobs = ((await r.json()) as { id: string }).id
    for (const id of [olgas, bobs]) expect((await page.request.delete(`/api/projects/${id}`, { headers: H })).status()).toBe(204)

    // Bob: neither is a row; 휴지통 lists both (he was a member of each) with 되돌리기 on his own one only
    await bob.goto('/projects')
    const panelB = bob.getByTestId('projects-panel')
    await expect(panelB.getByTestId('projects-panel-row')).toHaveCount(0)
    await panelB.getByTestId('projects-trash-row').click()
    const items = bob.getByRole('dialog').getByTestId('projects-trash-item')
    await expect(items).toHaveCount(2)
    await expect(items.filter({ hasText: 'Bob binned' }).getByTestId('projects-trash-restore')).toBeVisible()
    await expect(items.filter({ hasText: 'Olga binned' }).getByTestId('projects-trash-restore')).toHaveCount(0)
    // Bob restores his own; Olga's stays, and it is not his to restore: no 휴지통 row for him any more
    await items.filter({ hasText: 'Bob binned' }).getByTestId('projects-trash-restore').click()
    await expect(items).toHaveCount(1)
    await bob.keyboard.press('Escape')
    await expect(panelB.getByTestId('projects-trash-row')).toHaveCount(0)
    await expect(panelB.getByTestId('projects-panel-name').filter({ hasText: 'Bob binned' })).toHaveCount(1)
    await expect(panelB.getByTestId('projects-panel-row').filter({ hasText: 'Olga binned' })).toHaveCount(0)
    // a direct link to it still opens the in-the-trash note, saying who can restore it
    await bob.goto(`/projects/${olgas}`)
    await expect(bob.getByTestId('project-in-trash')).toBeVisible()
    await expect(bob.getByTestId('project-trash-restores')).toBeVisible()
  } finally { await ctxB.close() }

  // Dana, an admin who is in neither: 휴지통 with Olga's one, 되돌리기 there
  const ctxD = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 900 } })
  const dana = await ctxD.newPage()
  try {
    await signIn(dana, DANA)
    await dana.goto('/projects')
    const panelD = dana.getByTestId('projects-panel')
    await expect(panelD.getByTestId('projects-panel-row').filter({ hasText: 'Olga binned' })).toHaveCount(0)
    await expect(panelD.getByTestId('projects-trash-count')).toHaveText('1')
    await panelD.getByTestId('projects-trash-row').click()
    await expect(dana.getByRole('dialog').getByTestId('projects-trash-item').filter({ hasText: 'Olga binned' }).getByTestId('projects-trash-restore')).toBeVisible()
  } finally { await ctxD.close() }
})
