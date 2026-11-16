// A team file search also says when the person's rooms mention the same words (server/src/chat/room-hint.ts; AI scenario
// FLOW-03: the answer was only in the client's group chat, and the AI searched files only). Through the real turn and
// the fake engine: the grep result gets one line in the person's own chat; only rooms they are in count; no room name
// or message text in it; each word once a turn; nothing for a pattern with regular-expression syntax.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { plainWords } from '../../server/src/chat/room-hint'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const grep = (pattern: string) => ({ tool: 'grep', args: { pattern }, sayResult: true })

let h: Harness, sock: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'room-hint', stallTimeoutMs: 60_000 })
  sock = await h.ws('alice'); await sock.next('hello')
  const say = (user: string, roomId: string, body: string, threadRootId?: string) => h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: 'cm-' + crypto.randomUUID(), mentions: [], ...(threadRootId ? { threadRootId } : {}) } })
  // alice's group chat about a client: the answer is a thread reply
  const mine = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['bob', 'erin'], name: '라마바카페 건' } })).id
  const root = await say('alice', mine, '라마바카페에서 단가 26,500원 요청했어요.')
  await say('bob', mine, '토요일은 퀵으로만 가능해요.', root.id)
  // a group chat alice is not in
  const other = (await h.api('bob').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'carol'], name: 'not alice' } })).id
  await say('bob', other, '보라색프로젝트 일정은 비밀이에요.')
})
afterAll(async () => { sock?.close(); await h?.close() })

const turn = async (content: string) => {
  const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
  return (await ask(h, sock, 'alice', chat, content, { ms: 30_000 })).done.content
}

describe('a grep of team files and the person\'s rooms', () => {
  test('words a room of theirs mentions: one line, counted, no room name or text, once a turn', async () => {
    const a = await turn(fake(grep('토요일|Saturday'), grep('토요일')))
    expect(a).toContain('The user\'s chat rooms also mention "토요일": 1 message in 1 room.')
    expect(a).toContain('search them with rooms (query) and read the threads before saying nothing answers a question')
    expect(a).not.toContain('라마바카페 건')
    expect(a).not.toContain('퀵으로만')
    // the same word again in this turn: not again
    expect(a.split('chat rooms also mention').length).toBe(2)
  })

  test('only rooms the person is in; nothing for regular expressions or no match', async () => {
    expect(await turn(fake(grep('보라색프로젝트')))).not.toContain('chat rooms also mention')
    expect(await turn(fake(grep('토요일.*퀵')))).not.toContain('chat rooms also mention')
    expect(await turn(fake(grep('없는단어xyz')))).not.toContain('chat rooms also mention')
  })

  test('plain words: "a|b" of letters, digits and spaces with an optional (?i); at most four', () => {
    expect(plainWords('라마바|Lamaba')).toEqual(['라마바', 'Lamaba'])
    expect(plainWords('(?i)brand guide')).toEqual(['brand guide'])
    expect(plainWords('a|b')).toEqual([])
    for (const p of ['토요일.*퀵', '[ab]c', 'x+', '\\bword', '(a|b)', '']) expect(plainWords(p), p).toEqual([])
    expect(plainWords('aa|bb|cc|dd|ee')).toHaveLength(4)
    expect(plainWords(42)).toEqual([])
  })
})
