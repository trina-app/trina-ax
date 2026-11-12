// QA TC-360: a team made on 0.4.0 updated to this build. On 0.4.0 an admin (carol) made the team project "Sales" in
// projects/sales-2026 for alice; its folder had the 0.4.0 rules (each participant and the creator write, nothing else),
// and the owner (dana) and every admin read it by their role. The owner had her own chat there and a template task
// (Daily file index) on its folder. Since docs/DECISIONS.md "Project contents only for members" the owner and admins
// read a project only as its members; this checks what each person has after the first start of the new build
// (chat/members-only-once.ts): the owner, another admin (frank), the creator, a member and someone not in it (bob).
//   - the owner and frank: the project in their Projects list (manage=1, not a member, no instructions), not in the
//     pickers' list, its folder 404, and a way in that its members are told (Add me);
//   - the owner's own chat stays hers and readable, but a turn no longer gets the project (H7, "권한 회수");
//   - the owner's template task on the project's folder is skipped, paused and she is told once, like a task whose
//     project is gone; "Run now" says the same; a template task on a folder she still reads runs.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared'
import { API } from '@mycel/shared/api'
import { addTestPerson, startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { membersOnlyOnce } from '../../server/src/chat/members-only-once'
import { TurnExec } from '../../server/src/chat/turn'
import { CONFIRMED } from '../lib/schedule-card'

setDefaultTimeout(120_000)
const DIR = 'projects/sales-2026'
const SECRET = 'TC360-PIPELINE-7f3'
const INSTR = 'TC360-INSTR-2b9'
const q = (p: string) => encodeURIComponent(p)

let h: Harness
const projectId = uuidv7(), ownerChat = uuidv7()
let templateOnProject = '', templateOnShared = '', projectTask = ''
async function raw(who: string, method: string, p: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const r = await h.req(who, p, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
  const text = await r.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: r.status, text, json }
}
const names = async (who: string, manage: boolean) => ((await raw(who, 'GET', `/api/projects${manage ? '?manage=1' : ''}`)).json.items as { id: string; name: string; member?: boolean; instructions: string; canManage?: boolean }[])

beforeAll(async () => {
  h = await startHarness({ name: 'b-projects-after-update', askUserTimeoutMs: 2500, turnTimeoutMs: 60_000 })
  const db = h.ctx.db
  db.query("INSERT INTO users (id, username, name, role) VALUES ('frank', 'frank', 'Frank Admin', 'admin')").run()
  addTestPerson('frank', { id: 'frank', name: 'Frank Admin', role: 'admin', locale: 'en' })
  // what 0.4.0 left: the start steps of this build not yet run
  db.query("DELETE FROM settings WHERE key = 'projectsMembersOnly.v1'").run()
  const root = h.ctx.files.fx.root
  fs.mkdirSync(path.join(root, ...DIR.split('/')), { recursive: true })
  fs.writeFileSync(path.join(root, ...DIR.split('/'), 'pipeline.md'), `${SECRET}\n`)
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true })
  fs.mkdirSync(path.join(root, 'users', 'dana'), { recursive: true })
  const now = new Date().toISOString()
  // 0.4.0 createProject: a folders row with a write rule for each participant and the creator, then the project row
  // (no folder_made: the column came later and is 0 for every older project)
  const folder = uuidv7()
  db.query('INSERT INTO folders (id, path, created_at) VALUES (?, ?, ?)').run(folder, DIR, now)
  for (const who of ['alice', 'carol']) db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by) VALUES (?, ?, 'user', ?, 'write', 'carol')").run(uuidv7(), folder, who)
  db.query('INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at, instructions_author, instructions_authored) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(projectId, 'Sales', DIR, INSTR, 'carol', now, 'carol', INSTR)
  // the owner's own chat in it, from 0.4.0 (she read the project by her role then)
  db.query("INSERT INTO chats (id, user_id, project_id, title, title_source, engine, model, created_at, updated_at) VALUES (?, 'dana', ?, 'Owner in sales project', 'user', 'claude-code', NULL, ?, ?)").run(ownerChat, projectId, now, now)
  const question = uuidv7(), answer = uuidv7()
  db.query("INSERT INTO messages (id, chat_id, role, content, author_id) VALUES (?, ?, 'user', 'hello project', 'dana')").run(question, ownerChat)
  db.query("INSERT INTO messages (id, chat_id, role, content, parent_id) VALUES (?, ?, 'assistant', 'hello owner', ?)").run(answer, ownerChat, question)
  db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answer, ownerChat)
  // the owner's scheduled tasks from 0.4.0: two templates (on the project's folder, on shared/) and one in the project
  const rt = h.rt()
  const template = (source: string) => {
    const s = rt.schedules.create('dana', { title: 'Daily file index and organization suggestions', prompt: 'index', repeat: 'daily', time: '09:00' } as never, new Date(), CONFIRMED)
    db.query("UPDATE schedules SET template_id = 'daily-file-index', template_version = 1, template_source_path = ?, template_output_path = 'users/dana/reports' WHERE id = ?").run(source, s.id)
    return s.id
  }
  templateOnProject = template(DIR)
  templateOnShared = template('shared')
  projectTask = rt.schedules.create('dana', { title: 'Sales digest', prompt: 'digest', repeat: 'daily', time: '09:00', projectId } as never, new Date(), CONFIRMED).id
  // the first start of the new build
  await membersOnlyOnce(h.ctx)
})
afterAll(async () => { await h.close() })

describe('after the update from 0.4.0', () => {
  test('the start steps ran once', () => {
    expect(h.ctx.db.query("SELECT 1 AS x FROM settings WHERE key = 'projectsMembersOnly.v1'").get()).toEqual({ x: 1 })
  })

  test('the creator and the member keep the project; someone not in it still has nothing', async () => {
    for (const who of ['carol', 'alice']) {
      expect((await names(who, false)).find((p) => p.id === projectId)?.instructions, who).toBe(INSTR)
      expect((await raw(who, 'GET', `/api/files/content?path=${q(`${DIR}/pipeline.md`)}`)).text, who).toContain(SECRET)
    }
    expect((await names('bob', true)).some((p) => p.id === projectId)).toBe(false)
    expect((await raw('bob', 'GET', `/api/files/tree?path=${q(DIR)}`)).status).toBe(404)
  })

  test('the owner and another admin still find it in Projects, as not a member, and read nothing of it', async () => {
    for (const who of ['dana', 'frank']) {
      const listed = (await names(who, true)).find((p) => p.id === projectId)
      expect(listed, who).toMatchObject({ name: 'Sales', member: false, instructions: '', canManage: true })
      // the pickers' list (no manage) is the projects they read: not this one
      expect((await names(who, false)).some((p) => p.id === projectId), who).toBe(false)
      expect((await raw(who, 'GET', `/api/files/tree?path=${q(DIR)}`)).status, who).toBe(404)
      const page = await raw(who, 'GET', `/api/projects/${projectId}?manage=1`)
      expect(page.status, who).toBe(200)
      expect(page.text, who).not.toContain(INSTR)
    }
  })

  test("the owner's own chat there stays hers, but a turn no longer gets the project", async () => {
    const mine = (await raw('dana', 'GET', '/api/chats')).json.items as { id: string }[]
    expect(mine.some((c) => c.id === ownerChat)).toBe(true)
    expect((await raw('dana', 'GET', `/api/chats/${ownerChat}`)).status).toBe(200)
    const open = await raw('dana', 'GET', `/api/chats/${ownerChat}/messages`)
    expect(open.status).toBe(200)
    expect(open.text).toContain('hello owner')
    // nobody else sees it
    expect((await raw('frank', 'GET', `/api/chats/${ownerChat}`)).status).toBe(404)
    expect((await raw('carol', 'GET', `/api/chats/${ownerChat}`)).status).toBe(404)
    // the project's name, folder and instructions stop reaching the AI (chat/runtime.ts projectForChat)
    expect(h.rt().projectForChat(projectId, h.ctx.files.principal('dana'))).toBeNull()
    expect(h.rt().projectForChat(projectId, h.ctx.files.principal('alice'))?.instructions).toBe(INSTR)
    // and she cannot start a new chat in it
    expect((await raw('dana', 'POST', '/api/chats', { projectId })).status).toBe(404)
  })

  test("the owner's scheduled tasks on it are skipped, paused and she is told; a task on a folder she reads runs", async () => {
    const db = h.ctx.db
    const rt = h.rt()
    const starts: TurnExec[] = []
    const held = spyOn(TurnExec.prototype, 'run').mockImplementation(async function (this: TurnExec) { starts.push(this) })
    try {
      const due = new Date(Date.now() - 60_000).toISOString()
      for (const id of [templateOnProject, templateOnShared, projectTask]) db.query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(due, id)
      const ran = rt.schedules.runDue(new Date())
      expect(ran).toEqual([templateOnShared])
      expect(starts).toHaveLength(1)
      for (const id of [templateOnProject, projectTask]) {
        expect(db.query('SELECT project_id FROM schedule_project_skips WHERE schedule_id = ?').get(id), id).toEqual({ project_id: projectId })
        expect(db.query('SELECT enabled FROM schedules WHERE id = ?').get(id), id).toEqual({ enabled: 0 })
        expect(rt.schedules.lastOutcome('dana', id), id).toBe('project_gone')
        expect(db.query('SELECT COUNT(*) AS n FROM turns WHERE schedule_id = ?').get(id), id).toEqual({ n: 0 })
      }
      // told once per task, in the inbox; the notice names neither the project nor its folder
      const told = await waitFor(async () => {
        const items = (await raw('dana', 'GET', '/api/notifications')).json.items as { projectGone?: boolean; schedule?: { id: string } }[]
        const gone = items.filter((n) => n.projectGone)
        return gone.length >= 2 ? gone : null
      }, { timeoutMs: 10_000 })
      expect(told).toHaveLength(2)
      expect(JSON.stringify(told)).not.toContain(DIR)
      // the next tick runs nothing more (paused)
      expect(rt.schedules.runDue(new Date(Date.now() + 2 * 86_400_000))).not.toContain(templateOnProject)
      // "Run now" says why, the same as for a task whose project is gone
      const now = await raw('dana', 'POST', `/api/schedules/${templateOnProject}/run`)
      expect(now.status).toBe(409)
      expect(now.json.error.params?.reason).toBe('schedule_project_gone')
      expect(starts).toHaveLength(1)
    } finally {
      for (const exec of starts) { db.query("UPDATE turns SET status = 'done' WHERE id = ?").run(exec.id); rt.turnFinished(exec); (exec as any).resolveDone() }
      held.mockRestore()
    }
  })

  test('the way in shows: frank adds himself, reads it, and its members are told', async () => {
    const acc = (await raw('frank', 'GET', `/api/projects/${projectId}/access`)).json
    const parts = acc.participants.filter((x: { creator?: boolean }) => !x.creator).map((x: { subjectType: string; subjectId: string }) => ({ subjectType: x.subjectType, subjectId: x.subjectId }))
    const put = await raw('frank', 'PUT', `/api/projects/${projectId}/participants`, { participants: [...parts, { subjectType: 'user', subjectId: 'frank' }], expectedHash: acc.rulesHash })
    expect(put.status).toBe(200)
    expect((await raw('frank', 'GET', `/api/files/content?path=${q(`${DIR}/pipeline.md`)}`)).text).toContain(SECRET)
    expect((await names('frank', false)).find((p) => p.id === projectId)?.instructions).toBe(INSTR)
    const inbox = await waitFor(async () => ((await raw('alice', 'GET', '/api/notifications')).json.items as { code: string; projectJoined?: { project?: { id: string } } }[])
      .find((n) => n.code === 'project.joined' && n.projectJoined?.project?.id === projectId) ?? null, { timeoutMs: 10_000 })
    expect(inbox).not.toBeNull()
    // the owner is still not in it
    expect((await raw('dana', 'GET', `/api/files/tree?path=${q(DIR)}`)).status).toBe(404)
  })
})
