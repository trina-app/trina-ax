// Adds a pull request to dev's merge queue (docs/decisions/20261117-merge-queue.md, QA TC-4593).
//
//   bun scripts/ci/enqueue.ts <pr number> [<head sha>] [--jump]
//
// Why not `gh pr merge --match-head-commit`: gh asks GitHub to enable auto-merge, this repository has auto-merge off,
// and it fails with "Auto merge is not allowed for this repository" even when the required check is green. The
// GraphQL mutation enqueuePullRequest works. Auth is whatever `gh` is signed in with; no token is read or printed.
import { spawnSync } from 'node:child_process'

export const REQUIRED_CHECK = 'typecheck, native, unit, fast fuzz, web, relay'

export const USAGE = `Usage: bun scripts/ci/enqueue.ts <pr number> [<head sha>] [--jump]

Adds a pull request to dev's merge queue once the required check
"${REQUIRED_CHECK}" has passed on its head.

  <pr number>  the pull request (base must be dev, open, not a draft)
  <head sha>   the commit you reviewed (7+ characters are enough); refused if the PR head moved
  --jump       admin only: go to the front of the queue (hotfix or release PR)
  --help       this text`

export type Args = { pr: number; sha: string | null; jump: boolean } | { help: true } | { error: string }

export function parseArgs(argv: string[]): Args {
  let jump = false
  const rest: string[] = []
  for (const a of argv) {
    if (a === '--help' || a === '-h') return { help: true }
    if (a === '--jump') jump = true
    else if (a.startsWith('-')) return { error: `Unknown option ${a}` }
    else rest.push(a)
  }
  if (rest.length === 0) return { error: 'Missing the pull request number' }
  if (rest.length > 2) return { error: `Too many arguments: ${rest.slice(2).join(' ')}` }
  if (!/^\d+$/.test(rest[0]!) || Number(rest[0]) < 1) return { error: `"${rest[0]}" is not a pull request number` }
  const sha = rest[1] ?? null
  if (sha !== null && !/^[0-9a-f]{7,40}$/i.test(sha)) return { error: `"${sha}" is not a commit SHA (7 to 40 hex characters)` }
  return { pr: Number(rest[0]), sha, jump }
}

/** a given SHA matches the head when it is a prefix of at least 7 characters (case-insensitive) */
export function shaMatches(given: string, head: string): boolean {
  const g = given.toLowerCase()
  return g.length >= 7 && g.length <= head.length && head.toLowerCase().startsWith(g)
}

export type Pr = {
  id: string
  number: number
  state: string
  isDraft: boolean
  baseRefName: string
  headRefOid: string
  statusCheckRollup?: { name?: string; context?: string; status?: string; state?: string; conclusion?: string; startedAt?: string; completedAt?: string }[]
}

export type CheckState = 'passed' | 'running' | 'failed' | 'missing'

/** the state of the required check on the head, from gh's statusCheckRollup: only the latest run with that name counts
 *  (newest startedAt, else completedAt; a run with no timestamps is the oldest), so a stale cancelled or failed run
 *  next to a green rerun does not block */
export function requiredCheckState(rollup: Pr['statusCheckRollup']): CheckState {
  const runs = (rollup ?? []).filter((c) => c.name === REQUIRED_CHECK)
  if (runs.length === 0) return 'missing'
  const stamp = (c: (typeof runs)[number]) => c.startedAt || c.completedAt || ''
  let last = runs[0]!
  for (const c of runs) if (stamp(c) > stamp(last)) last = c
  if (last.status !== 'COMPLETED') return 'running'
  return last.conclusion === 'SUCCESS' || last.conclusion === 'SKIPPED' ? 'passed' : 'failed'
}

/** why this PR cannot be queued, or null when it can */
export function refusal(pr: Pr): string | null {
  if (pr.state === 'MERGED') return `PR #${pr.number} is already merged.`
  if (pr.state === 'CLOSED') return `PR #${pr.number} is closed.`
  if (pr.baseRefName !== 'dev') return `PR #${pr.number} targets "${pr.baseRefName}", not dev. Only pull requests to dev use the merge queue.`
  if (pr.isDraft) return `PR #${pr.number} is a draft. Mark it ready for review first.`
  return null
}

export type Decision = { go: true } | { go: false; message: string }

export function decide(state: CheckState, number: number, head: string): Decision {
  const see = `See the checks: gh pr checks ${number}`
  if (state === 'passed') return { go: true }
  if (state === 'running') return { go: false, message: `The required check "${REQUIRED_CHECK}" is still running on ${head.slice(0, 10)}. Not queued. Wait for it, then run this again.\n${see}` }
  if (state === 'failed') return { go: false, message: `The required check "${REQUIRED_CHECK}" failed on ${head.slice(0, 10)}. Not queued. Fix it, push, and run this again.\n${see}` }
  return { go: false, message: `The required check "${REQUIRED_CHECK}" has not reported on ${head.slice(0, 10)}. Not queued. Push the branch or wait for the PR checks to start.\n${see}` }
}

export const ENQUEUE_MUTATION =
  'mutation($id:ID! $sha:GitObjectID! $jump:Boolean){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha,jump:$jump}){mergeQueueEntry{position state}}}'

/** the gh arguments for the mutation (`-F jump=true` is sent only with --jump) */
export function enqueueArgs(id: string, sha: string, jump: boolean): string[] {
  const a = ['api', 'graphql', '-f', `query=${ENQUEUE_MUTATION}`, '-f', `id=${id}`, '-f', `sha=${sha}`]
  if (jump) a.push('-F', 'jump=true')
  return a
}

export function viewArgs(pr: number): string[] {
  return ['pr', 'view', String(pr), '--json', 'id,number,state,isDraft,baseRefName,headRefOid,statusCheckRollup']
}

export const QUEUE_QUERY = 'query($id:ID!){node(id:$id){... on PullRequest{isInMergeQueue mergeQueueEntry{position state}}}}'

export function queueArgs(id: string): string[] {
  return ['api', 'graphql', '-f', `query=${QUEUE_QUERY}`, '-f', `id=${id}`]
}

export type Run = { ok: boolean; stdout: string; stderr: string }
export type Runner = (args: string[]) => Run

export const ghRunner: Runner = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8' })
  if (r.error) return { ok: false, stdout: '', stderr: `could not run gh: ${r.error.message}` }
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** the GraphQL error messages of a gh api graphql answer (also when gh exits non-zero with the JSON on stdout) */
export function graphqlMessage(run: Run): string {
  try {
    const j = JSON.parse(run.stdout) as { errors?: { message?: string }[] }
    const m = (j.errors ?? []).map((e) => e.message).filter(Boolean)
    if (m.length > 0) return m.join('; ')
  } catch {}
  return run.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown error'
}

export type Result = { code: number; out: string[] }

export function enqueue(argv: string[], run: Runner): Result {
  const args = parseArgs(argv)
  if ('help' in args) return { code: 0, out: [USAGE] }
  if ('error' in args) return { code: 2, out: [args.error, '', USAGE] }

  const v = run(viewArgs(args.pr))
  if (!v.ok) {
    const e = v.stderr.trim()
    if (/Could not resolve|not found|no pull requests found/i.test(e)) return { code: 1, out: [`PR #${args.pr} was not found in this repository.`] }
    return { code: 1, out: [`Could not read PR #${args.pr}: ${e.split('\n').slice(-1)[0] || 'gh failed'}`, 'Is gh signed in (gh auth status) and are you inside the repository?'] }
  }
  let pr: Pr
  try {
    pr = JSON.parse(v.stdout) as Pr
  } catch {
    return { code: 1, out: [`Could not read PR #${args.pr}: gh returned something that is not JSON.`] }
  }

  const no = refusal(pr)
  if (no) return { code: 1, out: [no] }
  const head = pr.headRefOid
  if (args.sha !== null && !shaMatches(args.sha, head)) {
    return { code: 1, out: [`The head of PR #${pr.number} is not the commit you gave. Not queued.`, `  you gave:     ${args.sha}`, `  current head: ${head}`, 'Review the new commit(s), then run this again with the current head.'] }
  }
  const out: string[] = args.sha === null ? [`Using the current head ${head}`] : []
  const q = run(queueArgs(pr.id))
  if (!q.ok) return { code: 1, out: [...out, `Could not read the queue state of PR #${pr.number}: ${graphqlMessage(q)}`] }
  try {
    const n = (JSON.parse(q.stdout) as { data?: { node?: { isInMergeQueue?: boolean; mergeQueueEntry?: { position?: number; state?: string } | null } } }).data?.node
    if (n?.isInMergeQueue) {
      const e = n.mergeQueueEntry
      return { code: 0, out: [...out, `PR #${pr.number} is already in the merge queue${e ? ` (position ${e.position}, state ${e.state})` : ''}.`] }
    }
  } catch {}

  const d = decide(requiredCheckState(pr.statusCheckRollup), pr.number, head)
  if (!d.go) return { code: 1, out: [...out, d.message] }

  const m = run(enqueueArgs(pr.id, head, args.jump))
  let entry: { position?: number; state?: string } | null | undefined
  try {
    const j = JSON.parse(m.stdout) as { data?: { enqueuePullRequest?: { mergeQueueEntry?: { position?: number; state?: string } | null } | null }; errors?: unknown[] }
    if (!j.errors?.length) entry = j.data?.enqueuePullRequest?.mergeQueueEntry
  } catch {}
  if (!m.ok || !entry) {
    const msg = graphqlMessage(m)
    const hint = /already.*queue/i.test(msg) ? [] : args.jump && /jump|permission|admin/i.test(msg) ? ['--jump needs a repository admin.'] : []
    if (/already.*queue/i.test(msg)) return { code: 0, out: [...out, `PR #${pr.number} is already in the merge queue.`] }
    return { code: 1, out: [...out, `GitHub refused to queue PR #${pr.number}: ${msg}`, ...hint] }
  }
  return { code: 0, out: [...out, `Queued PR #${pr.number} at ${head.slice(0, 10)}${args.jump ? ' (jumped the queue)' : ''}: position ${entry.position}, state ${entry.state}.`, `Watch it: gh pr view ${pr.number} --json isInMergeQueue`] }
}

if (import.meta.main) {
  const r = enqueue(process.argv.slice(2), ghRunner)
  console.log(r.out.join('\n'))
  process.exit(r.code)
}
