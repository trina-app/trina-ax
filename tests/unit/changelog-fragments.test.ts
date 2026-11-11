// Changelog fragments (scripts/changelog.ts, changes/README.md): a PR's notes live in changes/<topic>.md; before a
// release they are folded into CHANGELOG.md under "## Unreleased". Two PRs then never edit the same lines.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { baseChangelog, foldInto, fragmentNotes, newLinesMessage, newUnreleasedLines, problems, readFragments, unreleasedNotes } from '../../scripts/changelog'

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

describe('new lines under "## Unreleased" (compared with the PR\'s base)', () => {
  const added = LOG.replace('- Older note A.\n', '- My new note.\n- Older note A.\n')
  test('a PR that adds a note there fails, and the message says to use changes/<topic>.md', () => {
    expect(newUnreleasedLines(LOG, added)).toEqual(['- My new note.'])
    const msg = newLinesMessage(['- My new note.'])
    expect(msg).toContain('put your entry in changes/<topic>.md')
    expect(msg).toContain('a new line under "## Unreleased"')
    expect(msg).toContain('\n  - My new note.')
  })
  test('a fix to a note that is there, a note moved to changes/, or no change pass', () => {
    expect(newUnreleasedLines(LOG, LOG.replace('- Older note A.', '- Older note A, fixed.'))).toEqual([])
    expect(newUnreleasedLines(added, LOG)).toEqual([])
    expect(newUnreleasedLines(LOG, LOG)).toEqual([])
  })
  test('notes a release moved out of the section meanwhile are not new; only the added one is', () => {
    const released = LOG.replace('## Unreleased\n\n- Older note A.\n- Older note B.\n', '## Unreleased\n\n## 0.5.0 — 2026-11-11\n\n- Older note A.\n- Older note B.\n')
    expect(newUnreleasedLines(released, LOG)).toEqual([])
    expect(newUnreleasedLines(released, added)).toEqual(['- My new note.'])
  })
  test('a base without the section counts as an empty one', () => {
    expect(newUnreleasedLines('# Changelog\n', added)).toEqual(['- My new note.', '- Older note A.', '- Older note B.'])
  })
})

describe('the base to compare with', () => {
  const tmp: string[] = []
  afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  /** A repository with dev holding LOG, cloned; the clone's CHANGELOG.md has a new note (a PR's checkout). */
  function pr(): string {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-base-'))
    tmp.push(top)
    const origin = path.join(top, 'origin'), clone = path.join(top, 'clone')
    fs.mkdirSync(origin)
    git(origin, 'init', '-q', '-b', 'dev')
    fs.writeFileSync(path.join(origin, 'CHANGELOG.md'), LOG)
    git(origin, 'add', 'CHANGELOG.md')
    git(origin, 'commit', '-q', '-m', 'base')
    git(top, 'clone', '-q', origin, clone)
    fs.writeFileSync(path.join(clone, 'CHANGELOG.md'), LOG.replace('- Older note A.\n', '- My new note.\n- Older note A.\n'))
    return clone
  }
  test('no base (a push, a local run): null, quietly', () => {
    const warned: string[] = []
    expect(baseChangelog(pr(), {}, (w) => warned.push(w))).toBeNull()
    expect(warned).toEqual([])
  })
  test('on a pull request in GitHub Actions: GITHUB_BASE_REF is fetched from origin', () => {
    const clone = pr()
    const base = baseChangelog(clone, { GITHUB_BASE_REF: 'dev' })
    expect(base).toBe(LOG)
    expect(newUnreleasedLines(base!, fs.readFileSync(path.join(clone, 'CHANGELOG.md'), 'utf8'))).toEqual(['- My new note.'])
  })
  test('the release PR (dev into main) is compared with dev: the notes dev gathered are not new', () => {
    const clone = pr()
    const origin = path.join(path.dirname(clone), 'origin')
    // main: the last release, without the notes dev gathered since; dev: those notes (merged PR by PR)
    git(origin, 'branch', 'main')
    const gathered = LOG.replace('- Older note A.\n', '- Merged into dev 1.\n- Merged into dev 2.\n- Older note A.\n')
    fs.writeFileSync(path.join(origin, 'CHANGELOG.md'), gathered)
    git(origin, 'commit', '-q', '-am', 'notes on dev')
    fs.writeFileSync(path.join(clone, 'CHANGELOG.md'), gathered)
    const head = fs.readFileSync(path.join(clone, 'CHANGELOG.md'), 'utf8')
    const env = { GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'dev' }
    const base = baseChangelog(clone, env)
    expect(base).toBe(gathered)
    expect(newUnreleasedLines(base!, head)).toEqual([])
    // against main itself every note of dev would read as new (the release PR's old failure)
    expect(newUnreleasedLines(LOG, head)).toEqual(['- Merged into dev 1.', '- Merged into dev 2.'])
    // a note that is not on dev still fails the release PR
    const added = gathered.replace('- Older note A.\n', '- Only in this PR.\n- Older note A.\n')
    expect(newUnreleasedLines(baseChangelog(clone, env)!, added)).toEqual(['- Only in this PR.'])
    // any other PR into main (a hotfix branch from main) still compares with main, so its new line fails
    expect(baseChangelog(clone, { GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'fix/hotfix' })).toBe(LOG)
    const hotfix = LOG.replace('- Older note A.\n', '- Hotfix note.\n- Older note A.\n')
    expect(newUnreleasedLines(baseChangelog(clone, { GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'fix/hotfix' })!, hotfix)).toEqual(['- Hotfix note.'])
  })
  test('CHANGELOG_BASE names a ref for a local check', () => {
    expect(baseChangelog(pr(), { CHANGELOG_BASE: 'origin/dev' })).toBe(LOG)
  })
  test('a base that cannot be read warns and skips; an odd branch name is never passed to git', () => {
    const warned: string[] = []
    const clone = pr()
    expect(baseChangelog(clone, { GITHUB_BASE_REF: 'no-such-branch' }, (w) => warned.push(w))).toBeNull()
    expect(baseChangelog(clone, { GITHUB_BASE_REF: '--upload-pack=touch x' }, (w) => warned.push(w))).toBeNull()
    expect(baseChangelog(clone, { CHANGELOG_BASE: '--output=x' }, (w) => warned.push(w))).toBeNull()
    expect(warned).toHaveLength(3)
    expect(warned[0]).toContain('could not fetch the base branch no-such-branch')
    expect(warned[1]).toContain('is not one git can fetch')
    expect(fs.existsSync(path.join(clone, 'x'))).toBe(false)
  })
})

test('this repository: CHANGELOG.md and changes/ pass the check', () => {
  const root = path.resolve(import.meta.dir, '../..')
  const fragments = readFragments(path.join(root, 'changes'))
  expect(problems(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), fragments, (f) => fs.readFileSync(f.file, 'utf8'))).toEqual([])
})
