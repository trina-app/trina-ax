// Security round 1 (sharing-works #7): a conflict copy emitted 'conflict' but nothing listened, so the person who changed
// the file first never heard about it (design tab 4 PUT content: both people are told). The notice goes to both, and
// only to someone who can read both the file and the copy at that moment (the copy's name carries the saver's name).
// Fixture: alice, erin = marketing (groups/marketing write); bob = finance; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { jsonBody, makeCApp, sha256hex, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r1-conflict-notice') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const save = (who: Who, p: string, content: string, baseSha256: string | null) => A.json('/api/files/content', { as: who, ...jsonBody({ path: p, content, baseSha256 }, 'PUT') })

describe('files.conflict', () => {
  test('both the saver and the person who changed the file first are told; nobody else', async () => {
    const base = sha256hex('# Shared plan\nStatus: DRAFT\nOwner: nobody\n')
    expect((await save('erin', 'shared/edit-me.md', 'erin was here\n', base)).body.conflict).toBe(false)
    A.hub.clear()
    const r = await save('alice', 'shared/edit-me.md', 'alice too\n', base) // alice loaded the old version
    expect(r.body.conflict).toBe(true)
    const to = A.hub.events.filter((e) => e.ev.type === 'files.conflict')
    expect(to.map((e) => e.userId).sort()).toEqual(['alice', 'erin'])
    for (const e of to) expect(e.ev.data).toEqual({ path: 'shared/edit-me.md', copyPath: r.body.path, by: { id: 'alice', name: 'Alice Kim' } })
    expect(JSON.stringify(to)).not.toContain('alice too') // no content
  })

  test('someone who can no longer read the file hears nothing', async () => {
    expect((await save('erin', 'groups/marketing/notes.md', 'v1\n', null)).status).toBe(200)
    expect((await save('erin', 'groups/marketing/notes.md', 'v2 erin\n', sha256hex('v1\n'))).status).toBe(200)
    A.ctx.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'erin'").run()
    A.hub.clear()
    const r = await save('alice', 'groups/marketing/notes.md', 'v2 alice\n', sha256hex('v1\n'))
    expect(r.body.conflict).toBe(true)
    expect(A.hub.of('files.conflict', 'alice').length).toBe(1)
    expect(A.hub.of('files.conflict', 'erin')).toEqual([])
    A.ctx.db.query("INSERT INTO group_members VALUES ('marketing', 'erin')").run()
  })

  test('AI tool conflicts use the same check (event from the tool layer)', () => {
    A.hub.clear()
    A.ctx.files.events.emit('conflict', { path: 'groups/finance/budget.md', copy: 'groups/finance/budget (충돌 사본 - Bob Lee 2026-10-21 10.00).md', by: 'bob', users: ['bob', 'alice'] })
    expect(A.hub.of('files.conflict', 'bob').length).toBe(1)
    expect(A.hub.of('files.conflict', 'alice')).toEqual([])
  })
})
