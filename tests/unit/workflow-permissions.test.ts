// Called workflows stay within their caller's token grant (scripts/ci/workflow-permissions.ts). The v0.5.19 release run
// (44517924801) ended in startup_failure because ci.yml, called by release.yml with `contents: read`, had a job asking
// for `issues: write` (the T1 alert). That job is now its own workflow_run workflow (t1-alert.yml).
import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { excess, grantOf, loadWorkflows, problems, type Workflow } from '../../scripts/ci/workflow-permissions'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const all = loadWorkflows(ROOT)

describe('called workflows fit their caller\'s permissions', () => {
  test('every uses: ./.github/workflows/… call in the repository', () => {
    expect(problems(all)).toEqual([])
  })

  test('the calls the releases make are still there (the check is not empty)', () => {
    const calls = Object.entries(all).flatMap(([f, wf]) => Object.entries(wf.jobs ?? {})
      .filter(([, j]) => typeof j.uses === 'string' && j.uses.startsWith('./.github/workflows/')).map(([id, j]) => `${f}:${id}→${j.uses}`))
    expect(calls).toEqual(expect.arrayContaining(['release.yml:test→./.github/workflows/ci.yml', 'msstore.yml:test→./.github/workflows/ci.yml']))
  })

  test('ci.yml asks for contents: read and nothing else, so release.yml\'s test job can call it', () => {
    const ci = all['ci.yml']!
    expect(grantOf(ci.permissions)).toEqual({ contents: 1 })
    for (const [id, job] of Object.entries(ci.jobs ?? {})) {
      expect({ id, excess: excess(grantOf(job.permissions) ?? {}, { contents: 1 }) }).toEqual({ id, excess: [] })
    }
    const release = all['release.yml']!
    expect(grantOf(release.jobs!.test!.permissions) ?? grantOf(release.permissions)).toEqual({ contents: 1 })
    expect(problems(all).filter((p) => p.includes('ci.yml'))).toEqual([])
  })

  test('it catches the 0.5.19 case: a ci.yml job asking for issues: write under a contents: read caller', () => {
    const ci = structuredClone(all['ci.yml']!) as Workflow
    ci.jobs!['t1-alert'] = { permissions: { contents: 'read', actions: 'read', issues: 'write' } }
    expect(problems({ ...all, 'ci.yml': ci }).sort()).toEqual([
      'ci.yml job t1-alert, called by release.yml job test: actions: read > none',
      'ci.yml job t1-alert, called by release.yml job test: issues: write > none',
      'ci.yml job t1-alert, called by msstore.yml job test: actions: read > none',
      'ci.yml job t1-alert, called by msstore.yml job test: issues: write > none',
    ].sort())
  })

  test('callee workflow-level permissions, nested calls, write-all and a missing grant', () => {
    const wfs: Record<string, Workflow> = {
      'a.yml': { permissions: { contents: 'read' }, jobs: { call: { uses: './.github/workflows/b.yml', permissions: { contents: 'write', 'id-token': 'write' } } } },
      'b.yml': { permissions: { contents: 'write' }, jobs: { x: {}, y: { permissions: 'write-all' }, z: { uses: './.github/workflows/c.yml' } } },
      'c.yml': { jobs: { w: { permissions: { packages: 'read', 'id-token': 'write' } } } },
      'd.yml': { jobs: { call: { uses: './.github/workflows/c.yml' } } },
    }
    const found = problems(wfs)
    expect(found).toContain('b.yml job y, called by a.yml job call: actions: write > none')
    expect(found).not.toContain(expect.stringContaining('b.yml job x'))
    // c.yml's job w is called through b.yml's job z, which has b.yml's workflow grant (contents: write)
    expect(found).toContain('c.yml job w, called by b.yml job z: packages: read > none')
    expect(found).toContain('c.yml job w, called by b.yml job z: id-token: write > none')
    expect(found).toContain('d.yml job call calls c.yml without a permissions: grant (job or workflow level)')
    expect(problems({ 'a.yml': { permissions: { contents: 'read' }, jobs: { c: { uses: './.github/workflows/b.yml' } } }, 'b.yml': { permissions: { issues: 'write' }, jobs: { x: {} } } }))
      .toContain('b.yml (workflow permissions), called by a.yml job c: issues: write > none')
  })
})

describe('the T1 alert runs after CI, on its own grant', () => {
  const t1 = all['t1-alert.yml'] as Workflow & { on: { workflow_run: unknown }; jobs: Record<string, { if?: string; steps?: { env?: Record<string, string> }[] }> }

  test('workflow_run on CI pushes to dev, with only actions read, contents read, issues write', () => {
    expect(t1.on.workflow_run).toEqual({ workflows: ['CI'], types: ['completed'], branches: ['dev'] })
    expect(all['ci.yml'] && (all['ci.yml'] as { name?: string }).name).toBe('CI')
    expect(grantOf(t1.permissions)).toEqual({ actions: 1, contents: 1, issues: 2 })
    expect(Object.keys(all['ci.yml']!.jobs!)).not.toContain('t1-alert')
  })

  test('it reads the CI run, not github.ref (always main under workflow_run)', () => {
    const job = t1.jobs['t1-alert']!
    expect(job.if).toContain("github.event.workflow_run.event == 'push'")
    expect(job.if).toContain("github.event.workflow_run.head_branch == 'dev'")
    expect(job.if).toContain('github.event.workflow_run.head_repository.full_name == github.repository')
    expect(job.if).not.toContain('github.ref')
    expect(job.steps![0]!.env).toMatchObject({ RUN_ID: '${{ github.event.workflow_run.id }}', SHA: '${{ github.event.workflow_run.head_sha }}' })
  })
})
