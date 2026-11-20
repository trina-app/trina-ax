// The 프로젝트 panel's mention counts (web/src/store/chatMentions.ts): my unread chat-thread mentions by chat and by
// project, who mentioned me once each, the newest first.
import { describe, expect, test } from 'bun:test'
import type { InboxNotification } from '@mycel/shared/api'
import { mentionsByChat, mentionsByProject } from '../../src/store/chatMentions'

const n = (id: string, chatId: string | null, o: { name?: string | null; mention?: boolean; readAt?: string | null; gone?: boolean; code?: string } = {}) =>
  ({
    id, eventType: o.code ?? 'chat.thread_reply', sourceId: id, code: o.code ?? 'chat.thread_reply', createdAt: '2026-11-20T00:00:00.000Z', readAt: o.readAt ?? null,
    chatId, link: 'chat_thread',
    chatThread: { chatId, rootId: null, name: o.name === undefined ? 'Bob' : o.name, title: 't', mention: o.mention === false ? undefined : true, gone: o.gone ? true : undefined },
  }) as unknown as InboxNotification

describe('mentionsByChat', () => {
  test('counts the unread mentions of each chat, each name once, the newest first', () => {
    const m = mentionsByChat([n('1', 'a', { name: 'Dana' }), n('2', 'a'), n('3', 'a', { name: 'Dana' }), n('4', 'b')])
    expect(m.get('a')).toEqual({ chatId: 'a', count: 3, names: ['Dana', 'Bob'] })
    expect(m.get('b')).toEqual({ chatId: 'b', count: 1, names: ['Bob'] })
  })
  test('leaves out read ones, replies that are not mentions, gone threads and other notices', () => {
    const m = mentionsByChat([n('1', 'a', { readAt: '2026-11-20T00:00:00.000Z' }), n('2', 'a', { mention: false }), n('3', 'a', { gone: true }), n('4', 'a', { code: 'room.mention' }), n('5', null)])
    expect(m.size).toBe(0)
  })
  test('a mention whose replier is gone still counts, with no name', () => {
    expect(mentionsByChat([n('1', 'a', { name: null })]).get('a')).toEqual({ chatId: 'a', count: 1, names: [] })
  })
})

describe('mentionsByProject', () => {
  test('adds each chat to its project; a chat of no known project is left out', () => {
    const byChat = mentionsByChat([n('1', 'a'), n('2', 'a'), n('3', 'b', { name: 'Dana' }), n('4', 'c'), n('5', 'd')])
    const p = mentionsByProject(byChat, (id) => ({ a: 'P', b: 'P', c: 'Q' })[id])
    expect(p.get('P')).toMatchObject({ count: 3, chats: 2, names: ['Bob', 'Dana'], chatIds: ['a', 'b'] })
    expect(p.get('Q')).toMatchObject({ count: 1, chats: 1 })
    expect(p.size).toBe(2)
  })
})
