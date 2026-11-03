// A team project whose folder is in the trash is the admins' and the owner's alone (docs/DECISIONS.md "휴지통에 간
// 그룹·프로젝트·규칙 폴더", "Projects: a folder with instructions"). Projects are seen by their folder's path, and a
// trashed folder's rules go to the trash with it: the path then fell back to the rules above it, so after an admin
// trashed the finance-only shared/secret every member saw its project's name and instructions in the list, could open
// it, got its instructions in their AI, and the one-project-per-folder 409 named it.
// Fixture: alice = marketing; bob = finance; carol = admin; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

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
  test('members neither list, open nor use it, and the 409 does not name it; admins still do', async () => {
    // shared/secret: finance writes, everyone else nothing
    fs.mkdirSync(path.join(h.team, 'shared/secret'), { recursive: true })
    h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_shared_secret', 'shared/secret')").run()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_secret_fin', 'f_shared_secret', 'group', 'finance', 'write'), ('r_secret_all', 'f_shared_secret', 'everyone', NULL, 'none')").run()
    const p = await h.api('bob').call(API.createProject, { body: { name: 'Secret plan', folderPath: 'shared/secret', instructions: `${CANARY}: follow the finance plan.`, scope: 'team', participants: [] } })
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
    // one project per folder still holds, without naming it; the folder made for the try goes again
    const taken = await h.api('alice').call(API.createProject, { body: { name: 'Mine', folderPath: 'shared/secret', instructions: '', scope: 'team', participants: [] } }).then(() => null, (e: ApiError) => e)
    expect(taken?.status).toBe(409)
    expect(taken?.message).not.toContain('Secret plan')
    expect(JSON.stringify(taken?.body ?? {})).not.toContain(p.id)
    expect(fs.existsSync(path.join(h.team, 'shared/secret'))).toBe(false)

    // the admin, who alone restores the folder, still sees and opens it, and the 409 names it for them
    expect(await listed('carol')).toContain('Secret plan')
    expect((await h.api('carol').call(API.getProject, { params: { id: p.id } })).name).toBe('Secret plan')
    const forAdmin = await h.api('carol').call(API.createProject, { body: { name: 'Again', folderPath: 'shared/secret', instructions: '', scope: 'team', participants: [] } }).then(() => null, (e: ApiError) => e)
    expect(forAdmin?.status).toBe(409)
    expect(forAdmin?.message).toContain('Secret plan')
    expect(h.rt().projectForChat(p.id, h.ctx.files.principal('carol'))?.instructions).toContain(CANARY)

    // back from the trash, the folder's rules decide again: bob sees it, alice still does not
    await h.api('carol').call(API.restoreTrash, { params: { id: trashId } })
    expect(await listed('bob')).toContain('Secret plan')
    expect(await listed('alice')).not.toContain('Secret plan')
  })
})
