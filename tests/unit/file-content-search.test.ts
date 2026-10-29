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
import { OFFICE_QUEUE_PER_PERSON_MINUTE } from '../../server/src/files/search'
import { admitContentSearch, CONTENT_SEARCH_PARALLEL_MAX, CONTENT_SEARCH_PER_FILE, CONTENT_SEARCH_RATE_MAX, resetContentSearchLimits, SNIPPET_CHARS, snippetOf } from '../../server/src/team-files/content-search'

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

  test('a symbolic link to a hidden file, in a folder the caller can read, never shows', async () => {
    const M = 'QA-SYMLINK-ONLY-55120'
    write('groups/finance/fs-sym-target.md', `target ${M}\n`)
    fs.mkdirSync(path.join(h.team, 'shared/fs-sym'), { recursive: true })
    fs.symlinkSync(path.join(h.team, 'groups/finance/fs-sym-target.md'), path.join(h.team, 'shared/fs-sym/link.md'))
    fs.symlinkSync(path.join(h.team, 'groups/finance'), path.join(h.team, 'shared/fs-sym/dir'))
    expect((await search('alice', M)).items).toEqual([])
    expect((await search('alice', M, '&path=shared%2Ffs-sym')).items).toEqual([])
    expect(paths(await search('bob', M))).toEqual(['groups/finance/fs-sym-target.md'])
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

  test('Korean: NFD text in a file is found with an NFC or NFD query, and the snippet is NFC', async () => {
    write('shared/fs-nfd/note.md', ('첫 줄\n' + '분기 매출 보고 QA-NFD-8812\n').normalize('NFD'))
    for (const q of ['매출 보고', '매출 보고'.normalize('NFD')]) {
      const r = await search('alice', q, '&path=shared%2Ffs-nfd')
      expect(r.items).toEqual([{ path: 'shared/fs-nfd/note.md', name: 'note.md', line: 2, snippet: '분기 매출 보고 QA-NFD-8812' }])
    }
  })

  test('a query with a line break, a NUL or another control character is refused as invalid input, not sent to ripgrep', async () => {
    for (const q of ['zzz\nbeta', 'zzz\rbeta', 'ab\u0000cd', 'ab\u001bcd']) {
      const r = await raw('alice', q)
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error?: { code?: string } }).error?.code).toBe('validation')
    }
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
    // a new document is not searched before the background indexer has its text
    const first = await search('alice', 'qa-xlsx-mark-3141', '&path=shared')
    expect(first.items).toEqual([])
    expect(first.indexing).toBe(1)
    await h.ctx.files.office.idle()
    const r = await search('alice', 'qa-xlsx-mark-3141', '&path=shared')
    expect(r.indexing).toBe(0)
    expect(paths(r)).toEqual(['shared/fs-sheet.xlsx'])
    expect(r.items[0]!.snippet).toContain('QA-XLSX-MARK-3141')
    // the hidden copy in another group stays hidden through the cache too
    fs.copyFileSync(out, path.join(h.team, 'groups/finance/fs-sheet.xlsx'))
    await search('bob', 'QA-XLSX-MARK-3141')
    await h.ctx.files.office.idle()
    expect(paths(await search('alice', 'QA-XLSX-MARK-3141'))).toEqual(['shared/fs-sheet.xlsx'])
    expect(paths(await search('bob', 'QA-XLSX-MARK-3141'))).toContain('groups/finance/fs-sheet.xlsx')
  })

  test('the text of an older version of an office document is not found while the new version waits for extraction', async () => {
    const rel = 'shared/fs-sheet.xlsx'
    expect(paths(await search('alice', 'QA-XLSX-MARK-3141', '&path=shared'))).toEqual([rel])
    // the document changes (a redaction); its new text is not extracted yet (it waits in the background queue)
    const abs = path.join(h.team, rel)
    fs.utimesSync(abs, new Date(), new Date(Date.now() + 60_000))
    const office = h.ctx.files.office
    const real = office.refresh.bind(office)
    office.refresh = (async () => ({ pending: 1, timedOut: false })) as typeof office.refresh
    try {
      const r = await search('alice', 'QA-XLSX-MARK-3141', '&path=shared')
      expect(r.items).toEqual([])
      expect(r.indexing).toBe(1)
    } finally { office.refresh = real }
    // after the background extraction the (same) text is found again
    await search('alice', 'QA-XLSX-MARK-3141', '&path=shared')
    await office.idle()
    expect(paths(await search('alice', 'QA-XLSX-MARK-3141', '&path=shared'))).toEqual([rel])
  })

  test('office documents without fresh text are not searched, counted as indexing, and found after the background indexer', async () => {
    const src = path.join(h.team, 'shared/fs-sheet.xlsx')
    fs.mkdirSync(path.join(h.team, 'shared/fs-many-xlsx'), { recursive: true })
    for (let i = 0; i < 12; i++) fs.copyFileSync(src, path.join(h.team, `shared/fs-many-xlsx/s${i}.xlsx`))
    const r = await search('alice', 'QA-XLSX-MARK-3141', '&path=shared%2Ffs-many-xlsx')
    expect(r.indexing).toBe(12)
    expect(r.timedOut).toBe(false)
    await h.ctx.files.office.idle()
    const again = await search('alice', 'QA-XLSX-MARK-3141', '&path=shared%2Ffs-many-xlsx')
    expect(again.indexing).toBe(0)
    expect(paths(again).length).toBe(12)
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

  test('a very long line (a minified file) is skipped, not held in memory; other files still answer', async () => {
    write('shared/fs-minified/big.json', '{"a":"' + 'x'.repeat(3 * 1024 * 1024) + ' QA-MINI-6610"}')
    write('shared/fs-minified/small.md', 'small QA-MINI-6610\n')
    const r = await search('alice', 'QA-MINI-6610', '&path=shared%2Ffs-minified')
    expect(r.items.map((i) => i.path)).toEqual(['shared/fs-minified/small.md'])
    expect(r.longSkipped).toBe(1)
    expect(JSON.stringify(r).length).toBeLessThan(10_000)
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

  test('a new search while the person already runs the most searches stops the oldest one, not the new one', () => {
    const runs = Array.from({ length: CONTENT_SEARCH_PARALLEL_MAX }, () => admitContentSearch('erin'))
    const next = admitContentSearch('erin')
    expect(runs[0]!.signal.aborted).toBe(true)
    expect(runs.slice(1).every((r) => !r.signal.aborted)).toBe(true)
    expect(next.signal.aborted).toBe(false)
    for (const r of [...runs, next]) r.done()
  })

  test('a search stopped by a newer one answers rate_limited, never a list that looks complete', async () => {
    write('shared/fs-stopped/a.md', 'QA-STOPPED-4410\n')
    const office = h.ctx.files.office
    const real = office.refresh.bind(office)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let entered!: () => void
    const inRefresh = new Promise<void>((r) => { entered = r })
    office.refresh = (async () => { entered(); await gate; return { pending: 0, timedOut: false } }) as typeof office.refresh
    try {
      const first = raw('alice', 'QA-STOPPED-4410', '&path=shared%2Ffs-stopped')
      await inRefresh
      const newer = [admitContentSearch('alice'), admitContentSearch('alice')]
      release()
      const r = await first
      expect(r.status).toBe(429)
      for (const n of newer) n.done()
    } finally { office.refresh = real }
    expect(paths(await search('alice', 'QA-STOPPED-4410', '&path=shared%2Ffs-stopped'))).toEqual(['shared/fs-stopped/a.md'])
  })
})

describe('office extraction capacity', () => {
  test('a search over many stale office files answers fast and leaves the extraction slots to the AI grep', async () => {
    const office = h.ctx.files.office
    await office.idle()
    // a slow fake extraction: alice's files wait for a gate (as scanned PDFs that take minutes), bob's take 50 ms
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const fake = async (rel: string) => { if (rel.startsWith('users/alice/')) await gate; else await Bun.sleep(50); return 'text of ' + rel }
    const o = office as unknown as { extract: (rel: string, b: Buffer) => Promise<string> }
    const real = o.extract
    o.extract = fake
    const N = 30
    for (let i = 0; i < N; i++) write(`users/alice/fs-scans/s${String(i).padStart(2, '0')}.docx`, 'scan ' + i)
    write('users/bob/fs-ai/report.docx', 'report')
    try {
      for (let k = 0; k < 5; k++) {
        const t0 = Date.now()
        const r = await search('alice', 'QA-CAPACITY-' + k, '&path=users%2Falice%2Ffs-scans')
        expect(Date.now() - t0).toBeLessThan(1500)
        expect(r.timedOut).toBe(false)
        // no office file of the folder was searched: all of them wait for the background indexer
        expect(r.indexing).toBe(N)
      }
      // the AI grep of another person extracts its file in the foreground (FilesService.grep -> refresh, budget 40)
      const filter = (rel: string) => { try { return fs.lstatSync(path.join(h.team, rel)) } catch { return null } }
      const t0 = Date.now()
      const ai = await Promise.race([
        office.refresh(h.ctx.files.cfg.rg, ['users/bob/fs-ai'], [], filter, { budget: 40 }),
        Bun.sleep(3000).then(() => 'blocked' as const),
      ])
      expect(ai).not.toBe('blocked')
      expect(Date.now() - t0).toBeLessThan(1500)
      expect(office.fresh('users/bob/fs-ai/report.docx', filter('users/bob/fs-ai/report.docx')!)).toBe(true)
    } finally {
      release()
      await office.idle()
      o.extract = real
    }
  })

  test('one person adds at most a fixed number of files a minute to the background queue; the rest are still counted', async () => {
    const office = h.ctx.files.office
    await office.idle()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const o = office as unknown as { extract: (rel: string, b: Buffer) => Promise<string> }
    const real = o.extract
    o.extract = async (rel: string) => { await gate; return 'text of ' + rel }
    const N = OFFICE_QUEUE_PER_PERSON_MINUTE + 20
    for (let i = 0; i < N; i++) write(`users/carol/fs-flood/d${String(i).padStart(3, '0')}.docx`, 'doc ' + i)
    try {
      const r = await search('carol', 'QA-FLOOD', '&path=users%2Fcarol%2Ffs-flood')
      expect(r.indexing).toBe(N)
      // queued (or running) for carol: at most the per-person limit
      expect(office.queued()).toBeLessThanOrEqual(OFFICE_QUEUE_PER_PERSON_MINUTE)
      // the same files again add nothing (the queue holds each path and mtime once)
      const before = office.queued()
      await search('carol', 'QA-FLOOD-2', '&path=users%2Fcarol%2Ffs-flood')
      expect(office.queued()).toBe(before)
    } finally {
      release()
      await office.idle()
      o.extract = real
    }
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
