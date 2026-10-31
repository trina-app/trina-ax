// Health, diagnostics, update, backup / restore / export, connection mode. Owner: G (server/src/routes/system.ts,
// server/src/system/*). Everything but health is owner-only; update and restore ask for the password again (tab 4).
import { z } from 'zod'
import { IsoTime, JobAccepted } from './common'
import { empty, endpoint } from './endpoint'
import { SourceCodeOffer } from '../source'

export const Health = z.object({
  ok: z.boolean(),
  /** version, schema and uptime are left out for a signed-out caller on the office internet address (docs/OFFICE.md
   * "인터넷 주소"): the internet does not learn which build runs. Everyone else (this Mac, the office LAN, the relay,
   * a signed-in person) gets them. */
  version: z.string().optional(),
  /** Operator metadata for this version; absent with anonymous office tunnel redaction or on older servers. */
  sourceCode: SourceCodeOffer.optional(),
  /** schema version range this build reads */
  schema: z.object({ applied: z.number().int(), readerLevel: z.number().int() }).optional(),
  uptimeSec: z.number().nonnegative().optional(),
  time: IsoTime,
})
export type Health = z.infer<typeof Health>

export const CheckStatus = z.enum(['ok', 'warn', 'fail', 'unknown'])
export type CheckStatus = z.infer<typeof CheckStatus>
export const DiagnosticCheck = z.object({
  id: z.string(),
  /** e.g. relay, disk, engines, queue, pf_anchor, sandbox, backups, clock, launcher, tools_gate */
  group: z.string(),
  label: z.string(),
  status: CheckStatus,
  /** what to do about it, in the user's language */
  detail: z.string().nullable(),
})
export type DiagnosticCheck = z.infer<typeof DiagnosticCheck>
export const Diagnostics = z.object({
  version: z.string(),
  host: z.object({ os: z.string(), arch: z.string(), hostname: z.string() }),
  disk: z.object({ teamFolderFreeBytes: z.number().int().nonnegative(), dataFreeBytes: z.number().int().nonnegative() }),
  queue: z.object({ running: z.number().int(), queued: z.number().int(), concurrency: z.number().int(),
    queuePolicyVersion: z.number().int().optional(), waitingUsers: z.number().int().optional(), oldestWaitMs: z.number().nonnegative().optional(),
    maxRunningPerUser: z.number().int().optional(), quarantined: z.number().int().optional(), deferredSchedules: z.number().int().optional(),
    deferredOldestWaitMs: z.number().nonnegative().optional(),
    /** queued answers are held back because the machine is short of memory (server/src/system/limits.ts) */
    waitingForMemory: z.boolean().optional(),
    recovery: z.enum(['ready', 'checking_launcher', 'launcher_unreachable', 'launcher_busy', 'launcher_unknown']).optional(),
    rejected: z.object({ queue_full: z.number().int(), queue_full_user: z.number().int(), draining: z.number().int() }).optional(),
  }),
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
  /** false: this server has no release feed (update.feedUrl null) or no release key, so it never looks for new
   * versions online; a new version comes from re-running the installer. Absent from older servers. */
  feed: z.boolean().optional(),
  /** the available version also changes root-owned parts (Linux: launcher, sandbox helper, units): the server does
   * not apply it; `sudo mycel-ctl update` (or the update timer / the hosted cloud) does. Absent from older servers. */
  needsRoot: z.boolean().optional(),
  /** this server applies app-only releases by itself inside the team's update window (Linux self-host update.auto) */
  auto: z.boolean().optional(),
  /** the hosted cloud: the hosting provider installs updates; the in-app update and roll-back are off */
  managed: z.boolean().optional(),
})
export type UpdateStatus = z.infer<typeof UpdateStatus>
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
export type BackupInfo = z.infer<typeof BackupInfo>
export const StartBackupBody = z.object({ scope: z.enum(['db', 'full']).default('full') })
export const StartRestoreBody = ReauthBody.extend({ backupId: z.string().min(1).max(200) })
/** Export (tab 6): chats as Markdown, memories as CSV, the team folder as is. Written to users/<owner>/exports/. */
export const StartExportBody = z.object({ what: z.array(z.enum(['chats', 'memories', 'files'])).min(1), password: z.string().min(8).max(256).optional() })
export type StartExportBody = z.infer<typeof StartExportBody>

export const ConnectionMode = z.enum(['relay', 'self-relay', 'cloudflare', 'tailscale', 'direct-only'])
export type ConnectionMode = z.infer<typeof ConnectionMode>
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
  /** the team name registered at the relay (relay.teamName in config/server.json; self-relay needs one) */
  teamName: z.string().nullable().optional(),
  /** the modes this server offers in Admin > System > Change connection; "relay" (the official relay) only while it runs */
  availableModes: z.array(ConnectionMode).optional(),
  /** the address the team reaches this server at without the relay, as far as it knows (host only, e.g.
   * team.example.com: tunnel.host or an https origin with an internet name, server/src/system/connection.ts
   * publicAddress); null = none, so without the relay only the office network */
  publicAddress: z.string().nullable().optional(),
})
export type ConnectionStatus = z.infer<typeof ConnectionStatus>
/** Team name at a relay: becomes <name>.<relay domain>. ASCII lowercase letters, digits and inner hyphens (tab 6). */
export const RelayTeamName = z.string().trim().toLowerCase().min(2).max(40).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
export const UpdateConnectionBody = z.object({
  mode: ConnectionMode,
  /** self-relay URL */
  relayUrl: z.url().optional(),
  /** team name at the relay (self-relay: required unless one is set already) */
  teamName: RelayTeamName.optional(),
  /** claim code from the account console (the official relay add-on, control-plane 3.13): registers the address
   * without proof of work at a relay with closed registration. Used once, at the next start. */
  claimCode: z.string().trim().min(16).max(64).regex(/^[A-Za-z0-9 -]+$/).optional(),
  password: z.string().min(1).max(256),
})

/**
 * Office-network direct connection info (design tab 4 / 6). The desktop app asks the team address (real TLS) and
 * then accepts only this certificate on the LAN addresses (no trust on first use). Signed-in users only.
 */
export const ConnectInfo = z.object({
  /** stable id of this team server (the same in every answer; Bonjour TXT later) */
  teamId: z.string().min(1).max(200),
  /** SHA-256 of the LAN certificate (DER), hex, with or without colons; null when the office connection is off */
  lanCertSha256: z.string().regex(/^([0-9A-Fa-f]{2}:?){31}[0-9A-Fa-f]{2}$/).nullable(),
  lanPort: z.number().int().min(1).max(65535),
  /** e.g. ["acme-mac.local", "192.168.0.20"] */
  lanHosts: z.array(z.string().min(1).max(253)).max(8),
  /** the team address apps should use (the relay address); null when there is none */
  canonicalOrigin: z.string().nullable().optional(),
})
export type ConnectInfo = z.infer<typeof ConnectInfo>
/** Why the desktop app could not use the office address it found (counted once per session per hour). */
export const LanFailureCode = z.enum(['unreachable', 'cert_mismatch', 'timeout'])
export type LanFailureCode = z.infer<typeof LanFailureCode>
export const LanFailureBody = z.object({ code: LanFailureCode })

// ---------------- storage (server/src/system/storage.ts) ----------------
export const StorageLevel = z.enum(['ok', 'warn', 'high', 'full'])
export type StorageLevel = z.infer<typeof StorageLevel>
const Bytes = z.number().nonnegative()
export const StorageBreakdown = z.object({ team: Bytes, history: Bytes, trash: Bytes, backups: Bytes, models: Bytes, data: Bytes, app: Bytes, other: Bytes })
export type StorageBreakdown = z.infer<typeof StorageBreakdown>
export const StorageStatus = z.object({
  /** statfs of the team folder's disk (the hosted cloud: the plan's disk) */
  totalBytes: Bytes, usedBytes: Bytes, freeBytes: Bytes,
  /** used / (used + available), 0–100 */
  percent: z.number().min(0).max(100),
  /** ok < 80% <= warn < 90% <= high < 95% <= full */
  level: StorageLevel,
  /** writes are refused when the free space would drop under this */
  reserveBytes: Bytes,
  /** saves, uploads and the AI's writes are refused now (507 storage_full) */
  writesRefused: z.boolean(),
  /** what uses the space (measured hourly; null until the first measurement) */
  breakdown: StorageBreakdown.nullable(),
  measuredAt: IsoTime.nullable(),
  /** the plan's disk (the hosted cloud), else null. The rest of the plan: GET /api/admin/plan */
  planDiskGiB: z.number().nullable(),
})
export type StorageStatus = z.infer<typeof StorageStatus>

// ---------------- the plan and the operator's notices (server/src/system/limits.ts, managed.ts; control-plane 3.5.6) ----------------
/** Admin > System > Plan: what plan.json allows and what the team uses of it. null plan = no plan file (self-hosted,
 * no limits beyond the admin's settings). */
export const PlanStatus = z.object({
  plan: z.object({
    /** plan id (basic, team, pro, ...) */
    id: z.string(),
    /** the plan's display name in the caller's language (plan.json display.name), else the id */
    name: z.string(),
    maxConcurrency: z.number().int(),
    /** answers at the same time now: min(the admin's setting, maxConcurrency) */
    concurrency: z.number().int(),
    /** active accounts allowed (owner included, disabled ones not); null = no limit */
    maxActiveMembers: z.number().int().nullable(),
    activeMembers: z.number().int(),
    diskGiB: z.number(),
    memoryMiB: z.number().int(),
    cpuCores: z.number().int(),
    /** local backups are kept this many days (the hosted cloud: 3, the off-site copy is the long one) */
    localBackupRetentionDays: z.number().int(),
    /** account = where the owner changes the plan; status page; support (a mail address or a URL) */
    links: z.object({ account: z.string(), status: z.string(), support: z.string() }).nullable(),
    updatedAt: IsoTime.nullable(),
  }).nullable(),
})
export type PlanStatus = z.infer<typeof PlanStatus>

export const NoticeLevel = z.enum(['info', 'warn', 'critical'])
export type NoticeLevel = z.infer<typeof NoticeLevel>
/** One notice of the operator (<base>/root/notices.json, written by `mycel-ctl notices-set`), already in the caller's
 * language and only when it is meant for the caller's role. */
export const ManagedNotice = z.object({
  id: z.string(),
  level: NoticeLevel,
  text: z.string(),
  /** https link to more (status page, billing, changelog) */
  link: z.string().nullable(),
  /** shown until then; null = until the operator removes it */
  until: IsoTime.nullable(),
  /** info and warn: the person may hide it on this browser; critical stays */
  dismissible: z.boolean(),
})
export type ManagedNotice = z.infer<typeof ManagedNotice>
export const ManagedNotices = z.object({ items: z.array(ManagedNotice) })
export type ManagedNotices = z.infer<typeof ManagedNotices>

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
  connectInfo: endpoint({ method: 'GET', path: '/api/connect-info', auth: 'user', owner: 'G', response: ConnectInfo, summary: 'Office-network address and certificate fingerprint for the desktop app (pinning).' }),
  lanFailure: endpoint({ method: 'POST', path: '/api/connect-info/lan-failure', auth: 'user', owner: 'G', status: 204, body: LanFailureBody, response: empty, summary: 'The desktop app could not use the office address (shown in Diagnostics).' }),
  updateConnection: endpoint({ method: 'PUT', path: '/api/admin/connection', auth: 'owner-reauth', owner: 'G', body: UpdateConnectionBody, response: ConnectionStatus, summary: 'Change the connection mode.' }),
  storage: endpoint({ method: 'GET', path: '/api/admin/storage', auth: 'admin', owner: 'G', response: StorageStatus, summary: 'Storage use of the team disk (statfs), what uses it, the plan\'s disk when there is one.' }),
  plan: endpoint({ method: 'GET', path: '/api/admin/plan', auth: 'admin', owner: 'G', response: PlanStatus, summary: 'The plan (plan.json): limits, what the team uses of them, where to change it. null without a plan file.' }),
  managedNotices: endpoint({ method: 'GET', path: '/api/managed/notices', auth: 'user', owner: 'G', response: ManagedNotices, summary: 'The operator\'s notices (notices.json) meant for the caller\'s role, in the caller\'s language.' }),
} as const
