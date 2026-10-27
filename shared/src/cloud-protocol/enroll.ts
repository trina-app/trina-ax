// First boot of a tenant VM (isolation §5.4, control-plane 3.5.2). MIT (see LICENSE in this folder).
//
//   ax-hostd ──cloud-init──► /run/ax/enroll.json (EnrollFile, root 0600)
//   mycel-enroll ──POST {controlPlane}/enroll (EnrollRequest)──► control plane ──► EnrollResponse
//   mycel-enroll ──► server.json, /etc/default/mycel, plan.json, notices.json, <data>/relay/registration.json,
//                    <data>/setup-token, restore … ──► /run/ax/enroll-status.json (EnrollStatus)
//
// Modes:
//   new       a new team. The tenant made its relay key; the control plane registers the address with it (relay
//             operator API, no proof of work) and hands back a setup token for the team's /setup page.
//   restore   a new VM from the R2 off-site backup of an existing team: the backup chain, the team's backup identity
//             and the credentials.key escrow come back encrypted to a one-time age recipient the tenant made; the
//             relay key is rotated to the new VM's key.
//   verify    a weekly restore test: download, decrypt, unpack, check against `expect`, report. No relay, no setup,
//             the server never starts; the VM is purged right after.
//   reattach  the OS disk was replaced (isolation §6.2 reimageTenant) but the data disk, with the relay key, is the
//             same: no enroll token. mycel-enroll re-applies what the data disk holds and does NOT call /enroll today;
//             the /enroll reattach mode (signed with the relay key, reattachSigningString) is there for a control plane
//             that wants to hand the tenant new settings at that moment.
import { z } from 'zod'
import {
  AgeArmored, AgeRecipient, CredentialKind, Ed25519PublicKeyB64, HttpsUrl, IsoTime, Locale, MinuteOfDay, RelayTeamId, Sha256Hex,
  SignatureB64, TeamSlug, TenantId, TimeZoneName, WsUrl,
} from './common.ts'
import { NoticesFile, PlanFile, RelayRegistrationFile } from './files.ts'

export const ENROLL_PATH = '/enroll'
export const ENROLL_FILE = '/run/ax/enroll.json'
export const ENROLL_STATUS_FILE = '/run/ax/enroll-status.json'
/** an enroll token is good for one use within this long (isolation §5.4) */
export const ENROLL_TOKEN_TTL_MS = 30 * 60_000

export const EnrollMode = z.enum(['new', 'restore', 'verify', 'reattach'])
export type EnrollMode = z.infer<typeof EnrollMode>
export const EnrollToken = z.string().regex(/^ent_[A-Za-z0-9_-]{20,200}$/)

/**
 * /run/ax/enroll.json as ax-hostd writes it. isolation §5.4 fields + mode / teamSlug / relayTeamId (control-plane 3.5.2).
 * A file without mode (written from the isolation spec alone) means mode 'new'.
 */
export const EnrollFile = z.object({
  v: z.literal(1),
  tenantId: TenantId,
  controlPlane: HttpsUrl,
  /** null only for reattach */
  enrollToken: EnrollToken.nullable(),
  mode: EnrollMode.default('new'),
  teamSlug: TeamSlug.nullable().default(null),
  relayTeamId: RelayTeamId.nullable().default(null),
  timeZone: TimeZoneName,
  locale: Locale,
  /** team-local minute of day the nightly local backup starts (02:00-05:00, spread by ax-hostd) */
  backupWindowStartMin: MinuteOfDay,
  /** team-local minute of day for kernel-update reboots */
  maintenanceWindowStartMin: MinuteOfDay,
}).superRefine((f, ctx) => {
  if (f.mode === 'reattach' ? f.enrollToken !== null : f.enrollToken === null) ctx.addIssue({ code: 'custom', path: ['enrollToken'], message: 'an enroll token for new / restore / verify; none for reattach' })
  // reattach may leave relayTeamId out: ax-hostd does not know it (the relay team is made at the first enroll) and the
  // data disk holds it (<data>/relay/registration.json); mycel-enroll's reattach is local (it does not call /enroll)
  if (f.mode === 'restore' && !f.relayTeamId) ctx.addIssue({ code: 'custom', path: ['relayTeamId'], message: 'restore needs relayTeamId' })
  if (f.mode === 'new' && !f.teamSlug) ctx.addIssue({ code: 'custom', path: ['teamSlug'], message: 'new needs teamSlug' })
})
export type EnrollFile = z.infer<typeof EnrollFile>
export type EnrollFileInput = z.input<typeof EnrollFile>

const InfoVersion = z.preprocess((v) => (v === '' ? 'unknown' : v), z.string().min(1).max(40))

/** relayProof: the tenant holds the relay key it sends (signing strings: ./signing.ts) */
export const RelayProof = z.discriminatedUnion('kind', [
  /** new: registerSigningString(teamSlug, relayPublicKey, ts) */
  z.object({ kind: z.literal('register'), ts: z.number().int().nonnegative(), sig: SignatureB64 }),
  /** restore: keyRotationString(relayTeamId, relayPublicKey), signed by the NEW key */
  z.object({ kind: z.literal('rotate'), relayTeamId: RelayTeamId, sig: SignatureB64 }),
  /** reattach: reattachSigningString(tenantId, relayTeamId, ts), signed by the CURRENT key */
  z.object({ kind: z.literal('reattach'), relayTeamId: RelayTeamId, ts: z.number().int().nonnegative(), sig: SignatureB64 }),
])
export type RelayProof = z.infer<typeof RelayProof>

export const EnrollRequest = z.object({
  v: z.literal(1),
  tenantId: TenantId,
  enrollToken: EnrollToken.nullable(),
  mode: EnrollMode,
  /** base64 SPKI of the relay key made inside the VM (<data>/relay/team-key.pem); null for verify */
  relayPublicKey: Ed25519PublicKeyB64.nullable(),
  relayProof: RelayProof.nullable(),
  /** restore / verify: a one-time age recipient the tenant made, for the secrets in the answer */
  oneTimeRecipient: AgeRecipient.nullable(),
  /** informational: the kit (root/VERSION) and the app (app/current, else the kit's) versions. An empty string (an
   * older mycel-enroll, a dev image without the app) reads as "unknown" instead of failing the enroll (CP C-20). */
  kitVersion: InfoVersion,
  appVersion: InfoVersion,
}).superRefine((r, ctx) => {
  const need = (ok: boolean, path: string, message: string) => { if (!ok) ctx.addIssue({ code: 'custom', path: [path], message }) }
  need(r.mode === 'reattach' ? r.enrollToken === null : r.enrollToken !== null, 'enrollToken', 'an enroll token for new / restore / verify; none for reattach')
  need(r.mode === 'verify' ? r.relayPublicKey === null : r.relayPublicKey !== null, 'relayPublicKey', 'a relay key for every mode but verify')
  const kind = { new: 'register', restore: 'rotate', reattach: 'reattach', verify: null }[r.mode]
  need((r.relayProof?.kind ?? null) === kind, 'relayProof', kind ? `${r.mode} needs relayProof { kind: '${kind}' }` : 'verify has no relayProof')
  need((r.mode === 'restore' || r.mode === 'verify') === (r.oneTimeRecipient !== null), 'oneTimeRecipient', 'restore and verify need oneTimeRecipient; the others none')
})
export type EnrollRequest = z.infer<typeof EnrollRequest>

/** server.json pieces the control plane decides (linux-runtime D24: deployment 'hosted') */
export const EnrollServerConfig = z.object({
  deployment: z.literal('hosted'),
  relay: z.object({ url: WsUrl, teamName: TeamSlug }).nullable(),
  publicOrigins: z.array(HttpsUrl).max(10),
  engine: z.object({ credentialKinds: z.array(CredentialKind).min(1).max(4) }),
})
export type EnrollServerConfig = z.infer<typeof EnrollServerConfig>

export const RestoreObject = z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), url: HttpsUrl, sha256: Sha256Hex, size: z.number().int().nonnegative() })
/** one backup of the chain (the full one first, then each incremental, the last one with the DB) */
export const RestoreChainItem = z.object({ backupId: z.string().min(1).max(128), objects: z.array(RestoreObject).min(1).max(16) })
export const RestoreExpect = z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), schemaVersion: z.number().int().nonnegative() })
export type RestoreExpect = z.infer<typeof RestoreExpect>

export const EnrollRestore = z.object({
  chain: z.array(RestoreChainItem).min(1).max(64),
  /** the team's backup identity (AGE-SECRET-KEY-1...), age-encrypted to oneTimeRecipient */
  identityAge: AgeArmored,
  /** credentials.key escrow, age-encrypted to oneTimeRecipient (verify: null) */
  credentialsKeyAge: AgeArmored.nullable(),
  /** verify only: what the restored copy must hold */
  expect: RestoreExpect.nullable(),
})
export type EnrollRestore = z.infer<typeof EnrollRestore>

export const EnrollResponse = z.object({
  v: z.literal(1),
  /** verify: null (nothing is configured) */
  server: EnrollServerConfig.nullable(),
  relayRegistration: RelayRegistrationFile.nullable(),
  /** new only: the one-time token of the team's /setup page (<data>/setup-token, server account 0600) */
  setupToken: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/).nullable(),
  plan: PlanFile,
  notices: NoticesFile,
  restore: EnrollRestore.nullable(),
})
export type EnrollResponse = z.infer<typeof EnrollResponse>
export type EnrollResponseInput = z.input<typeof EnrollResponse>

/** The rules that tie an answer to the request's mode (the control plane checks before it answers, mycel-enroll after). */
export function enrollResponseProblem(mode: EnrollMode, r: EnrollResponse): string | null {
  switch (mode) {
    case 'new':
      if (!r.server || !r.relayRegistration || !r.setupToken || r.restore) return 'new: server, relayRegistration and setupToken, no restore'
      break
    case 'restore':
      if (!r.server || !r.relayRegistration || r.setupToken || !r.restore || r.restore.expect) return 'restore: server, relayRegistration and restore (without expect), no setupToken'
      break
    case 'verify':
      if (r.server || r.relayRegistration || r.setupToken || !r.restore?.expect || r.restore.credentialsKeyAge) return 'verify: only restore with expect (no credentials key)'
      break
    case 'reattach':
      if (!r.server || !r.relayRegistration || r.setupToken || r.restore) return 'reattach: server and relayRegistration only'
      break
  }
  if (r.server?.relay && r.relayRegistration && r.server.relay.teamName !== r.relayRegistration.teamName) return 'server.relay.teamName must be relayRegistration.teamName'
  return null
}

export const EnrollErrorCode = z.enum([
  'invalid_request', 'token_invalid', 'token_expired', 'token_used', 'tenant_mismatch', 'mode_mismatch', 'bad_proof',
  'name_unavailable', 'relay_unavailable', 'not_ready', 'internal',
])
export type EnrollErrorCode = z.infer<typeof EnrollErrorCode>

/** What a restore test (mode verify) found: mycel-enroll writes it into enroll-status.json and ax-hostd hands it back
 * in the createTenant result (`verify`), where the control plane compares it with `expect`. schemaVersion is null when
 * the restored DB could not be opened. */
export const EnrollVerify = z.object({ ok: z.boolean(), files: z.number().int(), bytes: z.number().int(), schemaVersion: z.number().int().nullable(), seconds: z.number() })
export type EnrollVerify = z.infer<typeof EnrollVerify>

/** /run/ax/enroll-status.json, as mycel-enroll writes it (native/cmd/mycel-enroll/files.go statusFile); ax-hostd reads
 * it through the guest agent (createTenant step ⑧). The same schema is ee/cloud/contracts' EnrollStatusFile. */
export const EnrollStatus = z.object({
  v: z.literal(1).default(1),
  state: z.enum(['running', 'ok', 'failed']),
  at: IsoTime,
  mode: EnrollMode,
  step: z.string().max(64).nullable().default(null),
  /** root/VERSION of the kit on the data disk (null before the seed is in place) */
  kitVersion: z.string().max(64).nullable().default(null),
  error: z.object({ code: z.string().max(64), message: z.string().max(1000) }).nullable().default(null),
  /** verify only */
  verify: EnrollVerify.nullable().default(null),
})
export type EnrollStatus = z.infer<typeof EnrollStatus>
