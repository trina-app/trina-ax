// No server/engine startup: prevent new P4 routes from silently escaping the permanent permission matrix.
import { expect, test } from 'bun:test'
import path from 'node:path'
import { DRIVE, NOTIFICATIONS, SCHEDULES, PUSH } from '@mycel/shared/api'
import { enumerateRoutes } from './lib/matrix'
import { SPECS } from './lib/cases'
const root = path.resolve(import.meta.dir, '../..')
const p4 = [...Object.keys(DRIVE), ...Object.keys(NOTIFICATIONS), ...Object.keys(PUSH), 'listScheduleTemplates', 'createScheduleFromTemplate', 'frequentQuestions', 'popularSkills']
test('every P4 contract route is enumerated and has a permanent persona matrix case', () => {
  const routes = enumerateRoutes(root)
  for (const key of p4) {
    expect(routes, key).toContain(key)
    expect(SPECS[key], key).toBeDefined()
  }
  expect(SCHEDULES.createScheduleFromTemplate.auth).toBe('user')
})
