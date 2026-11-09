// Tokens in a plain text box (lib/textTokens.ts): where an edit happened, what it does to the ranges, a deletion into a
// token's edge, where a caret may stand, and the text cut into parts.
import { describe, expect, test } from 'bun:test'
import { applyEdit, findEdit, shiftRanges, snapCaret, tokenParts, wholeTokenEdit } from '../../src/lib/textTokens'

describe('where an edit happened', () => {
  test('typing, a paste over a selection, a deletion of a selection', () => {
    expect(findEdit('hi ', 'hi x', { start: 3, end: 3 })).toEqual({ from: 3, removed: 0, inserted: 1 })
    expect(findEdit('hello world', 'hello there', { start: 6, end: 11 })).toEqual({ from: 6, removed: 5, inserted: 5 })
    expect(findEdit('hello world', 'hello ', { start: 6, end: 11 })).toEqual({ from: 6, removed: 5, inserted: 0 })
  })

  test('the same letter twice: the selection says where it happened', () => {
    // "@" typed before "@Ann": at 0, not inside the name
    expect(findEdit('@Ann ', '@@Ann ', { start: 0, end: 0 })).toEqual({ from: 0, removed: 0, inserted: 1 })
    expect(findEdit('@Ann ', '@@Ann ', null)).toEqual({ from: 1, removed: 0, inserted: 1 })
    // Backspace after "@Annn" at 4 took the 4th letter; Delete at 4 the 5th
    expect(findEdit('@Annn', '@Ann', { start: 4, end: 4 })).toEqual({ from: 3, removed: 1, inserted: 0 })
    expect(findEdit('@Annn', '@Ann', { start: 4, end: 4, inputType: 'deleteContentForward' })).toEqual({ from: 4, removed: 1, inserted: 0 })
  })

  test('an IME changing the syllable it writes: the smallest change', () => {
    expect(findEdit('@Ann 트', '@Ann 틀', { start: 6, end: 6, inputType: 'insertCompositionText' })).toEqual({ from: 5, removed: 1, inserted: 1 })
    expect(findEdit('@Ann 낭', '@Ann 나아', { start: 6, end: 6, inputType: 'insertCompositionText' })).toEqual({ from: 5, removed: 1, inserted: 2 })
  })
})

describe('ranges through edits', () => {
  const ann = { start: 3, end: 7 } // "hi @Ann and"
  test('before an edit they stay, after it they move, inside it they are gone', () => {
    expect(shiftRanges([ann], { from: 0, removed: 0, inserted: 2 })).toEqual([{ start: 5, end: 9 }])
    expect(shiftRanges([ann], { from: 8, removed: 3, inserted: 0 })).toEqual([ann])
    expect(shiftRanges([ann], { from: 5, removed: 0, inserted: 1 })).toEqual([])
    expect(shiftRanges([ann], { from: 4, removed: 1, inserted: 1 })).toEqual([])
    expect(shiftRanges([ann], { from: 2, removed: 2, inserted: 0 })).toEqual([])
  })

  test('typing right at an edge leaves the token whole', () => {
    expect(shiftRanges([ann], { from: 7, removed: 0, inserted: 1 })).toEqual([ann])
    expect(shiftRanges([ann], { from: 3, removed: 0, inserted: 1 })).toEqual([{ start: 4, end: 8 }])
    // what was right before it, taken away
    expect(shiftRanges([ann], { from: 0, removed: 3, inserted: 0 })).toEqual([{ start: 0, end: 4 }])
  })

  test('a deletion into a token from its edge takes all of it; one from a selection does not', () => {
    const t = [ann]
    // Backspace at its end took "n"
    const back = findEdit('hi @Ann and', 'hi @An and', { start: 7, end: 7 })
    expect(wholeTokenEdit(t, back, { start: 7, end: 7 })).toEqual({ from: 3, removed: 4, inserted: 0 })
    expect(applyEdit('hi @Ann and', { from: 3, removed: 4, inserted: 0 })).toBe('hi  and')
    // Delete at its start took "@"
    expect(wholeTokenEdit(t, { from: 3, removed: 1, inserted: 0 }, { start: 3, end: 3 })).toEqual({ from: 3, removed: 4, inserted: 0 })
    // the last letter selected and deleted: an edit of the token, not of all of it
    expect(wholeTokenEdit(t, { from: 6, removed: 1, inserted: 0 }, { start: 6, end: 7 })).toBeNull()
    // the space after it
    expect(wholeTokenEdit(t, { from: 7, removed: 1, inserted: 0 }, { start: 8, end: 8 })).toBeNull()
    // typing is no deletion
    expect(wholeTokenEdit(t, { from: 7, removed: 0, inserted: 1 }, { start: 7, end: 7 })).toBeNull()
  })
})

test('a caret inside a token goes to its nearer edge', () => {
  const t = [{ start: 3, end: 13 }]
  expect(snapCaret(t, 4)).toBe(3)
  expect(snapCaret(t, 12)).toBe(13)
  expect(snapCaret(t, 8)).toBe(13)
  expect(snapCaret(t, 3)).toBe(3)
  expect(snapCaret(t, 13)).toBe(13)
  expect(snapCaret(t, 20)).toBe(20)
})

test('the text cut into plain parts and tokens; a token past the text or over another is left out', () => {
  expect(tokenParts('hi @Ann and @Bo', [{ start: 12, end: 15, kind: 'b' }, { start: 3, end: 7, kind: 'a' }])).toEqual([
    { text: 'hi ' },
    { text: '@Ann', token: { start: 3, end: 7, kind: 'a' } },
    { text: ' and ' },
    { text: '@Bo', token: { start: 12, end: 15, kind: 'b' } },
  ])
  expect(tokenParts('hi', [{ start: 1, end: 5 }])).toEqual([{ text: 'hi' }])
  expect(tokenParts('@Ann', [{ start: 0, end: 4 }, { start: 2, end: 4 }]).length).toBe(1)
  expect(tokenParts('', [])).toEqual([])
})
