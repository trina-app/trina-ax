// The summary of the web e2e run on a dev push (.github/workflows/feature-map.yml, job "summary"): reads the JSON report
// that `playwright merge-reports` made from every shard's blob report and writes a short Markdown summary (totals, then
// each failing spec:line with its first error line). The workflow puts it in $GITHUB_STEP_SUMMARY and, on a red run, in
// the one open issue labelled web-e2e-dev.
//
//   bun scripts/ci/web-e2e-summary.ts <merged report.json> --shards <expected> --blobs <found> [--date YYYY-MM-DD]
//     [--sha <commit>] [--run <url>] [--jobs <needs.e2e.result>] [--out <summary.md>]
//
// Prints the Markdown; with --out also writes it there. Appends `status=green|red`, `failing=<n>` and `title=<issue
// title>` to $GITHUB_OUTPUT when that is set. Exit 0 even on a red run: the shard jobs already fail the run.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { failuresOf, type JsonReport } from '../features/e2e-failures'

export interface SummaryInput {
  report: JsonReport | null
  /** shards the matrix ran */
  shards: number
  /** blob reports that reached the summary job (a shard that crashed before the end leaves none) */
  blobs: number
  date: string
  sha?: string
  run?: string
  /** the shard jobs' result (needs.e2e.result); anything but success makes the run red, even with no failing test */
  jobs?: string
}

export interface E2eSummary { status: 'green' | 'red', failing: number, title: string, markdown: string }

/** an issue body may hold 65536 characters; the list stops well before that */
export const MAX_LISTED = 150

const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 220)
/** an error line as a code span: page text such as "@name" or "#12" must not ping a person or link an issue on every run */
export const code = (s: string) => '`' + clean(s).replace(/`/g, "'") + '`'

export function e2eSummary(input: SummaryInput): E2eSummary {
  const { report, shards, blobs, date } = input
  const failures = report ? failuresOf(report) : []
  const errors = (report?.errors ?? []).map((e) => clean((e.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) ?? '')).filter(Boolean)
  const missing = Math.max(0, shards - blobs)
  const st = report?.stats
  const jobsFailed = input.jobs !== undefined && input.jobs !== 'success'
  const red = !report || failures.length > 0 || errors.length > 0 || missing > 0 || (st?.unexpected ?? 0) > 0 || jobsFailed
  const failing = failures.length
  const short = input.sha ? input.sha.slice(0, 9) : ''
  const title = `Web e2e on dev: ${failing} failing (${date}${short ? `, ${short}` : ''})`
  const head = [`## ${red ? '❌' : '✅'} Web e2e on dev, ${date}${short ? ` (\`${short}\`)` : ''}`, '']
  const lines = [...head]
  if (st) lines.push(`**${failing} failing** · ${st.expected} passed · ${st.flaky} flaky · ${st.skipped} skipped · ${blobs}/${shards} shards reported`)
  else lines.push(`**No merged report** · ${blobs}/${shards} shards reported: the shards stopped before Playwright wrote a report; see the job logs.`)
  if (missing > 0 && st) lines.push('', `⚠️ ${missing} shard(s) sent no report, so their tests are missing from the totals above (see the shard job's log).`)
  if (jobsFailed && !failures.length) lines.push('', `⚠️ The shard jobs ended \`${input.jobs}\` with no failing test: a setup step or a time-out (see the shard jobs' logs).`)
  if (input.run) lines.push('', `Run, HTML report and traces: ${input.run}`)
  if (failures.length) {
    lines.push('', '### Failing tests', '')
    for (const f of failures.slice(0, MAX_LISTED)) lines.push(`- \`${f.where}\`${f.project ? ` (${f.project})` : ''}: ${f.error.trim() ? code(f.error) : f.status}`)
    if (failures.length > MAX_LISTED) lines.push(`- … and ${failures.length - MAX_LISTED} more (see the HTML report)`)
  }
  if (errors.length) lines.push('', '### Errors outside a test', '', ...errors.map((e) => `- ${code(e)}`))
  lines.push(
    '',
    '<sub>Runs on Linux (ubuntu-24.04) with Roboto as the phone font (web/test/e2e/fonts/phone-font.conf). Specs that measure sizes',
    '(phone-targets, the 44 px tap checks) are not skipped here: a failure that does not happen on a Mac may come from the',
    'runner\'s fonts or pixels, so rerun it on a Mac before calling it a regression.</sub>',
    '',
  )
  return { status: red ? 'red' : 'green', failing, title, markdown: lines.join('\n') }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const file = args[0]
  const shards = Number(flag(args, '--shards'))
  const blobs = Number(flag(args, '--blobs'))
  if (!file || file.startsWith('--') || !Number.isInteger(shards) || !Number.isInteger(blobs)) {
    console.error('usage: bun scripts/ci/web-e2e-summary.ts <report.json> --shards <n> --blobs <n> [--date d] [--sha s] [--run url] [--out file]')
    process.exit(2)
  }
  let report: JsonReport | null = null
  if (existsSync(file)) {
    try { report = JSON.parse(readFileSync(file, 'utf8')) as JsonReport } catch { report = null }
  }
  const date = flag(args, '--date') ?? new Date().toISOString().slice(0, 10)
  const s = e2eSummary({ report, shards, blobs, date, sha: flag(args, '--sha'), run: flag(args, '--run'), jobs: flag(args, '--jobs') })
  const out = flag(args, '--out')
  if (out) writeFileSync(out, s.markdown)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${s.status}\nfailing=${s.failing}\ntitle=${s.title}\n`)
  process.stdout.write(s.markdown)
}
