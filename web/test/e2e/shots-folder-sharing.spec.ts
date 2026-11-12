// Screenshots of the Files page's "Who can open it" panel (docs/DECISIONS.md "Who can open it, like Drive's Share"),
// for reviewing it by eye: an admin at 1440 (light and dark, English and Korean), a member at 1440, the confirm that
// names who gains and who loses access, and the phone sheet at 390. Only when SHARING_SHOTS names a folder to write them to.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const dir = process.env.SHARING_SHOTS
const call = async (page: Page, method: 'post' | 'patch', url: string, data: unknown) => {
  const r = await page.request[method](url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.ok(), url).toBeTruthy()
  return r.json()
}
const everyone = (access: 'none' | 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })

test.skip(!dir, 'SHARING_SHOTS is not set')

/** Acme: Sales (Alice, Bob, Erin), Leads (Bob, Carol). Company-wide: everyone views. Sales folder: Leads view, Erin edits,
 * nobody else. Quotes: Sales edits, Alice only views. Plans: nothing of its own. */
async function world(page: Page, locale: 'en' | 'ko') {
  await reset(page, { teamLocale: locale, usersFollowTeam: true, withAdmin: true })
  await signIn(page)
  const ids: Record<string, string> = {}
  for (const [id, name] of [['alice', 'Alice'], ['carol', 'Carol'], ['erin', 'Erin'], ['dan', 'Dan']] as const) await call(page, 'post', '/api/admin/users', { username: id, name, role: 'member', groupIds: [], temporaryPassword: 'tiger4271x' })
  const sales = await call(page, 'post', '/api/admin/groups', { name: locale === 'ko' ? '영업' : 'Sales', memberIds: ['alice', 'bob', 'erin'] })
  const leads = await call(page, 'post', '/api/admin/groups', { name: locale === 'ko' ? '팀장단' : 'Leads', memberIds: ['bob', 'carol'] })
  ids.sales = sales.id
  ids.leads = leads.id
  // the mock keeps each person's groups on the person too
  for (const [u, gs] of [['alice', [sales.id]], ['bob', [sales.id, leads.id]], ['carol', [leads.id]], ['erin', [sales.id]]] as const) await call(page, 'patch', `/api/admin/users/${u}`, { groupIds: gs })
  for (const f of ['shared/Sales/Quotes/q4.md', 'shared/Sales/Plans/2027.md']) await call(page, 'post', '/__test/file', { path: f, text: 'x' })
  await call(page, 'post', '/api/admin/folders', { path: 'shared', create: false, rules: [everyone('read')] })
  await call(page, 'post', '/api/admin/folders', { path: 'shared/Sales', create: false, rules: [{ subjectType: 'group', subjectId: leads.id, access: 'read' }, { subjectType: 'user', subjectId: 'erin', access: 'write' }, everyone('none')] })
  await call(page, 'post', '/api/admin/folders', { path: 'shared/Sales/Quotes', create: false, rules: [{ subjectType: 'group', subjectId: sales.id, access: 'write' }, { subjectType: 'user', subjectId: 'alice', access: 'read' }] })
  return ids
}

const openPanel = async (page: Page, path: string) => {
  await page.goto(`/files?path=${encodeURIComponent(path)}`)
  await page.getByTestId('folder-access-chip').click()
  await expect(page.getByTestId('folder-access-panel')).toBeVisible()
}

test('who can open it: admin 1440 light and dark (en, ko), the confirm, a member, the phone sheet', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await world(page, 'en')
  // the admin's panel on Quotes, with Dan just added: what will happen, by name
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await openPanel(page, 'shared/Sales/Quotes')
    await expect(page.getByTestId('sharing-above')).toBeVisible()
    await page.getByTestId('edit-add').fill('Dan')
    await page.getByTestId('edit-add-option').filter({ hasText: 'Dan' }).click()
    await expect(page.getByTestId('sharing-outcome')).toContainText('Dan')
    await page.screenshot({ path: `${dir}/admin-1440-${theme}.png` })
    await page.getByTestId('sharing-cancel').click()
    await page.getByTestId('dialog-confirm').click()
    await page.keyboard.press('Escape')
  }
  await page.emulateMedia({ colorScheme: 'light' })
  // the confirm on Plans: Sales set to "Can view" here lowers Erin (she could edit through the Sales folder) and lets Alice in
  await openPanel(page, 'shared/Sales/Plans')
  await page.getByTestId('edit-add').fill('Sal')
  await page.getByTestId('edit-add-option').filter({ hasText: 'Sales' }).click()
  await expect(page.getByTestId('sharing-outcome')).toContainText('Erin')
  await page.getByTestId('sharing-save').click()
  await expect(page.getByTestId('sharing-confirm-body')).toBeVisible()
  await page.screenshot({ path: `${dir}/confirm-lose-access-1440-light.png` })
  await page.getByRole('dialog').filter({ has: page.getByTestId('dialog-confirm') }).getByRole('button', { name: 'Cancel' }).click()

  // a member (Bob writes in Quotes through Sales): the count and who changes it, nothing else
  const bob = await browser.newPage({ baseURL: new URL(page.url()).origin, locale: 'en-US', viewport: { width: 1440, height: 900 } })
  await signIn(bob, { username: 'bob', password: 'bob password 1' })
  await openPanel(bob, 'shared/Sales/Quotes')
  await expect(bob.getByTestId('folder-access-headline')).toBeVisible()
  await bob.screenshot({ path: `${dir}/member-1440-light.png` })
  await bob.close()

  // the phone sheet, an admin with a change
  await page.setViewportSize({ width: 390, height: 844 })
  await openPanel(page, 'shared/Sales/Quotes')
  await page.getByTestId('sharing-row').first().getByTestId('sharing-level').selectOption('read')
  await expect(page.getByTestId('sharing-outcome')).toBeVisible()
  await page.screenshot({ path: `${dir}/admin-390-light.png` })

  // Korean, 1440 light
  await page.setViewportSize({ width: 1440, height: 900 })
  await world(page, 'ko')
  await openPanel(page, 'shared/Sales/Quotes')
  await page.getByTestId('edit-add').fill('Dan')
  await page.getByTestId('edit-add-option').filter({ hasText: 'Dan' }).click()
  await expect(page.getByTestId('sharing-outcome')).toContainText('Dan')
  await page.screenshot({ path: `${dir}/admin-1440-light-ko.png` })
})

test('the confirm for a view-only change (QA TC-232): "open", never "open or edit"; 1440 and 390 light, and Korean', async ({ page }) => {
  for (const [locale, width] of [['en', 1440], ['en', 390], ['ko', 1440]] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await world(page, locale)
    // a group nobody is in yet and Dan, both "Can view" on Plans
    await call(page, 'post', '/api/admin/groups', { name: locale === 'ko' ? '디자인' : 'Design', memberIds: [] })
    await openPanel(page, 'shared/Sales/Plans')
    for (const [q, name] of [['Dan', 'Dan'], [locale === 'ko' ? '디자' : 'Des', locale === 'ko' ? '디자인' : 'Design']] as const) {
      await page.getByTestId('edit-add').fill(q)
      await page.getByTestId('edit-add-option').filter({ hasText: name }).click()
    }
    await page.getByTestId('sharing-save').click()
    await expect(page.getByTestId('sharing-confirm-latent')).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/confirm-view-only-${width}-light${locale === 'ko' ? '-ko' : ''}.png` })
    await page.getByRole('dialog').filter({ has: page.getByTestId('dialog-confirm') }).getByRole('button', { name: locale === 'ko' ? '취소' : 'Cancel' }).click()
  }
})
