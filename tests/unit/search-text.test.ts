// What a search box's text means (shared/src/search-text.ts): the words of a query (every one must match, in any order)
// and ⌘K's name match for rooms and people: case, width (NFKC), and Korean initial consonants (초성).
import { describe, expect, test } from 'bun:test'
import { nameMatch, searchWords, SEARCH_WORDS_MAX } from '@mycel/shared'

describe('searchWords', () => {
  test('split on any whitespace, no empty or repeated word, NFC', () => {
    expect(searchWords('  견적서   보내\t드림\n')).toEqual(['견적서', '보내', '드림'])
    expect(searchWords('acme acme Acme ACME-x')).toEqual(['acme', 'ACME-x'])
    expect(searchWords('   ')).toEqual([])
    // decomposed Hangul (a Mac file name, say) comes out composed
    expect(searchWords('견적'.normalize('NFD'))).toEqual(['견적'])
  })
  test(`at most ${SEARCH_WORDS_MAX} words`, () => {
    expect(searchWords('a b c d e f g h i j')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  })
})

describe('nameMatch', () => {
  test('initial consonants stand for the syllables that start with them', () => {
    expect(nameMatch('견적', 'ㄱㅈ')).toBe(0)
    expect(nameMatch('민희', 'ㅁㅎ')).toBe(0)
    expect(nameMatch('김민희', 'ㅁㅎ')).toBe(1)
    // a syllable and initials together, as people type a name
    expect(nameMatch('김민희', '김ㅁ')).toBe(0)
    expect(nameMatch('김민희', '김ㅁㅎ')).toBe(0)
    // double consonants are their own
    expect(nameMatch('까치', 'ㄲㅊ')).toBe(0)
    expect(nameMatch('가치', 'ㄲㅊ')).toBeNull()
    expect(nameMatch('견적', 'ㅈㄱ')).toBeNull()
    // a whole syllable must be that syllable, not only its first consonant
    expect(nameMatch('견적', '거')).toBeNull()
    // a name written in jamo itself still matches them
    expect(nameMatch('ㅇㅇ 팀', 'ㅇㅇ')).toBe(0)
    // an initial and a vowel typed apart stay apart (NFKC of the whole would join them into "가")
    expect(nameMatch('가방', 'ㄱㅏ')).toBeNull()
    expect(nameMatch('ㄱㅏ 메모', 'ㄱㅏ')).toBe(0)
    // a compatibility character that grows under NFKC (㈜ is "(주)") still matches what it stands for
    expect(nameMatch('㈜acme', '(주)')).toBe(0)
    expect(nameMatch('(주)acme', '㈜')).toBe(0)
  })
  test('any case and width; a decomposed name too', () => {
    expect(nameMatch('Acme Design', 'acme')).toBe(0)
    expect(nameMatch('acme design', 'ＡＣＭＥ')).toBe(0)
    expect(nameMatch('ACME', 'cm')).toBe(1)
    expect(nameMatch('견적 요청'.normalize('NFD'), '요청')).toBe(1)
    expect(nameMatch('견적 요청', 'ㅇㅊ')).toBe(1)
  })
  test('every word, in any order; the whole text first', () => {
    expect(nameMatch('acme-design', 'design acme')).toBe(2)
    expect(nameMatch('김소라 팀장', '팀장 ㄱㅅ')).toBe(2)
    expect(nameMatch('acme-design', 'design zeta')).toBeNull()
    expect(nameMatch('디자인 리뷰', '디자인 리뷰')).toBe(0)
    expect(nameMatch('2팀 디자인 리뷰', '디자인   리뷰')).toBe(1)
  })
  test('nothing typed matches nothing', () => {
    expect(nameMatch('acme', '')).toBeNull()
    expect(nameMatch('acme', '   ')).toBeNull()
    expect(nameMatch('', 'a')).toBeNull()
  })
})
