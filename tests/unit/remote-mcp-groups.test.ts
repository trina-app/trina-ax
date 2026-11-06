// The connector's group tools (scope mcp:admin): consent, the role re-check on every call, the tools themselves, the
// same audit lines as Admin › Groups, and the access-change text. Synthetic people and groups only.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { RemoteTools } from '../../server/src/connectors/remote-mcp/tools'
import { challenge, scopes } from '../../server/src/connectors/remote-mcp/policy'
import { GROUP_LIMITS } from '../../server/src/connectors/remote-mcp/groups'
import { addMember, harness, withOwner, type Harness } from './a-lib'

const live: Harness[] = []
afterEach(async () => { for (const h of live.splice(0)) await h.close() })
const redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
const GROUP = ['people_list', 'groups_list', 'group_create', 'group_update', 'group_delete']
const ALL = 'mcp:read mcp:write mcp:admin offline_access'
type Res = { content: { text: string }[]; isError?: boolean }
const text = (r: Res) => r.content[0]!.text

async function setup(name: string) {
  const h = await harness('remote-groups-' + name); live.push(h)
  const owner = await withOwner(h)
  const reader = await addMember(h, owner, { username: 'reader' })
  const helper = await addMember(h, owner, { username: 'helper', role: 'admin' })
  const oauth = new RemoteOAuth(h.ctx.db, { origin: 'https://team.example' }), tools = new RemoteTools(h.ctx, () => oauth)
  const client = oauth.register({ redirect_uris: [redirect] })
  const request = (scope: string) => new URL(oauth.authorize({ client_id: client.client_id, redirect_uri: redirect, resource: oauth.resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope })).searchParams.get('id')!
  /** sign in as the person with `cookie`, see the consent, allow with these boxes ticked (left out: as the old page) */
  const connect = async (cookie: string, scope = ALL, choice: { write?: boolean; admin?: boolean } = { admin: true }) => {
    const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie } }), { ip: '10.0.0.7', via: 'test' }))!
    const id = request(scope), consent = oauth.consent(id, auth)
    const code = new URL(oauth.decide(id, auth, true, choice).redirectUrl).searchParams.get('code')!
    const issued = oauth.token({ client_id: client.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oauth.resource() })
    return { asked: consent.scopes, optional: consent.optional, token: issued.access_token, refresh: issued.refresh_token, scope: issued.scope, grant: () => oauth.authenticate(issued.access_token) }
  }
  const names = (token: string) => tools.list(oauth.authenticate(token)).map(t => t.name)
  const call = (token: string, name: string, args: unknown = {}) => tools.call(token, name, args) as Promise<Res>
  const audits = (action: string) => (h.ctx.db.query('SELECT actor_id, target, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { actor_id: string | null; target: string | null; detail: string | null }[])
    .map(r => ({ actor: r.actor_id, target: r.target, detail: r.detail ? JSON.parse(r.detail) : null }))
  const groupCount = () => (h.ctx.db.query('SELECT count(*) AS n FROM groups').get() as { n: number }).n
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
  return { h, owner, ownerId, reader, helper, oauth, tools, client, connect, names, call, audits, groupCount }
}

test('mcp:admin is never a default, is offered to owners and admins only, and stays off unless ticked', async () => {
  const f = await setup('consent')
  expect(scopes(undefined)).toEqual(['mcp:read'])
  expect(f.oauth.metadata().scopes_supported).toContain('mcp:admin')
  // the owner, not ticked: no group tools, even when the app asked for it
  const off = await f.connect(f.owner.cookie!, ALL, { admin: false })
  expect(off.asked).toEqual(['mcp:read', 'mcp:write', 'mcp:admin', 'offline_access'])
  expect(off.optional).toEqual(['mcp:write', 'mcp:admin'])
  expect(off.scope).toBe('mcp:read mcp:write offline_access')
  expect(f.names(off.token).filter(n => GROUP.includes(n))).toEqual([])
  for (const name of GROUP) expect(text(await f.call(off.token, name))).toContain('no permission')
  // left out (the old page's body): never assumed
  expect((await f.connect(f.owner.cookie!, ALL, {})).scope).toBe('mcp:read mcp:write offline_access')
  // ticked: listed, with the right annotations
  const on = await f.connect(f.owner.cookie!, ALL, { admin: true })
  expect(on.scope).toBe('mcp:read mcp:write mcp:admin offline_access')
  const listed = f.tools.list(on.grant()).filter(t => GROUP.includes(t.name))
  expect(listed.map(t => t.name)).toEqual(GROUP)
  for (const t of listed) {
    expect(t.annotations.openWorldHint).toBe(false)
    expect(t.annotations.readOnlyHint).toBe(t.name.endsWith('_list'))
    const destructive = (t.annotations as { destructiveHint?: boolean }).destructiveHint
    if (t.name === 'group_update' || t.name === 'group_delete') expect(destructive).toBe(true)
    if (t.name === 'group_create') expect(destructive).toBe(false)
  }
  // an admin may have it too, without the write scope; and when the app asked only for read (what the 401 names)
  const admin = await f.connect(f.helper.client.cookie!, 'mcp:read', { write: false, admin: true })
  expect(admin.optional).toEqual(['mcp:write', 'mcp:admin'])
  expect(admin.scope).toBe('mcp:read mcp:admin')
  expect(f.names(admin.token)).toEqual(['list', 'glob', 'grep', 'read', 'skills_list', ...GROUP])
  expect(f.audits('remote_mcp.connected').map(a => a.detail)).toEqual([
    { scopes: ['mcp:read', 'mcp:write', 'offline_access'], asked: ['mcp:read', 'mcp:write', 'mcp:admin', 'offline_access'] },
    { scopes: ['mcp:read', 'mcp:write', 'offline_access'], asked: ['mcp:read', 'mcp:write', 'mcp:admin', 'offline_access'] },
    { scopes: ['mcp:read', 'mcp:write', 'mcp:admin', 'offline_access'], asked: ['mcp:read', 'mcp:write', 'mcp:admin', 'offline_access'] },
    { scopes: ['mcp:read', 'mcp:admin'], asked: ['mcp:read'] },
  ])
})

test('a member is never offered or granted mcp:admin and cannot use the group tools', async () => {
  const f = await setup('member')
  const m = await f.connect(f.reader.client.cookie!, ALL, { admin: true })
  expect(m.asked).toEqual(['mcp:read', 'mcp:write', 'offline_access'])
  expect(m.optional).toEqual(['mcp:write'])
  expect(m.scope).toBe('mcp:read mcp:write offline_access')
  // asked for read only: the member may still tick write, never group management
  const r1 = await f.connect(f.reader.client.cookie!, 'mcp:read', { write: true, admin: true })
  expect(r1.optional).toEqual(['mcp:write'])
  expect(r1.scope).toBe('mcp:read mcp:write')
  expect(f.names(m.token).filter(n => GROUP.includes(n))).toEqual([])
  for (const name of GROUP) {
    const r = await f.call(m.token, name, name === 'group_create' ? { name: 'Sneaky' } : {})
    expect(r.isError).toBe(true); expect(text(r)).toContain('no permission')
  }
  // a refresh cannot add it
  expect(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: m.refresh, scope: ALL, resource: f.oauth.resource() })).toThrow('invalid_scope')
  // even with the scope in the row (say a restored backup), the role is checked: refused, and the scope is taken off
  f.h.ctx.db.query('UPDATE remote_mcp_grants SET scopes = ? WHERE id = ?').run(JSON.stringify(['mcp:read', 'mcp:admin']), m.grant().id)
  expect(f.names(m.token).filter(n => GROUP.includes(n))).toEqual([])
  const r = await f.call(m.token, 'group_create', { name: 'Sneaky' })
  expect(r.isError).toBe(true); expect(text(r)).toContain('owner or admin')
  expect(JSON.parse(m.grant().scopes)).toEqual(['mcp:read'])
  expect(f.groupCount()).toBe(0)
  expect(f.audits('remote_mcp.tool').at(-1)!.detail).toEqual({ tool: 'group_create', ok: false, via: 'connector', reason: 'not_admin' })
})

test('existing grants are unaffected: the same nine tools, and a refresh cannot add mcp:admin', async () => {
  const f = await setup('existing')
  // a grant as the consent before this change made it (body { allow: true }: the asked scopes, never mcp:admin)
  const old = await f.connect(f.owner.cookie!, 'mcp:read mcp:write offline_access', {})
  expect(old.scope).toBe('mcp:read mcp:write offline_access')
  const nine = ['list', 'glob', 'grep', 'read', 'write', 'edit', 'upload_file', 'create_upload_link', 'skills_list']
  expect(f.names(old.token)).toEqual(nine)
  expect(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: old.refresh, scope: ALL, resource: f.oauth.resource() })).toThrow('invalid_scope')
  const next = f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: old.refresh, resource: f.oauth.resource() })
  expect(next.scope).toBe('mcp:read mcp:write offline_access')
  expect(f.names(next.access_token)).toEqual(nine)
})

test('an admin demoted after granting loses the group tools on the next call, for good', async () => {
  const f = await setup('demoted')
  const g = await f.connect(f.helper.client.cookie!)
  expect((await f.call(g.token, 'groups_list')).isError).toBeUndefined()
  // demoted in Admin › Members: the scope comes off the grant at once
  await f.owner.call('PATCH', `/api/admin/users/${f.helper.id}`, { role: 'member' })
  expect(f.names(g.token).filter(n => GROUP.includes(n))).toEqual([])
  expect(text(await f.call(g.token, 'group_create', { name: 'Late group' }))).toContain('no permission')
  expect(f.groupCount()).toBe(0)
  // made admin again: the old grant does not get it back; the file tools keep working
  await f.owner.call('PATCH', `/api/admin/users/${f.helper.id}`, { role: 'admin' })
  expect(f.names(g.token).filter(n => GROUP.includes(n))).toEqual([])
  expect(f.names(g.token)).toContain('read')
  expect(f.audits('remote_mcp.scope_dropped').map(a => a.detail)).toEqual([{ scope: 'mcp:admin', user: f.helper.id, reason: 'role' }])

  // a role changed some other way: the next call checks the role itself
  const h2 = await f.connect(f.helper.client.cookie!)
  f.h.ctx.db.query("UPDATE users SET role = 'member' WHERE id = ?").run(f.helper.id)
  expect(f.names(h2.token).filter(n => GROUP.includes(n))).toEqual([])
  expect(text(await f.call(h2.token, 'people_list'))).toContain('owner or admin')
  f.h.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(f.helper.id)
  expect(JSON.parse(h2.grant().scopes)).not.toContain('mcp:admin')

  // disabled: the connection ends
  const h3 = await f.connect(f.helper.client.cookie!)
  await f.owner.call('PATCH', `/api/admin/users/${f.helper.id}`, { status: 'disabled' })
  await expect(f.call(h3.token, 'groups_list')).rejects.toThrow('invalid_token')
})

test('people_list and groups_list show people, members and the folders group rules open', async () => {
  const f = await setup('lists')
  const g = await f.connect(f.owner.cookie!)
  const sales = await f.owner.call('POST', '/api/admin/groups', { name: 'Sales', memberIds: [f.reader.id] })
  const people = JSON.parse(text(await f.call(g.token, 'people_list')))
  expect(people.total).toBe(3)
  expect(people.people.find((p: { username: string }) => p.username === 'reader')).toEqual({ id: f.reader.id, name: 'READER', username: 'reader', role: 'member', groups: ['Sales'] })
  expect(JSON.parse(text(await f.call(g.token, 'people_list', { query: 'HELP' }))).people.map((p: { username: string }) => p.username)).toEqual(['helper'])
  // a disabled person is not listed
  await f.owner.call('PATCH', `/api/admin/users/${f.reader.id}`, { status: 'disabled' })
  expect(JSON.parse(text(await f.call(g.token, 'people_list'))).total).toBe(2)
  await f.owner.call('PATCH', `/api/admin/users/${f.reader.id}`, { status: 'active' })

  const all = JSON.parse(text(await f.call(g.token, 'groups_list')))
  expect(all.total).toBe(1)
  expect(all.groups[0]).toEqual({ id: sales.id, name: 'Sales', description: null, folder: 'groups/Sales', members: [{ id: f.reader.id, name: 'READER', username: 'reader' }], memberCount: 1, rules: [{ path: 'groups/Sales', access: 'write' }], ruleCount: 1 })
  // another folder's rule naming the group shows too; one group by name in any case, or by id
  await f.owner.call('POST', '/api/admin/folders', { path: 'projects/alpha', create: true, rules: [{ subjectType: 'group', subjectId: sales.id, access: 'read' }] })
  for (const ref of ['sales', sales.id]) {
    const one = JSON.parse(text(await f.call(g.token, 'groups_list', { group: ref })))
    expect(one.groups.map((x: { name: string }) => x.name)).toEqual(['Sales'])
    expect(one.groups[0].rules).toEqual([{ path: 'groups/Sales', access: 'write' }, { path: 'projects/alpha', access: 'read' }])
  }
  const none = await f.call(g.token, 'groups_list', { group: 'Nope' })
  expect(none.isError).toBe(true); expect(text(none)).toContain('No group "Nope"')
  expect((await f.call(g.token, 'people_list', { extra: 1 })).isError).toBe(true)
  expect(f.audits('remote_mcp.tool').filter(a => a.detail.tool === 'people_list').every(a => a.detail.via === 'connector')).toBe(true)
})

test('group_create works as Admin › Groups does: folder, rule, the same audit marked connector, and access words', async () => {
  const f = await setup('create')
  const g = await f.connect(f.owner.cookie!)
  const r = await f.call(g.token, 'group_create', { name: 'Design', members: ['READER', f.helper.id] })
  expect(r.isError).toBeUndefined()
  expect(text(r)).toContain('Created group "Design"')
  expect(text(r)).toContain('with 2 members: READER (reader), HELPER (helper).')
  expect(text(r)).toContain('Its folder is groups/Design; the group writes there.')
  expect(text(r)).toContain('Folder access changed for 1 person:\n- READER (reader): now opens groups/Design (write)')
  expect(fs.statSync(path.join(f.h.ctx.config.teamRoot, 'groups', 'Design')).isDirectory()).toBe(true)
  const id = (f.h.ctx.db.query("SELECT id FROM groups WHERE name = 'Design'").get() as { id: string }).id
  const folder = (await f.owner.call('GET', '/api/admin/folders')).items.find((x: { path: string }) => x.path === 'groups/Design')
  expect(folder.rules).toMatchObject([{ subjectType: 'group', subjectId: id, access: 'write' }])
  expect(f.h.ctx.files.rules().access(f.h.ctx.files.principal(f.reader.id), ['groups', 'Design'])).toBe('write')

  // the web route's audit line, and the connector's: the same fields, plus via
  await f.owner.call('POST', '/api/admin/groups', { name: 'Web made', memberIds: [f.reader.id] })
  const [mine, web] = f.audits('group.create')
  expect(mine!.actor).toBe(web!.actor); expect(mine!.actor).toBe(f.ownerId)
  expect(mine).toEqual({ actor: f.ownerId, target: id, detail: { name: 'Design', folder: 'groups/Design', memberIds: [f.reader.id, f.helper.id], via: 'connector' } })
  expect(Object.keys(mine!.detail).sort()).toEqual([...Object.keys(web!.detail), 'via'].sort())
  expect(web!.detail.via).toBeUndefined()
  expect(f.audits('remote_mcp.tool').at(-1)).toEqual({ actor: f.ownerId, target: g.grant().id, detail: { tool: 'group_create', ok: true, via: 'connector', group: id, members: 2 } })

  // only an admin added: nobody's access changes, and the answer says why
  const admins = await f.call(g.token, 'group_create', { name: 'Admins only', members: ['helper'] })
  expect(text(admins)).toContain('nobody opens or loses a folder. Owners and admins open every team folder whatever their groups (HELPER (helper)).')
  // the web's refusals, in its words
  const taken = await f.call(g.token, 'group_create', { name: 'design' })
  expect(taken.isError).toBe(true); expect(text(taken)).toBe('A group with this name already exists.')
  const ghost = await f.call(g.token, 'group_create', { name: 'Ghosts', members: ['reader', 'nobody-here'] })
  expect(ghost.isError).toBe(true); expect(text(ghost)).toContain('No such person: "nobody-here"')
  for (const bad of [{}, { name: '' }, { name: 'x'.repeat(101) }, { name: 'Odd', color: 'red' }, { name: 'Odd', members: 'reader' }]) {
    const res = await f.call(g.token, 'group_create', bad)
    expect(res.isError).toBe(true); expect(text(res)).toContain('Invalid tool input')
  }
  expect(f.groupCount()).toBe(3)
})

test('group_update adds and takes out members; the answer says who opens or loses folders; the same audit as the web', async () => {
  const f = await setup('update')
  const g = await f.connect(f.owner.cookie!)
  const design = await f.owner.call('POST', '/api/admin/groups', { name: 'Design' })
  const added = await f.call(g.token, 'group_update', { group: 'design', add: ['reader'] })
  expect(added.isError).toBeUndefined()
  expect(text(added)).toContain('Updated group "Design"')
  expect(text(added)).toContain('added READER (reader)')
  expect(text(added)).toContain('- READER (reader): now opens groups/Design (write)')
  const removed = await f.call(g.token, 'group_update', { group: design.id, remove: [f.reader.id] })
  expect(text(removed)).toContain('took out READER (reader)')
  expect(text(removed)).toContain('- READER (reader): loses groups/Design (had write)')
  expect(text(removed)).toContain('Members now: 0.')
  expect(f.h.ctx.files.rules().access(f.h.ctx.files.principal(f.reader.id), ['groups', 'Design'])).toBe('none')
  // the loss is recorded like the web's, marked as the connector's
  expect(f.audits('folder.access_lost').at(-1)).toMatchObject({ actor: f.ownerId, target: design.id, detail: { losing: [{ userId: f.reader.id, paths: ['groups/Design'] }], via: 'connector' } })

  // the web's update line and the connector's: the same fields, plus via
  await f.owner.call('PATCH', `/api/admin/groups/${design.id}`, { memberIds: [f.reader.id] })
  const lines = f.audits('group.update')
  const web = lines.at(-1)!, mine = lines.at(-2)!
  expect(web.detail.via).toBeUndefined()
  expect(mine).toEqual({ actor: f.ownerId, target: design.id, detail: { memberIds: [], via: 'connector' } })
  expect(Object.keys(mine.detail).sort()).toEqual([...Object.keys(web.detail), 'via'].sort())
  expect(f.audits('remote_mcp.tool').filter(a => a.detail.tool === 'group_update').map(a => a.detail)).toEqual([
    { tool: 'group_update', ok: true, via: 'connector', group: design.id, added: [f.reader.id], removed: [], renamed: false },
    { tool: 'group_update', ok: true, via: 'connector', group: design.id, added: [], removed: [f.reader.id], renamed: false },
  ])

  // rename: the folder keeps its name; no access change
  const renamed = await f.call(g.token, 'group_update', { group: 'Design', name: 'Studio', description: 'Synthetic studio' })
  expect(text(renamed)).toContain('Updated group "Studio"')
  expect(text(renamed)).toContain('renamed from "Design"; description changed')
  expect(text(renamed)).toContain('nobody opens or loses a folder')
  expect((await f.owner.call('GET', '/api/admin/groups')).items[0]).toMatchObject({ name: 'Studio', description: 'Synthetic studio' })
  // already in / not in: said, not an error
  const same = await f.call(g.token, 'group_update', { group: 'Studio', add: ['reader'], remove: ['helper'] })
  expect(same.isError).toBeUndefined()
  expect(text(same)).toContain('already in: READER (reader); not in the group: HELPER (helper)')

  // refusals
  const cases: [unknown, string][] = [
    [{ group: 'Nope', add: ['reader'] }, 'No group "Nope"'],
    [{ group: 'Studio', add: ['ghost-person'] }, 'No such person: "ghost-person"'],
    [{ group: 'Studio', remove: ['ghost-person'] }, 'No such person: "ghost-person"'],
    [{ group: 'Studio', add: ['reader'], remove: [f.reader.id] }, 'Both added and taken out: READER (reader)'],
    [{ group: 'Studio' }, 'Nothing to change'],
    [{ group: 'Studio', add: [] }, 'Nothing to change'],
    [{ add: ['reader'] }, 'Invalid tool input'],
  ]
  for (const [args, words] of cases) {
    const res = await f.call(g.token, 'group_update', args)
    expect(res.isError).toBe(true); expect(text(res)).toContain(words)
  }
  await f.owner.call('POST', '/api/admin/groups', { name: 'Other' })
  const clash = await f.call(g.token, 'group_update', { group: 'Studio', name: 'other' })
  expect(clash.isError).toBe(true); expect(text(clash)).toBe('A group with this name already exists.')
})

test('group_delete removes the group and its rules as the web does; members lose its folder; the folder stays', async () => {
  const f = await setup('delete')
  const g = await f.connect(f.owner.cookie!)
  await f.call(g.token, 'group_create', { name: 'Temp team', members: ['reader'] })
  fs.writeFileSync(path.join(f.h.ctx.config.teamRoot, 'groups', 'Temp team', 'note.txt'), 'synthetic')
  const id = (f.h.ctx.db.query("SELECT id FROM groups WHERE name = 'Temp team'").get() as { id: string }).id
  const r = await f.call(g.token, 'group_delete', { group: 'temp TEAM' })
  expect(r.isError).toBeUndefined()
  expect(text(r)).toContain('Deleted group "Temp team"')
  expect(text(r)).toContain('Its folder groups/Temp team and its files stay.')
  expect(text(r)).toContain('- READER (reader): loses groups/Temp team (had write)')
  expect(f.groupCount()).toBe(0)
  expect(f.h.ctx.db.query("SELECT count(*) AS n FROM folder_rules WHERE subject_type = 'group' AND subject_id = ?").get(id)).toEqual({ n: 0 })
  expect(fs.existsSync(path.join(f.h.ctx.config.teamRoot, 'groups', 'Temp team', 'note.txt'))).toBe(true)
  // the same line as the web's delete, plus via
  const web = await f.owner.call('POST', '/api/admin/groups', { name: 'Web temp' })
  await f.owner.call('DELETE', `/api/admin/groups/${web.id}`)
  const [mine, theirs] = f.audits('group.delete')
  expect(mine).toEqual({ actor: f.ownerId, target: id, detail: { name: 'Temp team', via: 'connector' } })
  expect(theirs).toEqual({ actor: f.ownerId, target: web.id, detail: { name: 'Web temp' } })
  expect(f.audits('folder.access_lost').at(-1)!.detail.via).toBe('connector')
  const again = await f.call(g.token, 'group_delete', { group: id })
  expect(again.isError).toBe(true); expect(text(again)).toContain('No group')
})

test('limits: input sizes, the change rate per person, and bounded access words', async () => {
  const f = await setup('limits')
  const g = await f.connect(f.owner.cookie!)
  // one rate-limit minute for the whole test
  const t0 = Date.now()
  f.oauth.now = () => t0
  const many = Array.from({ length: GROUP_LIMITS.peoplePerCall + 1 }, (_, i) => `p${i}`)
  for (const args of [{ name: 'Big', members: many }, { name: 'Long', members: ['x'.repeat(201)] }]) expect(text(await f.call(g.token, 'group_create', args))).toContain('Invalid tool input')
  // access words: at most textPeople people, then a count
  const before = GROUP_LIMITS.textPeople
  GROUP_LIMITS.textPeople = 1
  try {
    const other = await addMember(f.h, f.owner, { username: 'writer' })
    const r = await f.call(g.token, 'group_create', { name: 'Pair', members: ['reader', other.id] })
    expect(text(r)).toContain('Folder access changed for 2 people:')
    expect(text(r)).toContain('- and 1 more people')
  } finally { GROUP_LIMITS.textPeople = before }
  // changes per minute (refused calls count too); reads are not limited by it
  for (let i = 0; i < GROUP_LIMITS.changesPerMinute - 3; i++) expect(text(await f.call(g.token, 'group_delete', { group: 'none-' + i }))).toContain('No group')
  const limited = await f.call(g.token, 'group_update', { group: 'Pair', add: ['helper'] })
  expect(limited.isError).toBe(true); expect(text(limited)).toContain('Too many group changes')
  expect((await f.call(g.token, 'groups_list')).isError).toBeUndefined()
})
