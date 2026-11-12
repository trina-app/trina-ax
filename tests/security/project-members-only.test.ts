// A team project's contents are its members' only (docs/DECISIONS.md "Project contents only for members"). The owner
// (dana) and an admin (carol) who are not members of "Plan" (alice and erin) try every way in: files, versions, the
// trash, search, the audience count, the project and its shared chat, the AI's tools in their own chat, a scheduled
// task's save folder, realtime, Admin › Folder permissions, the activity log, the skill changes, the export, the top
// projects/ folder, repointing. Each row must refuse, or answer without one canary. Then what they keep (the project,
// its members, rename, delete, restore) and the way in that shows: adding themselves, which its members are told.
// Fixture (tests/lib/b-harness.ts): alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { runExport } from '../../server/src/system/export'
import { readFileChunks, zstdDecompress } from '../../server/src/system/streams'
import { extractTar } from '../../server/src/system/tar'
import { atLeast } from '../../server/src/policy/access'
import { WORK } from '../lib/env'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const K = {
  file: 'SEC-PMO-FILE-41a', old: 'SEC-PMO-OLD-52b', name: 'SEC-PMO-NAME-63c', sub: 'SEC-PMO-SUB-74d', trashed: 'SEC-PMO-TRASH-85e',
  instr: 'SEC-PMO-INSTR-96f', chat: 'SEC-PMO-CHAT-a07', skill: 'SEC-PMO-SKILL-b18', live: 'SEC-PMO-LIVE-c29',
} as const
const ALL = Object.values(K)
const OUTSIDERS = ['dana', 'carol'] as const
const DIR = 'projects/Plan'

let h: Harness
let projectId = '', chatId = '', trashId = '', versionId = ''
const ws: Record<string, TestSocket> = {}
const leaked = (text: string) => ALL.filter((k) => text.includes(k))
async function raw(who: string, method: string, p: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const r = await h.req(who, p, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
  const text = await r.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: r.status, text, json }
}
const q = (p: string) => encodeURIComponent(p)

beforeAll(async () => {
  h = await startHarness({ name: 'sec-project-members-only', askUserTimeoutMs: 2500, turnTimeoutMs: 60_000 })
  for (const u of ['alice', 'erin', 'bob', 'carol', 'dana']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const a = h.api('alice')
  projectId = (await a.call(API.createProject, { body: { name: 'Plan', participants: [{ subjectType: 'user', subjectId: 'erin' }], instructions: K.instr } })).id
  expect(h.rt().store.projectRow(projectId)!.folder_path).toBe(DIR)
  const save = async (p: string, content: string) => {
    const cur = await raw('alice', 'GET', `/api/files/content?path=${q(p)}`)
    await a.call(API.saveContent, { body: { path: p, content, baseSha256: cur.status === 200 ? cur.json.sha256 : null } })
  }
  await save(`${DIR}/plan.md`, `${K.old}\n`)
  await save(`${DIR}/plan.md`, `${K.file}\n`)
  await save(`${DIR}/${K.name}.md`, 'n\n')
  await a.call(API.mkdir, { body: { path: `${DIR}/${K.sub}` } })
  await save(`${DIR}/${K.sub}/x.md`, 'x\n')
  await save(`${DIR}/${K.trashed}.md`, 'x\n')
  trashId = (await a.call(API.remove, { query: { path: `${DIR}/${K.trashed}.md` } })).trashId
  await save(`${DIR}/skills/${K.skill}/SKILL.md`, `---\nname: ${K.skill}\ndescription: plan steps\n---\nsteps\n`)
  versionId = (await a.call(API.history, { query: { path: `${DIR}/plan.md` } })).items[0]!.id
  await a.call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  chatId = (await a.call(API.createChat, { body: { projectId, title: 'plan chat' } })).id
  const sent = await a.call(API.sendMessage, { params: { id: chatId }, body: { content: `${K.chat}\n${fake({ say: 'noted' })}`, clientMessageId: cm(), attachmentIds: [] } })
  await ws.alice!.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 30_000)
  await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 30_000 })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

describe('the owner and an admin who are not members read nothing of it', () => {
  // [route, what] rows, each tried by dana and carol: a refusal, or an answer without a canary
  const rows: [string, string, string][] = [
    ['files: list projects/', 'GET', '/api/files/tree?path=projects'],
    ['files: list the project folder', 'GET', `/api/files/tree?path=${q(DIR)}`],
    ['files: list a folder inside', 'GET', `/api/files/tree?path=${q(`${DIR}/${K.sub}`)}`],
    ['files: content', 'GET', `/api/files/content?path=${q(`${DIR}/plan.md`)}`],
    ['files: download', 'GET', `/api/files/download?path=${q(`${DIR}/plan.md`)}`],
    ['files: preview', 'GET', `/api/files/preview?path=${q(`${DIR}/plan.md`)}`],
    ['files: version history', 'GET', `/api/files/history?path=${q(`${DIR}/plan.md`)}`],
    ['files: an old version', 'GET', '/api/files/history/VERSION/download'],
    ['files: the trash', 'GET', '/api/files/trash'],
    ['files: find by name', 'GET', `/api/files/find?q=${q('SEC-PMO')}`],
    ['files: search contents', 'GET', `/api/files/search?q=${q('SEC-PMO')}`],
    ['files: recent', 'GET', '/api/files/recent'],
    ['files: who can see a folder inside', 'GET', `/api/files/audience?path=${q(`${DIR}/${K.sub}`)}`],
    ['projects: the list', 'GET', '/api/projects'],
    ['projects: the list to manage', 'GET', '/api/projects?manage=1'],
    ['projects: one, to manage', 'GET', '/api/projects/PROJECT?manage=1'],
    ['projects: who sees it', 'GET', '/api/projects/PROJECT/access'],
    ['chats: the project\'s chats', 'GET', '/api/chats?projectId=PROJECT'],
    ['chats: search', 'GET', `/api/chats?q=${q(K.chat)}`],
    ['chats: the shared chat', 'GET', '/api/chats/CHAT'],
    ['chats: its messages', 'GET', '/api/chats/CHAT/messages'],
    ['admin: the tree at projects/', 'GET', `/api/admin/access/tree?path=projects&open=1`],
    ['admin: the tree with its rule folders', 'GET', '/api/admin/access/tree?path=&rules=1'],
    ['admin: the project folder\'s people', 'GET', `/api/admin/access/folder?path=${q(DIR)}`],
    ['admin: by person (alice)', 'GET', '/api/admin/access/people/alice'],
    ['admin: the activity log', 'GET', '/api/admin/audit?limit=200'],
    ['admin: the skill changes', 'GET', '/api/admin/skill-changes'],
    ['inbox', 'GET', '/api/notifications'],
  ]
  for (const who of OUTSIDERS) {
    for (const [label, method, p0] of rows) {
      test(`${who}: ${label}`, async () => {
        const p = p0.replace('PROJECT', projectId).replace('CHAT', chatId).replace('VERSION', versionId)
        const r = await raw(who, method, p)
        expect(leaked(r.text)).toEqual([])
        expect(r.status).toBeLessThan(500)
      })
    }
    test(`${who}: the project itself is refused as missing, unless asked to manage it`, async () => {
      expect((await raw(who, 'GET', `/api/projects/${projectId}`)).status).toBe(404)
      const m = await raw(who, 'GET', `/api/projects/${projectId}?manage=1`)
      expect(m.status).toBe(200)
      expect(m.json.member).toBe(false)
      expect(m.json.instructions).toBe('')
      expect(m.json.canManage).toBe(true)
      expect(m.json.audience).toBe(2)
      expect((await raw(who, 'GET', '/api/projects')).json.items.some((p: { id: string }) => p.id === projectId)).toBe(false)
      expect((await raw(who, 'GET', '/api/projects?manage=1')).json.items.some((p: { id: string }) => p.id === projectId)).toBe(true)
    })
    test(`${who}: every read of what is in it answers like a missing path`, async () => {
      for (const p of [`/api/files/content?path=${q(`${DIR}/plan.md`)}`, `/api/files/download?path=${q(`${DIR}/plan.md`)}`, `/api/files/tree?path=${q(DIR)}`, `/api/files/history?path=${q(`${DIR}/plan.md`)}`, `/api/files/history/${versionId}/download`, `/api/files/audience?path=${q(`${DIR}/${K.sub}`)}`, `/api/chats/${chatId}`, `/api/chats/${chatId}/messages`])
        expect((await raw(who, 'GET', p)).status, p).toBe(404)
      expect((await raw(who, 'POST', `/api/files/trash/${trashId}/restore`)).status).toBe(404)
    })
    test(`${who}: writing into it, sending in its chat, moving it out: refused`, async () => {
      expect((await raw(who, 'PUT', '/api/files/content', { path: `${DIR}/new.md`, content: 'x', baseSha256: null })).status).toBeGreaterThanOrEqual(400)
      expect((await raw(who, 'POST', '/api/files/mkdir', { path: `${DIR}/new-folder` })).status).toBeGreaterThanOrEqual(400)
      expect((await raw(who, 'POST', `/api/chats/${chatId}/messages`, { content: 'hi', clientMessageId: cm(), attachmentIds: [] })).status).toBe(404)
      expect((await raw(who, 'POST', '/api/chats', { projectId, title: 'mine' })).status).toBe(404)
      expect((await raw(who, 'POST', '/api/files/move', { from: DIR, to: 'shared/Plan', onExists: 'fail' })).status).toBeGreaterThanOrEqual(400)
      expect(fs.existsSync(path.join(h.team, 'projects', 'Plan', 'plan.md'))).toBe(true)
    })
    test(`${who}: the top projects/ folder never moves, is never renamed (any letter case) and never goes to the trash`, async () => {
      for (const to of ['archive', 'Projects', 'shared/projects']) expect((await raw(who, 'POST', '/api/files/move', { from: 'projects', to, onExists: 'fail' })).status, to).toBeGreaterThanOrEqual(400)
      expect((await raw(who, 'DELETE', '/api/files?path=projects')).status).toBeGreaterThanOrEqual(400)
      expect(fs.existsSync(path.join(h.team, 'projects', 'Plan'))).toBe(true)
    })
    test(`${who}: Admin › Folder permissions never writes or answers inside it, with one answer for present and missing paths`, async () => {
      const a = await raw(who, 'POST', '/api/admin/folders', { path: `${DIR}/${K.sub}`, create: false, rules: [{ subjectType: 'user', subjectId: who, access: 'read' }] })
      const b = await raw(who, 'POST', '/api/admin/folders', { path: `${DIR}/not-there`, create: false, rules: [{ subjectType: 'user', subjectId: who, access: 'read' }] })
      expect(a.status).toBe(409); expect(b.status).toBe(409)
      expect(a.json.error.params.reason).toBe('project_members_only'); expect(b.json.error.params.reason).toBe('project_members_only')
      expect((await raw(who, 'POST', '/api/admin/folders', { path: DIR, create: false, rules: [{ subjectType: 'user', subjectId: who, access: 'write' }] })).status).toBe(409)
      expect((await raw(who, 'POST', '/api/admin/folders', { path: 'Projects/Plan', create: false, rules: [] })).status).toBe(409)
      // (the row's id from the database: this fixture's ids are not the UUIDs GET /api/admin/folders answers with)
      const row = h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(DIR) as { id: string }
      expect((await raw(who, 'PUT', `/api/admin/folders/${row.id}/rules`, { rules: [{ subjectType: 'user', subjectId: who, access: 'write' }] })).status).toBe(409)
      expect((await raw(who, 'DELETE', `/api/admin/folders/${row.id}`)).status).toBe(409)
      expect((await raw(who, 'POST', '/api/admin/folder-rules/preview', { changes: [{ path: `${DIR}/${K.sub}`, rules: [] }] })).status).toBe(409)
      expect((await raw(who, 'POST', '/api/admin/access/edit-preview', { path: DIR, rules: [] })).status).toBe(409)
      const t1 = await raw(who, 'GET', `/api/admin/access/tree?path=${q(`${DIR}/${K.sub}`)}`)
      const t2 = await raw(who, 'GET', `/api/admin/access/tree?path=${q(`${DIR}/not-there`)}`)
      expect([t1.status, t2.status]).toEqual([400, 400])
      const f1 = await raw(who, 'GET', `/api/admin/access/folder?path=${q(`${DIR}/${K.sub}`)}`)
      const f2 = await raw(who, 'GET', `/api/admin/access/folder?path=${q(`${DIR}/not-there`)}`)
      expect([f1.status, f2.status]).toEqual([400, 400])
      // still nobody but alice and erin
      expect(atLeast(h.ctx.files.rules().access(h.ctx.files.principal(who), DIR.split('/')), 'read')).toBe(false)
    })
    test(`${who}: the activity log names nothing inside it, and a path filter inside it answers empty`, async () => {
      const log = await raw(who, 'GET', '/api/admin/audit?limit=200')
      expect(leaked(log.text)).toEqual([])
      expect(log.text).toContain('projects/Plan/…')
      const inside = await raw(who, 'GET', `/api/admin/audit?path=${q(`${DIR}/plan.md`)}`)
      expect(inside.json.items).toEqual([])
    })
  }

  // (no canary in the calls themselves: the person's own message holds them; K.name is a file name the call names, so
  // only the answers are checked for the others)
  test('the AI of the owner and of an admin, in their own chats: no read, list, search, copy or move reaches into it', async () => {
    for (const who of OUTSIDERS) {
      const own = (await h.api(who).call(API.createChat, { body: { title: 'probe' } })).id
      const sent = await h.api(who).call(API.sendMessage, { params: { id: own }, body: { clientMessageId: cm(), attachmentIds: [], content: fake(
        { tool: 'read', args: { file_path: `${DIR}/plan.md` } },
        { tool: 'read', args: { file_path: `${DIR}/${K.name}.md` } },
        { tool: 'glob', args: { pattern: '**/*', path: DIR } },
        { tool: 'grep', args: { pattern: 'SEC-PMO', path: 'projects' } },
        { tool: 'grep', args: { pattern: 'SEC-PMO' } },
        { tool: 'copy_files', args: { items: [{ from: `${DIR}/plan.md`, to: 'shared/stolen.md' }] } },
        { tool: 'move_files', args: { items: [{ from: `${DIR}/plan.md`, to: 'shared/stolen2.md' }] } },
        { say: 'done' },
      ) } })
      await ws[who]!.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 60_000)
      await waitFor(() => !h.rt().activeTurn(own), { timeoutMs: 30_000 })
      const msgs = await raw(who, 'GET', `/api/chats/${own}/messages`)
      expect(leaked(msgs.text).filter((k) => k !== K.name)).toEqual([])
      expect(fs.existsSync(path.join(h.team, 'shared', 'stolen.md'))).toBe(false)
      expect(fs.existsSync(path.join(h.team, 'shared', 'stolen2.md'))).toBe(false)
    }
  })

  test('realtime: a save inside it reaches its members, never the owner or an admin', async () => {
    for (const s of Object.values(ws)) s.frames.length = 0
    const cur = await raw('alice', 'GET', `/api/files/content?path=${q(`${DIR}/plan.md`)}`)
    await h.api('alice').call(API.saveContent, { body: { path: `${DIR}/${K.live}.md`, content: 'live\n', baseSha256: null } })
    void cur
    await ws.erin!.next('files.changed', (f) => JSON.stringify(f).includes(K.live), 8000)
    await Bun.sleep(500)
    for (const who of OUTSIDERS) expect(ws[who]!.frames.filter((f) => leaked(JSON.stringify(f)).length).length, who).toBe(0)
  })

  test('the owner\'s export leaves out every project she does not read, and every folder inside one she cannot read', async () => {
    const rules = h.ctx.files.rules()
    const dana = h.ctx.files.principal('dana')
    const r = await runExport(h.ctx.db, h.team, { ownerId: 'dana', locale: 'en', what: ['files'], readable: (rel) => atLeast(rules.access(dana, rel.split('/')), 'read') })
    const out = path.join(WORK, `pmo-export-${Date.now()}`)
    fs.mkdirSync(out, { recursive: true })
    await extractTar(zstdDecompress(readFileChunks(path.join(h.team, r.path))), out)
    const names: string[] = []
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { names.push(e.name); if (e.isDirectory()) walk(path.join(d, e.name)) } }
    walk(out)
    expect(names.filter((n) => leaked(n).length)).toEqual([])
    expect(names).not.toContain('plan.md')
    // without a reader: none of projects/ goes in (fails closed)
    const r2 = await runExport(h.ctx.db, h.team, { ownerId: 'dana', locale: 'en', what: ['files'] })
    const out2 = path.join(WORK, `pmo-export2-${Date.now()}`)
    fs.mkdirSync(out2, { recursive: true })
    await extractTar(zstdDecompress(readFileChunks(path.join(h.team, r2.path))), out2)
    const all2: string[] = []
    const walk2 = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { all2.push(path.relative(out2, path.join(d, e.name))); if (e.isDirectory()) walk2(path.join(d, e.name)) } }
    walk2(out2)
    expect(all2.some((p) => /\/files\/projects\/./.test(p))).toBe(false)
  })
})

describe('what the owner and admins keep, and the way in that shows', () => {
  test('carol manages it without reading it: its members, a rename; the dry run counts nothing inside', async () => {
    const acc = await raw('carol', 'GET', `/api/projects/${projectId}/access`)
    expect(acc.status).toBe(200)
    expect(leaked(acc.text)).toEqual([])
    const dry = await raw('carol', 'POST', '/api/projects/access-preview', { projectId, participants: [{ subjectType: 'user', subjectId: 'erin' }, { subjectType: 'user', subjectId: 'bob' }] })
    expect(dry.status).toBe(200)
    expect(dry.json.contentsHidden).toBe(true)
    expect([dry.json.files, dry.json.sharedChats, dry.json.skills]).toEqual([0, 0, 0])
    expect(leaked(dry.text)).toEqual([])
    const ren = await raw('carol', 'PATCH', `/api/projects/${projectId}`, { name: 'Plan B' })
    expect(ren.status).toBe(200)
    expect(ren.json.instructions).toBe('')
    expect((await raw('carol', 'PATCH', `/api/projects/${projectId}`, { instructions: 'mine now' })).status).toBe(403)
    expect(h.rt().store.projectRow(projectId)!.instructions).toBe(K.instr)
    await raw('carol', 'PATCH', `/api/projects/${projectId}`, { name: 'Plan' })
  })

  test('the new-project dry run counts the owner and admins only when chosen, for every caller', async () => {
    for (const who of ['alice', 'carol']) {
      const r = await raw(who, 'POST', '/api/projects/access-preview', { participants: [{ subjectType: 'user', subjectId: 'erin' }] })
      expect(r.json.people).toBe(2)
      expect(r.json.adminsApart).toBeUndefined()
    }
  })

  test('Add me: carol adds herself; it is audited as hers, its members are told in their inbox, and she reads it', async () => {
    const acc = (await raw('carol', 'GET', `/api/projects/${projectId}/access`)).json
    const parts = acc.participants.filter((x: { creator?: boolean }) => !x.creator).map((x: { subjectType: string; subjectId: string }) => ({ subjectType: x.subjectType, subjectId: x.subjectId }))
    const put = await raw('carol', 'PUT', `/api/projects/${projectId}/participants`, { participants: [...parts, { subjectType: 'user', subjectId: 'carol' }], expectedHash: acc.rulesHash })
    expect(put.status).toBe(200)
    const rules = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'folder.rules' AND target = ? ORDER BY id DESC LIMIT 1").get(DIR) as { detail: string }
    expect(JSON.parse(rules.detail).self).toBe(true)
    const gained = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'project.member_gained' ORDER BY id DESC LIMIT 1").get() as { actor_id: string; detail: string }
    expect(gained.actor_id).toBe('carol')
    expect(JSON.parse(gained.detail)).toMatchObject({ projectId, userId: 'carol', self: true })
    for (const m of ['alice', 'erin']) {
      const inbox = await raw(m, 'GET', '/api/notifications')
      const n = inbox.json.items.find((x: { code: string }) => x.code === 'project.joined')
      expect(n?.projectJoined?.project?.id, m).toBe(projectId)
    }
    expect((await raw('dana', 'GET', '/api/notifications')).json.items.some((x: { code: string }) => x.code === 'project.joined')).toBe(false)
    expect((await raw('carol', 'GET', `/api/files/content?path=${q(`${DIR}/plan.md`)}`)).text).toContain(K.file)
    expect((await raw('carol', 'GET', `/api/projects/${projectId}`)).json.instructions).toBe(K.instr)
  })

  test('joining through a group the project names is told too: dana added to it', async () => {
    // (a group made through the API: this fixture's own group ids are not the UUIDs the group answers carry; carol, an
    // admin, names it: a member names only their own groups)
    const grp = await raw('dana', 'POST', '/api/admin/groups', { name: 'plan helpers', memberIds: ['bob'] })
    expect(grp.status).toBe(201)
    const acc = (await raw('carol', 'GET', `/api/projects/${projectId}/access`)).json
    const parts = acc.participants.filter((x: { creator?: boolean }) => !x.creator).map((x: { subjectType: string; subjectId: string }) => ({ subjectType: x.subjectType, subjectId: x.subjectId }))
    expect((await raw('carol', 'PUT', `/api/projects/${projectId}/participants`, { participants: [...parts, { subjectType: 'group', subjectId: grp.json.id }], expectedHash: acc.rulesHash })).status).toBe(200)
    expect((await raw('dana', 'GET', `/api/files/content?path=${q(`${DIR}/plan.md`)}`)).status).toBe(404)
    const g = await raw('dana', 'PATCH', `/api/admin/groups/${grp.json.id}`, { memberIds: ['bob', 'dana'] })
    expect(g.status).toBe(200)
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'project.member_gained' AND json_extract(detail, '$.userId') = 'dana' ORDER BY id DESC LIMIT 1").get() as { detail: string } | null
    expect(row).not.toBeNull()
    expect(JSON.parse(row!.detail)).toMatchObject({ projectId, self: true })
    const told = await raw('alice', 'GET', '/api/notifications')
    expect(told.json.items.filter((x: { code: string; projectJoined?: { name: string | null } }) => x.code === 'project.joined' && x.projectJoined?.name?.toLowerCase().includes('dana')).length).toBe(1)
    await raw('dana', 'PATCH', `/api/admin/groups/${grp.json.id}`, { memberIds: ['bob'] })
  })

  test('delete: to the trash with its folder first (nobody reads it there), restore by an admin, then delete for good', async () => {
    const other = (await h.api('alice').call(API.createProject, { body: { name: 'Gone soon', participants: [], instructions: K.instr } })).id
    await h.api('alice').call(API.saveContent, { body: { path: 'projects/Gone soon/g.md', content: `${K.file}\n`, baseSha256: null } })
    expect((await raw('carol', 'DELETE', `/api/projects/${other}`)).status).toBe(204)
    const row = h.rt().store.projectRow(other)!
    expect(row.trashed_with).not.toBeNull()
    expect(fs.existsSync(path.join(h.team, 'projects', 'Gone soon'))).toBe(false)
    // in the trash: alice no longer reads it either; carol sees it to manage, nothing inside
    expect((await raw('alice', 'GET', `/api/projects/${other}`)).status).toBe(404)
    const m = await raw('carol', 'GET', `/api/projects/${other}?manage=1`)
    expect(m.json.inTrash).toBe(true)
    expect(leaked(m.text)).toEqual([])
    // a repoint by an admin who is not a member of what it held: refused
    expect((await raw('carol', 'PATCH', `/api/projects/${other}`, { folderPath: DIR })).status).toBe(403)
    // restore: back with its folder and its rules (alice again, carol still not)
    const back = await raw('carol', 'POST', `/api/projects/${other}/restore`)
    expect(back.status).toBe(200)
    expect(fs.existsSync(path.join(h.team, 'projects', 'Gone soon', 'g.md'))).toBe(true)
    expect((await raw('alice', 'GET', `/api/projects/${other}`)).status).toBe(200)
    expect((await raw('carol', 'GET', `/api/files/content?path=${q('projects/Gone soon/g.md')}`)).status).toBe(404)
    // delete, then delete for good: the row and the folder's trash item go
    await raw('carol', 'DELETE', `/api/projects/${other}`)
    const tw = h.rt().store.projectRow(other)!.trashed_with!
    expect((await raw('carol', 'DELETE', `/api/projects/${other}`)).status).toBe(204)
    expect(h.rt().store.projectRow(other)).toBeNull()
    expect(h.ctx.db.query('SELECT 1 FROM trash_items WHERE id = ?').get(tw)).toBeNull()
  })
})

describe('the review\'s attacks (security review of the built code)', () => {
  test('M1: trash the project, join one of its groups, restore it: the join is recorded and told', async () => {
    const grp = await raw('dana', 'POST', '/api/admin/groups', { name: 'crew m1', memberIds: ['alice', 'erin'] })
    const id = (await h.api('alice').call(API.createProject, { body: { name: 'M one', participants: [{ subjectType: 'group', subjectId: grp.json.id }], instructions: '' } })).id
    await h.api('alice').call(API.saveContent, { body: { path: 'projects/M one/m.md', content: `${K.file}\n`, baseSha256: null } })
    expect((await raw('carol', 'DELETE', `/api/projects/${id}`)).status).toBe(204)
    expect((await raw('dana', 'PATCH', `/api/admin/groups/${grp.json.id}`, { memberIds: ['erin', 'carol'] })).status).toBe(200)
    expect((await raw('carol', 'POST', `/api/projects/${id}/restore`)).status).toBe(200)
    expect((await raw('carol', 'GET', `/api/files/content?path=${q('projects/M one/m.md')}`)).status).toBe(200)
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'project.member_gained' AND json_extract(detail, '$.userId') = 'carol' AND json_extract(detail, '$.projectId') = ?").get(id)
    expect(row).not.toBeNull()
    const told = h.ctx.db.query("SELECT user_id FROM project_notices WHERE event_type = 'project.joined'").all() as { user_id: string }[]
    expect(told.map((x) => x.user_id)).toContain('alice')
  })

  test('M2: a rule on a folder inside a project never lets the owner or an admin in alone', async () => {
    const grp = await raw('dana', 'POST', '/api/admin/groups', { name: 'crew m2', memberIds: [] })
    const id = (await h.api('alice').call(API.createProject, { body: { name: 'M two', participants: [], instructions: '' } })).id
    await h.api('alice').call(API.mkdir, { body: { path: 'projects/M two/hr' } })
    const M2 = 'SEC-PMO-M2-d40'
    await h.api('alice').call(API.saveContent, { body: { path: 'projects/M two/hr/pay.md', content: `${M2}\n`, baseSha256: null } })
    // a rule inside it, as Folder permissions of an older build could set it
    const { legacyProjectFolder } = await import('../lib/legacy-project')
    legacyProjectFolder(h.ctx.db, h.team, 'projects/M two/hr', [{ subjectType: 'group', subjectId: grp.json.id, access: 'read' }])
    await raw('dana', 'PATCH', `/api/admin/groups/${grp.json.id}`, { memberIds: ['carol'] })
    expect((await raw('carol', 'GET', `/api/files/content?path=${q('projects/M two/hr/pay.md')}`)).status).toBe(404)
    expect((await raw('carol', 'GET', `/api/files/tree?path=${q('projects/M two')}`)).status).toBe(404)
    expect((await raw('carol', 'GET', `/api/files/search?q=${q(M2)}`)).text).not.toContain(M2)
    expect((await raw('carol', 'GET', `/api/files/find?q=${q('pay')}`)).text).not.toContain('M two/hr')
    void id
  })

  test('M3: names with \' and ` inside a project stay out of the activity log, its path filter and the skill changes', async () => {
    const M3 = 'SEC-PMO-M3-e51', M3S = 'SEC-PMO-M3S-f62'
    const id = (await h.api('alice').call(API.createProject, { body: { name: "Bob's `plan`", participants: [], instructions: '' } })).id
    const dir = h.rt().store.projectRow(id)!.folder_path
    await h.api('alice').call(API.saveContent, { body: { path: `${dir}/John's ${M3}.md`, content: 'x\n', baseSha256: null } })
    await h.api('alice').call(API.saveContent, { body: { path: `${dir}/skills/${M3S}/SKILL.md`, content: `---\nname: ${M3S}\ndescription: d\n---\nx\n`, baseSha256: null } })
    for (const who of OUTSIDERS) {
      const log = await raw(who, 'GET', '/api/admin/audit?limit=200')
      expect(log.text, who).not.toContain(M3)
      expect(log.text, who).not.toContain(M3S)
      expect((await raw(who, 'GET', `/api/admin/audit?path=${q(dir)}`)).json.items).toEqual([])
      const skills = await raw(who, 'GET', '/api/admin/skill-changes')
      expect(skills.text, who).not.toContain(M3S)
    }
  })
})
