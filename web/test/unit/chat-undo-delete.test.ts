// "Undo" on the "Chat deleted." toast (components/chat/chatActions.ts): the chat comes back into the list, and a failed
// restore says so in an error toast instead of failing silently (it used to be an unhandled rejection).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Chat } from '@mycel/shared/api'
import { undoDelete } from '../../src/components/chat/chatActions'
import { translate } from '../../src/i18n'
import { useChats } from '../../src/store/chats'
import { useUi } from '../../src/store/ui'
import { CHAT } from './fixtures'

const realFetch = globalThis.fetch
const chat = Chat.parse({ id: CHAT, projectId: null, title: 'Launch plan', engine: 'claude-code', model: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, runState: 'idle' })
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
let reply: () => Response | Promise<Response>

beforeEach(() => {
  useChats.getState().reset()
  useUi.setState({ toasts: [] })
  globalThis.fetch = (async () => reply()) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const failText = translate('en', 'chat.restoreFailed', { trash: translate('en', 'sidebar.trash') })

test('undo brings the chat back into the list', async () => {
  reply = () => json(chat)
  await undoDelete(CHAT, failText)
  expect(useChats.getState().chats.map((c) => c.id)).toEqual([CHAT])
  expect(useUi.getState().toasts).toEqual([])
})

test('a failed undo says so in an error toast (no unhandled rejection), and the chat stays out of the list', async () => {
  reply = () => json({ error: { code: 'not_found', message: 'Not found' } }, 404)
  await undoDelete(CHAT, failText)
  expect(useChats.getState().chats).toEqual([])
  expect(useUi.getState().toasts.map((t) => [t.level, t.text])).toEqual([['error', failText]])
  expect(failText).toBe("Couldn't bring the chat back. It is still in Deleted history.")
})

test('no connection: the same error toast', async () => {
  reply = () => Promise.reject(new TypeError('Failed to fetch'))
  await undoDelete(CHAT, failText)
  expect(useUi.getState().toasts.map((t) => t.level)).toEqual(['error'])
})
