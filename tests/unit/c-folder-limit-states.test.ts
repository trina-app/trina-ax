// Limit access in every state the Share dialog shows (plan docs/AGENTS/plan/20261125-1044-folder-restrict-honest.md):
// the server's answer the dialog reads (`everyoneAbove`, `changes`: who loses access), the stored rules above, and what a
// save really does, on the real permission function. The dialog greys the switch (while it is off) exactly when nothing
// above lets anyone in but the owner and admins, by the stored rules (people not there yet count); then turning it on
// must change nobody's access, and when something above lets people in it must cut exactly who the preview named.
// Fixture: olga = owner, adam = admin; alice in Sales, bob in no group. shared/ everyone edits (the default).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { FolderEditPreview } from '@mycel/shared/api'
import { folderAccessProblems } from '../../server/src/policy/invariants'
import { aboveAdmits } from '../../web/src/lib/folder-sharing'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client
let admin: Client
let alice: Client
let sales: string
const ids: Record<string, string> = {}
beforeAll(async () => {
  h = await harness('folder-limit-states')
  owner = await withOwner(h)
  admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  const a = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
  alice = a.client
  ids.alice = a.id
  ids.bob = (await addMember(h, owner, { username: 'bob' })).id
  for (const d of ['shared/Finance', 'shared/Open', 'board/Minutes']) fs.mkdirSync(path.join(h.ctx.files.fx.root, ...d.split('/')), { recursive: true })
}, 60_000)
afterAll(() => { expect(folderAccessProblems(h.ctx.db)).toEqual([]); h.close() })

type Row = { id: string; path: string; rulesHash: string; limited?: boolean; rules: { subjectType: string; subjectId: string | null; access: 'none' | 'read' | 'write' }[] }
const folderRow = async (p: string) => ((await admin.call('GET', '/api/admin/folders')).items as Row[]).find((f) => f.path === p)
const preview = async (p: string, rules: unknown[], limited?: boolean) => (await admin.call('POST', '/api/admin/access/edit-preview', { path: p, rules, ...(limited !== undefined ? { limited } : {}) })) as FolderEditPreview
/** who can open `p` now, by user id (the owner and admins left out: they always can) */
const access = async (p: string) => {
  const r = await admin.call('GET', '/api/admin/access/folder?path=' + encodeURIComponent(p) + '&limit=2000') as { people: { user: { id: string }; role: string; access: string }[] }
  return Object.fromEntries(r.people.filter((x) => x.role === 'member').map((x) => [x.user.id, x.access]))
}
/** the dialog's test (FolderSharing limitIdle): something above lets in anyone but the owner and admins: General access
 * from above, or a stored rule on the way up (people not there yet count) */
const folders = async () => (await admin.call('GET', '/api/admin/folders')).items as Row[]
const aboveLetsInAt = async (path: string, p: FolderEditPreview) => (p.everyoneAbove?.access ?? 'none') !== 'none' || aboveAdmits(await folders(), path)
const lose = (p: FolderEditPreview) => p.changes.filter((c) => c.before !== 'none' && c.after === 'none').flatMap((c) => c.people.map((x) => x.id)).sort()
/** save `rules` and the limit on `p` (a new row or the one there), as the dialog does */
const save = async (p: string, rules: unknown[], limited: boolean) => {
  const row = await folderRow(p)
  if (row) await admin.call('PUT', `/api/admin/folders/${row.id}/rules`, { rules, limited, expectedHash: row.rulesHash })
  else await admin.call('POST', '/api/admin/folders', { path: p, create: false, rules, limited })
}

describe('the folder above is open (shared/ as a new team has it)', () => {
  test('nobody added: the switch matters; on cuts exactly who the preview named, off gives it back', async () => {
    const before = await preview('shared/Open', [])
    expect(await aboveLetsInAt('shared/Open', before)).toBe(true)
    const on = await preview('shared/Open', [], true)
    expect(lose(on)).toEqual([ids.alice!, ids.bob!].sort())
    await save('shared/Open', [], true)
    expect(await access('shared/Open')).toEqual({ [ids.alice!]: 'none', [ids.bob!]: 'none' })
    // a member's own read agrees
    expect((await alice.try('GET', '/api/files?path=' + encodeURIComponent('shared/Open'))).status).not.toBe(200)
    await save('shared/Open', [], false)
    expect(await access('shared/Open')).toEqual({ [ids.alice!]: 'write', [ids.bob!]: 'write' })
  })

  test('a person added: on keeps them (as added) and cuts the others', async () => {
    const rules = [{ subjectType: 'user', subjectId: ids.alice, access: 'read' }]
    expect(lose(await preview('shared/Open', rules, true))).toEqual([ids.bob!])
    await save('shared/Open', rules, true)
    expect(await access('shared/Open')).toEqual({ [ids.alice!]: 'read', [ids.bob!]: 'none' })
    // off: access adds up again, Alice's row is raised to what shared/ gives her (12-A)
    await save('shared/Open', rules, false)
    expect(await access('shared/Open')).toEqual({ [ids.alice!]: 'write', [ids.bob!]: 'write' })
  })
})

describe('the folder above lets in only the owner and admins', () => {
  test('a top folder under a team root with no rules: the limit changes nobody, saved or not', async () => {
    await save('board', [{ subjectType: 'user', subjectId: ids.alice, access: 'write' }], true)
    const p = await preview('board', [{ subjectType: 'user', subjectId: ids.alice, access: 'write' }], false)
    expect(await aboveLetsInAt('board', p)).toBe(false)
    expect(p.changes).toEqual([])
    await save('board', [{ subjectType: 'user', subjectId: ids.alice, access: 'write' }], false)
    expect(await access('board')).toEqual({ [ids.alice!]: 'write', [ids.bob!]: 'none' })
  })

  test('a subfolder of a restricted folder, nobody added and people added: on and off change nobody', async () => {
    // board lets in Alice by name: limit on Minutes matters for her
    expect(await aboveLetsInAt('board/Minutes', await preview('board/Minutes', []))).toBe(true)
    // board restricted to the owner and admins
    await save('board', [], true)
    const idle = await preview('board/Minutes', [])
    expect(await aboveLetsInAt('board/Minutes', idle)).toBe(false)
    expect((await preview('board/Minutes', [], true)).changes).toEqual([])
    const bob = [{ subjectType: 'user', subjectId: ids.bob, access: 'read' }]
    expect((await preview('board/Minutes', bob, true)).changes).toEqual((await preview('board/Minutes', bob, false)).changes)
    await save('board/Minutes', bob, true)
    const limitedAccess = await access('board/Minutes')
    await save('board/Minutes', bob, false)
    expect(await access('board/Minutes')).toEqual(limitedAccess)
    expect(limitedAccess).toEqual({ [ids.alice!]: 'none', [ids.bob!]: 'read' })
  })

  test('shared/ restricted by an admin (the owner\'s report): its subfolder follows it, and opens again with it', async () => {
    await save('shared', [], true)
    const fin = await preview('shared/Finance', [])
    expect(fin.everyoneAbove?.access).toBe('none')
    expect(await aboveLetsInAt('shared/Finance', fin)).toBe(false)
    expect((await preview('shared/Finance', [], true)).changes).toEqual([])
    expect(await access('shared/Finance')).toEqual({ [ids.alice!]: 'none', [ids.bob!]: 'none' })
    // the audit row says who restricted it
    const row = h.ctx.db.query("SELECT actor_id FROM audit_log WHERE action = 'folder.rules' AND target = 'shared' ORDER BY rowid DESC LIMIT 1").get() as { actor_id: string } | null
    expect(row?.actor_id).toBe((h.ctx.db.query("SELECT id FROM users WHERE username = 'adam'").get() as { id: string }).id)
    // "Change there": shared/ back to everyone edits; Finance follows, and the limit matters there again
    await save('shared', [{ subjectType: 'everyone', subjectId: null, access: 'write' }], false)
    const open = await preview('shared/Finance', [])
    expect(open.everyoneAbove).toEqual({ access: 'write', folder: 'shared' })
    expect(await aboveLetsInAt('shared/Finance', open)).toBe(true)
    expect(await access('shared/Finance')).toEqual({ [ids.alice!]: 'write', [ids.bob!]: 'write' })
  })
})

describe('a member', () => {
  test('cannot read the answer or save the limit', async () => {
    expect((await alice.try('POST', '/api/admin/access/edit-preview', { path: 'shared/Finance', rules: [], limited: true })).status).toBe(403)
    expect((await alice.try('POST', '/api/admin/folders', { path: 'shared/Finance', create: false, rules: [], limited: true })).status).toBe(403)
    expect(await folderRow('shared/Finance')).toBeUndefined()
  })
})

describe('people the head count cannot see (review of #590)', () => {
  test('a new team with no members yet: shared/ is open, so its subfolder\'s limit is not idle, and saving it limits', async () => {
    const h2 = await harness('folder-limit-states-empty')
    try {
      const own = await withOwner(h2)
      fs.mkdirSync(path.join(h2.ctx.files.fx.root, 'shared', 'Finance'), { recursive: true })
      const p = await own.call('POST', '/api/admin/access/edit-preview', { path: 'shared/Finance', rules: [] }) as FolderEditPreview
      // nobody but the owner today: no head count from above, yet shared/ lets everyone in
      expect((p.above ?? []).some((w) => w.reason === 'rule' && w.access !== 'none' && w.count > 0)).toBe(false)
      expect(p.everyoneAbove).toEqual({ access: 'write', folder: 'shared' })
      await own.call('POST', '/api/admin/folders', { path: 'shared/Finance', create: false, rules: [], limited: true })
      // a member who joins later cannot open it
      const late = await addMember(h2, own, { username: 'late' })
      const r = await own.call('GET', '/api/admin/access/folder?path=' + encodeURIComponent('shared/Finance')) as { people: { user: { id: string }; access: string }[] }
      expect(r.people.find((x) => x.user.id === late.id)?.access).toBe('none')
    } finally { h2.close() }
  }, 60_000)

  test('an empty group named above: the limit is not idle (it stops whoever joins the group)', async () => {
    const empty = (await admin.call('POST', '/api/admin/groups', { name: 'Board' })).id
    await save('board', [{ subjectType: 'group', subjectId: empty, access: 'read' }], true)
    const p = await preview('board/Minutes', [])
    expect((p.above ?? []).some((w) => w.reason === 'rule' && w.access !== 'none' && w.count > 0)).toBe(false)
    expect(await aboveLetsInAt('board/Minutes', p)).toBe(true)
  })
})
