// Changelog entries as one file per change (changelog.d/README.md): `bun run changelog:collect` folds the files into
// CHANGELOG.md at a release (scripts/changelog-collect.ts), and `bun run check:docs` fails on a bad fragment or a new
// line under "## Unreleased" (scripts/check-changelog.ts).
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UNRELEASED_NOTE, collect, fragmentProblems } from '../../scripts/changelog-collect'
import { checkChangelog } from '../../scripts/check-changelog'

const OLDER = '## 1.0.0 — 2026-11-01\n\n- An older entry.\n'
const HEAD = '# Changelog\n\nIntro line.\n\n## Unreleased\n\n'
const roots: string[] = []

function repo(files: Record<string, string | Buffer>, changelog = `${HEAD}${UNRELEASED_NOTE}\n\n${OLDER}`): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-frag-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'changelog.d'))
  fs.mkdirSync(path.join(root, 'server'))
  fs.writeFileSync(path.join(root, 'server/package.json'), JSON.stringify({ version: '1.1.0-beta.1' }))
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog)
  fs.writeFileSync(path.join(root, 'changelog.d/README.md'), '# Changelog entries\n\nOne file per change.\n')
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'changelog.d', name), text)
  return root
}
const read = (root: string, f: string) => fs.readFileSync(path.join(root, f), 'utf8')
const left = (root: string) => fs.readdirSync(path.join(root, 'changelog.d')).sort()

afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })

test('collect: paragraphs first, then bullets in file-name order, under the kept Unreleased heading and note', () => {
  const root = repo({
    'zebra-fix.md': '- Zebra: the last by name.\n',
    'apple-feature.md': '- Apple: the first by name.\n  - with a sub-point\n',
    'upgrade-note.md': '**Upgrade note:** take a backup first.\n',
    'middle.md': '\n\n- Middle, with blank lines around.\n\n',
  })
  const r = collect(root, { version: '1.1.0', date: '2026-11-11' })
  expect(read(root, 'CHANGELOG.md')).toBe(
    `${HEAD}${UNRELEASED_NOTE}\n\n## 1.1.0 — 2026-11-11\n\n**Upgrade note:** take a backup first.\n\n` +
      '- Apple: the first by name.\n  - with a sub-point\n- Middle, with blank lines around.\n- Zebra: the last by name.\n\n' +
      OLDER,
  )
  expect(r.deleted).toEqual(['changelog.d/apple-feature.md', 'changelog.d/middle.md', 'changelog.d/upgrade-note.md', 'changelog.d/zebra-fix.md'])
  expect(r.carried).toBe(false)
  // the fragments are gone, the README stays, and the result passes the check (ready for the next entries)
  expect(left(root)).toEqual(['README.md'])
  expect(checkChangelog(root)).toEqual([])
})

test('collect: the version comes from server/package.json, the same input gives the same section, --dry-run writes nothing', () => {
  const files = { 'b.md': '- B\n', 'a.md': '- A\n' }
  const one = repo(files), two = repo(files)
  const before = read(one, 'CHANGELOG.md')
  const dry = collect(one, { date: '2026-11-11', dryRun: true })
  expect(dry.section).toBe('## 1.1.0-beta.1 — 2026-11-11\n\n- A\n- B\n')
  expect(read(one, 'CHANGELOG.md')).toBe(before)
  expect(left(one)).toEqual(['README.md', 'a.md', 'b.md'])
  expect(collect(one, { date: '2026-11-11' }).changelog).toBe(collect(two, { date: '2026-11-11' }).changelog)
})

test('collect: refuses a version already there, an empty changelog.d, and a bad fragment, and then changes nothing', () => {
  const root = repo({ 'a.md': '- A\n' }, `${HEAD}${UNRELEASED_NOTE}\n\n${OLDER}`)
  expect(() => collect(root, { version: '1.0.0' })).toThrow('already has a "## 1.0.0" section')
  expect(() => collect(root, { version: 'v1.2' })).toThrow('not a release version')
  expect(() => collect(repo({}), { version: '1.1.0' })).toThrow('Nothing to collect')
  const bad = repo({ 'a.md': '- A\n', 'empty.md': '  \n' })
  const before = read(bad, 'CHANGELOG.md')
  expect(() => collect(bad, { version: '1.1.0' })).toThrow('changelog.d/empty.md: empty')
  expect(read(bad, 'CHANGELOG.md')).toBe(before)
  expect(left(bad)).toEqual(['README.md', 'a.md', 'empty.md'])
})

test('collect: a line someone still wrote under Unreleased is carried into the release, first, not lost', () => {
  const root = repo({ 'a.md': '- A\n' }, `${HEAD}- Written the old way.\n\n${UNRELEASED_NOTE}\n\n${OLDER}`)
  const r = collect(root, { version: '1.1.0', date: '2026-11-11' })
  expect(r.carried).toBe(true)
  expect(r.section).toBe('## 1.1.0 — 2026-11-11\n\n- Written the old way.\n- A\n')
  expect(read(root, 'CHANGELOG.md')).toStartWith(`${HEAD}${UNRELEASED_NOTE}\n\n## 1.1.0`)
  expect(checkChangelog(root)).toEqual([])
})

test('check: a good fragment passes; an empty fragment fails with where the entry goes', () => {
  expect(checkChangelog(repo({ 'room-drop-anywhere.md': '- A file dropped anywhere in a room attaches.\n', '.DS_Store': 'x' }))).toEqual([])
  const problems = checkChangelog(repo({ 'room-drop-anywhere.md': '\n \n' }))
  expect(problems).toHaveLength(1)
  expect(problems[0]).toStartWith('changelog.d/room-drop-anywhere.md: empty.')
})

test('check: a new line under ## Unreleased fails and says to use changelog.d/<slug>.md', () => {
  const root = repo({}, `${HEAD}- A new entry the old way.\n${UNRELEASED_NOTE}\n\n${OLDER}`)
  const problems = checkChangelog(root)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('CHANGELOG.md:7: "- A new entry the old way." is under ## Unreleased')
  expect(problems[0]).toContain('changelog.d/<slug>.md')
  // a missing heading fails too; an older release's entries are not "new"
  expect(checkChangelog(repo({}, `# Changelog\n\n${OLDER}`))[0]).toContain('"## Unreleased" heading is missing')
})

test('check: headings, rules, open code blocks, conflict markers, bad names and non-text fail', () => {
  expect(fragmentProblems('f.md', '## 1.2.0\n- x')[0]).toContain('f.md:1: a heading or a rule line')
  expect(fragmentProblems('f.md', 'Title\n=====\n')[0]).toContain('f.md:2: a heading or a rule line')
  expect(fragmentProblems('f.md', '- x\n```sh\nbun run x\n')).toEqual(['f.md: a code block (```) is not closed; it would swallow the rest of CHANGELOG.md.'])
  expect(fragmentProblems('f.md', '- x\n```md\n# not a heading inside code\n```\n')).toEqual([])
  expect(fragmentProblems('f.md', '- x\n||||||| 878a597a\n')[0]).toContain('f.md:2: a merge-conflict marker')
  expect(fragmentProblems('f.md', '- x\n=======\n')[0]).toContain('merge-conflict marker')
  expect(fragmentProblems('f.md', 'a\u0000b')[0]).toContain('not plain text')
  const root = repo({ 'Bad Name.md': '- x\n', 'notes.txt': '- x\n', 'bin.md': Buffer.from([0x2d, 0x20, 0xff, 0xfe]) })
  const problems = checkChangelog(root)
  expect(problems).toHaveLength(3)
  expect(problems.join('\n')).toContain('changelog.d/Bad Name.md: name it like room-drop-anywhere.md')
  expect(problems.join('\n')).toContain('changelog.d/notes.txt: name it like')
  expect(problems.join('\n')).toContain('changelog.d/bin.md: not UTF-8 text.')
  expect(checkChangelog(repo({}, `${HEAD}${UNRELEASED_NOTE}\n\n${OLDER}>>>>>>> dev\n`))[0]).toContain('CHANGELOG.md:12: a merge-conflict marker')
})

test('this repository follows the rules: fragments are valid and nothing new is under ## Unreleased', () => {
  expect(checkChangelog()).toEqual([])
})
