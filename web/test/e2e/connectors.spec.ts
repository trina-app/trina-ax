import { expect, test } from '@playwright/test'
import { OWNER, reset, signIn } from './helpers'
const id = 'a'.repeat(43)
// what a member sees for an app that asked for read (the 401 header's scope) and refresh: write is theirs to tick
const consent = { id, clientName: 'Synthetic Claude', redirectOrigin: 'https://claude.ai', scopes: ['mcp:read', 'offline_access'], optional: ['mcp:write'], admin: false, resource: 'https://team.example/mcp', expiresAt: '2099-01-01T00:00:00.000Z' }

test('login preserves the pending connector request path and query', async ({ page }) => {
  await reset(page)
  await page.route('**/api/connectors/remote/requests/*', route => route.fulfill({ json: consent }))
  await page.goto('/connectors/authorize?id=' + id)
  await expect(page.getByTestId('login-submit')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('next')).toBe('/connectors/authorize?id=' + id)
  await page.getByTestId('login-username').fill(OWNER.username)
  await page.getByTestId('login-password').fill(OWNER.password)
  await page.getByTestId('login-submit').click()
  await expect(page).toHaveURL(new RegExp('/connectors/authorize\\?id=' + id + '$'))
  await expect(page.getByTestId('connector-consent')).toContainText('Synthetic Claude')
})

test('connector consent requires a decision and sends only the chosen decision before the callback', async ({ page }) => {
  await reset(page)
  let decisions: unknown[] = []
  await page.route('**/api/connectors/remote/requests/*', route => {
    if (route.request().method() === 'POST') { decisions.push(route.request().postDataJSON()); return route.fulfill({ json: { redirectUrl: 'https://claude.ai/api/mcp/auth_callback?code=synthetic-code&state=synthetic-state' } }) }
    return route.fulfill({ json: consent })
  })
  await page.context().route('https://claude.ai/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic callback only</p>' }))
  await signIn(page)
  await page.goto('/connectors/authorize?id=' + id)
  const pane = page.getByTestId('connector-consent')
  await expect(pane).toContainText('Synthetic Claude')
  await expect(pane).toContainText('https://claude.ai')
  expect(decisions).toEqual([])
  // reading (and renewing, asked) is always granted; writing is a box, unticked because the app did not ask for it
  await expect(pane.getByTestId('connector-granted').locator('li')).toHaveCount(2)
  await expect(pane.getByTestId('connector-write-check')).not.toBeChecked()
  await expect(pane.getByTestId('connector-admin')).toHaveCount(0)
  await pane.getByTestId('connector-allow').click()
  await expect(page).toHaveURL('https://claude.ai/api/mcp/auth_callback?code=synthetic-code&state=synthetic-state')
  expect(decisions).toEqual([{ allow: true, write: false }])
})

test('write is a box whatever the app asked; an owner or admin is told the connection also manages groups, with no box', async ({ page }) => {
  await reset(page)
  const decisions: unknown[] = []
  let shown: Record<string, unknown> = {}
  await page.route('**/api/connectors/remote/requests/*', route => {
    if (route.request().method() === 'POST') { decisions.push(route.request().postDataJSON()); return route.fulfill({ json: { redirectUrl: 'https://claude.ai/api/mcp/auth_callback?code=synthetic-code' } }) }
    return route.fulfill({ json: { ...consent, ...shown } })
  })
  await page.context().route('https://claude.ai/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic callback only</p>' }))
  await signIn(page)
  // an owner, for an app that asked for read only: the write box, unticked, and one line about group management
  shown = { scopes: ['mcp:read'], admin: true }
  await page.goto('/connectors/authorize?id=' + id)
  const pane = page.getByTestId('connector-consent')
  await expect(pane.getByTestId('connector-write')).toContainText('파일 쓰기')
  await expect(pane.getByTestId('connector-admin')).toHaveText('팀장·관리자라서 이 연결로 팀 그룹도 관리할 수 있어요.')
  await expect(pane.locator('input[type=checkbox]')).toHaveCount(1)
  await expect(pane.getByTestId('connector-granted').locator('li')).toHaveCount(1)
  await expect(pane.getByTestId('connector-write-check')).not.toBeChecked()
  await pane.getByTestId('connector-write-check').check()
  await pane.getByTestId('connector-allow').click()
  await expect(page).toHaveURL('https://claude.ai/api/mcp/auth_callback?code=synthetic-code')
  // an app that asked for write: the box starts ticked; the body never carries group management
  shown = { scopes: ['mcp:read', 'mcp:write'], admin: true }
  await page.goto('/connectors/authorize?id=' + id)
  await expect(pane.getByTestId('connector-write-check')).toBeChecked()
  await pane.getByTestId('connector-allow').click()
  await expect(page).toHaveURL('https://claude.ai/api/mcp/auth_callback?code=synthetic-code')
  expect(decisions).toEqual([{ allow: true, write: true }, { allow: true, write: true }])
})

test('reading conversations starts ticked, writing in them unticked and only with reading; ChatGPT\'s callback is followed', async ({ page }) => {
  await reset(page)
  const decisions: unknown[] = []
  await page.route('**/api/connectors/remote/requests/*', route => {
    if (route.request().method() === 'POST') { decisions.push(route.request().postDataJSON()); return route.fulfill({ json: { redirectUrl: 'https://chatgpt.com/connector_platform_oauth_redirect?code=synthetic-code' } }) }
    return route.fulfill({ json: { ...consent, redirectOrigin: 'https://chatgpt.com', optional: ['mcp:write', 'mcp:rooms', 'mcp:rooms.write'] } })
  })
  await page.context().route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic callback only</p>' }))
  await signIn(page)
  await page.goto('/connectors/authorize?id=' + id)
  const pane = page.getByTestId('connector-consent')
  await expect(pane.getByTestId('connector-rooms')).toContainText('대화 읽기')
  await expect(pane.getByTestId('connector-rooms-write')).toContainText('대화 쓰기')
  await expect(pane.getByTestId('connector-rooms-check')).toBeChecked()
  await expect(pane.getByTestId('connector-rooms-write-check')).not.toBeChecked()
  // writing needs reading: unticking reading unticks and locks writing
  await pane.getByTestId('connector-rooms-write-check').check()
  await pane.getByTestId('connector-rooms-check').uncheck()
  await expect(pane.getByTestId('connector-rooms-write-check')).not.toBeChecked()
  await expect(pane.getByTestId('connector-rooms-write-check')).toBeDisabled()
  await pane.getByTestId('connector-rooms-check').check()
  await pane.getByTestId('connector-rooms-write-check').check()
  await pane.getByTestId('connector-allow').click()
  await expect(page).toHaveURL('https://chatgpt.com/connector_platform_oauth_redirect?code=synthetic-code')
  expect(decisions).toEqual([{ allow: true, write: false, rooms: true, roomsWrite: true }])
})

test('connector denial and malformed requests cannot silently authorize', async ({ page }) => {
  await reset(page)
  const decisions: unknown[] = []
  await page.route('**/api/connectors/remote/requests/*', route => {
    if (route.request().method() === 'POST') { decisions.push(route.request().postDataJSON()); return route.fulfill({ json: { redirectUrl: 'https://claude.ai/api/mcp/auth_callback?error=access_denied' } }) }
    return route.fulfill({ json: consent })
  })
  await page.context().route('https://claude.ai/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Denied callback</p>' }))
  await signIn(page)
  await page.goto('/connectors/authorize?id=malformed')
  await expect(page.getByTestId('connector-allow')).toHaveCount(0)
  await page.goto('/connectors/authorize?id=' + id)
  await page.getByTestId('connector-deny').click()
  await expect(page).toHaveURL(/error=access_denied/)
  expect(decisions).toEqual([{ allow: false }])
})

test('own connector settings show the address and revoke the selected connection', async ({ page }) => {
  await reset(page)
  let revoked = false
  await page.route('**/api/connectors/remote', route => route.fulfill({ json: { configured: true, resource: consent.resource, items: revoked ? [] : [{ id: 'synthetic-grant', clientName: 'Synthetic Claude', scopes: consent.scopes, createdAt: '2026-01-01T00:00:00.000Z', expiresAt: consent.expiresAt, currentSession: true }] } }))
  await page.route('**/api/connectors/remote/synthetic-grant', route => { expect(route.request().method()).toBe('DELETE'); revoked = true; return route.fulfill({ status: 204 }) })
  await signIn(page)
  // the team uses Slack (the mock's /api/slack/me): its line is in Connectors, on Yours (pages/Integrations.tsx)
  await page.goto('/settings/connectors')
  await expect(page.getByTestId('integrations').getByTestId('slack-account')).toContainText('Slack')
  await page.goto('/settings/ai-apps')
  const pane = page.getByTestId('ai-apps')
  await expect(pane).toContainText('https://team.example/mcp')
  await expect(pane.getByTestId('connector-item')).toHaveCount(1)
  await pane.getByRole('button', { name: '연결 해제', exact: true }).click()
  await expect(pane.getByTestId('connector-item')).toHaveCount(0)
  expect(revoked).toBe(true)
})
