// Access that shrinks while a turn runs takes effect at the next tool call (design tab 2 "권한 회수": "다음 도구 호출부터
// 바로 막힌다"). The tool connection loaded the person (role, groups) once when the engine connected, so a turn that
// was running when the admin took bob out of Finance kept reading Finance files until it ended, and a disabled or
// deleted account's turn kept running and using its old rights.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const readBudget = { tool: 'read', args: { file_path: 'groups/finance/budget.md' }, sayResult: true }
let h: Harness
let bob: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'p1-live-access', turnTimeoutMs: 60_000 })
  bob = await h.ws('bob', { windowId: 'win-p1-live-access' })
  await bob.next('hello')
})
afterAll(async () => { bob?.close(); await h.close() })

async function start(content: string) {
  const chat = await h.api('bob').call(API.createChat, { body: {} })
  const r = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  // the first read went through (the tool connection is up and authenticated)
  await bob.next('message.step', (f) => f.data.messageId === r.assistantMessage.id && f.data.step.tool === 'read' && f.data.step.status === 'ok')
  return r
}
const doneOf = (id: string) => bob.next('message.done', (f) => f.data.messageId === id, 20_000)

test('taken out of the group: the running turn can no longer read the group folder', async () => {
  const r = await start(fake(readBudget, { say: '\n--\n' }, { sleep: 800 }, readBudget))
  await h.api('carol').call(API.updateUser, { params: { id: 'bob' }, body: { groupIds: [] } })
  const done = (await doneOf(r.assistantMessage.id)).data.message
  const [first, second] = done.content.split('\n--\n')
  expect(first).toContain('CANARY-FIN-7731')
  expect(second).not.toContain('CANARY-FIN-7731')
})

test('a disabled account: its running turn stops', async () => {
  h.ctx.db.query("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES ('finance', 'bob')").run()
  const r = await start(fake(readBudget, { say: '\n--\n' }, { sleep: 800 }, readBudget, { say: 'still running' }))
  // the change is made; only the response fails the contract check (the fixture's group ids are not UUIDv7)
  await h.api('carol').call(API.updateUser, { params: { id: 'bob' }, body: { status: 'disabled' } }).catch(() => {})
  expect((h.ctx.db.query("SELECT status FROM users WHERE id = 'bob'").get() as { status: string }).status).toBe('disabled')
  // bob's windows were signed out: read the answer from the database
  const row = () => h.ctx.db.query('SELECT content, status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { content: string; status: string }
  expect(await waitFor(() => row().status !== 'streaming', { timeoutMs: 15_000 })).toBe(true)
  expect(row().content).not.toContain('still running')
  expect(row().content.split('CANARY-FIN-7731').length).toBeLessThanOrEqual(2) // the first read at most
  expect(h.rt().runningCount()).toBe(0)
})
