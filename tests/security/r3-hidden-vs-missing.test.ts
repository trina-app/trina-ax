// Security regression (round 3, files-http): a path hidden from the caller must get exactly the answer a path that is
// not there gets, through every route that takes a path, so its existence never shows.
//
// Round 2 fixed GET /api/files/history (tests/security/r2-history-existence-oracle.test.ts; the exploit is ported again
// below). The same oracle remained in the AI file tools: authorize() refused a hidden path as Denied ("Access denied:
// not found or no access: 'x'") but a missing one as a ToolError ("Error: not found: 'x'"), so read, list, glob, grep,
// share_file and make_file's source told the AI (and through it the person) that groups/marketing/salaries or an
// admin's 'none' folder skills/performance-reviews exists, by its exact name or a case variant. The HTTP routes mapped
// both to one 404.
// Now a missing path is refused for reads and listings with the same Denied as a hidden one.
// Fixture: alice = member of marketing (skills/ read-only, groups/marketing write, salaries/ and groups/finance none);
// carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { toolRegistry } from '../../server/src/tools/registry'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => {
  A = await makeCApp('sec-r3-hidden-vs-missing')
  // an admin-made 'none' folder under the everyone-read skills/ (alice: read-only parent)
  const r = await A.json('/api/admin/folders', { as: 'dana', ...jsonBody({ path: 'skills/performance-reviews', create: true, rules: [
    { subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'user', subjectId: 'carol', access: 'write' }] }) })
  expect(r.status).toBeLessThan(300)
  fs.writeFileSync(path.join(A.team, 'skills', 'performance-reviews', 'q3.md'), 'secret review\n')
})
afterAll(async () => { await A.close() })

// [parent, the hidden entry's real name, probes that point at it, a name that does not exist]
const READ_ONLY_PARENT: [string, string, string[], string] =
  ['skills', 'performance-reviews', ['performance-reviews', 'Performance-Reviews', 'PERFORMANCE-REVIEWS', 'performance-reviewſ' /* long s: NFKC 's' */, 'ｐerformance-reviews' /* fullwidth p */], 'performance-reviewz']
const CASES: [string, string, string[], string][] = [
  READ_ONLY_PARENT,
  ['groups/marketing', 'salaries', ['salaries', 'Salaries', 'SALARIES', 'ſalaries', 'ⓢalaries'], 'zalaries'],
  ['groups', 'finance', ['finance', 'FINANCE', 'ﬁnance' /* fi ligature */], 'fynance'],
]
const BELOW = ['', '/q3.md', '/2026.md', '/sub/deeper.md']

/** the answer with the typed name replaced, so a probe and the missing control can be compared */
const masked = (v: unknown, typed: string) => JSON.stringify(v).split(typed).join('<NAME>').replace(/"requestId":"[^"]*"/g, '"requestId":"-"')

// ---------------------------------------------------------------- AI tools
type Call = (p: string) => Promise<{ text: string; isError?: boolean }>
const ctx = () => A.toolCtx('alice', A.turn('alice', A.chat('alice')))
const TOOLS: [string, Call][] = [
  ['read', (p) => A.ctx.files.call('read', { file_path: p }, ctx())],
  ['list', (p) => A.ctx.files.call('list', { path: p }, ctx())],
  ['glob', (p) => A.ctx.files.call('glob', { pattern: '**/*', path: p }, ctx())],
  ['grep', (p) => A.ctx.files.call('grep', { pattern: 'secret', path: p }, ctx())],
  ['share_file', (p) => toolRegistry(A.ctx.files).call('share_file', { path: p, mode: 'preview' }, ctx())],
  ['make_file source', (p) => toolRegistry(A.ctx.files).call('make_file', { source: p, format: 'docx', output: 'users/alice/out.docx' }, ctx())],
]
describe('AI file tools answer a hidden path exactly like one that does not exist', () => {
  for (const [parent, real, probes, missing] of CASES) {
    for (const [tool, call] of TOOLS) {
      test(`${tool}: ${parent}/ exact name, case variants and look-alikes of '${real}' match '${missing}'`, async () => {
        for (const below of BELOW) {
          const control = await call(`${parent}/${missing}${below}`)
          expect(control.isError).toBe(true)
          for (const probe of probes) {
            const p = `${parent}/${probe}${below}`
            const r = await call(p)
            expect({ p, r: masked(r.text, probe) }).toEqual({ p, r: masked(control.text, missing) })
            if (probe !== real) expect(r.text).not.toContain(real) // the hidden spelling never comes back
          }
        }
      })
    }
  }
})

// ---------------------------------------------------------------- HTTP
type Req = (p: string) => Promise<{ status: number; body: unknown }>
const HTTP_READS: [string, Req][] = [
  ['history', (p) => A.json('/api/files/history?path=' + encodeURIComponent(p), { as: 'alice' })],
  ['tree', (p) => A.json('/api/files/tree?path=' + encodeURIComponent(p), { as: 'alice' })],
  ['content', (p) => A.json('/api/files/content?path=' + encodeURIComponent(p), { as: 'alice' })],
  ['download', (p) => A.json('/api/files/download?path=' + encodeURIComponent(p), { as: 'alice' })],
]
describe('HTTP answers a hidden path exactly like one that does not exist', () => {
  test('setup: the hidden folder is not in alice\'s tree, carol sees and edits it', async () => {
    const t = await A.json('/api/files/tree?path=skills', { as: 'alice' })
    expect(t.status).toBe(200)
    expect(JSON.stringify(t.body)).not.toContain('performance-reviews')
    const c = await A.json('/api/files/tree?path=' + encodeURIComponent('skills/performance-reviews'), { as: 'carol' })
    expect(JSON.stringify(c.body)).toContain('q3.md')
  })

  // the round-2 exploit (history on a long-s look-alike under the read-only skills/) and every other read route
  for (const [parent, real, probes, missing] of CASES) {
    for (const [route, call] of HTTP_READS) {
      test(`GET ${route}: ${parent}/ '${real}' and its variants match '${missing}' (status and body)`, async () => {
        for (const below of BELOW) {
          const control = await call(`${parent}/${missing}${below}`)
          expect(control.status).toBe(404)
          for (const probe of probes) {
            const p = `${parent}/${probe}${below}`
            const r = await call(p)
            expect({ p, status: r.status, body: masked(r.body, probe) }).toEqual({ p, status: control.status, body: masked(control.body, missing) })
          }
        }
      })
    }
  }
})

describe('the people it is meant for still work there', () => {
  test('alice reads and lists what she may; a missing file is a plain refusal for the AI', async () => {
    const c = ctx()
    expect((await A.ctx.files.call('read', { file_path: 'skills/team-rules.md' }, c)).text).toContain('Team rules')
    const list = (await A.ctx.files.call('list', { path: 'skills' }, c)).text
    expect(list).toStartWith('team-rules.md  (')
    expect(list).not.toContain('performance-reviews')
    const miss = await A.ctx.files.call('read', { file_path: 'groups/marketing/nope.md' }, c)
    expect(miss).toMatchObject({ isError: true, text: "Access denied: not found or no access: 'groups/marketing/nope.md'" })
  })

  test('alice still creates in her group folder; a read-only folder still says read-only', async () => {
    const c = ctx()
    expect((await A.ctx.files.call('write', { file_path: 'groups/marketing/new-plan.md', content: '# plan\n' }, c)).isError).toBeFalsy()
    expect((await A.json('/api/files/mkdir', { as: 'alice', ...jsonBody({ path: 'groups/marketing/r3-folder' }) })).status).toBeLessThan(300)
    const ro = await A.json('/api/files/mkdir', { as: 'alice', ...jsonBody({ path: 'skills/new-folder' }) })
    expect(ro.status).toBe(403)
    expect((await A.ctx.files.call('write', { file_path: 'skills/team-rules.md', content: 'x' }, c)).text).toBe("Access denied: read-only: you cannot change 'skills/team-rules.md'")
  })

  test('another person\'s folder stays "no access" whether it exists or not', async () => {
    for (const p of ['users/bob/x.md', 'users/nobody/x.md']) {
      const r = await A.json('/api/files/content', { as: 'alice', ...jsonBody({ path: p, content: 'x', baseSha256: null }, 'PUT') })
      expect(r.status).toBe(404)
      expect((await A.ctx.files.call('write', { file_path: p, content: 'x' }, ctx())).text).toBe(`Access denied: not found or no access: '${p}'`)
    }
  })

  test('carol (may write skills/performance-reviews) reads, lists, edits and creates there', async () => {
    const c = A.toolCtx('carol', A.turn('carol', A.chat('carol')))
    expect((await A.ctx.files.call('read', { file_path: 'skills/performance-reviews/q3.md' }, c)).text).toContain('secret review')
    expect((await A.ctx.files.call('list', { path: 'skills/performance-reviews' }, c)).text).toContain('q3.md')
    expect((await A.ctx.files.call('write', { file_path: 'skills/performance-reviews/q4.md', content: '# q4\n' }, c)).isError).toBeFalsy()
    expect((await A.json('/api/files/history?path=' + encodeURIComponent('skills/performance-reviews/q4.md'), { as: 'carol' })).status).toBe(200)
  })
})
