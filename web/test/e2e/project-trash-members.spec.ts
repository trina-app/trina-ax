// A team project in the trash (docs/DECISIONS.md "A team project in the trash: its members keep its card", QA TC-1060,
// TC-1061, TC-1062, TC-1063, TC-1064, TC-1066), at 1440 and 390 px, with axe on each screen:
// - Bob, a member of Olga's "Spring Launch": its card stays, "in the trash"; its page says who moved it there and that an
//   admin or Olga can restore it, with no buttons, contents or Trina history; a link to its shared chat says the same;
// - Bob's own "Bob Notes": the card's "Move to trash", then Restore on its page and in Files › Trash ("Bob Notes ·
//   Projects", the project icon);
// - Dana, an admin who is not a member: no card of it on Projects; Files › Trash has it with Restore and Delete for good,
//   whose confirm says where its shared chats go.
// SHOTS_DIR set: each of those screens in light and dark.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.en
const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const DANA = { username: 'dana', password: 'dana password 1' }
const OLGA = { username: 'olga', password: 'correct horse battery' }

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}
/** the screen in light and dark (SHOTS_DIR), then back to light */
async function shoot(page: Page, name: string, vp: string) {
  const dir = process.env.SHOTS_DIR
  if (!dir) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: `${dir}/${name}-${vp}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
async function person(browser: Browser, use: object, who: typeof BOB) {
  const ctx = await browser.newContext({ ...use, locale: 'en-US', reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await signIn(page, who)
  return page
}

const VPS = [
  { name: '1440', phone: false, use: { viewport: { width: 1440, height: 900 } } },
  { name: '390', phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
]

for (const vp of VPS) {
  test(`a team project in the trash, as a member, its creator and an admin at ${vp.name}`, async ({ page, browser }) => {
    test.setTimeout(120_000)
    await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
    // Olga's project with Bob in it, a shared chat of hers in it, then into the trash
    const olga = await person(browser, vp.use, OLGA)
    const spring = (await (await olga.request.post('/api/projects', { headers: H, data: { name: 'Spring Launch', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: 'Launch plan: secret dates.' } })).json()) as { id: string }
    const chat = (await (await olga.request.post('/api/chats', { headers: H, data: { projectId: spring.id, title: 'Draft the launch email' } })).json()) as { id: string; shared?: unknown }
    expect(chat.shared).toBeTruthy()
    expect((await olga.request.delete(`/api/projects/${spring.id}`, { headers: H })).ok()).toBeTruthy()

    // ---- Bob, a member: the card stays, "in the trash"; the page says who moved it and who can restore it
    const bob = await person(browser, vp.use, BOB)
    const notes = (await (await bob.request.post('/api/projects', { headers: H, data: { name: 'Bob Notes', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'olga' }], instructions: '' } })).json()) as { id: string }
    await bob.goto('/projects')
    const row = (name: string) => bob.getByTestId(vp.phone ? 'projects-panel-row' : 'project-card').filter({ hasText: name })
    await expect(row('Spring Launch')).toContainText(t['chat.project.inTrash'])
    await expect(row('Spring Launch')).not.toContainText('secret dates')
    // the card's menu moves Bob's own project to the trash, and says so (QA TC-1064); a phone's list has no card menu
    if (!vp.phone) {
      await row('Bob Notes').hover()
      await row('Bob Notes').getByTestId('project-card-menu').click()
      await expect(bob.getByTestId('project-card-delete')).toHaveText(t['projects.moveToTrash'])
      await bob.getByTestId('project-card-delete').click()
      await expect(bob.getByRole('dialog')).toContainText(t['projects.trashBody'])
      await bob.getByTestId('dialog-confirm').click()
    } else {
      expect((await bob.request.delete(`/api/projects/${notes.id}`, { headers: H })).ok()).toBeTruthy()
      await bob.reload()
    }
    await expect(row('Bob Notes')).toContainText(t['chat.project.inTrash'])
    await audit(bob, 'member projects')
    await shoot(bob, 'member-projects', vp.name)

    await bob.goto(`/projects/${spring.id}`)
    const note = bob.getByTestId('project-in-trash')
    await expect(note).toContainText(t['projects.inTrash'])
    await expect(bob.getByTestId('project-trashed-by')).toContainText('Moved to the trash by Olga on')
    await expect(bob.getByTestId('project-trash-restores')).toHaveText(translate('en', 'projects.trashRestoresCreator', { name: 'Olga' }))
    for (const id of ['project-restore', 'project-delete-for-good', 'project-chats', 'composer-input', 'project-members']) await expect(bob.getByTestId(id)).toHaveCount(0)
    await expect(bob.locator('body')).not.toContainText('secret dates')
    await audit(bob, 'member page')
    await shoot(bob, 'member-page', vp.name)

    // the shared chat's link (QA TC-1060)
    await bob.goto(`/c/${chat.id}`)
    await expect(bob.getByTestId('chat-not-found')).toContainText(translate('en', 'chat.projectInTrash', { name: 'Spring Launch' }))
    await expect(bob.getByTestId('chat-project-trash-restores')).toHaveText(translate('en', 'projects.trashRestoresCreator', { name: 'Olga' }))
    await expect(bob.getByTestId('chat-not-found-why')).toHaveCount(0)
    await audit(bob, 'member chat link')
    await shoot(bob, 'member-chat-link', vp.name)
    await bob.getByTestId('chat-project-open').click()
    await expect(bob.getByTestId('project-in-trash')).toBeVisible()

    // ---- Bob, the creator of Bob Notes: Restore on its page and in Files › Trash (QA TC-1062)
    await bob.goto(`/projects/${notes.id}`)
    await expect(bob.getByTestId('project-restore')).toBeVisible()
    await expect(bob.getByTestId('project-delete-for-good')).toHaveCount(0)
    await audit(bob, 'creator page')
    await shoot(bob, 'creator-page', vp.name)
    await bob.goto('/files?view=trash')
    const notesRow = bob.locator('[data-testid="trash-item"][data-kind="project"]').filter({ hasText: 'Bob Notes' })
    await expect(notesRow.getByTestId('trash-name')).toHaveText('Bob Notes')
    await expect(notesRow.getByTestId('trash-where')).toHaveText(t['projects.title'])
    await expect(notesRow.getByTestId('trash-project-delete')).toHaveCount(0)
    // Spring Launch is not Bob's to restore: not in his trash
    await expect(bob.locator('[data-testid="trash-item"]').filter({ hasText: 'Spring Launch' })).toHaveCount(0)
    await audit(bob, 'creator files trash')
    await shoot(bob, 'creator-files-trash', vp.name)
    await notesRow.getByTestId('trash-restore').click()
    await expect(notesRow).toHaveCount(0)
    await bob.goto(`/projects/${notes.id}`)
    await expect(bob.getByTestId('project-in-trash')).toHaveCount(0)
    await expect(bob.getByTestId('project-chats')).toBeVisible()

    // ---- Dana, an admin who is not a member: no card; Files › Trash has it (QA TC-1061)
    const dana = await person(browser, vp.use, DANA)
    await dana.goto('/projects')
    await expect(dana.getByText('Spring Launch')).toHaveCount(0)
    await dana.goto('/files?view=trash')
    const springRow = dana.locator('[data-testid="trash-item"][data-kind="project"]').filter({ hasText: 'Spring Launch' })
    await expect(springRow.getByTestId('trash-where')).toHaveText(t['projects.title'])
    await expect(springRow.getByTestId('trash-restore')).toBeVisible()
    await audit(dana, 'admin files trash')
    await shoot(dana, 'admin-files-trash', vp.name)
    if (!vp.phone) {
      // Delete for good: the project's own confirm, with where its shared chats go (QA TC-1063); cancelled here
      await springRow.getByTestId('trash-project-delete').click()
      await expect(dana.getByRole('dialog')).toContainText(translate('en', 'projects.deleteForGoodTitle', { name: 'Spring Launch' }))
      await expect(dana.getByTestId('project-delete-shared')).toHaveText(translate('en', 'projects.deleteForGoodShared', { days: 7, trash: t['sidebar.trash'] }))
      await shoot(dana, 'admin-delete-confirm', vp.name)
      await dana.keyboard.press('Escape')
    }
    // its row opens its page: who moved it, Restore and Delete for good; no Trina history (QA TC-1066)
    await dana.goto(`/projects/${spring.id}`)
    await expect(dana.getByTestId('project-restore')).toBeVisible()
    await expect(dana.getByTestId('project-delete-for-good')).toBeVisible()
    await expect(dana.getByTestId('project-chats')).toHaveCount(0)
    await shoot(dana, 'admin-page', vp.name)
    await dana.getByTestId('project-restore').click()
    await expect(dana.getByTestId('project-in-trash')).toHaveCount(0)
    // back: Bob reads it again
    await bob.goto(`/projects/${spring.id}`)
    await expect(bob.getByTestId('project-chats')).toBeVisible()
    for (const p of [olga, bob, dana]) await p.context().close()
  })
}
