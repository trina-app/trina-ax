// A called workflow (`uses: ./.github/workflows/X.yml`) may not ask for more token access than its caller grants:
// GitHub then refuses the WHOLE calling run at start-up (startup_failure), before any job runs. That happened to the
// v0.5.19 release (run 44517924801): release.yml calls ci.yml with `contents: read`, and a ci.yml job asked for
// `issues: write`. This check reads every workflow and, for each job that calls a local workflow, compares the caller
// job's grant with the callee's workflow-level permissions and each callee job's permissions (recursively, for a
// callee that calls another one). tests/unit/workflow-permissions.test.ts runs it (a guard test: check:prepush and the
// pull request's quick checks); `bun scripts/ci/workflow-permissions.ts` prints the problems.
import fs from 'node:fs'
import path from 'node:path'

/** The GITHUB_TOKEN scopes (docs: "Controlling permissions for GITHUB_TOKEN"). */
export const SCOPES = [
  'actions', 'artifact-metadata', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'id-token', 'issues',
  'models', 'packages', 'pages', 'pull-requests', 'repository-projects', 'security-events', 'statuses',
] as const
const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 }

export type Grant = Record<string, number>
type Permissions = string | Record<string, string> | null | undefined
export type Job = { uses?: string; permissions?: Permissions; [k: string]: unknown }
export type Workflow = { permissions?: Permissions; jobs?: Record<string, Job> }

/** A `permissions:` value as a level per scope; undefined when the key is absent (the job inherits). */
export function grantOf(p: Permissions): Grant | undefined {
  if (p === undefined) return undefined
  const all = (n: number) => Object.fromEntries(SCOPES.map((s) => [s, n]))
  if (p === 'read-all') return all(LEVEL.read!)
  if (p === 'write-all') return all(LEVEL.write!)
  if (p === null || (typeof p === 'object' && Object.keys(p).length === 0)) return {} // `permissions: {}`: none
  if (typeof p === 'string') throw new Error(`unknown permissions value "${p}"`)
  const g: Grant = {}
  for (const [scope, level] of Object.entries(p)) {
    if (!(level in LEVEL)) throw new Error(`unknown level "${level}" for ${scope}`)
    g[scope] = LEVEL[level]!
  }
  return g
}

const NAMES = ['none', 'read', 'write']
/** The scopes `want` asks for above `have`, e.g. ["issues: write > none"]. */
export function excess(want: Grant, have: Grant): string[] {
  return Object.entries(want)
    .filter(([scope, n]) => n > (have[scope] ?? 0))
    .map(([scope, n]) => `${scope}: ${NAMES[n]} > ${NAMES[have[scope] ?? 0]}`)
}

/** Every grant problem of the local workflow calls in `workflows` (file name → parsed workflow). */
export function problems(workflows: Record<string, Workflow>): string[] {
  const out: string[] = []
  const local = (uses: string) => /^\.\/\.github\/workflows\/([^/@]+\.ya?ml)$/.exec(uses)?.[1]

  function checkCall(callee: string, grant: Grant, via: string, seen: string[]) {
    const wf = workflows[callee]
    if (!wf) { out.push(`${via} calls ${callee}, which does not exist`); return }
    if (seen.includes(callee)) return
    const top = grantOf(wf.permissions)
    if (top) for (const e of excess(top, grant)) out.push(`${callee} (workflow permissions), called by ${via}: ${e}`)
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      // a callee job without its own permissions gets the callee's workflow-level ones, else the caller's grant
      const own = grantOf(job.permissions) ?? top ?? grant
      for (const e of excess(own, grant)) out.push(`${callee} job ${id}, called by ${via}: ${e}`)
      const next = typeof job.uses === 'string' ? local(job.uses) : undefined
      if (next) checkCall(next, own, `${callee} job ${id}`, [...seen, callee])
    }
  }

  for (const [file, wf] of Object.entries(workflows)) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      const callee = typeof job.uses === 'string' ? local(job.uses) : undefined
      if (!callee) continue
      const grant = grantOf(job.permissions) ?? grantOf(wf.permissions)
      // without an explicit grant the job gets the repository's default token access, which this file cannot see
      if (!grant) { out.push(`${file} job ${id} calls ${callee} without a permissions: grant (job or workflow level)`); continue }
      checkCall(callee, grant, `${file} job ${id}`, [file])
    }
  }
  return out
}

/** The repository's workflows, parsed. */
export function loadWorkflows(root: string): Record<string, Workflow> {
  const dir = path.join(root, '.github', 'workflows')
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
    .map((f) => [f, Bun.YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Workflow]))
}

if (import.meta.main) {
  const found = problems(loadWorkflows(path.resolve(import.meta.dir, '..', '..')))
  for (const p of found) console.error(p)
  console.log(found.length ? `${found.length} workflow permission problem(s)` : 'every called workflow fits its caller\'s permissions')
  process.exit(found.length ? 1 : 0)
}
