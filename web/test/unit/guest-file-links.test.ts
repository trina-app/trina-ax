// A guest has no Files screen (App.tsx NotForGuests: /files goes Home), so folder links open their project's own files
// screen or nowhere (docs/DECISIONS.md "A guest's AI reads their own rooms; file links and the delete card for guests").
import { expect, test } from 'bun:test'
import { guestAppHref, guestFolderHref } from '../../src/lib/guests'

const projects = [{ id: 'p1', folderPath: 'projects/Quote prep' }]

test('a folder of their project opens its files screen; anything else opens nothing', () => {
  expect(guestFolderHref('projects/Quote prep', projects)).toBe('/projects/p1/files')
  expect(guestFolderHref('projects/Quote prep/drafts/v2/', projects)).toBe('/projects/p1/files?dir=drafts%2Fv2')
  // a project whose name starts the same is another project
  expect(guestFolderHref('projects/Quote prep 2', projects)).toBeNull()
  expect(guestFolderHref('users/erin', projects)).toBeNull()
  expect(guestFolderHref('shared', projects)).toBeNull()
})

test('an in-app address as a guest opens it: /files addresses mapped or dropped, the rest kept', () => {
  const f = (p: string) => guestFolderHref(p, projects)
  expect(guestAppHref(`/files?path=${encodeURIComponent('projects/Quote prep/drafts')}`, f)).toBe('/projects/p1/files?dir=drafts')
  expect(guestAppHref('/files?path=shared', f)).toBeNull()
  expect(guestAppHref('/files', f)).toBeNull()
  expect(guestAppHref('/files/view?path=shared%2Fa.md', f)).toBeNull()
  expect(guestAppHref('/files?view=trash', f)).toBeNull()
  expect(guestAppHref('/rooms/r1', f)).toBe('/rooms/r1')
  expect(guestAppHref('/filesystem', f)).toBe('/filesystem')
})
