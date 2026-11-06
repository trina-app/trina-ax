// Counts in texts (shared/src/plural.ts): "{n, plural, one {# person} other {# people}}" takes the form for the number
// in the text's language, in the web app, the desktop app's own screens and the team server's messages. App review
// 2026-11-01 found "1 people" on the Skills page; the same "1 <plural>" was in the server's confirmation cards (the AI
// saving where more people see it, moving or copying files), the desktop's "more questions waiting" and a Linux
// diagnostics line.
import { describe, expect, test } from 'bun:test'
import { fillPlurals, pluralCategory, pluralNames } from '@mycel/shared/plural'
import { STRINGS, t as desktopT } from '../../desktop/src/common/i18n'
import { tr } from '../../server/src/chat/i18n'
import { TEXT as FILE_MOVE_TEXT } from '../../server/src/tools/file-moves'
import { ML } from '../../server/src/system/messages-linux'

const PEOPLE = '{n, plural, one {# person} other {# people}}'

describe('fillPlurals', () => {
  test('the form for the number in that language; # is the number as given', () => {
    expect(fillPlurals(PEOPLE, { n: 1 }, 'en')).toBe('1 person')
    expect(fillPlurals(PEOPLE, { n: 0 }, 'en')).toBe('0 people')
    expect(fillPlurals(PEOPLE, { n: '12' }, 'en')).toBe('12 people')
    expect(fillPlurals('{n, plural, one {# persona} other {# personas}}', { n: 1 }, 'es')).toBe('1 persona')
    expect(fillPlurals('{n, plural, one {#人} other {#人}}', { n: 1 }, 'ja')).toBe('1人')
    expect(pluralCategory('ja', 1)).toBe('other')
    expect(pluralCategory('xx-not-a-language', 1)).toBe('one')
  })
  test('plain placeholders, a missing or non-number value and values that look like placeholders stay as they are', () => {
    expect(fillPlurals(`{to}: ${PEOPLE}`, { n: 2, to: 'a' }, 'en')).toBe('{to}: 2 people')
    expect(fillPlurals(PEOPLE, {}, 'en')).toBe(PEOPLE)
    expect(fillPlurals(PEOPLE, { n: '1,204' }, 'en')).toBe(PEOPLE)
    expect(fillPlurals('{a, plural, one {# x} other {# xs}} {b, plural, one {# y} other {# ys}}', { a: 1, b: 3 }, 'en')).toBe('1 x 3 ys')
    expect(pluralNames(`${PEOPLE} {count, plural, one {it} other {them}} {to}`)).toEqual(['n', 'count'])
  })
})

describe('server messages', () => {
  test('the card before the AI saves where more people see it', () => {
    const one = tr('widenConfirm', 'en', { sources: 'users/a/x.md', target: 'shared', n: '1' })
    expect(one).toContain('which 1 person can see')
    expect(tr('widenConfirm', 'en', { sources: 's', target: 't', n: '5' })).toContain('which 5 people can see')
    expect(tr('widenConfirm', 'es', { sources: 's', target: 't', n: '1' })).toContain('visible para 1 persona.')
    expect(tr('widenConfirm', 'ko', { sources: 's', target: 't', n: '1' })).toContain('1명이 볼 수 있어요')
    // a value is put in as written, never read as a count
    expect(tr('widenConfirm', 'en', { sources: '{n, plural, one {x} other {y}}', target: 't', n: '2' })).toContain('({n, plural, one {x} other {y}})')
  })
  test('moving and copying files: "item" / "items", "person" / "people", "it" / "them"', () => {
    const fill = (s: string, v: Record<string, string | number>, l: string) => fillPlurals(s, v, l).replace(/\{(\w+)\}/g, (_, k) => String(v[k]))
    expect(fill(FILE_MOVE_TEXT.move.en, { n: 1, to: 'shared' }, 'en')).toBe('The AI wants to move 1 item to shared.')
    expect(fill(FILE_MOVE_TEXT.copy.en, { n: 3, to: 'shared' }, 'en')).toBe('The AI wants to copy 3 files to shared.')
    expect(fill(FILE_MOVE_TEXT.added.en, { n: 1, count: 1 }, 'en')).toBe('1 more person will be able to see it.')
    expect(fill(FILE_MOVE_TEXT.lost.en, { n: 2, count: 3 }, 'en')).toBe('2 people who can see them now will no longer be able to.')
    expect(fill(FILE_MOVE_TEXT.askMove.en, { count: 1 }, 'en')).toBe('Move it?')
    expect(fill(FILE_MOVE_TEXT.added.es, { n: 1, count: 1 }, 'es')).toBe('1 persona más podrá verlo.')
    expect(fill(FILE_MOVE_TEXT.lost.es, { n: 1, count: 2 }, 'es')).toBe('1 persona que ahora puede verlos dejará de tener acceso.')
  })
  test('Linux diagnostics: one CPU', () => {
    expect(ML.safeOpsReady(2 ** 30, 1, 1).en).toContain('1 task, 1 CPU.')
    expect(ML.safeOpsReady(2 ** 30, 512, 4).en).toContain('512 tasks, 4 CPUs.')
  })
})

describe('desktop app', () => {
  test('"more questions waiting" in every language', () => {
    expect(desktopT('en', 'pane.promptsMore', { n: '1' })).toBe('1 more question waiting')
    expect(desktopT('en', 'pane.promptsMore', { n: '2' })).toBe('2 more questions waiting')
    expect(desktopT('es', 'pane.promptsMore', { n: '1' })).toBe('Hay 1 pregunta más en espera')
    expect(desktopT('ja', 'pane.promptsMore', { n: '1' })).toBe('さらに1件の質問が待機中です')
    expect(desktopT('ko', 'pane.promptsMore', { n: '1' })).toBe('질문 1개가 더 기다리고 있어요')
    expect(desktopT('id', 'pane.promptsMore', { n: '1' })).toBe('1 pertanyaan lagi menunggu')
  })
  test('no bare count before an English plural noun in the desktop strings', () => {
    // names, addresses and versions are not counts ("{app} needs", "{host} is")
    const counts = (v: string) => [...v.matchAll(/\{(\w+)\} (?:more |other )?\w+s\b/g)].filter((m) => !['app', 'domain', 'host', 'version', 'current'].includes(m[1]!))
    for (const [k, v] of Object.entries(STRINGS.en)) expect({ k, bare: counts(v).length }).toEqual({ k, bare: 0 })
  })
})
