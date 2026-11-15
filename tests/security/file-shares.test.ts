// Files shared one by one (QA TC-3093, server/src/files/shares.ts; docs/DECISIONS.md "A member shares their own files").
// One test per leak path the plan review named. What must hold:
//  1. A grant opens the file's current bytes by its link, and nothing else: no versions, history, extracted text, path,
//     folder or neighbours; the permission function (RuleSet), search, the AI's file tools and the file list never see
//     the file through a grant.
//  2. The link page says nothing about a file to someone it does not open for (no name, type or owner), and ids are not
//     guessed (128 random bits; any other string is "unknown").
//  3. Only the owner (with edit access) shares; nobody becomes the owner by making the link or moving the file; never a
//     folder; never a guest; a guest gets nothing through a link.
//  4. A grant never widens past what its owner chose: someone else's narrowing move removes it; a different file at
//     the same path never inherits it.
//  5. Requests are capped and their note is plain text; admins gain nothing on personal files.
// Fixture: olga = owner, adam = admin; alice, bob, carl; gina is a guest.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { RuleSet } from '../../server/src/policy/access'
import { makeHandler } from '../../server/src/mcp/protocol'
import { TurnFiles } from '../../server/src/files/service'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'

let h: Harness
let owner: Client, admin: Client, alice: Client, bob: Client, carl: Client, gina: Client
let ids: Record<'alice' | 'bob' | 'carl' | 'gina', string>
const q = (p: string) => '?path=' + encodeURIComponent(p)
const put = (c: Client, p: string, content: string) => c.call('PUT', '/api/files/content', { path: p, content, baseSha256: null })
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })
let secret: string, linkId: string

beforeAll(async () => {
  h = await harness('sec-file-shares')
  owner = await withOwner(h)
  admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  const al = await addMember(h, owner, { username: 'alice' })
  const b = await addMember(h, owner, { username: 'bob' })
  const c = await addMember(h, owner, { username: 'carl' })
  const g = await addMember(h, owner, { username: 'gina' })
  h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(g.id)
  alice = al.client; bob = b.client; carl = c.client; gina = g.client
  ids = { alice: al.id, bob: b.id, carl: c.id, gina: g.id }
  // alice's personal file in a folder whose name is itself private, with two versions and a neighbour
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'users', ids.alice, 'resignation'), { recursive: true })
  secret = `users/${ids.alice}/resignation/letter-banana.txt`
  await put(alice, secret, 'first banana draft')
  const first = (await alice.call('GET', '/api/files/content' + q(secret))).sha256
  await alice.call('PUT', '/api/files/content', { path: secret, content: 'final banana letter', baseSha256: first })
  await put(alice, `users/${ids.alice}/resignation/neighbour.txt`, 'next door')
  linkId = (await alice.call('PUT', '/api/files/shares', { path: secret, add: [user(ids.bob)], remove: [] })).link.id
}, 60_000)
afterAll(() => h.close())

describe('1. a grant opens the current bytes and nothing else', () => {
  test('the link page and its bytes; no path, no folder in the answer', async () => {
    const v = await bob.call('GET', `/api/files/shared/${linkId}`)
    expect(Object.keys(v).sort()).toEqual(['mime', 'mine', 'name', 'sharedBy', 'size', 'status'])
    expect(JSON.stringify(v)).not.toContain('resignation')
    expect(JSON.stringify(v)).not.toContain('users/')
    expect(await (await bob.raw('GET', `/api/files/shared/${linkId}/download`)).text()).toBe('final banana letter')
  })

  test('no versions, history, extracted text or other endpoint by id; the path endpoints stay closed', async () => {
    for (const p of [`/api/files/shared/${linkId}/history`, `/api/files/shared/${linkId}/content`, `/api/files/shared/${linkId}/versions`, `/api/files/shared/${linkId}/text`]) {
      expect([404, 405]).toContain((await bob.raw('GET', p)).status)
    }
    for (const p of ['/api/files/content', '/api/files/history', '/api/files/download', '/api/files/tree', '/api/files/preview']) {
      expect((await bob.try('GET', p + q(secret))).status).toBe(404)
    }
    expect((await bob.try('GET', '/api/files/tree' + q(`users/${ids.alice}/resignation`))).status).toBe(404)
    expect((await bob.try('GET', '/api/files/shares' + q(secret))).status).toBe(404)
  })

  test('the permission function, search and the AI\'s file tools never see it through a grant', async () => {
    const rules = RuleSet.load(h.ctx.db)
    expect(rules.access(h.ctx.files.principal(ids.bob), secret.split('/'))).toBe('none')
    const found = await bob.try('GET', '/api/files/find?q=banana')
    expect(JSON.stringify(found.body)).not.toContain('letter-banana')
    const hits = await bob.try('GET', '/api/files/search?q=banana')
    expect(JSON.stringify(hits.body ?? {})).not.toContain('banana letter')
    let n = 0
    const call = async (name: string, args: unknown) => {
      const handler = makeHandler(h.ctx.files, h.ctx.db, { user: h.ctx.files.principal(ids.bob), turnId: null, files: new TurnFiles() } as any)
      const r = await handler({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })
      return { text: r.result.content[0].text as string, isError: !!r.result.isError }
    }
    expect((await call('read', { file_path: secret })).isError).toBe(true)
    expect((await call('grep', { pattern: 'banana', path: '' })).text).not.toContain('final banana letter')
    expect((await call('glob', { pattern: '**/*banana*' })).text).not.toContain('letter-banana')
    expect((await call('share_file', { path: secret, mode: 'preview' })).isError).toBe(true)
  })
})

describe('2. the link page says nothing to others; ids are not guessed', () => {
  test('no access: no name, type or owner, the same fields for every such case', async () => {
    const r = await carl.call('GET', `/api/files/shared/${linkId}`)
    expect(r).toEqual({ status: 'no_access', canAsk: true, askedAt: null })
    expect((await carl.raw('GET', `/api/files/shared/${linkId}/download`)).status).toBe(404)
  })

  test('any other id is unknown, and the bytes 404', async () => {
    for (const id of ['x', '../../etc/passwd', linkId.slice(0, 21) + (linkId.endsWith('A') ? 'B' : 'A'), 'A'.repeat(22), `${linkId}x`]) {
      const r = await carl.try('GET', `/api/files/shared/${encodeURIComponent(id)}`)
      expect([200, 400, 404]).toContain(r.status)
      if (r.status === 200) expect(r.body).toEqual({ status: 'unknown' })
      expect((await carl.raw('GET', `/api/files/shared/${encodeURIComponent(id)}/download`)).status).not.toBe(200)
    }
    expect(linkId).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })
})

describe('3. only the owner shares; nobody becomes the owner by the link or a move; no folders; no guests', () => {
  test('a viewer\'s Copy link and an admin\'s move never make them the owner', async () => {
    await put(alice, 'shared/plan.txt', 'p')
    await bob.call('POST', '/api/files/link', { path: 'shared/plan.txt' })
    await admin.call('POST', '/api/files/move', { from: 'shared/plan.txt', to: 'shared/plan-2.txt' })
    expect((await bob.call('GET', '/api/files/shares' + q('shared/plan-2.txt'))).owner.id).toBe(ids.alice)
    expect((await bob.try('PUT', '/api/files/shares', { path: 'shared/plan-2.txt', add: [user(ids.carl)], remove: [] })).status).toBe(403)
  })

  test('folders, path tricks and other people\'s personal files are refused', async () => {
    for (const p of ['shared', `users/${ids.alice}`, `users/${ids.alice}/resignation`, '../etc/passwd', `users/${ids.alice}/../${ids.bob}/x`, '.system/x', '/etc/passwd']) {
      const a = await bob.try('POST', '/api/files/link', { path: p })
      expect(a.status).not.toBe(200)
      const b = await bob.try('PUT', '/api/files/shares', { path: p, add: [user(ids.carl)], remove: [] })
      expect(b.status).not.toBe(200)
    }
  })

  test('a guest is never added and gets nothing through a link', async () => {
    expect((await alice.try('PUT', '/api/files/shares', { path: secret, add: [user(ids.gina)], remove: [] })).status).toBe(400)
    // even a guest who somehow had a grant row gets nothing
    h.ctx.db.query("INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?, 'user', ?, 'view', ?, ?, 'dialog')").run(linkId, ids.gina, ids.alice, new Date().toISOString())
    const r = await gina.try('GET', `/api/files/shared/${linkId}`)
    expect(r.status === 403 || r.body?.status !== 'open').toBe(true)
    expect((await gina.raw('GET', `/api/files/shared/${linkId}/download`)).status).not.toBe(200)
    expect((await gina.try('POST', `/api/files/shared/${linkId}/request`, {})).status).not.toBe(200)
    h.ctx.db.query("DELETE FROM file_share_grants WHERE subject_id = ?").run(ids.gina)
  })
})

describe('4. a grant never widens past what its owner chose', () => {
  test('someone else\'s move into their own folder drops the grants', async () => {
    await put(alice, 'shared/to-narrow.txt', 'n')
    const id = (await alice.call('PUT', '/api/files/shares', { path: 'shared/to-narrow.txt', add: [user(ids.bob)], remove: [] })).link.id
    await carl.call('POST', '/api/files/move', { from: 'shared/to-narrow.txt', to: `users/${ids.carl}/to-narrow.txt`, confirm: true })
    expect((await bob.call('GET', `/api/files/shared/${id}`)).status).toBe('no_access')
  })

  test('a different file put at the same path on the disk does not inherit the grants', async () => {
    const p = `users/${ids.alice}/swap.txt`
    await put(alice, p, 'mine')
    const id = (await alice.call('PUT', '/api/files/shares', { path: p, add: [user(ids.bob)], remove: [] })).link.id
    const abs = path.join(h.ctx.files.fx.root, ...p.split('/'))
    fs.rmSync(abs)
    fs.writeFileSync(abs, 'not the shared one')
    expect((await bob.call('GET', `/api/files/shared/${id}`)).status).toBe('no_access')
    expect((await bob.raw('GET', `/api/files/shared/${id}/download`)).status).toBe(404)
  })
})

describe('5. requests are capped and plain; admins gain nothing on personal files', () => {
  test('a note is stored as plain text, capped, control characters out; one waiting per person and file', async () => {
    const r = await carl.call('POST', `/api/files/shared/${linkId}/request`, { message: '<img src=x onerror=alert(1)>\u0007 please' })
    expect(r.status).toBe('sent')
    const row = h.ctx.db.query('SELECT message FROM file_access_requests WHERE requester_id = ?').get(ids.carl) as { message: string }
    expect(row.message).toBe('<img src=x onerror=alert(1)> please')
    expect((await carl.call('POST', `/api/files/shared/${linkId}/request`, {})).status).toBe('already')
    expect((await carl.try('POST', `/api/files/shared/${linkId}/request`, { message: 'x'.repeat(501) })).status).toBe(400)
  })

  test('5 a day to one owner, 20 an hour in all', async () => {
    const made: string[] = []
    for (let i = 0; i < 6; i++) {
      const p = `users/${ids.alice}/many-${i}.txt`
      await put(alice, p, String(i))
      made.push((await alice.call('POST', '/api/files/link', { path: p })).id)
    }
    const st: number[] = []
    for (const id of made) st.push((await owner.try('POST', `/api/files/shared/${id}/request`, {})).status)
    expect(st).toEqual([200, 200, 200, 200, 200, 429])
    // 20 requests to other owners in the last hour (rows as the server keeps them): the next one is refused too
    const now = new Date().toISOString()
    for (let i = 0; i < 20; i++) h.ctx.db.query("INSERT INTO file_access_requests (id, share_id, requester_id, owner_id, message, state, created_at) VALUES (?, ?, ?, ?, NULL, 'closed', ?)").run(`fill-${i}`, linkId, ids.bob, `other-${i}`, now)
    await put(carl, `users/${ids.carl}/c.txt`, 'c')
    const cid = (await carl.call('POST', '/api/files/link', { path: `users/${ids.carl}/c.txt` })).id
    expect((await bob.try('POST', `/api/files/shared/${cid}/request`, {})).status).toBe(429)
  })

  test('an admin opening a personal file\'s link gets no access; the audit says "a personal file", never its path', async () => {
    expect((await admin.call('GET', `/api/files/shared/${linkId}`)).status).toBe('no_access')
    expect((await admin.raw('GET', `/api/files/shared/${linkId}/download`)).status).toBe(404)
    const rows = h.ctx.db.query("SELECT target, detail FROM audit_log WHERE action LIKE 'file.%'").all() as { target: string | null; detail: string | null }[]
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(`${r.target} ${r.detail}`).not.toContain('resignation')
      expect(`${r.target} ${r.detail}`).not.toContain(`users/${ids.alice}`)
    }
    const audit = await admin.call('GET', '/api/admin/audit?limit=200')
    expect(JSON.stringify(audit)).not.toContain('resignation')
  })
})
