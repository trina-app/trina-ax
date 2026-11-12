// Where each Admin address sits on a phone (pages/admin/adminScreens.ts): ‹ goes one level up, and a page opened from
// outside gets the pages above it put under it, outermost first.
import { describe, expect, test } from 'bun:test'
import { adminChain, adminDesktopOf, adminParent, isAdminDetail } from '../../src/pages/admin/adminScreens'

describe('adminParent', () => {
  test('the list under 나, a page under the list, a group of Team settings under Team settings', () => {
    expect(adminParent('/admin')).toBe('/settings')
    expect(adminParent('/admin/members')).toBe('/admin')
    expect(adminParent('/admin/members?member=bob')).toBe('/admin')
    expect(adminParent('/admin/settings/general')).toBe('/admin/settings')
  })
  test('an item\'s own page under its page', () => {
    expect(adminParent('/admin/connectors/gmail')).toBe('/admin/connectors')
    expect(adminParent('/admin/plugins/hwp')).toBe('/admin/plugins')
    expect(adminParent('/admin/providers/codex')).toBe('/admin/providers')
    expect(adminParent('/admin/members/bob')).toBe('/admin/members')
    expect(adminParent('/admin/audit/abc?kind=auth')).toBe('/admin/audit')
  })
  test('Folder permissions: the editor under its folder, the folder under the tree, a person under By person', () => {
    expect(adminParent('/admin/folders?folder=a%2Fb&rules=a%2Fb')).toBe('/admin/folders?folder=a%2Fb')
    expect(adminParent('/admin/folders?rules=gone')).toBe('/admin/folders')
    expect(adminParent('/admin/folders?folder=a')).toBe('/admin/folders')
    expect(adminParent('/admin/folders?folder=')).toBe('/admin/folders')
    expect(adminParent('/admin/folders?view=people&person=bob')).toBe('/admin/folders?view=people')
    expect(adminParent('/admin/folders?view=people')).toBe('/admin')
  })
  test('outside Admin: none', () => {
    expect(adminParent('/settings')).toBeNull()
    expect(adminParent('/files?path=admin')).toBeNull()
  })
})

test('adminChain: the pages above, outermost first, without 나', () => {
  expect(adminChain('/admin')).toEqual([])
  expect(adminChain('/admin/usage')).toEqual(['/admin'])
  expect(adminChain('/admin/connectors/gmail')).toEqual(['/admin', '/admin/connectors'])
  expect(adminChain('/admin/folders?folder=a&rules=a')).toEqual(['/admin', '/admin/folders', '/admin/folders?folder=a'])
})

test('isAdminDetail: a page under another page of its section', () => {
  expect(isAdminDetail('/admin/connectors/gmail')).toBe(true)
  expect(isAdminDetail('/admin/folders?folder=a')).toBe(true)
  expect(isAdminDetail('/admin/settings/general')).toBe(true)
  expect(isAdminDetail('/admin/connectors')).toBe(false)
  expect(isAdminDetail('/admin')).toBe(false)
})

test('adminDesktopOf: a phone\'s own page is the same thing in the page on a computer', () => {
  expect(adminDesktopOf('members', 'bob')).toBe('/admin/members?member=bob')
  expect(adminDesktopOf('providers', 'claude-code')).toBe('/admin/providers?engine=claude-code')
  expect(adminDesktopOf('groups', 'g1')).toBe('/admin/groups')
  expect(adminDesktopOf('audit', 'x')).toBe('/admin/audit')
  // pages that have their address on every width stay
  expect(adminDesktopOf('connectors', 'gmail')).toBeNull()
  expect(adminDesktopOf('plugins', 'hwp')).toBeNull()
})
