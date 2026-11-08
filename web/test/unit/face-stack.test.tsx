// The small marks of people and groups (components/FaceStack.tsx, components/GroupTile.tsx): a group's tile is a
// neutral rounded square with the people mark, the size of a picture, no letter; the stack overlaps at most 3 faces and
// then "+N" (2 on a phone), decorative, its ring the page's colour (the hover colour on a hovered row only when asked).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { FaceStack } from '../../src/components/FaceStack'
import { GroupTile } from '../../src/components/GroupTile'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })

const people = ['Alex', 'Bob', 'Cho', 'Dev', 'Eve'].map((name) => ({ id: name.toLowerCase(), name }))
/** the stack's tiles in order: a photo or the text, with the class (which says where it shows) */
const tiles = (s: FakeElement) => s.children.map((e) => ({ text: e.localName === 'img' ? 'photo' : e.textContent, cls: e.getAttribute('class') ?? '' }))

test('a group tile: decorative, square-ish (not round), the people mark and no letter, the given size', async () => {
  const page = await mount(<GroupTile size={20} />)
  try {
    const tile = page.get('group-tile')
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    expect(tile.textContent).toBe('')
    expect(tile.querySelector('svg')).not.toBeNull()
    expect(tile.className).not.toContain('rounded-full')
    expect(tile.className).toContain('bg-hover')
    expect(tile.className).not.toMatch(/accent/)
    const style = tile.style as unknown as Record<string, string>
    expect([style.width, style.height]).toEqual(['20px', '20px'])
    expect(style.borderRadius).toBe('6px')
  } finally { await page.unmount() }
})

test('a stack: at most 3 faces and "+2" on a computer, 2 and "+3" on a phone; decorative; photos where there are', async () => {
  const page = await mount(<FaceStack people={[{ ...people[0]!, avatarVersion: 3 }, ...people.slice(1)]} count={5} testId="t" />)
  try {
    const stack = page.get('t-people')
    expect(stack.getAttribute('aria-hidden')).toBe('true')
    const all = tiles(stack)
    // only the first 3 of the 5 given
    expect(all.map((x) => x.text)).toEqual(['photo', 'B', 'C', '+2', '+3'])
    expect(stack.querySelector('img')!.getAttribute('src')).toContain('/api/people/alex/avatar')
    expect(all[0]!.cls).toContain('z-[3]')
    expect(all[1]!.cls).toMatch(/(^| )-ml-1( |$)/)
    expect(all[2]!.cls).toContain('max-sm:hidden')
    expect(page.get('t-more').className).toContain('max-sm:hidden')
    expect(page.get('t-more-phone').className).toMatch(/(^| )sm:hidden/)
    expect(page.get('t-more-phone').className).not.toContain('max-sm:hidden')
    // the page's colour around each one; no hover colour unless asked
    expect(all.every((x) => x.cls.includes('ring-canvas') && !x.cls.includes('group-hover:'))).toBe(true)
  } finally { await page.unmount() }
})

test('a stack of 1 or 2: no "+N"; of 3: no "+N" on a computer, "+1" on a phone; hoverRing adds the hover colour', async () => {
  let page = await mount(<FaceStack people={people.slice(0, 2)} count={2} testId="t" />)
  try {
    expect(tiles(page.get('t-people')).map((x) => x.text)).toEqual(['A', 'B'])
    expect(page.find('t-more')).toBeNull()
    expect(page.find('t-more-phone')).toBeNull()
  } finally { await page.unmount() }
  page = await mount(<FaceStack people={people.slice(0, 3)} count={3} hoverRing testId="t" />)
  try {
    expect(tiles(page.get('t-people')).map((x) => x.text)).toEqual(['A', 'B', 'C', '+1'])
    expect(page.find('t-more')).toBeNull()
    expect(tiles(page.get('t-people')).every((x) => x.cls.includes('group-hover:ring-hover'))).toBe(true)
  } finally { await page.unmount() }
})
