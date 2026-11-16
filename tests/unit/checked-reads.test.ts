// A file read uses the file that its permission check saw (server/src/files/store.ts readRegular, team-files/place.ts
// openChecked), as downloads do (download-checked-descriptor.test.ts). A personal folder is written by its person's dev
// environment runs too, at any time, so between the check and the open a name can come to mean something else. The
// rule these tests keep: a link placed under a personal folder is never followed (not in the last name, not in a
// folder on the way), and what is read comes from the one descriptor that was checked.
//
// The change is made at the moment the file is opened (fs.openSync of that path), so the test does not depend on
// timing: on code that opens the checked path again by name, the open goes wherever the name leads now.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, sha256hex as sha256, type CApp } from '../lib/c-app'
import { readRegular, sha256Regular } from '../../server/src/files/store'
import { authorize, visiblePath } from '../../server/src/policy/authorize'
import { SearchAdmission } from '../../server/src/files/search-admission'
import * as XLSX from 'xlsx'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'

const CHECKED = 'the file that was checked\n'.repeat(40)
const OTHER = 'a file that was never checked\n'.repeat(40)
const SAVED = 'saved a moment ago\n'.repeat(40)

let a: CApp
/** a folder outside the team folder, with a file named like the one in the personal folder */
let elsewhere: string
let n = 0

const mine = (rel: string) => path.join(a.team, 'users/alice', rel)
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
/** a fresh folder in the personal folder with report.txt in it; returns the folder's name */
function folder(): string {
  const name = `case-${++n}`
  fs.mkdirSync(mine(name), { recursive: true })
  fs.writeFileSync(mine(`${name}/report.txt`), CHECKED)
  return name
}

/** the folder on the way now is a link to the other folder; the checked file lives on under another name */
function folderBecomesLink(dir: string) {
  fs.renameSync(mine(dir), mine(`${dir}-kept`))
  fs.symlinkSync(elsewhere, mine(dir))
}
/** a normal save: the new content goes in under a temporary name and is renamed over the file */
function savedMeanwhile(dir: string) {
  fs.writeFileSync(mine(`${dir}/.saving`), SAVED)
  fs.renameSync(mine(`${dir}/.saving`), mine(`${dir}/report.txt`))
}

function docx(md: string, out: string) {
  const p = Bun.spawnSync(['pandoc', '-f', 'markdown', '-o', out], { stdin: new TextEncoder().encode(md) })
  if (p.exitCode !== 0) throw new Error('pandoc failed: ' + p.stderr.toString())
}

const realOpen = fs.openSync
/** run `change` once, right before the first open of a path that ends with `/<dir>/<name>` */
function atOpen(dir: string, change: (dir: string) => void, name = 'report.txt') {
  let done = false
  fs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (!done && String(p).endsWith(`/${dir}/${name}`)) { done = true; change(dir) }
    return (realOpen as (...x: unknown[]) => number)(p, ...rest)
  }) as typeof fs.openSync
}
afterEach(() => { fs.openSync = realOpen })

const readTool = (rel: string, args: Record<string, unknown> = {}) => a.ctx.files.call('read', { file_path: `users/alice/${rel}`, ...args }, a.toolCtx('alice'))
const panel = (rel: string, o: Record<string, string> = {}) => a.json('/api/files/content' + q({ path: `users/alice/${rel}`, ...o }), { as: 'alice' })
const check = (rel: string) => authorize(a.ctx.files.fx, a.ctx.files.rules(), a.ctx.files.principal('alice'), `users/alice/${rel}`, 'read')

beforeAll(async () => {
  a = await makeCApp('checked-reads')
  elsewhere = path.join(a.data, 'elsewhere')
  fs.mkdirSync(elsewhere, { recursive: true })
  fs.writeFileSync(path.join(elsewhere, 'report.txt'), OTHER)
  fs.mkdirSync(mine(''), { recursive: true })
  docx('# Report\n\nthe document that was checked\n', path.join(elsewhere, 'placeholder.docx'))
  docx('# Report\n\na document that was never checked\n', path.join(elsewhere, 'report.docx'))
}, 120_000)
afterAll(async () => { await a?.close() }, 120_000)

describe('normal reads are as before', () => {
  test('the read tool: numbered lines, offset and limit, Korean in UTF-8 and in CP949', async () => {
    const dir = folder()
    const whole = await readTool(`${dir}/report.txt`)
    expect(whole.isError).toBeFalsy()
    expect(whole.text).toContain('the file that was checked')
    expect(whole.text).not.toContain('never checked')
    const part = await readTool(`${dir}/report.txt`, { offset: 3, limit: 2 })
    expect(part.isError).toBeFalsy()
    expect(part.text.match(/the file that was checked/g)).toHaveLength(2)
    fs.writeFileSync(mine(`${dir}/memo.txt`), '분기 보고서\n')
    expect((await readTool(`${dir}/memo.txt`)).text).toContain('분기 보고서')
    fs.writeFileSync(mine(`${dir}/legacy.txt`), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a])) // 한글 in CP949
    expect((await readTool(`${dir}/legacy.txt`)).text).toContain('한글')
  })

  test('the file screen: size, hash, text, a cut at the limit, a binary file, a name in decomposed letters', async () => {
    const dir = folder()
    const r = await panel(`${dir}/report.txt`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ size: CHECKED.length, sha256: sha256(Buffer.from(CHECKED)), content: CHECKED, binary: false, truncated: false })
    expect(r.res.headers.get('x-content-sha256')).toBe(r.body.sha256)
    fs.writeFileSync(mine(`${dir}/long.md`), '가'.repeat(100))
    const cut = await panel(`${dir}/long.md`, { maxBytes: '10' })
    expect(cut.body).toMatchObject({ truncated: true, content: '가'.repeat(3), size: 300 })
    fs.writeFileSync(mine(`${dir}/blob.txt`), Buffer.from([1, 2, 0, 3]))
    expect((await panel(`${dir}/blob.txt`)).body).toMatchObject({ binary: true, content: null })
    const stored = '분기 보고서.txt'.normalize('NFD')
    fs.writeFileSync(mine(`${dir}/${stored}`), CHECKED)
    for (const asked of [stored, stored.normalize('NFC')]) {
      const s = await panel(`${dir}/${asked}`)
      expect(s.status).toBe(200)
      expect(s.body.content).toBe(CHECKED)
    }
  })

  test('readRegular and sha256Regular with the check: the same bytes, size and hash as without it', () => {
    const dir = folder()
    const r = check(`${dir}/report.txt`)
    const bound = readRegular(r.abs, undefined, r.st)
    const plain = readRegular(r.abs)
    expect(bound.bytes.toString()).toBe(CHECKED)
    expect(bound.bytes.equals(plain.bytes)).toBe(true)
    expect(bound.st.size).toBe(plain.st.size)
    expect(sha256Regular(r.abs, r.st)).toBe(sha256Regular(r.abs))
    expect(() => readRegular(r.abs, 10, r.st)).toThrow('file is too large')
  })

  test('what the check saw answers as before: a folder, a link as the last name, a folder on the way that is a link', async () => {
    const dir = folder()
    expect((await readTool(dir)).text).toContain('is a folder')
    fs.symlinkSync(path.join(elsewhere, 'report.txt'), mine(`${dir}/link.txt`))
    fs.symlinkSync(elsewhere, mine(`${dir}/sub`))
    for (const p of [`${dir}/link.txt`, `${dir}/sub/report.txt`]) {
      const r = await readTool(p)
      expect(r.isError).toBe(true)
      expect(r.text).not.toContain('never checked')
      const s = await panel(p)
      expect(s.status).not.toBe(200)
      expect(JSON.stringify(s.body)).not.toContain('never checked')
    }
  })
})

describe('a folder on the way becomes a link between the check and the open', () => {
  test('the read tool: refused, never the other file', async () => {
    const dir = folder()
    atOpen(dir, folderBecomesLink)
    const r = await readTool(`${dir}/report.txt`)
    expect(r.text).not.toContain('never checked')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('path changed while opening')
  })

  test('the file screen: refused, never the other file', async () => {
    const dir = folder()
    atOpen(dir, folderBecomesLink)
    const r = await panel(`${dir}/report.txt`)
    expect(JSON.stringify(r.body)).not.toContain('never checked')
    expect(r.status).not.toBe(200)
  })

  test('readRegular and sha256Regular with the check: refused', () => {
    for (const read of [(abs: string, st: fs.Stats) => readRegular(abs, undefined, st).bytes.toString(), (abs: string, st: fs.Stats) => sha256Regular(abs, st)]) {
      const dir = folder()
      const r = check(`${dir}/report.txt`)
      folderBecomesLink(dir)
      expect(() => read(r.abs, r.st!)).toThrow('path changed while opening')
    }
  })

  test('a deleted file keeps the checked file in the trash, or nothing at all', () => {
    const dir = folder()
    atOpen(dir, folderBecomesLink)
    expect(() => a.ctx.files.deleteFile('alice', `users/alice/${dir}/report.txt`)).toThrow()
    expect(fs.readFileSync(path.join(elsewhere, 'report.txt'), 'utf8')).toBe(OTHER)
    const kept = a.ctx.db.query('SELECT storage_path FROM trash_items WHERE original_path = ?').all(`users/alice/${dir}/report.txt`) as { storage_path: string }[]
    for (const t of kept) expect(fs.readFileSync(path.join(a.ctx.files.fx.root, ...t.storage_path.split('/')), 'utf8')).not.toContain('never checked')
  })
})

describe('after the check, one answer for every change', () => {
  test('gone, another file, a folder now, a folder on the way that became a link: the same refusal', () => {
    const answers = new Set<string>()
    const cases: Record<string, (dir: string) => void> = {
      gone: (dir) => fs.rmSync(mine(`${dir}/report.txt`)),
      'another file': savedMeanwhile,
      'a folder now': (dir) => { fs.rmSync(mine(`${dir}/report.txt`)); fs.mkdirSync(mine(`${dir}/report.txt`)) },
      'a link now': (dir) => { fs.rmSync(mine(`${dir}/report.txt`)); fs.symlinkSync(path.join(elsewhere, 'report.txt'), mine(`${dir}/report.txt`)) },
      'a folder on the way became a link': folderBecomesLink,
    }
    for (const change of Object.values(cases)) {
      const dir = folder()
      const r = check(`${dir}/report.txt`)
      change(dir)
      let err: unknown
      try { readRegular(r.abs, undefined, r.st) } catch (e) { err = e }
      expect(err).toBeInstanceOf(Error)
      answers.add(`${(err as Error).constructor.name}: ${(err as Error).message}`)
    }
    expect([...answers]).toHaveLength(1)
  })
})

describe('a normal save between the check and the open', () => {
  test('the read tool: refused once, the next read has the saved text', async () => {
    const dir = folder()
    atOpen(dir, savedMeanwhile)
    const first = await readTool(`${dir}/report.txt`)
    expect(first.isError).toBe(true)
    expect(first.text).toContain('path changed while opening')
    const again = await readTool(`${dir}/report.txt`)
    expect(again.isError).toBeFalsy()
    expect(again.text).toContain('saved a moment ago')
  })

  test('the file screen: refused once, the next load has the saved text', async () => {
    const dir = folder()
    atOpen(dir, savedMeanwhile)
    expect((await panel(`${dir}/report.txt`)).status).not.toBe(200)
    const again = await panel(`${dir}/report.txt`)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ content: SAVED, sha256: sha256(Buffer.from(SAVED)), size: SAVED.length })
  })
})

describe('the search index reads the file that was checked', () => {
  const visible = (rel: string) => () => visiblePath(a.ctx.files.fx, a.ctx.files.rules(), a.ctx.files.principal('alice'), `users/alice/${rel}`)

  test('its reader: the checked file as before; a folder on the way that became a link: nothing', () => {
    const dir = folder()
    const r = check(`${dir}/report.txt`)
    const plain = new SearchAdmission().read(r.abs, visible(`${dir}/report.txt`))
    expect(plain?.bytes.toString()).toBe(CHECKED)
    // the change comes after the file was found and before its reader looks at it again
    folderBecomesLink(dir)
    const swapped = new SearchAdmission().read(r.abs, visible(`${dir}/report.txt`))
    expect(swapped?.bytes.toString() ?? '').not.toContain('never checked')
    expect(swapped).toBeNull()
  })

  test('office text for search: the checked document, never the other one', async () => {
    const office = a.ctx.files.office
    const ok = folder()
    fs.copyFileSync(path.join(elsewhere, 'placeholder.docx'), mine(`${ok}/report.docx`))
    await office.update(`users/alice/${ok}/report.docx`)
    expect(fs.readFileSync(office.cachePath(`users/alice/${ok}/report.docx`), 'utf8')).toContain('the document that was checked')

    const dir = folder()
    fs.copyFileSync(path.join(elsewhere, 'placeholder.docx'), mine(`${dir}/report.docx`))
    atOpen(dir, folderBecomesLink, 'report.docx')
    await office.update(`users/alice/${dir}/report.docx`).catch(() => {})
    const cached = (() => { try { return fs.readFileSync(office.cachePath(`users/alice/${dir}/report.docx`), 'utf8') } catch { return '' } })()
    expect(cached).not.toContain('never checked')
  })
})

describe('a form made into a skill draft: its text is of the checked file', () => {
  let h: Harness
  /** a folder outside the team folder with a form named like the team's */
  let away: string
  beforeAll(async () => {
    h = await startHarness({ name: 'checked-reads-form' })
    away = path.join(h.dataDir, 'away-forms')
    fs.mkdirSync(away, { recursive: true })
  }, 120_000)
  afterAll(async () => { await h?.close() }, 120_000)

  const sheet = (out: string, text: string) => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['견적서'], [text]]), '견적서')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  }
  const formText = async (rel: string) => {
    const { draftChatId } = await h.api('carol').call(API.startFormSkillDraft, { body: { path: rel } })
    const row = h.ctx.db.query('SELECT material FROM onboarding_skill_drafts WHERE chat_id = ?').get(draftChatId) as { material: string }
    return (JSON.parse(row.material) as { text: string }).text
  }

  test('the form as it is; the forms folder becomes a link before the open: never the other file', async () => {
    const forms = path.join(h.team, 'shared/양식')
    sheet(path.join(forms, '견적서_양식.xlsx'), 'the form that was checked')
    expect(await formText('shared/양식/견적서_양식.xlsx')).toContain('the form that was checked')

    sheet(path.join(forms, '주문서_양식.xlsx'), 'the form that was checked')
    sheet(path.join(away, '주문서_양식.xlsx'), 'a form that was never checked')
    atOpen('양식', () => { fs.renameSync(forms, forms + '-kept'); fs.symlinkSync(away, forms) }, '주문서_양식.xlsx')
    expect(await formText('shared/양식/주문서_양식.xlsx')).not.toContain('never checked')
  })
})
