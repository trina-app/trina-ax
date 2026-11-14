// Team projects back from the trash, and two people editing one project (QA TC-1013, TC-1014, TC-1015).
// - A restore (the project page's Restore or its folder on Files › Trash) turns on again the scheduled tasks a due run
//   paused while the project was in the trash, for each person who sees it again; never a task paused before the trash
//   or one its person turned off (chat/project-restore.ts, chat/schedules.ts resumeForProject).
// - Its shared chats come back into its members' open lists: chat.updated 'restored'.
// - PATCH /api/projects/:id with a `base` that is not what the project has now: 409 project_changed with the latest,
//   nothing saved; no base (an older client): saved as before.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, uuidv7, type ServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { CONFIRMED } from '../lib/schedule-card'
import { legacyProjectFolder } from '../lib/legacy-project'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-project-restore', stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
const enabled = (id: string) => (db().query('SELECT enabled FROM schedules WHERE id = ?').get(id) as { enabled: number }).enabled
const seqOf = (f: ServerFrame) => ('seq' in f && typeof f.seq === 'number' ? f.seq : 0)

/** a team project dana made with bob and alice in it, sharing its chats; bob has a chat in it */
async function teamProject(name: string) {
  const p = await h.api('dana').call(API.createProject, { body: { name, scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'user', subjectId: 'alice' }], instructions: '' } })
  await h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { shareChats: true } })
  const chat = await h.api('bob').call(API.createChat, { body: { projectId: p.id } })
  return { p, chat }
}

/** bob's tasks in the project: one a due run will pause while it is in the trash, one paused before (it lost the
 * project earlier, by another way), one he turned off himself */
function tasks(projectId: string) {
  const rt = h.rt()
  const past = new Date(Date.now() - 2 * 86_400_000)
  const input = (title: string) => ({ title, prompt: fake({ say: 'ok' }), repeat: 'daily', time: '09:00', projectId }) as never
  const due = rt.schedules.create('bob', input('Due'), past, CONFIRMED)
  const before = rt.schedules.create('bob', input('Before'), new Date(), CONFIRMED)
  const off = rt.schedules.create('bob', input('Off'), new Date(), CONFIRMED)
  rt.schedules.setEnabled('bob', off.id, false)
  // paused for a project gone, long before this trash
  db().query('UPDATE schedules SET enabled = 0, next_run_at = NULL WHERE id = ?').run(before.id)
  db().query('INSERT INTO schedule_project_skips(id,user_id,schedule_id,scheduled_for,project_id,created_at) VALUES(?,?,?,?,?,?)').run(uuidv7(), 'bob', before.id, '2020-01-01T09:00:00.000Z', projectId, '2020-01-01T09:00:00.000Z')
  db().query("INSERT INTO audit_log(actor_id,action,target,detail,at) VALUES(NULL,'schedule.project_gone',?,?,'2020-01-01T09:00:00.000Z')").run(before.id, JSON.stringify({ originalDue: '2020-01-01T09:00:00.000Z', project: projectId, paused: true }))
  return { due, before, off }
}

describe('a team project back from the trash', () => {
  for (const via of ['the project page', 'Files › Trash'] as const) {
    test(`restored on ${via}: its paused tasks run again, its shared chats come back into its members' lists`, async () => {
      const { p, chat } = await teamProject(`Back ${via}`)
      const t = tasks(p.id)
      let trashId: string
      if (via === 'the project page') {
        await h.api('dana').call(API.deleteProject, { params: { id: p.id } })
        trashId = (db().query('SELECT trashed_with FROM projects WHERE id = ?').get(p.id) as { trashed_with: string }).trashed_with
      } else {
        trashId = (await h.api('dana').call(API.remove, { query: { path: p.folderPath } })).trashId
      }
      expect(trashId).toBeTruthy()
      // the due run while it is in the trash: skipped and paused (bob no longer sees it)
      expect(h.rt().schedules.runDue(new Date())).toEqual([])
      expect([enabled(t.due.id), enabled(t.before.id), enabled(t.off.id)]).toEqual([0, 0, 0])
      expect(h.rt().schedules.lastOutcome('bob', t.due.id)).toBe('project_gone')

      const from = { alice: h.rt().hub.lastSeq('alice'), bob: h.rt().hub.lastSeq('bob') }
      if (via === 'the project page') await h.api('carol').call(API.restoreProject, { params: { id: p.id } })
      else await h.api('dana').call(API.restoreTrash, { params: { id: trashId } })

      // only the task the trash paused; the one paused before and the one bob turned off stay off
      expect([enabled(t.due.id), enabled(t.before.id), enabled(t.off.id)]).toEqual([1, 0, 0])
      const resumed = db().query("SELECT actor_id AS actor, detail FROM audit_log WHERE action = 'schedule.resumed' AND target = ?").get(t.due.id) as { actor: string | null; detail: string }
      expect(resumed.actor).toBeNull()
      expect(JSON.parse(resumed.detail)).toMatchObject({ via: 'project_restored', project: p.id })
      // bob and alice hear the shared chat is back, with the chat as each sees it
      for (const u of ['alice', 'bob'] as const) {
        const f = await ws[u]!.next('chat.updated', (x) => x.data.chatId === chat.id && x.data.change === 'restored' && seqOf(x) > from[u], 10_000)
        expect(f.data.chat?.id).toBe(chat.id)
      }
    })
  }
})

describe('a team project in the trash pointed at a folder by an admin', () => {
  test('is back like a restore: its paused tasks run again, its shared chats come back into its members\' lists', async () => {
    const { p, chat } = await teamProject('Repointed')
    const t = tasks(p.id)
    await h.api('dana').call(API.deleteProject, { params: { id: p.id } })
    expect(h.rt().schedules.runDue(new Date())).toEqual([])
    expect([enabled(t.due.id), enabled(t.before.id), enabled(t.off.id)]).toEqual([0, 0, 0])
    // an admin made a new projects/<name> for its people; dana (the owner, a member) points the project at it
    const users = ['dana', 'bob', 'alice'].map((u) => ({ subjectType: 'user' as const, subjectId: u, access: 'write' as const }))
    legacyProjectFolder(db(), h.team, 'projects/repointed-new', [{ subjectType: 'everyone', subjectId: null, access: 'none' }, ...users], 'dana')
    const from = { alice: h.rt().hub.lastSeq('alice'), bob: h.rt().hub.lastSeq('bob') }
    const out = await h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { folderPath: 'projects/repointed-new' } })
    expect([out.inTrash, out.folderPath]).toEqual([false, 'projects/repointed-new'])
    expect([enabled(t.due.id), enabled(t.before.id), enabled(t.off.id)]).toEqual([1, 0, 0])
    for (const u of ['alice', 'bob'] as const) {
      const f = await ws[u]!.next('chat.updated', (x) => x.data.chatId === chat.id && x.data.change === 'restored' && seqOf(x) > from[u], 10_000)
      expect(f.data.chat?.id).toBe(chat.id)
    }
  })
})

describe('two people editing one project', () => {
  test('a save from an older version: 409 with the latest, nothing saved; no base: saved as before', async () => {
    const p = await h.api('dana').call(API.createProject, { body: { name: 'Edits', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'alice' }], instructions: 'v1' } })
    // carol (an admin, not a member) is not in it; dana edits first, from v1
    await h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { name: 'Edits', instructions: 'v2 by dana', base: { name: 'Edits', instructions: 'v1' } } })
    // a second edit from v1 too: refused, with what the project has now
    const e = await errOf(h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { name: 'Edits', instructions: 'v2 again', base: { name: 'Edits', instructions: 'v1' } } }))
    expect([e.status, e.body.params?.reason, e.body.params?.name, e.body.params?.instructions]).toEqual([409, 'project_changed', 'Edits', 'v2 by dana'])
    expect((db().query('SELECT instructions FROM projects WHERE id = ?').get(p.id) as { instructions: string }).instructions).toBe('v2 by dana')
    // a renamed project: the base's name counts too
    await h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { name: 'Renamed' } })
    const n = await errOf(h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { name: 'Edits 2', base: { name: 'Edits' } } }))
    expect([n.status, n.body.params?.name]).toEqual([409, 'Renamed'])
    // from the latest: saved
    const ok = await h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { name: 'Renamed', instructions: 'v3', base: { name: 'Renamed', instructions: 'v2 by dana' } } })
    expect(ok.instructions).toBe('v3')
    // carol, an admin who is not a member, renames it without reading it: a stale name is a 409 without its
    // instructions, and a guessed base of its instructions is not compared (no way to test them)
    const c = await errOf(h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { name: 'By carol', base: { name: 'Edits' } } }))
    expect([c.status, c.body.params?.name, c.body.params?.instructions]).toEqual([409, 'Renamed', undefined])
    expect((await h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { name: 'Renamed', base: { name: 'Renamed', instructions: 'a guess' } } })).name).toBe('Renamed')
    // an older client sends no base: last save wins, as before
    expect((await h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { instructions: 'v4' } })).instructions).toBe('v4')
  })
})
