// The schedule card's line for rooms a run may read (server/src/tools/schedules.ts scopeLines, no save folder). A run
// never posts to a room (post_to_room refuses in a scheduled run, chat/post-to-room.ts), so the line says the rooms are
// read only and promises no sending there (QA on dev 1565b39f1: "읽고 보내도 되는 대화"). What it may send, and where,
// is the "Where it may send" line of the person's own pinned connections.
import { expect, test } from 'bun:test'
import { scopeLines } from '../../server/src/tools/schedules'

const LANGS = ['en', 'ko', 'id', 'ja', 'es'] as const

test('rooms are listed as conversations it may read, in every language, with no word of sending', () => {
  expect(scopeLines({ save: null, rooms: ['#sales conversation'], sends: [] }, 'en')).toEqual(['Conversations it may read: #sales conversation'])
  expect(scopeLines({ save: null, rooms: ['#영업팀 대화'], sends: [] }, 'ko')).toEqual(['읽을 수 있는 대화: #영업팀 대화'])
  const sending = { en: /send/i, ko: /보내/, id: /kirim/i, ja: /送信/, es: /envi/i }
  for (const L of LANGS) {
    const [line] = scopeLines({ save: null, rooms: ['#room'], sends: [] }, L)
    expect(line, L).toContain('#room')
    expect(line, L).not.toMatch(sending[L])
  }
})

test('a pinned connection keeps its own "where it may send" line beside the rooms', () => {
  const lines = scopeLines({ save: null, rooms: ['#sales conversation'], sends: [{ name: 'Mail', pins: ['team@example.com'] }] }, 'en')
  expect(lines).toEqual(['Conversations it may read: #sales conversation', "Where it may send: Mail · 'team@example.com'"])
})
