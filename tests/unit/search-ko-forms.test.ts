// Korean search across verb and adjective forms (docs/decisions/20261121-ko-search-forms.md, shared/src/search-ko.ts):
// a word is found by any of its forms (searchForms), so "만든" finds "만들었어요" and "작성했어요" finds "작성했습니다";
// a noun keeps finding what it found (particles as before) and gains no stem alone ("시간" never finds "시가"); English
// is as it was. The table reads a text as every search does: each word, any of its forms, as a part of the text.
import { describe, expect, test } from 'bun:test'
import { parseSearch, searchForms, searchStem, searchTerm } from '@mycel/shared'

/** Does `text` hold every word of `q`, each by any of its forms (A–Z in any case, as LIKE)? */
const finds = (q: string, text: string) => parseSearch(q).forms.every((fs) => fs.some((f) => text.toLowerCase().includes(f.toLowerCase())))

// query → a text it must find (real-looking team chat lines)
const HITS: [string, string][] = [
  ['만들다', '어제 회의 자료 만들었어요'],
  ['만든', '제가 만들었어요, 확인해 주세요'],
  ['만든', '시안 먼저 만들어 볼게요'],
  ['만들다', '견적서는 제가 만듭니다'],
  ['만드는', '지금 표 만들고 있어요'],
  ['보고서 작성', '보고서를 작성했습니다'],
  ['작성했어요', '주간 보고서 작성했습니다'],
  ['작성하다', '회의록 작성 부탁드려요'],
  ['보낸', '견적서 보냈어요'],
  ['보냈어요', '내일 오전에 보내드릴게요'],
  ['보내다', '고객사에 메일 보낸 거 확인했어요'],
  ['확인해주세요', '확인했습니다 감사합니다'],
  ['공유된', '자료 공유 드렸어요'],
  ['보고서를', '보고서가 늦어지고 있어요'],
  ['보고서는', '보고서를 다시 올렸어요'],
  ['회의를', '회의는 3시로 옮겼어요'],
  ['어려워요', '이번 일정은 좀 어렵습니다'],
  ['어렵다', '생각보다 어려운 문제네요'],
  ['몰라요', '저도 잘 모르겠어요'],
  ['바빠요', '이번 주는 많이 바쁘네요'],
  ['마셨어요', '커피 마시고 갈게요'],
  ['배웠어요', '새 툴 배우는 중이에요'],
  ['알려드렸어요', '일정 알려 주세요'],
  ['괜찮은', '그 안 괜찮아요'],
  ['그렇다', '그런 줄 몰랐어요'],
  ['회의예요', '내일 회의 10시'],
  ['정리하고', '파일 정리했어요'],
]
// query → a text it must not find: a noun gains no verb's stem alone, other words stay apart
const MISSES: [string, string][] = [
  ['시간', '시가 총액'],
  ['사진', '사지 멀쩡해요'],
  ['이미지', '이미 보냈어요'],
  ['보고서', '보고 드릴게요'],
  ['한국어', '한국 지사'],
  ['확인', '확이'],
  ['만든', '만두 먹었어요'],
  ['보낸', '보나 마나'],
  ['작성했어요', '작업 했어요'],
  ['사과예요', '사고 났어요'],
]

describe('a Korean word finds the other forms of its verb or adjective', () => {
  test(`${HITS.length} query → text pairs that must be found`, () => {
    const missed = HITS.filter(([q, t]) => !finds(q, t))
    expect(missed).toEqual([])
  })
  test(`${MISSES.length} query → text pairs that must not be found`, () => {
    const wrong = MISSES.filter(([q, t]) => finds(q, t))
    expect(wrong).toEqual([])
  })
  test('what a word is shown and ranked by: a stem, the noun before 하다, else as before', () => {
    expect(searchTerm('만들었어요')).toBe('만들')
    expect(searchTerm('작성했습니다')).toBe('작성')
    expect(searchTerm('확인해주세요')).toBe('확인')
    expect(searchTerm('보냈어요')).toBe('보내')
    expect(searchTerm('보고서를')).toBe('보고서')
    expect(searchTerm('만든')).toBe('만든')
    expect(searchTerm('deploys')).toBe('deploy')
  })
  test('a word is never narrower than before: its searchStem or a part of it is always one of its forms', () => {
    for (const w of ['보고서를', '회의를', '인화원에서', '사과', '만든', '견적서는', '작성했어요', '시간', 'deploys', 'Q4-plan', '^abc', '사진을', '파일'])
      expect(searchForms(w).some((f) => searchStem(w).toLowerCase().includes(f)), w).toBe(true)
  })
  test('none of a word\'s forms is a part of another (it would find nothing more), and a stem of one syllable stays as typed', () => {
    for (const w of ['만든', '보낸', '어려워요', '몰라요', '만들다']) {
      const fs = searchForms(w)
      for (const a of fs) for (const b of fs) if (a !== b) expect(a.includes(b), `${w}: ${a} ⊃ ${b}`).toBe(false)
      expect(new Set(fs).size).toBe(fs.length)
    }
    // 봤어요, 갔다: one syllable would match too much
    expect(searchForms('봤어요')).toEqual(['봤어요'])
    expect(searchForms('갔다')).toEqual(['갔다'])
    expect(searchForms('바다')).toEqual(['바다'])
  })
  test('a quoted phrase is found as typed only', () => {
    expect(parseSearch('"보고서를 작성했습니다"').forms).toEqual([['보고서를 작성했습니다']])
  })
})

describe('English and other text: as before', () => {
  const EN: [string, string, boolean][] = [
    ['deploys', 'we deployed to staging', true],
    ['deploying', 'deploy notes', true],
    ['meetings', 'the meeting moved', true],
    ['Budget', 'quarterly budget review', true],
    ['process', 'the processor', true],
    ['report', 'a short memo', false],
    ['q4-plan', 'Q4-PLAN final', true],
    ['見積', '見積書を送りました', true],
  ]
  test('the same hits and misses', () => {
    for (const [q, t, want] of EN) expect(finds(q, t), `${q} / ${t}`).toBe(want)
  })
  test('one form: the word or its searchStem', () => {
    for (const w of ['deploys', 'meetings', 'process', 'Budget', 'q4-plan', '見積', 'Été']) expect(searchForms(w), w).toEqual([searchStem(w).replace(/[A-Z]/g, (c) => c.toLowerCase())])
  })
})
