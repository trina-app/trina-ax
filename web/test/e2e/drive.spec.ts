import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

const disconnected = { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null }
const account = { name: 'Drive Fixture', email: 'fixture@example.test' }
const expiresAt = '2099-01-01T00:00:00.000Z'

test('Drive requires explicit account confirmation, and disconnect explains a failed remote revoke', async ({ page }) => {
  await reset(page)
  let completed = 0, disconnectedCount = 0
  await page.context().route('https://accounts.google.com/**', r => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
  await page.route('**/api/integrations/google-drive', r => {
    if (r.request().method() === 'DELETE') { disconnectedCount++; return r.fulfill({ json: { disconnected: true, revocation: 'unavailable' } }) }
    return r.fulfill({ json: disconnected })
  })
  await page.route('**/api/integrations/google-drive/authorize', r => r.fulfill({ json: { flowId: 'fixture-flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic', expiresAt } }))
  await page.route('**/api/integrations/google-drive/flows/**', r => {
    if (r.request().method() === 'POST') { completed++; return r.fulfill({ json: { ...disconnected, status: 'connected', account } }) }
    return r.fulfill({ json: { flowId: 'fixture-flow', state: 'ready', account, expiresAt, reason: null } })
  })
  await signIn(page)
  await page.goto('/settings/drive')
  const pane = page.getByTestId('drive-connection')
  await pane.getByRole('button', { name: 'Google 계정 연결', exact: true }).click()
  await expect(page.getByTestId('drive-account')).toContainText('fixture@example.test')
  expect(completed).toBe(0)
  await pane.getByRole('button', { name: '이 계정으로 연결 완료' }).click()
  await expect(page.getByTestId('drive-status')).toHaveText('연결됨')
  expect(completed).toBe(1)
  await pane.getByRole('button', { name: '연결 해제', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '연결 해제', exact: true }).click()
  await expect(page.getByTestId('drive-status')).toHaveText('연결되지 않음')
  await expect(pane).toContainText('Google 계정의 연결된 앱에서도')
  expect(disconnectedCount).toBe(1)
})

test('a server without Google configuration offers no authorization action', async ({ page }) => {
  await reset(page)
  await page.route('**/api/integrations/google-drive', r => r.fulfill({ json: { ...disconnected, configured: false, status: 'disabled' } }))
  await signIn(page)
  await page.goto('/settings/drive')
  const pane = page.getByTestId('drive-connection')
  await expect(pane).toContainText('관리자가 이 서버의 Google Drive 연결을 먼저 설정')
  await expect(pane.getByRole('button', { name: 'Google 계정 연결' })).toHaveCount(0)
})
