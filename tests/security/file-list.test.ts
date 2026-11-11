// Security: the file list never tells anyone about a file they cannot open (server/src/file-list/;
// docs/AGENTS/plan/20261111-0630-file-list.md "The access unit"). Every `_FILES.md` a person can read names only files
// that person can read, and holds no text of another file: checked for every person through the permission function,
// the AI's own tools (read, grep) and the download route, after a first run, after rule changes (a narrower sub-folder,
// a rule taken away, a person rule), group changes and moves, at once (before the change's request returns).
// A fake reader puts every CANARY token of a file's text into that file's line, so a line in the wrong list shows.
// Fixture (tests/lib/fixtures.ts): shared/ everyone write; groups/marketing (alice, erin) with salaries/ none for them;
// groups/finance (bob); projects/falcon alice + finance read, its public/ everyone read; projects/atlas finance; carol
// admin, dana owner; users/<id> only that person.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { FILE_LIST_NAME } from '@mycel/shared/api'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { FakeReader } from '../lib/file-list-fake'
import { fileListOf, type FileList } from '../../server/src/file-list/service'
import { atLeast, RuleSet } from '../../server/src/policy/access'

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
function listsOnDisk(): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (e.name === FILE_LIST_NAME) out.push(r) } }
  walk(A.team, '')
  return out
}

/** For every person: each list they can read names only files they can read and holds only canaries of such files. */
function checkEveryone(when: string): number {
  const rules = RuleSet.load(A.ctx.db)
  const where = canaries()
  let checked = 0
  for (const u of PEOPLE) {
    const p = A.ctx.files.principal(u)
    const can = (rel: string) => atLeast(rules.access(p, rel.split('/')), 'read')
    for (const list of listsOnDisk()) {
      if (!can(list)) continue
      const text = fs.readFileSync(path.join(A.team, ...list.split('/')), 'utf8')
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
  }
  return checked
}

/** The AI's tools as each person: grep and read of every list find nothing they may not see. */
async function checkTools(when: string) {
  const rules = RuleSet.load(A.ctx.db)
  const where = canaries()
  for (const u of PEOPLE) {
    const p = A.ctx.files.principal(u)
    const can = (rel: string) => atLeast(rules.access(p, rel.split('/')), 'read')
    const g = JSON.stringify(await A.ctx.files.call('grep', { pattern: 'CANARY-[A-Z]+-[0-9]+', path: '', output_mode: 'content', glob: '**/_FILES.md', head_limit: 5000 }, A.toolCtx(u)))
    for (const m of g.matchAll(/CANARY-[A-Z]+-\d+/g)) expect({ when, u, canary: m[0], ok: (where.get(m[0]) ?? []).some(can) }).toEqual({ when, u, canary: m[0], ok: true })
    for (const list of listsOnDisk()) {
      const r = JSON.stringify(await A.ctx.files.call('read', { file_path: list }, A.toolCtx(u)))
      const d = await A.req(`/api/files/download?path=${encodeURIComponent(list)}`, { as: u })
      if (can(list)) { expect(r).toContain(' — '); expect(d.status).toBe(200) }
      else { expect({ when, u, list, leaked: r.includes(' — ') }).toEqual({ when, u, list, leaked: false }); expect(d.status).toBe(404) }
      await d.body?.cancel()
    }
  }
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
  test('after the first run: every person, every list (permission function)', () => {
    expect(listsOnDisk().length).toBeGreaterThan(6)
    expect(checkEveryone('first run')).toBeGreaterThan(50)
  })

  test('after the first run: the AI tools and the download route as every person', async () => {
    await checkTools('first run')
  })

  let policies = ''
  test('a narrower rule on a sub-folder: its lines leave the wider list at once', async () => {
    const r = await A.json('/api/admin/folders', { as: 'dana', ...jsonBody({ path: 'shared/policies', rules: [{ subjectType: 'user', subjectId: 'carol', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }] }) })
    expect(r.status).toBe(201)
    policies = r.body.id
    const shared = fs.readFileSync(path.join(A.team, 'shared', FILE_LIST_NAME), 'utf8')
    expect(shared).not.toContain('CANARY-HR-15')
    checkEveryone('narrowed shared/policies')
    await checkTools('narrowed shared/policies')
  })

  test('the rules of that folder changed (a person added): only they gain its lines', async () => {
    const r = await A.json(`/api/admin/folders/${policies}/rules`, { as: 'dana', ...jsonBody({ rules: [{ subjectType: 'user', subjectId: 'carol', access: 'write' }, { subjectType: 'user', subjectId: 'bob', access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'none' }] }, 'PUT') })
    expect(r.status).toBe(200)
    checkEveryone('policies for carol and bob')
    await checkTools('policies for carol and bob')
  })

  test('the rule taken away: its lines move back to the wider list, still only to readers', async () => {
    const r = await A.json(`/api/admin/folders/${policies}`, { as: 'dana', method: 'DELETE' })
    expect(r.status).toBe(204)
    expect(fs.existsSync(path.join(A.team, 'shared', 'policies', FILE_LIST_NAME))).toBe(false)
    expect(fs.readFileSync(path.join(A.team, 'shared', FILE_LIST_NAME), 'utf8')).toContain('CANARY-HR-15')
    checkEveryone('policies rule removed')
  })

  test('a group change (erin leaves marketing): she can no longer read its list or its files', async () => {
    const before = A.ctx.files.principal('erin')
    expect(before.groups).toContain('marketing')
    A.ctx.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'erin'").run()
    checkEveryone('erin left marketing')
    await checkTools('erin left marketing')
  })

  test('a file moved from a wide folder into a personal one: gone from the wide list at once', async () => {
    write('shared/to-move-CANARY-MOVE-17.md', '# moving CANARY-MOVE-18\n')
    expect(await fl.start('now')).toBe('done')
    expect(fs.readFileSync(path.join(A.team, 'shared', FILE_LIST_NAME), 'utf8')).toContain('CANARY-MOVE-18')
    const r = await A.json('/api/files/move', { as: 'bob', ...jsonBody({ from: 'shared/to-move-CANARY-MOVE-17.md', to: 'users/bob/to-move-CANARY-MOVE-17.md', confirm: true }) })
    expect(r.status).toBe(200)
    expect(fs.readFileSync(path.join(A.team, 'shared', FILE_LIST_NAME), 'utf8')).not.toContain('CANARY-MOVE-18')
    checkEveryone('moved into users/bob')
  })

  test('the next run after all that: still nobody sees more than they may', async () => {
    expect(await fl.start('now')).toBe('done')
    checkEveryone('after the next run')
    await checkTools('after the next run')
  })
})
