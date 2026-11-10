// Changelog fragments (changes/README.md): every PR adds its notes as one file in changes/ instead of a line at the top
// of CHANGELOG.md's "## Unreleased", so two open PRs never conflict on the same lines (each conflict started every CI job
// again, and a wrong fix left merge markers in the file).
//
//   bun scripts/changelog.ts          the Unreleased notes as they will read: the fragments first, then the section
//   bun scripts/changelog.ts --fold   before a release: put the fragments under "## Unreleased" and delete them
//   bun scripts/changelog.ts --check  fail when CHANGELOG.md or a fragment holds a merge marker or a fragment is empty
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
    for (const p of bad) console.error(p)
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
