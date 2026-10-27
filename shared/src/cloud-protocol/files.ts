// Files the control plane puts inside a tenant (through mycel-enroll / mycel-ctl), and the plan pieces it keeps.
// MIT (see LICENSE in this folder).
//
//   BASE/root/plan.json         PlanFile      root 0644; mycel-ctl apply-plan writes it, the server and launcher read it
//   BASE/root/notices.json      NoticesFile   root 0644; mycel-ctl notices-set writes it, the server shows it (SV-2)
//   <data>/relay/registration.json  RelayRegistrationFile   the relay registration the control plane made (SV-4)
//
// plan.json field names are the linux runtime's (linux-runtime §3.8.5, the schema's owner). The control-plane spec
// (3.5.6) called some of them planId / issuedAt / ramMB / diskGB / backup.localRetentionDays: those are the same
// values under the runtime's names plan / updatedAt / memoryMiB / diskGiB / localBackupRetentionDays. The control plane
// adds maxActiveMembers, display and links (all optional, so a plan.json written by the runtime alone still parses).
// This is THE plan.json schema: the team server reads plan.json with it (server/src/system/limits.ts), the control
// plane writes it with it, and mycel-ctl apply-plan (Go, native/internal/plan) must accept everything it accepts
// (same ranges; unknown keys are ignored by the server, never written by the control plane).
import { z } from 'zod'
import { HttpsUrl, I18nText, IsoTime, PlanId, RelayTeamId, Ed25519PublicKeyB64, TeamSlug } from './common.ts'

/** VM resources of a plan (isolation §5.5, §6.2 createTenant.plan): what ax-hostd applies to the VM. The ranges are
 * what Proxmox takes (cpuunits 1–262144, …). ee/cloud/contracts (ax-hostd) uses this schema as is. */
export const IoLimits = z.strictObject({ mbps: z.number().positive().max(100_000), iops: z.number().int().positive().max(10_000_000) })
export const PlanResources = z.strictObject({
  memoryMB: z.number().int().min(512).max(1_048_576),
  vcpus: z.number().int().min(1).max(128),
  cpuUnits: z.number().int().min(1).max(262_144),
  dataDiskGB: z.number().int().min(1).max(65_536),
  io: IoLimits,
  netRateMBps: z.number().positive().max(100_000),
})
export type PlanResources = z.infer<typeof PlanResources>

/** The control plane's plans.limits_json. */
export const PlanLimits = z.object({
  resources: PlanResources,
  maxConcurrency: z.number().int().min(1).max(16),
  maxActiveMembers: z.number().int().min(1).nullable(),
})
export type PlanLimits = z.infer<typeof PlanLimits>

export const PlanFile = z.object({
  format: z.literal(1),
  /** plan id: basic | team | pro | ... */
  plan: PlanId,
  maxConcurrency: z.number().int().min(1).max(16),
  memoryMiB: z.number().int().min(1024).max(262_144),
  cpuCores: z.number().int().min(1).max(64),
  diskGiB: z.number().int().min(5).max(10_000),
  reserveMiB: z.number().int().min(256).max(4096).default(768),
  turnMemoryMaxMiB: z.number().int().min(256).max(65_536).nullable().default(null),
  /** 64–4096: the Go reader's range (native/internal/plan), so the control plane never writes a plan mycel-ctl refuses */
  turnPidsMax: z.number().int().min(64).max(4096).default(256),
  turnDiskMaxMiB: z.number().int().min(128).max(10_240).default(1024),
  readMaxMiB: z.number().int().min(8).max(200).default(200),
  convMemoryMaxMiB: z.number().int().min(256).max(65_536).nullable().default(null),
  /** local backups kept on the tenant; the cloud keeps 3 (the off-site copy is the long one) */
  localBackupRetentionDays: z.number().int().min(1).max(30).default(14),
  /** when the control plane made this plan (always written by it; a hand-written self-host file may leave it out) */
  updatedAt: IsoTime.optional(),
  // ---- control plane additions (control-plane 3.5.6) ----
  /** active accounts allowed (D38: Basic 5, Team 12, Pro 20), the owner included, disabled ones not; null = no limit.
   * The server refuses invites, direct adds and re-enabling an account over it (409 plan_limit, reason seat_limit). */
  maxActiveMembers: z.number().int().min(1).max(10_000).nullable().default(null),
  /** what Admin > System shows as the plan name */
  display: z.object({ name: I18nText }).nullable().default(null),
  /** where "manage plan" (account: the billing page, also shown with every over-the-limit message), the status page
   * and support (a mail address or a URL) point */
  links: z.object({ account: HttpsUrl, status: HttpsUrl, support: z.string().min(3).max(200) }).nullable().default(null),
})
export type PlanFile = z.infer<typeof PlanFile>
export type PlanFileInput = z.input<typeof PlanFile>

export const MAX_NOTICES = 10
export const Notice = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  level: z.enum(['info', 'warn', 'critical']),
  audience: z.enum(['owner', 'admins', 'everyone']),
  text: I18nText,
  link: HttpsUrl.nullable(),
  until: IsoTime.nullable(),
})
export type Notice = z.infer<typeof Notice>
export const NoticesFile = z.object({
  format: z.literal(1),
  issuedAt: IsoTime,
  notices: z.array(Notice).max(MAX_NOTICES).refine((a) => new Set(a.map((n) => n.id)).size === a.length, 'notice ids must be unique'),
})
export type NoticesFile = z.infer<typeof NoticesFile>

/**
 * The relay registration the control plane made for this team (relay operator API POST /ops/v1/teams with the
 * tenant's own key). mycel-enroll writes it to <data>/relay/registration.json (server account, 0600); the team server
 * adopts it instead of registering with proof of work (SV-4), when publicKey is the key in <data>/relay/team-key.pem.
 * Same fields as the server's relay_registrations row.
 */
export const RelayRegistrationFile = z.object({
  /** registry API base, e.g. https://relay.treesoop.com */
  relayApi: HttpsUrl,
  teamId: RelayTeamId,
  teamName: TeamSlug,
  publicKey: Ed25519PublicKeyB64,
  /** https://<teamName>.treesoop.com */
  address: HttpsUrl,
})
export type RelayRegistrationFile = z.infer<typeof RelayRegistrationFile>
