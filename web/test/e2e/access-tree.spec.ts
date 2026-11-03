// Admin › Folder permissions › By folder (stage 4): the team folder as a tree, from the top. Each row says who can open
// the folder and where that comes from (the server's GET /api/admin/access/tree over the real RuleSet in the mock);
// choosing one shows its rules and every person's access and reason; rules change from there; rules of folders not
// in the tree are folded below it. One Tab stop, the arrow keys, pages, the address, 375px.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.ko
const call = async (page: Page, method: 'post' | 'patch', url: string, data: unknown) => {
  const r = await page.request[method](url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.ok(), url).toBeTruthy()
  return r.json()
}
const everyone = (access: 'none' | 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })
const tree = (page: Page) => page.getByTestId('folder-tree')
const item = (page: Page, path: string) => tree(page).locator(`[role="treeitem"][data-path="${path}"]`)
const detail = (page: Page) => page.getByTestId('folder-detail')
const person = (page: Page, id: string) => detail(page).locator(`[data-testid="folder-person"][data-person="${id}"]`)

/** Olga (owner, 재무팀), Bob, Carol (영업팀), Dan; shared: everyone writes; skills: everyone reads, admins write;
 * skills/영업: everyone writes; projects/apollo: Dan writes, 영업팀 reads, nobody else; connected/nas: 영업팀 reads. */
async function team(page: Page) {
  const sales = await call(page, 'post', '/api/admin/groups', { name: '영업팀', memberIds: [] })
  await call(page, 'post', '/api/admin/users', { username: 'carol', name: 'Carol', role: 'member', groupIds: [sales.id], temporaryPassword: 'tiger4271x' })
  await call(page, 'post', '/api/admin/users', { username: 'dan', name: 'Dan', role: 'member', groupIds: [], temporaryPassword: 'tiger4271x' })
  await call(page, 'post', '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read'), { subjectType: 'role', subjectId: 'admin', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'skills/영업', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'projects/apollo', create: true, rules: [{ subjectType: 'user', subjectId: 'dan', access: 'write' }, { subjectType: 'group', subjectId: sales.id, access: 'read' }, everyone('none')] })
  await call(page, 'post', '/api/admin/folders', { path: 'connected/nas', create: true, rules: [{ subjectType: 'group', subjectId: sales.id, access: 'read' }] })
  await call(page, 'post', '/api/projects', { name: 'Apollo', folderPath: 'projects/apollo' })
  return sales
}

test('the tree: who sees each folder and from where, the way down to marked folders open, users/ as one row', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders')
  await expect(tree(page)).toHaveAttribute('aria-label', t['accessTree.label'])
  // open: the top, and the way to rule, group, project and connected folders
  for (const p of ['', 'groups', 'projects', 'connected', 'skills']) await expect(item(page, p)).toHaveAttribute('aria-expanded', 'true')
  for (const p of ['groups/영업팀', 'projects/apollo', 'connected/nas', 'skills/영업', 'shared', 'docs', 'finance', 'users']) await expect(item(page, p)).toBeVisible()
  await expect(item(page, 'finance')).toHaveAttribute('aria-expanded', 'false')
  await expect(item(page, 'finance/2026')).toHaveCount(0)
  await expect(item(page, 'docs')).not.toHaveAttribute('aria-expanded', /.*/)
  await expect(item(page, 'projects/apollo')).toHaveAttribute('aria-level', '3')

  // the root has no rule: only the owner and admins, and it says so; a lock where only part of the team sees
  await expect(item(page, '').getByTestId('tree-who')).toHaveText(t['accessTree.who.adminsOnly'])
  await expect(item(page, '').getByTestId('tree-source')).toHaveText(`· ${t['accessTree.source.noRule']}`)
  await expect(item(page, '')).toContainText(t['accessTree.restricted'])
  // shared: everyone writes, from its own rule; a risk, said once (not on the folders below it)
  await expect(item(page, 'shared').getByTestId('tree-who')).toHaveText(`${t['rules.everyone']} · ${t['access.write']}`)
  await expect(item(page, 'shared').getByTestId('tree-source')).toHaveText(`· ${t['accessTree.source.here']}`)
  await expect(item(page, 'shared').getByTestId('tree-risk')).toHaveText(t['accessTree.risk.everyone'])
  await expect(item(page, 'shared')).not.toContainText(t['accessTree.restricted'])
  // the team skills: everyone reads; skills/영업 lets everyone change what every AI follows
  await expect(item(page, 'skills').getByTestId('tree-who')).toHaveText(`${t['rules.everyone']} · ${t['access.read']}`)
  await expect(item(page, 'skills').getByTestId('tree-risk')).toHaveCount(0)
  await expect(item(page, 'skills/영업').getByTestId('tree-risk')).toHaveText(t['accessTree.risk.skills'])
  await expect(item(page, 'skills/영업')).toContainText(t['accessTree.kind.skills'])
  // a project: by whom, the kind with its name, a lock (Bob cannot open it)
  const apollo = item(page, 'projects/apollo')
  await expect(apollo.getByTestId('tree-who')).toHaveText(`${translate('ko', 'accessView.who.person', { name: 'Dan' })} · ${t['access.write']}, ${translate('ko', 'accessTree.who.group', { name: '영업팀', n: 1 })} · ${t['access.read']}`)
  await expect(apollo).toContainText(translate('ko', 'accessView.projectOf', { name: 'Apollo' }))
  await expect(apollo).toContainText(t['accessTree.restricted'])
  await expect(item(page, 'groups/영업팀')).toContainText(t['accessTree.kind.group'])
  await expect(item(page, 'connected/nas')).toContainText(t['accessTree.kind.connected'])
  // a folder without rules of its own is inherited, dimmed, and says from where
  await expect(item(page, 'docs')).toHaveAttribute('data-rules', '0')
  await expect(item(page, 'groups')).toHaveAttribute('data-rules', '0')
  await expect(item(page, 'shared')).not.toHaveAttribute('data-rules', '0')
  // users/: one row, never opened, how many personal folders
  const users = item(page, 'users')
  await expect(users).not.toHaveAttribute('aria-expanded', /.*/)
  await expect(users).toContainText(t['accessTree.personal.who'])
  await expect(users).toContainText(translate('ko', 'accessTree.personal.count', { n: 4 }))
  await expect(users).toContainText(t['accessTree.personal.fixed'])

  // a rule for everyone on the root: said on the root, and folders below without their own rules inherit it
  await call(page, 'post', '/api/admin/folders', { path: '', create: true, rules: [everyone('read')] })
  await page.reload()
  await expect(item(page, '').getByTestId('tree-risk')).toHaveText(t['accessTree.risk.root'])
  await expect(item(page, 'docs').getByTestId('tree-source')).toHaveText(`· ${translate('ko', 'accessTree.source.from', { folder: t['accessView.rootFolder'] })}`)
  await expect(item(page, 'docs')).not.toContainText(t['accessTree.restricted'])
  // 영업팀's folder: its group writes, everyone else reads through the root
  await expect(item(page, 'groups/영업팀').getByTestId('tree-source')).toHaveText(`· 영업팀: ${t['accessTree.source.here']} · ${t['accessTree.who.othersShort']}: ${translate('ko', 'accessTree.source.from', { folder: t['accessView.rootFolder'] })}`)
  expect(realErrors(errors)).toEqual([])
})

test('a chosen folder: its rules, each person and why; rules change from there; users/ asks nothing', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders')
  await expect(page.getByTestId('folder-detail-box')).toContainText(t['accessTree.pick'])
  await item(page, 'projects/apollo').click()
  await expect(item(page, 'projects/apollo')).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/folder=projects%2Fapollo/)
  await expect(detail(page).getByRole('heading', { name: 'projects/apollo' })).toBeVisible()
  await expect(detail(page).getByTestId('folder-rules')).toContainText(`Dan: ${t['access.write']}`)
  await expect(detail(page).getByTestId('folder-rules')).toContainText(`${t['rules.everyone']}: ${t['access.none']}`)
  // the stage 3 reasons, at this folder
  await expect(person(page, 'bob')).toHaveAttribute('data-level', 'none')
  await expect(person(page, 'bob')).toContainText(translate('ko', 'accessView.why.ruleHere', { who: t['rules.everyone'], access: t['access.none'] }))
  await expect(person(page, 'carol')).toHaveAttribute('data-level', 'read')
  await expect(person(page, 'carol')).toContainText(translate('ko', 'accessView.why.ruleHere', { who: translate('ko', 'rules.groupOf', { name: '영업팀' }), access: t['access.read'] }))
  await expect(person(page, 'dan')).toHaveAttribute('data-level', 'write')
  await expect(person(page, 'olga')).toContainText(t['accessView.why.owner'])
  await expect(page.getByTestId('folder-detail-counts')).toHaveText(translate('ko', 'accessTree.counts', { see: 3, write: 2, none: 1 }))

  // change the rules from here: everyone reads; the row and the people follow, and the lock goes
  await page.getByTestId('folder-detail-edit').click()
  const dialog = page.getByRole('dialog')
  await page.getByTestId('rule-add').click()
  await dialog.getByLabel(t['rules.who'], { exact: true }).last().selectOption('everyone')
  await page.getByTestId('rules-save').click()
  await expect(dialog).toHaveCount(0)
  await expect(person(page, 'bob')).toHaveAttribute('data-level', 'read')
  await expect(item(page, 'projects/apollo').getByTestId('tree-who')).toContainText(`${translate('ko', 'accessTree.who.others', { n: 1 })} · ${t['access.read']}`)
  await expect(item(page, 'projects/apollo')).not.toContainText(t['accessTree.restricted'])
  await expect(item(page, 'projects/apollo')).toHaveAttribute('aria-selected', 'true')

  // users/: what it is, and nothing asked of the server about it
  const asked: string[] = []
  page.on('request', (r) => r.url().includes('/api/admin/access/folder') && asked.push(r.url()))
  await item(page, 'users').click()
  await expect(page.getByTestId('folder-detail-personal')).toContainText(t['accessTree.personal.detail'])
  await expect(detail(page).getByRole('link', { name: t['accessTree.personal.byPerson'] })).toHaveAttribute('href', '/admin/folders?view=people')
  expect(asked).toEqual([])
  expect(realErrors(errors)).toEqual([])
})

test('the keyboard: one Tab stop, arrows move, open and close, typing jumps, Enter chooses', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders')
  await expect(item(page, 'projects/apollo')).toBeVisible()
  await expect(tree(page).locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1)
  await page.getByTestId('folder-rule-new').focus()
  await page.keyboard.press('Tab')
  await expect(item(page, '')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(item(page, 'connected')).toBeFocused()
  await page.keyboard.press('End')
  await expect(item(page, 'users')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(item(page, '')).toBeFocused()
  // typing jumps to a name; Right opens finance (asking the server), Right again goes into it
  await page.keyboard.type('fi')
  await expect(item(page, 'finance')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(item(page, 'finance')).toHaveAttribute('aria-expanded', 'true')
  await expect(item(page, 'finance/2026')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(item(page, 'finance/2026')).toBeFocused()
  await expect(item(page, 'finance/2026')).toHaveAttribute('aria-level', '3')
  // Left: up to the folder above, then closes it
  await page.keyboard.press('ArrowLeft')
  await expect(item(page, 'finance')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(item(page, 'finance')).toHaveAttribute('aria-expanded', 'false')
  await expect(item(page, 'finance/2026')).toHaveCount(0)
  // moving alone chooses nothing; Enter does
  await expect(page.getByTestId('folder-detail')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(detail(page)).toHaveAttribute('data-path', 'finance')
  await expect(item(page, 'finance')).toHaveAttribute('aria-selected', 'true')
  await expect(item(page, 'finance')).toBeFocused()
  // one Tab stop: Tab leaves the tree, Shift+Tab comes back to the row last focused
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('folder-detail-edit')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(item(page, 'finance')).toBeFocused()
  // the focus ring is drawn inside the row (no clipping by the card), in the accent from the first frame
  await expect(item(page, 'finance')).toHaveCSS('outline-offset', '-2px')
  expect(await item(page, 'finance').evaluate((el) => getComputedStyle(el).outlineColor)).toBe('rgb(232, 82, 26)')
})

test('a level with more folders than a page: "N more" is a row, it loads the next page and its first folder takes the focus', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  for (let i = 0; i < 5; i++) await page.request.post('/__test/file', { data: { path: `docs/area-${i}/note.md`, text: 'x' } })
  // two rows a page (the server's own paging)
  await page.route('**/api/admin/access/tree**', (r) => {
    const u = new URL(r.request().url())
    u.searchParams.set('limit', '2')
    return r.continue({ url: u.toString() })
  })
  await page.goto('/admin/folders')
  await expect(item(page, '')).toBeVisible()
  // the top level: connected, docs, then a row for the other eight (by name, the server's order)
  const top = tree(page).locator('[role="treeitem"][aria-level="2"]')
  await expect(top).toHaveCount(3)
  const more = top.nth(2)
  await expect(more).toHaveAttribute('data-testid', 'tree-more')
  await expect(more).toHaveText(translate('ko', 'accessTree.more', { n: 8 }))
  await expect(item(page, 'finance')).toHaveCount(0)
  await more.focus()
  await page.keyboard.press('Enter')
  await expect(item(page, 'finance')).toBeFocused()
  await expect(top).toHaveCount(5) // 4 folders + "more"
  // a page of a folder opened by hand
  await item(page, 'docs').getByTestId('tree-toggle').click()
  await expect(item(page, 'docs/area-0')).toBeVisible()
  await expect(item(page, 'docs/area-1')).toBeVisible()
  await expect(tree(page).getByTestId('tree-more').filter({ hasText: translate('ko', 'accessTree.more', { n: 3 }) })).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('a level that fails to open: a row to try again; the first answer failing: try again', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  let fail = true
  await page.route('**/api/admin/access/tree**', (r) => (fail ? r.fulfill({ status: 500, json: { error: { code: 'internal', message: 'TREE-FAILED' } } }) : r.continue()))
  await page.goto('/admin/folders')
  await expect(page.getByText('TREE-FAILED')).toBeVisible()
  fail = false
  await page.getByRole('button', { name: t['common.retry'], exact: true }).click()
  await expect(item(page, 'finance')).toBeVisible()
  fail = true
  await item(page, 'finance').getByTestId('tree-toggle').click()
  const retry = tree(page).getByTestId('tree-failed')
  await expect(retry).toContainText('TREE-FAILED')
  await expect(retry).toHaveAttribute('role', 'treeitem')
  fail = false
  await retry.click()
  await expect(item(page, 'finance/2026')).toBeVisible()
})

test('rules of folders gone from disk: folded under the tree, removed with the server\'s preview, focus moves on', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  for (const p of ['old/a', 'old/b']) await call(page, 'post', '/api/admin/folders', { path: p, create: true, rules: [everyone('read')] })
  await page.request.post('/__test/rmdir', { data: { path: 'old' } })
  await page.goto('/admin/folders')
  await expect(item(page, 'finance')).toBeVisible()
  await expect(item(page, 'old')).toHaveCount(0)
  const toggle = page.getByTestId('folder-outside-toggle')
  await expect(toggle).toHaveText(translate('ko', 'accessTree.outside', { n: 2 }))
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const list = page.getByTestId('folder-list')
  const row = (p: string) => list.locator(`[data-path="${p}"]`)
  await expect(row('old/a')).toContainText(t['rules.missingOnDisk'])
  await expect(row('old/a')).toContainText(`${t['rules.everyone']}: ${t['access.read']}`)
  const del = (p: string) => row(p).getByRole('button', { name: translate('ko', 'common.deleteNamed', { name: p }), exact: true })
  await del('old/a').click()
  await expect(page.getByRole('dialog').getByTestId('rules-remove-preview')).toContainText(t['rules.removeKeeps'])
  await page.getByTestId('dialog-confirm').click()
  await expect(row('old/a')).toHaveCount(0)
  await expect(del('old/b')).toBeFocused()
  await del('old/b').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(toggle).toHaveCount(0)
  await expect(page.getByTestId('folder-rule-new')).toBeFocused()
  expect(realErrors(errors)).toEqual([])
})

test('add a folder: the picker, the rule editor, then the folder is opened to and chosen; the address opens one', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/folders')
  await expect(item(page, 'finance')).toBeVisible()
  await page.getByTestId('folder-rule-new').click()
  const picker = page.getByRole('dialog')
  // the mock's file policy has finance read only for the owner: the picker says so beside the name
  await picker.getByRole('button', { name: /^finance/ }).click()
  await picker.getByRole('button', { name: /^2026/ }).click()
  await page.getByTestId('folder-pick').click()
  await expect(page.getByRole('dialog')).toContainText(translate('ko', 'rules.editTitle', { path: 'finance/2026' }))
  await page.getByTestId('rule-add').click()
  await page.getByRole('dialog').getByLabel(t['rules.who'], { exact: true }).selectOption('everyone')
  await page.getByTestId('rules-save').click()
  await expect(item(page, 'finance')).toHaveAttribute('aria-expanded', 'true')
  await expect(item(page, 'finance/2026')).toHaveAttribute('aria-selected', 'true')
  await expect(detail(page)).toHaveAttribute('data-path', 'finance/2026')
  await expect(detail(page).getByTestId('folder-rules')).toContainText(`${t['rules.everyone']}: ${t['access.read']}`)
  await expect(item(page, 'finance/2026').getByTestId('tree-who')).toHaveText(`${t['rules.everyone']} · ${t['access.read']}`)
  // a link to a folder opens the way to it and chooses it
  await page.goto(`/admin/folders?folder=${encodeURIComponent('finance/2026')}`)
  await expect(item(page, 'finance/2026')).toHaveAttribute('aria-selected', 'true')
  await expect(detail(page)).toHaveAttribute('data-path', 'finance/2026')
})

test('375px: the folder replaces the tree and Back returns to its row; deep and long names stay inside', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  const deep = Array.from({ length: 10 }, (_, i) => `level-${i + 1}`).join('/')
  await call(page, 'post', '/api/admin/folders', { path: `docs/${deep}`, create: true, rules: [everyone('read')] })
  // as long as a name may be (255 bytes: 10 × 25)
  const long = '아주-긴-폴더-이름-'.repeat(10).slice(0, -1) + 'x'
  await page.request.post('/__test/file', { data: { path: `shared/${long}/a.md`, text: 'x' } })
  await page.goto('/admin/folders')
  // the way down to the deep folder is open; deeper than the room for depth, the name says so; the path is its title
  const bottom = item(page, `docs/${deep}`)
  await expect(bottom).toBeVisible()
  await expect(bottom).toHaveAttribute('title', `docs/${deep}`)
  await expect(bottom).toContainText('…/level-10')
  const fits = async () => page.evaluate(() => {
    const main = document.querySelector('main')!
    const scroller = main.querySelector<HTMLElement>('.overflow-y-auto') ?? main
    return document.documentElement.scrollWidth <= window.innerWidth && scroller.scrollWidth <= scroller.clientWidth
  })
  expect(await fits()).toBe(true)
  await item(page, 'shared').getByTestId('tree-toggle').click()
  await expect(item(page, `shared/${long}`)).toBeVisible()
  expect(await fits()).toBe(true)

  await item(page, 'projects/apollo').click()
  await expect(tree(page)).toBeHidden()
  await expect(detail(page).getByRole('heading', { name: 'projects/apollo' })).toBeFocused()
  await expect(person(page, 'dan')).toBeVisible()
  expect(await fits()).toBe(true)
  await page.getByTestId('folder-detail-back').click()
  await expect(tree(page)).toBeVisible()
  await expect(item(page, 'projects/apollo')).toBeFocused()
  expect(realErrors(errors)).toEqual([])
})

for (const locale of ['es', 'ja', 'en', 'id'] as const) {
  test(`the tree in ${locale} at 375px: its own words, nothing outside the screen`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    await team(page)
    await page.goto('/admin/folders')
    const d = DICTS[locale]
    await expect(item(page, '')).toContainText(d['accessView.rootFolder'])
    await expect(item(page, 'shared').getByTestId('tree-risk')).toHaveText(d['accessTree.risk.everyone'])
    await expect(item(page, 'users')).toContainText(translate(locale, 'accessTree.personal.count', { n: 4 }))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
