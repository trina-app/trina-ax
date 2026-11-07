// The knowledge graph's document index (server/src/knowledge-graph/documents): text of each document type through the
// file tools' converters, Korean and English search, change detection, failures recorded instead of thrown, related
// documents with their reasons, and nothing left after a folder or the whole index is removed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { DocumentIndex } from '../../server/src/knowledge-graph/documents'
import { docLinks, mentionNames, queryTerms, stripKo, topTerms } from '../../server/src/knowledge-graph/documents/text'
import { Matcher } from '../../server/src/knowledge-graph/documents/matcher'

const pandoc = Bun.which('pandoc')
const pdftotext = Bun.which('pdftotext')
const HWP_DIR = path.join(import.meta.dir, '..', 'fixtures', 'hwp')
const enc = (s: string) => new TextEncoder().encode(s)
const file = (bytes: Uint8Array | null, mtimeMs = 1000) => ({ bytes, size: bytes?.byteLength ?? 99_000_000, mtimeMs })

/** a one-page PDF with a line of text (Helvetica), offsets computed */
function pdf(line: string): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${line.replace(/[()\\]/g, '\\$&')}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return enc(out)
}
function docx(md: string): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from(md) })
  return new Uint8Array(r.stdout)
}
function xlsx(rows: (string | number)[][]): Uint8Array {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '예산')
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

let dir: string
let idx: DocumentIndex
const people = ['김가나', 'Alice Kim']
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-docs-'))
  idx = DocumentIndex.open(path.join(dir, 'documents'), { people: () => people })
})
afterAll(() => { idx.close(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('document types', () => {
  test('which files it takes', () => {
    for (const n of ['a.pdf', 'a.docx', 'a.pptx', 'a.xlsx', 'a.hwp', 'a.hwpx', 'a.md', 'a.txt', 'a.csv', 'a.html']) expect(DocumentIndex.accepts(n)).toBe(true)
    for (const n of ['a.ts', 'a.png', 'a.zip', '~$a.docx', 'a']) expect(DocumentIndex.accepts(n)).toBe(false)
  })

  test('Markdown, with headings and links', async () => {
    const md = '# 2027 마케팅 계획\n\n주간 회의록을 공유합니다. 상반기 공동 마케팅 예산은 [예산표](budget/plan.xlsx)를 보세요.\n\nThe quarterly budget review is in the plan.\n'
    expect(await idx.update('projects/acme', 'notes/plan.md', file(enc(md)))).toEqual({ ok: true, chunks: 1 })
  })

  test('HTML: tags and scripts are not text', async () => {
    const html = '<html><head><title>Launch checklist page</title><script>var secretToken = 1</script></head><body><h1>Launch checklist</h1><p>Booth B-214 at the expo.</p></body></html>'
    expect((await idx.update('projects/acme', 'web/launch.html', file(enc(html)))).ok).toBe(true)
    expect(idx.search('secretToken', { rootIds: ['projects/acme'] })).toEqual([])
    expect(idx.search('booth', { rootIds: ['projects/acme'] })[0]?.relPath).toBe('web/launch.html')
  })

  test('Excel (sheet places kept)', async () => {
    const r = await idx.update('projects/acme', 'budget/plan.xlsx', file(xlsx([['항목', '금액'], ['공동 부스 임대료', 8000000], ['박람회 홍보물', 1200000]])))
    expect(r.ok).toBe(true)
    const hit = idx.search('부스 임대료', { rootIds: ['projects/acme'] })[0]!
    expect(hit.relPath).toBe('budget/plan.xlsx')
    expect(hit.loc?.kind).toBe('sheet')
  })

  test('Hangul: hwp and hwpx', async () => {
    expect((await idx.update('projects/acme', 'contracts/agreement.hwp', file(new Uint8Array(fs.readFileSync(path.join(HWP_DIR, 'agreement.hwp')))))).ok).toBe(true)
    expect((await idx.update('projects/acme', 'contracts/notice.hwpx', file(new Uint8Array(fs.readFileSync(path.join(HWP_DIR, 'notice.hwpx')))))).ok).toBe(true)
    expect(idx.search('협약서', { rootIds: ['projects/acme'] })[0]?.relPath).toBe('contracts/agreement.hwp')
    expect(idx.search('박람회 공동 참가', { rootIds: ['projects/acme'] })[0]?.relPath).toBe('contracts/notice.hwpx')
  })

  test.skipIf(!pandoc)('Word', async () => {
    const r = await idx.update('projects/acme', 'docs/brief.docx', file(docx('# Expo brief\n\nThe shared booth budget is split evenly between both companies.\n')))
    expect(r.ok).toBe(true)
    const hit = idx.search('booth budget', { rootIds: ['projects/acme'] }).find((h) => h.relPath === 'docs/brief.docx')
    expect(hit?.snippet).toContain('booth budget')
  })

  test.skipIf(!pdftotext)('PDF (page kept)', async () => {
    expect((await idx.update('projects/acme', 'docs/review.pdf', file(pdf('Quarterly revenue forecast for the expo season'))))).toEqual({ ok: true, chunks: 1 })
    const hit = idx.search('revenue forecast', { rootIds: ['projects/acme'] })[0]!
    expect(hit.relPath).toBe('docs/review.pdf')
    expect(hit.loc).toEqual({ kind: 'page', page: 1 })
  })
})

describe('search', () => {
  test('Korean finds parts of words (trigram) and short words at the start of a word, never in the middle of one', () => {
    expect(idx.search('회의록', { rootIds: ['projects/acme'] })[0]?.relPath).toBe('notes/plan.md')
    expect(idx.search('회의', { rootIds: ['projects/acme'] })[0]?.relPath).toBe('notes/plan.md')
    expect(idx.search('마케팅 예산을', { rootIds: ['projects/acme'] })[0]?.relPath).toBe('notes/plan.md')
    // "의록" is inside "회의록": finding it took a full scan of the text, which held the one search worker (grep finds it)
    expect(idx.search('의록', { rootIds: ['projects/acme'] })).toEqual([])
  })
  test('English, any case; snippet around the words', () => {
    const h = idx.search('QUARTERLY Budget', { rootIds: ['projects/acme'] })[0]!
    expect(h.relPath).toBe('notes/plan.md')
    expect(h.snippet.toLowerCase()).toContain('quarterly budget')
    expect(h.score).toBeGreaterThan(10)
  })
  test('only the folders asked', () => {
    expect(idx.search('회의록', { rootIds: ['projects/other'] })).toEqual([])
    expect(idx.search('회의록', { rootIds: [] })).toEqual([])
  })
  test('a longer passage on request, its lines kept; only the snippet otherwise', () => {
    const h = idx.search('quarterly budget', { rootIds: ['projects/acme'], passage: 500 }).find((x) => x.relPath === 'notes/plan.md')!
    expect(h.passage).toBeDefined()
    expect(h.passage!.length).toBeLessThanOrEqual(500)
    expect(h.passage!.toLowerCase()).toContain('quarterly budget')
    expect(h.passage).toContain('\n')
    expect(idx.search('quarterly budget', { rootIds: ['projects/acme'] })[0]!.passage).toBeUndefined()
  })
  test('a folder inside the root: only its files', () => {
    expect(idx.search('budget', { rootIds: ['projects/acme'], prefix: 'notes' }).map((h) => h.relPath)).toEqual(['notes/plan.md'])
    expect(idx.search('booth', { rootIds: ['projects/acme'], prefix: 'notes' })).toEqual([])
    expect(idx.search('booth', { rootIds: ['projects/acme'], prefix: 'web' })[0]?.relPath).toBe('web/launch.html')
    // "notes" does not take in "notes-old/" or "notesx"; a path that is not plain is no folder (no narrowing)
    expect(idx.search('booth', { rootIds: ['projects/acme'], prefix: 'we' })).toEqual([])
    expect(idx.search('booth', { rootIds: ['projects/acme'], prefix: '../web' }).map((h) => h.relPath)).toContain('web/launch.html')
  })
  test('odd questions give no error', () => {
    for (const q of ['"', '*', 'AND OR NOT', ')(', '\\', '%_', '']) expect(() => idx.search(q, { rootIds: ['projects/acme'] })).not.toThrow()
  })
})

describe('changes', () => {
  test('unchanged bytes are not read again; an edit is', async () => {
    let calls = 0
    const d = DocumentIndex.open(path.join(dir, 'changes'), { extract: async (_r, b) => { calls++; return new TextDecoder().decode(b) } })
    const v1 = enc('First version of the onboarding guide for new staff.')
    await d.update('r', 'guide.md', file(v1, 1))
    await d.update('r', 'guide.md', file(v1, 2))
    expect(calls).toBe(1)
    expect(d.files('r').get('guide.md')).toEqual({ size: v1.byteLength, mtimeMs: 2, failed: null })
    await d.update('r', 'guide.md', file(enc('Second version: the onboarding guide now covers payroll.'), 3))
    expect(calls).toBe(2)
    expect(d.search('payroll', { rootIds: ['r'] }).length).toBe(1)
    expect(d.search('staff', { rootIds: ['r'] })).toEqual([])
    d.destroy()
  })

  test('delete and move', async () => {
    const d = DocumentIndex.open(path.join(dir, 'moves'))
    const b = enc('Vendor contract renewal terms and the payment schedule.')
    await d.update('r', 'a/contract.md', file(b))
    d.remove('r', 'a/contract.md')
    expect(d.search('vendor contract', { rootIds: ['r'] })).toEqual([])
    await d.update('r', 'b/contract.md', file(b))
    expect(d.search('vendor contract', { rootIds: ['r'] })[0]?.relPath).toBe('b/contract.md')
    expect([...d.files('r').keys()]).toEqual(['b/contract.md'])
    d.destroy()
  })

  test('failures are recorded, never thrown', async () => {
    const d = DocumentIndex.open(path.join(dir, 'fail'), {
      limits: { maxFileBytes: 1000 },
      extract: async (rel) => { if (rel.includes('broken')) throw new Error('could not convert the file to text (pandoc: bad zip)'); if (rel.includes('missing')) throw new Error('pandoc is not installed on the server'); return '   ' },
    })
    expect(await d.update('r', 'big.pdf', { bytes: null, size: 50_000_000, mtimeMs: 7 })).toEqual({ ok: false, reason: 'too_big' })
    expect(await d.update('r', 'big2.md', file(new Uint8Array(2000)))).toEqual({ ok: false, reason: 'too_big' })
    expect(await d.update('r', 'broken.docx', file(enc('x')))).toEqual({ ok: false, reason: 'unreadable' })
    expect(await d.update('r', 'missing.docx', file(enc('y')))).toEqual({ ok: false, reason: 'no_converter' })
    expect(await d.update('r', 'blank.md', file(enc('z')))).toEqual({ ok: false, reason: 'empty' })
    expect(await d.update('r', 'code.ts', file(enc('z')))).toEqual({ ok: false, reason: 'unsupported' })
    // too_big keeps its size and mtime, so change detection works
    expect(d.files('r').get('big.pdf')).toEqual({ size: 50_000_000, mtimeMs: 7, failed: 'too_big' })
    const s = d.stats('r')
    expect(s.documents).toBe(0)
    expect(s.failedCount).toBe(6)
    expect(s.failed.map((f) => f.reason).sort()).toEqual(['empty', 'no_converter', 'too_big', 'too_big', 'unreadable', 'unsupported'])
    d.destroy()
  })

  test('a timeout is tried again; the caller\'s abort records nothing', async () => {
    let slow = true
    const d = DocumentIndex.open(path.join(dir, 'slow'), {
      limits: { extractMs: 50 },
      extract: (_r, b, signal) => slow ? new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(signal.reason))) : Promise.resolve(new TextDecoder().decode(b)),
    })
    const b = enc('Slow converter text about the warehouse inventory count.')
    expect(await d.update('r', 'slow.md', file(b, 5))).toEqual({ ok: false, reason: 'timeout' })
    expect(d.files('r').get('slow.md')?.size).toBe(-1)
    slow = false
    expect((await d.update('r', 'slow.md', file(b, 5))).ok).toBe(true)
    slow = true
    const ac = new AbortController()
    const p = d.update('r', 'other.md', file(enc('another file about inventory')), { signal: ac.signal })
    ac.abort()
    expect(await p).toEqual({ ok: false, reason: 'aborted' })
    expect(d.files('r').has('other.md')).toBe(false)
    d.destroy()
  })
})

describe('related documents', () => {
  let d: DocumentIndex
  const R = ['projects/expo']
  beforeAll(async () => {
    d = DocumentIndex.open(path.join(dir, 'related'), { people: () => ['김가나', 'Bob Lee'], extract: async (_r, b) => new TextDecoder().decode(b) })
    const put = (rel: string, s: string) => d.update('projects/expo', rel, file(enc(s)))
    await put('plan/expo-plan.md', '# Expo 2027 booth plan\n\nSee [the budget](../money/booth-budget.csv). 담당자 김가나 과장. Lighting rig, banner stand, brochure printing for the hall.')
    await put('money/booth-budget.csv', 'item,amount\nlighting rig,300\nbanner stand,120\nbrochure printing,80\n')
    await put('plan/schedule.md', 'Setup on day one, teardown on day three. The Expo 2027 booth plan has the layout.')
    await put('other/visitors.md', 'Visitor survey. Bob Lee will collect the forms. 김가나 과장이 결과를 정리합니다.')
    await put('other/hr.md', 'Holiday rota and payroll dates for the office team.')
    await d.update('projects/secret', 'x/leak.md', file(enc('Expo 2027 booth plan copy kept in a private folder. 김가나')))
  })
  afterAll(() => d.destroy())

  const reasons = (rel: string, rootIds = R) => Object.fromEntries(d.related('projects/expo', rel, { rootIds }).map((r) => [r.relPath, r.reasons.map((x) => `${x.kind}:${x.detail}`)]))

  test('link, mention, people, terms and folder, each with its reason', () => {
    const r = reasons('plan/expo-plan.md')
    expect(r['money/booth-budget.csv']).toContain('link:../money/booth-budget.csv')
    expect(r['money/booth-budget.csv']).toContain('terms:' + r['money/booth-budget.csv']!.find((x) => x.startsWith('terms:'))!.slice(6))
    expect(r['plan/schedule.md']).toContain('mention:Expo 2027 booth plan')
    expect(r['plan/schedule.md']).toContain('folder:plan')
    expect(r['other/visitors.md']).toEqual(['people:김가나'])
    expect(r['other/hr.md']).toBeUndefined()
    // the strongest reason first
    expect(d.related('projects/expo', 'plan/expo-plan.md', { rootIds: R })[0]!.relPath).toBe('money/booth-budget.csv')
  })

  test('links are found from either side', () => {
    expect(reasons('money/booth-budget.csv')['plan/expo-plan.md']).toContain('link:../money/booth-budget.csv')
  })

  test('only the folders asked: a document elsewhere is never named', () => {
    const all = d.related('projects/expo', 'plan/expo-plan.md', { rootIds: R })
    expect(all.some((x) => x.rootId === 'projects/secret')).toBe(false)
    expect(JSON.stringify(all)).not.toContain('private folder')
    expect(d.related('projects/expo', 'plan/expo-plan.md', { rootIds: [...R, 'projects/secret'] }).some((x) => x.relPath === 'x/leak.md')).toBe(true)
  })
})

describe('removal leaves nothing', () => {
  test('dropRoot and destroy', async () => {
    const p = path.join(dir, 'drop')
    const d = DocumentIndex.open(p)
    await d.update('a', 'one.md', file(enc('Alpha folder document about the supplier audit.')))
    await d.update('b', 'two.md', file(enc('Beta folder document about the supplier audit.')))
    d.dropRoot('a')
    expect(d.files('a').size).toBe(0)
    expect(d.search('supplier audit', { rootIds: ['a', 'b'] }).map((h) => h.rootId)).toEqual(['b'])
    expect(d.stats('a')).toEqual({ documents: 0, chunks: 0, failed: [], failedCount: 0, lastUpdatedAt: null })
    expect(d.diskBytes()).toBeGreaterThan(0)
    d.destroy()
    expect(fs.existsSync(p)).toBe(false)
  })

  test('a damaged database is made again', async () => {
    const p = path.join(dir, 'damaged')
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, 'documents.db'), 'not a database at all, just text that is long enough to be read as a header')
    const d = DocumentIndex.open(p)
    expect((await d.update('r', 'a.md', file(enc('Recovered index works after damage to the file.')))).ok).toBe(true)
    d.destroy()
  })
})

describe('text helpers', () => {
  test('Korean particles and endings', () => {
    expect(stripKo('회의록을')).toBe('회의록')
    expect(stripKo('공유합니다')).toBe('공유')
    expect(stripKo('회사')).toBe('회사')
    expect(queryTerms('주간 회의록을 찾아줘, Q3-plan.xlsx!')).toEqual(['주간', '회의록', '찾아줘', 'q3-plan.xlsx'])
  })
  test('terms leave out stop words and numbers', () => {
    const t = topTerms('the budget and the budget and 2026 and booth booth booth 예산을 예산은').map((x) => x.term)
    expect(t.slice(0, 3)).toEqual(['booth', 'budget', '예산'])
    expect(t).not.toContain('the')
    expect(t).not.toContain('2026')
  })
  test('links: files only, resolved in the folder root', () => {
    expect(docLinks('a/b/note.md', '[x](../c.pdf) [w](https://x.io/a.pdf) [m](mailto:a@b.c) [t](#top) [up](../../../out.md) <a href="d%20e.docx">')
      .map((l) => [l.target, l.base])).toEqual([['a/c.pdf', 'c.pdf'], ['', 'out.md'], ['a/b/d e.docx', 'd e.docx']])
  })
  test('names: generic names are not mentions', () => {
    expect(mentionNames('x/readme.md', null)).toEqual([])
    expect(mentionNames('x/2027 예산안.xlsx', null).map((n) => n.key)).toEqual(['2027 예산안.xlsx', '2027 예산안'])
  })
  test('matcher finds every name once, overlapping', () => {
    expect([...new Matcher(['he', 'she', 'his', 'hers']).find('ushers')].sort()).toEqual([0, 1, 3])
  })
})
