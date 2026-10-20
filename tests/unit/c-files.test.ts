// Component C: the file screen API (tree, content, save, folders, move / rename, trash, history, downloads, small
// uploads, files.changed) on the shared fixture: alice = member (marketing), bob = member (finance), carol = admin,
// dana = owner, erin = member (marketing).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiClient, type FileEntry } from '@mycel/shared/api'
import { exists, jsonBody, makeCApp, sha256hex, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('c-files') })
afterAll(async () => { await A.close() })
const T = () => A.team
const write = (rel: string, s: string | Uint8Array) => { const p = path.join(T(), rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const read = (rel: string) => fs.readFileSync(path.join(T(), rel), 'utf8')
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()

describe('tree', () => {
  test('lists only what the caller may see; ancestors of visible folders appear for navigation with access none', async () => {
    const root = await A.json('/api/files/tree', { as: 'alice' })
    expect(root.status).toBe(200)
    const names = root.body.entries.map((e: FileEntry) => e.name)
    expect(names).toEqual(expect.arrayContaining(['groups', 'projects', 'shared', 'skills', 'users']))
    expect(names).not.toContain('CLAUDE.md') // root files: no access
    expect(names).not.toContain('.system')
    expect(root.body.entries.find((e: FileEntry) => e.name === 'groups').access).toBe('none')
    const groups = await A.json('/api/files/tree' + q({ path: 'groups' }), { as: 'alice' })
    expect(groups.body.entries.map((e: FileEntry) => e.name)).toEqual(['marketing'])
    const mk = await A.json('/api/files/tree' + q({ path: 'groups/marketing' }), { as: 'alice' })
    const mkNames = mk.body.entries.map((e: FileEntry) => e.name)
    expect(mk.body.access).toBe('write')
    expect(mkNames).not.toContain('salaries') // a 'none' rule inside a writable folder
    expect(mkNames).not.toContain('budget-link.md') // symlink
    expect(mkNames).not.toContain('margin-copy.md') // hard link
    expect(mkNames.indexOf('campaigns')).toBeLessThan(mkNames.indexOf('brand-guidelines.docx')) // folders first
    const brief = mk.body.entries.find((e: FileEntry) => e.name === 'campaign-brief.md')
    expect(brief).toMatchObject({ type: 'file', path: 'groups/marketing/campaign-brief.md', access: 'write' })
    expect(brief.mime).toContain('text/markdown')
  })
  test('hidden and missing folders look the same (404)', async () => {
    const hidden = await A.json('/api/files/tree' + q({ path: 'groups/finance' }), { as: 'alice' })
    const missing = await A.json('/api/files/tree' + q({ path: 'groups/nope' }), { as: 'alice' })
    expect(hidden.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(hidden.body).toEqual({ error: { ...missing.body.error, requestId: hidden.body.error.requestId } })
    expect((await A.json('/api/files/tree' + q({ path: '.system' }), { as: 'dana' })).status).toBe(404)
    expect((await A.json('/api/files/tree' + q({ path: 'users/bob' }), { as: 'carol' })).status).toBe(404)
  })
  test('paging with an opaque cursor', async () => {
    for (let i = 0; i < 7; i++) write(`shared/paging/f${i}.md`, 'x')
    const a = await A.json('/api/files/tree' + q({ path: 'shared/paging', limit: '3' }), { as: 'alice' })
    expect(a.body.entries.length).toBe(3)
    const b = await A.json('/api/files/tree' + q({ path: 'shared/paging', limit: '3', cursor: a.body.nextCursor }), { as: 'alice' })
    const c = await A.json('/api/files/tree' + q({ path: 'shared/paging', limit: '3', cursor: b.body.nextCursor }), { as: 'alice' })
    expect([...a.body.entries, ...b.body.entries, ...c.body.entries].map((e: FileEntry) => e.name)).toEqual(['f0.md', 'f1.md', 'f2.md', 'f3.md', 'f4.md', 'f5.md', 'f6.md'])
    expect(c.body.nextCursor).toBeNull()
  })
  test('needs a session; a bad path shape is a validation error', async () => {
    expect((await A.req('/api/files/tree')).status).toBe(401)
    expect((await A.json('/api/files/tree' + q({ path: '../etc' }), { as: 'alice' })).status).toBe(400)
  })
})

describe('content + save', () => {
  test('text content with sha256 (body and header); binary files are flagged; truncation', async () => {
    const r = await A.json('/api/files/content' + q({ path: 'shared/glossary.md' }), { as: 'alice' })
    expect(r.status).toBe(200)
    expect(r.body.content).toContain('ARR')
    expect(r.body.sha256).toBe(sha256hex(fs.readFileSync(path.join(T(), 'shared/glossary.md'))))
    expect(r.res.headers.get('x-content-sha256')).toBe(r.body.sha256)
    expect(r.body.binary).toBe(false)
    const pdf = await A.json('/api/files/content' + q({ path: 'shared/handbook.pdf' }), { as: 'alice' })
    expect(pdf.body).toMatchObject({ binary: true, content: null })
    write('shared/long.md', '가'.repeat(100))
    const cut = await A.json('/api/files/content' + q({ path: 'shared/long.md', maxBytes: '10' }), { as: 'alice' })
    expect(cut.body.truncated).toBe(true)
    expect(cut.body.content).toBe('가'.repeat(3)) // 10 bytes = 3 whole characters, the cut one dropped
    expect((await A.json('/api/files/content' + q({ path: 'groups/finance/budget.md' }), { as: 'alice' })).status).toBe(404)
  })
  test('save: version kept, conflict copy when the file changed since it was loaded', async () => {
    const p = 'shared/save-me.md'
    write(p, 'one\n')
    const first = await A.json('/api/files/content' + q({ path: p }), { as: 'alice' })
    A.hub.clear()
    const s1 = await A.json('/api/files/content', { ...jsonBody({ path: p, content: 'two\n', baseSha256: first.body.sha256 }, 'PUT'), as: 'alice' })
    expect(s1.status).toBe(200)
    expect(s1.body).toMatchObject({ path: p, conflict: false })
    expect(read(p)).toBe('two\n')
    // erin edits with the stale hash -> conflict copy, original untouched
    const s2 = await A.json('/api/files/content', { ...jsonBody({ path: p, content: 'erin\n', baseSha256: first.body.sha256 }, 'PUT'), as: 'erin' })
    expect(s2.body.conflict).toBe(true)
    expect(s2.body.path).toMatch(/^shared\/save-me \(충돌 사본 - Erin Yoo \d{4}-\d\d-\d\d \d\d\.\d\d\)\.md$/)
    expect(read(p)).toBe('two\n')
    expect(read(s2.body.path)).toBe('erin\n')
    const h = await A.json('/api/files/history' + q({ path: p }), { as: 'alice' })
    expect(h.body.items.map((v: any) => v.kind)).toEqual(['conflict_copy', 'edit'])
    expect(h.body.items[0].conflictPath).toBe(s2.body.path)
    expect(A.hub.of('files.changed', 'bob').length).toBeGreaterThan(0) // shared/ is readable by everyone
    // a new file with baseSha256 null
    const s3 = await A.json('/api/files/content', { ...jsonBody({ path: 'shared/new/dir/n.md', content: 'n', baseSha256: null }, 'PUT'), as: 'alice' })
    expect(s3.status).toBe(200)
    expect(read('shared/new/dir/n.md')).toBe('n')
  })
  test('save refuses binary targets, read-only folders and hidden paths', async () => {
    expect((await A.json('/api/files/content', { ...jsonBody({ path: 'shared/x.docx', content: 'x', baseSha256: null }, 'PUT'), as: 'alice' })).status).toBe(400)
    expect((await A.json('/api/files/content', { ...jsonBody({ path: 'skills/team-rules.md', content: 'x', baseSha256: null }, 'PUT'), as: 'alice' })).status).toBe(403)
    expect((await A.json('/api/files/content', { ...jsonBody({ path: 'groups/finance/budget.md', content: 'x', baseSha256: null }, 'PUT'), as: 'alice' })).status).toBe(404)
    expect(read('groups/finance/budget.md')).toContain('CANARY-FIN-7731')
  })
})

describe('mkdir / move / rename', () => {
  test('mkdir: 201, name rules, near-duplicate and existing names refused', async () => {
    const r = await A.json('/api/files/mkdir', { ...jsonBody({ path: 'shared/Reports' }), as: 'alice' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ type: 'folder', path: 'shared/Reports', access: 'write' })
    expect((await A.json('/api/files/mkdir', { ...jsonBody({ path: 'shared/Reports' }), as: 'alice' })).status).toBe(409)
    expect((await A.json('/api/files/mkdir', { ...jsonBody({ path: 'shared/ｒｅｐｏｒｔｓ' }), as: 'alice' })).status).toBe(400) // fullwidth look-alike
    expect((await A.json('/api/files/mkdir', { ...jsonBody({ path: 'shared/CON' }), as: 'alice' })).status).toBe(400)
    expect((await A.json('/api/files/mkdir', { ...jsonBody({ path: 'skills/x' }), as: 'alice' })).status).toBe(403)
  })
  test('rename a file; history follows the file', async () => {
    write('shared/mv/a.md', 'v1')
    await A.json('/api/files/content', { ...jsonBody({ path: 'shared/mv/a.md', content: 'v2', baseSha256: sha256hex('v1') }, 'PUT'), as: 'alice' })
    const r = await A.json('/api/files/move', { ...jsonBody({ from: 'shared/mv/a.md', to: 'shared/mv/b.md' }), as: 'alice' })
    expect(r.status).toBe(200)
    expect(r.body.entry.path).toBe('shared/mv/b.md')
    expect(exists(T(), 'shared/mv/a.md')).toBe(false)
    expect((await A.json('/api/files/history' + q({ path: 'shared/mv/b.md' }), { as: 'alice' })).body.items.length).toBe(1)
    // onExists
    write('shared/mv/c.md', 'c')
    expect((await A.json('/api/files/move', { ...jsonBody({ from: 'shared/mv/c.md', to: 'shared/mv/b.md' }), as: 'alice' })).status).toBe(409)
    const ren = await A.json('/api/files/move', { ...jsonBody({ from: 'shared/mv/c.md', to: 'shared/mv/b.md', onExists: 'rename' }), as: 'alice' })
    expect(ren.body.entry.path).toBe('shared/mv/b (2).md')
  })
  test('moving onto a path that still has history from an earlier file continues the version numbers', async () => {
    write('shared/hv/old.md', 'o1')
    await A.json('/api/files/content', { ...jsonBody({ path: 'shared/hv/old.md', content: 'o2', baseSha256: sha256hex('o1') }, 'PUT'), as: 'alice' })
    await A.json('/api/files' + q({ path: 'shared/hv/old.md' }), { method: 'DELETE', as: 'alice' })
    write('shared/hv/new.md', 'n1')
    await A.json('/api/files/content', { ...jsonBody({ path: 'shared/hv/new.md', content: 'n2', baseSha256: sha256hex('n1') }, 'PUT'), as: 'alice' })
    const r = await A.json('/api/files/move', { ...jsonBody({ from: 'shared/hv/new.md', to: 'shared/hv/old.md' }), as: 'alice' })
    expect(r.status).toBe(200)
    const h = await A.json('/api/files/history' + q({ path: 'shared/hv/old.md' }), { as: 'alice' })
    expect(h.body.items.map((v: any) => [v.version, v.sha256])).toEqual([[2, sha256hex('n1')], [1, sha256hex('o1')]])
  })
  test('moving a folder carries its rules and projects (folders.path follows)', async () => {
    const db = A.ctx.db
    write('groups/marketing/q4/plan.md', 'plan')
    db.query("INSERT INTO folders (id, path) VALUES ('f_q4_secret', 'groups/marketing/q4/secret')").run()
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_q4', 'f_q4_secret', 'user', 'erin', 'none')").run()
    write('groups/marketing/q4/secret/s.md', 'secret')
    db.query("INSERT INTO projects (id, name, folder_path) VALUES ('p_q4', 'Q4', 'groups/marketing/q4')").run()
    // erin can't touch the secret subfolder, so she may not move its parent
    expect((await A.json('/api/files/move', { ...jsonBody({ from: 'groups/marketing/q4', to: 'groups/marketing/q4-old' }), as: 'erin' })).status).toBe(403)
    const r = await A.json('/api/files/move', { ...jsonBody({ from: 'groups/marketing/q4', to: 'groups/marketing/campaigns/q4' }), as: 'alice' })
    expect(r.status).toBe(200)
    expect((db.query("SELECT path FROM folders WHERE id = 'f_q4_secret'").get() as any).path).toBe('groups/marketing/campaigns/q4/secret')
    expect((db.query("SELECT folder_path FROM projects WHERE id = 'p_q4'").get() as any).folder_path).toBe('groups/marketing/campaigns/q4')
    // the rule still applies at the new place
    expect((await A.json('/api/files/content' + q({ path: 'groups/marketing/campaigns/q4/secret/s.md' }), { as: 'erin' })).status).toBe(404)
    expect((await A.json('/api/files/content' + q({ path: 'groups/marketing/campaigns/q4/secret/s.md' }), { as: 'alice' })).status).toBe(200)
  })
  test('cannot move into itself, into a read-only or hidden place, or move protected folders', async () => {
    write('shared/loop/x.md', 'x')
    expect((await A.json('/api/files/move', { ...jsonBody({ from: 'shared/loop', to: 'shared/loop/inner' }), as: 'alice' })).status).toBe(400)
    expect((await A.json('/api/files/move', { ...jsonBody({ from: 'shared/loop/x.md', to: 'skills/x.md' }), as: 'alice' })).status).toBe(403)
    expect((await A.json('/api/files/move', { ...jsonBody({ from: 'shared/loop/x.md', to: 'groups/finance/x.md' }), as: 'alice' })).status).toBe(404)
    expect((await A.json('/api/files/move', { ...jsonBody({ from: 'users/alice', to: 'shared/alice' }), as: 'alice' })).status).toBe(403)
    expect((await A.json('/api/files/move', { ...jsonBody({ from: 'groups/finance/budget.md', to: 'shared/budget.md' }), as: 'alice' })).status).toBe(404)
    expect(read('groups/finance/budget.md')).toContain('CANARY')
  })
  test('a folder with a rule that hides part of it cannot be moved into the mover\'s own folder', async () => {
    // alice can write groups/marketing but not groups/marketing/salaries (none rule): moving the parent is refused
    expect((await A.json('/api/files/move', { ...jsonBody({ from: 'groups/marketing', to: 'users/alice/marketing' }), as: 'alice' })).status).toBe(403)
    expect(exists(T(), 'groups/marketing/salaries/2026.md')).toBe(true)
  })
  test('case-only rename on a case-insensitive volume', async () => {
    write('shared/case/readme.md', 'r')
    const r = await A.json('/api/files/move', { ...jsonBody({ from: 'shared/case/readme.md', to: 'shared/case/README.md' }), as: 'alice' })
    if (process.platform === 'darwin') {
      expect(r.status).toBe(200)
      expect(fs.readdirSync(path.join(T(), 'shared/case'))).toEqual(['README.md'])
    } else expect([200, 409]).toContain(r.status)
  })
})

describe('trash', () => {
  test('delete a file -> trash; list (write access only), restore, restore again under a new name', async () => {
    write('shared/t/doc.md', 'keep me')
    const d = await A.json('/api/files' + q({ path: 'shared/t/doc.md' }), { method: 'DELETE', as: 'alice' })
    expect(d.status).toBe(200)
    expect(exists(T(), 'shared/t/doc.md')).toBe(false)
    const list = await A.json('/api/files/trash', { as: 'erin' })
    const item = list.body.items.find((i: any) => i.id === d.body.trashId)
    expect(item).toMatchObject({ originalPath: 'shared/t/doc.md', type: 'file', deletedBy: { id: 'alice' } })
    expect((await A.json('/api/files/trash' + q({ mine: '1' }), { as: 'erin' })).body.items.find((i: any) => i.id === d.body.trashId)).toBeUndefined()
    // bob cannot see marketing trash
    const del2 = await A.json('/api/files' + q({ path: 'groups/marketing/campaigns/email-plan.md' }), { method: 'DELETE', as: 'alice' })
    expect((await A.json('/api/files/trash', { as: 'bob' })).body.items.find((i: any) => i.id === del2.body.trashId)).toBeUndefined()
    expect((await A.json(`/api/files/trash/${del2.body.trashId}/restore`, { method: 'POST', as: 'bob' })).status).toBe(404)
    // restore
    write('shared/t/doc.md', 'a new file with the same name')
    const r = await A.json(`/api/files/trash/${d.body.trashId}/restore`, { method: 'POST', as: 'erin' })
    expect(r.status).toBe(200)
    expect(r.body.entry.path).toBe('shared/t/doc (복원됨).md')
    expect(read('shared/t/doc (복원됨).md')).toBe('keep me')
    expect((await A.json(`/api/files/trash/${d.body.trashId}/restore`, { method: 'POST', as: 'erin' })).status).toBe(404)
  })
  test('delete a folder as one item and restore it whole', async () => {
    write('shared/tf/a.md', 'a'); write('shared/tf/sub/b.md', 'bb')
    const d = await A.json('/api/files' + q({ path: 'shared/tf' }), { method: 'DELETE', as: 'alice' })
    expect(d.status).toBe(200)
    const item = (await A.json('/api/files/trash', { as: 'alice' })).body.items.find((i: any) => i.id === d.body.trashId)
    expect(item).toMatchObject({ type: 'folder', size: 3 })
    expect((await A.json(`/api/files/trash/${d.body.trashId}/restore`, { method: 'POST', as: 'alice' })).status).toBe(200)
    expect(read('shared/tf/sub/b.md')).toBe('bb')
  })
  test('protected folders and folders with hidden parts cannot be deleted', async () => {
    expect((await A.json('/api/files' + q({ path: 'users/alice' }), { method: 'DELETE', as: 'alice' })).status).toBe(403)
    expect((await A.json('/api/files' + q({ path: 'groups/marketing' }), { method: 'DELETE', as: 'alice' })).status).toBe(403)
    expect((await A.json('/api/files' + q({ path: 'skills/team-rules.md' }), { method: 'DELETE', as: 'alice' })).status).toBe(403)
  })
  test('purge: admin only; sweep removes expired items', async () => {
    write('shared/purge.md', 'p')
    const d = await A.json('/api/files' + q({ path: 'shared/purge.md' }), { method: 'DELETE', as: 'alice' })
    expect((await A.req(`/api/files/trash/${d.body.trashId}`, { method: 'DELETE', as: 'alice' })).status).toBe(403)
    expect((await A.req(`/api/files/trash/${d.body.trashId}`, { method: 'DELETE', as: 'carol' })).status).toBe(204)
    expect(A.ctx.db.query('SELECT 1 FROM trash_items WHERE id = ?').get(d.body.trashId)).toBeNull()
    write('shared/expire.md', 'e')
    const e = await A.json('/api/files' + q({ path: 'shared/expire.md' }), { method: 'DELETE', as: 'alice' })
    const storage = (A.ctx.db.query('SELECT storage_path FROM trash_items WHERE id = ?').get(e.body.trashId) as any).storage_path
    const { componentC } = await import('../../server/src/team-files/component')
    componentC(A.ctx).files.sweep(Date.now() + 31 * 86_400_000)
    expect(fs.existsSync(path.join(T(), storage))).toBe(false)
  })
})

describe('history', () => {
  test('download and restore an old version (the current content becomes a version first)', async () => {
    const p = 'shared/h.md'
    write(p, 'first')
    await A.json('/api/files/content', { ...jsonBody({ path: p, content: 'second', baseSha256: sha256hex('first') }, 'PUT'), as: 'alice' })
    const h = await A.json('/api/files/history' + q({ path: p }), { as: 'alice' })
    const v = h.body.items[0]
    expect(v).toMatchObject({ version: 1, kind: 'edit', author: { id: 'alice', name: 'Alice Kim' }, sha256: sha256hex('first') })
    const dl = await A.req(`/api/files/history/${v.id}/download`, { as: 'alice' })
    expect(await dl.text()).toBe('first')
    expect(dl.headers.get('content-disposition')).toContain('h (v1).md')
    const r = await A.json('/api/files/restore', { ...jsonBody({ path: p, versionId: v.id }), as: 'alice' })
    expect(r.status).toBe(200)
    expect(read(p)).toBe('first')
    const h2 = await A.json('/api/files/history' + q({ path: p }), { as: 'alice' })
    expect(h2.body.items.map((x: any) => x.kind)).toEqual(['restore', 'edit'])
    expect((await A.req(`/api/files/history/${v.id}/download`, { as: 'bob' })).status).toBe(200) // shared: everyone reads
  })
  test('old versions saved in a private folder stay private after the file moves to a shared one', async () => {
    const p = 'groups/finance/plan-x.md'
    write(p, 'CANARY-FIN-7731 secret draft')
    await A.json('/api/files/content', { ...jsonBody({ path: p, content: 'public text', baseSha256: sha256hex('CANARY-FIN-7731 secret draft') }, 'PUT'), as: 'bob' })
    const mv = await A.json('/api/files/move', { ...jsonBody({ from: p, to: 'shared/plan-x.md' }), as: 'bob' })
    expect(mv.status).toBe(200)
    expect((await A.json('/api/files/history' + q({ path: 'shared/plan-x.md' }), { as: 'bob' })).body.items.length).toBe(1)
    const alice = await A.json('/api/files/history' + q({ path: 'shared/plan-x.md' }), { as: 'alice' })
    expect(alice.body.items).toEqual([])
    const vid = (A.ctx.db.query("SELECT id FROM file_versions WHERE path = 'shared/plan-x.md'").get() as any).id
    expect((await A.req(`/api/files/history/${vid}/download`, { as: 'alice' })).status).toBe(404)
    expect((await A.json('/api/files/restore', { ...jsonBody({ path: 'shared/plan-x.md', versionId: vid }), as: 'alice' })).status).toBe(404)
  })
})

describe('download', () => {
  test('stream with headers, Range, If-None-Match, 416', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251)
    write('shared/bin/data.bin', bytes)
    const full = await A.req('/api/files/download' + q({ path: 'shared/bin/data.bin' }), { as: 'alice' })
    expect(full.status).toBe(200)
    expect(full.headers.get('content-length')).toBe('100000')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('content-disposition')).toStartWith('attachment;')
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes)
    const part = await A.req('/api/files/download' + q({ path: 'shared/bin/data.bin' }), { as: 'alice', headers: { range: 'bytes=10-19' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 10-19/100000')
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(10, 20))
    const tail = await A.req('/api/files/download' + q({ path: 'shared/bin/data.bin' }), { as: 'alice', headers: { range: 'bytes=-5' } })
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(-5))
    expect((await A.req('/api/files/download' + q({ path: 'shared/bin/data.bin' }), { as: 'alice', headers: { range: 'bytes=200000-' } })).status).toBe(416)
    const etag = full.headers.get('etag')!
    expect((await A.req('/api/files/download' + q({ path: 'shared/bin/data.bin' }), { as: 'alice', headers: { 'if-none-match': etag } })).status).toBe(304)
  })
  test('active content is never served as HTML from the team origin; names are encoded', async () => {
    write('shared/x/page.html', '<script>alert(1)</script>')
    const inline = await A.req('/api/files/download' + q({ path: 'shared/x/page.html', disposition: 'inline' }), { as: 'alice' })
    expect(inline.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(inline.headers.get('content-security-policy')).toContain('sandbox')
    write('shared/x/보고서 최종 (1).md', 'k')
    const k = await A.req('/api/files/download' + q({ path: 'shared/x/보고서 최종 (1).md' }), { as: 'alice' })
    expect(k.headers.get('content-disposition')).toBe("attachment; filename=\"___ __ (1).md\"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C%20%EC%B5%9C%EC%A2%85%20%281%29.md")
  })
  test('ranges are exact when the body is read as a stream (relay path) and capped per response', async () => {
    const bytes = new Uint8Array(12 * 1024 * 1024).map((_, i) => (i * 7) % 256)
    write('shared/bin/r.bin', bytes)
    const r = await A.ctx.appFetch(new Request('http://team.localhost/api/files/download' + q({ path: 'shared/bin/r.bin' }), { headers: { 'x-test-user': 'alice', range: 'bytes=100-' } }), { ip: '203.0.113.1', via: 'relay' })
    expect(r.status).toBe(206)
    const end = 100 + 8 * 1024 * 1024 - 1
    expect(r.headers.get('content-range')).toBe(`bytes 100-${end}/${bytes.length}`)
    const got = new Uint8Array(await new Response(r.body).arrayBuffer())
    expect(got.length).toBe(end - 99)
    expect(got.subarray(0, 50)).toEqual(bytes.subarray(100, 150))
    expect(got.subarray(got.length - 50)).toEqual(bytes.subarray(end - 49, end + 1))
  })
  test('over the wire (Bun.serve): whole file and a range', async () => {
    const srv = Bun.serve({ port: 19131, hostname: '127.0.0.1', fetch: (req, server) => A.app.fetch(req, { ip: server.requestIP(req)?.address ?? null, via: 'direct' }) })
    try {
      const h = { 'x-test-user': 'alice' }
      const full = await fetch('http://127.0.0.1:19131/api/files/download' + q({ path: 'shared/bin/r.bin' }), { headers: h })
      expect((await full.arrayBuffer()).byteLength).toBe(12 * 1024 * 1024)
      const part = await fetch('http://127.0.0.1:19131/api/files/download' + q({ path: 'shared/bin/r.bin' }), { headers: { ...h, range: 'bytes=5-9' } })
      expect(part.status).toBe(206)
      expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([35, 42, 49, 56, 63])
      expect(full.headers.get('x-content-type-options')).toBe('nosniff')
    } finally { srv.stop(true) }
  })
  test('hidden, linked and missing files are 404', async () => {
    for (const p of ['groups/finance/budget.md', 'groups/marketing/budget-link.md', 'groups/marketing/margin-copy.md', 'shared/nope.md', '.system/history/old.bin'])
      expect((await A.req('/api/files/download' + q({ path: p }), { as: 'alice' })).status).not.toBe(200)
  })
  test('a large file is streamed, not buffered (memory stays flat)', async () => {
    const big = path.join(T(), 'shared/bin/big.bin')
    const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 300 * 1024 * 1024); fs.closeSync(fd)
    Bun.gc(true)
    const before = process.memoryUsage().rss
    const res = await A.req('/api/files/download' + q({ path: 'shared/bin/big.bin' }), { as: 'alice' })
    const reader = res.body!.getReader()
    let n = 0
    for (let i = 0; i < 40; i++) { const { value, done } = await reader.read(); if (done) break; n += value.byteLength }
    const grew = process.memoryUsage().rss - before
    await reader.cancel()
    expect(n).toBeGreaterThan(0)
    expect(grew).toBeLessThan(100 * 1024 * 1024)
    fs.rmSync(big)
  })
})

describe('small uploads', () => {
  const up = (fields: Record<string, string>, file: File, as: 'alice' | 'bob' = 'alice') => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    fd.set('file', file)
    return A.json('/api/files/upload', { method: 'POST', body: fd, as })
  }
  test('rename (default), replace keeps a version, fail refuses', async () => {
    const a = await up({ folder: 'shared' }, new File(['hello'], 'up.txt'))
    expect(a.status).toBe(201)
    expect(a.body).toMatchObject({ path: 'shared/up.txt', size: 5 })
    const b = await up({ folder: 'shared' }, new File(['again'], 'up.txt'))
    expect(b.body.path).toBe('shared/up (2).txt')
    expect((await up({ folder: 'shared', onExists: 'fail' }, new File(['x'], 'up.txt'))).status).toBe(409)
    const c = await up({ folder: 'shared', onExists: 'replace' }, new File(['replaced'], 'up.txt'))
    expect(c.status).toBe(201)
    expect(read('shared/up.txt')).toBe('replaced')
    expect((await A.json('/api/files/history' + q({ path: 'shared/up.txt' }), { as: 'alice' })).body.items.length).toBe(1)
    const ev = A.ctx.db.query("SELECT action, sha256 FROM file_events WHERE path = 'shared/up.txt' ORDER BY id DESC LIMIT 1").get() as any
    expect(ev).toMatchObject({ action: 'upload', sha256: sha256hex('replaced') })
  })
  test('name rules, read-only and hidden targets', async () => {
    expect((await up({ folder: 'shared', name: 'a:b.txt' }, new File(['x'], 'x'))).status).toBe(400)
    expect((await up({ folder: 'shared', name: '../x.txt' }, new File(['x'], 'x'))).status).toBe(400)
    expect((await up({ folder: 'skills' }, new File(['x'], 'x.md'))).status).toBe(403)
    expect((await up({ folder: 'groups/finance' }, new File(['x'], 'x.md'))).status).toBe(404)
  })
  test('office uploads are pre-extracted into the grep cache', async () => {
    const docx = fs.readFileSync(path.join(T(), 'groups/marketing/brand-guidelines.docx'))
    const r = await up({ folder: 'shared', name: 'brand-copy.docx' }, new File([docx], 'x.docx'))
    expect(r.status).toBe(201)
    const cache = A.ctx.files.office.cachePath('shared/brand-copy.docx')
    for (let i = 0; i < 100 && !fs.existsSync(cache); i++) await Bun.sleep(50)
    expect(fs.readFileSync(cache, 'utf8')).toContain('Pretendard')
    const g = await A.ctx.files.call('grep', { pattern: 'Pretendard', path: 'shared' }, { user: A.ctx.files.principal('alice'), turnId: null, files: new (await import('../../server/src/files/service')).TurnFiles() })
    expect(g.text).toContain('shared/brand-copy.docx')
  })
})

describe('files.changed', () => {
  test('only people who can read the path hear about it; a move out of sight looks like a delete', async () => {
    A.hub.clear()
    write('groups/marketing/notice.md', 'n')
    await A.json('/api/files/move', { ...jsonBody({ from: 'groups/marketing/notice.md', to: 'shared/notice.md' }), as: 'alice' })
    const forAlice = A.hub.of('files.changed', 'alice').flatMap((e) => e.data.changes)
    const forBob = A.hub.of('files.changed', 'bob').flatMap((e) => e.data.changes)
    expect(forAlice).toContainEqual(expect.objectContaining({ action: 'move', path: 'shared/notice.md', from: 'groups/marketing/notice.md' }))
    expect(forBob).toContainEqual(expect.objectContaining({ action: 'create', path: 'shared/notice.md' }))
    expect(JSON.stringify(forBob)).not.toContain('groups/marketing')
    A.hub.clear()
    write('groups/finance/f.md', 'CANARY-FIN-7731')
    await A.json('/api/files' + q({ path: 'groups/finance/f.md' }), { method: 'DELETE', as: 'bob' })
    expect(A.hub.of('files.changed', 'alice')).toEqual([])
    expect(A.hub.of('files.changed', 'bob').length).toBe(1)
  })
  test('AI tool writes are published too', async () => {
    A.hub.clear()
    await A.ctx.files.call('write', { file_path: 'shared/from-ai.md', content: 'hi' }, A.toolCtx('alice', null))
    expect(A.hub.of('files.changed', 'erin').flatMap((e) => e.data.changes)).toContainEqual(expect.objectContaining({ path: 'shared/from-ai.md', action: 'create' }))
  })
})

describe('typed client', () => {
  test('ApiClient round trip (tree + download stream)', async () => {
    const api = new ApiClient({ baseUrl: 'http://team.localhost', fetch: ((u: string, i: RequestInit) => { const h = new Headers(i.headers); h.set('x-test-user', 'alice'); return A.app.fetch(new Request(u, { ...i, headers: h }), { ip: null, via: 'test' }) }) as unknown as typeof fetch })
    const t = await api.call(API.tree, { query: { path: 'shared' } })
    expect(t.entries.length).toBeGreaterThan(3)
    const res = await api.call(API.download, { query: { path: 'shared/glossary.md' } })
    expect(await res.text()).toContain('Glossary')
  })
})
