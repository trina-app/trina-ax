// KnowledgeGraph.lookup() (server/src/knowledge-graph/service.ts; docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md):
// the one document search of the AI's knowledge_explore tool, the lookup before the model starts and the Files search.
// - access exactly as in explore: another person's personal folder, a hidden sub-folder, a rule taken away between two
//   calls, `base`, a quarantined file, links (also when the index answers more than it was asked)
// - strength: ordinary chat messages are none or weak, document questions strong
// - two wordings merged, one entry per (path, place); long and short sizes; the deadline
// - the tool's answer: passages first, its size cap, alt_query
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'
import { cutText, matchStrength, passageOf, questionTerms, STRONG_NEAR } from '../../server/src/knowledge-graph/documents'
import type { DocHit, DocIndexOptions, DocIndexPort, DocLink, DocSearchOptions } from '../../server/src/knowledge-graph/docs-port'
import { knowledgeGraphOf, LOOKUP_LONG, LOOKUP_LONG_CHARS, LOOKUP_SHORT, LOOKUP_SHORT_CHARS, openDocumentIndex, setKnowledgeGraphForTests, type KnowledgeGraph, type LookupResult } from '../../server/src/knowledge-graph/service'
import { exploreText, TOOL_TEXT_MAX } from '../../server/src/knowledge-graph/tool'
import { toolRegistry } from '../../server/src/tools/registry'

setDefaultTimeout(60_000)

type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const paths = (r: LookupResult) => r.passages.map((x) => x.path)
const keyOf = (x: { path: string; loc: unknown }) => `${x.path}\u0000${JSON.stringify(x.loc)}`

describe('the words of a question (questionTerms)', () => {
  test('greetings, thanks, requests, question words and fillers are not words, in English and Korean', () => {
    for (const q of ['hi', 'Thanks!', 'thank you so much', 'ok thx', 'Can you summarize this for me?', '안녕하세요', '고마워요', '감사합니다', 'ㅋㅋㅋ', '작성했나요', '뭐야?'])
      expect(questionTerms(q)).toEqual([])
    expect(questionTerms('write me an email')).toEqual(['email'])
    expect(questionTerms('이메일 좀 써줘')).toEqual(['이메일'])
    expect(questionTerms('What is our refund policy for enterprise customers?')).toEqual(['refund', 'policy', 'enterprise', 'customers'])
    expect(questionTerms('환불 정책 어디에 썼지?')).toEqual(['환불', '정책'])
    expect(questionTerms('환불 정책은 며칠이야?')).toEqual(['환불', '정책'])
    expect(questionTerms('보고서 정리해줘')).toEqual(['보고서'])
    expect(questionTerms('Q4 마케팅 예산은 얼마야?')).toEqual(['q4', '마케팅', '예산'])
    expect(questionTerms('주간 회의록을 찾아줘, Q3-plan.xlsx!')).toEqual(['주간', '회의록', 'q3-plan.xlsx'])
    // a noun ending like a question ("분야") stays a noun
    expect(questionTerms('분야별 예산 알려주세요')).toEqual(['분야별', '예산'])
  })
  test('a long message keeps its subject, not its first words', () => {
    expect(questionTerms('Hello Trina, could you please help me find out where we wrote down the refund policy for enterprise customers'))
      .toEqual(['refund', 'policy', 'enterprise', 'customers'])
    expect(questionTerms('a b c d e f g h i j k l m n o p q r s t u v w x y z alpha beta gamma delta epsilon zeta eta theta iota', 8)).toHaveLength(8)
  })
})

describe('how well a passage holds them (matchStrength)', () => {
  const doc = '# Refund policy\nCustomers can ask for a refund within 14 days. Enterprise customers have 30 days under their contract.\n환불 정책은 7일 이내로 정했습니다.'
  test('every word close together: strong; some: weak; none: none', () => {
    expect(matchStrength(['refund', 'policy'], doc)).toBe('strong')
    expect(matchStrength(['환불', '정책'], doc)).toBe('strong')
    expect(matchStrength(['refund', 'warranty'], doc)).toBe('weak')
    expect(matchStrength(['warranty', 'shipping'], doc)).toBe('none')
    expect(matchStrength([], doc)).toBe('none')
  })
  test('four words or more: all but one is enough', () => {
    expect(matchStrength(['refund', 'policy', 'enterprise', 'warranty'], doc)).toBe('strong')
    expect(matchStrength(['refund', 'policy', 'warranty', 'shipping'], doc)).toBe('weak')
  })
  test('words far apart are weak', () => {
    const far = `zebra crossing rules. ${'filler text without the words. '.repeat(20)} mango delivery schedule.`
    expect(far.indexOf('mango') - far.indexOf('zebra')).toBeGreaterThan(STRONG_NEAR)
    expect(matchStrength(['zebra', 'mango'], far)).toBe('weak')
    expect(matchStrength(['zebra', 'crossing'], far)).toBe('strong')
  })
  test('one word: strong only for a code, a date or a file name', () => {
    expect(matchStrength(['refund'], doc)).toBe('weak')
    expect(matchStrength(['acme-po-4471'], 'Order ACME-PO-4471 shipped.')).toBe('strong')
    expect(matchStrength(['2026-11-03'], 'Launch: 2026-11-03')).toBe('strong')
    expect(matchStrength(['q4'], 'Q4 budget')).toBe('weak')
  })
  test('Latin words count at the start of a word only; Korean anywhere (particles attach)', () => {
    expect(matchStrength(['plan'], 'An explanation.')).toBe('none')
    expect(matchStrength(['plan'], 'The planning notes.')).toBe('weak')
    expect(matchStrength(['회의록'], '주간 회의록을 공유합니다')).toBe('weak')
  })
})

describe('passages and cuts', () => {
  test('a passage keeps its lines, stays within its size, and holds the match', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Line ${i}: ${i === 30 ? 'the warranty covers two years' : 'nothing to see here at all'}`).join('\n')
    const p = passageOf(text, ['warranty'], 400)
    expect(p.length).toBeLessThanOrEqual(400)
    expect(p).toContain('warranty covers two years')
    expect(p).toContain('\n')
    expect(passageOf('short text', ['x'], 400)).toBe('short text')
  })
  test('a cut never splits a character', () => {
    const s = '가'.repeat(10) + '😀'.repeat(10)
    for (let n = 5; n < 30; n++) {
      const c = cutText(s, n)
      expect(c.length).toBeLessThanOrEqual(n)
      expect(/[\ud800-\udbff]$/.test(c.replace(/ …$/, ''))).toBe(false)
    }
  })
})

// ---------------------------------------------------------------- the real document index on the fixture team
let A: CApp
let kg: KnowledgeGraph
const put = (app: CApp, rel: string, text: string) => { const p = path.join(app.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const look = (who: Who, queries: string[], o: Parameters<KnowledgeGraph['lookup']>[2] = {}) => kg.lookup(A.ctx.files.principal(who), queries, o)
const LEAVE = '# Leave policy\n\n' + Array.from({ length: 11 }, (_, i) => `Paragraph ${i + 1} of the leave policy: annual leave requests go to the team lead at least two weeks ahead, and sick leave needs a note after three days.`).join('\n\n') + '\n'
const QUARANTINED = '# Generated deck notes\nQTEST-CANARY-5521 download only output\n'

beforeAll(async () => {
  setKnowledgeGraphForTests({ runner: null, openDocs: openDocumentIndex, debounceMs: 50, maxWaitMs: 500, pauseMinMs: 0, pauseMaxMs: 0 })
  A = await makeCApp('c-kg-lookup')
  setKnowledgeGraphForTests(undefined)
  kg = knowledgeGraphOf(A.ctx)
  put(A, 'shared/notes/pricing.md', '# Pricing\n\nRefund policy: customers get a refund within 14 days of purchase.\nEnterprise customers have 30 days under their contract.\n')
  put(A, 'shared/handbook/leave.md', LEAVE)
  put(A, 'shared/회의록/주간회의.md', '# 주간회의\n이번 주 회의록을 공유합니다. 환불 정책은 7일 이내로 바꿉니다.\n')
  put(A, 'shared/notes/vendors.md', '# Vendor contract\nThe vendor contract renewal is due in March.\n')
  put(A, 'shared/notes/계약.md', '# 계약 갱신\n공급업체 계약 갱신은 3월입니다.\n')
  put(A, 'shared/notes/far.md', `# Far apart\nzebra crossing rules for the office street. ${'Nothing about either word here, only filler. '.repeat(14)}The mango delivery schedule is weekly.\n`)
  put(A, 'shared/notes/orders.md', '# Orders\nOrder ACME-PO-4471 shipped on Monday.\n')
  put(A, 'shared/notes/deck-notes.md', QUARANTINED)
  put(A, 'users/bob/plan.md', '# Bob plan\nRefund policy draft: enterprise customers get 60 days (bob only).\n')
  put(A, 'groups/marketing/launch.md', '# Launch\nThe refund policy shows on the launch page for enterprise customers.\n')
  put(A, 'groups/marketing/salaries/pay.md', '# Pay\nRefund policy for salary advances: enterprise customers excluded. SALCANARY-0912\n')
  put(A, 'projects/falcon/falcon-spec.md', '# Falcon\nFalcon refund policy section for enterprise customers.\n')
  kg.checkAll()
  await kg.whenIdle()
})
afterAll(async () => { await A?.close() })

describe('access: exactly as in explore', () => {
  const Q = ['refund policy for enterprise customers']
  test("another person's personal folder: their owner only (not an admin, not the team owner)", async () => {
    expect(paths(await look('bob', Q))).toContain('users/bob/plan.md')
    for (const who of ['alice', 'carol', 'dana', 'erin'] as const) {
      const r = await look(who, Q)
      expect(paths(r)).not.toContain('users/bob/plan.md')
      expect([...r.files].some((p) => p.startsWith('users/bob'))).toBe(false)
      expect(JSON.stringify(r.passages)).not.toContain('60 days')
    }
  })

  test('a hidden sub-folder inside a readable folder: nothing of it, not even its words', async () => {
    const a = await look('alice', Q)
    expect(paths(a)).toContain('groups/marketing/launch.md')
    expect(paths(a).some((p) => p.includes('/salaries/'))).toBe(false)
    expect(JSON.stringify(a)).not.toContain('SALCANARY')
    expect((await look('alice', ['SALCANARY-0912'])).passages).toEqual([])
    expect((await look('alice', ['SALCANARY-0912'])).strength).toBe('none')
    expect(paths(await look('carol', Q))).toContain('groups/marketing/salaries/pay.md')
  })

  test('a rule taken away between two calls: the next call leaves the folder out, without re-indexing', async () => {
    expect(paths(await look('alice', ['falcon refund policy']))).toContain('projects/falcon/falcon-spec.md')
    const row = A.ctx.db.query("SELECT r.id, r.folder_id FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'projects/falcon' AND r.subject_type = 'user' AND r.subject_id = 'alice'").get() as { id: string; folder_id: string }
    A.ctx.db.query('DELETE FROM folder_rules WHERE id = ?').run(row.id)
    try {
      const r = await look('alice', ['falcon refund policy'])
      expect(paths(r).every((p) => !p.startsWith('projects/falcon/') || p.startsWith('projects/falcon/public/'))).toBe(true)
      expect(JSON.stringify(r)).not.toContain('falcon-spec')
    } finally {
      A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'alice', 'write')").run(row.id, row.folder_id)
    }
    expect(paths(await look('alice', ['falcon refund policy']))).toContain('projects/falcon/falcon-spec.md')
  })

  test('base: only files under it (a folder inside an indexed folder, a whole folder, a folder above several)', async () => {
    const notes = await look('alice', Q, { base: 'shared/notes' })
    expect(paths(notes)).toContain('shared/notes/pricing.md')
    expect(paths(notes).every((p) => p.startsWith('shared/notes/'))).toBe(true)
    const mkt = await look('alice', Q, { base: 'groups/marketing' })
    expect(paths(mkt)).toContain('groups/marketing/launch.md')
    expect(paths(mkt).every((p) => p.startsWith('groups/marketing/') && !p.includes('/salaries/'))).toBe(true)
    const groups = await look('carol', Q, { base: 'groups' })
    expect(paths(groups)).toEqual(expect.arrayContaining(['groups/marketing/launch.md', 'groups/marketing/salaries/pay.md']))
    expect(paths(groups).every((p) => p.startsWith('groups/'))).toBe(true)
  })

  test('a quarantined (download-only) file is left out from the moment it is quarantined', async () => {
    expect(paths(await look('alice', ['QTEST-CANARY-5521']))).toEqual(['shared/notes/deck-notes.md'])
    A.ctx.files.quarantine.add(new TextEncoder().encode(QUARANTINED), 'image')
    const r = await look('alice', ['QTEST-CANARY-5521'])
    expect(r.passages).toEqual([])
    expect(r.strength).toBe('none')
    expect(r.files.size).toBe(0)
  })

  test('links: a symbolic link or a hard link to a finance file never shows', async () => {
    // the fixture's groups/marketing/budget-link.md (symbolic) and margin-copy.md (hard link) point into groups/finance
    for (const who of ['alice', 'erin'] as const) {
      const r = await look(who, ['CANARY-FIN-7731'])
      expect(r.passages).toEqual([])
      expect(JSON.stringify(r)).not.toContain('CANARY-FIN')
    }
    const bob = await look('bob', ['CANARY-FIN-7731'])
    expect(paths(bob)).toContain('groups/finance/budget.md')
    expect(paths(bob).some((p) => p.includes('budget-link') || p.includes('margin-copy'))).toBe(false)
  })
})

describe('strength', () => {
  test('ordinary chat messages are none or weak, never strong', async () => {
    for (const q of ['hi', 'thanks!', 'Thanks a lot', 'write me an email', 'Can you summarize this for me?', '안녕하세요', '고마워요', '이메일 좀 써줘', '오늘 회의 어땠어?',
      'please write a short email to thank the team for their work', 'ok', 'translate this into English please']) {
      expect([q, (await look('alice', [q])).strength]).not.toEqual([q, 'strong'])
    }
    for (const q of ['hi', 'thanks!', '안녕하세요', 'Can you summarize this for me?']) {
      const r = await look('alice', [q])
      expect(r).toEqual({ passages: [], strength: 'none', files: new Set() })
    }
  })
  test('a document question is strong; a part of one weak; nothing none', async () => {
    expect((await look('alice', ['What is our refund policy for enterprise customers?'])).strength).toBe('strong')
    expect((await look('alice', ['환불 정책 어디에 썼지?'])).strength).toBe('strong')
    expect((await look('alice', ['ACME-PO-4471'])).strength).toBe('strong')
    expect((await look('alice', ['refund'])).strength).toBe('weak')
    expect((await look('alice', ['zebra mango'])).strength).toBe('weak')
    expect((await look('alice', ['zebra crossing'])).strength).toBe('strong')
    const none = await look('alice', ['zzqqx quxfrob'])
    expect(none).toEqual({ passages: [], strength: 'none', files: new Set() })
  })
})

describe('two wordings, sizes', () => {
  test('a Korean question and its English wording are merged: each finds its own document', async () => {
    const ko = await look('alice', ['공급업체 계약 갱신'])
    expect(paths(ko)).toContain('shared/notes/계약.md')
    expect(paths(ko)).not.toContain('shared/notes/vendors.md')
    const both = await look('alice', ['공급업체 계약 갱신', 'vendor contract renewal'])
    expect(paths(both)).toEqual(expect.arrayContaining(['shared/notes/계약.md', 'shared/notes/vendors.md']))
    expect(both.strength).toBe('strong')
    expect([...both.files].sort()).toEqual([...new Set(paths(both))].sort())
  })
  test('one entry per (path, place), best first, also when both wordings find it', async () => {
    const r = await look('alice', ['refund policy', 'refund policy customers'])
    const keys = r.passages.map(keyOf)
    expect(new Set(keys).size).toBe(keys.length)
    for (let i = 1; i < r.passages.length; i++) expect(r.passages[i - 1]!.score).toBeGreaterThanOrEqual(r.passages[i]!.score)
  })
  test('long passages first (up to 3, up to 1500 characters, lines kept), then short ones (up to 300)', async () => {
    const r = await look('alice', ['annual leave requests team lead'])
    expect(r.strength).toBe('strong')
    const long = r.passages.filter((x) => x.long), short = r.passages.filter((x) => !x.long)
    expect(long.length).toBeGreaterThanOrEqual(1)
    expect(long.length).toBeLessThanOrEqual(LOOKUP_LONG)
    expect(short.length).toBeLessThanOrEqual(LOOKUP_SHORT)
    // every long one before every short one
    expect(r.passages.map((x) => x.long)).toEqual([...long.map(() => true), ...short.map(() => false)])
    const leave = long.find((x) => x.path === 'shared/handbook/leave.md')!
    expect(leave.text.length).toBeGreaterThan(LOOKUP_SHORT_CHARS)
    expect(leave.text.length).toBeLessThanOrEqual(LOOKUP_LONG_CHARS)
    expect(leave.text).toContain('\n')
    for (const x of short) expect(x.text.length).toBeLessThanOrEqual(LOOKUP_SHORT_CHARS)
    const filesView = await look('alice', ['leave policy'], { long: 0, short: 20 })
    expect(filesView.passages.length).toBeGreaterThan(0)
    expect(filesView.passages.length).toBeLessThanOrEqual(20)
    for (const x of filesView.passages) { expect(x.long).toBe(false); expect(x.text.length).toBeLessThanOrEqual(LOOKUP_SHORT_CHARS) }
    expect((await look('alice', ['leave policy'], { long: 1, short: 0 })).passages.map((x) => x.long)).toEqual([true])
  })
  test('nothing asked, nothing searched', async () => {
    expect((await look('alice', ['leave policy'], { long: 0, short: 0 })).passages).toEqual([])
    expect((await look('alice', [])).passages).toEqual([])
    expect((await look('alice', ['', ' x '])).passages).toEqual([])
  })
})

describe('the tool', () => {
  const call = (who: Who, args: Record<string, unknown>) => toolRegistry(A.ctx.files).call('knowledge_explore', args, A.toolCtx(who))
  test('passages to answer from with their place and link, then short matches; alt_query searched too', async () => {
    const r = await call('alice', { query: '공급업체 계약 갱신', alt_query: 'vendor contract renewal' })
    expect(r.isError).toBeFalsy()
    const ps = (r.structured!.passages as { path: string; long: boolean }[])
    expect(ps.map((x) => x.path)).toEqual(expect.arrayContaining(['shared/notes/계약.md', 'shared/notes/vendors.md']))
    expect(r.text.startsWith('Documents:\n1. ')).toBe(true)
    expect(r.text).toContain('link: [')
    const many = await call('alice', { query: 'refund policy customers' })
    expect(many.text).toContain('More matches:')
    expect(many.text.length).toBeLessThanOrEqual(TOOL_TEXT_MAX)
  })
  test('alt_query is 2 to 300 characters', async () => {
    expect((await call('alice', { query: 'refund policy', alt_query: 'x' })).isError).toBe(true)
    expect((await call('alice', { query: 'refund policy', alt_query: 'y'.repeat(301) })).isError).toBe(true)
  })
  test('the answer stays within its size; what is cut is not counted as shown', () => {
    const passage = (i: number, long: boolean) => ({ path: `shared/d${i}.md`, loc: { kind: 'heading' as const, heading: 'H' }, text: (long ? 'L' : 'S').repeat(long ? LOOKUP_LONG_CHARS : LOOKUP_SHORT_CHARS), score: 10 - i / 100, long })
    const hit = (i: number) => ({ path: `projects/app/f${i}.ts`, kind: 'function', name: `fn${i}`, line: 1, endLine: 12, signature: null, snippet: Array.from({ length: 12 }, (_, l) => `${String(l + 1).padStart(5)}  ${'x'.repeat(300)}`).join('\n'), callers: [], callees: [] })
    const r = {
      passages: [...[0, 1, 2].map((i) => passage(i, true)), ...Array.from({ length: 12 }, (_, i) => passage(3 + i, false))],
      related: Array.from({ length: 8 }, (_, i) => ({ path: `shared/r${i}.md`, from: 'shared/d0.md', reason: { kind: 'terms', detail: 'a, b, c' } })),
      hits: Array.from({ length: 20 }, (_, i) => hit(i)),
      pending: 2,
    }
    const out = exploreText(r, 'en')
    expect(out.text.length).toBeLessThanOrEqual(TOOL_TEXT_MAX)
    expect(out.passages).toHaveLength(15)
    expect(out.related).toHaveLength(8)
    expect(out.hits.length).toBeGreaterThan(0)
    expect(out.hits.length).toBeLessThan(20)
    expect(out.text).toContain('More matches were left out')
    expect(out.text).toContain('2 folders are still being indexed')
    expect(exploreText({ passages: [], related: [], hits: [], pending: 0 }, 'en').text).toBe('Nothing in the indexed documents or code matches, or nothing is indexed there yet. Use grep and read.')
  })
})

// ---------------------------------------------------------------- a stand-in index: leaky, slow
interface Doc { size: number; mtimeMs: number; text: string }
class FakeDocs implements DocIndexPort {
  roots = new Map<string, Map<string, Doc>>()
  /** answers from every folder and adds hits it was never asked for (to prove the service's own filter) */
  leaky = false
  extra: DocHit[] = []
  /** a search of a query with this word waits this long */
  slow = { word: 'slowword', ms: 0 }
  asked: DocSearchOptions[] = []
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
    if (this.slow.ms && q.includes(this.slow.word)) await Bun.sleep(this.slow.ms)
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const found = [...this.roots].filter(([r]) => this.leaky || o.rootIds.includes(r)).flatMap(([r, m]) => [...m].map(([rel, d]) => ({ r, rel, d })))
      .filter((x) => terms.some((t) => x.d.text.toLowerCase().includes(t)))
      .map((x): DocHit => ({ rootId: x.r, relPath: x.rel, loc: null, snippet: x.d.text.slice(0, 200), passage: x.d.text, score: terms.filter((t) => x.d.text.toLowerCase().includes(t)).length }))
    return [...(this.leaky ? this.extra : []), ...found].slice(0, o.limit)
  }
  related(): DocLink[] { return [] }
  stats(rootId: string) { return { documents: this.root(rootId).size, failed: [], lastUpdatedAt: null } }
  diskBytes() { return 0 }
  close() {}
  destroy() { fs.rmSync(this.dir, { recursive: true, force: true }) }
}

describe('with a stand-in index', () => {
  let B: CApp
  let k: KnowledgeGraph
  let fake: FakeDocs
  beforeAll(async () => {
    setKnowledgeGraphForTests({ runner: null, openDocs: (dir, o) => (fake = new FakeDocs(dir, o)), debounceMs: 50, maxWaitMs: 500, pauseMinMs: 0, pauseMaxMs: 0 })
    B = await makeCApp('c-kg-lookup-fake')
    setKnowledgeGraphForTests(undefined)
    k = knowledgeGraphOf(B.ctx)
    put(B, 'shared/notes/refunds.md', 'Refund policy: 14 days. slowword marker.\n')
    put(B, 'groups/marketing/launch-notes.md', 'Launch refund banner text.\n')
    k.checkAll()
    await k.whenIdle()
  })
  afterAll(async () => { await B?.close() })
  const bLook = (who: Who, q: string[], o: Parameters<KnowledgeGraph['lookup']>[2] = {}) => k.lookup(B.ctx.files.principal(who), q, o)

  test('an index that answers more than it was asked: links, hard links, hidden and other folders never show', async () => {
    const bad = (rootId: string, relPath: string): DocHit => ({ rootId, relPath, loc: null, snippet: `refund CANARY-LEAK ${relPath}`, passage: `refund CANARY-LEAK ${relPath}`, score: 99 })
    fake.extra = [
      bad('groups/marketing', 'budget-link.md'), // a symbolic link into groups/finance
      bad('groups/marketing', 'secret-link.txt'), // a symbolic link out of the team folder
      bad('groups/marketing', 'margin-copy.md'), // a hard link to a finance file
      bad('groups/marketing', 'salaries/2026.md'), // a hidden sub-folder
      bad('groups/marketing', '../finance/budget.md'), // not a plain path
      bad('groups/finance', 'budget.md'), // a folder alice cannot see
      bad('users/bob', 'notes.md'), // another person's folder
      bad('shared', 'abs-budget.md'), // an absolute link in shared/
    ]
    fake.leaky = true
    try {
      const r = await bLook('alice', ['refund'])
      expect(paths(r).sort()).toEqual(['groups/marketing/launch-notes.md', 'shared/notes/refunds.md'])
      expect(JSON.stringify(r)).not.toContain('CANARY-LEAK')
      expect([...r.files].sort()).toEqual(['groups/marketing/launch-notes.md', 'shared/notes/refunds.md'])
    } finally { fake.leaky = false; fake.extra = [] }
  })

  test('only the folders the person can see are asked; a folder inside one root narrows the index to it', async () => {
    fake.asked = []
    await bLook('alice', ['refund'])
    const asked = fake.asked.at(-1)!
    expect(asked.rootIds).toContain('shared')
    expect(asked.rootIds.some((r) => r.startsWith('users/bob') || r === 'groups/finance')).toBe(false)
    expect(asked.passage).toBe(LOOKUP_LONG_CHARS)
    await bLook('alice', ['refund'], { base: 'shared/notes' })
    expect(fake.asked.at(-1)).toMatchObject({ rootIds: ['shared'], prefix: 'notes' })
    await bLook('alice', ['refund'], { base: 'shared' })
    expect(fake.asked.at(-1)!.prefix).toBeUndefined()
  })

  test('the deadline: the first wording always answers; a second one that is not ready in time is left out', async () => {
    fake.slow.ms = 300
    try {
      let t0 = Date.now()
      const quick = await bLook('alice', ['launch banner', 'slowword refund'], { deadlineMs: 60 })
      expect(Date.now() - t0).toBeLessThan(250)
      expect(paths(quick)).toContain('groups/marketing/launch-notes.md')
      expect(paths(quick)).not.toContain('shared/notes/refunds.md')
      t0 = Date.now()
      const first = await bLook('alice', ['slowword refund'], { deadlineMs: 20 })
      expect(Date.now() - t0).toBeGreaterThanOrEqual(280)
      expect(paths(first)).toContain('shared/notes/refunds.md')
      // no deadline: both wordings
      const both = await bLook('alice', ['launch banner', 'slowword refund'])
      expect(paths(both)).toEqual(expect.arrayContaining(['groups/marketing/launch-notes.md', 'shared/notes/refunds.md']))
    } finally { fake.slow.ms = 0 }
  })
})
