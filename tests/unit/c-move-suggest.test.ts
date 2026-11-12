// The Move picker's "추천" and "최근" (server/src/team-files/move-suggest.ts; docs/DECISIONS.md "Move picker: suggested
// and recent folders"). No AI call: names and file-list lines against the folders the caller can write. Fixture
// (tests/lib/fixtures.ts): shared/ everyone write; groups/finance bob only; projects/falcon alice write, finance read.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { fileListOf } from '../../server/src/file-list/service'
import { Units } from '../../server/src/file-list/units'
import { RuleSet } from '../../server/src/policy/access'
import { namePattern, same, score, THRESHOLD, words } from '../../server/src/team-files/move-suggest'

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
  test('a folder named like the file fits; a stranger does not', () => {
    const q = { name: '견적서_삼성.xlsx', words: ['견적서', '삼성'], ext: 'xlsx', dir: 'shared' }
    const total = new Map([['견적서', 4], ['삼성', 0]])
    expect(score(q, { path: 'shared/견적서', name: ['견적서'], files: [['견적서', 'lg'], ['견적서', '현대']], exts: ['xlsx', 'xlsx'] }, total)).toBeGreaterThan(0.85)
    expect(score(q, { path: 'shared/회의록', name: ['회의록'], files: [['주간회의록']], exts: ['docx'] }, total)).toBe(0)
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
})
