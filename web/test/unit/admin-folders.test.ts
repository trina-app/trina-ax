// Admin > Folder permissions: what the "remove all rules" dialog says happens next. It must match the permission
// function (server/src/policy/access.ts): the nearest folder above with rules decides, none above means only the owner
// and admins, and rules inside a personal folder never applied. And which rows cannot be removed (the server refuses
// them too: server/src/routes/admin.ts).
import { expect, test } from 'bun:test'
import type { Folder } from '@mycel/shared/api'
import { afterRemoval, keepReason } from '../../src/pages/admin/Folders'

const at = '2026-01-01T00:00:00.000Z'
const folder = (path: string, rules: number): Folder => ({
  id: `id-${path || 'root'}`, path, exists: true, createdAt: at,
  rules: Array.from({ length: rules }, (_, i) => ({ id: `r-${path}-${i}`, folderId: `id-${path}`, subjectType: 'everyone', subjectId: null, access: 'read', updatedBy: null, updatedAt: at })),
})

test('the nearest folder above with rules decides', () => {
  const list = [folder('finance', 1), folder('finance/2026', 0), folder('finance/2026/q3', 2)]
  expect(afterRemoval('finance/2026/q3', list)).toEqual({ kind: 'above', path: 'finance' })
  expect(afterRemoval('finance/2026/q3/drafts', [...list, folder('finance/2026', 1)])).toEqual({ kind: 'above', path: 'finance/2026/q3' })
})

test('a rule on the team folder counts as the folder above', () => {
  expect(afterRemoval('projects/apollo', [folder('', 1), folder('projects/apollo', 1)])).toEqual({ kind: 'above', path: '' })
})

test('no folder above with rules: only the owner and admins see it then', () => {
  expect(afterRemoval('projects/apollo', [folder('projects/apollo', 1), folder('projects', 0)])).toEqual({ kind: 'none' })
  expect(afterRemoval('', [folder('', 1)])).toEqual({ kind: 'none' })
  // a sibling with a common prefix is not above it
  expect(afterRemoval('shared-old/x', [folder('shared', 1), folder('shared-old/x', 1)])).toEqual({ kind: 'none' })
})

test('inside a personal folder rules never applied', () => {
  expect(afterRemoval('users/ana/moved', [folder('', 1), folder('users/ana/moved', 1)])).toEqual({ kind: 'personal' })
})

test('rows that stay: shared/ and skills/ (the team defaults) and a group\'s folder; any other row may go', () => {
  expect(keepReason({ path: 'shared', groupId: null })).toBe('team')
  expect(keepReason({ path: 'skills' })).toBe('team')
  expect(keepReason({ path: 'groups/sales', groupId: 'g1' })).toBe('group')
  for (const path of ['', 'skills/finance', 'shared/board', 'groups/old', 'projects/apollo']) expect(keepReason({ path, groupId: null })).toBeNull()
})
