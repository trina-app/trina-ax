// The document skills (docs/decisions/20261124-doc-skills.md): what ships is what SOURCE.json lists, with its licence
// and no schema; a run gets them read-only; the prompt uses them only where a run can, and stays honest without a viewer.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFileRule } from '../../server/src/chat/prompt'
import { docSkillsReady, writeDocSkills } from '../../server/src/devenv/doc-skills'
import { docSkillBundleFiles } from '../../scripts/build-bundle'

const REPO = path.resolve(import.meta.dir, '../..')
const DIR = path.join(REPO, 'resources/doc-skills')
const source = JSON.parse(fs.readFileSync(path.join(DIR, 'SOURCE.json'), 'utf8')) as { commit: string; licence: string; files: Record<string, string>; changed: string[] }
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])

describe('what ships', () => {
  test('exactly the listed files, by sha256, at one commit', () => {
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/)
    const shipped = walk(DIR).map((f) => path.relative(DIR, f)).filter((f) => f !== 'SOURCE.json' && f !== 'README.md').sort()
    expect(shipped).toEqual(Object.keys(source.files).sort())
    for (const [f, want] of Object.entries(source.files)) expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, f))).digest('hex')).toBe(want)
  })
  test('every skill keeps its Apache-2.0 licence, no XSD ships, and a changed file says so', () => {
    expect(source.licence).toBe('Apache-2.0')
    for (const s of ['docx', 'pptx', 'xlsx', 'pdf']) expect(fs.readFileSync(path.join(DIR, s, 'LICENSE.txt'), 'utf8')).toContain('Apache License')
    expect(Object.keys(source.files).filter((f) => f.endsWith('.xsd') || f.includes('/schemas/'))).toEqual([])
    expect(source.changed.length).toBe(3)
    for (const f of source.changed) expect(fs.readFileSync(path.join(DIR, f), 'utf8').startsWith('# Changed by Trina AX')).toBe(true)
    expect(fs.readFileSync(path.join(REPO, 'NOTICE'), 'utf8')).toContain('resources/doc-skills/')
  })
  test('the Linux bundle carries them', () => {
    expect(docSkillBundleFiles()).toContain('resources/doc-skills/docx/SKILL.md')
    expect(docSkillBundleFiles()).toContain('resources/doc-skills/docx/LICENSE.txt')
  })
})

describe('in a run', () => {
  test('a version folder and a link; a second call changes nothing; a changed file is refused', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-skills-'))
    try {
      expect(writeDocSkills(bin, DIR)).toBe(true)
      const target = fs.readlinkSync(path.join(bin, 'doc-skills'))
      expect(fs.existsSync(path.join(bin, 'doc-skills/pptx/SKILL.md'))).toBe(true)
      expect(fs.statSync(path.join(bin, 'doc-skills/pptx/SKILL.md')).mode & 0o777).toBe(0o644)
      expect(writeDocSkills(bin, DIR)).toBe(true)
      expect(fs.readlinkSync(path.join(bin, 'doc-skills'))).toBe(target)
      const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-skills-bad-'))
      fs.cpSync(DIR, bad, { recursive: true })
      fs.appendFileSync(path.join(bad, 'docx/SKILL.md'), 'x')
      fs.appendFileSync(path.join(bad, 'SOURCE.json'), ' ')
      expect(() => writeDocSkills(bin, bad)).toThrow(/not the file/)
      fs.rmSync(bad, { recursive: true, force: true })
    } finally { fs.rmSync(bin, { recursive: true, force: true }) }
  })
  test('only Linux with the run\'s Python libraries', () => {
    expect(docSkillsReady('darwin', os.tmpdir())).toBe(false)
    expect(docSkillsReady('linux', path.join(os.tmpdir(), 'no-such-python'))).toBe(false)
    expect(docSkillsReady('linux', os.tmpdir())).toBe(true)
  })
})

describe('the prompt', () => {
  test('with the skills: no Markdown for Office, Hangul stays, no claim without a look', () => {
    const r = makeFileRule(true, true, true)
    expect(r).toContain('$TRINA_DOC_SKILLS/docx/SKILL.md')
    expect(r).not.toContain('Word / PowerPoint / Excel / PDF / Hangul (.hwpx) files, write Markdown')
    expect(r).toContain('A Hangul (.hwpx) file: write Markdown')
    expect(r).toContain('Never say you checked how a file looks unless you saw it')
    expect(r).toContain('save_work_file')
    expect(r).toContain('read the saved file with as_images')
  })
  test('without them the rule is what it was', () => {
    expect(makeFileRule(false, true)).toContain('write Markdown or CSV and convert it with make_file')
    expect(makeFileRule(false, true)).not.toContain('TRINA_DOC_SKILLS')
  })
})
