// `bun run check:prepush`: run before pushing a pull request. It runs the fast checks of CI's job "typecheck, docs,
// native" (.github/workflows/ci.yml: typecheck, features:check, check:docs, check:migrations) with the base set to
// origin/dev, plus the repo-wide guard tests (scripts/ci/guard-tests.ts: the i18n completeness and voice rules, the
// product-name and Korean-literal rules, the exact tool lists, route coverage of the permission matrix, ...; CI runs the
// same list on every pull request). `check:i18n` is the one extra: CI covers it through i18n-completeness.test.ts, it names the key sooner. The native build and the other unit tests stay in CI.
//
// - fetches origin/dev first; warns (never fails) when the branch is behind it ("merge origin/dev first");
// - prints one hint line per failing step ("migration 410 is taken on dev, use 412");
// - warns about migration numbers new PRs already use (only when `gh` is installed and signed in; never fails).
// Run it under CI's Bun (1.3.12): a different version is warned about, since server tests differ (bun:sqlite).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parse, MIGRATIONS_PATH, RANGES } from './check-migrations'
import { GUARD_TESTS } from './ci/guard-tests'

export const BASE = 'origin/dev'
/** CI's Bun version (.github/workflows/ci.yml env BUN_VERSION). */
export const CI_BUN = '1.3.12'
/** The repo-wide guard tests, one list shared with CI's pull request checks (scripts/ci/guard-tests.ts). */
export { GUARD_TESTS }

export interface Step { name: string, cmd: string[], env?: Record<string, string>, hint: (out: string) => string[] }

/** The lowest unused number of a migration's component, above the highest number in use (like a later PR takes it). */
export function nextFree(component: string, used: readonly number[]): number | null {
  const ranges = component ? RANGES[component] : [[1, 99] as const]
  if (!ranges) return null
  // above the highest number in use: the last range that has one, else the first range
  const at = ranges.findLastIndex(([lo, hi]) => used.some((n) => n >= lo && n <= hi))
  if (at < 0) return ranges[0]![0]
  const [lo, hi] = ranges[at]!
  const top = Math.max(...used.filter((n) => n >= lo && n <= hi))
  if (top < hi) return top + 1
  return ranges[at + 1]?.[0] ?? null
}

/** New migration files (not on the base) whose number the base already uses for another file, each with the number to take. */
export function takenOnBase(files: readonly string[], base: readonly string[]): { file: string, number: number, use: number | null }[] {
  const onBase = new Set(base)
  const baseNumbers = new Set<number>()
  const all: number[] = []
  for (const f of base) { const p = parse(f); if (typeof p !== 'string') { baseNumbers.add(p.number); all.push(p.number) } }
  const out: { file: string, number: number, use: number | null }[] = []
  for (const f of [...files].sort()) {
    if (onBase.has(f)) continue
    const p = parse(f)
    if (typeof p === 'string') continue
    all.push(p.number)
    if (!baseNumbers.has(p.number)) continue
    const use = nextFree(p.component, all)
    if (use !== null) all.push(use) // the next file takes the number after it
    out.push({ file: f, number: p.number, use })
  }
  return out
}

/** Hint lines for a failed check:migrations run, read from the files; the script's own messages stay above them. */
export function migrationHints(files: readonly string[], base: readonly string[]): string[] {
  const lowOnes: string[] = []
  const onBase = new Set(base)
  const top = new Map<string, number>()
  for (const f of base) { const p = parse(f); if (typeof p !== 'string') top.set(p.component, Math.max(top.get(p.component) ?? 0, p.number)) }
  const taken = new Set(takenOnBase(files, base).map((t) => t.file))
  for (const f of files) {
    const p = parse(f)
    if (typeof p === 'string' || onBase.has(f) || taken.has(f)) continue
    const t = top.get(p.component)
    if (t !== undefined && p.number < t) lowOnes.push(`migration ${p.number} (${f}) is below dev's highest ${t}: rename it to ${nextFree(p.component, [...top.values(), t]) ?? 'a free number'} or higher`)
  }
  return [...lowOnes, ...takenOnBase(files, base).map((t) => `migration ${t.number} is taken on dev (${t.file}), use ${t.use ?? 'a free number of its component'}`)]
}

/** Migration numbers that new files use and another open PR adds too: [number, PR numbers]. */
export function sharedWithOpenPrs(mine: readonly string[], prs: readonly { number: number, files: readonly string[] }[], base: readonly string[]): [number, number[]][] {
  const onBase = new Set(base)
  const num = (f: string) => { const p = parse(path.basename(f)); return typeof p === 'string' ? null : p.number }
  const wanted = new Set(mine.filter((f) => !onBase.has(f)).map(num).filter((n): n is number => n !== null))
  const found = new Map<number, number[]>()
  for (const pr of prs) {
    for (const f of pr.files) {
      if (!f.startsWith(`${MIGRATIONS_PATH}/`) || onBase.has(path.basename(f))) continue
      const n = num(f)
      if (n !== null && wanted.has(n)) found.set(n, [...new Set([...(found.get(n) ?? []), pr.number])])
    }
  }
  return [...found]
}

/** One-line hints for a failed step, picked from its output. */
export function hintsFor(stepName: string, out: string): string[] {
  const h: string[] = []
  if (stepName === 'check:i18n' || stepName.startsWith('test ')) {
    if (/kamu|"kamu"/.test(out)) h.push('Indonesian voice: say "Anda", not "kamu" (list the key in voiceRules.except only for text sent to the AI)')
    if (/Korean|[가-힣]/.test(out) && /outside|screen text|table/i.test(out)) h.push('Korean text outside a ko table: take the words from the i18n table, or list the file in tests/unit/i18n-languages.test.ts with a reason')
    if (/product name|literal product/i.test(out)) h.push('product name spelled out in code or a comment: write <app>')
    if (/(c-tools|i-wiring|b-browser|b-chat)\.test\.ts/.test(out) && /(toEqual|toBe|Expected|Received)/.test(out)) h.push('exact tool list: a PR that adds a tool must add it to the list in c-tools / i-wiring / b-browser / b-chat tests')
    if (/counts readers|reviewed for folder shares/.test(out)) h.push('a new access check or users/ shortcut: add the file and its new count to REVIEWED in tests/unit/c-reader-counters.test.ts with the reason it is safe for folder shares (or go through files/share-readers.ts)')
    if (/user column is removed or kept|cleanup hook \(auth\/account-removal\.ts\)/.test(out)) h.push('a new table with a user id: add table.column to a cleanup hook (e.g. server/src/chat/account-cleanup.ts) or to KEPT_WITH_ACCOUNT in server/src/auth/account-removal.ts with the reason')
    if (/pins a download of its own/.test(out)) h.push('a script pins its own download: read it from scripts/system/packages.json, or add a narrow PINS_ALLOWED entry in tests/unit/system-packages.test.ts with the reason')
    if (/routes with no matrix case/.test(out)) h.push('a new route: add a permission matrix case in tests/security/lib/*cases.ts (who may call it, aimed at something the wrong person must not reach) and its spread in tests/security/lib/cases.ts SPECS')
    if (/catalog does not hold together|has no line in tests\/ai-scenarios\/feature-scope\.ts|every feature the AI reaches has a case/.test(out)) h.push('a new feature in docs/features.ts: add its line to tests/ai-scenarios/feature-scope.ts and, for acts or explains, a case in tests/ai-scenarios/cases.yaml')
    if (/missing|placeholder|plural/i.test(out) && stepName === 'check:i18n') h.push('a text is missing in a language, or its {placeholders} differ: add it in all six languages (merge origin/dev first if a dev merge brought the key)')
  }
  if (stepName === 'check:docs' && /merge marker|Unreleased/.test(out)) h.push('changelog: put the note in a new changes/<topic>.md, not in CHANGELOG.md; remove merge markers')
  return h
}

export function behindBy(root: string, base = BASE): number | null {
  const r = spawnSync('git', ['rev-list', '--count', `HEAD..${base}`], { cwd: root, encoding: 'utf8' })
  return r.status === 0 ? parseInt(r.stdout.trim(), 10) : null
}

function run(root: string, cmd: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 28 })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const git = (root: string, ...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' })
const lines = (s: string) => s.split('\n').filter(Boolean)

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..')
  const t0 = Date.now()
  const warnings: string[] = []
  console.log(`check:prepush: fetching ${BASE}`)
  const fetched = git(root, 'fetch', '--quiet', '--no-tags', 'origin', 'dev')
  if (fetched.status !== 0) { console.error(`could not fetch origin dev: ${fetched.stderr.trim()}\nWithout it the checks would compare with an old base; fix the network or remote and run again.`); process.exit(1) }
  if (typeof Bun !== 'undefined' && Bun.version !== CI_BUN) warnings.push(`Bun ${Bun.version} here, CI runs ${CI_BUN}: run server tests under ${CI_BUN} (bun:sqlite differs)`)
  const behind = behindBy(root)
  if (behind) warnings.push(`this branch is ${behind} commit(s) behind ${BASE}: merge origin/dev first (a dev merge brings new i18n keys, tools and migration numbers)`)

  const baseEnv = { MIGRATIONS_BASE: BASE, CHANGELOG_BASE: BASE, DECISIONS_BASE: BASE }
  const steps: Step[] = [
    { name: 'typecheck', cmd: ['bun', 'run', 'typecheck'], hint: () => [] },
    { name: 'features:check', cmd: ['bun', 'run', 'features:check'], hint: () => [] },
    { name: 'check:docs', cmd: ['bun', 'run', 'check:docs'], env: baseEnv, hint: () => [] },
    { name: 'check:migrations', cmd: ['bun', 'run', 'check:migrations'], env: baseEnv, hint: () => [] },
    // a change to what the Chrome extension's zip is built from bumps its version (docs/RELEASE-CI.md 16)
    { name: 'chrome:check', cmd: ['bun', 'run', 'chrome:check'], env: { CHROME_BASE: BASE }, hint: () => [] },
    { name: 'check:i18n', cmd: ['bun', 'run', 'check:i18n'], hint: () => [] },
    { name: 'test guards', cmd: ['bun', 'test', ...GUARD_TESTS.map((f) => `./${f}`)], hint: () => [] },
  ]
  const failed: string[] = []
  // the tool-list tests start a real server that needs the native helpers (native/bin; the "native" part of CI's job)
  if (!fs.existsSync(path.join(root, 'native', 'bin', `${process.platform}-${process.arch}`))) {
    console.log('native/bin is missing: building it once (bash native/build.sh), the tool-list tests need it')
    const b = run(root, ['bash', 'native/build.sh'])
    if (!b.ok) warnings.push(`native build failed (is Go installed?); the tool-list tests will fail for that reason, not for yours:\n${b.out.split('\n').slice(-5).join('\n')}`)
  }
  for (const s of steps) {
    const t = Date.now()
    const r = run(root, s.cmd, s.env)
    const secs = ((Date.now() - t) / 1000).toFixed(0)
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${s.name} (${secs}s)`)
    if (r.ok) continue
    failed.push(s.name)
    console.log(r.out.split('\n').slice(-40).join('\n'))
    const hints = hintsFor(s.name === 'test guards' ? 'test ' : s.name, r.out)
    if (s.name === 'check:migrations') {
      const mine = lines(git(root, 'ls-tree', '--name-only', `HEAD:${MIGRATIONS_PATH}`).stdout)
      const base = lines(git(root, 'ls-tree', '--name-only', `${BASE}:${MIGRATIONS_PATH}`).stdout)
      hints.push(...migrationHints(mine, base))
    }
    for (const h of hints) console.log(`  hint: ${h}`)
  }

  // migration numbers other open PRs already use (a warning only; needs gh)
  const mine = lines(git(root, 'ls-tree', '--name-only', `HEAD:${MIGRATIONS_PATH}`).stdout)
  const base = lines(git(root, 'ls-tree', '--name-only', `${BASE}:${MIGRATIONS_PATH}`).stdout)
  if (mine.some((f) => !base.includes(f))) {
    const gh = spawnSync('gh', ['pr', 'list', '--repo', 'trina-app/trina-ax', '--base', 'dev', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,files'], { cwd: root, encoding: 'utf8', timeout: 30000 })
    if (gh.status !== 0) warnings.push('open-PR migration check skipped (gh missing, not signed in, or offline)')
    else {
      try {
        const prs = JSON.parse(gh.stdout) as { number: number, headRefName: string, files: { path: string }[] }[]
        const current = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()
        const others = prs.filter((p) => p.headRefName !== current).map((p) => ({ number: p.number, files: p.files.map((f) => f.path) }))
        for (const [n, list] of sharedWithOpenPrs(mine, others, base)) warnings.push(`migration number ${n} is also added by open PR ${list.map((x) => `#${x}`).join(', ')}: the one that merges second must take another number`)
      } catch { /* gh answered with something else: skip */ }
    }
  }

  for (const w of warnings) console.log(`warning: ${w}`)
  console.log(failed.length ? `check:prepush FAILED: ${failed.join(', ')} (${((Date.now() - t0) / 1000).toFixed(0)}s)` : `check:prepush OK (${((Date.now() - t0) / 1000).toFixed(0)}s); CI also runs the native build and all unit tests`)
  process.exit(failed.length ? 1 : 0)
}
