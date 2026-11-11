// Security: the file list never tells anyone about a file they cannot open (server/src/file-list/;
// docs/AGENTS/plan/20261111-0630-file-list.md "Design"). The lists are virtual: the AI's file tools render each
// `_FILES.md` for the person asking, line by line through visiblePath. Every list a person gets names only files that
// person can read now and holds no text of another file: checked for every person through the permission function and
// the AI's own tools (list, glob, grep, read; the chat engines and the remote connector both use them), after a first
// run, after rule changes (a narrower sub-folder, a person added, a rule taken away), a group change and a move.
// A fake reader puts every CANARY token of a file's text into that file's line, so a line in the wrong place shows.
// Fixture (tests/lib/fixtures.ts): shared/ everyone write; groups/marketing (alice, erin) with salaries/ none for them;
// groups/finance (bob); projects/falcon alice + finance read, its public/ everyone read; projects/atlas finance; carol
// admin, dana owner; users/<id> only that person (and not read by the file list for now).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { FILE_LIST_NAME } from '@mycel/shared/api'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { defaultAnswer, FakeReader } from '../lib/file-list-fake'
import { fileListOf, type FileList } from '../../server/src/file-list/service'
import { atLeast, RuleSet } from '../../server/src/policy/access'
import { HEADER } from '../../server/src/file-list/view'

setDefaultTimeout(180_000)

const PEOPLE = ['alice', 'bob', 'carol', 'dana', 'erin'] as const
let A: CApp
let fl: FileList
const reader = new FakeReader()
const write = (rel: string, s: string) => { const p = path.join(A.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }

/** every file of the team folder (not the lists) and the CANARY tokens of its text and name */
function canaries(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(path.join(d, e.name), r); continue }
      if (e.name === FILE_LIST_NAME) continue
      let text = ''
      try { text = fs.readFileSync(path.join(d, e.name), 'latin1') } catch {}
      for (const m of `${r}\n${text}`.matchAll(/CANARY-[A-Z]+-\d+/g)) { const l = out.get(m[0]) ?? []; if (!l.includes(r)) l.push(r); out.set(m[0], l) }
    }
  }
  walk(A.team, '')
  return out
}
/** Every list this person gets from the AI's tools: the paths glob finds, each read with read. */
async function listsOf(u: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const g = await A.ctx.files.call('glob', { pattern: '**/_FILES.md' }, A.toolCtx(u as 'alice'))
  for (const p of g.text === 'No files found' ? [] : g.text.split('\n')) {
    const r = await A.ctx.files.call('read', { file_path: p }, A.toolCtx(u as 'alice'))
    out.set(p, r.text.split('\n').map((l) => l.replace(/^\s*\d+\t/, '')).join('\n'))
  }
  return out
}

/** For every person: each list they get names only files they can read and holds only canaries of such files. */
async function checkEveryone(when: string): Promise<number> {
  const rules = RuleSet.load(A.ctx.db)
  const where = canaries()
  let checked = 0
  for (const u of PEOPLE) {
    const p = A.ctx.files.principal(u)
    const can = (rel: string) => atLeast(rules.access(p, rel.split('/')), 'read')
    // the provider directly (every folder) and through the tools must agree
    const direct = fl.under(p, rules, [])
    const viaTools = await listsOf(u)
    expect({ when, u, lists: [...viaTools.keys()].sort() }).toEqual({ when, u, lists: [...direct.keys()].sort() })
    for (const [list, text] of viaTools) {
      expect({ when, u, list, readable: can(list) }).toEqual({ when, u, list, readable: true })
      expect(text.startsWith(HEADER)).toBe(true)
      for (const line of text.split('\n')) {
        if (line.startsWith('#') || !line.includes(' — ')) continue
        const f = line.slice(0, line.indexOf(' — '))
        expect({ when, u, list, f, readable: can(f) }).toEqual({ when, u, list, f, readable: true })
        checked++
      }
      for (const m of text.matchAll(/CANARY-[A-Z]+-\d+/g)) {
        const from = where.get(m[0]) ?? []
        expect({ when, u, list, canary: m[0], fromReadable: from.some(can) }).toEqual({ when, u, list, canary: m[0], fromReadable: true })
      }
    }
    // grep over everything (content), with the list's lines first: no canary of a file this person cannot read
    const g = (await A.ctx.files.call('grep', { pattern: 'CANARY-[A-Z]+-[0-9]+', path: '', output_mode: 'content', glob: '**/_FILES.md', head_limit: 5000 }, A.toolCtx(u as 'alice'))).text
    for (const m of g.matchAll(/CANARY-[A-Z]+-\d+/g)) expect({ when, u, canary: m[0], ok: (where.get(m[0]) ?? []).some(can) }).toEqual({ when, u, canary: m[0], ok: true })
    // a list of a folder they cannot read, named directly: not found, like any hidden file
    for (const hidden of ['groups/finance/_FILES.md', 'groups/marketing/salaries/_FILES.md', 'projects/falcon/_FILES.md', 'users/bob/_FILES.md']) {
      if (can(hidden)) continue
      const r = await A.ctx.files.call('read', { file_path: hidden }, A.toolCtx(u as 'alice'))
      expect({ when, u, hidden, leaked: r.text.includes(' — ') }).toEqual({ when, u, hidden, leaked: false })
    }
  }
  return checked
}

beforeAll(async () => {
  A = await makeCApp('sec-file-list')
  write('users/bob/CANARY-BOBNAME-11 plan.md', '# bob private CANARY-BOB-12\n')
  write('users/alice/diary.md', '# alice private CANARY-ALICE-13\n')
  write('groups/marketing/salaries/bonus.md', '# bonus CANARY-SAL-14\n')
  write('shared/policies/hr-only-later.md', '# moves under a narrower rule CANARY-HR-15\n')
  write('projects/falcon/public/press.md', '# press CANARY-PUB-16\n')
  fl = fileListOf(A.ctx)
  fl.useReader(() => ({ ok: true, reader }))
  expect(await fl.start('now')).toBe('done')
})
afterAll(async () => { await A.close() })

describe('nobody sees a file name or text they cannot open through any list', () => {
  test('after the first run: every person, every list, every tool', async () => {
    expect(await checkEveryone('first run')).toBeGreaterThan(50)
    // nothing was written into the team folder, and personal folders were not read
    expect(canaries().has('CANARY-BOB-12')).toBe(true)
    expect(JSON.stringify([...fl.store.all().keys()])).not.toContain('users/')
  })

  let policies = ''
  test('a narrower rule on a sub-folder: its lines leave the wider list at once', async () => {
    const r = await A.json('/api/admin/folders', { as: 'dana', ...jsonBody({ path: 'shared/policies', rules: [{ subjectType: 'user', subjectId: 'carol', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }] }) })
    expect(r.status).toBe(201)
    policies = r.body.id
    expect((await listsOf('bob')).get('shared/_FILES.md') ?? '').not.toContain('CANARY-HR-15')
    await checkEveryone('narrowed shared/policies, before a run')
    expect(await fl.start('now')).toBe('done')
    expect((await listsOf('carol')).get('shared/policies/_FILES.md') ?? '').toContain('CANARY-HR-15')
    await checkEveryone('narrowed shared/policies, read again')
  })

  test('the rules of that folder changed (a person added): only they gain its lines', async () => {
    const r = await A.json(`/api/admin/folders/${policies}/rules`, { as: 'dana', ...jsonBody({ rules: [{ subjectType: 'user', subjectId: 'carol', access: 'write' }, { subjectType: 'user', subjectId: 'bob', access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'none' }] }, 'PUT') })
    expect(r.status).toBe(200)
    await checkEveryone('policies for carol and bob, before a run')
    expect(await fl.start('now')).toBe('done')
    expect((await listsOf('bob')).get('shared/policies/_FILES.md') ?? '').toContain('CANARY-HR-15')
    expect((await listsOf('alice')).has('shared/policies/_FILES.md')).toBe(false)
    await checkEveryone('policies for carol and bob')
  })

  test('the rule taken away: its lines move back to the wider list, still only to readers', async () => {
    const r = await A.json(`/api/admin/folders/${policies}`, { as: 'dana', method: 'DELETE' })
    expect(r.status).toBe(204)
    await checkEveryone('policies rule removed, before a run')
    expect(await fl.start('now')).toBe('done')
    expect((await listsOf('alice')).get('shared/_FILES.md') ?? '').toContain('CANARY-HR-15')
    await checkEveryone('policies rule removed')
  })

  test('a group change (erin leaves marketing): she can no longer read its list or its files', async () => {
    const before = A.ctx.files.principal('erin')
    expect(before.groups).toContain('marketing')
    A.ctx.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'erin'").run()
    expect([...(await listsOf('erin')).keys()].some((l) => l.startsWith('groups/marketing/'))).toBe(false)
    await checkEveryone('erin left marketing')
  })

  test('a file moved from a wide folder into a personal one: gone from the wide list at once', async () => {
    write('shared/to-move-CANARY-MOVE-17.md', '# moving CANARY-MOVE-18\n')
    expect(await fl.start('now')).toBe('done')
    expect((await listsOf('alice')).get('shared/_FILES.md') ?? '').toContain('CANARY-MOVE-18')
    const r = await A.json('/api/files/move', { as: 'bob', ...jsonBody({ from: 'shared/to-move-CANARY-MOVE-17.md', to: 'users/bob/to-move-CANARY-MOVE-17.md', confirm: true }) })
    expect(r.status).toBe(200)
    for (const u of PEOPLE) expect(JSON.stringify([...(await listsOf(u)).values()])).not.toContain('CANARY-MOVE-18')
    await checkEveryone('moved into users/bob')
  })

  test('a model that mixes up batch-mates: after a rule splits their unit, nobody sees a batch-mate\'s text', async () => {
    // every line also carries the canaries of the other files of its call (a confused or steered model)
    const all = (files: { text: string }[]) => [...new Set(files.flatMap((f) => [...f.text.matchAll(/CANARY-[A-Z]+-\d+/g)].map((m) => m[0])))]
    reader.answer = (files) => files.map((f) => JSON.stringify({ id: f.id, type: 'document', names: [], date: '', what: `mixed ${all(files).join(' ')}` })).join('\n')
    write('shared/team-a/plan.md', '# team a plan CANARY-TEAMA-21\n')
    write('shared/team-b/plan.md', '# team b plan CANARY-TEAMB-22\n')
    expect(await fl.start('now')).toBe('done')
    // one call held both (one unit): each line names both canaries, which everyone in shared/ may see
    expect((await listsOf('alice')).get('shared/_FILES.md') ?? '').toContain('CANARY-TEAMB-22')
    // now team-b becomes bob's only: the mixed lines must not show anywhere bob's file text could reach alice
    const r = await A.json('/api/admin/folders', { as: 'dana', ...jsonBody({ path: 'shared/team-b', rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }] }) })
    expect(r.status).toBe(201)
    reader.answer = (files) => files.map((f) => JSON.stringify(defaultAnswer(f))).join('\n')
    await checkEveryone('team-b split off, before a run')
    // alice's lists: no CANARY-TEAMB-22 at all (the shared line that named it came from a call holding team-b's file,
    // and team-a's line is still from that call: it is read again too)
    expect(JSON.stringify([...(await listsOf('alice')).values()])).not.toContain('CANARY-TEAMB-22')
    expect(await fl.start('now')).toBe('done')
    expect(JSON.stringify([...(await listsOf('alice')).values()])).not.toContain('CANARY-TEAMB-22')
    await checkEveryone('team-b split off, read again')
  })

  test('the next run after all that: still nobody sees more than they may', async () => {
    expect(await fl.start('now')).toBe('done')
    await checkEveryone('after the next run')
  })
})
