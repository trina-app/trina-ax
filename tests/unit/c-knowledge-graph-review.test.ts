// The knowledge graph's security review fixes (docs/KNOWLEDGE-GRAPH.md "Access: what an answer may show"):
// - F2: CodeGraph finds callers and callees by name, so another function of the same name in a file the person may not
//   read must not lend its connections to the match they may read
// - F1: an empty answer says the same whether or not anything is indexed, and an update in progress (which a change in
//   a hidden part can start) is not counted as "still being indexed"
// - F3: a signature (it can hold values) is shown only while the file itself still has it
// The stand-in indexer answers like CodeGraph 1.5: exact names first in a search, connections by name across every
// symbol of that name.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'
import { findCodeGraph } from '../../server/src/knowledge-graph/codegraph'
import { CodeGraphRunner, type GraphRef, type GraphRunner, type GraphSymbol } from '../../server/src/knowledge-graph/runner'
import { knowledgeGraphOf, setKnowledgeGraphForTests, type KnowledgeGraph } from '../../server/src/knowledge-graph/service'
import { NOTHING_FOUND } from '../../server/src/knowledge-graph/tool'
import { toolRegistry } from '../../server/src/tools/registry'

setDefaultTimeout(60_000)

class ByNameRunner implements GraphRunner {
  version = 'by-name-1'
  /** a build waits for this while set (an update in progress) */
  gate: Promise<void> | null = null
  private idx = new Map<string, { syms: GraphSymbol[]; calls: { from: GraphSymbol; to: string }[] }>()
  async build(project: string) {
    if (this.gate) await this.gate
    const tree = path.join(project, 'tree')
    const syms: GraphSymbol[] = []
    const calls: { from: GraphSymbol; to: string }[] = []
    const walk = (rel: string) => {
      for (const n of fs.readdirSync(path.join(tree, rel))) {
        const r = rel ? `${rel}/${n}` : n
        if (fs.lstatSync(path.join(tree, r)).isDirectory()) { walk(r); continue }
        const lines = fs.readFileSync(path.join(tree, r), 'utf8').split('\n')
        lines.forEach((l, i) => {
          const f = /function\s+(\w+)\s*\(/.exec(l)
          const c = /const\s+(\w+)\s*(=.*)$/.exec(l)
          if (c) syms.push({ kind: 'constant', name: c[1]!, filePath: `tree/${r}`, startLine: i + 1, endLine: i + 1, signature: c[2]!.trim(), score: 0 })
          if (!f) return
          const s: GraphSymbol = { kind: 'function', name: f[1]!, filePath: `tree/${r}`, startLine: i + 1, endLine: i + 3, signature: '(x)', score: 0 }
          syms.push(s)
          for (const m of (lines[i + 1] ?? '').matchAll(/(\w+)\(/g)) calls.push({ from: s, to: m[1]! })
        })
      }
    }
    if (fs.existsSync(tree)) walk('')
    fs.mkdirSync(path.join(project, '.codegraph'), { recursive: true })
    fs.writeFileSync(path.join(project, '.codegraph', 'codegraph.db'), 'stand-in')
    this.idx.set(project, { syms, calls })
    return { ok: true }
  }
  async stats(project: string) { const x = this.idx.get(project); return x ? { files: 1, symbols: x.syms.length } : null }
  async search(project: string, query: string, limit: number) {
    const q = query.toLowerCase()
    const syms = this.idx.get(project)?.syms ?? []
    const exact = syms.filter((s) => s.name.toLowerCase() === q), part = syms.filter((s) => s.name.toLowerCase() !== q && s.name.toLowerCase().includes(q))
    return [...exact, ...part].map((s) => ({ ...s, score: 10 })).slice(0, limit)
  }
  private ref = (s: GraphSymbol): GraphRef => ({ kind: s.kind, name: s.name, filePath: s.filePath, startLine: s.startLine })
  async callers(project: string, name: string) { return (this.idx.get(project)?.calls ?? []).filter((c) => c.to === name).map((c) => this.ref(c.from)) }
  async callees(project: string, name: string) {
    const x = this.idx.get(project)
    if (!x) return []
    // every symbol of that name, like CodeGraph's `callees <name>`
    return x.calls.filter((c) => c.from.name === name).flatMap((c) => x.syms.filter((s) => s.name === c.to && s.kind === 'function')).map(this.ref)
  }
}

const runner = new ByNameRunner()
let A: CApp
let kg: KnowledgeGraph
const put = (rel: string, text: string) => { const p = path.join(A.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const fn = (name: string, body = 'return 1') => `export function ${name}(x) {\n  ${body}\n}\n`
const tool = (who: 'alice' | 'carol', args: Record<string, unknown>) => toolRegistry(A.ctx.files).call('knowledge_explore', args, A.toolCtx(who))

beforeAll(async () => {
  setKnowledgeGraphForTests({ runner, debounceMs: 60, maxWaitMs: 500, pauseMinMs: 0, pauseMaxMs: 0 })
  A = await makeCApp('c-knowledge-graph-review')
  setKnowledgeGraphForTests(undefined)
  kg = knowledgeGraphOf(A.ctx)
  // alice is in marketing: groups/marketing yes, groups/marketing/salaries no (fixture rule); carol is an admin
  put('groups/marketing/site/run.ts', fn('runJob', 'return x'))
  put('groups/marketing/site/bank.ts', fn('notifyBank', 'return x'))
  put('groups/marketing/salaries/run.ts', fn('runJob', 'return notifyBank(x)'))
  put('groups/marketing/site/cart.ts', fn('cartTotal', 'return sumPrices(x)'))
  put('groups/marketing/site/sum.ts', fn('sumPrices', 'return x'))
  put('groups/marketing/site/config.ts', 'export const API_KEY = "sk-live-CANARY-OLD"\nexport const REGION = "ap-northeast-2"\n')
  kg.checkAll()
  await kg.whenIdle()
})
afterAll(async () => { await A?.close() })

describe('F2: connections by name', () => {
  test('a same-named function in a hidden folder does not lend its calls to the match the person may read', async () => {
    const r = await tool('alice', { query: 'runJob' })
    expect(r.text).toContain('runJob — groups/marketing/site/run.ts')
    expect(r.text).not.toContain('salaries')
    expect(r.text).not.toContain('notifyBank')
    const h = (r.structured!.hits as { name: string; callees: unknown[]; callers: unknown[] }[]).find((x) => x.name === 'runJob')!
    expect(h.callees).toEqual([])
    expect(h.callers).toEqual([])
  })

  test('someone who may read every function of that name still sees the connections', async () => {
    const r = await tool('carol', { query: 'runJob' })
    expect(r.text).toContain('calls: notifyBank (groups/marketing/site/bank.ts:1)')
  })

  test('a name with one function keeps its connections', async () => {
    expect((await tool('alice', { query: 'cartTotal' })).text).toContain('calls: sumPrices (groups/marketing/site/sum.ts:1)')
  })
})

describe('F1: what an empty answer tells', () => {
  test('the same words whether a folder seen only in part has code in the hidden part or none at all', async () => {
    const q = { query: 'zzqqnothinghere', path: 'groups/marketing/site' }
    const withHidden = await tool('alice', q)
    fs.rmSync(path.join(A.team, 'groups/marketing/site'), { recursive: true, force: true })
    put('groups/marketing/site/readme.md', '# nothing here\n')
    fs.rmSync(path.join(A.team, 'groups/marketing/salaries/run.ts'), { force: true })
    kg.checkAll()
    await kg.whenIdle()
    const without = await tool('alice', q)
    expect(withHidden.text).toBe(NOTHING_FOUND)
    expect(without.text).toBe(NOTHING_FOUND)
    // restore for the next tests
    put('groups/marketing/site/run.ts', fn('runJob', 'return x'))
    put('groups/marketing/site/config.ts', 'export const API_KEY = "sk-live-CANARY-OLD"\nexport const REGION = "ap-northeast-2"\n')
    kg.checkAll()
    await kg.whenIdle()
  })

  test('an update in progress (a change in a part hidden from the person can start one) is not "still being indexed"', async () => {
    let release!: () => void
    runner.gate = new Promise<void>((r) => { release = r })
    try {
      A.ctx.files.write(A.toolCtx('carol'), { file_path: 'groups/marketing/salaries/pay.ts', content: fn('payrollRun') })
      await Bun.sleep(300) // past the quiet time: the folder's run has started and waits in build
      const r = await tool('alice', { query: 'zzqqnothinghere', path: 'groups/marketing/site' })
      expect(r.text).toBe(NOTHING_FOUND)
      expect(r.text).not.toContain('still being indexed')
    } finally { runner.gate = null; release() }
    await kg.whenIdle()
  })
})

describe('F3: signatures', () => {
  test('a value taken out of a file is not shown from the older index', async () => {
    const before = await tool('alice', { query: 'API_KEY' })
    expect(before.text).toContain('sk-live-CANARY-OLD')
    // the file changes on disk; the index has not taken it in yet
    fs.writeFileSync(path.join(A.team, 'groups/marketing/site/config.ts'), 'export const API_KEY = process.env.API_KEY\nexport const REGION = "ap-northeast-2"\n')
    const after = await tool('alice', { query: 'API_KEY' })
    expect(after.text).toContain('API_KEY — groups/marketing/site/config.ts')
    expect(after.text).not.toContain('sk-live-CANARY-OLD')
    // a signature the file still has is shown
    expect((await tool('alice', { query: 'REGION' })).text).toContain('signature: = "ap-northeast-2"')
  })
})

const real = findCodeGraph()
describe.skipIf(!real)('F2 with the real CodeGraph (installed on this machine)', () => {
  test('a hidden runJob that calls notifyBank does not show under the readable runJob', async () => {
    setKnowledgeGraphForTests({ runner: new CodeGraphRunner(real!), debounceMs: 50, pauseMinMs: 0, pauseMaxMs: 0 })
    const C = await makeCApp('c-knowledge-graph-review-real')
    setKnowledgeGraphForTests(undefined)
    try {
      const k = knowledgeGraphOf(C.ctx)
      const w = (rel: string, s: string) => { const p = path.join(C.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
      w('groups/marketing/site/run.ts', 'export function runJob(x: number) {\n  return x\n}\n')
      w('groups/marketing/site/bank.ts', 'export function notifyBank(x: number) {\n  return x\n}\n')
      w('groups/marketing/salaries/run.ts', "import { notifyBank } from '../site/bank'\nexport function runJob(x: number) {\n  return notifyBank(x)\n}\n")
      k.checkAll()
      await k.whenIdle()
      const r = await toolRegistry(C.ctx.files).call('knowledge_explore', { query: 'runJob' }, C.toolCtx('alice'))
      expect(r.text).toContain('runJob — groups/marketing/site/run.ts')
      expect(r.text).not.toContain('notifyBank')
    } finally { await C.close() }
  })
})
