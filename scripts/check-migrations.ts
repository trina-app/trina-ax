// `bun run check:migrations`: the numbers of server/migrations/ (docs/WORKPLAN.md §4).
//
// The server refuses to start when two migration files share a number (readMigrations, server/src/db.ts), and several
// branches add migrations at the same time. This fails before the merge instead:
// - two files with one number;
// - a name the runner would skip, or `NNN_<component letter>_<name>.sql` with a number outside that component's range
//   (001–099 is the foundation and has no letter);
// - on a pull request, a number the base branch does not have that is not above the base's highest number of the same
//   component. CI checks the merge with the base, so a number taken by a PR that merged first fails the next run of
//   the second PR. Numbers on the base are never changed; the later branch takes the next free one.
//
// The base is found as changelog:check finds it (scripts/changelog.ts baseRef): `MIGRATIONS_BASE` or `CHANGELOG_BASE`
// (a git ref, e.g. `MIGRATIONS_BASE=origin/dev` for a local check), else the pull request's base in GitHub Actions.
// With no base (a push, a local run) only the first two rules run. Gaps in the numbers are fine.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { baseRef } from './changelog'

export const MIGRATIONS_PATH = 'server/migrations'
/** The same names the runner applies (MIGRATION_FILE in server/src/db.ts; the unit test compares the two). */
const FILE = /^(\d{3})_([a-z0-9_]+)\.sql$/
type Range = readonly [number, number]
/** docs/WORKPLAN.md §4. B uses 400–499 once 200–299 is full. */
export const RANGES: Record<string, readonly Range[]> = {
  a: [[100, 199]],
  b: [[200, 299], [400, 499]],
  c: [[300, 399]],
  f: [[600, 699]],
  g: [[700, 799]],
}
const FOUNDATION: Range = [1, 99]

export interface Parsed { file: string; number: number; component: string }

const within = (n: number, ranges: readonly Range[]) => ranges.some(([lo, hi]) => n >= lo && n <= hi)
const spans = (ranges: readonly Range[]) => ranges.map(([lo, hi]) => `${lo}–${hi}`).join(', ')

/** A migration file name read as number and component ('' for the foundation), or what is wrong with it. */
export function parse(file: string): Parsed | string {
  const m = FILE.exec(file)
  if (!m) return `${file}: the runner skips this name; use NNN_<component letter>_<lower-case letters, digits, _>.sql`
  const number = parseInt(m[1]!, 10)
  if (within(number, [FOUNDATION])) return { file, number, component: '' }
  const letter = /^([a-z])_./.exec(m[2]!)?.[1] ?? ''
  const ranges = RANGES[letter]
  if (!ranges) return `${file}: no component letter after the number (${Object.keys(RANGES).join(', ')}); only 001–099 has none`
  if (!within(number, ranges)) return `${file}: ${number} is outside component ${letter.toUpperCase()}'s range (${spans(ranges)})`
  return { file, number, component: letter }
}

/** What is wrong with the migration file names of this tree; `base` is the same folder on the PR's base branch
 * (null: nothing to compare with). */
export function problems(files: readonly string[], base: readonly string[] | null = null): string[] {
  const out: string[] = []
  const parsed: Parsed[] = []
  for (const f of [...files].sort()) {
    const p = parse(f)
    if (typeof p === 'string') out.push(p)
    else parsed.push(p)
  }
  const byNumber = new Map<number, string[]>()
  for (const p of parsed) byNumber.set(p.number, [...(byNumber.get(p.number) ?? []), p.file])
  for (const [n, names] of byNumber) if (names.length > 1) out.push(`two migrations with number ${n}: ${names.join(', ')} (the server refuses to start)`)
  if (base) {
    // a name on the base that cannot be read is the base's own problem, not this PR's
    const onBase = base.map(parse).filter((p): p is Parsed => typeof p !== 'string')
    const taken = new Set(onBase.map((p) => p.number))
    const highest = new Map<string, Parsed>()
    for (const p of onBase) if (p.number > (highest.get(p.component)?.number ?? 0)) highest.set(p.component, p)
    for (const p of parsed) {
      const top = highest.get(p.component)
      if (!taken.has(p.number) && top && p.number < top.number) {
        out.push(`${p.file}: new number ${p.number} is not above the base branch's highest ${p.component ? `for component ${p.component.toUpperCase()}` : 'foundation number'} (${top.file}); take the next free number`)
      }
    }
  }
  return out
}

/** The file names of server/migrations/ at a git ref, or null (with a warning) when they cannot be listed. */
export function filesAt(root: string, ref: string, warn: (why: string) => void = () => {}): string[] | null {
  const r = spawnSync('git', ['ls-tree', '--name-only', `${ref}:${MIGRATIONS_PATH}`], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) { warn(`could not list ${MIGRATIONS_PATH} at ${ref}: ${(r.stderr || '').trim()}`); return null }
  return r.stdout.split('\n').filter(Boolean)
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..')
  const files = fs.readdirSync(path.join(root, MIGRATIONS_PATH)).filter((f) => f !== '.DS_Store')
  const warn = (why: string) =>
    console.log(`${process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : 'warning: '}check:migrations: ${why}; new numbers were not compared with the base branch`)
  const ref = baseRef(root, process.env, warn, process.env.MIGRATIONS_BASE ?? process.env.CHANGELOG_BASE ?? '')
  const base = ref === null ? null : filesAt(root, ref, warn)
  const bad = problems(files, base)
  for (const p of bad) console.error(p)
  if (!bad.length) console.log(`Migrations OK: ${files.length} file(s), no shared number, every number in its component's range${base === null ? '' : ", new numbers above the base branch's"}.`)
  process.exit(bad.length ? 1 : 0)
}
