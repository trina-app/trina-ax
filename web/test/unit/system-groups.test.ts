// Admin › System on a phone (pages/admin/systemGroups.ts; QA TC-269): its parts as a list of pages, which ones a
// person has, and where /admin/system/<group> goes (a computer: the one page; a group not there: the list).
import { describe, expect, test } from 'bun:test'
import { systemGroup, systemGroups, systemRedirect } from '../../src/pages/admin/systemGroups'

const ids = (o: Parameters<typeof systemGroups>[0]) => systemGroups(o).map((g) => g.id)

describe('systemGroups', () => {
  test('the owner: every part, in the page\'s order', () => {
    expect(ids({ owner: true, features: undefined })).toEqual(['storage', 'updates', 'health', 'connection', 'connected', 'backups', 'export'])
  })
  test('a server without connected folders has no such page', () => {
    expect(ids({ owner: true, features: { connectedFolders: false } })).not.toContain('connected')
  })
  test('an admin: the storage, and the automatic updates in office mode only (while unknown, the address is kept)', () => {
    expect(ids({ owner: false, features: undefined, office: false })).toEqual(['storage'])
    expect(ids({ owner: false, features: undefined, office: true })).toEqual(['storage', 'updates'])
    expect(systemGroup('updates', { owner: false, features: undefined })?.id).toBe('updates')
    expect(systemGroup('backups', { owner: false, features: undefined })).toBeUndefined()
  })
})

test('systemRedirect: a phone keeps a group it has; a computer opens the one page at that part; anything else, the list', () => {
  const owner = { owner: true, features: undefined }
  expect(systemRedirect({ sub: undefined, phone: true, ...owner })).toBeNull()
  expect(systemRedirect({ sub: undefined, phone: false, ...owner })).toBeNull()
  expect(systemRedirect({ sub: 'backups', phone: true, ...owner })).toBeNull()
  expect(systemRedirect({ sub: 'backups', phone: false, ...owner })).toBe('/admin/system#system-backups')
  expect(systemRedirect({ sub: 'nope', phone: true, ...owner })).toBe('/admin/system')
  expect(systemRedirect({ sub: 'backups', phone: true, owner: false, features: undefined })).toBe('/admin/system')
  expect(systemRedirect({ sub: 'connected', phone: true, owner: true, features: { connectedFolders: false } })).toBe('/admin/system')
})
