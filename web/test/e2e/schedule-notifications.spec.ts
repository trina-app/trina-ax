import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { CSRF_HEADER } from '@mycel/shared/api'

test('templates stay dormant, select readable source/private output, and reuse the request after a lost response', async ({ page }) => {
  await reset(page)
  const requests: Record<string, unknown>[] = []
  await page.route('**/api/schedule-templates', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: [{ id: 'daily-file-index', version: 1, repeat: 'daily' }, { id: 'weekly-summary', version: 1, repeat: 'weekly' }], timeZone: 'Asia/Seoul' } })
    const body = route.request().postDataJSON(); requests.push(body)
    if (requests.length === 1) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Synthetic lost response' } } })
    return route.fulfill({ json: { id: 'template-fixture', title: 'Weekly', prompt: 'internal template prompt', repeat: 'weekly', time: body.time, weekday: body.weekday, day: null, date: null, projectId: null, enabled: true, nextRunAt: '2026-11-02T00:00:00Z', lastRunAt: null, lastChatId: null, templateId: body.templateId, templateVersion: 1, sourcePath: body.sourcePath, outputPath: body.outputPath, pendingDueAt: null, retryAt: null, lastOutcome: null } })
  })
  await page.route('**/api/files/tree*', route => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? ''
    return route.fulfill({ json: { path, access: path ? 'read' : 'none', entries: path ? [] : [{ path: 'shared', name: 'shared', type: 'folder', size: null, mime: null, mtime: '2026-10-01T00:00:00Z', access: 'read' }], nextCursor: null } })
  })
  await signIn(page)
  await page.goto('/settings/schedules')
  const form = page.getByTestId('schedule-templates')
  await expect(form.getByTestId('template-create')).toBeDisabled()
  expect(requests).toHaveLength(0)
  await form.getByTestId('template-kind').selectOption('weekly-summary')
  await form.getByTestId('template-source').click()
  await expect(page.getByTestId('folder-pick')).toBeDisabled()
  await page.getByRole('dialog').getByRole('button', { name: 'shared' }).click()
  await page.getByTestId('folder-pick').click()
  await form.getByTestId('template-time').fill('08:30')
  await form.getByTestId('template-weekday').selectOption('1')
  await form.getByTestId('template-create').click()
  await expect(form.getByTestId('template-create')).toBeEnabled()
  await form.getByTestId('template-create').click()
  await expect(form).toContainText('예약했어요')
  expect(requests).toHaveLength(2)
  expect(requests[0]).toEqual(requests[1])
  expect(requests[1]).toMatchObject({ templateId: 'weekly-summary', sourcePath: 'shared', time: '08:30', weekday: 1, outputPath: 'users/olga/reports' })
  await expect(page.getByTestId('schedule-list')).toContainText('shared → users/olga/reports')
  await expect(page.getByTestId('schedule-list')).not.toContainText('internal template prompt')
})

test('inbox shows generic events, persists preferences and marks items read without requesting OS permission', async ({ page }) => {
  await reset(page)
  let prefs = { scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true }
  let readAt: string | null = null, reads = 0, preferenceUpdates = 0
  await page.addInitScript(() => {
    ;(window as unknown as { permissionCalls: number }).permissionCalls = 0
    Notification.requestPermission = async () => { (window as unknown as { permissionCalls: number }).permissionCalls++; return 'denied' }
  })
  const item = () => ({ id: 'notification-fixture', eventType: 'schedule.success', sourceId: 'opaque-occurrence', code: 'schedule.success', createdAt: '2026-10-27T01:00:00Z', readAt, chatId: null, link: null })
  await page.route('**/api/notification-preferences', async route => {
    if (route.request().method() === 'PATCH') { preferenceUpdates++; prefs = { ...prefs, ...route.request().postDataJSON() } }
    return route.fulfill({ json: prefs })
  })
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { items: [item()], nextCursor: null, unreadCount: readAt ? 0 : 1 } }))
  await page.route('**/api/notifications/*/read', route => { reads++; readAt = '2026-10-27T01:10:00Z'; return route.fulfill({ json: item() }) })
  await signIn(page)
  await page.goto('/settings/notifications')
  const pane = page.getByTestId('notifications')
  await expect(pane).toContainText('읽지 않은 알림 1개')
  await expect(pane.getByTestId('notification-item')).toContainText('예약 작업이 완료됐어요')
  await pane.getByTestId('notification-pref-scheduleSuccess').uncheck()
  await expect(pane.getByTestId('notification-pref-scheduleSuccess')).not.toBeChecked()
  expect(preferenceUpdates).toBe(1)
  await pane.getByRole('button', { name: '읽음 표시' }).click()
  await expect(pane).toContainText('읽지 않은 알림 0개')
  expect(reads).toBe(1)
  await page.reload()
  await expect(pane.getByTestId('notification-pref-scheduleSuccess')).not.toBeChecked()
  await expect(pane.getByRole('button', { name: '읽음 표시' })).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { permissionCalls: number }).permissionCalls)).toBe(0)
})

test('access revocation drops an inbox chat link; changing locale during a save does not leave preferences disabled', async ({ page }) => {
  await reset(page)
  let allowed = true, changed = false, release!: () => void, received!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { received = resolve })
  await page.route('**/api/notification-preferences', async route => {
    if (route.request().method() === 'PATCH') { received(); await held; changed = true }
    return route.fulfill({ json: { scheduleSuccess: !changed, scheduleFailure: true, connectionReconnect: true } })
  })
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { items: [{ id: 'event-access', sourceId: 'opaque', eventType: 'schedule.success', code: 'schedule.success', createdAt: '2026-10-27T00:00:00Z', readAt: null, chatId: allowed ? 'private-result' : null, link: allowed ? 'chat' : null }], nextCursor: null, unreadCount: 1 } }))
  await signIn(page); await page.goto('/settings/notifications')
  const pane = page.getByTestId('notifications'), pref = pane.getByTestId('notification-pref-scheduleSuccess')
  await expect(pane.locator('a[href="/c/private-result"]')).toBeVisible()
  allowed = false
  await page.request.post('/__test/revoke', { data: { path: 'shared' } })
  await expect(pane.locator('a[href="/c/private-result"]')).toHaveCount(0)
  await pref.uncheck(); await started
  const result = await page.request.patch('/api/me', { headers: { [CSRF_HEADER]: '1' }, data: { locale: 'en' } })
  expect(result.ok()).toBeTruthy()
  await expect(pane.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible()
  release()
  await expect(pref).toBeEnabled(); await expect(pref).not.toBeChecked()
})
