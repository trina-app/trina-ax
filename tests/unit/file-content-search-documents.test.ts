// The Files search box also asks the knowledge graph (GET /api/files/search, FileContentHits.documents; plan
// docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, wave 1 step 7): one row per document with its best
// passage and its place, next to the exact-line matches, which stay as they were. Permissions as before: a document
// row never names a file the person may not open now (another person's folder, a hidden sub-folder, a link, a hard
// link, a quarantined file, a folder rule taken away), also when the lookup itself answers more than it should, and
// only under the folder searched. Off, failing or slow: no rows, the line search answers as always. A stand-in
// document index (as tests/unit/c-knowledge-graph-docs.test.ts) keeps text in memory and matches substrings.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { FileContentHits } from '@mycel/shared/api'
import { jsonBody, makeCApp, type CApp, type Person } from '../lib/c-app'
import { knowledgeGraphOf, setKnowledgeGraphForTests, type KnowledgeGraph, type LookupResult } from '../../server/src/knowledge-graph/service'
import type { DocHit, DocIndexOptions, DocIndexPort, DocLink } from '../../server/src/knowledge-graph/docs-port'
import { CONTENT_SEARCH_DOCS_DEADLINE_MS, passageSnippet, queryWords, resetContentSearchLimits, SNIPPET_CHARS } from '../../server/src/team-files/content-search'

setDefaultTimeout(60_000)

interface Doc { size: number; mtimeMs: number; text: string }
class FakeDocs implements DocIndexPort {
  roots = new Map<string, Map<string, Doc>>()
  constructor(readonly dir: string, readonly o: DocIndexOptions) { fs.mkdirSync(dir, { recursive: true }) }
  accepts(name: string) { return /\.(md|txt)$/i.test(name) }
  private root(r: string) { let m = this.roots.get(r); if (!m) { m = new Map(); this.roots.set(r, m) } return m }
  files(rootId: string) { return new Map([...this.root(rootId)].map(([k, v]) => [k, { size: v.size, mtimeMs: v.mtimeMs, failed: null }])) }
  async update(rootId: string, relPath: string, f: { bytes: Uint8Array | null; size: number; mtimeMs: number }) {
    if (!f.bytes) return { ok: false as const, reason: 'too_big' }
    this.root(rootId).set(relPath, { size: f.size, mtimeMs: f.mtimeMs, text: await this.o.extract(relPath, f.bytes) })
    return { ok: true as const, chunks: 1 }
  }
  remove(rootId: string, relPath: string) { this.root(rootId).delete(relPath) }
  dropRoot(rootId: string) { this.roots.delete(rootId) }
  // two passages per document (two headings), so the screen's "one row per document" is tested
  search(q: string, o: { rootIds: string[]; limit: number }): DocHit[] {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return [...this.roots].filter(([r]) => o.rootIds.includes(r)).flatMap(([r, m]) => [...m].map(([rel, d]) => ({ r, rel, d })))
      .filter((x) => terms.some((t) => x.d.text.toLowerCase().includes(t)))
      .flatMap((x) => [
        { rootId: x.r, relPath: x.rel, loc: { kind: 'heading' as const, heading: 'Policy' }, snippet: x.d.text, score: 2 },
        { rootId: x.r, relPath: x.rel, loc: { kind: 'page' as const, page: 3 }, snippet: x.d.text, score: 1 },
      ]).slice(0, o.limit)
  }
  related(): DocLink[] { return [] }
  stats(rootId: string) { return { documents: this.root(rootId).size, failed: [], lastUpdatedAt: new Date().toISOString() } }
  diskBytes() { return 4096 }
  close() {}
  destroy() { this.roots.clear() }
}

let A: CApp
let kg: KnowledgeGraph
const put = (rel: string, text: string) => { const p = path.join(A.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
async function search(who: Person, q: string, extra = ''): Promise<FileContentHits> {
  resetContentSearchLimits()
  const r = await A.json(`/api/files/search?q=${encodeURIComponent(q)}${extra}`, { as: who })
  expect(r.status, `search ${q} as ${who}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200)
  return r.body as FileContentHits
}
const docs = (r: FileContentHits) => (r.documents ?? []).map((d) => d.path).sort()
const lines = (r: FileContentHits) => [...new Set(r.items.map((i) => i.path))].sort()

beforeAll(async () => {
  setKnowledgeGraphForTests({ runner: null, openDocs: (dir, o) => new FakeDocs(dir, o), debounceMs: 80, maxWaitMs: 600, pauseMinMs: 0, pauseMaxMs: 0 })
  A = await makeCApp('file-content-search-documents')
  setKnowledgeGraphForTests(undefined)
  kg = knowledgeGraphOf(A.ctx)
  put('shared/notes/pricing.md', '# Pricing\nRefund policy: customers get a refund within 14 days of the kgdoc order.\n')
  put('shared/notes/환불.md', '# 환불\n환불 정책은 7일 이내로 정했습니다. kgdoc\n')
  put('groups/marketing/launch-brief.md', '# Launch\nThe kgdoc refund rules show on the launch page.\n')
  put('groups/marketing/salaries/pay-memo.md', '# Pay\nkgdoc refund for salary advances (hidden from marketing members).\n')
  put('groups/finance/fin-refund.md', '# Finance\nkgdoc refund reserve.\n')
  put('users/bob/private-plan.md', '# Bob plan\nkgdoc refund draft only bob may read.\n')
  put('users/alice/mine.md', '# Mine\nkgdoc refund notes of alice.\n')
  put('projects/falcon/falcon-spec.md', '# Falcon\nFalcon kgdoc refund section.\n')
  put('shared/quarantined.md', '# Generated\nkgdoc refund in a generated file.\n')
  kg.checkAll()
  await kg.whenIdle()
})
afterAll(async () => { await A?.close() })

describe('document rows', () => {
  test('one row per document, best passage first, with its name, place and a short passage around the query words', async () => {
    const r = await search('alice', 'refund policy')
    expect(docs(r)).toEqual(expect.arrayContaining(['shared/notes/pricing.md', 'groups/marketing/launch-brief.md']))
    expect(new Set(docs(r)).size).toBe(docs(r).length)
    const row = r.documents!.find((d) => d.path === 'shared/notes/pricing.md')!
    // the heading passage scored higher than the page one of the same file
    expect(row).toEqual({ path: 'shared/notes/pricing.md', name: 'pricing.md', loc: { kind: 'heading', heading: 'Policy' }, snippet: '# Pricing Refund policy: customers get a refund within 14 days of the kgdoc order.' })
    // the line matches stay exactly the line search's
    expect(lines(r)).toEqual(['shared/notes/pricing.md'])
    expect(r.items[0]).toMatchObject({ path: 'shared/notes/pricing.md', line: 2 })
  })

  test('Korean: the document is found, the passage is cut around the first word found', async () => {
    const r = await search('alice', '환불 정책')
    expect(docs(r)).toContain('shared/notes/환불.md')
    expect(queryWords('환불  정책 a 의')).toEqual(['환불', '정책', '의'])
    const long = 'x'.repeat(300) + ' 환불 정책 ' + 'y'.repeat(300)
    const s = passageSnippet(long, ['정책', '환불'])
    expect(s.length).toBeLessThanOrEqual(SNIPPET_CHARS + 2)
    expect(s).toContain('환불 정책')
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true)
    // no word in the passage (a match by meaning, later): its start
    expect(passageSnippet('first line\nsecond', ['zzz'])).toBe('first line second')
  })

  test('a file written after the index was made: the line search finds it now, the document row comes later', async () => {
    put('shared/notes/fresh.md', 'kgdoc-fresh-line refund\n')
    const r = await search('alice', 'kgdoc-fresh-line')
    expect(lines(r)).toEqual(['shared/notes/fresh.md'])
    expect(r.documents).toEqual([])
  })
})

describe('permissions: as the line search, for the person searching, now', () => {
  test('another person\'s folder, a hidden sub-folder, a group the person is not in: never a row', async () => {
    const a = await search('alice', 'kgdoc')
    expect(docs(a)).toEqual(expect.arrayContaining(['groups/marketing/launch-brief.md', 'projects/falcon/falcon-spec.md', 'shared/notes/pricing.md', 'users/alice/mine.md']))
    for (const hidden of ['users/bob/private-plan.md', 'groups/marketing/salaries/pay-memo.md', 'groups/finance/fin-refund.md']) expect(docs(a)).not.toContain(hidden)
    expect(JSON.stringify(a)).not.toContain('salary advances')
    // the people who may open them do get them; an admin or the owner never another person's own folder
    expect(docs(await search('bob', 'kgdoc'))).toEqual(expect.arrayContaining(['users/bob/private-plan.md', 'groups/finance/fin-refund.md']))
    expect(docs(await search('carol', 'kgdoc'))).toContain('groups/marketing/salaries/pay-memo.md')
    for (const who of ['carol', 'dana'] as const) expect(docs(await search(who, 'kgdoc'))).not.toContain('users/bob/private-plan.md')
  })

  test('a quarantined file: no row once it is quarantined, though the index still holds its text', async () => {
    expect(docs(await search('alice', 'generated file'))).toContain('shared/quarantined.md')
    A.ctx.files.quarantine.add(fs.readFileSync(path.join(A.team, 'shared/quarantined.md')), 'pptx')
    const r = await search('alice', 'generated file')
    expect(docs(r)).not.toContain('shared/quarantined.md')
    expect(lines(r)).not.toContain('shared/quarantined.md')
  })

  test('a folder rule taken away after indexing: the next search leaves its documents out', async () => {
    expect(docs(await search('alice', 'Falcon'))).toContain('projects/falcon/falcon-spec.md')
    const row = A.ctx.db.query("SELECT r.id, r.folder_id FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'projects/falcon' AND r.subject_type = 'user' AND r.subject_id = 'alice'").get() as { id: string; folder_id: string }
    A.ctx.db.query('DELETE FROM folder_rules WHERE id = ?').run(row.id)
    try {
      const r = await search('alice', 'Falcon')
      expect(docs(r).every((p) => p.startsWith('projects/falcon/public/'))).toBe(true)
      expect(JSON.stringify(r)).not.toContain('falcon-spec')
    } finally {
      A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'alice', 'write')").run(row.id, row.folder_id)
    }
  })

  test('a lookup that answers more than it should still shows only files the line search could show', async () => {
    // every kind of file the person may not open: another person's, a hidden sub-folder, another group, a symbolic link
    // to a hidden file, a hard link of one (both names), a quarantined file, a server folder, a missing file
    const hidden = ['users/bob/private-plan.md', 'groups/marketing/salaries/pay-memo.md', 'groups/finance/fin-refund.md', 'groups/marketing/budget-link.md',
      'shared/abs-budget.md', 'groups/marketing/margin-copy.md', 'users/alice/audit-copy.md', 'shared/quarantined.md', '.system/x.md', 'shared/none.md', '../outside.md']
    const ok = ['groups/marketing/launch-brief.md', 'shared/notes/pricing.md']
    const real = kg.lookup.bind(kg)
    kg.lookup = async (): Promise<LookupResult> => {
      const all = [...hidden, ...ok]
      return { passages: all.map((p, i) => ({ path: p, loc: null, text: 'kgdoc leaked text ' + p, score: 100 - i, long: false })), strength: 'weak', files: new Set(all) }
    }
    try {
      const r = await search('alice', 'kgdoc')
      expect(docs(r)).toEqual(ok.slice().sort())
      for (const h of hidden) expect(JSON.stringify(r.documents)).not.toContain(h)
      // and under the folder searched only
      expect(docs(await search('alice', 'kgdoc', '&path=shared'))).toEqual(['shared/notes/pricing.md'])
    } finally { kg.lookup = real }
  })

  test('the folder searched limits the rows; a folder the person cannot list is "not found" as before', async () => {
    const r = await search('alice', 'kgdoc', '&path=groups%2Fmarketing')
    expect(docs(r)).toEqual(['groups/marketing/launch-brief.md'])
    expect(docs(await search('bob', 'kgdoc', '&path=users%2Fbob'))).toEqual(['users/bob/private-plan.md'])
    resetContentSearchLimits()
    for (const [who, p] of [['alice', 'groups/finance'], ['alice', 'users/bob'], ['carol', 'users/bob'], ['alice', 'groups/marketing/salaries']] as const) {
      const x = await A.json(`/api/files/search?q=kgdoc&path=${encodeURIComponent(p)}`, { as: who })
      expect(x.status, `${who} ${p}`).toBe(404)
      expect(JSON.stringify(x.body)).not.toContain('kgdoc')
    }
  })
})

describe('off, failing, slow', () => {
  test('the documents part off: no documents field, the line matches as before', async () => {
    expect((await A.json('/api/admin/knowledge-graph', { ...jsonBody({ documents: false }, 'PATCH'), as: 'carol' })).status).toBe(200)
    try {
      const r = await search('alice', 'refund policy')
      expect(r.documents).toBeUndefined()
      expect(lines(r)).toEqual(['shared/notes/pricing.md'])
    } finally {
      expect((await A.json('/api/admin/knowledge-graph', { ...jsonBody({ documents: true }, 'PATCH'), as: 'carol' })).status).toBe(200)
      await kg.whenIdle()
    }
  })

  test('a lookup that fails: no rows, the search still answers', async () => {
    const real = kg.lookup.bind(kg)
    kg.lookup = async () => { throw new Error('index broken') }
    try {
      const r = await search('alice', 'refund policy')
      expect(r.documents).toEqual([])
      expect(lines(r)).toEqual(['shared/notes/pricing.md'])
    } finally { kg.lookup = real }
  })

  test(`a lookup that is not back in time: the line matches do not wait for it (about ${CONTENT_SEARCH_DOCS_DEADLINE_MS * 2} ms at most)`, async () => {
    const real = kg.lookup.bind(kg)
    let asked: { base?: string; long?: number; short?: number; deadlineMs?: number; words?: string } | undefined
    kg.lookup = (_u, _q, o) => { asked = o; return new Promise<LookupResult>(() => {}) }
    try {
      const t0 = performance.now()
      const r = await search('alice', 'refund policy', '&path=shared')
      expect(performance.now() - t0).toBeLessThan(CONTENT_SEARCH_DOCS_DEADLINE_MS * 2 + 1500)
      expect(r.documents).toEqual([])
      expect(lines(r)).toEqual(['shared/notes/pricing.md'])
      // asked for short rows only, under the folder searched, with the deadline, every word typed counting
      expect(asked).toEqual({ base: 'shared', long: 0, short: 20, deadlineMs: CONTENT_SEARCH_DOCS_DEADLINE_MS, words: 'search' })
    } finally { kg.lookup = real }
  })

  test('the per-person rate limit still counts each search once', async () => {
    resetContentSearchLimits()
    let last = 0
    for (let i = 0; i < 61; i++) last = (await A.json('/api/files/search?q=kgdoc&path=shared', { as: 'erin' })).status
    expect(last).toBe(429)
    resetContentSearchLimits()
  })
})
