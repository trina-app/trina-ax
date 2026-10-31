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

/** Per-box limits. Defaults from the P0 spike (docs/research/dev-env-p0-spike.md section 4). */
export const DevEnvLimits = z.object({
  cpus: z.number().min(0.25).max(4).default(1),
  memoryMiB: z.number().int().min(256).max(8192).default(1536),
  pids: z.number().int().min(64).max(4096).default(512),
  diskGiB: z.number().int().min(1).max(32).default(4),
  idleStopMin: z.number().int().min(5).max(240).default(30),
})
export type DevEnvLimits = z.infer<typeof DevEnvLimits>
export const DEV_ENV_DEFAULT_LIMITS: DevEnvLimits = DevEnvLimits.parse({})

/** What is stored per project (settings key devEnv.project.<id>). */
export const DevEnvProjectSetting = z.object({
  enabled: z.boolean(),
  scope: DevEnvScope,
  network: DevEnvNetwork.default('open'),
  limits: DevEnvLimits.default(DEV_ENV_DEFAULT_LIMITS),
  consent: DevEnvConsent.nullable(),
})
export type DevEnvProjectSetting = z.infer<typeof DevEnvProjectSetting>

/** Can this server run boxes? flag: MYCEL_DEV_ENV=1 is not set; boxd: the box helper does not answer;
 * platform: the box helper says it cannot run boxes here (not Linux, no rootless podman, no idmapped mounts). */
export const DevEnvAvailability = z.object({
  available: z.boolean(),
  reason: z.enum(['flag', 'boxd', 'platform']).optional(),
  detail: z.string().max(500).optional(),
})
export type DevEnvAvailability = z.infer<typeof DevEnvAvailability>

export const DevEnvProcess = z.object({ pid: z.number().int(), seconds: z.number().int(), command: z.string() })
export const DevEnvBox = z.object({
  state: z.enum(['none', 'stopped', 'running']),
  startedAt: IsoTime.nullable(),
  lastActiveAt: IsoTime.nullable(),
  memoryMiB: z.number().nullable(),
  /** processes in the box besides its init and helpers: dev servers and watchers that earlier commands left */
  processes: z.array(DevEnvProcess),
})
export type DevEnvBox = z.infer<typeof DevEnvBox>

export const DevEnvProjectResponse = z.object({
  availability: DevEnvAvailability,
  setting: DevEnvProjectSetting,
  warningVersion: z.number().int(),
  /** the caller may run commands in this box (setting on, in scope, write access to the folder) */
  mayUse: z.boolean(),
  /** the caller may change the setting (owner or admin) */
  mayManage: z.boolean(),
  box: DevEnvBox.nullable(),
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
  devEnvActivity: endpoint({ method: 'GET', path: '/api/projects/:id/dev-env/activity', auth: 'user', owner: 'B', response: z.object({ items: z.array(DevEnvActivity) }), summary: 'Box audit of a project: AI commands, changed files, box and preview events (read access to the folder).' }),
} as const
