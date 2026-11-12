// The run summary of one e2e shard of the Feature map workflow (.github/workflows/feature-map.yml): reads Playwright's
// JSON report and writes the tests that failed (failed, timed out, interrupted) as Markdown, for $GITHUB_STEP_SUMMARY.
// The workflow fails the shard by Playwright's own exit code; this only names what failed.
// Run: bun scripts/features/e2e-failures.ts <report.json> [shard label]   (prints Markdown; exit 0 even when tests failed)
import { existsSync, readFileSync } from 'node:fs'

interface JsonTest { projectName: string; status: 'skipped' | 'expected' | 'unexpected' | 'flaky'; results: { status?: string; error?: { message?: string } }[] }
interface JsonSpec { title: string; file: string; line: number; tests: JsonTest[] }
interface JsonSuite { title: string; file: string; specs?: JsonSpec[]; suites?: JsonSuite[] }
export interface JsonReport { suites?: JsonSuite[]; errors?: { message?: string }[]; stats?: { expected: number; unexpected: number; flaky: number; skipped: number } }

export interface Failure { project: string; where: string; title: string; status: string; error: string }

/** The tests of a report that did not end as expected, in report order (a describe block's titles joined with ›). */
export function failuresOf(report: JsonReport): Failure[] {
  const out: Failure[] = []
  const walk = (suite: JsonSuite, path: string[]) => {
    // the file's own suite has the file name as its title; describe blocks under it add theirs
    const titles = suite.title && suite.title !== suite.file ? [...path, suite.title] : path
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        if (t.status !== 'unexpected') continue
        const last = t.results[t.results.length - 1]
        const firstLine = (last?.error?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) ?? ''
        out.push({ project: t.projectName, where: `${spec.file}:${spec.line}`, title: [...titles, spec.title].join(' › '), status: last?.status ?? 'failed', error: firstLine.trim() })
      }
    }
    for (const s of suite.suites ?? []) walk(s, titles)
  }
  for (const s of report.suites ?? []) walk(s, [])
  return out
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 200)

/** Markdown for the run summary: a count line, then a table of the failed tests (or a line saying none failed). */
export function summaryMarkdown(report: JsonReport | null, label: string): string {
  if (!report) return `### e2e ${label}: no report\n\nPlaywright wrote no JSON report (the run stopped before it ended); see the job log.\n`
  const failures = failuresOf(report)
  const st = report.stats
  const counts = st ? `${st.expected} passed, ${st.unexpected} failed, ${st.flaky} flaky, ${st.skipped} skipped` : `${failures.length} failed`
  const errors = (report.errors ?? []).map((e) => (e.message ?? '').split('\n')[0]).filter(Boolean)
  const lines = [`### e2e ${label}: ${failures.length || errors.length ? '❌' : '✅'} ${counts}`, '']
  if (failures.length) {
    lines.push('| Spec | Test | Status | First error line |', '| --- | --- | --- | --- |')
    for (const f of failures) lines.push(`| \`${cell(f.where)}\`${f.project ? ` (${cell(f.project)})` : ''} | ${cell(f.title)} | ${f.status} | ${cell(f.error)} |`)
    lines.push('')
  }
  if (errors.length) lines.push('Errors outside a test:', '', ...errors.map((e) => `- ${cell(e)}`), '')
  return lines.join('\n')
}

if (import.meta.main) {
  const [file, label = ''] = process.argv.slice(2)
  if (!file) {
    console.error('usage: bun scripts/features/e2e-failures.ts <report.json> [label]')
    process.exit(2)
  }
  let report: JsonReport | null = null
  if (existsSync(file)) {
    try { report = JSON.parse(readFileSync(file, 'utf8')) as JsonReport } catch { report = null }
  }
  process.stdout.write(summaryMarkdown(report, label))
}
