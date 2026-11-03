// Admin › Folder permissions › By person (read only): choose a person and see every team folder they and their AI can
// see, with the access and the reason in words; someone new (role and groups as in the invite dialog); a folder shown
// only on the way to one below; a disabled person as if enabled again; the Members links and the invite preview;
// pages; narrowing to a folder; errors; 375px in Korean and Spanish; the keyboard alone. The answers are the server's
// (the mock runs server/src/policy/access.ts and server/src/admin/access-rows.ts).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.ko
const H = { [CSRF_HEADER]: '1' }
const SHOTS = process.env.ACCESS_SHOTS

const call = async (page: Page, method: 'post' | 'patch', url: string, data: unknown) => {
  const r = await page.request[method](url, { headers: H, data })
  expect(r.ok(), `${method} ${url}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}
const everyone = (access: 'none' | 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })

/**
 * Bob (member, group 영업팀): shared (everyone writes), skills (everyone reads, Bob writes: a member who manages team
 * skills), projects/apollo (Bob writes; a team project), marketing (members read), secret (nobody), connected/nas
 * (영업팀 reads), the group's folder; finance (재무팀 reads) and docs (no rule) he cannot see. Dan: disabled, 영업팀.
 */
async function team(page: Page) {
  const g = await call(page, 'post', '/api/admin/groups', { name: '영업팀', memberIds: [] })
  await call(page, 'patch', '/api/admin/users/bob', { groupIds: [g.id] })
  await call(page, 'post', '/__test/file', { path: 'projects/apollo/plan.md', text: 'plan' })
  await call(page, 'post', '/__test/file', { path: 'connected/nas/readme.md', text: 'nas' })
  await call(page, 'post', '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read'), { subjectType: 'user', subjectId: 'bob', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'projects/apollo', create: true, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'marketing', create: true, rules: [{ subjectType: 'role', subjectId: 'member', access: 'read' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'secret', create: true, rules: [everyone('none')] })
  await call(page, 'post', '/api/admin/folders', { path: 'connected/nas', create: true, rules: [{ subjectType: 'group', subjectId: g.id, access: 'read' }] })
  await call(page, 'post', '/api/projects', { name: 'Apollo', folderPath: 'projects/apollo' })
  await call(page, 'post', '/api/admin/users', { username: 'dan', name: 'Dan', role: 'member', groupIds: [g.id], temporaryPassword: 'tiger4271x' })
  await call(page, 'patch', '/api/admin/users/dan', { status: 'disabled' })
  return g as { id: string }
}

const row = (page: Page, path: string) => page.getByTestId('access-answer').locator(`[data-testid="access-row"][data-path="${path}"]`)
const option = (page: Page, person: string) => page.getByTestId('access-person-option').and(page.locator(`[data-person="${person}"]`))
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

test('by person: every team folder with its access and why, folded hidden folders, the rule editor, links and Back', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders')
  await page.getByRole('tab', { name: t['accessView.byPerson'], exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/folders\?view=people$/)
  await expect(page.getByTestId('access-answer')).toContainText(t['accessView.pick'])

  // the list: someone new first, the active people, the disabled one apart
  const list = page.getByRole('listbox', { name: t['accessView.people'] })
  await expect(list.getByRole('option')).toHaveCount(4)
  await expect(list.getByRole('option').first()).toContainText(t['accessView.newPerson'])
  await expect(list.getByRole('group', { name: t['accessView.off'] }).getByRole('option')).toHaveText([/Dan/])
  await page.getByTestId('access-person-search').fill('영업')
  await expect(list.getByRole('option')).toHaveCount(2) // Bob and Dan, by their group
  await page.getByTestId('access-person-search').fill('')

  await option(page, 'bob').click()
  await expect(page).toHaveURL(/view=people&person=bob/)
  await expect(option(page, 'bob')).toHaveAttribute('aria-selected', 'true')
  const summary = page.getByTestId('access-summary')
  await expect(summary).toContainText('Bob 님과 그 AI는 팀 폴더 6개를 볼 수 있고, 그중 4개에 쓸 수 있어요.')
  await expect(summary).toContainText(translate('ko', 'accessView.summaryListed', { n: 3 }))
  // said to screen readers too
  await expect(page.locator('[role="status"][aria-live="polite"]').filter({ hasText: 'Bob 님과 그 AI는 팀 폴더 6개' })).toHaveCount(1)

  const reason = (p: string) => row(page, p).getByTestId('access-reason')
  await expect(row(page, 'shared')).toHaveAttribute('data-level', 'write')
  await expect(reason('shared')).toHaveText('이 폴더의 규칙 · 모두: 읽기·쓰기')
  await expect(reason('groups/영업팀')).toHaveText('이 폴더의 규칙 · 영업팀 그룹: 읽기·쓰기')
  await expect(reason('marketing')).toHaveText('이 폴더의 규칙 · 팀원 전체: 읽기')
  await expect(reason('projects/apollo')).toHaveText('이 폴더의 규칙 · Bob 님: 읽기·쓰기')
  await expect(row(page, 'projects/apollo')).toContainText(translate('ko', 'accessView.projectOf', { name: 'Apollo' }))
  // shown only on the way to a folder below
  await expect(row(page, 'projects')).toHaveAttribute('data-level', 'listed')
  await expect(reason('projects')).toHaveText('아래 projects/apollo 때문에 폴더 이름만 보여요')
  await expect(row(page, 'projects')).toContainText(t['accessView.level.listed'])
  await expect(reason('connected')).toHaveText('아래 connected/nas 때문에 폴더 이름만 보여요')
  // a member who writes in skills/ manages team skills: the one warning
  await expect(row(page, 'skills').getByTestId('access-risk')).toContainText(t['accessView.risk.skills'])
  await expect(page.getByTestId('access-risk')).toHaveCount(1)
  await expect(reason('users/bob')).toHaveText(t['accessView.why.ownPersonal'])
  // grouped by kind, in order
  await expect(page.getByTestId('access-section')).toHaveText([/^팀 폴더/, /^그룹 폴더/, /^프로젝트/, /^연결 폴더/, /^스킬/, /^본인 개인 폴더/])

  // folders he cannot see are folded
  await expect(row(page, 'finance')).toBeHidden()
  const toggle = page.getByTestId('access-hidden-toggle')
  await expect(toggle).toHaveText(translate('ko', 'accessView.hidden', { n: 3 }))
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(reason('finance')).toHaveText(t['accessView.why.noRule'])
  await expect(reason('secret')).toHaveText('이 폴더의 규칙 · 모두: 권한 없음')
  await expect(row(page, 'docs')).toHaveAttribute('data-level', 'none')

  // "View or change rules" opens the folder's own editor; a save shows at once here
  const edit = row(page, 'marketing').getByRole('button', { name: translate('ko', 'accessView.editNamed', { path: 'marketing' }), exact: true })
  await edit.click()
  const dialog = page.getByRole('dialog', { name: translate('ko', 'rules.editTitle', { path: 'marketing' }) })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel(t['rules.access'], { exact: true }).selectOption('none')
  await page.getByTestId('rules-save').click()
  await expect(dialog).toHaveCount(0)
  await expect(row(page, 'marketing')).toHaveAttribute('data-level', 'none')
  await expect(summary).toContainText('Bob 님과 그 AI는 팀 폴더 5개를 볼 수 있고, 그중 4개에 쓸 수 있어요.')
  await expect(edit).toBeFocused()
  // no edit for a personal folder (rules there never apply)
  await expect(row(page, 'users/bob').getByTestId('access-edit')).toHaveCount(0)

  // Back: the empty choice, then the folder view
  await page.goBack()
  await expect(page).toHaveURL(/view=people$/)
  await expect(page.getByTestId('access-answer')).toContainText(t['accessView.pick'])
  await page.goBack()
  await expect(page.getByTestId('folder-list')).toBeVisible()
  await page.goForward()
  await page.goForward()
  await expect(summary).toContainText('Bob 님과 그 AI는')
  expect(realErrors(errors)).toEqual([])
})

test('someone new: the invite\'s choices, worked out by the server; an admin sees all but personal folders', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const g = await team(page)
  await page.goto('/admin/folders?view=people')
  await option(page, 'new').click()
  await expect(page).toHaveURL(/view=people&new=1$/)
  const summary = page.getByTestId('access-summary')
  await expect(summary).toContainText('새로 들어올 사람과 그 AI는 팀 폴더 3개를 볼 수 있고, 그중 1개에 쓸 수 있어요.')
  // no personal folder yet, and no person rule can name them
  await expect(row(page, 'users/bob')).toHaveCount(0)
  await expect(row(page, 'projects/apollo')).toBeHidden()

  const setup = page.getByTestId('access-new-setup')
  await setup.getByRole('checkbox', { name: '영업팀' }).check()
  await expect(page).toHaveURL(new RegExp(`new=1&groups=${g.id}`))
  await expect(summary).toContainText('새로 들어올 사람과 그 AI는 팀 폴더 5개를 볼 수 있고, 그중 2개에 쓸 수 있어요.')
  await expect(row(page, 'groups/영업팀')).toHaveAttribute('data-level', 'write')

  await setup.getByRole('combobox', { name: t['members.role'], exact: true }).selectOption('admin')
  await expect(page).toHaveURL(/new=1&role=admin/)
  await expect(row(page, 'secret').getByTestId('access-reason')).toHaveText(t['accessView.why.admin'])
  await expect(page.getByTestId('access-hidden-toggle')).toHaveCount(0)

  // a reload keeps the choice
  await page.reload()
  await expect(setup.getByRole('combobox', { name: t['members.role'], exact: true })).toHaveValue('admin')
  await expect(setup.getByRole('checkbox', { name: '영업팀' })).toBeChecked()
  await expect(option(page, 'new')).toHaveAttribute('aria-selected', 'true')
  expect(realErrors(errors)).toEqual([])
})

test('a disabled person: what they would get if enabled again', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders?view=people&person=dan')
  await expect(page.getByTestId('access-off-note')).toHaveText(t['accessView.offNote'])
  await expect(page.getByTestId('access-summary')).toContainText('다시 활성화하면 Dan 님과 그 AI는 팀 폴더 5개를 볼 수 있고, 그중 2개에 쓸 수 있어요.')
  await expect(row(page, 'users/dan').getByTestId('access-reason')).toHaveText(t['accessView.why.ownPersonal'])
})

test('Members: "Folders they see" opens the person; the invite previews what someone new will see', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const g = await team(page)
  await page.goto('/admin/members')
  await page.getByRole('link', { name: translate('ko', 'accessView.membersLinkFor', { name: 'Bob' }), exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/folders\?view=people&person=bob$/)
  await expect(option(page, 'bob')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('access-summary')).toContainText('Bob 님과 그 AI는 팀 폴더 6개')

  await page.goto('/admin/members')
  await page.getByTestId('invite-new').click()
  const dialog = page.getByRole('dialog', { name: t['members.invite'] })
  await dialog.getByRole('checkbox', { name: '영업팀' }).check()
  const preview = dialog.getByTestId('new-person-preview-toggle')
  await expect(preview).toHaveAttribute('aria-expanded', 'false')
  await preview.click()
  await expect(dialog.getByTestId('access-summary')).toContainText('새로 들어올 사람과 그 AI는 팀 폴더 5개를 볼 수 있고, 그중 2개에 쓸 수 있어요.')
  // read only: no rule editor from the dialog
  await expect(dialog.getByTestId('access-edit')).toHaveCount(0)
  // a group changed while open: the same answer again
  await dialog.getByRole('checkbox', { name: '영업팀' }).uncheck()
  await expect(dialog.getByTestId('access-summary')).toContainText('새로 들어올 사람과 그 AI는 팀 폴더 3개를 볼 수 있고, 그중 1개에 쓸 수 있어요.')
  await dialog.getByRole('checkbox', { name: '영업팀' }).check()
  await expect(dialog.getByTestId('access-summary')).toContainText('팀 폴더 5개')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/invite-preview-1360.png` })
  await dialog.getByTestId('new-person-preview-full').click()
  await expect(page).toHaveURL(new RegExp(`/admin/folders\\?view=people&new=1&groups=${g.id}$`))
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('access-summary')).toContainText('팀 폴더 5개')
  expect(realErrors(errors)).toEqual([])
})

test('pages of rows, narrowing to a folder, and a failed answer to try again', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  // three rows a page (the server's own paging; the screen asks for the default)
  await page.route('**/api/admin/access/people/**', (r) => {
    const u = new URL(r.request().url())
    u.searchParams.set('limit', '3')
    return r.continue({ url: u.toString() })
  })
  await page.goto('/admin/folders?view=people&person=bob')
  const summary = page.getByTestId('access-summary')
  await expect(summary).toContainText(translate('ko', 'accessView.summaryPartial', { loaded: 3, total: 13 }))
  const more = page.getByTestId('access-more')
  for (let n = 6; n <= 12; n += 3) {
    await more.click()
    await expect(page.getByText(translate('ko', 'accessView.loaded', { n, total: 13 }), { exact: true })).toBeVisible()
  }
  await more.click()
  await expect(more).toHaveCount(0)
  await expect(page.getByText(translate('ko', 'accessView.loaded', { n: 13, total: 13 }))).toBeFocused()
  await expect(summary).toContainText('Bob 님과 그 AI는 팀 폴더 6개를 볼 수 있고, 그중 4개에 쓸 수 있어요.')
  await expect(summary).not.toContainText(translate('ko', 'accessView.summaryPartial', { loaded: 13, total: 13 }))
  await page.unroute('**/api/admin/access/people/**')

  // one part of the tree
  await page.getByTestId('access-prefix').fill('/projects/')
  await page.getByTestId('access-prefix-apply').click()
  await expect(page).toHaveURL(/person=bob&prefix=projects$/)
  await expect(page.getByTestId('access-row')).toHaveCount(2)
  await expect(summary).toContainText(translate('ko', 'accessView.summaryPrefix', { path: 'projects' }))
  await page.getByTestId('access-prefix').fill('nowhere')
  await page.getByTestId('access-prefix').press('Enter')
  await expect(page.getByTestId('access-answer')).toContainText(translate('ko', 'accessView.emptyPrefix', { path: 'nowhere' }))
  await page.getByTestId('access-prefix').fill('../x')
  await page.getByTestId('access-prefix').press('Enter')
  await expect(page.getByRole('alert').filter({ hasText: t['accessView.prefixBad'] })).toBeVisible()
  await page.getByTestId('access-prefix-clear').click()
  await expect(page).toHaveURL(/person=bob$/)

  // the server cannot be reached: say so, try again
  await page.route('**/api/admin/access/people/**', (r) => r.abort())
  await page.reload()
  const note = page.getByTestId('access-answer').getByRole('alert')
  await expect(note).toContainText(t['error.network'])
  await page.unroute('**/api/admin/access/people/**')
  await note.getByRole('button', { name: t['common.retry'], exact: true }).click()
  await expect(summary).toContainText('Bob 님과 그 AI는')
  expect(realErrors(errors).filter((e) => !/ERR_FAILED|Failed to load resource/.test(e))).toEqual([])
})

test('the keyboard alone: search, choose, read the answer, open and close a folder\'s rules', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders?view=people')
  await page.getByTestId('access-person-search').focus()
  await page.keyboard.type('Bo')
  await page.keyboard.press('ArrowDown')
  await expect(option(page, 'bob')).toBeFocused()
  // the focus ring is not cut off by the scrolling list
  await expect(option(page, 'bob')).toHaveCSS('outline-offset', '-2px')
  await page.keyboard.press('ArrowUp')
  await expect(page.getByTestId('access-person-search')).toBeFocused()
  for (let i = 0; i < 2; i++) await page.keyboard.press('Backspace')
  await page.keyboard.press('ArrowDown')
  await expect(option(page, 'new')).toBeFocused()
  await page.keyboard.press('End')
  await expect(option(page, 'dan')).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await expect(option(page, 'bob')).toBeFocused()
  // moving alone loads nothing; Enter chooses
  await expect(page).toHaveURL(/view=people$/)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/person=bob/)
  await expect(page.getByTestId('access-summary')).toContainText('Bob 님과 그 AI는')
  await expect(option(page, 'bob')).toBeFocused()
  // one stop for the whole list, then the answer
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('access-prefix')).toBeFocused()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(row(page, 'marketing').getByTestId('access-edit').filter({ visible: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(row(page, 'marketing').getByTestId('access-edit').filter({ visible: true })).toBeFocused()
  // the folded folders open from the keyboard
  await page.getByTestId('access-hidden-toggle').focus()
  await page.keyboard.press('Enter')
  await expect(row(page, 'finance')).toBeVisible()
  // Shift+Tab from the answer back to the chosen person
  await option(page, 'bob').focus()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByTestId('access-person-search')).toBeFocused()
})

test('a big team: the list shows the first hundred and says how many more; typing narrows; a linked person is in it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  for (let i = 0; i < 110; i++) {
    const n = String(i).padStart(3, '0')
    await call(page, 'post', '/api/admin/users', { username: `p${n}`, name: `Person ${n}`, role: 'member', groupIds: [], temporaryPassword: 'tiger4271x' })
  }
  await page.goto('/admin/folders?view=people&person=p109')
  const options = page.getByTestId('access-person-option')
  // someone new, 100 people, and the chosen one past them
  await expect(options).toHaveCount(102)
  await expect(option(page, 'p109')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(translate('ko', 'accessView.moreMatches', { n: 11 }), { exact: true })).toBeVisible()
  await page.getByTestId('access-person-search').fill('Person 10')
  await expect(options).toHaveCount(10) // Person 100 … 109
  await page.getByTestId('access-person-search').fill('nobody here')
  await expect(page.getByText(t['accessView.noMatch'], { exact: true })).toBeVisible()
  await expect(page.getByRole('listbox')).toHaveCount(0)
})

for (const locale of ['ko', 'es'] as const) {
  test(`375px wide: the list above the answer, nothing wider than the screen (${locale})`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    await team(page)
    await page.goto('/admin/folders?view=people')
    const L = DICTS[locale]
    await expect(page.getByRole('tab', { name: L['accessView.byPerson'], exact: true })).toHaveAttribute('aria-selected', 'true')
    await option(page, 'bob').click()
    await expect(page.getByTestId('access-summary')).toBeVisible()
    await page.getByTestId('access-hidden-toggle').click()
    await expect(row(page, 'finance')).toBeVisible()
    const list = await page.getByTestId('access-person-list').boundingBox()
    const answer = await page.getByTestId('access-answer').boundingBox()
    expect(answer!.y).toBeGreaterThanOrEqual(list!.y + list!.height)
    await noOverflow(page)
    // each row stays inside the card
    for (const r of await page.getByTestId('access-row').all()) {
      const b = (await r.boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(375)
    }
    await option(page, 'new').click()
    await expect(page.getByTestId('access-new-setup')).toBeVisible()
    await noOverflow(page)
    if (SHOTS) {
      // the page scrolls inside the app shell, so a tall window shows all of it
      await page.setViewportSize({ width: 375, height: 2600 })
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto('/admin/folders?view=people&person=bob')
        await expect(page.getByTestId('access-summary')).toBeVisible()
        await page.getByTestId('access-hidden-toggle').click()
        await page.screenshot({ path: `${SHOTS}/person-375-${locale}-${scheme}.png` })
      }
    }
  })
}

if (SHOTS) {
  test('screenshots at 1360px, light and dark', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await team(page)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1360, height: 860 })
      await page.goto('/admin/folders?view=people&person=bob')
      await expect(page.getByTestId('access-summary')).toBeVisible()
      await page.screenshot({ path: `${SHOTS}/person-1360-${scheme}.png` })
      // the page scrolls inside the app shell, so a tall window shows all of it
      await page.setViewportSize({ width: 1360, height: 1900 })
      await page.getByTestId('access-hidden-toggle').click()
      await page.screenshot({ path: `${SHOTS}/person-1360-all-${scheme}.png` })
      await page.goto('/admin/folders?view=people&new=1')
      await expect(page.getByTestId('access-summary')).toBeVisible()
      await page.screenshot({ path: `${SHOTS}/new-1360-${scheme}.png` })
      await page.goto('/admin/folders?view=people&person=dan')
      await expect(page.getByTestId('access-summary')).toBeVisible()
      await page.screenshot({ path: `${SHOTS}/off-1360-${scheme}.png` })
    }
  })
}
