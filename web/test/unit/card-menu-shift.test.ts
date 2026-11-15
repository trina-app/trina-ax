// A card's ⋯ menu (components/integrations/AppConnectorCard.tsx CardMenu) opens under its button, right edges in line,
// and is moved in to stay clear of both sides of the window (QA TC-935: on a phone it opened off the left edge).
import { expect, test } from 'bun:test'
import { cardMenuShift } from '../../src/components/integrations/AppConnectorCard'
import { MENU_EDGE } from '../../src/components/rooms/MenuButton'

test('room to spare: not moved', () => {
  expect(cardMenuShift(1200, 160, 1440)).toBe(0)
})

test('off the left edge (a phone, ⋯ next to Connected): moved right to 8px from the left', () => {
  // measured on a 390px phone before the fix: the menu began at -40px
  expect(cardMenuShift(-40, 160, 390)).toBe(40 + MENU_EDGE)
  expect(-40 + cardMenuShift(-40, 160, 390)).toBe(MENU_EDGE)
})

test('off the right edge: moved left; wider than the window: kept at the left edge', () => {
  expect(cardMenuShift(300, 160, 390)).toBe(390 - MENU_EDGE - 160 - 300)
  expect(-10 + cardMenuShift(-10, 400, 390)).toBe(MENU_EDGE)
})
