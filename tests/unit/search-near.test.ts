// Near matches of a search of several words (shared/src/search-near.ts, docs/decisions/20261121-search-near-every-word.md):
// each word on its own as typed or with a typing mistake, so one misspelled word no longer makes the whole search miss;
// exact before prefix before near; short words never near, a one-letter word never inside a word.
import { describe, expect, test } from 'bun:test'
import { hangulLetters, nearMatcher, nearNames, nearPossible, nearTermsOf, nearWordBudget, parseSearch } from '@mycel/shared'

const score = (q: string, text: string) => nearMatcher(nearTermsOf(parseSearch(q)))(text)
/** the texts a query finds, the best first (the order a near pass gives) */
const ranked = (q: string, texts: string[]) => {
  const m = nearMatcher(nearTermsOf(parseSearch(q)))
  return texts.map((t) => ({ t, s: m(t) })).filter((x) => x.s !== null).sort((a, b) => a.s! - b.s!).map((x) => x.t)
}

describe('nearWordBudget', () => {
  test('none under four letters or three syllables, 1 then 2; only letters and digits', () => {
    expect(['a', 'to', 'cat', '견적', '회의'].map(nearWordBudget)).toEqual([0, 0, 0, 0, 0])
    expect(['plan', 'report', 'quarter', '견적서', '인화원연수'].map(nearWordBudget)).toEqual([1, 1, 1, 1, 1])
    expect(['quarterly', 'deployment', '고객사미팅일정'].map(nearWordBudget)).toEqual([2, 2, 2])
    expect(['q4-plan', '^abcd', 'a.b.c.d'].map(nearWordBudget)).toEqual([0, 0, 0])
  })
  test('Hangul by its letters: 셔 and 서 are one letter apart', () => {
    expect([...hangulLetters('견적서')].length).toBe(8)
    expect(hangulLetters('견적셔').length).toBe(hangulLetters('견적서').length)
    expect(hangulLetters('abc')).toBe('abc')
  })
})

describe('a typing mistake in any one word of several', () => {
  const doc = 'Quarterly report budget'
  test('English: the first, the middle and the last word', () => {
    for (const q of ['qaurterly report budget', 'quarterly reprot budget', 'quarterly report budgte', 'Quartely report budget', 'quarterly report budgett']) expect(score(q, doc), q).not.toBeNull()
    // two words with a mistake each
    expect(score('quartrely reprot budget', doc)).not.toBeNull()
  })
  test('Korean and mixed: the first, the middle and the last word', () => {
    const ko = '견적서 Sincere 보냈습니다'
    expect(score('견적서 sincre', ko)).not.toBeNull()
    expect(score('견젹서 sincere', ko)).not.toBeNull()
    expect(score('견적셔 sincere 보냈습니다', ko)).not.toBeNull()
    expect(score('sincere 견적서 보냇습니다', ko)).not.toBeNull()
    // a particle after the word as typed and with a mistake
    expect(score('견적셔를', '견적서를 보내드렸어요')).not.toBeNull()
    expect(score('인화원 연수 일졍표', '인화원 연수 일정표 공유')).not.toBeNull()
  })
  test('every word must still be there: one that matches nothing, nothing', () => {
    expect(score('quarterly reprot banana', doc)).toBeNull()
    expect(score('견적서 sincre 계약', '견적서 Sincere 보냈습니다')).toBeNull()
  })
  test('a word as typed in another case or width is exact', () => {
    expect(score('QUARTERLY ＲＥＰＯＲＴ budget', doc)).toBe(0)
  })
})

describe('order: exact, then a word\'s start, then inside, then near', () => {
  test('the grades add up per word', () => {
    expect(score('report budget', 'report budget')).toBe(0)
    expect(score('rep budget', 'report budget')).toBe(1)
    expect(score('port budget', 'report budget')).toBe(2)
    expect(score('reprot budget', 'report budget')).toBe(3)
    expect(score('reprot budgte', 'report budget')).toBe(6)
    // a Korean particle after the word is its end
    expect(score('견적서', '견적서를 보냈어요')).toBe(0)
  })
  test('ranked: whole words, then prefixes, then near', () => {
    const texts = ['Quarterly reports budgeting', 'Quarterly report budget', 'Quarterly reprot budget draft', 'the budget of the quarter']
    expect(ranked('quarterly report budget', texts)).toEqual(['Quarterly report budget', 'Quarterly reports budgeting', 'Quarterly reprot budget draft'])
    expect(ranked('quarterly reprot budget', texts)).toEqual(['Quarterly reprot budget draft', 'Quarterly report budget', 'Quarterly reports budgeting'])
    // one mistake before two
    expect(ranked('deploymnet', ['deplyomnte notes', 'deployment notes'])).toEqual(['deployment notes', 'deplyomnte notes'])
  })
})

describe('no false matches for short words', () => {
  test('short words are never near', () => {
    expect(score('cst', 'the cat sat')).toBeNull()
    expect(score('teh plan', 'the plan')).toBeNull()
    expect(score('견젹', '견적 요청')).toBeNull()
    expect(score('q4-plam', 'q4-plan here')).toBeNull()
  })
  test('a one-letter word: a whole word or a word\'s start, never inside a word', () => {
    expect(score('a reprot', 'Quarterly report')).toBeNull()
    expect(score('a reprot', 'a report')).toBe(3)
    expect(score('r reprot', 'report on roads')).toBe(4)
    expect(score('x', 'box')).toBeNull()
  })
  test('a quoted phrase is as typed only', () => {
    expect(score('"quarterly reprot"', 'Quarterly report')).toBeNull()
    expect(score('"quarterly report" budgte', 'Quarterly report budget')).toBe(3)
  })
  test('nearPossible: only when a word may have a mistake', () => {
    expect(nearPossible(nearTermsOf(parseSearch('a to cat')))).toBe(false)
    expect(nearPossible(nearTermsOf(parseSearch('"quarterly report"')))).toBe(false)
    expect(nearPossible(nearTermsOf(parseSearch('cat report')))).toBe(true)
  })
})

describe('names (⌘K rooms and people)', () => {
  test('every word as typed or near; none when no word may have a mistake', () => {
    expect(nearNames(['alcie', 'kim'])!('Alice Kim')).toBe(3)
    expect(nearNames(['alcie', 'kim'])!('Alice Park')).toBeNull()
    expect(nearNames(['bob'])).toBeNull()
    expect(nearNames(['마케팅팁'])!('마케팅팀')).toBe(3)
  })
})

describe('speed', () => {
  test('10,000 names and 10,000 messages scored quickly', () => {
    const names = Array.from({ length: 10_000 }, (_, i) => `Project ${i} quarterly report draft v${i % 7}.xlsx`)
    const bodies = Array.from({ length: 10_000 }, (_, i) => `${i} 오늘 회의는 견적서를 보내드릴게요 the quarterly budget deployed to staging please review meeting notes ${i % 13}`)
    const m = nearMatcher(nearTermsOf(parseSearch('quartrely reprot draft')))
    const k = nearMatcher(nearTermsOf(parseSearch('견적셔 stagign 회의')))
    const t = performance.now()
    expect(names.filter((n) => m(n) !== null)).toHaveLength(10_000)
    expect(bodies.filter((b) => k(b) !== null)).toHaveLength(10_000)
    const none = nearMatcher(nearTermsOf(parseSearch('zebrafish mangoes')))
    expect(bodies.filter((b) => none(b) !== null)).toHaveLength(0)
    const ms = performance.now() - t
    console.log(`near matcher: 30,000 texts in ${ms.toFixed(0)} ms`)
    // loose (a busy machine runs this far slower)
    expect(ms).toBeLessThan(15_000)
  })
})
