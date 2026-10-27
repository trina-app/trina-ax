// Scripted engine only: real launcher/MCP/file service/turn finish, never a provider call.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
setDefaultTimeout(60_000)
let h: Harness, ws: TestSocket
beforeAll(async () => { h = await startHarness({ name: 'template-native' }); ws = await h.ws('alice'); await ws.next('hello') })
afterAll(async () => { ws?.close(); await h?.close() })
test('scheduled template uses current scope at MCP boundary and records one generic completion after DB terminal', async () => {
  const made = await h.api('alice').call(API.createScheduleFromTemplate, { body: { requestId: crypto.randomUUID(), templateId: 'daily-file-index', version: 1, sourcePath: 'shared', outputPath: 'users/alice/reports', time: '09:00' } })
  const directives = [
    { tool: 'read', args: { file_path: 'shared/glossary.md' }, sayResult: true },
    { tool: 'read', args: { file_path: 'users/alice/todo.md' }, sayResult: true },
    { tool: 'write', args: { file_path: 'shared/should-not-exist.md', content: 'blocked' }, sayResult: true },
    { tool: 'write', args: { file_path: 'users/alice/reports/result.md', content: '# Private synthetic report' }, sayResult: true },
    { tool: 'write', args: { file_path: 'users/alice/reports/result.md', content: 'overwrite blocked' }, sayResult: true },
    { tool: 'remember', args: { text: 'must not silently save' }, sayResult: true },
  ].map(d => '@fake ' + JSON.stringify(d)).join('\n')
  // Test fixture only: swap generated instructions for deterministic directives; approved scope stays unchanged.
  h.ctx.db.query('UPDATE schedules SET prompt=?,next_run_at=? WHERE id=?').run(directives,new Date(Date.now()-1000).toISOString(),made.id)
  expect(h.rt().schedules.runDue()).toEqual([made.id])
  const chatId = h.rt().schedules.get('alice',made.id)!.last_chat_id!
  const done = await ws.next('message.done', f => f.data.chatId === chatId)
  expect(done.data.status).toBe('done')
  expect(done.data.message?.content).toContain('ARR')
  expect(done.data.message?.content).toContain('approved folder')
  expect(fs.existsSync(path.join(h.team,'shared/should-not-exist.md'))).toBe(false)
  expect(fs.readFileSync(path.join(h.team,'users/alice/reports/result.md'),'utf8')).toBe('# Private synthetic report')
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM memories WHERE user_id='alice'").get()).toEqual({ n: 0 })
  const page = await h.api('alice').call(API.listNotifications)
  expect(page.items).toMatchObject([{ eventType: 'schedule.success', chatId }])
  expect(JSON.stringify(page)).not.toContain('Private synthetic report')
  expect((await h.api('bob').call(API.listNotifications)).items).toHaveLength(0)
})

test('inbox write failure cannot fail a completed scheduled turn and REST reconciliation repairs it', async () => {
  const made = await h.api('alice').call(API.createScheduleFromTemplate, { body: { requestId: crypto.randomUUID(), templateId: 'daily-file-index', version: 1, sourcePath: 'shared', outputPath: 'users/alice/reports', time: '09:00' } })
  h.ctx.db.query('UPDATE schedules SET prompt=?,next_run_at=? WHERE id=?').run('@fake {"say":"completed without inbox storage"}',new Date(Date.now()-1000).toISOString(),made.id)
  h.ctx.db.exec("CREATE TRIGGER fail_notification BEFORE INSERT ON notification_inbox BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END")
  try {
    h.rt().schedules.runDue()
    const chatId=h.rt().schedules.get('alice',made.id)!.last_chat_id!
    const done=await ws.next('message.done',f=>f.data.chatId===chatId)
    expect(done.data.status).toBe('done')
    expect((await h.api('alice').call(API.listNotifications)).items.some(x=>x.chatId===chatId)).toBe(false)
    h.ctx.db.exec('DROP TRIGGER fail_notification')
    expect((await h.api('alice').call(API.listNotifications)).items.filter(x=>x.chatId===chatId)).toHaveLength(1)
    expect((await h.api('alice').call(API.listNotifications)).items.filter(x=>x.chatId===chatId)).toHaveLength(1)
  } finally { h.ctx.db.exec('DROP TRIGGER IF EXISTS fail_notification') }
})
