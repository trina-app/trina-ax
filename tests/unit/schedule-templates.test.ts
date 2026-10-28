import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { ERROR_MESSAGES } from '@mycel/shared/api'
import { HttpError } from '../../server/src/http/errors'
import { tr } from '../../server/src/chat/i18n'
import { SCHEDULES_PER_PERSON } from '../../server/src/chat/schedules'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { createFromTemplate, templateToolRefusal, validateTemplateTurn } from '../../server/src/chat/schedule-templates'
let h: Harness
const input = () => ({ requestId: crypto.randomUUID(), templateId: 'daily-file-index' as const, version: 1 as const, sourcePath: 'shared', outputPath: 'users/olga/reports', time: '09:00' })
async function setup() {
  h = await harness('schedule-templates'); const owner = await withOwner(h)
  fs.mkdirSync(path.join(h.ctx.config.teamRoot, 'shared'), { recursive: true })
  return owner
}
afterEach(async () => { await h?.close() })
test('templates are dormant; explicit creation is idempotent and changed input conflicts', async () => {
  await setup(); const rt = getChatRuntime(h.ctx)
  expect(rt.schedules.list('olga')).toHaveLength(0)
  const a = input(), first = createFromTemplate(h.ctx, rt, 'olga', a)
  expect(first.repeat).toBe('daily'); expect(first.prompt).toContain('Do not move')
  expect(createFromTemplate(h.ctx, rt, 'olga', a).id).toBe(first.id)
  expect(rt.schedules.list('olga')).toHaveLength(1)
  expect(() => createFromTemplate(h.ctx, rt, 'olga', { ...a, time: '10:00' })).toThrow()
  rt.schedules.delete('olga', first.id)
  expect(() => createFromTemplate(h.ctx, rt, 'olga', a)).toThrow() // deletion never recreates on late retry
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM turns').get()).toEqual({ n: 0 })
})
test('creation rejects other private outputs, links, files and invalid weekly input', async () => {
  await setup(); const rt = getChatRuntime(h.ctx)
  for (const sourcePath of ['../outside', 'users/bob', '.system']) expect(() => createFromTemplate(h.ctx, rt, 'olga', { ...input(), sourcePath })).toThrow()
  for (const outputPath of ['shared/reports', 'users/bob/reports']) expect(() => createFromTemplate(h.ctx, rt, 'olga', { ...input(), outputPath })).toThrow()
  fs.symlinkSync(path.join(h.ctx.config.teamRoot, 'shared'), path.join(h.ctx.config.teamRoot, 'users/olga/link'))
  expect(() => createFromTemplate(h.ctx, rt, 'olga', { ...input(), outputPath: 'users/olga/link' })).toThrow()
  expect(() => createFromTemplate(h.ctx, rt, 'olga', { ...input(), templateId: 'weekly-summary' })).toThrow()
})
test('queued template snapshots survive schedule deletion and tool paths cannot expand the scope', async () => {
  await setup(); const rt = getChatRuntime(h.ctx), made = createFromTemplate(h.ctx, rt, 'olga', input())
  h.ctx.db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,template_source_path,template_output_path) VALUES('t','c','olga','claude-code','queued',?,?)").run('shared', 'users/olga/reports')
  rt.schedules.delete('olga', made.id)
  expect(validateTemplateTurn(h.ctx, 'olga', 't')).toBe(true)
  expect(templateToolRefusal(h.ctx, 'olga', 't', 'read', { file_path: 'shared/x.md' })).toBeNull()
  expect(templateToolRefusal(h.ctx, 'olga', 't', 'write', { file_path: 'users/olga/reports/daily.md' })).toBeNull()
  for (const [name, args] of [['write', { file_path: 'shared/x.md' }], ['read', { file_path: 'users/olga/private.md' }], ['write', { file_path: 'users/olga/reports/run.sh' }], ['edit', { file_path: 'users/olga/reports/a.md' }], ['share_file', {}], ['glob', {}]] as const)
    expect(templateToolRefusal(h.ctx, 'olga', 't', name, args)).toBeTruthy()
  h.ctx.db.query("UPDATE users SET status='disabled' WHERE id='olga'").run()
  expect(() => validateTemplateTurn(h.ctx, 'olga', 't')).toThrow()
})

test('an existing Markdown source/report is never silently overwritten by a template', async () => {
  await setup()
  const output = path.join(h.ctx.config.teamRoot, 'users/olga/reports')
  fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'keep.md'), 'keep original')
  h.ctx.db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,template_source_path,template_output_path) VALUES('t','c','olga','claude-code','running','shared','users/olga/reports')").run()
  expect(templateToolRefusal(h.ctx, 'olga', 't', 'write', { file_path: 'users/olga/reports/keep.md' })).toBeTruthy()
  expect(fs.readFileSync(path.join(output, 'keep.md'), 'utf8')).toBe('keep original')
})

test('20 stored schedules include paused ones; capacity is per person and preserves idempotent retries', async () => {
  const owner = await setup(), rt = getChatRuntime(h.ctx)
  const member = await addMember(h, owner, { username: 'bob' })
  expect(SCHEDULES_PER_PERSON).toBe(20)
  const requests = Array.from({ length: SCHEDULES_PER_PERSON }, input)
  const made = requests.map(request => createFromTemplate(h.ctx, rt, 'olga', request))
  for (const schedule of made) rt.schedules.setEnabled('olga', schedule.id, false)
  expect(rt.schedules.list('olga')).toHaveLength(20)
  expect(rt.schedules.list('olga').every(schedule => !schedule.enabled)).toBe(true)

  // Existing successful requests are checked before capacity; changed input still conflicts.
  expect(createFromTemplate(h.ctx, rt, 'olga', requests[0]!).id).toBe(made[0]!.id)
  expect(() => createFromTemplate(h.ctx, rt, 'olga', { ...requests[0]!, time: '10:00' }))
    .toThrow(expect.objectContaining({ code: 'conflict', extra: {} }))
  const rejected = input()
  for (const locale of ['ko', 'en', 'id'] as const) {
    await owner.call('PATCH', '/api/me', { locale })
    const response = await owner.try('POST', '/api/schedule-templates', rejected)
    expect(response.status).toBe(409)
    expect(response.body.error).toMatchObject({ code: 'conflict', params: { reason: 'schedule_limit', limit: 20 }, message: tr('scheduleLimit', locale, { n: '20' }) })
    expect(response.body.error.message).not.toBe(ERROR_MESSAGES.plan_limit[locale])
    expect(new HttpError('plan_limit').body(locale).message).toBe(ERROR_MESSAGES.plan_limit[locale])
  }
  expect(rt.schedules.list('olga')).toHaveLength(20)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM schedule_template_requests WHERE user_id=? AND request_id=?').get('olga', rejected.requestId)).toEqual({ n: 0 })

  const other = createFromTemplate(h.ctx, rt, member.id, { ...requests[0]!, outputPath: `users/${member.id}/reports` })
  expect(rt.schedules.list(member.id)).toHaveLength(1)
  expect(other.id).not.toBe(made[0]!.id)
  expect(rt.schedules.list('olga')).toHaveLength(20)

  expect(rt.schedules.delete('olga', made[0]!.id)).toBe(true)
  const recovered = createFromTemplate(h.ctx, rt, 'olga', rejected)
  expect(createFromTemplate(h.ctx, rt, 'olga', rejected).id).toBe(recovered.id)
  expect(rt.schedules.list('olga')).toHaveLength(20)
  // A late retry cannot resurrect a deleted schedule, even when capacity is full again.
  expect(() => createFromTemplate(h.ctx, rt, 'olga', requests[0]!)).toThrow(expect.objectContaining({ code: 'gone' }))
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM turns').get()).toEqual({ n: 0 })
})
