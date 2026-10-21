// Security round 2 (sharing-works #2 and #4, the r1 conflict notice was incomplete): a conflict copy left by
// POST /api/files/copy (onExists replace with a stale baseSha256) or by the AI's make_file told nobody, and make_file's
// copy was missing from the original's history. The AI write / edit named (and told) the wrong person when the change
// it missed was an upload or a version restore. Every conflict copy now goes through recordConflictCopy(): a history
// row on the original, file_events 'conflict', and files.conflict for the saver and the person who changed the file
// last (each only if they can read both the file and the copy).
// Fixture: alice, erin = marketing (groups/marketing write); bob = finance; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { makeHandler } from '../../server/src/mcp/protocol'
import { jsonBody, makeCApp, sha256hex, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r2-conflict-paths') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
const save = (who: Who, p: string, content: string, baseSha256: string | null) => A.json('/api/files/content', { as: who, ...jsonBody({ path: p, content, baseSha256 }, 'PUT') })
const notices = () => A.hub.events.filter((e) => e.ev.type === 'files.conflict').map((e) => ({ to: e.userId, data: e.ev.data as { path: string; copyPath: string; by: { id: string } | null } }))
const history = async (who: Who, p: string) => (await A.json('/api/files/history' + q({ path: p }), { as: who })).body.items as { kind: string; conflictPath: string | null }[]
let rpc = 0
async function tool(who: Who, name: string, args: unknown, tc = A.toolCtx(who, A.turn(who, A.chat(who)))) {
  const r = await makeHandler(A.ctx.files, A.ctx.db, tc)({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) as any
  return { text: r.result.content[0].text as string, isError: !!r.result.isError }
}

describe('every conflict copy is announced and kept in the history', () => {
  test('POST /api/files/copy replace over a file changed since: both people told, the copy in the history', async () => {
    expect((await save('alice', 'users/alice/report.md', '# Q3\nalice draft\n', null)).status).toBe(200)
    const c1 = await A.json('/api/files/copy', { as: 'alice', ...jsonBody({ from: 'users/alice/report.md', to: 'groups/marketing/report.md' }) })
    expect(c1.status).toBe(201)
    const base = c1.body.sha256 as string
    expect((await save('erin', 'groups/marketing/report.md', '# Q3\nerin edit\n', base)).body.conflict).toBe(false)
    A.hub.clear()
    const c2 = await A.json('/api/files/copy', { as: 'alice', ...jsonBody({ from: 'users/alice/report.md', to: 'groups/marketing/report.md', onExists: 'replace', baseSha256: base }) })
    expect(c2.status).toBe(201)
    expect(c2.body.path).toMatch(/^groups\/marketing\/report \(conflict copy - Alice Kim .*\)\.md$/)
    const n = notices()
    expect(n.map((e) => e.to).sort()).toEqual(['alice', 'erin'])
    for (const e of n) expect(e.data).toEqual({ path: 'groups/marketing/report.md', copyPath: c2.body.path, by: { id: 'alice', name: 'Alice Kim' } })
    expect((await history('erin', 'groups/marketing/report.md')).filter((v) => v.kind === 'conflict_copy').map((v) => v.conflictPath)).toEqual([c2.body.path])
    expect((await A.json('/api/files/content' + q({ path: 'groups/marketing/report.md' }), { as: 'erin' })).body.content).toBe('# Q3\nerin edit\n')
  })

  test('make_file over a file the AI did not read: both people told, the copy in the history', async () => {
    const r1 = await tool('erin', 'make_file', { content: '# Deck\nerin\n', format: 'docx', output: 'groups/marketing/deck.docx' })
    expect(r1.isError).toBe(false)
    A.hub.clear()
    const r2 = await tool('alice', 'make_file', { content: '# Deck\nalice\n', format: 'docx', output: 'groups/marketing/deck.docx' })
    expect(r2.isError).toBe(false)
    const copy = /saved as '([^']+)'/.exec(r2.text)?.[1]
    expect(copy).toMatch(/^groups\/marketing\/deck \(conflict copy - Alice Kim .*\)\.docx$/)
    expect(notices().map((e) => e.to).sort()).toEqual(['alice', 'erin'])
    for (const e of notices()) expect(e.data.copyPath).toBe(copy!)
    expect((await history('alice', 'groups/marketing/deck.docx')).filter((v) => v.kind === 'conflict_copy').map((v) => v.conflictPath)).toEqual([copy!])
  })

  test('make_file conflict in a folder one of the two cannot read any more: only the other is told', async () => {
    const r1 = await tool('erin', 'make_file', { content: '# Plan\nerin\n', format: 'docx', output: 'groups/marketing/plan.docx' })
    expect(r1.isError).toBe(false)
    A.ctx.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'erin'").run()
    try {
      A.hub.clear()
      expect((await tool('alice', 'make_file', { content: '# Plan\nalice\n', format: 'docx', output: 'groups/marketing/plan.docx' })).isError).toBe(false)
      expect(notices().map((e) => e.to)).toEqual(['alice'])
    } finally { A.ctx.db.query("INSERT INTO group_members VALUES ('marketing', 'erin')").run() }
  })

  test('the AI write names and tells whoever changed the file last: an upload that replaced it', async () => {
    const p = 'shared/v2-notes.txt'
    expect((await save('erin', p, 'v0 by erin\n', null)).status).toBe(200)
    const tc = A.toolCtx('alice', A.turn('alice', A.chat('alice')))
    await A.ctx.files.call('read', { file_path: p }, tc)
    const fd = new FormData(); fd.set('folder', 'shared'); fd.set('name', 'v2-notes.txt'); fd.set('onExists', 'replace'); fd.set('file', new File(['v1 uploaded by bob\n'], 'v2-notes.txt'))
    expect((await A.json('/api/files/upload', { method: 'POST', body: fd, as: 'bob' })).status).toBe(201)
    A.hub.clear()
    const w = await tool('alice', 'write', { file_path: p, content: 'alice AI version\n' }, tc)
    expect(w.text).toContain('was changed by Bob Lee after you read it')
    expect(notices().map((e) => e.to).sort()).toEqual(['alice', 'bob'])
  })

  test('the AI write names and tells whoever changed the file last: a version restore', async () => {
    const p = 'shared/v3-notes.txt'
    expect((await save('erin', p, 'v0\n', null)).status).toBe(200)
    expect((await save('erin', p, 'v1\n', sha256hex('v0\n'))).status).toBe(200)
    const tc = A.toolCtx('alice', A.turn('alice', A.chat('alice')))
    await A.ctx.files.call('read', { file_path: p }, tc)
    const vid = (await A.json('/api/files/history' + q({ path: p }), { as: 'bob' })).body.items[0].id
    expect((await A.json('/api/files/restore', { as: 'bob', ...jsonBody({ path: p, versionId: vid }) })).status).toBe(200)
    A.hub.clear()
    const w = await tool('alice', 'write', { file_path: p, content: 'alice AI v3\n' }, tc)
    expect(w.text).toContain('was changed by Bob Lee after you read it')
    expect(notices().map((e) => e.to).sort()).toEqual(['alice', 'bob'])
  })
})
