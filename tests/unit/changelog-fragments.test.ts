// Changelog fragments (scripts/changelog.ts, changes/README.md): a PR's notes live in changes/<topic>.md; before a
// release they are folded into CHANGELOG.md under "## Unreleased". Two PRs then never edit the same lines.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { foldInto, fragmentNotes, problems, readFragments, unreleasedNotes } from '../../scripts/changelog'

const LOG = `# Changelog

Intro line.

## Unreleased

- Older note A.
- Older note B.

## 0.5.0-beta.1 — 2026-11-09

- Released note.
`

describe('a fragment', () => {
  test('each "- " line is a note; a line after it goes on with that note; blank lines are left out', () => {
    expect(fragmentNotes('- One.\n\n- Two, first part\n  and second part.\n')).toEqual(['- One.', '- Two, first part and second part.'])
  })
  test('text without "- " becomes one note; CRLF reads the same', () => {
    expect(fragmentNotes('Plain text.\r\nMore.\r\n')).toEqual(['- Plain text. More.'])
    expect(fragmentNotes('\n  \n')).toEqual([])
  })
})

describe('fold', () => {
  test('the fragments go first under "## Unreleased"; older notes and released sections stay', () => {
    const out = foldInto(LOG, ['- New 1.', '- New 2.'])
    expect(unreleasedNotes(out)).toBe('- New 1.\n- New 2.\n- Older note A.\n- Older note B.')
    expect(out).toContain('\n## 0.5.0-beta.1 — 2026-11-09\n\n- Released note.\n')
    expect(out.startsWith('# Changelog\n\nIntro line.\n\n## Unreleased\n\n- New 1.\n')).toBe(true)
  })
  test('an empty Unreleased section keeps one blank line before the next section', () => {
    const empty = LOG.replace('- Older note A.\n- Older note B.\n\n', '')
    expect(foldInto(empty, ['- New.'])).toContain('## Unreleased\n\n- New.\n\n## 0.5.0-beta.1')
  })
  test('no "## Unreleased": it is made above the first section', () => {
    const none = LOG.replace('## Unreleased\n\n- Older note A.\n- Older note B.\n\n', '')
    const out = foldInto(none, ['- New.'])
    expect(out).toContain('Intro line.\n\n## Unreleased\n\n- New.\n\n## 0.5.0-beta.1')
  })
  test('no fragments: the file does not change', () => {
    expect(foldInto(LOG, [])).toBe(LOG)
  })
})

describe('the folder and the checks', () => {
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })
  test('Markdown files in name order; README.md and dot files are left out', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changes-'))
    fs.writeFileSync(path.join(dir, 'b-topic.md'), '- B.\n')
    fs.writeFileSync(path.join(dir, 'a-topic.md'), '- A.\n')
    fs.writeFileSync(path.join(dir, 'README.md'), '- not a note\n')
    fs.writeFileSync(path.join(dir, '.keep.md'), '- not a note\n')
    fs.writeFileSync(path.join(dir, 'notes.txt'), '- not a note\n')
    expect(readFragments(dir).map((f) => [path.basename(f.file), f.notes])).toEqual([['a-topic.md', ['- A.']], ['b-topic.md', ['- B.']]])
    expect(readFragments(path.join(dir, 'missing'))).toEqual([])
  })
  test('merge markers and empty fragments are problems', () => {
    const marked = LOG.replace('- Older note B.\n', '||||||| 878a597a\n- Older note B.\n')
    expect(problems(marked, [], () => '')).toHaveLength(1)
    expect(problems(LOG, [{ file: 'changes/x.md', notes: [] }], () => '')).toEqual(['changes/x.md has no note'])
    expect(problems(LOG, [{ file: 'changes/y.md', notes: ['- Y.'] }], () => '<<<<<<< HEAD\n- Y.')).toEqual(['changes/y.md holds a merge marker'])
    expect(problems(LOG, [{ file: 'changes/z.md', notes: ['- Z.'] }], () => '- Z.')).toEqual([])
  })
})

test('this repository: CHANGELOG.md and changes/ pass the check', () => {
  const root = path.resolve(import.meta.dir, '../..')
  const fragments = readFragments(path.join(root, 'changes'))
  expect(problems(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), fragments, (f) => fs.readFileSync(f.file, 'utf8'))).toEqual([])
})
