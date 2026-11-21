// An answer's attached files arrive live (message.attachments: the AI attached a file in a chat shared with people,
// server chat/work-file-tool.ts): the running answer shows them at once; another message is not touched.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { uuidv7, type Attachment } from '@mycel/shared/api'
import { useChats } from '../../src/store/chats'
import { CHAT, msg } from './fixtures'

const h = (ev: unknown) => useChats.getState().handleEvent(ev as never)
beforeEach(() => useChats.getState().reset())
afterEach(() => useChats.getState().reset())

test('message.attachments puts the files on the running answer', () => {
  const a = msg({ role: 'assistant', status: 'streaming', turnId: uuidv7() })
  const other = msg({ role: 'assistant', status: 'done' })
  useChats.setState({ threads: { [CHAT]: { messages: [other, a], nextCursor: null, stale: false } } })
  const file: Attachment = { id: uuidv7(), name: 'clip.mp4', path: '', size: 9, mime: 'video/mp4', kind: 'video', source: 'chat', origin: 'ai' }
  h({ type: 'message.attachments', seq: 1, at: 0, data: { chatId: CHAT, messageId: a.id, attachments: [file] } })
  const msgs = useChats.getState().threads[CHAT]!.messages
  expect(msgs.find((m) => m.id === a.id)!.attachments).toEqual([file])
  expect(msgs.find((m) => m.id === other.id)!.attachments).toEqual(other.attachments)
})
