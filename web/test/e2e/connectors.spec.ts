import { expect, test } from '@playwright/test'
import { OWNER, reset, signIn } from './helpers'
const id = 'a'.repeat(43)
const consent = { id, clientName: 'Synthetic Claude', redirectOrigin: 'https://claude.ai', scopes: ['mcp:read', 'offline_access'], resource: 'https://team.example/mcp', expiresAt: '2099-01-01T00:00:00.000Z' }

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
  await pane.getByTestId('connector-allow').click()
  await expect(page).toHaveURL('https://claude.ai/api/mcp/auth_callback?code=synthetic-code&state=synthetic-state')
  expect(decisions).toEqual([{ allow: true }])
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
  await page.goto('/settings/connectors')
  const pane = page.getByTestId('connector-connections')
  await expect(pane).toContainText('https://team.example/mcp')
  await expect(pane.getByTestId('connector-item')).toHaveCount(1)
  await pane.getByRole('button', { name: '연결 해제', exact: true }).click()
  await expect(pane.getByTestId('connector-item')).toHaveCount(0)
  expect(revoked).toBe(true)
})
