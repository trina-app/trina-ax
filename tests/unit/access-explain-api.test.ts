// Admin > Folder permissions, "why": GET /api/admin/access/folder, GET /api/admin/access/people/:id and
// POST /api/admin/access/new-person (server/src/admin/access-explain.ts). Every answer must be the permission
// function's own answer (RuleSet.access, and canList for "shown in the tree"), and nothing under users/ other than
// the person's own folder row, nothing in .system/ and no temp name may show.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { FolderAccessResponse, PersonAccessResponse } from '@mycel/shared/api'
import { AUTH_MESSAGES } from '../../server/src/auth/messages'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { legacyProject, legacyProjectFolder } from '../lib/legacy-project'

let h: Harness
let owner: Client
let admin: Client
let alice: { client: Client; id: string }
let sales: string
let ops: string
const rule = (subjectType: 'everyone' | 'role' | 'group' | 'user', subjectId: string | null, access: 'none' | 'read' | 'write') => ({ subjectType, subjectId, access })
const segs = (p: string) => (p === '' ? [] : p.split('/'))
/** the permission function's own answers for a person now */
const accessOf = (id: string, p: string) => h.ctx.files.rules().access(h.ctx.files.principal(id), segs(p))
const canList = (id: string, p: string) => h.ctx.files.rules().canList(h.ctx.files.principal(id), segs(p))
const folderAnswer = async (p: string, extra = '') => FolderAccessResponse.parse(await admin.call('GET', `/api/admin/access/folder?path=${encodeURIComponent(p)}${extra}`))
const personAnswer = async (id: string, extra = '') => PersonAccessResponse.parse(await admin.call('GET', `/api/admin/access/people/${id}?limit=2000${extra}`))

beforeAll(async () => {
  h = await harness('access-explain')
  owner = await withOwner(h)
  admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  ops = (await admin.call('POST', '/api/admin/groups', { name: 'Ops' })).id
  alice = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
  await addMember(h, owner, { username: 'bob' })
  await addMember(h, owner, { username: 'carl', groupIds: [sales] })
  await addMember(h, owner, { username: 'dora', groupIds: [sales] }) // like alice, without person rules
  await addMember(h, owner, { username: 'erik' }) // no group, no person rule
  // the project's rules as builds before "Project contents only for members" let an admin set them (Admin › Folder
  // permissions refuses every path at or under projects/<name> now: tests/lib/legacy-project.ts)
  legacyProjectFolder(h.ctx.db, h.ctx.files.fx.root, 'projects/apollo', [rule('user', 'alice', 'write'), rule('group', sales, 'read'), rule('user', 'carl', 'write'), rule('everyone', null, 'none')], 'adam')
  legacyProjectFolder(h.ctx.db, h.ctx.files.fx.root, 'projects/apollo/drafts', [rule('user', 'bob', 'write')], 'adam')
  legacyProjectFolder(h.ctx.db, h.ctx.files.fx.root, 'projects/apollo/closed', [rule('everyone', null, 'none')], 'adam')
  await admin.call('POST', '/api/admin/folders', { path: 'skills/finance', rules: [rule('everyone', null, 'none'), rule('group', ops, 'read')] })
  // a team project, and alice's personal project and file (their names must never reach an admin)
  // made as builds before "Projects live only in projects/" made them on existing folders (tests/lib/legacy-project.ts)
  legacyProject(h.ctx.db, h.ctx.files.fx.root, alice.id, { name: 'Apollo', folderPath: 'projects/apollo' })
  legacyProject(h.ctx.db, h.ctx.files.fx.root, alice.id, { name: 'Alice-private-plan-7c1', folderPath: `users/${alice.id}` })
  fs.writeFileSync(path.join(h.ctx.files.fx.root, 'users', 'alice', 'Alice-secret-name-3e9.md'), 'x')
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'users', 'alice', 'Alice-private-folder-5d2'), { recursive: true })
  fs.writeFileSync(path.join(h.ctx.files.fx.root, 'shared', 'plain-file.md'), 'x')
  // a connected folder (adding one needs the owner's password and a real source: the row is enough here)
  h.ctx.db.query('INSERT INTO connected_folders (id, name, source) VALUES (?, ?, ?)').run('00000000-0000-7000-8000-00000000c0de', 'nas', '/Volumes/nas')
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'connected', 'nas'), { recursive: true })
  // a rule folder that went to the trash: its rules are parked under .system/trash
  await admin.call('POST', '/api/admin/folders', { path: 'shared/old-team-4b8', rules: [rule('user', 'alice', 'write')] })
  await owner.call('DELETE', `/api/files?path=${encodeURIComponent('shared/old-team-4b8')}`)
  // carl is switched off
  await owner.call('PATCH', '/api/admin/users/carl', { status: 'disabled' })
})
afterAll(() => h.close())

describe('one folder: every active person, the folder and rule it comes from', () => {
  test('projects/apollo', async () => {
    const r = await folderAnswer('projects/apollo')
    expect(r).toMatchObject({ path: 'projects/apollo', exists: true, ruleFolder: 'projects/apollo', total: 6, nextCursor: null })
    const by = Object.fromEntries(r.people.map((p) => [p.user.id, p]))
    expect(Object.keys(by).sort()).toEqual(['adam', 'alice', 'bob', 'dora', 'erik', 'olga']) // carl is switched off
    // the owner and admins are judged as members inside a team project (docs/DECISIONS.md "Project contents only for
    // members"): no rule names them, so everyone:none decides, and nothing below is open to them
    const asMember = { access: 'none', reason: { kind: 'rule', folder: 'projects/apollo', tier: 'everyone', rules: [rule('everyone', null, 'none')] }, listable: false, via: [] }
    expect(by.olga!).toMatchObject(asMember)
    expect(by.adam!).toMatchObject(asMember)
    expect(by.alice!).toMatchObject({ access: 'write', reason: { kind: 'rule', folder: 'projects/apollo', tier: 'user', rules: [rule('user', 'alice', 'write')] } })
    expect(by.dora!).toMatchObject({ access: 'read', reason: { kind: 'rule', folder: 'projects/apollo', tier: 'group', rules: [rule('group', sales, 'read')] } })
    // bob may not read apollo, but its drafts: apollo shows in his tree; the folder inside is never named
    expect(by.bob!).toMatchObject({ access: 'none', reason: { kind: 'rule', folder: 'projects/apollo', tier: 'everyone' }, listable: true, via: [], viaMore: false })
    expect(by.erik!).toMatchObject({ access: 'none', listable: false, via: [] })
    for (const p of r.people) {
      expect(p.access, p.user.id).toBe(accessOf(p.user.id, 'projects/apollo'))
      expect(p.listable, p.user.id).toBe(canList(p.user.id, 'projects/apollo'))
    }
    expect(r.summary.access).toEqual({ none: 4, read: 1, write: 1 })
    expect(r.summary.sources).toEqual([{ reason: 'rule', folder: 'projects/apollo', count: 6 }])
    expect(JSON.stringify(r)).not.toContain('drafts')
  })

  test('a folder only for navigation: projects shows for those who read something below', async () => {
    const r = await folderAnswer('projects')
    const by = Object.fromEntries(r.people.map((p) => [p.user.id, p]))
    expect(by.alice!).toMatchObject({ access: 'none', reason: { kind: 'no-rule' }, listable: true, via: ['projects/apollo'] })
    // bob reads only a folder inside apollo: projects/ shows for him, the folder is not named
    expect(by.bob!).toMatchObject({ access: 'none', listable: true, via: [] })
    expect(by.erik!).toMatchObject({ access: 'none', listable: false, via: [] })
    // projects/ itself is outside the members-only zone: the owner and admins as before
    expect(by.olga!).toMatchObject({ access: 'write', reason: { kind: 'owner-admin' } })
    expect(by.adam!).toMatchObject({ access: 'write', reason: { kind: 'owner-admin' } })
    for (const p of r.people) expect(p.listable, p.user.id).toBe(canList(p.user.id, 'projects'))
    expect(JSON.stringify(r)).not.toContain('drafts')
  })

  test('someone switched off: what they would get here if switched back on, not the rule that names them', async () => {
    const apollo = await folderAnswer('projects/apollo')
    expect(apollo.inactive).toMatchObject([{ user: { id: 'carl' }, access: 'write', reason: { kind: 'rule', folder: 'projects/apollo', tier: 'user' } }])
    // carl:write on projects/apollo, everyone:none on projects/apollo/closed: a folder inside a team project has no folder
    // answer and no row in a person answer any more (docs/DECISIONS.md "Project contents only for members")
    expect((await admin.try('GET', `/api/admin/access/folder?path=${encodeURIComponent('projects/apollo/closed')}`)).status).toBe(400)
    expect((await personAnswer('carl')).folders.find((f) => f.path === 'projects/apollo/closed')).toBeUndefined()
    // the same case in a team folder: carl:write above, everyone:none below; switched back on, carl gets none there
    const top = await admin.call('POST', '/api/admin/folders', { path: 'shared/carl-team-1d4', rules: [rule('user', 'carl', 'write')] })
    const below = await admin.call('POST', '/api/admin/folders', { path: 'shared/carl-team-1d4/closed', rules: [rule('everyone', null, 'none')] })
    try {
      const closed = await folderAnswer('shared/carl-team-1d4/closed')
      expect(closed.people.some((p) => p.user.id === 'carl')).toBe(false)
      expect(closed.inactive).toEqual([{ user: { id: 'carl', name: 'CARL' }, role: 'member', access: 'none',
        reason: { kind: 'rule', folder: 'shared/carl-team-1d4/closed', tier: 'everyone', rules: [rule('everyone', null, 'none')] }, rules: [{ folder: 'shared/carl-team-1d4', access: 'write' }] }])
      // the same as the person answer for carl, which is computed as if active
      const carl = await personAnswer('carl')
      expect(carl.folders.find((f) => f.path === 'shared/carl-team-1d4/closed')).toMatchObject({ access: 'none' })
    } finally {
      await admin.call('DELETE', `/api/admin/folders/${below.id}`)
      await admin.call('DELETE', `/api/admin/folders/${top.id}`)
      fs.rmSync(path.join(h.ctx.files.fx.root, 'shared', 'carl-team-1d4'), { recursive: true, force: true })
    }
  })

  test('a folder without rules answers from the nearest folder with rules; a missing one too; a file is not a folder', async () => {
    const r = await folderAnswer('skills/finance/not-yet')
    expect(r).toMatchObject({ path: 'skills/finance/not-yet', exists: false, ruleFolder: 'skills/finance' })
    const by = Object.fromEntries(r.people.map((p) => [p.user.id, p]))
    expect(by.erik!).toMatchObject({ access: 'none', reason: { kind: 'rule', folder: 'skills/finance', tier: 'everyone' } })
    expect(by.adam!).toMatchObject({ access: 'write', reason: { kind: 'owner-admin' } })
    for (const p of r.people) expect(p.access).toBe(accessOf(p.user.id, 'skills/finance/not-yet'))
    // inside a team project: no answer, the same one for a missing folder and one that is there
    for (const inside of ['projects/apollo/drafts/not-yet', 'projects/apollo/drafts']) expect((await admin.try('GET', `/api/admin/access/folder?path=${encodeURIComponent(inside)}`)).status, inside).toBe(400)
    expect(await folderAnswer('shared/plain-file.md')).toMatchObject({ exists: false, ruleFolder: 'shared' })
    expect(await folderAnswer('shared')).toMatchObject({ exists: true })
    const top = FolderAccessResponse.parse(await admin.call('GET', '/api/admin/access/folder'))
    expect(top).toMatchObject({ path: '', ruleFolder: null })
    expect(top.people.find((p) => p.user.id === 'erik')).toMatchObject({ access: 'none', reason: { kind: 'no-rule' }, listable: true }) // shared/ below
    if (h.ctx.files.fx.caseInsensitive) expect((await folderAnswer('PROJECTS/Apollo')).path).toBe('projects/apollo')
  })

  test('people in pages: by name, every one once, the summary over everyone', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const r: FolderAccessResponse = await folderAnswer('projects/apollo', `&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      expect(r.total).toBe(6)
      expect(r.summary.access).toEqual({ none: 4, read: 1, write: 1 })
      seen.push(...r.people.map((p) => p.user.id))
      cursor = r.nextCursor
    } while (cursor)
    expect(seen).toEqual((await folderAnswer('projects/apollo')).people.map((p) => p.user.id))
    expect(seen).toEqual(['adam', 'alice', 'bob', 'dora', 'erik', 'olga'])
    expect((await admin.try('GET', '/api/admin/access/folder?path=shared&cursor=x')).status).toBe(400)
    expect((await admin.try('GET', '/api/admin/access/folder?path=shared&limit=2001')).status).toBe(400)
  })

  test('never users/, .system/, temp names or paths outside the team folder; members are refused', async () => {
    const personal = Object.values(AUTH_MESSAGES.accessPersonalFolder) as string[]
    const notTeam = Object.values(AUTH_MESSAGES.accessNotTeamFolder) as string[]
    for (const bad of ['users', 'users/alice', 'users/alice/Alice-secret-name-3e9.md', 'USERS/alice', 'Users']) {
      const r = await admin.try('GET', `/api/admin/access/folder?path=${encodeURIComponent(bad)}`)
      expect(r.status, bad).toBe(400)
      expect(personal, bad).toContain(r.body.error.message)
      expect(JSON.stringify(r.body)).not.toContain('Alice-secret-name')
    }
    for (const bad of ['.system', '.system/trash', '.SYSTEM', 'shared/.mycel-tmp-1', '.mycel-tmp-1', 'ｕｓｅｒｓ/x', 'shared/CON']) {
      const r = await admin.try('GET', `/api/admin/access/folder?path=${encodeURIComponent(bad)}`)
      expect(r.status, bad).toBe(400)
      expect(notTeam, bad).toContain(r.body.error.message)
    }
    // nothing inside a team project (docs/DECISIONS.md "Project contents only for members"), any letter case, there or
    // not: one answer, which names nothing
    const answers = new Set<string>()
    for (const inside of ['projects/apollo/drafts', 'projects/apollo/closed', 'PROJECTS/Apollo/drafts', 'projects/apollo/not-there-6b1', 'projects/no-such-8c3/x']) {
      const r = await admin.try('GET', `/api/admin/access/folder?path=${encodeURIComponent(inside)}`)
      expect(r.status, inside).toBe(400)
      expect(notTeam, inside).toContain(r.body.error.message)
      answers.add(JSON.stringify({ ...r.body.error, requestId: undefined }))
    }
    expect(answers.size).toBe(1)
    // not even a relative path: the contract (RelPath) refuses it before the route
    for (const bad of ['../etc', '/etc', 'shared/../users/alice']) expect((await admin.try('GET', `/api/admin/access/folder?path=${encodeURIComponent(bad)}`)).status, bad).toBe(400)
    expect((await alice.client.try('GET', '/api/admin/access/folder?path=shared')).status).toBe(403)
    expect((await alice.client.try('GET', '/api/admin/access/people/alice')).status).toBe(403)
    expect((await alice.client.try('POST', '/api/admin/access/new-person', { role: 'member', groupIds: [] })).status).toBe(403)
    expect((await h.client().try('GET', '/api/admin/access/folder?path=shared')).status).toBe(401)
  })
})

describe('one person: every team folder and why', () => {
  test('alice: own folder from the member list, team folders by kind, nothing else of users/ or .system/', async () => {
    const res = await admin.call('GET', '/api/admin/access/people/alice?limit=2000')
    const r = PersonAccessResponse.parse(res)
    expect(r).toMatchObject({ user: { id: 'alice', name: 'ALICE' }, role: 'member', status: 'active', groups: [{ id: sales, name: 'Sales' }], nextCursor: null })
    expect(r.total).toBe(r.folders.length)
    expect(r.folders.map((f) => f.path)).toEqual([...r.folders.map((f) => f.path)].sort((a, b) => (a < b ? -1 : 1)))
    const text = JSON.stringify(res)
    // the trashed folder's rules are there, parked under .system/trash/<month>/<id>: they must not show
    expect(h.ctx.files.rules().ruleFolders().some((f) => f.startsWith('.system/trash/'))).toBe(true)
    for (const hidden of ['Alice-private-plan-7c1', 'Alice-secret-name-3e9', 'Alice-private-folder-5d2', 'old-team-4b8', '.system', '.mycel-tmp']) expect(text, hidden).not.toContain(hidden)
    expect(r.folders.filter((f) => f.path.startsWith('users')).map((f) => f.path)).toEqual(['users/alice'])
    const by = Object.fromEntries(r.folders.map((f) => [f.path, f]))
    expect(by['users/alice']).toEqual({ path: 'users/alice', kinds: ['personal'], exists: null, access: 'write', reason: { kind: 'own-personal' }, listable: true, via: [], viaMore: false })
    expect(by['projects/apollo']).toMatchObject({ kinds: ['rules', 'project'], projects: [{ name: 'Apollo' }], exists: true, access: 'write', reason: { kind: 'rule', tier: 'user' } })
    expect(by['projects']).toMatchObject({ kinds: ['top'], access: 'none', listable: true, via: ['projects/apollo'] })
    expect(by['groups/Sales']).toMatchObject({ kinds: ['rules', 'group'], group: { id: sales, name: 'Sales' }, access: 'write', reason: { kind: 'rule', folder: 'groups/Sales', tier: 'group' } })
    expect(by['groups']).toMatchObject({ kinds: ['top'], access: 'none', listable: true, via: ['groups/Sales'] })
    expect(by['groups/Ops']).toMatchObject({ access: 'none', reason: { kind: 'no-rule' }, listable: false })
    expect(by['connected/nas']).toMatchObject({ kinds: ['connected'], connected: { name: 'nas' }, exists: true })
    expect(by['skills']!.kinds.sort()).toEqual(['rules', 'top'])
    expect(by['skills/finance']).toMatchObject({ access: 'none', reason: { kind: 'rule', folder: 'skills/finance', tier: 'everyone' }, listable: false })
    expect(by['shared']).toMatchObject({ access: 'write', reason: { kind: 'rule', folder: 'shared', tier: 'everyone' } })
    // every row is the permission function's answer, and "shown in the tree" is canList
    for (const f of r.folders) {
      expect(f.access, f.path).toBe(accessOf('alice', f.path))
      expect(f.listable, f.path).toBe(canList('alice', f.path))
    }
  })

  test('pages by path and a part of the tree (prefix): every row once, in order', async () => {
    const full = await personAnswer('alice')
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const r: PersonAccessResponse = PersonAccessResponse.parse(await admin.call('GET', `/api/admin/access/people/alice?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))
      expect(r.total).toBe(full.total)
      expect(r.folders.length).toBeLessThanOrEqual(3)
      seen.push(...r.folders.map((f) => f.path))
      cursor = r.nextCursor
    } while (cursor)
    expect(seen).toEqual(full.folders.map((f) => f.path))
    // nothing inside a team project is a row (its rule folders drafts and closed are not named)
    const part = PersonAccessResponse.parse(await admin.call('GET', '/api/admin/access/people/alice?prefix=projects'))
    expect(part.folders.map((f) => f.path)).toEqual(['projects', 'projects/apollo'])
    expect(part).toMatchObject({ total: 2, nextCursor: null })
    const own = PersonAccessResponse.parse(await admin.call('GET', '/api/admin/access/people/alice?prefix=users'))
    expect(own.folders.map((f) => f.path)).toEqual(['users/alice'])
    // the default page is 500 rows
    expect(PersonAccessResponse.parse(await admin.call('GET', '/api/admin/access/people/alice')).folders).toHaveLength(full.total)
  })

  test('someone switched off is shown as they would be when switched back on; unknown people are 404', async () => {
    const r = await personAnswer('carl')
    expect(r.status).toBe('disabled')
    expect(r.folders.find((f) => f.path === 'projects/apollo')).toMatchObject({ access: 'write', reason: { kind: 'rule', tier: 'user', rules: [rule('user', 'carl', 'write')] } })
    expect((await admin.try('GET', '/api/admin/access/people/nobody-here')).status).toBe(404)
    // the owner: write everywhere by her role, but inside a team project only as a member (no rule names her in apollo)
    const own = await personAnswer('olga')
    const notApollo = own.folders.filter((f) => f.path !== 'projects/apollo')
    expect(notApollo.every((f) => f.access === 'write' && f.listable)).toBe(true)
    expect(notApollo.filter((f) => f.path !== 'users/olga').every((f) => f.reason.kind === 'owner-admin')).toBe(true)
    expect(own.folders.find((f) => f.path === 'projects/apollo')).toMatchObject({ access: 'none', reason: { kind: 'rule', folder: 'projects/apollo', tier: 'everyone' }, listable: false })
  })

  test('a new person with a role and groups gets what a real person with them gets', async () => {
    const preview = PersonAccessResponse.parse(await admin.call('POST', '/api/admin/access/new-person', { role: 'member', groupIds: [sales], limit: 2000 }))
    expect(preview).toMatchObject({ user: null, role: 'member', status: null, groups: [{ id: sales, name: 'Sales' }] })
    expect(preview.folders.some((f) => f.path.startsWith('users'))).toBe(false)
    const dora = await personAnswer('dora')
    const strip = (f: PersonAccessResponse['folders'][number]) => ({ p: f.path, access: f.access, reason: f.reason, listable: f.listable, via: f.via })
    expect(preview.folders.map(strip)).toEqual(dora.folders.filter((f) => f.path !== 'users/dora').map(strip))
    const part = PersonAccessResponse.parse(await admin.call('POST', '/api/admin/access/new-person', { role: 'member', groupIds: [sales], prefix: 'projects', limit: 1 }))
    expect(part).toMatchObject({ total: 2, nextCursor: 'projects' })
    // a new admin: write everywhere but inside a team project, where they are a member with their groups
    const asAdmin = PersonAccessResponse.parse(await admin.call('POST', '/api/admin/access/new-person', { role: 'admin', groupIds: [], limit: 2000 }))
    expect(asAdmin.folders.filter((f) => f.path !== 'projects/apollo').every((f) => f.access === 'write' && f.reason.kind === 'owner-admin')).toBe(true)
    expect(asAdmin.folders.find((f) => f.path === 'projects/apollo')).toMatchObject({ access: 'none', reason: { kind: 'rule', folder: 'projects/apollo', tier: 'everyone' } })
    // in the project's group they read it as its members of that group do
    const salesAdmin = PersonAccessResponse.parse(await admin.call('POST', '/api/admin/access/new-person', { role: 'admin', groupIds: [sales], limit: 2000 }))
    expect(salesAdmin.folders.find((f) => f.path === 'projects/apollo')).toMatchObject({ access: 'read', reason: { kind: 'rule', folder: 'projects/apollo', tier: 'group' } })
    expect((await admin.try('POST', '/api/admin/access/new-person', { role: 'member', groupIds: ['no-such-group'] })).status).toBe(400)
    expect((await admin.try('POST', '/api/admin/access/new-person', { role: 'owner', groupIds: [] })).status).toBe(400)
  })
})

describe('someone new with rules on the team root (the person view, stage 3)', () => {
  test('their own folder is never named (it has no id yet); every row and access is what a member with the same groups gets', async () => {
    // a rule on the root makes the root a row; it is listable for everyone through their own users/<id>
    const top = await admin.call('POST', '/api/admin/folders', { path: '', rules: [rule('group', ops, 'read')] })
    try {
      const raw = await admin.call('POST', '/api/admin/access/new-person', { role: 'member', groupIds: [], limit: 2000 })
      // before: via named users/\u0000new-person, which is no RelPath (500 with the response check, a ZodError in the app)
      const preview = PersonAccessResponse.parse(raw)
      expect(JSON.stringify(raw)).not.toContain('users')
      expect(JSON.stringify(raw)).not.toContain('\\u0000')
      expect(preview.folders.find((f) => f.path === '')).toMatchObject({ access: 'none', listable: true, reason: { kind: 'no-rule' } })
      // erik: a member with no group and no person rule, the same answer without his own folder
      const erik = await personAnswer('erik')
      const strip = (f: PersonAccessResponse['folders'][number]) => ({ p: f.path, access: f.access, reason: f.reason, listable: f.listable, via: f.via.filter((v) => v !== 'users/erik'), more: f.viaMore })
      expect(preview.folders.map(strip)).toEqual(erik.folders.filter((f) => f.path !== 'users/erik').map(strip))
      expect(erik.folders.find((f) => f.path === '')?.via).toContain('users/erik')
      // access() is unchanged: every row is the permission function's answer for such a member
      for (const f of preview.folders) expect(f.access, f.path).toBe(accessOf('erik', f.path))
      // more readable folders than MAX_VIA below the root: still at most 20 named, viaMore says there are others
      const made: string[] = []
      for (let i = 0; i < 21; i++) made.push((await admin.call('POST', '/api/admin/folders', { path: `wide/f${String(i).padStart(2, '0')}`, rules: [rule('everyone', null, 'read')] })).id)
      try {
        const wide = PersonAccessResponse.parse(await admin.call('POST', '/api/admin/access/new-person', { role: 'member', groupIds: [], limit: 2000 }))
        const root = wide.folders.find((f) => f.path === '')!
        expect(root.via).toHaveLength(20)
        expect(root.viaMore).toBe(true)
        expect(root.via.some((v) => v.startsWith('users'))).toBe(false)
      } finally {
        for (const id of made) await admin.call('DELETE', `/api/admin/folders/${id}`)
      }
    } finally {
      await admin.call('DELETE', `/api/admin/folders/${top.id}`)
    }
  })

  test('saving rules for a folder that is not on disk, without create: refused, and nothing is made', async () => {
    // the person view opens the rule editor on a folder that is gone; it saves with create: false
    const missing = 'shared/gone-9f2'
    const r = await admin.try('POST', '/api/admin/folders', { path: missing, create: false, rules: [rule('everyone', null, 'read')] })
    expect(r.status).toBe(404)
    expect(Object.values(AUTH_MESSAGES.folderMissing)).toContain(r.body.error.message)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, missing))).toBe(false)
    expect(h.ctx.db.query('SELECT 1 FROM folders WHERE path = ?').get(missing)).toBeNull()
    // a project's folder (gone or there) and anything in it: refused first, one answer, nothing made (its members are
    // changed on its page: docs/DECISIONS.md "Project contents only for members")
    for (const p of ['projects/gone-9f2', 'projects/apollo', 'Projects/Apollo/drafts']) {
      const x = await admin.try('POST', '/api/admin/folders', { path: p, create: false, rules: [rule('everyone', null, 'read')] })
      expect(x.status, p).toBe(409)
      expect(x.body.error.params.reason, p).toBe('project_members_only')
    }
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'projects/gone-9f2'))).toBe(false)
    expect(h.ctx.db.query('SELECT 1 FROM folders WHERE path = ?').get('projects/gone-9f2')).toBeNull()
    expect(accessOf('erik', 'projects/apollo')).toBe('none')
  })
})

describe('changes between pages, forgotten rule rows', () => {
  test('the folder answer pages by person: someone added before the cursor or switched off after it changes nothing else', async () => {
    const first = await folderAnswer('projects/apollo', '&limit=2')
    expect(first.people.map((p) => p.user.id)).toEqual(['adam', 'alice'])
    // between the pages: abby (sorts first) joins, bob (next on the old page 2) is switched off
    await addMember(h, owner, { username: 'abby' })
    await owner.call('PATCH', '/api/admin/users/bob', { status: 'disabled' })
    try {
      const rest: string[] = []
      let cursor: string | null = first.nextCursor
      while (cursor) {
        const r: FolderAccessResponse = await folderAnswer('projects/apollo', `&limit=2&cursor=${cursor}`)
        rest.push(...r.people.map((p) => p.user.id))
        cursor = r.nextCursor
      }
      // alice does not come again, nobody after her goes missing
      expect(rest).toEqual(['dora', 'erik', 'olga'])
      // a cursor survives its own person being switched off
      const afterBob = await folderAnswer('projects/apollo', `&limit=1&cursor=${Buffer.from(JSON.stringify(['BOB', 'bob'])).toString('base64url')}`)
      expect(afterBob.people.map((p) => p.user.id)).toEqual(['dora'])
    } finally {
      await owner.call('PATCH', '/api/admin/users/bob', { status: 'active' })
      await owner.call('DELETE', '/api/admin/users/abby')
    }
    expect((await admin.try('GET', `/api/admin/access/folder?path=shared&cursor=${Buffer.from('[1]').toString('base64url')}`)).status).toBe(400)
  })

  test('rule rows nobody can open (Users/…, .SYSTEM/…, a temp name in capitals) are never named, and access stays as it was', async () => {
    const root = h.ctx.files.fx.root
    fs.mkdirSync(path.join(root, '.MYCEL-TMP-z'), { recursive: true })
    const ghosts = ['Users/alice/x', '.SYSTEM/x', 'shared/.MYCEL-TMP-y']
    const ins = (p: string) => {
      const id = crypto.randomUUID()
      h.ctx.db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(id, p)
      h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'everyone', NULL, 'read')").run(crypto.randomUUID(), id)
      return id
    }
    const ids = ghosts.map(ins)
    try {
      const erik = await personAnswer('erik')
      const text = JSON.stringify(erik)
      for (const g of [...ghosts, '.MYCEL-TMP-z']) expect(text, g).not.toContain(g)
      for (const f of erik.folders) expect(f.listable, f.path).toBe(canList('erik', f.path))
      const top = await folderAnswer('')
      expect(JSON.stringify(top)).not.toContain('MYCEL-TMP')
      expect(JSON.stringify(top)).not.toContain('Users/')
      for (const p of top.people) expect(p.listable, p.user.id).toBe(canList(p.user.id, ''))
      // the permission function still answers these paths exactly as before (display only)
      expect(accessOf('erik', 'shared/.MYCEL-TMP-y')).toBe('read')
    } finally {
      for (const id of ids) h.ctx.db.query('DELETE FROM folders WHERE id = ?').run(id)
      fs.rmSync(path.join(root, '.MYCEL-TMP-z'), { recursive: true, force: true })
    }
  })
})
