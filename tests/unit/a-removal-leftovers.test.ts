// What a deleted group or member leaves behind (docs/DECISIONS.md "What a deleted member or group leaves behind"):
// AI connection assignments (credentials/assignees.ts: removed, and a connection left with none is switched off, never
// team-wide), the profile of a deleted person, their own AI connections, the bookkeeping of the personal folder's
// transfer (team-files/service.ts archiveFolder), saving a connection that still names a deleted group, and
// migration 117 for what earlier builds left.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addCred } from '../lib/credentials'
import { WORK } from '../lib/env'
import { credentialsOf, getRow } from '../../server/src/credentials/store'
import { resolveCredential } from '../../server/src/credentials/resolve'
import { ALL_CREDENTIAL_KINDS } from '../../server/src/app-config'
import { MIGRATIONS_DIR, migrate, openDb, readMigrations } from '../../server/src/db'
import { saveAvatar } from '../../server/src/auth/profiles'

// people are made with password hashing and deletes re-check access across the team: slow on a busy machine
setDefaultTimeout(30_000)
const ALL = new Set(ALL_CREDENTIAL_KINDS)
const key = (n: string) => 'sk-ant-api03-' + n.padEnd(40, 'k')
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

let h: Harness, owner: Client
let admin: Awaited<ReturnType<typeof addMember>>
beforeAll(async () => {
  h = await harness('removal-leftovers')
  owner = await withOwner(h)
  admin = await addMember(h, owner, { username: 'adele', role: 'admin', password: 'admin horse battery 42' })
})
afterAll(async () => { await h?.close() })

const cc = () => credentialsOf(h.ctx)
const assignments = (id: string) => h.ctx.db.query('SELECT subject_type, subject_id FROM engine_credential_assignments WHERE credential_id = ? ORDER BY subject_type, subject_id').all(id)
const served = (userId: string) => resolveCredential(h.ctx.db, { userId, engine: 'claude-code', allowedKinds: ALL })
const audits = (target: string) => (h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'credential.update' AND target = ? ORDER BY id").all(target) as { actor_id: string | null; detail: string }[])
  .map((r) => ({ actor: r.actor_id, ...JSON.parse(r.detail) }))
const clearCreds = () => h.ctx.db.query('DELETE FROM engine_credentials').run()

describe('deleting a group', () => {
  test('a connection only for the group is switched off, not given to the whole team; the owner is told when an admin deleted', async () => {
    clearCreds()
    const m = await addMember(h, owner, { username: 'fin' })
    const other = await addMember(h, owner, { username: 'oscar' })
    const g = await owner.call('POST', '/api/admin/groups', { name: 'Finance', memberIds: [m.id] })
    const only = addCred(cc(), 'anthropic-api-key', key('only-finance'), { label: 'Finance key', assignments: [{ subjectType: 'group', subjectId: g.id }] })
    const shared = addCred(cc(), 'anthropic-api-key', key('finance-and-oscar'), { label: 'Shared key', assignments: [{ subjectType: 'group', subjectId: g.id }, { subjectType: 'user', subjectId: other.id }] })
    expect(served(m.id)).toMatchObject({ ok: true, credentialId: only })
    // nobody outside the group or the list is served by either
    expect(served(admin.id).ok).toBe(false)
    const ownerNotices = (h.ctx.db.query("SELECT COUNT(*) AS n FROM credential_change_notices WHERE action = 'disabled'").get() as { n: number }).n

    await admin.client.call('DELETE', `/api/admin/groups/${g.id}`)

    expect(assignments(only)).toEqual([])
    expect(getRow(h.ctx.db, only)!.disabled).toBe(1)
    expect(assignments(shared)).toEqual([{ subject_type: 'user', subject_id: other.id }])
    expect(getRow(h.ctx.db, shared)!.disabled).toBe(0)
    // never team-wide: the former member and anyone else get nothing from it, oscar keeps his
    expect(served(m.id).ok).toBe(false)
    expect(served(admin.id).ok).toBe(false)
    expect(served(other.id)).toMatchObject({ ok: true, credentialId: shared })
    // the Activity log: the group's line names the connection switched off, each connection has its own line
    const del = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'group.delete' AND target = ?").get(g.id) as { detail: string }
    expect(JSON.parse(del.detail).aiConnectionsOff).toEqual([{ id: only, label: 'Finance key' }])
    expect(audits(only).at(-1)).toMatchObject({ actor: admin.id, changed: ['disabled', 'assignments'], reason: 'assignees_deleted', assignmentsAfter: [] })
    expect(audits(shared).at(-1)).toMatchObject({ actor: admin.id, changed: ['assignments'], assignmentsAfter: [{ subjectType: 'user', subjectId: other.id }] })
    // an admin switched off a team connection: the owner is told, as for any admin's switch-off
    expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM credential_change_notices WHERE action = 'disabled' AND subject = 'Finance key'").get() as { n: number }).n).toBe(ownerNotices + 1)
    // the list shows it off and for nobody in particular; switching it on again is the owner's or an admin's choice
    const listed = (await owner.call('GET', '/api/admin/credentials')).items.find((c: any) => c.id === only)
    expect(listed).toMatchObject({ disabled: true, state: 'disabled', assignments: [] })
  })

  test('a team-wide connection and one already off are left as they are', async () => {
    clearCreds()
    const g = await owner.call('POST', '/api/admin/groups', { name: 'Ops' })
    const team = addCred(cc(), 'anthropic-api-key', key('team'), { label: 'Team key' })
    const off = addCred(cc(), 'anthropic-api-key', key('off'), { label: 'Off key', disabled: true, assignments: [{ subjectType: 'group', subjectId: g.id }] })
    await owner.call('DELETE', `/api/admin/groups/${g.id}`)
    expect(getRow(h.ctx.db, team)!.disabled).toBe(0)
    expect(getRow(h.ctx.db, off)!.disabled).toBe(1)
    expect(assignments(off)).toEqual([])
    expect(audits(team)).toEqual([])
    expect(audits(off).at(-1)).toMatchObject({ changed: ['assignments'] })
    const del = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'group.delete' AND target = ?").get(g.id) as { detail: string }
    expect(JSON.parse(del.detail).aiConnectionsOff).toBeUndefined()
  })
})

describe('a connection switched off because everyone it was for was deleted', () => {
  test('is marked, says why, and is not switched on by the bare switch; choosing who uses it clears the mark', async () => {
    clearCreds()
    const g = await owner.call('POST', '/api/admin/groups', { name: 'Gone soon' })
    const g2 = await owner.call('POST', '/api/admin/groups', { name: 'Stays' })
    const on = addCred(cc(), 'anthropic-api-key', key('was-on'), { label: 'Was on', assignments: [{ subjectType: 'group', subjectId: g.id }] })
    const off = addCred(cc(), 'anthropic-api-key', key('was-off'), { label: 'Was off', disabled: true, assignments: [{ subjectType: 'group', subjectId: g.id }] })
    await owner.call('DELETE', `/api/admin/groups/${g.id}`)
    const listed = (await admin.client.call('GET', '/api/admin/credentials')).items
    for (const id of [on, off]) {
      expect(listed.find((c: any) => c.id === id)).toMatchObject({ disabled: true, state: 'disabled', assignments: [], detail: expect.stringContaining('대상') })
      // the row's 켜기 (only `disabled`): refused for the owner and an admin alike, nothing changes
      for (const who of [owner, admin.client]) {
        const r = await who.try('PATCH', `/api/admin/credentials/${id}`, { disabled: false })
        expect(r.status).toBe(409)
        expect(r.body.error.params).toMatchObject({ reason: 'assignees_gone' })
      }
      expect(getRow(h.ctx.db, id)!.disabled).toBe(1)
    }
    // the edit dialog's save of a rename or a limit (it always sends its list, here the empty "팀 전체" it opens with)
    // is no choice: the mark stays and the switch is still refused
    await owner.call('PATCH', `/api/admin/credentials/${on}`, { label: 'Was on 2' })
    await owner.call('PATCH', `/api/admin/credentials/${on}`, { label: 'Was on 2b', assignments: [], spendLimit: { usd: 5, tokens: null, action: 'block' } })
    expect(JSON.parse(getRow(h.ctx.db, on)!.meta).assigneesGone).toBe(true)
    expect((await owner.try('PATCH', `/api/admin/credentials/${on}`, { disabled: false })).status).toBe(409)
    // a group picked: the mark goes, and the switch works
    await owner.call('PATCH', `/api/admin/credentials/${on}`, { label: 'Was on 3', assignments: [{ subjectType: 'group', subjectId: g2.id }] })
    expect(await owner.call('PATCH', `/api/admin/credentials/${on}`, { disabled: false })).toMatchObject({ disabled: false, detail: null, assignments: [{ subjectId: g2.id }] })
    // the whole team is a choice too when it is made on purpose: sent together with the switch (never the dialog's save)
    expect(await owner.call('PATCH', `/api/admin/credentials/${off}`, { disabled: false, assignments: [] })).toMatchObject({ disabled: false, assignments: [] })
    expect(JSON.parse(getRow(h.ctx.db, off)!.meta).assigneesGone).toBeUndefined()
  })

  test('a person who is disabled, not deleted, keeps their assignments everywhere', async () => {
    clearCreds()
    const d = await addMember(h, owner, { username: 'dora' })
    await owner.call('PATCH', `/api/admin/users/${d.id}`, { status: 'disabled' })
    const g = await owner.call('POST', '/api/admin/groups', { name: 'Doomed' })
    const id = addCred(cc(), 'anthropic-api-key', key('dora'), { label: 'Dora', assignments: [{ subjectType: 'user', subjectId: d.id }, { subjectType: 'group', subjectId: g.id }] })
    // a delete prunes every dead row in the team: dora's is not dead
    await owner.call('DELETE', `/api/admin/groups/${g.id}`)
    expect(assignments(id)).toEqual([{ subject_type: 'user', subject_id: d.id }])
    expect(getRow(h.ctx.db, id)!.disabled).toBe(0)
    // and a save keeps her
    expect(await owner.call('PATCH', `/api/admin/credentials/${id}`, { label: 'Dora 2', assignments: [{ subjectType: 'user', subjectId: d.id }] })).toMatchObject({ disabled: false, assignments: [{ subjectId: d.id }] })
  })
})

describe('saving a connection that names a group or person that is gone', () => {
  test('the dead id is dropped; when nothing sent is left the connection is switched off, never team-wide', async () => {
    clearCreds()
    const live = await owner.call('POST', '/api/admin/groups', { name: 'Live' })
    const both = addCred(cc(), 'anthropic-api-key', key('both'), { label: 'Both', assignments: [{ subjectType: 'group', subjectId: live.id }] })
    const dead = addCred(cc(), 'anthropic-api-key', key('dead'), { label: 'Dead' })
    // rows an older build left: a group deleted without its assignment, a person deleted without theirs
    const gone = crypto.randomUUID()
    h.ctx.db.query("INSERT INTO engine_credential_assignments (credential_id, subject_type, subject_id) VALUES (?, 'group', ?)").run(both, gone)
    h.ctx.db.query("INSERT INTO engine_credential_assignments (credential_id, subject_type, subject_id) VALUES (?, 'group', ?), (?, 'user', 'nobody-here')").run(dead, gone, dead)
    // the dialog sends its whole form back, the dead ids with it: the save works and keeps the live group
    const a = await owner.call('PATCH', `/api/admin/credentials/${both}`, { label: 'Both 2', assignments: [{ subjectType: 'group', subjectId: live.id }, { subjectType: 'group', subjectId: gone }] })
    expect(a).toMatchObject({ label: 'Both 2', disabled: false, assignments: [{ subjectType: 'group', subjectId: live.id }] })
    // only dead ids: the rename works and the connection is switched off instead of serving everyone
    const b = await admin.client.call('PATCH', `/api/admin/credentials/${dead}`, { label: 'Dead 2', assignments: [{ subjectType: 'group', subjectId: gone }, { subjectType: 'user', subjectId: 'nobody-here' }] })
    expect(b).toMatchObject({ label: 'Dead 2', disabled: true, state: 'disabled', assignments: [] })
    expect(served(admin.id).ok).toBe(false)
    expect(audits(dead).at(-1)).toMatchObject({ actor: admin.id, reason: 'assignees_deleted', assigneesGone: 2 })
    // even when the request says "on"
    h.ctx.db.query('UPDATE engine_credentials SET disabled = 0 WHERE id = ?').run(dead)
    h.ctx.db.query("INSERT INTO engine_credential_assignments (credential_id, subject_type, subject_id) VALUES (?, 'group', ?)").run(dead, gone)
    const c = await owner.call('PATCH', `/api/admin/credentials/${dead}`, { disabled: false, assignments: [{ subjectType: 'group', subjectId: gone }] })
    expect(c).toMatchObject({ disabled: true, assignments: [] })
    // an empty list is still the explicit choice "the whole team"
    expect(await owner.call('PATCH', `/api/admin/credentials/${both}`, { assignments: [] })).toMatchObject({ disabled: false, assignments: [] })
  })
})

describe('deleting a member', () => {
  test('their profile, their own AI connections and their assignments go; a connection only for them is switched off', async () => {
    clearCreds()
    const m = await addMember(h, owner, { username: 'pia' })
    await m.client.call('PATCH', '/api/me/profile', { title: 'Accountant', status: 'On leave' })
    h.ctx.db.query('UPDATE user_profiles SET avatar = ?, avatar_type = ?, avatar_version = ? WHERE user_id = ?').run(new Uint8Array([1, 2, 3]), 'image/png', 1, m.id)
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM user_profiles WHERE user_id = ?').get(m.id)).toEqual({ n: 1 })
    const own = addCred(cc(), 'anthropic-api-key', key('pia-own'), { label: 'Pia own', owner: m.id })
    const forPia = addCred(cc(), 'anthropic-api-key', key('pia-team'), { label: 'Pia team', assignments: [{ subjectType: 'user', subjectId: m.id }] })
    await admin.client.call('DELETE', `/api/admin/users/${m.id}`, { password: 'admin horse battery 42' })
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM user_profiles WHERE user_id = ?').get(m.id)).toEqual({ n: 0 })
    expect(getRow(h.ctx.db, own)).toBeNull()
    expect(assignments(forPia)).toEqual([])
    expect(getRow(h.ctx.db, forPia)!.disabled).toBe(1)
    expect(served(admin.id).ok).toBe(false)
    const del = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'user.delete' AND target = ?").get(m.id) as { detail: string }
    expect(JSON.parse(del.detail)).toMatchObject({ aiConnectionsOff: [{ id: forPia, label: 'Pia team' }], ownAiConnections: 1 })
    // nothing of them in the people list or the photo address
    expect((await owner.call('GET', '/api/people')).people.some((p: any) => p.id === m.id)).toBe(false)
    expect((await owner.try('GET', `/api/people/${m.id}/avatar`)).status).toBe(404)
  })

  test('transfer: history, projects and file events follow the personal folder into the owner\'s archive', async () => {
    const m = await addMember(h, owner, { username: 'tom' })
    const ownerId = (await owner.call('GET', '/api/me')).user.id
    const file = `users/${m.id}/notes.md`
    await m.client.call('PUT', '/api/files/content', { path: file, content: 'one', baseSha256: null })
    await m.client.call('PUT', '/api/files/content', { path: file, content: 'two', baseSha256: sha('one') })
    const project = await m.client.call('POST', '/api/projects', { name: 'Plan', scope: 'personal' })
    expect(project.folderPath.startsWith(`users/${m.id}/`)).toBe(true)
    const before = (h.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(file) as { n: number }).n
    expect(before).toBeGreaterThan(0)

    await owner.call('DELETE', `/api/admin/users/${m.id}`)

    const archive = `users/${ownerId}/보관된 계정/${m.id}`
    expect(fs.readFileSync(path.join(h.ctx.files.fx.root, archive, 'notes.md'), 'utf8')).toBe('two')
    // the version history moved with the file (numbering continues there). As after any move out of a personal
    // folder, a version saved where only the member could read stays theirs: the owner's history lists none of them
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(file)).toEqual({ n: 0 })
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(`${archive}/notes.md`)).toEqual({ n: before })
    const history = await owner.call('GET', `/api/files/history?path=${encodeURIComponent(`${archive}/notes.md`)}`)
    expect(history.items).toEqual([])
    // the project follows its folder
    const p = h.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(project.id) as { folder_path: string }
    expect(p.folder_path).toBe(archive + project.folderPath.slice(`users/${m.id}`.length))
    // the file events say where it went, by whom
    const ev = h.ctx.db.query("SELECT user_id, action, detail FROM file_events WHERE path = ? AND action = 'create' ORDER BY id DESC LIMIT 1").get(archive) as { user_id: string; detail: string }
    expect(ev.user_id).toBe(ownerId)
    expect(JSON.parse(ev.detail)).toMatchObject({ movedFrom: `users/${m.id}`, folder: true, tool: 'member-delete' })
    const del = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'user.delete' AND target = ?").get(m.id) as { detail: string }
    expect(JSON.parse(del.detail)).toMatchObject({ personalFolder: 'transfer', movedTo: archive })
  })
})

describe('the transfer\'s archive name and a photo upload during the delete', () => {
  test('a name an earlier archive left in the database is skipped; a photo saved after the delete is refused', async () => {
    const m = await addMember(h, owner, { username: 'ula' })
    const ownerId = (await owner.call('GET', '/api/me')).user.id
    // a folders row an earlier archive left at users/<owner>/보관된 계정/<id> (its folder gone from disk)
    h.ctx.db.query("INSERT INTO folders (id, path) VALUES (?, ?)").run(crypto.randomUUID(), `users/${ownerId}/보관된 계정/${m.id}`)
    fs.writeFileSync(path.join(h.ctx.files.fx.root, 'users', m.id, 'a.md'), 'a')
    await owner.call('DELETE', `/api/admin/users/${m.id}`)
    expect(fs.readFileSync(path.join(h.ctx.files.fx.root, 'users', ownerId, '보관된 계정', `${m.id}-2`, 'a.md'), 'utf8')).toBe('a')
    const del = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'user.delete' AND target = ?").get(m.id) as { detail: string }
    expect(JSON.parse(del.detail)).toMatchObject({ movedTo: `users/${ownerId}/보관된 계정/${m.id}-2` })
    expect(JSON.parse(del.detail).folderError).toBeUndefined()
    // an upload that was still being read when the account was deleted
    const body = (async function* () { yield new Uint8Array([1]) })()
    await expect(saveAvatar(h.ctx.db, m.id, body, 'image/png', 'en')).rejects.toMatchObject({ code: 'unauthorized' })
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM user_profiles WHERE user_id = ?').get(m.id)).toEqual({ n: 0 })
  })
})

describe('migration 117', () => {
  test('profiles and own connections of people already deleted go; dead assignments go, and a connection left with none is switched off', () => {
    const dir = path.join(WORK, 'removal-leftovers-migrate'), part = path.join(dir, 'before')
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(part, { recursive: true })
    for (const m of readMigrations().filter((m) => m.version !== 117)) fs.copyFileSync(path.join(MIGRATIONS_DIR, m.name), path.join(part, m.name))
    const db = openDb(path.join(dir, 'app.db'), { migrationsDir: part })
    try {
      db.query("INSERT INTO users (id, username, name, role) VALUES ('ann','ann','Ann','member'), ('bo','bo#deleted-1','Bo','member'), ('cy','cy','Cy','member')").run()
      db.query("UPDATE users SET status = 'disabled' WHERE id = 'cy'").run()
      db.query("UPDATE users SET deleted_at = '2026-10-01T00:00:00.000Z', status = 'disabled' WHERE id = 'bo'").run()
      db.query("INSERT INTO groups (id, name) VALUES ('g-live', 'Live')").run()
      db.query("INSERT INTO user_profiles (user_id, title) VALUES ('ann', 'Lead'), ('bo', 'Gone')").run()
      const cred = (id: string, owner: string | null, disabled = 0) => db.query(`INSERT INTO engine_credentials (id, kind, label, owner_user_id, disabled, secret_enc, fingerprint)
        VALUES (?, 'anthropic-api-key', ?, ?, ?, 'x', ?)`).run(id, id, owner, disabled, id)
      cred('bo-own', 'bo'); cred('ann-own', 'ann'); cred('only-dead', null); cred('mixed', null); cred('team', null); cred('off-dead', null, 1); cred('for-cy', null)
      const asg = db.query('INSERT INTO engine_credential_assignments (credential_id, subject_type, subject_id) VALUES (?, ?, ?)')
      asg.run('only-dead', 'group', 'g-gone'); asg.run('only-dead', 'user', 'bo')
      asg.run('mixed', 'group', 'g-gone'); asg.run('mixed', 'group', 'g-live'); asg.run('mixed', 'user', 'ann')
      asg.run('off-dead', 'user', 'bo')
      asg.run('for-cy', 'user', 'cy')

      migrate(db, { backupDir: path.join(dir, 'backups') })

      expect(db.query('SELECT user_id FROM user_profiles ORDER BY user_id').all()).toEqual([{ user_id: 'ann' }])
      expect(db.query("SELECT id, disabled, json_extract(meta, '$.assigneesGone') AS gone FROM engine_credentials ORDER BY id").all()).toEqual([
        { id: 'ann-own', disabled: 0, gone: null }, { id: 'for-cy', disabled: 0, gone: null }, { id: 'mixed', disabled: 0, gone: null },
        { id: 'off-dead', disabled: 1, gone: 1 }, { id: 'only-dead', disabled: 1, gone: 1 }, { id: 'team', disabled: 0, gone: null },
      ])
      // a disabled person is not a deleted one: their row stays
      expect(db.query('SELECT credential_id, subject_type, subject_id FROM engine_credential_assignments ORDER BY credential_id, subject_type, subject_id').all()).toEqual([
        { credential_id: 'for-cy', subject_type: 'user', subject_id: 'cy' },
        { credential_id: 'mixed', subject_type: 'group', subject_id: 'g-live' }, { credential_id: 'mixed', subject_type: 'user', subject_id: 'ann' },
      ])
      // the switched-off connection still serves nobody: not the whole team
      expect(resolveCredential(db, { userId: 'ann', engine: 'claude-code', allowedKinds: ALL })).toMatchObject({ ok: true, credentialId: 'ann-own' })
      db.query("DELETE FROM engine_credentials WHERE id IN ('ann-own', 'team', 'for-cy')").run()
      expect(resolveCredential(db, { userId: 'ann', engine: 'claude-code', allowedKinds: ALL })).toMatchObject({ ok: true, credentialId: 'mixed' })
      db.query("DELETE FROM engine_credentials WHERE id = 'mixed'").run()
      expect(resolveCredential(db, { userId: 'ann', engine: 'claude-code', allowedKinds: ALL }).ok).toBe(false)
      // one Activity log line for each connection changed, with no actor
      const lines = (db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'credential.update' ORDER BY target").all() as { actor_id: string | null; target: string; detail: string }[])
        .map((r) => ({ actor: r.actor_id, target: r.target, ...JSON.parse(r.detail) }))
      expect(lines.map((l) => [l.target, l.changed])).toEqual([['mixed', ['assignments']], ['off-dead', ['assignments']], ['only-dead', ['disabled', 'assignments']]])
      expect(lines.every((l) => l.actor === null && l.reason === 'assignees_deleted')).toBe(true)
      expect(lines.find((l) => l.target === 'only-dead').assignmentsAfter).toEqual([])
      expect(lines.find((l) => l.target === 'mixed').assignmentsAfter).toHaveLength(2)
    } finally { db.close() }
  })
})

