// PC runner (docs/DECISIONS.md "PC runner"): the AI stays on the team server; files change and commands run in the
// desktop app of the person who asked. The server sends pc.call over the WebSocket of the window that sent the turn and
// waits for pc.result. Approval happens in the desktop app's own screen, never in the team page. Owner: B
// (server/src/pc/, server/src/routes/pc-runner.ts).
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { IsoTime } from './common'
import { DevEnvConsent, DevEnvScope } from './dev-env'
import { UserRef } from './entities'
import { endpoint } from './endpoint'

/** A new version (other words, other risks) asks again: the stored consent then names an older one. */
export const PC_RUNNER_WARNING_VERSION = 1

/** How long a call waits for the person before it counts as refused. The server's limit of a call includes it. */
export const PC_APPROVAL_TIMEOUT_MS = 5 * 60_000

export const PcToolName = z.enum(['pc_read', 'pc_write', 'pc_edit', 'pc_search', 'pc_shell'])
export type PcToolName = z.infer<typeof PcToolName>

export const PcCall = z.object({
  /** unique per call; the app must not run the same callId twice (dedupe after reconnects) */
  callId: z.string().min(1).max(100),
  turnId: Uuid7,
  chatId: Uuid7,
  /** the workspace folder is chosen per project; the name is for the person's eyes only */
  project: z.object({ id: z.string().min(1).max(100), name: z.string().max(200) }),
  tool: PcToolName,
  /** tool input exactly as the engine sent it (validated by the app against shared/src/pc-tools.ts) */
  args: z.record(z.string(), z.unknown()),
})
export type PcCall = z.infer<typeof PcCall>

/** How a call was let through. `chat`: the person allowed this chat earlier; `none`: it never reached the person (an
 * unknown tool, a bad path, no workspace). */
export const PcApproval = z.enum(['once', 'chat', 'denied', 'none'])
export type PcApproval = z.infer<typeof PcApproval>

export const PcResult = z.object({
  callId: z.string().min(1).max(100),
  ok: z.boolean(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string().max(2_000_000) })).max(20),
  error: z.string().max(4000).optional(),
  approval: PcApproval,
  /** the grants the person gave this call on the card (for the audit log) */
  grants: z.object({ login: z.boolean(), secretFiles: z.boolean() }).optional(),
  /** what a command did (for the audit log) */
  run: z.object({ code: z.number().int().nullable(), signal: z.string().max(40).nullable(), ms: z.number().int().nonnegative() }).optional(),
})
export type PcResult = z.infer<typeof PcResult>

export const PcRunnerProjectSetting = z.object({
  enabled: z.boolean(),
  scope: DevEnvScope,
  consent: DevEnvConsent.nullable(),
})
export type PcRunnerProjectSetting = z.infer<typeof PcRunnerProjectSetting>

export const PcRunnerActivity = z.object({
  at: IsoTime,
  by: UserRef.nullable(),
  tool: z.string(),
  text: z.string(),
  ok: z.boolean(),
  approval: z.string().nullable(),
})
export type PcRunnerActivity = z.infer<typeof PcRunnerActivity>

export const PcRunnerProjectResponse = z.object({
  setting: PcRunnerProjectSetting,
  warningVersion: z.number().int(),
  /** the caller's desktop app may work on this project (setting on, in scope, write access to the folder) */
  mayUse: z.boolean(),
  /** the caller may change the setting (owner or admin) */
  mayManage: z.boolean(),
})
export type PcRunnerProjectResponse = z.infer<typeof PcRunnerProjectResponse>

export const UpdatePcRunnerBody = z.object({
  enabled: z.boolean(),
  scope: DevEnvScope,
  acceptWarning: z.number().int().min(1).optional(),
})
export type UpdatePcRunnerBody = z.infer<typeof UpdatePcRunnerBody>

export const PC_RUNNER = {
  pcRunner: endpoint({ method: 'GET', path: '/api/projects/:id/pc-runner', auth: 'user', owner: 'B', response: PcRunnerProjectResponse, summary: 'PC runner of a project: setting and whether the caller may use it; for people who can read the folder. 404 without MYCEL_PC_RUNNER=1.' }),
  updatePcRunner: endpoint({ method: 'PUT', path: '/api/projects/:id/pc-runner', auth: 'admin', owner: 'B', body: UpdatePcRunnerBody, response: PcRunnerProjectResponse, summary: 'Turn the PC runner of a project on or off and say who may use it; turning on needs the current warning accepted (audited).' }),
  pcRunnerActivity: endpoint({ method: 'GET', path: '/api/projects/:id/pc-runner/activity', auth: 'user', owner: 'B', response: z.object({ items: z.array(PcRunnerActivity) }), summary: 'What the AI did on people\'s computers for this project: tool, text, who, how it was allowed (read access to the folder).' }),
} as const
