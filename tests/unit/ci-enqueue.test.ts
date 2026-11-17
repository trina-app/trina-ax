// scripts/ci/enqueue.ts (QA TC-4593): adds a PR to dev's merge queue through GraphQL. No network: gh is a fake runner.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { REQUIRED_CHECK, decide, enqueue, enqueueArgs, parseArgs, requiredCheckState, shaMatches, type Pr, type Runner } from '../../scripts/ci/enqueue'

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'
const ok = (c: string): Pr['statusCheckRollup'] => [{ name: REQUIRED_CHECK, status: 'COMPLETED', conclusion: c }]
const pr = (o: Partial<Pr> = {}): Pr => ({ id: 'PR_node', number: 7, state: 'OPEN', isDraft: false, baseRefName: 'dev', headRefOid: HEAD, statusCheckRollup: ok('SUCCESS'), ...o })

/** a fake gh: `pr view` answers the PR, the mutation answers `mutation` */
function fake(p: Partial<Pr> | { fail: string }, inQueue = false, mutation: { ok: boolean; stdout: string; stderr?: string } = { ok: true, stdout: '{"data":{"enqueuePullRequest":{"mergeQueueEntry":{"position":2,"state":"AWAITING_CHECKS"}}}}' }) {
  const calls: string[][] = []
  const run: Runner = (args) => {
    calls.push(args)
    if (args[0] === 'pr') return 'fail' in p ? { ok: false, stdout: '', stderr: p.fail } : { ok: true, stdout: JSON.stringify(pr(p)), stderr: '' }
    if (args.join(' ').includes('node(id')) return { ok: true, stdout: JSON.stringify({ data: { node: { isInMergeQueue: inQueue, mergeQueueEntry: inQueue ? { position: 1, state: 'QUEUED' } : null } } }), stderr: '' }
    return { ok: mutation.ok, stdout: mutation.stdout, stderr: mutation.stderr ?? '' }
  }
  return { run, calls }
}

describe('parseArgs', () => {
  test('number, sha, --jump in any order', () => {
    expect(parseArgs(['7'])).toEqual({ pr: 7, sha: null, jump: false })
    expect(parseArgs(['7', 'abcdef0'])).toEqual({ pr: 7, sha: 'abcdef0', jump: false })
    expect(parseArgs(['--jump', '7', HEAD])).toEqual({ pr: 7, sha: HEAD, jump: true })
    expect(parseArgs(['--help'])).toEqual({ help: true })
  })
  test('refuses bad input', () => {
    for (const a of [[], ['x'], ['0'], ['7', 'abc'], ['7', 'zzzzzzz'], ['7', 'abcdef0', 'extra'], ['7', '--force']]) expect('error' in parseArgs(a)).toBe(true)
  })
})

describe('shaMatches', () => {
  test('full SHA or a prefix of 7+ characters; never shorter, never a different commit', () => {
    expect(shaMatches(HEAD, HEAD)).toBe(true)
    expect(shaMatches(HEAD.slice(0, 7), HEAD)).toBe(true)
    expect(shaMatches(HEAD.slice(0, 7).toUpperCase(), HEAD)).toBe(true)
    expect(shaMatches(HEAD.slice(0, 6), HEAD)).toBe(false)
    expect(shaMatches('abcdef1', HEAD)).toBe(false)
    expect(shaMatches(`${HEAD}0`, HEAD)).toBe(false)
  })
})

describe('the decision from the check state', () => {
  test('only a finished, successful required check goes on', () => {
    expect(requiredCheckState(ok('SUCCESS'))).toBe('passed')
    expect(requiredCheckState([{ name: REQUIRED_CHECK, status: 'IN_PROGRESS' }])).toBe('running')
    expect(requiredCheckState([{ name: REQUIRED_CHECK, status: 'QUEUED' }])).toBe('running')
    expect(requiredCheckState(ok('FAILURE'))).toBe('failed')
    expect(requiredCheckState(ok('CANCELLED'))).toBe('failed')
    expect(requiredCheckState([{ name: 'other', status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('missing')
    expect(requiredCheckState(undefined)).toBe('missing')
    expect(decide('passed', 7, HEAD)).toEqual({ go: true })
    for (const s of ['running', 'failed', 'missing'] as const) {
      const d = decide(s, 7, HEAD)
      expect(d.go).toBe(false)
      expect(!d.go && d.message).toContain('gh pr checks 7')
    }
  })
})

describe('several runs of the required check on one head: the latest counts', () => {
  const run = (startedAt: string, status: string, conclusion?: string) => ({ name: REQUIRED_CHECK, startedAt, status, conclusion })
  test('reruns and cancelled runs', () => {
    expect(requiredCheckState([run('2026-11-17T01:00:00Z', 'COMPLETED', 'CANCELLED'), run('2026-11-17T02:00:00Z', 'COMPLETED', 'SUCCESS')])).toBe('passed')
    expect(requiredCheckState([run('2026-11-17T02:00:00Z', 'COMPLETED', 'SUCCESS'), run('2026-11-17T03:00:00Z', 'IN_PROGRESS')])).toBe('running')
    expect(requiredCheckState([run('2026-11-17T03:00:00Z', 'COMPLETED', 'SUCCESS'), run('2026-11-17T01:00:00Z', 'COMPLETED', 'FAILURE')])).toBe('passed')
    expect(requiredCheckState([run('2026-11-17T02:00:00Z', 'COMPLETED', 'SUCCESS'), run('2026-11-17T03:00:00Z', 'COMPLETED', 'FAILURE')])).toBe('failed')
  })
  test('completedAt is the fallback; no timestamps is the oldest', () => {
    const a = { name: REQUIRED_CHECK, status: 'COMPLETED', conclusion: 'FAILURE' }
    expect(requiredCheckState([{ ...a, completedAt: '2026-11-17T01:00:00Z' }, { ...a, conclusion: 'SUCCESS', completedAt: '2026-11-17T02:00:00Z' }])).toBe('passed')
    expect(requiredCheckState([a, { ...a, conclusion: 'SUCCESS', startedAt: '2026-11-17T02:00:00Z' }])).toBe('passed')
  })
})

describe('the GraphQL body', () => {
  test('expectedHeadOid always, jump only with --jump', () => {
    const a = enqueueArgs('PR_node', HEAD, false)
    expect(a.slice(0, 2)).toEqual(['api', 'graphql'])
    expect(a.join(' ')).toContain('enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha,jump:$jump})')
    expect(a).toContain(`sha=${HEAD}`)
    expect(a).not.toContain('jump=true')
    expect(enqueueArgs('PR_node', HEAD, true).slice(-2)).toEqual(['-F', 'jump=true'])
  })
})

describe('enqueue', () => {
  test('queues the current head and prints position and state', () => {
    const f = fake({})
    const r = enqueue(['7'], f.run)
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain(`Using the current head ${HEAD}`)
    expect(r.out.join('\n')).toContain('position 2, state AWAITING_CHECKS')
    expect(f.calls.at(-1)).toContain(`sha=${HEAD}`)
  })
  test('accepts a short SHA and --jump', () => {
    const f = fake({})
    expect(enqueue(['7', HEAD.slice(0, 8), '--jump'], f.run).code).toBe(0)
    expect(f.calls.at(-1)).toContain('jump=true')
  })
  test('a SHA that is not the head is refused with both printed, nothing queued', () => {
    const f = fake({})
    const r = enqueue(['7', '1234567'], f.run)
    expect(r.code).toBe(1)
    expect(r.out.join('\n')).toContain('1234567')
    expect(r.out.join('\n')).toContain(HEAD)
    expect(f.calls.length).toBe(1)
  })
  test('a running or failed check queues nothing', () => {
    for (const roll of [[{ name: REQUIRED_CHECK, status: 'IN_PROGRESS' }], ok('FAILURE')]) {
      const f = fake({ statusCheckRollup: roll })
      const r = enqueue(['7'], f.run)
      expect(r.code).toBe(1)
      expect(f.calls.length).toBe(2)
    }
  })
  test('already merged, closed, wrong base, draft, not found', () => {
    expect(enqueue(['7'], fake({ state: 'MERGED' }).run).out[0]).toContain('already merged')
    expect(enqueue(['7'], fake({ state: 'CLOSED' }).run).out[0]).toContain('closed')
    expect(enqueue(['7'], fake({ baseRefName: 'main' }).run).out[0]).toContain('not dev')
    expect(enqueue(['7'], fake({ isDraft: true }).run).out[0]).toContain('draft')
    const nf = enqueue(['7'], fake({ fail: 'GraphQL: Could not resolve to a PullRequest with the number of 7.' }).run)
    expect(nf.code).toBe(1)
    expect(nf.out[0]).toContain('not found')
  })
  test('already in the queue exits 0 without calling the mutation', () => {
    const f = fake({}, true)
    const r = enqueue(['7'], f.run)
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('already in the merge queue')
    expect(f.calls.length).toBe(2)
  })
  test('a GraphQL error prints the message, not a stack', () => {
    const f = fake({}, false, { ok: false, stdout: '{"errors":[{"message":"Pull request is not mergeable"}]}' })
    const r = enqueue(['7'], f.run)
    expect(r.code).toBe(1)
    expect(r.out.join('\n')).toContain('Pull request is not mergeable')
    expect(r.out.join('\n')).not.toContain('    at ')
    const g = fake({}, false, { ok: true, stdout: '{"data":{"enqueuePullRequest":null},"errors":[{"message":"nope"}]}' })
    expect(enqueue(['7'], g.run).out.join('\n')).toContain('nope')
  })
  test('usage and bad arguments never call gh', () => {
    const f = fake({})
    expect(enqueue(['--help'], f.run).code).toBe(0)
    expect(enqueue([], f.run).code).toBe(2)
    expect(f.calls.length).toBe(0)
  })
})

describe('docs and shortcut', () => {
  const root = path.resolve(import.meta.dir, '..', '..')
  test('package.json has the queue shortcut; the docs name the script, not the broken command as the way', () => {
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.queue).toBe('bun scripts/ci/enqueue.ts')
    for (const f of ['docs/REPOSITORY-RULES.md', 'docs/decisions/20261117-merge-queue.md']) {
      const t = fs.readFileSync(path.join(root, f), 'utf8')
      expect(t).toContain('scripts/ci/enqueue.ts')
      expect(t).toContain('Auto merge is not allowed')
    }
  })
})
