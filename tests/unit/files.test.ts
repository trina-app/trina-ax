import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { sha256 } from '../../server/src/files/store'

const env = makeEnv('unit-files')
const T = env.fx.team
const read = (p: string) => fs.readFileSync(path.join(T, p), 'utf8')
const events = (p: string) => env.db.query('SELECT action, user_id FROM file_events WHERE path = ? ORDER BY id').all(p) as any[]

describe('read / write / edit', () => {
  test('edit without read is refused; after read it works and keeps the old version', async () => {
    const c = env.ctx('alice', 't1')
    expect((await env.files.call('edit', { file_path: 'shared/edit-me.md', old_string: 'DRAFT', new_string: 'FINAL' }, c)).text).toMatch(/read .* first/)
    await env.files.call('read', { file_path: 'shared/edit-me.md' }, c)
    const r = await env.files.call('edit', { file_path: 'shared/edit-me.md', old_string: 'DRAFT', new_string: 'FINAL' }, c)
    expect(r.isError).toBeFalsy()
    expect(read('shared/edit-me.md')).toContain('FINAL')
    const v = env.db.query("SELECT * FROM file_versions WHERE path = 'shared/edit-me.md'").all() as any[]
    expect(v.length).toBe(1)
    expect(fs.readFileSync(path.join(T, ...v[0].storage_path.split('/')), 'utf8')).toContain('DRAFT')
    expect(events('shared/edit-me.md').map((e) => e.action)).toEqual(['update'])
  })
  test('second edit in the same turn works without re-reading (own write updates the remembered hash)', async () => {
    const c = env.ctx('alice', 't2')
    await env.files.call('read', { file_path: 'shared/edit-me.md' }, c)
    expect((await env.files.call('edit', { file_path: 'shared/edit-me.md', old_string: 'Owner: nobody', new_string: 'Owner: alice' }, c)).isError).toBeFalsy()
    expect((await env.files.call('edit', { file_path: 'shared/edit-me.md', old_string: 'Owner: alice', new_string: 'Owner: Alice Kim' }, c)).isError).toBeFalsy()
  })
  test('overwrite of an existing file needs a read; new file does not', async () => {
    const c = env.ctx('alice', 't3')
    expect((await env.files.call('write', { file_path: 'shared/glossary.md', content: 'x' }, c)).isError).toBe(true)
    expect((await env.files.call('write', { file_path: 'users/alice/new/deep/note.md', content: '# hi' }, c)).isError).toBeFalsy()
    expect(read('users/alice/new/deep/note.md')).toBe('# hi')
  })
  test('office binaries cannot be written as text', async () => {
    const r = await env.files.call('write', { file_path: 'users/alice/x.docx', content: 'x' }, env.ctx('alice'))
    expect(r.isError).toBe(true)
  })
  test('temp files never left behind and never listed', async () => {
    const all: string[] = []
    const w = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory() && !e.isSymbolicLink()) w(path.join(d, e.name)); else all.push(e.name) } }
    w(T)
    expect(all.filter((n) => n.startsWith('.mycel-tmp-'))).toEqual([])
  })
  test('read converts office documents', async () => {
    const c = env.ctx('alice')
    expect((await env.files.call('read', { file_path: 'groups/marketing/brand-guidelines.docx' }, c)).text).toContain('Pretendard')
    expect((await env.files.call('read', { file_path: 'groups/marketing/campaign-spend-q3.xlsx' }, c)).text).toContain('3500000')
    expect((await env.files.call('read', { file_path: 'groups/marketing/q4-kickoff.pptx' }, c)).text).toContain('Instagram 40%')
    expect((await env.files.call('read', { file_path: 'shared/handbook.pdf' }, c)).text).toContain('Annual leave is 17 days')
  })
})

describe('concurrent edits: no lost writes', () => {
  test('two turns read, both edit: first wins, second becomes a conflict copy', async () => {
    const a = env.ctx('alice', 'ta'), e = env.ctx('erin', 'te')
    await env.files.call('read', { file_path: 'groups/marketing/campaign-brief.md' }, a)
    await env.files.call('read', { file_path: 'groups/marketing/campaign-brief.md' }, e)
    expect((await env.files.call('edit', { file_path: 'groups/marketing/campaign-brief.md', old_string: 'by 12%', new_string: 'by 15%' }, a)).isError).toBeFalsy()
    const r = await env.files.call('edit', { file_path: 'groups/marketing/campaign-brief.md', old_string: 'Launch date: 2026-11-03', new_string: 'Launch date: 2026-11-10' }, e)
    expect(r.text).toMatch(/^Conflict/)
    expect(r.text).toContain('Alice Kim')
    const orig = read('groups/marketing/campaign-brief.md')
    expect(orig).toContain('by 15%'); expect(orig).toContain('2026-11-03')
    const copy = fs.readdirSync(path.join(T, 'groups/marketing')).find((n) => n.includes('충돌 사본 - Erin Yoo'))!
    expect(copy).toMatch(/^campaign-brief \(충돌 사본 - Erin Yoo \d{4}-\d\d-\d\d \d\d\.\d\d\)\.md$/)
    const c = read('groups/marketing/' + copy)
    expect(c).toContain('2026-11-10'); expect(c).toContain('by 15%')
    expect((env.db.query("SELECT kind FROM file_versions WHERE conflict_path IS NOT NULL").all() as any[]).length).toBe(1)
    expect(events('groups/marketing/campaign-brief.md').map((x) => x.action)).toEqual(['update', 'conflict'])
  })
  test('a person saving in the file screen between read and write also triggers a conflict copy', async () => {
    const a = env.ctx('alice', 'tb')
    await env.files.call('read', { file_path: 'shared/policies/remote-work-v2.md' }, a)
    const base = sha256(fs.readFileSync(path.join(T, 'shared/policies/remote-work-v2.md')))
    env.files.humanSave('bob', 'shared/policies/remote-work-v2.md', Buffer.from(read('shared/policies/remote-work-v2.md') + '- 사람이 고침\n'), base)
    const r = await env.files.call('write', { file_path: 'shared/policies/remote-work-v2.md', content: 'AI version' }, a)
    expect(r.text).toMatch(/^Conflict/); expect(r.text).toContain('Bob Lee')
    expect(read('shared/policies/remote-work-v2.md')).toContain('사람이 고침')
  })
  test('human save with a stale base hash is a conflict too', () => {
    const r = env.files.humanSave('erin', 'shared/policies/remote-work-v2.md', Buffer.from('stale'), sha256('something else'))
    expect(r.text).toMatch(/^Conflict/)
  })
  test('30 turns racing on one file: every change ends up in the file or in a conflict copy', async () => {
    fs.writeFileSync(path.join(T, 'shared/race.md'), 'line0\n')
    const ctxs = Array.from({ length: 30 }, (_, i) => env.ctx(i % 2 ? 'alice' : 'erin', 'race' + i))
    await Promise.all(ctxs.map((c) => env.files.call('read', { file_path: 'shared/race.md' }, c)))
    const res = await Promise.all(ctxs.map((c, i) => env.files.call('edit', { file_path: 'shared/race.md', old_string: 'line0', new_string: `line0\nMARK-${i}` }, c)))
    const final = read('shared/race.md')
    const copies = fs.readdirSync(path.join(T, 'shared')).filter((n) => n.startsWith('race (충돌 사본')).map((n) => read('shared/' + n))
    for (let i = 0; i < 30; i++) {
      const inFinal = final.includes(`MARK-${i}\n`) || final.endsWith(`MARK-${i}`)
      const inCopies = copies.filter((c) => c.includes(`MARK-${i}`)).length
      expect(inFinal || inCopies >= 1).toBe(true)
    }
    expect(res.filter((r) => !r.isError && !r.text.startsWith('Conflict')).length).toBe(1)
    expect(copies.length).toBe(29)
  })
})

describe('trash and versions', () => {
  test('delete moves to trash with a 30 day purge date; restore needs write access', () => {
    const id = env.files.deleteFile('alice', 'users/alice/todo.md')
    expect(fs.existsSync(path.join(T, 'users/alice/todo.md'))).toBe(false)
    const t = env.db.query('SELECT * FROM trash_items WHERE id = ?').get(id) as any
    expect(new Date(t.purge_at).getTime() - Date.now()).toBeGreaterThan(29 * 86400_000)
    expect(() => env.files.restoreTrash('erin', id)).toThrow()
    expect(env.files.restoreTrash('alice', id)).toBe('users/alice/todo.md')
    expect(read('users/alice/todo.md')).toContain('Alice todo')
    expect(events('users/alice/todo.md').map((e) => e.action)).toEqual(['delete', 'restore'])
  })
  test('cannot delete what you cannot write', () => {
    expect(() => env.files.deleteFile('alice', 'skills/team-rules.md')).toThrow()
    expect(() => env.files.deleteFile('alice', 'groups/finance/budget.md')).toThrow()
  })
})

describe('audit', () => {
  test('every file change in this suite has a file_events row', () => {
    const rows = env.db.query("SELECT action, COUNT(*) n FROM file_events GROUP BY action").all() as any[]
    const m = Object.fromEntries(rows.map((r) => [r.action, r.n]))
    expect(m.update).toBeGreaterThan(3); expect(m.conflict).toBeGreaterThan(30); expect(m.create).toBeGreaterThan(30); expect(m.delete).toBe(1)
  })
  test('denied writes are recorded as rejected', async () => {
    await env.files.call('write', { file_path: 'groups/finance/x.md', content: 'x' }, env.ctx('alice', 'tz'))
    expect((env.db.query("SELECT COUNT(*) n FROM file_events WHERE action = 'rejected' AND turn_id = 'tz'").get() as any).n).toBe(1)
  })
})
