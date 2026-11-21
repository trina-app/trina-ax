// CI: run one shard of the unit tests (tests/unit) and the security tests (tests/security: the permission matrix,
// realtime resume and leaks, …), so they run as several jobs at once (.github/workflows/ci.yml "unit", the required
// check). Every test file goes to exactly one shard; a security file that cannot run on a Linux runner is in
// CI_SKIPPED below with its reason, and every shard prints that list (never left out silently). The files are spread by how long each
// took in earlier CI runs (scripts/ci/unit-times.json, seconds per file; refresh it with
// `bun scripts/ci/unit-shard.ts --times <CI job logs of the unit step...>`, the median per file): the longest first, each to the shard with the least time
// so far (a file not in the list counts as the median). The split depends only on the file list and the times, so
// every job of the same commit computes the same split.
//   bun scripts/ci/unit-shard.ts <index> <total>     run shard <index> (1-based) of <total>
//   bun scripts/ci/unit-shard.ts --plan <total>      print the split and each shard's expected seconds
//   bun scripts/ci/unit-shard.ts --times <log>...    write unit-times.json from CI logs of the unit test step (every
//                                                    shard's log of a few runs: each file's median, so one slow runner
//                                                    does not skew the split)
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const TIMES = path.join(import.meta.dir, 'unit-times.json')

/** The folders whose test files CI runs in the shards. tests/security was missing until TC-3846: a realtime security
 * regression went unnoticed on dev for 11 days. */
export const TEST_DIRS = ['tests/unit', 'tests/security'] as const

/** Test files CI does not run, each with the reason (printed by every shard). Files that guard only some of their
 * tests with `describe.skipIf(!mac)` (macOS sandbox-exec, the login keychain) stay in: bun reports those as skipped. */
export const CI_SKIPPED: Readonly<Record<string, string>> = {}

/** Every unit and security test file CI runs, as a path from the repository root, sorted. */
export function unitFiles(root = ROOT): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== '__snapshots__' && e.name !== 'node_modules') walk(rel) }
      else if (/\.test\.tsx?$/.test(e.name)) out.push(rel)
    }
  }
  for (const d of TEST_DIRS) walk(d)
  return out.filter((f) => !(f in CI_SKIPPED)).sort()
}

/** The files split into `total` shards, the longest first onto the shard with the least expected time. */
export function split(files: readonly string[], times: Readonly<Record<string, number>>, total: number): { files: string[]; seconds: number }[] {
  const known = files.map((f) => times[f]).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
  const median = known.length ? known[Math.floor(known.length / 2)]! : 1
  const weight = (f: string) => times[f] ?? median
  const shards = Array.from({ length: total }, () => ({ files: [] as string[], seconds: 0 }))
  const order = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))
  for (const f of order) {
    let best = shards[0]!
    for (const s of shards) if (s.seconds < best.seconds) best = s
    best.files.push(f)
    best.seconds += weight(f)
  }
  for (const s of shards) { s.files.sort(); s.seconds = Math.round(s.seconds) }
  return shards
}

/** Seconds per test file from a GitHub Actions log of `bun test`: from one file's header to the next. */
export function timesFromLog(log: string): Record<string, number> {
  const marks: { file: string; at: number }[] = []
  let end = 0
  for (const line of log.split('\n')) {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+)Z (?:##\[group\])?(tests\/(?:unit|security)\/\S+\.test\.tsx?):$/.exec(line)
    if (m) marks.push({ file: m[2]!, at: Date.parse(`${m[1]!.slice(0, 23)}Z`) })
    const e = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+)Z\s+\d+ pass$/.exec(line)
    if (e) end = Date.parse(`${e[1]!.slice(0, 23)}Z`)
  }
  const out: Record<string, number> = {}
  marks.forEach((m, i) => {
    const next = marks[i + 1]?.at ?? end
    if (next >= m.at) out[m.file] = Math.round((next - m.at) / 100) / 10
  })
  return out
}

/** Each file's median seconds over several logs (a file in only some logs takes the median of those). */
export function timesFromLogs(logs: readonly string[]): Record<string, number> {
  const all: Record<string, number[]> = {}
  for (const log of logs) for (const [f, t] of Object.entries(timesFromLog(log))) (all[f] ??= []).push(t)
  const out: Record<string, number> = {}
  for (const [f, v] of Object.entries(all)) {
    v.sort((a, b) => a - b)
    const m = v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2
    out[f] = Math.round(m * 10) / 10
  }
  return out
}

if (import.meta.main) {
  const [a, b, ...rest] = process.argv.slice(2)
  const times = fs.existsSync(TIMES) ? (JSON.parse(fs.readFileSync(TIMES, 'utf8')) as Record<string, number>) : {}
  if (a === '--times') {
    const logs = [b!, ...rest]
    const t = timesFromLogs(logs.map((f) => fs.readFileSync(f, 'utf8')))
    fs.writeFileSync(TIMES, JSON.stringify(Object.fromEntries(Object.entries(t).sort(([x], [y]) => x.localeCompare(y))), null, 1) + '\n')
    console.log(`${Object.keys(t).length} files from ${logs.length} logs written to ${path.relative(ROOT, TIMES)}`)
  } else if (a === '--plan') {
    split(unitFiles(), times, Number(b)).forEach((s, i) => console.log(`shard ${i + 1}: ${s.files.length} files, ~${s.seconds}s`))
  } else {
    const index = Number(a), total = Number(b)
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
      console.error('usage: bun scripts/ci/unit-shard.ts <index> <total>')
      process.exit(2)
    }
    const files = unitFiles()
    const unknown = files.filter((f) => !(f in times)).length
    // never fails a run (a failing check would block the queue that the refresh has to go through): a warning only
    if (unknown > files.length * 0.2) console.log(`::warning::scripts/ci/unit-times.json has no time for ${unknown} of ${files.length} test files; the shards drift apart. Refresh it (docs/decisions/20261117-faster-full-run.md)`)
    const shard = split(files, times, total)[index - 1]!
    console.log(`unit + security tests, shard ${index}/${total}: ${shard.files.length} files, ~${shard.seconds}s expected`)
    for (const [f, why] of Object.entries(CI_SKIPPED)) console.log(`not run in CI: ${f} (${why})`)
    const p = Bun.spawnSync(['bun', 'test', ...shard.files.map((f) => `./${f}`)], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', env: process.env })
    process.exit(p.exitCode ?? 1)
  }
}
