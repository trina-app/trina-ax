// No server start: every Admin > Plugins route stays in the permanent persona matrix and stays owner/admin-only.
import { expect, test } from 'bun:test'
import path from 'node:path'
import { PLUGINS } from '@mycel/shared/api'
import { enumerateRoutes } from './lib/matrix'
import { SPECS } from './lib/cases'

test('every plugin route is admin-level, enumerated and has a persona matrix case', () => {
  const routes = enumerateRoutes(path.resolve(import.meta.dir, '../..'))
  for (const [key, ep] of Object.entries(PLUGINS)) {
    expect(ep.auth, key).toBe('admin')
    expect(ep.path.startsWith('/api/admin/plugins'), key).toBe(true)
    expect(routes, key).toContain(key)
    expect(SPECS[key], key).toBeDefined()
  }
})
