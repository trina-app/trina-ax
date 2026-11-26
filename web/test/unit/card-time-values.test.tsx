// A card's ISO date and time values in the person's words (lib/format.ts formatCardTime; QA: a Calendar card showed
// "2026-11-27T15:00:00"): the time written, never converted, its offset kept; anything else as sent.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale, TurnRequest } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import AskCard from '../../src/components/chat/AskCard'
import { formatCardTime } from '../../src/lib/format'

const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))

describe('formatCardTime', () => {
  test('a wall-clock time in each language, not converted to any zone', () => {
    expect(formatCardTime('2026-11-27T15:00:00', 'ko')).toBe(new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(Date.UTC(2026, 10, 27, 15)))
    expect(formatCardTime('2026-11-27T15:00:00', 'ko')).toContain('3:00')
    expect(formatCardTime('2026-11-27T15:00:00', 'en')).toContain('3:00 PM')
    expect(formatCardTime('2026-11-27T15:00:00', 'en')).toContain('Nov 27, 2026')
    for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as Locale[]) expect(formatCardTime('2026-11-27T15:00', l)).not.toBeNull()
  })
  test('an offset or Z stays shown; seconds only when not zero; a day alone', () => {
    expect(formatCardTime('2026-11-27T15:00:00+09:00', 'en')).toMatch(/3:00 PM UTC\+9$/)
    expect(formatCardTime('2026-11-27T15:00:00+05:30', 'en')).toMatch(/UTC\+5:30$/)
    expect(formatCardTime('2026-11-27T06:00:00Z', 'en')).toMatch(/6:00 AM UTC$/)
    expect(formatCardTime('2026-11-27T15:00:07', 'en')).toContain('3:00:07 PM')
    expect(formatCardTime('2026-11-27', 'en')).toBe('Fri, Nov 27, 2026')
  })
  test('anything else is null: the card shows it as sent', () => {
    for (const v of ['2026-11-27T15:00:00.123', '2026-02-30', '2026-11-27T25:00:00', 'tomorrow 3pm', '2026-11-27 and more', '15:00', '20261127'])
      expect(formatCardTime(v, 'en')).toBeNull()
  })
})

test('the card shows a Calendar start and end in words, the zone line and the exact JSON as sent', () => {
  setLocale('ko')
  const exact = '{"action":"create","summary":"QA 카드 확인2","start_time":"2026-11-27T15:00:00","end_time":"2026-11-27T16:00:00","timezone":"Asia/Seoul"}'
  const req: Extract<TurnRequest, { kind: 'ask_user' }> = {
    kind: 'ask_user', origin: 'server', requestId: 'r1', question: '일정을 추가할까요?', multiple: false, allowText: false,
    options: [{ label: '이번만 추가', value: 'once' }, { label: '추가 안 함', value: 'deny' }],
    details: [{ label: '보내는 내용', exact: true, callJson: true, text: exact, fields: [
      { name: '작업', value: '만들기' }, { name: '제목', value: 'QA 카드 확인2' }, { name: '시작', value: '2026-11-27T15:00:00' },
      { name: '끝', value: '2026-11-27T16:00:00' }, { name: '시간대', value: 'Asia/Seoul' },
    ] }],
  }
  const html = renderToStaticMarkup(<AskCard req={{ request: req }} onAnswer={async () => {}} />)
  expect(html).toContain(formatCardTime('2026-11-27T15:00:00', 'ko')!)
  expect(html).toContain(formatCardTime('2026-11-27T16:00:00', 'ko')!)
  expect(html).not.toContain('>2026-11-27T15:00:00<')
  expect(html).toContain('Asia/Seoul')
})
