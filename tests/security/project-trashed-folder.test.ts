// A team project whose folder is in the trash is the admins' and the owner's alone (docs/DECISIONS.md "휴지통에 간
// 그룹·프로젝트·규칙 폴더", "Projects: a folder with instructions"). Projects are seen by their folder's path, and a
// trashed folder's rules go to the trash with it: the path then fell back to the rules above it, so after an admin
// trashed the finance-only shared/secret every member saw its project's name and instructions in the list, could open
// it, got its instructions in their AI, and the one-project-per-folder 409 named it. Now the project carries the trash
// item that took its folder (projects.trashed_with): nobody reads it until the folder comes back, the owner and admins
// included, who manage it without its contents (docs/DECISIONS.md "Project contents only for members"), and it holds no
// path meanwhile, so whoever makes a new folder there may make their own project on it.
// Fixture: alice = marketing; bob = finance; carol = admin; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const CANARY = 'SECRET-CANARY-4411'

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'sec-project-trashed-folder' })
  alice = await h.ws('alice')
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

const status = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof ApiError ? e.status : 0))
const listed = async (who: string) => (await h.api(who).call(API.listProjects)).items.map((p) => p.name)

describe('a project whose restricted folder is in the trash', () => {
  test('members neither list, open nor use it; it holds no path; admins only manage it; it follows its folder back', async () => {
    // shared/secret: finance writes, everyone else nothing
    fs.mkdirSync(path.join(h.team, 'shared/secret'), { recursive: true })
    h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_shared_secret', 'shared/secret')").run()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_secret_fin', 'f_shared_secret', 'group', 'finance', 'write'), ('r_secret_all', 'f_shared_secret', 'everyone', NULL, 'none')").run()
    const p = await oldProject(h, 'bob', { name: 'Secret plan', folderPath: 'shared/secret', instructions: `${CANARY}: follow the finance plan.` })
    // alice's chat names the project (attached while she could see it; here directly)
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    h.ctx.db.query('UPDATE chats SET project_id = ? WHERE id = ?').run(p.id, chat.id)
    expect(await listed('alice')).not.toContain('Secret plan')

    const { trashId } = await h.api('carol').call(API.remove, { query: { path: 'shared/secret' } })
    // the path now falls back to shared/ (everyone writes): alice could read it, but the project stays hidden from her
    expect(fs.existsSync(path.join(h.team, 'shared/secret'))).toBe(false)
    expect(await listed('alice')).not.toContain('Secret plan')
    expect(await status(h.api('alice').call(API.getProject, { params: { id: p.id } }))).toBe(404)
    expect(await status(h.api('alice').call(API.createChat, { body: { projectId: p.id } }))).toBe(404)
    expect(await status(h.api('alice').call(API.updateChat, { params: { id: chat.id }, body: { projectId: p.id } }))).toBe(404)
    expect(await status(h.api('alice').call(API.updateProject, { params: { id: p.id }, body: { instructions: 'mine now' } }))).toBe(404)
    // a turn in her chat: the project's name and instructions do not reach her AI
    const turn = await ask(h, alice, 'alice', chat.id, fake({ echo: 'system' }))
    expect(turn.done.status).toBe('done')
    expect(turn.done.content).not.toContain(CANARY)
    expect(turn.done.content).not.toContain('Secret plan')
    // the admin, who restores the folder, no longer opens it (it was listed and opened for her): only her manage list
    // has it, marked as in the trash, without its instructions; no turn gets it, hers included: its path may be another
    // folder's by now
    expect(await listed('carol')).not.toContain('Secret plan')
    expect(await status(h.api('carol').call(API.getProject, { params: { id: p.id } }))).toBe(404)
    const managed = await h.api('carol').call(API.getProject, { params: { id: p.id }, query: { manage: '1' } })
    expect(managed).toMatchObject({ name: 'Secret plan', inTrash: true, member: false, instructions: '' })
    expect(JSON.stringify(managed)).not.toContain(CANARY)
    expect(JSON.stringify(await h.api('carol').call(API.listProjects, { query: { manage: '1' } }))).not.toContain(CANARY)
    expect(await status(h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { instructions: 'mine now' } }))).toBe(409) // project_in_trash: its instructions nobody's while there
    expect(h.rt().projectForChat(p.id, h.ctx.files.principal('carol'))).toBeNull()

    // it holds no path meanwhile: alice's own new project on a new shared/secret is hers, and names nothing of it
    const mine = await oldProject(h, 'alice', { name: 'Mine', folderPath: 'shared/secret', instructions: '' })
    expect(mine.folderPath).toBe('shared/secret')
    expect(await listed('alice')).toEqual(expect.arrayContaining(['Mine']))
    expect(await listed('alice')).not.toContain('Secret plan')

    // back from the trash (under a new name, since alice's folder took the old one), the project follows its folder and
    // the folder's rules decide again: bob sees it there, alice still does not; alice's project stays on her folder
    const back = await h.api('carol').call(API.restoreTrash, { params: { id: trashId } })
    const row = h.rt().store.projectRow(p.id)!
    expect(row.folder_path).toBe(back.entry.path)
    expect(row.folder_path).not.toBe('shared/secret')
    expect(row.trashed_with).toBeNull()
    expect(await h.api('carol').call(API.getProject, { params: { id: p.id } })).toMatchObject({ inTrash: false })
    expect(h.rt().projectForChat(p.id, h.ctx.files.principal('bob'))?.instructions).toContain(CANARY)
    expect(await listed('bob')).toContain('Secret plan')
    expect(await listed('alice')).not.toContain('Secret plan')
    expect(h.rt().store.projectRow(mine.id)!.folder_path).toBe('shared/secret')
  })
})
