// Health, diagnostics, update, backup / restore / export, connection mode. Owner: G (server/src/routes/system.ts,
// server/src/system/*). Everything but health is owner-only; update and restore ask for the password again (tab 4).
import { z } from 'zod'
import { IsoTime, JobAccepted } from './common'
import { endpoint } from './endpoint'

export const Health = z.object({
  ok: z.boolean(),
  version: z.string(),
  /** schema version range this build reads */
  schema: z.object({ applied: z.number().int(), readerLevel: z.number().int() }),
  uptimeSec: z.number().nonnegative(),
  time: IsoTime,
})
export type Health = z.infer<typeof Health>

export const CheckStatus = z.enum(['ok', 'warn', 'fail', 'unknown'])
export const DiagnosticCheck = z.object({
  id: z.string(),
  /** e.g. relay, disk, engines, queue, pf_anchor, sandbox, backups, clock, launcher, tools_gate */
  group: z.string(),
  label: z.string(),
  status: CheckStatus,
  /** what to do about it, in the user's language */
  detail: z.string().nullable(),
})
export const Diagnostics = z.object({
  version: z.string(),
  host: z.object({ os: z.string(), arch: z.string(), hostname: z.string() }),
  disk: z.object({ teamFolderFreeBytes: z.number().int().nonnegative(), dataFreeBytes: z.number().int().nonnegative() }),
  queue: z.object({ running: z.number().int(), queued: z.number().int(), concurrency: z.number().int() }),
  checks: z.array(DiagnosticCheck),
  generatedAt: IsoTime,
})
export type Diagnostics = z.infer<typeof Diagnostics>

export const UpdateStatus = z.object({
  current: z.string(),
  channel: z.enum(['stable', 'beta']),
  available: z.object({ version: z.string(), notes: z.string(), publishedAt: IsoTime, needsBackupRestoreToRollBack: z.boolean() }).nullable(),
  lastCheckedAt: IsoTime.nullable(),
  /** previous version kept for roll-back */
  previous: z.string().nullable(),
})
export const ReauthBody = z.object({ password: z.string().min(1).max(256) })
export const StartUpdateBody = ReauthBody.extend({
  /** default: the available version; 'rollback' = switch back to the previous version */
  version: z.string().max(50).optional(),
  rollback: z.boolean().optional(),
})

export const BackupInfo = z.object({
  id: z.string(),
  kind: z.enum(['daily', 'manual', 'pre-update', 'pre-migrate']),
  createdAt: IsoTime,
  size: z.number().int().nonnegative(),
  /** includes the team folder (full or incremental) or only the DB */
  scope: z.enum(['db', 'full', 'incremental']),
})
export const StartBackupBody = z.object({ scope: z.enum(['db', 'full']).default('full') })
export const StartRestoreBody = ReauthBody.extend({ backupId: z.string().min(1).max(200) })
/** Export (tab 6): chats as Markdown, memories as CSV, the team folder as is. Written to users/<owner>/exports/. */
export const StartExportBody = z.object({ what: z.array(z.enum(['chats', 'memories', 'files'])).min(1), password: z.string().min(8).max(256).optional() })

export const ConnectionMode = z.enum(['relay', 'self-relay', 'cloudflare', 'tailscale', 'direct-only'])
export const ConnectionStatus = z.object({
  mode: ConnectionMode,
  /** team address, e.g. https://acme.treesoop.com (dev: http://acme.localhost:19100) */
  address: z.string().nullable(),
  state: z.enum(['connected', 'connecting', 'offline', 'replaced', 'not_registered', 'disabled']),
  /** replaced = another server with the same key took over (relay close 4009); it must not reconnect */
  detail: z.string().nullable(),
  connectedSince: IsoTime.nullable(),
  /** office-network direct connection (TLS 8443): cert fingerprint for desktop pinning */
  direct: z.object({ enabled: z.boolean(), port: z.number().int(), fingerprintSha256: z.string().nullable() }),
})
export type ConnectionStatus = z.infer<typeof ConnectionStatus>
export const UpdateConnectionBody = z.object({
  mode: ConnectionMode,
  /** self-relay URL */
  relayUrl: z.url().optional(),
  password: z.string().min(1).max(256),
})

export const SYSTEM = {
  health: endpoint({ method: 'GET', path: '/api/health', auth: 'public', owner: 'G', response: Health, summary: 'Liveness for the menubar app, relay and update check. No private data.' }),
  diagnostics: endpoint({ method: 'GET', path: '/api/admin/diagnostics', auth: 'owner', owner: 'G', response: Diagnostics, summary: 'Relay, disk, engine keys, queue, pf anchor, sandbox, backups.' }),
  updateStatus: endpoint({ method: 'GET', path: '/api/admin/update', auth: 'owner', owner: 'G', response: UpdateStatus, summary: 'Current / available version.' }),
  startUpdate: endpoint({ method: 'POST', path: '/api/admin/update', auth: 'owner-reauth', owner: 'G', status: 202, body: StartUpdateBody, response: JobAccepted, summary: 'Back up the DB, switch app/current, restart; roll back if the health check fails.' }),
  listBackups: endpoint({ method: 'GET', path: '/api/admin/backups', auth: 'owner', owner: 'G', response: z.object({ items: z.array(BackupInfo) }), summary: 'Backups in .system/backups/.' }),
  startBackup: endpoint({ method: 'POST', path: '/api/admin/backup', auth: 'owner', owner: 'G', status: 202, body: StartBackupBody, response: JobAccepted, summary: 'Back up now (VACUUM INTO + team folder manifest diff).' }),
  startRestore: endpoint({ method: 'POST', path: '/api/admin/restore', auth: 'owner-reauth', owner: 'G', status: 202, body: StartRestoreBody, response: JobAccepted, summary: 'Restore a backup (everything after it is lost; the UI shows how much).' }),
  startExport: endpoint({ method: 'POST', path: '/api/admin/export', auth: 'owner', owner: 'G', status: 202, body: StartExportBody, response: JobAccepted, summary: 'Export chats / memories / files (optionally password-encrypted with age).' }),
  connection: endpoint({ method: 'GET', path: '/api/admin/connection', auth: 'owner', owner: 'G', response: ConnectionStatus, summary: 'Relay / direct connection state (from the relay client, component F).' }),
  updateConnection: endpoint({ method: 'PUT', path: '/api/admin/connection', auth: 'owner-reauth', owner: 'G', body: UpdateConnectionBody, response: ConnectionStatus, summary: 'Change the connection mode.' }),
} as const
