// Dev environment (개발 환경) (docs/DECISIONS.md "Dev environment on srt, behind a flag", "Dev environment: box runner
// removed, srt only"). The AI runs shell commands (git, npm, pip, a dev server) through the box_shell tool, in srt on
// the team server, with the folder access of the person of the chat. Off unless the server runs with MYCEL_DEV_ENV=1;
// an admin turns it on or off for the whole team. Folder permissions stay the only permission model.
import { z } from 'zod'
import { endpoint } from './endpoint'
import { IsoTime } from './common'
import { UserRef } from './entities'
import { UserId } from '../ids'

/** The warning of the srt runner: "open" network means the allowlist, and commands run on the team server (the
 * response's warningVersion). A new version (other words, other risks) asks again: the stored consent then names an
 * older one. Version 1 was the warning of the removed box runner. */
export const DEV_ENV_SRT_WARNING_VERSION = 2

/** Who may use the dev environment. writers = every active person of the team; selected = only the named people and
 * group members. */
export const DevEnvScope = z.object({
  mode: z.enum(['writers', 'selected']),
  groupIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  userIds: z.array(UserId).max(1000).default([]),
})
export type DevEnvScope = z.infer<typeof DevEnvScope>

export const DevEnvConsent = z.object({ by: UserRef.nullable(), at: IsoTime, warningVersion: z.number().int().min(1) })
export type DevEnvConsent = z.infer<typeof DevEnvConsent>

/** open = the allowed sites only (the default list, the team's sites and the sites a person allowed); offline = no
 * network. */
export const DevEnvNetwork = z.enum(['open', 'offline'])
export type DevEnvNetwork = z.infer<typeof DevEnvNetwork>

/** Per-run limits. Defaults from the P0 spike (docs/research/dev-env-p0-spike.md section 4). diskGiB and idleStopMin
 * are fields of the removed box runner: they stay in the schema so that stored settings still parse. Runs stop when the
 * server disk comes under its floor (srt/runner.ts). */
export const DevEnvLimits = z.object({
  cpus: z.number().min(0.25).max(4).default(1),
  memoryMiB: z.number().int().min(256).max(8192).default(2560),
  pids: z.number().int().min(64).max(4096).default(512),
  diskGiB: z.number().int().min(1).max(32).default(4),
  idleStopMin: z.number().int().min(5).max(240).default(10),
})
export type DevEnvLimits = z.infer<typeof DevEnvLimits>
export const DEV_ENV_DEFAULT_LIMITS: DevEnvLimits = DevEnvLimits.parse({})

/** Can this server run the dev environment? flag: MYCEL_DEV_ENV=1 is not set; platform: srt is not installed or does
 * not work here (detail says why). */
export const DevEnvAvailability = z.object({
  available: z.boolean(),
  reason: z.enum(['flag', 'platform']).optional(),
  detail: z.string().max(500).optional(),
})
export type DevEnvAvailability = z.infer<typeof DevEnvAvailability>

/** What is stored per team (settings key devEnv.team, admins). The srt runner is turned on for the whole team, not per
 * project (docs/research/srt-dev-env.md section 3): any chat of a person in scope can run commands, with that person's
 * folder access. extraDomains: the sites that the AI may reach in addition to the default list
 * (shared/src/dev-env-domains.ts). scope "writers" means every active person here. */
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
  /** the warning version that turning on needs */
  warningVersion: z.number().int(),
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

/** The team setting in the shape of the old per-project setting: what GET /api/projects/:id/dev-env answers. */
export const DevEnvProjectSetting = z.object({
  enabled: z.boolean(),
  scope: DevEnvScope,
  network: DevEnvNetwork.default('open'),
  limits: DevEnvLimits.default(DEV_ENV_DEFAULT_LIMITS),
  consent: DevEnvConsent.nullable(),
})
export type DevEnvProjectSetting = z.infer<typeof DevEnvProjectSetting>

/** One run: a job, a dev server or a command, running or waiting in the queue. */
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
  /** the chat and the project of the run (null: none, or not shown to this person) */
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
  /** the caller may run commands in this project's chats (in scope, and can open the folder) */
  mayUse: z.boolean(),
  /** the caller may change the team setting (owner or admin) */
  mayManage: z.boolean(),
  /** what runs and what waits in this project's chats */
  runs: DevEnvRuns.default({ running: [], waiting: [] }),
})
export type DevEnvProjectResponse = z.infer<typeof DevEnvProjectResponse>

/** One line of the dev environment activity of a project (audit): a command, a group of changed files, another event
 * (a stop, a job end, the lines of the removed box runner). */
export const DevEnvActivity = z.object({
  at: IsoTime,
  by: UserRef.nullable(),
  kind: z.enum(['command', 'files', 'event']),
  text: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
})
export type DevEnvActivity = z.infer<typeof DevEnvActivity>

/** The sites one person allowed and her Full internet switch (docs/DECISIONS.md "Dev environment: sites a person
 * allows"). state: off = the dev environment is not on for this person (nothing to show); no_network = the team (or
 * the plan) set No network: nothing can be allowed and the lists are empty; on = the lists below apply. */
export const DevEnvMySites = z.object({
  state: z.enum(['off', 'no_network', 'on']),
  sites: z.array(z.object({ host: z.string(), createdAt: IsoTime })),
  /** the person's Full internet switch is on (with the current warning accepted) */
  fullInternet: z.boolean(),
  /** this server can run Full internet (full.mjs installed); false: the switch is not shown */
  fullAvailable: z.boolean(),
  /** the warning version that turning Full internet on needs */
  fullWarningVersion: z.number().int(),
  /** the sites every run of the team may reach: the default list and the team's extra sites */
  teamSites: z.array(z.string()),
  maxSites: z.number().int(),
})
export type DevEnvMySites = z.infer<typeof DevEnvMySites>
export const RemoveDevEnvSiteBody = z.object({ host: z.string().min(1).max(260) })
/** Full internet on needs the warning accepted (acceptWarning = fullWarningVersion); off needs nothing. */
export const SetDevEnvFullInternetBody = z.object({ on: z.boolean(), acceptWarning: z.number().int().min(1).optional() })

export const DEV_ENV = {
  devEnv: endpoint({ method: 'GET', path: '/api/projects/:id/dev-env', auth: 'user', owner: 'B', response: DevEnvProjectResponse, summary: 'Dev environment of a project: the team setting, availability, and the runs of the project\'s chats; for people who can see the project.' }),
  devEnvStop: endpoint({ method: 'POST', path: '/api/projects/:id/dev-env/stop', auth: 'user', owner: 'B', response: DevEnvProjectResponse, summary: 'Stop every run of the project\'s chats; a waiting command only for its owner (people who may use the dev environment, and admins; audited).' }),
  devEnvRunStop: endpoint({ method: 'POST', path: '/api/projects/:id/dev-env/runs/:runId/stop', auth: 'user', owner: 'B', response: DevEnvProjectResponse, summary: 'Stop a running job, dev server or command, or cancel a waiting job (the person who started it, people who may use the dev environment, admins; audited).' }),
  devEnvTeam: endpoint({ method: 'GET', path: '/api/admin/dev-env', auth: 'admin', owner: 'B', response: DevEnvTeamResponse, summary: 'Dev environment of the team: the extra sites the AI may reach, the default sites and the plan caps.' }),
  updateDevEnvTeam: endpoint({ method: 'PUT', path: '/api/admin/dev-env', auth: 'admin', owner: 'B', body: UpdateDevEnvTeamBody, response: DevEnvTeamResponse, summary: 'Change the dev environment of the team: on or off, who may use it, network, limits and the extra sites the AI may reach (audited).' }),
  myDevEnvRuns: endpoint({ method: 'GET', path: '/api/dev-env/runs', auth: 'user', owner: 'B', response: DevEnvRuns, summary: 'The runs of the caller (every chat, with or without a project): what runs and what waits.' }),
  stopMyDevEnvRun: endpoint({ method: 'POST', path: '/api/dev-env/runs/:runId/stop', auth: 'user', owner: 'B', response: DevEnvRuns, summary: 'Stop a run of the caller, or cancel a waiting job of the caller (audited).' }),
  myDevEnvSites: endpoint({ method: 'GET', path: '/api/dev-env/sites', auth: 'user', owner: 'B', response: DevEnvMySites, summary: 'The sites the caller allowed for the dev environment, the Full internet switch, and the team\'s sites.' }),
  removeMyDevEnvSite: endpoint({ method: 'POST', path: '/api/dev-env/sites/remove', auth: 'user', owner: 'B', body: RemoveDevEnvSiteBody, response: DevEnvMySites, summary: 'Remove a site from the caller\'s own allowed sites; the caller\'s jobs and dev servers that use it stop (audited).' }),
  setMyDevEnvFullInternet: endpoint({ method: 'PUT', path: '/api/dev-env/full-internet', auth: 'user', owner: 'B', body: SetDevEnvFullInternetBody, response: DevEnvMySites, summary: 'Turn the caller\'s Full internet on (the warning accepted) or off; off stops the caller\'s jobs and dev servers that used it (audited).' }),
  devEnvActivity: endpoint({ method: 'GET', path: '/api/projects/:id/dev-env/activity', auth: 'user', owner: 'B', response: z.object({ items: z.array(DevEnvActivity) }), summary: 'Dev environment audit of a project: AI commands, changed files and other events (people who can see the project).' }),
} as const
