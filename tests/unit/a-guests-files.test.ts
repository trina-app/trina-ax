// Guests and team files (docs/DECISIONS.md "Guests: only what they were invited to"; guest-review path 1). A guest
// reaches only their own project (by the person rule the invite wrote) and their own users/<id>/: everyone, role and
// group rules never apply to them, whatever folder they are on (shared/, skills/, connected/, an admin's everyone rule),
// and nor does a person rule outside projects/ or deep in another project. The policy knows guests by id (users.guest),
// so a Principal that says 'member' still fails closed. Files tree, search, find, recent, read, the share_file tool and
// the MCP list/grep tools all go through it. Each test: the guest is denied, the allowed path works, a member is as before.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { RuleSet, type Principal } from '../../server/src/policy/access'
import { makeHandler } from '../../server/src/mcp/protocol'
import { TurnFiles } from '../../server/src/files/service'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)

describe('the folder policy for a guest (RuleSet)', () => {
  const rules = RuleSet.fromWorld({
    rows: [
      { path: 'shared', subject_type: 'everyone', subject_id: null, access: 'write' },
      { path: 'skills', subject_type: 'everyone', subject_id: null, access: 'read' },
      { path: 'connected/drive', subject_type: 'everyone', subject_id: null, access: 'read' },
      { path: 'finance', subject_type: 'role', subject_id: 'member', access: 'write' },
      { path: 'design', subject_type: 'group', subject_id: 'g1', access: 'write' },
      { path: 'notes', subject_type: 'user', subject_id: 'gus', access: 'write' },
      { path: '', subject_type: 'everyone', subject_id: null, access: 'read' },
      { path: 'projects', subject_type: 'user', subject_id: 'gus', access: 'write' },
      { path: 'projects/Quote', subject_type: 'user', subject_id: 'gus', access: 'write' },
      { path: 'projects/Quote', subject_type: 'user', subject_id: 'mia', access: 'write' },
      { path: 'projects/Quote', subject_type: 'everyone', subject_id: null, access: 'none' },
      { path: 'projects/Secret', subject_type: 'everyone', subject_id: null, access: 'read' },
      { path: 'projects/Secret/drop', subject_type: 'user', subject_id: 'gus', access: 'write' },
    ],
    limited: ['projects/Quote'],
    guests: ['gus'],
  })
  const gus: Principal = { id: 'gus', name: 'Gus', role: 'guest', groups: ['g1'] }
  // the same guest as a Principal built somewhere that read the stored role ('member'): the set knows the id
  const gusAsMember: Principal = { ...gus, role: 'member' }
  const mia: Principal = { id: 'mia', name: 'Mia', role: 'member', groups: ['g1'] }
  const at = (p: Principal, path: string) => rules.access(p, path === '' ? [] : path.split('/'))

  test('everyone, role, group rules and person rules outside projects/ never apply to a guest', () => {
    for (const p of [gus, gusAsMember]) {
      for (const path of ['', 'shared', 'shared/a.txt', 'skills', 'skills/x/SKILL.md', 'connected/drive/f.pdf', 'finance', 'design', 'notes', 'projects', 'projects/Secret', 'projects/Secret/f.txt']) {
        expect(`${p.role} ${path} ${at(p, path)}`).toBe(`${p.role} ${path} none`)
      }
    }
    // the member next to them reads the same folders as before
    expect(at(mia, 'shared')).toBe('write')
    expect(at(mia, 'skills')).toBe('read')
    expect(at(mia, 'design')).toBe('write')
    expect(at(mia, 'projects/Secret/f.txt')).toBe('read')
  })

  test('their own project: read and write; a person rule deep in a project they are not in: none', () => {
    for (const p of [gus, gusAsMember]) {
      expect(at(p, 'projects/Quote')).toBe('write')
      expect(at(p, 'projects/Quote/price.txt')).toBe('write')
      // a person rule below another project's folder does not let them read part of it
      expect(at(p, 'projects/Secret/drop')).toBe('none')
      expect(at(p, 'projects/Secret/drop/x.txt')).toBe('none')
      // their own folder stays theirs
      expect(at(p, `users/${p.id}/a.txt`)).toBe('write')
      expect(at(p, 'users/mia/a.txt')).toBe('none')
    }
  })

  test('the tree: at the root only users/ and projects/ show the way; below projects/ only theirs', () => {
    const nav = rules.navigator([], 50)
    const root = nav(gus)
    expect(root.listable).toBe(true)
    expect(root.via).toEqual(['projects/Quote', 'users/gus'])
    expect(rules.canList(gus, ['shared'])).toBe(false)
    expect(rules.canList(gus, ['projects'])).toBe(true)
    expect(rules.navigator(['projects'], 50)(gus).via).toEqual(['projects/Quote'])
    expect(rules.navigator(['projects', 'Secret'], 50)(gus).listable).toBe(false)
    expect(rules.listing(gusAsMember).listable(['shared'])).toBe(false)
    expect(rules.listing(gusAsMember).listable(['projects', 'Quote'])).toBe(true)
    // the member: the root is readable by the everyone rule
    expect(nav(mia).listable).toBe(true)
    expect(rules.canList(mia, ['shared'])).toBe(true)
  })

  test('explain says why a guest has no access to an everyone folder', () => {
    expect(rules.explain(gus, ['shared'])).toEqual({ access: 'none', reason: { kind: 'no-rule' } })
    expect(rules.explain(gus, ['projects', 'Quote']).reason).toMatchObject({ kind: 'rule', tier: 'user' })
  })
})

describe('a real guest and the team folder (API and tools)', () => {
  let h: Harness
  let owner: Client
  let mia: { client: Client; id: string }
  let nora: { client: Client; id: string }
  let g: { client: Client; id: string }
  const save = (c: Client, path: string, content: string) => c.call('PUT', '/api/files/content', { path, content, baseSha256: null })
  beforeAll(async () => {
    h = await harness('a-guests-files')
    owner = await withOwner(h)
    mia = await addMember(h, owner, { username: 'mia' })
    nora = await addMember(h, owner, { username: 'nora' })
    const quote = await mia.client.call('POST', '/api/projects', { name: 'Quote', participants: [{ subjectType: 'user', subjectId: nora.id }] })
    await mia.client.call('POST', '/api/projects', { name: 'Secret', participants: [] })
    await save(owner, 'shared/plan.txt', 'banana team plan')
    await save(owner, 'skills/hello/SKILL.md', 'banana skill')
    await save(mia.client, 'projects/Quote/price.txt', 'banana quote price')
    await save(mia.client, 'projects/Secret/x.txt', 'banana secret')
    // an admin's everyone rule on a team folder of its own
    await save(owner, 'Handbook/rules.txt', 'banana handbook')
    g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: quote.id } })
  })
  afterAll(async () => { await h?.close() })

  test('tree: the root shows projects/ and users/ only, shared/ and skills/ are 404', async () => {
    const root = await g.client.call('GET', '/api/files/tree?path=')
    expect(root.entries.map((e: any) => e.path).sort()).toEqual(['projects', 'users'])
    expect((await g.client.call('GET', '/api/files/tree?path=projects')).entries.map((e: any) => e.path)).toEqual(['projects/Quote'])
    for (const p of ['shared', 'skills', 'Handbook', 'projects/Secret']) expect(`${p} ${(await g.client.try('GET', `/api/files/tree?path=${p}`)).status}`).toBe(`${p} 404`)
    // the member sees the team as before
    expect((await nora.client.call('GET', '/api/files/tree?path=')).entries.map((e: any) => e.path)).toContain('shared')
  })

  test('read, download and write: their project yes, anything else 404', async () => {
    expect((await g.client.call('GET', '/api/files/content?path=projects/Quote/price.txt')).content).toBe('banana quote price')
    expect((await save(g.client, 'projects/Quote/from-gus.txt', 'hi')).path).toBe('projects/Quote/from-gus.txt')
    for (const p of ['shared/plan.txt', 'skills/hello/SKILL.md', 'projects/Secret/x.txt', 'Handbook/rules.txt', `users/${mia.id}/x.txt`]) {
      expect(`${p} ${(await g.client.try('GET', `/api/files/content?path=${encodeURIComponent(p)}`)).status}`).toBe(`${p} 404`)
      expect(`${p} ${(await g.client.try('GET', `/api/files/download?path=${encodeURIComponent(p)}`)).status}`).toBe(`${p} 404`)
    }
    expect((await g.client.try('PUT', '/api/files/content', { path: 'shared/gus.txt', content: 'x', baseSha256: null })).status).toBeGreaterThanOrEqual(403)
    expect((await g.client.try('POST', '/api/files/mkdir', { path: 'Handbook/gus' })).status).toBeGreaterThanOrEqual(403)
  })

  test('search, find and recent: only their project; the member still finds shared/', async () => {
    const paths = (r: any) => r.items.map((x: any) => x.path).sort()
    expect(paths(await g.client.call('GET', '/api/files/search?q=banana'))).toEqual(['projects/Quote/price.txt'])
    expect(paths(await g.client.call('GET', '/api/files/find?q=txt')).every((p: string) => p.startsWith('projects/Quote/'))).toBe(true)
    expect(paths(await g.client.call('GET', '/api/files/recent')).every((p: string) => p.startsWith('projects/Quote/'))).toBe(true)
    // searching a folder outside their reach gives nothing
    expect((await g.client.try('GET', '/api/files/search?q=banana&path=shared')).body?.items ?? []).toEqual([])
    const member = paths(await nora.client.call('GET', '/api/files/search?q=banana'))
    expect(member).toContain('shared/plan.txt')
    expect(member).toContain('projects/Quote/price.txt')
  })

  test('the AI tools as the guest (share_file, list, grep): only their project', async () => {
    let id = 0
    const call = async (userId: string, name: string, args: unknown) => {
      const handler = makeHandler(h.ctx.files, h.ctx.db, { user: h.ctx.files.principal(userId), turnId: null, files: new TurnFiles() } as any)
      const r = await handler({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
      return { text: r.result.content[0].text as string, isError: !!r.result.isError }
    }
    expect((await call(g.id, 'share_file', { path: 'shared/plan.txt', mode: 'preview' })).isError).toBe(true)
    expect((await call(g.id, 'share_file', { path: 'projects/Secret/x.txt', mode: 'download' })).isError).toBe(true)
    expect((await call(g.id, 'share_file', { path: 'projects/Quote/price.txt', mode: 'preview' })).isError).toBe(false)
    const list = await call(g.id, 'list', { path: '' })
    expect(list.text).not.toContain('shared')
    expect(list.text).toContain('projects')
    expect((await call(g.id, 'list', { path: 'shared' })).isError).toBe(true)
    const grep = await call(g.id, 'grep', { pattern: 'banana', path: '' })
    expect(grep.text).toContain('price.txt')
    expect(grep.text).not.toContain('plan.txt')
    expect(grep.text).not.toContain('SKILL.md')
    expect(grep.text).not.toContain('x.txt')
    // the member: the same tools reach shared/
    expect((await call(nora.id, 'share_file', { path: 'shared/plan.txt', mode: 'preview' })).isError).toBe(false)
    expect((await call(nora.id, 'grep', { pattern: 'banana', path: '' })).text).toContain('plan.txt')
  })
})
