// Design decisions (docs/decisions/README.md): from 2026-11-16 every decision is one file docs/decisions/<YYYYMMDD>-<topic>.md
// instead of a section at the end of docs/DECISIONS.md, so two open PRs never add to the same lines. DECISIONS.md is the
// archive of what was decided before.
//
//   bun scripts/decisions.ts           the decision files, newest first
//   bun scripts/decisions.ts --check   fail when a decision file has no header or a merge marker, when DECISIONS.md holds
//                                      a merge marker, and when a PR adds a section or lines to DECISIONS.md (compared
//                                      with the PR's base as scripts/changelog.ts does; without a base it is skipped)
import fs from 'node:fs'
import path from 'node:path'
import { baseFile } from './changelog'

export const ARCHIVE = 'docs/DECISIONS.md'
export const DIR = 'docs/decisions'
export const STATUSES = ['accepted', 'superseded', 'dropped'] as const
const MARKER = /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)( |$)/m
const NAME = /^(\d{4})(\d{2})(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

export interface Decision { file: string; title: string; date: string; status: string; supersedes: string }

/** The header of one decision file: "# <title>", then "- Date:", "- Status:" and "- Supersedes:" lines. */
export function readHeader(text: string): Omit<Decision, 'file'> {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const field = (name: string) => lines.find((l) => l.startsWith(`- ${name}:`))?.slice(name.length + 3).trim() ?? ''
  const first = lines.find((l) => l.trim()) ?? ''
  return { title: first.startsWith('# ') ? first.slice(2).trim() : '', date: field('Date'), status: field('Status'), supersedes: field('Supersedes') }
}

/** What is wrong with one decision file (its name, e.g. 20261116-decisions-split.md, and its text). */
export function fileProblems(name: string, text: string): string[] {
  const out: string[] = []
  const where = `${DIR}/${name}`
  const m = NAME.exec(name)
  if (!m) out.push(`${where}: the name is not <YYYYMMDD>-<topic>.md (lowercase words joined with -)`)
  const h = readHeader(text)
  if (!h.title) out.push(`${where}: the first line is not "# <title>"`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date)) out.push(`${where}: no "- Date: YYYY-MM-DD" line`)
  else if (m && h.date !== `${m[1]}-${m[2]}-${m[3]}`) out.push(`${where}: "- Date: ${h.date}" is not the date in the file name`)
  if (!STATUSES.some((s) => h.status === s || h.status.startsWith(`${s} `))) out.push(`${where}: no "- Status:" line with ${STATUSES.join(', ')}`)
  if (!h.supersedes) out.push(`${where}: no "- Supersedes:" line (write "none" when it replaces nothing)`)
  if (MARKER.test(text)) out.push(`${where}: holds a merge marker`)
  return out
}

/** Every decision file in `dir` (README.md and dot files left out), newest first. */
export function readDecisions(dir: string): Decision[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && !f.startsWith('.'))
    .sort().reverse()
    .map((f) => ({ file: f, ...readHeader(fs.readFileSync(path.join(dir, f), 'utf8')) }))
}

/** The archive after its top note: from the first "## " heading on. */
function body(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const first = lines.findIndex((l) => l.startsWith('## '))
  return (first < 0 ? [] : lines.slice(first)).filter((l) => l.trim())
}

/** Lines a PR added to the archive instead of a file in docs/decisions/: below the top note the archive has more
 * sections ("## " headings) or more lines than the base's, and these lines are nowhere in the base's file. A typo fix
 * keeps both counts and passes; so does any change to the top note (above the first heading). */
export function newArchiveLines(base: string, head: string): string[] {
  const b = body(base), h = body(head)
  const headings = (ls: string[]) => ls.filter((l) => l.startsWith('## ')).length
  if (headings(h) <= headings(b) && h.length <= b.length) return []
  const known = new Set(base.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()))
  const added = h.filter((l) => !known.has(l.trim()))
  return added.length ? added : [`(${h.length - b.length} more line(s) than the base)`]
}

/** The failure for lines a PR added to the archive. */
export function newLinesMessage(lines: readonly string[]): string {
  const shown = lines.slice(0, 12).map((l) => `  ${l.length > 100 ? `${l.slice(0, 97)}...` : l}`)
  return [
    `${ARCHIVE}: ${lines.length === 1 ? 'a new line' : `${lines.length} new lines`}. ${ARCHIVE} is the archive of decisions made before 2026-11-16;`,
    `a PR adds a new decision as a new file ${DIR}/<YYYYMMDD>-<topic>.md (rules: ${DIR}/README.md) and takes these lines out`,
    `of ${ARCHIVE} (a typo fix in an old entry that keeps its number of lines passes):`,
    ...shown,
    ...(lines.length > shown.length ? [`  ... and ${lines.length - shown.length} more`] : []),
  ].join('\n')
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..')
  const dir = path.join(root, DIR)
  const arg = process.argv[2] ?? ''
  if (arg === '--check') {
    const archive = fs.readFileSync(path.join(root, ARCHIVE), 'utf8')
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md' && !f.startsWith('.')) : []
    const bad = names.flatMap((f) => fileProblems(f, fs.readFileSync(path.join(dir, f), 'utf8')))
    if (MARKER.test(archive)) bad.push(`${ARCHIVE} holds a merge marker (<<<<<<<, |||||||, =======, >>>>>>>)`)
    const warn = (why: string) =>
      console.log(`${process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : 'warning: '}decisions:check: ${why}; new lines in ${ARCHIVE} were not checked`)
    const base = baseFile(root, ARCHIVE, process.env, warn, process.env.DECISIONS_BASE ?? process.env.CHANGELOG_BASE ?? '')
    const added = base === null ? [] : newArchiveLines(base, archive)
    if (added.length) bad.push(newLinesMessage(added))
    for (const p of bad) console.error(p)
    if (!bad.length) console.log(`Decisions OK: ${names.length} file(s) in ${DIR}/${base === null ? '' : `, nothing new in ${ARCHIVE}`}.`)
    process.exit(bad.length ? 1 : 0)
  } else if (!arg) {
    for (const d of readDecisions(dir)) console.log(`${d.date}  ${d.status.padEnd(10)}  ${d.title}  (${DIR}/${d.file})`)
  } else {
    console.error('usage: bun scripts/decisions.ts [--check]')
    process.exit(2)
  }
}
