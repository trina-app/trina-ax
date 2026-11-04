// Dev environment (개발 환경), EXPERIMENT on branch feat/dev-env (docs/DECISIONS.md "Dev environment (experiment)").
// One box per project: the AI runs shell commands (git, npm, pip, a dev server) in the project's box through the
// box_shell tool; a person opens a running dev server through a preview link on a separate origin. Off unless the
// server runs with MYCEL_DEV_ENV=1 AND an owner or admin turns it on for the project after accepting the warning.
// Folder permissions stay the only permission model: a person uses the box only with write access to the folder.
import { z } from 'zod'
import { endpoint } from './endpoint'
import { IsoTime } from './common'
import { UserRef } from './entities'
import { UserId } from '../ids'

/** A new version (other words, other risks) asks again: the stored consent then names an older one. */
export const DEV_ENV_WARNING_VERSION = 1
/** The warning of the srt runner (MYCEL_DEV_ENV_RUNNER=srt): "open" network means the allowlist now, and commands run on
 * the team server. A server on srt asks for this version (the response's warningVersion). */
export const DEV_ENV_SRT_WARNING_VERSION = 2

/** Who may use the box of a project. Both modes need write access to the project folder.
 * writers = every person with write access to the folder; selected = only the named people and group members. */
export const DevEnvScope = z.object({
  mode: z.enum(['writers', 'selected']),
  groupIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  userIds: z.array(UserId).max(1000).default([]),
})
export type DevEnvScope = z.infer<typeof DevEnvScope>

export const DevEnvConsent = z.object({ by: UserRef.nullable(), at: IsoTime, warningVersion: z.number().int().min(1) })
export type DevEnvConsent = z.infer<typeof DevEnvConsent>

/** open = internet without private, link-local, metadata or team-server addresses and without mail ports;
 * offline = no network (loopback only). */
export const DevEnvNetwork = z.enum(['open', 'offline'])
export type DevEnvNetwork = z.infer<typeof DevEnvNetwork>

/** Per-box limits. Defaults from the P0 spike (docs/research/dev-env-p0-spike.md section 4). diskGiB sizes only the box
 * volume (node_modules, .venv, caches). /work is the team folder on the server's disk and has no size limit of its own:
 * the box stops when the server disk comes under its floor (native/cmd/mycel-boxd/plan.go diskFloor). */
export const DevEnvLimits = z.object({
  cpus: z.number().min(0.25).max(4).default(1),
  memoryMiB: z.number().int().min(256).max(8192).default(2560),
  pids: z.number().int().min(64).max(4096).default(512),
  diskGiB: z.number().int().min(1).max(32).default(4),
  idleStopMin: z.number().int().min(5).max(240).default(30),
})
export type DevEnvLimits = z.infer<typeof DevEnvLimits>
export const DEV_ENV_DEFAULT_LIMITS: DevEnvLimits = DevEnvLimits.parse({})

/** Can this server run boxes? flag: MYCEL_DEV_ENV=1 is not set; boxd: the box helper does not answer;
 * platform: the box helper says it cannot run boxes here (not Linux, no rootless podman, no idmapped mounts). */
export const DevEnvAvailability = z.object({
  available: z.boolean(),
  reason: z.enum(['flag', 'boxd', 'platform']).optional(),
  detail: z.string().max(500).optional(),
})
export type DevEnvAvailability = z.infer<typeof DevEnvAvailability>

/** What is stored per team (settings key devEnv.team, admins). The srt runner is turned on for the whole team, not per
 * project (docs/research/srt-dev-env.md section 3): any chat of a person in scope can run commands, with that person's
 * folder access. extraDomains: the sites that the AI may reach in addition to the default list
 * (shared/src/dev-env-domains.ts). scope "writers" means every active person here. The box runner reads only
 * extraDomains; it keeps the per-project setting. */
export const DevEnvTeamSetting = z.object({
  extraDomains: z.array(z.string().min(3).max(253)).max(50).default([]),
  enabled: z.boolean().default(false),
  scope: DevEnvScope.default({ mode: 'writers', groupIds: [], userIds: [] }),
  network: DevEnvNetwork.default('open'),
  limits: DevEnvLimits.default(DEV_ENV_DEFAULT_LIMITS),
  consent: DevEnvConsent.nullable().default(null),
})
export type DevEnvTeamSetting = z.infer<typeof DevEnvTeamSetting>
export const DevEnvTeamResponse = z.object({
  setting: DevEnvTeamSetting,
  defaultDomains: z.array(z.string()),
  /** the plan caps of this server (root/dev-env.json), or null when there is no file (self-hosted) */
  plan: z.object({ plan: z.string(), maxRunning: z.number(), cpus: z.number(), memoryMiB: z.number(), pids: z.number(), network: z.string() }).nullable(),
  runner: z.enum(['box', 'srt']),
  /** srt runner: the warning version that turning on needs (older servers omit it) */
  warningVersion: z.number().int().optional(),
  availability: DevEnvAvailability.optional(),
})
export type DevEnvTeamResponse = z.infer<typeof DevEnvTeamResponse>
/** A change of the team setting. Only the fields given change. Turning on needs the current warning accepted. */
export const UpdateDevEnvTeamBody = z.object({
  extraDomains: z.array(z.string().min(3).max(253)).max(50).optional(),
  enabled: z.boolean().optional(),
  scope: DevEnvScope.optional(),
  network: DevEnvNetwork.optional(),
  limits: DevEnvLimits.partial().optional(),
  acceptWarning: z.number().int().min(1).optional(),
})
export type UpdateDevEnvTeamBody = z.infer<typeof UpdateDevEnvTeamBody>

/** What is stored per project (settings key devEnv.project.<id>). */
export const DevEnvProjectSetting = z.object({
  enabled: z.boolean(),
  scope: DevEnvScope,
  network: DevEnvNetwork.default('open'),
  limits: DevEnvLimits.default(DEV_ENV_DEFAULT_LIMITS),
  consent: DevEnvConsent.nullable(),
})
export type DevEnvProjectSetting = z.infer<typeof DevEnvProjectSetting>


export const DevEnvProcess = z.object({ pid: z.number().int(), seconds: z.number().int(), command: z.string() })
export const DevEnvBox = z.object({
  state: z.enum(['none', 'stopped', 'running']),
  startedAt: IsoTime.nullable(),
  lastActiveAt: IsoTime.nullable(),
  memoryMiB: z.number().nullable(),
  /** processes in the box besides its init and helpers: dev servers and watchers that earlier commands left */
  processes: z.array(DevEnvProcess),
  /** a box that does not run: why boxd stopped it (disk, busy_max, idle, pids, exited), or null */
  stopCode: z.string().nullable().optional(),
})
export type DevEnvBox = z.infer<typeof DevEnvBox>

/** A long command that runs in the box (box_shell job): what the project page shows as progress. */
export const DevEnvJob = z.object({
  id: z.string(), name: z.string(), by: UserRef.nullable(), startedAt: IsoTime,
  /** the last line of its log at the last poll, "" before the first */
  lastLine: z.string(),
})
export type DevEnvJob = z.infer<typeof DevEnvJob>

/** One run of the srt runner: a job, a dev server or a command, running or waiting in the queue. */
export const DevEnvRun = z.object({
  id: z.string(), kind: z.enum(['command', 'job', 'server']), name: z.string(), by: UserRef.nullable(),
  /** when it was asked for */
  startedAt: IsoTime,
  /** when it left the queue (null while it waits) */
  runAt: IsoTime.nullable(),
  /** 1 = next to start; null while it runs */
  position: z.number().int().nullable(),
  memoryMiB: z.number().nullable(),
  lastLine: z.string(),
  /** srt runner: the chat and the project of the run (null: none, or not shown to this person) */
  chatId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
})
export type DevEnvRun = z.infer<typeof DevEnvRun>
export const DevEnvRuns = z.object({ running: z.array(DevEnvRun), waiting: z.array(DevEnvRun) })
export type DevEnvRuns = z.infer<typeof DevEnvRuns>

export const DevEnvProjectResponse = z.object({
  availability: DevEnvAvailability,
  setting: DevEnvProjectSetting,
  warningVersion: z.number().int(),
  /** the caller may run commands in this box (setting on, in scope, write access to the folder) */
  mayUse: z.boolean(),
  /** the caller may change the setting (owner or admin) */
  mayManage: z.boolean(),
  /** the project is on the team root: turning on creates a folder of its own under projects/ */
  needsFolder: z.boolean(),
  box: DevEnvBox.nullable(),
  /** jobs that run now, for people who see the box; older servers omit it */
  jobs: z.array(DevEnvJob).default([]),
  /** srt runner: what runs and what waits; empty with the box runner and on older servers */
  runs: DevEnvRuns.default({ running: [], waiting: [] }),
  /** box: the per-project setting applies. srt: the team setting applies (setting is the team's), and this page only
   * shows the runs of this project's chats. Older servers omit it. */
  runner: z.enum(['box', 'srt']).default('box'),
})
export type DevEnvProjectResponse = z.infer<typeof DevEnvProjectResponse>

export const UpdateDevEnvBody = z.object({
  enabled: z.boolean(),
  scope: DevEnvScope,
  network: DevEnvNetwork.optional(),
  limits: DevEnvLimits.partial().optional(),
  acceptWarning: z.number().int().min(1).optional(),
})
export type UpdateDevEnvBody = z.infer<typeof UpdateDevEnvBody>

export const DevEnvBoxAction = z.object({ action: z.enum(['stop', 'restart']) })

export const DevEnvPreviewBody = z.object({ port: z.number().int().min(1024).max(65535) })
export const DevEnvPreviewLink = z.object({ url: z.string(), expiresAt: IsoTime })
export type DevEnvPreviewLink = z.infer<typeof DevEnvPreviewLink>

/** One line of the box activity (audit): a command, a group of changed files, a network decision. */
export const DevEnvActivity = z.object({
  at: IsoTime,
  by: UserRef.nullable(),
  kind: z.enum(['command', 'files', 'box', 'preview']),
  text: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
})
export type DevEnvActivity = z.infer<typeof DevEnvActivity>

export const DEV_ENV = {
  devEnv: endpoint({ method: 'GET', path: '/api/projects/:id/dev-env', auth: 'user', owner: 'B', response: DevEnvProjectResponse, summary: 'Dev environment (experiment) of a project: setting, availability, the box state; for people who can read the folder.' }),
  updateDevEnv: endpoint({ method: 'PUT', path: '/api/projects/:id/dev-env', auth: 'admin', owner: 'B', body: UpdateDevEnvBody, response: DevEnvProjectResponse, summary: 'Turn the dev environment of a project on or off, who may use it, network and limits; turning on needs the current warning accepted (audited).' }),
  devEnvBox: endpoint({ method: 'POST', path: '/api/projects/:id/dev-env/box', auth: 'user', owner: 'B', body: DevEnvBoxAction, response: DevEnvProjectResponse, summary: 'Stop or restart the project box (people who may use it, and admins; audited).' }),
  devEnvPreview: endpoint({ method: 'POST', path: '/api/projects/:id/dev-env/preview', auth: 'user', owner: 'B', body: DevEnvPreviewBody, response: DevEnvPreviewLink, summary: 'A short-lived link to a dev server port of the box, on the separate preview origin (read access to the folder; audited).' }),
  devEnvRunStop: endpoint({ method: 'POST', path: '/api/projects/:id/dev-env/runs/:runId/stop', auth: 'user', owner: 'B', response: DevEnvProjectResponse, summary: 'srt runner: stop a running job, dev server or command, or cancel a waiting job (the person who started it, people who may use the dev environment, admins; audited).' }),
  devEnvTeam: endpoint({ method: 'GET', path: '/api/admin/dev-env', auth: 'admin', owner: 'B', response: DevEnvTeamResponse, summary: 'Dev environment of the team: the extra sites the AI may reach, the default sites and the plan caps.' }),
  updateDevEnvTeam: endpoint({ method: 'PUT', path: '/api/admin/dev-env', auth: 'admin', owner: 'B', body: UpdateDevEnvTeamBody, response: DevEnvTeamResponse, summary: 'Change the dev environment of the team: on or off (srt), who may use it, network, limits and the extra sites the AI may reach (audited).' }),
  myDevEnvRuns: endpoint({ method: 'GET', path: '/api/dev-env/runs', auth: 'user', owner: 'B', response: DevEnvRuns, summary: 'srt runner: the runs of the caller (every chat, with or without a project): what runs and what waits.' }),
  stopMyDevEnvRun: endpoint({ method: 'POST', path: '/api/dev-env/runs/:runId/stop', auth: 'user', owner: 'B', response: DevEnvRuns, summary: 'srt runner: stop a run of the caller, or cancel a waiting job of the caller (audited).' }),
  devEnvActivity: endpoint({ method: 'GET', path: '/api/projects/:id/dev-env/activity', auth: 'user', owner: 'B', response: z.object({ items: z.array(DevEnvActivity) }), summary: 'Box audit of a project: AI commands, changed files, box and preview events (read access to the folder).' }),
} as const
