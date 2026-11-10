// CI check for changelog entries (part of `bun run check:docs`): each pull request adds its entry as one new file
// changelog.d/<slug>.md and leaves CHANGELOG.md alone (changelog.d/README.md). Fails when a fragment is empty, not
// UTF-8 text, has a heading or rule line, an open code block or a merge-conflict marker, when a file in changelog.d/ is
// not a <slug>.md, and when CHANGELOG.md has a conflict marker or anything but its note under "## Unreleased".
// The rules live in scripts/changelog-collect.ts, which the release runs with the same checks.
import fs from 'node:fs'
import path from 'node:path'
import { CHANGELOG, FRAGMENT_DIR, changelogProblems, readFragments } from './changelog-collect'

const ROOT = path.resolve(import.meta.dir, '..')

/** Every problem with changelog.d/ and CHANGELOG.md; empty when both follow the rules. */
export function checkChangelog(root = ROOT): string[] {
  const { problems } = readFragments(root)
  return [...problems, ...changelogProblems(fs.readFileSync(path.join(root, CHANGELOG), 'utf8'))]
}

if (import.meta.main) {
  const problems = checkChangelog()
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else {
    const n = readFragments(ROOT).fragments.length
    console.log(`Changelog OK: ${n} entr${n === 1 ? 'y' : 'ies'} in ${FRAGMENT_DIR}/, nothing new under "## Unreleased" in ${CHANGELOG}.`)
  }
}
