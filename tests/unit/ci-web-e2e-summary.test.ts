// The web e2e summary of the Feature map workflow (.github/workflows/feature-map.yml, job "summary") and its script
// (scripts/ci/web-e2e-summary.ts): on a dev push, after the shards, it keeps one issue labelled web-e2e-dev open while
// dev is red. Only that job may write issues, and only a run whose shards all ran to the end touches the issue.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_LISTED, e2eSummary } from '../../scripts/ci/web-e2e-summary'
import type { JsonReport } from '../../scripts/features/e2e-failures'

const ROOT = path.resolve(import.meta.dir, '..', '..')
type Step = { id?: string, name?: string, uses?: string, if?: string, run?: string, with?: Record<string, unknown>, env?: Record<string, string> }
type Job = { name?: string, 'runs-on'?: string, needs?: string[] | string, if?: string, permissions?: Record<string, string>, strategy?: { 'fail-fast'?: boolean, matrix?: { shard?: number[] } }, steps?: Step[] }
type Workflow = { on: Record<string, unknown>, permissions?: Record<string, string>, concurrency?: { group?: string, 'cancel-in-progress'?: boolean }, env?: Record<string, string | number>, jobs: Record<string, Job> }
const wf = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/feature-map.yml'), 'utf8')) as Workflow

describe('feature-map.yml: the web e2e summary on dev', () => {
  test('a dev push only for paths that can change the web e2e result or the feature map, and by hand', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch'])
    const push = wf.on.push as { branches: string[], paths: string[] }
    expect(push.branches).toEqual(['dev'])
    for (const p of ['web/**', 'shared/**', 'server/**', 'resources/**', 'scripts/release-notices.ts', 'versions.json', 'package.json', 'bun.lock', '.github/workflows/feature-map.yml', 'docs/features.ts', 'scripts/features/**', 'scripts/ci/web-e2e-summary.ts']) expect(push.paths).toContain(p)
    // every file the mock team server and the specs import from outside web/ is under a listed path
    const outside = new Set<string>()
    for (const dir of ['web/test/mock', 'web/test/e2e']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]) {
        if (!/\.(ts|tsx)$/.test(f)) continue
        const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8')
        for (const m of src.matchAll(/from '((?:\.\.\/)+[^']+)'/g)) {
          const rel = path.relative(ROOT, path.resolve(ROOT, dir, path.dirname(f), m[1]!))
          if (!rel.startsWith('web/')) outside.add(rel)
        }
      }
    }
    expect(outside.size).toBeGreaterThan(0)
    const globs = push.paths.map((p) => new Bun.Glob(p))
    for (const rel of outside) expect({ rel, listed: globs.some((g) => g.match(rel) || g.match(`${rel}.ts`) || g.match(`${rel}/index.ts`)) }).toEqual({ rel, listed: true })
  })

  test('one run at a time, never cancelled half way: every run finishes, a newer push replaces the waiting one', () => {
    expect(wf.concurrency).toEqual({ group: 'feature-map-${{ github.ref_name }}', 'cancel-in-progress': false })
    expect(wf.permissions).toEqual({ contents: 'read' })
    for (const [id, job] of Object.entries(wf.jobs)) {
      if (id === 'summary') expect(job.permissions).toEqual({ contents: 'read', issues: 'write' })
      else expect({ id, permissions: job.permissions }).toEqual({ id, permissions: undefined })
      expect(job['runs-on']).toBe('ubuntu-24.04')
    }
  })

  test('the shards write a blob report; a cancelled shard uploads none', () => {
    const e2e = wf.jobs.e2e!
    expect(e2e.strategy!['fail-fast']).toBe(false)
    expect(e2e.strategy!.matrix!.shard).toEqual([1, 2, 3, 4])
    const st = e2e.steps!.find((s) => s.run?.includes('playwright test'))!
    expect(st.run).toContain('--shard=${{ matrix.shard }}/4')
    expect(st.run).toContain('blob')
    expect(st.run).not.toContain('--workers')
    expect(fs.readFileSync(path.join(ROOT, 'web/playwright.config.ts'), 'utf8')).toMatch(/^\s*workers: 1,$/m)
    expect(st.env!.PLAYWRIGHT_BLOB_OUTPUT_FILE).toContain('report-${{ matrix.shard }}.zip')
    const blob = e2e.steps!.find((s) => s.with?.name === 'blob-report-${{ matrix.shard }}')!
    expect(blob.if).toBe('${{ !cancelled() }}')
  })

  test('the Features tab is written from dev only (a manual run of another branch runs beside dev)', () => {
    expect(wf.jobs.sheet!.if).toBe("${{ !cancelled() && github.ref == 'refs/heads/dev' }}")
  })

  test('the summary: dev pushes only, and only when every shard ran to the end', () => {
    const job = wf.jobs.summary!
    expect(job.needs).toBe('e2e')
    for (const part of ['!cancelled()', "github.event_name == 'push'", "github.ref == 'refs/heads/dev'", "needs.e2e.result == 'success' || needs.e2e.result == 'failure'"]) expect(job.if).toContain(part)
    expect(job.steps!.find((s) => s.id === 'sum')!.run).toContain('--shards 4')
  })
})

const report = (fails: { file: string, line: number, msg: string }[], stats = { expected: 10, unexpected: fails.length, flaky: 0, skipped: 2 }): JsonReport => ({
  stats,
  suites: [{
    title: 'a.spec.ts', file: 'a.spec.ts',
    specs: fails.map((f) => ({ title: 't', file: f.file, line: f.line, tests: [{ projectName: 'chromium', status: 'unexpected' as const, results: [{ status: 'failed', error: { message: `\u001b[31m${f.msg}\u001b[39m\n  at x` } }] }] })),
  }],
})

describe('the summary', () => {
  test('green: every shard reported, nothing failed', () => {
    const s = e2eSummary({ report: report([]), shards: 8, blobs: 8, date: '2026-11-17', jobs: 'success' })
    expect(s.status).toBe('green')
    expect(s.title).toBe('Web e2e on dev: 0 failing (2026-11-17)')
    expect(s.markdown).toContain('**0 failing** · 10 passed · 0 flaky · 2 skipped · 8/8 shards reported')
  })

  test('red: each failing spec:line with its first error line, the Linux font note, the run link', () => {
    const s = e2eSummary({ report: report([{ file: 'rail.spec.ts', line: 122, msg: 'Error: expected 3' }]), shards: 8, blobs: 8, date: '2026-11-17', run: 'https://x/run/1', sha: 'abcdef0123456789' })
    expect(s.status).toBe('red')
    expect(s.failing).toBe(1)
    expect(s.title).toBe('Web e2e on dev: 1 failing (2026-11-17, abcdef012)')
    expect(s.markdown).toContain('- `rail.spec.ts:122` (chromium): `Error: expected 3`')
    expect(s.markdown).toContain('Web e2e on dev, 2026-11-17 (`abcdef012`)')
    expect(s.markdown).toContain('https://x/run/1')
    expect(s.markdown).toContain('phone-targets')
  })

  test('an error line that quotes @someone or #12 stays inside a code span', () => {
    const s = e2eSummary({ report: report([{ file: 'x.spec.ts', line: 1, msg: 'Error: saw `@olga` in #12' }]), shards: 8, blobs: 8, date: 'd' })
    expect(s.markdown).toContain("- `x.spec.ts:1` (chromium): `Error: saw '@olga' in #12`")
  })

  test('red without a failing test: a shard sent no report, a shard job failed, or no report at all', () => {
    expect(e2eSummary({ report: report([]), shards: 8, blobs: 7, date: 'd' }).markdown).toContain('1 shard(s) sent no report')
    const jobs = e2eSummary({ report: report([]), shards: 8, blobs: 8, date: 'd', jobs: 'failure' })
    expect(jobs.status).toBe('red')
    expect(jobs.markdown).toContain('`failure` with no failing test')
    const none = e2eSummary({ report: null, shards: 8, blobs: 0, date: 'd' })
    expect(none.status).toBe('red')
    expect(none.markdown).toContain('No merged report')
  })

  test('a long list stops so the issue body stays under GitHub\'s limit', () => {
    const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) => ({ file: 'x.spec.ts', line: i + 1, msg: 'E'.repeat(400) }))
    const s = e2eSummary({ report: report(many), shards: 8, blobs: 8, date: 'd' })
    expect(s.markdown).toContain('… and 5 more')
    expect(s.markdown.length).toBeLessThan(65536)
  })
})

describe('the issue step (gh stubbed)', () => {
  const issue = wf.jobs.summary!.steps!.find((s) => s.id === 'issue')!
  /** runs the step's script with a fake gh that answers `issue list` with `open` and logs every call */
  function run(status: string, open: string, body = 'summary', oldTitle = 'Web e2e on dev: 1 failing (c, zzz)') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-e2e-'))
    fs.writeFileSync(path.join(dir, 'summary.md'), body)
    const log = path.join(dir, 'calls')
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/bash\necho "$*" >> "${log}"\nif [ "$1 $2" = "issue list" ]; then printf '%s' "${open}"; fi\nif [ "$1 $2" = "issue view" ]; then printf '%s' "${oldTitle}"; fi\n`, { mode: 0o755 })
    const r = spawnSync('bash', ['-e', '-c', issue.run!], { env: { PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, RUNNER_TEMP: dir, STATUS: status, TITLE: 'Web e2e on dev: 2 failing (d, abc)', SHA: 'abcdef0123456789', RUN_URL: 'https://x/run/1' }, encoding: 'utf8' })
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => !l.startsWith('label ') && !l.startsWith('issue list') && !l.startsWith('issue view')) : []
    fs.rmSync(dir, { recursive: true, force: true })
    return { status: r.status, calls: calls.map((c) => c.replace(dir, '$T')) }
  }

  test('red and none open: opens one with the label', () => {
    expect(run('red', '')).toEqual({ status: 0, calls: ['issue create --title Web e2e on dev: 2 failing (d, abc) --label web-e2e-dev --body-file $T/summary.md'] })
  })

  test('red with one open: updates that one, never a second; a comment only when the count changed', () => {
    expect(run('red', '42')).toEqual({ status: 0, calls: ['issue edit 42 --title Web e2e on dev: 2 failing (d, abc) --body-file $T/summary.md', 'issue comment 42 --body Web e2e on dev: 2 failing (d, abc): https://x/run/1'] })
    expect(run('red', '42', 'summary', 'Web e2e on dev: 2 failing (c, zzz)')).toEqual({ status: 0, calls: ['issue edit 42 --title Web e2e on dev: 2 failing (d, abc) --body-file $T/summary.md'] })
  })

  test('green closes every open one', () => {
    const r = run('green', '42\n43')
    expect(r.calls).toHaveLength(2)
    expect(r.calls[1]).toMatch(/^issue close 43 /)
  })

  test('green closes the open one; green with none open does nothing', () => {
    const closed = run('green', '42')
    expect(closed.calls).toHaveLength(1)
    expect(closed.calls[0]).toMatch(/^issue close 42 --comment Green again on \d{4}-\d{2}-\d{2} \(abcdef012\): https:\/\/x\/run\/1$/)
    expect(run('green', '')).toEqual({ status: 0, calls: [] })
  })

  test('a failed summary step still reports red', () => {
    const r = run('', '', '')
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]).toMatch(/^issue create --title Web e2e on dev: summary failed \(\d{4}-\d{2}-\d{2}, abcdef012\) --label web-e2e-dev/)
  })
})
