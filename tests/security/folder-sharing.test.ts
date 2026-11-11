// The Files page's "Who can open it" panel, where admins change who can open a folder in place (docs/DECISIONS.md
// "Who can open it, like Drive's Share"; plan docs/AGENTS/plan/20261110-1715-drive-like-access.md, security review).
// What must hold:
//  1. A member learns nothing new: every read and write the admin panel makes is refused to them, and what they do get
//     (GET /api/files/audience) has the same fields as before, no split and nothing from the edit preview.
//  2. Saving in place keeps every server check: the panel saves only through PUT /api/admin/folders/:id/rules and
//     POST /api/admin/folders, which refuse users/, an empty shared/ or skills/, unknown or repeated subjects, more than
//     200 rules, a save over another admin's change (409 rules_changed), a rule row made meanwhile (409
//     folder_exists), and write the audit row.
//  3. A change that gives more access asks first: the panel's decision (web/src/lib/folder-sharing.ts saveAsk,
//     raisesAccess), fed with the real server's answers, asks for every widening, including the ones the server's head
//     count misses (switched-off people, "everyone" when today every member is named by a group), and not for a change
//     that only narrows. The confirm is the admin's second look, not a boundary: only admins can save at all (1).
// Fixture (the harness Admin's own editor tests use): olga = owner, adam = admin; alice, carl = Sales; bob; shared/
// everyone writes (the default).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { FolderEditPreview } from '@mycel/shared/api'
import { draftOf, rulesOf, type Draft } from '../../web/src/lib/access-edit'
import { raisesAccess, saveAsk } from '../../web/src/lib/folder-sharing'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'

let h: Harness
let owner: Client
let admin: Client
let alice: Client
let sales: string
beforeAll(async () => {
  h = await harness('sec-folder-sharing')
  owner = await withOwner(h)
  admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  alice = (await addMember(h, owner, { username: 'alice', groupIds: [sales] })).client
  await addMember(h, owner, { username: 'bob' })
  await addMember(h, owner, { username: 'carl', groupIds: [sales] })
  for (const d of ['docs/team', 'docs/plain']) fs.mkdirSync(path.join(h.ctx.files.fx.root, ...d.split('/')), { recursive: true })
  await admin.call('POST', '/api/admin/folders', { path: 'docs/team', rules: [{ subjectType: 'group', subjectId: sales, access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }] })
  // five sign-ins with real password hashing: slow on a busy machine
}, 60_000)
afterAll(() => h.close())
const q = (p: string) => '?path=' + encodeURIComponent(p)
type Row = { id: string; path: string; rulesHash: string; rules: { subjectType: string; subjectId: string | null; access: string }[] }
const folderRow = async (p: string) => ((await admin.call('GET', '/api/admin/folders')).items as Row[]).find((f) => f.path === p)
const preview = async (p: string, rules: unknown[]) => (await admin.call('POST', '/api/admin/access/edit-preview', { path: p, rules })) as FolderEditPreview
const every = (access: string) => ({ subjectType: 'everyone', subjectId: null, access })
const user = (id: string, access: string) => ({ subjectType: 'user', subjectId: id, access })
const plain = (r: Row['rules'][number]) => ({ subjectType: r.subjectType, subjectId: r.subjectId, access: r.access })

describe('1. a member learns nothing new', () => {
  test('every read and write of the admin panel is refused to a member, and the refusal names nothing', async () => {
    const shared = await folderRow('shared')
    const calls = [
      alice.try('GET', '/api/admin/folders'),
      alice.try('GET', '/api/admin/users'),
      alice.try('GET', '/api/admin/groups'),
      alice.try('GET', '/api/admin/access/tree' + q('shared') + '&rules=1&limit=1'),
      alice.try('POST', '/api/admin/access/edit-preview', { path: 'shared', rules: [every('write')] }),
      alice.try('PUT', `/api/admin/folders/${shared!.id}/rules`, { rules: [every('write')], expectedHash: shared!.rulesHash }),
      alice.try('POST', '/api/admin/folders', { path: 'docs/plain', create: false, rules: [every('read')] }),
    ]
    for (const r of await Promise.all(calls)) {
      expect(r.status).toBe(403)
      const text = JSON.stringify(r.body)
      for (const word of ['everyoneAbove', 'BOB', 'CARL', 'ADAM', 'Olga', 'Sales', 'rulesHash', '"next"']) expect(text).not.toContain(word)
    }
    // and nothing changed
    expect((await folderRow('shared'))!.rulesHash).toBe(shared!.rulesHash)
    expect(await folderRow('docs/plain')).toBeUndefined()
  })

  test('what a member gets is what it was: the count and whether it is everyone, where they can write; no split', async () => {
    const r = await alice.call('GET', '/api/files/audience' + q('shared'))
    expect(r).toEqual({ path: 'shared', access: 'write', people: 5, everyone: true })
    const team = await alice.call('GET', '/api/files/audience' + q('docs/team'))
    expect(Object.keys(team).sort()).toEqual(['access', 'everyone', 'path', 'people'])
    // the owner and admins get the split, members never
    expect(Object.keys(await admin.call('GET', '/api/files/audience' + q('docs/team')))).toContain('split')
  })
})

describe('2. saving in place keeps every server check', () => {
  test('shared/ keeps a rule; unknown and repeated subjects, users/ and more than 200 rules are refused', async () => {
    const shared = await folderRow('shared')
    const id = shared!.id
    expect((await admin.try('PUT', `/api/admin/folders/${id}/rules`, { rules: [], expectedHash: shared!.rulesHash })).status).toBe(400)
    expect((await admin.try('PUT', `/api/admin/folders/${id}/rules`, { rules: [user('nobody-here', 'read')], expectedHash: shared!.rulesHash })).status).toBe(400)
    expect((await admin.try('PUT', `/api/admin/folders/${id}/rules`, { rules: [user('bob', 'read'), user('bob', 'write')], expectedHash: shared!.rulesHash })).status).toBe(400)
    expect((await admin.try('POST', '/api/admin/folders', { path: 'users/alice/x', create: false, rules: [every('read')] })).status).toBe(400)
    const many = Array.from({ length: 201 }, (_, i) => user(`u${i}`, 'read'))
    expect((await admin.try('POST', '/api/admin/folders', { path: 'docs/plain', create: false, rules: many })).status).toBe(400)
    // nothing of it was saved
    expect((await folderRow('shared'))!.rulesHash).toBe(shared!.rulesHash)
    expect(await folderRow('docs/plain')).toBeUndefined()
  })

  test('another admin\'s change in between is refused (409 rules_changed) and changes nothing', async () => {
    const team = await folderRow('docs/team')
    // the owner changes it first
    await owner.call('PUT', `/api/admin/folders/${team!.id}/rules`, { rules: [...team!.rules.map(plain), user('bob', 'read')], expectedHash: team!.rulesHash })
    const late = await admin.try('PUT', `/api/admin/folders/${team!.id}/rules`, { rules: [every('write')], expectedHash: team!.rulesHash })
    expect(late.status).toBe(409)
    expect(late.body.error.params.reason).toBe('rules_changed')
    expect((await folderRow('docs/team'))!.rules.map((r) => `${r.subjectType}:${r.subjectId}:${r.access}`).sort()).toEqual(['everyone::none', `group:${sales}:write`, 'user:bob:read'].map((x) => x.replace('everyone::', 'everyone:null:')).sort())
  })

  test('a rule row made meanwhile: the hash it started from refuses it, and without one it is folder_exists', async () => {
    const none = (await preview('docs/plain', [])).hash
    await owner.call('POST', '/api/admin/folders', { path: 'docs/plain', create: false, rules: [user('carl', 'write')], expectedHash: none })
    const withHash = await admin.try('POST', '/api/admin/folders', { path: 'docs/plain', create: false, rules: [every('read')], expectedHash: none })
    expect(withHash.status).toBe(409)
    expect(withHash.body.error.params.reason).toBe('rules_changed')
    const bare = await admin.try('POST', '/api/admin/folders', { path: 'docs/plain', create: false, rules: [every('read')] })
    expect(bare.status).toBe(409)
    expect(bare.body.error.params.reason).toBe('folder_exists')
  })

  test('a save is audited with the rules before and after, by the admin who saved', async () => {
    const team = await folderRow('docs/team')
    await admin.call('PUT', `/api/admin/folders/${team!.id}/rules`, { rules: [...team!.rules.map(plain).filter((r) => r.subjectId !== 'bob'), user('alice', 'read')], expectedHash: team!.rulesHash })
    const adamId = (h.ctx.db.query("SELECT id FROM users WHERE username = 'adam'").get() as { id: string }).id
    const row = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'folder.rules' AND target = 'docs/team' ORDER BY rowid DESC LIMIT 1").get() as { actor_id: string; detail: string } | null
    expect(row?.actor_id).toBe(adamId)
    expect(JSON.parse(row!.detail).after).toContainEqual(user('alice', 'read'))
    expect(JSON.parse(row!.detail).before).toContainEqual(user('bob', 'read'))
  })
})

describe('3. a change that gives more access asks first', () => {
  /** what the panel would do with the server's answer for this draft of `p`: ask (widen / narrow) or save straight */
  const decide = async (p: string, change: (d: Draft) => Draft, o: { off?: string[] } = {}) => {
    const row = await folderRow(p)
    const stored = draftOf(row?.rules ?? [], false).draft
    const draft = change(stored)
    const answer = await preview(p, rulesOf(draft, { root: false }))
    const users = new Map(((await admin.call('GET', '/api/admin/users')).items as { id: string; username: string; status: string }[]).map((u) => [u.id, { status: o.off?.includes(u.username) ? 'disabled' as const : u.status as 'active' }]))
    const groups = new Map(((await admin.call('GET', '/api/admin/groups')).items as { id: string; memberIds: string[] }[]).map((g) => [g.id, { memberIds: g.memberIds }]))
    return saveAsk(answer, raisesAccess({ stored, draft, above: answer.everyoneAbove?.access ?? 'none', users, groups }))
  }
  const idOf = (username: string) => (h.ctx.db.query('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id

  test('adding someone who could not open it asks; changing nothing does not', async () => {
    expect((await decide('docs/team', (d) => ({ ...d, named: [...d.named, { subjectType: 'user', subjectId: idOf('bob'), access: 'read' }] })))?.widen).toBe(true)
    expect(await decide('docs/team', (d) => d)).toBeNull()
  })

  test('view → edit asks; edit → view (only narrowing) saves straight', async () => {
    expect((await decide('docs/team', (d) => ({ ...d, named: d.named.map((n) => (n.subjectId === idOf('alice') ? { ...n, access: 'write' as const } : n)) })))?.widen).toBe(true)
    const narrowed = await decide('docs/team', (d) => ({ ...d, named: d.named.map((n) => (n.subjectType === 'group' ? { ...n, access: 'read' as const } : n)) }))
    expect(narrowed).toBeNull()
  })

  test('"everyone can edit" asks even when today every member is named by a group (the head count says 0)', async () => {
    const all = (await admin.call('POST', '/api/admin/groups', { name: 'Everybody', memberIds: ['alice', 'bob', 'carl'].map(idOf) })).id
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'docs', 'all'), { recursive: true })
    await admin.call('POST', '/api/admin/folders', { path: 'docs/all', create: false, rules: [{ subjectType: 'group', subjectId: all, access: 'write' }, every('none')] })
    const answer = await preview('docs/all', [{ subjectType: 'group', subjectId: all, access: 'write' }, every('write')])
    expect(answer.more).toBe(0)
    expect((await decide('docs/all', (d) => ({ ...d, basic: 'write' })))?.widen).toBe(true)
  })

  test('a switched-off person raised, or their row removed where everyone gets more, asks (they are not counted)', async () => {
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'docs', 'off'), { recursive: true })
    await admin.call('POST', '/api/admin/folders', { path: 'docs/off', create: false, rules: [user(idOf('carl'), 'none'), every('read')] })
    const carl = idOf('carl')
    // carl is switched off in the panel's people list: no head count can see him
    expect((await decide('docs/off', (d) => ({ ...d, named: d.named.filter((n) => n.subjectId !== carl) }), { off: ['carl'] }))?.widen).toBe(true)
    expect((await decide('docs/off', (d) => ({ ...d, named: d.named.map((n) => (n.subjectId === carl ? { ...n, access: 'write' as const } : n)) }), { off: ['carl'] }))?.widen).toBe(true)
  })

  test('taking the team\'s own files from members asks too, in its own words (narrowing)', async () => {
    const ask = await decide('shared', (d) => ({ ...d, basic: 'named' }))
    expect(ask?.widen).toBe(false)
    expect(ask?.narrow.map((w) => w.kind)).toEqual(['team-files'])
  })
})
