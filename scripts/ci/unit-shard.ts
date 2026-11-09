// CI: run one shard of the unit tests (tests/unit), so the ~30 minutes of unit tests run as several jobs at once
// (.github/workflows/ci.yml "unit"). Every test file goes to exactly one shard. The files are spread by how long each
// took in an earlier CI run (scripts/ci/unit-times.json, seconds per file; refresh it with
// `bun scripts/ci/unit-shard.ts --times <a CI job log>`): the longest first, each to the shard with the least time
// so far (a file not in the list counts as the median). The split depends only on the file list and the times, so
// every job of the same commit computes the same split.
//   bun scripts/ci/unit-shard.ts <index> <total>     run shard <index> (1-based) of <total>
//   bun scripts/ci/unit-shard.ts --plan <total>      print the split and each shard's expected seconds
//   bun scripts/ci/unit-shard.ts --times <log>       write unit-times.json from a CI log of the unit test step
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const TIMES = path.join(import.meta.dir, 'unit-times.json')

/** Every unit test file, as a path from the repository root, sorted. */
export function unitFiles(root = ROOT): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== '__snapshots__' && e.name !== 'node_modules') walk(rel) }
      else if (/\.test\.tsx?$/.test(e.name)) out.push(rel)
    }
  }
  walk('tests/unit')
  return out.sort()
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
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+)Z (?:##\[group\])?(tests\/unit\/\S+\.test\.tsx?):$/.exec(line)
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

if (import.meta.main) {
  const [a, b] = process.argv.slice(2)
  const times = fs.existsSync(TIMES) ? (JSON.parse(fs.readFileSync(TIMES, 'utf8')) as Record<string, number>) : {}
  if (a === '--times') {
    const t = timesFromLog(fs.readFileSync(b!, 'utf8'))
    fs.writeFileSync(TIMES, JSON.stringify(Object.fromEntries(Object.entries(t).sort(([x], [y]) => x.localeCompare(y))), null, 1) + '\n')
    console.log(`${Object.keys(t).length} files written to ${path.relative(ROOT, TIMES)}`)
  } else if (a === '--plan') {
    split(unitFiles(), times, Number(b)).forEach((s, i) => console.log(`shard ${i + 1}: ${s.files.length} files, ~${s.seconds}s`))
  } else {
    const index = Number(a), total = Number(b)
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
      console.error('usage: bun scripts/ci/unit-shard.ts <index> <total>')
      process.exit(2)
    }
    const shard = split(unitFiles(), times, total)[index - 1]!
    console.log(`unit tests, shard ${index}/${total}: ${shard.files.length} files, ~${shard.seconds}s expected`)
    const p = Bun.spawnSync(['bun', 'test', ...shard.files.map((f) => `./${f}`)], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', env: process.env })
    process.exit(p.exitCode ?? 1)
  }
}
