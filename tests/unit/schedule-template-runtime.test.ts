// Real chat runtime and SQLite queue; only the engine boundary is held, never a model call.
import { afterEach, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { harness, withOwner, type Harness } from './a-lib'
import { getChatRuntime, type ChatRuntime } from '../../server/src/chat/runtime'
import { createFromTemplate, validateTemplateTurn } from '../../server/src/chat/schedule-templates'
import { TurnExec } from '../../server/src/chat/turn'
import { notificationsOf } from '../../server/src/notifications/service'
import { createBudget } from '../../server/src/admin/budgets'
let h: Harness, rt: ChatRuntime, held: ReturnType<typeof spyOn>, starts: TurnExec[]
async function setup() {
  starts = []; held = spyOn(TurnExec.prototype, 'run').mockImplementation(async function(this: TurnExec) { starts.push(this) })
  h = await harness('template-runtime'); await withOwner(h); rt = getChatRuntime(h.ctx)
  fs.mkdirSync(path.join(h.ctx.config.teamRoot, 'shared'), { recursive: true })
}
function make() { return createFromTemplate(h.ctx, rt, 'olga', { requestId: crypto.randomUUID(), templateId: 'daily-file-index', version: 1, sourcePath: 'shared', outputPath: 'users/olga/reports', time: '09:00' }) }
afterEach(async () => {
  if (rt) { void rt.drain(0); for (const exec of starts) { h.ctx.db.query("UPDATE turns SET status='done' WHERE id=?").run(exec.id); rt.turnFinished(exec); (exec as any).resolveDone() } }
  held?.mockRestore(); await h?.close()
})
test('template snapshot is committed before dispatch; repeated due tick admits exactly one occurrence', async () => {
  await setup(); const s = make(), due = '2026-10-20T00:00:00.000Z'
  h.ctx.db.query('UPDATE schedules SET next_run_at=? WHERE id=?').run(due,s.id)
  const now = new Date()
  expect(rt.schedules.runDue(now)).toEqual([s.id]); expect(rt.schedules.runDue(now)).toEqual([])
  expect(starts).toHaveLength(1)
  const exec = starts[0]!
  expect(h.ctx.db.query('SELECT template_source_path,template_output_path,scheduled_for FROM turns WHERE id=?').get(exec.id))
    .toEqual({ template_source_path: 'shared', template_output_path: 'users/olga/reports', scheduled_for: due })
  rt.schedules.delete('olga',s.id)
  expect(validateTemplateTurn(h.ctx,'olga',exec.id)).toBe(true)
  h.ctx.db.query("UPDATE turns SET status='interrupted',ended_at=? WHERE id=?").run(new Date().toISOString(),exec.id)
  notificationsOf(h.ctx).reconcile(); notificationsOf(h.ctx).reconcile()
  expect(notificationsOf(h.ctx).list('olga',{}).items).toHaveLength(1)
})
test('budget skip is a durable occurrence failure with no engine start and no duplicate retry', async () => {
  await setup(); const s = make()
  createBudget(h.ctx.db, { subjectType: 'user', subjectId: 'olga', limitUsd: 0.01, period: 'day', action: 'block' }, 'en')
  h.ctx.db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,cost_usd) VALUES('spent','c','olga','claude-code','done',1)").run()
  h.ctx.db.query('UPDATE schedules SET next_run_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),s.id)
  const now=new Date(); expect(rt.schedules.runDue(now)).toEqual([]); expect(rt.schedules.runDue(now)).toEqual([])
  expect(starts).toHaveLength(0)
  expect(rt.schedules.lastOutcome('olga',s.id)).toBe('budget_exceeded')
  expect(notificationsOf(h.ctx).list('olga',{}).items).toMatchObject([{ eventType: 'schedule.failure' }])
})

test('queued template survives an actual restart without duplicate occurrence or losing approved scope', async () => {
  await setup(); const paused = spyOn(rt,'schedule').mockImplementation(() => {})
  const made = make(), due = new Date(Date.now()-1000).toISOString()
  h.ctx.db.query('UPDATE schedules SET next_run_at=? WHERE id=?').run(due,made.id)
  expect(rt.schedules.runDue()).toEqual([made.id]); expect(starts).toHaveLength(0)
  await h.close(); paused.mockRestore()
  h = await harness('template-runtime',{}, { reuse: true }); rt = getChatRuntime(h.ctx)
  expect(starts).toHaveLength(1)
  expect(validateTemplateTurn(h.ctx,'olga',starts[0]!.id)).toBe(true)
  rt.schedules.runDue()
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM turns WHERE schedule_id=? AND scheduled_for=?').get(made.id,due)).toEqual({ n: 1 })
})
test('lost folder access after queue admission prevents even engine selection and produces a failed occurrence', async () => {
  await setup(); const made=make()
  h.ctx.db.query('UPDATE schedules SET next_run_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),made.id)
  rt.schedules.runDue(); expect(starts).toHaveLength(1)
  fs.rmSync(path.join(h.ctx.config.teamRoot,'shared'),{ recursive: true })
  const selected = spyOn(rt.engines,'get')
  held.mockRestore()
  await starts[0]!.run()
  expect(selected).not.toHaveBeenCalled(); selected.mockRestore()
  expect(rt.schedules.lastOutcome('olga',made.id)).toBe('error')
  expect(notificationsOf(h.ctx).list('olga',{}).items).toMatchObject([{ eventType: 'schedule.failure', link: null }])
})

test('parallel template writes to one new path cannot silently overwrite the first report', async () => {
  await setup(); const made=make()
  h.ctx.db.query('UPDATE schedules SET next_run_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),made.id)
  rt.schedules.runDue(); const exec=starts[0]!
  const { buildToolSet } = await import('../../server/src/chat/tools')
  const { makeHandler } = await import('../../server/src/mcp/protocol')
  const handler=makeHandler(h.ctx.files,h.ctx.db,{user:h.ctx.files.principal('olga'),turnId:exec.id,files:exec.files},buildToolSet(exec))
  const call=(content:string,id:number)=>handler({jsonrpc:'2.0',id,method:'tools/call',params:{name:'write',arguments:{file_path:'users/olga/reports/parallel.md',content}}})
  const results=await Promise.all([call('first',1),call('second',2)])
  expect(results.filter((r:any)=>r.result.isError)).toHaveLength(1)
  expect(fs.readFileSync(path.join(h.ctx.config.teamRoot,'users/olga/reports/parallel.md'),'utf8')).toBe('first')
})
