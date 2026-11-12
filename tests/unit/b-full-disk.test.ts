// QA TC-209: an answer that failed on a full disk read as an engine crash ("the AI stopped unexpectedly"). The turn now
// ends with storage_full: the server's storage is full and an admin has to free space.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { API, CHAT_ERROR_MESSAGES } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-full-disk', turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-alice-disk' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

test('an engine that stops with "no space left on device" ends the answer with storage_full, not the crash words', async () => {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  const r = await ask(h, alice, 'alice', chat.id, fake({ diskFull: true }))
  expect(r.done.status).toBe('error')
  expect(r.done.error).toMatchObject({ code: 'storage_full', params: { reason: 'storage_full' } })
  expect(r.done.error?.message).toBe(CHAT_ERROR_MESSAGES.storage_full.en) // alice reads English
  // an ordinary crash keeps its own words
  const other = await ask(h, alice, 'alice', (await h.api('alice').call(API.createChat, { body: {} })).id, fake({ crashOnce: true }, { say: 'survived' }))
  expect(other.done).toMatchObject({ status: 'done', content: 'survived' })
})
