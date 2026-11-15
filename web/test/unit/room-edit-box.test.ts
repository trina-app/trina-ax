// A phone's edit in the box at the bottom (store/roomEdit.ts): which places have a box, the edit by place, and the last
// box of a place to go ending its edit; and lib/autoGrow.ts fitHeight, which makes an edit field as tall as its text.
import { expect, test } from 'bun:test'
import { hasRoomBox, registerRoomBox, useRoomEdit } from '../../src/store/roomEdit'
import { fitHeight } from '../../src/lib/autoGrow'

test('an edit goes to a place with a box; the last box of the place to go ends it', () => {
  const place = 'room-1/root-1'
  expect(hasRoomBox(place)).toBe(false)
  const a = registerRoomBox(place)
  const b = registerRoomBox(place)
  expect(hasRoomBox(place)).toBe(true)
  useRoomEdit.getState().start(place, 'm1')
  useRoomEdit.getState().start('room-1', 'm2')
  expect(useRoomEdit.getState().editing).toEqual({ [place]: 'm1', 'room-1': 'm2' })
  a()
  // one box of the place is still there: the edit stays
  expect(useRoomEdit.getState().editing[place]).toBe('m1')
  b()
  expect(hasRoomBox(place)).toBe(false)
  expect(useRoomEdit.getState().editing).toEqual({ 'room-1': 'm2' })
  useRoomEdit.getState().end('room-1')
  useRoomEdit.getState().end('room-1')
  expect(useRoomEdit.getState().editing).toEqual({})
})

test('fitHeight: as tall as the text, at most max; a field not drawn keeps its height', () => {
  const ta = { style: { height: '40px' }, scrollHeight: 130 } as unknown as HTMLTextAreaElement
  fitHeight(ta)
  expect(ta.style.height).toBe('130px')
  fitHeight(ta, 100)
  expect(ta.style.height).toBe('100px')
  const hidden = { style: { height: '44px' }, scrollHeight: 0 } as unknown as HTMLTextAreaElement
  fitHeight(hidden)
  expect(hidden.style.height).toBe('44px')
})
