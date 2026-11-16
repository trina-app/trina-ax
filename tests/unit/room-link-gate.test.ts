// A link a teammate posted in a room, opened from that room's ✦ side chat (docs/decisions/
// 20261116-room-link-save-one-prompt.md, QA TC-3831): the room's links are links of the conversation (learned, within the
// link budget), the same address with tracking parts dropped (?utm_…, a trailing slash) is that address, and once
// allowed on a card it is not asked again. What still asks: a link of another room, an address with a part the known
// one does not have, an unknown address. No name is looked up here (gateUrl decides from the text and the database).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { answerFilePaths, API, uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { recordSent } from '../../server/src/tools/connection-urls'
import { gateUrl, noteRoomLinks, rememberUrls, sameLink, type TurnPerson } from '../../server/src/tools/url-gate'

setDefaultTimeout(60_000)
let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'room-link-gate', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 }) })
afterAll(async () => { await h?.close() })

const LINK = 'https://notes.example/s/8LdgbR8hDYo2hLjRhVXF?utm_source=slack&utm_medium=share'
const BARE = 'https://notes.example/s/8LdgbR8hDYo2hLjRhVXF'
function person(asked: string[], answer = false): TurnPerson {
  return { locale: 'en', async confirm(q) { asked.push(q); return answer }, turnUrls: () => [] }
}
/** bob posts `text` in a 1:1 room with alice; alice's side chat of it reads the room (room_read: noteRoomLinks with what
 * it gave the AI). `before`: done to the room's rows before the read */
async function sideChatWithLink(text: string, before?: (room: string) => void) {
  const room = (await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'bob' } })).id
  await h.api('bob').call(API.sendRoomMessage, { params: { id: room }, body: { body: text, mentions: [], clientMessageId: uuidv7(), fileIds: [] } })
  const chat = (await h.api('alice').call(API.createChat, { body: { sideRoomId: room } })).id as string
  before?.(room)
  noteRoomLinks(h.ctx.db, chat, 'alice', text)
  return { room, chat }
}
const gate = (chat: string, url: string, p: TurnPerson, user = 'alice') => gateUrl(h.ctx.db, chat, url, p, { egressKnown: true, turnId: `t-${uuidv7()}`, userId: user })

describe('sameLink', () => {
  test('only tracking parts may be left out, never added; host, path and the other parts must match', () => {
    expect(sameLink(BARE, LINK)).toBe(true)
    expect(sameLink(`${BARE}/`, LINK)).toBe(true)
    expect(sameLink(`${BARE}?utm_source=slack`, LINK)).toBe(true)
    expect(sameLink(LINK, BARE)).toBe(false)
    expect(sameLink(`${BARE}?utm_source=other`, LINK)).toBe(false)
    expect(sameLink(`${BARE}?d=secret`, `${BARE}?d=secret&fbclid=x`)).toBe(true)
    expect(sameLink(BARE, `${BARE}?d=secret`)).toBe(false)
    expect(sameLink('https://other.example/s/8LdgbR8hDYo2hLjRhVXF', LINK)).toBe(false)
    expect(sameLink('http://notes.example/s/8LdgbR8hDYo2hLjRhVXF', LINK)).toBe(false)
  })
})

describe('the side chat of the room the link was posted in', () => {
  test('the link as posted, and without its tracking query, open with no card', async () => {
    const { chat } = await sideChatWithLink(`일요일 회의록이에요 ${LINK}`)
    const asked: string[] = []
    expect(await gate(chat, LINK, person(asked))).toBe('seen')
    expect(await gate(chat, BARE, person(asked))).toBe('seen')
    expect(asked).toEqual([])
  })

  test('still asks: an added part, another address, the same link in my own chat, someone else\'s side chat', async () => {
    const { chat } = await sideChatWithLink(`notes ${LINK}`)
    for (const u of [`${BARE}?d=hello`, 'https://notes.example/s/other']) {
      const asked: string[] = []
      await expect(gate(chat, u, person(asked))).rejects.toThrow(/did not allow/)
      expect(asked).toHaveLength(1)
    }
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    const asked: string[] = []
    await expect(gate(own, LINK, person(asked))).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(1)
    // read in another person's side chat (alice's chat, bob reading): nothing is noted
    const other = (await h.api('alice').call(API.createChat, { body: {} })).id
    noteRoomLinks(h.ctx.db, other, 'bob', `notes ${LINK}`)
    const b: string[] = []
    await expect(gate(other, LINK, person(b))).rejects.toThrow(/did not allow/)
  })
})

describe('what of the room does not count (review)', () => {
  test('a link in an answer shared from an AI chat (its text is the AI\'s) asks', async () => {
    const { chat } = await sideChatWithLink(`answer ${LINK}`, (room) => h.ctx.db.query('UPDATE room_messages SET answer_at = 0 WHERE room_id = ?').run(room))
    const asked: string[] = []
    await expect(gate(chat, LINK, person(asked))).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(1)
  })
})

describe('an echo in the room asks', () => {
  test('a room link holding what the AI had sent to a tool of this chat (a room app posting it back) asks', async () => {
    const room = (await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'bob' } })).id
    const chat = (await h.api('alice').call(API.createChat, { body: { sideRoomId: room } })).id as string
    recordSent(h.ctx.db, chat, { body: 'customer list token Zq8xLm3Np7Rt5Vw2Ky9B' })
    const echo = 'https://collect.example/i?d=Zq8xLm3Np7Rt5Vw2Ky9B'
    await h.api('bob').call(API.sendRoomMessage, { params: { id: room }, body: { body: `form ${echo}`, mentions: [], clientMessageId: uuidv7(), fileIds: [] } })
    noteRoomLinks(h.ctx.db, chat, 'alice', `form ${echo}`)
    const asked: string[] = []
    await expect(gate(chat, echo, person(asked))).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(1)
  })
})

describe('asked once', () => {
  test('an address allowed on a card opens again without one, also with its tracking query dropped', async () => {
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    rememberUrls(h.ctx.db, own, [LINK], 'allowed')
    const asked: string[] = []
    expect(await gate(own, LINK, person(asked))).toBe('seen')
    expect(await gate(own, BARE, person(asked))).toBe('seen')
    expect(asked).toEqual([])
  })
})

describe('answerFilePaths: a file name with parentheses (FL-28: "일요일 회의록 (11-15).md" made the dialog list a hidden file)', () => {
  test('balanced parentheses stay in the address; the link\'s own closing one ends it', () => {
    const body = '[내 파일에 저장했어요](/files/view?path=users%2Fsora%2F%EC%9D%BC%EC%9A%94%EC%9D%BC%20(11-15).md). 또 [a](/files/view?path=shared/a.md)'
    expect(answerFilePaths(body)).toEqual(['users/sora/일요일 (11-15).md', 'shared/a.md'])
  })
})
