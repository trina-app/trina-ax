// Office mode automatic updates (docs/OFFICE.md "자동 업데이트"): what Admin > System shows and its two buttons.
// Owner: G (server/src/routes/office-update.ts, server/src/office/update.ts). The work itself is done by the
// installation's update LaunchAgent; the server only reads its state and asks it to run ("now").
import { z } from 'zod'
import { IsoTime } from './common'
import { endpoint } from './endpoint'

const Channel = z.enum(['stable', 'beta'])
export const OfficeUpdateResult = z.enum(['up-to-date', 'updated', 'available', 'rolled-back', 'failed', 'refused', 'paused', 'skipped'])
export type OfficeUpdateResult = z.infer<typeof OfficeUpdateResult>

/** what an update in progress is doing (the web shows it in the person's language; `phase` is the log's English line) */
export const OfficeUpdateStep = z.enum(['check', 'download', 'unpack', 'precheck', 'wait-idle', 'backup', 'install', 'verify', 'rollback'])
export type OfficeUpdateStep = z.infer<typeof OfficeUpdateStep>

export const OfficeUpdateStatus = z.object({
  /** the installed version (app/VERSION) */
  current: z.string(),
  channel: Channel,
  /** automatic updates off ("자동 업데이트 끄기", `teamax update pause`) */
  paused: z.boolean(),
  /** the start of the update window, HH:MM in timeZone (older pages show it) */
  time: z.string(),
  /** the team's update window, HH:mm-HH:mm (Admin > Team settings; 03:00-05:00 when empty), in timeZone */
  window: z.string().optional(),
  /** where the window comes from: team = Admin > Team settings; legacy = a time `teamax update time` of an older version
   * set, which counts while the team setting is empty; default = 03:00-05:00 */
  windowSource: z.enum(['team', 'legacy', 'default']).optional(),
  /** the team's time zone (IANA) the window and nextWindowAt are shown in */
  timeZone: z.string().optional(),
  /** the update agent's next run inside the window; null while paused, without the update agent, or when the window
   * never opens */
  nextWindowAt: IsoTime.nullable(),
  lastCheckAt: IsoTime.nullable(),
  last: z.object({ kind: OfficeUpdateResult, at: IsoTime, version: z.string().nullable(), message: z.string().nullable() }).nullable(),
  /** a newer version on the feed, not installed yet */
  available: z.object({ version: z.string(), channel: Channel, notes: z.string(), publishedAt: IsoTime }).nullable(),
  lastUpdate: z.object({ from: z.string(), to: z.string(), at: IsoTime, result: z.enum(['updated', 'rolled-back', 'failed']), error: z.string().nullable() }).nullable(),
  /** an update in progress */
  running: z.object({ since: IsoTime, step: OfficeUpdateStep, phase: z.string(), target: z.string().nullable() }).nullable(),
  /** "update now" asked, the agent has not started yet */
  requested: z.boolean(),
  /** the update LaunchAgent is installed (installs made before automatic updates do not have it) */
  agentInstalled: z.boolean(),
  /** the Windows desktop app the updater last offered to the desks */
  desktop: z.object({ version: z.string(), at: IsoTime }).nullable(),
})
export type OfficeUpdateStatus = z.infer<typeof OfficeUpdateStatus>

/** "now" re-asks the caller's password (like the owner's update and restore): it restarts the office's server */
export const OfficeUpdateAction = z.object({ action: z.enum(['now', 'pause', 'resume']), password: z.string().min(1).max(256).optional() })
export type OfficeUpdateAction = z.infer<typeof OfficeUpdateAction>

export const OFFICE_UPDATE = {
  officeUpdateStatus: endpoint({ method: 'GET', path: '/api/admin/office-update', auth: 'admin', owner: 'G', response: OfficeUpdateStatus.nullable(), summary: 'Office mode automatic updates: version, channel, next window, last check (null outside office mode).' }),
  officeUpdateAction: endpoint({ method: 'POST', path: '/api/admin/office-update', auth: 'admin', owner: 'G', body: OfficeUpdateAction, response: OfficeUpdateStatus, summary: 'Office mode: update now, or turn automatic updates off / on.' }),
} as const
