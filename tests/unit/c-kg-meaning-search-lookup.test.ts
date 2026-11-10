// The combined search seen from KnowledgeGraph.lookup() and explore() (server/src/knowledge-graph/service.ts; plan
// docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, wave 2), with a stand-in index that answers like the
// search worker: keyword hits, plus pieces found by meaning only (byMeaning) when asked with `meaning`.
// - `meaning` goes to the index only while search by meaning is on (KnowledgeGraph.meaningOn), and so does the index's
//   own `meaning` (the worker warms at its start)
// - a meaning-only hit is kept without the words (a Korean report for an English question) but is never strong, even
//   when its text holds every word; strong stays the keyword rule
// - meaning-only hits pass the same per-file access check: another person's folder never shows
// - knowledge_explore shows them as usual
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'
import type { DocHit, DocIndexOptions, DocIndexPort, DocLink, DocSearchOptions } from '../../server/src/knowledge-graph/docs-port'
import { knowledgeGraphOf, setKnowledgeGraphForTests, type KnowledgeGraph } from '../../server/src/knowledge-graph/service'

setDefaultTimeout(60_000)

const INCIDENT = '# 장애 보고서 — 2026-09-12\n예약 API 전체 중단, 47분. 원인: 인증서 만료.\n'
const REFUND = '# Refund policy\nCustomers get a refund within 14 days of purchase.\n'
const BOB = '# 장애 메모\nBOB-ONLY-CANARY 개인 메모.\n'

interface Doc { size: number; mtimeMs: number; text: string }
class MeaningFake implements DocIndexPort {
  roots = new Map<string, Map<string, Doc>>()
  asked: DocSearchOptions[] = []
  /** pieces "found by meaning" (rootId, relPath), answered only to a search asked with meaning */
  meaning: { rootId: string; relPath: string; text?: string }[] = []
  constructor(readonly dir: string, readonly o: DocIndexOptions) { fs.mkdirSync(dir, { recursive: true }) }
  accepts(name: string) { return /\.(md|txt)$/i.test(name) }
  private root(r: string) { let m = this.roots.get(r); if (!m) { m = new Map(); this.roots.set(r, m) } return m }
  files(rootId: string) { return new Map([...this.root(rootId)].map(([k, v]) => [k, { size: v.size, mtimeMs: v.mtimeMs, failed: null }])) }
  async update(rootId: string, relPath: string, f: { bytes: Uint8Array | null; size: number; mtimeMs: number }) {
    this.root(rootId).set(relPath, { size: f.size, mtimeMs: f.mtimeMs, text: f.bytes ? await this.o.extract(relPath, f.bytes) : '' })
    return { ok: true as const, chunks: 1 }
  }
  remove(rootId: string, relPath: string) { this.root(rootId).delete(relPath) }
  dropRoot(rootId: string) { this.roots.delete(rootId) }
  async search(q: string, o: DocSearchOptions): Promise<DocHit[]> {
    this.asked.push(o)
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    // keyword hits from this test's own files only (the fixture team's files hold common words)
    const keyword = [...this.roots].filter(([r]) => o.rootIds.includes(r)).flatMap(([r, m]) => [...m].map(([rel, d]) => ({ r, rel, d })))
      .filter((x) => (x.rel.startsWith('bench/') || x.r === 'users/bob') && terms.some((t) => x.d.text.toLowerCase().includes(t)))
      .map((x): DocHit => ({ rootId: x.r, relPath: x.rel, loc: null, snippet: x.d.text.slice(0, 200), passage: x.d.text, score: 10 }))
    if (!o.meaning) return keyword
    // like the worker: every folder's vectors would be filtered by rootIds there; here they are not, to prove the
    // service's own check
    const byMeaning = this.meaning.map((m): DocHit => {
      const text = m.text ?? this.roots.get(m.rootId)?.get(m.relPath)?.text ?? ''
      return { rootId: m.rootId, relPath: m.relPath, loc: null, snippet: text.slice(0, 200), passage: text, score: 7.5, byMeaning: true }
    })
    return [...keyword, ...byMeaning].slice(0, o.limit)
  }
  related(): DocLink[] { return [] }
  stats(rootId: string) { return { documents: this.root(rootId).size, failed: [], lastUpdatedAt: null } }
  diskBytes() { return 0 }
  close() {}
  destroy() { fs.rmSync(this.dir, { recursive: true, force: true }) }
}

let A: CApp
let k: KnowledgeGraph
let fake: MeaningFake
let on = false
const put = (rel: string, text: string) => { const p = path.join(A.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const look = (who: 'alice' | 'bob', q: string[], o: Parameters<KnowledgeGraph['lookup']>[2] = {}) => k.lookup(A.ctx.files.principal(who), q, o)

beforeAll(async () => {
  setKnowledgeGraphForTests({ runner: null, openDocs: (dir, o) => (fake = new MeaningFake(dir, o)), debounceMs: 50, maxWaitMs: 500, pauseMinMs: 0, pauseMaxMs: 0 })
  A = await makeCApp('c-kg-meaning-search-lookup')
  setKnowledgeGraphForTests(undefined)
  k = knowledgeGraphOf(A.ctx)
  // the switch is the meaning index's (KnowledgeGraph.meaningOn); here a stand-in
  Object.assign(k, { meaningOn: () => on })
  put('shared/bench/incident-2026-09.md', INCIDENT)
  put('shared/bench/refund.md', REFUND)
  put('users/bob/memo.md', BOB)
  k.checkAll()
  await k.whenIdle()
})
afterAll(async () => { await A?.close() })

describe('search by meaning through lookup()', () => {
  test('off: no meaning asked, and meaning-only hits never come', async () => {
    on = false
    fake.meaning = [{ rootId: 'shared', relPath: 'bench/incident-2026-09.md' }]
    fake.asked = []
    const r = await look('alice', ['Where is the note about the September downtime?'])
    expect(fake.asked.length).toBeGreaterThan(0)
    for (const a of fake.asked) expect('meaning' in a).toBe(false)
    expect(r).toEqual({ passages: [], strength: 'none', files: new Set() })
    expect(fake.o.meaning?.()).toBe(false)
  })

  test('on: an English question finds the Korean report by meaning, as a weak match (named, not pasted)', async () => {
    on = true
    fake.meaning = [{ rootId: 'shared', relPath: 'bench/incident-2026-09.md' }]
    fake.asked = []
    const r = await look('alice', ['Where is the note about the September downtime?'], { deadlineMs: 200 })
    for (const a of fake.asked) expect(a.meaning).toBe(true)
    expect(r.strength).toBe('weak')
    expect(r.passages.map((p) => p.path)).toEqual(['shared/bench/incident-2026-09.md'])
    expect([...r.files]).toEqual(['shared/bench/incident-2026-09.md'])
    expect(fake.o.meaning?.()).toBe(true)
  })

  test('meaningOnly: false (the lookup before the model) leaves out what only meaning found; the default keeps it', async () => {
    on = true
    fake.meaning = [{ rootId: 'shared', relPath: 'bench/incident-2026-09.md' }]
    fake.asked = []
    const before = await look('alice', ['Where is the note about the September downtime?'], { deadlineMs: 200, meaningOnly: false })
    expect(before).toEqual({ passages: [], strength: 'none', files: new Set() })
    // not even asked: no wait on a cold model, no meaning-only pieces taking the keyword hits' slots
    expect(fake.asked.length).toBeGreaterThan(0)
    for (const a of fake.asked) expect('meaning' in a).toBe(false)
    const asked = await look('alice', ['Where is the note about the September downtime?'], { deadlineMs: 200 })
    expect(asked.passages.map((p) => p.path)).toEqual(['shared/bench/incident-2026-09.md'])
  })

  test('a meaning-only hit is never strong, even holding every word; strong stays the keyword rule', async () => {
    on = true
    // its text holds "refund policy" close together, but only meaning "found" it
    fake.meaning = [{ rootId: 'shared', relPath: 'bench/incident-2026-09.md', text: 'refund policy refund policy' }]
    const r = await look('alice', ['refund policy'])
    expect(r.passages.map((p) => p.path)).toContain('shared/bench/incident-2026-09.md')
    // the keyword hit (refund.md) is strong on its own
    expect(r.strength).toBe('strong')
    fake.meaning = [{ rootId: 'shared', relPath: 'bench/incident-2026-09.md', text: 'warranty terms warranty terms' }]
    expect((await look('alice', ['warranty terms'])).strength).toBe('weak')
    fake.meaning = [{ rootId: 'shared', relPath: 'bench/incident-2026-09.md', text: 'warranty terms are here' }]
    expect((await look('alice', ['warranty terms'])).strength).toBe('weak')
  })

  test('a meaning-only hit passes the same access check: another person\'s folder never shows', async () => {
    on = true
    fake.meaning = [{ rootId: 'users/bob', relPath: 'memo.md' }, { rootId: 'shared', relPath: 'bench/incident-2026-09.md' }]
    const r = await look('alice', ['September downtime'])
    expect(r.passages.map((p) => p.path)).toEqual(['shared/bench/incident-2026-09.md'])
    expect(JSON.stringify(r.passages)).not.toContain('BOB-ONLY-CANARY')
    const b = await look('bob', ['September downtime'])
    expect(b.passages.map((p) => p.path).sort()).toEqual(['shared/bench/incident-2026-09.md', 'users/bob/memo.md'])
  })

  test('knowledge_explore shows meaning-only passages as usual', async () => {
    on = true
    fake.meaning = [{ rootId: 'shared', relPath: 'bench/incident-2026-09.md' }]
    const r = await k.explore(A.ctx.files.principal('alice'), 'September downtime note', { limit: 8 })
    expect(r.passages[0]).toMatchObject({ path: 'shared/bench/incident-2026-09.md', long: true })
    expect(r.passages[0]!.text).toContain('장애 보고서')
    expect(r.strength).toBe('weak')
  })
})
