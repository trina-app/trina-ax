// Admin > Folder permissions > By folder: GET /api/admin/access/tree (server/src/admin/access-tree.ts). One level of
// the team folder at a time; every child's "who" must add up to the permission function's own answers (RuleSet.access
// for every active person), users/ is one row that is never listed, and nothing of .system/, temp names or someone's
// personal folder may show.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { AccessTreeResponse, type AccessTreeNode } from '@mycel/shared/api'
import { MAX_DEPTH } from '../../server/src/policy/names'
import { OPEN_LEVELS, OPEN_ROWS } from '../../server/src/admin/access-tree'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client
let admin: Client
let sales: string
let ops: string
const rule = (subjectType: 'everyone' | 'role' | 'group' | 'user', subjectId: string | null, access: 'none' | 'read' | 'write') => ({ subjectType, subjectId, access })
const segs = (p: string) => (p === '' ? [] : p.split('/'))
const tree = async (p: string, extra = '') => AccessTreeResponse.parse(await admin.call('GET', `/api/admin/access/tree?path=${encodeURIComponent(p)}${extra}`))
const child = (r: AccessTreeResponse, name: string) => r.levels[0]!.children.find((c) => c.name === name)
const active = () => (h.ctx.db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((u) => u.id)

/** every active person once, and as many at each access as the permission function says */
function addsUp(n: AccessTreeNode) {
  const people = active()
  expect(n.who.reduce((s, w) => s + w.count, 0), n.path).toBe(people.length)
  const want = { none: 0, read: 0, write: 0 }
  for (const id of people) want[h.ctx.files.rules().access(h.ctx.files.principal(id), segs(n.path))]++
  const got = { none: 0, read: 0, write: 0 }
  for (const w of n.who) got[w.access] += w.count
  expect(got, n.path).toEqual(want)
}

beforeAll(async () => {
  h = await harness('access-tree')
  owner = await withOwner(h)
  admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  ops = (await admin.call('POST', '/api/admin/groups', { name: 'Ops' })).id
  const alice = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
  await addMember(h, owner, { username: 'bob' })
  await addMember(h, owner, { username: 'carl', groupIds: [sales] })
  await addMember(h, owner, { username: 'dora', groupIds: [sales] })
  await addMember(h, owner, { username: 'erik' })
  await admin.call('POST', '/api/admin/folders', { path: 'projects/apollo', rules: [rule('user', 'alice', 'write'), rule('group', sales, 'read'), rule('everyone', null, 'none')] })
  await admin.call('POST', '/api/admin/folders', { path: 'projects/apollo/drafts', rules: [rule('user', 'bob', 'write')] })
  await admin.call('POST', '/api/admin/folders', { path: 'skills/finance', rules: [rule('everyone', null, 'none'), rule('group', ops, 'read')] })
  await alice.client.call('POST', '/api/projects', { name: 'Apollo', folderPath: 'projects/apollo', instructions: '' })
  await alice.client.call('POST', '/api/projects', { name: 'Alice-private-plan-7c1', folderPath: 'users/alice', instructions: '' })
  const root = h.ctx.files.fx.root
  fs.mkdirSync(path.join(root, 'users', 'alice', 'Alice-private-folder-5d2'), { recursive: true })
  fs.mkdirSync(path.join(root, 'shared', 'notes', 'deep'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(root, '.MYCEL-TMP-q'), { recursive: true })
  fs.mkdirSync(path.join(root, 'shared', '.MYCEL-TMP-r'), { recursive: true })
  fs.writeFileSync(path.join(root, 'shared', 'a-file.md'), 'x')
  fs.symlinkSync(path.join(root, 'users', 'alice'), path.join(root, 'shared', 'link-to-alice'))
  h.ctx.db.query('INSERT INTO connected_folders (id, name, source) VALUES (?, ?, ?)').run('00000000-0000-7000-8000-00000000c0de', 'nas', '/Volumes/nas')
  fs.mkdirSync(path.join(root, 'connected', 'nas'), { recursive: true })
  await owner.call('PATCH', '/api/admin/users/carl', { status: 'disabled' })
})
afterAll(() => h.close())

describe('one level', () => {
  test('the team root: its folders by name, users/ as one row, never .system/ or a temp name', async () => {
    const r = await tree('')
    expect(r.path).toBe('')
    expect(r.exists).toBe(true)
    expect(r.people).toBe(active().length)
    expect(r.members).toBe(active().length - 2) // olga (owner), adam (admin)
    const names = r.levels[0]!.children.map((c) => c.name)
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    expect(names).toEqual(expect.arrayContaining(['connected', 'docs', 'groups', 'projects', 'shared', 'skills', 'users']))
    expect(names.some((n) => n.startsWith('.'))).toBe(false)
    const users = child(r, 'users')!
    expect(users).toMatchObject({ path: 'users', kinds: ['personal'], folders: false, who: [], people: active().length })
    const text = JSON.stringify(r)
    for (const s of ['Alice-private', 'MYCEL-TMP', '.system']) expect(text, s).not.toContain(s)
    expect(r.self.path).toBe('')
    addsUp(r.self)
    for (const c of r.levels[0]!.children) if (c.path !== 'users') addsUp(c)
    expect(r.levels).toHaveLength(1)
  })

  test('kinds, own rules and what is below: group, project and connected folders; inherited folders', async () => {
    const top = await tree('')
    expect(child(top, 'projects')).toMatchObject({ rules: 0, folders: true, marked: 2, kinds: [] })
    expect(child(top, 'skills')).toMatchObject({ rules: 2, marked: 1, kinds: ['rules'] })
    expect(child(top, 'groups')!.marked).toBe(2)
    const projects = await tree('projects')
    const apollo = child(projects, 'apollo')!
    expect(apollo.kinds).toEqual(['rules', 'project'])
    expect(apollo.projects).toEqual([expect.objectContaining({ name: 'Apollo' })])
    expect(apollo).toMatchObject({ rules: 3, folders: true, marked: 1, restricted: true })
    // alice's personal project is not a team folder: never named
    expect(JSON.stringify(projects)).not.toContain('Alice-private-plan')
    const groups = await tree('groups')
    expect(child(groups, 'Sales')).toMatchObject({ kinds: ['rules', 'group'], group: { id: sales, name: 'Sales' } })
    expect(child(await tree('connected'), 'nas')).toMatchObject({ kinds: ['connected'], connected: { name: 'nas' } })
    // a folder without rules: the people's access comes from above (shared: everyone writes)
    const notes = child(await tree('shared'), 'notes')!
    expect(notes).toMatchObject({ rules: 0, folders: true, restricted: false, risks: [] })
    expect(notes.who.find((w) => w.reason === 'rule')).toMatchObject({ folder: 'shared', subject: { type: 'everyone' }, access: 'write' })
  })

  test('who sees apollo, grouped by the rule that decided, with names', async () => {
    const apollo = child(await tree('projects'), 'apollo')!
    addsUp(apollo)
    const by = (type: string, id: string | null) => apollo.who.find((w) => w.subject?.type === type && w.subject.id === id)
    expect(by('user', 'alice')).toMatchObject({ reason: 'rule', folder: 'projects/apollo', access: 'write', count: 1, subject: { name: 'ALICE' } })
    expect(by('group', sales)).toMatchObject({ access: 'read', count: 1, subject: { name: 'Sales' } }) // dora (carl is switched off)
    expect(by('everyone', null)).toMatchObject({ access: 'none', count: 2 }) // bob, erik
    expect(apollo.who.find((w) => w.reason === 'owner-admin')).toMatchObject({ access: 'write', count: 2 })
    // most access first
    expect(apollo.who.map((w) => w.access)).toEqual(['write', 'write', 'read', 'none'])
    // drafts: bob by his own rule; the others from apollo
    const drafts = child(await tree('projects/apollo'), 'drafts')!
    addsUp(drafts)
    expect(drafts.who.find((w) => w.subject?.id === 'bob')).toMatchObject({ folder: 'projects/apollo/drafts', access: 'write' })
    expect(drafts.who.find((w) => w.subject?.id === 'alice')).toMatchObject({ folder: 'projects/apollo', access: 'write' })
  })

  test('folders on disk only: no file, no link, nothing under a temp name; a folder not there', async () => {
    const shared = await tree('shared')
    const names = shared.levels[0]!.children.map((c) => c.name)
    expect(names).toContain('notes')
    for (const n of ['a-file.md', 'link-to-alice', '.MYCEL-TMP-r']) expect(names).not.toContain(n)
    expect(JSON.stringify(shared)).not.toContain('Alice-private')
    const gone = await tree('shared/not-here-1b3')
    expect(gone).toMatchObject({ exists: false, levels: [{ children: [], total: 0, nextCursor: null }] })
    addsUp(gone.self)
  })

  test('refused: personal folders, .system/, temp names and paths outside the team folder, before anything is read', async () => {
    for (const p of ['users', 'users/alice', 'Users/alice', '.system', '.system/trash', 'shared/.MYCEL-TMP-r', '../etc']) {
      const r = await admin.try('GET', `/api/admin/access/tree?path=${encodeURIComponent(p)}`)
      expect(r.status, p).toBe(400)
      expect(JSON.stringify(r.body), p).not.toContain('Alice-private')
    }
    // members cannot ask
    const bob = (await addMember(h, owner, { username: 'bobby' })).client
    expect((await bob.try('GET', '/api/admin/access/tree?path=')).status).toBe(403)
    await owner.call('DELETE', '/api/admin/users/bobby')
  })
})

describe('pages and opening the way down', () => {
  test('pages by name: every child once, in order, with the total', async () => {
    const all = (await tree('', '&limit=500')).levels[0]!
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const r: AccessTreeResponse = await tree('', `&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      const l = r.levels[0]!
      expect(l.total).toBe(all.total)
      expect(l.children.length).toBeLessThanOrEqual(2)
      seen.push(...l.children.map((c) => c.name))
      cursor = l.nextCursor
    } while (cursor)
    expect(seen).toEqual(all.children.map((c) => c.name))
    expect((await admin.try('GET', '/api/admin/access/tree?limit=501')).status).toBe(400)
  })

  test('open=1: the levels on the way to rule, group, project and connected folders, breadth first', async () => {
    const r = await tree('', '&open=1')
    const opened = r.levels.map((l) => l.path)
    expect(opened[0]).toBe('')
    expect(opened).toEqual(expect.arrayContaining(['connected', 'groups', 'projects', 'skills', 'projects/apollo']))
    // nothing marked below shared/ or docs/: they stay closed
    expect(opened).not.toContain('shared')
    expect(opened).not.toContain('docs')
    expect(opened.indexOf('projects')).toBeLessThan(opened.indexOf('projects/apollo'))
    // a page further down does not open anything
    expect((await tree('', '&open=1&limit=1&cursor=a')).levels).toHaveLength(1)
  })

  test('open=1 stays small in a wide team folder', async () => {
    const root = h.ctx.files.fx.root
    const made: string[] = []
    for (let i = 0; i < 80; i++) made.push((await admin.call('POST', '/api/admin/folders', { path: `wide/w${String(i).padStart(2, '0')}/inner`, rules: [rule('role', 'member', 'read')] })).id)
    try {
      const r = await tree('', '&open=1')
      expect(r.levels.length).toBeLessThanOrEqual(OPEN_LEVELS)
      expect(r.levels.slice(1).reduce((s, l) => s + l.children.length, 0) + r.levels[0]!.children.length).toBeLessThanOrEqual(OPEN_ROWS)
      const wide = r.levels.find((l) => l.path === 'wide')!
      expect(wide.total).toBe(80)
    } finally {
      for (const id of made) await admin.call('DELETE', `/api/admin/folders/${id}`)
      fs.rmSync(path.join(root, 'wide'), { recursive: true, force: true })
    }
  })

  test(`depth ${MAX_DEPTH}: the deepest folder has nothing to open; long names come back whole`, async () => {
    const root = h.ctx.files.fx.root
    const deep = Array.from({ length: MAX_DEPTH }, (_, i) => `d${i}`)
    fs.mkdirSync(path.join(root, ...deep, 'too-deep'), { recursive: true })
    const long = 'L'.repeat(200)
    fs.mkdirSync(path.join(root, 'docs', long), { recursive: true })
    try {
      const last = await tree(deep.slice(0, -1).join('/'))
      expect(child(last, `d${MAX_DEPTH - 1}`)).toMatchObject({ folders: false })
      const bottom = await tree(deep.join('/'))
      expect(bottom.levels[0]!.children).toEqual([])
      expect(child(await tree('docs'), long)?.path).toBe(`docs/${long}`)
    } finally {
      fs.rmSync(path.join(root, 'd0'), { recursive: true, force: true })
      fs.rmSync(path.join(root, 'docs', long), { recursive: true, force: true })
    }
  })
})

describe('risks and restricted folders', () => {
  test('everyone writes: said on the topmost folder only; in skills/ as the team AI instructions; a root rule for everyone', async () => {
    const top = await tree('')
    expect(child(top, 'shared')!.risks).toEqual(['everyone-writes'])
    expect(child(top, 'shared')!.restricted).toBe(false)
    expect(child(await tree('shared'), 'notes')!.risks).toEqual([])
    expect(child(top, 'skills')!.risks).toEqual([])
    expect(child(top, 'docs')).toMatchObject({ risks: [], restricted: true }) // no rule: only the owner and admins
    const sx = await admin.call('POST', '/api/admin/folders', { path: 'skills/open', rules: [rule('everyone', null, 'write')] })
    const rootRule = await admin.call('POST', '/api/admin/folders', { path: '', rules: [rule('everyone', null, 'read')] })
    try {
      expect(child(await tree('skills'), 'open')!.risks).toEqual(['skills-everyone-writes'])
      const r = await tree('')
      expect(r.self.risks).toEqual(['root-everyone'])
      expect(child(r, 'docs')).toMatchObject({ restricted: false, risks: [] })
      // groups/Sales: its group writes, everyone else reads through the root
      const salesFolder = child(await tree('groups'), 'Sales')!
      addsUp(salesFolder)
      expect(salesFolder.who.find((w) => w.subject?.type === 'everyone')).toMatchObject({ folder: '', access: 'read' })
    } finally {
      await admin.call('DELETE', `/api/admin/folders/${sx.id}`)
      await admin.call('DELETE', `/api/admin/folders/${rootRule.id}`)
    }
  })
})
