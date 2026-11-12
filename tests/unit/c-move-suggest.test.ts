// The Move picker's "추천" and "최근" (server/src/team-files/move-suggest.ts; docs/DECISIONS.md "Move picker: suggested
// and recent folders"). No AI call: names and file-list lines against the folders the caller can write. Fixture
// (tests/lib/fixtures.ts): shared/ everyone write; groups/finance bob only; projects/falcon alice write, finance read.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { fileListOf } from '../../server/src/file-list/service'
import { Units } from '../../server/src/file-list/units'
import { RuleSet } from '../../server/src/policy/access'
import { CANDIDATES_MAX, FILES_PER_FOLDER, FILES_SCORED, folderOf, namePattern, rank, same, THRESHOLD, words, WORDS_PER_FILE } from '../../server/src/team-files/move-suggest'

let A: CApp
const write = (rel: string, s = 'x') => { const p = path.join(A.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const suggest = async (as: string, paths: string[]) => A.json('/api/files/move-suggestions', { as: as as 'alice', ...jsonBody({ paths }) })
const folders = (b: { suggested: { path: string }[] }) => b.suggested.map((s) => s.path)

/** A file-list line for a file as the nightly run would keep it (the sidecar row with its unit's chain). */
const line = (rel: string, type: string, what: string) => {
  const st = fs.lstatSync(path.join(A.team, ...rel.split('/')))
  const units = new Units(RuleSet.load(A.ctx.db).ruleFolders())
  const segs = rel.split('/')
  fileListOf(A.ctx).store.put({ path: rel, size: st.size, mtimeMs: st.mtimeMs, sha: null, kind: null, real: null, fields: { type, names: [], date: '', what, lang: 'en' },
    via: 'model', readAt: new Date().toISOString(), tries: 0, chain: units.chain(units.listFolderOf(segs).split('/').filter(Boolean)), ino: `${st.dev}:${st.ino}`, batch: null })
}

beforeAll(async () => {
  A = await makeCApp('c-move-suggest')
  for (const n of ['견적서_LG_2024.xlsx', '견적서_현대_2024.xlsx', '견적서_SK_2025.xlsx', '견적서_한화_2025.xlsx']) write(`shared/견적서/${n}`)
  for (const n of ['주간회의록_0301.docx', '주간회의록_0308.docx', '월간회의록_03.docx']) write(`shared/회의록/${n}`)
  write('shared/견적서_삼성전자_2025.xlsx')
  write('shared/qzx_0001.bin')
})
afterAll(async () => { await A.close() })

describe('words and scores', () => {
  test('letters only, by script, no dates or filler words', () => {
    expect(words('견적서_삼성전자_2025-03_최종.xlsx')).toEqual(['견적서', '삼성전자', 'xlsx'])
    expect(words('WeeklyReport final v2')).toEqual(['weekly', 'report'])
  })
  test('the same word: a Korean word inside another, an English plural', () => {
    expect(same('주간회의록', '회의록')).toBe(true)
    expect(same('invoice', 'invoices')).toBe(true)
    expect(same('견적서', '회의록')).toBe(false)
    expect(same('to', 'today')).toBe(false)
  })
  const F = (p: string, names: string[], ext = 'xlsx') => folderOf(p, words(p.slice(p.lastIndexOf('/') + 1)), names.map((n) => ({ words: words(n), ext })))
  const q = (name: string) => ({ name, words: words(name.replace(/\.[^.]+$/, '')), ext: name.slice(name.lastIndexOf('.') + 1) })
  test('a folder named like the file fits; a stranger does not', () => {
    const r = rank([q('견적서_삼성.xlsx')], [F('shared/견적서', ['견적서_LG', '견적서_현대']), F('shared/회의록', ['주간회의록'], 'docx')])
    expect(r.map((x) => x.path)).toEqual(['shared/견적서'])
    expect(r[0]!.confidence).toBeGreaterThan(0.85)
  })
  test('a two-letter name alone does not take a longer word ("인사" for "인사말"); with a file that agrees it does', () => {
    expect(rank([q('인사말.docx')], [F('shared/인사', ['급여_2025', '근로계약서'], 'docx')])).toEqual([])
    expect(rank([q('인사.docx')], [F('shared/인사', ['급여_2025'], 'docx')]).map((x) => x.path)).toEqual(['shared/인사'])
    expect(rank([q('인사말.docx')], [F('shared/인사', ['인사말_2024', '인사말_2023'], 'docx')]).map((x) => x.path)).toEqual(['shared/인사'])
  })
  test('the extension alone never makes a suggestion', () => {
    // a weak word match (one file of ten) in a folder of the same extension stays under the threshold
    const files = ['보고서_a', ...Array.from({ length: 9 }, (_, i) => `x${'abcdefghi'[i]}y`)]
    expect(rank([q('보고서_삼성.xlsx')], [F('shared/qq', files)])).toEqual([])
  })
  test('Japanese and Chinese words inside others count too', () => {
    expect(same('見積', '見積書')).toBe(true)
    expect(rank([q('見積書_山田.xlsx')], [F('shared/見積', ['見積書_A', '見積書_B'])]).map((x) => x.path)).toEqual(['shared/見積'])
  })
  test('at the caps: the scoring finishes well under 150 ms', () => {
    const syl = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초'
    const word = (i: number) => syl[i % syl.length]! + syl[(i * 7) % syl.length]! + syl[(i * 13) % syl.length]!
    const folders = Array.from({ length: CANDIDATES_MAX }, (_, f) => F(`shared/${word(f)}${word(f + 3)}`,
      Array.from({ length: FILES_PER_FOLDER }, (_, i) => Array.from({ length: 8 }, (_, k) => word(f * 31 + i * 7 + k)).join('_'))))
    const queries = Array.from({ length: FILES_SCORED }, (_, i) => ({ name: `${i}.xlsx`, words: Array.from({ length: WORDS_PER_FILE }, (_, k) => word(i * 11 + k) + word(k)), ext: 'xlsx' }))
    const t0 = performance.now()
    rank(queries, folders)
    expect(performance.now() - t0).toBeLessThan(150)
  })
  test('a ✕ never promotes a weak folder: the bar is still the best one\'s, and the ✕\'d folder\'s files still count (QA 2026-11-13)', () => {
    const quotes = F('shared/견적서', ['견적서_LG', '견적서_현대', '견적서_SK'])
    // a forms folder holding the quote form: over THRESHOLD when it is the only folder with 견적서 files, under it when
    // the quotes folder's files make the word common (taking that folder out of the scoring promoted it)
    const forms = F('shared/양식', ['견적서_양식'])
    const both = rank([q('견적서_삼성.xlsx')], [quotes, forms])
    expect(both.map((x) => x.path)).toEqual(['shared/견적서'])
    expect(rank([q('견적서_삼성.xlsx')], [forms]).map((x) => x.path)).toEqual(['shared/양식'])
    // ✕ on the quotes folder: nothing rather than the weak one
    expect(rank([q('견적서_삼성.xlsx')], [quotes, forms], (p) => p === 'shared/견적서')).toEqual([])
    // a folder as strong as the best stays
    const quotes2 = F('shared/견적', ['견적서_A', '견적서_B', '견적서_C'])
    expect(rank([q('견적서_삼성.xlsx')], [quotes, quotes2, forms], (p) => p === 'shared/견적서').map((x) => x.path)).toEqual(['shared/견적'])
  })
  test('the ✕ pattern drops digits', () => { expect(namePattern('견적서_SK_2025.xlsx')).toBe('견적서_sk_#.xlsx') })
})

describe('the endpoint', () => {
  test('a loose quote: the quotes folder first, with a confidence over the threshold; not its own folder', async () => {
    const r = await suggest('alice', ['shared/견적서_삼성전자_2025.xlsx'])
    expect(r.status).toBe(200)
    expect(r.body.suggested[0]).toMatchObject({ path: 'shared/견적서' })
    expect(r.body.suggested[0].confidence).toBeGreaterThanOrEqual(THRESHOLD)
    expect(folders(r.body)).not.toContain('shared/회의록')
    expect(folders(r.body)).not.toContain('shared')
    expect(r.body.suggested.length).toBeLessThanOrEqual(3)
  })

  test('no suggestion rather than a weak guess (a name that says nothing)', async () => {
    const r = await suggest('alice', ['shared/qzx_0001.bin'])
    expect(r.body.suggested).toEqual([])
  })

  test('a file the caller cannot read: not found, nothing said', async () => {
    const r = await suggest('alice', ['groups/finance/budget.md'])
    expect(r.status).toBe(404)
  })

  test('only folders the caller can write; nothing from files they cannot read', async () => {
    // quotes the finance group keeps (alice cannot read them), and in falcon (bob reads, cannot write)
    for (const n of ['견적서_A_2024.xlsx', '견적서_B_2024.xlsx', '견적서_C_2024.xlsx']) { write(`groups/finance/견적서/${n}`); write(`projects/falcon/견적/${n}`) }
    // a folder alice can write whose only quotes are in a subfolder closed to her
    const r0 = await A.json('/api/admin/folders', { as: 'dana', ...jsonBody({ path: 'shared/영업/비공개', rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'user', subjectId: 'bob', access: 'write' }] }) })
    expect(r0.status).toBe(201)
    for (const n of ['견적서_D_2024.xlsx', '견적서_E_2024.xlsx', '견적서_F_2024.xlsx']) write(`shared/영업/비공개/${n}`)
    write('shared/영업/안내.txt')
    const alice = folders((await suggest('alice', ['shared/견적서_삼성전자_2025.xlsx'])).body)
    expect(alice).not.toContain('groups/finance/견적서')
    expect(alice).not.toContain('shared/영업')
    expect(alice).not.toContain('shared/영업/비공개')
    expect(alice).toContain('shared/견적서')
    const bob = folders((await suggest('bob', ['shared/견적서_삼성전자_2025.xlsx'])).body)
    expect(bob).not.toContain('projects/falcon/견적') // read only for finance
    expect(bob.some((p) => p === 'groups/finance/견적서' || p === 'shared/견적서')).toBe(true)
    // erin (marketing) writes nothing in falcon or finance: neither shows
    const erin = folders((await suggest('erin', ['shared/견적서_삼성전자_2025.xlsx'])).body)
    expect(erin.every((p) => !p.startsWith('groups/finance') && !p.startsWith('projects/'))).toBe(true)
  })

  test('the file list: a scan named like nothing goes where files of its kind are, by their lines', async () => {
    write('shared/scan_0012.pdf', 'scan')
    for (const n of ['a.pdf', 'b.pdf', 'c.pdf']) write(`shared/contracts-en/${n}`, n)
    // no lines yet: names only, nothing to go on
    expect((await suggest('alice', ['shared/scan_0012.pdf'])).body.suggested).toEqual([])
    line('shared/scan_0012.pdf', 'service contract', 'signed service contract with a supplier')
    for (const n of ['a.pdf', 'b.pdf', 'c.pdf']) line(`shared/contracts-en/${n}`, 'service contract', 'service contract for maintenance')
    expect(folders((await suggest('alice', ['shared/scan_0012.pdf'])).body)[0]).toBe('shared/contracts-en')
    // a line of a file alice cannot read never counts: the same lines in finance do not make it a suggestion for her
    for (const n of ['x.pdf', 'y.pdf']) { write(`groups/finance/contracts/${n}`, n); line(`groups/finance/contracts/${n}`, 'service contract', 'service contract') }
    expect(folders((await suggest('alice', ['shared/scan_0012.pdf'])).body)).not.toContain('groups/finance/contracts')
    // a file changed since its line was read: its line no longer counts
    fs.appendFileSync(path.join(A.team, 'shared', 'scan_0012.pdf'), 'more')
    expect((await suggest('alice', ['shared/scan_0012.pdf'])).body.suggested).toEqual([])
  })

  test('several files: folders that fit them all', async () => {
    write('shared/견적서_두산_2025.xlsx')
    const r = await suggest('alice', ['shared/견적서_삼성전자_2025.xlsx', 'shared/견적서_두산_2025.xlsx'])
    expect(folders(r.body)[0]).toBe('shared/견적서')
  })

  test('✕: that folder is not suggested again for files named like it, for that person only', async () => {
    const d = await A.json('/api/files/move-suggestions/dismiss', { as: 'alice', ...jsonBody({ paths: ['shared/견적서_삼성전자_2025.xlsx'], folder: 'shared/견적서' }) })
    expect(d.status).toBe(204)
    expect(folders((await suggest('alice', ['shared/견적서_삼성전자_2025.xlsx'])).body)).not.toContain('shared/견적서')
    write('shared/견적서_삼성전자_2026.xlsx') // the same pattern: digits apart
    expect(folders((await suggest('alice', ['shared/견적서_삼성전자_2026.xlsx'])).body)).not.toContain('shared/견적서')
    // another name still gets it; another person too
    expect(folders((await suggest('alice', ['shared/견적서_두산_2025.xlsx'])).body)).toContain('shared/견적서')
    expect(folders((await suggest('erin', ['shared/견적서_삼성전자_2025.xlsx'])).body)).toContain('shared/견적서')
    // nor is it under 최근 for those files, even when she just saved into it; for another name it is (QA 2026-11-13)
    write('shared/note-q.txt')
    expect((await A.json('/api/files/move', { as: 'alice', ...jsonBody({ from: 'shared/note-q.txt', to: 'shared/견적서/note-q.txt' }) })).status).toBe(200)
    const after = (await suggest('alice', ['shared/견적서_삼성전자_2025.xlsx'])).body
    expect([...folders(after), ...after.recent.map((x: { path: string }) => x.path)]).not.toContain('shared/견적서')
    write('shared/memo-z.txt')
    expect((await suggest('alice', ['shared/memo-z.txt'])).body.recent.map((x: { path: string }) => x.path)).toContain('shared/견적서')
    // a file the caller cannot read cannot be dismissed (nor named)
    expect((await A.json('/api/files/move-suggestions/dismiss', { as: 'alice', ...jsonBody({ paths: ['groups/finance/budget.md'], folder: 'shared' }) })).status).toBe(404)
  })

  test('최근: folders the caller moved or uploaded into and can still write, newest first; not where the file is', async () => {
    write('shared/note-a.txt')
    write('shared/note-b.txt')
    expect((await A.json('/api/files/move', { as: 'alice', ...jsonBody({ from: 'shared/note-a.txt', to: 'shared/회의록/note-a.txt' }) })).status).toBe(200)
    const r = await suggest('alice', ['shared/note-b.txt'])
    expect(r.body.recent[0]).toEqual({ path: 'shared/회의록' })
    // erin did not move it: not hers
    expect((await suggest('erin', ['shared/note-b.txt'])).body.recent.map((x: { path: string }) => x.path)).not.toContain('shared/회의록')
    // asked from inside that folder: not offered as a place to go
    expect((await suggest('alice', ['shared/회의록/note-a.txt'])).body.recent.map((x: { path: string }) => x.path)).not.toContain('shared/회의록')
    // a folder she can no longer write drops off
    expect((await A.json('/api/admin/folders', { as: 'dana', ...jsonBody({ path: 'shared/회의록', rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }] }) })).status).toBe(201)
    expect((await suggest('alice', ['shared/note-b.txt'])).body.recent.map((x: { path: string }) => x.path)).not.toContain('shared/회의록')
  })

  test('moving a folder: never into itself or a folder inside it (suggested or recent)', async () => {
    write('shared/견적서/보관/old.txt')
    // alice moved a file into shared/견적서/보관 before
    write('shared/x-old.txt')
    expect((await A.json('/api/files/move', { as: 'alice', ...jsonBody({ from: 'shared/x-old.txt', to: 'shared/견적서/보관/x-old.txt' }) })).status).toBe(200)
    const r = await suggest('alice', ['shared/견적서'])
    const all = [...folders(r.body), ...r.body.recent.map((x: { path: string }) => x.path)]
    expect(all.some((p) => p === 'shared/견적서' || p.startsWith('shared/견적서/'))).toBe(false)
    // with a file of the same selection, the same
    const r2 = await suggest('alice', ['shared/견적서', 'shared/견적서_두산_2025.xlsx'])
    expect([...folders(r2.body), ...r2.body.recent.map((x: { path: string }) => x.path)].some((p) => p === 'shared/견적서' || p.startsWith('shared/견적서/'))).toBe(false)
  })

  test('recent never names a folder with a hidden part on its way (a server temp folder above it)', async () => {
    const hidden = `${PRODUCT.tmpPrefix}work`
    write(`shared/${hidden}/inner/a.txt`)
    A.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action) VALUES (NULL, 'alice', ?, 'create')").run(`shared/${hidden}/inner/b.txt`)
    const r = await suggest('alice', ['shared/note-b.txt'])
    expect(r.body.recent.map((x: { path: string }) => x.path).some((p: string) => p.includes(hidden))).toBe(false)
  })

  test('✕ only for a folder the caller can write', async () => {
    const no = await A.json('/api/files/move-suggestions/dismiss', { as: 'alice', ...jsonBody({ paths: ['shared/견적서_두산_2025.xlsx'], folder: 'groups/finance' }) })
    expect(no.status).toBe(404)
    const gone = await A.json('/api/files/move-suggestions/dismiss', { as: 'alice', ...jsonBody({ paths: ['shared/견적서_두산_2025.xlsx'], folder: 'shared/nowhere' }) })
    expect(gone.status).toBe(404)
  })

  test('a person asking too often gets 429 for a while', async () => {
    let last = 200
    for (let i = 0; i < 40 && last !== 429; i++) last = (await suggest('carol', ['shared/qzx_0001.bin'])).status
    expect(last).toBe(429)
  })
})
