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
/** the chosen folder's rules in the edit panel (stage 5): everyone reads, saved */
async function everyoneReads(page: Page) {
  const panel = page.getByTestId('edit-panel')
  await page.getByTestId('folder-detail-edit').click()
  await panel.getByTestId('edit-basic-read').click()
  await expect(panel.getByTestId('edit-result')).toHaveAttribute('data-ready', 'true')
  await panel.getByTestId('edit-save').click()
  await expect(panel).toHaveCount(0)
}

/** Olga (owner, 재무팀), Bob, Carol (영업팀), Dan; shared: everyone writes; skills: everyone reads, admins write;
 * skills/영업: everyone writes; partners/apollo (a project made before outside projects/): Dan writes, 영업팀 reads, nobody
 * else; connected/nas: 영업팀 reads. */
async function team(page: Page) {
  const sales = await call(page, 'post', '/api/admin/groups', { name: '영업팀', memberIds: [] })
  await call(page, 'post', '/api/admin/users', { username: 'carol', name: 'Carol', role: 'member', groupIds: [sales.id], temporaryPassword: 'tiger4271x' })
  await call(page, 'post', '/api/admin/users', { username: 'dan', name: 'Dan', role: 'member', groupIds: [], temporaryPassword: 'tiger4271x' })
  await call(page, 'post', '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read'), { subjectType: 'role', subjectId: 'admin', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'skills/영업', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'partners/apollo', create: true, rules: [{ subjectType: 'user', subjectId: 'dan', access: 'write' }, { subjectType: 'group', subjectId: sales.id, access: 'read' }, everyone('none')] })
  await call(page, 'post', '/api/admin/folders', { path: 'connected/nas', create: true, rules: [{ subjectType: 'group', subjectId: sales.id, access: 'read' }] })
  await call(page, 'post', '/api/projects', { name: 'Apollo', folderPath: 'partners/apollo' })
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
  for (const p of ['', 'groups', 'partners', 'connected', 'skills']) await expect(item(page, p)).toHaveAttribute('aria-expanded', 'true')
  for (const p of ['groups/영업팀', 'partners/apollo', 'connected/nas', 'skills/영업', 'shared', 'docs', 'finance', 'users']) await expect(item(page, p)).toBeVisible()
  await expect(item(page, 'finance')).toHaveAttribute('aria-expanded', 'false')
  await expect(item(page, 'finance/2026')).toHaveCount(0)
  await expect(item(page, 'docs')).not.toHaveAttribute('aria-expanded', /.*/)
  await expect(item(page, 'partners/apollo')).toHaveAttribute('aria-level', '3')

  // the root has no rule: only the owner and admins, and it says so; a lock where only part of the team sees
  await expect(item(page, '').getByTestId('tree-who')).toHaveText(t['accessTree.who.adminsOnly'])
  // no rule anywhere: "only the owner and admins" says it all, with no source line (it would repeat on most rows)
  await expect(item(page, '').getByTestId('tree-source')).toHaveCount(0)
  await expect(item(page, 'docs').getByTestId('tree-who')).toHaveText(t['accessTree.who.adminsOnly'])
  await expect(item(page, 'docs').getByTestId('tree-source')).toHaveCount(0)
  await expect(item(page, '')).toContainText(t['accessTree.restricted'])
  // shared: everyone writes, from its own rule (the lock-free row needs no "this folder's rules"); a risk, said once
  // (not on the folders below it), as a small chip
  await expect(item(page, 'shared').getByTestId('tree-who')).toHaveText(`${t['rules.everyone']} · ${t['access.write']}`)
  await expect(item(page, 'shared').getByTestId('tree-source')).toHaveCount(0)
  await expect(item(page, 'shared').getByTestId('tree-risk')).toHaveText(t['accessTree.risk.everyone'])
  await expect(item(page, 'shared')).not.toContainText(t['accessTree.restricted'])
  // the team skills: everyone reads; skills/영업 lets everyone change what every AI follows
  await expect(item(page, 'skills').getByTestId('tree-who')).toHaveText(`${t['rules.everyone']} · ${t['access.read']}`)
  await expect(item(page, 'skills').getByTestId('tree-risk')).toHaveCount(0)
  await expect(item(page, 'skills/영업').getByTestId('tree-risk')).toHaveText(t['accessTree.risk.skills'])
  await expect(item(page, 'skills/영업')).toContainText(t['accessTree.kind.skills'])
  // a project: by whom, the kind with its name, a lock (Bob cannot open it)
  const apollo = item(page, 'partners/apollo')
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
  await item(page, 'partners/apollo').click()
  await expect(item(page, 'partners/apollo')).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/folder=partners%2Fapollo/)
  await expect(detail(page).getByRole('heading', { name: 'partners/apollo' })).toBeVisible()
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

  // change the rules from here (the edit panel): everyone reads; the row and the people follow, and the lock goes
  await everyoneReads(page)
  await expect(person(page, 'bob')).toHaveAttribute('data-level', 'read')
  await expect(item(page, 'partners/apollo').getByTestId('tree-who')).toContainText(`${translate('ko', 'accessTree.who.others', { n: 1 })} · ${t['access.read']}`)
  await expect(item(page, 'partners/apollo')).not.toContainText(t['accessTree.restricted'])
  await expect(item(page, 'partners/apollo')).toHaveAttribute('aria-selected', 'true')

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
  await expect(item(page, 'partners/apollo')).toBeVisible()
  await expect(tree(page).locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1)
  // the header: Add folder, then By folder / By person, then the switch; then "How this works", then the tree
  await page.getByTestId('folder-rule-new').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tab', { name: t['accessView.byFolder'] })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('tree-ruled-only')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('tree-how').locator('summary')).toBeFocused()
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
  // with the keyboard: the focus waits on the folder while it is asked again, after a second failure too
  await retry.focus()
  await page.keyboard.press('Enter')
  await expect(item(page, 'finance')).toBeFocused()
  await expect(retry).toBeVisible()
  await expect(item(page, 'finance')).toBeFocused()
  fail = false
  await page.keyboard.press('ArrowDown')
  await expect(retry).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(item(page, 'finance/2026')).toBeVisible()
  await expect(item(page, 'finance')).toBeFocused()
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
  const del = (p: string) => row(p).getByRole('button', { name: translate('ko', 'accessTree.removeRulesOf', { path: p }), exact: true })
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

test('add a folder: the picker, the folder opened to and chosen, then its rules in the edit panel; the address opens one', async ({ page }) => {
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
  // the folder is found in the tree and chosen, and its rules open in the panel there
  await expect(item(page, 'finance')).toHaveAttribute('aria-expanded', 'true')
  await expect(item(page, 'finance/2026')).toHaveAttribute('aria-selected', 'true')
  const panel = page.getByTestId('edit-panel')
  await expect(panel).toHaveAttribute('data-path', 'finance/2026')
  await panel.getByTestId('edit-basic-read').click()
  await expect(panel.getByTestId('edit-result')).toHaveAttribute('data-ready', 'true')
  await panel.getByTestId('edit-save').click()
  await expect(panel).toHaveCount(0)
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

  await item(page, 'partners/apollo').click()
  await expect(tree(page)).toBeHidden()
  await expect(detail(page).getByRole('heading', { name: 'partners/apollo' })).toBeFocused()
  await expect(person(page, 'dan')).toBeVisible()
  expect(await fits()).toBe(true)
  await page.getByTestId('folder-detail-back').click()
  await expect(tree(page)).toBeVisible()
  await expect(item(page, 'partners/apollo')).toBeFocused()
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

// ---------------- a folder in the address, back to the tree ----------------

/** two rows a page (the server's own paging), so shared is past the first page of the top level */
async function twoAPage(page: Page) {
  await page.route('**/api/admin/access/tree**', (r) => {
    const u = new URL(r.request().url())
    u.searchParams.set('limit', '2')
    return r.continue({ url: u.toString() })
  })
}

for (const size of [{ width: 1360, height: 900 }, { width: 375, height: 812 }]) {
  const narrow = size.width < 640
  test(`?folder= at ${size.width}px: a missing folder is said with a way back; past the first page and deep folders are found`, async ({ page }) => {
    await page.setViewportSize(size)
    await reset(page)
    const errors = watchConsole(page)
    await signIn(page)
    await team(page)
    await page.request.post('/__test/file', { data: { path: 'docs/deep1/deep2/deep3/deep4/x.md', text: 'x' } })

    // not there: said, the tree comes back (narrow: Back; wide: it never went), the address drops it
    await page.goto(`/admin/folders?folder=${encodeURIComponent('nope/x')}`)
    const missing = page.getByTestId('folder-detail-missing')
    await expect(missing).toContainText(t['accessTree.notFound'])
    await expect(missing).toContainText('nope/x')
    if (narrow) {
      await expect(tree(page)).toBeHidden()
      await expect(missing.getByRole('heading', { name: t['accessTree.notFound'] })).toBeFocused()
      await page.getByTestId('folder-detail-back').click()
    } else {
      await expect(tree(page)).toBeVisible()
      await expect(tree(page).locator('[aria-selected="true"]')).toHaveCount(0)
      await page.getByTestId('folder-detail-missing-close').click()
    }
    await expect(tree(page)).toBeVisible()
    await expect(missing).toHaveCount(0)
    await expect(page).not.toHaveURL(/folder=/)
    await expect(item(page, '')).toBeFocused()

    // a folder not opened at first, four levels down: each level is asked for on the way
    await page.goto(`/admin/folders?folder=${encodeURIComponent('docs/deep1/deep2/deep3/deep4')}`)
    await expect(detail(page)).toHaveAttribute('data-path', 'docs/deep1/deep2/deep3/deep4')
    await expect(item(page, 'docs/deep1/deep2/deep3/deep4')).toHaveAttribute('aria-selected', 'true')
    if (narrow) {
      await page.getByTestId('folder-detail-back').click()
      await expect(item(page, 'docs/deep1/deep2/deep3/deep4')).toBeFocused()
    }

    // past the first page of its level (two a page): the pages come until it is there
    await twoAPage(page)
    await page.goto('/admin/folders?folder=shared')
    await expect(detail(page)).toHaveAttribute('data-path', 'shared')
    await expect(item(page, 'shared')).toHaveAttribute('aria-selected', 'true')
    if (narrow) {
      await expect(tree(page)).toBeHidden()
      await page.getByTestId('folder-detail-back').click()
    }
    // the Tab stop is the chosen row
    await expect(item(page, 'shared')).toHaveAttribute('tabindex', '0')
    await page.getByTestId('folder-rule-new').focus()
    // the header's tabs and switch, and "How this works", come first
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await expect(item(page, 'shared')).toBeFocused()
    expect(realErrors(errors)).toEqual([])
  })
}

test('the By folder tab and the menu link go back to the tree from a chosen folder (375px)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await reset(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders?folder=shared')
  await expect(detail(page)).toHaveAttribute('data-path', 'shared')
  await expect(tree(page)).toBeHidden()
  await page.getByRole('tab', { name: t['accessView.byFolder'], exact: true }).click()
  await expect(tree(page)).toBeVisible()
  await expect(page).not.toHaveURL(/folder=/)
  // a missing one, then the menu link
  await page.goto(`/admin/folders?folder=${encodeURIComponent('gone/away')}`)
  await expect(page.getByTestId('folder-detail-missing')).toBeVisible()
  await page.getByRole('link', { name: t['admin.folders'], exact: true }).click()
  await expect(tree(page)).toBeVisible()
  await expect(page.getByTestId('folder-detail-missing')).toHaveCount(0)
})

test('rule folders only: the folders with rules and the way to them, open; pages; back to the whole tree', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  await page.request.post('/__test/file', { data: { path: 'docs/deep1/deep2/x.md', text: 'x' } })
  await call(page, 'post', '/api/admin/folders', { path: 'docs/deep1/deep2', create: true, rules: [everyone('read')] })
  await page.goto('/admin/folders')
  await expect(item(page, 'partners/apollo')).toBeVisible()
  await expect(item(page, 'marketing')).toBeVisible()
  await page.getByTestId('tree-ruled-only').check({ force: true })
  await expect(tree(page)).toHaveAttribute('data-mode', 'ruled')
  for (const p of ['docs/deep1/deep2', 'partners/apollo', 'skills/영업', 'shared', 'finance', 'groups/영업팀', 'connected/nas']) await expect(item(page, p)).toBeVisible()
  // the folders on the way show, open; folders with no rule below them do not
  await expect(item(page, 'docs/deep1')).toHaveAttribute('aria-expanded', 'true')
  await expect(item(page, 'docs/deep1')).toHaveAttribute('data-rules', '0')
  for (const p of ['marketing', 'secret', 'users']) await expect(item(page, p)).toHaveCount(0)
  // the keyboard: Left goes up, Right goes in
  await item(page, 'docs/deep1/deep2').focus()
  await page.keyboard.press('ArrowLeft')
  await expect(item(page, 'docs/deep1')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(item(page, 'docs/deep1/deep2')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(detail(page)).toHaveAttribute('data-path', 'docs/deep1/deep2')
  // back to the whole tree: the chosen folder is opened to
  await page.getByTestId('tree-ruled-only').uncheck({ force: true })
  await expect(tree(page)).toHaveAttribute('data-mode', 'all')
  await expect(item(page, 'docs/deep1/deep2')).toHaveAttribute('aria-selected', 'true')
  expect(realErrors(errors)).toEqual([])

  // pages of two: "N more" after the loaded rule folders
  await twoAPage(page)
  await page.goto('/admin/folders')
  await expect(item(page, '')).toBeVisible()
  await page.getByTestId('tree-ruled-only').check({ force: true })
  const more = tree(page).getByTestId('tree-more')
  await expect(more).toBeVisible()
  const before = await tree(page).locator('[data-testid="tree-row"]').count()
  await more.click()
  await expect.poll(() => tree(page).locator('[data-testid="tree-row"]').count()).toBeGreaterThan(before)
})

for (const width of [1360, 375]) {
  test(`a long project name never squeezes the folder's own name out (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await reset(page)
    await signIn(page)
    await team(page)
    // as long as a project name may be (100 characters); the second project on apollo makes the kind "프로젝트 2개", so
    // shared carries the long one alone
    await call(page, 'post', '/api/projects', { name: '아주 긴 프로젝트 이름 '.repeat(8).trim().slice(0, 100), folderPath: 'shared' })
    await call(page, 'post', '/api/projects', { name: 'L'.repeat(100), folderPath: 'skills' })
    await page.goto('/admin/folders')
    for (const p of ['shared', 'skills']) {
      const name = item(page, p).getByTestId('tree-name')
      await expect(name).toBeVisible()
      expect((await name.boundingBox())!.width).toBeGreaterThan(24)
    }
    const fits = await page.evaluate(() => {
      const scroller = document.querySelector('main')!.querySelector<HTMLElement>('.overflow-y-auto') ?? document.querySelector('main')!
      const card = document.querySelector('[data-testid="folder-tree"]')!.getBoundingClientRect()
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="tree-row"]')]
      return document.documentElement.scrollWidth <= window.innerWidth && scroller.scrollWidth <= scroller.clientWidth && rows.every((r) => r.getBoundingClientRect().right <= card.right + 1)
    })
    expect(fits).toBe(true)
  })
}

test('a refresh that fails says so with a way to try again; the people already shown stay', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders?folder=partners%2Fapollo')
  await expect(page.getByTestId('folder-people')).toBeVisible()
  // the rules change (the edit panel works its result out first), and the answers that would show it fail
  const panel = page.getByTestId('edit-panel')
  await page.getByTestId('folder-detail-edit').click()
  await panel.getByTestId('edit-basic-read').click()
  await expect(panel.getByTestId('edit-result')).toHaveAttribute('data-ready', 'true')
  await page.route(/\/api\/admin\/access\/(tree|folder)/, (r) => r.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'x' } } }))
  await panel.getByTestId('edit-save').click()
  await expect(page.getByTestId('tree-stale')).toContainText(t['accessTree.refreshFailed'])
  await expect(page.getByTestId('folder-people-stale')).toContainText(t['accessTree.refreshFailed'])
  await expect(person(page, 'dan')).toBeVisible()
  await page.unroute(/\/api\/admin\/access\/(tree|folder)/)
  await page.getByTestId('tree-stale').getByRole('button', { name: t['common.retry'], exact: true }).click()
  await expect(page.getByTestId('tree-stale')).toHaveCount(0)
  await expect(item(page, 'partners/apollo').getByTestId('tree-who')).toContainText(`${translate('ko', 'accessTree.who.others', { n: 1 })} · ${t['access.read']}`)
  await page.getByTestId('folder-people-stale').getByRole('button', { name: t['common.retry'], exact: true }).click()
  await expect(page.getByTestId('folder-people-stale')).toHaveCount(0)
  await expect(person(page, 'bob')).toHaveAttribute('data-level', 'read')
})

test('rule rows the tree never shows (a name it hides) are listed under it, to remove', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  // Users/x is a personal-folder look-alike the answers never name (any case): its row is apart, with why
  await call(page, 'post', '/api/admin/folders', { path: 'Users/x', create: true, rules: [everyone('read')] })
  await call(page, 'post', '/api/admin/folders', { path: 'old/a', create: true, rules: [everyone('read')] })
  await page.request.post('/__test/rmdir', { data: { path: 'old' } })
  await page.goto('/admin/folders')
  const toggle = page.getByTestId('folder-outside-toggle')
  await expect(toggle).toHaveText(translate('ko', 'accessTree.outsideMixed', { n: 2 }))
  await toggle.click()
  const row = (p: string) => page.getByTestId('folder-list').locator(`[data-path="${p}"]`)
  await expect(row('Users/x')).toContainText(t['accessTree.hiddenName'])
  await expect(row('old/a')).toContainText(t['rules.missingOnDisk'])
  await expect(page.getByTestId('folder-outside')).toContainText(t['accessTree.outsideHintMixed'])
  await row('Users/x').getByRole('button', { name: translate('ko', 'accessTree.removeRulesOf', { path: 'Users/x' }), exact: true }).click()
  await page.getByTestId('dialog-confirm').click()
  await expect(row('Users/x')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('375px: long group and person names in a folder\'s rules wrap inside the panel', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await reset(page)
  await signIn(page)
  const long = await call(page, 'post', '/api/admin/groups', { name: '아주긴그룹이름'.repeat(12), memberIds: [] })
  await call(page, 'post', '/api/admin/folders', { path: 'marketing', create: true, rules: [{ subjectType: 'group', subjectId: long.id, access: 'write' }, everyone('read')] })
  await page.goto('/admin/folders?folder=marketing')
  await expect(page.getByTestId('folder-rules')).toBeVisible()
  const fits = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="folder-detail"]')!.getBoundingClientRect()
    const badges = [...document.querySelectorAll('[data-testid="folder-rules"] > *')]
    return document.documentElement.scrollWidth <= window.innerWidth && badges.every((b) => b.getBoundingClientRect().right <= box.right + 1)
  })
  expect(fits).toBe(true)
})

test('a slow "Load more" of the people that comes after a rule change is dropped, not laid over the new answer', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  // one person a page; the second page takes long
  await page.route('**/api/admin/access/folder**', async (r) => {
    const u = new URL(r.request().url())
    u.searchParams.set('limit', '1')
    if (u.searchParams.has('cursor')) await new Promise((done) => setTimeout(done, 2500))
    await r.continue({ url: u.toString() }).catch(() => {})
  })
  await page.goto('/admin/folders?folder=partners%2Fapollo')
  await expect(page.getByTestId('folder-person')).toHaveCount(1)
  await expect(person(page, 'bob')).toHaveAttribute('data-level', 'none')
  await page.getByTestId('folder-people-more').click()
  // meanwhile: everyone reads apollo now
  await everyoneReads(page)
  await expect(person(page, 'bob')).toHaveAttribute('data-level', 'read')
  // the slow page of before the change lands and is dropped: the new answer stays as it is
  await page.waitForTimeout(3000)
  await expect(person(page, 'bob')).toHaveAttribute('data-level', 'read')
  await expect(page.getByTestId('folder-person')).toHaveCount(1)
  await expect(page.getByTestId('folder-people-more')).toBeVisible()
})

// ---------------- lookups that overlap ----------------

/** a new address the way Back and Forward bring one (the router hears popstate) */
const goTo = (page: Page, folder: string) =>
  page.evaluate((f) => {
    history.pushState(null, '', `/admin/folders?folder=${encodeURIComponent(f)}`)
    dispatchEvent(new PopStateEvent('popstate'))
  }, folder)

test('a lookup while a page of the same level is on its way waits for it; a replaced lookup stops', async ({ page }) => {
  test.setTimeout(90_000)
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  // two rows a page; every page after the first takes 2 seconds
  await page.route('**/api/admin/access/tree**', async (r) => {
    const u = new URL(r.request().url())
    u.searchParams.set('limit', '2')
    if (u.searchParams.has('cursor')) await new Promise((done) => setTimeout(done, 2000))
    await r.continue({ url: u.toString() }).catch(() => {})
  })
  // A: "N more" of the top level is on its way when the address names shared (three pages further)
  await page.goto('/admin/folders')
  await expect(item(page, '')).toBeVisible()
  await tree(page).getByTestId('tree-more').first().click()
  await goTo(page, 'shared')
  await expect(detail(page)).toHaveAttribute('data-path', 'shared', { timeout: 20_000 })
  await expect(page.getByTestId('folder-detail-missing')).toHaveCount(0)
  await expect(item(page, 'shared')).toHaveAttribute('aria-selected', 'true')

  // B: one folder, then another 300 ms later: the second is found, the first stops and is not said missing
  await page.goto('/admin/folders?folder=secret')
  await page.waitForTimeout(300)
  await goTo(page, 'shared')
  await expect(detail(page)).toHaveAttribute('data-path', 'shared', { timeout: 20_000 })
  await page.waitForTimeout(2500)
  await expect(page.getByTestId('folder-detail-missing')).toHaveCount(0)
  await expect(detail(page)).toHaveAttribute('data-path', 'shared')
  await expect(item(page, 'secret')).toHaveAttribute('aria-selected', 'false')
  expect(realErrors(errors)).toEqual([])
})

test('"Try again" on a lookup that failed keeps the focus: on its "Try again" when it fails again', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  let fails = 2
  await page.route('**/api/admin/access/tree**', (r) => {
    const u = new URL(r.request().url())
    if (u.searchParams.get('path') === 'shared' && fails > 0) {
      fails--
      return r.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'LOOKUP-FAILED' } } })
    }
    return r.continue()
  })
  await page.goto('/admin/folders?folder=shared')
  const failed = page.getByTestId('folder-detail-failed')
  await expect(failed).toContainText('LOOKUP-FAILED')
  await failed.getByRole('button', { name: t['common.retry'], exact: true }).click()
  await expect(failed.getByRole('button', { name: t['common.retry'], exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(detail(page)).toHaveAttribute('data-path', 'shared')
  expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null)).toBe(true)
})

test('a team folder that serves Skills/ is the team skills on the screen too: the label, the hint, the managers', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await call(page, 'post', '/api/admin/folders', { path: 'Skills/영업', create: true, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }, everyone('read')] })
  await page.goto(`/admin/folders?folder=${encodeURIComponent('Skills/영업')}`)
  await expect(item(page, 'Skills/영업')).toContainText(t['accessTree.kind.skills'])
  await expect(detail(page)).toContainText(t['skillMgr.folderHint'])
  await expect(detail(page).getByTestId('skill-manager-badge')).toBeVisible()
})

test('the header stays at the top while the tree scrolls: title, Add folder, the tabs and the switch', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  await page.setViewportSize({ width: 1360, height: 520 })
  await page.goto('/admin/folders')
  await expect(item(page, 'partners/apollo')).toBeVisible()
  const content = page.getByTestId('admin-content')
  await content.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const header = page.getByTestId('folders-header')
  const box = (await header.boundingBox())!
  const area = (await content.boundingBox())!
  // the header sits at the top of the scrolling area, whole, with its controls usable
  expect(Math.abs(box.y - area.y)).toBeLessThan(2)
  await expect(page.getByTestId('folder-rule-new')).toBeInViewport()
  await expect(header.getByTestId('tree-ruled-only')).toHaveCount(1)
  await expect(header.getByRole('tab', { name: t['accessView.byPerson'] })).toBeInViewport()
  // no card around the tree
  await expect(page.getByTestId('access-tree').locator('section.rounded-2xl')).toHaveCount(0)
})

// docs/DECISIONS.md "Project contents only for members": a team project's folder in projects/ is its members'. The
// tree shows it as one row ("멤버만" and its count, never "팀장과 관리자만"), nothing inside it, no rules to change here,
// and the way to its members ("멤버 관리", the project's page with its members dialog open). Writes there are refused.
for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  test(`a team project's folder: members only, nothing inside, no editor, the way to its members (${vp.name})`, async ({ page }) => {
    await page.setViewportSize(vp.size)
    await reset(page)
    const errors = watchConsole(page)
    await signIn(page)
    await team(page)
    // Bob's project: Bob and Dan; a folder inside it; the owner is not in it
    const made = await page.request.post('/__test/project', { data: { name: 'falcon', by: 'bob', participants: [{ subjectType: 'user', subjectId: 'dan' }], files: { 'plan.md': 'plan', 'drafts/a.md': 'a' } } })
    const { id } = (await made.json()) as { id: string }
    await page.request.post('/__test/file', { data: { path: 'projects/falcon/drafts/b.md', text: 'b' } })
    await page.goto('/admin/folders')
    const falcon = item(page, 'projects/falcon')
    await expect(falcon).toBeVisible()
    await expect(falcon.getByTestId('tree-who')).toHaveText(`${t['accessTree.membersOnly']} · ${translate('ko', 'folderAccess.people', { n: 2 })}`)
    await expect(falcon).not.toContainText(t['accessTree.who.adminsOnly'])
    await expect(falcon.getByTestId('tree-source')).toHaveCount(0)
    // nothing below it: no way to open it
    await expect(falcon).not.toHaveAttribute('aria-expanded', /.*/)
    await expect(item(page, 'projects/falcon/drafts')).toHaveCount(0)
    await falcon.click()
    await expect(detail(page)).toHaveAttribute('data-path', 'projects/falcon')
    await expect(detail(page).getByTestId('folder-detail-members-only')).toHaveText(t['accessTree.membersOnly'])
    await expect(detail(page).getByTestId('folder-detail-edit')).toHaveCount(0)
    await expect(detail(page).getByTestId('folder-detail-delete')).toHaveCount(0)
    // the owner is no member: by the rule there, like anyone else
    await expect(person(page, 'olga')).toHaveAttribute('data-level', 'none')
    await expect(person(page, 'dan')).toHaveAttribute('data-level', 'write')
    const manage = detail(page).getByTestId('folder-detail-manage-members')
    await expect(manage).toHaveText(t['accessTree.manageMembers'])
    await expect(manage).toHaveAttribute('href', `/projects/${id}?members=1`)
    // the edit panel by its address: the server's refusal, in its words
    await page.goto(`/admin/folders?edit=${encodeURIComponent('projects/falcon')}`)
    await expect(page.getByTestId('edit-panel')).toContainText('프로젝트 멤버는 프로젝트 페이지에서 바꿔요.')
    // and "멤버 관리": the project's page with its members dialog
    await page.goto(`/admin/folders?folder=${encodeURIComponent('projects/falcon')}`)
    await detail(page).getByTestId('folder-detail-manage-members').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}`))
    await expect(page.getByTestId('project-members-dialog')).toBeVisible()
    expect(realErrors(errors).filter((e) => !/status of 409/.test(e))).toEqual([])
  })
}
