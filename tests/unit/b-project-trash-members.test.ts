// A team project in the trash, for its members (docs/DECISIONS.md "A team project in the trash: its members keep its
// card", QA TC-1060, TC-1061, TC-1062, TC-1063).
// - Its members keep it on GET /api/projects?manage=1 and GET /api/projects/:id?manage=1: its name, In trash, who moved
//   it there and when; never its instructions, members, counts, files or chats. Someone who is not a member gets 404.
// - A shared chat link of it answers its members with the same 404, saying why and which project.
// - Its creator (a plain member) may restore it: on its page (POST /api/projects/:id/restore) and in Files › Trash, where
//   its folder's row names the project. Other members may not; deleting it for good stays the owner's and admins'.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'

setDefaultTimeout(60_000)

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-project-trash-members' }) })
afterAll(async () => { await h.close() })

const db = () => h.ctx.db
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }

/** alice (a member) makes a team project with bob in it, with instructions, a file and a shared chat of bob's, and puts
 * it in the trash herself */
async function trashed(name: string) {
  const p = await h.api('alice').call(API.createProject, { body: { name, scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: 'Secret plan' } })
  fs.writeFileSync(path.join(h.team, ...p.folderPath.split('/'), 'notes.md'), 'inside')
  const chat = await h.api('bob').call(API.createChat, { body: { projectId: p.id } })
  expect((await h.api('bob').call(API.getChat, { params: { id: chat.id } })).shared).toBeTruthy()
  await h.api('alice').call(API.deleteProject, { params: { id: p.id } })
  const trashId = (db().query('SELECT trashed_with FROM projects WHERE id = ?').get(p.id) as { trashed_with: string }).trashed_with
  expect(trashId).toBeTruthy()
  return { p, chat, trashId }
}

describe('a team project in the trash, to its members', () => {
  test('its members keep its card with only its name, In trash, and who moved it there; nobody else sees it', async () => {
    const { p } = await trashed('Members keep it')
    for (const u of ['alice', 'bob'] as const) {
      const listed = (await h.api(u).call(API.listProjects, { query: { manage: '1' } })).items.find((x) => x.id === p.id)
      expect(listed).toBeTruthy()
      const one = await h.api(u).call(API.getProject, { params: { id: p.id }, query: { manage: '1' } })
      for (const x of [listed!, one]) {
        expect([x.inTrash, x.member, x.wasMember, x.instructions, x.canManage, x.canDelete]).toEqual([true, false, true, '', false, false])
        expect(x.trashed?.by?.id).toBe('alice')
        expect(Date.parse(x.trashed!.at)).toBeGreaterThan(Date.now() - 60_000)
        // nothing of its contents or its people
        expect([x.audience, x.audienceSplit, x.sharedChats, x.shareChats, x.membersEditable]).toEqual([undefined, undefined, undefined, undefined, undefined])
        expect(JSON.stringify(x)).not.toContain('Secret plan')
      }
      // its creator may restore it, its other member may not
      expect(one.canRestore).toBe(u === 'alice' ? true : undefined)
      // the pickers' plain list never has it
      expect((await h.api(u).call(API.listProjects)).items.some((x) => x.id === p.id)).toBe(false)
    }
    // erin is not a member: as if there were no project
    expect((await h.api('erin').call(API.listProjects, { query: { manage: '1' } })).items.some((x) => x.id === p.id)).toBe(false)
    expect((await errOf(h.api('erin').call(API.getProject, { params: { id: p.id }, query: { manage: '1' } }))).status).toBe(404)
    // carol (an admin, not a member) manages it: who moved it, that she may restore it, and its shared chats' count
    const admin = await h.api('carol').call(API.getProject, { params: { id: p.id }, query: { manage: '1' } })
    expect([admin.inTrash, admin.wasMember, admin.canRestore, admin.trashed?.by?.id, admin.sharedChats]).toEqual([true, undefined, true, 'alice', 1])
  })

  test('its files, chats, instructions and people stay closed to its members (404)', async () => {
    const { p, chat } = await trashed('Still closed')
    for (const u of ['alice', 'bob'] as const) {
      const api = h.api(u)
      expect((await errOf(api.call(API.getProject, { params: { id: p.id } }))).status).toBe(404)
      expect((await errOf(api.call(API.getProjectPeople, { params: { id: p.id } }))).status).toBe(404)
      expect((await errOf(api.call(API.content, { query: { path: `${p.folderPath}/notes.md` } }))).status).toBe(404)
      expect((await errOf(api.call(API.tree, { query: { path: p.folderPath } }))).status).toBe(404)
      expect((await errOf(api.call(API.listMessages, { params: { id: chat.id }, query: {} }))).status).toBe(404)
      // the project page's chat list: no shared chat of it
      expect((await api.call(API.listChats, { query: { projectId: p.id } })).items.some((c) => c.id === chat.id && u !== 'bob')).toBe(false)
      expect((await api.call(API.listChats, { query: { projectId: p.id } })).items.filter((c) => c.shared).length).toBe(0)
      // instructions can't be changed or read back
      expect((await errOf(api.call(API.updateProject, { params: { id: p.id }, body: { instructions: 'x' } }))).status).toBeGreaterThanOrEqual(400)
    }
  })

  test('a shared chat link of it says to its members that its project is in the trash; to anyone else, the plain 404', async () => {
    const { p, chat } = await trashed('Chat link')
    for (const u of ['alice', 'bob'] as const) {
      const e = await errOf(h.api(u).call(API.getChat, { params: { id: chat.id } }))
      expect([e.status, e.body.params?.reason, e.body.params?.projectId]).toEqual([404, 'project_in_trash', p.id])
    }
    for (const u of ['erin', 'carol'] as const) {
      const e = await errOf(h.api(u).call(API.getChat, { params: { id: chat.id } }))
      expect([e.status, e.body.params]).toEqual([404, undefined])
    }
  })
})

describe('its creator restores it', () => {
  test('on its page: the creator yes (and reads it again), another member no', async () => {
    const { p, chat } = await trashed('Creator restores')
    expect((await errOf(h.api('bob').call(API.restoreProject, { params: { id: p.id } }))).status).toBe(403)
    const back = await h.api('alice').call(API.restoreProject, { params: { id: p.id } })
    expect([back.inTrash, back.member, back.instructions]).toEqual([false, undefined, 'Secret plan'])
    expect((await h.api('bob').call(API.getChat, { params: { id: chat.id } })).id).toBe(chat.id)
    expect(db().query("SELECT 1 FROM audit_log WHERE action = 'project.restore' AND target = ? AND actor_id = 'alice'").get(p.id)).toBeTruthy()
  })

  test('in Files › Trash: its row names the project for the creator and admins; the creator restores it there', async () => {
    const { p, trashId } = await trashed('Files trash row')
    const row = async (u: string) => (await h.api(u).call(API.trash, { query: { limit: 200 } })).items.find((x) => x.id === trashId)
    for (const u of ['alice', 'carol', 'dana']) expect((await row(u))?.project).toEqual({ id: p.id, name: 'Files trash row' })
    // bob, a member who did not make it, and erin do not see it there (nor restore it)
    for (const u of ['bob', 'erin']) {
      expect(await row(u)).toBeUndefined()
      expect((await errOf(h.api(u).call(API.restoreTrash, { params: { id: trashId } }))).status).toBe(404)
    }
    // deleting it for good stays the owner's and admins'
    expect((await errOf(h.api('alice').call(API.purgeTrash, { params: { id: trashId } }))).status).toBe(403)
    expect((await errOf(h.api('alice').call(API.deleteProject, { params: { id: p.id } }))).status).toBe(404)
    await h.api('alice').call(API.restoreTrash, { params: { id: trashId } })
    const now = await h.api('bob').call(API.getProject, { params: { id: p.id } })
    expect([now.inTrash, now.instructions]).toEqual([false, 'Secret plan'])
  })

  test('an admin who is not a member restores it in Files › Trash, still without its contents', async () => {
    const { p, trashId } = await trashed('Admin in Files trash')
    await h.api('carol').call(API.restoreTrash, { params: { id: trashId } })
    const now = await h.api('carol').call(API.getProject, { params: { id: p.id }, query: { manage: '1' } })
    expect([now.inTrash, now.member, now.instructions]).toEqual([false, false, ''])
    expect((await h.api('bob').call(API.getProject, { params: { id: p.id } })).instructions).toBe('Secret plan')
  })

  test('a creator who is no longer one of its members neither sees nor restores it', async () => {
    const p = await h.api('alice').call(API.createProject, { body: { name: 'Creator left', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
    // alice's own rule is gone (she left it: the members dialog keeps a creator's rule, so as the data has it), then an
    // admin puts it in the trash
    db().query("DELETE FROM folder_rules WHERE subject_type = 'user' AND subject_id = 'alice' AND folder_id = (SELECT id FROM folders WHERE path = ?)").run(p.folderPath)
    await h.api('carol').call(API.deleteProject, { params: { id: p.id } })
    const trashId = (db().query('SELECT trashed_with FROM projects WHERE id = ?').get(p.id) as { trashed_with: string }).trashed_with
    expect((await errOf(h.api('alice').call(API.restoreProject, { params: { id: p.id } }))).status).toBe(404)
    expect((await errOf(h.api('alice').call(API.restoreTrash, { params: { id: trashId } }))).status).toBe(404)
    expect((await h.api('alice').call(API.listProjects, { query: { manage: '1' } })).items.some((x) => x.id === p.id)).toBe(false)
    // bob, still a member, keeps its card, moved there by carol
    const card = (await h.api('bob').call(API.listProjects, { query: { manage: '1' } })).items.find((x) => x.id === p.id)
    expect([card?.inTrash, card?.trashed?.by?.id, card?.canRestore]).toEqual([true, 'carol', undefined])
  })

  test('a creator who only reads it (no write by its own rules): no Restore offered, and none taken (review #769 1)', async () => {
    const p = await h.api('alice').call(API.createProject, { body: { name: 'Creator reads', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
    db().query("UPDATE folder_rules SET access = 'read' WHERE subject_type = 'user' AND subject_id = 'alice' AND folder_id = (SELECT id FROM folders WHERE path = ?)").run(p.folderPath)
    await h.api('carol').call(API.deleteProject, { params: { id: p.id } })
    const trashId = (db().query('SELECT trashed_with FROM projects WHERE id = ?').get(p.id) as { trashed_with: string }).trashed_with
    const card = await h.api('alice').call(API.getProject, { params: { id: p.id }, query: { manage: '1' } })
    expect([card.wasMember, card.canRestore]).toEqual([true, undefined])
    expect((await errOf(h.api('alice').call(API.restoreProject, { params: { id: p.id } }))).status).toBe(403)
    expect((await errOf(h.api('alice').call(API.restoreTrash, { params: { id: trashId } }))).status).toBe(404)
    expect((await h.api('alice').call(API.trash, { query: { limit: 200 } })).items.some((x) => x.id === trashId)).toBe(false)
  })

  test('restored from Files › Trash: audited as project.restore, as from its page (review #769 3)', async () => {
    const { p, trashId } = await trashed('Audited restore')
    await h.api('carol').call(API.restoreTrash, { params: { id: trashId } })
    const rows = db().query("SELECT actor_id AS actor, detail FROM audit_log WHERE action = 'project.restore' AND target = ?").all(p.id) as { actor: string; detail: string }[]
    expect(rows.map((x) => [x.actor, JSON.parse(x.detail).name])).toEqual([['carol', 'Audited restore']])
    // and its page's Restore writes exactly one too
    await h.api('alice').call(API.deleteProject, { params: { id: p.id } })
    await h.api('alice').call(API.restoreProject, { params: { id: p.id } })
    expect((db().query("SELECT count(*) AS n FROM audit_log WHERE action = 'project.restore' AND target = ?").get(p.id) as { n: number }).n).toBe(2)
  })

  test('Delete for good from Files › Trash is the project\'s own delete: its shared chats to their creators\' trash, the row gone (review #769 2)', async () => {
    const { p, chat, trashId } = await trashed('Purged from Files')
    await h.api('carol').call(API.purgeTrash, { params: { id: trashId } })
    expect(db().query('SELECT 1 FROM projects WHERE id = ?').get(p.id)).toBeNull()
    expect(db().query('SELECT 1 FROM trash_items WHERE id = ?').get(trashId)).toBeNull()
    const c = db().query('SELECT project_id, shared_at, deleted_at, deleted_by FROM chats WHERE id = ?').get(chat.id) as { project_id: string | null; shared_at: string | null; deleted_at: string | null; deleted_by: string | null }
    expect([c.project_id, c.shared_at, !!c.deleted_at, c.deleted_by]).toEqual([null, null, true, 'carol'])
    // in bob's (its creator's) Deleted history
    expect((await h.api('bob').call(API.listChats, { query: { trash: '1' } })).items.some((x) => x.id === chat.id)).toBe(true)
    const a = db().query("SELECT actor_id AS actor, detail FROM audit_log WHERE action = 'project.delete' AND target = ?").get(p.id) as { actor: string; detail: string }
    expect([a.actor, JSON.parse(a.detail).sharedChats]).toEqual(['carol', 1])
  })

  test('deleted for good: gone for its members, as before', async () => {
    const { p } = await trashed('For good')
    await h.api('carol').call(API.deleteProject, { params: { id: p.id } })
    for (const u of ['alice', 'bob']) {
      expect((await h.api(u).call(API.listProjects, { query: { manage: '1' } })).items.some((x) => x.id === p.id)).toBe(false)
      expect((await errOf(h.api(u).call(API.getProject, { params: { id: p.id }, query: { manage: '1' } }))).status).toBe(404)
    }
  })
})
