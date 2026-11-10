// Changelog entries, one file per change (changelog.d/README.md). A pull request adds changelog.d/<slug>.md holding
// its entry, written as it would have been under "## Unreleased", and leaves CHANGELOG.md alone, so two open pull
// requests never conflict on the changelog. A release folds the files into CHANGELOG.md:
//   bun run changelog:collect [<version>] [--date YYYY-MM-DD] [--dry-run]
// <version> defaults to server/package.json's (bump it first); the date defaults to today on this computer. The new
// "## <version> — <date>" goes right under "## Unreleased" and its note. Paragraph fragments (an upgrade note) come
// first, then the bullets; within each group the order is the file name (no git history needed). Lines someone still
// wrote under "## Unreleased" are carried into the new section first, so nothing is lost. The fragments are deleted;
// README.md stays. Nothing is written or deleted when a fragment breaks a rule below. --dry-run prints the section.
// The CI check (scripts/check-changelog.ts, in `bun run check:docs`) uses the same rules.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
export const FRAGMENT_DIR = 'changelog.d'
export const CHANGELOG = 'CHANGELOG.md'
export const UNRELEASED = '## Unreleased'
/** The only text under "## Unreleased" in CHANGELOG.md. */
export const UNRELEASED_NOTE =
  'Changes merged since the last release are in [changelog.d/](changelog.d/), one file per change; the next release moves them here.'
/** Files in changelog.d/ that are not entries (besides hidden files such as .gitkeep or .DS_Store). */
const NOT_ENTRIES = new Set(['README.md'])
const NAME_RE = /^[a-z0-9][a-z0-9._-]*\.md$/
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const WHERE = 'changelog.d/<slug>.md (one new file per change, see changelog.d/README.md)'

export type Fragment = { name: string; text: string }

/** A merge-conflict marker line: <<<<<<<, |||||||, ======= or >>>>>>>. */
export function isConflictMarker(line: string): boolean {
  return /^(<{7}|\|{7}|>{7})( |$)/.test(line) || /^={7}[ \t]*$/.test(line)
}

/** Problems with one fragment's text: empty, not text, a heading or rule, an open code block, a conflict marker. */
export function fragmentProblems(file: string, text: string): string[] {
  if (!text.trim()) return [`${file}: empty. Write the change as one Markdown bullet: "- What changed, for whom."`]
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return [`${file}: not plain text (control characters). Write the entry as Markdown text.`]
  const problems: string[] = []
  let fence: string | null = null
  text.split('\n').forEach((line, i) => {
    const at = `${file}:${i + 1}`
    if (isConflictMarker(line)) { problems.push(`${at}: a merge-conflict marker. Resolve the conflict and delete the marker line.`); return }
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fence) fence = f[1]!
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null
      return
    }
    if (fence) return
    if (/^ {0,3}#{1,6}([ \t]|$)/.test(line) || /^ {0,3}(={3,}|-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line)) {
      problems.push(`${at}: a heading or a rule line. A fragment is one entry (a "- " bullet, or a paragraph); the release writes the version heading.`)
    }
  })
  if (fence) problems.push(`${file}: a code block (${fence}) is not closed; it would swallow the rest of CHANGELOG.md.`)
  return problems
}

/** The entries in changelog.d/, in file-name order, and the problems found in them. */
export function readFragments(root = ROOT): { fragments: Fragment[]; problems: string[] } {
  const dir = path.join(root, FRAGMENT_DIR)
  const fragments: Fragment[] = []
  const problems: string[] = []
  if (!fs.existsSync(dir)) return { fragments, problems: [`${FRAGMENT_DIR}/ is missing; it holds the changelog entries (keep its README.md).`] }
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    if (NOT_ENTRIES.has(e.name) || e.name.startsWith('.')) continue
    const file = `${FRAGMENT_DIR}/${e.name}`
    if (!e.isFile()) { problems.push(`${file}: only files belong in ${FRAGMENT_DIR}/. Put the entry in ${WHERE}.`); continue }
    if (!NAME_RE.test(e.name)) { problems.push(`${file}: name it like room-drop-anywhere.md (lowercase letters, digits, "-", ending in .md).`); continue }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.join(dir, e.name))) }
    catch { problems.push(`${file}: not UTF-8 text.`); continue }
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    const found = fragmentProblems(file, text)
    problems.push(...found)
    if (!found.length) fragments.push({ name: e.name, text: text.trim() })
  }
  return { fragments, problems }
}

/** CHANGELOG.md split around "## Unreleased": the lines up to it, the lines under it, and the next "## " onward. */
export function splitUnreleased(changelog: string): { head: string[]; body: string[]; tail: string[]; bodyStart: number } | null {
  const lines = changelog.split('\n')
  const at = lines.findIndex((l) => l.trimEnd() === UNRELEASED)
  if (at < 0) return null
  let end = lines.findIndex((l, i) => i > at && l.startsWith('## '))
  if (end < 0) end = lines.length
  return { head: lines.slice(0, at + 1), body: lines.slice(at + 1, end), tail: lines.slice(end), bodyStart: at + 2 }
}

/** The lines under "## Unreleased" other than blank lines and the note, with their line numbers. */
export function unreleasedEntries(changelog: string): { line: number; text: string }[] {
  const s = splitUnreleased(changelog)
  if (!s) return []
  return s.body
    .map((text, i) => ({ line: s.bodyStart + i, text }))
    .filter((l) => l.text.trim() && l.text.trim() !== UNRELEASED_NOTE)
}

/** Problems with CHANGELOG.md: conflict markers, a missing "## Unreleased", entries under it. */
export function changelogProblems(changelog: string): string[] {
  const problems: string[] = []
  changelog.split('\n').forEach((line, i) => {
    if (isConflictMarker(line)) problems.push(`${CHANGELOG}:${i + 1}: a merge-conflict marker. Resolve the conflict and delete the marker line.`)
  })
  if (!splitUnreleased(changelog)) {
    problems.push(`${CHANGELOG}: the "${UNRELEASED}" heading is missing. Put it back above the newest release, followed by the note: ${UNRELEASED_NOTE}`)
  }
  for (const { line, text } of unreleasedEntries(changelog)) {
    const shown = text.length > 80 ? `${text.slice(0, 77)}...` : text
    problems.push(`${CHANGELOG}:${line}: "${shown}" is under ${UNRELEASED}. New entries go in ${WHERE}, not in ${CHANGELOG}; move it there and leave ${CHANGELOG} as it is. The release moves the files in.`)
  }
  return problems
}

const isBullet = (text: string) => /^[-*+] /.test(text)

/** Today's date on this computer, YYYY-MM-DD (release headings use the day the release is cut). */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export type CollectResult = { changelog: string; section: string; deleted: string[]; carried: boolean }

/** Fold changelog.d/ into CHANGELOG.md under "## <version> — <date>". Throws with a message when it cannot. */
export function collect(root = ROOT, opts: { version?: string; date?: string; dryRun?: boolean } = {}): CollectResult {
  const version = opts.version ?? (JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8')) as { version: string }).version
  if (!VERSION_RE.test(version)) throw new Error(`"${version}" is not a release version (1.2.3 or 1.2.3-beta.1).`)
  const date = opts.date ?? today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date (YYYY-MM-DD).`)
  const file = path.join(root, CHANGELOG)
  const changelog = fs.readFileSync(file, 'utf8')
  const { fragments, problems } = readFragments(root)
  const markers = changelog.split('\n').flatMap((l, i) => (isConflictMarker(l) ? [`${CHANGELOG}:${i + 1}: a merge-conflict marker. Resolve the conflict and delete the marker line.`] : []))
  if (problems.length || markers.length) throw new Error(`Nothing collected; fix these first:\n${[...problems, ...markers].join('\n')}`)
  const s = splitUnreleased(changelog)
  if (!s) throw new Error(`${CHANGELOG} has no "${UNRELEASED}" heading; put it back above the newest release.`)
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`^## ${escaped}( |$)`, 'm').test(changelog)) {
    const hint = opts.version ? '' : ' Bump the version in server/package.json first (docs/RELEASE-CI.md section 1), or name the new version.'
    throw new Error(`${CHANGELOG} already has a "## ${version}" section.${hint}`)
  }
  // lines someone still wrote under "## Unreleased" (dev merges before CI): they go first, as written
  const left = s.body.filter((l) => l.trim() !== UNRELEASED_NOTE).join('\n').trim()
  const blocks = [...(left ? [left] : []), ...fragments.map((f) => f.text)]
  if (!blocks.length) throw new Error(`Nothing to collect: ${FRAGMENT_DIR}/ has no entries and nothing is under ${UNRELEASED}.`)
  const paragraphs = blocks.filter((b) => !isBullet(b))
  const bullets = blocks.filter(isBullet)
  const parts = [`## ${version} — ${date}`, ...paragraphs, ...(bullets.length ? [bullets.join('\n')] : [])]
  const section = `${parts.join('\n\n')}\n`
  const out = [...s.head, '', UNRELEASED_NOTE, '', section, ...s.tail].join('\n')
  const deleted = fragments.map((f) => `${FRAGMENT_DIR}/${f.name}`)
  if (!opts.dryRun) {
    fs.writeFileSync(file, out)
    for (const f of deleted) fs.rmSync(path.join(root, f))
  }
  return { changelog: out, section, deleted, carried: !!left }
}

const USAGE = 'Usage: bun run changelog:collect [<version>] [--date YYYY-MM-DD] [--dry-run]'

if (import.meta.main) {
  const args = process.argv.slice(2)
  const opts: { version?: string; date?: string; dryRun?: boolean } = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--date') opts.date = args[++i]
    else if (a.startsWith('--date=')) opts.date = a.slice('--date='.length)
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0) }
    else if (!a.startsWith('-') && !opts.version) opts.version = a
    else { console.error(`Unknown argument: ${a}\n${USAGE}`); process.exit(2) }
  }
  try {
    const r = collect(ROOT, opts)
    if (opts.dryRun) console.log(`${r.section}\n(dry run: ${CHANGELOG} and ${FRAGMENT_DIR}/ unchanged)`)
    else {
      console.log(`${CHANGELOG}: wrote ${r.section.split('\n')[0]} with ${r.deleted.length} entr${r.deleted.length === 1 ? 'y' : 'ies'} from ${FRAGMENT_DIR}/ and deleted them.`)
      if (r.carried) console.log(`Also moved what was still under ${UNRELEASED} into the new section (first); check it reads right.`)
      console.log('Review the section (add the channel line and any upgrade note), then commit it with the version bump.')
    }
  } catch (e) {
    console.error((e as Error).message)
    process.exitCode = 1
  }
}
