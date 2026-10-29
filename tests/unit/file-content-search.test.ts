// File content search for people (R2-ETC-02): GET /api/files/search. It uses the AI's grep with the same
// permission checks, so a person finds only lines of files they can open: never another group's folder, a 'none'
// rule folder, someone else's personal folder or a hard link to a hidden file. Also: limits (results, lines per file,
// query length, rate limit), literal queries, Korean text (UTF-8 in NFC or NFD, legacy CP949) and office documents
// through the text cache. Real routes (tests/lib/b-harness.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { FileContentHits } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { CONTENT_SEARCH_PER_FILE, CONTENT_SEARCH_RATE_MAX, resetContentSearchLimits, SNIPPET_CHARS, snippetOf } from '../../server/src/team-files/content-search'

setDefaultTimeout(60_000)

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'file-content-search' }) })
afterAll(async () => { await h.close() })
beforeEach(() => resetContentSearchLimits())

const write = (rel: string, s: string | Uint8Array) => { const p = path.join(h.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const raw = (user: string, q: string, extra = '') => h.req(user, `/api/files/search?q=${encodeURIComponent(q)}${extra}`)
async function search(user: string, q: string, extra = ''): Promise<FileContentHits> {
  const r = await raw(user, q, extra)
  expect(r.status, `search ${q} as ${user}`).toBe(200)
  return (await r.json()) as FileContentHits
}
const paths = (r: FileContentHits) => [...new Set(r.items.map((i) => i.path))].sort()

describe('permission isolation', () => {
  test('a marker in another group, a none-rule folder, a personal folder or behind a hard link never shows', async () => {
    const M = 'QA-CONTENT-ONLY-874091'
    write('groups/finance/fs-secret.md', `top\nfinance line ${M}\n`)
    write('groups/marketing/salaries/fs-pay.md', `pay ${M}\n`)
    write('users/bob/fs-private.md', `bob ${M}\n`)
    write('groups/marketing/fs-open.md', `open ${M}\n`)
    // a hard link: both names have nlink 2, so the server shows neither of them (store.ts readRegular)
    write('groups/finance/fs-linked.md', `linked ${M}\n`)
    fs.linkSync(path.join(h.team, 'groups/finance/fs-linked.md'), path.join(h.team, 'users/alice/fs-link.md'))

    const alice = await search('alice', M)
    expect(paths(alice)).toEqual(['groups/marketing/fs-open.md'])
    expect(JSON.stringify(alice)).not.toContain('finance line')
    expect(alice.items[0]).toMatchObject({ path: 'groups/marketing/fs-open.md', name: 'fs-open.md', line: 1, snippet: `open ${M}` })

    const bob = await search('bob', M)
    expect(paths(bob)).toContain('groups/finance/fs-secret.md')
    expect(paths(bob)).toContain('users/bob/fs-private.md')
    expect(paths(bob)).not.toContain('users/alice/fs-link.md')
    expect(paths(bob)).not.toContain('groups/finance/fs-linked.md')
    expect(bob.items.find((i) => i.path === 'groups/finance/fs-secret.md')).toMatchObject({ line: 2 })

    // a folder the caller cannot list answers 404, as the name search does
    expect((await raw('alice', M, '&path=groups%2Ffinance')).status).toBe(404)
    expect((await raw('dana', M, '&path=users%2Fbob')).status).toBe(404)
    // the search can be narrowed to a folder the caller can read
    expect(paths(await search('bob', M, '&path=users%2Fbob'))).toEqual(['users/bob/fs-private.md'])
  })
})

describe('query handling', () => {
  test('the query is literal text in any case, not a pattern', async () => {
    write('shared/fs-literal.md', 'price (a.b) here\naxb other\nPRICE (A.B) upper\n')
    const r = await search('alice', '(a.b)', '&path=shared')
    expect(r.items.map((i) => [i.path, i.line])).toEqual([['shared/fs-literal.md', 1], ['shared/fs-literal.md', 3]])
    expect((await search('alice', '[unclosed', '&path=shared')).items).toEqual([])
  })

  test('Korean: UTF-8 found with an NFC or NFD query, legacy CP949 text found as Korean', async () => {
    write('shared/fs-korean.md', '회의록\n올해 예산 계획 QA-KO-5521\n')
    for (const q of ['예산 계획', '예산 계획'.normalize('NFD')]) {
      const r = await search('alice', q, '&path=shared')
      expect(r.items).toEqual([{ path: 'shared/fs-korean.md', name: 'fs-korean.md', line: 2, snippet: '올해 예산 계획 QA-KO-5521' }])
    }
    // the CP949 bytes of the text, from the decoder's own table (as tests/unit/office-extra.test.ts)
    const table = new Map<string, number[]>()
    const dec = new TextDecoder('euc-kr')
    for (let a = 0xb0; a <= 0xc8; a++) for (let b = 0xa1; b <= 0xfe; b++) {
      const ch = dec.decode(new Uint8Array([a, b]))
      if (ch.length === 1 && !table.has(ch)) table.set(ch, [a, b])
    }
    const cp949 = (s: string) => new Uint8Array([...s].flatMap((ch) => (ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : table.get(ch)!)))
    write('shared/fs-legacy.txt', cp949('첫 줄\n거래처 메모 가나상사\n'))
    const r = await search('alice', '가나상사', '&path=shared')
    expect(r.items).toEqual([{ path: 'shared/fs-legacy.txt', name: 'fs-legacy.txt', line: 2, snippet: '거래처 메모 가나상사' }])
  })

  test('office documents are searched through the text cache', async () => {
    const dir = fs.mkdtempSync(path.join(h.dataDir, 'xlsx-'))
    const put = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s) }
    put('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
    put('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    put('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')
    put('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
    put('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>QA-XLSX-MARK-3141</t></is></c></row></sheetData></worksheet>')
    const out = path.join(h.team, 'shared/fs-sheet.xlsx')
    const z = Bun.spawnSync(['zip', '-q', '-r', '-X', out, '[Content_Types].xml', '_rels', 'xl'], { cwd: dir })
    expect(z.exitCode).toBe(0)
    const r = await search('alice', 'qa-xlsx-mark-3141', '&path=shared')
    expect(paths(r)).toEqual(['shared/fs-sheet.xlsx'])
    expect(r.items[0]!.snippet).toContain('QA-XLSX-MARK-3141')
    // the hidden copy in another group stays hidden through the cache too
    fs.copyFileSync(out, path.join(h.team, 'groups/finance/fs-sheet.xlsx'))
    expect(paths(await search('alice', 'QA-XLSX-MARK-3141'))).toEqual(['shared/fs-sheet.xlsx'])
    expect(paths(await search('bob', 'QA-XLSX-MARK-3141'))).toContain('groups/finance/fs-sheet.xlsx')
  })
})

describe('limits', () => {
  test('results stop at the limit, a file gives at most a few lines, long lines are cut around the match', async () => {
    for (let f = 0; f < 6; f++) write(`shared/fs-many/f${f}.md`, Array.from({ length: 20 }, (_, i) => `row ${i} QA-MANY-77`).join('\n'))
    const all = await search('alice', 'QA-MANY-77', '&path=shared%2Ffs-many&limit=100')
    expect(all.items.length).toBe(6 * CONTENT_SEARCH_PER_FILE)
    const cut = await search('alice', 'QA-MANY-77', '&path=shared%2Ffs-many&limit=7')
    expect(cut.items.length).toBe(7)
    expect(cut.truncated).toBe(true)
    expect(all.timedOut).toBe(false)

    write('shared/fs-long.md', 'x'.repeat(1500) + ' QA-LONG-MARK ' + 'y'.repeat(1500))
    const long = await search('alice', 'QA-LONG-MARK', '&path=shared')
    const s = long.items[0]!.snippet
    expect(s).toContain('QA-LONG-MARK')
    expect(s.length).toBeLessThanOrEqual(SNIPPET_CHARS + 2)
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true)
  })

  test('query length and limit are checked', async () => {
    expect((await raw('alice', 'a'.repeat(201))).status).toBe(400)
    expect((await raw('alice', '   ')).status).toBe(400)
    expect((await raw('alice', 'abc', '&limit=101')).status).toBe(400)
  })

  test('each person has a rate limit; others are not affected', async () => {
    for (let i = 0; i < CONTENT_SEARCH_RATE_MAX; i++) expect((await raw('carol', 'QA-RATE-' + i, '&path=shared')).status).toBe(200)
    const r = await raw('carol', 'QA-RATE-X', '&path=shared')
    expect(r.status).toBe(429)
    expect(Number(r.headers.get('retry-after') ?? (await r.json() as { retryAfter?: number }).retryAfter)).toBeGreaterThan(0)
    expect((await raw('alice', 'QA-RATE-X', '&path=shared')).status).toBe(200)
  })
})

describe('snippetOf', () => {
  test('short lines stay whole; a surrogate pair is not cut', () => {
    expect(snippetOf('short line', 'line')).toBe('short line')
    const s = snippetOf('\u{1F600}'.repeat(200) + 'MARK' + 'z'.repeat(300), 'mark')
    expect(s).toContain('MARK')
    expect(s.isWellFormed()).toBe(true)
  })
})
