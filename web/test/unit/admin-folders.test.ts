// Admin > Folder permissions: the "remove all rules" dialog shows what the server's preview says changes, person by
// person (access walks up per person, so the nearest folder above with rules is not the answer for everyone), and only
// the people whose access changes.
import { expect, test } from 'bun:test'
import type { PreviewResponse } from '@mycel/shared/api'
import { previewChanges } from '../../src/pages/admin/Folders'

const row = (id: string, before: 'none' | 'read' | 'write', after: 'none' | 'read' | 'write') => ({ user: { id, name: id.toUpperCase() }, role: 'member' as const, before, after })

test('only the people whose access changes, per folder; folders where nothing changes are left out', () => {
  const preview: PreviewResponse = {
    folders: [
      { path: 'finance/2026', users: [row('olga', 'write', 'write'), row('bob', 'none', 'read'), row('ana', 'write', 'write')] },
      { path: 'finance/2026/q3', users: [row('bob', 'none', 'none')] },
      { path: 'finance/2026/drafts', users: [row('ana', 'read', 'none')] },
    ],
    losing: [{ user: { id: 'ana', name: 'ANA' }, paths: ['finance/2026/drafts'], chatsReset: 1 }],
  }
  expect(previewChanges(preview)).toEqual([
    { path: 'finance/2026', users: [row('bob', 'none', 'read')] },
    { path: 'finance/2026/drafts', users: [row('ana', 'read', 'none')] },
  ])
})

test('nothing changes: no folder', () => {
  expect(previewChanges({ folders: [{ path: 'docs', users: [row('olga', 'write', 'write'), row('bob', 'read', 'read')] }], losing: [] })).toEqual([])
})
