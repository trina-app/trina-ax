// Changelog fragments (changes/README.md): every PR adds its notes as one file in changes/ instead of a line at the top
// of CHANGELOG.md's "## Unreleased", so two open PRs never conflict on the same lines (each conflict started every CI job
// again, and a wrong fix left merge markers in the file).
//
//   bun scripts/changelog.ts          the Unreleased notes as they will read: the fragments first, then the section
//   bun scripts/changelog.ts --fold   before a release: put the fragments under "## Unreleased" and delete them
//   bun scripts/changelog.ts --check  fail when CHANGELOG.md or a fragment holds a merge marker or a fragment is empty,
//                                     and when a PR adds notes under "## Unreleased" instead of a file in changes/
//                                     (compared with the PR's base, dev for the dev -> main PR; see baseChangelog.
//                                     Without a base it is skipped.)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const HEADING = '## Unreleased'
const MARKER = /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)( |$)/m

/** The notes of one fragment: each "- " line starts a note; a line after it without "- " goes on with that note. */
export function fragmentNotes(text: string): string[] {
  const notes: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    if (/^- /.test(line) || !notes.length) notes.push(/^- /.test(line) ? line : `- ${line.trim()}`)
    else notes[notes.length - 1] += ` ${line.trim()}`
  }
  return notes
}

export interface Fragment { file: string; notes: string[] }

/** Every fragment in `dir` (Markdown files, README.md and dot files left out), in file-name order. */
export function readFragments(dir: string): Fragment[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && !f.startsWith('.'))
    .sort()
    .map((f) => ({ file: path.join(dir, f), notes: fragmentNotes(fs.readFileSync(path.join(dir, f), 'utf8')) }))
}

/** The changelog with `notes` put at the top of "## Unreleased" (made under the title when there is none). */
export function foldInto(changelog: string, notes: readonly string[]): string {
  if (!notes.length) return changelog
  const text = changelog.replace(/\r\n?/g, '\n')
  const at = text.search(/^## Unreleased[ \t]*$/m)
  const block = notes.join('\n')
  if (at < 0) {
    const first = text.search(/^## /m)
    const head = first < 0 ? `${text.trimEnd()}\n\n` : text.slice(0, first)
    const rest = first < 0 ? '' : text.slice(first)
    return `${head}${HEADING}\n\n${block}\n\n${rest}`
  }
  const end = text.indexOf('\n', at)
  const after = end < 0 ? '' : text.slice(end + 1).replace(/^\n+/, '')
  return `${text.slice(0, at)}${HEADING}\n\n${block}\n${after.startsWith('## ') ? '\n' : ''}${after}`
}

/** The "## Unreleased" section's notes (empty when there is none). */
export function unreleasedNotes(changelog: string): string {
  const text = changelog.replace(/\r\n?/g, '\n')
  const at = text.search(/^## Unreleased[ \t]*$/m)
  if (at < 0) return ''
  const body = text.slice(text.indexOf('\n', at) + 1)
  const next = body.search(/^## /m)
  return (next < 0 ? body : body.slice(0, next)).trim()
}

/** The non-blank lines of the "## Unreleased" section. */
function unreleasedLines(changelog: string): string[] {
  return unreleasedNotes(changelog).split('\n').filter((l) => l.trim())
}

/** Lines a PR added under "## Unreleased" instead of a file in changes/: the section has more notes ("- " lines) than
 * the base's, and these lines are nowhere in the base's CHANGELOG.md. A fix to a note that is already there keeps the
 * count and passes; a note the PR moved to changes/ lowers it; lines that a release moved out of the section meanwhile
 * are still in the base's file, so they are not new. */
export function newUnreleasedLines(base: string, head: string): string[] {
  const notes = (text: string) => unreleasedLines(text).filter((l) => l.startsWith('- ')).length
  if (notes(head) <= notes(base)) return []
  const known = new Set(base.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()))
  return unreleasedLines(head).filter((l) => !known.has(l.trim()))
}

/** The failure for lines a PR added under "## Unreleased". */
export function newLinesMessage(lines: readonly string[]): string {
  const shown = lines.map((l) => `  ${l.length > 100 ? `${l.slice(0, 97)}...` : l}`)
  return [
    `CHANGELOG.md: ${lines.length === 1 ? 'a new line' : `${lines.length} new lines`} under "${HEADING}". A PR does not edit CHANGELOG.md:`,
    'put your entry in changes/<topic>.md (<topic> = the branch name without its prefix; rules: changes/README.md)',
    `and take ${lines.length === 1 ? 'this line' : 'these lines'} out of CHANGELOG.md:`,
    ...shown,
  ].join('\n')
}

const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/

/** The release PR (head dev, base main) is compared with dev, not main: dev's "## Unreleased" holds every note merged
 * since the last release, and each was checked when its PR went into dev. Compared with main, all of them read as new
 * and the release PR could never pass. Any other PR into main (a hotfix branch, a release branch) still compares with
 * main. */
export const RELEASE_BRANCH = 'main'
export const INTEGRATION_BRANCH = 'dev'

/** The CHANGELOG.md of the PR's base, or null when there is none to compare with (a push, a local run):
 * `CHANGELOG_BASE` (a git ref, read as it is, e.g. `origin/dev` for a local check), else on a pull request in GitHub
 * Actions `GITHUB_BASE_REF` (dev instead for the release PR, see RELEASE_BRANCH), fetched from `origin` (the public
 * repository, no credentials needed). `warn` says why a base that should be there could not be read; the comparison
 * is then skipped, not failed. */
export function baseChangelog(root: string, env: Record<string, string | undefined> = process.env, warn: (why: string) => void = () => {}): string | null {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  let ref = env.CHANGELOG_BASE ?? ''
  if (!ref) {
    const target = env.GITHUB_BASE_REF ?? ''
    if (!target) return null
    const release = target === RELEASE_BRANCH && env.GITHUB_HEAD_REF === INTEGRATION_BRANCH
    const branch = release ? INTEGRATION_BRANCH : target
    if (!BRANCH.test(branch)) { warn(`the base branch name "${branch}" is not one git can fetch`); return null }
    const shallow = git('rev-parse', '--is-shallow-repository').stdout.trim() === 'true'
    const fetched = git('fetch', '--quiet', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', `refs/heads/${branch}`)
    if (fetched.status !== 0) { warn(`could not fetch the base branch ${branch}: ${(fetched.stderr || '').trim()}`); return null }
    ref = 'FETCH_HEAD'
  }
  if (ref.startsWith('-')) { warn(`"${ref}" is not a git ref`); return null }
  const shown = git('show', `${ref}:CHANGELOG.md`)
  if (shown.status !== 0) { warn(`could not read CHANGELOG.md at ${ref}: ${(shown.stderr || '').trim()}`); return null }
  return shown.stdout
}

/** What is wrong with the changelog and the fragments: merge markers, a fragment with no note. */
export function problems(changelog: string, fragments: readonly Fragment[], fragmentText: (f: Fragment) => string): string[] {
  const out: string[] = []
  if (MARKER.test(changelog)) out.push('CHANGELOG.md holds a merge marker (<<<<<<<, |||||||, =======, >>>>>>>)')
  for (const f of fragments) {
    if (!f.notes.length) out.push(`${f.file} has no note`)
    if (MARKER.test(fragmentText(f))) out.push(`${f.file} holds a merge marker`)
  }
  return out
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..')
  const file = path.join(root, 'CHANGELOG.md')
  const dir = path.join(root, 'changes')
  const changelog = fs.readFileSync(file, 'utf8')
  const fragments = readFragments(dir)
  const notes = fragments.flatMap((f) => f.notes)
  const arg = process.argv[2] ?? ''
  if (arg === '--check') {
    const bad = problems(changelog, fragments, (f) => fs.readFileSync(f.file, 'utf8'))
    const warn = (why: string) =>
      console.log(`${process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : 'warning: '}changelog:check: ${why}; new lines under "${HEADING}" were not checked`)
    const base = baseChangelog(root, process.env, warn)
    const added = base === null ? [] : newUnreleasedLines(base, changelog)
    if (added.length) bad.push(newLinesMessage(added))
    for (const p of bad) console.error(p)
    if (!bad.length) console.log(`Changelog OK: ${fragments.length} file(s) in changes/${base === null ? '' : `, nothing new under "${HEADING}"`}.`)
    process.exit(bad.length ? 1 : 0)
  } else if (arg === '--fold') {
    const bad = problems(changelog, fragments, (f) => fs.readFileSync(f.file, 'utf8'))
    if (bad.length) {
      for (const p of bad) console.error(p)
      process.exit(1)
    }
    fs.writeFileSync(file, foldInto(changelog, notes))
    for (const f of fragments) fs.rmSync(f.file)
    console.log(`${fragments.length} fragment(s), ${notes.length} note(s) moved into CHANGELOG.md`)
  } else if (!arg) {
    console.log(`${HEADING}\n\n${[...notes, unreleasedNotes(changelog)].filter(Boolean).join('\n')}`)
  } else {
    console.error('usage: bun scripts/changelog.ts [--fold | --check]')
    process.exit(2)
  }
}
