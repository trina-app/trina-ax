// A folder in a person's own files, shared with teammates or groups (server/src/files/folder-shares.ts,
// share-places.ts, share-undo.ts, team-files/stream-checked.ts; docs/decisions/20261116-folder-share-server.md).
// What must hold (the tests the security review of the design asked for are marked (R)):
//  1. With the gate closed nobody can share a folder, by any route.
//  2. A shared folder opens only by its link id, for the people on it: names, sizes, times and current bytes. Never by
//     path, never versions, history or text; the folder rules are untouched (admins too stay out of users/<id>/).
//  3. Places the server keeps are never shared, by name in every case, width, Unicode form and language (R).
//  4. The folder's identity: a different folder at the path pauses the share and keeps its people (R); a disk without
//     birth times refuses folder shares (R); the owner resumes.
//  5. A path inside the folder never reaches outside it; links and hard links are neither listed nor served (R); the
//     bytes come from the one checked descriptor (R).
//  6. An owner can always stop, also with the team switch off (files too); a removal can be undone once by its actor.
//  7. The row follows the folder through rename, move, trash, restore and purge; it ends when the folder leaves the
//     owner's shareable places.
// Fixture: olga = owner, adam = admin; alice shares; bob, carl, dana receive; gina is a guest. Sales = { carl }.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ARCHIVE_DIR, FROM_COMPUTER_DIR, PRODUCT } from '@mycel/shared'
import { FOLDER_LIST_PAGE, FOLDER_LIST_SCAN, FOLDER_OPENS_PER_MIN } from '@mycel/shared/api'
import { RuleSet, loadPrincipal } from '../../server/src/policy/access'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { folderStat } from '../../server/src/files/folder-id'
import { fileSharesOf } from '../../server/src/files/shares'
import { folderSharesOf } from '../../server/src/files/folder-shares'
import { openSame, streamChecked } from '../../server/src/team-files/stream-checked'
import { roomsOf } from '../../server/src/rooms/service'
import { componentC } from '../../server/src/team-files/component'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'

let h: Harness
let owner: Client, admin: Client, alice: Client, bob: Client, carl: Client, dana: Client, gina: Client
let ids: Record<'alice' | 'bob' | 'carl' | 'dana' | 'gina', string>
let sales: string
let root: string
const q = (p: string) => '?path=' + encodeURIComponent(p)
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })
const group = (id: string) => ({ subjectType: 'group' as const, subjectId: id })
const mine = (...p: string[]) => ['users', ids.alice, ...p].join('/')
const abs = (rel: string) => path.join(root, ...rel.split('/'))
const mk = (rel: string) => fs.mkdirSync(abs(rel), { recursive: true })
const wr = (rel: string, text: string) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text) }
const budget = () => (roomsOf(h.ctx) as unknown as { sendBudget: Map<string, unknown> }).sendBudget.clear()
const bucket = () => (folderSharesOf(h.ctx) as unknown as { opens: Map<string, unknown> }).opens.clear()
const share = async (c: Client, p: string, add: unknown[], remove: unknown[] = []) => { budget(); return c.call('PUT', '/api/files/shares', { path: p, add, remove }) }
const tryShare = async (c: Client, p: string, body: Record<string, unknown>) => { budget(); return c.try('PUT', '/api/files/shares', { path: p, add: [], remove: [], ...body }) }
const listOf = (c: Client, id: string, sub = '', extra = '') => c.try('GET', `/api/files/shared/${id}/list?sub=${encodeURIComponent(sub)}${extra}`)
const names = async (c: Client, id: string, sub = '') => ((await listOf(c, id, sub)).body.items as { name: string }[]).map((i) => i.name)
const dl = (c: Client, id: string, sub: string) => c.raw('GET', `/api/files/shared/${id}/download?sub=${encodeURIComponent(sub)}`)
const page = (c: Client, id: string) => c.call('GET', `/api/files/shared/${id}`)
const row = (id: string) => h.ctx.db.query('SELECT * FROM file_shares WHERE id = ?').get(id) as { id: string; path: string; state: string; kind: string; paused_at: string | null; folder_id: string | null; owner_id: string } | null
const grants = (id: string) => (h.ctx.db.query('SELECT COUNT(*) n FROM file_share_grants WHERE share_id = ?').get(id) as { n: number }).n
const audits = (action: string, id: string) => h.ctx.db.query('SELECT detail FROM audit_log WHERE action = ? AND target = ? ORDER BY id').all(action, `file-share:${id}`).map((r) => JSON.parse((r as { detail: string }).detail))
const reason = (r: { body: any }) => r.body?.error?.params?.reason
const tick = () => new Promise((r) => setTimeout(r, 5))
const uid = (username: string) => (h.ctx.db.query('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id
/** a guest is refused by the API before the link is looked at, or gets the plain refusal: never the folder */
const closedFor = async (c: Client, id: string) => { const r = await c.try('GET', `/api/files/shared/${id}`); return r.status !== 200 || (r.body.status === 'no_access' && r.body.canAsk === false) }

beforeAll(async () => {
  h = await harness('sec-folder-shares', { folderShares: true })
  root = h.ctx.files.fx.root
  owner = await withOwner(h)
  admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  const al = await addMember(h, owner, { username: 'alice' })
  const b = await addMember(h, owner, { username: 'bob' })
  const c = await addMember(h, owner, { username: 'carl', groupIds: [sales] })
  const d = await addMember(h, owner, { username: 'dana' })
  const g = await addMember(h, owner, { username: 'gina' })
  h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(g.id)
  alice = al.client; bob = b.client; carl = c.client; dana = d.client; gina = g.client
  ids = { alice: al.id, bob: b.id, carl: c.id, dana: d.id, gina: g.id }
}, 120_000)
afterAll(() => h.close())
beforeEach(() => { bucket() })

describe('1. the gate', () => {
  let g: Harness, o: Client, m: Client, mid: string
  beforeAll(async () => {
    g = await harness('sec-folder-shares-gate')
    o = await withOwner(g)
    const a = await addMember(g, o, { username: 'mina' })
    m = a.client; mid = a.id
    fs.mkdirSync(path.join(g.ctx.files.fx.root, 'users', mid, 'Work'), { recursive: true })
    fs.writeFileSync(path.join(g.ctx.files.fx.root, 'users', mid, 'Work', 'a.txt'), 'a')
  }, 60_000)
  afterAll(() => g.close())
  test('closed by default: no route makes a folder share, and the answers are the ones before this work', async () => {
    expect(g.ctx.config.folderShares).toBeUndefined()
    const p = `users/${mid}/Work`
    const put = await m.try('PUT', '/api/files/shares', { path: p, add: [user('someone')], remove: [] })
    expect(put.status).toBe(400)
    expect(reason(put)).toBe('folder_shares_soon')
    for (const body of [{ stop: true }, { resume: true }, { remove: [user('x')] }]) expect(reason(await m.try('PUT', '/api/files/shares', { path: p, add: [], remove: [], ...body }))).toBe('folder_shares_soon')
    const get = await m.try('GET', '/api/files/shares' + '?path=' + encodeURIComponent(p))
    expect(get.status).toBe(400)
    expect(reason(get)).toBe('is_folder')
    const link = await m.try('POST', '/api/files/link', { path: p })
    expect(reason(link)).toBe('is_folder')
    const batch = await m.call('POST', '/api/files/shares/batch', { paths: [p], add: [user(mid)] }).catch((e) => e)
    expect(JSON.stringify(batch)).not.toContain('"shared":["')
    expect((g.ctx.db.query('SELECT COUNT(*) n FROM file_shares').get() as { n: number }).n).toBe(0)
    // the counts answer has no new field while the gate is closed
    expect(await o.call('GET', '/api/admin/file-shares')).toEqual({ files: 0, people: 0 })
    // a listing of the person's own files carries no shared mark
    const tree = await m.call('GET', '/api/files/tree' + '?path=' + encodeURIComponent(`users/${mid}`))
    expect(tree.entries.every((e: { shared?: string }) => e.shared === undefined)).toBe(true)
  })
  test('a folder row cannot be reached even if one existed: every id endpoint needs the row to open', async () => {
    const id = 'A'.repeat(22)
    for (const u of [`/api/files/shared/${id}/list`, `/api/files/shared/${id}/entry?sub=a.txt`, `/api/files/shared/${id}/download?sub=a.txt`]) expect((await m.try('GET', u).catch(() => ({ status: 404 }))).status).toBe(404)
  })
})

describe('2. a shared folder opens by its link, for the people on it, and nothing else does', () => {
  let id: string
  beforeAll(async () => {
    wr(mine('Area51', 'Work', 'plan.txt'), 'the plan')
    wr(mine('Area51', 'Work', 'Q4', 'numbers.csv'), 'a,b\n1,2\n')
    wr(mine('Area51', 'Other', 'private.txt'), 'not shared')
    const v = await share(alice, mine('Area51', 'Work'), [user(ids.bob)])
    id = v.link.id
    expect(v).toMatchObject({ kind: 'folder', mine: true, canShare: true, teamFile: false, holds: { files: 1, folders: 1, more: false } })
    expect(v.people.map((p: { subjectId: string }) => p.subjectId)).toEqual([ids.bob])
  })
  test('the page, the listing, a sub-folder, an entry and the bytes', async () => {
    const v = await page(bob, id)
    expect(v).toEqual({ status: 'open', kind: 'folder', name: 'Work', sharedBy: 'ALICE', mine: false })
    const l = (await listOf(bob, id)).body
    expect(l.crumbs).toEqual(['Work'])
    expect(l.items.map((i: any) => [i.name, i.dir, i.size])).toEqual([['Q4', true, null], ['plan.txt', false, 8]])
    expect(l.next).toBeNull()
    const sub = (await listOf(bob, id, 'Q4')).body
    expect(sub.crumbs).toEqual(['Work', 'Q4'])
    expect(sub.items.map((i: any) => i.name)).toEqual(['numbers.csv'])
    expect((await bob.call('GET', `/api/files/shared/${id}/entry?sub=${encodeURIComponent('Q4/numbers.csv')}`))).toEqual({ name: 'numbers.csv', size: 8, mime: 'text/csv' })
    const res = await dl(bob, id, 'plan.txt')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('the plan')
    expect(res.headers.get('content-length')).toBe('8')
    // a range, from the same descriptor
    const part = await bob.raw('GET', `/api/files/shared/${id}/download?sub=plan.txt`, undefined, { range: 'bytes=4-6' })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('pla')
  })
  test('files added later follow the folder; a file moved out stops following', async () => {
    wr(mine('Area51', 'Work', 'later.txt'), 'added later')
    expect(await names(bob, id)).toEqual(['Q4', 'later.txt', 'plan.txt'])
    expect(await (await dl(bob, id, 'later.txt')).text()).toBe('added later')
    await alice.call('POST', '/api/files/move', { from: mine('Area51', 'Work', 'later.txt'), to: mine('Area51', 'Other', 'later.txt'), confirm: true })
    expect(await names(bob, id)).toEqual(['Q4', 'plan.txt'])
    expect((await dl(bob, id, 'later.txt')).status).toBe(404)
  })
  test('(T20, T21) someone it does not open for learns nothing; nothing above the folder is ever sent', async () => {
    // a file link's refusal, for comparison: the same body
    wr(mine('solo.txt'), 'solo')
    const fileLink = (await alice.call('POST', '/api/files/link', { path: mine('solo.txt') })).id
    const stranger = await page(carl, id)
    expect(stranger).toEqual(await page(carl, fileLink))
    expect(Object.keys(stranger).sort()).toEqual(['askedAt', 'canAsk', 'status'])
    expect(await closedFor(gina, id)).toBe(true)
    for (const c of [carl, gina, admin, owner]) {
      const want = c === gina ? [403, 404] : [404]
      expect(want).toContain((await listOf(c, id)).status)
      expect(want).toContain((await dl(c, id, 'plan.txt')).status)
      expect(want).toContain((await c.try('GET', `/api/files/shared/${id}/entry?sub=plan.txt`)).status)
    }
    const all = JSON.stringify([await page(bob, id), (await listOf(bob, id)).body, (await listOf(bob, id, 'Q4')).body, await bob.call('GET', '/api/files/shared-with-me')])
    expect(all).not.toContain('Area51')
    expect(all).not.toContain('users/')
    expect(all).not.toContain(ids.alice)
    expect(all).not.toContain(root)
  })
  test('(T1, T8) by path nothing changed: the folder rules, the admin endpoints and every path endpoint', async () => {
    const rules = RuleSet.load(h.ctx.db)
    const segs = mine('Area51', 'Work', 'plan.txt').split('/')
    for (const who of [ids.bob, uid('adam'), uid('olga')]) expect(rules.access(loadPrincipal(h.ctx.db, who)!, segs)).toBe('none')
    const p = mine('Area51', 'Work', 'plan.txt')
    for (const c of [bob, admin]) {
      for (const u of ['/api/files/content' + q(p), '/api/files/download' + q(p), '/api/files/history' + q(p), '/api/files/tree' + q(mine('Area51', 'Work')), '/api/files/shares' + q(mine('Area51', 'Work')), '/api/files/shares' + q(p)])
        expect([403, 404]).toContain((await c.try('GET', u).catch(() => ({ status: 404 }))).status)
      expect([403, 404]).toContain((await c.try('PUT', '/api/files/shares', { path: mine('Area51', 'Work'), add: [], remove: [], stop: true })).status)
      const found = await c.call('GET', '/api/files/search?q=plan').catch(() => ({ items: [] }))
      expect(JSON.stringify(found)).not.toContain('plan.txt')
    }
    const rule = await admin.try('POST', '/api/admin/folders', { path: mine('Area51', 'Work'), create: false, limited: false, rules: [{ subjectType: 'user', subjectId: ids.bob, access: 'read' }] })
    expect(rule.status).toBe(400)
  })
  test('Shared with me lists the folder as a folder; the owner\'s own listing marks it', async () => {
    const mineList = (await bob.call('GET', '/api/files/shared-with-me')).items as { linkId: string; kind?: string; name: string }[]
    expect(mineList.find((i) => i.linkId === id)).toMatchObject({ name: 'Work', kind: 'folder' })
    const top = (await alice.call('GET', '/api/files/tree' + q(mine('Area51')))).entries as { name: string; shared?: string }[]
    expect(top.find((e) => e.name === 'Work')?.shared).toBe('own')
    expect(top.find((e) => e.name === 'Other')?.shared).toBeUndefined()
    const inside = (await alice.call('GET', '/api/files/tree' + q(mine('Area51', 'Work')))).entries as { name: string; shared?: string }[]
    expect(inside.every((e) => e.shared === 'through')).toBe(true)
    // what its people never see (receiverSees: a hidden name, a project's folder) is not marked as shared
    wr(mine('Area51', 'Work', '.notes'), 'mine only')
    mk(mine('Area51', 'Work', 'ProjMark'))
    h.ctx.db.query("INSERT INTO projects (id, name, folder_path) VALUES ('p-mark', 'Mark', ?)").run(mine('Area51', 'Work', 'ProjMark'))
    try {
      const marks = (await alice.call('GET', '/api/files/tree' + q(mine('Area51', 'Work')))).entries as { name: string; shared?: string }[]
      expect(marks.find((e) => e.name === '.notes')).toBeDefined()
      expect(marks.filter((e) => e.name === '.notes' || e.name === 'ProjMark').map((e) => e.shared)).toEqual([undefined, undefined])
      expect(marks.filter((e) => e.name !== '.notes' && e.name !== 'ProjMark').every((e) => e.shared === 'through')).toBe(true)
    } finally {
      h.ctx.db.query("DELETE FROM projects WHERE id = 'p-mark'").run()
      fs.rmSync(abs(mine('Area51', 'Work', '.notes')))
      fs.rmSync(abs(mine('Area51', 'Work', 'ProjMark')), { recursive: true })
    }
    // a file inside says which folder shares it (its owner only)
    const f = await alice.call('GET', '/api/files/shares' + q(mine('Area51', 'Work', 'plan.txt')))
    expect(f.through.map((t: any) => [t.name, t.people.map((p: any) => p.subjectId)])).toEqual([['Work', [ids.bob]]])
  })
  test('(T9, T10, T11) never a guest, by name, through a group or through Everyone; only one\'s own groups; a refused name costs a token', async () => {
    const p = mine('Area51', 'Work')
    expect(reason(await tryShare(alice, p, { add: [user(ids.gina)] }))).toBe('unknown_subject')
    expect(reason(await tryShare(alice, p, { add: [user(ids.alice)] }))).toBe('unknown_subject')
    expect(reason(await tryShare(alice, p, { add: [group(sales)] }))).toBe('unknown_subject')
    h.ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(sales, ids.gina)
    const ev = await share(alice, p, [group('*')])
    expect(ev.people.some((x: any) => x.everyone)).toBe(true)
    h.ctx.db.query("INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?, 'group', ?, 'view', ?, ?, 'dialog')").run(id, sales, ids.alice, new Date().toISOString())
    expect(await closedFor(gina, id)).toBe(true)
    expect((await listOf(gina, id)).status).not.toBe(200)
    expect((await page(carl, id)).status).toBe('open')
    await share(alice, p, [], [group('*'), group(sales)])
    h.ctx.db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(sales, ids.gina)
    expect((await page(carl, id)).status).toBe('no_access')
    // probing: refused names spend the same budget as real ones
    budget()
    let limited = false
    for (let i = 0; i < 80 && !limited; i++) limited = (await alice.try('PUT', '/api/files/shares', { path: p, add: [user('nobody-' + i)], remove: [] })).status === 429
    expect(limited).toBe(true)
    budget()
  })
  test('(T23) a build that reads the row as a file row answers no access, paused or not', async () => {
    // an older build ignores `kind`: its open() resolves the path as a file and refuses a directory
    h.ctx.db.query("UPDATE file_shares SET kind = 'file' WHERE id = ?").run(id)
    try {
      expect(fileSharesOf(h.ctx).open(ids.bob, id).kind).toBe('no_access')
      expect((await page(bob, id)).status).toBe('no_access')
      expect((await bob.raw('GET', `/api/files/shared/${id}/download`)).status).toBe(404)
    } finally { h.ctx.db.query("UPDATE file_shares SET kind = 'folder' WHERE id = ?").run(id) }
    // and a folder link's download without `sub` is never a file
    expect((await bob.raw('GET', `/api/files/shared/${id}/download`)).status).toBe(404)
  })
  test('(L2) a press of several files and the file path of the AI tool refuse a folder', async () => {
    budget()
    const b = await alice.call('POST', '/api/files/shares/batch', { paths: [mine('Area51', 'Other'), mine('solo.txt')], add: [user(ids.dana)] })
    expect(b.shared).toEqual([mine('solo.txt')])
    expect(b.failed).toMatchObject([{ path: mine('Area51', 'Other'), reason: 'is_folder' }])
    expect(h.ctx.db.query("SELECT 1 FROM file_shares WHERE path = ? AND state = 'live'").get(mine('Area51', 'Other'))).toBeNull()
    // chat/share-with-person.ts calls change(): a folder is refused there whatever the gate says
    let err: any
    try { fileSharesOf(h.ctx).change(ids.alice, mine('Area51', 'Other'), [user(ids.dana)], [], 'en', 'ai') } catch (e) { err = e }
    expect(err?.extra?.params?.reason).toBe('is_folder')
  })
})

describe('3. places that are never shared (T2, T3)', () => {
  test('(R) the personal folder, the server\'s places, From this computer, the archive folder in every language, their twins, and anything inside', async () => {
    const refused: string[] = [mine()]
    const kept = ['skills', 'projects', 'downloads', 'images', 'videos', 'exports', '.attachments', FROM_COMPUTER_DIR, ...Object.values(ARCHIVE_DIR)]
    for (const k of kept) { mk(mine(k, 'inside')); refused.push(mine(k), mine(k, 'inside')) }
    // twins, each in a person of their own so that a case-insensitive disk keeps them apart: carl, dana
    const twins: [Client, string, string][] = [[carl, ids.carl, 'downloadſ'], [carl, ids.carl, 'EXPORTS'], [carl, ids.carl, FROM_COMPUTER_DIR.toUpperCase()], [dana, ids.dana, ARCHIVE_DIR.ko.normalize('NFD')], [dana, ids.dana, ARCHIVE_DIR.ja.normalize('NFD')], [dana, ids.dana, 'Ｉｍａｇｅｓ']]
    for (const p of refused) {
      const r = await tryShare(alice, p, { add: [user(ids.bob)] })
      expect([p, r.status, reason(r)]).toEqual([p, 400, 'folder_share_place'])
      expect(reason(await alice.try('POST', '/api/files/link', { path: p }))).toBe('folder_share_place')
    }
    for (const [c, uid, name] of twins) {
      fs.mkdirSync(path.join(root, 'users', uid, name, 'inside'), { recursive: true })
      for (const p of [`users/${uid}/${name}`, `users/${uid}/${name}/inside`]) {
        const r = await tryShare(c, p, { add: [user(ids.bob)] })
        // (a name the name rules refuse outright, such as a fully full-width one, is not even resolved: 403 or 404)
        // (a fully full-width name is refused as a path before anything else: 400 with no reason)
        expect([name, r.status, reason(r) ?? 'folder_share_place']).toEqual([name, 400, 'folder_share_place'])
        expect(h.ctx.db.query('SELECT 1 FROM file_shares WHERE path = ?').get(p)).toBeNull()
        if (name === 'download\u017f' || name === ARCHIVE_DIR.ko.normalize('NFD')) expect([name, r.status, reason(r)]).toEqual([name, 400, 'folder_share_place'])
      }
    }
    expect((await alice.call('GET', '/api/files/shares' + q(mine('downloads')))).blocked).toBe('system_place')
    expect((await alice.call('GET', '/api/files/shares' + q(mine()))).blocked).toBe('root')
    expect((await alice.call('GET', '/api/files/shares' + q(mine('downloads')))).canShare).toBe(false)
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM file_shares WHERE kind = 'folder' AND (path LIKE '%downloads%' OR path LIKE '%inside%')").get() as { n: number }).n).toBe(0)
  })
  test('a team folder is never shared here, also by an admin; a project\'s folder neither', async () => {
    mk('shared/TeamDocs')
    for (const c of [admin, owner]) {
      expect(reason(await tryShare(c, 'shared/TeamDocs', { add: [user(ids.bob)] }))).toBe('is_folder')
      expect(reason(await c.try('POST', '/api/files/link', { path: 'shared/TeamDocs' }))).toBe('is_folder')
      expect(await c.call('GET', '/api/files/shares' + q('shared/TeamDocs'))).toMatchObject({ kind: 'folder', blocked: 'team_folder', canShare: false, link: null, people: [] })
    }
    mk(mine('Clients', 'Acme', 'Files'))
    h.ctx.db.query("INSERT INTO projects (id, name, folder_path) VALUES ('p-acme', 'Acme', ?)").run(mine('Clients', 'Acme'))
    try {
      for (const p of [mine('Clients'), mine('Clients', 'Acme'), mine('Clients', 'Acme', 'Files')]) {
        expect(reason(await tryShare(alice, p, { add: [user(ids.bob)] }))).toBe('folder_share_place')
        expect((await alice.call('GET', '/api/files/shares' + q(p))).blocked).toBe('project')
      }
    } finally { h.ctx.db.query("DELETE FROM projects WHERE id = 'p-acme'").run() }
  })
  test('(T3) a shared folder renamed into a kept name, moved into a kept place or out of the personal folder ends', async () => {
    for (const [name, to, why] of [['Gone1', mine('exports'), 'moved_excluded'], ['Gone2', mine('downloads', 'Gone2'), 'moved_excluded'], ['Gone3', 'shared/Gone3', 'left_personal']] as const) {
      if (to === mine('exports')) fs.rmSync(abs(to), { recursive: true, force: true })
      wr(mine(name, 'f.txt'), 'x')
      const id = (await share(alice, mine(name), [user(ids.bob)])).link.id
      expect((await page(bob, id)).status).toBe('open')
      await alice.call('POST', '/api/files/move', { from: mine(name), to, confirm: true })
      expect(row(id)).toMatchObject({ state: 'dead' })
      expect(grants(id)).toBe(0)
      expect((await page(bob, id)).status).toBe('no_access')
      expect((await listOf(bob, id)).status).toBe(404)
      expect(audits('folder_share.ended', id)).toMatchObject([{ personal: true, reason: why, removed: 1 }])
      expect(JSON.stringify(audits('folder_share.ended', id))).not.toContain(name)
    }
    await tick()
    // the owner is told (their own Activity row), with nothing but their own folder's name
    const told = h.ctx.db.query("SELECT COUNT(*) n FROM file_share_notices WHERE user_id = ? AND event_type = 'file.unshared_by_move'").get(ids.alice) as { n: number }
    expect(told.n).toBeGreaterThanOrEqual(3)
  })
  test('a project made on a shared folder later: the next open ends the share', async () => {
    wr(mine('Becomes', 'f.txt'), 'x')
    const id = (await share(alice, mine('Becomes'), [user(ids.bob)])).link.id
    h.ctx.db.query("INSERT INTO projects (id, name, folder_path) VALUES ('p-later', 'Later', ?)").run(mine('Becomes'))
    try {
      expect((await listOf(bob, id)).status).toBe(404)
      expect(row(id)?.state).toBe('dead')
      expect(audits('folder_share.ended', id)).toMatchObject([{ reason: 'project' }])
    } finally { h.ctx.db.query("DELETE FROM projects WHERE id = 'p-later'").run() }
  })
})

describe('4. which folder: identity, pause and resume (T4, T30)', () => {
  test('(R) a different folder at the path pauses the share and keeps its people; only the owner resumes', async () => {
    wr(mine('Pin', 'old.txt'), 'the folder that was shared')
    const id = (await share(alice, mine('Pin'), [user(ids.bob), group('*')])).link.id
    expect(await names(bob, id)).toEqual(['old.txt'])
    // replaced on the disk outside the app: another folder under the same name
    fs.renameSync(abs(mine('Pin')), abs(mine('Pin-set-aside')))
    wr(mine('Pin', 'new.txt'), 'another folder, never shared')
    expect((await listOf(bob, id)).status).toBe(404)
    expect((await dl(bob, id, 'new.txt')).status).toBe(404)
    expect(row(id)?.paused_at).toBeTruthy()
    expect(row(id)?.state).toBe('live')
    expect(grants(id)).toBe(2)
    expect(audits('folder_share.paused', id)).toEqual([{ personal: true, reason: 'identity' }])
    // a receiver learns nothing, cannot ask, and no longer sees it in Shared with me
    expect(await page(bob, id)).toEqual({ status: 'no_access', canAsk: false, askedAt: null })
    expect(((await bob.call('GET', '/api/files/shared-with-me')).items as { linkId: string }[]).some((i) => i.linkId === id)).toBe(false)
    await tick()
    // the owner is told once, and sees Paused with the people still there
    const notices = h.ctx.db.query("SELECT source_id FROM file_share_notices WHERE user_id = ? AND event_type = 'file.unshared_by_move'").all(ids.alice) as { source_id: string }[]
    const mineNotice = notices.filter((n) => (h.ctx.db.query('SELECT target, action FROM audit_log WHERE id = ?').get(Number(n.source_id)) as { target: string; action: string }).target === `file-share:${id}`)
    expect(mineNotice.length).toBe(1)
    const inbox = (await alice.call('GET', '/api/notifications')).items as { fileShare?: { folder?: string; name?: string } }[]
    expect(inbox.some((n) => n.fileShare?.folder === 'paused' && n.fileShare.name === 'Pin')).toBe(true)
    const v = await alice.call('GET', '/api/files/shares' + q(mine('Pin')))
    expect(v).toMatchObject({ paused: true, kind: 'folder' })
    expect(v.people.length).toBe(2)
    // adding while paused is refused; taking people off still works
    expect(reason(await tryShare(alice, mine('Pin'), { add: [user(ids.carl)] }))).toBe('folder_share_paused')
    expect((await tryShare(alice, mine('Pin'), { remove: [group('*')] })).status).toBe(200)
    expect(grants(id)).toBe(1)
    // nobody else resumes
    for (const c of [bob, admin, owner]) expect([403, 404]).toContain((await tryShare(c, mine('Pin'), { resume: true })).status)
    expect(row(id)?.paused_at).toBeTruthy()
    // resume is alone in its call
    expect((await tryShare(alice, mine('Pin'), { resume: true, add: [user(ids.carl)] })).status).toBe(400)
    expect((await tryShare(alice, mine('Pin'), { resume: true, stop: true })).status).toBe(400)
    const r = await tryShare(alice, mine('Pin'), { resume: true })
    expect(r.status).toBe(200)
    expect(r.body.paused).toBeUndefined()
    expect(row(id)?.paused_at).toBeNull()
    expect(await names(bob, id)).toEqual(['new.txt'])
    expect(audits('folder_share.resumed', id).length).toBe(1)
  })
  test('a new folder made in the app where a shared one was deleted on the disk: paused, never served without Resume', async () => {
    wr(mine('Remade', 'a.txt'), 'a')
    const id = (await share(alice, mine('Remade'), [user(ids.bob)])).link.id
    fs.rmSync(abs(mine('Remade')), { recursive: true })
    // nothing at the path: no access, and not a pause
    expect((await listOf(bob, id)).status).toBe(404)
    expect(row(id)?.paused_at).toBeNull()
    await alice.call('POST', '/api/files/mkdir', { path: mine('Remade') })
    expect(row(id)?.paused_at).toBeTruthy()
    expect(audits('folder_share.paused', id)).toEqual([{ personal: true, reason: 'new_folder' }])
    expect((await listOf(bob, id)).status).toBe(404)
    expect(grants(id)).toBe(1)
  })
  test('(R) a disk without birth times refuses folder shares', async () => {
    wr(mine('NoBirth', 'a.txt'), 'a')
    const real = folderStat.lstat
    folderStat.lstat = (p) => { const st = real(p); return { isDirectory: () => st.isDirectory(), dev: st.dev, ino: st.ino, birthtimeNs: 0n } }
    try {
      const r = await tryShare(alice, mine('NoBirth'), { add: [user(ids.bob)] })
      expect([r.status, reason(r)]).toEqual([400, 'folder_share_disk'])
      expect(reason(await alice.try('POST', '/api/files/link', { path: mine('NoBirth') }))).toBe('folder_share_disk')
      expect(await alice.call('GET', '/api/files/shares' + q(mine('NoBirth')))).toMatchObject({ blocked: 'disk', canShare: false, link: null })
      expect(h.ctx.db.query('SELECT 1 FROM file_shares WHERE path = ?').get(mine('NoBirth'))).toBeNull()
    } finally { folderStat.lstat = real }
    // and a share made before the disk lost them does not open there: paused, people kept
    const id = (await share(alice, mine('NoBirth'), [user(ids.bob)])).link.id
    folderStat.lstat = (p) => { const st = real(p); return { isDirectory: () => st.isDirectory(), dev: st.dev, ino: st.ino, birthtimeNs: 0n } }
    try { expect((await listOf(bob, id)).status).toBe(404) } finally { folderStat.lstat = real }
    expect(row(id)?.paused_at).toBeTruthy()
    expect(grants(id)).toBe(1)
  })
  test('(T30) only the device number changed (a remount, another host): the same folder, the row takes the new id', async () => {
    wr(mine('Remount', 'a.txt'), 'a')
    const id = (await share(alice, mine('Remount'), [user(ids.bob)])).link.id
    const [dev, ino, birth] = row(id)!.folder_id!.split(':')
    h.ctx.db.query('UPDATE file_shares SET folder_id = ? WHERE id = ?').run(`${Number(dev) + 7}:${ino}:${birth}`, id)
    expect(await names(bob, id)).toEqual(['a.txt'])
    expect(row(id)).toMatchObject({ folder_id: `${dev}:${ino}:${birth}`, paused_at: null })
    // another inode or another birth time is another folder
    h.ctx.db.query('UPDATE file_shares SET folder_id = ? WHERE id = ?').run(`${dev}:${ino}:${BigInt(birth!) + 1n}`, id)
    expect((await listOf(bob, id)).status).toBe(404)
    expect(row(id)?.paused_at).toBeTruthy()
  })
})

describe('5. a path inside the folder (T5, T6, T7, L7)', () => {
  let id: string
  const base = () => mine('Box')
  beforeAll(async () => {
    wr(mine('Box', 'ok.txt'), 'ok')
    wr(mine('Box', 'sub', 'deep.txt'), 'deep')
    wr(mine('secret.txt'), 'alice private, outside the shared folder')
    wr(`users/${ids.dana}/dana-secret.txt`, 'dana private')
    id = (await share(alice, base(), [user(ids.bob)])).link.id
  })
  test('(T5) dots, absolute, encoded and odd paths never reach outside', async () => {
    const bad = ['..', '../secret.txt', 'sub/../../secret.txt', 'sub/..', '/etc/passwd', `/${base()}/ok.txt`, '%2e%2e/secret.txt', '..%2fsecret.txt', 'sub//deep.txt', 'sub/', './ok.txt', 'ok.txt\0', 'sub\\deep.txt', 'sub/‮deep.txt',
      Array(65).fill('d').join('/'), `${PRODUCT.systemDir}/x`, '.', '~', '~/secret.txt', `../../${ids.dana}/dana-secret.txt`]
    for (const sub of bad) {
      for (const c of [bob, alice]) {
        const u = encodeURIComponent(sub)
        expect([sub, (await c.raw('GET', `/api/files/shared/${id}/download?sub=${u}`)).status]).toEqual([sub, 404])
        expect([sub, (await c.try('GET', `/api/files/shared/${id}/entry?sub=${u}`)).status]).toEqual([sub, 404])
        if (sub !== '.') expect([sub, (await listOf(c, id, sub)).status]).toEqual([sub, sub === '' ? 200 : 404])
      }
    }
    // a Unicode twin of a real name resolves to the name on disk, inside the folder
    wr(mine('Box', '보고서.txt'), 'report')
    const twin = await dl(bob, id, '보고서.txt'.normalize('NFD'))
    expect(twin.status).toBe(200)
    expect(await twin.text()).toBe('report')
  })
  test('(R, T6) a symbolic link, a linked folder and a hard link are neither listed nor served', async () => {
    fs.symlinkSync(abs(mine('secret.txt')), abs(mine('Box', 'link.txt')))
    fs.symlinkSync(abs(`users/${ids.dana}`), abs(mine('Box', 'linkdir')))
    fs.linkSync(abs(`users/${ids.dana}/dana-secret.txt`), abs(mine('Box', 'hard.txt')))
    fs.symlinkSync(path.join(root, PRODUCT.systemDir), abs(mine('Box', 'sys')))
    try {
      const got = await names(bob, id)
      for (const n of ['link.txt', 'linkdir', 'hard.txt', 'sys']) expect(got).not.toContain(n)
      expect(got).toContain('ok.txt')
      for (const sub of ['link.txt', 'hard.txt', 'linkdir/dana-secret.txt', 'sys/x']) {
        expect([sub, (await dl(bob, id, sub)).status]).toEqual([sub, 404])
        expect([sub, (await bob.try('GET', `/api/files/shared/${id}/entry?sub=${encodeURIComponent(sub)}`)).status]).toEqual([sub, 404])
      }
      expect((await listOf(bob, id, 'linkdir')).status).toBe(404)
    } finally { for (const n of ['link.txt', 'linkdir', 'hard.txt', 'sys']) fs.rmSync(abs(mine('Box', n)), { force: true }) }
  })
  test('(R) the descriptor served is the file that was checked: its inode equals the checked one', async () => {
    const p = abs(mine('Box', 'ok.txt'))
    const st = fs.lstatSync(p)
    const f = folderSharesOf(h.ctx).file(ids.bob, id, 'ok.txt', 'en')
    expect(f).toEqual({ abs: p, name: 'ok.txt', expect: { ino: st.ino, dev: st.dev } })
    const o = openSame(f.abs, f.expect)
    try {
      const fst = fs.fstatSync(o.fd)
      expect([fst.ino, fst.dev, fst.nlink]).toEqual([st.ino, st.dev, 1])
      expect(o.st.ino).toBe(st.ino)
    } finally { fs.closeSync(o.fd) }
    // the response's ETag is built from that descriptor's fstat
    const res = await dl(bob, id, 'ok.txt')
    expect(res.headers.get('etag')).toBe(`"${st.ino.toString(36)}-${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`)
    await res.arrayBuffer()
  })
  test('(R) a symbolic link swapped in between the check and the open is refused; so is another file', async () => {
    const req = new Request('http://x/y')
    wr(mine('Box', 'swap.txt'), 'the checked file')
    const p = abs(mine('Box', 'swap.txt'))
    // 1. checked, then replaced by a link to a file outside the folder
    let f = folderSharesOf(h.ctx).file(ids.bob, id, 'swap.txt', 'en')
    fs.rmSync(p)
    fs.symlinkSync(abs(mine('secret.txt')), p)
    await expect((async () => streamChecked({ ...f, req, disposition: 'attachment' }))()).rejects.toThrow(/symbolic links/)
    expect(() => openSame(f.abs, f.expect)).toThrow()
    // 2. checked, then replaced by another regular file (another inode) with other content
    fs.rmSync(p)
    wr(mine('Box', 'swap.txt'), 'the checked file')
    f = folderSharesOf(h.ctx).file(ids.bob, id, 'swap.txt', 'en')
    fs.renameSync(p, p + '.aside')
    fs.copyFileSync(abs(mine('secret.txt')), p)
    await expect((async () => streamChecked({ ...f, req, disposition: 'attachment' }))()).rejects.toThrow(/changed/)
    // 3. checked, then given a second link
    fs.rmSync(p); fs.renameSync(p + '.aside', p)
    f = folderSharesOf(h.ctx).file(ids.bob, id, 'swap.txt', 'en')
    fs.linkSync(p, p + '.hard')
    await expect((async () => streamChecked({ ...f, req, disposition: 'attachment' }))()).rejects.toThrow(/regular file/)
    fs.rmSync(p + '.hard')
    // untouched: the bytes of the checked file, and the descriptor is closed afterwards
    const ok = await streamChecked({ ...folderSharesOf(h.ctx).file(ids.bob, id, 'swap.txt', 'en'), req, disposition: 'attachment' })
    expect(await ok.text()).toBe('the checked file')
    fs.rmSync(p)
  })
  test('(R, T7) the listing drops bad names, dot names, temp names, hard links and links', async () => {
    mk(mine('Listing'))
    const lid = (await share(alice, mine('Listing'), [user(ids.bob)])).link.id
    const dir = abs(mine('Listing'))
    for (const n of ['good.txt', '.env', '.hidden-dir/x', `${PRODUCT.tmpPrefix}half`, 'trailing.', 'CON', 'a:b.txt', 'ABCDEF~1', ' lead.txt', 'r‮evil.txt', 'zz-folder/in.txt']) {
      const p = path.join(dir, n)
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x') } catch {}
    }
    fs.linkSync(path.join(dir, 'good.txt'), path.join(dir, 'twice.txt'))
    fs.symlinkSync(path.join(dir, 'zz-folder'), path.join(dir, 'ln'))
    const l = (await listOf(bob, lid)).body
    // (good.txt has two links now, so it is dropped too)
    expect(l.items.map((i: any) => i.name)).toEqual(['zz-folder'])
    fs.rmSync(path.join(dir, 'twice.txt'))
    expect(await names(bob, lid)).toEqual(['zz-folder', 'good.txt'])
    for (const sub of ['.env', '.hidden-dir/x', `${PRODUCT.tmpPrefix}half`, 'CON', 'a:b.txt', 'ln/in.txt']) expect([sub, (await dl(bob, lid, sub)).status]).toEqual([sub, 404])
  })
  test('things moved in after the share that a receiver never sees: a project folder inside', async () => {
    mk(mine('Listing', 'Proj'))
    wr(mine('Listing', 'Proj', 'p.txt'), 'project file')
    const lid = h.ctx.db.query("SELECT id FROM file_shares WHERE path = ? AND state = 'live'").get(mine('Listing')) as { id: string }
    expect(await names(bob, lid.id)).toContain('Proj')
    // (a project row whose folder is INSIDE the shared folder: the row itself would be refused when sharing; here it
    // appears afterwards, by the database alone, so the open-time check is what is tested)
    h.ctx.db.query("INSERT INTO projects (id, name, folder_path) VALUES ('p-in', 'In', ?)").run(mine('Listing', 'Proj'))
    try {
      // the folder that holds a project may no longer be shared at all: the share ends at the next open
      expect((await listOf(bob, lid.id)).status).toBe(404)
      expect(row(lid.id)?.state).toBe('dead')
    } finally { h.ctx.db.query("DELETE FROM projects WHERE id = 'p-in'").run() }
  })
  test('(L7) the path limits are the whole team path\'s: a child past them is not listed and does not open', async () => {
    // users/<id>/Deep = 3 segments; 60 more make 63; "e" is the 64th, "f.txt" the 65th
    const chain = Array(60).fill('d')
    wr(mine('Deep', ...chain, 'e', 'f.txt'), 'too deep')
    wr(mine('Deep', ...chain, 'at64.txt'), 'fits')
    const did = (await share(alice, mine('Deep'), [user(ids.bob)])).link.id
    expect(await names(bob, did, chain.join('/'))).toEqual(['e', 'at64.txt'])
    expect(await names(bob, did, [...chain, 'e'].join('/'))).toEqual([])
    expect((await dl(bob, did, [...chain, 'e', 'f.txt'].join('/'))).status).toBe(404)
    expect(await (await dl(bob, did, [...chain, 'at64.txt'].join('/'))).text()).toBe('fits')
  })
})

describe('6. limits (T22, M4)', () => {
  test('a big directory: at most 2,000 entries read, 200 a page, truncated said', async () => {
    const dir = abs(mine('Big'))
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < FOLDER_LIST_SCAN + 50; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(5, '0')}.txt`), '')
    const id = (await share(alice, mine('Big'), [user(ids.bob)])).link.id
    const t0 = performance.now()
    const first = (await listOf(bob, id)).body
    const took = performance.now() - t0
    expect(first.items.length).toBe(FOLDER_LIST_PAGE)
    expect(first.truncated).toBe(true)
    expect(first.next).toBeTruthy()
    expect(took).toBeLessThan(2000)
    const seen = new Set<string>(first.items.map((i: any) => i.name))
    let next = first.next as string | null
    let pages = 1
    while (next) {
      const p = (await listOf(bob, id, '', `&cursor=${encodeURIComponent(next)}`)).body
      for (const i of p.items) { expect(seen.has(i.name)).toBe(false); seen.add(i.name) }
      next = p.next
      if (++pages > 20) break
    }
    expect(seen.size).toBe(FOLDER_LIST_SCAN)
    expect(pages).toBe(FOLDER_LIST_SCAN / FOLDER_LIST_PAGE)
    expect((await listOf(bob, id, '', '&limit=5')).body.items.length).toBe(5)
    expect((await listOf(bob, id, '', '&cursor=%%%')).status).toBe(400)
    expect((await listOf(bob, id, '', '&limit=201')).status).toBe(400)
    fs.rmSync(dir, { recursive: true })
  }, 60_000)
  test('one bucket covers list, entry and download: 240 a minute per person, then 429 for all three', async () => {
    wr(mine('Bucket', 'a.txt'), 'a')
    const id = (await share(alice, mine('Bucket'), [user(ids.bob)])).link.id
    bucket()
    const f = folderSharesOf(h.ctx)
    // spent across the three kinds (also by refused calls)
    for (let i = 0; i < FOLDER_OPENS_PER_MIN - 3; i++) {
      if (i % 3 === 0) f.list(ids.bob, id, '', undefined, 1, 'en')
      else if (i % 3 === 1) f.entry(ids.bob, id, 'a.txt', 'en')
      else f.file(ids.bob, id, 'a.txt', 'en')
    }
    expect((await listOf(bob, id)).status).toBe(200)
    expect((await bob.try('GET', `/api/files/shared/${id}/entry?sub=a.txt`)).status).toBe(200)
    expect((await bob.try('GET', `/api/files/shared/${id}/entry?sub=nope.txt`)).status).toBe(404)
    for (const u of [`/api/files/shared/${id}/list`, `/api/files/shared/${id}/entry?sub=a.txt`, `/api/files/shared/${id}/download?sub=a.txt`]) {
      const r = await bob.raw('GET', u)
      expect(r.status).toBe(429)
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0)
      await r.arrayBuffer()
    }
    // another person's bucket is their own
    expect((await listOf(alice, id)).status).toBe(200)
    bucket()
  })
  test('at most 50 on a folder; a deleted group\'s entry is not one of them', async () => {
    mk(mine('Full'))
    const id = (await share(alice, mine('Full'), [user(ids.bob)])).link.id
    const at = new Date().toISOString()
    for (let i = 0; i < 48; i++) h.ctx.db.query("INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?, 'user', ?, 'view', ?, ?, 'dialog')").run(id, 'ghost-' + i, ids.alice, at)
    h.ctx.db.query("INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?, 'group', 'gone-group', 'view', ?, ?, 'dialog')").run(id, ids.alice, at)
    // 49 real entries and one of a group that is gone: one more fits, a second does not
    expect((await tryShare(alice, mine('Full'), { add: [user(ids.carl)] })).status).toBe(200)
    expect(reason(await tryShare(alice, mine('Full'), { add: [user(ids.dana)] }))).toBe('file_share_full')
    expect(h.ctx.db.query("SELECT 1 FROM file_share_grants WHERE share_id = ? AND subject_id = 'gone-group'").get(id)).toBeNull()
  })
})

describe('7. nested shares add up (D4, L4, T24)', () => {
  let outer: string, inner: string, fileLink: string
  beforeAll(async () => {
    wr(mine('Nest', 'top.txt'), 'top')
    wr(mine('Nest', 'Q4', 'q.txt'), 'q4')
    wr(mine('Nest', 'Q4', 'own.txt'), 'own share')
    outer = (await share(alice, mine('Nest'), [user(ids.bob)])).link.id
    budget()
    h.ctx.db.query('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(sales, ids.alice)
    inner = (await share(alice, mine('Nest', 'Q4'), [group(sales)])).link.id
    fileLink = (await share(alice, mine('Nest', 'Q4', 'own.txt'), [user(ids.dana)])).link.id
  })
  test('the inner folder\'s people see it only; the outer folder\'s people see everything, by either link', async () => {
    expect(await names(carl, inner)).toEqual(['own.txt', 'q.txt'])
    expect((await listOf(carl, outer)).status).toBe(404)
    expect(await names(bob, outer)).toEqual(['Q4', 'top.txt'])
    expect(await names(bob, outer, 'Q4')).toEqual(['own.txt', 'q.txt'])
    expect(await names(bob, inner)).toEqual(['own.txt', 'q.txt'])
    expect((await page(bob, inner)).sharedBy).toBe('ALICE')
    expect((await listOf(dana, inner)).status).toBe(404)
    expect(await (await dana.raw('GET', `/api/files/shared/${fileLink}/download`)).text()).toBe('own share')
  })
  test('(L4) a paused folder above grants nothing; the inner folder\'s own people keep it', async () => {
    h.ctx.db.query('UPDATE file_shares SET paused_at = ? WHERE id = ?').run(new Date().toISOString(), outer)
    try {
      expect((await listOf(bob, inner)).status).toBe(404)
      expect((await listOf(bob, outer)).status).toBe(404)
      expect(await names(carl, inner)).toEqual(['own.txt', 'q.txt'])
    } finally { h.ctx.db.query('UPDATE file_shares SET paused_at = NULL WHERE id = ?').run(outer) }
    // a folder above that is no longer the folder shared pauses on the way, and grants nothing
    const real = row(outer)!.folder_id!
    const [dev, ino, birth] = real.split(':')
    h.ctx.db.query('UPDATE file_shares SET folder_id = ? WHERE id = ?').run(`${dev}:${Number(ino) + 1}:${birth}`, outer)
    expect((await listOf(bob, inner)).status).toBe(404)
    expect(row(outer)?.paused_at).toBeTruthy()
    h.ctx.db.query('UPDATE file_shares SET paused_at = NULL, folder_id = ? WHERE id = ?').run(real, outer)
    expect(await names(bob, inner)).toEqual(['own.txt', 'q.txt'])
  })
  test('(T24) Stop names what stays shared on its own, folders too, and they do stay', async () => {
    const v = await alice.call('GET', '/api/files/shares' + q(mine('Nest')))
    expect(v.ownShares).toMatchObject({ files: 1, folders: 1 })
    expect(v.ownShares.names).toEqual([{ name: 'Q4', folder: true }, { name: 'own.txt', folder: false }])
    expect(v.ownShares.people).toBeGreaterThanOrEqual(2)
    const stop = await tryShare(alice, mine('Nest'), { stop: true })
    expect(stop.status).toBe(200)
    expect(stop.body.people).toEqual([])
    expect(stop.body.link.id).toBe(outer)
    expect(stop.body.undo.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect((await listOf(bob, outer)).status).toBe(404)
    expect((await listOf(bob, inner)).status).toBe(404)
    expect(await names(carl, inner)).toEqual(['own.txt', 'q.txt'])
    expect((await dana.raw('GET', `/api/files/shared/${fileLink}/download`)).status).toBe(200)
    expect(audits('folder_share.stop', outer)).toMatchObject([{ personal: true, removed: 1, keptOwn: 1, keptOwnFolders: 1, via: 'dialog' }])
    // stop never comes with an add
    expect((await tryShare(alice, mine('Nest'), { stop: true, add: [user(ids.bob)] })).status).toBe(400)
  })
})

describe('8. an owner can always stop (D9, T15); the server undo (M6)', () => {
  test('the team switch off: adds are refused, removing and stopping work, for a folder and for a file', async () => {
    wr(mine('Stoppable', 'a.txt'), 'a')
    wr(mine('stoppable-file.txt'), 'f')
    const fid = (await share(alice, mine('Stoppable'), [user(ids.bob), user(ids.carl)])).link.id
    const file = (await share(alice, mine('stoppable-file.txt'), [user(ids.bob), user(ids.carl)])).link.id
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try {
      for (const p of [mine('Stoppable'), mine('stoppable-file.txt')]) {
        const add = await tryShare(alice, p, { add: [user(ids.dana)] })
        expect([p, add.status, reason(add)]).toEqual([p, 403, 'file_shares_off'])
        // an add and a removal in one call is an add
        expect((await tryShare(alice, p, { add: [user(ids.dana)], remove: [user(ids.bob)] })).status).toBe(403)
        const v = await alice.call('GET', '/api/files/shares' + q(p))
        expect(v).toMatchObject({ off: true, canShare: false })
        expect(v.people.length).toBe(2)
        const rm = await tryShare(alice, p, { remove: [user(ids.bob)] })
        expect([p, rm.status]).toEqual([p, 200])
        expect(rm.body.people.map((x: any) => x.subjectId)).toEqual([ids.carl])
        const stop = await tryShare(alice, p, { stop: true })
        expect([p, stop.status]).toEqual([p, 200])
        expect(stop.body.people).toEqual([])
        // the undo does not ask the switch either
        const undo = await alice.try('POST', '/api/files/shares/undo', { id: stop.body.undo.id })
        expect([p, undo.status, undo.body.restored]).toEqual([p, 200, 1])
        expect((await tryShare(alice, p, { stop: true })).status).toBe(200)
      }
      expect(grants(fid)).toBe(0)
      expect(grants(file)).toBe(0)
      // existing shares keep working while the switch is off; nobody else stops them
      await h.ctx.db.query("INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?, 'user', ?, 'view', ?, ?, 'dialog')").run(fid, ids.bob, ids.alice, new Date().toISOString())
      expect(await names(bob, fid)).toEqual(['a.txt'])
      for (const c of [bob, admin]) expect([403, 404]).toContain((await tryShare(c, mine('Stoppable'), { stop: true })).status)
      expect(grants(fid)).toBe(1)
    } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
  })
  test('a team file: the owner without the switch, staff always; someone else never', async () => {
    await bob.call('PUT', '/api/files/content', { path: 'shared/bobs.txt', content: 'bob', baseSha256: null })
    const id = (await share(bob, 'shared/bobs.txt', [user(ids.carl), user(ids.dana)])).link.id
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try {
      expect((await tryShare(alice, 'shared/bobs.txt', { stop: true })).status).toBe(403)
      expect((await tryShare(bob, 'shared/bobs.txt', { remove: [user(ids.carl)] })).status).toBe(200)
      expect((await tryShare(admin, 'shared/bobs.txt', { stop: true })).status).toBe(200)
      expect(grants(id)).toBe(0)
    } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
  })
  test('(M6) undo: the actor only, once, 10 minutes, the still-valid grants with their old giver and way (dated at the Undo), quietly', async () => {
    wr(mine('Undo', 'a.txt'), 'a')
    const p = mine('Undo')
    const id = (await share(alice, p, [user(ids.bob), user(ids.carl), user(ids.dana), group('*')])).link.id
    const before = h.ctx.db.query('SELECT subject_id, granted_by, granted_at, via FROM file_share_grants WHERE share_id = ? ORDER BY subject_id').all(id)
    await tick()
    const notices = () => (h.ctx.db.query('SELECT COUNT(*) n FROM file_share_notices').get() as { n: number }).n
    const stop = (await tryShare(alice, p, { stop: true })).body
    expect(new Date(stop.undo.until).getTime() - Date.now()).toBeGreaterThan(9 * 60_000)
    expect(new Date(stop.undo.until).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000)
    const n0 = notices()
    // someone else's id, a malformed one and an unknown one: the same 404
    for (const c of [bob, admin, owner]) expect((await c.try('POST', '/api/files/shares/undo', { id: stop.undo.id })).status).toBe(404)
    expect((await alice.try('POST', '/api/files/shares/undo', { id: 'B'.repeat(22) })).status).toBe(404)
    expect((await alice.try('POST', '/api/files/shares/undo', { id: 'short' })).status).toBe(400)
    // dana left the team meanwhile: skipped and counted, the others come back as they were
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(ids.dana)
    budget()
    const tokens = () => JSON.stringify([...(roomsOf(h.ctx) as unknown as { sendBudget: Map<string, unknown> }).sendBudget.entries()])
    const t0 = tokens()
    const undoneAt = new Date().toISOString()
    const u = await alice.call('POST', '/api/files/shares/undo', { id: stop.undo.id })
    expect([u.restored, u.skipped]).toEqual([3, 1])
    expect(u.kind).toBe('folder')
    expect(tokens()).toBe(t0)
    await tick()
    expect(notices()).toBe(n0)
    const after = h.ctx.db.query('SELECT subject_id, granted_by, granted_at, via FROM file_share_grants WHERE share_id = ? ORDER BY subject_id').all(id) as { granted_at: string }[]
    const dateless = (rows: any[]) => rows.map(({ granted_at: _at, ...g }) => g)
    expect(dateless(after)).toEqual(dateless(before.filter((g: any) => g.subject_id !== ids.dana)))
    // dated at the Undo, not at the first share: they had no access between the stop and the Undo (a restore's upTo)
    for (const g of after) expect(g.granted_at >= undoneAt).toBe(true)
    expect(await names(bob, id)).toEqual(['a.txt'])
    expect(audits('folder_share.undo', id)).toEqual([{ personal: true, restored: 3, skipped: 1 }])
    // once
    expect((await alice.try('POST', '/api/files/shares/undo', { id: stop.undo.id })).status).toBe(404)
    h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = ?").run(ids.dana)
    // expired
    const again = (await tryShare(alice, p, { remove: [user(ids.bob)] })).body
    h.ctx.db.query('UPDATE file_share_undos SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), again.undo.id)
    expect((await alice.try('POST', '/api/files/shares/undo', { id: again.undo.id })).status).toBe(404)
    // never more than was taken: someone added after the removal stays, and nothing else appears
    const third = (await tryShare(alice, p, { remove: [user(ids.carl)] })).body
    await share(alice, p, [user(ids.bob)])
    const back = await alice.call('POST', '/api/files/shares/undo', { id: third.undo.id })
    expect([back.restored, back.skipped]).toEqual([1, 0])
    expect(back.people.map((x: any) => x.subjectId).sort()).toEqual([ids.bob, ids.carl, '*'].sort())
    // a paused folder is not undone into
    const fourth = (await tryShare(alice, p, { remove: [user(ids.carl)] })).body
    h.ctx.db.query('UPDATE file_shares SET paused_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    expect((await alice.try('POST', '/api/files/shares/undo', { id: fourth.undo.id })).status).toBe(404)
    h.ctx.db.query('UPDATE file_shares SET paused_at = NULL WHERE id = ?').run(id)
  })
  test('undo for a file; the owner\'s Remove all closes every earlier undo and counts folders apart', async () => {
    wr(mine('undo-file.txt'), 'f')
    const p = mine('undo-file.txt')
    const id = (await share(alice, p, [user(ids.bob), user(ids.carl)])).link.id
    const rm = (await tryShare(alice, p, { remove: [user(ids.bob)] })).body
    const u = await alice.call('POST', '/api/files/shares/undo', { id: rm.undo.id })
    expect([u.restored, u.skipped, u.kind]).toEqual([1, 0, undefined])
    expect(grants(id)).toBe(2)
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'file.share' AND target = ? ORDER BY id DESC LIMIT 1").get(`file-share:${id}`) as { detail: string }
    expect(JSON.parse(a.detail)).toEqual({ personal: true, undo: true, restored: 1, skipped: 0 })
    const rm2 = (await tryShare(alice, p, { remove: [user(ids.bob)] })).body
    const c = await admin.call('GET', '/api/admin/file-shares')
    expect(c.folders).toBeGreaterThan(0)
    expect(c.files).toBeGreaterThan(0)
    const folderRows = (h.ctx.db.query("SELECT COUNT(DISTINCT g.share_id) n FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.state = 'live' AND s.kind = 'folder'").get() as { n: number }).n
    expect(c.folders).toBe(folderRows)
    expect((await admin.try('DELETE', '/api/admin/file-shares')).status).toBe(403)
    expect(await owner.call('DELETE', '/api/admin/file-shares')).toEqual(c)
    expect(await admin.call('GET', '/api/admin/file-shares')).toEqual({ files: 0, people: 0, folders: 0 })
    expect((h.ctx.db.query('SELECT COUNT(*) n FROM file_share_grants').get() as { n: number }).n).toBe(0)
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM file_shares WHERE kind = 'folder' AND state = 'live'").get() as { n: number }).n).toBeGreaterThan(0)
    expect((await alice.try('POST', '/api/files/shares/undo', { id: rm2.undo.id })).status).toBe(404)
    expect(grants(id)).toBe(0)
  })
})

describe('9. the row follows the folder (lifecycle)', () => {
  test('rename and a move inside the owner\'s files keep the link and the people', async () => {
    wr(mine('Before', 'a.txt'), 'a')
    const id = (await share(alice, mine('Before'), [user(ids.bob)])).link.id
    await alice.call('POST', '/api/files/move', { from: mine('Before'), to: mine('After') })
    expect(row(id)).toMatchObject({ path: mine('After'), state: 'live', paused_at: null })
    expect((await page(bob, id)).name).toBe('After')
    expect(await names(bob, id)).toEqual(['a.txt'])
    mk(mine('Holder'))
    await alice.call('POST', '/api/files/move', { from: mine('After'), to: mine('Holder', 'After') })
    expect(row(id)?.path).toBe(mine('Holder', 'After'))
    expect(await names(bob, id)).toEqual(['a.txt'])
  })
  test('trash: no access (the owner sees "in the trash"); restore: shared again with the same link; purge: gone', async () => {
    wr(mine('Binned', 'a.txt'), 'a')
    const id = (await share(alice, mine('Binned'), [user(ids.bob)])).link.id
    const del = await alice.call('DELETE', '/api/files' + q(mine('Binned')))
    expect(row(id)?.state).toBe('trashed')
    expect((await page(bob, id)).status).toBe('no_access')
    expect((await page(alice, id)).status).toBe('trashed')
    expect((await listOf(bob, id)).status).toBe(404)
    await alice.call('POST', `/api/files/trash/${del.trashId}/restore`)
    expect(row(id)).toMatchObject({ state: 'live', paused_at: null })
    expect(grants(id)).toBe(1)
    expect(await names(bob, id)).toEqual(['a.txt'])
    // again, and for good: the row, its people and its undo snapshots go
    const rm = (await tryShare(alice, row(id)!.path, { remove: [user(ids.bob)] })).body
    await share(alice, row(id)!.path, [user(ids.bob)])
    const del2 = await alice.call('DELETE', '/api/files' + q(row(id)!.path))
    // (deleting for good is the owner's and admins' button, for items they could restore: here the service, as alice)
    componentC(h.ctx).files.purgeTrash(del2.trashId, ids.alice)
    expect(row(id)).toBeNull()
    expect(grants(id)).toBe(0)
    expect(h.ctx.db.query('SELECT 1 FROM file_share_undos WHERE id = ?').get(rm.undo.id)).toBeNull()
    expect((await page(bob, id)).status).toBe('unknown')
  })
  test('a folder trashed, a new one made under its name, the old one restored: each keeps its own state', async () => {
    wr(mine('Twice', 'old.txt'), 'old')
    const id = (await share(alice, mine('Twice'), [user(ids.bob)])).link.id
    const del = await alice.call('DELETE', '/api/files' + q(mine('Twice')))
    await alice.call('POST', '/api/files/mkdir', { path: mine('Twice') })
    wr(mine('Twice', 'new.txt'), 'new')
    // the new folder is not shared
    expect((await alice.call('GET', '/api/files/shares' + q(mine('Twice')))).people).toEqual([])
    expect((await listOf(bob, id)).status).toBe(404)
    await alice.call('POST', `/api/files/trash/${del.trashId}/restore`)
    // the old one comes back beside it, still shared, and serves the old folder only
    expect(row(id)?.path).not.toBe(mine('Twice'))
    expect(await names(bob, id)).toEqual(['old.txt'])
  })
  test('a group deleted: its entries go from files and folders (L3)', async () => {
    const g = (await admin.call('POST', '/api/admin/groups', { name: 'Temps' })).id
    h.ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?), (?, ?)').run(g, ids.alice, g, ids.dana)
    wr(mine('ForGroup', 'a.txt'), 'a')
    wr(mine('for-group.txt'), 'f')
    const fid = (await share(alice, mine('ForGroup'), [group(g)])).link.id
    const file = (await share(alice, mine('for-group.txt'), [group(g)])).link.id
    expect(await names(dana, fid)).toEqual(['a.txt'])
    // membership is read live
    h.ctx.db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(g, ids.dana)
    expect((await listOf(dana, fid)).status).toBe(404)
    h.ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(g, ids.dana)
    expect((await listOf(dana, fid)).status).toBe(200)
    await admin.call('DELETE', `/api/admin/groups/${g}`)
    expect(grants(fid)).toBe(0)
    expect(grants(file)).toBe(0)
    expect((await listOf(dana, fid)).status).toBe(404)
    expect((await page(dana, file)).status).toBe('no_access')
  })
  test('Ask for access on a folder link goes to its owner; the owner\'s Share adds the person', async () => {
    wr(mine('Askable', 'a.txt'), 'a')
    const id = (await alice.call('POST', '/api/files/link', { path: mine('Askable') })).id
    expect(row(id)).toMatchObject({ kind: 'folder', owner_id: ids.alice })
    expect(grants(id)).toBe(0)
    expect(await page(carl, id)).toEqual({ status: 'no_access', canAsk: true, askedAt: null })
    expect(await closedFor(gina, id)).toBe(true)
    const asked = await carl.call('POST', `/api/files/shared/${id}/request`, {})
    expect(asked.status).toBe('sent')
    const req = h.ctx.db.query('SELECT id FROM file_access_requests WHERE share_id = ? AND requester_id = ?').get(id, ids.carl) as { id: string }
    // an admin gains nothing on a personal folder
    expect([403, 404]).toContain((await admin.try('POST', `/api/files/requests/${req.id}`, { answer: 'approve' })).status)
    budget()
    expect((await alice.call('POST', `/api/files/requests/${req.id}`, { answer: 'approve' })).state).toBe('approved')
    expect(await names(carl, id)).toEqual(['a.txt'])
    expect((h.ctx.db.query('SELECT via FROM file_share_grants WHERE share_id = ? AND subject_id = ?').get(id, ids.carl) as { via: string }).via).toBe('request')
    // off while the team switch is off
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try { expect((await page(dana, id)).canAsk).toBe(false) } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
  })
  test('(T17) an owner who is turned off shares nothing; back on, it works again; removed: the rows go and the archive is never shared', async () => {
    const eve = await addMember(h, owner, { username: 'eve' })
    fs.mkdirSync(path.join(root, 'users', eve.id, 'Team notes'), { recursive: true })
    fs.writeFileSync(path.join(root, 'users', eve.id, 'Team notes', 'n.txt'), 'notes')
    const p = `users/${eve.id}/Team notes`
    const id = (await share(eve.client, p, [user(ids.bob)])).link.id
    expect(await names(bob, id)).toEqual(['n.txt'])
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(eve.id)
    expect((await listOf(bob, id)).status).toBe(404)
    expect((await page(bob, id)).status).toBe('no_access')
    expect(grants(id)).toBe(1)
    h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = ?").run(eve.id)
    expect(await names(bob, id)).toEqual(['n.txt'])
    // a receiver removed: their entry goes
    const fred = await addMember(h, owner, { username: 'fred' })
    await share(eve.client, p, [user(fred.id)])
    expect(grants(id)).toBe(2)
    expect((await owner.try('DELETE', `/api/admin/users/${fred.id}`)).status).toBe(204)
    expect(grants(id)).toBe(1)
    // the owner removed, their folder handed to the team owner: no row left, and the archive cannot be shared
    expect((await owner.try('DELETE', `/api/admin/users/${eve.id}`)).status).toBe(204)
    expect(row(id)).toBeNull()
    expect((await page(bob, id)).status).toBe('unknown')
    const oid = uid('olga')
    const archive = Object.values(ARCHIVE_DIR).find((n) => fs.existsSync(path.join(root, 'users', oid, n)))!
    expect(archive).toBeTruthy()
    const inArchive = `users/${oid}/${archive}/${eve.id}/Team notes`
    expect(fs.existsSync(abs(inArchive))).toBe(true)
    for (const x of [`users/${oid}/${archive}`, `users/${oid}/${archive}/${eve.id}`, inArchive]) expect(reason(await tryShare(owner, x, { add: [user(ids.bob)] }))).toBe('folder_share_place')
  })
})
