// The dev environment section of Team settings (pages/admin/DevEnvTeam.tsx): the form's draft of the team setting
// (devEnv.team, PUT /api/admin/dev-env) and the body of a save. Only the fields that changed are sent: a change of the
// network or the limits stops every run on the server (server/src/routes/dev-env.ts), so a save of the sites alone must
// not send them.
import type { DevEnvTeamResponse, DevEnvTeamSetting, UpdateDevEnvTeamBody } from '@mycel/shared/api'

export interface DevEnvTeamDraft {
  enabled: boolean
  mode: 'writers' | 'selected'
  groupIds: string[]
  /** people chosen by name: kept as they are (this form edits groups only) */
  userIds: string[]
  network: 'open' | 'offline'
  cpus: number
  memoryMiB: number
  pids: number
  idleStopMin: number
  /** one host name per line */
  sites: string
}

export const draftOf = (s: DevEnvTeamSetting): DevEnvTeamDraft => ({
  enabled: s.enabled, mode: s.scope.mode, groupIds: [...s.scope.groupIds], userIds: [...s.scope.userIds], network: s.network,
  cpus: s.limits.cpus, memoryMiB: s.limits.memoryMiB, pids: s.limits.pids, idleStopMin: s.limits.idleStopMin, sites: s.extraDomains.join('\n'),
})

/** The host names of the text: one per line (spaces and commas also split), no empty ones, each once. The server checks
 * each one and says which is wrong. */
export const sitesOf = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))]

export type LimitKey = 'cpus' | 'memoryMiB' | 'pids' | 'idleStopMin'
// the ranges of DevEnvLimits (shared/src/api/dev-env.ts); a unit test checks them against the schema
export const LIMIT_RANGE: Record<LimitKey, { min: number; max: number; int: boolean }> = {
  cpus: { min: 0.25, max: 4, int: false },
  memoryMiB: { min: 256, max: 8192, int: true },
  pids: { min: 64, max: 4096, int: true },
  idleStopMin: { min: 5, max: 240, int: true },
}

/** The largest value the form offers: the schema's limit, cut to the server's plan (a run gets at most the plan). */
export function limitMax(k: LimitKey, plan: DevEnvTeamResponse['plan']): number {
  const cap = !plan ? Infinity : k === 'cpus' ? plan.cpus : k === 'memoryMiB' ? plan.memoryMiB : k === 'pids' ? plan.pids : Infinity
  return Math.max(LIMIT_RANGE[k].min, Math.min(LIMIT_RANGE[k].max, cap))
}

/** A typed value inside the range (a value that is not a number becomes the smallest). */
export function clampLimit(k: LimitKey, v: number, plan: DevEnvTeamResponse['plan']): number {
  const r = LIMIT_RANGE[k]
  const n = Number.isFinite(v) ? v : r.min
  const x = Math.max(r.min, Math.min(limitMax(k, plan), n))
  return r.int ? Math.round(x) : Math.round(x * 100) / 100
}

/** Does this save need the warning accepted? srt, turning on, and the stored consent is for another version. */
export const needsWarning = (r: Pick<DevEnvTeamResponse, 'runner' | 'warningVersion' | 'setting'>, d: Pick<DevEnvTeamDraft, 'enabled'>) =>
  r.runner === 'srt' && d.enabled && r.warningVersion !== undefined && r.setting.consent?.warningVersion !== r.warningVersion

/** The body of a save: only what changed. On the box runner only the sites (the rest is per project). */
export function teamBody(r: Pick<DevEnvTeamResponse, 'runner' | 'warningVersion' | 'setting' | 'plan'>, d: DevEnvTeamDraft, accept: boolean): UpdateDevEnvTeamBody {
  const s = r.setting
  const body: UpdateDevEnvTeamBody = {}
  const sites = sitesOf(d.sites)
  if (JSON.stringify(sites) !== JSON.stringify(s.extraDomains)) body.extraDomains = sites
  if (r.runner !== 'srt') return body
  if (d.enabled !== s.enabled) body.enabled = d.enabled
  const scope = { mode: d.mode, groupIds: d.mode === 'selected' ? d.groupIds : [], userIds: d.mode === 'selected' ? d.userIds : [] }
  if (scope.mode !== s.scope.mode || JSON.stringify([...scope.groupIds].sort()) !== JSON.stringify([...s.scope.groupIds].sort())
    || JSON.stringify([...scope.userIds].sort()) !== JSON.stringify([...s.scope.userIds].sort())) body.scope = scope
  if (d.network !== s.network) body.network = d.network
  const limits: Partial<Record<LimitKey, number>> = {}
  for (const k of ['cpus', 'memoryMiB', 'pids', 'idleStopMin'] as const) {
    const v = clampLimit(k, d[k], r.plan)
    if (v !== s.limits[k]) limits[k] = v
  }
  if (Object.keys(limits).length) body.limits = limits
  if (accept && needsWarning(r, d) && r.warningVersion !== undefined) body.acceptWarning = r.warningVersion
  return body
}
