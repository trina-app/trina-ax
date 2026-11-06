// The knowledge graph (server/src/knowledge-graph/, docs/KNOWLEDGE-GRAPH.md): where the index lives, what the copy of
// the code holds, the quiet-time update after file changes, the access filter of every answer (a folder the person
// cannot read, a personal folder, a hidden sub-folder, access lost after indexing), the tool only while it is on, the
// rebuild and the admin routes. A stand-in indexer reads the copy the way CodeGraph would (functions and calls); the
// last test runs the real CodeGraph when this machine has it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { findCodeGraph } from '../../server/src/knowledge-graph/codegraph'
import { CodeGraphRunner, type GraphRef, type GraphRunner, type GraphSymbol } from '../../server/src/knowledge-graph/runner'
import { knowledgeGraphOf, setKnowledgeGraphForTests, type KnowledgeGraph } from '../../server/src/knowledge-graph/service'
import { toolRegistry } from '../../server/src/tools/registry'

setDefaultTimeout(60_000)

/** Functions ("function name(") and the calls in their bodies, read from the copy (<project>/tree). */
class FakeRunner implements GraphRunner {
  version = 'fake-1'
  builds: { project: string; full: boolean }[] = []
  /** the next n builds fail (a CodeGraph crash) */
  failNext = 0
  private idx = new Map<string, { syms: GraphSymbol[]; calls: Map<string, Set<string>>; files: number }>()
  async build(project: string, full: boolean) {
    this.builds.push({ project, full })
    if (this.failNext > 0) { this.failNext--; return { ok: false, error: 'exit 1' } }
    const tree = path.join(project, 'tree')
    const syms: GraphSymbol[] = []
    const bodies = new Map<string, string>()
    let files = 0
    const walk = (rel: string) => {
      for (const n of fs.readdirSync(path.join(tree, rel))) {
        const r = rel ? `${rel}/${n}` : n
        const st = fs.lstatSync(path.join(tree, r))
        if (st.isDirectory()) { walk(r); continue }
        files++
        const lines = fs.readFileSync(path.join(tree, r), 'utf8').split('\n')
        lines.forEach((l, i) => {
          const m = /function\s+(\w+)\s*\(/.exec(l)
          if (!m) return
          let end = i
          while (end < lines.length - 1 && lines[end] !== '}') end++
          syms.push({ kind: 'function', name: m[1]!, filePath: `tree/${r}`, startLine: i + 1, endLine: end + 1, signature: null, score: 0 })
          bodies.set(m[1]!, lines.slice(i + 1, end + 1).join('\n'))
        })
      }
    }
    if (fs.existsSync(tree)) walk('')
    const calls = new Map<string, Set<string>>()
    for (const s of syms) calls.set(s.name, new Set(syms.filter((o) => o.name !== s.name && bodies.get(s.name)!.includes(o.name + '(')).map((o) => o.name)))
    fs.mkdirSync(path.join(project, '.codegraph'), { recursive: true })
    fs.writeFileSync(path.join(project, '.codegraph', 'codegraph.db'), 'stand-in')
    this.idx.set(project, { syms, calls, files })
    return { ok: true }
  }
  async stats(project: string) { const x = this.idx.get(project); return x ? { files: x.files, symbols: x.syms.length } : null }
  async search(project: string, query: string, limit: number) {
    const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2)
    return (this.idx.get(project)?.syms ?? []).filter((s) => terms.some((t) => s.name.toLowerCase().includes(t))).map((s) => ({ ...s, score: 10 })).slice(0, limit)
  }
  private ref = (s: GraphSymbol): GraphRef => ({ kind: s.kind, name: s.name, filePath: s.filePath, startLine: s.startLine })
  async callers(project: string, name: string) { const x = this.idx.get(project); return x ? x.syms.filter((s) => x.calls.get(s.name)?.has(name)).map(this.ref) : [] }
  async callees(project: string, name: string) { const x = this.idx.get(project); return x ? [...(x.calls.get(name) ?? [])].map((n) => x.syms.find((s) => s.name === n)!).map(this.ref) : [] }
  forRoot(kg: KnowledgeGraph, root: string) { return this.builds.filter((b) => b.project.startsWith(kg.dir) && fs.realpathSync(b.project) === fs.realpathSync(projectOf(kg, root))) }
}

const projectOf = (kg: KnowledgeGraph, root: string) => {
  const id = new Bun.CryptoHasher('sha256').update(root.normalize('NFC')).digest('hex').slice(0, 24)
  return path.join(kg.dir, 'roots', id, 'project')
}
const listAll = (dir: string): string[] => {
  const out: string[] = []
  const walk = (rel: string) => {
    let names: string[] = []
    try { names = fs.readdirSync(path.join(dir, rel)) } catch { return }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n
      out.push(r)
      const st = fs.lstatSync(path.join(dir, r))
      if (st.isDirectory()) walk(r)
    }
  }
  walk('')
  return out.sort()
}

const fake = new FakeRunner()
let A: CApp
let kg: KnowledgeGraph
const put = (rel: string, text: string) => { const p = path.join(A.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const fn = (name: string, body = 'return 1') => `export function ${name}(x) {\n  ${body}\n}\n`
const names = async (who: string, q: string, base?: string) => (await kg.explore(A.ctx.files.principal(who), q, { limit: 20, base })).hits.map((h) => `${h.name}@${h.path}`)
const tool = (who: 'alice' | 'bob' | 'carol' | 'dana' | 'erin', args: Record<string, unknown>) => {
  const t = A.toolCtx(who)
  return toolRegistry(A.ctx.files).call('knowledge_explore', args, t).then((r) => ({ ...r, reads: t.files.readPaths }))
}

beforeAll(async () => {
  setKnowledgeGraphForTests({ runner: fake, debounceMs: 80, maxWaitMs: 600, pauseMinMs: 0, pauseMaxMs: 0 })
  A = await makeCApp('c-knowledge-graph')
  setKnowledgeGraphForTests(undefined)
  kg = knowledgeGraphOf(A.ctx)
  put('projects/demo/src/cart.ts', fn('cartTotal', 'return sumPrices(x) * 1.1'))
  put('projects/demo/src/sum.ts', fn('sumPrices', 'return x.reduce((a, b) => a + b, 0)'))
  put('projects/atlas/ledger.ts', fn('atlasLedger'))                      // finance only
  put('projects/falcon/engine.ts', fn('falconEngine'))                    // alice (person rule) and finance
  put('users/bob/tools/helper.ts', fn('bobPrivateHelper'))                // bob's own
  put('groups/marketing/site/app.ts', fn('marketingLaunch', 'return payrollSecret(x) + 1'))
  put('groups/marketing/salaries/pay.ts', fn('payrollSecret'))            // 'none' for marketing members
  put('groups/finance/finance-code.ts', fn('financeOnlyCode'))            // reachable from marketing only through the fixture's finance-dir link
  // traps in the demo project: a link to a file outside the team folder, a link to a folder, a hard link, a
  // dependency folder, a server temp name, a file too big for the copy
  const outside = path.join(A.team, '..', 'outside')
  fs.writeFileSync(path.join(outside, 'evil.ts'), fn('outsideEvil'))
  fs.symlinkSync(path.join(outside, 'evil.ts'), path.join(A.team, 'projects/demo/src/evil.ts'))
  fs.symlinkSync(outside, path.join(A.team, 'projects/demo/outside-dir'))
  fs.writeFileSync(path.join(outside, 'hard-src.ts'), fn('hardLinked'))
  fs.linkSync(path.join(outside, 'hard-src.ts'), path.join(A.team, 'projects/demo/src/hard.ts'))
  put('projects/demo/node_modules/dep/index.js', fn('dependencyThing'))
  put('projects/demo/src/.mycel-tmp-1.ts', fn('tempThing'))
  put('projects/demo/src/huge.ts', fn('hugeThing') + '//'.repeat(600_000))
  kg.checkAll()
  await kg.whenIdle()
})
afterAll(async () => { await A?.close() })

describe('where the index lives', () => {
  test('in the server data folder, outside the team folder; the team folder gets nothing of it', async () => {
    expect(kg.dir.startsWith(A.data + path.sep)).toBe(true)
    expect(path.relative(A.team, kg.dir).startsWith('..')).toBe(true)
    expect(fs.existsSync(path.join(projectOf(kg, 'projects/demo'), '.codegraph', 'codegraph.db'))).toBe(true)
    const before = listAll(A.team)
    expect(before.filter((p) => p.split('/').some((s) => s === '.codegraph' || s === 'codegraph.db'))).toEqual([])
    kg.rebuild('projects/demo')
    await kg.whenIdle()
    expect(listAll(A.team)).toEqual(before)
  })

  test('the copy holds only the code the file tools would show (no links, hard links, temp names, dependencies or huge files)', () => {
    expect(listAll(path.join(projectOf(kg, 'projects/demo'), 'tree'))).toEqual(['src', 'src/cart.ts', 'src/sum.ts'])
    // the fixture's link groups/marketing/finance-dir -> ../finance is not followed
    expect(listAll(path.join(projectOf(kg, 'groups/marketing'), 'tree')).filter((p) => !p.endsWith('/') && p.includes('.ts'))).toEqual(['salaries/pay.ts', 'site/app.ts'])
  })

  test('a folder without code is not indexed; personal folders show only as a total', async () => {
    const s = (await A.json('/api/admin/knowledge-graph', { as: 'carol' })).body
    expect(s.roots.map((r: { path: string }) => r.path)).toEqual(['groups/finance', 'groups/marketing', 'projects/atlas', 'projects/demo', 'projects/falcon'])
    expect(s.personal).toEqual({ folders: 1, files: 1, symbols: 1 })
    expect(JSON.stringify(s)).not.toContain('users/')
    expect(s.roots.find((r: { path: string }) => r.path === 'projects/demo')).toMatchObject({ status: 'ready', files: 2, symbols: 2, source: 'auto' })
  })
})

describe('kept up to date when files change', () => {
  test('several AI edits within the quiet time: one update of that folder, and the new code is found', async () => {
    const before = fake.forRoot(kg, 'projects/demo').length
    const t = A.toolCtx('carol')
    A.ctx.files.write(t, { file_path: 'projects/demo/src/tax.ts', content: fn('taxRate') })
    await Bun.sleep(20)
    A.ctx.files.write(t, { file_path: 'projects/demo/src/discount.ts', content: fn('discountRate') })
    await Bun.sleep(20)
    A.ctx.files.write(t, { file_path: 'projects/demo/src/tax.ts', content: fn('taxRate', 'return 0.1') })
    await kg.whenIdle()
    const runs = fake.forRoot(kg, 'projects/demo').slice(before)
    expect(runs).toEqual([{ project: expect.any(String), full: false }])
    expect(await names('carol', 'taxRate discountRate')).toEqual(expect.arrayContaining(['taxRate@projects/demo/src/tax.ts', 'discountRate@projects/demo/src/discount.ts']))
  })

  test('an upload from the file screen updates its folder', async () => {
    const fd = new FormData()
    fd.set('folder', 'projects/demo/src'); fd.set('name', 'shipping.ts'); fd.set('onExists', 'rename')
    fd.set('file', new File([fn('shippingCost')], 'shipping.ts'))
    expect((await A.json('/api/files/upload', { method: 'POST', body: fd, as: 'carol' })).status).toBe(201)
    await kg.whenIdle()
    expect(await names('carol', 'shippingCost')).toEqual(['shippingCost@projects/demo/src/shipping.ts'])
  })

  test('a failed update keeps the last index answering, and the next check runs it again (the copy did not change)', async () => {
    fake.failNext = 1
    A.ctx.files.write(A.toolCtx('carol'), { file_path: 'projects/demo/src/retry.ts', content: fn('retryMe') })
    await kg.whenIdle()
    expect(kg.status().roots.find((r) => r.path === 'projects/demo')!.status).toBe('error')
    expect(await names('carol', 'cartTotal')).toEqual(['cartTotal@projects/demo/src/cart.ts'])
    expect(await names('carol', 'retryMe')).toEqual([])
    kg.checkAll()
    await kg.whenIdle()
    expect(kg.status().roots.find((r) => r.path === 'projects/demo')!.status).toBe('ready')
    expect(await names('carol', 'retryMe')).toEqual(['retryMe@projects/demo/src/retry.ts'])
  })

  test('a deleted file leaves the index; a new project folder gets its own index', async () => {
    expect((await A.json('/api/files?path=' + encodeURIComponent('projects/demo/src/discount.ts'), { method: 'DELETE', as: 'carol' })).status).toBe(200)
    A.ctx.files.write(A.toolCtx('carol'), { file_path: 'projects/zeta/main.ts', content: fn('zetaMain') })
    await kg.whenIdle()
    expect(await names('carol', 'discountRate')).toEqual([])
    expect(await names('carol', 'zetaMain')).toEqual(['zetaMain@projects/zeta/main.ts'])
  })
})

describe('every answer is filtered by the asking person\'s folder access', () => {
  test('a folder the person cannot read gives nothing', async () => {
    expect(await names('alice', 'atlasLedger')).toEqual([])
    expect(await names('erin', 'atlasLedger cartTotal')).toEqual([])
    expect(await names('bob', 'atlasLedger')).toEqual(['atlasLedger@projects/atlas/ledger.ts'])
  })

  test('a personal folder answers its owner only (not an admin, not the owner of the team)', async () => {
    expect(await names('bob', 'bobPrivateHelper')).toEqual(['bobPrivateHelper@users/bob/tools/helper.ts'])
    for (const who of ['alice', 'carol', 'dana']) expect(await names(who, 'bobPrivateHelper')).toEqual([])
  })

  test('a hidden folder inside a readable one: its code, and calls into it, are left out without a trace', async () => {
    expect(await names('alice', 'payrollSecret')).toEqual([])
    expect(await names('carol', 'payrollSecret')).toEqual(['payrollSecret@groups/marketing/salaries/pay.ts'])
    const r = await tool('alice', { query: 'marketingLaunch payroll' })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('groups/marketing/site/app.ts')
    // the callee in the hidden folder is not named (its name is in the visible line of code itself, which alice may read)
    expect(r.text).not.toContain('salaries')
    expect(r.text).not.toContain('calls: ')
    expect((r.structured!.hits as { callees: unknown[] }[])[0]!.callees).toEqual([])
    // carol sees the connection
    const c = await tool('carol', { query: 'marketingLaunch' })
    expect(c.text).toContain('calls: payrollSecret (groups/marketing/salaries/pay.ts:1)')
  })

  test('access lost after indexing: the next question already leaves it out', async () => {
    expect(await names('alice', 'falconEngine')).toEqual(['falconEngine@projects/falcon/engine.ts'])
    const row = A.ctx.db.query("SELECT r.id, r.folder_id FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'projects/falcon' AND r.subject_type = 'user' AND r.subject_id = 'alice'").get() as { id: string; folder_id: string }
    A.ctx.db.query('DELETE FROM folder_rules WHERE id = ?').run(row.id)
    try {
      expect(await names('alice', 'falconEngine')).toEqual([])
      expect((await tool('alice', { query: 'falconEngine' })).text).not.toContain('falcon')
    } finally {
      A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'alice', 'write')").run(row.id, row.folder_id)
    }
  })

  test('links in the team folder are never followed: outside files and other folders do not answer', async () => {
    for (const who of ['carol', 'dana', 'alice']) expect(await names(who, 'outsideEvil financeOnlyCode dependencyThing tempThing hugeThing hardLinked')).toEqual(who === 'alice' ? [] : ['financeOnlyCode@groups/finance/finance-code.ts'])
  })

  test('the tool: a folder the person cannot read is refused like a missing one; what it showed joins the read scope', async () => {
    const no = await tool('alice', { query: 'atlasLedger', path: 'projects/atlas' })
    expect(no.isError).toBe(true)
    expect(no.text).toBe("Access denied: not found or no access: 'projects/atlas'")
    const yes = await tool('carol', { query: 'cartTotal', path: 'projects/demo' })
    expect(yes.text).toContain('function cartTotal — projects/demo/src/cart.ts:1-3')
    expect(yes.text).toContain('calls: sumPrices (projects/demo/src/sum.ts:1)')
    expect(yes.text).toContain('return sumPrices(x) * 1.1')
    expect([...yes.reads].sort()).toEqual(['projects/demo/src/cart.ts', 'projects/demo/src/sum.ts'])
  })
})

describe('on, off, missing, rebuild', () => {
  test('the tool is offered only while the knowledge graph is on; off deletes the indexes', async () => {
    const reg = toolRegistry(A.ctx.files)
    const turnTool = () => A.ctx.services.turnTools!.find((x) => x.name === 'knowledge_explore')!
    expect(reg.available('knowledge_explore')).toBe(true)
    expect(turnTool().available!({ userId: 'alice', chatId: 'c', browser: false })).toBe(true)
    expect((await A.json('/api/admin/knowledge-graph', { ...jsonBody({ enabled: false }, 'PATCH'), as: 'carol' })).body).toMatchObject({ enabled: false, roots: [] })
    expect(reg.available('knowledge_explore')).toBe(false)
    expect(reg.list().map((x) => x.name)).not.toContain('knowledge_explore')
    expect(turnTool().available!({ userId: 'alice', chatId: 'c', browser: false })).toBe(false)
    expect((await reg.call('knowledge_explore', { query: 'cartTotal' }, A.toolCtx('carol'))).text).toBe("Error: unknown tool 'knowledge_explore'")
    expect(fs.existsSync(path.join(kg.dir, 'roots'))).toBe(false)
    // a change while off starts nothing
    A.ctx.files.write(A.toolCtx('carol'), { file_path: 'projects/demo/src/off.ts', content: fn('whileOff') })
    await kg.whenIdle()
    expect(fs.existsSync(path.join(kg.dir, 'roots'))).toBe(false)
    expect((await A.json('/api/admin/knowledge-graph', { ...jsonBody({ enabled: true }, 'PATCH'), as: 'carol' })).status).toBe(200)
    await kg.whenIdle()
    expect(reg.available('knowledge_explore')).toBe(true)
    expect(await names('carol', 'whileOff')).toEqual(['whileOff@projects/demo/src/off.ts'])
    const acts = (A.ctx.db.query("SELECT action FROM audit_log WHERE action LIKE 'knowledge_graph.%' ORDER BY id").all() as { action: string }[]).map((r) => r.action)
    expect(acts).toEqual(['knowledge_graph.off', 'knowledge_graph.on'])
  })

  test('rebuild makes every index again from the files (one folder, or all)', async () => {
    const one = fake.forRoot(kg, 'projects/demo').length
    expect((await A.json('/api/admin/knowledge-graph/rebuild', { ...jsonBody({ path: 'projects/demo' }), as: 'carol' })).status).toBe(202)
    await kg.whenIdle()
    expect(fake.forRoot(kg, 'projects/demo').slice(one)).toEqual([{ project: expect.any(String), full: true }])
    const all = fake.builds.length
    expect((await A.json('/api/admin/knowledge-graph/rebuild', { ...jsonBody({}), as: 'carol' })).status).toBe(202)
    await kg.whenIdle()
    expect(fake.builds.slice(all).every((b) => b.full)).toBe(true)
    expect(fake.builds.length - all).toBe(7) // the six team folders with code (zeta included) and bob's personal folder
    expect(await names('carol', 'cartTotal')).toEqual(['cartTotal@projects/demo/src/cart.ts'])
    // a personal folder is not a folder an admin may name
    expect((await A.json('/api/admin/knowledge-graph/rebuild', { ...jsonBody({ path: 'users/bob' }), as: 'carol' })).status).toBe(404)
  })

  test('without CodeGraph: off, the tool is not offered, and it cannot be turned on', async () => {
    setKnowledgeGraphForTests({ runner: null })
    const B = await makeCApp('c-knowledge-graph-missing')
    setKnowledgeGraphForTests(undefined)
    try {
      expect(toolRegistry(B.ctx.files).available('knowledge_explore')).toBe(false)
      expect((await B.json('/api/admin/knowledge-graph', { as: 'carol' })).body).toMatchObject({ available: false, version: null, enabled: false, roots: [] })
      const on = await B.json('/api/admin/knowledge-graph', { ...jsonBody({ enabled: true }, 'PATCH'), as: 'carol' })
      expect(on.status).toBe(409)
      expect(on.body.error.params).toEqual({ reason: 'unavailable' })
    } finally { await B.close() }
  })
})

describe('admin routes', () => {
  test('admins only', async () => {
    expect((await A.json('/api/admin/knowledge-graph', { as: 'alice' })).status).toBe(403)
    expect((await A.json('/api/admin/knowledge-graph', { ...jsonBody({ enabled: false }, 'PATCH'), as: 'bob' })).status).toBe(403)
    expect((await A.json('/api/admin/knowledge-graph/rebuild', { ...jsonBody({}), as: 'erin' })).status).toBe(403)
    expect(kg.enabled()).toBe(true)
  })

  test('added folders: existing folders outside personal folders, as they are named on disk', async () => {
    for (const [p, reason] of [['users/bob', 'personal'], ['nope/x', 'not_found'], ['../outside', 'not_found'], ['groups/marketing/finance-dir', 'not_found']] as const) {
      const r = await A.json('/api/admin/knowledge-graph', { ...jsonBody({ added: [p] }, 'PATCH'), as: 'carol' })
      expect(r.status, p).toBe(400)
      expect(r.body.error.params?.reason ?? r.body.error.fields?.['body.added'], p).toBe(reason)
    }
    put('tools/scripts/build.ts', fn('buildScript'))
    const ok = await A.json('/api/admin/knowledge-graph', { ...jsonBody({ added: ['tools/scripts'] }, 'PATCH'), as: 'carol' })
    expect(ok.body.added).toEqual(['tools/scripts'])
    await kg.whenIdle()
    // every top-level folder is indexed by itself now (documents anywhere are covered): tools/ holds the added folder
    expect((await A.json('/api/admin/knowledge-graph', { as: 'carol' })).body.roots.find((r: { path: string }) => r.path === 'tools')).toMatchObject({ source: 'auto', status: 'ready', symbols: 1 })
    // no rule on tools/: only admins and the owner read it
    expect(await names('alice', 'buildScript')).toEqual([])
    expect(await names('dana', 'buildScript')).toEqual(['buildScript@tools/scripts/build.ts'])
  })
})

const real = findCodeGraph()
describe.skipIf(!real)('the real CodeGraph (installed on this machine)', () => {
  test('indexes a copy in the data folder and answers with symbols, callers and callees', async () => {
    setKnowledgeGraphForTests({ runner: new CodeGraphRunner(real!), debounceMs: 50, pauseMinMs: 0, pauseMaxMs: 0 })
    const C = await makeCApp('c-knowledge-graph-real')
    setKnowledgeGraphForTests(undefined)
    try {
      const k = knowledgeGraphOf(C.ctx)
      const w = (rel: string, s: string) => { const p = path.join(C.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
      w('projects/shop/src/sum.ts', 'export function sumPrices(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0)\n}\n')
      w('projects/shop/src/cart.ts', "import { sumPrices } from './sum'\nexport function cartTotal(prices: number[]) {\n  return sumPrices(prices) * 1.1\n}\n")
      k.checkAll()
      await k.whenIdle()
      expect(k.status().roots).toEqual([expect.objectContaining({ path: 'projects/shop', status: 'ready', files: 2 })])
      expect(listAll(C.team).filter((p) => p.includes('.codegraph'))).toEqual([])
      const r = await k.explore(C.ctx.files.principal('carol'), 'cart total', { limit: 5 })
      const hit = r.hits.find((h) => h.name === 'cartTotal')!
      expect(hit).toMatchObject({ path: 'projects/shop/src/cart.ts', kind: 'function', line: 2 })
      expect(hit.callees.map((c) => `${c.name}@${c.filePath}`)).toContain('sumPrices@projects/shop/src/sum.ts')
      expect(hit.snippet).toContain('return sumPrices(prices) * 1.1')
      expect((await k.explore(C.ctx.files.principal('alice'), 'cart total', { limit: 5 })).hits).toEqual([])
    } finally { await C.close() }
  })
})
