// A link a teammate posted in a room, opened from that room's ✦ side chat (docs/decisions/
// 20261116-room-link-save-one-prompt.md, QA TC-3831): the room's links are links of the conversation (learned, within the
// link budget), the same address with tracking parts dropped (?utm_…, a trailing slash) is that address, and once
// allowed on a card it is not asked again. What still asks: a link of another room, an address with a part the known
// one does not have, an unknown address. No name is looked up here (gateUrl decides from the text and the database).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { gateUrl, rememberUrls, sameLink, type TurnPerson } from '../../server/src/tools/url-gate'

setDefaultTimeout(60_000)
let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'room-link-gate', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 }) })
afterAll(async () => { await h?.close() })

const LINK = 'https://notes.example/s/8LdgbR8hDYo2hLjRhVXF?utm_source=slack&utm_medium=share'
const BARE = 'https://notes.example/s/8LdgbR8hDYo2hLjRhVXF'
function person(asked: string[], answer = false): TurnPerson {
  return { locale: 'en', async confirm(q) { asked.push(q); return answer }, turnUrls: () => [] }
}
async function sideChatWithLink(text: string) {
  const room = (await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'bob' } })).id
  await h.api('bob').call(API.sendRoomMessage, { params: { id: room }, body: { body: text, mentions: [], clientMessageId: uuidv7(), fileIds: [] } })
  return { room, chat: (await h.api('alice').call(API.createChat, { body: { sideRoomId: room } })).id as string }
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
    // the chat is alice's: bob's turn there (not its person) has no room links
    const b: string[] = []
    await expect(gate(chat, LINK, person(b), 'bob')).rejects.toThrow(/did not allow/)
  })
})

describe('what of the room does not count (review)', () => {
  test('a link in an answer shared from an AI chat (its text is the AI\'s) asks', async () => {
    const { room, chat } = await sideChatWithLink(`answer ${LINK}`)
    h.ctx.db.query('UPDATE room_messages SET answer_at = 0 WHERE room_id = ?').run(room)
    const asked: string[] = []
    await expect(gate(chat, LINK, person(asked))).rejects.toThrow(/did not allow/)
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
