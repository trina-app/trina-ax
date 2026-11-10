// Copying several room messages (lib/messageCopy.ts copyPlainText): one message per block under its author and time, the
// author line once per run of one author, a file as its name, a date or event line of its own, a partial first or last
// message as the part selected; one message alone is left to the browser. The DOM side is in e2e/room-copy.spec.ts.
import { describe, expect, test } from 'bun:test'
import { copyPlainText, type CopyItem } from '../../src/lib/messageCopy'

const msg = (run: string, author: string, time: string, text: string, files: string[] = []): CopyItem => ({ kind: 'message', run, author, time, text, files })

describe('copyPlainText', () => {
  test('two authors: each block is the author and time on one line, then the text; one blank line between', () => {
    expect(copyPlainText([msg('a', 'Minjae', '2:57 PM', '전시 준비 해야해서 ㅠ'), msg('b', 'dion', '2:57 PM', '네네, 수요일까지 보내기로했어요')])).toBe(
      'Minjae  2:57 PM\n전시 준비 해야해서 ㅠ\n\ndion  2:57 PM\n네네, 수요일까지 보내기로했어요',
    )
  })

  test('a run of one author keeps its author line once, as the list shows it', () => {
    const out = copyPlainText([msg('a', '소라님', '오후 6:01', '이번 주 시안 공유드려요'), msg('a', '소라님', '오후 6:01', '피드백 부탁드려요'), msg('b', 'Olga', '오후 6:03', '네')])
    expect(out).toBe('소라님  오후 6:01\n이번 주 시안 공유드려요\n\n피드백 부탁드려요\n\nOlga  오후 6:03\n네')
    // the same author in a later run (another time, after someone else) gets the line again
    expect(copyPlainText([msg('a', '벤', '오후 1:00', 'one'), msg('b', 'Olga', '오후 1:01', 'two'), msg('c', '벤', '오후 1:30', 'three')])).toBe('벤  오후 1:00\none\n\nOlga  오후 1:01\ntwo\n\n벤  오후 1:30\nthree')
  })

  test('a file is its name on a line of its own, after the text; a message of files alone is its names', () => {
    expect(copyPlainText([msg('a', '벤', '오후 2:00', '자료 올려요', ['brief.pdf', 'logo.png']), msg('b', 'Olga', '오후 2:01', '', ['notes.md'])])).toBe(
      '벤  오후 2:00\n자료 올려요\nbrief.pdf\nlogo.png\n\nOlga  오후 2:01\nnotes.md',
    )
  })

  test('an emoji-only message is kept as its emoji', () => {
    expect(copyPlainText([msg('a', 'Olga', '오후 6:03', '좋아요'), msg('b', '벤', '오후 6:04', '👍')])).toBe('Olga  오후 6:03\n좋아요\n\n벤  오후 6:04\n👍')
    expect(copyPlainText([msg('a', 'Olga', '오후 6:03', '🎉🎉'), msg('a', 'Olga', '오후 6:03', '✅')])).toBe('Olga  오후 6:03\n🎉🎉\n\n✅')
  })

  test('a partial first or last message: the part selected, still under its author line', () => {
    // the selection starts inside the first message and ends inside the last
    expect(copyPlainText([msg('a', '소라님', '오후 6:02', ' 부탁드려요\n'), msg('b', 'Olga', '오후 6:03', '네네, 수요일')])).toBe('소라님  오후 6:02\n부탁드려요\n\nOlga  오후 6:03\n네네, 수요일')
    // it starts in the second message of a run: that message carries the run's author line
    expect(copyPlainText([msg('a', '소라님', '오후 6:01', ''), msg('a', '소라님', '오후 6:01', '피드백'), msg('b', '벤', '오후 6:04', '👍')])).toBe('소라님  오후 6:01\n피드백\n\n벤  오후 6:04\n👍')
    // it ends at the very start of the next message: that one is left out
    expect(copyPlainText([msg('a', '소라님', '오후 6:01', '하나'), msg('a', '소라님', '오후 6:01', '둘'), msg('b', '벤', '오후 6:04', '')])).toBe('소라님  오후 6:01\n하나\n\n둘')
  })

  test('a date line and an event line are lines of their own; after one, the author line comes again', () => {
    const items: CopyItem[] = [msg('a', '벤', '오후 11:59', '내일 봐요'), { kind: 'line', text: '2026년 11월 6일 금요일' }, msg('b', '벤', '오전 9:00', '좋은 아침'), { kind: 'line', text: '벤님이 방 이름을 바꿨어요' }, msg('b', '벤', '오전 9:00', '이름 바꿨어요')]
    expect(copyPlainText(items)).toBe('벤  오후 11:59\n내일 봐요\n\n2026년 11월 6일 금요일\n\n벤  오전 9:00\n좋은 아침\n\n벤님이 방 이름을 바꿨어요\n\n벤  오전 9:00\n이름 바꿨어요')
  })

  test('one message alone is the browser\'s own copy (null); with its run\'s name and time selected too, it is a block', () => {
    expect(copyPlainText([])).toBeNull()
    expect(copyPlainText([msg('a', '벤', '오후 2:00', '하나')])).toBeNull()
    // a triple click: the message, and the next one's start with nothing in it
    expect(copyPlainText([msg('a', '벤', '오후 2:00', '하나'), msg('b', 'Olga', '오후 2:01', '')])).toBeNull()
    expect(copyPlainText([{ kind: 'head', run: 'a' }])).toBeNull()
    expect(copyPlainText([{ kind: 'head', run: 'a' }, msg('a', '벤', '오후 2:00', '하나')])).toBe('벤  오후 2:00\n하나')
  })

  test('the text keeps its own line breaks; only the edges are trimmed', () => {
    expect(copyPlainText([msg('a', '벤', '오후 2:00', '\n첫 줄\n\n셋째 줄  \n'), msg('b', 'Olga', '오후 2:01', '네')])).toBe('벤  오후 2:00\n첫 줄\n\n셋째 줄\n\nOlga  오후 2:01\n네')
  })
})
