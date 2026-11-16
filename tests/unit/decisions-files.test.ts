// Design decisions (scripts/decisions.ts, docs/decisions/README.md): from 2026-11-16 a decision is one file in
// docs/decisions/; docs/DECISIONS.md is the archive and a PR that adds to it fails `bun run check:docs`.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { baseFile } from '../../scripts/changelog'
import { fileProblems, newArchiveLines, newLinesMessage, readDecisions, readHeader } from '../../scripts/decisions'
import { decisionFiles, localLinkProblems } from '../../scripts/check-onboarding-docs'

const ARCHIVE = `# 결정 기록

> Archive note.

## 저장소

- **One.** Reason.
- **Two.** Reason.

## Later entry (fix/x, 2026-11-15)

- Rule line.
`

const GOOD = `# A guest can't take an e-mail used in the team

- Date: 2026-11-16
- Status: accepted
- Supersedes: none

- **Rule:** ...
`

describe('a decision file', () => {
  test('the header: title, date, status, supersedes', () => {
    expect(readHeader(GOOD)).toEqual({ title: "A guest can't take an e-mail used in the team", date: '2026-11-16', status: 'accepted', supersedes: 'none' })
    expect(fileProblems('20261116-guest-email-unique.md', GOOD)).toEqual([])
    expect(fileProblems('20261116-guest-email-unique.md', GOOD.replace('accepted', 'superseded by [x](20261201-x.md)'))).toEqual([])
  })
  test('a wrong name, a date that is not the name\'s, a missing line or a merge marker is a problem', () => {
    expect(fileProblems('guest-email.md', GOOD)[0]).toContain('<YYYYMMDD>-<topic>.md')
    expect(fileProblems('20261116-Guest_Email.md', GOOD)).toHaveLength(1)
    expect(fileProblems('20261117-guest.md', GOOD)[0]).toContain('not the date in the file name')
    expect(fileProblems('20261116-guest.md', GOOD.replace('- Status: accepted\n', ''))[0]).toContain('Status')
    expect(fileProblems('20261116-guest.md', GOOD.replace('accepted', 'maybe'))[0]).toContain('Status')
    expect(fileProblems('20261116-guest.md', GOOD.replace('- Supersedes: none\n', ''))[0]).toContain('Supersedes')
    expect(fileProblems('20261116-guest.md', GOOD.replace('# A guest', 'A guest'))[0]).toContain('# <title>')
    expect(fileProblems('20261116-guest.md', `${GOOD}<<<<<<< HEAD\n`)[0]).toContain('merge marker')
  })
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })
  test('the folder lists newest first, README.md and dot files left out', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'))
    fs.writeFileSync(path.join(dir, '20261116-b.md'), GOOD)
    fs.writeFileSync(path.join(dir, '20261201-a.md'), GOOD.replace('2026-11-16', '2026-12-01'))
    fs.writeFileSync(path.join(dir, 'README.md'), '# not one\n')
    fs.writeFileSync(path.join(dir, '.x.md'), '# not one\n')
    expect(readDecisions(dir).map((d) => [d.file, d.date])).toEqual([['20261201-a.md', '2026-12-01'], ['20261116-b.md', '2026-11-16']])
    expect(readDecisions(path.join(dir, 'missing'))).toEqual([])
  })
})

describe('the archive', () => {
  test('a new section at the end fails, with its lines', () => {
    const head = `${ARCHIVE}\n## New entry (feat/y, 2026-11-16)\n\n- New rule.\n`
    expect(newArchiveLines(ARCHIVE, head)).toEqual(['## New entry (feat/y, 2026-11-16)', '- New rule.'])
    expect(newLinesMessage(newArchiveLines(ARCHIVE, head))).toContain('docs/decisions/<YYYYMMDD>-<topic>.md')
  })
  test('lines added to an old section fail; a section in the middle fails', () => {
    expect(newArchiveLines(ARCHIVE, ARCHIVE.replace('- Rule line.\n', '- Rule line.\n- Another rule.\n'))).toEqual(['- Another rule.'])
    expect(newArchiveLines(ARCHIVE, ARCHIVE.replace('## Later', '## Middle\n\n## Later'))).toEqual(['## Middle'])
  })
  test('a typo fix in an old entry passes; so does a change to the top note; so does taking lines out', () => {
    expect(newArchiveLines(ARCHIVE, ARCHIVE.replace('Reason.', 'Reasons.'))).toEqual([])
    expect(newArchiveLines(ARCHIVE, ARCHIVE.replace('> Archive note.\n', '> Archive note.\n> Look in docs/decisions/.\n> One more line.\n'))).toEqual([])
    expect(newArchiveLines(ARCHIVE, ARCHIVE.replace('- **Two.** Reason.\n', ''))).toEqual([])
  })
  test('a decision hidden in the top note fails', () => {
    const many = Array.from({ length: 8 }, (_, i) => `> Rule ${i}.`).join('\n')
    expect(newArchiveLines(ARCHIVE, ARCHIVE.replace('> Archive note.\n', `> Archive note.\n${many}\n`))).toHaveLength(8)
  })
  test('a copied line still counts as new', () => {
    expect(newArchiveLines(ARCHIVE, ARCHIVE.replace('- Rule line.\n', '- Rule line.\n- Rule line.\n'))).toEqual(['(1 more line(s) than the base)'])
  })
})

describe('the base', () => {
  test('the archive is read from the PR\'s base like CHANGELOG.md (DECISIONS_BASE / a ref)', () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-git-'))
    try {
      const git = (cwd: string, ...args: string[]) => {
        const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
        if (r.status !== 0) throw new Error(r.stderr)
        return r.stdout
      }
      const origin = path.join(top, 'origin'), clone = path.join(top, 'clone')
      fs.mkdirSync(path.join(origin, 'docs'), { recursive: true })
      git(origin, 'init', '-q', '-b', 'dev')
      fs.writeFileSync(path.join(origin, 'docs/DECISIONS.md'), ARCHIVE)
      git(origin, 'add', '.')
      git(origin, 'commit', '-q', '-m', 'base')
      git(top, 'clone', '-q', origin, clone)
      expect(baseFile(clone, 'docs/DECISIONS.md', { GITHUB_BASE_REF: 'dev' })).toBe(ARCHIVE)
      expect(baseFile(clone, 'docs/DECISIONS.md', {}, () => {}, 'origin/dev')).toBe(ARCHIVE)
      expect(baseFile(clone, 'docs/DECISIONS.md', {})).toBeNull()
      // the real archive is over 3 MB: past spawnSync's default buffer the read failed with no message
      const big = `${ARCHIVE}${'- A long line of an old entry.\n'.repeat(120_000)}`
      fs.writeFileSync(path.join(origin, 'docs/DECISIONS.md'), big)
      git(origin, 'commit', '-q', '-am', 'big')
      git(clone, 'fetch', '-q', 'origin')
      expect(baseFile(clone, 'docs/DECISIONS.md', {}, () => {}, 'origin/dev')).toBe(big)
      const warned: string[] = []
      expect(baseFile(clone, 'docs/missing.md', {}, (w) => warned.push(w), 'origin/dev')).toBeNull()
      expect(warned[0]).toContain('could not read docs/missing.md')
    } finally {
      fs.rmSync(top, { recursive: true, force: true })
    }
  })
})

describe('this repository', () => {
  const root = path.resolve(import.meta.dir, '../..')
  test('every file in docs/decisions/ has its header, and their links and anchors resolve', () => {
    const files = decisionFiles(root)
    expect(files).toContain('docs/decisions/README.md')
    for (const f of files.filter((f) => !f.endsWith('README.md'))) expect(fileProblems(path.basename(f), fs.readFileSync(path.join(root, f), 'utf8'))).toEqual([])
    expect(files.flatMap((f) => localLinkProblems(f, root))).toEqual([])
  })
  test('the archive\'s top note points to docs/decisions/', () => {
    const top = fs.readFileSync(path.join(root, 'docs/DECISIONS.md'), 'utf8').split('\n## ')[0]!
    expect(top).toContain('docs/decisions/')
  })
})
