// The people a post the AI makes may mention (server/src/chat/post-mentions.ts, docs/decisions/
// 20261118-ai-post-real-mentions.md): picked among the room's people only, an exact "@Name" in the text counts, any
// other "@word" stays plain, "@everyone" only when allowed. Made-up names.
import { describe, expect, test } from 'bun:test'
import { broadcastIn, isBroadcastRef, leadingMentions, mentionHead, pickMentions, POST_MENTIONS_MAX, textMentions, withExactNames, type Mentionable } from '../../server/src/chat/post-mentions'

const people: Mentionable[] = [
  { id: 'u1', name: 'Mira Santoso', username: 'mira' },
  { id: 'u2', name: 'Jonas Berg', username: 'jonas' },
  { id: 'u3', name: '김하늘', username: 'haneul' },
  { id: 'u4', name: 'Ana Ruiz', username: 'ana.r' },
  { id: 'u5', name: 'Ana Ruiz', username: 'ana.ruiz2' },
]
const P = 'person:'

describe('pickMentions (the tool\'s mention)', () => {
  test('a full name, a username, person:<id>, a unique part of a name; each once', () => {
    expect(pickMentions(people, ['Mira Santoso', '@jonas', 'person:u3', 'mira santoso', 'Santoso'], { allowAll: false, personRef: P })).toEqual({ ok: true, ids: ['u1', 'u2', 'u3'], all: false })
  })
  test('someone not in the room, an id of someone not there, a look-alike: not ok', () => {
    const r = pickMentions(people, ['Mira Sant0so', 'person:zz', 'Lee'], { allowAll: false, personRef: P })
    expect(r).toMatchObject({ ok: false, unknown: ['Mira Sant0so', 'person:zz', 'Lee'] })
  })
  test('a name two people share: not ok, with both', () => {
    const r = pickMentions(people, ['Ana Ruiz'], { allowAll: false, personRef: P })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.many[0]!.people.map((p) => p.id)).toEqual(['u4', 'u5'])
  })
  test('everyone: only when allowed', () => {
    for (const w of ['everyone', '@전체', 'channel', '@here', 'semua']) expect(isBroadcastRef(w)).toBe(true)
    expect(pickMentions(people, ['everyone'], { allowAll: false, personRef: P })).toMatchObject({ ok: false, broadcast: true })
    expect(pickMentions(people, ['@everyone'], { allowAll: true, personRef: P })).toEqual({ ok: true, ids: [], all: true })
  })
  test('at most POST_MENTIONS_MAX people', () => {
    const many = Array.from({ length: POST_MENTIONS_MAX + 1 }, (_, i) => ({ id: `x${i}`, name: `Person ${i}`, username: `p${i}` }))
    expect(pickMentions(many, many.map((p) => p.id).map((id) => P + id), { allowAll: false, personRef: P })).toMatchObject({ ok: false, tooMany: true })
  })
})

describe('textMentions (an "@Name" in the text)', () => {
  test('exactly a person\'s name (any case), the longest first, with a word edge; a Hangul name may take a particle', () => {
    const t = textMentions('@Mira Santoso hi, ask @JONAS BERG and @김하늘님 too', people, { allowAll: false })
    expect(t.tokens.map((x) => x.id)).toEqual(['u1', 'u2', 'u3'])
    expect(t.plain).toEqual([])
  })
  test('a look-alike, a non-member, a part of a name, a name two people share, an e-mail: no mention', () => {
    const t = textMentions('@Mlra Santoso @Mirabel @Ana Ruiz mail me at x@y.com @Lee', people, { allowAll: false })
    expect(t.tokens).toEqual([])
    expect(t.plain).toEqual(['@Mlra', '@Mirabel', '@Ana', '@Lee'])
  })
  test('"@everyone" / "@channel" only when allowed', () => {
    expect(textMentions('@everyone look', people, { allowAll: false }).tokens).toEqual([])
    expect(textMentions('@everyone look', people, { allowAll: true }).tokens).toEqual([{ start: 0, end: 9, all: true }])
    expect(textMentions('hey @channel!', people, { allowAll: true }).tokens).toEqual([{ start: 4, end: 12, all: true }])
    expect(broadcastIn('please @here')).toBe(true)
    expect(broadcastIn('a@here.com')).toBe(false)
  })
  test('the run of mentions a text starts with, and the exact names', () => {
    const text = '@mira santoso, @Jonas Berg: Forwarding a mail'
    const t = textMentions(text, people, { allowAll: false })
    expect(text.slice(leadingMentions(text, t.tokens))).toBe(' Forwarding a mail')
    expect(leadingMentions('@Mira Santoso', textMentions('@Mira Santoso', people, { allowAll: false }).tokens)).toBe(0)
    expect(withExactNames(text, t.tokens, (id) => people.find((p) => p.id === id)!.name, 'everyone')).toBe('@Mira Santoso, @Jonas Berg: Forwarding a mail')
    expect(mentionHead(['Mira Santoso', 'Jonas Berg'], 'everyone')).toBe('@Mira Santoso @Jonas Berg @everyone')
  })
})
