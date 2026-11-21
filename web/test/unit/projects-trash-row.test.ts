// The Projects list's Trash (src/components/panels/ProjectsTrash.tsx, docs/decisions/20261121-projects-trash-out-of-list.md):
// which trashed projects its dialog lists (only what GET /api/projects?manage=1 already gives the person: a member's or
// one they may restore, its folder still in the trash), newest first, and that the row shows only to someone who may
// restore at least one of them.
import { describe, expect, test } from 'bun:test'
import type { Project } from '@mycel/shared/api'
import { showsProjectsTrash, trashedProjects } from '../../src/components/panels/ProjectsTrash'

const P = (id: string, o: Partial<Project> = {}): Project => ({
  id,
  name: id,
  folderPath: `projects/${id}`,
  instructions: '',
  createdBy: { id: 'olga', name: 'Olga' },
  createdAt: '2026-11-01T00:00:00.000Z',
  canEdit: false,
  ...o,
}) as Project
const trashed = (at: string, by = 'Olga') => ({ inTrash: true, trashed: { by: { id: by.toLowerCase(), name: by }, at } })

describe('trashedProjects', () => {
  test('lists the trashed ones the person is a member of or may restore, newest first; never a live one', () => {
    const list = [
      P('live'),
      P('managed-live', { member: false }),
      P('old', { ...trashed('2026-11-10T00:00:00.000Z'), wasMember: true }),
      P('new', { ...trashed('2026-11-20T00:00:00.000Z'), canRestore: true }),
      P('both', { ...trashed('2026-11-15T00:00:00.000Z'), wasMember: true, canRestore: true }),
    ]
    expect(trashedProjects(list).map((p) => p.id)).toEqual(['new', 'both', 'old'])
  })
  test('one deleted for good from Files › Trash (no `trashed`), or neither a member nor a restorer: not listed', () => {
    const list = [
      P('purged', { inTrash: true, member: false }),
      P('stranger', { ...trashed('2026-11-10T00:00:00.000Z'), member: false }),
    ]
    expect(trashedProjects(list)).toEqual([])
    expect(trashedProjects(null)).toEqual([])
  })
})

describe('showsProjectsTrash', () => {
  test('the row shows only when at least one is the person\'s to restore', () => {
    const member = P('m', { ...trashed('2026-11-10T00:00:00.000Z'), wasMember: true })
    const restorer = P('r', { ...trashed('2026-11-11T00:00:00.000Z'), canRestore: true })
    expect(showsProjectsTrash(trashedProjects([member]))).toBe(false)
    expect(showsProjectsTrash(trashedProjects([member, restorer]))).toBe(true)
    expect(showsProjectsTrash([])).toBe(false)
  })
})
