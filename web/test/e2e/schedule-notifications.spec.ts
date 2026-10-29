import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { CSRF_HEADER, ERROR_MESSAGES, type Schedule } from '@mycel/shared/api'
import { ko } from '../../src/i18n/ko'
import { en } from '../../src/i18n/en'
import { id } from '../../src/i18n/id'

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

for (const timezoneId of ['Asia/Jakarta', 'UTC']) {
  test.describe(`schedule settings in a ${timezoneId} browser`, () => {
    test.use({ timezoneId })
    for (const [locale, dict] of [['ko', ko], ['en', en], ['id', id]] as const) {
      test(`team dates, terminal once states and deletion preserve the result chat (${locale})`, async ({ page }) => {
        await reset(page, { teamLocale: locale, usersFollowTeam: true })
        await page.clock.setFixedTime(new Date('2026-10-28T14:00:00Z'))
        await signIn(page)
        const created = await page.request.post('/api/chats', { headers: { [CSRF_HEADER]: '1' }, data: { title: 'Schedule result' } })
        expect(created.ok()).toBeTruthy()
        const chat = await created.json()
        const base: Schedule = { id: 'active', title: 'Active once', prompt: 'Scheduled task fixture', repeat: 'once', time: '00:09', date: '2026-10-29', weekday: null, day: null, projectId: null, enabled: true, nextRunAt: '2026-10-28T15:09:00Z', lastRunAt: null, lastChatId: null, resumeBlockedReason: null }
        let items: Schedule[] = [
          base,
          { ...base, id: 'deferred', title: 'Deferred once', nextRunAt: '2026-10-28T14:00:00Z', pendingDueAt: '2026-10-28T14:00:00Z', retryAt: '2026-10-28T15:10:00Z' },
          { ...base, id: 'completed', title: 'Completed once', enabled: false, nextRunAt: null, lastRunAt: '2026-10-28T13:00:00Z', lastChatId: chat.id, resumeBlockedReason: 'completed' },
          { ...base, id: 'expired', title: 'Expired once', date: '2026-10-27', enabled: false, nextRunAt: null, resumeBlockedReason: 'expired' },
          { ...base, id: 'future', title: 'Future once', enabled: false, nextRunAt: null },
          { ...base, id: 'daily', title: 'Recurring task', repeat: 'daily', date: null, enabled: false, nextRunAt: null },
        ]
        const patches: string[] = [], deleted: string[] = []
        await page.route('**/api/schedules', route => route.fulfill({ json: { items, timeZone: 'Asia/Seoul' } }))
        await page.route('**/api/schedules/*', route => {
          const key = route.request().url().split('/').pop()!
          if (route.request().method() === 'DELETE') {
            deleted.push(key); items = items.filter(item => item.id !== key)
            return route.fulfill({ status: 204 })
          }
          patches.push(key)
          const item = items.find(item => item.id === key)!
          item.enabled = route.request().postDataJSON().enabled
          item.nextRunAt = item.enabled ? base.nextRunAt : null
          return route.fulfill({ json: item })
        })
        await page.goto('/settings/schedules')
        const list = page.getByTestId('schedule-list')
        const row = (title: string) => list.getByRole('listitem').filter({ hasText: title })
        // Expected Seoul wall time, independent of the browser zone and ICU punctuation.
        const wall = await page.evaluate(({ locale }) => {
          const formatter = new Intl.DateTimeFormat({ ko: 'ko-KR', en: 'en-US', id: 'id-ID' }[locale], { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
          return [formatter.format(new Date('2026-10-29T00:09:00Z')), formatter.format(new Date('2026-10-29T00:10:00Z'))]
        }, { locale })
        await expect(row('Active once')).toContainText(dict['schedules.next'].replace('{time}', wall[0]!))
        await expect(row('Deferred once')).toContainText(dict['scheduleTemplates.deferred'].replace('{time}', wall[1]!))
        await expect(list.locator('+ p')).toHaveText(dict['schedules.timeZone'].replace('{tz}', 'Asia/Seoul'))
        for (const [title, reason] of [['Completed once', 'completed'], ['Expired once', 'expired']] as const) {
          await expect(row(title)).toContainText(dict[`schedules.${reason}Hint`])
          await expect(row(title).getByText(dict[`schedules.${reason}`], { exact: true })).toBeVisible()
          // visible but disabled, described by the reason (no silent no-op, no PATCH)
          const resume = row(title).getByRole('button', { name: dict['schedules.resume'], exact: true })
          await expect(resume).toBeDisabled()
          await expect(resume).toHaveAccessibleDescription(dict[`schedules.${reason}Hint`])
        }
        await expect(row('Deferred once').getByRole('button', { name: dict['schedules.pause'], exact: true })).toBeVisible()
        for (const title of ['Future once', 'Recurring task']) {
          await row(title).getByRole('button', { name: dict['schedules.resume'], exact: true }).click()
          await expect(row(title).getByRole('button', { name: dict['schedules.pause'], exact: true })).toBeVisible()
          await row(title).getByRole('button', { name: dict['schedules.pause'], exact: true }).click()
          await expect(row(title).getByRole('button', { name: dict['schedules.resume'], exact: true })).toBeVisible()
        }
        expect(patches).toEqual(['future', 'future', 'daily', 'daily'])
        await expect(row('Completed once').getByRole('link', { name: dict['schedules.lastRun'] })).toHaveAttribute('href', `/c/${chat.id}`)
        await row('Completed once').getByRole('button', { name: dict['schedules.delete'], exact: true }).click()
        await expect(page.getByRole('dialog')).toContainText(dict['schedules.deleteBody'].replace('{title}', 'Completed once'))
        await page.getByRole('dialog').getByRole('button', { name: dict['schedules.delete'], exact: true }).click()
        await expect(row('Completed once')).toHaveCount(0)
        expect(deleted).toEqual(['completed'])
        const kept = await page.request.get(`/api/chats/${chat.id}`)
        expect(kept.ok()).toBeTruthy()
        expect((await kept.json()).deletedAt).toBeNull()
        await page.goto(`/c/${chat.id}`)
        await expect(page.getByTestId('composer-input')).toBeVisible()
      })
    }
  })
}

for (const [locale, dict] of [['ko', ko], ['en', en], ['id', id]] as const) {
  test(`personal schedule limit differs from plan limits and follows the UI language (${locale})`, async ({ page }) => {
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    const requests: Record<string, unknown>[] = []
    let planLimit = false
    await page.route('**/api/schedule-templates', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { items: [{ id: 'daily-file-index', version: 1, repeat: 'daily' }], timeZone: 'Asia/Seoul' } })
      requests.push(route.request().postDataJSON())
      return route.fulfill({ status: 409, json: { error: planLimit
        ? { code: 'plan_limit', message: ERROR_MESSAGES.plan_limit.en }
        : { code: 'conflict', message: en['scheduleTemplates.limit'].replace('{n}', '20'), params: { reason: 'schedule_limit', limit: 20 } } } })
    })
    await page.route('**/api/files/tree*', route => {
      const path = new URL(route.request().url()).searchParams.get('path') ?? ''
      return route.fulfill({ json: { path, access: path ? 'read' : 'none', entries: path ? [] : [{ path: 'shared', name: 'shared', type: 'folder', size: null, mime: null, mtime: '2026-10-01T00:00:00Z', access: 'read' }], nextCursor: null } })
    })
    await signIn(page)
    await page.goto('/settings/schedules')
    const form = page.getByTestId('schedule-templates')
    await form.getByTestId('template-source').click()
    await page.getByRole('dialog').getByRole('button', { name: 'shared' }).click()
    await page.getByTestId('folder-pick').click()
    for (let i = 0; i < 2; i++) {
      await form.getByTestId('template-create').click()
      await expect(form.getByRole('alert')).toHaveText(dict['scheduleTemplates.limit'].replace('{n}', '20'))
      await expect(form).not.toContainText(ERROR_MESSAGES.plan_limit[locale])
    }
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])

    const nextLocale = locale === 'en' ? 'id' : 'en', nextDict = nextLocale === 'en' ? en : id
    const changed = await page.request.patch('/api/me', { headers: { [CSRF_HEADER]: '1' }, data: { locale: nextLocale } })
    expect(changed.ok()).toBeTruthy()
    await expect(form.getByRole('alert')).toHaveText(nextDict['scheduleTemplates.limit'].replace('{n}', '20'))
    expect(requests).toHaveLength(2)

    const restored = await page.request.patch('/api/me', { headers: { [CSRF_HEADER]: '1' }, data: { locale } })
    expect(restored.ok()).toBeTruthy()
    await expect(form.getByRole('alert')).toHaveText(dict['scheduleTemplates.limit'].replace('{n}', '20'))
    planLimit = true
    await form.getByTestId('template-create').click()
    await expect(form.getByRole('alert')).toHaveText(ERROR_MESSAGES.plan_limit[locale])
    await expect(form).not.toContainText(dict['scheduleTemplates.limit'].replace('{n}', '20'))
    expect(requests).toHaveLength(3)
    expect(requests[2]).toEqual(requests[0])
  })
}
