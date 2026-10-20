// Access shrinking resets the person's engine sessions (tab 2 "권한 회수", H7). A turn that was running at that moment
// stashed its session when it ended and wrote engine_session_id back, so the next turn resumed a session that may hold
// file contents the person can no longer read. Running turns now end without keeping their session.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { resetEngineSessions as adminReset } from '../../server/src/admin/folders'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'p1-session-revoke', turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-p1-revoke' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

const session = (chatId: string) => h.ctx.db.query('SELECT engine_session_id AS sid, engine_session_leaf_id AS leaf FROM chats WHERE id = ?').get(chatId) as { sid: string | null; leaf: string | null }

test('a reset while a turn runs is not undone when the turn ends', async () => {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  await ask(h, alice, 'alice', chat.id, 'first\n' + fake({ say: 'one' }))
  expect(session(chat.id).sid).not.toBeNull()
  // second turn resumes the session and is still running when the admin narrows alice's access
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ say: 'reading the finance folder... ' }, { sleep: 700 }, { say: 'done' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await alice.next('message.delta', (f) => f.data.messageId === r.assistantMessage.id)
  expect(adminReset(h.ctx, 'alice')).toBeGreaterThanOrEqual(1)
  const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
  expect(done.data.status).toBe('done')
  expect(session(chat.id)).toEqual({ sid: null, leaf: null })
  expect(fs.existsSync(path.join(h.dataDir, 'sessions', chat.id))).toBe(false)
  // the next turn starts a fresh session (from the DB history)
  const next = await ask(h, alice, 'alice', chat.id, fake({ echo: 'resume' }))
  expect(next.done.content).toBe('resumed=false')
  // and a turn without a reset keeps its session as before
  expect(await waitFor(() => session(chat.id).sid !== null)).toBe(true)
})

test('turns of other people keep their sessions', async () => {
  const bob = await h.ws('bob', { windowId: 'win-p1-revoke-bob' })
  await bob.next('hello')
  const chat = await h.api('bob').call(API.createChat, { body: {} })
  const r = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ say: 'x' }, { sleep: 500 }, { say: 'y' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await bob.next('message.delta', (f) => f.data.messageId === r.assistantMessage.id)
  adminReset(h.ctx, 'alice')
  await bob.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
  expect(session(chat.id).sid).not.toBeNull()
  bob.close()
})
