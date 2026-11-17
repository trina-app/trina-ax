// dev's merge queue (docs/decisions/20261117-merge-queue.md, QA TC-4555): the check the dev ruleset requires must
// report on a queued entry (merge_group), or every queued pull request waits until the queue's time-out and is
// removed. A pull request to dev runs the quick jobs only; the queue runs the rest. Jobs that are not required on dev
// (the phone app, the Linux jobs, desktop.yml's macOS / Windows jobs) never hold up a queued entry.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const REQUIRED = 'typecheck, native, unit, fast fuzz, web, relay'
type Job = { name?: string; needs?: string[] | string; if?: string; steps?: { id?: string; run?: string; env?: Record<string, string> }[] }
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> }
const load = (f: string) => Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8')) as Workflow
const ci = load('ci.yml')

/** run one of ci.yml's bash scripts with the given environment; its stdout, or null when it fails */
function sh(script: string, env: Record<string, string>): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-mq-'))
  const file = path.join(dir, 'step.sh')
  fs.writeFileSync(file, script)
  const r = spawnSync('bash', [file], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  return r.status === 0 ? r.stdout : null
}

describe('the required check reports on every event', () => {
  test('ci.yml runs on merge_group (checks_requested) beside pull_request and push', () => {
    expect(Object.keys(ci.on)).toEqual(expect.arrayContaining(['push', 'pull_request', 'merge_group', 'workflow_dispatch', 'workflow_call']))
    expect(ci.on.merge_group).toEqual({ types: ['checks_requested'] })
    // the default types only (opened, synchronize, reopened): a label event would cancel and restart the run and flash
    // a red required check; the full suite on demand is `gh workflow run ci.yml --ref <branch>` (workflow_dispatch)
    expect(ci.on.pull_request).toBeNull()
    expect('workflow_dispatch' in ci.on).toBe(true)
    expect(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')).not.toContain('full-ci')
  })

  test('the job with the required name always runs and needs only the scope, docs and build/test jobs', () => {
    const [id, job] = Object.entries(ci.jobs).find(([, j]) => j.name === REQUIRED)!
    expect(id).toBe('check')
    expect(job.if).toContain('always()')
    expect(job.needs).toEqual(['scope', 'docs', 'static', 'unit', 'other'])
    // no job-level if on scope: it must run on merge_group too, or the check fails on the scope result
    expect(ci.jobs.scope!.if).toBeUndefined()
  })

  test('the Linux jobs run on neither a pull request nor a queued entry; the phone app typecheck runs everywhere', () => {
    for (const id of ['linux-docker', 'linux-bundle', 'linux-install']) {
      expect(ci.jobs[id]!.if).toBe("github.event_name != 'pull_request' && github.event_name != 'merge_group'")
    }
    // its own job except on a queued entry, where "typecheck, docs, native" runs the same steps (one job fewer)
    expect(ci.jobs.mobile!.if).toBe("github.event_name != 'merge_group'")
    const own = (ci.jobs.mobile!.steps ?? []).map((x) => x.run).filter(Boolean)
    const inStatic = (ci.jobs.static!.steps ?? []).filter((x) => (x as { if?: string }).if?.startsWith("github.event_name == 'merge_group'"))
    expect(inStatic.map((x) => x.run).filter(Boolean)).toEqual(own)
  })

  test('no workflow with macOS or Windows jobs runs on merge_group (hosted macOS runners are short)', () => {
    for (const f of ['desktop.yml', 'mac-whisper.yml', 'msstore.yml', 'mac-app.yml', 'release.yml']) {
      expect({ f, mergeGroup: 'merge_group' in load(f).on }).toEqual({ f, mergeGroup: false })
    }
  })
})

describe('which jobs run in which mode', () => {
  const diff = ci.jobs.scope!.steps!.find((s) => s.id === 'diff')!
  // the mode part of the scope step (no git): from "mode=full" to the outputs
  const modeScript = `${diff.run!.slice(diff.run!.indexOf('mode=full'), diff.run!.indexOf('echo "docs_only'))}echo "$mode"\n`
  const mode = (env: Record<string, string>) =>
    sh(modeScript, { EVENT: '', REF: '', ACTOR: 'someone', BASE_REF: '', CALLED: 'false', MERGE_QUEUE: 'on', ...env })?.trim()

  test('quick on a pull request to dev only while MERGE_QUEUE is on: until the ruleset has the queue, full', () => {
    expect(mode({ EVENT: 'pull_request', REF: 'refs/pull/7/merge', BASE_REF: 'dev', MERGE_QUEUE: '' })).toBe('full')
    expect(mode({ EVENT: 'pull_request', REF: 'refs/pull/7/merge', BASE_REF: 'dev', MERGE_QUEUE: 'off' })).toBe('full')
  })

  test('quick on a pull request to dev, full to main, on a queued entry and on a manual run of a branch', () => {
    expect(mode({ EVENT: 'pull_request', REF: 'refs/pull/7/merge', BASE_REF: 'dev' })).toBe('quick')
    expect(mode({ EVENT: 'workflow_dispatch', REF: 'refs/heads/fix/risky' })).toBe('full')
    expect(mode({ EVENT: 'pull_request', REF: 'refs/pull/7/merge', BASE_REF: 'main' })).toBe('full')
    expect(mode({ EVENT: 'merge_group', REF: 'refs/heads/gh-readonly-queue/dev/pr-7-abc', ACTOR: 'github-merge-queue[bot]' })).toBe('full')
  })

  test("tested only for the queue's own push to dev; any other push, a manual run and a release's call are full", () => {
    expect(mode({ EVENT: 'push', REF: 'refs/heads/dev', ACTOR: 'github-merge-queue[bot]' })).toBe('tested')
    expect(mode({ EVENT: 'push', REF: 'refs/heads/dev', ACTOR: 'trina-app-admin' })).toBe('full')
    expect(mode({ EVENT: 'push', REF: 'refs/heads/main', ACTOR: 'github-merge-queue[bot]' })).toBe('full')
    expect(mode({ EVENT: 'workflow_dispatch', REF: 'refs/heads/dev', ACTOR: 'github-merge-queue[bot]' })).toBe('full')
    expect(mode({ EVENT: 'push', REF: 'refs/heads/dev', ACTOR: 'github-merge-queue[bot]', CALLED: 'true' })).toBe('full')
  })

  test('the job conditions follow the mode', () => {
    expect(ci.jobs.static!.if).toBe("needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.mode != 'tested'")
    for (const id of ['unit', 'other']) {
      expect(ci.jobs[id]!.if).toBe("needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.mode == 'full'")
    }
  })

  test('the required check passes only when the jobs of its mode passed', () => {
    const run = ci.jobs.check!.steps![0]!.run!
    const check = (DOCS_ONLY: string, MODE: string, DOCS: string, STATIC: string, HEAVY: string, SCOPE = 'success') =>
      sh(run, { DOCS_ONLY, MODE, SCOPE, DOCS, STATIC, HEAVY }) !== null
    expect(check('false', 'quick', 'skipped', 'success', 'skipped skipped')).toBe(true)
    expect(check('false', 'quick', 'skipped', 'failure', 'skipped skipped')).toBe(false)
    expect(check('false', 'quick', 'skipped', 'success', 'success skipped')).toBe(false)
    expect(check('false', 'full', 'skipped', 'success', 'success success')).toBe(true)
    expect(check('false', 'full', 'skipped', 'success', 'failure success')).toBe(false)
    // a heavy job skipped in a full run (a queued entry) is a failure, never a pass
    expect(check('false', 'full', 'skipped', 'success', 'skipped success')).toBe(false)
    expect(check('false', 'full', 'skipped', 'cancelled', 'success success')).toBe(false)
    expect(check('false', 'tested', 'skipped', 'skipped', 'skipped skipped')).toBe(true)
    expect(check('true', 'full', 'success', 'skipped', 'skipped skipped')).toBe(true)
    expect(check('true', 'full', 'failure', 'skipped', 'skipped skipped')).toBe(false)
    expect(check('false', 'full', 'skipped', 'success', 'success success', 'failure')).toBe(false)
    expect(check('false', '', 'skipped', 'success', 'success success')).toBe(false)
  })
})

describe('the queue settings', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/decisions/20261117-merge-queue.md'), 'utf8')
  const block = /\*\*Queue settings\*\*[\s\S]*?```json\n([\s\S]*?)```/.exec(doc)?.[1]

  test('grouping stays ALLGREEN with merge commits: the docs-only shortcut on merge_group needs every entry to pass', () => {
    // merge_group.base_sha is the entry's parent (the entry ahead). With HEADGREEN a failing code entry followed by a
    // docs-only entry could land on the doc checks alone, so changing this means removing that shortcut first.
    expect(block).toBeDefined()
    const s = JSON.parse(block!) as Record<string, unknown>
    expect(s).toEqual({
      merge_method: 'MERGE',
      grouping_strategy: 'ALLGREEN',
      max_entries_to_build: 2,
      max_entries_to_merge: 5,
      min_entries_to_merge: 1,
      min_entries_to_merge_wait_minutes: 5,
      check_response_timeout_minutes: 60,
    })
    const scope = ci.jobs.scope!.steps!.find((x) => x.id === 'diff')!.run!
    expect(scope).toContain('merge_group.base_sha is the entry\'s PARENT')
    expect(scope).toContain('ALLGREEN')
  })
})
