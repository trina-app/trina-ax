// Every count in every language reads as a plural the formatter fills (shared/src/plural.ts): a form with a "{n}" inside
// is not read, and the dialog showed the raw "{n, plural, one {…} other {…}}" (QA rerun E, "멤버를 바꿀까요?" removing a
// guest: ko and id projects.guestsOff). Inside a form the number is "#".
import { expect, test } from 'bun:test'
import { fillPlurals, PLURAL_PATTERN } from '@mycel/shared/plural'
import { en } from '../../src/i18n/en'
import { es } from '../../src/i18n/es'
import { id } from '../../src/i18n/id'
import { ja } from '../../src/i18n/ja'
import { ko } from '../../src/i18n/ko'
import { zh } from '../../src/i18n/zh'

test('no plural placeholder is left unread in any language', () => {
  const bad: string[] = []
  for (const [l, m] of Object.entries({ en, es, id, ja, ko, zh }) as [string, Record<string, unknown>][])
    for (const [k, v] of Object.entries(m)) if (typeof v === 'string' && v.replace(PLURAL_PATTERN, '').includes(', plural,')) bad.push(`${l} ${k}`)
  expect(bad).toEqual([])
})

test('removing guests: the line is filled in Korean and Indonesian', () => {
  expect(fillPlurals(ko['projects.guestsOff'], { n: 2 }, 'ko')).toBe('게스트 2명의 계정이 꺼져요. 더 이상 로그인할 수 없어요.')
  expect(fillPlurals(id['projects.guestsOff'], { n: 3 }, 'id')).toBe('Akun 3 tamu dimatikan: mereka tidak bisa masuk lagi.')
})
