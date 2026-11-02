// An admin asks a member to connect a service as the member's own connection, against the mock server
// (components/integrations/RequestDialog.tsx, AnswerDialog.tsx): the admin fills in the service and picks the member,
// copies the link; the member opens it, enters their own key and it becomes their connection; the admin sees it
// connected and never the key. A withdrawn request's link says so; a decline shows on the admin's list.
import { expect, test } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const KEY = 'member-own-' + 'k'.repeat(24)
const BOB = { username: 'bob', password: 'bob password 1' }

test('ask, connect with the member\'s own key, see it connected; the key never reaches the admin', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/integrations')
  await expect(page.getByText('아직 보낸 요청이 없어요')).toBeVisible()
  await page.getByTestId('integration-request-add').click()
  const dialog = page.getByRole('dialog')
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
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/admin/integration-requests') && r.method() === 'POST')
  await page.getByTestId('integration-request-send').click()
  expect((await sent).postDataJSON()).toEqual({ userId: 'bob', kind: 'http', name: 'Ledger', url: 'https://api.ledger.example/v1', auth: 'header', authHeader: 'X-API-Key', notes: 'GET /entries lists entries' })
  await expect(page.getByTestId('integration-request-sent')).toContainText('Bob님에게 Ledger 연결 요청 알림을 보냈어요.')
  const link = (await page.getByTestId('integration-request-link').textContent())!
  expect(link).toMatch(/\/settings\/integrations\?request=[0-9a-f-]+$/)
  await dialog.getByRole('button', { name: '닫기' }).first().click()
  const asked = page.getByTestId('integration-request').filter({ hasText: 'Ledger' })
  await expect(asked).toHaveAttribute('data-state', 'waiting')
  await expect(asked).toContainText('받는 사람 Bob')
  await expect(asked.getByRole('button', { name: '링크 복사' })).toBeVisible()

  // the owner opening the member's link finds nothing
  await page.goto(new URL(link).pathname + new URL(link).search)
  await expect(page.getByTestId('integrations-asked-note')).toContainText('이 요청을 찾을 수 없어요.')

  // Bob opens the link: the request opens with what the admin filled in, fixed
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto(new URL(link).pathname + new URL(link).search)
  const answer = page.getByRole('dialog')
  await expect(answer.getByRole('heading', { name: 'Ledger 연결' })).toBeVisible()
  await expect(answer).toContainText('Olga님이 이 서비스를 내 계정으로 연결해 달라고 요청했어요.')
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
  await page.goto('/admin/integrations')
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
  await page.goto('/admin/integrations')
  await page.getByTestId('integration-request').filter({ hasText: 'Board' }).getByTestId('integration-request-withdraw').click()
  await page.getByRole('dialog').getByRole('button', { name: '철회' }).click()
  await expect(page.getByTestId('integration-request').filter({ hasText: 'Board' })).toHaveAttribute('data-state', 'withdrawn')

  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto(`/settings/integrations?request=${gone.id}`)
  await expect(page.getByTestId('integrations-asked-note')).toContainText('관리자가 Board 연결 요청을 철회했어요.')
  const wiki = page.getByTestId('integration-asked').filter({ hasText: 'Wiki' })
  // a sign-in: the token goes to the address's host, even when the sign-in page is the real service's
  await wiki.getByTestId('integration-asked-connect').click()
  await expect(page.getByTestId('integration-answer-host-warning')).toContainText('로그인 토큰을 받는 곳: mcp.wiki.example.')
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await expect(wiki).toContainText('Olga님이 요청')
  await expect(page.getByTestId('integration-asked')).toHaveCount(1)
  await wiki.getByTestId('integration-asked-decline').click()
  await page.getByRole('dialog').getByRole('button', { name: '거절' }).click()
  await expect(page.getByTestId('integrations-asked-list')).toHaveCount(0)

  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/admin/integrations')
  await expect(page.getByTestId('integration-request').filter({ hasText: 'Wiki' })).toHaveAttribute('data-state', 'declined')
  await expect(page.getByTestId('integration-request').filter({ hasText: 'Wiki' })).toContainText('거절됨')
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})
