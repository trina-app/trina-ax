// QA TC-360, the owner's choice (2026-11-12, "안내 + 한 번에 추가"): after 0.4.0 -> 0.5.0 the owner and admins who lost
// team projects they read by their role on 0.4.0 get ONE card naming them, "Add me to these" and a dismiss
// (server/src/chat/old-projects.ts; docs/DECISIONS.md "Projects from before the update: one card, Add me to these").
// A 0.4.0-shaped team: the owner (dana), admins carol (made most projects), frank (an old admin, member of Finance),
// grace (an admin made after the update), henry (a member made an admin after the update), members alice and bob.
// Projects from 0.4.0: Sales (projects/sales: carol, alice), Ops (Projects/ops, capital P where the disk ignores case,
// else projects/ops: carol, bob), Finance
// (projects/finance: frank), Left (projects/left: carol; frank joined after the update and was taken out again); after
// the update: New (projects/new: carol); a personal one of alice's. The owner's template task on Sales, and one on Ops
// she changed after it paused.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared'
import { addTestPerson, startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { membersOnlyOnce } from '../../server/src/chat/members-only-once'
import { TurnExec } from '../../server/src/chat/turn'
import { CONFIRMED } from '../lib/schedule-card'

setDefaultTimeout(120_000)
const q = (p: string) => encodeURIComponent(p)
const OLD = '2026-01-05T09:00:00.000Z'
const SECRET = 'TC360-NOTICE-SECRET'

let h: Harness
const ids = { sales: uuidv7(), ops: uuidv7(), finance: uuidv7(), left: uuidv7(), fresh: uuidv7(), personal: uuidv7() }
let taskOnSales = '', taskOnOps = ''
async function raw(who: string, method: string, p: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const r = await h.req(who, p, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
  const text = await r.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: r.status, text, json }
}
const card = async (who: string) => {
  const r = await raw(who, 'GET', '/api/projects/update-notice')
  expect(r.status, who).toBe(200)
  return (r.json.items as { id: string; name: string }[]).map((x) => x.name)
}
const reads = async (who: string, dir: string) => (await raw(who, 'GET', `/api/files/content?path=${q(`${dir}/plan.md`)}`)).text.includes(SECRET)
// the project's contents (without manage: only a member's); Projects/ops by this, as the fixture's volume may fold its
// name into projects/
const opens = async (who: string, id: string) => (await raw(who, 'GET', `/api/projects/${id}`)).status === 200

beforeAll(async () => {
  h = await startHarness({ name: 'b-old-projects-notice', askUserTimeoutMs: 2500, turnTimeoutMs: 60_000 })
  const db = h.ctx.db
  // (henry is a member at the update, made an admin after it)
  for (const [id, name, role] of [['frank', 'Frank Admin', 'admin'], ['henry', 'Henry Admin', 'member']] as const) {
    db.query('INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, ?)').run(id, id, name, role)
    addTestPerson(id, { id, name, role, locale: 'en' })
  }
  db.query('UPDATE users SET created_at = ?').run(OLD)
  db.query("DELETE FROM settings WHERE key IN ('projectsMembersOnly.v1', 'projectsMembersOnly.staff')").run()
  const root = h.ctx.files.fx.root
  const project = (id: string, name: string, dir: string, creator: string | null, members: string[], at = OLD) => {
    fs.mkdirSync(path.join(root, ...dir.split('/')), { recursive: true })
    fs.writeFileSync(path.join(root, ...dir.split('/'), 'plan.md'), `${SECRET}\n`)
    if (!dir.startsWith('users/')) {
      const folder = uuidv7()
      db.query('INSERT INTO folders (id, path, created_at) VALUES (?, ?, ?)').run(folder, dir, at)
      for (const who of members) db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by) VALUES (?, ?, 'user', ?, 'write', 'carol')").run(uuidv7(), folder, who)
    }
    db.query('INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at, instructions_author, instructions_authored) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, dir, '', creator, at, creator, '')
  }
  project(ids.sales, 'Sales', 'projects/sales', 'carol', ['carol', 'alice'])
  // (Projects/ is projects/ only where the disk ignores case: docs/DECISIONS.md "Only the lowercase projects/")
  const ops = h.ctx.files.fx.caseInsensitive ? 'Projects/ops' : 'projects/ops'
  project(ids.ops, 'Ops', ops, 'carol', ['carol', 'bob'])
  project(ids.finance, 'Finance', 'projects/finance', 'frank', ['frank'])
  project(ids.left, 'Left', 'projects/left', 'carol', ['carol'])
  project(ids.personal, 'Alice notes', 'users/alice/projects/notes', 'alice', [])
  fs.mkdirSync(path.join(root, 'users', 'dana', 'reports'), { recursive: true })
  // the owner's template tasks from 0.4.0 on two of them
  const rt = h.rt()
  const template = (source: string) => {
    const s = rt.schedules.create('dana', { title: 'Daily file index', prompt: 'index', repeat: 'daily', time: '09:00' } as never, new Date(), CONFIRMED)
    db.query("UPDATE schedules SET template_id = 'daily-file-index', template_version = 1, template_source_path = ?, template_output_path = 'users/dana/reports' WHERE id = ?").run(source, s.id)
    return s.id
  }
  taskOnSales = template('projects/sales')
  taskOnOps = template(ops)
  // the first start of the new build (T)
  await membersOnlyOnce(h.ctx)
  // after the update: a new project, a role change, a new admin, and frank in Left and out again
  await new Promise((r) => setTimeout(r, 5))
  const after = new Date().toISOString()
  project(ids.fresh, 'New', 'projects/new', 'carol', ['carol'], after)
  db.query("UPDATE users SET role = 'admin' WHERE id = 'henry'").run()
  addTestPerson('henry', { id: 'henry', name: 'Henry Admin', role: 'admin', locale: 'en' })
  db.query("INSERT INTO audit_log (actor_id, action, target, detail, at) VALUES ('dana', 'user.update', 'henry', '{\"role\":\"admin\"}', ?)").run(after)
  db.query("INSERT INTO users (id, username, name, role, created_at) VALUES ('grace', 'grace', 'Grace Admin', 'admin', ?)").run(after)
  addTestPerson('grace', { id: 'grace', name: 'Grace Admin', role: 'admin', locale: 'en' })
  db.query("INSERT INTO audit_log (actor_id, action, target, detail, at) VALUES ('frank', 'project.member_gained', ?, ?, ?)").run(ids.left, JSON.stringify({ projectId: ids.left, userId: 'frank', via: 'project', self: true }), after)
})
afterAll(async () => { await h.close() })

describe('the card for projects from before the update', () => {
  test('the owner and an old admin see the projects they read by role on 0.4.0 and not now; nobody else gets one', async () => {
    // (Ops is in Projects/ with a capital P where the disk ignores case: the members-only zone in any letter case there)
    expect(await card('dana')).toEqual(['Finance', 'Left', 'Ops', 'Sales'])
    // frank is in Finance, and left Left after the update (someone chose that)
    expect(await card('frank')).toEqual(['Ops', 'Sales'])
    // carol made and is in the rest
    expect(await card('carol')).toEqual(['Finance'])
    // an admin made after the update, and one whose role changed since: they did not read them on 0.4.0
    expect(await card('grace')).toEqual([])
    expect(await card('henry')).toEqual([])
    // who was one at the update is kept at the first start (the audit rows age out); without it, read from the audit
    const keptStaff = h.ctx.db.query("SELECT value FROM settings WHERE key = 'projectsMembersOnly.staff'").get() as { value: string }
    expect(JSON.parse(keptStaff.value).sort()).toEqual(['carol', 'dana', 'frank'])
    h.ctx.db.query("DELETE FROM settings WHERE key = 'projectsMembersOnly.staff'").run()
    expect(await card('henry')).toEqual([])
    expect(await card('frank')).toEqual(['Ops', 'Sales'])
    h.ctx.db.query("INSERT INTO settings (key, value) VALUES ('projectsMembersOnly.staff', ?)").run(keptStaff.value)
    // members never see it
    for (const who of ['alice', 'bob', 'erin']) expect(await card(who), who).toEqual([])
    // and the card names no folder
    expect((await raw('dana', 'GET', '/api/projects/update-notice')).text).not.toContain('projects/')
  })

  test("the owner's task on such a project pauses with a plain message", async () => {
    const db = h.ctx.db
    const rt = h.rt()
    const held = spyOn(TurnExec.prototype, 'run').mockImplementation(async function () { /* nothing runs */ })
    try {
      const due = new Date(Date.now() - 60_000).toISOString()
      for (const id of [taskOnSales, taskOnOps]) db.query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(due, id)
      expect(rt.schedules.runDue(new Date())).toEqual([])
      for (const id of [taskOnSales, taskOnOps]) expect(db.query('SELECT enabled FROM schedules WHERE id = ?').get(id), id).toEqual({ enabled: 0 })
    } finally { held.mockRestore() }
    const told = await waitFor(async () => {
      const items = (await raw('dana', 'GET', '/api/notifications')).json.items as { projectGone?: boolean; membersOnly?: boolean }[]
      const gone = items.filter((n) => n.projectGone)
      return gone.length >= 2 ? gone : null
    }, { timeoutMs: 10_000 })
    expect(told!.every((n) => n.membersOnly === true)).toBe(true)
    expect(JSON.stringify(told)).not.toContain('projects/')
    // she changed the Ops task after it paused: hers to turn on, not the server's
    db.query("INSERT INTO audit_log (actor_id, action, target, detail, at) VALUES ('dana', 'schedule.edited', ?, '{}', ?)").run(taskOnOps, new Date().toISOString())
  })

  test('a member who asks to join gets nothing', async () => {
    const r = await raw('alice', 'POST', '/api/projects/update-notice/join')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ joined: 0, skipped: 0 })
    expect(await opens('alice', ids.ops)).toBe(false)
    expect(await reads('alice', 'projects/finance')).toBe(false)
  })

  test('Add me to these: a member of each, audited, their members told, the task resumes, nothing more', async () => {
    const db = h.ctx.db
    const r = await raw('dana', 'POST', '/api/projects/update-notice/join')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ joined: 4, skipped: 0 })
    for (const dir of ['projects/sales', 'projects/finance', 'projects/left']) expect(await reads('dana', dir), dir).toBe(true)
    for (const id of [ids.sales, ids.ops, ids.finance, ids.left]) expect(await opens('dana', id), id).toBe(true)
    // nothing that was not on the card: the project made after the update, a personal project
    expect(await reads('dana', 'projects/new')).toBe(false)
    expect(await opens('dana', ids.fresh)).toBe(false)
    expect(await reads('dana', 'users/alice/projects/notes')).toBe(false)
    // one row for the card, and each join as Add me records it (self), so its members are told
    const row = db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'projects.update_joined'").all() as { actor_id: string; detail: string }[]
    expect(row).toHaveLength(1)
    expect(row[0]!.actor_id).toBe('dana')
    expect([...JSON.parse(row[0]!.detail).joined].sort()).toEqual([ids.sales, ids.ops, ids.finance, ids.left].sort())
    const gained = db.query("SELECT target, detail FROM audit_log WHERE action = 'project.member_gained' AND json_extract(detail, '$.userId') = 'dana'").all() as { target: string; detail: string }[]
    expect(gained.map((g) => g.target).sort()).toEqual([ids.sales, ids.ops, ids.finance, ids.left].sort())
    expect(gained.every((g) => JSON.parse(g.detail).self === true)).toBe(true)
    const inbox = await waitFor(async () => ((await raw('alice', 'GET', '/api/notifications')).json.items as { code: string; projectJoined?: { project?: { id: string } } }[])
      .find((n) => n.code === 'project.joined' && n.projectJoined?.project?.id === ids.sales) ?? null, { timeoutMs: 10_000 })
    expect(inbox).not.toBeNull()
    // the card is empty now
    expect(await card('dana')).toEqual([])
    // the task the pause turned off is on again; the one she changed since stays off
    expect(db.query('SELECT enabled, next_run_at IS NOT NULL AS due FROM schedules WHERE id = ?').get(taskOnSales)).toEqual({ enabled: 1, due: 1 })
    expect(db.query('SELECT enabled FROM schedules WHERE id = ?').get(taskOnOps)).toEqual({ enabled: 0 })
    const resumed = db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'schedule.resumed' AND target = ?").get(taskOnSales) as { actor_id: string | null; detail: string }
    expect(resumed.actor_id).toBeNull()
    expect(JSON.parse(resumed.detail)).toMatchObject({ via: 'project_member', project: ids.sales })
    // other admins: unchanged (frank is still not in Sales)
    expect(await reads('frank', 'projects/sales')).toBe(false)
  })

  test('a project whose members read it through a setting above it is not joined in one go: nobody is cut out', async () => {
    const db = h.ctx.db
    const root = h.ctx.files.fx.root
    // an older build's project folder with no settings of its own; everyone reads projects/ (a setting above it)
    fs.mkdirSync(path.join(root, 'projects', 'open'), { recursive: true })
    fs.writeFileSync(path.join(root, 'projects', 'open', 'plan.md'), `${SECRET}\n`)
    let top = db.query("SELECT id FROM folders WHERE path = 'projects'").get() as { id: string } | null
    if (!top) { top = { id: uuidv7() }; db.query("INSERT INTO folders (id, path, created_at) VALUES (?, 'projects', ?)").run(top.id, OLD) }
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by) VALUES (?, ?, 'everyone', NULL, 'read', 'carol')").run(uuidv7(), top.id)
    const openId = uuidv7()
    db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at, instructions_author, instructions_authored) VALUES (?, 'Open', 'projects/open', '', 'carol', ?, 'carol', '')").run(openId, OLD)
    expect(await reads('alice', 'projects/open')).toBe(true)
    expect(await card('dana')).toEqual(['Open'])
    const r = await raw('dana', 'POST', '/api/projects/update-notice/join')
    expect(r.json).toEqual({ joined: 0, skipped: 1 })
    // nothing saved: alice and bob still read it, dana does not, and the card still names it (Projects has its preview)
    expect(await reads('alice', 'projects/open')).toBe(true)
    expect(await reads('bob', 'projects/open')).toBe(true)
    expect(await opens('dana', openId)).toBe(false)
    expect(await card('dana')).toEqual(['Open'])
  })

  test('dismiss hides it for good and changes no access', async () => {
    expect((await raw('frank', 'POST', '/api/projects/update-notice/dismiss')).status).toBe(204)
    expect(await card('frank')).toEqual([])
    // Add me to these after the dismiss: nothing to join
    expect((await raw('frank', 'POST', '/api/projects/update-notice/join')).json).toEqual({ joined: 0, skipped: 0 })
    expect(await reads('frank', 'projects/sales')).toBe(false)
    // the projects stay in his Projects list, as not a member (Add me there still works)
    const listed = (await raw('frank', 'GET', '/api/projects?manage=1')).json.items as { id: string; member?: boolean }[]
    expect(listed.find((p) => p.id === ids.sales)?.member).toBe(false)
    // carol's card is hers alone: Finance and Open, and the fixture's leftover folders in projects/ that frank's Projects
    // list just made projects (no creator, their folders from before the update), never one she is in
    const carols = await card('carol')
    expect(carols).toEqual(expect.arrayContaining(['Finance', 'Open', 'atlas']))
    for (const name of ['Sales', 'Ops', 'Left', 'New']) expect(carols).not.toContain(name)
  })
})
