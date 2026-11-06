// The knowledge graph's documents part, as the service wires it (server/src/knowledge-graph/service.ts, docs-port.ts):
// which files reach the document index and how (bytes read by the service, never through a link), updates after
// uploads, deletes and moves within the quiet time, the access filter of every passage and related document (also
// when the index itself answers more than it was asked: the "leaky" stand-in), the status for admins, too-big files and
// the off switch. A stand-in index keeps text in memory and matches substrings; the real index's own search (FTS5,
// Korean) is tested with it (knowledge-graph/documents/).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { knowledgeGraphOf, setKnowledgeGraphForTests, type KnowledgeGraph } from '../../server/src/knowledge-graph/service'
import type { DocHit, DocIndexOptions, DocIndexPort, DocLink } from '../../server/src/knowledge-graph/docs-port'
import { toolRegistry } from '../../server/src/tools/registry'

setDefaultTimeout(60_000)

interface Doc { size: number; mtimeMs: number; failed: string | null; text: string }
class FakeDocs implements DocIndexPort {
  roots = new Map<string, Map<string, Doc>>()
  /** answers from every folder, whatever it is asked (to prove the service's own filter) */
  leaky = false
  updates: { rootId: string; relPath: string; bytes: boolean }[] = []
  destroyed = 0
  constructor(readonly dir: string, readonly o: DocIndexOptions) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'index.db'), 'stand-in') }
  accepts(name: string) { return /\.(md|txt|pdf|docx|hwp|csv)$/i.test(name) }
  private root(r: string) { let m = this.roots.get(r); if (!m) { m = new Map(); this.roots.set(r, m) } return m }
  files(rootId: string) { return new Map([...this.root(rootId)].map(([k, v]) => [k, { size: v.size, mtimeMs: v.mtimeMs, failed: v.failed }])) }
  async update(rootId: string, relPath: string, f: { bytes: Uint8Array | null; size: number; mtimeMs: number }) {
    this.updates.push({ rootId, relPath, bytes: !!f.bytes })
    if (!f.bytes) { this.root(rootId).set(relPath, { size: f.size, mtimeMs: f.mtimeMs, failed: 'too_big', text: '' }); return { ok: false as const, reason: 'too_big' } }
    if (relPath.includes('broken')) { this.root(rootId).set(relPath, { size: f.size, mtimeMs: f.mtimeMs, failed: 'unreadable', text: '' }); return { ok: false as const, reason: 'unreadable' } }
    const text = await this.o.extract(relPath, f.bytes)
    this.root(rootId).set(relPath, { size: f.size, mtimeMs: f.mtimeMs, failed: null, text })
    return { ok: true as const, chunks: 1 }
  }
  remove(rootId: string, relPath: string) { this.root(rootId).delete(relPath) }
  dropRoot(rootId: string) { this.roots.delete(rootId) }
  private docs(rootIds: string[]) { return [...this.roots].filter(([r]) => this.leaky || rootIds.includes(r)).flatMap(([r, m]) => [...m].filter(([, d]) => !d.failed).map(([rel, d]) => ({ r, rel, d }))) }
  search(q: string, o: { rootIds: string[]; limit: number }): DocHit[] {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return this.docs(o.rootIds).filter((x) => terms.some((t) => x.d.text.toLowerCase().includes(t)))
      .map((x) => ({ rootId: x.r, relPath: x.rel, loc: { kind: 'heading' as const, heading: 'Notes' }, snippet: x.d.text.slice(0, 120), score: 1 })).slice(0, o.limit)
  }
  related(rootId: string, relPath: string, o: { rootIds: string[]; limit: number }): DocLink[] {
    return this.docs(o.rootIds).filter((x) => !(x.r === rootId && x.rel === relPath) && (this.leaky || x.r === rootId))
      .map((x) => ({ rootId: x.r, relPath: x.rel, reason: { kind: 'folder', detail: 'same folder' } })).slice(0, o.limit)
  }
  stats(rootId: string) {
    const m = [...this.root(rootId)]
    return { documents: m.filter(([, d]) => !d.failed).length, failed: m.filter(([, d]) => d.failed).map(([relPath, d]) => ({ relPath, reason: d.failed! })), lastUpdatedAt: new Date().toISOString() }
  }
  diskBytes() { return 4096 }
  close() {}
  destroy() { this.destroyed++; this.roots.clear(); fs.rmSync(this.dir, { recursive: true, force: true }) }
}

let fake: FakeDocs | null = null
const open = (dir: string, o: DocIndexOptions) => (fake = new FakeDocs(dir, o))
let A: CApp
let kg: KnowledgeGraph
const put = (rel: string, text: string) => { const p = path.join(A.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const ask = async (who: 'alice' | 'bob' | 'carol' | 'dana' | 'erin', query: string, extra: Record<string, unknown> = {}) => {
  const t = A.toolCtx(who)
  const r = await toolRegistry(A.ctx.files).call('knowledge_explore', { query, ...extra }, t)
  return { ...r, reads: [...t.files.readPaths].sort(), passages: ((r.structured?.passages ?? []) as { path: string }[]).map((x) => x.path), related: ((r.structured?.related ?? []) as { path: string }[]).map((x) => x.path) }
}
const upload = async (folder: string, name: string, text: string, as = 'carol') => {
  const fd = new FormData()
  fd.set('folder', folder); fd.set('name', name); fd.set('onExists', 'replace')
  fd.set('file', new File([text], name))
  return (await A.json('/api/files/upload', { method: 'POST', body: fd, as: as as 'carol' })).status
}

beforeAll(async () => {
  setKnowledgeGraphForTests({ runner: null, openDocs: open, debounceMs: 80, maxWaitMs: 600, pauseMinMs: 0, pauseMaxMs: 0, docReadMax: 20_000 })
  A = await makeCApp('c-knowledge-graph-docs')
  setKnowledgeGraphForTests(undefined)
  kg = knowledgeGraphOf(A.ctx)
  put('shared/회의록/2026-10-주간회의.md', '# 주간회의\n회의록을 정리했습니다. 환불 정책은 7일 이내로 정했습니다.\n')
  put('shared/notes/pricing.md', '# Pricing\nRefund policy: customers get a refund within 14 days.\n')
  put('shared/broken-scan.pdf', 'not really a pdf')
  put('shared/huge-log.txt', 'x'.repeat(30_000))
  put('users/bob/private-plan.md', '# Bob plan\nRefund policy draft only bob may read.\n')
  put('groups/marketing/launch-brief.md', '# Launch\nThe refund policy shows on the launch page.\n')
  put('groups/marketing/salaries/pay-memo.md', '# Pay\nRefund policy for salary advances (hidden from marketing members).\n')
  put('projects/falcon/falcon-spec.md', '# Falcon\nFalcon refund policy section.\n')
  kg.checkAll()
  await kg.whenIdle()
})
afterAll(async () => { await A?.close() })

describe('which files reach the index, and how', () => {
  test('documents in every top-level folder, read by the server: no links, no hard links, none over the read limit', () => {
    const shared = fake!.files('shared')
    expect([...shared.keys()]).toEqual(expect.arrayContaining(['회의록/2026-10-주간회의.md', 'notes/pricing.md', 'glossary.md', 'handbook.pdf', 'broken-scan.pdf', 'huge-log.txt']))
    expect([...shared.keys()].some((k) => k.includes('abs-budget') || k.includes('etc-link'))).toBe(false)
    expect([...fake!.files('groups/marketing').keys()].some((k) => k.includes('budget-link') || k.includes('finance-dir'))).toBe(false)
    // the fixture's links in shared/ (abs-budget.md → groups/finance, etc-link → /etc) never reach the index
    expect(fake!.updates.some((u) => u.relPath.includes('abs-budget') || u.relPath.includes('etc-link'))).toBe(false)
    // the hard-linked copy of a finance file in groups/marketing is not read either
    expect(fake!.files('groups/marketing').has('margin-copy.md')).toBe(false)
    // over the read limit: recorded without its bytes
    expect(fake!.updates.find((u) => u.relPath === 'huge-log.txt')).toMatchObject({ bytes: false })
    // the index lives in the server's data folder
    expect(fake!.dir.startsWith(A.data + path.sep)).toBe(true)
  })

  test('the status: folders with documents, unreadable files by path, personal folders only as totals', async () => {
    const s = (await A.json('/api/admin/knowledge-graph', { as: 'carol' })).body
    expect(s.documents.enabled).toBe(true)
    expect(s.documents.folders.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['groups/marketing', 'projects/falcon', 'shared']))
    expect(s.documents.failed).toEqual(expect.arrayContaining([{ path: 'shared/broken-scan.pdf', reason: 'unreadable' }, { path: 'shared/huge-log.txt', reason: 'too_big' }]))
    expect(s.documents.personal.documents).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(s)).not.toContain('users/')
  })
})

describe('the tool: passages and related documents, filtered by the asker\'s access', () => {
  test('Korean and English questions find their documents, with a link and the place', async () => {
    const ko = await ask('alice', '회의록')
    expect(ko.passages).toContain('shared/회의록/2026-10-주간회의.md')
    expect(ko.text).toContain('Documents:')
    expect(ko.text).toContain('link: [')
    const en = await ask('alice', 'refund')
    expect(en.passages).toEqual(expect.arrayContaining(['shared/notes/pricing.md', 'groups/marketing/launch-brief.md', 'projects/falcon/falcon-spec.md']))
    expect(en.reads).toEqual(expect.arrayContaining(en.passages))
  })

  test('another person\'s folder, a hidden sub-folder, a folder without access: nothing of them, not even a count', async () => {
    const a = await ask('alice', 'refund')
    expect(a.passages).not.toContain('users/bob/private-plan.md')
    expect(a.passages).not.toContain('groups/marketing/salaries/pay-memo.md')
    expect(a.text).not.toContain('salar')
    expect(a.text).not.toContain('private-plan')
    expect((await ask('carol', 'refund')).passages).toContain('groups/marketing/salaries/pay-memo.md')
    // personal folders: their owner only (not an admin, not the team owner)
    expect((await ask('bob', 'refund')).passages).toContain('users/bob/private-plan.md')
    for (const who of ['carol', 'dana'] as const) expect((await ask(who, 'refund')).passages).not.toContain('users/bob/private-plan.md')
    expect((await ask('erin', 'refund')).passages).not.toContain('projects/falcon/falcon-spec.md')
  })

  test('an index that answers more than it was asked still shows only what the asker may read (passages and related)', async () => {
    fake!.leaky = true
    try {
      const a = await ask('alice', 'refund launch')
      expect(a.passages.every((p) => !p.startsWith('users/bob') && !p.includes('/salaries/'))).toBe(true)
      expect(a.related.length).toBeGreaterThan(0)
      expect(a.related.every((p) => !p.startsWith('users/') && !p.includes('/salaries/') && !p.startsWith('groups/finance'))).toBe(true)
      expect(a.text).not.toContain('pay-memo')
      expect(a.text).not.toContain('private-plan')
    } finally { fake!.leaky = false }
  })

  test('access lost after indexing: the next question leaves the folder out, without re-indexing', async () => {
    expect((await ask('alice', 'falcon')).passages).toContain('projects/falcon/falcon-spec.md')
    const row = A.ctx.db.query("SELECT r.id, r.folder_id FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'projects/falcon' AND r.subject_type = 'user' AND r.subject_id = 'alice'").get() as { id: string; folder_id: string }
    A.ctx.db.query('DELETE FROM folder_rules WHERE id = ?').run(row.id)
    try {
      const r = await ask('alice', 'falcon')
      // only what stays open to everyone (projects/falcon/public/) is still shown
      expect(r.passages.every((p) => p.startsWith('projects/falcon/public/'))).toBe(true)
      expect(r.text).not.toContain('falcon-spec')
    } finally {
      A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'alice', 'write')").run(row.id, row.folder_id)
    }
  })

  test('a folder the asker cannot read is refused like a missing one', async () => {
    const r = await ask('alice', 'refund', { path: 'groups/finance' })
    expect(r.isError).toBe(true)
    expect(r.text).toBe("Access denied: not found or no access: 'groups/finance'")
  })
})

describe('kept up to date', () => {
  test('an upload is found after the quiet time; a delete and a move follow', async () => {
    expect(await upload('shared/notes', 'onboarding.txt', 'Onboarding checklist: laptop, badge, 보안 서약서 제출')).toBe(201)
    await kg.whenIdle()
    expect((await ask('alice', '보안 서약서')).passages).toContain('shared/notes/onboarding.txt')
    const mv = await A.json('/api/files/move', { ...jsonBody({ from: 'shared/notes/onboarding.txt', to: 'shared/회의록/onboarding.txt' }), as: 'carol' })
    expect(mv.status).toBe(200)
    await kg.whenIdle()
    expect((await ask('alice', 'onboarding checklist')).passages).toEqual(['shared/회의록/onboarding.txt'])
    expect((await A.json('/api/files?path=' + encodeURIComponent('shared/회의록/onboarding.txt'), { method: 'DELETE', as: 'carol' })).status).toBe(200)
    await kg.whenIdle()
    expect((await ask('alice', 'onboarding checklist')).passages).toEqual([])
  })
})

describe('the off switch', () => {
  test('off deletes the document index and the tool goes (no code part here); on builds it again', async () => {
    const reg = toolRegistry(A.ctx.files)
    expect(reg.available('knowledge_explore')).toBe(true)
    const dir = fake!.dir
    const off = await A.json('/api/admin/knowledge-graph', { ...jsonBody({ documents: false }, 'PATCH'), as: 'carol' })
    expect(off.status).toBe(200)
    expect(off.body.documents).toMatchObject({ enabled: false, folders: [], documents: 0 })
    expect(fake!.destroyed).toBe(1)
    expect(fs.existsSync(dir)).toBe(false)
    expect(reg.available('knowledge_explore')).toBe(false)
    expect((await A.json('/api/admin/knowledge-graph', { ...jsonBody({ documents: true }, 'PATCH'), as: 'carol' })).status).toBe(200)
    await kg.whenIdle()
    expect(reg.available('knowledge_explore')).toBe(true)
    expect((await ask('alice', '회의록')).passages).toContain('shared/회의록/2026-10-주간회의.md')
    const acts = (A.ctx.db.query("SELECT action FROM audit_log WHERE action LIKE 'knowledge_graph.%' ORDER BY id").all() as { action: string }[]).map((r) => r.action)
    expect(acts).toEqual(['knowledge_graph.documents_off', 'knowledge_graph.documents_on'])
  })
})

describe('with the real document index (knowledge-graph/documents/)', () => {
  test('Korean (part of a word) and English found through the tool, filtered by access; off deletes it', async () => {
    const { openDocumentIndex } = await import('../../server/src/knowledge-graph/service')
    setKnowledgeGraphForTests({ runner: null, openDocs: openDocumentIndex, debounceMs: 50, pauseMinMs: 0, pauseMaxMs: 0 })
    const B = await makeCApp('c-knowledge-graph-docs-real')
    setKnowledgeGraphForTests(undefined)
    try {
      const k = knowledgeGraphOf(B.ctx)
      const w = (rel: string, s: string) => { const p = path.join(B.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
      w('shared/회의록/주간회의.md', '# 주간회의\n이번 주 회의록을 공유합니다. 환불 정책은 7일 이내로 바꿉니다.\n')
      w('shared/notes/pricing.md', '# Pricing\nThe refund policy gives customers 14 days.\n')
      w('groups/finance/secret-plan.md', '# Plan\n환불 예산 회의록 (finance only)\n')
      k.checkAll()
      await k.whenIdle()
      const t = B.toolCtx('alice')
      const ko = await toolRegistry(B.ctx.files).call('knowledge_explore', { query: '회의록' }, t)
      const koPaths = ((ko.structured?.passages ?? []) as { path: string }[]).map((x) => x.path)
      expect(koPaths).toContain('shared/회의록/주간회의.md')
      expect(koPaths).not.toContain('groups/finance/secret-plan.md')
      expect(ko.text).not.toContain('secret-plan')
      const en = await toolRegistry(B.ctx.files).call('knowledge_explore', { query: 'refund policy' }, B.toolCtx('alice'))
      expect(((en.structured?.passages ?? []) as { path: string }[]).map((x) => x.path)).toContain('shared/notes/pricing.md')
      const bob = await toolRegistry(B.ctx.files).call('knowledge_explore', { query: '회의록' }, B.toolCtx('bob'))
      expect(((bob.structured?.passages ?? []) as { path: string }[]).map((x) => x.path)).toContain('groups/finance/secret-plan.md')
      const dir = path.join(k.dir, 'documents')
      expect(fs.existsSync(dir)).toBe(true)
      k.setDocsEnabled(false)
      expect(fs.existsSync(dir)).toBe(false)
    } finally { await B.close() }
  })
})
