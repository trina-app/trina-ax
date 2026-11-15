// Message links in a text (shared/src/api/rooms.ts parseMessageLinks, docs/DECISIONS.md "Message links and their
// previews"): /rooms/<room>?m=<message> and /rooms/<room>/t/<root>?m=<reply> on any host, ids lower-cased, where an
// address ends as people mean it in a chat; never a "//" or /api/ path, never ids that are not uuid v7.
import { expect, test } from 'bun:test'
import { linkCount, parseMessageLink, parseMessageLinks } from '@mycel/shared/api'

const R = '019a5f00-0000-7000-8000-00000000a001'
const M = '019a5f00-0000-7000-8000-00000000b002'
const T = '019a5f00-0000-7000-8000-00000000c003'
const ids = (s: string) => parseMessageLinks(s).map((l) => [l.roomId, l.messageId, l.rootId])

test('a top-level message, a reply, extra query parts, another host, http and https', () => {
  expect(ids(`https://acme.example.com/rooms/${R}?m=${M}`)).toEqual([[R, M, null]])
  expect(ids(`https://acme.example.com/rooms/${R}/t/${T}?m=${M}`)).toEqual([[R, M, T]])
  expect(ids(`http://192.168.0.5:8080/rooms/${R}?x=1&m=${M}&y=2`)).toEqual([[R, M, null]])
  expect(parseMessageLinks(`http://192.168.0.5:8080/rooms/${R}?m=${M}`)[0]!.host).toBe('192.168.0.5:8080')
  // a reply whose thread is itself: a top-level message
  expect(ids(`https://a.example/rooms/${R}/t/${M}?m=${M}`)).toEqual([[R, M, null]])
})

test('where an address ends: punctuation, Hangul, brackets, Markdown, a quote', () => {
  expect(ids(`see https://a.example/rooms/${R}?m=${M}.`)).toEqual([[R, M, null]])
  expect(parseMessageLinks(`see https://a.example/rooms/${R}?m=${M}.`)[0]!.href).toBe(`https://a.example/rooms/${R}?m=${M}`)
  expect(ids(`https://a.example/rooms/${R}?m=${M}에서 봐`)).toEqual([[R, M, null]])
  expect(ids(`(https://a.example/rooms/${R}?m=${M})`)).toEqual([[R, M, null]])
  expect(ids(`[the plan](https://a.example/rooms/${R}?m=${M})`)).toEqual([[R, M, null]])
  expect(ids(`> https://a.example/rooms/${R}?m=${M}`)).toEqual([[R, M, null]])
})

test('not message links: "//", /api/, inside a word, not uuid v7, no m', () => {
  expect(ids(`https://a.example//rooms/${R}?m=${M}`)).toEqual([])
  expect(ids(`https://a.example/api/rooms/${R}?m=${M}`)).toEqual([])
  expect(ids(`xhttps://a.example/rooms/${R}?m=${M}`)).toEqual([])
  expect(ids(`https://a.example/rooms/${R}?m=019a5f00-0000-4000-8000-00000000b002`)).toEqual([])
  expect(ids(`https://a.example/rooms/${R}`)).toEqual([])
  expect(ids(`https://a.example/rooms/${R}?n=${M}`)).toEqual([])
  expect(ids('')).toEqual([])
})

test('uppercase ids, duplicates once, several in order', () => {
  expect(ids(`https://a.example/rooms/${R.toUpperCase()}?m=${M.toUpperCase()}`)).toEqual([[R, M, null]])
  expect(ids(`https://a.example/rooms/${R}?m=${M} https://b.example/rooms/${R}?m=${M.toUpperCase()}`)).toEqual([[R, M, null]])
  expect(ids(`https://a.example/rooms/${R}/t/${T}?m=${M} then https://a.example/rooms/${R}?m=${T}`)).toEqual([[R, M, T], [R, T, null]])
})

test('linkCount counts any web address; parseMessageLink takes one address', () => {
  expect(linkCount(`a https://x.example www.y.example http://z.example xhttps://no`)).toBe(3)
  expect(linkCount('no links')).toBe(0)
  expect(parseMessageLink(`https://a.example/rooms/${R}?m=${M}`)?.messageId).toBe(M)
  expect(parseMessageLink(`https://a.example/files/view?path=x`)).toBeNull()
  expect(parseMessageLink(`https://a.example/rooms/${R}?m=${M} more`)).toBeNull()
})
