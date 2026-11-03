// Admin › Folder permissions › By folder, stage 5: the edit panel. "규칙 바꾸기" turns the chosen folder's part into the
// panel: the basic access first (with what "follow the folder above" gives now), people and groups from one search,
// each with read, write or no access, and the result the server works out (POST /api/admin/access/edit-preview, the
// mock answers with the server's own server/src/admin/access-edit.ts), which the Save button sums up. Old role rows,
// another admin's change (409), the stage 1 guards, a connected folder, the root, unsaved changes, the debounce and
// stale answers, a phone, the keyboard.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.ko
const call = async (page: Page, method: 'post' | 'patch' | 'put', url: string, data: unknown) => {
  const r = await page.request[method](url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.ok(), url).toBeTruthy()
  return r.json()
}
const everyone = (access: 'none' | 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })
const tree = (page: Page) => page.getByTestId('folder-tree')
const item = (page: Page, path: string) => tree(page).locator(`[role="treeitem"][data-path="${path}"]`)
const detail = (page: Page) => page.getByTestId('folder-detail')
const person = (page: Page, id: string) => detail(page).locator(`[data-testid="folder-person"][data-person="${id}"]`)
const panel = (page: Page) => page.getByTestId('edit-panel')
const save = (page: Page) => panel(page).getByTestId('edit-save')
const named = (page: Page, subject: string) => panel(page).locator(`[data-testid="edit-named"][data-subject="${subject}"]`)
const rulesOf = async (page: Page, path: string) =>
  ((await (await page.request.get('/api/admin/folders')).json()).items as { path: string; rules: { subjectType: string; subjectId: string | null; access: string }[] }[])
    .find((f) => f.path === path)?.rules.map((r) => `${r.subjectType}:${r.subjectId ?? ''}:${r.access}`).sort() ?? []
const rowId = async (page: Page, path: string) => ((await (await page.request.get('/api/admin/folders')).json()).items as { id: string; path: string }[]).find((f) => f.path === path)!.id
/** the panel's answer for what is on the screen has come */
const settled = (page: Page) => expect(panel(page).getByTestId('edit-result')).toHaveAttribute('data-ready', 'true')
async function openPanel(page: Page, path: string) {
  await page.goto(`/admin/folders?folder=${encodeURIComponent(path)}`)
  await expect(detail(page)).toHaveAttribute('data-path', path)
  await page.getByTestId('folder-detail-edit').click()
  await expect(panel(page)).toHaveAttribute('data-path', path)
  await settled(page)
}

/** Olga (owner, 재무팀), Bob, Carol (영업팀), Dan, Erin (disabled); shared: everyone writes; skills: everyone reads, admins
 * write (the default, an old role row); projects/apollo: Dan writes, 영업팀 reads, Erin reads, nobody else, and
 * apollo/drafts: Bob writes (a rule folder below); connected/nas: 영업팀 reads; docs/old: members read, everyone none. */
async function team(page: Page) {
  const sales = await call(page, 'post', '/api/admin/groups', { name: '영업팀', memberIds: [] })
  for (const [id, name] of [['carol', 'Carol'], ['dan', 'Dan'], ['erin', 'Erin']] as const) await call(page, 'post', '/api/admin/users', { username: id, name, role: 'member', groupIds: id === 'carol' ? [sales.id] : [], temporaryPassword: 'tiger4271x' })
  await call(page, 'patch', '/api/admin/users/erin', { status: 'disabled' })
  await call(page, 'post', '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read'), { subjectType: 'role', subjectId: 'admin', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'projects/apollo', create: true, rules: [{ subjectType: 'user', subjectId: 'dan', access: 'write' }, { subjectType: 'group', subjectId: sales.id, access: 'read' }, { subjectType: 'user', subjectId: 'erin', access: 'read' }, everyone('none')] })
  await call(page, 'post', '/api/admin/folders', { path: 'projects/apollo/drafts', create: true, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'connected/nas', create: true, rules: [{ subjectType: 'group', subjectId: sales.id, access: 'read' }] })
  await call(page, 'post', '/api/admin/folders', { path: 'docs/old', create: true, rules: [{ subjectType: 'role', subjectId: 'member', access: 'read' }, everyone('none')] })
  return sales as { id: string }
}

test.beforeEach(async ({ page }) => {
  // leaving the page with changes not saved asks the browser (beforeunload): the tests go on
  page.on('dialog', (d) => void d.accept())
})

test('basic access first: "follow the folder above" says what it gives now, the result follows the choice, Save says the impact; the tree and the people follow', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  await openPanel(page, 'shared')
  // the heading takes the focus; the folder is named
  await expect(panel(page).getByRole('heading', { name: t['accessEdit.title'] })).toBeFocused()
  await expect(panel(page).getByTestId('edit-path')).toHaveText('shared')
  // the basic access as it is, and what following the folder above gives now (no rule above shared: only admins)
  await expect(panel(page).getByTestId('edit-basic-write').getByRole('radio')).toBeChecked()
  await expect(panel(page).getByTestId('edit-follow-now')).toHaveText(translate('ko', 'accessEdit.follow.now', { who: t['accessTree.who.adminsOnly'] }))
  await expect(panel(page).getByTestId('edit-no-change')).toHaveText(t['accessEdit.noChange'])
  await expect(save(page)).toBeDisabled()
  await expect(save(page)).toHaveAccessibleDescription(t['accessEdit.why.same'])

  // everyone reads: write → read is a loss, for every active member (Erin is switched off)
  await panel(page).getByTestId('edit-basic-read').click()
  await settled(page)
  const less = panel(page).getByTestId('edit-less')
  await expect(less.getByRole('heading')).toHaveText(translate('ko', 'accessEdit.lessTitle', { n: 3 }))
  await expect(less.getByTestId('edit-change')).toHaveCount(1)
  await expect(less.getByTestId('edit-change')).toContainText(`${t['access.write']}`)
  await expect(less.getByTestId('edit-change')).toContainText('Bob, Carol, Dan')
  await expect(panel(page).getByTestId('edit-more')).toHaveCount(0)
  await expect(panel(page).getByTestId('edit-next')).toHaveText(translate('ko', 'accessEdit.next', { who: `${t['rules.everyone']} · ${t['access.read']}` }))
  await expect(save(page)).toHaveText(translate('ko', 'accessEdit.saveLess', { n: 3 }))
  await expect(save(page)).toBeEnabled()

  const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/rules'))
  await save(page).click()
  // the hash of the rules it started from goes with the save
  expect((await put).postDataJSON()).toMatchObject({ rules: [everyone('read')], expectedHash: expect.any(String) })
  await expect(panel(page)).toHaveCount(0)
  await expect(item(page, 'shared').getByTestId('tree-who')).toHaveText(`${t['rules.everyone']} · ${t['access.read']}`)
  await expect(detail(page).getByTestId('folder-rules')).toContainText(`${t['rules.everyone']}: ${t['access.read']}`)
  await expect(person(page, 'bob')).toHaveAttribute('data-level', 'read')
  await expect(page.getByTestId('folder-detail-edit')).toBeFocused()
  expect(await rulesOf(page, 'shared')).toEqual(['everyone::read'])
  // opened again at once: it starts from the rules just saved, not from the list before (no "another admin" note)
  await page.getByTestId('folder-detail-edit').click()
  await settled(page)
  await expect(panel(page).getByTestId('edit-basic-read').getByRole('radio')).toBeChecked()
  await expect(panel(page).getByTestId('edit-stale')).toHaveCount(0)
  await page.getByTestId('edit-close').click()

  // with a rule on the root, "follow" names where it comes from
  await call(page, 'post', '/api/admin/folders', { path: '', create: true, rules: [everyone('read')] })
  await openPanel(page, 'marketing')
  await expect(panel(page).getByTestId('edit-basic-follow').getByRole('radio')).toBeChecked()
  await expect(panel(page).getByTestId('edit-follow-now')).toHaveText(translate('ko', 'accessEdit.follow.from', { folder: t['accessView.rootFolder'], who: `${t['rules.everyone']} · ${t['access.read']}` }))
  expect(realErrors(errors)).toEqual([])
})

test('people and groups: one search adds either, each with read, write or no access; "everyone reads, Bob not" is kept; a disabled person says so', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const sales = await team(page)
  // marketing has no rules: it follows the folder above (nothing: only admins)
  await openPanel(page, 'marketing')
  await expect(panel(page).getByTestId('edit-basic-follow').getByRole('radio')).toBeChecked()
  await expect(panel(page).getByTestId('edit-people')).toContainText(t['accessEdit.namedHint'])
  await panel(page).getByTestId('edit-basic-read').click()
  // Bob, found by his name, with no access
  const add = panel(page).getByTestId('edit-add')
  await add.fill('bo')
  await expect(add).toHaveAttribute('aria-expanded', 'true')
  await expect(panel(page).getByTestId('edit-add-option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(add).toHaveValue('')
  await expect(add).toBeFocused()
  await expect(named(page, 'user:bob').getByTestId('edit-access-read').getByRole('radio')).toBeChecked()
  await named(page, 'user:bob').getByTestId('edit-access-none').click()
  // a group, read and write
  await add.fill('영업')
  await panel(page).getByTestId('edit-add-option').first().click()
  await named(page, `group:${sales.id}`).getByTestId('edit-access-write').click()
  // what is named is not offered again
  await add.fill('bo')
  await expect(panel(page).getByTestId('edit-add-list')).toContainText(t['accessEdit.noMatch'])
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeVisible()
  await settled(page)
  // Carol (영업팀) writes, Dan reads; Bob stays without access, so he is not in the result
  const more = panel(page).getByTestId('edit-more')
  await expect(more.getByRole('heading')).toHaveText(translate('ko', 'accessEdit.moreTitle', { n: 2 }))
  await expect(more.getByTestId('edit-change').filter({ hasText: 'Carol' })).toContainText(t['access.write'])
  await expect(more.getByTestId('edit-change').filter({ hasText: 'Dan' })).toContainText(t['access.read'])
  await expect(more).not.toContainText('Bob')
  await expect(save(page)).toHaveText(translate('ko', 'accessEdit.saveMore', { n: 2 }))
  await save(page).click()
  await expect(panel(page)).toHaveCount(0)
  expect(await rulesOf(page, 'marketing')).toEqual(['everyone::read', `group:${sales.id}:write`, 'user:bob:none'].sort())
  await expect(person(page, 'bob')).toHaveAttribute('data-level', /none|listed/)
  await expect(person(page, 'carol')).toHaveAttribute('data-level', 'write')
  await expect(person(page, 'dan')).toHaveAttribute('data-level', 'read')

  // open again: as saved. Removing Bob gives him read (the basic access): the result says so, and the focus goes on
  await page.getByTestId('folder-detail-edit').click()
  await expect(panel(page).getByTestId('edit-basic-read').getByRole('radio')).toBeChecked()
  await expect(named(page, 'user:bob').getByTestId('edit-access-none').getByRole('radio')).toBeChecked()
  await named(page, 'user:bob').getByTestId('edit-named-remove').click()
  await expect(named(page, 'user:bob')).toHaveCount(0)
  await expect(named(page, `group:${sales.id}`).getByTestId('edit-access-write').getByRole('radio')).toBeFocused()
  await settled(page)
  await expect(panel(page).getByTestId('edit-more').getByTestId('edit-change')).toContainText('Bob')

  // a person switched off is named as such; the owner and admins are said to write anyway
  await page.getByTestId('edit-cancel').click()
  await page.getByTestId('dialog-confirm').click()
  await openPanel(page, 'projects/apollo')
  await expect(named(page, 'user:erin').getByTestId('edit-named-off')).toHaveText(t['accessEdit.disabled'])
  await panel(page).getByTestId('edit-add').fill('olga')
  await page.keyboard.press('Enter')
  await expect(named(page, 'user:olga')).toContainText(t['accessEdit.always'])
  expect(realErrors(errors)).toEqual([])
})

test('old role rows: one line says how they are saved, the result shows no change, and saving stores "everyone"', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  await openPanel(page, 'skills')
  await expect(panel(page).getByTestId('edit-converted')).toHaveText(t['accessEdit.convertedAdmin'])
  await expect(panel(page).getByTestId('edit-basic-read').getByRole('radio')).toBeChecked()
  await expect(panel(page).getByTestId('edit-no-change')).toBeVisible()
  await expect(save(page)).toHaveText(t['accessEdit.saveNone'])
  await save(page).click()
  await expect(panel(page)).toHaveCount(0)
  expect(await rulesOf(page, 'skills')).toEqual(['everyone::read'])
  // members read, everyone none: the member row is the basic access, saved as everyone
  await openPanel(page, 'docs/old')
  await expect(panel(page).getByTestId('edit-converted')).toHaveText(t['accessEdit.convertedMember'])
  await expect(panel(page).getByTestId('edit-basic-read').getByRole('radio')).toBeChecked()
  await expect(panel(page).getByTestId('edit-no-change')).toBeVisible()
  await save(page).click()
  await expect(panel(page)).toHaveCount(0)
  expect(await rulesOf(page, 'docs/old')).toEqual(['everyone::read'])
})

test('another admin changes the rules: the save is refused, the panel says so, keeps the draft and works the result out again', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  await openPanel(page, 'shared')
  await panel(page).getByTestId('edit-basic-named').click()
  await settled(page)
  await expect(save(page)).toHaveText(translate('ko', 'accessEdit.saveLess', { n: 3 }))
  // meanwhile another admin keeps Dan out of shared
  await call(page, 'put', `/api/admin/folders/${await rowId(page, 'shared')}/rules`, { rules: [everyone('write'), { subjectType: 'user', subjectId: 'dan', access: 'none' }] })
  const refused = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/rules'))
  await save(page).click()
  expect((await refused).status()).toBe(409)
  await expect(panel(page).getByTestId('edit-stale')).toContainText('다른 관리자가 방금 바꿨어요')
  // the draft stays; the result is against their rules now: Dan had none already
  await expect(panel(page).getByTestId('edit-basic-named').getByRole('radio')).toBeChecked()
  await settled(page)
  await expect(save(page)).toHaveText(translate('ko', 'accessEdit.saveLess', { n: 2 }))
  await expect(panel(page).getByTestId('edit-less')).not.toContainText('Dan')
  expect(await rulesOf(page, 'shared')).toEqual(['everyone::write', 'user:dan:none'])
  // their rules can be taken instead
  await panel(page).getByTestId('edit-stale-load').click()
  await expect(panel(page).getByTestId('edit-stale')).toContainText(t['accessEdit.staleLoaded'])
  await expect(panel(page).getByTestId('edit-basic-write').getByRole('radio')).toBeChecked()
  await expect(named(page, 'user:dan').getByTestId('edit-access-none').getByRole('radio')).toBeChecked()
  await settled(page)
  await expect(save(page)).toBeDisabled()
  // or the draft saved over them, knowingly
  await panel(page).getByTestId('edit-basic-named').click()
  await settled(page)
  await save(page).click()
  await expect(panel(page)).toHaveCount(0)
  expect(await rulesOf(page, 'shared')).toEqual(['everyone::none', 'user:dan:none'])
  expect(realErrors(errors).filter((e) => !/status of 409/.test(e))).toEqual([])
})

test('guards: shared cannot follow above with nobody named (said, Save waits); a connected folder offers no "everyone writes"; the root has nothing above; the warnings', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  await openPanel(page, 'shared')
  await panel(page).getByTestId('edit-basic-follow').click()
  await expect(panel(page).getByTestId('edit-keep-one')).toHaveText(t['accessEdit.keepTeam'])
  await expect(save(page)).toBeDisabled()
  await expect(save(page)).toHaveAccessibleDescription(t['accessEdit.keepTeam'])
  // somebody named: follow above is allowed there
  await panel(page).getByTestId('edit-add').fill('dan')
  await page.keyboard.press('Enter')
  await expect(panel(page).getByTestId('edit-keep-one')).toHaveCount(0)
  await settled(page)
  await expect(save(page)).toBeEnabled()
  // "only the people named" on shared: members' AI loses the team's files
  await named(page, 'user:dan').getByTestId('edit-named-remove').click()
  await panel(page).getByTestId('edit-basic-named').click()
  await settled(page)
  await expect(panel(page).getByTestId('edit-warning')).toHaveText(translate('ko', 'accessEdit.warn.teamFiles', { n: 3 }))
  await page.getByTestId('edit-close').click()
  await page.getByTestId('dialog-confirm').click()

  // skills/영업 for everyone to write: everyone becomes a skill manager
  await call(page, 'post', '/api/admin/folders', { path: 'skills/영업', create: true, rules: [everyone('read')] })
  await openPanel(page, 'skills/영업')
  await panel(page).getByTestId('edit-basic-write').click()
  await settled(page)
  await expect(panel(page).getByTestId('edit-warning')).toHaveText(translate('ko', 'accessEdit.warn.skillsEveryone', { n: 3 }))
  await page.getByTestId('edit-close').click()
  await page.getByTestId('dialog-confirm').click()

  // a connected folder: a one-way copy, so no "everyone writes", and it says why
  await openPanel(page, 'connected/nas')
  await expect(panel(page).getByTestId('edit-connected')).toHaveText(t['accessEdit.connectedNoWrite'])
  await expect(panel(page).getByTestId('edit-basic-write')).toHaveCount(0)
  await expect(panel(page).getByTestId('edit-basic-read')).toBeVisible()
  await page.getByTestId('edit-close').click()

  // the team root: nothing above it, so no "follow"; opening it to everyone is warned about
  await page.goto('/admin/folders')
  await item(page, '').click()
  await page.getByTestId('folder-detail-edit').click()
  await settled(page)
  await expect(panel(page).getByTestId('edit-basic-follow')).toHaveCount(0)
  await expect(panel(page).getByTestId('edit-basic-named').getByRole('radio')).toBeChecked()
  await expect(panel(page).getByTestId('edit-basic-named')).toContainText(t['accessEdit.basic.namedRootDesc'])
  await panel(page).getByTestId('edit-basic-read').click()
  await settled(page)
  await expect(panel(page).getByTestId('edit-warning')).toHaveAttribute('data-kind', 'root-everyone')
})

test('unsaved changes: closing, Esc and choosing another folder ask first; nothing is asked when nothing changed', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  await openPanel(page, 'shared')
  // nothing changed: it closes at once, and the focus goes back to the rules button
  await page.getByTestId('edit-close').click()
  await expect(panel(page)).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('folder-detail-edit')).toBeFocused()

  await page.getByTestId('folder-detail-edit').click()
  await panel(page).getByTestId('edit-basic-read').click()
  // the add list open: Cancel below it is still what the click reaches (the list lies over the panel and leaves nothing
  // to move when it closes)
  await panel(page).getByTestId('edit-add').fill('a')
  await expect(panel(page).getByTestId('edit-add-list')).toBeVisible()
  await page.getByTestId('edit-cancel').click()
  await expect(page.getByRole('dialog')).toContainText(t['accessEdit.discardTitle'])
  await page.getByRole('dialog').getByRole('button', { name: t['common.cancel'], exact: true }).click()
  await panel(page).getByTestId('edit-add').fill('')
  // another folder in the tree: asked; staying keeps the draft
  await item(page, 'docs').click()
  await expect(page.getByRole('dialog')).toContainText(t['accessEdit.discardTitle'])
  await page.getByRole('dialog').getByRole('button', { name: t['common.cancel'], exact: true }).click()
  await expect(panel(page).getByTestId('edit-basic-read').getByRole('radio')).toBeChecked()
  await expect(detail(page)).toBeHidden()
  // Esc asks too; dropping the changes closes the panel, and nothing was saved
  await panel(page).getByTestId('edit-basic-read').getByRole('radio').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toContainText(t['accessEdit.discardBody'])
  await page.getByTestId('dialog-confirm').click()
  await expect(panel(page)).toHaveCount(0)
  expect(await rulesOf(page, 'shared')).toEqual(['everyone::write'])
  // another folder after dropping the changes: chosen
  await page.getByTestId('folder-detail-edit').click()
  await panel(page).getByTestId('edit-basic-read').click()
  await item(page, 'docs').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(detail(page)).toHaveAttribute('data-path', 'docs')
})

test('the result waits for the choices to settle, and an older answer never replaces a newer one', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  const asked: string[] = []
  await page.route('**/api/admin/access/edit-preview', async (r) => {
    const rules = JSON.stringify(r.request().postDataJSON().rules)
    asked.push(rules)
    // the answer for "everyone reads" is slow
    if (rules.includes('"read"')) await new Promise((done) => setTimeout(done, 1500))
    await r.continue().catch(() => {})
  })
  await openPanel(page, 'shared')
  expect(asked).toHaveLength(1)
  // four quick choices: one question, for the last
  for (const b of ['read', 'named', 'read', 'named'] as const) await panel(page).getByTestId(`edit-basic-${b}`).click()
  await settled(page)
  await page.waitForTimeout(400)
  expect(asked).toHaveLength(2)
  expect(asked[1]).toContain('"none"')
  // "everyone reads" is asked (slow), then "only the people named" before it answers: the newer answer stays
  await panel(page).getByTestId('edit-basic-read').click()
  await expect.poll(() => asked.length).toBe(3)
  await panel(page).getByTestId('edit-basic-named').click()
  await settled(page)
  await expect(panel(page).getByTestId('edit-less').getByTestId('edit-change')).toContainText(t['access.none'])
  await page.waitForTimeout(1800)
  await expect(panel(page).getByTestId('edit-less').getByTestId('edit-change')).toContainText(t['access.none'])
  await expect(save(page)).toHaveText(translate('ko', 'accessEdit.saveLess', { n: 3 }))
  await expect(panel(page).getByTestId('edit-basic-named').getByRole('radio')).toBeChecked()
})

test('a phone: the panel is the whole screen with a way back, the focus stays in it, and nothing runs off the side', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const sales = await team(page)
  await openPanel(page, 'projects/apollo')
  await expect(panel(page)).toHaveAttribute('role', 'dialog')
  await expect(panel(page)).toHaveAttribute('aria-modal', 'true')
  const box = (await panel(page).boundingBox())!
  expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, 375, 812])
  await expect(panel(page).getByRole('heading', { name: t['accessEdit.title'] })).toBeFocused()
  // the Save button is on the screen without scrolling
  const s = (await save(page).boundingBox())!
  expect(s.y + s.height).toBeLessThanOrEqual(812)
  const fits = await page.evaluate(() => {
    const p = document.querySelector<HTMLElement>('[data-testid="edit-panel"]')!
    return document.documentElement.scrollWidth <= window.innerWidth && p.scrollWidth <= p.clientWidth && [...p.querySelectorAll('[data-testid="edit-named"]')].every((r) => r.getBoundingClientRect().right <= window.innerWidth)
  })
  expect(fits).toBe(true)
  await expect(named(page, `group:${sales.id}`)).toBeVisible()
  // Tab stays inside the panel
  for (let i = 0; i < 25; i++) await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="edit-panel"]'))).toBe(true)
  // the way back asks when something changed
  await panel(page).getByTestId('edit-basic-read').click()
  await page.getByTestId('edit-back').click()
  await expect(page.getByRole('dialog').filter({ hasText: t['accessEdit.discardTitle'] })).toBeVisible()
  await page.getByTestId('dialog-confirm').click()
  await expect(panel(page)).toHaveCount(0)
  await expect(detail(page)).toBeVisible()
  await expect(page.getByTestId('folder-detail-edit')).toBeFocused()
  // a save on the phone
  await page.getByTestId('folder-detail-edit').click()
  await panel(page).getByTestId('edit-basic-read').click()
  await settled(page)
  await save(page).click()
  await expect(panel(page)).toHaveCount(0)
  await expect(person(page, 'bob')).toHaveAttribute('data-level', 'read')
  expect(realErrors(errors)).toEqual([])
})

test('the keyboard: the basic access, the search, a person\'s access and Save by keys alone; focus rings drawn inside', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders?folder=shared')
  await page.getByTestId('folder-detail-edit').focus()
  await page.keyboard.press('Enter')
  await expect(panel(page).getByRole('heading', { name: t['accessEdit.title'] })).toBeFocused()
  await settled(page)
  // past the close button, the basic access is one Tab stop; the arrow keys choose
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('edit-close')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(panel(page).getByTestId('edit-basic-write').getByRole('radio')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(panel(page).getByTestId('edit-basic-read').getByRole('radio')).toBeChecked()
  // the search: type, arrows, Enter adds; Esc closes the list and leaves the panel open
  await page.keyboard.press('Tab')
  await expect(panel(page).getByTestId('edit-add')).toBeFocused()
  await page.keyboard.type('a')
  await page.keyboard.press('ArrowDown')
  await expect(panel(page).getByTestId('edit-add')).toHaveAttribute('aria-activedescendant', /.+/)
  await page.keyboard.press('Escape')
  await expect(panel(page).getByTestId('edit-add')).toHaveAttribute('aria-expanded', 'false')
  await expect(panel(page)).toBeVisible()
  await page.keyboard.press('Backspace')
  await page.keyboard.type('dan')
  await page.keyboard.press('Enter')
  await expect(named(page, 'user:dan')).toBeVisible()
  // Dan's access: one Tab stop, the arrow keys choose; the ring is inside the strip
  await page.keyboard.press('Tab')
  const read = named(page, 'user:dan').getByTestId('edit-access-read')
  await expect(read.getByRole('radio')).toBeFocused()
  await expect(read).toHaveCSS('outline-offset', '-2px')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(named(page, 'user:dan').getByTestId('edit-access-none').getByRole('radio')).toBeChecked()
  await page.keyboard.press('Tab')
  await expect(named(page, 'user:dan').getByTestId('edit-named-remove')).toBeFocused()
  await expect(named(page, 'user:dan').getByTestId('edit-named-remove')).toHaveCSS('outline-offset', '-2px')
  // on to Save
  await settled(page)
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('edit-cancel')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(save(page)).toBeFocused()
  await expect(save(page)).toHaveText(translate('ko', 'accessEdit.saveLess', { n: 3 }))
  await page.keyboard.press('Enter')
  await expect(panel(page)).toHaveCount(0)
  await expect(page.getByTestId('folder-detail-edit')).toBeFocused()
  expect(await rulesOf(page, 'shared')).toEqual(['everyone::read', 'user:dan:none'])
})
