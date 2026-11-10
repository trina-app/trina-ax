// The emoji picker's data, search and "Recently used" (docs/DECISIONS.md "Any emoji as a reaction"; lib/emoji.ts,
// scripts/emoji-data.ts): every emoji the picker offers is one the server takes as a reaction; English and Korean
// names find it, best matches first; an emoji typed into the search is offered as it is; "Recently used" keeps the
// last 16, the newest first, per person, and drops anything that is not one emoji.
import { describe, expect, test } from 'bun:test'
import { isStatusEmoji } from '@mycel/shared'
import { RoomReactionEmoji } from '@mycel/shared/api'
import { EMOJI_VERSION_MAX, emojiModules, installedEmojiModules } from '../../scripts/emoji-data'
import { EMOJI_GROUPS, hasHangul, noteRecent, parseEmoji, readRecent, recentKey, RECENT_MAX, searchEmoji } from '../../src/lib/emoji'

describe('the data the build makes', () => {
  const mods = installedEmojiModules()
  const list = parseEmoji(mods.en, mods.ko)
  test('every emoji is one the server takes as a reaction, once; the Korean lines match the English ones', () => {
    const lines = mods.en.split('\n')
    expect(lines.length).toBeGreaterThan(1500)
    expect(mods.ko.split('\n')).toHaveLength(lines.length)
    expect(list).toHaveLength(lines.length)
    for (const e of list) expect([e.emoji, RoomReactionEmoji.safeParse(e.emoji).success]).toEqual([e.emoji, true])
    expect(new Set(list.map((e) => e.emoji)).size).toBe(list.length)
    // the groups the picker heads, nothing else (no skin tones or hair alone)
    expect([...new Set(list.map((e) => e.group))].sort()).toEqual(EMOJI_GROUPS.map((g) => g.group).sort())
    // the eight reactions of before are all there
    for (const e of ['👍', '✅', '👀', '🙏', '😂', '🎉', '❤️', '🔥', '😭']) expect(list.some((x) => x.emoji === e)).toBe(true)
  })
  test('names are one line each (they are shown as text: a keyword like "<3" is just that)', () => {
    for (const e of list) for (const s of [e.name, e.keys, e.local ?? '', e.localKeys ?? '']) expect(/[\t\n\r]/.test(s)).toBe(false)
    expect(searchEmoji(list, '<3')).toContain('🫶')
    const cry = list.find((e) => e.emoji === '😭')!
    expect(cry.name).toBe('loudly crying face')
    expect(cry.local).toBeTruthy()
    expect(hasHangul(cry.local!)).toBe(true)
  })
  test('nothing newer than the systems draw, and no skin-tone variants', () => {
    const fake = emojiModules([
      { emoji: '😀', label: 'grinning face', hexcode: '1F600', group: 0, version: 1 },
      { emoji: '🫨', label: 'shaking face', hexcode: '1FAE8', group: 0, version: EMOJI_VERSION_MAX },
      { emoji: '🙂‍↔️', label: 'head shaking horizontally', hexcode: '1F642-200D-2194-FE0F', group: 0, version: EMOJI_VERSION_MAX + 0.1 },
      { emoji: '🏻', label: 'light skin tone', hexcode: '1F3FB', group: 2, version: 1 },
      { emoji: '🇦', label: 'regional indicator A', hexcode: '1F1E6', version: 0 },
    ], [{ hexcode: '1F600', label: '활짝 웃는 얼굴', tags: ['얼굴', '웃음'] }])
    expect(fake.en.split('\n').map((l) => l.split('\t')[0])).toEqual(['😀', '🫨'])
    expect(fake.ko.split('\n')).toEqual(['활짝 웃는 얼굴\t웃음', '\t'])
    expect(mods.en).not.toContain('🏻')
  })
  test('the real data: "cry" finds 😭 among the first few, "울음" too, and "thumbs" 👍 first', () => {
    expect(searchEmoji(list, 'cry').slice(0, 6)).toContain('😭')
    expect(searchEmoji(list, '울음')).toContain('😭')
    expect(searchEmoji(list, 'thumbs')[0]).toBe('👍')
    expect(searchEmoji(list, 'red heart')[0]).toBe('❤️')
  })
})

describe('search', () => {
  const list = parseEmoji(
    ['😢\t0\tcrying face\tsad tear', '😭\t0\tloudly crying face\tbawling cry sob', '🥲\t0\tsmiling face with tear\tgrateful', '🔮\t7\tcrystal ball\tfortune', 'not one emoji\t0\tbroken\t', '👍\t1\tthumbs up\t+1 good'].join('\n'),
    ['우는 얼굴\t눈물 슬픔', '엉엉 우는 얼굴\t대성통곡 울음', '눈물 흘리며 웃는 얼굴\t', '수정 구슬\t', '\t', '좋아요\t엄지'].join('\n'),
  )
  test('a line that is not one emoji is left out', () => {
    expect(list.map((e) => e.emoji)).toEqual(['😢', '😭', '🥲', '🔮', '👍'])
  })
  test('a name that starts with it first, then a word of a name, then keywords; in the data\'s order within each', () => {
    expect(searchEmoji(list, 'cry')).toEqual(['😢', '🔮', '😭'])
    expect(searchEmoji(list, 'CRYING')).toEqual(['😢', '😭'])
    expect(searchEmoji(list, 'tear')).toEqual(['🥲', '😢'])
    expect(searchEmoji(list, 'sob')).toEqual(['😭'])
    // every word must be there
    expect(searchEmoji(list, 'face sad')).toEqual(['😢'])
    expect(searchEmoji(list, '+1')).toEqual(['👍'])
  })
  test('Korean names and keywords', () => {
    expect(searchEmoji(list, '우는')).toEqual(['😢', '😭'])
    expect(searchEmoji(list, '울음')).toEqual(['😭'])
    expect(searchEmoji(list, '엄지')).toEqual(['👍'])
  })
  test('nothing for an empty search or no match; at most `max`', () => {
    expect(searchEmoji(list, '   ')).toEqual([])
    expect(searchEmoji(list, 'zzz')).toEqual([])
    expect(searchEmoji(list, 'face', 2)).toEqual(['😢', '😭'])
  })
  test('an emoji typed or pasted is offered as it is, even one the data has not (a skin tone)', () => {
    expect(searchEmoji(list, ' 👍🏽 ')).toEqual(['👍🏽'])
    expect(searchEmoji(list, '😭')).toEqual(['😭'])
    // two emoji, or an emoji with tag letters, are no emoji: a text search (that finds nothing)
    expect(searchEmoji(list, '😭😭')).toEqual([])
    expect(searchEmoji(list, '😭\u{E0068}')).toEqual([])
  })
})

describe('recently used', () => {
  const store = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m }
  }
  test('the newest first, once each, at most RECENT_MAX', () => {
    const s = store()
    expect(readRecent('u1', s)).toEqual([])
    noteRecent('u1', '😭', s)
    noteRecent('u1', '👍', s)
    expect(noteRecent('u1', '😭', s)).toEqual(['😭', '👍'])
    for (let i = 0; i < 20; i++) noteRecent('u1', String.fromCodePoint(0x1f600 + i), s)
    const r = readRecent('u1', s)
    expect(r).toHaveLength(RECENT_MAX)
    expect(r[0]).toBe(String.fromCodePoint(0x1f600 + 19))
    expect(r).not.toContain('👍')
  })
  test('per person: another person on the same browser has their own', () => {
    const s = store()
    noteRecent('u1', '😭', s)
    expect(readRecent('u2', s)).toEqual([])
    expect([...s.map.keys()]).toEqual([recentKey('u1')])
  })
  test('anything that is not one emoji is neither kept nor read back', () => {
    const s = store()
    expect(noteRecent('u1', '<b>x</b>', s)).toEqual([])
    s.setItem(recentKey('u1'), JSON.stringify(['😭', 'text', '<img src=x>', 7, null, '😭', '👍🏽', '😭😭']))
    expect(readRecent('u1', s)).toEqual(['😭', '👍🏽'])
    s.setItem(recentKey('u1'), '{not json')
    expect(readRecent('u1', s)).toEqual([])
    s.setItem(recentKey('u1'), JSON.stringify({ a: '😭' }))
    expect(readRecent('u1', s)).toEqual([])
  })
  test('storage that throws (blocked, full) is no error', () => {
    const bad = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') } }
    expect(readRecent('u1', bad)).toEqual([])
    expect(noteRecent('u1', '😭', bad)).toEqual(['😭'])
    expect(isStatusEmoji('😭')).toBe(true)
  })
})
