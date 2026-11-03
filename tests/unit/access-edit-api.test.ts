// Admin › Folder permissions, stage 5: the edit panel's answers (server/src/admin/access-edit.ts). The preview of a
// folder's rules (POST /api/admin/access/edit-preview) must say exactly what RuleSet.access says before and after, at
// the folder and at the rule folders below it; the rules hash must refuse a save over another admin's change (409) and
// change nothing else; converting old role rows must change nobody's access.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { FolderEditPreview, type Folder } from '@mycel/shared/api'
import { msg } from '../../server/src/auth/messages'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { EDIT_BELOW, EDIT_BELOW_PEOPLE, EDIT_PEOPLE, editPreview, rulesHash, withRules } from '../../server/src/admin/access-edit'
import { byPerson } from '../../server/src/admin/access-rows'
import { treeCmp, whoAt } from '../../server/src/admin/access-tree'
import { newId } from '../../server/src/db'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

const rule = (subjectType: 'everyone' | 'role' | 'group' | 'user', subjectId: string | null, access: Access) => ({ subjectType, subjectId, access })
const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
const RANK = { none: 0, read: 1, write: 2 }

describe('the rules hash', () => {
  test('the same rules in any order give the same hash; another access, subject or none differ', () => {
    const a = [rule('everyone', null, 'read'), rule('group', 'g1', 'write'), rule('user', 'bob', 'none')]
    expect(rulesHash(a)).toBe(rulesHash([...a].reverse()))
    expect(rulesHash(a)).not.toBe(rulesHash([rule('everyone', null, 'write'), rule('group', 'g1', 'write'), rule('user', 'bob', 'none')]))
    expect(rulesHash(a)).not.toBe(rulesHash([rule('everyone', null, 'read'), rule('group', 'g2', 'write'), rule('user', 'bob', 'none')]))
    expect(rulesHash([])).not.toBe(rulesHash([rule('everyone', null, 'none')]))
    // no subject id is not the id ''
    expect(rulesHash([rule('role', 'member', 'read')])).not.toBe(rulesHash([rule('everyone', null, 'read')]))
  })
})

// ---------------- the preview against the permission function, on random worlds ----------------

let seed = 23
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
const ACCESS: Access[] = ['none', 'read', 'write']

test('every change is RuleSet.access before and after, at the folder and the rule folders below; nobody else changes', () => {
  let changed = 0
  let below = 0
  for (let world = 0; world < 400; world++) {
    const nGroups = pick([2, 5, 34])
    const groups = Array.from({ length: nGroups }, (_, i) => `g${i}`)
    const people: Principal[] = Array.from({ length: pick([6, 30, 70]) }, (_, i) => ({
      id: `p${i}`, name: `P${String(i).padStart(2, '0')}`, role: i === 0 ? 'owner' : i < 3 ? 'admin' : 'member',
      groups: groups.filter(() => rand() < 0.3),
    }))
    const folders = ['', 'a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/e', 'a/e/f', 'g', 'skills', 'skills/x', 'shared', 'users/p3', '.system/trash/x', 'a/b/.MYCEL-TMP-z']
    const rows: ConstructorParameters<typeof RuleSet>[0] = []
    const someRule = () => {
      const t = pick(['everyone', 'role', 'group', 'group', 'user'] as const)
      return { subjectType: t, subjectId: t === 'everyone' ? null : t === 'role' ? pick(['member', 'admin']) : t === 'group' ? pick(groups) : pick(people).id, access: pick(ACCESS) }
    }
    for (const f of folders) {
      if (rand() < 0.45) continue
      const seen = new Set<string>()
      for (let k = 0, n = 1 + Math.floor(rand() * 4); k < n; k++) {
        const r = someRule()
        if (seen.has(`${r.subjectType}:${r.subjectId}`)) continue
        seen.add(`${r.subjectType}:${r.subjectId}`)
        rows.push({ path: f, subject_type: r.subjectType, subject_id: r.subjectId, access: r.access })
      }
    }
    const rules = new RuleSet(rows)
    const at = pick(['', 'a', 'a/b', 'a/b/c', 'a/e', 'g', 'g/new', 'skills', 'skills/x', 'shared'])
    const next = Array.from({ length: Math.floor(rand() * 4) }, someRule).filter((r, i, all) => all.findIndex((x) => x.subjectType === r.subjectType && x.subjectId === r.subjectId) === i)
    const out = editPreview({ rules, people, groupName: (id) => `G ${id}`, personName: (id) => `U ${id}` }, at, next, { team: at === 'shared' ? 'shared' : at === 'skills' ? 'skills' : null })
    const after = withRules(rules, at, next)

    // the brute force: every person at the folder and at every shown rule folder strictly below it
    const ruleBelow = rules.ruleFolders().filter((q) => q !== at && (at === '' || q.startsWith(at + '/')) && !q.startsWith('users') && !q.startsWith('.system') && !q.includes('.MYCEL-TMP-')).sort(treeCmp)
    const want = new Map<string, { before: Access; after: Access; below: string[] }>()
    for (const p of people) {
      const b = rules.access(p, segsOf(at))
      const a = after.access(p, segsOf(at))
      const where = ruleBelow.filter((q) => rules.access(p, segsOf(q)) !== after.access(p, segsOf(q)))
      if (a === b) {
        // the reason the preview looks no further: no change at the folder, no change below it
        expect(where, `${world} ${p.id} ${at}`).toEqual([])
        continue
      }
      // below, the change is the folder's own
      for (const q of where) expect([rules.access(p, segsOf(q)), after.access(p, segsOf(q))]).toEqual([b, a])
      want.set(p.id, { before: b, after: a, below: where })
    }
    // the changes at the folder: one group per before → after, the first 50 by name, everyone counted once
    let less = 0
    let more = 0
    const seen = new Set<string>()
    for (const c of out.changes) {
      expect(c.direction).toBe(RANK[c.after] < RANK[c.before] ? 'less' : 'more')
      expect(c.people.length).toBe(Math.min(c.count, EDIT_PEOPLE))
      if (c.direction === 'less') less += c.count
      else more += c.count
      const who = [...want].filter(([, w]) => w.before === c.before && w.after === c.after).map(([id]) => people.find((p) => p.id === id)!).sort(byPerson)
      expect(c.count, `${world} ${c.before}→${c.after}`).toBe(who.length)
      expect(c.people.map((u) => u.id)).toEqual(who.slice(0, EDIT_PEOPLE).map((p) => p.id))
      expect(seen.has(`${c.before}${c.after}`)).toBe(false)
      seen.add(`${c.before}${c.after}`)
    }
    expect(less + more).toBe(want.size)
    expect(out.less).toBe(less)
    expect(out.more).toBe(more)
    // the rule folders below that change: every one in the tree's order (the first 20), how many lose and gain there,
    // the first five names
    const moved = ruleBelow.map((q) => {
      const who = [...want].filter(([, w]) => w.below.includes(q)).map(([id]) => people.find((p) => p.id === id)!).sort(byPerson)
      return { path: q, less: who.filter((p) => RANK[want.get(p.id)!.after] < RANK[want.get(p.id)!.before]).length, more: who.filter((p) => RANK[want.get(p.id)!.after] > RANK[want.get(p.id)!.before]).length, people: who.slice(0, EDIT_BELOW_PEOPLE).map((p) => ({ id: p.id, name: p.name })) }
    }).filter((x) => x.less + x.more)
    expect(out.below, `${world} at ${at}`).toEqual(moved.slice(0, EDIT_BELOW))
    expect(out.belowMore).toBe(Math.max(0, moved.length - EDIT_BELOW))
    // losses first
    const dirs = out.changes.map((c) => c.direction)
    expect(dirs).toEqual([...dirs].sort((x, y) => (x === y ? 0 : x === 'less' ? -1 : 1)))
    // "follow the folder above": who with no rules of its own there
    expect(out.above).toEqual(at === '' ? null : whoAt({ rules: withRules(rules, at, []), people, groupName: (id) => `G ${id}`, personName: (id) => `U ${id}` }, segsOf(at)))
    expect(out.hash).toBe(rulesHash(rules.rulesAt(at)))
    changed += want.size
    below += [...want.values()].filter((w) => w.below.length).length
  }
  // the worlds did reach both cases
  expect(changed).toBeGreaterThan(500)
  expect(below).toBeGreaterThan(50)
})

test('converting old role rows changes nobody: member X becomes everyone X (replacing an everyone row), admin rows go', () => {
  for (let world = 0; world < 300; world++) {
    const groups = ['g0', 'g1', 'g2']
    const people: Principal[] = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, role: i === 0 ? 'owner' : i === 1 ? 'admin' : 'member', groups: groups.filter(() => rand() < 0.4) }))
    const rows: ConstructorParameters<typeof RuleSet>[0] = []
    for (const f of ['', 'a', 'a/b', 'a/b/c']) {
      if (rand() < 0.4) continue
      if (rand() < 0.6) rows.push({ path: f, subject_type: 'role', subject_id: 'member', access: pick(ACCESS) })
      if (rand() < 0.6) rows.push({ path: f, subject_type: 'role', subject_id: 'admin', access: pick(ACCESS) })
      if (rand() < 0.6) rows.push({ path: f, subject_type: 'everyone', subject_id: null, access: pick(ACCESS) })
      if (rand() < 0.5) rows.push({ path: f, subject_type: 'group', subject_id: pick(groups), access: pick(ACCESS) })
      if (rand() < 0.3) rows.push({ path: f, subject_type: 'user', subject_id: pick(people).id, access: pick(ACCESS) })
    }
    const rules = new RuleSet(rows)
    const at = pick(['', 'a', 'a/b', 'a/b/c'])
    const now = rules.rulesAt(at)
    // the conversion the panel makes (web/src/lib/access-edit.ts): the member row's access, else the everyone row's
    const member = now.find((r) => r.subjectType === 'role' && r.subjectId === 'member')
    const every = member ?? now.find((r) => r.subjectType === 'everyone')
    const converted = [...now.filter((r) => r.subjectType === 'user' || r.subjectType === 'group'), ...(every ? [rule('everyone', null, every.access)] : [])]
    const out = editPreview({ rules, people, groupName: () => null, personName: () => null }, at, converted, { team: null })
    expect(out.changes, `${world} ${JSON.stringify(now)}`).toEqual([])
    expect([out.less, out.more]).toEqual([0, 0])
  }
})

// ---------------- the API ----------------

describe('the edit panel through the API', () => {
  let h: Harness
  let owner: Client
  let admin: Client
  let alice: { client: Client; id: string }
  let sales: string
  beforeAll(async () => {
    h = await harness('access-edit')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
    sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
    alice = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
    await addMember(h, owner, { username: 'bob' })
    await addMember(h, owner, { username: 'carl', groupIds: [sales] })
    await admin.call('POST', '/api/admin/folders', { path: 'docs/team', rules: [rule('group', sales, 'write')] })
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'docs', 'plain'), { recursive: true })
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'connected', 'nas', 'sub'), { recursive: true })
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'connected', 'other'), { recursive: true })
    h.ctx.db.query('INSERT INTO connected_folders (id, name, source) VALUES (?, ?, ?)').run(newId(), 'nas', '/Volumes/nas')
  })
  afterAll(() => h.close())
  const preview = async (p: string, rules: unknown[], as = admin) => FolderEditPreview.parse(await as.call('POST', '/api/admin/access/edit-preview', { path: p, rules }))
  const folders = async () => (await admin.call('GET', '/api/admin/folders')).items as Folder[]
  const row = async (p: string) => (await folders()).find((f) => f.path === p)
  const access = (id: string, p: string) => h.ctx.files.rules().access(h.ctx.files.principal(id), segsOf(p))

  test('write → read is a loss; everyone named; the save button counts them', async () => {
    // shared: everyone writes (the default)
    const r = await preview('shared', [rule('everyone', null, 'read')])
    expect(r.path).toBe('shared')
    expect(r.exists).toBe(true)
    expect(r.less).toBe(3)
    expect(r.more).toBe(0)
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0]).toMatchObject({ direction: 'less', before: 'write', after: 'read', count: 3, chatsReset: 0 })
    expect(r.changes[0]!.people.map((u) => u.id)).toEqual(['alice', 'bob', 'carl'])
    // reading stays: no warning about the team's files
    expect(r.warnings).toEqual([])
    // nothing saved
    expect(access('bob', 'shared')).toBe('write')
  })

  test('gains, and folders below that change by the same step: bob reads docs/team through docs, the group keeps its own', async () => {
    const r = await preview('docs', [rule('everyone', null, 'read')])
    expect(r.less).toBe(0)
    expect(r.more).toBe(3)
    expect(r.changes).toEqual([{ direction: 'more', before: 'none', after: 'read', people: ['alice', 'bob', 'carl'].map((id) => ({ id, name: id.toUpperCase() })), count: 3, chatsReset: 0 }])
    // bob is not in Sales: docs/team's rule is not for him, so he reads there too; Sales keeps its own rule there
    expect(r.below).toEqual([{ path: 'docs/team', less: 0, more: 1, people: [{ id: 'bob', name: 'BOB' }] }])
    expect(r.belowMore).toBe(0)
    expect(r.next.some((w) => w.access === 'read' && w.subject?.type === 'everyone')).toBe(true)
    expect(r.now.every((w) => w.access === 'none' || w.reason === 'owner-admin')).toBe(true)
  })

  test('"follow the folder above" says what the folder gets with no rules of its own; the root has none above', async () => {
    const r = await preview('docs/team', [rule('group', sales, 'write')])
    expect(r.changes).toEqual([])
    // above docs/team: no rule anywhere, so only the owner and admins
    expect(r.above!.filter((w) => w.reason === 'rule')).toEqual([])
    expect(r.above!.find((w) => w.reason === 'no-rule')?.count).toBe(3)
    // shared's "above" is the root: nothing there either; with a root rule it is the root's
    await admin.call('POST', '/api/admin/folders', { path: '', rules: [rule('everyone', null, 'read')] })
    const s = await preview('shared', [rule('everyone', null, 'write')])
    expect(s.above!.find((w) => w.reason === 'rule')).toMatchObject({ folder: '', access: 'read', count: 3 })
    expect((await preview('', [rule('everyone', null, 'read')])).above).toBeNull()
    const root = (await row(''))!
    await admin.call('PUT', `/api/admin/folders/${root.id}/rules`, { rules: [], expectedHash: root.rulesHash })
  })

  test('role rows converted change nothing: skills\' default admin row dropped, a member row as everyone', async () => {
    const skills = (await row('skills'))!
    expect(skills.rules.map((r) => `${r.subjectType}:${r.subjectId}:${r.access}`).sort()).toEqual(['everyone:null:read', 'role:admin:write'])
    const r = await preview('skills', [rule('everyone', null, 'read')])
    expect([r.changes, r.less, r.more, r.warnings]).toEqual([[], 0, 0, []])
    await admin.call('POST', '/api/admin/folders', { path: 'docs/old', rules: [rule('role', 'member', 'write'), rule('everyone', null, 'none'), rule('role', 'admin', 'none')] })
    const o = await preview('docs/old', [rule('everyone', null, 'write')])
    expect([o.changes, o.less, o.more]).toEqual([[], 0, 0])
  })

  test('warnings: members\' AI losing the team\'s files or instructions; everyone writing in skills; a root rule for everyone', async () => {
    const shared = await preview('shared', [rule('everyone', null, 'none'), rule('group', sales, 'write')])
    expect(shared.warnings).toEqual([{ kind: 'team-files', count: 1 }])
    const skills = await preview('skills', [rule('everyone', null, 'none')])
    expect(skills.warnings).toEqual([{ kind: 'team-instructions', count: 3 }])
    expect(skills.changes[0]).toMatchObject({ direction: 'less', before: 'read', after: 'none', count: 3 })
    const sub = await preview('skills/finance', [rule('everyone', null, 'write')])
    expect(sub.warnings).toEqual([{ kind: 'skills-everyone-writes', count: 3 }])
    // a group writing there is how skill managers work: no warning
    expect((await preview('skills/finance', [rule('group', sales, 'write')])).warnings).toEqual([])
    const root = await preview('', [rule('everyone', null, 'read')])
    expect(root.warnings).toEqual([{ kind: 'root-everyone', count: 3 }])
    expect((await preview('', [rule('everyone', null, 'none')])).warnings).toEqual([])
  })

  test('connected folders and what is inside them say so; a folder that is not there answers as it would be', async () => {
    expect((await preview('connected/nas', [rule('everyone', null, 'read')])).connected).toBe(true)
    expect((await preview('connected/nas/sub', [])).connected).toBe(true)
    expect((await preview('connected/other', [])).connected).toBe(false)
    expect((await preview('connected', [])).connected).toBe(false)
    const missing = await preview('docs/not-yet', [rule('everyone', null, 'read')])
    expect(missing.exists).toBe(false)
    expect(missing.hash).toBe(rulesHash([]))
    expect(missing.more).toBe(3)
  })

  test('chats that start a fresh session are counted for people who lose read', async () => {
    const chat = newId()
    h.ctx.db.query("INSERT INTO chats (id, user_id, engine_session_id) VALUES (?, ?, 'sess-edit')").run(chat, alice.id)
    const r = await preview('docs/team', [])
    const lost = r.changes.find((c) => c.people.some((u) => u.id === alice.id))!
    expect(lost).toMatchObject({ before: 'write', after: 'none', chatsReset: 1, count: 2 })
    h.ctx.db.query('DELETE FROM chats WHERE id = ?').run(chat)
  })

  test('refused: inside users/, .system/, a temp name, an unknown group; members cannot ask', async () => {
    for (const p of ['users/alice', 'users', 'Users/alice/x']) {
      const r = await admin.try('POST', '/api/admin/access/edit-preview', { path: p, rules: [] })
      expect(r.status, p).toBe(400)
      expect(r.body.error.message, p).toBe(msg('rulesInUsers', 'ko'))
    }
    for (const p of ['.system/trash', 'docs/.MYCEL-TMP-x']) expect((await admin.try('POST', '/api/admin/access/edit-preview', { path: p, rules: [] })).status, p).toBe(400)
    expect((await admin.try('POST', '/api/admin/access/edit-preview', { path: 'docs', rules: [rule('group', newId(), 'read')] })).status).toBe(400)
    expect((await alice.client.try('POST', '/api/admin/access/edit-preview', { path: 'docs', rules: [] })).status).toBe(403)
  })

  test('a save over another admin\'s change is refused with 409 and changes nothing; the right hash saves', async () => {
    const team = (await row('docs/team'))!
    expect(team.rulesHash).toBe(rulesHash(team.rules))
    expect((await preview('docs/team', [])).hash).toBe(team.rulesHash!)
    // another admin adds bob meanwhile
    await owner.call('PUT', `/api/admin/folders/${team.id}/rules`, { rules: [rule('group', sales, 'write'), rule('user', 'bob', 'read')], expectedHash: team.rulesHash })
    const stale = await admin.try('PUT', `/api/admin/folders/${team.id}/rules`, { rules: [rule('group', sales, 'read')], expectedHash: team.rulesHash })
    expect(stale.status).toBe(409)
    expect(stale.body.error.params).toEqual({ reason: 'rules_changed' })
    expect(stale.body.error.message).toBe(msg('rulesChanged', 'ko'))
    expect(access('bob', 'docs/team')).toBe('read')
    expect(access('alice', 'docs/team')).toBe('write')
    // the panel asks again, sees the new rules and hash, and saves over them knowingly
    const again = await preview('docs/team', [rule('group', sales, 'read')])
    expect(again.current.map((r) => r.subjectId).sort()).toEqual(['bob', sales].sort())
    const saved = await admin.call('PUT', `/api/admin/folders/${team.id}/rules`, { rules: [rule('group', sales, 'read')], expectedHash: again.hash })
    expect(saved.rulesHash).toBe(rulesHash([rule('group', sales, 'read')]))
    expect(access('alice', 'docs/team')).toBe('read')
    // other callers that send no hash replace the rules as before
    await admin.call('PUT', `/api/admin/folders/${team.id}/rules`, { rules: [rule('group', sales, 'write')] })
    expect(access('alice', 'docs/team')).toBe('write')
  })

  test('the stage 1 guards still apply with the right hash; the Members skill-manager switch counts as a change', async () => {
    const shared = (await row('shared'))!
    const empty = await admin.try('PUT', `/api/admin/folders/${shared.id}/rules`, { rules: [], expectedHash: shared.rulesHash })
    expect(empty.status).toBe(400)
    expect(empty.body.error.message).toBe(msg('teamFolderKeepsRules', 'ko'))
    const skills = (await row('skills'))!
    await admin.call('PUT', '/api/admin/skill-managers', { subjectType: 'user', subjectId: 'bob', path: 'skills', enabled: true })
    const stale = await admin.try('PUT', `/api/admin/folders/${skills.id}/rules`, { rules: [rule('everyone', null, 'read')], expectedHash: skills.rulesHash })
    expect(stale.status).toBe(409)
    expect(access('bob', 'skills')).toBe('write')
    await admin.call('PUT', '/api/admin/skill-managers', { subjectType: 'user', subjectId: 'bob', path: 'skills', enabled: false })
  })

  test('the first rules of a folder: the hash of none saves; rules made meanwhile are refused before anything is made', async () => {
    const none = rulesHash([])
    const made = await admin.call('POST', '/api/admin/folders', { path: 'docs/plain', create: false, rules: [rule('everyone', null, 'read')], expectedHash: none })
    expect(made.rulesHash).toBe(rulesHash([rule('everyone', null, 'read')]))
    const late = await admin.try('POST', '/api/admin/folders', { path: 'docs/plain', create: false, rules: [rule('everyone', null, 'write')], expectedHash: none })
    expect(late.status).toBe(409)
    expect(late.body.error.params).toEqual({ reason: 'rules_changed' })
    expect(access('bob', 'docs/plain')).toBe('read')
    // nothing made on disk for a refused new folder
    const refused = await admin.try('POST', '/api/admin/folders', { path: 'docs/brand-new', create: true, rules: [rule('everyone', null, 'read')], expectedHash: rulesHash([rule('everyone', null, 'read')]) })
    expect(refused.status).toBe(409)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'docs', 'brand-new'))).toBe(false)
  })
})
