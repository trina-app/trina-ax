// The storage card (Admin › System): files sent in conversations are a line of their own, right after Team files; an
// older server that does not send the part shows no line, never a made-up 0
// (docs/decisions/20261116-room-files-storage-line.md).
import { expect, test } from 'bun:test'
import { storageLines } from '../../src/pages/admin/System'

const base = { team: 10, history: 1, trash: 2, backups: 3, models: 4, data: 5, app: 6, other: 7 }

test('Files in conversations comes right after Team files', () => {
  expect(storageLines({ ...base, rooms: 9, kept: 1 }).map(([k]) => k)).toEqual(['team', 'rooms', 'history', 'trash', 'backups', 'models', 'data', 'app', 'other'])
  expect(storageLines({ ...base, rooms: 0 }).find(([k]) => k === 'rooms')).toEqual(['rooms', 0])
})

test('an older server without the part: no line', () => {
  expect(storageLines(base).map(([k]) => k)).not.toContain('rooms')
  expect(storageLines(base)).toHaveLength(8)
})
