// An admin asks a member to connect a service as the member's own connection, against the mock server
// (components/integrations/RequestDialog.tsx, AnswerDialog.tsx): from Add connection's menu, a popup takes the service
// and the member; sent, it closes with a short note and the request is a row in the Connected list (its link copied
// from there). The member opens the link, enters their own key and it becomes their connection; the admin sees it
// connected and never the key. A withdrawn request leaves the list and its link says so; a decline shows on the row.
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const KEY = 'member-own-' + 'k'.repeat(24)
const BOB = { username: 'bob', password: 'bob password 1' }

test('ask, connect with the member\'s own key, see it connected; the key never reaches the admin', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/connectors')
  // no card or empty list for requests on the page: asking is in Add connection's menu
  await expect(page.getByText('아직 보낸 요청이 없어요')).toHaveCount(0)
  await expect(page.getByTestId('integration-request')).toHaveCount(0)
  await page.getByTestId('integration-add-more').click()
  await expect(page.getByRole('menuitem')).toHaveText(['팀 연결', '멤버에게 연결 요청…'])
  await page.getByTestId('integration-request-add').click()
  const dialog = page.getByRole('dialog').filter({ hasNot: page.getByTestId('settings-menu') }) // not Settings itself
  await expect(dialog.getByRole('heading', { name: '멤버에게 연결 요청' })).toBeVisible()
  // nothing goes without a member
  await page.getByTestId('integration-request-send').click()
  await expect(dialog).toContainText('멤버를 골라 주세요.')
  await page.getByTestId('integration-request-user').selectOption('bob')
  await page.getByTestId('integration-request-kind-http').check()
  // an API signs in with a key only, which the member enters
  await expect(page.getByTestId('integration-request-auth-oauth')).toHaveCount(0)
  await expect(dialog).toContainText('키는 멤버가 직접 넣어요.')
  await page.getByTestId('integration-request-header-custom').check()
  await page.getByTestId('integration-request-header-name').fill('X-API-Key')
  await page.getByTestId('integration-request-name').fill('Ledger')
  await page.getByTestId('integration-request-url').fill('https://api.ledger.example/v1')
  await page.getByTestId('integration-request-notes').fill('GET /entries lists entries')
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/admin/integration-requests') && r.request().method() === 'POST')
  await page.getByTestId('integration-request-send').click()
  const res = await sent
  expect(res.request().postDataJSON()).toEqual({ userId: 'bob', kind: 'http', name: 'Ledger', url: 'https://api.ledger.example/v1', auth: 'header', authHeader: 'X-API-Key', notes: 'GET /entries lists entries' })
  const link = ((await res.json()) as { link: string }).link
  // the server's link still says integrations: Settings sends it on to Connectors with the request open
  expect(link).toMatch(/\/settings\/integrations\?request=[0-9a-f-]+$/)
  // sent: the popup closes with a short note, and the focus is back on the menu's button
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Bob님에게 요청을 보냈어요.')).toBeVisible()
  await expect(page.getByTestId('integration-add-more')).toBeFocused()
  const asked = page.getByTestId('integration-request').filter({ hasText: 'Ledger' })
  await expect(asked).toHaveAttribute('data-state', 'waiting')
  await expect(asked.getByTestId('integration-request-chip')).toHaveText('요청함 · Bob')
  await expect(asked.getByRole('button', { name: '링크 복사' })).toBeVisible()

  // the owner opening the member's link finds nothing
  await page.goto(new URL(link).pathname + new URL(link).search)
  await expect(page.getByTestId('integrations-asked-note')).toContainText('이 요청을 찾을 수 없어요.')

  // Bob opens the link: the request opens with what the admin filled in, fixed
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto(new URL(link).pathname + new URL(link).search)
  const answer = page.getByRole('dialog').filter({ hasNot: page.getByTestId('settings-menu') }) // not Settings itself
  await expect(answer.getByRole('heading', { name: 'Ledger 연결' })).toBeVisible()
  await expect(answer).toContainText('관리자가 이 서비스를 내 계정으로 연결해 달라고 요청했어요.')
  // admins are never named to members (docs/DECISIONS.md "Admins are never named")
  await expect(answer).not.toContainText('Olga')
  await expect(answer).toContainText('https://api.ledger.example/v1')
  await expect(answer).toContainText('X-API-Key')
  // the admin chose the address: where the key goes is said plainly, the host in bold, before the key field
  const warning = page.getByTestId('integration-answer-host-warning')
  await expect(warning).toContainText('이 키를 받는 곳: api.ledger.example. 이곳이 정말 Ledger의 주소일 때만 키를 넣어 주세요.')
  await expect(warning.locator('strong').first()).toHaveText('api.ledger.example')
  await expect(answer).toContainText('관리자도 앱에서 볼 수 없지만, 이 주소의 서비스는 키를 받아요.')
  await expect(page.getByTestId('integration-answer-write-allow')).toHaveCount(0)
  await page.getByTestId('integration-answer-connect').click()
  await expect(answer).toContainText('키를 넣어 주세요.')
  await page.getByTestId('integration-answer-key').fill(KEY)
  await page.getByTestId('integration-answer-write-deny').check()
  const done = page.waitForRequest((r) => /\/api\/integration-requests\/[^/]+\/complete$/.test(r.url()))
  await page.getByTestId('integration-answer-connect').click()
  expect((await done).postDataJSON()).toEqual({ writePolicy: 'deny', secret: KEY })
  await expect(answer).toHaveCount(0)
  const mine = page.getByTestId('integrations-mine').getByTestId('integration-row').filter({ hasText: 'Ledger' })
  await expect(mine).toBeVisible()
  await mine.getByTestId('integration-toggle').click()
  await expect(mine.getByTestId('integration-meta')).toContainText('키 저장됨')
  await expect(page.getByTestId('integrations-asked-list')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(KEY)

  // the admin sees it connected, and nothing of the key or the member's connection
  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/admin/connectors')
  await expect(page.getByTestId('integration-request').filter({ hasText: 'Ledger' })).toHaveAttribute('data-state', 'connected')
  await expect(page.locator('body')).not.toContainText(KEY)
  for (const p of ['/api/admin/integration-requests', '/api/admin/integrations']) expect(await (await page.request.get(p)).text()).not.toContain(KEY)
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})

test('withdrawn and declined requests: the member\'s link says what became of it; the admin sees the decline', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const make = async (name: string, url: string) => {
    const r = await page.request.post('/api/admin/integration-requests', { headers: { [CSRF_HEADER]: '1' }, data: { userId: 'bob', kind: 'mcp', name, url, auth: 'oauth' } })
    expect(r.status()).toBe(201)
    return (await r.json()) as { id: string; link: string }
  }
  const gone = await make('Board', 'https://mcp.board.example/mcp')
  await make('Wiki', 'https://mcp.wiki.example/mcp')
  await page.goto('/admin/connectors')
  await page.getByTestId('integration-request').filter({ hasText: 'Board' }).getByTestId('integration-request-withdraw').click()
  await page.getByRole('dialog').getByRole('button', { name: '철회' }).click()
  // withdrawn: the row goes (the admin did it), with a short note
  await expect(page.getByTestId('integration-request').filter({ hasText: 'Board' })).toHaveCount(0)
  await expect(page.getByText('요청을 철회했어요.')).toBeVisible()

  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto(`/connectors?request=${gone.id}`)
  await expect(page.getByTestId('integrations-asked-note')).toContainText('관리자가 Board 연결 요청을 철회했어요.')
  const wiki = page.getByTestId('integration-asked').filter({ hasText: 'Wiki' })
  // a sign-in: the token goes to the address's host, even when the sign-in page is the real service's
  await wiki.getByTestId('integration-asked-connect').click()
  await expect(page.getByTestId('integration-answer-host-warning')).toContainText('로그인 토큰을 받는 곳: mcp.wiki.example.')
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await expect(wiki).toContainText('관리자가 요청')
  await expect(wiki).not.toContainText('Olga')
  await expect(page.getByTestId('integration-asked')).toHaveCount(1)
  await wiki.getByTestId('integration-asked-decline').click()
  await page.getByRole('dialog').getByRole('button', { name: '거절' }).click()
  await expect(page.getByTestId('integrations-asked-list')).toHaveCount(0)

  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/admin/connectors')
  await expect(page.getByTestId('integration-request').filter({ hasText: 'Wiki' })).toHaveAttribute('data-state', 'declined')
  const declined = page.getByTestId('integration-request').filter({ hasText: 'Wiki' })
  await expect(declined.getByTestId('integration-request-chip')).toHaveText('거절됨 · Bob')
  // asked again: the popup opens with the same service and member
  await declined.getByTestId('integration-request-again').click()
  await expect(page.getByTestId('integration-request-name')).toHaveValue('Wiki')
  await expect(page.getByTestId('integration-request-url')).toHaveValue('https://mcp.wiki.example/mcp')
  await expect(page.getByTestId('integration-request-user')).toHaveValue('bob')
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await expect(declined.getByTestId('integration-request-again')).toBeFocused()
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})

test('Add connection menu: ask a member in a popup, the request is a row, withdraw it; a phone leaves adding to a computer', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  // a phone has no Add (by address) and so no ⌄ with "Ask a member" (TC-270, phone-admin-pages.spec.ts): at a
  // computer's width the menu, the popup and the row; at a phone's, the request row and nothing sideways
  await signIn(page)
  await page.goto('/admin/connectors')
  await page.getByTestId('integration-add-more').click()
  // the menu works from the keyboard: Esc closes it and returns to its button
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByTestId('integration-add-more')).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('integration-request-add')).toBeFocused()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog').filter({ hasNot: page.getByTestId('settings-menu') })
  await expect(dialog.getByRole('heading', { name: '멤버에게 연결 요청' })).toBeVisible()
  // why a member's own key: one line in the popup, not on the page
  await expect(dialog).toContainText('호출마다 키 주인의 이름으로 기록하는 서비스에 써요.')
  await page.getByTestId('integration-request-user').selectOption('bob')
  await page.getByTestId('integration-request-name').fill('Tracker')
  await page.getByTestId('integration-request-url').fill('https://mcp.tracker.example/mcp')
  await page.getByTestId('integration-request-send').click()
  await expect(dialog).toHaveCount(0)
  const row = page.getByTestId('integration-request').filter({ hasText: 'Tracker' })
  await expect(row.getByTestId('integration-request-chip')).toHaveText('요청함 · Bob')
  await expect(row).toContainText('mcp.tracker.example')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(row).toBeVisible()
  await expect(page.getByTestId('integration-add-more')).toHaveCount(0)
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  expect(sideways).toBe(false)
  await page.setViewportSize({ width: 1360, height: 860 })
  await row.getByTestId('integration-request-withdraw').click()
  await page.getByRole('dialog').getByRole('button', { name: '철회' }).click()
  await expect(row).toHaveCount(0)
  // the Team connection item opens the team dialog, like the main button
  await page.getByTestId('integration-add-more').click()
  await page.getByTestId('integration-add-team').click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: '팀 서비스 추가' })).toBeVisible()
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})

for (const scheme of ['light', 'dark'] as const) {
  test(`asking a member: the menu, the popup and a request row have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const r = await page.request.post('/api/admin/integration-requests', { headers: { [CSRF_HEADER]: '1' }, data: { userId: 'bob', kind: 'mcp', name: 'Board', url: 'https://mcp.board.example/mcp', auth: 'oauth' } })
    expect(r.status()).toBe(201)
    await page.goto('/admin/connectors')
    await expect(page.getByTestId('integration-request')).toHaveCount(1)
    const axe = async (only?: string) => {
      const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe')
      const res = await (only ? builder.include(only) : builder).analyze()
      return res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    expect(await axe()).toEqual([])
    await page.getByTestId('integration-add-more').click()
    await expect(page.getByRole('menu')).toBeVisible()
    // the menu itself: open, it lies over the list under the title, whose small row buttons it covers for the moment
    // (axe's target-size counts that); the list was checked above
    expect(await axe('[role="menu"]')).toEqual([])
    await page.getByTestId('integration-request-add').click()
    await expect(page.getByTestId('integration-request-user')).toBeVisible()
    expect(await axe()).toEqual([])
  })
}
