// The admin menu marks one item (pages/admin/AdminLayout.tsx adminMenuItemClass): the page that is open. The item under
// the pointer only gets darker text, so after an Inbox notice opens Admin with the pointer resting on another item, two
// items never look marked (QA TC-3035).
import { expect, test } from 'bun:test'
import { adminMenuItemClass } from '../../src/pages/admin/AdminLayout'

const bg = (cls: string, hover: boolean) => cls.split(/\s+/).filter((c) => (hover ? c.startsWith('hover:bg-') : c.startsWith('bg-'))).map((c) => c.replace('hover:', ''))

test('only the open page has a fill; an item under the pointer gets darker text, no fill', () => {
  expect(bg(adminMenuItemClass(true), false)).toEqual(['bg-hover'])
  expect(bg(adminMenuItemClass(false), false)).toEqual([])
  expect(bg(adminMenuItemClass(false), true)).toEqual([])
  expect(adminMenuItemClass(false).split(' ')).toContain('hover:text-ink')
})
