// Where a computer's "…" menu goes (components/rooms/MenuButton.tsx menuSpot): under its button with their right edges in
// line, above it near the window's bottom, and never off a side of the window. A sidebar row's notification menu (wider
// than the room left of its "…" in English) slides right instead of losing the first words of each item.
import { expect, test } from 'bun:test'
import { MENU_EDGE, menuSpot } from '../../src/components/rooms/MenuButton'

const view = { width: 1440, height: 900 }
/** a button's box: its right edge, top and bottom */
const at = (right: number, top: number, bottom = top + 28) => ({ right, top, bottom })

test('room to spare: under the button, right edges in line, 4px apart', () => {
  expect(menuSpot(at(1400, 60), { width: 200, height: 160 }, view)).toEqual({ x: 1200, y: 92 })
})

test('a menu wider than the room left of its button slides right, 8px from the window\'s left', () => {
  // a sidebar row's "…" at 268px and a 300px "Notify me about" menu: it would start at -32px
  expect(menuSpot(at(268, 300), { width: 300, height: 200 }, view).x).toBe(MENU_EDGE)
  // the same at a narrow window (900px wide)
  expect(menuSpot(at(268, 300), { width: 300, height: 200 }, { width: 900, height: 700 }).x).toBe(MENU_EDGE)
})

test('never past the right edge either', () => {
  expect(menuSpot(at(1440, 60), { width: 200, height: 160 }, view).x).toBe(1440 - MENU_EDGE - 200)
})

test('near the bottom it opens upward; with no room either way it is kept inside, bottom first', () => {
  // under it would end at 860 + 4 + 160 > 892: above it instead
  expect(menuSpot(at(1400, 832, 860), { width: 200, height: 160 }, view).y).toBe(832 - 4 - 160)
  // a short window: neither fits, its bottom 8px from the window's bottom, its top never above 8px
  expect(menuSpot(at(1400, 150, 178), { width: 200, height: 240 }, { width: 1440, height: 300 }).y).toBe(300 - MENU_EDGE - 240)
  expect(menuSpot(at(1400, 150, 178), { width: 200, height: 400 }, { width: 1440, height: 300 }).y).toBe(MENU_EDGE)
})
